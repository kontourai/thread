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
| `claude-code` | Session JSONL | Skips bookkeeping, `isMeta`, and inline sidechains by default; imports a subagent transcript file as its own agent thread. Merges split assistant records by API message ID, which can change strict event order. Skips the large `toolUseResult` sidecar. Derives user-message `origin`. |
| `codex` | Rollout JSONL (`response_item`, `event_msg`, metadata) | Folds assistant items per turn; skips tool-search items and encrypted reasoning. Adjacent mirrored assistant text is deduplicated. Tool output has unknown terminal standing. `developer` items become `system` messages; inter-agent `agent_message` items become agent-authored `user` messages. Derives `origin`. |
| `opencode` | `opencode export` JSON with `info` and message `parts` | Splits embedded tool parts into calls/results; skips structural markers. Only observed `completed` tool status maps to success. |
| `kiro` | CLI JSONL (`Prompt`, `AssistantMessage`, `ToolResults`) | Skips compaction snapshots. Reads no session sidecar; callers supply session ID (the CLI uses the filename stem). Assistant/tool times inherit the preceding prompt. |
| `pi` | Session JSONL (`session`, `message`) | Uses append order rather than rewalking parent links. Settings records are skipped; non-text tool results become placeholders. |
| `muse` | `muse export` JSON with sessions/events/envelopes | Groups assistant content by response ID. Skips duplicate scheduler/task lifecycle, tool-batch effects, diagnostics, and opaque encrypted reasoning. |
| `chatgpt-export` | `conversations.json`, array or single conversation | Follows `current_node` to the root; drops alternative branches and reports their importable-message count. Skips tool/plugin messages, hidden messages, empty system placeholders, and image asset pointers. |
| `thread` | Canonical Thread JSON | Parses and validates the schema; canonical message IDs alone do not supply observed answer-reference standing. |

Malformed/skipped JSONL records are reported through supported adapters'
`onWarn` callbacks. The CLI sends these warnings to stderr. Detection inspects
content and a bounded JSONL prefix; pass `--from` for unidentified inputs.

### Large files and counted losses

`importThreadsFromFile(path, format, options)` is the file-level bulk path.
At or below `streamThresholdBytes` (default 64 MiB) it reads the file and
calls `importThreadsWithIdentityObservations`. Above it, no whole-file
string is built for a JSONL format: Claude Code and Codex stream through
their incremental importers in batches, and Kiro, Pi, and observed tool
events are read as a line array. A single-document JSON format is read whole
only below V8's string limit; past it, `FerryInputTooLargeError` is thrown
before reading. The result reports `read: "whole" | "streamed"` and the
resolved `format`.

`readJsonlLines` splits only on `\n`. Node's `readline` also breaks lines at
U+2028 and U+2029, which JSON allows inside strings, and so cut real Codex
records in two; that was the source of "unparseable" lines seen when tailing
very large rollouts.

Claude Code and Codex report lines they cannot import as typed, counted
losses: `{ format, kind: "unparseable-line" | "unrecognized-record", count }`.
They arrive in `ImportResult.losses`, an adapter's `onLosses` callback, an
incremental importer's `losses()`, and the thread's
`metadata.custom.ferryImportLosses`. Other adapters still report skips only
through `onWarn`.

### Claude Code subagent transcripts

When a file's first conversation record is a sidechain record with an
`agentId`, the file is a subagent transcript and its records are imported
without `includeSidechains`. Those records carry the parent's `sessionId`,
so the thread id is `<sessionId>:agent-<agentId>` and
`metadata.custom.claudeSubagent` holds `{ agentId, parentSessionId }`. The
composed thread id makes message identities adapter-fallback. Sidechain
messages carry `metadata.agentId`, and their user turns have origin `agent`.
The sibling `agent-<id>.meta.json` (agent type, spawning tool call) is not
read.

### Incremental JSONL import

Claude Code and Codex also export `create*Importer` and `restore*Importer`
APIs with `pushLines`, `finalize`, `state`, and `thread`. Hosts supply complete
lines and own files, byte offsets, tailing, and rotation. Announcements are
append-only, but a later split source record can amend a prior assistant;
`thread()` is the authoritative snapshot. Finalize at EOF/rotation/close.
These APIs do not turn the CLI's line-array path into a file watcher.

### Observed tool-event JSONL (programmatic API)

Read an observation log into an ordered list of tool starts and completions.
These JSONL files are written by the observe hook; they are not conversation
messages. In code, call `importObservations(content, { sourceId })` from
`@kontourai/ferry`. `detectFormat` identifies the source as
`observed-tool-events`; the CLI cannot convert it.

Each `ObservedToolEvent` preserves its source line, timestamp, session,
project, tool, and the input or output string the hook wrote. The hook may
already have truncated or scrubbed that string. Missing input and event pairs
cannot be reconstructed.

Save the returned cursor with your downstream effects, or deduplicate effects
by event ID. On the next run, pass the entire file and that cursor to receive
only new lines. A string's unfinished final line is reported in `partial` and
left for the next run. Line-array callers must supply complete lines without terminators; a final
empty array entry is ignored. The
whole prefix is checked on each replay, so edits and truncation are refused.
When a file rotates, finish its archived copy with the old source ID and cursor
before importing the new file with a new, unique source ID. If the archived file ends without a newline, verify its final record is
complete, then pass the whole archived file as a line array, including that
record.

`malformed` counts unreadable complete lines, including `parse_error` records.
The default limit is 100 per run; set `maxMalformed` to a nonnegative integer
to change it. Above the limit, the call throws and returns nothing; raise the limit to accept
the counted omissions. Errors contain no source content. Input and output may
be sensitive; callers must protect them.

## Message origin

Claude Code and Codex derive [`origin`](contracts.md#message-origin) on user
and system messages from source signals only. Other importers leave it
absent.

Claude Code checks, in order: `isCompactSummary` (compaction); the record's
own `origin.kind` (`human`, `task-notification`, `peer` and `coordinator` as
agent, `auto-continuation` as harness); text that is entirely harness wrapper
blocks (`<system-reminder>`, `<local-command-stdout>`, `<task-notification>`,
`[Request interrupted by user]`, and similar); `promptSource` of `typed`,
`queued`, or `suggestion_accepted` (human); and `isSidechain` (agent, since a
subagent's user is its parent). Anything else is `unknown`, including
SDK-submitted prompts, because an SDK client can relay a person or an
orchestrator. `turnOrigin` is not used: it describes the whole turn, and
records inside a human turn, such as local command output, inherit it.
Slash-command wrappers (`<command-name>`, `<bash-input>`) report an envelope
but no author. `isMeta` records stay skipped.

Codex maps `developer` and `system` items to `system` messages with origin
`harness` (or `hook` when the item's provenance says so). For a user item, the
rollout's `internal_chat_message_metadata_passthrough` provenance decides
first: harness, AGENTS.md, tool, and skills provenance mean `harness` (`hook`
when flagged, `task-notification` for subagent notifications). Without
provenance, text that is entirely wrapper blocks (`<environment_context>`,
the AGENTS.md heading with `<INSTRUCTIONS>`, `<subagent_notification>`, and
similar) decides. What remains came through the user-input path, so the
session's `session_meta.source` decides: `subagent` is `agent`, the
interactive `cli` is `human`, and other clients (`vscode`, `exec`, app-server)
are `unknown`. In a forked subagent rollout, records before
`subagent_history_start_ordinal` are the parent's history and use the
parent's source. Codex has no compaction-summary user record, so it never
emits `compaction`.

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

