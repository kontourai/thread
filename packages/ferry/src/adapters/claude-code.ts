/**
 * Import from Claude Code session transcripts.
 * Source: ~/.claude/projects/<project>/<session-id>.jsonl
 *
 * The JSONL stream mixes conversation events (`type: "user" | "assistant"`)
 * with bookkeeping events (attachments, hook output, titles, snapshots, …).
 * Only conversation events become messages. Field names are camelCase
 * (`sessionId`, `parentUuid`, `isSidechain`) and content blocks use the
 * Anthropic API shapes: `{type:"tool_use", id, name, input}`,
 * `{type:"tool_result", tool_use_id, content}`, `{type:"thinking", thinking,
 * signature}`, `{type:"image", source:{media_type, data}}`.
 *
 * Known limitations (deliberate):
 * - Sidechain events (subagent transcripts, `isSidechain: true`) are skipped
 *   by default; with `includeSidechains: true` they are kept interleaved and
 *   tagged `metadata.sidechain: true`.
 * - `isMeta` user events (injected context, not user speech) are skipped.
 * - The `toolUseResult` sidecar (structured duplicate of tool_result content,
 *   often containing whole files) is not imported.
 * Records that fail to parse are skipped and counted; pass `onWarn` to hear
 * about them instead of losing data silently.
 *
 * Chronology tradeoff: split assistant lines sharing one API message id are
 * merged into a single message even when other events (tool results, user
 * interjections) landed between them in the file — the id denotes one API
 * message, so reconstruction wins over strict file order. Real transcripts
 * also occasionally repeat a user-event uuid on two distinct lines; message
 * ids are therefore not guaranteed unique across a thread.
 */

import { z } from "zod";
import type {
  AssistantContent,
  AssistantMessage,
  ContentPart,
  ImagePart,
  Message,
  Thread,
  ThreadMetadata,
  ToolResult,
} from "@kontourai/thread";
import { FinishReason, THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import { parseTimestamp, toLines, type JsonlInput } from "./shared.js";

const ConversationEvent = z
  .object({
    type: z.enum(["user", "assistant"]),
    message: z
      .object({
        role: z.enum(["user", "assistant"]),
        // Items are validated individually during processing so one malformed
        // block cannot delete the whole event.
        content: z.union([z.string(), z.array(z.unknown())]),
        id: z.string().optional(),
        model: z.string().optional(),
        stop_reason: z.string().nullish(),
        usage: z
          .object({
            input_tokens: z.number().int().nonnegative().optional(),
            output_tokens: z.number().int().nonnegative().optional(),
            cache_read_input_tokens: z.number().int().nonnegative().nullish(),
            cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    uuid: z.string().optional(),
    timestamp: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    version: z.string().optional(),
    gitBranch: z.string().optional(),
    isSidechain: z.boolean().optional(),
    isMeta: z.boolean().optional(),
  })
  .passthrough();

type ConversationEvent = z.infer<typeof ConversationEvent>;

const STOP_REASON_MAP: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

export interface ClaudeCodeImportOptions {
  includeSidechains?: boolean;
  /** Called with a summary of skipped/unparseable records, if any. */
  onWarn?: (message: string) => void;
}

function imagePartFromSource(source: unknown): ImagePart | null {
  if (typeof source !== "object" || source === null) return null;
  const s = source as Record<string, unknown>;
  if (s["type"] === "base64" && typeof s["data"] === "string") {
    return {
      type: "image",
      data: s["data"],
      mediaType: typeof s["media_type"] === "string" ? s["media_type"] : "image/png",
    };
  }
  if (s["type"] === "url" && typeof s["url"] === "string") {
    return { type: "image", data: s["url"], mediaType: "image/*" };
  }
  return null;
}

function contentPartsFromBlocks(blocks: unknown): ContentPart[] {
  const parts: ContentPart[] = [];
  if (typeof blocks === "string") {
    return [{ type: "text", text: blocks }];
  }
  if (!Array.isArray(blocks)) return parts;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      parts.push({ type: "text", text: b["text"] });
    } else if (b["type"] === "image") {
      const img = imagePartFromSource(b["source"]);
      if (img) parts.push(img);
    }
  }
  return parts;
}

export function importFromClaudeCode(
  jsonlContent: JsonlInput,
  options: ClaudeCodeImportOptions = {},
): Thread {
  const events: ConversationEvent[] = [];
  let skippedLines = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let gitBranch: string | undefined;
  let title: string | undefined;

  for (const line of toLines(jsonlContent)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue; // tolerate truncated/corrupt lines
    }
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;

    // Bookkeeping events that carry thread-level metadata.
    if (record["type"] === "ai-title" && typeof record["aiTitle"] === "string") {
      title = record["aiTitle"];
      continue;
    }
    if (record["type"] === "summary" && typeof record["summary"] === "string") {
      title ??= record["summary"];
      continue;
    }

    const parsed = ConversationEvent.safeParse(raw);
    if (!parsed.success) {
      if (record["type"] === "user" || record["type"] === "assistant") skippedLines += 1;
      continue;
    }
    const event = parsed.data;

    if (event.isSidechain && !options.includeSidechains) continue;
    if (event.isMeta) continue;

    sessionId ??= event.sessionId;
    cwd ??= event.cwd;
    version ??= event.version;
    gitBranch ??= event.gitBranch;
    events.push(event);
  }

  if (skippedLines > 0) {
    options.onWarn?.(
      `claude-code: skipped ${skippedLines} unparseable or unrecognized conversation line(s)`,
    );
  }
  if (events.length === 0) {
    throw new Error("No Claude Code conversation events found in input");
  }

  const threadId = sessionId ?? "claude-code-session";
  const messages: Message[] = [];
  // One API assistant message is split across several JSONL lines sharing
  // message.id; sidechain lines can interleave, so merging is by id lookup,
  // keyed separately per sidechain-ness to keep attribution honest.
  const assistantById = new Map<string, AssistantMessage>();
  let syntheticId = 0;
  const nextId = (): string => `${threadId}:${++syntheticId}`;

  for (const event of events) {
    const timestamp = parseTimestamp(event.timestamp) ?? lastTimestamp(messages) ?? Date.now();
    const apiMessage = event.message;

    if (apiMessage.role === "user") {
      const blocks = typeof apiMessage.content === "string" ? [] : apiMessage.content;
      const toolResults: ToolResult[] = [];
      for (const block of blocks) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b["type"] === "tool_result" && typeof b["tool_use_id"] === "string") {
          toolResults.push({
            toolCallId: b["tool_use_id"],
            name: "",
            content: contentPartsFromBlocks(b["content"]),
            isError: typeof b["is_error"] === "boolean" ? b["is_error"] : undefined,
          });
        }
      }
      if (toolResults.length > 0) {
        messages.push({
          id: event.uuid ?? nextId(),
          threadId,
          role: "tool",
          timestamp,
          toolResults,
          ...(event.isSidechain ? { metadata: { sidechain: true } } : {}),
        });
      }
      const content = contentPartsFromBlocks(apiMessage.content);
      if (content.length > 0) {
        messages.push({
          // A user event holding only tool_results consumed the uuid above;
          // mixed events get a synthetic id for the text half.
          id: toolResults.length > 0 ? nextId() : (event.uuid ?? nextId()),
          threadId,
          role: "user",
          timestamp,
          content,
          ...(event.isSidechain ? { metadata: { sidechain: true } } : {}),
        });
      }
      continue;
    }

    // Assistant: one API message is often split across several JSONL lines
    // sharing message.id — merge those into a single assistant message.
    const content: AssistantContent[] = [];
    const blocks = typeof apiMessage.content === "string"
      ? [{ type: "text", text: apiMessage.content }]
      : apiMessage.content;
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        content.push({ type: "text", text: b["text"] });
      } else if (b["type"] === "thinking") {
        content.push({
          type: "reasoning",
          reasoning: {
            type: "reasoning",
            text: typeof b["thinking"] === "string" ? b["thinking"] : undefined,
            signature: typeof b["signature"] === "string" ? b["signature"] : undefined,
          },
        });
      } else if (b["type"] === "redacted_thinking") {
        content.push({
          type: "reasoning",
          reasoning: {
            type: "reasoning",
            // `data` is the opaque material the API requires back verbatim on
            // replay; the anthropic exporter re-emits it as redacted_thinking.
            providerMetadata: {
              redacted: true,
              ...(typeof b["data"] === "string" ? { data: b["data"] } : {}),
            },
          },
        });
      } else if (
        b["type"] === "tool_use" &&
        typeof b["id"] === "string" &&
        typeof b["name"] === "string"
      ) {
        const input = b["input"];
        content.push({
          type: "tool_call",
          toolCall: {
            id: b["id"],
            name: b["name"],
            arguments: JSON.stringify(input ?? {}),
            parsedArguments:
              typeof input === "object" && input !== null && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : undefined,
          },
        });
      } else if (b["type"] === "image") {
        const img = imagePartFromSource(b["source"]);
        if (img) content.push({ type: "image", image: img });
      }
      // Other block types (fallback markers, server tool blocks, …) are skipped.
    }
    if (content.length === 0) continue;

    const usage = apiMessage.usage;
    const stopReason = apiMessage.stop_reason ?? undefined;
    const assistantMessage: AssistantMessage = {
      id: apiMessage.id ?? event.uuid ?? nextId(),
      threadId,
      role: "assistant",
      timestamp,
      content,
      model: apiMessage.model,
      provider: "anthropic",
      usage:
        usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)
          ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
            }
          : undefined,
      finishReason: stopReason ? STOP_REASON_MAP[stopReason] : undefined,
      ...(event.isSidechain ? { metadata: { sidechain: true } } : {}),
    };

    const mergeKey =
      apiMessage.id !== undefined
        ? `${event.isSidechain ? "side:" : "main:"}${apiMessage.id}`
        : undefined;
    const existing = mergeKey !== undefined ? assistantById.get(mergeKey) : undefined;
    if (existing !== undefined) {
      existing.content.push(...content);
      existing.model ??= assistantMessage.model;
      existing.usage = assistantMessage.usage ?? existing.usage;
      existing.finishReason = assistantMessage.finishReason ?? existing.finishReason;
    } else {
      messages.push(assistantMessage);
      if (mergeKey !== undefined) assistantById.set(mergeKey, assistantMessage);
    }
  }

  if (messages.length === 0) {
    throw new Error("Claude Code input contained no importable messages");
  }

  const metadata: ThreadMetadata = {
    source: "claude-code",
    sourceVersion: version,
    cwd,
    title,
    git: gitBranch ? { branch: gitBranch } : undefined,
  };

  return {
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: threadId,
    messages,
    metadata,
    createdAt: messages[0]?.timestamp ?? Date.now(),
    updatedAt: messages[messages.length - 1]?.timestamp ?? Date.now(),
  };
}

function lastTimestamp(messages: Message[]): number | undefined {
  return messages[messages.length - 1]?.timestamp;
}
