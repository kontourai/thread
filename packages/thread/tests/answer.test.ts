import { describe, expect, it } from "vitest";

import {
  AssistantAnswerProjectionOutcome,
  MAX_SAFE_ASSISTANT_ANSWER_BYTES,
  MAX_SAFE_ASSISTANT_ANSWER_PARTS,
  MAX_SAFE_ASSISTANT_ANSWER_TEXT_BYTES,
  SafeAssistantAnswerProjection,
  THREAD_ANSWER_REF_AUTHORITY,
  THREAD_SCHEMA_VERSION,
  ThreadAnswerRef,
  createThreadAnswerRef,
  isThreadAnswerRef,
  parseThreadAnswerRef,
  projectAssistantAnswer,
  threadAnswerRefKey,
} from "../src/index.js";

const ref = createThreadAnswerRef("thread-1", "message-1");
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
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(THREAD_ANSWER_REF_AUTHORITY).toBe("@kontourai/thread");
    expect(threadAnswerRefKey(ref)).not.toBe(threadAnswerRefKey(createThreadAnswerRef("thread-2", "message-1")));
    expect(parseThreadAnswerRef(ref)).toEqual(ref);
    expect(isThreadAnswerRef(ref)).toBe(true);
  });

  it("rejects unknown keys, incorrect versions, blank or oversized IDs, and malformed Unicode", () => {
    expect(() => ThreadAnswerRef.parse({ ...ref, extra: true })).toThrow();
    expect(() => ThreadAnswerRef.parse({ ...ref, schemaVersion: "1.2.1" })).toThrow();
    expect(() => createThreadAnswerRef("", "message")).toThrow();
    expect(() => createThreadAnswerRef("thread", "x".repeat(4097))).toThrow();
    expect(() => createThreadAnswerRef("\ud800", "message")).toThrow();
    expect(isThreadAnswerRef({ ...ref, unknown: "no" })).toBe(false);
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
});
