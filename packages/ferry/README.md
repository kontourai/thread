# @kontourai/ferry

Migrate AI conversations between tools. Importers and exporters for
[`@kontourai/thread`](https://www.npmjs.com/package/@kontourai/thread), plus
the `ferry` CLI.

```sh
ferry inspect ~/.claude/projects/<project>/<session>.jsonl
ferry convert rollout.jsonl -o session.thread.json
ferry convert session.thread.json --to anthropic-messages
ferry formats
```

Input formats: `claude-code`, `codex`, `opencode` (`opencode export` JSON),
`kiro`, `pi`, `muse` (Muse Code `muse export` JSON), `chatgpt-export`,
`thread`. Output formats: `thread`, `openai-chat`,
`anthropic-messages`, `gemini`, `markdown`.

Importers are grounded in real transcript shapes (including multi-hundred-MB
JSONL files, which stream); each adapter documents what its target format
cannot represent.

`ferry rows` emits one JSON object per tool call (or `--csv` for a narrower
projection), streamed per file so it can be pointed at a whole sessions
directory. Each row carries the dimensions the schema keeps in different
places — `source`/`sourceVersion`/`cwd`/`gitBranch` from the thread,
`model`/`provider` from the owning assistant message, the tool's name and raw
`arguments`, `parsedArguments` when the source supplied structure, `derived`
for importer heuristics, and `isError`/`resultChars` joined from the matching
`ToolResult` by `toolCallId`. Result columns are ABSENT for an unpaired call:
a missing result is not a successful one, and `resultChars` counts result
TEXT only, so a result carrying just an image reads as 0.

Unlike `convert`/`usage`, a bad input is warned about and skipped rather than
aborting the run: **exit 0** means every input was read, **2** means the run
completed with inputs skipped, and **1** stays reserved for a fatal error. A
file that simply contains no conversation (a sessions directory holds
non-transcript sidecars) is reported but is not a skip — it is a normal
outcome, not a failure.

There is no `sidechain` column: in current Claude Code versions subagent
traffic lives in separate transcript files rather than inline sidechain
lines, so such a column would be permanently false. It returns when an
importer reads those files.

`--csv` cells are emitted verbatim, including a leading `=`, `+`, `-` or `@`,
which a spreadsheet may interpret as a formula. That is deliberate — escaping
would corrupt every legitimate `-1` and every command starting with a flag —
so prefer `--jsonl` into a query engine for untrusted data.

Codex fixture provenance: `codex-forked-rollout.jsonl` (lines 1-4 = rollout
2026-06-25T23-06-53-019f0252 lines 19-22) and `codex-rollout-variants.jsonl`
(lines 1-4 = rollout 2026-03-27T22-21-41-019d32ad lines 8, 10, 11, 15) are
byte-copied from real local rollouts — only free-text values are replaced
with `[redacted]`; keys, nesting, and every non-text value remain as written
by Codex. `codex-rollout.jsonl` is a composed fixture whose individual usage
records mirror observed shapes. `codex-exec-program.jsonl` is composed, with
each `exec` payload shaped after the dominant real form measured across a
12.2 GB local corpus: a single double-quoted `cmd` string (255,070
occurrences) rather than an array (6 occurrences, none of them JSON-parseable
— which is why array literals are deliberately not recovered), plus the
single-quoted and backtick variants (1,009 / 3,472) and two `apply_patch`
payloads, one of which contains `tools.map(` in its diffed source because
that shape defeated an earlier gate.

License: Apache-2.0
