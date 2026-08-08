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

export const THREAD_SCHEMA_VERSION = "1.0.0";
export const SCHEMA_NAME = "@kontourai/thread";

// ---------------------------------------------------------------------------
// Base scalars
// ---------------------------------------------------------------------------

export const MessageId = z.string().min(1);
export type MessageId = z.infer<typeof MessageId>;

export const ThreadId = z.string().min(1);
export type ThreadId = z.infer<typeof ThreadId>;

export const ToolCallId = z.string().min(1);
export type ToolCallId = z.infer<typeof ToolCallId>;

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
  annotations: z.record(z.unknown()).optional(),
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
 * structured form.
 */
export const ToolCall = z.object({
  id: ToolCallId,
  name: z.string(),
  arguments: z.string(),
  parsedArguments: z.record(z.unknown()).optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  toolCallId: ToolCallId,
  /** Tool name, when the source records it on the result ("" when unknown). */
  name: z.string(),
  content: z.array(ContentPart),
  isError: z.boolean().optional(),
  structuredResult: z.record(z.unknown()).optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

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
  providerMetadata: z.record(z.unknown()).optional(),
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
  metadata: z.record(z.unknown()).optional(),
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
  custom: z.record(z.unknown()).optional(),
});
export type ThreadMetadata = z.infer<typeof ThreadMetadata>;

export const Thread = z.object({
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
  return {
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: options?.id ?? createThreadId(),
    messages,
    metadata,
    createdAt: options?.createdAt ?? messages[0]?.timestamp ?? fallback,
    updatedAt: options?.updatedAt ?? messages[messages.length - 1]?.timestamp ?? fallback,
  };
};

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

export const threadToJson = (thread: Thread, pretty = true): string =>
  JSON.stringify(
    { ...thread, schemaVersion: thread.schemaVersion ?? THREAD_SCHEMA_VERSION },
    null,
    pretty ? 2 : 0,
  );

/** Parses and validates; throws ZodError on schema violations. */
export const threadFromJson = (json: string): Thread => Thread.parse(JSON.parse(json));
