/**
 * Import from Kiro CLI session transcripts.
 * Source: ~/.kiro/sessions/cli/<session-id>.jsonl
 *
 * Each line is `{version, kind, data}`:
 * - `Prompt` — user turn: `{message_id, content: parts[], meta: {timestamp}}`
 *   (timestamp in epoch SECONDS)
 * - `AssistantMessage` — `{message_id, content: parts[]}` (no timestamp)
 * - `ToolResults` — `{message_id, content: [toolResult parts], results}`
 * - `Compaction` — context summarization bookkeeping, skipped
 * Content parts are `{kind, data}`: `text` (data is the string), `toolUse`
 * (`{toolUseId, name, input}`), `toolResult` (`{toolUseId, content: parts,
 * status?}` where nested parts use kind `text` or `json`), `thinking`
 * (`{text, signature}`), `image` (`{format, source: {kind: "bytes", data:
 * byte[]}}`).
 *
 * Known limitations (deliberate):
 * - The session sidecar JSON (title, cwd) is a separate file; this importer
 *   reads only the JSONL stream, so those fields are absent. The session id
 *   is taken from the filename by callers via `options.sessionId`.
 * - Assistant/tool records carry no timestamps; they inherit the preceding
 *   prompt's time.
 * - `Compaction` snapshots are skipped (their messages duplicate history).
 * - Image byte arrays are imported as base64.
 */

import { z } from "zod";
import type {
  AssistantContent,
  ContentPart,
  Message,
  Thread,
  ThreadMetadata,
  ToolResult,
} from "@kontourai/thread";
import { THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import { asRecord, toLines, type JsonlInput } from "./shared.js";

// `version` is a string tag ("v1") in real transcripts; typing it loosely
// keeps a future tag change from silently deleting every line.
const KiroRecord = z
  .object({
    kind: z.string(),
    // See codex.ts: zod 4 makes bare `z.unknown()` keys required at parse
    // time, so a record without `data` would be dropped as unparseable.
    data: z.unknown().optional(),
    version: z.unknown().optional(),
  })
  .passthrough();

export interface KiroImportOptions {
  /** Session id (the JSONL filename stem); used as the thread id. */
  sessionId?: string;
  /** Called with a summary of skipped/unparseable records, if any. */
  onWarn?: (message: string) => void;
}

function bytesToBase64(bytes: unknown): string | undefined {
  if (!Array.isArray(bytes) || bytes.length === 0) return undefined;
  if (!bytes.every((b) => typeof b === "number")) return undefined;
  return Buffer.from(bytes as number[]).toString("base64");
}

function textFromResultParts(parts: unknown): ContentPart[] {
  const out: ContentPart[] = [];
  if (!Array.isArray(parts)) return out;
  for (const part of parts) {
    const p = asRecord(part);
    if (!p) continue;
    if (p["kind"] === "text" && typeof p["data"] === "string") {
      out.push({ type: "text", text: p["data"] });
    } else if (p["kind"] === "json") {
      out.push({ type: "text", text: JSON.stringify(p["data"]) });
    }
  }
  return out;
}

export function importFromKiro(jsonlContent: JsonlInput, options: KiroImportOptions = {}): Thread {
  const threadId = options.sessionId ?? "kiro-session";
  const messages: Message[] = [];
  let syntheticId = 0;
  const nextId = (): string => `${threadId}:${++syntheticId}`;
  let skippedLines = 0;
  let lastTimestamp: number | undefined;

  const currentTime = (): number => lastTimestamp ?? Date.now();

  for (const line of toLines(jsonlContent)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const parsed = KiroRecord.safeParse(raw);
    if (!parsed.success) {
      skippedLines += 1;
      continue;
    }
    const { kind } = parsed.data;
    const data = asRecord(parsed.data.data);
    if (!data) {
      if (kind !== "Compaction") skippedLines += 1;
      continue;
    }
    const messageId = typeof data["message_id"] === "string" ? data["message_id"] : undefined;
    const contentParts = Array.isArray(data["content"]) ? data["content"] : [];

    if (kind === "Prompt") {
      const meta = asRecord(data["meta"]);
      const seconds = typeof meta?.["timestamp"] === "number" ? meta["timestamp"] : undefined;
      if (seconds !== undefined && seconds > 0) lastTimestamp = Math.round(seconds * 1000);
      const content: ContentPart[] = [];
      const toolResults: ToolResult[] = [];
      for (const part of contentParts) {
        const p = asRecord(part);
        if (!p) continue;
        if (p["kind"] === "text" && typeof p["data"] === "string") {
          content.push({ type: "text", text: p["data"] });
        } else if (p["kind"] === "image") {
          const d = asRecord(p["data"]);
          const source = asRecord(d?.["source"]);
          const base64 = bytesToBase64(source?.["data"]);
          if (base64 !== undefined) {
            const format = typeof d?.["format"] === "string" ? d["format"] : "png";
            content.push({ type: "image", data: base64, mediaType: `image/${format}` });
          }
        } else if (p["kind"] === "toolResult") {
          const result = toToolResult(p["data"]);
          if (result) toolResults.push(result);
        }
      }
      if (toolResults.length > 0) {
        messages.push({
          id: messageId ?? nextId(),
          threadId,
          role: "tool",
          timestamp: currentTime(),
          toolResults,
        });
      }
      if (content.length > 0) {
        messages.push({
          id: toolResults.length > 0 ? nextId() : (messageId ?? nextId()),
          threadId,
          role: "user",
          timestamp: currentTime(),
          content,
        });
      }
    } else if (kind === "AssistantMessage") {
      const content: AssistantContent[] = [];
      for (const part of contentParts) {
        const p = asRecord(part);
        if (!p) continue;
        if (p["kind"] === "text" && typeof p["data"] === "string") {
          content.push({ type: "text", text: p["data"] });
        } else if (p["kind"] === "thinking") {
          const d = asRecord(p["data"]);
          if (typeof d?.["text"] === "string") {
            content.push({
              type: "reasoning",
              reasoning: {
                type: "reasoning",
                text: d["text"],
                signature: typeof d["signature"] === "string" ? d["signature"] : undefined,
              },
            });
          }
        } else if (p["kind"] === "toolUse") {
          const d = asRecord(p["data"]);
          if (typeof d?.["toolUseId"] === "string" && typeof d["name"] === "string") {
            const input = d["input"];
            content.push({
              type: "tool_call",
              toolCall: {
                id: d["toolUseId"],
                name: d["name"],
                arguments: JSON.stringify(input ?? {}),
                parsedArguments: asRecord(input),
              },
            });
          }
        }
      }
      if (content.length > 0) {
        messages.push({
          id: messageId ?? nextId(),
          threadId,
          role: "assistant",
          timestamp: currentTime(),
          content,
        });
      } else {
        skippedLines += 1;
      }
    } else if (kind === "ToolResults") {
      const toolResults: ToolResult[] = [];
      for (const part of contentParts) {
        const p = asRecord(part);
        if (p?.["kind"] === "toolResult") {
          const result = toToolResult(p["data"]);
          if (result) toolResults.push(result);
        }
      }
      if (toolResults.length > 0) {
        messages.push({
          id: messageId ?? nextId(),
          threadId,
          role: "tool",
          timestamp: currentTime(),
          toolResults,
        });
      }
    }
    // Compaction and unknown kinds are skipped.
  }

  if (skippedLines > 0) {
    options.onWarn?.(`kiro: skipped ${skippedLines} unparseable or unrecognized line(s)`);
  }
  if (messages.length === 0) {
    throw new Error("Kiro input contained no importable messages");
  }

  const metadata: ThreadMetadata = { source: "kiro" };

  return {
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: threadId,
    messages,
    metadata,
    createdAt: messages[0]?.timestamp ?? Date.now(),
    updatedAt: messages[messages.length - 1]?.timestamp ?? Date.now(),
  };
}

function toToolResult(data: unknown): ToolResult | null {
  const d = asRecord(data);
  if (!d || typeof d["toolUseId"] !== "string") return null;
  const status = typeof d["status"] === "string" ? d["status"] : undefined;
  return {
    toolCallId: d["toolUseId"],
    name: typeof d["name"] === "string" ? d["name"] : "",
    content: textFromResultParts(d["content"]),
    isError: status === "error" ? true : undefined,
  };
}
