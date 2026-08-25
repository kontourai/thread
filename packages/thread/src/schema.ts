/**
 * @kontourai/thread — canonical AI conversation schema.
 *
 * A portable, tool-agnostic representation of an agent conversation:
 * messages, tool calls and results, reasoning, attachments, usage.
 *
 * IDs are plain strings on purpose: threads cross package and process
 * boundaries, and branded types don't survive serialization anyway.
 */

import { z } from "zod";

export const THREAD_SCHEMA_VERSION = "1.2.0";
export const SCHEMA_NAME = "@kontourai/thread";

// ---------------------------------------------------------------------------
// Base scalars
// ---------------------------------------------------------------------------

export const MAX_OPAQUE_ID_BYTES = 4096;
export const MAX_NAMESPACE_BYTES = 4096;

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

/** Byte length matching UTF-8 encoding without requiring DOM or Node globals. */
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

const hasUtf8BytesAtMost = (limit: number) => (value: string): boolean =>
  utf8ByteLength(value) <= limit;

const WellFormedUnicode = z.string().refine(isWellFormedUnicode, {
  message: "must be well-formed Unicode",
});

/** Stable, opaque identifiers supplied by the owning system. */
export const BoundedOpaqueId = WellFormedUnicode.min(1).refine(hasUtf8BytesAtMost(MAX_OPAQUE_ID_BYTES), {
  message: `must be at most ${MAX_OPAQUE_ID_BYTES} UTF-8 bytes`,
});
export type BoundedOpaqueId = z.infer<typeof BoundedOpaqueId>;

/** Namespace labels supplied by an adapter or provider. */
export const BoundedNamespace = WellFormedUnicode.min(1).refine(
  hasUtf8BytesAtMost(MAX_NAMESPACE_BYTES),
  { message: `must be at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes` },
);
export type BoundedNamespace = z.infer<typeof BoundedNamespace>;

export const MessageId = z.string().min(1);
export type MessageId = z.infer<typeof MessageId>;

export const ThreadId = z.string().min(1);
export type ThreadId = z.infer<typeof ThreadId>;

export const ToolCallId = z.string().min(1);
export type ToolCallId = z.infer<typeof ToolCallId>;

/** A provider-issued identity for one terminal tool result, never a call ID. */
export const ToolResultId = BoundedOpaqueId;
export type ToolResultId = z.infer<typeof ToolResultId>;

export const ModelId = z.string();
export type ModelId = z.infer<typeof ModelId>;

export const ProviderId = z.string();
export type ProviderId = z.infer<typeof ProviderId>;

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.number().int().positive();
export type Timestamp = z.infer<typeof Timestamp>;

// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

export const TextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type TextPart = z.infer<typeof TextPart>;

/** `data` is either base64 image bytes or a URL (http(s):, data:, file:). */
export const ImagePart = z.object({
  type: z.literal("image"),
  data: z.string(),
  mediaType: z.string(),
  detail: z.enum(["low", "high", "auto"]).optional(),
});
export type ImagePart = z.infer<typeof ImagePart>;

/** `data` is either base64 file bytes or a URL, mirroring ImagePart. */
export const FilePart = z.object({
  type: z.literal("file"),
  name: z.string(),
  mediaType: z.string(),
  data: z.string(),
  size: z.number().int().nonnegative().optional(),
});
export type FilePart = z.infer<typeof FilePart>;

export const ContentPart = z.discriminatedUnion("type", [TextPart, ImagePart, FilePart]);
export type ContentPart = z.infer<typeof ContentPart>;

// ---------------------------------------------------------------------------
// Tool calls and results
// ---------------------------------------------------------------------------

/**
 * `arguments` carries the raw argument string exactly as the source emitted it
 * (usually JSON, but some tools emit free-form strings). `parsedArguments` is
 * present when the source provided — or the importer could recover — a
 * structured form OF THE SAME ARGUMENTS: exporters re-emit it as the model's
 * literal tool input, so nothing derived or summarized may go there.
 *
 * `derived` is the opposite contract: importer-produced analysis ABOUT the
 * call, keyed by the producing importer, never source-provided and never a
 * replay input. Exporters must ignore it. It exists because some tools take
 * an opaque payload — Codex's `exec` takes a JavaScript program, not
 * arguments — where the only way to make the call queryable is a documented
 * heuristic, and putting a heuristic in `parsedArguments` would assert on the
 * wire that the model called the tool with keys it never sent.
 */
export const ToolCall = z.object({
  id: ToolCallId,
  name: z.string(),
  arguments: z.string(),
  parsedArguments: z.record(z.string(), z.unknown()).optional(),
  derived: z.record(z.string(), z.unknown()).optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResultTerminalStatus = z.enum(["success", "error", "cancelled", "unknown"]);
export type ToolResultTerminalStatus = z.infer<typeof ToolResultTerminalStatus>;

/** An explicit policy denial, as reported by the owning authority. */
export const ToolResultAuthorityDecision = z.object({
  decision: z.literal("denied"),
  authority: BoundedOpaqueId,
  policyId: BoundedOpaqueId.optional(),
});
export type ToolResultAuthorityDecision = z.infer<typeof ToolResultAuthorityDecision>;

/** A portable pointer to the source session, turn, event, message, or result. */
export const ToolResultCorrelation = z.object({
  namespace: BoundedNamespace,
  kind: z.enum(["session", "turn", "event", "message", "result"]),
  id: BoundedOpaqueId,
});
export type ToolResultCorrelation = z.infer<typeof ToolResultCorrelation>;

/** At most sixteen distinct source pointers; tuple encoding avoids delimiter collisions. */
export const ToolResultCorrelations = z
  .array(ToolResultCorrelation)
  .max(16)
  .superRefine((correlations, ctx) => {
    const seen = new Set<string>();
    for (const [index, correlation] of correlations.entries()) {
      const key = JSON.stringify([correlation.namespace, correlation.kind, correlation.id]);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "correlations must be unique",
        });
      }
      seen.add(key);
    }
  });

export const ToolResult = z
  .object({
    toolCallId: ToolCallId,
    /**
     * Tool name. Importers that can pair a result with its call carry the
     * call's name across (claude-code, codex, opencode); `""` means genuinely
     * unpaired — a result whose call was never seen — not "this source does
     * not record it".
     */
    name: z.string(),
    content: z.array(ContentPart),
    isError: z.boolean().optional(),
    structuredResult: z.record(z.string(), z.unknown()).optional(),
    /** Owner-issued result identity and its terminal standing are inseparable. */
    resultId: ToolResultId.optional(),
    terminalStatus: ToolResultTerminalStatus.optional(),
    authorityDecision: ToolResultAuthorityDecision.optional(),
    correlations: ToolResultCorrelations.optional(),
  })
  .superRefine((result, ctx) => {
    const identified = result.resultId !== undefined && result.terminalStatus !== undefined;
    if ((result.resultId === undefined) !== (result.terminalStatus === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: result.resultId === undefined ? ["resultId"] : ["terminalStatus"],
        message: "resultId and terminalStatus must be supplied together",
      });
    }
    if (result.resultId !== undefined && result.resultId === result.toolCallId) {
      ctx.addIssue({
        code: "custom",
        path: ["resultId"],
        message: "resultId must not equal toolCallId",
      });
    }
    if (!identified && result.authorityDecision !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["authorityDecision"],
        message: "authorityDecision requires an identified tool result",
      });
    }
    if (!identified && result.correlations !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["correlations"],
        message: "correlations require an identified tool result",
      });
    }
    if (result.authorityDecision !== undefined && result.terminalStatus === "success") {
      ctx.addIssue({
        code: "custom",
        path: ["authorityDecision"],
        message: "a denied result cannot have success terminalStatus",
      });
    }
    if (
      (result.terminalStatus === "success" || result.terminalStatus === "cancelled") &&
      result.isError === true
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["isError"],
        message: "isError must not be true for a successful or cancelled result",
      });
    }
    if (result.terminalStatus === "error" && result.isError === false) {
      ctx.addIssue({
        code: "custom",
        path: ["isError"],
        message: "isError must not be false for an error result",
      });
    }
  });
export type ToolResult = z.infer<typeof ToolResult>;

/** A result whose identity and terminal standing were recorded by its owner. */
export type IdentifiedToolResult = ToolResult & {
  resultId: ToolResultId;
  terminalStatus: ToolResultTerminalStatus;
};

// ---------------------------------------------------------------------------
// Reasoning
// ---------------------------------------------------------------------------

/**
 * `text` is absent when the source only ships opaque/encrypted reasoning.
 * `signature` preserves provider verification material (e.g. Anthropic
 * thinking signatures) so a thread can be replayed against the provider.
 */
export const ReasoningPart = z.object({
  type: z.literal("reasoning"),
  text: z.string().optional(),
  signature: z.string().optional(),
  providerMetadata: z.record(z.string(), z.unknown()).optional(),
});
export type ReasoningPart = z.infer<typeof ReasoningPart>;

// ---------------------------------------------------------------------------
// Assistant content
// ---------------------------------------------------------------------------

export const AssistantTextContent = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type AssistantTextContent = z.infer<typeof AssistantTextContent>;

export const AssistantReasoningContent = z.object({
  type: z.literal("reasoning"),
  reasoning: ReasoningPart,
});
export type AssistantReasoningContent = z.infer<typeof AssistantReasoningContent>;

export const AssistantToolCallContent = z.object({
  type: z.literal("tool_call"),
  toolCall: ToolCall,
});
export type AssistantToolCallContent = z.infer<typeof AssistantToolCallContent>;

export const AssistantImageContent = z.object({
  type: z.literal("image"),
  image: ImagePart,
});
export type AssistantImageContent = z.infer<typeof AssistantImageContent>;

export const AssistantContent = z.discriminatedUnion("type", [
  AssistantTextContent,
  AssistantReasoningContent,
  AssistantToolCallContent,
  AssistantImageContent,
]);
export type AssistantContent = z.infer<typeof AssistantContent>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const BaseMessage = {
  id: MessageId,
  threadId: ThreadId,
  timestamp: Timestamp,
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const UserMessage = z.object({
  ...BaseMessage,
  role: z.literal("user"),
  content: z.array(ContentPart),
});
export type UserMessage = z.infer<typeof UserMessage>;

export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const FinishReason = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "error",
  "cancelled",
]);
export type FinishReason = z.infer<typeof FinishReason>;

export const AssistantMessage = z.object({
  ...BaseMessage,
  role: z.literal("assistant"),
  content: z.array(AssistantContent),
  model: ModelId.optional(),
  provider: ProviderId.optional(),
  usage: TokenUsage.optional(),
  finishReason: FinishReason.optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const SystemMessage = z.object({
  ...BaseMessage,
  role: z.literal("system"),
  content: z.array(ContentPart),
});
export type SystemMessage = z.infer<typeof SystemMessage>;

export const ToolMessage = z.object({
  ...BaseMessage,
  role: z.literal("tool"),
  toolResults: z.array(ToolResult),
});
export type ToolMessage = z.infer<typeof ToolMessage>;

export const Message = z.discriminatedUnion("role", [
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ToolMessage,
]);
export type Message = z.infer<typeof Message>;

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export const ThreadMetadata = z.object({
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Importing tool identifier, e.g. "claude-code", "codex", "opencode". */
  source: z.string().optional(),
  /** Version of the source tool that wrote the original transcript. */
  sourceVersion: z.string().optional(),
  cwd: z.string().optional(),
  git: z
    .object({
      repo: z.string().optional(),
      branch: z.string().optional(),
      commit: z.string().optional(),
    })
    .optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type ThreadMetadata = z.infer<typeof ThreadMetadata>;

export const Thread = z
  .object({
    /**
     * Serialized threads written by this package always stamp the version;
     * it is optional on parse so hand-built objects remain valid.
     */
    schemaVersion: z.string().optional(),
    id: ThreadId,
    messages: z.array(Message),
    metadata: ThreadMetadata.optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .superRefine((thread, ctx) => {
    const resultIds = new Set<string>();
    for (const [messageIndex, message] of thread.messages.entries()) {
      if (message.role !== "tool") continue;
      for (const [resultIndex, result] of message.toolResults.entries()) {
        if (result.resultId === undefined) continue;
        if (resultIds.has(result.resultId)) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", messageIndex, "toolResults", resultIndex, "resultId"],
            message: "identified tool result IDs must be unique within a thread",
          });
        }
        resultIds.add(result.resultId);
      }
    }
  });
export type Thread = z.infer<typeof Thread>;

// ---------------------------------------------------------------------------
// Type guards and accessors
// ---------------------------------------------------------------------------

export const isUserMessage = (msg: Message): msg is UserMessage => msg.role === "user";
export const isAssistantMessage = (msg: Message): msg is AssistantMessage =>
  msg.role === "assistant";
export const isSystemMessage = (msg: Message): msg is SystemMessage => msg.role === "system";
export const isToolMessage = (msg: Message): msg is ToolMessage => msg.role === "tool";

/** True when this result retains the owner-issued identity required for dereference. */
export const isIdentifiedToolResult = (result: ToolResult): result is IdentifiedToolResult =>
  result.resultId !== undefined && result.terminalStatus !== undefined;

/** Concatenated text of a message's text parts (empty string for tool messages). */
export const getTextContent = (msg: Message): string => {
  if (isUserMessage(msg) || isSystemMessage(msg)) {
    return msg.content
      .filter((c): c is TextPart => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (isAssistantMessage(msg)) {
    return msg.content
      .filter((c): c is AssistantTextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
};

export const getToolCalls = (msg: AssistantMessage): ToolCall[] =>
  msg.content
    .filter((c): c is AssistantToolCallContent => c.type === "tool_call")
    .map((c) => c.toolCall);

/** Concatenated reasoning text of an assistant message, undefined when absent. */
export const getReasoning = (msg: AssistantMessage): string | undefined => {
  const texts = msg.content
    .filter((c): c is AssistantReasoningContent => c.type === "reasoning")
    .map((c) => c.reasoning.text)
    .filter((t): t is string => t !== undefined && t.length > 0);
  return texts.length > 0 ? texts.join("\n") : undefined;
};

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let idCounter = 0;
const generateId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${(++idCounter).toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;

export const createMessageId = (): MessageId => generateId("msg");
export const createThreadId = (): ThreadId => generateId("thread");
export const createToolCallId = (): ToolCallId => generateId("call");
export const now = (): Timestamp => Date.now();

/**
 * Creates an owner-identified tool result. The caller must supply the owner
 * result ID and terminal status; this factory deliberately never invents
 * either piece of source evidence.
 */
export const createToolResult = (result: IdentifiedToolResult): IdentifiedToolResult => {
  const parsed = ToolResult.parse(result);
  if (!isIdentifiedToolResult(parsed)) {
    throw new Error("createToolResult requires resultId and terminalStatus");
  }
  return parsed;
};

export const createUserMessage = (
  threadId: ThreadId,
  content: string | ContentPart[],
): UserMessage => ({
  id: createMessageId(),
  threadId,
  role: "user",
  timestamp: now(),
  content: typeof content === "string" ? [{ type: "text", text: content }] : content,
});

export const createAssistantMessage = (
  threadId: ThreadId,
  content: AssistantContent[],
  options?: {
    model?: ModelId;
    provider?: ProviderId;
    usage?: TokenUsage;
    finishReason?: FinishReason;
  },
): AssistantMessage => ({
  id: createMessageId(),
  threadId,
  role: "assistant",
  timestamp: now(),
  content,
  ...options,
});

export const createSystemMessage = (threadId: ThreadId, content: string): SystemMessage => ({
  id: createMessageId(),
  threadId,
  role: "system",
  timestamp: now(),
  content: [{ type: "text", text: content }],
});

export const createToolMessage = (
  threadId: ThreadId,
  toolResults: ToolResult[],
): ToolMessage => ({
  id: createMessageId(),
  threadId,
  role: "tool",
  timestamp: now(),
  toolResults,
});

export const createThread = (
  messages: Message[] = [],
  metadata?: ThreadMetadata,
  options?: { id?: ThreadId; createdAt?: Timestamp; updatedAt?: Timestamp },
): Thread => {
  const fallback = now();
  return Thread.parse({
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: options?.id ?? createThreadId(),
    messages,
    metadata,
    createdAt: options?.createdAt ?? messages[0]?.timestamp ?? fallback,
    updatedAt: options?.updatedAt ?? messages[messages.length - 1]?.timestamp ?? fallback,
  });
};

// ---------------------------------------------------------------------------
// Safe tool-result projection
// ---------------------------------------------------------------------------

/** Maximum result content parts made available by a portable projection. */
export const MAX_PROJECTED_TOOL_RESULT_PARTS = 32;
/** Maximum UTF-8 bytes across projected text parts. */
export const MAX_PROJECTED_TOOL_RESULT_TEXT_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes in a displayed tool or file label. */
export const MAX_PROJECTED_TOOL_RESULT_LABEL_BYTES = 256;
/** Maximum UTF-8 bytes in a projected media type. */
export const MAX_PROJECTED_TOOL_RESULT_MEDIA_TYPE_BYTES = 256;
/** Maximum UTF-8 bytes in each projected authority or correlation scalar. */
export const MAX_PROJECTED_TOOL_RESULT_METADATA_FIELD_BYTES = 256;
/** Maximum UTF-8 bytes across every string retained by a safe projection. */
export const MAX_PROJECTED_TOOL_RESULT_BYTES = 72 * 1024;

const ProjectedLabel = WellFormedUnicode.refine(
  hasUtf8BytesAtMost(MAX_PROJECTED_TOOL_RESULT_LABEL_BYTES),
  { message: `must be at most ${MAX_PROJECTED_TOOL_RESULT_LABEL_BYTES} UTF-8 bytes` },
);
const isSafeFileLabel = (value: string): boolean =>
  value.length > 0 &&
  !/[\\/\u0000-\u001F\u007F]/u.test(value) &&
  value !== "." &&
  value !== ".." &&
  !/^[A-Za-z]:/u.test(value);
const isSafeMediaType = (value: string): boolean => {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)) {
    return false;
  }
  const primaryType = value.slice(0, value.indexOf("/")).toLowerCase();
  return !["data", "file", "http", "https"].includes(primaryType);
};
const SafeFileLabel = ProjectedLabel.refine(isSafeFileLabel, {
  message: "must be a neutral file label, not a path or control-bearing name",
});
const SafeMediaType = WellFormedUnicode.refine(
  hasUtf8BytesAtMost(MAX_PROJECTED_TOOL_RESULT_MEDIA_TYPE_BYTES),
  { message: `must be at most ${MAX_PROJECTED_TOOL_RESULT_MEDIA_TYPE_BYTES} UTF-8 bytes` },
).refine(isSafeMediaType, { message: "must be a type/subtype MIME token" });
const ProjectedMetadataScalar = WellFormedUnicode.refine(
  hasUtf8BytesAtMost(MAX_PROJECTED_TOOL_RESULT_METADATA_FIELD_BYTES),
  { message: `must be at most ${MAX_PROJECTED_TOOL_RESULT_METADATA_FIELD_BYTES} UTF-8 bytes` },
);

export const SafeToolResultPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: WellFormedUnicode }),
  z.object({ type: z.literal("image"), mediaType: SafeMediaType }),
  z.object({
    type: z.literal("file"),
    name: SafeFileLabel,
    mediaType: SafeMediaType,
    size: z.number().int().nonnegative().optional(),
  }),
]);
export type SafeToolResultPart = z.infer<typeof SafeToolResultPart>;

export const SafeToolResultAuthorityDecision = z.object({
  decision: z.literal("denied"),
  authority: ProjectedMetadataScalar,
  policyId: ProjectedMetadataScalar.optional(),
});
export type SafeToolResultAuthorityDecision = z.infer<typeof SafeToolResultAuthorityDecision>;

export const SafeToolResultCorrelation = z.object({
  namespace: ProjectedMetadataScalar,
  kind: z.enum(["session", "turn", "event", "message", "result"]),
  id: ProjectedMetadataScalar,
});
export type SafeToolResultCorrelation = z.infer<typeof SafeToolResultCorrelation>;

export const SafeToolResultCorrelations = z
  .array(SafeToolResultCorrelation)
  .max(16)
  .superRefine((correlations, ctx) => {
    const seen = new Set<string>();
    for (const [index, correlation] of correlations.entries()) {
      const key = JSON.stringify([correlation.namespace, correlation.kind, correlation.id]);
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: [index], message: "correlations must be unique" });
      }
      seen.add(key);
    }
  });

const projectedTextBytes = (content: SafeToolResultPart[]): number =>
  content.reduce((bytes, part) => bytes + (part.type === "text" ? utf8ByteLength(part.text) : 0), 0);

const projectedPayloadBytes = (result: {
  resultId: string;
  name: string;
  terminalStatus: string;
  authorityDecision?: SafeToolResultAuthorityDecision;
  correlations?: SafeToolResultCorrelation[];
  content: SafeToolResultPart[];
}): number => {
  let bytes = utf8ByteLength(result.resultId) + utf8ByteLength(result.name) + utf8ByteLength(result.terminalStatus);
  if (result.authorityDecision !== undefined) {
    bytes += utf8ByteLength(result.authorityDecision.decision);
    bytes += utf8ByteLength(result.authorityDecision.authority);
    if (result.authorityDecision.policyId !== undefined) {
      bytes += utf8ByteLength(result.authorityDecision.policyId);
    }
  }
  for (const correlation of result.correlations ?? []) {
    bytes += utf8ByteLength(correlation.namespace);
    bytes += utf8ByteLength(correlation.kind);
    bytes += utf8ByteLength(correlation.id);
  }
  for (const part of result.content) {
    bytes += utf8ByteLength(part.type);
    if (part.type === "text") bytes += utf8ByteLength(part.text);
    else if (part.type === "image") bytes += utf8ByteLength(part.mediaType);
    else bytes += utf8ByteLength(part.name) + utf8ByteLength(part.mediaType);
  }
  return bytes;
};

/**
 * Content that can cross a consumer boundary without exposing tool payloads,
 * URLs, annotations, or structured result data. `truncated` records capacity
 * loss only; image/file payload omission is an intentional projection rule.
 */
export const SafeToolResultProjection = z
  .object({
    resultId: ToolResultId,
    name: ProjectedLabel,
    terminalStatus: ToolResultTerminalStatus,
    authorityDecision: SafeToolResultAuthorityDecision.optional(),
    correlations: SafeToolResultCorrelations.optional(),
    content: z.array(SafeToolResultPart).max(MAX_PROJECTED_TOOL_RESULT_PARTS),
    truncated: z.boolean(),
    omittedParts: z.number().int().nonnegative(),
    omittedTextBytes: z.number().int().nonnegative(),
    omittedMetadataBytes: z.number().int().nonnegative(),
  })
  .superRefine((result, ctx) => {
    if (projectedTextBytes(result.content) > MAX_PROJECTED_TOOL_RESULT_TEXT_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: `projected text must be at most ${MAX_PROJECTED_TOOL_RESULT_TEXT_BYTES} UTF-8 bytes`,
      });
    }
    if (projectedPayloadBytes(result) > MAX_PROJECTED_TOOL_RESULT_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `projected payload must be at most ${MAX_PROJECTED_TOOL_RESULT_BYTES} UTF-8 bytes`,
      });
    }
    const hasOmissions =
      result.omittedParts > 0 || result.omittedTextBytes > 0 || result.omittedMetadataBytes > 0;
    if (result.truncated !== hasOmissions) {
      ctx.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncated must exactly reflect omitted parts or text bytes",
      });
    }
  });
export type SafeToolResultProjection = z.infer<typeof SafeToolResultProjection>;

export type ToolResultProjectionOutcome =
  | { state: "available"; result: SafeToolResultProjection }
  | { state: "unavailable"; reason: "identity-not-captured" | "corrupt-content" };

/** Truncates at Unicode code-point boundaries, so it never leaves a broken emoji surrogate. */
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

const safeLabel = (value: string, fallback: string): { value: string; omittedBytes: number } => {
  const nonempty = value.length > 0 ? value : fallback;
  const truncated = truncateUtf8(nonempty, MAX_PROJECTED_TOOL_RESULT_LABEL_BYTES);
  return { value: truncated.value, omittedBytes: value.length === 0 ? 0 : truncated.omittedBytes };
};

const safeMediaType = (mediaType: string): { value: string; omittedBytes: number } => {
  if (!isSafeMediaType(mediaType)) {
    return { value: "application/octet-stream", omittedBytes: utf8ByteLength(mediaType) };
  }
  const truncated = truncateUtf8(mediaType, MAX_PROJECTED_TOOL_RESULT_MEDIA_TYPE_BYTES);
  if (!isSafeMediaType(truncated.value)) {
    return { value: "application/octet-stream", omittedBytes: utf8ByteLength(mediaType) };
  }
  return { value: truncated.value, omittedBytes: truncated.omittedBytes };
};

const safeFileName = (name: string): { value: string; omittedBytes: number } => {
  if (!isSafeFileLabel(name)) {
    return { value: "file", omittedBytes: utf8ByteLength(name) };
  }
  return safeLabel(name, "file");
};

const safeMetadataScalar = (value: string): { value: string; omittedBytes: number } => {
  const truncated = truncateUtf8(value, MAX_PROJECTED_TOOL_RESULT_METADATA_FIELD_BYTES);
  return { value: truncated.value, omittedBytes: truncated.omittedBytes };
};

const projectAuthorityDecision = (
  authorityDecision: ToolResultAuthorityDecision | undefined,
): { value?: SafeToolResultAuthorityDecision; omittedBytes: number } => {
  if (authorityDecision === undefined) return { omittedBytes: 0 };
  const authority = safeMetadataScalar(authorityDecision.authority);
  const policyId = authorityDecision.policyId === undefined
    ? undefined
    : safeMetadataScalar(authorityDecision.policyId);
  return {
    value: {
      decision: "denied",
      authority: authority.value,
      ...(policyId === undefined ? {} : { policyId: policyId.value }),
    },
    omittedBytes: authority.omittedBytes + (policyId?.omittedBytes ?? 0),
  };
};

const projectCorrelations = (
  correlations: ToolResultCorrelation[] | undefined,
): { value?: SafeToolResultCorrelation[]; omittedBytes: number } => {
  if (correlations === undefined) return { omittedBytes: 0 };
  let omittedBytes = 0;
  const seen = new Set<string>();
  const value: SafeToolResultCorrelation[] = [];
  for (const correlation of correlations) {
    const namespace = safeMetadataScalar(correlation.namespace);
    const id = safeMetadataScalar(correlation.id);
    const projected = { namespace: namespace.value, kind: correlation.kind, id: id.value };
    const key = JSON.stringify([projected.namespace, projected.kind, projected.id]);
    if (seen.has(key)) {
      omittedBytes +=
        utf8ByteLength(correlation.namespace) +
        utf8ByteLength(correlation.kind) +
        utf8ByteLength(correlation.id);
      continue;
    }
    seen.add(key);
    omittedBytes += namespace.omittedBytes + id.omittedBytes;
    value.push(projected);
  }
  return { value, omittedBytes };
};

const hasWellFormedProjectionContent = (result: ToolResult): boolean => {
  if (!isWellFormedUnicode(result.name)) return false;
  return result.content.every((part) => {
    if (part.type === "text") return isWellFormedUnicode(part.text);
    if (part.type === "image") return isWellFormedUnicode(part.mediaType);
    return isWellFormedUnicode(part.name) && isWellFormedUnicode(part.mediaType);
  });
};

/**
 * Produces a bounded inert view for consumers that later dereference a known
 * result. Legacy results deliberately disclose no call-derived identity.
 */
export const projectToolResult = (result: ToolResult): ToolResultProjectionOutcome => {
  const canonical = ToolResult.parse(result);
  if (!isIdentifiedToolResult(canonical)) {
    return { state: "unavailable", reason: "identity-not-captured" };
  }
  if (!hasWellFormedProjectionContent(canonical)) {
    return { state: "unavailable", reason: "corrupt-content" };
  }

  const retainedParts = canonical.content.slice(0, MAX_PROJECTED_TOOL_RESULT_PARTS);
  const omittedParts = canonical.content.length - retainedParts.length;
  let omittedMetadataBytes = 0;
  const retainedContent = retainedParts.map((part): SafeToolResultPart => {
    if (part.type === "text") return { type: "text", text: "" };
    if (part.type === "image") {
      const mediaType = safeMediaType(part.mediaType);
      omittedMetadataBytes += mediaType.omittedBytes;
      return { type: "image", mediaType: mediaType.value };
    }
    const name = safeFileName(part.name);
    const mediaType = safeMediaType(part.mediaType);
    omittedMetadataBytes += name.omittedBytes + mediaType.omittedBytes;
    return {
      type: "file",
      name: name.value,
      mediaType: mediaType.value,
      ...(part.size === undefined ? {} : { size: part.size }),
    };
  });
  const tailOmittedTextBytes = canonical.content
    .slice(MAX_PROJECTED_TOOL_RESULT_PARTS)
    .reduce((bytes, part) => bytes + (part.type === "text" ? utf8ByteLength(part.text) : 0), 0);
  const name = safeLabel(canonical.name, "tool");
  const authorityDecision = projectAuthorityDecision(canonical.authorityDecision);
  const correlations = projectCorrelations(canonical.correlations);
  omittedMetadataBytes += name.omittedBytes + authorityDecision.omittedBytes + correlations.omittedBytes;
  const staticProjection = {
    resultId: canonical.resultId,
    name: name.value,
    terminalStatus: canonical.terminalStatus,
    ...(authorityDecision.value === undefined ? {} : { authorityDecision: authorityDecision.value }),
    ...(correlations.value === undefined ? {} : { correlations: correlations.value }),
    content: retainedContent,
  };
  const staticBytes = projectedPayloadBytes(staticProjection);
  const remainingTextBytes = Math.min(
    MAX_PROJECTED_TOOL_RESULT_TEXT_BYTES,
    MAX_PROJECTED_TOOL_RESULT_BYTES - staticBytes,
  );
  if (remainingTextBytes < 0) {
    throw new RangeError("tool result identity metadata exceeds the safe projection byte budget");
  }

  let availableTextBytes = remainingTextBytes;
  let omittedTextBytes = tailOmittedTextBytes;
  const content = retainedParts.map((part, index): SafeToolResultPart => {
    if (part.type === "text") {
      const projected = truncateUtf8(part.text, availableTextBytes);
      availableTextBytes -= utf8ByteLength(projected.value);
      omittedTextBytes += projected.omittedBytes;
      return { type: "text", text: projected.value };
    }
    return retainedContent[index]!;
  });

  const projection = SafeToolResultProjection.parse({
    ...staticProjection,
    content,
    truncated: omittedParts > 0 || omittedTextBytes > 0 || omittedMetadataBytes > 0,
    omittedParts,
    omittedTextBytes,
    omittedMetadataBytes,
  });
  return {
    state: "available",
    result: projection,
  };
};

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

export const threadToJson = (thread: Thread, pretty = true): string => {
  const parsed = Thread.parse(thread);
  return JSON.stringify(
    { ...parsed, schemaVersion: parsed.schemaVersion ?? THREAD_SCHEMA_VERSION },
    null,
    pretty ? 2 : 0,
  );
};

/** Parses and validates; throws ZodError on schema violations. */
export const threadFromJson = (json: string): Thread => Thread.parse(JSON.parse(json));
