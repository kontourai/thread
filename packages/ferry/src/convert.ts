/**
 * Format-dispatch shared by the CLI and programmatic callers.
 */

import type { Thread } from "@kontourai/thread";
import { threadFromJson, threadToJson } from "@kontourai/thread";
import { importFromChatGPTExport } from "./adapters/chatgpt-export.js";
import { importFromClaudeCode } from "./adapters/claude-code.js";
import { importFromCodex } from "./adapters/codex.js";
import { importFromKiro } from "./adapters/kiro.js";
import { importFromOpenCode } from "./adapters/opencode.js";
import { importFromMuse } from "./adapters/muse.js";
import { importFromPi } from "./adapters/pi.js";
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
  "kiro",
  "pi",
  "muse",
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

export interface ImportOptions {
  /** Receives warnings about skipped/unparseable records. */
  onWarn?: (message: string) => void;
  /** Thread id for formats whose transcript does not carry one (kiro). */
  sessionId?: string;
}

export function importThreads(
  content: string | readonly string[],
  format: InputFormat,
  options: ImportOptions = {},
): Thread[] {
  const { onWarn } = options;
  switch (format) {
    case "claude-code":
      return [importFromClaudeCode(content, { onWarn })];
    case "codex":
      return [importFromCodex(content, { onWarn })];
    case "opencode":
      return [importFromOpenCode(requireString(content, format))];
    case "kiro":
      return [importFromKiro(content, { onWarn, sessionId: options.sessionId })];
    case "pi":
      return [importFromPi(content, { onWarn })];
    case "muse":
      return [importFromMuse(requireString(content, format), { onWarn })];
    case "chatgpt-export":
      return importFromChatGPTExport(requireString(content, format), { onWarn });
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
