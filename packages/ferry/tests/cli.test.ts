import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "src", "cli.js");
const fixturesDir = join(here, "fixtures");
const outDir = mkdtempSync(join(tmpdir(), "ferry-cli-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function run(args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: "utf-8" });
}

describe("ferry CLI (built binary)", () => {
  it("lists formats", () => {
    const out = run(["formats"]);
    expect(out).toContain("claude-code");
    expect(out).toContain("anthropic-messages");
  });

  it("auto-detects and inspects a claude-code transcript", () => {
    const out = run(["inspect", join(fixturesDir, "claude-code-session.jsonl")]);
    expect(out).toContain("format:    claude-code");
    expect(out).toContain("messages:  7");
    expect(out).toContain("toolCalls: 1");
  });

  it("aggregates usage from real Claude Code and Codex transcripts in a table", () => {
    const out = run([
      "usage",
      join(fixturesDir, "claude-code-session.jsonl"),
      join(fixturesDir, "codex-rollout.jsonl"),
    ]);
    expect(out).toBe(
      "key              messages  noUsage  inputTokens  outputTokens  cacheReadTokens  cacheWriteTokens  reasoningTokens\n" +
        "---------------  --------  -------  -----------  ------------  ---------------  ----------------  ---------------\n" +
        "claude-sonnet-5  5         0        1280         187           200              36\n" +
        "gpt-5.4-codex    1         1        4918         249           0                0                 0\n" +
        "gpt-5.5          1         0        20706        217           9600             0                 20\n",
    );
  });

  // Review T-1c: garbage --window fails loudly with a non-zero exit.
  it("rejects a malformed --window loudly", () => {
    expect(() =>
      run(["usage", join(fixturesDir, "claude-code-session.jsonl"), "--window", "30x"]),
    ).toThrowError(/invalid --window/);
  });

  // Review T-1d: the table and --json agree on the same corpus — same bucket
  // keys in the same order, same core counts rendered.
  it("keeps table and JSON output semantically consistent", () => {
    const files = [join(fixturesDir, "claude-code-session.jsonl")];
    const table = run(["usage", ...files]);
    const buckets = JSON.parse(run(["usage", ...files, "--json"])) as Array<{
      key: string;
      messages: number;
      inputTokens: number;
      outputTokens: number;
    }>;
    const rows = table.trim().split("\n").slice(2);
    expect(rows.length).toBe(buckets.length);
    rows.forEach((row, index) => {
      const cells = row.trim().split(/\s+/);
      const bucket = buckets[index]!;
      expect(cells[0]).toBe(bucket.key);
      expect(Number(cells[1])).toBe(bucket.messages);
      expect(Number(cells[3])).toBe(bucket.inputTokens);
      expect(Number(cells[4])).toBe(bucket.outputTokens);
    });
  });

  it("prints usage buckets as JSON without losing coverage counts", () => {
    const out = run([
      "usage",
      join(fixturesDir, "claude-code-session.jsonl"),
      join(fixturesDir, "codex-rollout.jsonl"),
      "--json",
    ]);
    expect(JSON.parse(out)).toEqual([
      {
        key: "claude-sonnet-5",
        messages: 5,
        messagesWithoutUsage: 0,
        duplicatesSkipped: 0,
        inputTokens: 1280,
        outputTokens: 187,
        cacheReadTokens: 200,
        cacheWriteTokens: 36,
      },
      {
        key: "gpt-5.4-codex",
        messages: 1,
        messagesWithoutUsage: 1,
        duplicatesSkipped: 0,
        inputTokens: 4918,
        outputTokens: 249,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        reasoningMessages: 1,
      },
      {
        key: "gpt-5.5",
        messages: 1,
        messagesWithoutUsage: 0,
        duplicatesSkipped: 0,
        inputTokens: 20706,
        outputTokens: 217,
        cacheReadTokens: 9600,
        cacheWriteTokens: 0,
        reasoningTokens: 20,
        reasoningMessages: 1,
      },
    ]);
  });

  it("converts codex → thread JSON on stdout", () => {
    const out = run([
      "convert",
      join(fixturesDir, "codex-rollout.jsonl"),
      "--to",
      "thread",
    ]);
    const thread = JSON.parse(out);
    expect(thread.schemaVersion).toBe("1.0.0");
    expect(thread.metadata.source).toBe("codex");
  });

  it("writes numbered outputs for multi-thread chatgpt exports", () => {
    const target = join(outDir, "out.json");
    run([
      "convert",
      join(fixturesDir, "chatgpt-conversations.json"),
      "--to",
      "thread",
      "--output",
      target,
    ]);
    const first = JSON.parse(readFileSync(join(outDir, "out-1.json"), "utf-8"));
    const second = JSON.parse(readFileSync(join(outDir, "out-2.json"), "utf-8"));
    expect(first.metadata.source).toBe("chatgpt-export");
    expect(second.id).toBe("conv-0002");
  });

  it("converts opencode → anthropic-messages", () => {
    const out = run([
      "convert",
      join(fixturesDir, "opencode-export.json"),
      "--to",
      "anthropic-messages",
    ]);
    const body = JSON.parse(out);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(JSON.stringify(body)).toContain("tool_result");
  });

  it("reports the package version, not a hardcoded string", () => {
    const packageJson = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf-8"),
    ) as { version: string };
    expect(run(["--version"]).trim()).toBe(packageJson.version);
  });

  it("auto-detects claude-code files prefixed by many summary lines", () => {
    const prefixed = join(outDir, "summary-prefixed.jsonl");
    const summaries = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ type: "summary", summary: `s${i}`, leafUuid: `l${i}` }),
    );
    const original = readFileSync(join(fixturesDir, "claude-code-session.jsonl"), "utf-8");
    writeFileSync(prefixed, `${summaries.join("\n")}\n${original}`);
    const out = run(["inspect", prefixed]);
    expect(out).toContain("format:    claude-code");
  });

  it("fails cleanly on undetectable input", () => {
    expect(() =>
      execFileSync(process.execPath, [cli, "inspect", join(fixturesDir, "..", "cli.test.ts")], {
        encoding: "utf-8",
        stdio: "pipe",
      }),
    ).toThrow(/could not detect/);
  });
});
