import type { Thread } from "./schema.js";

/** The dimension used to group assistant-message token usage. */
export type UsageAggregationDimension = "model" | "day" | "thread";

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
 * Aggregate canonical assistant-message usage without interpreting importer
 * metadata. Results are sorted by ascending bucket key.
 */
export function aggregateUsage(
  threads: readonly Thread[],
  options: AggregateUsageOptions = {},
): UsageBucket[] {
  const by = options.by ?? "model";
  const buckets = new Map<string, UsageBucket>();
  // Imports can overlap or include the same session more than once. Canonical
  // message IDs are scoped to a thread, so deduplicate at that boundary before
  // any filtering or bucket accounting.
  const seenMessageIds = new Set<string>();

  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.role !== "assistant") continue;
      if (options.since !== undefined && message.timestamp < options.since) continue;

      const key = usageKey(by, thread.id, message.model, message.timestamp);
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
  }

  // Code-point order, deliberately not localeCompare: collation varies by
  // host locale (sv/en disagree on "\u00e4"), and output must be
  // deterministic everywhere.
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function usageKey(
  by: UsageAggregationDimension,
  threadId: string,
  model: string | undefined,
  timestamp: number,
): string {
  switch (by) {
    case "model":
      return model ?? "unknown";
    case "day":
      return new Date(timestamp).toISOString().slice(0, 10);
    case "thread":
      return threadId;
  }
}
