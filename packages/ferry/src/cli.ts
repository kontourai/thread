#!/usr/bin/env node
/**
 * ferry — migrate AI conversations between tools.
 */

import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, extname } from "node:path";
import { Command } from "commander";
import { getTextContent } from "@kontourai/thread";
import {
  exportThread,
  importThreads,
  INPUT_FORMATS,
  OUTPUT_FORMATS,
  type OutputFormat,
} from "./convert.js";
import { detectFormat, type InputFormat } from "./detect.js";

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

function resolveInputFormat(
  file: string,
  content: string | readonly string[],
  requested: string,
): InputFormat {
  if (requested !== "auto") {
    if (!(INPUT_FORMATS as readonly string[]).includes(requested)) {
      fail(`unknown input format "${requested}" (expected: ${INPUT_FORMATS.join(", ")})`);
    }
    return requested as InputFormat;
  }
  const sample = typeof content === "string" ? content : content.slice(0, 20).join("\n");
  const detected = detectFormat(sample);
  if (!detected) {
    fail(`could not detect the format of ${file}; pass --from <format>`);
  }
  return detected;
}

/**
 * Files beyond Node's max string length (~512MB) can't be read in one go;
 * JSONL inputs stream line-by-line instead (importers accept line arrays).
 */
const STREAM_THRESHOLD = 256 * 1024 * 1024;

async function readInput(file: string): Promise<string | string[]> {
  const path = resolve(file);
  try {
    if (statSync(path).size > STREAM_THRESHOLD) {
      const lines: string[] = [];
      const reader = createInterface({
        input: createReadStream(path, "utf-8"),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of reader) lines.push(line);
      return lines;
    }
    return readFileSync(path, "utf-8");
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** thread-2.json for the second thread of a multi-thread input. */
function numberedPath(output: string, index: number, total: number): string {
  if (total === 1) return output;
  const ext = extname(output);
  const base = ext ? output.slice(0, -ext.length) : output;
  return `${base}-${index + 1}${ext}`;
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
      const content = await readInput(file);
      const from = resolveInputFormat(file, content, options.from);
      let threads;
      try {
        threads = importThreads(content, from, { onWarn: warn, sessionId: sessionIdFrom(file) });
      } catch (error) {
        fail(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    const content = await readInput(input);
    const from = resolveInputFormat(input, content, options.from);
    let threads;
    try {
      threads = importThreads(content, from, { onWarn: warn, sessionId: sessionIdFrom(input) });
    } catch (error) {
      fail(`${input}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  .command("formats")
  .description("List supported input/output formats")
  .action(() => {
    console.log("Input formats (--from):");
    console.log("  claude-code      Claude Code session JSONL (~/.claude/projects/**/*.jsonl)");
    console.log("  codex            Codex rollout JSONL (~/.codex/sessions/**/rollout-*.jsonl)");
    console.log("  opencode         OpenCode `opencode export` JSON");
    console.log("  kiro             Kiro CLI session JSONL (~/.kiro/sessions/cli/*.jsonl)");
    console.log("  pi               pi session JSONL (~/.pi/agent/sessions/**/*.jsonl)");
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
