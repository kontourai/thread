import { describe, expect, it } from "vitest";
import { createThreadAnswerRef } from "@kontourai/thread/answer";

import {
  ferryMessageIdentityObservation,
  findObservedMessageIdentity,
  importThreads,
  importThreadsWithIdentityObservations,
  normalizeMessageIdentityObservations,
} from "../src/index.js";

describe("Ferry answer-reference identity standing", () => {
  it("never promotes Codex or other adapter fallback IDs", () => {
    const codexFallback = ferryMessageIdentityObservation(
      { threadId: "codex-session", id: "codex-session:1" } as never,
      undefined,
    );
    const otherFallback = ferryMessageIdentityObservation(
      { threadId: "session", id: "session:2" } as never,
      { threadId: "source-session", messageId: "source-message" },
    );
    expect(codexFallback.standing).toBe("adapter-fallback");
    expect(otherFallback.standing).toBe("adapter-fallback");
    expect(() => createThreadAnswerRef(codexFallback as never)).toThrow();
    expect(() => createThreadAnswerRef(otherFallback as never)).toThrow();
  });

  it("permits only an exact byte-observed source tuple", () => {
    const message = { threadId: "source%2Fthread", id: "message%2f1" } as never;
    const identity = ferryMessageIdentityObservation(message, {
      threadId: "source%2Fthread",
      messageId: "message%2f1",
    });
    expect(identity.standing).toBe("observed");
    if (identity.standing !== "observed") throw new Error("expected observed identity");
    expect(createThreadAnswerRef(identity)).toMatchObject({
      standing: "observed", threadId: "source%2Fthread", messageId: "message%2f1",
    });
  });

  it("returns a serializable, tuple-addressable side channel without changing Thread[] compatibility", () => {
    const source = JSON.stringify([{
      id: "conversation-1", create_time: 1, update_time: 2, mapping: {
        root: { id: "root", parent: null, children: ["answer"], message: null },
        answer: { id: "answer", parent: "root", children: [], message: {
          id: "message-1", author: { role: "assistant" }, create_time: 2,
          content: { content_type: "text", parts: ["hello"] },
        } },
      }, current_node: "answer",
    }]);
    const result = importThreadsWithIdentityObservations(source, "chatgpt-export");
    expect(importThreads(source, "chatgpt-export")).toEqual(result.threads);
    expect(JSON.parse(JSON.stringify(result.messageIdentityObservations))).toEqual(result.messageIdentityObservations);
    const observed = findObservedMessageIdentity(result.messageIdentityObservations, "conversation-1", "message-1");
    expect(observed?.standing).toBe("observed");
    if (observed) expect(createThreadAnswerRef(observed).messageId).toBe("message-1");
  });

  it("preserves deterministic mixed observed and fallback observations across threads", () => {
    const observedConversation = {
      id: "observed-thread", mapping: {
        leaf: { id: "leaf", parent: null, children: [], message: {
          id: "observed-message", author: { role: "assistant" }, create_time: 1,
          content: { content_type: "text", parts: ["observed"] },
        } },
      }, current_node: "leaf",
    };
    const fallbackConversation = {
      mapping: {
        leaf: { id: "leaf", parent: null, children: [], message: {
          id: "fallback-message", author: { role: "assistant" }, create_time: 2,
          content: { content_type: "text", parts: ["fallback"] },
        } },
      }, current_node: "leaf",
    };
    const result = importThreadsWithIdentityObservations(
      JSON.stringify([observedConversation, fallbackConversation]), "chatgpt-export",
    );
    expect(result.threads.map((thread) => thread.id)).toEqual(["observed-thread", "chatgpt-2"]);
    expect(result.messageIdentityObservations.map((item) => item.standing)).toEqual(["observed", "adapter-fallback"]);
  });

  it("keeps Codex generated messages fallback and fails closed for duplicate, absent, or malformed data", () => {
    const codex = [
      JSON.stringify({ type: "session_meta", payload: { id: "session-1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "source-message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } }),
    ].join("\n");
    const result = importThreadsWithIdentityObservations(codex, "codex");
    expect(result.messageIdentityObservations).toHaveLength(1);
    expect(result.messageIdentityObservations[0]?.standing).toBe("adapter-fallback");
    expect(findObservedMessageIdentity(result.messageIdentityObservations, "session-1", "session-1:1")).toBeUndefined();
    const duplicate = normalizeMessageIdentityObservations([
      ferryMessageIdentityObservation({ threadId: "t", id: "m" } as never, { threadId: "t", messageId: "m" }),
      ferryMessageIdentityObservation({ threadId: "t", id: "m" } as never, { threadId: "t", messageId: "m" }),
    ]);
    expect(duplicate[0]?.standing).toBe("adapter-fallback");
    expect(findObservedMessageIdentity(undefined, "t", "m")).toBeUndefined();
    expect(findObservedMessageIdentity([{ nope: true }], "t", "m")).toBeUndefined();
  });
});
