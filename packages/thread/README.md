# @kontourai/thread

Canonical Zod schema for AI conversations — messages, tool calls and results,
reasoning, attachments, token usage — plus type guards, factories, and
validated JSON serialization.

Schema 1.2.0 also supports owner-issued tool-result identity. Legacy imported
results remain valid, but only results carrying both `resultId` and
`terminalStatus` can be safely retained for later dereference. Use
`projectToolResult` when passing one to another consumer: it produces a
bounded inert view (32 parts, 64 KiB of UTF-8 text, and 72 KiB of projected
string data) and intentionally omits payload bytes, URLs, annotations, and
structured result data. Any dropped text or projected metadata is declared by
the mandatory omission counters on the projection.

## Assistant-answer references

`ThreadAnswerRef` is an exact, portable identity for one owner-issued assistant
message: `{ authority: "@kontourai/thread", schemaVersion: "1.2.0",
kind: "assistant-message", threadId, messageId }`. It is separate from the
serialized Thread/Message schema, so this additive API does **not** change the
Thread schema version or require Ferry adapters to invent source identities.

Use `createThreadAnswerRef(threadId, messageId)` only with the source owner's
IDs, then use the total `projectAssistantAnswer(ref, unknownMessage)` at a
consumer boundary. It returns a typed unavailable reason for bad input, a
non-assistant message, an identity mismatch, corrupt text, or an answer with
no visible text; it does not throw a Zod error for those inputs.

The available form retains ordered, inert text parts only. It never exposes
reasoning, tool calls or arguments, structured results, image/file payloads,
annotations, attachment paths or bytes, or source/private metadata. Markdown,
HTML, and URLs remain strings. The contract caps visible text at 32 parts,
16 KiB per part, 64 KiB total text, and 72 KiB across the ref plus content.
`truncated`, `omittedParts`, and `omittedTextBytes` describe capacity loss among
visible text candidates only; intentionally excluded reasoning/tools are not
misreported as truncation. Source metadata has an explicit zero-byte budget.

```ts
import { createThreadAnswerRef, projectAssistantAnswer } from "@kontourai/thread";

const ref = createThreadAnswerRef("source-thread-42", "source-message-7");
const outcome = projectAssistantAnswer(ref, importedMessage);
if (outcome.state === "available") {
  // Render outcome.answer.content as plain inert text, not executable markup.
  console.log(outcome.answer.content);
}
```

```ts
import { threadFromJson, getToolCalls, isAssistantMessage } from "@kontourai/thread";

const thread = threadFromJson(json); // validates, throws on schema violations
for (const msg of thread.messages) {
  if (isAssistantMessage(msg)) console.log(getToolCalls(msg));
}
```

```ts
import { createToolResult, projectToolResult } from "@kontourai/thread";

const result = createToolResult({
  resultId: "provider-result-42", // supplied by the result owner
  terminalStatus: "cancelled",
  toolCallId: "provider-call-9",
  name: "shell",
  content: [{ type: "text", text: "cancelled by user" }],
});

const projection = projectToolResult(result);
// { state: "available", result: { resultId, terminalStatus, content, ... } }
```

Use [`@kontourai/ferry`](https://www.npmjs.com/package/@kontourai/ferry) to
import transcripts from Claude Code, Codex, OpenCode, or ChatGPT exports into
this format, and to export back out to provider API formats.

License: Apache-2.0
