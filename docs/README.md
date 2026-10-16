# Thread

Thread gives AI conversations a common, validated representation. Ferry moves
transcripts into that representation and exports selected views for provider
APIs, archives, and analysis. Use them when each harness's transcript format
would otherwise require a separate parser.

## How it works

1. Ferry detects a supported input's content, or uses an explicit `--from`.
2. An importer maps source records into Thread messages, preserving supported
   content, usage, and source metadata. Warnings disclose skipped records where
   the adapter provides them.
3. Thread's Zod schemas validate canonical JSON at serialization boundaries.
4. Ferry writes canonical JSON, a provider message/body format, Markdown,
   tool-call rows, or a token-usage summary.

The repository contains two ESM packages for Node 22 and later:

| Package | Owns | Start here |
| --- | --- | --- |
| `@kontourai/thread` | Message schemas, validation, factories, usage aggregation, bounded projections and answer references | [Contracts](contracts.md) |
| `@kontourai/ferry` | Transcript adapters, format detection, conversion, analysis, and the `ferry` CLI | [CLI](cli.md) |

Ferry depends on Thread within this product. There is no declared dependency
on a different first-party Kontour product; `builtOn` is therefore empty.
Consumer applications own storage, presentation, authorization, tool execution,
and provider requests. Ferry's API exports are data; callers must handle the
target provider's replay requirements.

## Choose a route

- [Install and convert a transcript](getting-started.md).
- [Look up commands, output shapes, and exit codes](cli.md).
- [Check supported formats and known conversion losses](formats.md).
- [Understand schema versions, result standing, and safe projections](contracts.md).
- [Build, verify, and maintain the docs](contributing.md).
- Read the package guides for [Thread](../packages/thread/README.md) and
  [Ferry](../packages/ferry/README.md).

## Current scope

The checked-in dispatcher supports eight input formats and five output formats,
including canonical Thread JSON in both lists. Compatibility follows observed
writer shapes and retained fixtures; a source tool's new release may need an
adapter update. Conversion can drop branches, opaque reasoning, attachments,
or source-only fields. Read [format-specific limits](formats.md) before using
an export for replay or archival.

Canonical Thread JSON preserves the fields its schema represents. It does not
prove that an imported identifier was owner-issued or that a missing tool
result succeeded. The [identity contracts](contracts.md#identity-and-projections)
keep those claims separate.
