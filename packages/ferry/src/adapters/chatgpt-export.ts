/**
 * Import from ChatGPT data exports (conversations.json).
 *
 * Each conversation is a tree (`mapping` of nodes with parent/children);
 * the canonical transcript is the path from `current_node` up to the root —
 * NOT a walk down first-children, which would pick an arbitrary branch when
 * the user edited messages.
 *
 * Content types handled: `text`, `multimodal_text` (string parts only),
 * `code` (imported as text), `thoughts` (imported as reasoning).
 * Known limitations (deliberate):
 * - Tool/plugin messages and image asset pointers are skipped (the export
 *   does not include the binary assets).
 * - Messages hidden from the UI (`is_visually_hidden_from_conversation`)
 *   and empty system placeholders are skipped.
 */

import { z } from "zod";
import type {
  AssistantContent,
  ContentPart,
  Message,
  Thread,
  ThreadMetadata,
} from "@kontourai/thread";
import { THREAD_SCHEMA_VERSION } from "@kontourai/thread";
import { asRecord } from "./shared.js";

// Field-level .catch() keeps one malformed node from silently deleting the
// whole conversation: a bad message degrades to null, bad links degrade to
// no-links, and the rest of the tree still imports. These per-field
// degradations are not individually counted (only whole-conversation skips
// reach onWarn) — zod's .catch offers no hook to observe them.
const MappingNode = z
  .object({
    id: z.string().optional(),
    message: z
      .object({
        id: z.string(),
        author: z.object({ role: z.string() }).loose(),
        content: z.object({ content_type: z.string() }).loose(),
        create_time: z.number().nullish(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .loose()
      .nullable()
      .catch(null),
    parent: z.string().nullable().catch(null),
    children: z.array(z.string()).catch([]),
  })
  .loose();

const Conversation = z
  .object({
    id: z.string().optional(),
    conversation_id: z.string().optional(),
    title: z.string().nullish(),
    create_time: z.number().nullish(),
    update_time: z.number().nullish(),
    mapping: z.record(z.string(), MappingNode),
    current_node: z.string().nullish(),
  })
  .loose();

type Conversation = z.infer<typeof Conversation>;
type Node = z.infer<typeof MappingNode>;

/** Walk current_node → root via parents; returns nodes in transcript order. */
function canonicalPath(conversation: Conversation): Node[] {
  const mapping = conversation.mapping;
  let leafId = conversation.current_node ?? undefined;
  if (leafId === undefined || !(leafId in mapping)) {
    // Fall back to any node without children (a leaf), preferring the last.
    for (const [id, node] of Object.entries(mapping)) {
      if (node.children.length === 0) leafId = id;
    }
  }
  const path: Node[] = [];
  const seen = new Set<string>();
  let currentId: string | null | undefined = leafId;
  while (currentId !== null && currentId !== undefined && !seen.has(currentId)) {
    const node: Node | undefined = mapping[currentId];
    if (!node) break;
    seen.add(currentId);
    path.push(node);
    currentId = node.parent;
  }
  return path.reverse();
}

function textFromParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0);
}

export interface ChatGPTImportOptions {
  /** Called with a summary of skipped conversations, if any. */
  onWarn?: (message: string) => void;
}

export function importFromChatGPTExport(
  jsonContent: string,
  options: ChatGPTImportOptions = {},
): Thread[] {
  const raw: unknown = JSON.parse(jsonContent);
  const candidates = Array.isArray(raw) ? raw : [raw];
  const threads: Thread[] = [];
  let skippedConversations = 0;

  for (const candidate of candidates) {
    const parsed = Conversation.safeParse(candidate);
    if (!parsed.success) {
      skippedConversations += 1;
      continue;
    }
    const conversation = parsed.data;
    const threadId =
      conversation.id ?? conversation.conversation_id ?? `chatgpt-${threads.length + 1}`;
    const messages: Message[] = [];

    for (const node of canonicalPath(conversation)) {
      const msg = node.message;
      if (!msg) continue;
      const metadata = msg.metadata ?? {};
      if (metadata["is_visually_hidden_from_conversation"] === true) continue;

      const role = msg.author.role;
      const contentType = msg.content.content_type;
      const timestamp =
        typeof msg.create_time === "number" && msg.create_time > 0
          ? Math.round(msg.create_time * 1000)
          : (messages[messages.length - 1]?.timestamp ??
            (typeof conversation.create_time === "number"
              ? Math.round(conversation.create_time * 1000)
              : Date.now()));

      if (role === "user" || role === "system") {
        const texts = textFromParts((msg.content as Record<string, unknown>)["parts"]);
        if (texts.length === 0) continue; // empty system root placeholder
        const content: ContentPart[] = texts.map((text) => ({ type: "text", text }));
        messages.push({ id: msg.id, threadId, role, timestamp, content });
      } else if (role === "assistant") {
        const content: AssistantContent[] = [];
        if (contentType === "text" || contentType === "multimodal_text") {
          for (const text of textFromParts((msg.content as Record<string, unknown>)["parts"])) {
            content.push({ type: "text", text });
          }
        } else if (contentType === "code") {
          const codeText = (msg.content as Record<string, unknown>)["text"];
          if (typeof codeText === "string" && codeText.length > 0) {
            content.push({ type: "text", text: codeText });
          }
        } else if (contentType === "thoughts") {
          const thoughts = (msg.content as Record<string, unknown>)["thoughts"];
          if (Array.isArray(thoughts)) {
            const texts = thoughts
              .map((t) => asRecord(t))
              .filter((t): t is Record<string, unknown> => t !== undefined)
              .map((t) => (typeof t["content"] === "string" ? t["content"] : undefined))
              .filter((t): t is string => t !== undefined && t.length > 0);
            if (texts.length > 0) {
              content.push({
                type: "reasoning",
                reasoning: { type: "reasoning", text: texts.join("\n") },
              });
            }
          }
        }
        if (content.length === 0) continue;
        const model = metadata["model_slug"];
        messages.push({
          id: msg.id,
          threadId,
          role: "assistant",
          timestamp,
          content,
          model: typeof model === "string" ? model : undefined,
          provider: "openai",
        });
      }
      // tool / plugin roles are skipped.
    }

    if (messages.length === 0) continue;

    const metadata: ThreadMetadata = {
      source: "chatgpt-export",
      title: conversation.title ?? undefined,
    };
    threads.push({
      schemaVersion: THREAD_SCHEMA_VERSION,
      id: threadId,
      messages,
      metadata,
      createdAt:
        typeof conversation.create_time === "number" && conversation.create_time > 0
          ? Math.round(conversation.create_time * 1000)
          : (messages[0]?.timestamp ?? Date.now()),
      updatedAt:
        typeof conversation.update_time === "number" && conversation.update_time > 0
          ? Math.round(conversation.update_time * 1000)
          : (messages[messages.length - 1]?.timestamp ?? Date.now()),
    });
  }

  if (skippedConversations > 0) {
    options.onWarn?.(
      `chatgpt-export: skipped ${skippedConversations} conversation(s) that did not match the export shape`,
    );
  }
  return threads;
}
