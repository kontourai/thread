/**
 * Import from pi coding-agent session transcripts.
 * Source: ~/.pi/agent/sessions/<project-dir>/<timestamp>_<uuid>.jsonl
 *
 * The first line is a `session` header `{type, id, cwd, timestamp, version}`.
 * Conversation lines are `{type: "message", id, parentId, timestamp,
 * message}` where `message.role` is:
 * - `user` — `content` is a string or `[{type: "text", text}]`
 * - `assistant` — carries `model`, `provider`, `api`, `stopReason`, `usage`
 *   (`{input, output, cacheRead, cacheWrite}`), and content parts `text`,
 *   `thinking` (`{thinking, thinkingSignature}`), `toolCall`
 *   (`{id, name, arguments}` — arguments is already an object)
 * - `toolResult` — a whole message per result: `{toolCallId, toolName,
 *   isError, content: [{type: "text", text}]}`
 * `model_change` / `thinking_level_change` lines are settings bookkeeping,
 * skipped.
 *
 * Known limitations (deliberate):
 * - Messages are imported in file order (append order); `parentId` links are
 *   not re-walked.
 * - Non-text tool result content is flattened to text placeholders.
 */

import { z } from "zod";
import type {
  AssistantContent,
  ContentPart,
  FinishReason,
  Message,
  Thread,
  ThreadMetadata,
} from "@kontourai/thread";
import { THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import { asRecord, parseTimestamp, toLines, type JsonlInput } from "./shared.js";

const PiLine = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    message: z.unknown().optional(),
    cwd: z.string().optional(),
    version: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const STOP_REASON_MAP: Record<string, FinishReason> = {
  stop: "stop",
  toolUse: "tool_calls",
  length: "length",
  maxTokens: "length",
  error: "error",
  aborted: "cancelled",
};

export interface PiImportOptions {
  /** Called with a summary of skipped/unparseable records, if any. */
  onWarn?: (message: string) => void;
}

function userContent(content: unknown): ContentPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const parts: ContentPart[] = [];
  if (!Array.isArray(content)) return parts;
  for (const item of content) {
    const p = asRecord(item);
    if (!p) continue;
    if (p["type"] === "text" && typeof p["text"] === "string") {
      parts.push({ type: "text", text: p["text"] });
    } else if (p["type"] === "image" && typeof p["data"] === "string") {
      parts.push({
        type: "image",
        data: p["data"],
        mediaType: typeof p["mimeType"] === "string" ? p["mimeType"] : "image/png",
      });
    }
  }
  return parts;
}

export function importFromPi(jsonlContent: JsonlInput, options: PiImportOptions = {}): Thread {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let skippedLines = 0;
  const messages: Message[] = [];
  let syntheticId = 0;
  const threadIdRef = (): string => sessionId ?? "pi-session";
  const nextId = (): string => `${threadIdRef()}:${++syntheticId}`;

  for (const line of toLines(jsonlContent)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const parsed = PiLine.safeParse(raw);
    if (!parsed.success) {
      skippedLines += 1;
      continue;
    }
    const record = parsed.data;

    if (record.type === "session") {
      sessionId ??= record.id;
      cwd ??= record.cwd;
      version ??= record.version !== undefined ? String(record.version) : undefined;
      continue;
    }
    if (record.type !== "message") continue; // model_change etc. are settings noise

    const message = asRecord(record.message);
    if (!message) {
      skippedLines += 1;
      continue;
    }
    const role = message["role"];
    const timestamp =
      parseTimestamp(message["timestamp"]) ??
      parseTimestamp(record.timestamp) ??
      messages[messages.length - 1]?.timestamp ??
      Date.now();

    if (role === "user") {
      const content = userContent(message["content"]);
      if (content.length === 0) continue;
      messages.push({
        id: record.id ?? nextId(),
        threadId: threadIdRef(),
        role: "user",
        timestamp,
        content,
      });
    } else if (role === "assistant") {
      const content: AssistantContent[] = [];
      const rawContent = Array.isArray(message["content"]) ? message["content"] : [];
      for (const item of rawContent) {
        const p = asRecord(item);
        if (!p) continue;
        if (p["type"] === "text" && typeof p["text"] === "string") {
          content.push({ type: "text", text: p["text"] });
        } else if (p["type"] === "thinking") {
          const text = typeof p["thinking"] === "string" ? p["thinking"] : undefined;
          const signature =
            typeof p["thinkingSignature"] === "string" ? p["thinkingSignature"] : undefined;
          if ((text !== undefined && text.length > 0) || signature !== undefined) {
            content.push({
              type: "reasoning",
              reasoning: { type: "reasoning", text, signature },
            });
          }
        } else if (p["type"] === "toolCall" && typeof p["id"] === "string") {
          const args = p["arguments"];
          content.push({
            type: "tool_call",
            toolCall: {
              id: p["id"],
              name: typeof p["name"] === "string" ? p["name"] : "unknown",
              arguments: JSON.stringify(args ?? {}),
              parsedArguments: asRecord(args),
            },
          });
        }
      }
      if (content.length === 0) continue;
      const usage = asRecord(message["usage"]);
      const stopReason =
        typeof message["stopReason"] === "string" ? message["stopReason"] : undefined;
      const asNonNegInt = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? Math.round(value)
          : undefined;
      messages.push({
        id: record.id ?? nextId(),
        threadId: threadIdRef(),
        role: "assistant",
        timestamp,
        content,
        model: typeof message["model"] === "string" ? message["model"] : undefined,
        provider: typeof message["provider"] === "string" ? message["provider"] : undefined,
        usage:
          usage && (usage["input"] !== undefined || usage["output"] !== undefined)
            ? {
                inputTokens: asNonNegInt(usage["input"]) ?? 0,
                outputTokens: asNonNegInt(usage["output"]) ?? 0,
                cacheReadTokens: asNonNegInt(usage["cacheRead"]),
                cacheWriteTokens: asNonNegInt(usage["cacheWrite"]),
              }
            : undefined,
        finishReason: stopReason !== undefined ? STOP_REASON_MAP[stopReason] : undefined,
      });
    } else if (role === "toolResult") {
      if (typeof message["toolCallId"] !== "string") continue;
      const text = Array.isArray(message["content"])
        ? message["content"]
            .map((item) => {
              const p = asRecord(item);
              if (p?.["type"] === "text" && typeof p["text"] === "string") return p["text"];
              return p?.["type"] !== undefined ? `[${String(p["type"])}]` : "";
            })
            .filter((t) => t.length > 0)
            .join("\n")
        : "";
      messages.push({
        id: record.id ?? nextId(),
        threadId: threadIdRef(),
        role: "tool",
        timestamp,
        toolResults: [
          {
            toolCallId: message["toolCallId"],
            name: typeof message["toolName"] === "string" ? message["toolName"] : "",
            content: text ? [{ type: "text", text }] : [],
            isError: message["isError"] === true ? true : undefined,
          },
        ],
      });
    }
  }

  if (skippedLines > 0) {
    options.onWarn?.(`pi: skipped ${skippedLines} unparseable or unrecognized line(s)`);
  }
  if (messages.length === 0) {
    throw new Error("pi input contained no importable messages");
  }
  // The session header is normally line 1; if it arrived late, heal the
  // threadId on messages emitted before it.
  for (const message of messages) message.threadId = threadIdRef();

  const metadata: ThreadMetadata = {
    source: "pi",
    sourceVersion: version,
    cwd,
  };

  return {
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: threadIdRef(),
    messages,
    metadata,
    createdAt: messages[0]?.timestamp ?? Date.now(),
    updatedAt: messages[messages.length - 1]?.timestamp ?? Date.now(),
  };
}
