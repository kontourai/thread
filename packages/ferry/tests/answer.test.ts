import { describe, expect, it } from "vitest";
import { createThreadAnswerRef } from "@kontourai/thread/answer";

import { ferryMessageIdentityObservation } from "../src/index.js";

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
});
