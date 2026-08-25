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
