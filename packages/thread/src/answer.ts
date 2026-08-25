/**
 * A deliberately small, inert boundary for showing one assistant answer.
 *
 * This is not a second Thread serialization format.  It identifies an
 * owner-issued assistant message and projects only its visible text; reasoning,
 * tool inputs, result payloads, attachments, annotations, and metadata do not
 * cross this boundary.
 */

import { z } from "zod";

import {
  BoundedOpaqueId,
  Message,
  SCHEMA_NAME,
  THREAD_SCHEMA_VERSION,
} from "./schema.js";

export const THREAD_ANSWER_REF_AUTHORITY = SCHEMA_NAME;
export const THREAD_ANSWER_REF_KIND = "assistant-message";

/**
 * Exact, owner-issued identity for an assistant message.  These fields are
 * opaque identifiers, never URLs or normalized paths.
 */
export const ThreadAnswerRef = z
  .object({
    authority: z.literal(THREAD_ANSWER_REF_AUTHORITY),
    schemaVersion: z.literal(THREAD_SCHEMA_VERSION),
    kind: z.literal(THREAD_ANSWER_REF_KIND),
    threadId: BoundedOpaqueId,
    messageId: BoundedOpaqueId,
  })
  .strict();
export type ThreadAnswerRef = z.infer<typeof ThreadAnswerRef>;

/** Requires both IDs from the owning transcript; it never creates identities. */
export const createThreadAnswerRef = (
  threadId: string,
  messageId: string,
): ThreadAnswerRef =>
  ThreadAnswerRef.parse({
    authority: THREAD_ANSWER_REF_AUTHORITY,
    schemaVersion: THREAD_SCHEMA_VERSION,
    kind: THREAD_ANSWER_REF_KIND,
    threadId,
    messageId,
  });

/** Parses the closed wire shape, including its authority and schema version. */
export const parseThreadAnswerRef = (value: unknown): ThreadAnswerRef => ThreadAnswerRef.parse(value);

/** Non-throwing validation for untrusted wire input. */
export const isThreadAnswerRef = (value: unknown): value is ThreadAnswerRef =>
  ThreadAnswerRef.safeParse(value).success;

/**
 * Collision-free, deterministic identity key.  Tuple encoding keeps equal
 * message IDs in different threads distinct without interpreting either ID.
 */
export const threadAnswerRefKey = (ref: ThreadAnswerRef): string => {
  const canonical = ThreadAnswerRef.parse(ref);
  return JSON.stringify([
    canonical.authority,
    canonical.schemaVersion,
    canonical.kind,
    canonical.threadId,
    canonical.messageId,
  ]);
};

// No source metadata is retained.  Defining this explicitly prevents a later
// consumer from treating metadata as an unbounded safe display field.
export const MAX_SAFE_ASSISTANT_ANSWER_METADATA_BYTES = 0;
/** At most this many non-empty visible text parts are exposed. */
export const MAX_SAFE_ASSISTANT_ANSWER_PARTS = 32;
/** At most this many UTF-8 bytes may be retained from one text part. */
export const MAX_SAFE_ASSISTANT_ANSWER_PART_TEXT_BYTES = 16 * 1024;
/** At most this many UTF-8 bytes may be retained across all answer text. */
export const MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES = 64 * 1024;
/** Total UTF-8 bytes across the ref and projected content strings. */
export const MAX_SAFE_ASSISTANT_ANSWER_BYTES = 72 * 1024;

const isWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

/** UTF-8 byte length without requiring Node or DOM globals. */
const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const codePoint of value) {
    const valueAtPoint = codePoint.codePointAt(0) ?? 0;
    if (valueAtPoint <= 0x7f) bytes += 1;
    else if (valueAtPoint <= 0x7ff) bytes += 2;
    else if (valueAtPoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

/** Truncates at Unicode code-point boundaries, never leaving a lone surrogate. */
const truncateUtf8 = (value: string, limit: number): { value: string; omittedBytes: number } => {
  if (utf8ByteLength(value) <= limit) return { value, omittedBytes: 0 };

  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (bytes + codePointBytes > limit) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return { value: value.slice(0, end), omittedBytes: utf8ByteLength(value) - bytes };
};

const SafeAssistantAnswerTextPart = z
  .object({ type: z.literal("text"), text: z.string().min(1) })
  .strict();
export type SafeAssistantAnswerTextPart = z.infer<typeof SafeAssistantAnswerTextPart>;

const answerTextBytes = (content: readonly SafeAssistantAnswerTextPart[]): number =>
  content.reduce((total, part) => total + utf8ByteLength(part.text), 0);

const answerPayloadBytes = (answer: {
  ref: ThreadAnswerRef;
  content: readonly SafeAssistantAnswerTextPart[];
}): number =>
  utf8ByteLength(answer.ref.authority) +
  utf8ByteLength(answer.ref.schemaVersion) +
  utf8ByteLength(answer.ref.kind) +
  utf8ByteLength(answer.ref.threadId) +
  utf8ByteLength(answer.ref.messageId) +
  answer.content.reduce((total, part) => total + utf8ByteLength(part.type) + utf8ByteLength(part.text), 0);

/**
 * A bounded display-safe answer.  Its `ref` is exact; no source metadata is
 * included.  Omission fields describe capacity loss among retained text
 * candidates only, never intentional exclusions such as reasoning or tools.
 */
export const SafeAssistantAnswerProjection = z
  .object({
    ref: ThreadAnswerRef,
    content: z.array(SafeAssistantAnswerTextPart).min(1).max(MAX_SAFE_ASSISTANT_ANSWER_PARTS),
    truncated: z.boolean(),
    omittedParts: z.number().int().nonnegative(),
    omittedTextBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((answer, ctx) => {
    if (!answer.content.every((part) => isWellFormedUnicode(part.text))) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "text must be well-formed Unicode" });
    }
    if (answer.content.some((part) => utf8ByteLength(part.text) > MAX_SAFE_ASSISTANT_ANSWER_PART_TEXT_BYTES)) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "a text part exceeds its byte budget" });
    }
    if (answerTextBytes(answer.content) > MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "answer text exceeds its byte budget" });
    }
    if (answerPayloadBytes(answer) > MAX_SAFE_ASSISTANT_ANSWER_BYTES) {
      ctx.addIssue({ code: "custom", message: "answer projection exceeds its total byte budget" });
    }
    const hasCapacityLoss = answer.omittedParts > 0 || answer.omittedTextBytes > 0;
    if (answer.truncated !== hasCapacityLoss) {
      ctx.addIssue({ code: "custom", path: ["truncated"], message: "truncated must exactly reflect capacity loss" });
    }
  });
export type SafeAssistantAnswerProjection = z.infer<typeof SafeAssistantAnswerProjection>;

export type AssistantAnswerProjectionOutcome =
  | { state: "available"; answer: SafeAssistantAnswerProjection }
  | {
      state: "unavailable";
      reason:
        | "invalid-reference"
        | "invalid-message"
        | "not-assistant"
        | "reference-mismatch"
        | "corrupt-content"
        | "no-safe-answer-text";
    };

/**
 * Safely projects a possibly-untrusted message.  This function is total: bad
 * reference/message data is represented as an unavailable result rather than
 * leaking a Zod parse exception through an answer-rendering boundary.
 */
export const projectAssistantAnswer = (
  refInput: unknown,
  messageInput: unknown,
): AssistantAnswerProjectionOutcome => {
  const parsedRef = ThreadAnswerRef.safeParse(refInput);
  if (!parsedRef.success) return { state: "unavailable", reason: "invalid-reference" };

  const parsedMessage = Message.safeParse(messageInput);
  if (!parsedMessage.success) return { state: "unavailable", reason: "invalid-message" };
  const message = parsedMessage.data;
  if (message.role !== "assistant") return { state: "unavailable", reason: "not-assistant" };
  if (message.threadId !== parsedRef.data.threadId || message.id !== parsedRef.data.messageId) {
    return { state: "unavailable", reason: "reference-mismatch" };
  }

  const textParts = message.content.filter((part) => part.type === "text");
  if (!textParts.every((part) => isWellFormedUnicode(part.text))) {
    return { state: "unavailable", reason: "corrupt-content" };
  }
  const candidates = textParts.filter((part) => part.text.length > 0);
  if (candidates.length === 0) return { state: "unavailable", reason: "no-safe-answer-text" };

  const ref = parsedRef.data;
  const content: SafeAssistantAnswerTextPart[] = [];
  let payloadBytes = answerPayloadBytes({ ref, content });
  let textBytes = 0;
  let omittedParts = 0;
  let omittedTextBytes = 0;

  for (const candidate of candidates) {
    const sourceBytes = utf8ByteLength(candidate.text);
    if (content.length === MAX_SAFE_ASSISTANT_ANSWER_PARTS) {
      omittedParts += 1;
      omittedTextBytes += sourceBytes;
      continue;
    }

    const availableTextBytes = Math.min(
      MAX_SAFE_ASSISTANT_ANSWER_PART_TEXT_BYTES,
      MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES - textBytes,
      MAX_SAFE_ASSISTANT_ANSWER_BYTES - payloadBytes - utf8ByteLength("text"),
    );
    if (availableTextBytes <= 0) {
      omittedParts += 1;
      omittedTextBytes += sourceBytes;
      continue;
    }
    const truncated = truncateUtf8(candidate.text, availableTextBytes);
    if (truncated.value.length === 0) {
      omittedParts += 1;
      omittedTextBytes += sourceBytes;
      continue;
    }
    content.push({ type: "text", text: truncated.value });
    const retainedBytes = sourceBytes - truncated.omittedBytes;
    textBytes += retainedBytes;
    payloadBytes += utf8ByteLength("text") + retainedBytes;
    omittedTextBytes += truncated.omittedBytes;
  }

  // The bounded reference guarantees this is reachable for a valid candidate,
  // but retain a typed outcome if future budget changes invalidate that fact.
  if (content.length === 0) return { state: "unavailable", reason: "no-safe-answer-text" };

  const answer = SafeAssistantAnswerProjection.parse({
    ref,
    content,
    truncated: omittedParts > 0 || omittedTextBytes > 0,
    omittedParts,
    omittedTextBytes,
  });
  return { state: "available", answer };
};
