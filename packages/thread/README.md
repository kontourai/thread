# @kontourai/thread

Canonical Zod schema for AI conversations — messages, tool calls and results,
reasoning, attachments, token usage — plus type guards, factories, and
validated JSON serialization.

```ts
import { threadFromJson, getToolCalls, isAssistantMessage } from "@kontourai/thread";

const thread = threadFromJson(json); // validates, throws on schema violations
for (const msg of thread.messages) {
  if (isAssistantMessage(msg)) console.log(getToolCalls(msg));
}
```

Use [`@kontourai/ferry`](https://www.npmjs.com/package/@kontourai/ferry) to
import transcripts from Claude Code, Codex, OpenCode, or ChatGPT exports into
this format, and to export back out to provider API formats.

License: Apache-2.0
