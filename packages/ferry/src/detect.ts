/**
 * Content-based input format detection. Filenames are hints at best — the
 * detector inspects structure and never trusts extensions alone.
 */

import { asRecord, tryParseJson } from "./adapters/shared.js";

export type InputFormat =
  | "claude-code"
  | "codex"
  | "opencode"
  | "kiro"
  | "pi"
  | "chatgpt-export"
  | "thread";

export function detectFormat(content: string): InputFormat | undefined {
  const trimmed = content.trimStart();

  // JSONL: decide from the first few parseable lines.
  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  const firstRecord = asRecord(tryParseJson(firstLine));
  if (firstRecord) {
    if (
      firstRecord["type"] === "session_meta" ||
      firstRecord["type"] === "response_item" ||
      firstRecord["type"] === "turn_context" ||
      firstRecord["type"] === "event_msg"
    ) {
      return "codex";
    }
    if (isClaudeCodeRecord(firstRecord)) {
      return "claude-code";
    }
    if (isKiroRecord(firstRecord)) return "kiro";
    if (isPiRecord(firstRecord)) return "pi";
  }

  const document = tryParseJson(trimmed);
  if (document === undefined) {
    // Not a single JSON document; scan JSONL lines for markers. Compacted
    // Claude Code sessions can start with dozens of summary lines that carry
    // no sessionId, so the scan window is generous.
    for (const line of trimmed.split("\n").slice(0, 200)) {
      const record = asRecord(tryParseJson(line));
      if (!record) continue;
      if (isClaudeCodeRecord(record)) return "claude-code";
      if (record["type"] === "response_item" || record["type"] === "session_meta") {
        return "codex";
      }
      if (isKiroRecord(record)) return "kiro";
      if (isPiRecord(record)) return "pi";
    }
    return undefined;
  }

  if (Array.isArray(document)) {
    const first = asRecord(document[0]);
    if (first && "mapping" in first) return "chatgpt-export";
    return undefined;
  }

  const record = asRecord(document);
  if (!record) return undefined;
  if ("mapping" in record) return "chatgpt-export";
  if ("schemaVersion" in record && "messages" in record) return "thread";
  if ("messages" in record && Array.isArray(record["messages"])) {
    const first = asRecord(record["messages"][0]);
    if (first && "parts" in first && "info" in first) return "opencode";
    if ("id" in record && "createdAt" in record) return "thread";
    if ("info" in record) return "opencode";
  }
  return undefined;
}

/** Claude Code lines carry sessionId/parentUuid, or are its bookkeeping records. */
function isClaudeCodeRecord(record: Record<string, unknown>): boolean {
  if ("sessionId" in record || "parentUuid" in record) return true;
  const type = record["type"];
  return (
    (type === "summary" && "leafUuid" in record) ||
    type === "ai-title" ||
    type === "file-history-snapshot"
  );
}

/** Kiro CLI lines are {version, kind: Prompt|AssistantMessage|ToolResults|Compaction, data}. */
function isKiroRecord(record: Record<string, unknown>): boolean {
  return (
    "data" in record &&
    typeof record["kind"] === "string" &&
    ["Prompt", "AssistantMessage", "ToolResults", "Compaction"].includes(record["kind"])
  );
}

/** pi lines are {type: session|message|model_change|...}; the header carries cwd+version. */
function isPiRecord(record: Record<string, unknown>): boolean {
  if (record["type"] === "session" && "cwd" in record && "version" in record) return true;
  if (record["type"] === "message" && "message" in record && "parentId" in record) return true;
  return false;
}
