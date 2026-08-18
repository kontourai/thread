# thread

Portable AI conversation layer: a canonical schema for agent conversations and
a migration CLI that moves transcripts between tools.

| Package | What it is |
| --- | --- |
| [`@kontourai/thread`](packages/thread) | Canonical Zod schema for AI conversations — messages, tool calls and results, reasoning, attachments, token usage. |
| [`@kontourai/ferry`](packages/ferry) | Importers/exporters plus the `ferry` CLI: convert transcripts from Claude Code, Codex, OpenCode, and ChatGPT exports into the canonical format, or out to API/message formats. |

## Why

Every agent tool writes conversations in its own shape, and none of them can
read each other's. `@kontourai/thread` defines one validated, serializable
representation; `@kontourai/ferry` does the translation — so switching tools,
archiving sessions, or replaying a conversation against a provider API stops
being a bespoke parsing project.

## Quick start

```sh
# Inspect any supported transcript (format auto-detected)
ferry inspect ~/.claude/projects/<project>/<session>.jsonl

# Convert a Codex rollout to canonical thread JSON
ferry convert ~/.codex/sessions/2026/08/01/rollout-*.jsonl -o session.thread.json

# One row per tool call, across a whole corpus, straight into a query engine
ferry rows ~/.claude/projects/**/*.jsonl ~/.codex/sessions/**/*.jsonl > calls.jsonl
duckdb -c "SELECT source, tool, count(*) FROM 'calls.jsonl' GROUP BY 1,2 ORDER BY 3 DESC"

# Token usage grouped by harness
ferry usage ~/.codex/sessions/**/*.jsonl --by source --json

# Re-export a thread as an Anthropic Messages API body
ferry convert session.thread.json --to anthropic-messages

# Everything supported
ferry formats
```

Programmatic use:

```ts
import { importFromClaudeCode, exportToAnthropicMessages } from "@kontourai/ferry";
import { threadToJson } from "@kontourai/thread";

const thread = importFromClaudeCode(jsonl);
const body = exportToAnthropicMessages(thread);
```

## Formats

Input: `claude-code` (session JSONL), `codex` (rollout JSONL), `opencode`
(`opencode export` JSON), `kiro` (CLI session JSONL), `pi` (session JSONL),
`muse` (Muse Code `muse export` JSON), `chatgpt-export` (`conversations.json`),
`thread`.

Output: `thread` (canonical JSON), `openai-chat`, `anthropic-messages`,
`gemini`, `markdown`.

Each adapter documents its fidelity limits (what a format cannot represent) in
its source header, and importers report skipped/unparseable records through a
warning callback (surfaced on stderr by the CLI) instead of losing them
silently.

## Development

```sh
npm install
npm run verify   # build + typecheck + test in both packages
```

Importers are tested against fixtures that mirror the exact shapes the source
tools write (field casing, split assistant events, sidechains, noise records),
and conversions of multi-hundred-MB real transcripts are supported by
streaming JSONL input.

## License

Apache-2.0
