/** Legacy observe-hook JSONL. The writer truncates and scrubs tool I/O before
 * writing; this adapter retains those strings as observed, not original calls.
 * It cannot recover omitted empty input, truncated data, or pair events. */
import { createHash } from "node:crypto";
import type { ObservedToolEvent } from "@kontourai/thread";
import { toLines, type JsonlInput } from "./shared.js";

export interface ObservationCursor { version: 1; sourceId: string; lines: number; digest: string }
export interface ObservationImportOptions { sourceId: string; cursor?: ObservationCursor; maxMalformed?: number }
export interface ObservationImportResult {
  events: ObservedToolEvent[];
  malformed: number;
  partial: number;
  cursor: ObservationCursor;
}

/** Replay the complete source prefix on each invocation. Persist the returned
 * cursor atomically with effects; it verifies that the consumed prefix did not
 * change. A distinct stable sourceId is required for each physical source.
 * Array inputs must contain only complete lines, without line terminators. */
export function importObservations(input: JsonlInput, options: ObservationImportOptions): ObservationImportResult {
  const { sourceId, cursor } = options;
  const maxMalformed = options.maxMalformed ?? 100;
  if (typeof sourceId !== "string" || !sourceId.trim()) throw new Error("sourceId must be a non-empty string");
  if (!Number.isSafeInteger(maxMalformed) || maxMalformed < 0) throw new Error("maxMalformed must be a nonnegative whole number");
  if (cursor && (cursor.version !== 1 || cursor.sourceId !== sourceId || !Number.isSafeInteger(cursor.lines) || cursor.lines < 0 || !/^[a-f0-9]{64}$/.test(cursor.digest)))
    throw new Error("Cursor is invalid or belongs to another sourceId");
  const lines = [...toLines(input)];
  // String input may end while the writer is still appending a record.
  // Line arrays are supplied as complete records by the caller.
  let partial = 0;
  if (typeof input === "string") {
    const tail = lines.pop() ?? "";
    partial = tail.length > 0 ? 1 : 0;
  } else if (lines.at(-1) === "") {
    lines.pop();
  }
  if (cursor && cursor.lines > lines.length) throw new Error("The file or cursor changed since the last import; check for rotation, truncation, edits, or a damaged cursor");
  const hash = createHash("sha256");
  const events: ObservedToolEvent[] = [];
  let malformed = 0;
  const emptyDigest = createHash("sha256").digest("hex");
  if (cursor?.lines === 0 && cursor.digest !== emptyDigest) throw new Error("The file or cursor changed since the last import; check for rotation, truncation, edits, or a damaged cursor");
  for (const [i, line] of lines.entries()) {
    // Length-prefixing makes line boundaries unambiguous, including empty lines.
    hash.update(`${Buffer.byteLength(line, "utf8")}:`).update(line);
    if (cursor && i + 1 === cursor.lines && hash.copy().digest("hex") !== cursor.digest)
      throw new Error("The file or cursor changed since the last import; check for rotation, truncation, edits, or a damaged cursor");
    if (cursor && i < cursor.lines) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { malformed++; continue; }
    if (!v || typeof v !== "object" || Array.isArray(v)) { malformed++; continue; }
    const x = v as Record<string, unknown>;
    if (typeof x.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(x.timestamp) || !validObservationTimestamp(x.timestamp) ||
        typeof x.session !== "string" || typeof x.project_id !== "string" ||
        typeof x.project_name !== "string" || (x.event !== "tool_start" && x.event !== "tool_complete") ||
        typeof x.tool !== "string" || (x.input !== undefined && typeof x.input !== "string") ||
        (x.output !== undefined && typeof x.output !== "string") ||
        (x.event === "tool_complete" && typeof x.output !== "string")) { malformed++; continue; }
    const id = createHash("sha256").update(JSON.stringify([sourceId, i + 1])).digest("hex");
    events.push({ id, sourceId, ordinal: i + 1, timestamp: x.timestamp, session: x.session,
      projectId: x.project_id, projectName: x.project_name, event: x.event, tool: x.tool,
      ...(typeof x.input === "string" ? { input: x.input } : {}),
      ...(typeof x.output === "string" ? { output: x.output } : {}) });
  }
  if (malformed > maxMalformed) throw new Error(`${malformed} ${malformed === 1 ? "record" : "records"} could not be read, more than maxMalformed (${maxMalformed}); nothing was returned`);
  return { events, malformed, partial, cursor: { version: 1, sourceId, lines: lines.length, digest: hash.digest("hex") } };
}

function validObservationTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}
