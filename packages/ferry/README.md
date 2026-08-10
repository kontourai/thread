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
records mirror observed shapes.

License: Apache-2.0
