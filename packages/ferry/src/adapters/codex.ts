/**
 * Import from Codex CLI rollout transcripts.
 * Source: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
 *
 * Each line is `{timestamp: ISO string, type, payload}`. Conversation content
 * lives in `type: "response_item"` payloads and `event_msg` payloads:
 * - `message` — user/assistant text (`input_text` / `output_text` parts)
 * - `reasoning` — summary array (+ opaque `encrypted_content`, not imported)
 * - `function_call` / `custom_tool_call` — tool invocations
 * - `function_call_output` / `custom_tool_call_output` — tool results
 * - `agent_message` — assistant text, including final text in forked runs
 * - `agent_reasoning` — assistant reasoning text
 * `session_meta` carries the session id, cwd and CLI version; `turn_context`
 * carries the active model.
 *
 * Consecutive assistant-side items (reasoning, text, tool calls) are folded
 * into one assistant message per turn, mirroring how the Responses API groups
 * output items.
 *
 * Known limitations (deliberate):
 * - `tool_search_*` items are skipped.
 * - `reasoning.encrypted_content` is dropped; only summary text is kept.
 * - Codex `last_token_usage.input_tokens` includes cached reads (observed:
 *   98/98 cumulative-delta-consistent samples) and is normalized to exclusive
 *   `usage.inputTokens` by subtracting cached reads. Cache-write subtraction
 *   is an assumption pending a real nonzero observation; the unmodified source
 *   object remains in `metadata.codexTokenUsage`.
 * - `token_count` carries no message id. Its usage and rate limits attach only
 *   to the first usage-less imported assistant emitted after the preceding
 *   token count. When none has appeared yet, the count is held for the next
 *   assistant; superseded or terminal held counts are retained in the
 *   thread-level `codexUnattributedUsage` rollup. The last observed
 *   `rate_limits` is also retained as the
 *   point-in-time `metadata.custom.codexRateLimits` thread snapshot.
 *   Incremental state retains output plus at most one held token-count record.
 *   That record retains its raw `info.last_token_usage` object because it is
 *   later exported faithfully as `metadata.codexTokenUsage` if it attaches.
 * - Codex Desktop mirrors an `event_msg.agent_message` into an immediately
 *   following assistant `response_item` with byte-identical `output_text`
 *   (observed in the forked 2026-08-01T16-05-24 rollout at lines 183-184,
 *   and ordinary 2026-08-01T00-12-52 and T00-33-00 rollouts at lines 12-13).
 *   The event is canonical so its adjacent `agent_reasoning` and token-count
 *   window remain together; that immediate duplicate response text is skipped.
 *   Equal text at any other position is retained.
 */

import { z } from "zod";
import type {
  AssistantContent,
  AssistantMessage,
  ContentPart,
  Message,
  Thread,
  TokenUsage,
} from "@kontourai/thread";
import { THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import { asRecord, parseTimestamp, toLines, tryParseJson, type JsonlInput } from "./shared.js";

const RolloutLine = z
  .object({
    type: z.string(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    // .optional() is load-bearing under zod 4: `z.unknown()` keys became
    // NON-optional at parse time (not just in inferred types), so a line
    // missing `payload` would fail validation and be silently counted as
    // skipped. Tolerating unexpected shapes is this importer's premise.
    payload: z.unknown().optional(),
  })
  .passthrough();

export interface CodexImportOptions {
  /** Called with a summary of skipped/unparseable records, if any. */
  onWarn?: (message: string) => void;
}

interface CodexReducerState {
  format: "codex";
  messages: Message[];
  /** Number of committed messages already announced to the tailing host. */
  announcedMessageCount?: number;
  syntheticId: number;
  sessionId?: string;
  cwd?: string;
  cliVersion?: string;
  provider?: string;
  currentModel?: string;
  importableItemCount: number;
  skippedLines: number;
  pending: { content: AssistantContent[]; timestamp: number; model?: string } | null;
  heldTokenCount?: TokenCount;
  previousTokenCountMessageIndex?: number;
  lastRateLimits?: Record<string, unknown>;
  unattributedUsage?: CodexUnattributedUsage;
  duplicateAgentMessageText?: string;
}

function codexThread(state: CodexReducerState): Thread {
  if (state.importableItemCount === 0) throw new Error("No Codex importable items found in input");
  const messages = structuredClone(state.messages);
  // Pending assistant output is intentionally kept uncommitted in reducer
  // state so a following record can still join its Responses turn.
  if (state.pending?.content.length) {
    const pending = structuredClone(state.pending);
    const threadId = state.sessionId ?? "codex-session";
    const assistant: AssistantMessage = {
      id: `${threadId}:${state.syntheticId + 1}`,
      threadId,
      role: "assistant",
      timestamp: pending.timestamp,
      content: pending.content,
      model: pending.model,
      provider: state.provider,
    };
    if (state.heldTokenCount) attachTokenCount(assistant, state.heldTokenCount);
    messages.push(assistant);
  }
  // A finalize pass over output, never over input records. It deliberately
  // works on the clone so repeated or mid-stream thread() calls are pure.
  const firstKnownModel = messages.find((m) => m.role === "assistant" && m.model !== undefined);
  if (firstKnownModel?.role === "assistant") {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (message.model !== undefined) break;
      message.model = firstKnownModel.model;
    }
  }
  let unattributedUsage = state.unattributedUsage;
  if (!state.pending?.content.length && state.heldTokenCount?.usage) {
    unattributedUsage = addUnattributedUsage(unattributedUsage, state.heldTokenCount.usage);
  }
  if (messages.length === 0) throw new Error("Codex input contained no importable messages");
  const threadId = state.sessionId ?? "codex-session";
  return {
    schemaVersion: THREAD_SCHEMA_VERSION, id: threadId, messages,
    metadata: { source: "codex", sourceVersion: state.cliVersion, cwd: state.cwd,
      ...(state.lastRateLimits || unattributedUsage ? { custom: {
        ...(state.lastRateLimits ? { codexRateLimits: state.lastRateLimits } : {}),
        ...(unattributedUsage ? { codexUnattributedUsage: unattributedUsage } : {}),
      } } : {}) },
    createdAt: messages[0]!.timestamp, updatedAt: messages[messages.length - 1]!.timestamp,
  };
}

function stepCodex(record: z.infer<typeof RolloutLine>, state: CodexReducerState): void {
  const payload = asRecord(record.payload);
  if (!payload) { state.duplicateAgentMessageText = undefined; return; }
  if (record.type === "session_meta") {
    if (typeof payload["id"] === "string") state.sessionId ??= payload["id"];
    if (typeof payload["cwd"] === "string") state.cwd ??= payload["cwd"];
    if (typeof payload["cli_version"] === "string") state.cliVersion ??= payload["cli_version"];
    if (typeof payload["model_provider"] === "string") state.provider ??= payload["model_provider"];
    state.duplicateAgentMessageText = undefined; return;
  }
  if (record.type === "turn_context") {
    if (typeof payload["model"] === "string") state.currentModel = payload["model"];
    state.duplicateAgentMessageText = undefined; return;
  }
  // A source timestamp may be absent. Capture the observation time while
  // stepping the record so thread() remains a pure state projection.
  const timestamp = parseTimestamp(record.timestamp) ?? Date.now();
  const threadId = state.sessionId ?? "codex-session";
  const nextId = (): string => `${threadId}:${++state.syntheticId}`;
  const flush = (): void => flushCodexPending(state);
  const append = (part: AssistantContent): void => {
    state.pending ??= { content: [], timestamp, model: state.currentModel };
    state.pending.model ??= state.currentModel;
    state.pending.content.push(part);
  };
  if (record.type === "event_msg" && payload["type"] === "token_count") {
    flush(); const rateLimits = asRecord(payload["rate_limits"]); if (rateLimits) state.lastRateLimits = rateLimits;
    const extracted = extractTokenUsage(payload);
    const tokenCount: TokenCount = { usage: extracted?.usage, rawUsage: extractRawTokenUsage(payload), rateLimits, inconsistent: extracted?.inconsistent };
    const assistant = findAssistantWithoutUsage(state.messages, state.previousTokenCountMessageIndex ?? 0);
    if (assistant) attachTokenCount(assistant, tokenCount);
    else { if (state.heldTokenCount?.usage) state.unattributedUsage = addUnattributedUsage(state.unattributedUsage, state.heldTokenCount.usage); state.heldTokenCount = tokenCount; }
    state.previousTokenCountMessageIndex = state.messages.length; state.duplicateAgentMessageText = undefined; return;
  }
  const importable = record.type === "response_item" || (record.type === "event_msg" && (payload["type"] === "agent_message" || payload["type"] === "agent_reasoning"));
  if (!importable) { state.duplicateAgentMessageText = undefined; return; }
  state.importableItemCount += 1;
  const type = payload["type"];
  const duplicate = state.duplicateAgentMessageText;
  state.duplicateAgentMessageText = type === "agent_message" && typeof payload["message"] === "string" ? payload["message"] : undefined;
  if (type === "message") {
    const role = payload["role"];
    const parts = extractMessageParts(payload["content"]).filter((p) => p.type !== "text" || p.text !== duplicate);
    if (!parts.length) return;
    if (role === "assistant") for (const part of parts) {
      if (part.type === "text") append({ type: "text", text: part.text });
      else if (part.type === "image") append({ type: "image", image: part });
    }
    else { flush(); state.messages.push({ id: nextId(), threadId, role: role === "system" ? "system" : "user", timestamp, content: parts }); }
  } else if (type === "reasoning") {
    const texts = (Array.isArray(payload["summary"]) ? payload["summary"] : []).map(asRecord).filter((s): s is Record<string, unknown> => s !== undefined).map((s) => s["text"]).filter((t): t is string => typeof t === "string" && t.length > 0);
    if (texts.length) append({ type: "reasoning", reasoning: { type: "reasoning", text: texts.join("\n") } });
  } else if (type === "agent_message" && typeof payload["message"] === "string" && payload["message"].length) append({ type: "text", text: payload["message"] });
  else if (type === "agent_reasoning" && typeof payload["text"] === "string" && payload["text"].length) append({ type: "reasoning", reasoning: { type: "reasoning", text: payload["text"] } });
  else if (type === "function_call" || type === "custom_tool_call") {
    const name = typeof payload["name"] === "string" ? payload["name"] : "unknown";
    const callId = typeof payload["call_id"] === "string" ? payload["call_id"] : typeof payload["id"] === "string" ? payload["id"] : nextId();
    const arguments_ = typeof payload["arguments"] === "string" ? payload["arguments"] : typeof payload["input"] === "string" ? payload["input"] : "{}";
    let parsedArguments: Record<string, unknown> | undefined; if (type === "function_call") { try { parsedArguments = asRecord(JSON.parse(arguments_)); } catch { /* deliberate */ } }
    append({ type: "tool_call", toolCall: { id: callId, name, arguments: arguments_, parsedArguments } });
  } else if (type === "function_call_output" || type === "custom_tool_call_output") {
    flush(); const callId = typeof payload["call_id"] === "string" ? payload["call_id"] : nextId();
    state.messages.push({ id: nextId(), threadId, role: "tool", timestamp, toolResults: [{ toolCallId: callId, name: "", content: [{ type: "text", text: extractOutputText(payload["output"]) }] }] });
  }
}

function flushCodexPending(state: CodexReducerState): void {
  const pending = state.pending;
  if (pending?.content.length) {
    const threadId = state.sessionId ?? "codex-session";
    const assistant: AssistantMessage = {
      id: `${threadId}:${++state.syntheticId}`,
      threadId,
      role: "assistant",
      timestamp: pending.timestamp,
      content: pending.content,
      model: pending.model,
      provider: state.provider,
    };
    if (state.heldTokenCount) {
      attachTokenCount(assistant, state.heldTokenCount);
      state.heldTokenCount = undefined;
    }
    state.messages.push(assistant);
  }
  state.pending = null;
}

/** Resolve every committed message through the single identity-assignment path. */
function reconcileCodexStateMessageIds(state: CodexReducerState): void {
  const threadId = state.sessionId;
  if (!threadId) return;
  for (const message of state.messages) {
    const previousThreadId = message.threadId;
    if (previousThreadId === threadId) continue;
    message.threadId = threadId;
    if (message.id.startsWith(`${previousThreadId}:`)) {
      message.id = `${threadId}${message.id.slice(previousThreadId.length)}`;
    }
  }
}

/** JSON-safe checkpoint for a Codex incremental importer.
 *
 * Hosts pass complete JSONL lines only: ferry does not buffer partial bytes.
 * `pushLines` returns append-only message announcements. An id is stable from
 * the moment it is announced: announcements may be deferred until thread
 * identity resolves, while `thread()` remains authoritative for in-flight
 * content. A later token_count may add usage to an announced assistant.
 * A tailing host calls `finalize()` at EOF, rotation, or close to commit and
 * announce pending content exactly once; until then, in-flight content is
 * visible only through `thread()`.
 * Malformed-line warnings are emitted per `pushLines` batch; the one-shot
 * wrapper supplies one batch and therefore emits at most one such warning.
 * This adapter performs no file watching, offset tracking, path handling, or
 * filesystem access.
 */
export type CodexImporterState = CodexReducerState;

export interface CodexIncrementalImporter {
  pushLines(lines: readonly string[]): Message[];
  finalize(): Message[];
  state(): CodexImporterState;
  thread(): Thread;
}

export function createCodexImporter(
  options: CodexImportOptions = {},
): CodexIncrementalImporter {
  return codexImporter({
    format: "codex", messages: [], syntheticId: 0, importableItemCount: 0,
    skippedLines: 0, pending: null,
  }, options.onWarn);
}

export function restoreCodexImporter(
  state: CodexImporterState,
  options: Pick<CodexImportOptions, "onWarn"> = {},
): CodexIncrementalImporter {
  if (state.format !== "codex") throw new Error("Invalid Codex importer state");
  return codexImporter(structuredClone(state), options.onWarn);
}

function codexImporter(
  snapshot: CodexImporterState,
  onWarn: CodexImportOptions["onWarn"],
): CodexIncrementalImporter {
  const current = (): Thread => codexThread(snapshot);
  return {
    pushLines(lines) {
      if (lines.length === 0) return [];
      let skipped = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { skipped += 1; continue; }
        const parsed = RolloutLine.safeParse(raw);
        if (!parsed.success) { skipped += 1; continue; }
        stepCodex(parsed.data, snapshot);
      }
      if (skipped > 0) onWarn?.(`codex: skipped ${skipped} unparseable line(s)`);
      // Do not give a tailing host an id based on the provisional fallback.
      // A session id resolves all accumulated state messages together.
      reconcileCodexStateMessageIds(snapshot);
      if (!snapshot.sessionId) return [];
      const announcements = snapshot.messages.slice(snapshot.announcedMessageCount ?? 0);
      snapshot.announcedMessageCount = snapshot.messages.length;
      return announcements;
    },
    finalize() {
      flushCodexPending(snapshot);
      // Finalization promises no later input, so the fallback is now a stable
      // identity just as a session_meta id would be.
      snapshot.sessionId ??= "codex-session";
      reconcileCodexStateMessageIds(snapshot);
      const announcements = snapshot.messages.slice(snapshot.announcedMessageCount ?? 0);
      snapshot.announcedMessageCount = snapshot.messages.length;
      return announcements;
    },
    state: () => structuredClone(snapshot),
    thread: current,
  };
}

/** One-shot compatibility wrapper over the incremental Codex core. */
export function importFromCodex(
  jsonlContent: JsonlInput,
  options: CodexImportOptions = {},
): Thread {
  const importer = createCodexImporter(options);
  importer.pushLines(toLines(jsonlContent));
  importer.finalize();
  return importer.thread();
}

interface ExtractedTokenUsage {
  usage: TokenUsage;
  inconsistent: boolean;
}

interface TokenCount {
  usage: TokenUsage | undefined;
  rawUsage: Record<string, unknown> | undefined;
  rateLimits: Record<string, unknown> | undefined;
  inconsistent: boolean | undefined;
}

function extractTokenUsage(payload: Record<string, unknown>): ExtractedTokenUsage | undefined {
  const lastUsage = extractRawTokenUsage(payload);
  if (!lastUsage) return undefined;
  const inputTokens = nonnegativeInteger(lastUsage["input_tokens"]);
  const outputTokens = nonnegativeInteger(lastUsage["output_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = nonnegativeInteger(lastUsage["cached_input_tokens"]) ?? 0;
  const cacheWriteInputTokens = nonnegativeInteger(lastUsage["cache_write_input_tokens"]) ?? 0;
  const reasoningTokens = nonnegativeInteger(lastUsage["reasoning_output_tokens"]) ?? 0;
  const exclusiveInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;
  return {
    usage: {
      inputTokens: Math.max(0, exclusiveInputTokens),
      outputTokens,
      reasoningTokens,
      cacheReadTokens: cachedInputTokens,
      cacheWriteTokens: cacheWriteInputTokens,
    },
    inconsistent: exclusiveInputTokens < 0,
  };
}

function extractRawTokenUsage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(asRecord(payload["info"])?.["last_token_usage"]);
}

interface CodexUnattributedUsage extends TokenUsage {
  events: number;
}

function addUnattributedUsage(
  current: CodexUnattributedUsage | undefined,
  usage: TokenUsage,
): CodexUnattributedUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + usage.outputTokens,
    reasoningTokens: (current?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    events: (current?.events ?? 0) + 1,
  };
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function attachTokenCount(assistant: AssistantMessage, tokenCount: TokenCount): void {
  if (tokenCount.usage) assistant.usage = tokenCount.usage;
  assistant.metadata = {
    ...assistant.metadata,
    ...(tokenCount.rawUsage
      ? {
          // Byte-pure raw writer object — the anomaly marker lives OUTSIDE it
          // so preservation stays honest (round-3 review, L-2).
          codexTokenUsage: tokenCount.rawUsage,
          ...(tokenCount.inconsistent ? { codexTokenUsageInconsistent: true } : {}),
        }
      : {}),
    ...(tokenCount.rateLimits ? { codexRateLimits: tokenCount.rateLimits } : {}),
  };
}

function findAssistantWithoutUsage(
  messages: Message[],
  fromIndex: number,
): AssistantMessage | undefined {
  // Most-recent-first: a token_count describes the turn that JUST completed,
  // so the newest usage-less assistant inside the window is the subject; the
  // window floor (fromIndex) keeps earlier turns' assistants unreachable.
  for (let index = messages.length - 1; index >= fromIndex; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.usage === undefined) return message;
  }
  return undefined;
}

function extractMessageParts(content: unknown): ContentPart[] {
  const parts: ContentPart[] = [];
  if (!Array.isArray(content)) return parts;
  for (const item of content) {
    const part = asRecord(item);
    if (!part) continue;
    const type = part["type"];
    if ((type === "input_text" || type === "output_text") && typeof part["text"] === "string") {
      parts.push({ type: "text", text: part["text"] });
    } else if (type === "input_image" && typeof part["image_url"] === "string") {
      parts.push({ type: "image", data: part["image_url"], mediaType: "image/*" });
    }
  }
  return parts;
}

/**
 * Tool outputs are usually strings, occasionally wrapped as {output, metadata}
 * — either as an actual object or JSON-encoded into the string. Unwrapping
 * requires BOTH fields: a lone string `output` key also occurs in legitimate
 * JSON tool results, and unwrapping those would truncate them.
 */
function extractOutputText(output: unknown): string {
  const isWrapper = (candidate: Record<string, unknown> | undefined): candidate is Record<string, unknown> =>
    candidate !== undefined && typeof candidate["output"] === "string" && "metadata" in candidate;
  const record = asRecord(output);
  if (isWrapper(record)) return record["output"] as string;
  if (typeof output !== "string") return "";
  if (output.startsWith("{")) {
    const parsed = asRecord(tryParseJson(output));
    if (isWrapper(parsed)) return parsed["output"] as string;
  }
  return output;
}
