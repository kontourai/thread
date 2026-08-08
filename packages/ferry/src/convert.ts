/**
 * Format-dispatch shared by the CLI and programmatic callers.
 */

import type { Thread } from "@kontourai/thread";
import { threadFromJson, threadToJson } from "@kontourai/thread";
import { importFromChatGPTExport } from "./adapters/chatgpt-export.js";
import { importFromClaudeCode } from "./adapters/claude-code.js";
import { importFromCodex } from "./adapters/codex.js";
import { importFromOpenCode } from "./adapters/opencode.js";
import {
  exportToAnthropicMessages,
  extractSystemPrompt,
} from "./adapters/anthropic-messages.js";
import { exportToGemini, extractSystemInstruction } from "./adapters/gemini.js";
import { exportToMarkdown } from "./adapters/markdown.js";
import { exportToOpenAIChat } from "./adapters/openai-chat.js";
import type { InputFormat } from "./detect.js";

export const INPUT_FORMATS: readonly InputFormat[] = [
  "claude-code",
  "codex",
  "opencode",
  "chatgpt-export",
  "thread",
];

export const OUTPUT_FORMATS = [
  "thread",
  "openai-chat",
  "anthropic-messages",
  "gemini",
  "markdown",
] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function importThreads(
  content: string | readonly string[],
  format: InputFormat,
): Thread[] {
  switch (format) {
    case "claude-code":
      return [importFromClaudeCode(content)];
    case "codex":
      return [importFromCodex(content)];
    case "opencode":
      return [importFromOpenCode(requireString(content, format))];
    case "chatgpt-export":
      return importFromChatGPTExport(requireString(content, format));
    case "thread":
      return [threadFromJson(requireString(content, format))];
  }
}

function requireString(content: string | readonly string[], format: InputFormat): string {
  if (typeof content !== "string") {
    throw new Error(
      `${format} input is a single JSON document too large to parse in one piece; split it first`,
    );
  }
  return content;
}

export function exportThread(thread: Thread, format: OutputFormat): string {
  switch (format) {
    case "thread":
      return threadToJson(thread);
    case "openai-chat":
      return JSON.stringify(exportToOpenAIChat(thread), null, 2);
    case "anthropic-messages": {
      const system = extractSystemPrompt(thread);
      return JSON.stringify(
        {
          ...(system !== undefined ? { system } : {}),
          messages: exportToAnthropicMessages(thread),
        },
        null,
        2,
      );
    }
    case "gemini": {
      const system = extractSystemInstruction(thread);
      return JSON.stringify(
        {
          ...(system !== undefined
            ? { systemInstruction: { parts: [{ text: system }] } }
            : {}),
          contents: exportToGemini(thread),
        },
        null,
        2,
      );
    }
    case "markdown":
      return exportToMarkdown(thread);
  }
}
