/**
 * The file-level bulk path, counted losses, and Claude Code subagent
 * transcripts. Large inputs are generated at runtime; nothing large is
 * committed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Thread } from "@kontourai/thread";
import {
  createClaudeCodeImporter,
  DEFAULT_STREAM_THRESHOLD_BYTES,
  FerryInputTooLargeError,
  importFromClaudeCode,
  restoreClaudeCodeImporter,
  importThreadsFromFile,
  importThreadsWithIdentityObservations,
  readJsonlLines,
} from "../src/index.js";
import { splitJsonlChunks } from "../src/read.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf-8");
const cli = join(here, "..", "dist", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "ferry-large-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const collect = async (path: string): Promise<string[]> => {
  const lines: string[] = [];
  for await (const line of readJsonlLines(path)) lines.push(line);
  return lines;
};

/**
 * A Codex rollout of `turns` user/assistant turns. Every text carries raw
 * U+2028 and U+2029, which JSON allows inside strings and which Node's
 * readline treats as line breaks.
 */
function codexRollout(turns: number, padding = 0): string {
  const lines = [JSON.stringify({
    timestamp: "2026-08-01T12:00:00.000Z", type: "session_meta",
    payload: { id: "generated-session", cwd: "/w", source: "cli", cli_version: "0.21.0" },
  })];
  const pad = "x".repeat(padding);
  for (let turn = 0; turn < turns; turn += 1) {
    const at = new Date(Date.UTC(2026, 7, 1, 12, 0, 0, turn + 1)).toISOString();
    lines.push(JSON.stringify({ timestamp: at, type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${turn} line two ${pad}` }] } }));
    lines.push(JSON.stringify({ timestamp: at, type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${turn}` }] } }));
  }
  return `${lines.join("\n")}\n`;
}

describe("readJsonlLines", () => {
  it("splits on \\n only, keeps U+2028/U+2029 inside a line, and drops a CRLF's \\r", async () => {
    const path = join(dir, "separators.jsonl");
    writeFileSync(path, '{"a":"x y z"}\r\n{"b":1}\n\n{"c":"no trailing newline"}');
    expect(await collect(path)).toEqual(['{"a":"x y z"}', '{"b":1}', "", '{"c":"no trailing newline"}']);
  });

  it("reassembles lines and multi-byte characters across read chunks", async () => {
    const path = join(dir, "chunks.jsonl");
    // Longer than the 64 KiB stream chunk, with 4-byte characters throughout.
    const long = JSON.stringify({ text: "\u{1F600}a".repeat(40_000) });
    writeFileSync(path, `${long}\n${long}\n`);
    const lines = await collect(path);
    expect(lines).toEqual([long, long]);
  });
});

describe("splitJsonlChunks", () => {
  it("scans each byte of one long line a bounded number of times", async () => {
    // One 2 MiB line arriving in 4 KiB chunks. Re-scanning a growing carry
    // string reads about 512 chunks x 1 MiB on average = 512 MiB; a linear
    // splitter reads about 2 MiB. Bytes scanned are counted via the receiver
    // of every String#indexOf call made while splitting.
    const chunkSize = 4096;
    const total = 2 * 1024 * 1024;
    const chunks = Array.from({ length: total / chunkSize }, () => "a".repeat(chunkSize));
    chunks.push("\n");
    let scanned = 0;
    const original = String.prototype.indexOf;
    const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, ...args) {
      scanned += String(this).length;
      return original.apply(this, args as [string, number?]);
    });
    const lines: string[] = [];
    try {
      for await (const line of splitJsonlChunks(chunks)) lines.push(line);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(["a".repeat(total)]);
    expect(scanned).toBeGreaterThan(0); // the seam was reached
    expect(scanned).toBeLessThan(4 * total);
  });
});

describe("importThreadsFromFile", () => {
  it("defaults to a 64 MiB threshold and reads a file exactly at the threshold whole", async () => {
    expect(DEFAULT_STREAM_THRESHOLD_BYTES).toBe(67_108_864);
    const path = join(dir, "boundary.jsonl");
    const content = codexRollout(3);
    writeFileSync(path, content);
    const size = Buffer.byteLength(content);
    expect((await importThreadsFromFile(path, "codex", { streamThresholdBytes: size })).read).toBe("whole");
    expect((await importThreadsFromFile(path, "codex", { streamThresholdBytes: size - 1 })).read).toBe("streamed");
  });

  it("streams a file above the threshold and matches the whole-file import exactly", async () => {
    const path = join(dir, "rollout.jsonl");
    const content = codexRollout(2_000, 200);
    writeFileSync(path, content);
    expect(Buffer.byteLength(content)).toBeGreaterThan(64 * 1024);

    const streamed = await importThreadsFromFile(path, "auto", { streamThresholdBytes: 64 * 1024, batchLines: 97 });
    const whole = await importThreadsFromFile(path, "auto");
    expect(streamed.read).toBe("streamed");
    expect(whole.read).toBe("whole");
    expect(streamed.format).toBe("codex");
    expect(streamed.threads[0]!.messages).toHaveLength(4_000);
    expect(streamed.losses).toEqual([]);
    expect(streamed.threads).toEqual(whole.threads);
    expect(streamed.messageIdentityObservations).toEqual(whole.messageIdentityObservations);
    expect(Thread.parse(streamed.threads[0])).toBeTruthy();
  });

  it("streams Claude Code with the same observations as the in-memory import", async () => {
    const path = join(dir, "claude.jsonl");
    writeFileSync(path, fixture("claude-code-session.jsonl"));
    const streamed = await importThreadsFromFile(path, "claude-code", { streamThresholdBytes: 1 });
    const inMemory = importThreadsWithIdentityObservations(fixture("claude-code-session.jsonl"), "claude-code");
    expect(streamed.read).toBe("streamed");
    expect(streamed.threads).toEqual(inMemory.threads);
    expect(streamed.messageIdentityObservations).toEqual(inMemory.messageIdentityObservations);
    expect(streamed.messageIdentityObservations.some((o) => o.standing === "observed")).toBe(true);
  });

  it("refuses a single-document format beyond the string limit before reading it", async () => {
    // Sparse: the size is real to stat, but no bytes are written or read.
    const path = join(dir, "huge-export.json");
    writeFileSync(path, "");
    truncateSync(path, 600 * 1024 * 1024);
    await expect(importThreadsFromFile(path, "chatgpt-export")).rejects.toBeInstanceOf(FerryInputTooLargeError);
    await expect(importThreadsFromFile(path, "auto")).rejects.toThrow(/could not be detected/);
  });
});

describe("counted losses", () => {
  const brokenCodex = [
    ...codexRollout(2).trim().split("\n"),
    '{"timestamp":"2026-08-01T12:00:09.000Z","type":"response_item","payload":{"type":"mess', // truncated write
    "[1,2,3]", // valid JSON, not a rollout record
  ].join("\n");

  it("reports Codex skips as typed counts on the result and the thread", async () => {
    const path = join(dir, "broken-codex.jsonl");
    writeFileSync(path, brokenCodex);
    const expected = [
      { format: "codex", kind: "unparseable-line", count: 1 },
      { format: "codex", kind: "unrecognized-record", count: 1 },
    ];
    for (const options of [{}, { streamThresholdBytes: 1 }]) {
      const result = await importThreadsFromFile(path, "codex", options);
      expect(result.losses).toEqual(expected);
      expect(result.threads[0]!.metadata?.custom?.["ferryImportLosses"]).toEqual(expected);
    }
  });

  it("reports Claude Code skips as typed counts", () => {
    const lines = [
      ...fixture("claude-code-provenance.jsonl").trim().split("\n"),
      '{"type":"user","uuid":"broken',
      '{"type":"user","uuid":"bad-shape","message":{"role":"user","content":42}}',
    ];
    const result = importThreadsWithIdentityObservations(lines, "claude-code");
    expect(result.losses).toEqual([
      { format: "claude-code", kind: "unparseable-line", count: 1 },
      { format: "claude-code", kind: "unrecognized-record", count: 1 },
    ]);
    expect(result.threads[0]!.metadata?.custom?.["ferryImportLosses"]).toEqual(result.losses);
  });

  it("reports nothing for a clean import", () => {
    const result = importThreadsWithIdentityObservations(fixture("codex-rollout.jsonl"), "codex");
    expect(result.losses).toEqual([]);
    expect(result.threads[0]!.metadata?.custom?.["ferryImportLosses"]).toBeUndefined();
  });
});

describe("Claude Code subagent transcripts (#35)", () => {
  const source = fixture("claude-code-subagent.jsonl");

  it("imports a subagent file as its own agent thread instead of throwing", () => {
    const thread = importFromClaudeCode(source);
    const session = "11111111-2222-4333-8444-555555555555";
    expect(thread.id).toBe(`${session}:agent-fixture-id-0002`);
    expect(thread.metadata?.custom?.["claudeSubagent"]).toEqual({ agentId: "fixture-id-0002", parentSessionId: session });
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    for (const message of thread.messages) {
      expect(message.metadata).toMatchObject({ sidechain: true, agentId: "fixture-id-0002" });
    }
    const brief = thread.messages[0];
    expect(brief?.role === "user" ? brief.origin : undefined).toEqual({ kind: "agent", evidence: "claude-code:isSidechain" });
  });

  it("does not claim observed identity for the composed thread id", () => {
    const result = importThreadsWithIdentityObservations(source, "claude-code");
    expect(result.messageIdentityObservations.length).toBeGreaterThan(0);
    expect(result.messageIdentityObservations.every((o) => o.standing === "adapter-fallback")).toBe(true);
  });

  it("imports only the transcript's own agent; a nested agent's records need includeSidechains", () => {
    const nested = source.trim().split("\n").map((line) => line.replaceAll("fixture-id-0002", "fixture-id-nested")
      .replaceAll('"uuid":"bbbbbbbb', '"uuid":"nnnnnnnn').replaceAll("msg_fixture", "msg_nested"));
    const lines = [...source.trim().split("\n"), ...nested];
    const own = importFromClaudeCode(lines);
    expect(own.messages).toHaveLength(4);
    expect(own.messages.every((m) => m.metadata?.["agentId"] === "fixture-id-0002")).toBe(true);
    const all = importFromClaudeCode(lines, { includeSidechains: true });
    expect(all.id).toBe(own.id);
    expect(all.messages.filter((m) => m.metadata?.["agentId"] === "fixture-id-nested")).toHaveLength(4);
  });

  it("keeps a restored pre-#92 main-session state from turning into a subagent transcript", () => {
    const importer = createClaudeCodeImporter();
    importer.pushLines(fixture("claude-code-provenance.jsonl").trim().split("\n"));
    const saved = JSON.parse(JSON.stringify(importer.state())) as Record<string, unknown>;
    delete saved["firstEventSeen"]; // as written before subagent detection existed
    const restored = restoreClaudeCodeImporter(saved as unknown as Parameters<typeof restoreClaudeCodeImporter>[0]);
    const before = restored.thread().messages.length;
    restored.pushLines(source.trim().split("\n"));
    expect(restored.thread().id).toBe("11111111-2222-4333-8444-555555555555");
    expect(restored.thread().messages).toHaveLength(before);
  });

  it("still skips inline sidechains in a main session by default", () => {
    const main = fixture("claude-code-provenance.jsonl").trim().split("\n");
    const inline = source.trim().split("\n");
    const thread = importFromClaudeCode([...main, ...inline]);
    expect(thread.id).toBe("11111111-2222-4333-8444-555555555555");
    expect(thread.messages.some((m) => m.metadata?.["sidechain"] === true)).toBe(false);
  });
});

describe("ferry CLI on large and subagent files", () => {
  it("inspects a rollout above the default 64 MiB threshold without losing U+2028 records", () => {
    const path = join(dir, "large-rollout.jsonl");
    const content = codexRollout(16_000, 4_200);
    expect(Buffer.byteLength(content)).toBeGreaterThan(64 * 1024 * 1024);
    writeFileSync(path, content);
    const run = spawnSync(process.execPath, [cli, "inspect", path], { encoding: "utf-8", maxBuffer: 1 << 20 });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("skipped");
    expect(run.stdout).toContain("format:    codex");
    expect(run.stdout).toContain("messages:  32000");
  }, 120_000);

  it("inspects a subagent transcript", () => {
    const out = execFileSync(process.execPath, [cli, "inspect", join(fixturesDir, "claude-code-subagent.jsonl")], {
      encoding: "utf-8",
    });
    expect(out).toContain("threadId:  11111111-2222-4333-8444-555555555555:agent-fixture-id-0002");
  });
});
