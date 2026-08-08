/**
 * Export to the Google Gemini API `contents` array (REST camelCase shapes:
 * `functionCall`, `functionResponse`, `inlineData`).
 *
 * Function responses ride in `user`-role contents per the current API
 * (the legacy `function` role is deprecated).
 *
 * Fidelity notes (what is lost):
 * - Reasoning parts are dropped.
 * - File parts are flattened to text placeholders.
 * - Tool call ids are not representable; pairing is by function name.
 */

import type { Thread, ToolCall } from "@kontourai/thread";
import { asRecord, tryParseJson } from "./shared.js";

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function toolArgs(toolCall: ToolCall): unknown {
  return toolCall.parsedArguments ?? asRecord(tryParseJson(toolCall.arguments)) ?? {};
}

export function exportToGemini(thread: Thread): GeminiContent[] {
  const contents: GeminiContent[] = [];
  /** callId → tool name, so results can be paired by name. */
  const callNames = new Map<string, string>();

  for (const msg of thread.messages) {
    if (msg.role === "system") continue; // carried via extractSystemInstruction

    if (msg.role === "user") {
      const parts: GeminiPart[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else if (part.type === "image" && !/^https?:/.test(part.data)) {
          parts.push({
            inlineData: {
              mimeType: part.mediaType,
              data: part.data.replace(/^data:[^;]+;base64,/, ""),
            },
          });
        } else if (part.type === "image") {
          parts.push({ text: `[image: ${part.data}]` });
        } else {
          parts.push({ text: `[file: ${part.name} (${part.mediaType})]` });
        }
      }
      if (parts.length > 0) contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else if (part.type === "tool_call") {
          callNames.set(part.toolCall.id, part.toolCall.name);
          parts.push({
            functionCall: { name: part.toolCall.name, args: toolArgs(part.toolCall) },
          });
        }
        // reasoning and image output parts are dropped.
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      const parts: GeminiPart[] = msg.toolResults.map((result) => ({
        functionResponse: {
          name: result.name || callNames.get(result.toolCallId) || "unknown",
          response: {
            content: result.content
              .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
              .join("\n"),
          },
        },
      }));
      if (parts.length > 0) contents.push({ role: "user", parts });
    }
  }

  return contents;
}

export function extractSystemInstruction(thread: Thread): string | undefined {
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
