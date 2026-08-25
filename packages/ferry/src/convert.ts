/**
 * Format-dispatch shared by the CLI and programmatic callers.
 */

import type { Thread } from "@kontourai/thread";
import { threadFromJson, threadToJson } from "@kontourai/thread";
import type { MessageIdentityObservation } from "@kontourai/thread/answer";
import {
  ferryMessageIdentityObservationFromStanding,
  normalizeMessageIdentityObservations,
  type MessageIdentityObservationSink,
} from "./answer.js";
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

/** Additive import result for consumers that need durable answer-ref standing. */
export interface ImportResult {
  threads: Thread[];
  messageIdentityObservations: MessageIdentityObservation[];
}

export function importThreads(
  content: string | readonly string[],
  format: InputFormat,
  options: ImportOptions = {},
): Thread[] {
  return importThreadsWithIdentityObservations(content, format, options).threads;
}

/**
 * Imports the usual Thread values plus serializable identity observations.
 * `importThreads` remains the compatibility API.  Observation collection is
 * callback-based so adapters declare standing at source-read time; it never
 * guesses from a converted ID's spelling.
 */
export function importThreadsWithIdentityObservations(
  content: string | readonly string[],
  format: InputFormat,
  options: ImportOptions = {},
): ImportResult {
  const { onWarn } = options;
  const raw: MessageIdentityObservation[] = [];
  const onMessageIdentity: MessageIdentityObservationSink = (message, standing) => {
    raw.push(ferryMessageIdentityObservationFromStanding(message, standing));
  };
  let threads: Thread[];
  switch (format) {
    case "claude-code":
      threads = [importFromClaudeCode(content, { onWarn, onMessageIdentity })]; break;
    case "codex":
      threads = [importFromCodex(content, { onWarn, onMessageIdentity })]; break;
    case "opencode":
      threads = [importFromOpenCode(requireString(content, format), { onMessageIdentity })]; break;
    case "kiro":
      threads = [importFromKiro(content, { onWarn, sessionId: options.sessionId, onMessageIdentity })]; break;
    case "pi":
      threads = [importFromPi(content, { onWarn, onMessageIdentity })]; break;
    case "muse":
      threads = [importFromMuse(requireString(content, format), { onWarn, onMessageIdentity })]; break;
    case "chatgpt-export":
      threads = importFromChatGPTExport(requireString(content, format), { onWarn, onMessageIdentity }); break;
    case "thread":
      threads = [threadFromJson(requireString(content, format))];
      for (const thread of threads) for (const message of thread.messages) onMessageIdentity(message, "adapter-fallback");
      break;
  }
  return { threads, messageIdentityObservations: normalizeMessageIdentityObservations(raw) };
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
