import { describe, expect, it } from "vitest";
import {
  AssistantMessage,
  createAssistantMessage,
  createThread,
  createToolMessage,
  createUserMessage,
  getReasoning,
  getTextContent,
  getToolCalls,
  isAssistantMessage,
  isToolMessage,
  isUserMessage,
  Message,
  Thread,
  THREAD_SCHEMA_VERSION,
  threadFromJson,
  threadToJson,
} from "../src/index.js";

describe("message schemas", () => {
  it("accepts a full assistant message with reasoning, tool call, usage", () => {
    const msg = {
      id: "m1",
      threadId: "t1",
      role: "assistant",
      timestamp: 1700000000000,
      content: [
        { type: "reasoning", reasoning: { type: "reasoning", text: "think", signature: "sig" } },
        { type: "text", text: "hello" },
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "bash", arguments: '{"command":"ls"}' },
        },
      ],
      model: "claude-sonnet-5",
      provider: "anthropic",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      finishReason: "tool_calls",
    };
    const parsed = AssistantMessage.parse(msg);
    expect(getToolCalls(parsed)).toHaveLength(1);
    expect(getReasoning(parsed)).toBe("think");
    expect(getTextContent(parsed)).toBe("hello");
  });

  it("rejects unknown roles via the discriminated union", () => {
    expect(() =>
      Message.parse({ id: "m", threadId: "t", role: "narrator", timestamp: 1, content: [] }),
    ).toThrow();
  });

  it("rejects empty ids", () => {
    expect(() =>
      Message.parse({ id: "", threadId: "t", role: "user", timestamp: 1, content: [] }),
    ).toThrow();
  });
});

describe("factories", () => {
  it("builds user messages from plain strings", () => {
    const msg = createUserMessage("t1", "hi");
    expect(isUserMessage(msg)).toBe(true);
    expect(getTextContent(msg)).toBe("hi");
    expect(Message.parse(msg)).toBeTruthy();
  });

  it("builds tool messages that validate", () => {
    const msg = createToolMessage("t1", [
      { toolCallId: "c1", name: "bash", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(isToolMessage(msg)).toBe(true);
    expect(Message.parse(msg)).toBeTruthy();
  });

  it("derives thread created/updated from message timestamps", () => {
    const a = { ...createUserMessage("t", "x"), timestamp: 1000 };
    const b = { ...createAssistantMessage("t", [{ type: "text", text: "y" }]), timestamp: 2000 };
    const thread = createThread([a, b]);
    expect(thread.createdAt).toBe(1000);
    expect(thread.updatedAt).toBe(2000);
    expect(thread.schemaVersion).toBe(THREAD_SCHEMA_VERSION);
    expect(Thread.parse(thread)).toBeTruthy();
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createUserMessage("t", "x").id));
    expect(ids.size).toBe(1000);
  });
});

describe("json round trip", () => {
  it("survives serialize → parse byte-stable", () => {
    const thread = createThread(
      [
        createUserMessage("t", "question"),
        createAssistantMessage("t", [
          { type: "text", text: "answer" },
          { type: "tool_call", toolCall: { id: "c9", name: "read", arguments: "{}" } },
        ]),
      ],
      { source: "test", title: "Round trip", git: { branch: "main" } },
    );
    const json = threadToJson(thread);
    const back = threadFromJson(json);
    expect(back).toEqual({ ...thread, schemaVersion: THREAD_SCHEMA_VERSION });
    // Zod canonicalizes key order on parse, so byte stability holds from the
    // first parsed generation onward.
    const canonical = threadToJson(back);
    expect(threadToJson(threadFromJson(canonical))).toBe(canonical);
  });

  it("stamps schemaVersion on serialization even when absent", () => {
    const thread = { ...createThread([]), schemaVersion: undefined };
    const parsed = JSON.parse(threadToJson(thread));
    expect(parsed.schemaVersion).toBe(THREAD_SCHEMA_VERSION);
  });

  it("rejects structurally invalid thread JSON", () => {
    expect(() => threadFromJson('{"id":"x","messages":[{"role":"user"}]}')).toThrow();
  });

  it("guards helpers narrow correctly", () => {
    const msgs = [
      createUserMessage("t", "u"),
      createAssistantMessage("t", [{ type: "text", text: "a" }]),
    ];
    expect(msgs.filter(isAssistantMessage)).toHaveLength(1);
  });
});
