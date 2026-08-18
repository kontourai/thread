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
