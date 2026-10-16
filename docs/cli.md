# Ferry CLI

The installed command is `ferry`; a built checkout can run
`node packages/ferry/dist/src/cli.js` with the same arguments. Use
`ferry --help`, `ferry <command> --help`, and `ferry --version` to inspect the
installed version. [Setup](getting-started.md) and [formats](formats.md)
describe prerequisites and conversion limits.

## Commands

| Command | Input | Behavior |
| --- | --- | --- |
| `ferry convert <inputs...>` | One or more files | Convert each imported conversation; default output is canonical Thread JSON on stdout. |
| `ferry inspect <input>` | One file | Print detected format, IDs, metadata, dates, message/role/tool-call counts, and a first-user-text preview. |
| `ferry usage <inputs...>` | One or more files | Aggregate assistant-message token usage. |
| `ferry rows <inputs...>` | One or more files | Emit one JSON object per tool call, or a narrower CSV projection. |
| `ferry formats` | None | List supported input and output format names. |

All four file commands accept `-f, --from <format>` (default `auto`). Files
must be named explicitly or expanded by your shell. There is no CLI flag
for including Claude Code sidechains; that option belongs to the adapter API.

## Conversion output

`convert` accepts `-t, --to <format>` (default `thread`) and
`-o, --output <path>`. An output path supports one input file only. A
multi-conversation input produces `name-1.json`, `name-2.json`, and so on;
the suffix is inserted before the extension. The parent directory must exist,
and an existing destination file is overwritten.

Without `--output`, multiple conversations are printed as separate documents,
with labels on stderr. This is not one JSON array or JSONL stream. Use output
files for machine processing of a ChatGPT multi-conversation export.

`thread` emits canonical JSON; `openai-chat` emits a messages array;
`anthropic-messages` emits `{ system?, messages }`; `gemini` emits
`{ systemInstruction?, contents }`. These are conversation payloads, not a
complete configured provider request. Markdown is a one-way readable view.

## Usage and rows

```sh
ferry usage sessions/*.jsonl --by source --json
ferry usage sessions/*.jsonl --by day --window 30d
ferry rows sessions/*.jsonl > calls.jsonl
ferry rows sessions/*.jsonl --window 7d --csv > calls.csv
```

`usage --by` accepts `model` (default), `day` (UTC date), `thread`, or
`source`. `--window <Nd>` includes messages at or after the command's current
time minus N days. `--json` emits sorted usage buckets including missing-usage
and duplicate counts, with reasoning totals and contributing-message counts
when present. The human table exposes fewer fields. Input tokens stay
exclusive of cache reads/writes; reasoning tokens are a subset of output.
Deduplication uses the thread/message tuple across files.

`rows` defaults to JSONL; there is no `--jsonl` flag. It joins results by
`toolCallId` across each thread, emits one row per distinct call ID, and uses
the last result if that ID repeats. Rows retain raw arguments, optional
source-provided `parsedArguments`, and optional importer heuristics in
`derived`. Result columns are absent for unpaired calls. Unknown standing
does not become `isError: false`; `resultChars` counts text characters only.
There is no sidechain column. CSV omits nested argument projections and
emits cells verbatim, including formula-leading characters; prefer JSONL
for untrusted data sent to a query engine.

## Errors and resource limits

`convert`, `inspect`, and `usage` stop on a failed file and exit 1; earlier
outputs may already have been written. Importer warnings alone do not
necessarily make a command fail.

`rows` continues after bad files: exit 0 means no inputs were skipped as
errors; exit 2 means a completed partial run with skipped inputs; exit 1
remains the fatal-error signal. A recognized importer outcome of “no
conversation” is counted and reported but does not count as an error skip.
These exit codes do not certify that every source field was preserved.

Above 256 MiB the CLI reads files line by line into an array, avoiding a
single oversized JavaScript string. The lines and imported Thread still
occupy memory; this is not constant-memory conversion. Single-document JSON
inputs that exceed that path cannot use line-array import and must be split
first. `usage` and `rows` process files in sequence and release each imported
file rather than retaining a whole archive; usage retains buckets and dedup IDs.
