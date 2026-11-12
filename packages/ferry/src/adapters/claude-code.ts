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
 * - Inline sidechain events (`isSidechain: true` inside a main session) are
 *   skipped by default; with `includeSidechains: true` they are kept
 *   interleaved and tagged `metadata.sidechain: true` plus `metadata.agentId`.
 * - A subagent transcript (`<session>/subagents/agent-<id>.jsonl`, where the
 *   first conversation record is a sidechain record carrying `agentId`) is
 *   the subagent's own conversation, so its records are imported without
 *   `includeSidechains`. Its records carry the PARENT's `sessionId`, so the
 *   thread id is `<sessionId>:agent-<agentId>` (an adapter-composed id, so
 *   message identities are adapter-fallback) and
 *   `metadata.custom.claudeSubagent` holds `{agentId, parentSessionId}`. The
 *   sibling `agent-<id>.meta.json` (agent type, spawning tool call) is not
 *   read: importers see only the transcript.
 * - `isMeta` user events (injected context, not user speech) are skipped.
 * - User-role messages carry a derived `origin` (see `claudeUserOrigin`).
 *   `isCompactSummary` wins, then `promptSource: "suggestion_accepted"`
 *   (model-written text a person accepted: unknown), then the record's own
 *   `origin.kind` (but `human` only when `promptSource` is absent, `typed`,
 *   or `queued`; Claude Code also stamps `human` on SDK-submitted prompts),
 *   then a message that is entirely harness wrapper blocks, then
 *   `promptSource` typed or queued, then `isSidechain` (a subagent's "user"
 *   is its parent agent).
 *   `turnOrigin` is deliberately ignored: it describes the turn, and records
 *   inside a human turn (local command output, for example) inherit it.
 *   Anything else, including SDK-submitted prompts, is `unknown`: an SDK
 *   client may relay a person's typing or an orchestrator's brief, and the
 *   record does not say which.
 * - The `toolUseResult` sidecar (structured duplicate of tool_result content,
 *   often containing whole files) is not imported.
 * - Result identity is derived from the observed session, event UUID (or
 *   raw source-record occurrence), and block index. The retained byte-real
 *   fixture has no error result, so `is_error: true` remains unknown; the
 *   observed false/absence contract is success.
 * - Pricing and deduplication usage extras are retained in
 *   `metadata.claudeUsageExtras`; other provider-specific usage fields (such
 *   as `inference_geo`, `iterations`, and `speed`) are dropped.
 * Records that fail to parse are skipped and counted as typed losses
 * (`unparseable-line` for invalid JSON, `unrecognized-record` for a
 * user/assistant record that fails the schema), reported through `onWarn`,
 * `onLosses`, the importer's `losses()`, and the thread's
 * `metadata.custom.ferryImportLosses`.
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
  MessageOrigin,
  MessageOriginKind,
  Thread,
  ThreadMetadata,
  ToolResult,
} from "@kontourai/thread";
import { FinishReason, THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import {
  deterministicToolResultId,
  importLosses,
  parseTimestamp,
  toLines,
  type ImportLoss,
  type JsonlInput,
} from "./shared.js";
import { wholeEnvelope, type EnvelopeVocabulary } from "./origin.js";
import type { MessageIdentityObservationSink } from "../answer.js";

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
    isCompactSummary: z.boolean().optional(),
    agentId: z.string().optional(),
    // Read defensively during origin derivation; an unexpected shape must
    // not reject the whole conversation event.
    origin: z.unknown().optional(),
    promptSource: z.unknown().optional(),
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
  onMessageIdentity?: MessageIdentityObservationSink;
  /** Called once per import with the typed, counted losses (only when there are any). */
  onLosses?: (losses: ImportLoss[]) => void;
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
  /** Every non-blank source record, before filters; checkpointed for stable anchors. */
  recordOrdinal: number;
  eventCount: number;
  /** Total of the two loss counters below. */
  skippedLines: number;
  /** Non-blank lines that were not valid JSON. */
  unparseableLines?: number;
  /** user/assistant records that failed the conversation-event schema. */
  unrecognizedRecords?: number;
  /** Set when the first conversation record decides whether this file is a subagent transcript. */
  firstEventSeen?: boolean;
  /** The subagent's id when this file is a subagent transcript. */
  subagentAgentId?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  title?: string;
  /**
   * Tool-call names awaiting their result, keyed by tool_use id (#38).
   * Bounded rather than a growing index: the entry is consumed when its
   * tool_result arrives, and results follow their call closely. A plain
   * record because the incremental importer serializes this state as JSON.
   */
  pendingToolNames?: Record<string, string>;
  /** Indices whose exact message ids were read from source records. */
  observedMessageIndices?: number[];
}

const pushClaudeMessage = (
  state: ClaudeReducerState,
  message: Message,
  messageIdWasObserved: boolean,
): void => {
  state.messages.push(message);
  if (messageIdWasObserved) (state.observedMessageIndices ??= []).push(state.messages.length - 1);
};

/**
 * A subagent transcript reuses its parent's sessionId, so its thread id is
 * composed to keep the two threads distinct.
 */
function claudeThreadId(state: ClaudeReducerState): string {
  const sessionId = state.sessionId ?? "claude-code-session";
  return state.subagentAgentId === undefined ? sessionId : `${sessionId}:agent-${state.subagentAgentId}`;
}

function claudeLosses(state: ClaudeReducerState): ImportLoss[] {
  return importLosses("claude-code", state.unparseableLines ?? 0, state.unrecognizedRecords ?? 0);
}

function claudeThread(state: ClaudeReducerState): Thread {
  if (state.eventCount === 0) throw new Error("No Claude Code conversation events found in input");
  if (state.messages.length === 0) throw new Error("Claude Code input contained no importable messages");
  const messages = structuredClone(state.messages);
  const threadId = claudeThreadId(state);
  const losses = claudeLosses(state);
  const custom = {
    ...(state.subagentAgentId !== undefined
      ? { claudeSubagent: { agentId: state.subagentAgentId, ...(state.sessionId !== undefined ? { parentSessionId: state.sessionId } : {}) } }
      : {}),
    ...(losses.length > 0 ? { ferryImportLosses: losses } : {}),
  };
  return {
    schemaVersion: THREAD_SCHEMA_VERSION, id: threadId, messages,
    metadata: { source: "claude-code", sourceVersion: state.version, cwd: state.cwd,
      title: state.title, git: state.gitBranch ? { branch: state.gitBranch } : undefined,
      ...(Object.keys(custom).length > 0 ? { custom } : {}) },
    createdAt: messages[0]?.timestamp ?? Date.now(),
    updatedAt: messages[messages.length - 1]?.timestamp ?? Date.now(),
  };
}

/** Sidechain marker plus, when the record names it, the subagent's id (#35). */
function sidechainMetadata(event: ConversationEvent): Record<string, unknown> | undefined {
  if (!event.isSidechain) return undefined;
  return { sidechain: true, ...(event.agentId !== undefined ? { agentId: event.agentId } : {}) };
}

function stepClaude(event: ConversationEvent, state: ClaudeReducerState, recordOrdinal: number): void {
  const threadId = claudeThreadId(state);
  const sidechain = sidechainMetadata(event);
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
      for (const [blockIndex, block] of blocks.entries()) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b["type"] === "tool_result" && typeof b["tool_use_id"] === "string") {
          // Carry the call's name onto its result (#38): Claude Code records
          // the name only on the tool_use block, so a result-side rollup
          // otherwise buckets everything under "". Consume the entry to keep
          // the map bounded; a genuinely unpaired result keeps "".
          const callId = b["tool_use_id"];
          const pendingNames = (state.pendingToolNames ??= {});
          const resolvedName = pendingNames[callId] ?? "";
          delete pendingNames[callId];
          const sessionAnchor = event.sessionId ?? state.sessionId;
          const eventAnchor = event.uuid ?? "record-without-uuid";
          toolResults.push({
            toolCallId: callId,
            name: resolvedName,
            content: contentPartsFromBlocks(b["content"]),
            // Claude's observed tool_result contract defaults an absent
            // is_error to false. This is source-format semantics, not an
            // inference from result prose.
            ...(b["is_error"] === false ? { isError: false } : {}),
            ...(sessionAnchor === undefined
              ? {}
              : {
                  resultId: deterministicToolResultId(
                    "claude-code",
                    [sessionAnchor, eventAnchor, `record:${recordOrdinal}`],
                    blockIndex,
                  ),
                  terminalStatus: b["is_error"] === false || b["is_error"] === undefined
                    ? "success"
                    : "unknown",
                  correlations: [
                    { namespace: "claude-code", kind: "session" as const, id: sessionAnchor },
                    ...(event.uuid === undefined
                      ? []
                      : [{ namespace: "claude-code", kind: "event" as const, id: event.uuid }]),
                    {
                      namespace: "claude-code",
                      kind: "message" as const,
                      id: apiMessage.id ?? event.uuid ?? `record:${recordOrdinal}`,
                    },
                  ],
                }),
          });
        }
      }
      if (toolResults.length > 0) {
        pushClaudeMessage(state, {
          id: event.uuid ?? nextId(),
          threadId,
          role: "tool",
          timestamp,
          toolResults,
          ...(sidechain ? { metadata: sidechain } : {}),
        }, event.uuid !== undefined);
      }
      const content = contentPartsFromBlocks(apiMessage.content);
      if (content.length > 0) {
        pushClaudeMessage(state, {
          // A user event holding only tool_results consumed the uuid above;
          // mixed events get a synthetic id for the text half.
          id: toolResults.length > 0 ? nextId() : (event.uuid ?? nextId()),
          threadId,
          role: "user",
          timestamp,
          content,
          origin: claudeUserOrigin(event, content),
          ...(sidechain ? { metadata: sidechain } : {}),
        }, toolResults.length === 0 && event.uuid !== undefined);
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
        (state.pendingToolNames ??= {})[b["id"]] = b["name"];
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
      ...((sidechain || claudeUsageExtras)
        ? {
            metadata: {
              ...(sidechain ?? {}),
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
      pushClaudeMessage(state, assistantMessage, apiMessage.id !== undefined || event.uuid !== undefined);
      if (mergeKey !== undefined) state.assistantById[mergeKey] = messages.length - 1;
    }
}

/** JSON-safe checkpoint for a Claude Code incremental importer.
 *
 * Hosts pass complete JSONL lines only: ferry deliberately does not retain or
 * reconstruct partial byte records. `pushLines` announcements are append-only;
 * `thread()` is authoritative because a later split record can amend an
 * already announced assistant message. A tailing host calls `finalize()` at
 * EOF, rotation, or close; it flushes any terminal content and announces it
 * exactly once (Claude Code currently has no separate pending buffer, so it
 * returns `[]`). This adapter owns no files, watches, byte offsets, paths, or
 * source handles.
 */
export type ClaudeCodeImporterState = ClaudeReducerState;

export interface IncrementalImporter<State> {
  pushLines(lines: readonly string[]): Message[];
  finalize(): Message[];
  state(): State;
  thread(): Thread;
  /** Typed, counted losses so far (lines or records that could not be imported). */
  losses(): ImportLoss[];
}

export function createClaudeCodeImporter(
  options: ClaudeCodeImportOptions = {},
): IncrementalImporter<ClaudeCodeImporterState> {
  return claudeImporter({
    format: "claude-code",
    includeSidechains: options.includeSidechains === true,
    messages: [], assistantById: {}, syntheticId: 0, recordOrdinal: 0, eventCount: 0, skippedLines: 0,
  }, options.onWarn);
}

export function restoreClaudeCodeImporter(
  state: ClaudeCodeImporterState,
  options: Pick<ClaudeCodeImportOptions, "onWarn"> = {},
): IncrementalImporter<ClaudeCodeImporterState> {
  if (state.format !== "claude-code") throw new Error("Invalid Claude Code importer state");
  const restored = structuredClone(state);
  // State saved before subagent detection existed has no firstEventSeen. If
  // it already imported events, its first event was decided (as a main
  // session), so a later sidechain record must not reclassify the file.
  if (restored.firstEventSeen === undefined && restored.eventCount > 0) restored.firstEventSeen = true;
  return claudeImporter(restored, options.onWarn);
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
      let unparseable = 0;
      let unrecognized = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        snapshot.recordOrdinal += 1;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { unparseable += 1; continue; }
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
          if (record["type"] === "user" || record["type"] === "assistant") unrecognized += 1;
          continue;
        }
        const event = parsed.data;
        if (!snapshot.firstEventSeen) {
          // The first conversation record decides: a subagent transcript
          // opens with the subagent's own sidechain brief.
          snapshot.firstEventSeen = true;
          if (event.isSidechain === true && event.agentId !== undefined) snapshot.subagentAgentId = event.agentId;
        }
        const ownSubagentRecord = snapshot.subagentAgentId !== undefined && event.agentId === snapshot.subagentAgentId;
        if (event.isSidechain && !snapshot.includeSidechains && !ownSubagentRecord) continue;
        if (event.isMeta) continue;
        snapshot.sessionId ??= event.sessionId;
        snapshot.cwd ??= event.cwd;
        snapshot.version ??= event.version;
        snapshot.gitBranch ??= event.gitBranch;
        snapshot.eventCount += 1;
        stepClaude(event, snapshot, snapshot.recordOrdinal);
      }
      const skipped = unparseable + unrecognized;
      if (skipped > 0) {
        snapshot.unparseableLines = (snapshot.unparseableLines ?? 0) + unparseable;
        snapshot.unrecognizedRecords = (snapshot.unrecognizedRecords ?? 0) + unrecognized;
        snapshot.skippedLines += skipped;
        onWarn?.(`claude-code: skipped ${skipped} unparseable or unrecognized conversation line(s)`);
      }
      return snapshot.messages.slice(start);
    },
    finalize: () => [],
    state: () => structuredClone(snapshot),
    thread: current,
    losses: () => claudeLosses(snapshot),
  };
}

/** One-shot compatibility wrapper over the incremental Claude Code core. */
export function importFromClaudeCode(
  jsonlContent: JsonlInput,
  options: ClaudeCodeImportOptions = {},
): Thread {
  const importer = createClaudeCodeImporter(options);
  importer.pushLines(toLines(jsonlContent));
  return finishClaudeImport(importer, options);
}

/**
 * Streams JSONL lines (for example from `readJsonlLines`) through the same
 * incremental core in bounded batches, so no whole-file string is built.
 */
export async function importFromClaudeCodeLines(
  lines: AsyncIterable<string> | Iterable<string>,
  options: ClaudeCodeImportOptions & { batchLines?: number } = {},
): Promise<Thread> {
  const importer = createClaudeCodeImporter(options);
  const batchLines = options.batchLines ?? DEFAULT_BATCH_LINES;
  let batch: string[] = [];
  for await (const line of lines) {
    batch.push(line);
    if (batch.length >= batchLines) { importer.pushLines(batch); batch = []; }
  }
  importer.pushLines(batch);
  return finishClaudeImport(importer, options);
}

const DEFAULT_BATCH_LINES = 1000;

function finishClaudeImport(
  importer: IncrementalImporter<ClaudeCodeImporterState>,
  options: ClaudeCodeImportOptions,
): Thread {
  importer.finalize();
  const thread = importer.thread();
  const state = importer.state();
  const observed = new Set(state.observedMessageIndices ?? []);
  // A subagent transcript's thread id is composed, not owner-issued.
  const sourceThreadWasObserved = state.sessionId !== undefined && state.subagentAgentId === undefined;
  for (const [index, message] of thread.messages.entries()) options.onMessageIdentity?.(
    message,
    sourceThreadWasObserved && observed.has(index) ? "observed" : "adapter-fallback",
  );
  const losses = importer.losses();
  if (losses.length > 0) options.onLosses?.(losses);
  return thread;
}

/** Harness wrappers whose whole-text presence decides the origin by itself. */
const CLAUDE_HARNESS_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "bash-stdout",
  "bash-stderr",
] as const;
/**
 * Wrappers around a command a person (or an SDK client) invoked: the envelope
 * is reported, but who invoked it is left to the record's own signals.
 */
const CLAUDE_COMMAND_TAGS = ["command-name", "command-message", "command-args", "bash-input"] as const;
const CLAUDE_ENVELOPES: EnvelopeVocabulary = {
  tags: new Set<string>([...CLAUDE_HARNESS_TAGS, ...CLAUDE_COMMAND_TAGS, "task-notification"]),
  markers: new Map([
    ["[Request interrupted by user]", "request-interrupted"],
    ["[Request interrupted by user for tool use]", "request-interrupted"],
  ]),
};

/** Claude Code's own `origin.kind` values, as observed in real transcripts. */
const CLAUDE_ORIGIN_KINDS: Readonly<Record<string, MessageOriginKind>> = {
  human: "human",
  "task-notification": "task-notification",
  // Another Claude session's message, and a coordinator's instruction to a
  // worker: both are an agent speaking in the user role.
  peer: "agent",
  coordinator: "agent",
  "auto-continuation": "harness",
};
/**
 * `promptSource` values that mean a person wrote the prompt in the
 * interactive composer. `suggestion_accepted` is excluded: the model wrote
 * that text and a person only accepted it.
 */
const CLAUDE_TYPED_PROMPT_SOURCES = new Set(["typed", "queued"]);

function claudeUserOrigin(event: ConversationEvent, content: readonly ContentPart[]): MessageOrigin {
  const envelope = wholeEnvelope(content, CLAUDE_ENVELOPES);
  const withEnvelope = (origin: MessageOrigin): MessageOrigin =>
    envelope === undefined ? origin : { ...origin, envelope };
  if (event.isCompactSummary === true) {
    return withEnvelope({ kind: "compaction", evidence: "claude-code:isCompactSummary" });
  }
  const promptSource = typeof event.promptSource === "string" ? event.promptSource : undefined;
  if (promptSource === "suggestion_accepted") {
    return withEnvelope({ kind: "unknown", evidence: "claude-code:promptSource=suggestion_accepted" });
  }
  const sourceKind = typeof event.origin === "object" && event.origin !== null
    ? (event.origin as Record<string, unknown>)["kind"]
    : undefined;
  const mapped = typeof sourceKind === "string" ? CLAUDE_ORIGIN_KINDS[sourceKind] : undefined;
  // Claude Code stamps origin.kind "human" on SDK-submitted prompts too
  // (observed with promptSource "sdk", including machine-written briefs), so
  // the harness's human label is trusted only for composer input.
  const humanLabelTrusted = promptSource === undefined || CLAUDE_TYPED_PROMPT_SOURCES.has(promptSource);
  if (mapped !== undefined && (mapped !== "human" || humanLabelTrusted)) {
    return withEnvelope({ kind: mapped, evidence: `claude-code:origin.kind=${sourceKind}` });
  }
  if (envelope === "task-notification") {
    return { kind: "task-notification", evidence: "claude-code:envelope", envelope };
  }
  if (envelope !== undefined && !(CLAUDE_COMMAND_TAGS as readonly string[]).includes(envelope)) {
    return { kind: "harness", evidence: "claude-code:envelope", envelope };
  }
  if (promptSource !== undefined && CLAUDE_TYPED_PROMPT_SOURCES.has(promptSource)) {
    return withEnvelope({ kind: "human", evidence: `claude-code:promptSource=${promptSource}` });
  }
  if (event.isSidechain === true) {
    return withEnvelope({ kind: "agent", evidence: "claude-code:isSidechain" });
  }
  // An unrecognized or "unclassified" origin.kind, an SDK prompt, or no
  // signal at all: say so rather than guessing human.
  const evidence = typeof sourceKind === "string"
    ? `claude-code:origin.kind=${sourceKind}${promptSource !== undefined ? `,promptSource=${promptSource}` : ""}`
    : promptSource !== undefined
      ? `claude-code:promptSource=${promptSource}`
      : "claude-code:no-origin-signal";
  return withEnvelope({ kind: "unknown", evidence });
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
