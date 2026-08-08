/**
 * Content-based input format detection. Filenames are hints at best — the
 * detector inspects structure and never trusts extensions alone.
 */

import { asRecord, tryParseJson } from "./adapters/shared.js";

export type InputFormat = "claude-code" | "codex" | "opencode" | "chatgpt-export" | "thread";

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
    if ("sessionId" in firstRecord || "parentUuid" in firstRecord) {
      return "claude-code";
    }
  }

  const document = tryParseJson(trimmed);
  if (document === undefined) {
    // Not a single JSON document; scan a few JSONL lines for claude-code markers.
    for (const line of trimmed.split("\n").slice(0, 20)) {
      const record = asRecord(tryParseJson(line));
      if (record && ("sessionId" in record || "parentUuid" in record)) return "claude-code";
      if (record && (record["type"] === "response_item" || record["type"] === "session_meta")) {
        return "codex";
      }
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
