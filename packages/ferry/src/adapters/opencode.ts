/**
 * Import from OpenCode session exports.
 * Source: `opencode export <sessionID>` JSON — `{info, messages: [{info, parts}]}`.
 *
 * Message info carries `role`, `time.{created,completed}` (epoch ms),
 * `modelID`/`providerID`, and `tokens.{input,output,reasoning,cache:{read,write}}`.
 * Parts carry `type`: `text`, `reasoning`, `tool` (with
 * `state: {status, input, output}`), `file`, plus structural markers
 * (`step-start`, `step-finish`, `snapshot`, `patch`, …) that are skipped.
 *
 * Tool parts embed both the call and its result; they are split into an
 * assistant `tool_call` plus a following tool message so pairing survives
 * export to API formats.
 */

import { z } from "zod";
import type {
  AssistantContent,
  ContentPart,
  Message,
  Thread,
  ThreadMetadata,
  ToolResult,
} from "@kontourai/thread";
import { THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import { asRecord, parseTimestamp } from "./shared.js";

const OpenCodeExport = z
  .object({
    info: z
      .object({
        id: z.string().optional(),
        title: z.string().optional(),
        directory: z.string().optional(),
        version: z.string().optional(),
        time: z
          .object({ created: z.number().optional(), updated: z.number().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    messages: z.array(
      z
        .object({
          info: z
            .object({
              id: z.string().optional(),
              role: z.enum(["user", "assistant"]),
              time: z
                .object({ created: z.number().optional(), completed: z.number().optional() })
                .passthrough()
                .optional(),
              modelID: z.string().optional(),
              providerID: z.string().optional(),
              tokens: z
                .object({
                  input: z.number().optional(),
                  output: z.number().optional(),
                  reasoning: z.number().optional(),
                  cache: z
                    .object({ read: z.number().optional(), write: z.number().optional() })
                    .passthrough()
                    .optional(),
                })
                .passthrough()
                .optional(),
            })
            .passthrough(),
          parts: z.array(z.object({ type: z.string() }).passthrough()).default([]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function importFromOpenCode(jsonContent: string): Thread {
  const parsed = OpenCodeExport.safeParse(JSON.parse(jsonContent));
  if (!parsed.success) {
    throw new Error(`Not an OpenCode session export: ${parsed.error.issues[0]?.message ?? "invalid shape"}`);
  }
  const session = parsed.data;
  const threadId = session.info?.id ?? "opencode-session";
  const messages: Message[] = [];
  let syntheticId = 0;
  const nextId = (): string => `${threadId}:${++syntheticId}`;

  for (const message of session.messages) {
    const info = message.info;
    const timestamp =
      parseTimestamp(info.time?.created) ?? messages[messages.length - 1]?.timestamp ?? Date.now();

    if (info.role === "user") {
      const content: ContentPart[] = [];
      for (const part of message.parts) {
        const p = part as Record<string, unknown>;
        if (p["type"] === "text" && typeof p["text"] === "string") {
          content.push({ type: "text", text: p["text"] });
        } else if (p["type"] === "file") {
          const url = typeof p["url"] === "string" ? p["url"] : "";
          content.push({
            type: "file",
            name: typeof p["filename"] === "string" ? p["filename"] : "file",
            mediaType: typeof p["mime"] === "string" ? p["mime"] : "application/octet-stream",
            data: url,
          });
        }
      }
      if (content.length > 0) {
        messages.push({ id: info.id ?? nextId(), threadId, role: "user", timestamp, content });
      }
      continue;
    }

    // Assistant message: fold text/reasoning/tool calls, then emit tool
    // results (which OpenCode embeds in the same parts) as a tool message.
    const content: AssistantContent[] = [];
    const toolResults: ToolResult[] = [];
    for (const part of message.parts) {
      const p = part as Record<string, unknown>;
      if (p["type"] === "text" && typeof p["text"] === "string") {
        content.push({ type: "text", text: p["text"] });
      } else if (p["type"] === "reasoning" && typeof p["text"] === "string") {
        content.push({ type: "reasoning", reasoning: { type: "reasoning", text: p["text"] } });
      } else if (p["type"] === "tool") {
        const state = asRecord(p["state"]) ?? {};
        const callId =
          typeof p["callID"] === "string" ? p["callID"] : `${threadId}:call:${++syntheticId}`;
        const name = typeof p["tool"] === "string" ? p["tool"] : "unknown";
        const input = asRecord(state["input"]);
        content.push({
          type: "tool_call",
          toolCall: {
            id: callId,
            name,
            arguments: JSON.stringify(state["input"] ?? {}),
            parsedArguments: input,
          },
        });
        if (typeof state["output"] === "string" || state["status"] === "error") {
          toolResults.push({
            toolCallId: callId,
            name,
            content: [
              {
                type: "text",
                text:
                  typeof state["output"] === "string"
                    ? state["output"]
                    : typeof state["error"] === "string"
                      ? state["error"]
                      : "",
              },
            ],
            isError: state["status"] === "error" ? true : undefined,
          });
        }
      }
      // step-start/step-finish/snapshot/patch/etc. are structural, skipped.
    }

    if (content.length > 0) {
      const tokens = info.tokens;
      messages.push({
        id: info.id ?? nextId(),
        threadId,
        role: "assistant",
        timestamp,
        content,
        model: info.modelID,
        provider: info.providerID,
        usage:
          tokens && (tokens.input !== undefined || tokens.output !== undefined)
            ? {
                inputTokens: Math.max(0, Math.round(tokens.input ?? 0)),
                outputTokens: Math.max(0, Math.round(tokens.output ?? 0)),
                reasoningTokens:
                  tokens.reasoning !== undefined
                    ? Math.max(0, Math.round(tokens.reasoning))
                    : undefined,
                cacheReadTokens:
                  tokens.cache?.read !== undefined
                    ? Math.max(0, Math.round(tokens.cache.read))
                    : undefined,
                cacheWriteTokens:
                  tokens.cache?.write !== undefined
                    ? Math.max(0, Math.round(tokens.cache.write))
                    : undefined,
              }
            : undefined,
      });
    }
    if (toolResults.length > 0) {
      messages.push({
        id: nextId(),
        threadId,
        role: "tool",
        timestamp: parseTimestamp(info.time?.completed) ?? timestamp,
        toolResults,
      });
    }
  }

  if (messages.length === 0) {
    throw new Error("OpenCode input contained no importable messages");
  }

  const metadata: ThreadMetadata = {
    source: "opencode",
    sourceVersion: session.info?.version,
    cwd: session.info?.directory,
    title: session.info?.title,
  };

  return {
    schemaVersion: THREAD_SCHEMA_VERSION,
    id: threadId,
    messages,
    metadata,
    createdAt:
      parseTimestamp(session.info?.time?.created) ?? messages[0]?.timestamp ?? Date.now(),
    updatedAt:
      parseTimestamp(session.info?.time?.updated) ??
      messages[messages.length - 1]?.timestamp ??
      Date.now(),
  };
}
