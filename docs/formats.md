# Formats and fidelity

Ferry translates observed transcript shapes. Its [dispatcher](../packages/ferry/src/convert.ts)
defines eight inputs and five outputs, counting canonical `thread` in both.
Adapters are directional: provider API output is not a supported input format.
No adapter promises compatibility with every version of a source tool.
Headers in the [adapter sources](../packages/ferry/src/adapters/index.ts)
describe the source fields and the retained fixture evidence.

## Input formats

| `--from` | Source | Important limits |
| --- | --- | --- |
| `claude-code` | Session JSONL | Skips bookkeeping, `isMeta`, and sidechains by default. Merges split assistant records by API message ID, which can change strict event order. Skips the large `toolUseResult` sidecar. |
| `codex` | Rollout JSONL (`response_item`, `event_msg`, metadata) | Folds assistant items per turn; skips tool-search items and encrypted reasoning. Adjacent mirrored assistant text is deduplicated. Tool output has unknown terminal standing. |
| `opencode` | `opencode export` JSON with `info` and message `parts` | Splits embedded tool parts into calls/results; skips structural markers. Only observed `completed` tool status maps to success. |
| `kiro` | CLI JSONL (`Prompt`, `AssistantMessage`, `ToolResults`) | Skips compaction snapshots. Reads no session sidecar; callers supply session ID (the CLI uses the filename stem). Assistant/tool times inherit the preceding prompt. |
| `pi` | Session JSONL (`session`, `message`) | Uses append order rather than rewalking parent links. Settings records are skipped; non-text tool results become placeholders. |
| `muse` | `muse export` JSON with sessions/events/envelopes | Groups assistant content by response ID. Skips duplicate scheduler/task lifecycle, tool-batch effects, diagnostics, and opaque encrypted reasoning. |
| `chatgpt-export` | `conversations.json`, array or single conversation | Follows `current_node` to the root; drops alternative branches and reports their importable-message count. Skips tool/plugin messages, hidden messages, empty system placeholders, and image asset pointers. |
| `thread` | Canonical Thread JSON | Parses and validates the schema; canonical message IDs alone do not supply observed answer-reference standing. |

Malformed/skipped JSONL records are reported through supported adapters'
`onWarn` callbacks. The CLI sends these warnings to stderr. Detection inspects
content and a bounded JSONL prefix; pass `--from` for unidentified inputs.

### Incremental JSONL import

Claude Code and Codex also export `create*Importer` and `restore*Importer`
APIs with `pushLines`, `finalize`, `state`, and `thread`. Hosts supply complete
lines and own files, byte offsets, tailing, and rotation. Announcements are
append-only, but a later split source record can amend a prior assistant;
`thread()` is the authoritative snapshot. Finalize at EOF/rotation/close.
These APIs do not turn the CLI's line-array path into a file watcher.

## Identity and usage losses

Ferry assigns deterministic namespaced tool-result IDs only from source record
anchors and result indexes. It never uses a call ID, timestamp, output text,
or JSON-looking prose to invent result identity or status.

Claude Code's observed false/absent error marker, OpenCode's `completed`,
Kiro's explicit `success`, and Pi's explicit `isError: false` can map to success.
The retained fixtures do not establish failed-result contracts for those
four adapters; their other/error markers remain unknown. Codex outputs and
Muse result batches have no mapped terminal standing, so identified results
remain unknown. ChatGPT has no retained safe tool-result mapping.

Codex and Muse normalize inclusive input-token counts by subtracting cache
reads; cache-write subtraction follows the same convention but remains an
assumption pending nonzero observations in the cited source evidence. Raw
usage objects remain in adapter metadata. Codex usage attribution follows
token-count windows; counts with no matching assistant remain in thread-level
unattributed usage, outside ordinary assistant-message aggregation.

Codex `exec`/`js_repl` arguments are program text. Best-effort command extraction
lives in `derived.codexExec`, tagged as heuristic, rather than in replayable
`parsedArguments`. Variable-built commands and unresolved templates are not
guessed; the extraction caps at 32 commands and marks truncation.

## Output formats

| `--to` | Output | Losses and replay requirements |
| --- | --- | --- |
| `thread` | Canonical validated JSON | Preserves represented fields; does not reconstruct anything an importer dropped. |
| `openai-chat` | Chat Completions messages array | Drops reasoning, usage/model/timestamps, and result identity/status/authority/correlations. Files, assistant images, and non-text tool results become placeholders. Caller must supply missing trailing tool results before replay. |
| `anthropic-messages` | Optional system string plus messages | Preserves signed/redacted thinking; drops unsigned reasoning. Files become placeholders. Merges same-role messages and omits empty text. Caller must handle assistant-first input or a missing tool result. Result identity/authority/correlations are lost; error, cancelled, and unknown map to `is_error: true`. |
| `gemini` | Optional system instruction plus contents | Drops reasoning, tool-call IDs, and tool-result identity/status/authority/correlations. Pairing is by function name; files become placeholders. |
| `markdown` | Human-readable Markdown | One-way; no importer. Includes reasoning/tool calls by default, represents media as placeholders, and truncates each tool result to 2,000 characters by default. Library options can change presentation. |

Provider bodies still need model/configuration and caller validation against
the current provider API. Converted content can contain private paths, raw
arguments, reasoning, and transcript text. Applications own access control,
retention, and rendering; use the [bounded projections](contracts.md#identity-and-projections)
when exposing only one result or assistant answer.
