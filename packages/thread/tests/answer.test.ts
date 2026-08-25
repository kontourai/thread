import { describe, expect, it } from "vitest";

import {
  AssistantAnswerProjectionOutcome,
  MAX_SAFE_ASSISTANT_ANSWER_BYTES,
  MAX_SAFE_ASSISTANT_ANSWER_PARTS,
  MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES,
  MAX_SAFE_ASSISTANT_ANSWER_PART_TYPE_CODE_UNITS,
  SafeAssistantAnswerProjection,
  THREAD_ANSWER_REF_AUTHORITY,
  ThreadAnswerRef,
  createObservedMessageIdentity,
  createThreadAnswerRef,
  isThreadAnswerRef,
  parseThreadAnswerRef,
  projectAssistantAnswer,
  threadAnswerRefKey,
} from "../src/answer.js";
import { THREAD_SCHEMA_VERSION } from "../src/schema.js";

const observed = createObservedMessageIdentity("thread-1", "message-1");
const ref = createThreadAnswerRef(observed);
const assistant = (content: unknown[], overrides: Record<string, unknown> = {}) => ({
  id: "message-1",
  threadId: "thread-1",
  role: "assistant",
  timestamp: 1,
  content,
  ...overrides,
});

describe("ThreadAnswerRef", () => {
  it("requires exact owner-issued fields and makes thread scope part of identity", () => {
    expect(ref).toEqual({
      authority: "@kontourai/thread",
      schemaVersion: THREAD_SCHEMA_VERSION,
      kind: "assistant-message",
      standing: "observed",
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(THREAD_ANSWER_REF_AUTHORITY).toBe("@kontourai/thread");
    expect(threadAnswerRefKey(ref)).not.toBe(threadAnswerRefKey(createThreadAnswerRef(createObservedMessageIdentity("thread-2", "message-1"))));
    expect(parseThreadAnswerRef(ref)).toEqual(ref);
    expect(isThreadAnswerRef(ref)).toBe(true);
  });

  it("rejects unknown keys, incorrect versions, blank or oversized IDs, and malformed Unicode", () => {
    expect(() => ThreadAnswerRef.parse({ ...ref, extra: true })).toThrow();
    expect(() => ThreadAnswerRef.parse({ ...ref, schemaVersion: "1.2.1" })).toThrow();
    expect(() => createObservedMessageIdentity("", "message")).toThrow();
    expect(() => createObservedMessageIdentity("thread", "x".repeat(4097))).toThrow();
    expect(() => createObservedMessageIdentity("\ud800", "message")).toThrow();
    expect(isThreadAnswerRef({ ...ref, unknown: "no" })).toBe(false);
    expect(isThreadAnswerRef({ ...ref, standing: "synthetic" })).toBe(false);
    expect(() => parseThreadAnswerRef({ ...ref, standing: "synthetic" })).toThrow();
  });

  it("is total and does not execute hostile ref getters or proxy gets", () => {
    let getterCalls = 0;
    const accessor = { ...ref, get threadId() { getterCalls += 1; throw new Error("must not run"); } };
    const proxy = new Proxy({}, {
      get() { getterCalls += 1; throw new Error("must not run"); },
      getOwnPropertyDescriptor() { throw new Error("descriptor trap"); },
    });
    expect(isThreadAnswerRef(accessor)).toBe(false);
    expect(isThreadAnswerRef(proxy)).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("preserves opaque Unicode ID bytes without path or percent semantics", () => {
    const lower = createThreadAnswerRef(createObservedMessageIdentity("https://source/%2f", "a/../b%2f"));
    const upper = createThreadAnswerRef(createObservedMessageIdentity("https://source/%2F", "a/../b%2F"));
    expect(lower.threadId).toBe("https://source/%2f");
    expect(lower.messageId).toBe("a/../b%2f");
    expect(threadAnswerRefKey(lower)).not.toBe(threadAnswerRefKey(upper));
  });
});

describe("projectAssistantAnswer", () => {
  it("projects ordered visible text only and leaves markup, HTML, and URLs inert", () => {
    const outcome = projectAssistantAnswer(
      ref,
      assistant([
        { type: "reasoning", reasoning: { type: "reasoning", text: "private thought" } },
        { type: "text", text: "# Answer <img src=x onerror=alert(1)> https://example.test" },
        { type: "tool_call", toolCall: { id: "call", name: "shell", arguments: "rm -rf /" } },
        { type: "text", text: "second" },
        { type: "image", image: { type: "image", data: "base64-private", mediaType: "image/png" } },
      ], {
        metadata: { private: "no", annotation: { url: "https://private.example" } },
        model: "private-model",
        provider: "private-provider",
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    );
    expect(outcome).toEqual({
      state: "available",
      answer: {
        ref,
        content: [
          { type: "text", text: "# Answer <img src=x onerror=alert(1)> https://example.test" },
          { type: "text", text: "second" },
        ],
        truncated: false,
        omittedParts: 0,
        omittedTextBytes: 0,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("private thought");
    expect(JSON.stringify(outcome)).not.toContain("rm -rf /");
    expect(JSON.stringify(outcome)).not.toContain("base64-private");
    expect(JSON.stringify(outcome)).not.toContain("private.example");
    expect(JSON.stringify(outcome)).not.toContain("private-model");
  });

  it("is total for bad input and only accepts the exact assistant message", () => {
    const cases: Array<[unknown, unknown, AssistantAnswerProjectionOutcome]> = [
      [{ ...ref, schemaVersion: "wrong" }, assistant([{ type: "text", text: "x" }]), { state: "unavailable", reason: "invalid-reference" }],
      [ref, { nope: true }, { state: "unavailable", reason: "invalid-message" }],
      [ref, { id: "message-1", threadId: "thread-1", role: "user", timestamp: 1, content: [] }, { state: "unavailable", reason: "not-assistant" }],
      [ref, assistant([{ type: "text", text: "x" }], { id: "other" }), { state: "unavailable", reason: "reference-mismatch" }],
      [ref, assistant([{ type: "text", text: "\ud800" }]), { state: "unavailable", reason: "corrupt-content" }],
      [ref, assistant([{ type: "reasoning", reasoning: { type: "reasoning", text: "secret" } }]), { state: "unavailable", reason: "no-safe-answer-text" }],
      [ref, assistant([{ type: "text", text: "" }]), { state: "unavailable", reason: "no-safe-answer-text" }],
    ];
    for (const [inputRef, inputMessage, expected] of cases) {
      expect(projectAssistantAnswer(inputRef, inputMessage)).toEqual(expected);
    }
  });

  it("accounts exactly for per-part capacity loss without counting intentional exclusions", () => {
    const oversized = `${"a".repeat(MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES - 1)}😀`;
    const outcome = projectAssistantAnswer(
      ref,
      assistant([
        { type: "reasoning", reasoning: { type: "reasoning", text: "do not count" } },
        { type: "tool_call", toolCall: { id: "call", name: "tool", arguments: "private" } },
        { type: "text", text: oversized },
        { type: "text", text: "tail" },
      ]),
    );
    expect(outcome.state).toBe("available");
    if (outcome.state !== "available") return;
    expect(outcome.answer.content[0]).toEqual({ type: "text", text: "a".repeat(16 * 1024) });
    expect(outcome.answer.content[1]).toEqual({ type: "text", text: "tail" });
    expect(outcome.answer.omittedParts).toBe(0);
    expect(outcome.answer.omittedTextBytes).toBe(3 * 16 * 1024 + 3);
    expect(outcome.answer.truncated).toBe(true);
  });

  it("accounts exactly for total text capacity loss", () => {
    const outcome = projectAssistantAnswer(
      ref,
      assistant([
        ...Array.from({ length: 4 }, () => ({ type: "text", text: "a".repeat(16 * 1024) })),
        { type: "text", text: "tail" },
      ]),
    );
    expect(outcome).toEqual({
      state: "available",
      answer: expect.objectContaining({
        content: Array.from({ length: 4 }, () => ({ type: "text", text: "a".repeat(16 * 1024) })),
        truncated: true,
        omittedParts: 1,
        omittedTextBytes: 4,
      }),
    });
  });

  it("caps visible items and reports exactly the source text removed by that cap", () => {
    const outcome = projectAssistantAnswer(
      ref,
      assistant(Array.from({ length: MAX_SAFE_ASSISTANT_ANSWER_PARTS + 2 }, (_, index) => ({ type: "text", text: `p${index}` }))),
    );
    expect(outcome.state).toBe("available");
    if (outcome.state !== "available") return;
    expect(outcome.answer.content).toHaveLength(MAX_SAFE_ASSISTANT_ANSWER_PARTS);
    expect(outcome.answer.content[0]).toEqual({ type: "text", text: "p0" });
    expect(outcome.answer.omittedParts).toBe(2);
    expect(outcome.answer.omittedTextBytes).toBe("p32".length + "p33".length);
    expect(outcome.answer.truncated).toBe(true);
  });

  it("never splits emoji and remains deterministic for huge hostile text", () => {
    const message = assistant([{ type: "text", text: `${"😀".repeat(20_000)}tail` }]);
    const first = projectAssistantAnswer(ref, message);
    const second = projectAssistantAnswer(ref, message);
    expect(first).toEqual(second);
    expect(first.state).toBe("available");
    if (first.state !== "available") return;
    expect(first.answer.content[0]!.text.endsWith("😀")).toBe(true);
    expect(SafeAssistantAnswerProjection.parse(first.answer)).toEqual(first.answer);
  });

  it("enforces the strict public output cap and does not accept metadata", () => {
    const safe = {
      ref,
      content: [{ type: "text" as const, text: "ok" }],
      truncated: false,
      omittedParts: 0,
      omittedTextBytes: 0,
    };
    expect(SafeAssistantAnswerProjection.parse(safe)).toEqual(safe);
    expect(() => SafeAssistantAnswerProjection.parse({ ...safe, metadata: {} })).toThrow();
    expect(() => SafeAssistantAnswerProjection.parse({ ...safe, content: [{ type: "text", text: "x".repeat(16 * 1024 + 1) }] })).toThrow();
    expect(() => SafeAssistantAnswerProjection.parse({ ...safe, content: [{ type: "text", text: "x".repeat(MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES + 1) }] })).toThrow();
    expect(MAX_SAFE_ASSISTANT_ANSWER_BYTES).toBeGreaterThan(MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES);
  });

  it("is total and projection-bounded for hostile reflective inputs", () => {
    let getterCalls = 0;
    const rootAccessor = {
      get id() { getterCalls += 1; throw new Error("must not run"); },
      threadId: "thread-1", role: "assistant", content: [],
    };
    const rootProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("must not run"); } });
    const partProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("must not run"); } });
    const excluded = {
      type: "tool_call",
      toolCall: {
        get arguments() { getterCalls += 1; throw new Error("must not run"); },
        raw: "x".repeat(8 * 1024 * 1024),
        huge: new Array(1_000_000).fill({ nested: "ignored" }),
      },
    };
    const metadata = {
      raw: "x".repeat(8 * 1024 * 1024),
      get private() { getterCalls += 1; throw new Error("must not run"); },
    };

    expect(projectAssistantAnswer(ref, rootAccessor)).toEqual({ state: "unavailable", reason: "invalid-message" });
    expect(projectAssistantAnswer(ref, rootProxy)).toEqual({ state: "unavailable", reason: "invalid-message" });
    expect(projectAssistantAnswer(ref, assistant([partProxy]))).toEqual({ state: "unavailable", reason: "corrupt-content" });
    expect(projectAssistantAnswer(ref, assistant([excluded], { metadata }))).toEqual({ state: "unavailable", reason: "no-safe-answer-text" });
    expect(projectAssistantAnswer(ref, assistant(new Array(257).fill({ type: "text", text: "x" })))).toEqual({ state: "unavailable", reason: "input-over-budget" });
    expect(projectAssistantAnswer(ref, assistant([{ type: "text", text: "x".repeat(256 * 1024 + 1) }]))).toEqual({ state: "unavailable", reason: "input-over-budget" });
    expect(projectAssistantAnswer(ref, assistant([{ type: "x".repeat(MAX_SAFE_ASSISTANT_ANSWER_PART_TYPE_CODE_UNITS + 1), ignored: "x".repeat(8 * 1024 * 1024) }]))).toEqual({ state: "unavailable", reason: "corrupt-content" });
    expect(getterCalls).toBe(0);
  });
});
