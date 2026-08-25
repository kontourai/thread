import { describe, expect, it } from "vitest";
import {
  AssistantMessage,
  createToolResult,
  createAssistantMessage,
  createThread,
  createToolMessage,
  createUserMessage,
  getReasoning,
  getTextContent,
  getToolCalls,
  isAssistantMessage,
  isIdentifiedToolResult,
  isToolMessage,
  isUserMessage,
  Message,
  projectToolResult,
  Thread,
  ToolResult,
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

describe("tool result identity", () => {
  const legacy = {
    toolCallId: "call-1",
    name: "read_file",
    content: [{ type: "text" as const, text: "stored exactly" }],
  };

  const identified = (terminalStatus: "success" | "error" | "cancelled" | "unknown") => ({
    ...legacy,
    resultId: `result-${terminalStatus}`,
    terminalStatus,
  });

  it("keeps legacy results valid but makes them unavailable for dereference", () => {
    const result = ToolResult.parse(legacy);
    expect(isIdentifiedToolResult(result)).toBe(false);
    expect(projectToolResult(result)).toEqual({
      state: "unavailable",
      reason: "identity-not-captured",
    });
  });

  it("accepts every owner-issued terminal status", () => {
    for (const status of ["success", "error", "cancelled", "unknown"] as const) {
      const result = ToolResult.parse(identified(status));
      expect(isIdentifiedToolResult(result)).toBe(true);
      expect(result.terminalStatus).toBe(status);
    }
  });

  it("requires result identity and status together without generating either", () => {
    expect(() => ToolResult.parse({ ...legacy, resultId: "result-1" })).toThrow();
    expect(() => ToolResult.parse({ ...legacy, terminalStatus: "success" })).toThrow();
    expect(() =>
      createToolResult({ ...legacy, resultId: "result-1" } as never),
    ).toThrow();

    const result = createToolResult({ ...identified("cancelled") });
    expect(result.resultId).toBe("result-cancelled");
    expect(result.terminalStatus).toBe("cancelled");
  });

  it("enforces identified-result invariants", () => {
    expect(() => ToolResult.parse({ ...identified("success"), resultId: "call-1" })).toThrow();
    expect(() =>
      ToolResult.parse({ ...legacy, authorityDecision: { decision: "denied", authority: "policy" } }),
    ).toThrow();
    expect(() =>
      ToolResult.parse({
        ...legacy,
        correlations: [{ namespace: "source", kind: "event", id: "event-1" }],
      }),
    ).toThrow();
    expect(() =>
      ToolResult.parse({
        ...identified("success"),
        authorityDecision: { decision: "denied", authority: "policy" },
      }),
    ).toThrow();
    expect(() => ToolResult.parse({ ...identified("success"), isError: true })).toThrow();
    expect(() => ToolResult.parse({ ...identified("error"), isError: false })).toThrow();
  });

  it("bounds and deduplicates correlations", () => {
    const correlation = { namespace: "source", kind: "event" as const, id: "event-1" };
    expect(() =>
      ToolResult.parse({ ...identified("unknown"), correlations: [correlation, correlation] }),
    ).toThrow();
    expect(() =>
      ToolResult.parse({
        ...identified("unknown"),
        correlations: Array.from({ length: 17 }, (_, index) => ({
          namespace: "source",
          kind: "event" as const,
          id: `event-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      ToolResult.parse({
        ...identified("unknown"),
        resultId: "x".repeat(4097),
      }),
    ).toThrow();
    expect(() =>
      ToolResult.parse({
        ...identified("unknown"),
        correlations: [{ namespace: "x".repeat(4097), kind: "event", id: "event-1" }],
      }),
    ).toThrow();
  });

  it("rejects a result ID reused across tool messages in one thread", () => {
    const first = {
      ...createToolMessage("t", [{ ...identified("success"), resultId: "result-shared" }]),
      timestamp: 1,
    };
    const second = {
      ...createToolMessage("t", [{ ...identified("cancelled"), resultId: "result-shared" }]),
      timestamp: 2,
    };
    expect(() =>
      Thread.parse({ id: "t", messages: [first, second], createdAt: 1, updatedAt: 2 }),
    ).toThrow();
  });

  it("projects identified results without exposing executable or payload-bearing data", () => {
    const result = ToolResult.parse({
      toolCallId: "call-1",
      resultId: "result-1",
      terminalStatus: "error",
      name: "x".repeat(300),
      isError: true,
      authorityDecision: { decision: "denied", authority: "station", policyId: "policy-7" },
      correlations: [{ namespace: "station", kind: "turn", id: "turn-4" }],
      structuredResult: { internalValue: "do-not-project" },
      content: [
        { type: "text", text: "visible", annotations: { sourceUrl: "https://private.example" } },
        { type: "image", data: "data:image/png;base64,private", mediaType: "image/png" },
        {
          type: "file",
          name: "../private.txt",
          mediaType: "text/plain",
          data: "file:///private.txt",
          size: 7,
        },
      ],
    });
    const projected = projectToolResult(result);
    expect(projected).toEqual({
      state: "available",
      result: {
        resultId: "result-1",
        name: "x".repeat(256),
        terminalStatus: "error",
        authorityDecision: { decision: "denied", authority: "station", policyId: "policy-7" },
        correlations: [{ namespace: "station", kind: "turn", id: "turn-4" }],
        content: [
          { type: "text", text: "visible" },
          { type: "image", mediaType: "image/png" },
          { type: "file", name: "file", mediaType: "text/plain", size: 7 },
        ],
        truncated: false,
        omittedParts: 0,
        omittedTextBytes: 0,
      },
    });
    expect(JSON.stringify(projected)).not.toContain("call-1");
    expect(JSON.stringify(projected)).not.toContain("private.example");
    expect(JSON.stringify(projected)).not.toContain("file:///private.txt");
  });

  it("bounds projection parts and text bytes without splitting emoji", () => {
    const oversizedText = `${"a".repeat(65535)}😀`;
    const result = ToolResult.parse({
      ...identified("unknown"),
      content: [
        { type: "text", text: oversizedText },
        ...Array.from({ length: 32 }, (_, index) => ({ type: "text" as const, text: `tail-${index}` })),
      ],
    });
    const projected = projectToolResult(result);
    expect(projected.state).toBe("available");
    if (projected.state !== "available") return;
    expect(projected.result.content).toHaveLength(32);
    expect(projected.result.content[0]).toEqual({ type: "text", text: "a".repeat(65535) });
    expect(projected.result.truncated).toBe(true);
    expect(projected.result.omittedParts).toBe(1);
    expect(projected.result.omittedTextBytes).toBe(217);
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

  it("round-trips identified result content without projection loss", () => {
    const message = {
      ...createToolMessage("t", [
        {
          toolCallId: "call-1",
          resultId: "result-1",
          terminalStatus: "success" as const,
          name: "read",
          content: [
            { type: "text" as const, text: "verbatim", annotations: { trace: "kept" } },
            { type: "image" as const, data: "data:image/png;base64,bytes", mediaType: "image/png" },
          ],
          structuredResult: { raw: { value: true } },
        },
      ]),
      timestamp: 1,
    };
    const thread = createThread([message], undefined, { id: "t", createdAt: 1, updatedAt: 1 });
    expect(threadFromJson(threadToJson(thread))).toEqual(thread);
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
