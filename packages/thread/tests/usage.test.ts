import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  type AssistantMessage,
  createUsageAccumulator,
  type Thread,
  THREAD_SCHEMA_VERSION,
} from "../src/index.js";

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
        duplicatesSkipped: 0,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
        reasoningMessages: 1,
      },
      {
        key: "beta",
        messages: 1,
        messagesWithoutUsage: 0,
        duplicatesSkipped: 0,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      {
        key: "unknown",
        messages: 1,
        messagesWithoutUsage: 0,
        duplicatesSkipped: 0,
        inputTokens: 7,
        outputTokens: 6,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
        reasoningMessages: 1,
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
        duplicatesSkipped: 0,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
        reasoningMessages: 1,
      },
      {
        key: "unknown",
        messages: 1,
        messagesWithoutUsage: 0,
        duplicatesSkipped: 0,
        inputTokens: 7,
        outputTokens: 6,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
        reasoningMessages: 1,
      },
    ]);
  });

  it("does not double count assistant messages from overlapping thread imports", () => {
    expect(aggregateUsage([threads[0]!, threads[0]!], { by: "model" })).toEqual([
      {
        key: "alpha",
        messages: 1,
        messagesWithoutUsage: 1,
        duplicatesSkipped: 2,
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
        reasoningMessages: 1,
      },
      {
        key: "beta",
        messages: 1,
        messagesWithoutUsage: 0,
        duplicatesSkipped: 1,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    ]);
  });

  it("counts two different threads with identical message ids separately", () => {
    const twin = (threadId: string): Thread => ({
      id: threadId,
      createdAt: dayOne,
      updatedAt: dayOne,
      messages: [
        assistant("same-id", threadId, dayOne, "alpha", {
          inputTokens: 3,
          outputTokens: 2,
        }),
      ],
    });
    const [bucket] = aggregateUsage([twin("t1"), twin("t2")], { by: "model" });
    expect(bucket).toMatchObject({
      key: "alpha",
      messages: 2,
      duplicatesSkipped: 0,
      inputTokens: 6,
      outputTokens: 4,
    });
  });

  // Review T-1a: two usage-bearing messages in ONE bucket — a
  // replace-instead-of-sum defect must redden here.
  it("sums multiple usage-bearing messages inside one bucket", () => {
    const thread: Thread = {
      id: "sum-thread",
      createdAt: dayOne,
      updatedAt: dayOne,
      messages: [
        assistant("s1", "sum-thread", dayOne, "gamma", {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          reasoningTokens: 5,
        }),
        assistant("s2", "sum-thread", dayOne + 1, "gamma", {
          inputTokens: 13,
          outputTokens: 9,
          cacheWriteTokens: 2,
        }),
      ],
    };
    expect(aggregateUsage([thread], { by: "model" })).toEqual([
      {
        key: "gamma",
        messages: 2,
        messagesWithoutUsage: 0,
        duplicatesSkipped: 0,
        inputTokens: 24,
        outputTokens: 16,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        // Review M-1: partial reasoning coverage is visible, never presented
        // as a bucket-wide total.
        reasoningTokens: 5,
        reasoningMessages: 1,
      },
    ]);
  });

  // Review T-1b: day buckets assert per-bucket TOTALS, not just keys.
  it("lands the right totals in each UTC day bucket", () => {
    const buckets = aggregateUsage(threads, { by: "day" });
    expect(buckets.map((bucket) => bucket.key)).toEqual(["2026-08-01", "2026-08-02"]);
    expect(buckets[0]).toMatchObject({ inputTokens: 10, outputTokens: 4, messages: 1, messagesWithoutUsage: 1 });
    expect(buckets[1]).toMatchObject({ inputTokens: 12, outputTokens: 9, messages: 2 });
  });

  // Review M-2: ordering is code-point deterministic, independent of host
  // locale collation (sv/en disagree on "\u00e4").
  it("orders bucket keys by code point regardless of locale", () => {
    const mk = (id: string, model: string): Thread => ({
      id,
      createdAt: dayOne,
      updatedAt: dayOne,
      messages: [assistant(`${id}-m`, id, dayOne, model, { inputTokens: 1, outputTokens: 1 })],
    });
    const keys = aggregateUsage(
      [mk("t1", "a-model"), mk("t2", "\u00e4-model"), mk("t3", "z-model")],
      { by: "model" },
    ).map((bucket) => bucket.key);
    expect(keys).toEqual(["a-model", "z-model", "\u00e4-model"]);
  });
});

describe("createUsageAccumulator (#36, #34)", () => {
  const thread = (id: string, source: string, model: string, tokens: number): Thread => ({
    schemaVersion: THREAD_SCHEMA_VERSION,
    id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [
      {
        id: `${id}:1`,
        threadId: id,
        role: "assistant",
        timestamp: 1_700_000_000_000,
        model,
        content: [{ type: "text", text: "hi" }],
        usage: { inputTokens: tokens, outputTokens: tokens },
      },
    ],
    metadata: { source },
  });

  it("folding one thread at a time equals aggregating the array", () => {
    const threads = [thread("a", "codex", "m1", 10), thread("b", "claude-code", "m2", 20)];
    const accumulator = createUsageAccumulator({ by: "source" });
    for (const t of threads) accumulator.add(t);
    expect(accumulator.result()).toEqual(aggregateUsage(threads, { by: "source" }));
  });

  it("keeps cross-file dedup when folds are separated in time", () => {
    // The property that makes streaming safe: the seen-set lives on the
    // accumulator, so the same session imported twice — from overlapping
    // globs, say — is counted once, exactly as the array form does.
    const accumulator = createUsageAccumulator({ by: "model" });
    accumulator.add(thread("a", "codex", "m1", 10));
    accumulator.add(thread("a", "codex", "m1", 10));
    const [bucket] = accumulator.result();
    expect(bucket?.messages).toBe(1);
    expect(bucket?.duplicatesSkipped).toBe(1);
    expect(bucket?.inputTokens).toBe(10);
  });

  it("groups by the importing harness", () => {
    const buckets = aggregateUsage(
      [thread("a", "codex", "m1", 10), thread("b", "codex", "m2", 5), thread("c", "claude-code", "m1", 1)],
      { by: "source" },
    );
    expect(buckets.map((b) => [b.key, b.inputTokens])).toEqual([
      ["claude-code", 1],
      ["codex", 15],
    ]);
  });
});

