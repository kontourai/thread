import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getReasoning, getToolCalls, Thread, threadFromJson, threadToJson } from "@kontourai/thread";
import { detectFormat, importFromKiro, importFromPi } from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf-8");

describe("kiro importer", () => {
  const warnings: string[] = [];
  const thread = importFromKiro(fixture("kiro-session.jsonl"), {
    sessionId: "62001838-138c-4fc3-b5c5-ced67a614d57",
    onWarn: (m) => warnings.push(m),
  });

  it("produces a schema-valid thread and warns about the corrupt line", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("62001838-138c-4fc3-b5c5-ced67a614d57");
    expect(thread.metadata?.source).toBe("kiro");
    expect(warnings.join(" ")).toContain("skipped 1");
  });

  it("maps prompt/assistant/tool records with epoch-second timestamps", () => {
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(thread.messages[0]?.timestamp).toBe(1786067801000);

    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content.map((c) => c.type)).toEqual(["reasoning", "text", "tool_call"]);
    expect(getReasoning(assistant)).toContain("CI history");
    const [call] = getToolCalls(assistant);
    expect(call?.id).toBe("toolu_bdrk_01Fixture000001");
    expect(call?.name).toBe("shell");
    expect(call?.parsedArguments).toEqual({ command: "ls tests" });

    const tool = thread.messages[2];
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.toolCallId).toBe("toolu_bdrk_01Fixture000001");
    expect(tool.toolResults[0]?.content[0]?.type).toBe("text");
    expect(JSON.stringify(tool.toolResults[0]?.content)).toContain("retry.test.ts");
  });

  it("skips compaction snapshots entirely", () => {
    expect(JSON.stringify(thread.messages)).not.toContain("SHOULD NOT IMPORT");
  });

  it("round-trips through canonical thread JSON", () => {
    const restored = threadFromJson(threadToJson(thread));
    expect(restored).toEqual(thread);
  });

  it("throws when nothing is importable", () => {
    expect(() => importFromKiro('{"kind":"Compaction","data":{}}')).toThrow(/no importable/);
  });
});

describe("pi importer", () => {
  const thread = importFromPi(fixture("pi-session.jsonl"));

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("019de3fe-13d5-730a-a9b6-cfce85558fff");
    expect(thread.metadata?.source).toBe("pi");
    expect(thread.metadata?.cwd).toBe("/Users/dev/example");
    expect(thread.metadata?.sourceVersion).toBe("3");
  });

  it("maps roles, tool pairing, usage, stop reasons, and object arguments", () => {
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.model).toBe("claude-sonnet-5");
    expect(assistant.provider).toBe("anthropic");
    expect(assistant.finishReason).toBe("tool_calls");
    expect(assistant.usage).toEqual({
      inputTokens: 3930,
      outputTokens: 138,
      cacheReadTokens: 12,
      cacheWriteTokens: 0,
    });
    expect(getReasoning(assistant)).toContain("Read the helper");
    const [call] = getToolCalls(assistant);
    expect(call?.id).toBe("call_pi_0001|fc_abc");
    expect(call?.parsedArguments).toEqual({ command: "cat src/retry.ts" });
    expect(call?.arguments).toBe('{"command":"cat src/retry.ts"}');

    const tool = thread.messages[2];
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.toolCallId).toBe("call_pi_0001|fc_abc");
    expect(tool.toolResults[0]?.name).toBe("bash");

    const final = thread.messages[3];
    if (final?.role !== "assistant") throw new Error("expected assistant");
    expect(final.finishReason).toBe("stop");
    expect(thread.messages[0]?.timestamp).toBe(1785661201000);
  });

  it("skips settings-change events", () => {
    expect(thread.messages).toHaveLength(4);
  });

  it("round-trips through canonical thread JSON", () => {
    const restored = threadFromJson(threadToJson(thread));
    expect(restored).toEqual(thread);
  });

  it("keeps errored/aborted assistant turns instead of dropping them silently", () => {
    const jsonl = [
      '{"type":"session","version":3,"id":"s-err","timestamp":"2026-08-01T09:00:00.000Z","cwd":"/x"}',
      '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-01T09:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"go"}],"timestamp":1785661201000}}',
      '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-01T09:00:02.000Z","message":{"role":"assistant","stopReason":"error","errorMessage":"Codex error: server_is_overloaded","timestamp":1785661202000,"content":[]}}',
    ].join("\n");
    const thread = importFromPi(jsonl);
    const errored = thread.messages[1];
    if (errored?.role !== "assistant") throw new Error("expected assistant");
    expect(errored.finishReason).toBe("error");
    expect(errored.metadata?.["errorMessage"]).toContain("server_is_overloaded");
  });
});

describe("detection for kiro and pi", () => {
  it("detects kiro from record shape", () => {
    expect(detectFormat(fixture("kiro-session.jsonl"))).toBe("kiro");
  });
  it("detects pi from the session header", () => {
    expect(detectFormat(fixture("pi-session.jsonl"))).toBe("pi");
  });
  it("still detects the original four", () => {
    expect(detectFormat(fixture("claude-code-session.jsonl"))).toBe("claude-code");
    expect(detectFormat(fixture("codex-rollout.jsonl"))).toBe("codex");
    expect(detectFormat(fixture("opencode-export.json"))).toBe("opencode");
    expect(detectFormat(fixture("chatgpt-conversations.json"))).toBe("chatgpt-export");
  });
});
