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
 * - Pricing and deduplication usage extras are retained in
 *   `metadata.claudeUsageExtras`; other provider-specific usage fields (such
 *   as `inference_geo`, `iterations`, and `speed`) are dropped.
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
            cache_creation: z
              .object({
                ephemeral_5m_input_tokens: z.number().int().nonnegative().optional(),
                ephemeral_1h_input_tokens: z.number().int().nonnegative().optional(),
              })
              .optional(),
            // Observed Claude Code transcripts emit `null` when the API did
            // not assign a service tier. It is intentionally not exported as
            // a pricing extra (assistantUsageExtras only retains strings).
            service_tier: z.string().nullish(),
            server_tool_use: z
              .object({
                web_search_requests: z.number().int().nonnegative().optional(),
                web_fetch_requests: z.number().int().nonnegative().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    uuid: z.string().optional(),
    requestId: z.string().optional(),
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

interface ClaudeReducerState {
  format: "claude-code";
  includeSidechains: boolean;
  messages: Message[];
  assistantById: Record<string, number>;
  syntheticId: number;
  eventCount: number;
  skippedLines: number;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  title?: string;
}

function claudeThread(state: ClaudeReducerState): Thread {
  if (state.eventCount === 0) throw new Error("No Claude Code conversation events found in input");
  if (state.messages.length === 0) throw new Error("Claude Code input contained no importable messages");
  const messages = structuredClone(state.messages);
  const threadId = state.sessionId ?? "claude-code-session";
  return {
    schemaVersion: THREAD_SCHEMA_VERSION, id: threadId, messages,
    metadata: { source: "claude-code", sourceVersion: state.version, cwd: state.cwd,
      title: state.title, git: state.gitBranch ? { branch: state.gitBranch } : undefined },
    createdAt: messages[0]?.timestamp ?? Date.now(),
    updatedAt: messages[messages.length - 1]?.timestamp ?? Date.now(),
  };
}

function stepClaude(event: ConversationEvent, state: ClaudeReducerState): void {
  const threadId = state.sessionId ?? "claude-code-session";
  const messages = state.messages;
  const nextId = (): string => `${threadId}:${++state.syntheticId}`;
  // One API assistant message is split across several JSONL lines sharing
  // message.id; sidechain lines can interleave, so merging is by id lookup,
  // keyed separately per sidechain-ness to keep attribution honest.
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
      return;
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
    if (content.length === 0) return;

    const usage = apiMessage.usage;
    const claudeUsageExtras = usage && assistantUsageExtras(usage, event.requestId);
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
      ...((event.isSidechain || claudeUsageExtras)
        ? {
            metadata: {
              ...(event.isSidechain ? { sidechain: true } : {}),
              ...(claudeUsageExtras ? { claudeUsageExtras } : {}),
            },
          }
        : {}),
    };

    const mergeKey =
      apiMessage.id !== undefined
        ? `${event.isSidechain ? "side:" : "main:"}${apiMessage.id}`
        : undefined;
    const existingIndex = mergeKey !== undefined ? state.assistantById[mergeKey] : undefined;
    const existing = existingIndex === undefined ? undefined : messages[existingIndex];
    if (existing?.role === "assistant") {
      existing.content.push(...content);
      existing.model ??= assistantMessage.model;
      existing.usage = assistantMessage.usage ?? existing.usage;
      if (assistantMessage.usage !== undefined) {
        const claudeUsageExtras = assistantMessage.metadata?.["claudeUsageExtras"];
        if (claudeUsageExtras !== undefined) {
          existing.metadata = {
            ...existing.metadata,
            claudeUsageExtras,
          };
        } else if (existing.metadata?.["claudeUsageExtras"] !== undefined) {
          const { claudeUsageExtras: _, ...metadata } = existing.metadata;
          existing.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
        }
      }
      existing.finishReason = assistantMessage.finishReason ?? existing.finishReason;
    } else {
      messages.push(assistantMessage);
      if (mergeKey !== undefined) state.assistantById[mergeKey] = messages.length - 1;
    }
}

/** JSON-safe checkpoint for a Claude Code incremental importer.
 *
 * Hosts pass complete JSONL lines only: ferry deliberately does not retain or
 * reconstruct partial byte records. `pushLines` announcements are append-only;
 * `thread()` is authoritative because a later split record can amend an
 * already announced assistant message. This adapter owns no files, watches,
 * byte offsets, paths, or source handles.
 */
export type ClaudeCodeImporterState = ClaudeReducerState;

export interface IncrementalImporter<State> {
  pushLines(lines: readonly string[]): Message[];
  state(): State;
  thread(): Thread;
}

export function createClaudeCodeImporter(
  options: ClaudeCodeImportOptions = {},
): IncrementalImporter<ClaudeCodeImporterState> {
  return claudeImporter({
    format: "claude-code",
    includeSidechains: options.includeSidechains === true,
    messages: [], assistantById: {}, syntheticId: 0, eventCount: 0, skippedLines: 0,
  }, options.onWarn);
}

export function restoreClaudeCodeImporter(
  state: ClaudeCodeImporterState,
  options: Pick<ClaudeCodeImportOptions, "onWarn"> = {},
): IncrementalImporter<ClaudeCodeImporterState> {
  if (state.format !== "claude-code") throw new Error("Invalid Claude Code importer state");
  return claudeImporter(structuredClone(state), options.onWarn);
}

function claudeImporter(
  snapshot: ClaudeCodeImporterState,
  onWarn: ClaudeCodeImportOptions["onWarn"],
): IncrementalImporter<ClaudeCodeImporterState> {
  const current = (): Thread => claudeThread(snapshot);
  return {
    pushLines(lines) {
      if (lines.length === 0) return [];
      const start = snapshot.messages.length;
      let skipped = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { skipped += 1; continue; }
        if (typeof raw !== "object" || raw === null) continue;
        const record = raw as Record<string, unknown>;
        if (record["type"] === "ai-title" && typeof record["aiTitle"] === "string") {
          snapshot.title = record["aiTitle"]; continue;
        }
        if (record["type"] === "summary" && typeof record["summary"] === "string") {
          snapshot.title ??= record["summary"]; continue;
        }
        const parsed = ConversationEvent.safeParse(raw);
        if (!parsed.success) {
          if (record["type"] === "user" || record["type"] === "assistant") skipped += 1;
          continue;
        }
        const event = parsed.data;
        if (event.isSidechain && !snapshot.includeSidechains) continue;
        if (event.isMeta) continue;
        snapshot.sessionId ??= event.sessionId;
        snapshot.cwd ??= event.cwd;
        snapshot.version ??= event.version;
        snapshot.gitBranch ??= event.gitBranch;
        snapshot.eventCount += 1;
        stepClaude(event, snapshot);
      }
      if (skipped > 0) onWarn?.(`claude-code: skipped ${skipped} unparseable or unrecognized conversation line(s)`);
      return snapshot.messages.slice(start);
    },
    state: () => structuredClone(snapshot),
    thread: current,
  };
}

/** One-shot compatibility wrapper over the incremental Claude Code core. */
export function importFromClaudeCode(
  jsonlContent: JsonlInput,
  options: ClaudeCodeImportOptions = {},
): Thread {
  const importer = createClaudeCodeImporter(options);
  importer.pushLines(toLines(jsonlContent));
  return importer.thread();
}

function assistantUsageExtras(
  usage: NonNullable<ConversationEvent["message"]["usage"]>,
  requestId: string | undefined,
): Record<string, unknown> | undefined {
  const extras = {
    ...(usage.cache_creation?.ephemeral_5m_input_tokens !== undefined
      ? { cacheCreation5m: usage.cache_creation.ephemeral_5m_input_tokens }
      : {}),
    ...(usage.cache_creation?.ephemeral_1h_input_tokens !== undefined
      ? { cacheCreation1h: usage.cache_creation.ephemeral_1h_input_tokens }
      : {}),
    ...(typeof usage.service_tier === "string" ? { serviceTier: usage.service_tier } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(usage.server_tool_use !== undefined ? { serverToolUse: usage.server_tool_use } : {}),
  };
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function lastTimestamp(messages: Message[]): number | undefined {
  return messages[messages.length - 1]?.timestamp;
}
