import type { Thread } from "./schema.js";

/** The dimension used to group assistant-message token usage. */
export type UsageAggregationDimension = "model" | "day" | "thread" | "source";

export interface AggregateUsageOptions {
  /** Defaults to `model`. */
  by?: UsageAggregationDimension;
  /** Include messages at or after this epoch-millisecond timestamp. */
  since?: number;
}

/**
 * A token-only rollup of canonical assistant messages. `inputTokens` remains
 * the importer's exclusive input count; cache token fields are never folded
 * into it. `reasoningTokens`, when present, is a subset of output tokens.
 */
export interface UsageBucket {
  key: string;
  /** Assistant messages that supplied a usage record. */
  messages: number;
  /** Assistant messages in the bucket which did not supply a usage record. */
  messagesWithoutUsage: number;
  /** Cross-file duplicates of already-counted messages, dropped, made visible. */
  duplicatesSkipped: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  /**
   * How many usage-bearing messages contributed to `reasoningTokens`. Present
   * exactly when `reasoningTokens` is: a bucket where only some messages
   * report reasoning would otherwise present a partial sum as the total.
   */
  reasoningMessages?: number;
}

/**
 * Fold threads into usage buckets ONE AT A TIME.
 *
 * `aggregateUsage` takes an array, which means a caller aggregating a corpus
 * must materialize every thread — each holding every message, tool payload
 * and result verbatim — before a single number is produced. That is fine for
 * a handful of sessions and impossible for a real archive (thousands of
 * sessions, tens of gigabytes). The accumulator lets a caller import, fold
 * and release one file at a time; only the buckets and the dedup key set
 * (ids, not content) stay resident.
 *
 * The cross-file duplicate protection is preserved exactly: the seen-set
 * lives on the accumulator, so folding two overlapping imports separately
 * counts a shared message once, just as passing them in one array does.
 */
export function createUsageAccumulator(options: AggregateUsageOptions = {}) {
  const by = options.by ?? "model";
  const buckets = new Map<string, UsageBucket>();
  // Imports can overlap or include the same session more than once. Canonical
  // message IDs are scoped to a thread, so deduplicate at that boundary before
  // any filtering or bucket accounting.
  const seenMessageIds = new Set<string>();

  const add = (thread: Thread): void => {
    for (const message of thread.messages) {
      if (message.role !== "assistant") continue;
      if (options.since !== undefined && message.timestamp < options.since) continue;

      const key = usageKey(by, thread, message.model, message.timestamp);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          messages: 0,
          messagesWithoutUsage: 0,
          duplicatesSkipped: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        buckets.set(key, bucket);
      }

      const messageIdentity = `${thread.id}\u0000${message.id}`;
      if (seenMessageIds.has(messageIdentity)) {
        bucket.duplicatesSkipped += 1;
        continue;
      }
      seenMessageIds.add(messageIdentity);

      if (!message.usage) {
        bucket.messagesWithoutUsage += 1;
        continue;
      }

      bucket.messages += 1;
      bucket.inputTokens += message.usage.inputTokens;
      bucket.outputTokens += message.usage.outputTokens;
      bucket.cacheReadTokens += message.usage.cacheReadTokens ?? 0;
      bucket.cacheWriteTokens += message.usage.cacheWriteTokens ?? 0;
      if (message.usage.reasoningTokens !== undefined) {
        bucket.reasoningTokens = (bucket.reasoningTokens ?? 0) + message.usage.reasoningTokens;
        bucket.reasoningMessages = (bucket.reasoningMessages ?? 0) + 1;
      }
    }
  };

  const result = (): UsageBucket[] =>
    // Code-point order, deliberately not localeCompare: collation varies by
    // host locale (sv/en disagree on "\u00e4"), and output must be
    // deterministic everywhere.
    [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { add, result };
}

/**
 * Aggregate canonical assistant-message usage without interpreting importer
 * metadata. Results are sorted by ascending bucket key.
 *
 * Buffers whatever the caller passes; `createUsageAccumulator` is the
 * streaming form for corpora that cannot be held in memory.
 */
export function aggregateUsage(
  threads: readonly Thread[],
  options: AggregateUsageOptions = {},
): UsageBucket[] {
  const accumulator = createUsageAccumulator(options);
  for (const thread of threads) accumulator.add(thread);
  return accumulator.result();
}

function usageKey(
  by: UsageAggregationDimension,
  thread: Thread,
  model: string | undefined,
  timestamp: number,
): string {
  switch (by) {
    case "model":
      return model ?? "unknown";
    case "day":
      return new Date(timestamp).toISOString().slice(0, 10);
    case "thread":
      return thread.id;
    case "source":
      // The importing tool: `claude-code`, `codex`, `opencode`… Coarse by
      // design — `sourceVersion` belongs to a later dimension rather than
      // baked into this key, so upgrading a CLI does not split a harness in
      // two mid-corpus.
      return thread.metadata?.source ?? "unknown";
  }
}
