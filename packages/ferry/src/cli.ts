#!/usr/bin/env node
/**
 * ferry — migrate AI conversations between tools.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { Command } from "commander";
import {
  createUsageAccumulator,
  getTextContent,
  type UsageAggregationDimension,
  type UsageBucket,
} from "@kontourai/thread";
import {
  exportThread,
  INPUT_FORMATS,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "./convert.js";
import type { InputFormat } from "./detect.js";
import { FerryFormatDetectionError, importThreadsFromFile, type ImportFileResult } from "./read.js";
import {
  csvHeader,
  formatRowCsv,
  formatRowJsonl,
  isNoImportableContentError,
  toolCallRows,
} from "./rows.js";

const program = new Command();

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version: string };

program
  .name("ferry")
  .description("Migrate AI conversations between tools (@kontourai/thread)")
  .version(packageJson.version);

function fail(message: string): never {
  console.error(`ferry: ${message}`);
  process.exit(1);
}

function warn(message: string): void {
  console.error(`ferry: warning: ${message}`);
}

/** Filename stem, for formats whose transcript carries no session id (kiro). */
function sessionIdFrom(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return base.replace(/\.[^.]+$/, "");
}

/** A CLI failure whose message is already phrased for the user. */
class CliInputError extends Error {}

/**
 * Imports one input file, THROWING on failure, so `rows` (which must survive
 * a bad file) can catch it while the other verbs exit through `fail`.
 *
 * Reading goes through `importThreadsFromFile`: large JSONL inputs stream
 * line by line (split on `\n` only) instead of becoming one string, which
 * V8 cannot hold past ~512 Mi characters.
 */
async function importFile(file: string, requested: string): Promise<ImportFileResult> {
  if (requested !== "auto" && !(INPUT_FORMATS as readonly string[]).includes(requested)) {
    throw new CliInputError(`unknown input format "${requested}" (expected: ${INPUT_FORMATS.join(", ")})`);
  }
  const format = requested as InputFormat | "auto";
  try {
    return await importThreadsFromFile(resolve(file), format, {
      onWarn: warn,
      sessionId: sessionIdFrom(file),
    });
  } catch (error) {
    if (error instanceof FerryFormatDetectionError) {
      throw new CliInputError(`could not detect the format of ${file}; pass --from <format>`);
    }
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) throw new CliInputError(`cannot read ${file}: ${message}`);
    throw new CliInputError(`${file}: ${message}`, { cause: error });
  }
}

/** `importFile` for verbs where any failure ends the run. */
async function importFileOrFail(file: string, requested: string): Promise<ImportFileResult> {
  try {
    return await importFile(file, requested);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** thread-2.json for the second thread of a multi-thread input. */
function numberedPath(output: string, index: number, total: number): string {
  if (total === 1) return output;
  const ext = extname(output);
  const base = ext ? output.slice(0, -ext.length) : output;
  return `${base}-${index + 1}${ext}`;
}

function parseWindow(window: string | undefined, clock: () => number): number | undefined {
  if (window === undefined) return undefined;
  const match = /^(\d+)d$/.exec(window);
  if (!match) fail(`invalid --window "${window}" (expected <Nd>, for example 30d)`);
  return clock() - Number(match[1]) * 24 * 60 * 60 * 1000;
}

function formatUsageTable(buckets: readonly UsageBucket[]): string {
  const includeReasoning = buckets.some((bucket) => bucket.reasoningTokens !== undefined);
  const headers = [
    "key",
    "messages",
    "noUsage",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    ...(includeReasoning ? ["reasoningTokens"] : []),
  ];
  const rows = buckets.map((bucket) => [
    bucket.key,
    String(bucket.messages),
    String(bucket.messagesWithoutUsage),
    String(bucket.inputTokens),
    String(bucket.outputTokens),
    String(bucket.cacheReadTokens),
    String(bucket.cacheWriteTokens),
    ...(includeReasoning ? [bucket.reasoningTokens === undefined ? "" : String(bucket.reasoningTokens)] : []),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [formatRow(headers), formatRow(widths.map((width) => "-".repeat(width))), ...rows.map(formatRow)].join(
    "\n",
  );
}

program
  .command("convert")
  .description("Convert conversation files to another format")
  .argument("<inputs...>", "input file(s)")
  .option("-f, --from <format>", `input format (auto, ${INPUT_FORMATS.join(", ")})`, "auto")
  .option("-t, --to <format>", `output format (${OUTPUT_FORMATS.join(", ")})`, "thread")
  .option("-o, --output <path>", "output file (default: stdout; multi-thread inputs get -N suffixes)")
  .action(async (inputs: string[], options: { from: string; to: string; output?: string }) => {
    if (!(OUTPUT_FORMATS as readonly string[]).includes(options.to)) {
      fail(`unknown output format "${options.to}" (expected: ${OUTPUT_FORMATS.join(", ")})`);
    }
    const to = options.to as OutputFormat;
    if (options.output !== undefined && inputs.length > 1) {
      fail("--output supports a single input file; convert files one at a time");
    }

    for (const file of inputs) {
      const { threads } = await importFileOrFail(file, options.from);
      if (threads.length === 0) {
        fail(`${file}: no conversations found`);
      }

      threads.forEach((thread, index) => {
        const output = exportThread(thread, to);
        if (options.output !== undefined) {
          const path = numberedPath(options.output, index, threads.length);
          writeFileSync(path, output.endsWith("\n") ? output : `${output}\n`);
          console.error(`wrote ${path}`);
        } else {
          if (inputs.length > 1 || threads.length > 1) {
            console.error(`=== ${file}${threads.length > 1 ? ` [${index + 1}]` : ""} ===`);
          }
          console.log(output);
        }
      });
    }
  });

program
  .command("inspect")
  .description("Summarize a conversation file without converting it")
  .argument("<input>", "input file")
  .option("-f, --from <format>", `input format (auto, ${INPUT_FORMATS.join(", ")})`, "auto")
  .action(async (input: string, options: { from: string }) => {
    const { threads, format: from } = await importFileOrFail(input, options.from);
    if (threads.length === 0) fail(`${input}: no conversations found`);

    threads.forEach((thread, index) => {
      if (threads.length > 1) console.log(`=== conversation ${index + 1} ===`);
      console.log(`format:    ${from}`);
      console.log(`threadId:  ${thread.id}`);
      if (thread.metadata?.title) console.log(`title:     ${thread.metadata.title}`);
      if (thread.metadata?.cwd) console.log(`cwd:       ${thread.metadata.cwd}`);
      if (thread.metadata?.sourceVersion) {
        console.log(`version:   ${thread.metadata.sourceVersion}`);
      }
      console.log(`created:   ${new Date(thread.createdAt).toISOString()}`);
      console.log(`updated:   ${new Date(thread.updatedAt).toISOString()}`);
      console.log(`messages:  ${thread.messages.length}`);

      const byRole = new Map<string, number>();
      let toolCalls = 0;
      for (const msg of thread.messages) {
        byRole.set(msg.role, (byRole.get(msg.role) ?? 0) + 1);
        if (msg.role === "assistant") {
          toolCalls += msg.content.filter((c) => c.type === "tool_call").length;
        }
      }
      console.log(
        `by role:   ${[...byRole.entries()].map(([role, count]) => `${role}=${count}`).join(" ")}`,
      );
      console.log(`toolCalls: ${toolCalls}`);

      const firstUser = thread.messages.find((m) => m.role === "user");
      if (firstUser) {
        const preview = getTextContent(firstUser).replaceAll("\n", " ").slice(0, 100);
        if (preview) console.log(`first msg: ${preview}`);
      }
    });
  });

program
  .command("usage")
  .description("Aggregate assistant token usage from conversation files")
  .argument("<inputs...>", "input file(s)")
  .option("-f, --from <format>", `input format (auto, ${INPUT_FORMATS.join(", ")})`, "auto")
  .option("--by <dimension>", "group by model, day, thread, or source", "model")
  .option("--window <Nd>", "include messages from the last N days")
  .option("--json", "print machine-readable JSON")
  .action(
    async (
      inputs: string[],
      options: { from: string; by: string; window?: string; json?: boolean },
    ) => {
      if (
        !(["model", "day", "thread", "source"] as const).includes(
          options.by as UsageAggregationDimension,
        )
      ) {
        fail('invalid --by value (expected "model", "day", "thread", or "source")');
      }
      // Read the clock exactly once at the CLI boundary; aggregation remains pure.
      const now = Date.now();
      const since = parseWindow(options.window, () => now);
      // Fold per file and release: collecting every Thread first made this
      // verb impossible on a real archive, where the inputs it documents
      // (a glob over a sessions directory) are thousands of files and tens of
      // gigabytes. The accumulator keeps only buckets plus message ids, so
      // cross-file dedup is preserved.
      const accumulator = createUsageAccumulator({
        by: options.by as UsageAggregationDimension,
        since,
      });
      for (const file of inputs) {
        for (const thread of (await importFileOrFail(file, options.from)).threads) {
          accumulator.add(thread);
        }
      }
      const buckets = accumulator.result();
      console.log(options.json ? JSON.stringify(buckets, null, 2) : formatUsageTable(buckets));
    },
  );

program
  .command("rows")
  .description("Emit one row per tool call (JSONL or CSV) for ad-hoc analysis")
  .argument("<inputs...>", "input file(s)")
  .option("-f, --from <format>", `input format (auto, ${INPUT_FORMATS.join(", ")})`, "auto")
  .option("--csv", "emit CSV instead of JSONL (a narrower projection)")
  .option("--window <Nd>", "only calls from the last N days")
  .action(async (inputs: string[], options: { from: string; csv?: boolean; window?: string }) => {
    const since = parseWindow(options.window, () => Date.now());
    // Written a ROW at a time: nothing larger than one record is materialized,
    // so the claim in the README holds for a session of any size.
    if (options.csv) console.log(csvHeader());
    // Unlike `convert`/`usage`, a bad file does NOT abort the run. This verb
    // is pointed at whole session directories, where one unreadable or
    // foreign file among thousands is ordinary — losing the other 6,899
    // sessions to it would be absurd. Every failure is named on stderr and
    // the exit code still reports that something was skipped, so a script
    // can tell a partial run from a complete one.
    let skipped = 0;
    let notConversations = 0;
    for (const file of inputs) {
      try {
        for (const thread of (await importFile(file, options.from)).threads) {
          for (const row of toolCallRows(thread)) {
            if (since !== undefined && row.timestamp < since) continue;
            console.log(options.csv ? formatRowCsv(row) : formatRowJsonl(row));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // "Nothing importable here" is a deliberate importer outcome, not a
        // failure: a sessions directory legitimately contains files that are
        // not transcripts at all (Claude Code writes bridge sidecars keyed
        // bridgeSessionId/lastSequenceNum; a Codex rollout can hold only a
        // session_meta). Counting those as skips made the README's own
        // advertised invocation exit non-zero every time on a real corpus —
        // 1,652 of 1,802 files here — which trains the reader to ignore the
        // signal. Every adapter's phrasing is covered and enumerated by test.
        if (isNoImportableContentError(error)) {
          notConversations += 1;
          continue;
        }
        skipped += 1;
        // importFile already names the file in its own messages.
        warn(message.includes(file) ? message : `${file}: ${message}`);
      }
    }
    if (notConversations > 0) {
      warn(`${notConversations} input(s) contained no conversation to read`);
    }
    if (skipped > 0) {
      // 2, not 1: a partial run and a total failure must not be the same
      // signal. `fail` still exits 1 for a fatal error.
      warn(`${skipped} input(s) skipped`);
      process.exitCode = 2;
    }
  });

program
  .command("formats")
  .description("List supported input/output formats")
  .action(() => {
    console.log("Input formats (--from):");
    console.log("  claude-code      Claude Code session JSONL (~/.claude/projects/**/*.jsonl)");
    console.log("  codex            Codex rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl)");
    console.log("  opencode         OpenCode `opencode export` JSON");
    console.log("  kiro             Kiro CLI session JSONL (~/.kiro/sessions/cli/*.jsonl)");
    console.log("  pi               pi session JSONL (~/.pi/agent/sessions/**/*.jsonl)");
    console.log("  muse             Muse Code `muse export` session JSON");
    console.log("  chatgpt-export   ChatGPT data export (conversations.json)");
    console.log("  thread           @kontourai/thread canonical JSON");
    console.log("");
    console.log("Output formats (--to):");
    console.log("  thread              @kontourai/thread canonical JSON (default)");
    console.log("  openai-chat         OpenAI Chat Completions messages");
    console.log("  anthropic-messages  Anthropic Messages API body");
    console.log("  gemini              Google Gemini API body");
    console.log("  markdown            Human-readable Markdown");
  });

await program.parseAsync();
