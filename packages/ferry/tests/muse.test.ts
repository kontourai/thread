import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getReasoning,
  getTextContent,
  getToolCalls,
  Thread,
  threadFromJson,
  threadToJson,
} from "@kontourai/thread";
import { detectFormat, importFromMuse, importThreads } from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf-8");

const CHAT = "muse-session.json";
const TOOLS = "muse-session-tools.json";

/** Read the source events back, so expectations are pinned to the real export. */
interface SourceEvent {
  kind?: string;
  envelope?: {
    id?: string;
    recorded_at?: number;
    payload?: { kind?: string; event?: Record<string, unknown> };
  };
}
function sourceEvents(name: string): SourceEvent[] {
  return (JSON.parse(fixture(name)) as { events: SourceEvent[] }).events;
}
function runEvents(name: string, kind: string): Array<Record<string, unknown>> {
  return sourceEvents(name)
    .filter((event) => event.envelope?.payload?.kind === "run")
    .map((event) => event.envelope?.payload?.event)
    .filter((event): event is Record<string, unknown> => event?.["kind"] === kind);
}

describe("muse importer — multi-turn session", () => {
  const warnings: string[] = [];
  const thread = importFromMuse(fixture(CHAT), { onWarn: (m) => warnings.push(m) });

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("1023465b-9491-4a39-b8e3-111e73b61c50");
    expect(thread.metadata?.source).toBe("muse");
    expect(thread.metadata?.sourceVersion).toBe("0.1.0");
    expect(thread.metadata?.cwd).toBe("/workspace/example");
    // muse's export carries no conversation title.
    expect(thread.metadata?.title).toBeUndefined();
  });

  it("maps both turns in order, with the tool call split from its result", () => {
    expect(thread.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(getTextContent(thread.messages[0]!)).toBe("Remember the number 7413. Reply OK.");
    expect(getTextContent(thread.messages[3]!)).toBe("OK");
    expect(getTextContent(thread.messages[4]!)).toBe("What number did I ask you to remember?");
    expect(getTextContent(thread.messages[5]!)).toBe("7413");
  });

  it("reads recorded_at as MICROseconds, not milliseconds", () => {
    const started = sourceEvents(CHAT).find(
      (event) => event.envelope?.payload?.event?.["kind"] === "started",
    );
    const micros = started?.envelope?.recorded_at;
    expect(typeof micros).toBe("number");
    expect(thread.messages[0]?.timestamp).toBe(Math.round(micros! / 1000));
    // A ms/µs mix-up would place the thread ~55,000 years from the export date.
    expect(new Date(thread.createdAt).getUTCFullYear()).toBe(2026);
    expect(thread.createdAt).toBeLessThanOrEqual(thread.messages[0]!.timestamp);
    expect(thread.updatedAt).toBeGreaterThanOrEqual(
      thread.messages[thread.messages.length - 1]!.timestamp,
    );
  });

  it("pairs the tool result to its call by call_id and backfills the tool name", () => {
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    const [call] = getToolCalls(assistant);
    expect(call?.id).toBe("call_019fe7ea8dbd7e92b369e9872d40a0c4");
    expect(call?.name).toBe("add_memory");

    const tool = thread.messages[2];
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults).toHaveLength(1);
    expect(tool.toolResults[0]?.toolCallId).toBe(call?.id);
    // muse records the tool name only on the call; the result inherits it.
    expect(tool.toolResults[0]?.name).toBe("add_memory");
    expect(tool.toolResults[0]?.content[0]).toEqual({
      type: "text",
      text: '{"success":true,"scope":"personal","path":"memory.md","operation":"add","message":"memory note written"}',
    });
    // muse's committed batch carries no error flag; nothing is invented.
    expect(tool.toolResults[0]?.isError).toBeUndefined();
  });

  it("does not double-count tool uses from muse's internal task lifecycle", () => {
    // The fixture keeps a `task` output event carrying the SAME bytes as the
    // committed batch result: mapping it too would duplicate every tool use.
    const taskOutputs = sourceEvents(CHAT).filter(
      (event) => event.envelope?.payload?.kind === "task",
    );
    expect(taskOutputs.length).toBeGreaterThan(0);
    expect(runEvents(CHAT, "assistant_tool_calls_committed")).toHaveLength(1);

    const calls = thread.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m.role === "assistant" ? getToolCalls(m) : []));
    expect(calls).toHaveLength(1);
    expect(thread.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("never presents provider-encrypted reasoning as readable reasoning", () => {
    const reasoning = runEvents(CHAT, "reasoning_committed");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.["text"]).toBe(""); // plaintext empty…
    expect(String(reasoning[0]?.["encrypted_content"] ?? "")).not.toBe(""); // …blob present

    const serialized = threadToJson(thread);
    expect(serialized).not.toContain("ENCRYPTED_REASONING_BLOB");
    expect(serialized).not.toContain("encrypted_content");
    for (const message of thread.messages) {
      if (message.role === "assistant") expect(getReasoning(message)).toBeUndefined();
    }
    expect(warnings).toContain(
      "muse: 1 reasoning event(s) carried only provider-encrypted content and were not imported as reasoning",
    );
    expect(thread.metadata?.custom).toEqual({ museEncryptedReasoningDropped: 1 });
  });

  it("attributes usage to the response that produced it, whichever side it lands on", () => {
    const completions = runEvents(CHAT, "model_completed");
    const assistants = thread.messages.filter((m) => m.role === "assistant");
    expect(completions).toHaveLength(assistants.length);

    // model_completed PRECEDES assistant_tool_calls_committed …
    const first = assistants[0];
    if (first?.role !== "assistant") throw new Error("expected assistant");
    expect(first.content.map((c) => c.type)).toEqual(["tool_call"]);
    expect(first.usage).toEqual({
      inputTokens: 21469,
      outputTokens: 572,
      reasoningTokens: 427,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(first.finishReason).toBe("tool_calls");

    // … and FOLLOWS assistant_message_committed. Same response, same message.
    const second = assistants[1];
    if (second?.role !== "assistant") throw new Error("expected assistant");
    expect(getTextContent(second)).toBe("OK");
    // input_tokens 22243 is inclusive of the 21425 cached reads.
    expect(second.usage).toEqual({
      inputTokens: 818,
      outputTokens: 21,
      reasoningTokens: 10,
      cacheReadTokens: 21425,
      cacheWriteTokens: 0,
    });
    expect(second.metadata?.["museTokenUsage"]).toEqual(completions[1]?.["usage"]);
    // muse states no finish_reason for a plain completion; none is invented.
    expect(completions[1]?.["finish_reason"]).toBeUndefined();
    expect(second.finishReason).toBeUndefined();
  });

  it("carries the session model and provider onto every assistant message", () => {
    for (const message of thread.messages) {
      if (message.role !== "assistant") continue;
      expect(message.model).toBe("muse-spark-1.2-contributor");
      expect(message.provider).toBe("meta");
    }
  });

  it("round-trips through canonical thread JSON", () => {
    const restored = threadFromJson(threadToJson(thread));
    expect(restored).toEqual(thread);
    const canonical = threadToJson(restored);
    expect(threadToJson(threadFromJson(canonical))).toBe(canonical);
    for (let i = 0; i < thread.messages.length; i += 1) {
      const original = thread.messages[i]!;
      const back = restored.messages[i]!;
      expect(back.role).toBe(original.role);
      expect(getTextContent(back)).toBe(getTextContent(original));
      if (original.role === "assistant" && back.role === "assistant") {
        expect(getToolCalls(back)).toEqual(getToolCalls(original));
      }
    }
  });
});

describe("muse importer — tool-calling session", () => {
  const warnings: string[] = [];
  const thread = importFromMuse(fixture(TOOLS), { onWarn: (m) => warnings.push(m) });

  it("keeps every call/result pair distinct and in order", () => {
    expect(thread.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    const callIds = thread.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m.role === "assistant" ? getToolCalls(m) : []))
      .map((c) => c.id);
    const resultIds = thread.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => (m.role === "tool" ? m.toolResults : []))
      .map((r) => r.toolCallId);
    expect(new Set(callIds).size).toBe(callIds.length);
    expect(resultIds).toEqual(callIds);
    expect(callIds).toEqual(
      runEvents(TOOLS, "assistant_tool_calls_committed").flatMap((event) =>
        (event["tool_calls"] as Array<{ call_id: string }>).map((call) => call.call_id),
      ),
    );
  });

  it("keeps the JSON-string args verbatim and also parses them", () => {
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    const [call] = getToolCalls(assistant);
    const source = (
      runEvents(TOOLS, "assistant_tool_calls_committed")[0]?.["tool_calls"] as Array<{
        args: string;
      }>
    )[0];
    expect(typeof source?.args).toBe("string"); // muse ships args as a JSON STRING
    expect(call?.arguments).toBe(source?.args);
    expect(call?.name).toBe("bash");
    expect(call?.parsedArguments?.["command"]).toContain("ls -la");
    expect(call?.parsedArguments?.["description"]).toBe("List workspace contents");
  });

  it("gives each assistant the usage of the response that produced it", () => {
    // Every model_completed here PRECEDES the content it describes while a
    // previous assistant message is already the most recent one: attributing
    // usage by adjacency instead of by response id lands it one message early.
    const completions = runEvents(TOOLS, "model_completed");
    const assistants = thread.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(completions.length);
    assistants.forEach((assistant, index) => {
      if (assistant.role !== "assistant") throw new Error("expected assistant");
      const raw = completions[index]?.["usage"] as Record<string, number>;
      expect(assistant.metadata?.["museTokenUsage"]).toEqual(raw);
      expect(assistant.usage?.outputTokens).toBe(raw["output_tokens"]);
      expect(assistant.usage?.cacheReadTokens).toBe(raw["cache_read_tokens"]);
      expect(assistant.usage?.inputTokens).toBe(
        raw["input_tokens"]! - raw["cache_read_tokens"]! - raw["cache_write_tokens"]!,
      );
    });
    // Ordered spot-check so a uniform off-by-one cannot satisfy the loop.
    expect(assistants.map((a) => (a.role === "assistant" ? a.usage?.outputTokens : undefined))).toEqual(
      [251, 226, 348],
    );
  });

  it("takes the git branch from the workspace_branch record", () => {
    expect(thread.metadata?.git).toEqual({ branch: "feat/muse-code-adapter" });
  });

  it("tolerates export gap markers and discloses them", () => {
    const gaps = sourceEvents(TOOLS).filter((event) => event.kind !== "record");
    expect(gaps.length).toBe(2);
    expect(warnings).toContain("muse: 2 export gap marker(s) carried no record to import");
  });

  it("treats a literal 'undefined' prompt as ordinary user text", () => {
    expect(getTextContent(thread.messages[0]!)).toBe("undefined");
  });

  it("round-trips through canonical thread JSON", () => {
    expect(threadFromJson(threadToJson(thread))).toEqual(thread);
  });
});

describe("muse importer — shapes not present in the probe corpus", () => {
  // Every reasoning event observed from muse 0.1.0 had empty `text` with the
  // content in `encrypted_content`. This pins the plaintext branch's behaviour.
  it("emits a reasoning part when muse supplies plaintext reasoning", () => {
    const document = JSON.parse(fixture(CHAT)) as {
      events: Array<{ envelope?: { payload?: { event?: Record<string, unknown> } } }>;
    };
    for (const event of document.events) {
      const runEvent = event.envelope?.payload?.event;
      if (runEvent?.["kind"] === "reasoning_committed") {
        runEvent["text"] = "checking the memory tool first";
      }
    }
    const thread = importFromMuse(JSON.stringify(document));
    const assistant = thread.messages.find((m) => m.role === "assistant");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content[0]?.type).toBe("reasoning");
    expect(getReasoning(assistant)).toBe("checking the memory tool first");
    expect(threadToJson(thread)).not.toContain("ENCRYPTED_REASONING_BLOB");
    expect(thread.metadata?.custom).toBeUndefined();
  });

  it("discloses usage from a response that committed no message rather than misattributing it", () => {
    const document = JSON.parse(fixture(CHAT)) as {
      events: Array<{ envelope?: { payload?: { event?: Record<string, unknown> } } }>;
    };
    // Drop the tool-call commit: its response then reports usage with nothing
    // to carry it. The earlier assistant must not absorb it.
    document.events = document.events.filter(
      (event) => event.envelope?.payload?.event?.["kind"] !== "assistant_tool_calls_committed",
    );
    const warnings: string[] = [];
    const thread = importFromMuse(JSON.stringify(document), {
      onWarn: (message) => warnings.push(message),
    });
    expect(thread.messages.map((m) => m.role)).toEqual([
      "user",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    const assistants = thread.messages.filter((m) => m.role === "assistant");
    for (const assistant of assistants) {
      if (assistant.role !== "assistant") throw new Error("expected assistant");
      expect(assistant.usage?.outputTokens).not.toBe(572); // the orphaned response
    }
    expect(warnings).toContain(
      "muse: 1 model response(s) reported usage but committed no message; that usage is not represented",
    );
  });

  it("rejects json that is not a muse export", () => {
    expect(() => importFromMuse('{"foo":1}')).toThrow(/Not a Muse Code session export/);
    expect(() => importFromMuse("not json")).toThrow(/Not a Muse Code session export/);
    expect(() => importFromMuse(fixture("opencode-export.json"))).toThrow(
      /Not a Muse Code session export/,
    );
  });

  it("fails loudly on an export whose events carry nothing importable", () => {
    expect(() =>
      importFromMuse(
        JSON.stringify({
          export_schema_version: 1,
          sessions: [{ session_id: "s1" }],
          events: [
            {
              kind: "record",
              envelope: {
                id: "e1",
                recorded_at: 1786302330653229,
                payload_type: "runtime.session.metadata",
                payload: { kind: "metadata", record: { workspace_root: "/workspace" } },
              },
            },
          ],
        }),
      ),
    ).toThrow(/no importable messages/);
  });
});

describe("muse detection", () => {
  it("detects both muse exports", () => {
    expect(detectFormat(fixture(CHAT))).toBe("muse");
    expect(detectFormat(fixture(TOOLS))).toBe("muse");
  });

  it("does not claim another tool's export", () => {
    expect(detectFormat(fixture("opencode-export.json"))).toBe("opencode");
    expect(detectFormat(fixture("chatgpt-conversations.json"))).toBe("chatgpt-export");
    expect(detectFormat(fixture("claude-code-session.jsonl"))).toBe("claude-code");
    expect(detectFormat(fixture("codex-rollout.jsonl"))).toBe("codex");
    expect(detectFormat(fixture("kiro-session.jsonl"))).toBe("kiro");
    expect(detectFormat(fixture("pi-session.jsonl"))).toBe("pi");
    // A canonical thread export also has messages and a version-ish field.
    const canonical = threadToJson(importFromMuse(fixture(CHAT)));
    expect(detectFormat(canonical)).toBe("thread");
  });

  it("does not claim a foreign document that merely has an events array", () => {
    expect(
      detectFormat(
        JSON.stringify({ export_schema_version: 1, events: [{ type: "click", ts: 1 }] }),
      ),
    ).toBeUndefined();
    expect(detectFormat(JSON.stringify({ events: [], sessions: [] }))).toBeUndefined();
    expect(
      detectFormat(JSON.stringify({ export_schema_version: "1", events: [], sessions: [] })),
    ).toBeUndefined();
  });

  it("routes through the shared import dispatch", () => {
    const [thread] = importThreads(fixture(TOOLS), "muse");
    expect(thread?.metadata?.source).toBe("muse");
    expect(thread?.messages).toHaveLength(6);
  });
});
