import { describe, expect, it } from "vitest";
import { aggregateUsage, type AssistantMessage, type Thread } from "../src/index.js";

const dayOne = Date.parse("2026-08-01T00:00:00.000Z");
const dayTwo = Date.parse("2026-08-02T00:00:00.000Z");

function assistant(
  id: string,
  threadId: string,
  timestamp: number,
  model?: string,
  usage?: AssistantMessage["usage"],
): AssistantMessage {
  return { id, threadId, timestamp, role: "assistant", content: [], model, usage };
}

const threads: Thread[] = [
  {
    id: "thread-b",
    createdAt: dayOne,
    updatedAt: dayTwo,
    messages: [
      assistant("one", "thread-b", dayOne, "beta", {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      }),
      assistant("two", "thread-b", dayOne + 1, "alpha"),
      assistant("three", "thread-b", dayTwo, "alpha", {
        inputTokens: 5,
        outputTokens: 3,
        reasoningTokens: 2,
      }),
    ],
  },
  {
    id: "thread-a",
    createdAt: dayTwo,
    updatedAt: dayTwo,
    messages: [
      assistant("four", "thread-a", dayTwo, undefined, {
        inputTokens: 7,
        outputTokens: 6,
        reasoningTokens: 1,
        cacheReadTokens: 4,
      }),
    ],
  },
];

describe("aggregateUsage", () => {
  it("sums canonical assistant usage by model and exposes missing-usage coverage", () => {
    expect(aggregateUsage(threads, { by: "model" })).toEqual([
      {
        key: "alpha",
        messages: 1,
        messagesWithoutUsage: 1,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
      },
      {
        key: "beta",
        messages: 1,
        messagesWithoutUsage: 0,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      {
        key: "unknown",
        messages: 1,
        messagesWithoutUsage: 0,
        inputTokens: 7,
        outputTokens: 6,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
      },
    ]);
  });

  it("buckets deterministically by UTC day and thread", () => {
    expect(aggregateUsage(threads, { by: "day" }).map((bucket) => bucket.key)).toEqual([
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(aggregateUsage(threads, { by: "thread" }).map((bucket) => bucket.key)).toEqual([
      "thread-a",
      "thread-b",
    ]);
  });

  it("includes a message exactly at the inclusive window boundary", () => {
    expect(aggregateUsage(threads, { by: "model", since: dayTwo })).toEqual([
      {
        key: "alpha",
        messages: 1,
        messagesWithoutUsage: 0,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
      },
      {
        key: "unknown",
        messages: 1,
        messagesWithoutUsage: 0,
        inputTokens: 7,
        outputTokens: 6,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
      },
    ]);
  });
});
