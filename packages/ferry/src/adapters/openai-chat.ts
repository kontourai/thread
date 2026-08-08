/**
 * Export to the OpenAI Chat Completions `messages` array.
 *
 * Fidelity notes (what is lost or caveated):
 * - Reasoning parts are dropped (Chat Completions has no reasoning input).
 * - File parts and assistant image output are flattened to text placeholders.
 * - Non-text tool result content (images) is flattened to text placeholders.
 * - Usage, model and timestamps are not representable per-message.
 * - A trailing tool call with no recorded result exports without a following
 *   `tool` message; replay requires supplying one.
 */

import type { Thread } from "@kontourai/thread";

export interface OpenAIChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function toImageUrl(data: string, mediaType: string): string {
  return /^(https?:|data:|file:)/.test(data) ? data : `data:${mediaType};base64,${data}`;
}

export function exportToOpenAIChat(thread: Thread): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];

  for (const msg of thread.messages) {
    if (msg.role === "user" || msg.role === "system") {
      const text = msg.content
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "file") return `[file: ${c.name} (${c.mediaType})]`;
          return "";
        })
        .filter((t) => t.length > 0)
        .join("\n");
      const images = msg.role === "user" ? msg.content.filter((c) => c.type === "image") : [];

      if (images.length > 0) {
        const content: OpenAIChatMessage["content"] = [];
        if (text) content.push({ type: "text", text });
        for (const img of images) {
          content.push({ type: "image_url", image_url: { url: toImageUrl(img.data, img.mediaType) } });
        }
        messages.push({ role: "user", content });
      } else if (text) {
        messages.push({ role: msg.role, content: text });
      }
    } else if (msg.role === "assistant") {
      const text = msg.content
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "image") return `[image: ${c.image.mediaType}]`;
          return "";
        })
        .filter((t) => t.length > 0)
        .join("\n");
      const toolCalls = msg.content
        .filter((c) => c.type === "tool_call")
        .map((c) => c.toolCall);

      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: text || undefined,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
    } else if (msg.role === "tool") {
      for (const result of msg.toolResults) {
        const text = result.content
          .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join("\n");
        messages.push({ role: "tool", content: text, tool_call_id: result.toolCallId });
      }
    }
  }

  return messages;
}
