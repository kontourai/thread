/**
 * One flat row per tool call, for ad-hoc analysis.
 *
 * `usage` answers five numeric columns over four dimensions; `convert` gives
 * one nested document per session. Neither answers the questions people
 * actually have about their own agent usage — top commands by harness, which
 * tools an agent leans on, error rate per tool, how the mix moved week over
 * week — because every one of those needs a row-per-event shape.
 *
 * The join on `toolCallId` is done ONCE, here, so no consumer has to know
 * that most importers record a tool's name only on the call.
 */
import type { Thread, ToolCall, ToolResult } from "@kontourai/thread";

export interface ToolCallRow {
  /** Importing tool: `claude-code`, `codex`, `opencode`… */
  source?: string;
  sourceVersion?: string;
  cwd?: string;
  gitBranch?: string;
  threadId: string;
  /** Epoch ms of the assistant message that issued the call. */
  timestamp: number;
  model?: string;
  provider?: string;
  toolCallId: string;
  tool: string;
  /** Raw payload exactly as the source emitted it. */
  arguments: string;
  /** Structured form of the SAME arguments, when the source provided one. */
  parsedArguments?: Record<string, unknown>;
  /** Importer-derived analysis about the call (heuristic; see the schema). */
  derived?: Record<string, unknown>;
  /** True/false once a result was seen; absent when the call is unpaired. */
  isError?: boolean;
  /**
   * Characters of result TEXT. Image and file result parts contribute 0, so
   * a row can read `resultChars: 0` for a result that was not empty — 126 of
   * 18,657 Claude Code results in a sampled corpus have no text part. Use
   * `--jsonl` and inspect the thread if that distinction matters.
   */
  resultChars?: number;
}

// Deliberately NO `sidechain` column. Claude Code subagent traffic lives in
// separate transcript files in current versions, not as inline sidechain
// lines: importing 40 real sessions with `includeSidechains: true` produced
// zero sidechain messages, and a full-corpus run produced zero such rows. A
// column whose name asserts a distinction nothing populates is the exact
// label-vs-derivation defect this repo keeps finding — better absent than
// permanently false. Reinstate it together with an importer that actually
// reads those files.

function resultText(result: ToolResult): number {
  let total = 0;
  for (const part of result.content) {
    if (part.type === "text") total += part.text.length;
  }
  return total;
}

/**
 * Rows for one thread, in call order.
 *
 * Results are matched by `toolCallId` across the whole thread rather than
 * only the adjacent message, because a result can arrive several messages
 * later; an unpaired call still yields a row, with the result columns absent
 * rather than defaulted — a missing result is not a successful one.
 */
export function toolCallRows(thread: Thread): ToolCallRow[] {
  // Last write wins on a repeated toolCallId. Real transcripts do repeat one
  // (31 occurrences across 8 sampled sessions) but every observed pair was
  // identical in length and outcome, so the choice is currently unobservable;
  // it is stated rather than left implicit.
  const results = new Map<string, ToolResult>();
  for (const message of thread.messages) {
    if (message.role !== "tool") continue;
    for (const result of message.toolResults) results.set(result.toolCallId, result);
  }

  const rows: ToolCallRow[] = [];
  // One row per CALL, not per occurrence. Claude Code can write the same
  // assistant line twice (same uuid, same message.id) and the importer merges
  // split events by message.id, so an identical tool_call part can appear
  // twice inside one message — found once in 72,735 real rows. That would
  // double-count in exactly the `GROUP BY tool` the README demonstrates.
  const emitted = new Set<string>();
  for (const message of thread.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      const call: ToolCall = part.toolCall;
      if (emitted.has(call.id)) continue;
      emitted.add(call.id);
      const result = results.get(call.id);
      rows.push({
        source: thread.metadata?.source,
        sourceVersion: thread.metadata?.sourceVersion,
        cwd: thread.metadata?.cwd,
        gitBranch: thread.metadata?.git?.branch,
        threadId: thread.id,
        timestamp: message.timestamp,
        model: message.model,
        provider: message.provider,
        toolCallId: call.id,
        tool: call.name,
        arguments: call.arguments,
        ...(call.parsedArguments ? { parsedArguments: call.parsedArguments } : {}),
        ...(call.derived ? { derived: call.derived } : {}),
        ...(result ? { isError: result.isError === true, resultChars: resultText(result) } : {}),
      });
    }
  }
  return rows;
}

/** One JSON object per line — the shape DuckDB/jq read directly. */
export function formatRowsJsonl(rows: readonly ToolCallRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

/** One row, one line. The CLI writes through this so nothing larger than a single record is ever materialized. */
export function formatRowJsonl(row: ToolCallRow): string {
  return JSON.stringify(row);
}



const CSV_COLUMNS = [
  "source",
  "threadId",
  "timestamp",
  "model",
  "provider",
  "tool",
  "operation",
  "command",
  "isError",
  "resultChars",
  "cwd",
  "gitBranch",
] as const;

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  // Quote when the value could otherwise break the row apart. A command
  // string routinely contains commas, quotes and newlines.
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * A deliberately NARROWER projection than JSONL: `arguments` and the nested
 * objects are omitted because a multi-kilobyte program in a spreadsheet cell
 * helps nobody. `operation`/`command` are lifted from the structured forms
 * when present — the first command only, since a cell cannot hold a list
 * without lying about its shape. Use `--jsonl` for the complete record.
 */
export function formatRowsCsv(rows: readonly ToolCallRow[]): string {
  return [csvHeader(), ...rows.map((row) => formatRowCsv(row))].join("\n");
}

/** Header for the CSV projection, emitted once per run. */
export function csvHeader(): string {
  return CSV_COLUMNS.join(",");
}

/**
 * One row as a CSV line — which may itself span physical lines, because a
 * quoted cell can legitimately contain a newline (a `cmd` literal is often a
 * multi-line script). Building it directly, rather than slicing the second
 * line off a formatted batch, is the difference between the whole row and a
 * row truncated at its first embedded newline.
 */
export function formatRowCsv(row: ToolCallRow): string {
  {
    const derived = (row.derived?.["codexExec"] ?? {}) as Record<string, unknown>;
    const commands = derived["commands"];
    const command =
      Array.isArray(commands) && commands.length > 0
        ? String(commands[0])
        : typeof row.parsedArguments?.["command"] === "string"
          ? (row.parsedArguments["command"] as string)
          : Array.isArray(row.parsedArguments?.["command"])
            ? (row.parsedArguments["command"] as unknown[]).map(String).join(" ")
            : undefined;
    const cells: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      source: row.source,
      threadId: row.threadId,
      timestamp: row.timestamp,
      model: row.model,
      provider: row.provider,
      tool: row.tool,
      operation: derived["operation"],
      command,
      isError: row.isError,
      resultChars: row.resultChars,
      cwd: row.cwd,
      gitBranch: row.gitBranch,
    };
    return CSV_COLUMNS.map((column) => csvCell(cells[column])).join(",");
  }
}
