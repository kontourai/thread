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
  /** Characters of result text, absent when the call is unpaired. */
  resultChars?: number;
  /** Claude Code subagent traffic. */
  sidechain?: boolean;
}

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
  const results = new Map<string, ToolResult>();
  for (const message of thread.messages) {
    if (message.role !== "tool") continue;
    for (const result of message.toolResults) results.set(result.toolCallId, result);
  }

  const rows: ToolCallRow[] = [];
  for (const message of thread.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool_call") continue;
      const call: ToolCall = part.toolCall;
      const result = results.get(call.id);
      const sidechain = message.metadata?.["sidechain"];
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
        ...(sidechain === true ? { sidechain: true } : {}),
      });
    }
  }
  return rows;
}

/** One JSON object per line — the shape DuckDB/jq read directly. */
export function formatRowsJsonl(rows: readonly ToolCallRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
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
  "sidechain",
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
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
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
      sidechain: row.sidechain,
    };
    lines.push(CSV_COLUMNS.map((column) => csvCell(cells[column])).join(","));
  }
  return lines.join("\n");
}
