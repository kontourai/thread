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
`chatgpt-export`, `thread`. Output formats: `thread`, `openai-chat`,
`anthropic-messages`, `gemini`, `markdown`.

Importers are grounded in real transcript shapes (including multi-hundred-MB
JSONL files, which stream); each adapter documents what its target format
cannot represent.

Codex JSONL fixtures are copied from source rollouts retained in the local
corpus.
Only free-text values are replaced with `[redacted]`; keys, nesting, and every
non-text value remain as written by Codex.

License: Apache-2.0
