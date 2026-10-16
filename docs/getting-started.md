# Get started

## Install

Both packages require Node 22 or later and use ESM. Install the packages your
application needs with its existing package manager:

```sh
pnpm add @kontourai/thread @kontourai/ferry
pnpm exec ferry formats
```

For a standalone command, install Ferry globally with your package manager
(for example `pnpm add -g @kontourai/ferry`), then use `ferry`. The examples
below assume its executable is on PATH. Package versions and the canonical
schema version are distinct; see [compatibility](contracts.md#schema-and-serialization).

## Convert a transcript

```sh
ferry inspect rollout.jsonl
ferry convert rollout.jsonl --from codex -o session.thread.json
ferry convert session.thread.json --to anthropic-messages -o messages.json
```

Detection reads content rather than trusting the filename. Pass `--from` when
auto-detection cannot identify a transcript. Commands consume files, not stdin.
Start with a single file, inspect stderr warnings, and compare the converted
content with the source before processing an archive. Provider export can
require caller repairs such as a leading user turn or a missing tool result;
see [formats](formats.md#output-formats).

## Use the libraries

```ts
import { readFileSync } from "node:fs";
import { importThreads, exportThread } from "@kontourai/ferry";
import { threadFromJson, threadToJson } from "@kontourai/thread";

const [thread] = importThreads(readFileSync("rollout.jsonl", "utf8"), "codex", {
  onWarn: (message) => console.error(message),
});
if (!thread) throw new Error("No conversation imported");
const canonical = threadToJson(thread);
const validated = threadFromJson(canonical);
const messages = exportThread(validated, "openai-chat");
```

`importThreads` returns an array because ChatGPT exports can hold multiple
conversations. Direct adapter functions are also exported. Import warnings are
opt-in through `onWarn` for adapters that support them; the CLI supplies a
stderr callback. Keep the original transcript when archival fidelity matters.

## Build this checkout

```sh
pnpm --version                  # packageManager pins 11.25.0
pnpm install --frozen-lockfile
npm run build
node packages/ferry/dist/src/cli.js formats
node packages/ferry/dist/src/cli.js inspect packages/ferry/tests/fixtures/codex-rollout.jsonl
```

The workspace links Ferry's Thread dependency to `packages/thread` so local
builds use this checkout. Build Thread before Ferry; the root recursive build
orders them. The root package is private; the two members publish separately.
Use the [contributor route](contributing.md) for verification and release ownership.
