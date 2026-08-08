/**
 * Export to the Anthropic Messages API `messages` array (+ system string).
 *
 * Tool results become `tool_result` blocks inside a user message — never
 * duplicated as free-standing text — and thinking blocks round-trip with
 * their signatures so a thread imported from Claude Code can be replayed.
 *
 * Fidelity notes (what is lost):
 * - File parts are flattened to text placeholders.
 * - Usage and timestamps are not representable per-message.
 * - Consecutive same-role messages are merged (API requires alternation).
 */

import type { Thread, ToolCall } from "@kontourai/thread";
import { tryParseJson, asRecord } from "./shared.js";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}
export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}
export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function imageBlock(data: string, mediaType: string): AnthropicImageBlock {
  if (/^https?:/.test(data)) {
    return { type: "image", source: { type: "url", url: data } };
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: data.replace(/^data:[^;]+;base64,/, ""),
    },
  };
}

function toolInput(toolCall: ToolCall): unknown {
  return toolCall.parsedArguments ?? asRecord(tryParseJson(toolCall.arguments)) ?? {};
}

export function exportToAnthropicMessages(thread: Thread): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  const push = (role: "user" | "assistant", content: AnthropicBlock[]): void => {
    if (content.length === 0) return;
    const previous = messages[messages.length - 1];
    if (previous && previous.role === role) {
      previous.content.push(...content);
    } else {
      messages.push({ role, content });
    }
  };

  for (const msg of thread.messages) {
    if (msg.role === "system") continue; // carried via extractSystemPrompt

    if (msg.role === "user") {
      const content: AnthropicBlock[] = [];
      for (const part of msg.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "image") content.push(imageBlock(part.data, part.mediaType));
        else if (part.type === "file") {
          content.push({ type: "text", text: `[file: ${part.name} (${part.mediaType})]` });
        }
      }
      push("user", content);
    } else if (msg.role === "assistant") {
      const content: AnthropicBlock[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "reasoning") {
          if (part.reasoning.text !== undefined) {
            content.push({
              type: "thinking",
              thinking: part.reasoning.text,
              ...(part.reasoning.signature !== undefined
                ? { signature: part.reasoning.signature }
                : {}),
            });
          }
        } else if (part.type === "tool_call") {
          content.push({
            type: "tool_use",
            id: part.toolCall.id,
            name: part.toolCall.name,
            input: toolInput(part.toolCall),
          });
        } else if (part.type === "image") {
          content.push(imageBlock(part.image.data, part.image.mediaType));
        }
      }
      push("assistant", content);
    } else if (msg.role === "tool") {
      const content: AnthropicBlock[] = msg.toolResults.map((result) => ({
        type: "tool_result",
        tool_use_id: result.toolCallId,
        content: result.content.map((part): AnthropicTextBlock | AnthropicImageBlock => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "image") return imageBlock(part.data, part.mediaType);
          return { type: "text", text: `[file: ${part.name}]` };
        }),
        ...(result.isError !== undefined ? { is_error: result.isError } : {}),
      }));
      push("user", content);
    }
  }

  return messages;
}

export function extractSystemPrompt(thread: Thread): string | undefined {
  const texts = thread.messages
    .filter((m) => m.role === "system")
    .map((m) =>
      m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    )
    .filter((t) => t.length > 0);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}
