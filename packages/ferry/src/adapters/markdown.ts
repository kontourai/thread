/**
 * Export to human-readable Markdown (one-way; not re-importable).
 */

import type { Thread } from "@kontourai/thread";

export interface MarkdownOptions {
  includeMetadata?: boolean;
  includeTimestamps?: boolean;
  includeReasoning?: boolean;
  includeToolCalls?: boolean;
  /** Truncate individual tool results beyond this many characters. */
  maxToolResultLength?: number;
}

const escapeYaml = (value: string): string => JSON.stringify(value);

export function exportToMarkdown(thread: Thread, options: MarkdownOptions = {}): string {
  const {
    includeMetadata = true,
    includeTimestamps = true,
    includeReasoning = true,
    includeToolCalls = true,
    maxToolResultLength = 2000,
  } = options;

  const lines: string[] = [];

  if (includeMetadata) {
    lines.push("---");
    lines.push(`title: ${escapeYaml(thread.metadata?.title ?? `Thread ${thread.id}`)}`);
    lines.push(`id: ${escapeYaml(thread.id)}`);
    lines.push(`created: ${new Date(thread.createdAt).toISOString()}`);
    lines.push(`updated: ${new Date(thread.updatedAt).toISOString()}`);
    if (thread.metadata?.source) lines.push(`source: ${escapeYaml(thread.metadata.source)}`);
    if (thread.metadata?.sourceVersion) {
      lines.push(`sourceVersion: ${escapeYaml(thread.metadata.sourceVersion)}`);
    }
    if (thread.metadata?.cwd) lines.push(`cwd: ${escapeYaml(thread.metadata.cwd)}`);
    if (thread.metadata?.git?.branch) {
      lines.push(`branch: ${escapeYaml(thread.metadata.git.branch)}`);
    }
    if (thread.metadata?.tags?.length) {
      lines.push(`tags: [${thread.metadata.tags.map(escapeYaml).join(", ")}]`);
    }
    lines.push("---", "");
  }

  for (const msg of thread.messages) {
    const time = includeTimestamps ? ` — ${new Date(msg.timestamp).toISOString()}` : "";

    if (msg.role === "user" || msg.role === "system") {
      lines.push(`## ${msg.role === "user" ? "User" : "System"}${time}`, "");
      for (const part of msg.content) {
        if (part.type === "text") lines.push(part.text, "");
        else if (part.type === "image") lines.push(`*[image: ${part.mediaType}]*`, "");
        else lines.push(`*[file: ${part.name} (${part.mediaType})]*`, "");
      }
    } else if (msg.role === "assistant") {
      const model = msg.model ? ` (${msg.model})` : "";
      lines.push(`## Assistant${model}${time}`, "");
      for (const part of msg.content) {
        if (part.type === "text") {
          lines.push(part.text, "");
        } else if (part.type === "reasoning" && includeReasoning) {
          if (part.reasoning.text) {
            lines.push("<details><summary>Reasoning</summary>", "");
            lines.push(part.reasoning.text, "");
            lines.push("</details>", "");
          }
        } else if (part.type === "tool_call" && includeToolCalls) {
          lines.push(`**→ ${part.toolCall.name}**`, "");
          lines.push("```json", part.toolCall.arguments, "```", "");
        } else if (part.type === "image") {
          lines.push(`*[image: ${part.image.mediaType}]*`, "");
        }
      }
    } else if (msg.role === "tool" && includeToolCalls) {
      for (const result of msg.toolResults) {
        const label = result.name ? `${result.name} ` : "";
        const status = result.isError ? " (error)" : "";
        lines.push(`**← ${label}result${status}**`, "");
        const text = result.content
          .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join("\n");
        const truncated =
          text.length > maxToolResultLength
            ? `${text.slice(0, maxToolResultLength)}\n… (${text.length - maxToolResultLength} more characters)`
            : text;
        lines.push("```", truncated, "```", "");
      }
    }
  }

  return lines.join("\n");
}
