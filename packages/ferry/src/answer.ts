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
