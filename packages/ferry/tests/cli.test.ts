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
