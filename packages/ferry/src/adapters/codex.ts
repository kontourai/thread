/**
 * Import from Codex CLI rollout transcripts.
 * Source: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
 *
 * Each line is `{timestamp: ISO string, type, payload}`. Conversation content
 * lives in `type: "response_item"` payloads:
 * - `message` — user/assistant text (`input_text` / `output_text` parts)
 * - `reasoning` — summary array (+ opaque `encrypted_content`, not imported)
 * - `function_call` / `custom_tool_call` — tool invocations
 * - `function_call_output` / `custom_tool_call_output` — tool results
 * `session_meta` carries the session id, cwd and CLI version; `turn_context`
 * carries the active model.
 *
 * Consecutive assistant-side items (reasoning, text, tool calls) are folded
 * into one assistant message per turn, mirroring how the Responses API groups
 * output items.
 *
 * Known limitations (deliberate):
 * - `agent_message` items (inter-agent traffic) and `tool_search_*` items are
 *   skipped.
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
 * - `agent_message` events are deliberately unimported (separate issue).
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
    payload: z.unknown(),
  })
  .passthrough();

export interface CodexImportOptions {
  /** Called with a summary of skipped/unparseable records, if any. */
  onWarn?: (message: string) => void;
}

export function importFromCodex(
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
  }
  const items: Item[] = [];
  let responseItemCount = 0;

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
      responseItemCount += 1;
      items.push({ timestamp: parseTimestamp(record.timestamp), payload, model: currentModel });
    } else if (record.type === "event_msg" && payload["type"] === "token_count") {
      items.push({
        timestamp: parseTimestamp(record.timestamp),
        payload,
        model: currentModel,
        isTokenCount: true,
      });
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
  if (responseItemCount === 0) {
    throw new Error("No Codex response items found in input");
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

  for (const { timestamp, payload, model, isTokenCount } of items) {
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
      const assistant =
        previousTokenCountMessageIndex === undefined
          ? undefined
          : findAssistantWithoutUsage(messages, previousTokenCountMessageIndex);
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
      const parts = extractMessageParts(payload["content"]);
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
    // agent_message, tool_search_call/_output and unknown types are skipped.
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
          codexTokenUsage: {
            ...tokenCount.rawUsage,
            ...(tokenCount.inconsistent ? { inconsistent: true } : {}),
          },
        }
      : {}),
    ...(tokenCount.rateLimits ? { codexRateLimits: tokenCount.rateLimits } : {}),
  };
}

function findAssistantWithoutUsage(
  messages: Message[],
  fromIndex: number,
): AssistantMessage | undefined {
  for (let index = fromIndex; index < messages.length; index += 1) {
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
