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
  cursor: ObservationCursor;
}

/** Replay the complete source prefix on each invocation. Persist the returned
 * cursor atomically with effects; it verifies that the consumed prefix did not
 * change. A distinct stable sourceId is required for each physical source. */
export function importObservations(input: JsonlInput, options: ObservationImportOptions): ObservationImportResult {
  const { sourceId, cursor } = options;
  const maxMalformed = options.maxMalformed ?? 100;
  if (typeof sourceId !== "string" || !sourceId.trim() || !Number.isSafeInteger(maxMalformed) || maxMalformed < 0)
    throw new Error("Invalid observation import options");
  if (cursor && (cursor.version !== 1 || cursor.sourceId !== sourceId || !Number.isSafeInteger(cursor.lines) || cursor.lines < 0 || !/^[a-f0-9]{64}$/.test(cursor.digest)))
    throw new Error("Invalid observation cursor");
  const lines = [...toLines(input)];
  // A trailing newline is a delimiter, not a record.
  if (lines.at(-1) === "") lines.pop();
  if (cursor && cursor.lines > lines.length) throw new Error("Observation source prefix changed");
  const hash = createHash("sha256");
  const events: ObservedToolEvent[] = [];
  let malformed = 0;
  const emptyDigest = createHash("sha256").digest("hex");
  if (cursor?.lines === 0 && cursor.digest !== emptyDigest) throw new Error("Observation source prefix changed");
  for (const [i, line] of lines.entries()) {
    // Length-prefixing makes line boundaries unambiguous, including empty lines.
    hash.update(`${Buffer.byteLength(line, "utf8")}:`).update(line);
    if (cursor && i + 1 === cursor.lines && hash.copy().digest("hex") !== cursor.digest)
      throw new Error("Observation source prefix changed");
    if (cursor && i < cursor.lines) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { malformed++; continue; }
    if (!v || typeof v !== "object" || Array.isArray(v)) { malformed++; continue; }
    const x = v as Record<string, unknown>;
    if (typeof x.timestamp !== "string" || !Number.isFinite(Date.parse(x.timestamp)) ||
        typeof x.session !== "string" || !x.session || typeof x.project_id !== "string" ||
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
  if (malformed > maxMalformed) throw new Error(`Observation malformed record bound exceeded (${malformed} > ${maxMalformed})`);
  return { events, malformed, cursor: { version: 1, sourceId, lines: lines.length, digest: hash.digest("hex") } };
}
