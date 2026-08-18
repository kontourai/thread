import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  getReasoning,
  getTextContent,
  getToolCalls,
  Thread,
  threadFromJson,
  threadToJson,
} from "@kontourai/thread";
import type { Message } from "@kontourai/thread";
import {
  importFromChatGPTExport,
  importFromClaudeCode,
  importFromCodex,
  importFromOpenCode,
  createClaudeCodeImporter,
  createCodexImporter,
  restoreClaudeCodeImporter,
  restoreCodexImporter,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf-8");

function retainsRawJsonlLine(value: unknown, sourceLines: ReadonlySet<string>): boolean {
  if (typeof value === "string") return sourceLines.has(value);
  if (Array.isArray(value)) return value.some((item) => retainsRawJsonlLine(item, sourceLines));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => retainsRawJsonlLine(item, sourceLines));
  }
  return false;
}

describe("claude-code importer", () => {
  const thread = importFromClaudeCode(fixture("claude-code-session.jsonl"));

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    expect(thread.metadata?.source).toBe("claude-code");
    expect(thread.metadata?.cwd).toBe("/Users/dev/example");
    expect(thread.metadata?.sourceVersion).toBe("2.0.14");
    expect(thread.metadata?.git?.branch).toBe("main");
    expect(thread.metadata?.title).toBe("Fix the flaky retry test");
  });

  it("yields user → assistant → tool → assistant messages with sidechains and meta dropped", () => {
    expect(thread.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "tool", "assistant", "assistant", "assistant", "assistant",
    ]);
    const allText = JSON.stringify(thread.messages);
    expect(allText).not.toContain("Subagent");
    expect(allText).not.toContain("Caveat");
    expect(allText).not.toContain("should not be imported"); // toolUseResult sidecar
  });

  it("merges split assistant events sharing one API message id", () => {
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.id).toBe("msg_01AAA");
    expect(assistant.content.map((c) => c.type)).toEqual(["reasoning", "text", "tool_call"]);
    expect(getReasoning(assistant)).toContain("timing race");
    const [call] = getToolCalls(assistant);
    expect(call?.id).toBe("toolu_01XYZ");
    expect(call?.name).toBe("Read");
    expect(call?.parsedArguments).toEqual({
      file_path: "/Users/dev/example/tests/retry.test.ts",
    });
    expect(assistant.finishReason).toBe("tool_calls");
    expect(assistant.model).toBe("claude-sonnet-5");
    expect(assistant.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 16,
    });
    // Usage and pricing/deduplication extras are last-wins together: this is
    // the final split record's request id and usage, not the earlier one.
    expect(assistant.metadata?.["claudeUsageExtras"]).toEqual({
      cacheCreation5m: 4,
      cacheCreation1h: 12,
      serviceTier: "priority",
      requestId: "req_1",
      serverToolUse: {
        web_search_requests: 2,
        web_fetch_requests: 3,
      },
    });
  });

  it("removes stale Claude usage extras when the winning split usage has none", () => {
    const assistant = thread.messages.find((message) => message.id === "msg_01STALE");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(getTextContent(assistant)).toContain("Earlier split content with extras.");
    expect(getTextContent(assistant)).toContain("Winning split content without extras.");
    expect(assistant.usage).toEqual({ inputTokens: 410, outputTokens: 12 });
    expect(assistant.metadata?.["claudeUsageExtras"]).toBeUndefined();
    expect(assistant.metadata).toBeUndefined();
  });

  it("imports a null service_tier without inventing a serviceTier extra", () => {
    const assistant = thread.messages.find((message) => message.id === "msg_01NULL");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(getTextContent(assistant)).toBe("A synthetic assistant response with a null service tier.");
    expect(assistant.usage).toEqual({ inputTokens: 250, outputTokens: 25 });
    expect(assistant.metadata?.["claudeUsageExtras"]).toEqual({ requestId: "req_null_tier" });
    expect(assistant.metadata?.["claudeUsageExtras"]).not.toHaveProperty("serviceTier");
  });

  it("deduplicates usage repeated on every split content-block record", () => {
    const assistants = thread.messages.filter(
      (message) => message.role === "assistant" && message.id === "msg_01REPEAT",
    );
    expect(assistants).toHaveLength(1);
    const [assistant] = assistants;
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(getTextContent(assistant)).toBe(
      "Repeated usage first content block.\nRepeated usage second content block.",
    );
    expect(assistant.usage).toEqual({
      inputTokens: 300,
      outputTokens: 80,
      cacheReadTokens: 120,
      cacheWriteTokens: 20,
    });
  });

  it("surfaces requestId for messageId:requestId usage deduplication", () => {
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    const extras = assistant.metadata?.["claudeUsageExtras"] as { requestId?: string } | undefined;
    expect(`${assistant.id}:${extras?.requestId}`).toBe("msg_01AAA:req_1");
  });

  it("pairs tool results with their calls and keeps ISO timestamps as epoch ms", () => {
    const tool = thread.messages[2];
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.toolCallId).toBe("toolu_01XYZ");
    expect(tool.toolResults[0]?.content[0]).toEqual({
      type: "text",
      text: "it('retries', async () => { await sleep(50); })",
    });
    expect(thread.messages[0]?.timestamp).toBe(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(thread.createdAt).toBe(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(thread.updatedAt).toBe(Date.parse("2026-08-01T10:00:19.000Z"));
  });

  it("keeps sidechains when asked", () => {
    const withSidechains = importFromClaudeCode(fixture("claude-code-session.jsonl"), {
      includeSidechains: true,
    });
    expect(JSON.stringify(withSidechains.messages)).toContain("Subagent");
  });

  it("throws on input with no conversation events", () => {
    expect(() => importFromClaudeCode('{"type":"mode","mode":"default"}')).toThrow(
      /No Claude Code conversation events/,
    );
  });
});

describe("incremental importers", () => {
  const chunks = (source: string, sizes: readonly number[]): string[][] => {
    const lines = source.split("\n");
    const result: string[][] = [];
    let offset = 0;
    for (const size of sizes) {
      if (offset >= lines.length) break;
      result.push(lines.slice(offset, offset + size));
      offset += size;
    }
    if (offset < lines.length) result.push(lines.slice(offset));
    return result;
  };

  it("matches one-shot Claude Code imports through varied chunk boundaries and restore", () => {
    const source = fixture("claude-code-session.jsonl");
    const expected = importFromClaudeCode(source);
    const importer = createClaudeCodeImporter();
    expect(importer.pushLines([])).toEqual([]);
    const parts = chunks(source, [1, 2, 1, 4, 3, 2, 5]);
    for (const part of parts.slice(0, 3)) importer.pushLines(part);
    const restored = restoreClaudeCodeImporter(JSON.parse(JSON.stringify(importer.state())));
    for (const part of parts.slice(3)) restored.pushLines(part);
    expect(restored.thread()).toEqual(expected);
  });

  it("matches one-shot Codex imports through token-count-separated chunks and restore", () => {
    const source = fixture("codex-forked-rollout-window.jsonl");
    const expected = importFromCodex(source);
    const importer = createCodexImporter();
    expect(importer.pushLines([])).toEqual([]);
    const parts = chunks(source, [1, 3, 1, 2, 4, 1]);
    for (const part of parts.slice(0, 2)) importer.pushLines(part);
    const restored = restoreCodexImporter(JSON.parse(JSON.stringify(importer.state())));
    for (const part of parts.slice(2)) restored.pushLines(part);
    expect(restored.thread()).toEqual(expected);
  });

  // A snapshot that keeps mutating is not a snapshot. Every other test
  // round-trips state() through JSON, which would mask an aliased return —
  // and a host that snapshots, keeps tailing, then persists later would
  // silently save a NEWER state than it believes, skipping records on resume.
  it.each([
    ["claude", fixture("claude-code-session.jsonl"), createClaudeCodeImporter,
      (state: unknown) => restoreClaudeCodeImporter(state as Parameters<typeof restoreClaudeCodeImporter>[0])],
    ["codex", fixture("codex-rollout.jsonl"), createCodexImporter,
      (state: unknown) => restoreCodexImporter(state as Parameters<typeof restoreCodexImporter>[0])],
  ])("state() returns a detached snapshot, not a live view (%s)", (_, source, create, restoreSnapshot) => {
    const lines = source.trim().split("\n");
    const half = Math.max(1, Math.floor(lines.length / 2));
    const importer = create();
    importer.pushLines(lines.slice(0, half));
    const snapshot = importer.state() as { messages: Array<{ id: string; content?: Array<{ text?: string }> }> };
    const captured = structuredClone(snapshot);
    const expectedAtSnapshot = importer.thread();
    const messagesAtSnapshot = snapshot.messages.length;
    snapshot.messages[0]!.id = "mutated-snapshot-id";
    snapshot.messages[0]!.content![0]!.text = "mutated nested snapshot text";
    expect((importer.state() as { messages: Array<{ id: string }> }).messages[0]!.id)
      .toBe(captured.messages[0]!.id);
    expect((importer.state() as { messages: Array<{ content?: Array<{ text?: string }> }> }).messages[0]!.content![0]!.text)
      .toBe((captured as { messages: Array<{ content?: Array<{ text?: string }> }> }).messages[0]!.content![0]!.text);
    importer.pushLines(lines.slice(half));
    expect(snapshot.messages.length).toBe(messagesAtSnapshot);
    // And the detached snapshot still restores to exactly its own point.
    expect(restoreSnapshot(captured).thread()).toEqual(expectedAtSnapshot);
  });

  it.each([
    ["claude", fixture("claude-code-session.jsonl"), createClaudeCodeImporter, importFromClaudeCode],
    ["codex", fixture("codex-rollout.jsonl"), createCodexImporter, importFromCodex],
  ])("is random-chunk equivalent and has a pure mid-stream thread() (%s)", (_, source, create, oneShot) => {
    const expected = oneShot(source);
    const lines = source.split("\n");
    // Deterministic pseudo-random boundaries make this a regression test.
    let seed = 0x5eed;
    const next = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0);
    const importer = create();
    for (let index = 0; index < lines.length;) {
      const size = (next() % 7) + 1;
      importer.pushLines(lines.slice(index, index + size));
      const before = importer.state();
      expect(retainsRawJsonlLine(before, new Set(lines.filter((line) => {
        try { JSON.parse(line); return true; } catch { return false; }
      })))).toBe(false);
      expect(importer.thread()).toEqual(importer.thread());
      expect(importer.state()).toEqual(before);
      index += size;
    }
    expect(importer.thread()).toEqual(expected);
  });

  it("captures a timestamp-less Codex tail at ingest so thread() is pure", () => {
    const importer = createCodexImporter();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      importer.pushLines(['{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"tail"}]}}']);
      const first = importer.thread();
      clock.mockReturnValue(2000);
      expect(importer.thread()).toEqual(first);
      expect(first.messages[0]?.timestamp).toBe(1000);
    } finally {
      clock.mockRestore();
    }
  });

  it("finalizes a pending Codex tail exactly once", () => {
    const importer = createCodexImporter();
    const line = '{"timestamp":"2026-08-01T00:00:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"tail"}]}}';
    expect(importer.pushLines([line])).toEqual([]);
    expect(importer.thread().messages).toHaveLength(1);
    expect(importer.finalize()).toHaveLength(1);
    expect(importer.finalize()).toEqual([]);
    expect(importer.thread().messages).toHaveLength(1);
  });

  it("announces reordered Codex messages only after late session metadata assigns final ids", () => {
    const importer = createCodexImporter();
    const realFixture = fixture("codex-rollout.jsonl").trim().split("\n");
    const user = realFixture.find((line) => line.includes('"role":"user"'))!;
    const sessionMeta = realFixture.find((line) => line.includes('"type":"session_meta"'))!;
    expect(importer.pushLines([user])).toEqual([]);
    const announced = importer.pushLines([sessionMeta]);
    const thread = importer.thread();
    expect(thread.id).toBe("019f0000-1111-2222-3333-444444444444");
    expect(thread.messages[0]).toMatchObject({
      id: "019f0000-1111-2222-3333-444444444444:1",
      threadId: "019f0000-1111-2222-3333-444444444444",
    });
    expect(announced).toEqual(thread.messages);
  });

  it("defers Codex announcements until session metadata resolves identity", () => {
    const importer = createCodexImporter();
    const user = '{"timestamp":"2026-08-01T00:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"before metadata"}]}}';
    const meta = '{"timestamp":"2026-08-01T00:00:01.000Z","type":"session_meta","payload":{"id":"real-session"}}';
    expect(importer.pushLines([user])).toEqual([]);
    expect(importer.pushLines([meta])).toEqual([expect.objectContaining({ id: "real-session:1", threadId: "real-session" })]);
    expect(importer.finalize()).toEqual([]);
  });

  it("announces never-metadata Codex messages once at finalize with the fallback id", () => {
    const importer = createCodexImporter();
    const user = '{"timestamp":"2026-08-01T00:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"no metadata"}]}}';
    expect(importer.pushLines([user])).toEqual([]);
    expect(importer.finalize()).toEqual([expect.objectContaining({ id: "codex-session:1", threadId: "codex-session" })]);
    expect(importer.finalize()).toEqual([]);
  });

  // The class-catcher: every message the consumer was told about must be the
  // message thread() ends up holding, in the same order, under the same id.
  // Identity+order only — a full-object compare is NOT a valid invariant here,
  // because an early Codex assistant can legitimately gain its model in the
  // thread() finalize pass (backfill) after it was announced.
  //
  // The reordered-metadata source is the load-bearing row: it exercises the
  // DEFERRAL path, so removing deferral makes this test fail rather than
  // leaving it green (review round 2 note — the first version of this test
  // only ever saw fixtures whose session_meta came first).
  it.each([
    ["Claude Code", fixture("claude-code-session.jsonl"), createClaudeCodeImporter],
    ["Codex", fixture("codex-rollout.jsonl"), createCodexImporter],
    ["Codex (identity deferred)", fixture("codex-reordered-metadata.jsonl"), createCodexImporter],
  ])("keeps all %s announcements in final thread order with matching ids", (_, source, create) => {
    const importer = create();
    const announced: Message[] = [];
    for (const line of source.split("\n")) announced.push(...importer.pushLines([line]));
    announced.push(...importer.finalize());
    const identity = (messages: readonly Message[]) =>
      messages.map((message) => [message.id, message.threadId, message.role]);
    expect(identity(announced)).toEqual(identity(importer.thread().messages));
    expect(announced.length).toBeGreaterThan(0);
    // Agreement alone is not enough: if identity resolution were removed,
    // announcements and thread() would both carry the FALLBACK id and still
    // agree. Pin the resolved id too — when the source declares a session,
    // nothing may be announced under the placeholder.
    const declaredSession = source
      .split("\n")
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as { type?: string; payload?: { id?: string } };
          return record.type === "session_meta" && record.payload?.id ? [record.payload.id] : [];
        } catch {
          return [];
        }
      })
      .at(0);
    if (declaredSession) {
      expect(announced.map((message) => message.threadId)).not.toContain("codex-session");
      expect(new Set(announced.map((message) => message.threadId))).toEqual(
        new Set([declaredSession]),
      );
    }
  });

  it("exposes idempotent finalize() on Claude Code importers", () => {
    const importer = createClaudeCodeImporter();
    expect(importer.finalize()).toEqual([]);
    expect(importer.finalize()).toEqual([]);
  });
});

describe("codex importer", () => {
  const thread = importFromCodex(fixture("codex-rollout.jsonl"));

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("019f0000-1111-2222-3333-444444444444");
    expect(thread.metadata?.source).toBe("codex");
    expect(thread.metadata?.cwd).toBe("/Users/dev/example");
    expect(thread.metadata?.sourceVersion).toBe("0.21.0");
  });

  it("folds assistant items per turn and pairs both tool call kinds", () => {
    expect(thread.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);

    const first = thread.messages[1];
    if (first?.role !== "assistant") throw new Error("expected assistant");
    expect(getReasoning(first)).toBe("Find every caller before renaming.");
    const [shellCall] = getToolCalls(first);
    expect(shellCall?.id).toBe("call_alpha");
    expect(shellCall?.name).toBe("shell");
    expect(shellCall?.parsedArguments).toEqual({ command: ["rg", "old_flag"] });
    expect(first.model).toBe("gpt-5.4-codex");
    expect(first.provider).toBe("openai");

    const patch = thread.messages[3];
    if (patch?.role !== "assistant") throw new Error("expected assistant");
    const [patchCall] = getToolCalls(patch);
    expect(patchCall?.id).toBe("call_beta");
    expect(patchCall?.name).toBe("apply_patch");
    expect(patchCall?.arguments).toContain("*** Begin Patch");

    const outputs = thread.messages.filter((m) => m.role === "tool");
    expect(outputs[0]?.toolResults[0]?.toolCallId).toBe("call_alpha");
    expect(outputs[1]?.toolResults[0]?.toolCallId).toBe("call_beta");
  });

  it("keeps non-event inter-agent chatter skipped and encrypted reasoning out", () => {
    const text = JSON.stringify(thread.messages);
    expect(text).not.toContain("inter-agent chatter");
    expect(text).not.toContain("opaque-not-imported");
  });

  it("normalizes modern and historical token counts and preserves their complete raw metadata", () => {
    const first = thread.messages[1];
    const modern = thread.messages[3];
    const second = thread.messages[5];
    if (first?.role !== "assistant" || modern?.role !== "assistant" || second?.role !== "assistant") {
      throw new Error("expected assistant messages");
    }
    expect(first.usage).toEqual({
      inputTokens: 4918,
      outputTokens: 249,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(modern.usage).toBeUndefined();
    expect(second.usage).toEqual({
      inputTokens: 20706,
      outputTokens: 217,
      reasoningTokens: 20,
      cacheReadTokens: 9600,
      cacheWriteTokens: 0,
    });
    expect(first.metadata?.codexTokenUsage).toEqual({
      input_tokens: 4918,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 249,
      reasoning_output_tokens: 0,
      total_tokens: 5167,
    });
    expect(second.metadata?.codexTokenUsage).toEqual({
      input_tokens: 30306,
      cached_input_tokens: 9600,
      output_tokens: 217,
      reasoning_output_tokens: 20,
      total_tokens: 30523,
    });
    expect(first.metadata?.codexRateLimits).toEqual({
      limit_id: "codex",
      limit_name: null,
      primary: null,
      secondary: null,
      credits: null,
      individual_limit: null,
      spend_control_reached: null,
      plan_type: null,
      rate_limit_reached_type: null,
    });
    expect(thread.metadata?.custom?.codexRateLimits).toEqual({
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1774689802 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1775276602 },
      credits: null,
      plan_type: "plus",
    });
  });

  it("preserves a real June count-agent_message-assistant-count sequence", () => {
    const forked = importFromCodex(fixture("codex-forked-rollout.jsonl"));
    expect(forked.metadata?.custom?.codexUnattributedUsage).toEqual({
      inputTokens: 377,
      outputTokens: 18,
      reasoningTokens: 0,
      cacheReadTokens: 17408,
      cacheWriteTokens: 0,
      events: 1,
    });
    const assistant = forked.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.usage).toEqual({
      inputTokens: 271,
      outputTokens: 54,
      reasoningTokens: 0,
      cacheReadTokens: 17408,
      cacheWriteTokens: 0,
    });
  });

  it("imports forked agent event text and reasoning into an assistant with its token window", () => {
    const forked = importFromCodex(fixture("codex-forked-agent-events.jsonl"));
    expect(forked.messages).toHaveLength(1);
    const assistant = forked.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content).toEqual([
      { type: "reasoning", reasoning: { type: "reasoning", text: "[redacted]" } },
      { type: "text", text: "[redacted]" },
    ]);
    expect(assistant.usage).toEqual({
      inputTokens: 3945,
      outputTokens: 310,
      reasoningTokens: 29,
      cacheReadTokens: 26368,
      cacheWriteTokens: 0,
    });
    expect(forked.metadata?.custom?.codexUnattributedUsage).toEqual({
      inputTokens: 10474,
      outputTokens: 512,
      reasoningTokens: 218,
      cacheReadTokens: 29440,
      cacheWriteTokens: 0,
      events: 1,
    });
  });

  it("shrinks forked-rollout unattributed usage when agent events are attachment targets", () => {
    const source = fixture("codex-forked-rollout-window.jsonl");
    const before = importFromCodex(
      source
        .trim()
        .split("\n")
        .filter((line) => !["agent_message", "agent_reasoning"].includes(JSON.parse(line).payload?.type))
        .join("\n"),
    );
    const after = importFromCodex(source);
    expect(before.metadata?.custom?.codexUnattributedUsage).toEqual({
      inputTokens: 21293,
      outputTokens: 182,
      reasoningTokens: 39,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      events: 1,
    });
    expect(after.metadata?.custom?.codexUnattributedUsage).toBeUndefined();
    // Attribution follows the real record order in this window: the
    // token_count sits BETWEEN two agent_message events, so it belongs to the
    // first one. The trailing agent_message has no count of its own yet and
    // must stay usage-less — asserting on `.at(-1)` would demand exactly the
    // forward-misattribution the #8 boundary rule exists to prevent.
    const assistants = after.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    const [counted, trailing] = assistants;
    if (counted?.role !== "assistant" || trailing?.role !== "assistant") {
      throw new Error("expected two assistants");
    }
    expect(counted.usage).toEqual({
      inputTokens: 21293,
      outputTokens: 182,
      reasoningTokens: 39,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(trailing.usage).toBeUndefined();
  });

  it("does not duplicate an immediately mirrored ordinary agent message", () => {
    const imported = importFromCodex(fixture("codex-ordinary-agent-message.jsonl"));
    expect(imported.messages).toHaveLength(1);
    expect(imported.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "[redacted]" }],
    });
  });

  it("holds a token count before any assistant and attaches it to the first assistant that follows", () => {
    const jsonl = [
      '{"timestamp":"2026-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"held-count"}}',
      '{"timestamp":"2026-06-15T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20}}}}',
      '{"timestamp":"2026-06-15T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"receives held usage"}]}}',
    ].join("\n");
    const held = importFromCodex(jsonl);
    const assistant = held.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("attaches counts backward within their respective attribution windows", () => {
    const jsonl = [
      '{"timestamp":"2026-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"stale-count"}}',
      '{"timestamp":"2026-06-15T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"assistant A"}]}}',
      '{"timestamp":"2026-06-15T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20}}}}',
      '{"timestamp":"2026-06-15T10:00:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"assistant B"}]}}',
      '{"timestamp":"2026-06-15T10:00:04.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"output_tokens":40}}}}',
    ].join("\n");
    const imported = importFromCodex(jsonl);
    const [assistantA, assistantB] = imported.messages;
    if (assistantA?.role !== "assistant" || assistantB?.role !== "assistant") {
      throw new Error("expected assistant messages");
    }
    expect(assistantA.usage?.inputTokens).toBe(100);
    expect(assistantB.usage?.inputTokens).toBe(200);
  });

  it("never crosses count1 to attach count2 to an older assistant", () => {
    const jsonl = [
      '{"timestamp":"2026-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"stale-count"}}',
      '{"timestamp":"2026-06-15T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"old assistant"}]}}',
      '{"timestamp":"2026-06-15T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"separates assistant turns"}]}}',
      '{"timestamp":"2026-06-15T10:00:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"count1 recipient"}]}}',
      '{"timestamp":"2026-06-15T10:00:04.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20}}}}',
      '{"timestamp":"2026-06-15T10:00:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"output_tokens":40}}}}',
      '{"timestamp":"2026-06-15T10:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"held count2 recipient"}]}}',
    ].join("\n");
    const imported = importFromCodex(jsonl);
    const [oldAssistant, count1Recipient, count2Recipient] = imported.messages.filter(
      (message): message is Extract<Message, { role: "assistant" }> => message.role === "assistant",
    );
    if (
      oldAssistant?.role !== "assistant" ||
      count1Recipient?.role !== "assistant" ||
      count2Recipient?.role !== "assistant"
    ) {
      throw new Error("expected assistant messages");
    }
    expect(oldAssistant.usage).toBeUndefined();
    expect(count1Recipient.usage?.inputTokens).toBe(100);
    expect(count2Recipient.usage?.inputTokens).toBe(200);
  });

  it("imports observed nullable-info and historical rate-limit variants", () => {
    const variants = importFromCodex(fixture("codex-rollout-variants.jsonl"));
    expect(variants.messages).toHaveLength(1);
    const [missingCacheWrite] = variants.messages;
    if (missingCacheWrite?.role !== "assistant") {
      throw new Error("expected assistant messages");
    }
    expect(variants.metadata?.custom?.codexRateLimits).toEqual({
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1774689802 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1775276602 },
      credits: null,
      plan_type: "plus",
    });
    expect(missingCacheWrite.usage).toEqual({
      inputTokens: 20706,
      outputTokens: 217,
      reasoningTokens: 20,
      cacheReadTokens: 9600,
      cacheWriteTokens: 0,
    });
    expect(missingCacheWrite.metadata?.codexTokenUsage).toEqual({
      input_tokens: 30306,
      cached_input_tokens: 9600,
      output_tokens: 217,
      reasoning_output_tokens: 20,
      total_tokens: 30523,
    });
  });

  it("marks synthetic impossible exclusive input without inventing raw usage fields", () => {
    // Synthetic anomaly probe: real samples contained no negative exclusive input.
    const jsonl = [
      '{"timestamp":"2026-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"negative-count"}}',
      '{"timestamp":"2026-06-15T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":20,"output_tokens":5}}}}',
      '{"timestamp":"2026-06-15T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"anomaly recipient"}]}}',
    ].join("\n");
    const imported = importFromCodex(jsonl);
    const assistant = imported.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.usage?.inputTokens).toBe(0);
    expect(assistant.metadata?.codexTokenUsage).toEqual({
      input_tokens: 10,
      cached_input_tokens: 20,
      output_tokens: 5,
    });
    expect(assistant.metadata?.codexTokenUsageInconsistent).toBe(true);
  });

  it("rolls up a terminal count with no assistant in its attribution window", () => {
    const [firstCount, , assistant, secondCount] = fixture("codex-forked-rollout.jsonl").trim().split("\n");
    const repeated = importFromCodex([assistant, firstCount, secondCount].join("\n"));
    const importedAssistant = repeated.messages[0];
    if (importedAssistant?.role !== "assistant") throw new Error("expected assistant");
    expect(repeated.metadata?.custom?.codexUnattributedUsage).toEqual({
      inputTokens: 377,
      outputTokens: 18,
      reasoningTokens: 0,
      cacheReadTokens: 17408,
      cacheWriteTokens: 0,
      events: 1,
    });
    expect(importedAssistant.usage?.inputTokens).toBe(271);
  });

  it("tolerates a line with no payload key (zod 4 unknown-key regression guard)", () => {
    // zod 4 made bare `z.unknown()` object keys required AT PARSE TIME.
    // Without .optional() on RolloutLine.payload this line fails validation
    // and the whole record is silently counted as skipped.
    const warnings: string[] = [];
    const jsonl = [
      '{"timestamp":"2026-08-01T12:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
      '{"timestamp":"2026-08-01T12:00:00.500Z","type":"event_msg"}',
      '{"timestamp":"2026-08-01T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
    ].join("\n");
    const thread = importFromCodex(jsonl, { onWarn: (m) => warnings.push(m) });
    expect(thread.messages).toHaveLength(1);
    // The payload-less line is recognized and ignored, NOT counted as a
    // parse failure.
    expect(warnings).toEqual([]);
  });

  it("throws when no importable items exist", () => {
    expect(() => importFromCodex('{"type":"event_msg","payload":{"type":"noise"}}')).toThrow(
      /No Codex importable items/,
    );
  });
});

describe("opencode importer", () => {
  const thread = importFromOpenCode(fixture("opencode-export.json"));

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("ses_0abc111defV0Example00001");
    expect(thread.metadata?.title).toBe("Clean up merged worktrees");
    expect(thread.metadata?.cwd).toBe("/Users/dev/example");
    expect(thread.metadata?.sourceVersion).toBe("1.18.11");
    expect(thread.createdAt).toBe(1785432240000);
    expect(thread.updatedAt).toBe(1785432299000);
  });

  it("splits embedded tool state into call + result and maps tokens", () => {
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content.map((c) => c.type)).toEqual(["reasoning", "text", "tool_call"]);
    expect(assistant.model).toBe("glm-5.2");
    expect(assistant.provider).toBe("zai-coding-plan");
    expect(assistant.usage).toEqual({
      inputTokens: 31405,
      outputTokens: 83,
      reasoningTokens: 55,
      cacheReadTokens: 128,
      cacheWriteTokens: 0,
    });

    const [call] = getToolCalls(assistant);
    expect(call?.id).toBe("call_06d8469b26674bf7a0f80d15");
    expect(call?.name).toBe("bash");
    expect(call?.parsedArguments).toEqual({ command: "git worktree list" });

    const tool = thread.messages[2];
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.toolCallId).toBe("call_06d8469b26674bf7a0f80d15");
    expect(tool.toolResults[0]?.name).toBe("bash");
    expect(getToolResultText(tool.toolResults[0]?.content)).toContain("abc1234 [main]");
  });

  it("rejects non-opencode json", () => {
    expect(() => importFromOpenCode('{"foo":1}')).toThrow(/Not an OpenCode session export/);
  });
});

function getToolResultText(content: unknown): string {
  return JSON.stringify(content ?? "");
}

describe("chatgpt export importer", () => {
  const threads = importFromChatGPTExport(fixture("chatgpt-conversations.json"));

  it("follows current_node, not the abandoned branch", () => {
    expect(threads).toHaveLength(2);
    const thread = threads[0];
    if (!thread) throw new Error("expected thread");
    expect(Thread.parse(thread)).toBeTruthy();
    const text = JSON.stringify(thread.messages);
    expect(text).not.toContain("ABANDONED BRANCH");
    expect(text).toContain("feed it twice daily");
  });

  it("discloses importable messages dropped from alternative branches", () => {
    const warnings: string[] = [];
    const withWarnings = importFromChatGPTExport(fixture("chatgpt-conversations.json"), {
      onWarn: (message) => warnings.push(message),
    });
    expect(withWarnings[0]?.metadata?.custom).toEqual({ chatgptAbandonedBranchMessages: 1 });
    expect(warnings).toEqual([
      "chatgpt-export: 1 message(s) on alternative branches were not imported (only the canonical path is imported; they remain in the source export)",
    ]);
  });

  it("does not record or warn about conversations without alternative branches", () => {
    const warnings: string[] = [];
    const [, secondConversation] = JSON.parse(fixture("chatgpt-conversations.json")) as unknown[];
    const [thread] = importFromChatGPTExport(JSON.stringify(secondConversation), {
      onWarn: (message) => warnings.push(message),
    });
    expect(thread?.metadata?.custom?.["chatgptAbandonedBranchMessages"]).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("tolerates a malformed children field without deleting the conversation", () => {
    const second = threads[1];
    if (!second) throw new Error("expected second thread");
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(second.messages)).toContain("Second conversation answer");
  });

  it("keeps a codex mid-session model switch per turn", () => {
    const thread = importFromCodex(fixture("codex-rollout.jsonl"));
    const assistants = thread.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.model).toBe("gpt-5.4-codex");
    expect(assistants[assistants.length - 1]?.model).toBe("gpt-5.5");
  });

  it("does not unwrap legitimate JSON tool output lacking the metadata sibling", () => {
    const jsonl = [
      '{"timestamp":"2026-08-01T12:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
      '{"timestamp":"2026-08-01T12:00:01.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}',
      `{"timestamp":"2026-08-01T12:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\\"output\\":\\"dist\\",\\"clean\\":true}"}}`,
    ].join("\n");
    const thread = importFromCodex(jsonl);
    const tool = thread.messages.find((m) => m.role === "tool");
    if (tool?.role !== "tool") throw new Error("expected tool");
    // No metadata sibling → this is real tool output, kept verbatim.
    expect(tool.toolResults[0]?.content[0]?.type).toBe("text");
    expect(JSON.stringify(tool.toolResults[0]?.content)).toContain("clean");
  });

  it("backfills the session model for items before the first turn_context", () => {
    const jsonl = [
      '{"timestamp":"2026-08-01T12:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
      '{"timestamp":"2026-08-01T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"early"}]}}',
      '{"timestamp":"2026-08-01T12:00:02.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}',
      '{"timestamp":"2026-08-01T12:00:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}}',
      '{"timestamp":"2026-08-01T12:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"late"}]}}',
    ].join("\n");
    const thread = importFromCodex(jsonl);
    const assistants = thread.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.model).toBe("gpt-5.5"); // backfilled
    expect(assistants[1]?.model).toBe("gpt-5.5");
  });

  it("unwraps codex {output, metadata} wrappers in tool results", () => {
    const jsonl = [
      '{"timestamp":"2026-08-01T12:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
      '{"timestamp":"2026-08-01T12:00:01.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}',
      `{"timestamp":"2026-08-01T12:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\\"output\\":\\"unwrapped text\\",\\"metadata\\":{\\"exit_code\\":0}}"}}`,
    ].join("\n");
    const thread = importFromCodex(jsonl);
    const tool = thread.messages.find((m) => m.role === "tool");
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.content[0]).toEqual({ type: "text", text: "unwrapped text" });
  });

  it("does not delete a user event because one content block is malformed", () => {
    const warnings: string[] = [];
    const jsonl = [
      '{"type":"user","uuid":"u1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{"role":"user","content":[null,{"type":"text","text":"IMPORTANT USER SPEECH"}]}}',
      '{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:01.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      "corrupt line",
    ].join("\n");
    const thread = importFromClaudeCode(jsonl, { onWarn: (m) => warnings.push(m) });
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(thread.messages)).toContain("IMPORTANT USER SPEECH");
    expect(warnings.join(" ")).toContain("skipped 1");
  });

  it("merges split assistant messages across interleaved sidechain lines", () => {
    const jsonl = [
      '{"type":"user","uuid":"u1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:01.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"part one"}]}}',
      '{"type":"user","uuid":"side1","isSidechain":true,"sessionId":"s","timestamp":"2026-08-01T10:00:02.000Z","message":{"role":"user","content":"sidechain prompt"}}',
      '{"type":"assistant","uuid":"a2","sessionId":"s","timestamp":"2026-08-01T10:00:03.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"part two"}]}}',
    ].join("\n");
    const thread = importFromClaudeCode(jsonl, { includeSidechains: true });
    const ids = thread.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    const merged = thread.messages.find((m) => m.id === "m1");
    if (merged?.role !== "assistant") throw new Error("expected assistant");
    expect(merged.content).toHaveLength(2);
    const sidechain = thread.messages.find((m) => m.metadata?.["sidechain"] === true);
    expect(sidechain).toBeTruthy();
  });

  it("preserves redacted thinking data for replay", () => {
    const jsonl =
      '{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"redacted_thinking","data":"OPAQUE_REPLAY_MATERIAL"}]}}';
    const thread = importFromClaudeCode(jsonl);
    expect(JSON.stringify(thread.messages)).toContain("OPAQUE_REPLAY_MATERIAL");
  });

  it("maps roles, thoughts, hidden system messages, and second-based times", () => {
    const thread = threads[0];
    if (!thread) throw new Error("expected thread");
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    const thoughts = thread.messages[1];
    if (thoughts?.role !== "assistant") throw new Error("expected assistant");
    expect(getReasoning(thoughts)).toContain("hungry, not dead");
    expect(thoughts.model).toBe("gpt-5");
    expect(thoughts.provider).toBe("openai");
    expect(thread.messages[0]?.timestamp).toBe(1754040001000);
    expect(thread.createdAt).toBe(1754040000123);
    expect(thread.metadata?.title).toBe("Sourdough starter help");
  });
});

describe("round trips", () => {
  const imports: Array<[string, () => Thread]> = [
    ["claude-code", () => importFromClaudeCode(fixture("claude-code-session.jsonl"))],
    ["codex", () => importFromCodex(fixture("codex-rollout.jsonl"))],
    ["opencode", () => importFromOpenCode(fixture("opencode-export.json"))],
    ["chatgpt", () => importFromChatGPTExport(fixture("chatgpt-conversations.json"))[0]!],
  ];
  type Thread = ReturnType<typeof importFromClaudeCode>;

  for (const [name, load] of imports) {
    it(`${name} → thread JSON → thread preserves everything`, () => {
      const thread = load();
      const restored = threadFromJson(threadToJson(thread));
      expect(restored).toEqual(thread);
      // Byte stability holds from the first zod-parsed generation onward.
      const canonical = threadToJson(restored);
      expect(threadToJson(threadFromJson(canonical))).toBe(canonical);
    });
  }

  it("preserves text and tool calls through the canonical format", () => {
    const thread = importFromClaudeCode(fixture("claude-code-session.jsonl"));
    const restored = threadFromJson(threadToJson(thread));
    for (let i = 0; i < thread.messages.length; i++) {
      const original = thread.messages[i]!;
      const back = restored.messages[i]!;
      expect(getTextContent(back)).toBe(getTextContent(original));
      if (original.role === "assistant" && back.role === "assistant") {
        expect(getToolCalls(back)).toEqual(getToolCalls(original));
      }
    }
  });
});

describe("claude-code tool result names (#38)", () => {
  const thread = importFromClaudeCode(fixture("claude-code-session.jsonl"));
  const results = thread.messages.flatMap((m) => (m.role === "tool" ? m.toolResults : []));
  const calls = new Map(
    thread.messages
      .flatMap((m) => (m.role === "assistant" ? m.content : []))
      .filter((c) => c.type === "tool_call")
      .map((c) => [c.toolCall.id, c.toolCall.name] as const),
  );

  it("names every paired result after its call", () => {
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      // Only paired results — an unpaired one legitimately keeps "".
      if (!calls.has(result.toolCallId)) continue;
      expect(result.name).toBe(calls.get(result.toolCallId));
      expect(result.name).not.toBe("");
    }
  });
});

describe("codex exec legibility (#32, #33, #38)", () => {
  const thread = importFromCodex(fixture("codex-exec-program.jsonl"));
  const calls = thread.messages.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((c) => c.type === "tool_call").map((c) => c.toolCall) : [],
  );
  const byId = (id: string) => calls.find((c) => c.id === id)!;
  const results = thread.messages.flatMap((m) => (m.role === "tool" ? m.toolResults : []));
  const derivedOf = (id: string) =>
    byId(id).derived?.["codexExec"] as Record<string, unknown> | undefined;

  it("recovers a structured form for custom_tool_call, not only function_call (#32)", () => {
    // The `function_call`-only gate left every Codex `exec` — the majority of
    // tool calls in a real corpus — with no structured form at all.
    expect(byId("c1").derived).toBeDefined();
  });

  it("recovers the operation and the literal command (#33)", () => {
    expect(derivedOf("c1")).toMatchObject({
      operation: "exec_command",
      commands: ["git status --short"],
      heuristic: true,
    });
    // The verbatim program stays the lossless record.
    expect(byId("c1").arguments).toContain("tools.exec_command");
  });

  it("keeps the derivation OUT of parsedArguments (#33 review)", () => {
    // Exporters re-emit parsedArguments as the model's literal tool input, so
    // a heuristic there asserts on the wire that the model called `exec` with
    // keys it never sent. Before this change the field was simply absent,
    // which is honest — confidently wrong is worse than empty.
    expect(byId("c1").parsedArguments).toBeUndefined();
  });

  it("distinguishes a non-shell exec from a command (#33)", () => {
    // 38% of exec calls in a sampled corpus run no shell command at all.
    expect(derivedOf("c2")).toMatchObject({ operation: "write_stdin" });
    expect(derivedOf("c2")?.["commands"]).toBeUndefined();
  });

  it("reports a program that invokes several operations as mixed", () => {
    expect(derivedOf("c3")).toMatchObject({
      operation: "mixed",
      operations: ["exec_command", "write_stdin"],
    });
    // One entry is one `cmd` literal, which is often a multi-line script.
    expect(derivedOf("c3")?.["commands"]).toEqual([
      "sed -n '1,40p' a.ts\nsed -n '1,40p' b.ts",
    ]);
  });

  it("never derives for a tool whose payload is not a program", () => {
    // Both are apply_patch. c4 contains `cmd:` in its diffed source; c5
    // contains `tools.map(`/`tools.filter(`, which satisfied an earlier
    // `tools.*` gate and fabricated an operation on 61 real payloads across
    // a 12.2 GB corpus. Gating on the tool NAME is exact.
    expect(byId("c4").derived).toBeUndefined();
    expect(byId("c5").derived).toBeUndefined();
  });

  it("does not emit an unresolved template as a command", () => {
    // A backtick `cmd` still containing ${…} was assembled at runtime: that
    // command string was never run, and nothing would mark it partial.
    expect(derivedOf("c6")).toMatchObject({ operation: "exec_command" });
    expect(derivedOf("c6")?.["commands"]).toBeUndefined();
  });

  it("still parses a JSON function_call payload into parsedArguments", () => {
    expect(byId("c7").parsedArguments).toMatchObject({ command: ["ls", "-la"] });
    expect(byId("c7").derived).toBeUndefined();
  });

  it("derives for js_repl too, the other program-payload tool", () => {
    // js_repl is rarer than exec (34 vs ~309k in a local corpus) but takes
    // the same program payload, so it is in the name gate — and was
    // otherwise unexercised by any fixture.
    expect(derivedOf("c8")).toMatchObject({
      operation: "exec_command",
      commands: ["node -e 'console.log(1)'"],
    });
  });

  it("carries the call name onto its result (#38)", () => {
    expect(results.find((r) => r.toolCallId === "c1")?.name).toBe("exec");
    expect(results.find((r) => r.toolCallId === "c2")?.name).toBe("exec");
  });
});
