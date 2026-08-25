/**
 * Ferry's bridge from imported messages to answer references.
 *
 * Importers must pass the source tuple they actually observed. A missing or
 * changed tuple is explicitly adapter-fallback; this helper never promotes an
 * adapter-generated Message.id by recognizing its format.
 */
import {
  SCHEMA_NAME,
  THREAD_SCHEMA_VERSION,
} from "@kontourai/thread";
import {
  MessageIdentityObservation,
  createObservedMessageIdentity,
} from "@kontourai/thread/answer";
import type { Message } from "@kontourai/thread";

export type FerryMessageIdentityStanding = "observed" | "synthetic" | "adapter-fallback";

/**
 * An importer calls this while it still knows whether its emitted tuple is an
 * exact source tuple.  It is intentionally a callback rather than Message
 * metadata: Thread metadata is untrusted application data and must never be
 * promoted into an answer reference.
 */
export type MessageIdentityObservationSink = (
  message: Pick<Message, "threadId" | "id">,
  standing: FerryMessageIdentityStanding,
) => void;

export interface ObservedSourceMessageIdentity {
  threadId: string;
  messageId: string;
}

export const ferryMessageIdentityObservation = (
  message: Pick<Message, "threadId" | "id">,
  observed: ObservedSourceMessageIdentity | undefined,
): MessageIdentityObservation => {
  if (observed !== undefined && observed.threadId === message.threadId && observed.messageId === message.id) {
    return createObservedMessageIdentity(observed.threadId, observed.messageId);
  }
  return MessageIdentityObservation.parse({
    authority: SCHEMA_NAME,
    schemaVersion: THREAD_SCHEMA_VERSION,
    kind: "message-identity-observation",
    standing: "adapter-fallback",
    threadId: message.threadId,
    messageId: message.id,
  });
};

export const ferryMessageIdentityObservationFromStanding = (
  message: Pick<Message, "threadId" | "id">,
  standing: FerryMessageIdentityStanding,
): MessageIdentityObservation => {
  if (standing === "observed") return createObservedMessageIdentity(message.threadId, message.id);
  return MessageIdentityObservation.parse({
    authority: SCHEMA_NAME,
    schemaVersion: THREAD_SCHEMA_VERSION,
    kind: "message-identity-observation",
    standing,
    threadId: message.threadId,
    messageId: message.id,
  });
};

/**
 * Produces a stable, fail-closed side channel.  Multiple messages claiming an
 * identical tuple are ambiguous to a consumer, so the tuple is downgraded to
 * adapter-fallback even when one source record was byte-observed.
 */
export const normalizeMessageIdentityObservations = (
  observations: readonly MessageIdentityObservation[],
): MessageIdentityObservation[] => {
  const byTuple = new Map<string, MessageIdentityObservation>();
  for (const observation of observations) {
    const parsed = MessageIdentityObservation.safeParse(observation);
    if (!parsed.success) continue;
    const item = parsed.data;
    const key = JSON.stringify([item.threadId, item.messageId]);
    const existing = byTuple.get(key);
    if (!existing) {
      byTuple.set(key, item);
      continue;
    }
    // A tuple names one message.  A duplicate is ambiguous even when both
    // producers call it observed, so never let a consumer pick arbitrarily.
    byTuple.set(key, ferryMessageIdentityObservationFromStanding(
      { threadId: item.threadId, id: item.messageId },
      "adapter-fallback",
    ));
  }
  return [...byTuple.values()];
};

/**
 * Resolves only an unambiguous, schema-valid observed fact from untrusted
 * serialized side-channel input.  Missing/malformed data is intentionally
 * indistinguishable from no standing: callers must not manufacture a ref.
 */
export const findObservedMessageIdentity = (
  input: unknown,
  threadId: string,
  messageId: string,
): ReturnType<typeof createObservedMessageIdentity> | undefined => {
  try {
    if (!Array.isArray(input)) return undefined;
    let match: MessageIdentityObservation | undefined;
    for (const candidate of input) {
      const parsed = MessageIdentityObservation.safeParse(candidate);
      if (!parsed.success) return undefined;
      if (parsed.data.threadId !== threadId || parsed.data.messageId !== messageId) continue;
      if (match !== undefined) return undefined;
      match = parsed.data;
    }
    return match?.standing === "observed" ? match : undefined;
  } catch {
    return undefined;
  }
};
