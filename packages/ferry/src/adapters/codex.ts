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
  ThreadMetadata,
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
  syntheticId: number;
  sessionId?: string;
  cwd?: string;
  cliVersion?: string;
  provider?: string;
  currentModel?: string;
  importableItemCount: number;
  skippedLines: number;
  pending: { content: AssistantContent[]; timestamp?: number; model?: string } | null;
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
  // state so a following record can still join its Responses turn. Finalize
  // presents it without changing that state.
  if (state.pending?.content.length) {
    const pending = structuredClone(state.pending);
    const threadId = state.sessionId ?? "codex-session";
    const assistant: AssistantMessage = {
      id: `${threadId}:${state.syntheticId + 1}`,
      threadId,
      role: "assistant",
      timestamp: pending.timestamp ?? fallbackTimestamp(messages),
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
    createdAt: messages[0]?.timestamp ?? Date.now(), updatedAt: messages[messages.length - 1]?.timestamp ?? Date.now(),
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
  const timestamp = parseTimestamp(record.timestamp);
  const threadId = state.sessionId ?? "codex-session";
  const nextId = (): string => `${threadId}:${++state.syntheticId}`;
  const flush = (): void => {
    const pending = state.pending;
    if (pending?.content.length) {
      const assistant: AssistantMessage = { id: nextId(), threadId, role: "assistant",
        timestamp: pending.timestamp ?? fallbackTimestamp(state.messages), content: pending.content,
        model: pending.model, provider: state.provider };
      if (state.heldTokenCount) { attachTokenCount(assistant, state.heldTokenCount); state.heldTokenCount = undefined; }
      state.messages.push(assistant);
    }
    state.pending = null;
  };
  const append = (part: AssistantContent): void => {
    state.pending ??= { content: [], timestamp, model: state.currentModel };
    state.pending.timestamp ??= timestamp;
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
    else { flush(); state.messages.push({ id: nextId(), threadId, role: role === "system" ? "system" : "user", timestamp: timestamp ?? fallbackTimestamp(state.messages), content: parts }); }
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
    state.messages.push({ id: nextId(), threadId, role: "tool", timestamp: timestamp ?? fallbackTimestamp(state.messages), toolResults: [{ toolCallId: callId, name: "", content: [{ type: "text", text: extractOutputText(payload["output"]) }] }] });
  }
}

function importFromCodexCore(
  jsonlContent: JsonlInput,
  options: CodexImportOptions = {},
): Thread {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let cliVersion: string | undefined;
  let provider: string | undefined;
  // Mid-session /model switches arrive as later turn_context lines, so each
  // response item carries the model that was active when it was emitted.
  let currentModel: string | undefined;
  let skippedLines = 0;

  interface Item {
    timestamp: number | undefined;
    payload: Record<string, unknown>;
    model: string | undefined;
    isTokenCount?: boolean;
    duplicateAgentMessageText?: string;
  }
  const items: Item[] = [];
  let importableItemCount = 0;

  for (const line of toLines(jsonlContent)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const parsed = RolloutLine.safeParse(raw);
    if (!parsed.success) {
      skippedLines += 1;
      continue;
    }
    const record = parsed.data;
    const payload = asRecord(record.payload);
    if (!payload) continue;

    if (record.type === "session_meta") {
      if (typeof payload["id"] === "string") sessionId ??= payload["id"];
      if (typeof payload["cwd"] === "string") cwd ??= payload["cwd"];
      if (typeof payload["cli_version"] === "string") cliVersion ??= payload["cli_version"];
      if (typeof payload["model_provider"] === "string") provider ??= payload["model_provider"];
      continue;
    }
    if (record.type === "turn_context") {
      if (typeof payload["model"] === "string") currentModel = payload["model"];
      continue;
    }
    if (record.type === "response_item") {
      importableItemCount += 1;
      items.push({ timestamp: parseTimestamp(record.timestamp), payload, model: currentModel });
    } else if (record.type === "event_msg" && payload["type"] === "token_count") {
      items.push({
        timestamp: parseTimestamp(record.timestamp),
        payload,
        model: currentModel,
        isTokenCount: true,
      });
    } else if (
      record.type === "event_msg" &&
      (payload["type"] === "agent_message" || payload["type"] === "agent_reasoning")
    ) {
      importableItemCount += 1;
      items.push({ timestamp: parseTimestamp(record.timestamp), payload, model: currentModel });
    }
  }

  // The Desktop writer emits the mirrored response item directly after the
  // event item. Keep the event as the source because agent_reasoning records
  // share its assistant window, and suppress only this observed adjacency.
  //
  // Adjacency is measured over `items` (post-filter), not raw lines, so an
  // ignored record between a mirror pair would still read as adjacent and
  // could suppress a legitimately repeated short text ("Done." twice).
  // Measured across 852 August-2026 rollouts: all 14,632 exact mirrors were
  // ALSO immediately adjacent as raw records, so the two orderings coincide
  // in every observed case. If a future writer interleaves records into a
  // mirror pair, tighten this to raw-line adjacency rather than widening the
  // text match.
  for (let index = 0; index < items.length - 1; index += 1) {
    const event = items[index];
    const response = items[index + 1];
    if (event?.payload["type"] !== "agent_message" || !response) continue;
    const text = event.payload["message"];
    if (typeof text !== "string") continue;
    if (
      response.payload["type"] === "message" &&
      response.payload["role"] === "assistant" &&
      extractMessageParts(response.payload["content"]).some(
        (part) => part.type === "text" && part.text === text,
      )
    ) {
      response.duplicateAgentMessageText = text;
    }
  }

  // Items recorded before the first turn_context carry no model; in the
  // common single-model session that is pure fidelity loss, so backfill
  // leading unknowns from the first model that becomes known.
  const firstKnownModel = items.find((item) => item.model !== undefined)?.model;
  for (const item of items) {
    if (item.model !== undefined) break;
    item.model = firstKnownModel;
  }

  if (skippedLines > 0) {
    options.onWarn?.(`codex: skipped ${skippedLines} unparseable line(s)`);
  }
  if (importableItemCount === 0) {
    throw new Error("No Codex importable items found in input");
  }

  const threadId = sessionId ?? "codex-session";
  const messages: Message[] = [];
  let syntheticId = 0;
  const nextId = (): string => `${threadId}:${++syntheticId}`;

  let pending: {
    content: AssistantContent[];
    timestamp: number | undefined;
    model: string | undefined;
  } | null = null;
  let lastRateLimits: Record<string, unknown> | undefined;
  let unattributedUsage: CodexUnattributedUsage | undefined;
  let previousTokenCountMessageIndex: number | undefined;
  let heldTokenCount: TokenCount | undefined;
  const flushPending = (): void => {
    if (pending && pending.content.length > 0) {
      const assistant: AssistantMessage = {
        id: nextId(),
        threadId,
        role: "assistant",
        timestamp: pending.timestamp ?? fallbackTimestamp(messages),
        content: pending.content,
        model: pending.model,
        provider,
      };
      if (heldTokenCount) {
        attachTokenCount(assistant, heldTokenCount);
        heldTokenCount = undefined;
      }
      messages.push(assistant);
    }
    pending = null;
  };
  const appendAssistant = (
    part: AssistantContent,
    timestamp: number | undefined,
    model: string | undefined,
  ): void => {
    pending ??= { content: [], timestamp, model };
    pending.timestamp ??= timestamp;
    pending.model ??= model;
    pending.content.push(part);
  };

  for (const { timestamp, payload, model, isTokenCount, duplicateAgentMessageText } of items) {
    if (isTokenCount) {
      flushPending();
      const rateLimits = asRecord(payload["rate_limits"]);
      if (rateLimits) lastRateLimits = rateLimits;
      const extractedUsage = extractTokenUsage(payload);
      const rawUsage = extractRawTokenUsage(payload);
      const tokenCount: TokenCount = {
        usage: extractedUsage?.usage,
        rawUsage,
        rateLimits,
        inconsistent: extractedUsage?.inconsistent,
      };
      // Attribution window: from the previous token_count (or file start for
      // the first count) forward. A count reports the turn that just
      // completed, so it attaches backward within its window; holding is only
      // for windows with no candidate assistant (round-3 review, H-2).
      const assistant = findAssistantWithoutUsage(
        messages,
        previousTokenCountMessageIndex ?? 0,
      );
      if (assistant) {
        attachTokenCount(assistant, tokenCount);
      } else {
        if (heldTokenCount?.usage) {
          unattributedUsage = addUnattributedUsage(unattributedUsage, heldTokenCount.usage);
        }
        heldTokenCount = tokenCount;
      }
      previousTokenCountMessageIndex = messages.length;
      continue;
    }
    const type = payload["type"];

    if (type === "message") {
      const role = payload["role"];
      const parts = extractMessageParts(payload["content"]).filter(
        (part) => part.type !== "text" || part.text !== duplicateAgentMessageText,
      );
      if (parts.length === 0) continue;
      if (role === "assistant") {
        for (const part of parts) {
          if (part.type === "text") {
            appendAssistant({ type: "text", text: part.text }, timestamp, model);
          } else if (part.type === "image") {
            appendAssistant({ type: "image", image: part }, timestamp, model);
          }
        }
      } else {
        flushPending();
        messages.push({
          id: nextId(),
          threadId,
          role: role === "system" ? "system" : "user",
          timestamp: timestamp ?? fallbackTimestamp(messages),
          content: parts,
        });
      }
    } else if (type === "reasoning") {
      const summary = Array.isArray(payload["summary"]) ? payload["summary"] : [];
      const texts = summary
        .map((s) => asRecord(s))
        .filter((s): s is Record<string, unknown> => s !== undefined)
        .map((s) => s["text"])
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      if (texts.length > 0) {
        appendAssistant(
          { type: "reasoning", reasoning: { type: "reasoning", text: texts.join("\n") } },
          timestamp,
          model,
        );
      }
    } else if (type === "agent_message") {
      const text = payload["message"];
      if (typeof text === "string" && text.length > 0) {
        appendAssistant({ type: "text", text }, timestamp, model);
      }
    } else if (type === "agent_reasoning") {
      const text = payload["text"];
      if (typeof text === "string" && text.length > 0) {
        appendAssistant(
          { type: "reasoning", reasoning: { type: "reasoning", text } },
          timestamp,
          model,
        );
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      const name = typeof payload["name"] === "string" ? payload["name"] : "unknown";
      const callId =
        typeof payload["call_id"] === "string"
          ? payload["call_id"]
          : typeof payload["id"] === "string"
            ? payload["id"]
            : nextId();
      const rawArguments =
        typeof payload["arguments"] === "string"
          ? payload["arguments"]
          : typeof payload["input"] === "string"
            ? payload["input"]
            : "{}";
      let parsedArguments: Record<string, unknown> | undefined;
      if (type === "function_call") {
        try {
          parsedArguments = asRecord(JSON.parse(rawArguments));
        } catch {
          parsedArguments = undefined;
        }
      }
      appendAssistant(
        {
          type: "tool_call",
          toolCall: { id: callId, name, arguments: rawArguments, parsedArguments },
        },
        timestamp,
        model,
      );
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      flushPending();
      const callId = typeof payload["call_id"] === "string" ? payload["call_id"] : nextId();
      const output = extractOutputText(payload["output"]);
      messages.push({
        id: nextId(),
        threadId,
        role: "tool",
        timestamp: timestamp ?? fallbackTimestamp(messages),
        toolResults: [
          { toolCallId: callId, name: "", content: [{ type: "text", text: output }] },
        ],
      });
    }
    // tool_search_call/_output and unknown types are skipped.
  }
  flushPending();
  if (heldTokenCount?.usage) {
    unattributedUsage = addUnattributedUsage(unattributedUsage, heldTokenCount.usage);
  }

  if (messages.length === 0) {
    throw new Error("Codex input contained no importable messages");
  }

  const metadata: ThreadMetadata = {
    source: "codex",
    sourceVersion: cliVersion,
    cwd,
    ...(lastRateLimits || unattributedUsage
      ? {
          custom: {
            ...(lastRateLimits ? { codexRateLimits: lastRateLimits } : {}),
            ...(unattributedUsage ? { codexUnattributedUsage: unattributedUsage } : {}),
          },
        }
      : {}),
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

/** JSON-safe checkpoint for a Codex incremental importer.
 *
 * Hosts pass complete JSONL lines only: ferry does not buffer partial bytes.
 * `pushLines` returns append-only message announcements; a later token_count
 * may add usage to an announced assistant, so `thread()` is authoritative.
 * This adapter performs no file watching, offset tracking, path handling, or
 * filesystem access.
 */
export type CodexImporterState = CodexReducerState;

export interface CodexIncrementalImporter {
  pushLines(lines: readonly string[]): Message[];
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
      const start = snapshot.messages.length;
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
      return snapshot.messages.slice(start);
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

function fallbackTimestamp(messages: Message[]): number {
  return messages[messages.length - 1]?.timestamp ?? Date.now();
}
