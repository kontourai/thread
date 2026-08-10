/**
 * Import from Muse Code session exports.
 * Source: `muse export --session <id> --out <file>` — ONE self-contained JSON
 * document `{export_schema_version, sessions, events, diagnostics, …}`.
 *
 * `events` is the session's append-only record stream. Entries are either
 * `{kind: "record", recorded_at, derived, envelope}` or `{kind: "gap", marker,
 * omitted_record}` placeholders for records the exporter did not persist.
 * Conversation content lives in `envelope.payload`:
 * - `kind: "metadata"` — `record.{workspace_root, provider_id, model_id, build}`
 * - `kind: "workspace_branch"` — `record.reference` (git branch)
 * - `kind: "run"`, with `event.kind`:
 *   - `started` — `prompt` is the user turn's text
 *   - `model_response_created` — opens a provider response (`response_id`)
 *   - `reasoning_committed` — reasoning item for that response
 *   - `assistant_message_committed` — assistant text
 *   - `assistant_tool_calls_committed` — tool calls (`args` is a JSON STRING)
 *   - `tool_result_batch_committed` — results, paired by `tool_call_id`
 *   - `model_completed` — usage + finish reason for the open response
 *   - `terminal` — end of turn
 *
 * All items sharing a `response_id` fold into ONE canonical assistant message,
 * which is also its id: one provider response is one assistant message. This
 * grouping is what makes usage attribution exact — `model_completed` carries no
 * id of its own, and its position relative to the content it describes varies
 * (it precedes `assistant_tool_calls_committed` but follows
 * `assistant_message_committed`, observed in both probe exports), so usage is
 * attached to the response opened by the preceding `model_response_created`
 * rather than to whichever message happens to be adjacent.
 *
 * Known limitations (deliberate):
 * - `payload.kind: "task"` events (`proposed`/`accepted`/`started`/`status`/
 *   `output`/`completed`/`rejected`) are muse's INTERNAL scheduler lifecycle and
 *   shadow the very tool uses already committed as
 *   `assistant_tool_calls_committed` / `tool_result_batch_committed` — a
 *   `task.output` chunk is the same bytes as the corresponding batch result.
 *   Mapping them too would double-count every tool call, so they are dropped.
 *   The same applies to `tool_batch_effect` records.
 * - `reasoning_committed.encrypted_content` is dropped: it is opaque
 *   provider-encrypted material, not readable reasoning, and the canonical
 *   `ReasoningPart.signature` is verification material rather than a place to
 *   hide a payload. A reasoning part is emitted only when `text` is non-empty.
 *   Every reasoning event in the probe corpus (8/8) had empty `text`, so the
 *   count of dropped events is disclosed in `metadata.custom` and via `onWarn`.
 * - `model_completed.usage.input_tokens` is inclusive of cache reads (observed:
 *   13/13 samples, where the exclusive remainder tracks prompt growth exactly
 *   and the inclusive reading is arithmetically impossible), and is normalized
 *   to exclusive `usage.inputTokens` by subtracting cache reads and writes.
 *   `cache_write_tokens` was 0 in every sample, so subtracting it is an
 *   assumption from the same convention; the unmodified source object is kept
 *   in `metadata.museTokenUsage`. `cached_tokens` equalled `cache_read_tokens`
 *   in every sample and is treated as its alias.
 * - The run `terminal` event (`terminal`/`reason`/`turn_duration_ms`) is used
 *   only as a turn boundary. muse states a finish reason explicitly in
 *   `model_completed.finish_reason` when it has one; inferring "stop" from a
 *   `terminal: "completed"` turn would be a claim muse did not make.
 * - Per-item `message_id`s, `duration_ms`, `time_to_first_token_ms`, task
 *   lifecycle state and the `diagnostics`/`session_build` blocks have no
 *   canonical home and are not imported.
 */

import { z } from "zod";
import type {
  AssistantMessage,
  FinishReason,
  Message,
  Thread,
  ThreadMetadata,
  TokenUsage,
  ToolResult,
} from "@kontourai/thread";
import { THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import { asRecord, tryParseJson } from "./shared.js";

const MuseEvent = z
  .object({
    kind: z.string().optional(),
    recorded_at: z.number().optional(),
    // `.optional()` is load-bearing under zod 4: `z.unknown()` keys are
    // non-optional at parse time, and gap entries carry no envelope.
    envelope: z
      .object({
        id: z.string().optional(),
        sequence: z.number().optional(),
        recorded_at: z.number().optional(),
        payload_type: z.string().optional(),
        payload: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const MuseExport = z
  .object({
    export_schema_version: z.number(),
    session_terminated_abnormally: z.boolean().optional(),
    exporter_version: z
      .object({ semver: z.string().optional(), sha: z.string().optional() })
      .passthrough()
      .optional(),
    sessions: z
      .array(z.object({ session_id: z.string().optional() }).passthrough())
      .default([]),
    events: z.array(MuseEvent).default([]),
  })
  .passthrough();

/** The run events this importer maps; everything else is bookkeeping. */
const RunEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), prompt: z.string().optional() }).passthrough(),
  z.object({ kind: z.literal("model_response_created"), response_id: z.string() }).passthrough(),
  z
    .object({
      kind: z.literal("reasoning_committed"),
      response_id: z.string().optional(),
      text: z.string().optional(),
      encrypted_content: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("assistant_message_committed"),
      response_id: z.string().optional(),
      text: z.string(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("assistant_tool_calls_committed"),
      response_id: z.string().optional(),
      tool_calls: z.array(
        z
          .object({
            id: z.string().optional(),
            call_id: z.string().optional(),
            name: z.string(),
            // JSON *string*, not an object.
            args: z.string().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("tool_result_batch_committed"),
      results: z.array(
        z
          .object({ tool_call_id: z.string().optional(), text: z.string().optional() })
          .passthrough(),
      ),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("model_completed"),
      model: z.string().optional(),
      finish_reason: z.string().nullish(),
      usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cached_tokens: z.number().optional(),
          cache_read_tokens: z.number().optional(),
          cache_write_tokens: z.number().optional(),
          reasoning_tokens: z.number().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  z.object({ kind: z.literal("terminal") }).passthrough(),
]);

const FINISH_REASONS = new Set<FinishReason>([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "error",
  "cancelled",
]);

export interface MuseImportOptions {
  /** Called with a summary of dropped/undecodable records, if any. */
  onWarn?: (message: string) => void;
}

/**
 * `""` is not a usable id. `ToolCallId` is `z.string().min(1)`, and neither
 * this importer nor `threadToJson` validates on the way out — an empty id
 * would write a thread file that only fails later, on read.
 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Run-event kinds this importer maps; a malformed instance of one is disclosed. */
const MAPPED_RUN_EVENT_KINDS = new Set([
  "started",
  "assistant_message_committed",
  "assistant_tool_calls_committed",
  "tool_result_batch_committed",
  "reasoning_committed",
  "model_response_created",
  "model_completed",
]);

/** `recorded_at` is MICROseconds since the epoch; canonical timestamps are ms. */
function microsToMillis(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // Guard the unit, not just the type. Dividing a millisecond value by 1000
  // yields a silently plausible date in 1970 rather than an error, so refuse
  // anything that cannot be microseconds in a sane range (1980..2100).
  if (value < 315_360_000_000_000 || value > 4_102_444_800_000_000) return undefined;
  const ms = Math.round(value / 1000);
  return ms > 0 ? ms : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function importFromMuse(jsonContent: string, options: MuseImportOptions = {}): Thread {
  let document: unknown;
  try {
    document = JSON.parse(jsonContent);
  } catch (error) {
    throw new Error(
      `Not a Muse Code session export: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  const parsed = MuseExport.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `Not a Muse Code session export: ${parsed.error.issues[0]?.message ?? "invalid shape"}`,
    );
  }
  const exported = parsed.data;

  const threadId =
    exported.sessions.find((session) => typeof session.session_id === "string")?.session_id ??
    "muse-session";

  const messages: Message[] = [];
  let syntheticId = 0;
  const nextId = (): string => `${threadId}:${++syntheticId}`;
  const usedIds = new Set<string>();
  const uniqueId = (preferred: string): string => {
    if (!usedIds.has(preferred)) {
      usedIds.add(preferred);
      return preferred;
    }
    let candidate = `${preferred}:${++syntheticId}`;
    while (usedIds.has(candidate)) candidate = `${preferred}:${++syntheticId}`;
    usedIds.add(candidate);
    return candidate;
  };

  let workspaceRoot: string | undefined;
  let providerId: string | undefined;
  let sessionModelId: string | undefined;
  let buildVersion: string | undefined;
  let branch: string | undefined;
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;
  let gapEvents = 0;
  let encryptedOnlyReasoning = 0;
  let malformedMappedRunEvents = 0;
  let orphanedCompletions = 0;
  let undecodableEvents = 0;

  /** The response opened by the most recent `model_response_created`. */
  let openResponseId: string | undefined;
  /** Assistant messages still accepting content, keyed by response id. */
  const openAssistants = new Map<string, AssistantMessage>();
  /** Completions seen before the response committed any content. */
  const pendingCompletions = new Map<string, ResponseCompletion>();
  /** Tool name by call id — muse records it on the call, not on the result. */
  const toolNames = new Map<string, string>();

  interface ResponseCompletion {
    usage?: TokenUsage;
    rawUsage?: Record<string, unknown>;
    model?: string;
    finishReason?: FinishReason;
  }

  const applyCompletion = (message: AssistantMessage, completion: ResponseCompletion): void => {
    if (completion.usage) message.usage = completion.usage;
    if (completion.model !== undefined) message.model = completion.model;
    if (completion.finishReason !== undefined) message.finishReason = completion.finishReason;
    if (completion.rawUsage) {
      message.metadata = { ...message.metadata, museTokenUsage: completion.rawUsage };
    }
  };

  const openAssistant = (responseId: string, timestamp: number): AssistantMessage => {
    const existing = openAssistants.get(responseId);
    if (existing) return existing;
    const message: AssistantMessage = {
      id: uniqueId(responseId),
      threadId,
      role: "assistant",
      timestamp,
      content: [],
    };
    openAssistants.set(responseId, message);
    messages.push(message);
    const pending = pendingCompletions.get(responseId);
    if (pending) {
      applyCompletion(message, pending);
      pendingCompletions.delete(responseId);
    }
    return message;
  };

  // A committed tool batch or a new user turn ends every open response: later
  // content belongs to a new model call even if muse reuses a response id.
  const closeOpenAssistants = (): void => openAssistants.clear();

  for (const event of exported.events) {
    if (event.kind !== "record") {
      // `{kind: "gap", marker, omitted_record}` — the exporter records that a
      // live-only record existed but was not persisted. Nothing to import.
      gapEvents += 1;
      continue;
    }
    if (!event.envelope) {
      undecodableEvents += 1;
      continue;
    }
    const envelope = event.envelope;
    const timestamp =
      microsToMillis(envelope.recorded_at) ??
      microsToMillis(event.recorded_at) ??
      lastTimestamp ??
      undefined;
    if (timestamp !== undefined) {
      firstTimestamp ??= timestamp;
      lastTimestamp = timestamp;
    }
    const payload = asRecord(envelope.payload);
    if (!payload) {
      undecodableEvents += 1;
      continue;
    }

    if (payload["kind"] === "metadata") {
      const record = asRecord(payload["record"]);
      if (record) {
        if (typeof record["workspace_root"] === "string") workspaceRoot ??= record["workspace_root"];
        if (typeof record["provider_id"] === "string") providerId ??= record["provider_id"];
        if (typeof record["model_id"] === "string") sessionModelId ??= record["model_id"];
        const build = asRecord(record["build"]);
        if (build && typeof build["semver"] === "string") buildVersion ??= build["semver"];
      }
      continue;
    }

    if (payload["kind"] === "workspace_branch") {
      const reference = asRecord(asRecord(payload["record"])?.["reference"]);
      if (reference?.["kind"] === "branch" && typeof reference["name"] === "string") {
        branch = reference["name"];
      }
      continue;
    }

    // task / tool_batch_effect / route_facts / session_* records are bookkeeping.
    if (payload["kind"] !== "run") continue;

    const runEvent = RunEvent.safeParse(payload["event"]);
    if (!runEvent.success) {
      // Two very different cases used to share this branch. A run event kind
      // this importer does not map is expected and silent; a MALFORMED
      // instance of a kind it does map is a fidelity loss and must be
      // disclosed, or a null `text` would delete an assistant message whose
      // only symptom is a warning that misdescribes the cause. Mirrors
      // `claude-code.ts`'s skipped-line counting.
      const kind = asRecord(payload["event"])?.["kind"];
      if (typeof kind === "string" && MAPPED_RUN_EVENT_KINDS.has(kind)) {
        malformedMappedRunEvents += 1;
      }
      continue;
    }
    const run = runEvent.data;
    const at = timestamp ?? messages[messages.length - 1]?.timestamp ?? Date.now();

    switch (run.kind) {
      case "started": {
        closeOpenAssistants();
        // A turn boundary closes the open response. Without this, a genuinely
        // orphaned `model_completed` in a LATER turn would attach to the
        // previous turn's response id instead of being disclosed as an orphan.
        openResponseId = undefined;
        if (typeof run.prompt === "string" && run.prompt.length > 0) {
          messages.push({
            id: uniqueId(envelope.id ?? nextId()),
            threadId,
            role: "user",
            timestamp: at,
            content: [{ type: "text", text: run.prompt }],
          });
        }
        break;
      }

      case "model_response_created": {
        openResponseId = run.response_id;
        break;
      }

      case "reasoning_committed": {
        const responseId = run.response_id ?? openResponseId;
        if (responseId === undefined) break;
        if (typeof run.text === "string" && run.text.length > 0) {
          openAssistant(responseId, at).content.push({
            type: "reasoning",
            reasoning: { type: "reasoning", text: run.text },
          });
        } else if (typeof run.encrypted_content === "string" && run.encrypted_content.length > 0) {
          // Opaque provider-encrypted material: never presented as reasoning.
          encryptedOnlyReasoning += 1;
        }
        break;
      }

      case "assistant_message_committed": {
        const responseId = run.response_id ?? openResponseId;
        if (responseId === undefined || run.text.length === 0) break;
        openAssistant(responseId, at).content.push({ type: "text", text: run.text });
        break;
      }

      case "assistant_tool_calls_committed": {
        const responseId = run.response_id ?? openResponseId;
        if (responseId === undefined || run.tool_calls.length === 0) break;
        const message = openAssistant(responseId, at);
        for (const call of run.tool_calls) {
          const callId = nonEmpty(call.call_id) ?? nonEmpty(call.id) ?? nextId();
          toolNames.set(callId, call.name);
          const rawArguments = call.args ?? "";
          message.content.push({
            type: "tool_call",
            toolCall: {
              id: callId,
              name: call.name,
              arguments: rawArguments,
              parsedArguments: asRecord(tryParseJson(rawArguments)),
            },
          });
        }
        break;
      }

      case "tool_result_batch_committed": {
        const toolResults: ToolResult[] = [];
        for (const result of run.results) {
          const resultCallId = nonEmpty(result.tool_call_id);
          if (resultCallId === undefined) continue;
          toolResults.push({
            toolCallId: resultCallId,
            name: toolNames.get(resultCallId) ?? "",
            content: [{ type: "text", text: result.text ?? "" }],
          });
        }
        if (toolResults.length > 0) {
          messages.push({
            id: uniqueId(envelope.id ?? nextId()),
            threadId,
            role: "tool",
            timestamp: at,
            toolResults,
          });
        }
        closeOpenAssistants();
        break;
      }

      case "model_completed": {
        // The only drop path that used to be undisclosed. Every other one
        // (gaps, undecodable payloads, encrypted reasoning, pending
        // completions) is counted and surfaced, and this adapter treats
        // disclosure as a contract rather than a courtesy.
        if (openResponseId === undefined) {
          orphanedCompletions += 1;
          break;
        }
        const rawUsage = asRecord(run.usage);
        const completion: ResponseCompletion = {
          usage: rawUsage ? extractUsage(rawUsage) : undefined,
          rawUsage,
          model: run.model,
          finishReason:
            typeof run.finish_reason === "string" &&
            FINISH_REASONS.has(run.finish_reason as FinishReason)
              ? (run.finish_reason as FinishReason)
              : undefined,
        };
        const open = openAssistants.get(openResponseId);
        if (open) applyCompletion(open, completion);
        else pendingCompletions.set(openResponseId, completion);
        break;
      }

      case "terminal": {
        closeOpenAssistants();
        break;
      }
    }
  }

  if (messages.length === 0) {
    throw new Error("Muse input contained no importable messages");
  }

  // Model/provider are session-wide facts; a response that reported no
  // `model_completed` still ran on the session's configured model.
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    message.model ??= sessionModelId;
    message.provider ??= providerId;
  }

  if (encryptedOnlyReasoning > 0) {
    options.onWarn?.(
      `muse: ${encryptedOnlyReasoning} reasoning event(s) carried only provider-encrypted content and were not imported as reasoning`,
    );
  }
  if (gapEvents > 0) {
    options.onWarn?.(`muse: ${gapEvents} export gap marker(s) carried no record to import`);
  }
  if (undecodableEvents > 0) {
    options.onWarn?.(`muse: skipped ${undecodableEvents} record(s) with no decodable payload`);
  }
  if (pendingCompletions.size > 0) {
    // A model response reported usage but committed no message — nothing to
    // attach it to, and attaching it elsewhere would misattribute it.
    options.onWarn?.(
      `muse: ${pendingCompletions.size} model response(s) reported usage but committed no message; that usage is not represented`,
    );
  }
  if (exported.sessions.length > 1) {
    options.onWarn?.(
      `muse: export contains ${exported.sessions.length} sessions; all events were imported into one thread (${threadId})`,
    );
  }

  const custom: Record<string, unknown> = {};
  if (encryptedOnlyReasoning > 0) custom["museEncryptedReasoningDropped"] = encryptedOnlyReasoning;
  if (malformedMappedRunEvents > 0) {
    custom["museMalformedRunEventsDropped"] = malformedMappedRunEvents;
    options.onWarn?.(
      `muse: dropped ${malformedMappedRunEvents} run event(s) whose payload did not match this importer's schema for a kind it maps`,
    );
  }
  if (orphanedCompletions > 0) {
    custom["museOrphanedCompletionsDropped"] = orphanedCompletions;
    options.onWarn?.(
      `muse: dropped usage from ${orphanedCompletions} model_completed event(s) with no preceding model_response_created`,
    );
  }
  if (exported.session_terminated_abnormally === true) {
    custom["museSessionTerminatedAbnormally"] = true;
  }

  const metadata: ThreadMetadata = {
    source: "muse",
    sourceVersion: buildVersion,
    cwd: workspaceRoot,
    ...(branch ? { git: { branch } } : {}),
    ...(Object.keys(custom).length > 0 ? { custom } : {}),
  };

  return {
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: threadId,
    messages,
    metadata,
    createdAt: firstTimestamp ?? messages[0]?.timestamp ?? Date.now(),
    updatedAt: lastTimestamp ?? messages[messages.length - 1]?.timestamp ?? Date.now(),
  };
}

/**
 * muse reports `input_tokens` inclusive of cache reads; canonical
 * `inputTokens` is exclusive, so reads and writes are subtracted.
 */
function extractUsage(raw: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = nonnegativeInteger(raw["input_tokens"]);
  const outputTokens = nonnegativeInteger(raw["output_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadTokens =
    nonnegativeInteger(raw["cache_read_tokens"]) ?? nonnegativeInteger(raw["cached_tokens"]) ?? 0;
  const cacheWriteTokens = nonnegativeInteger(raw["cache_write_tokens"]) ?? 0;
  const reasoningTokens = nonnegativeInteger(raw["reasoning_tokens"]);
  return {
    inputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    cacheReadTokens,
    cacheWriteTokens,
  };
}
