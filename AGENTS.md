# thread — agent instructions

Two npm-workspace packages: `packages/thread` (canonical conversation schema,
Zod) and `packages/ferry` (importers/exporters + `ferry` CLI). ESM-only,
Node >= 22, plain `tsc` builds, Vitest tests.

## Commands

```sh
npm install
npm run verify        # build + typecheck + test, both packages
npm run test -w packages/ferry   # one package
```

## Rules that exist because of real incidents

- **Importers are written from observed transcripts, never from imagination.**
  Every importer's zod schema mirrors byte-real source shapes (camelCase
  Claude Code envelopes, Codex `payload` nesting, OpenCode `info`/`parts`).
  If you change an importer, re-verify against a real transcript from the
  actual tool, not just the fixtures. The first draft of this codebase parsed
  invented formats and silently dropped nearly every message.
- **Fixtures mirror real writer output exactly** — same key casing, same
  nesting, including noise records, split assistant events, sidechain and
  `isMeta` lines. Don't "clean up" fixtures; the mess is the point.
- **Fidelity losses are declared** in each adapter's header comment and must
  stay accurate. An exporter that drops reasoning says so.
- **Large-file path**: JSONL importers accept `string | readonly string[]`
  because real rollouts exceed Node's max string length. Don't regress the
  streaming path in the CLI.
- Schema changes are breaking for every adapter: update
  `THREAD_SCHEMA_VERSION` per semver and check each importer/exporter.

## Publishing

release-please manages versions/changelogs per package; publishes go through
the repo's CI on release PRs. Do not hand-edit versions or publish locally.
