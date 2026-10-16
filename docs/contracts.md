# Canonical contracts

`@kontourai/thread` owns the portable schema, validation, factories, usage
aggregation, and bounded display projections. `@kontourai/ferry` owns source
translation and the identity-observation bridge. Neither package stores
conversations, runs tools, authorizes a consumer, or makes provider requests.

## Schema and serialization

The current source declares `THREAD_SCHEMA_VERSION = "1.2.0"`; this is separate
from the npm package version. A Thread contains an ID, ordered messages,
created/updated epoch-millisecond timestamps, and optional source metadata.
Roles are `user`, `assistant`, `system`, and `tool`. Content supports text,
images/files, assistant reasoning and tool calls, and tool results.

`threadFromJson` parses JSON and validates through Zod; invalid JSON or schema
violations throw. `threadToJson` validates first and supplies the current
schema version when absent. Parsing allows a missing `schemaVersion` and
accepts a version string; it does not negotiate migrations or reject a future
version solely by that string. Consumers must decide compatibility rather
than treating the field as an automatic migration guarantee.

Tool calls distinguish raw `arguments`, structured `parsedArguments` for the
same inputs, and importer-produced `derived` analysis. Exporters ignore
`derived`. Timestamps and IDs may be adapter fallbacks; validation of their
shape does not prove source observation.

The root package exports schemas, types, factories such as `createThread`,
role guards, serialization, tool-result projection, and usage APIs. The
`@kontourai/thread/answer` subpath owns assistant-answer reference APIs.
See the [package guide](../packages/thread/README.md) for examples.

## Identity and projections

A legacy tool result without identity remains valid. An identified result
must carry `resultId` and `terminalStatus` together; the result ID must differ
from the call ID and be unique within a Thread. Standing is `success`,
`error`, `cancelled`, or `unknown`. Authority denials and source correlations
require an identified result. A denial cannot claim success, and known
error/success/cancelled standing must agree with an explicit `isError`.

`projectToolResult` exposes an inert bounded result, retaining identity and
standing while omitting raw payload bytes, URLs, annotations, and structured
result data. Its limits include 32 parts, 64 KiB of UTF-8 text, and 72 KiB of
projected string data. Omission counters disclose capacity loss. Legacy
unidentified results are unavailable; invalid input can fail validation, so
validate at the caller boundary.

A `ThreadAnswerRef` names one observed assistant-message tuple under authority
`@kontourai/thread`, schema `1.2.0`, and kind `assistant-message`. IDs are
opaque Unicode strings: path/URL-looking values are never normalized or
dereferenced. `createObservedMessageIdentity` declares a producer observation;
it cannot independently prove the producer's claim. Only a producer that read
the exact owner-issued thread/message tuple should create that fact.

Ferry's additive `importThreadsWithIdentityObservations` returns Threads plus
serializable observations collected while adapters still know source standing.
Duplicate tuples downgrade to adapter-fallback. `findObservedMessageIdentity`
refuses missing, malformed, ambiguous, or unobserved matches. Re-importing
canonical JSON supplies adapter-fallback standing; metadata or a convincing
ID spelling cannot upgrade it. Persist observations separately if later
answer-reference creation needs their standing.

`projectAssistantAnswer(ref, unknownMessage)` is a total boundary: unavailable
outcomes cover malformed input, non-assistant messages, identity mismatches,
and missing/corrupt visible text. Available output retains ordered text only,
with at most 32 parts, 16 KiB per part, 64 KiB total text, and 72 KiB including
reference fields. It retains no reasoning, tools, attachments, or metadata;
source metadata has a zero-byte budget. Text and URLs remain inert strings,
so callers still choose safe rendering. Truncation counters describe loss
among visible-text candidates, not intentionally excluded private fields.

## Usage ownership

`aggregateUsage` handles a collection of Threads; `createUsageAccumulator`
folds one Thread at a time while retaining cross-file deduplication. Both
count assistant usage, distinguish missing records from zero usage, and group
by model/day/thread/source. They do not reinterpret raw adapter metadata or
estimate missing token counts. See [usage output](cli.md#usage-and-rows).
