/** Helpers shared across importers. */

/** JSONL input, either a whole document or pre-split lines (for files too large for one string). */
export type JsonlInput = string | readonly string[];

export function toLines(input: JsonlInput): readonly string[] {
  return typeof input === "string" ? input.split("\n") : input;
}

/**
 * Accepts ISO strings (Claude Code, Codex) and epoch milliseconds (OpenCode);
 * returns undefined for anything unparseable rather than inventing a time.
 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  return undefined;
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Narrow an unknown to a plain object record. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
