import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ObservedToolEvent } from "@kontourai/thread";
import { detectFormat, importObservations, importThreads } from "../src/index.js";

const source = readFileSync(new URL("./fixtures/observed-tool-events.jsonl", import.meta.url), "utf8");
describe("observed tool events", () => {
  it("detects the source and retains ordered standalone events and provenance", () => {
    expect(detectFormat(source)).toBe("observed-tool-events");
    expect(() => importThreads(source, "observed-tool-events")).toThrow("importObservations");
    const result = importObservations(source, { sourceId: "source-1" });
    expect(result.malformed).toBe(1);
    expect(result.events.map(x => x.ordinal)).toEqual([1, 2, 4]);
    expect(result.events.map(x => x.event)).toEqual(["tool_start", "tool_complete", "tool_start"]);
    expect(result.events[0]?.input).toBe('{"file_path": "example.txt"}');
    expect(result.events[1]?.output).toBe("example output");
    expect(result.events[0]?.timestamp).toBe("2026-01-02T03:04:05Z");
    expect(result.events.every(x => ObservedToolEvent.safeParse(x).success)).toBe(true);
    expect(new Set(result.events.map(x => x.id)).size).toBe(3);
  });
  it("refuses beyond the malformed bound without exposing content", () => {
    expect(() => importObservations(source, { sourceId: "source-1", maxMalformed: 0 })).toThrow(/1 records could not be read/);
    expect(() => importObservations('private-value\n', { sourceId: 'x', maxMalformed: 0 })).toThrow(/^1 records could not be read/);
  });
  it("checks source identity, timestamps, complete outputs, and empty cursor digests", () => {
    const start = source.split("\n")[0]!;
    const parsed = JSON.parse(start);
    expect(importObservations(JSON.stringify({ ...parsed, timestamp: "1" }) + "\n", { sourceId: "a" }).malformed).toBe(1);
    expect(importObservations(JSON.stringify({ ...parsed, event: "tool_complete", input: undefined }) + "\n", { sourceId: "a" }).malformed).toBe(1);
    expect(importObservations(start + "\n", { sourceId: "a" }).events[0]?.id).not.toBe(importObservations(start + "\n", { sourceId: "b" }).events[0]?.id);
    expect(() => importObservations("", { sourceId: "a", cursor: { version: 1, sourceId: "a", lines: 0, digest: "0".repeat(64) } })).toThrow(/cursor prefix/);
    expect(detectFormat('{"event":"parse_error"}\n' + start)).toBe("observed-tool-events");
  });
  it("does not advance past a partial last line", () => {
    const lines = source.split("\n");
    const partial = lines[0] + "\n" + lines[1]!.slice(0, 30);
    const first = importObservations(partial, { sourceId: "source-1" });
    expect(first.partial).toBe(1);
    expect(first.cursor.lines).toBe(1);
    const completed = importObservations(lines[0] + "\n" + lines[1] + "\n", { sourceId: "source-1", cursor: first.cursor });
    expect(completed.events).toHaveLength(1);
    expect(completed.partial).toBe(0);
  });
  it("replays without duplicates and refuses changed or truncated prefixes", () => {
    const first = importObservations(source, { sourceId: "source-1" });
    expect(first.events[2]?.session).toBe("");
    const replay = importObservations(source, { sourceId: "source-1", cursor: first.cursor });
    expect(replay.events).toEqual([]);
    const next = importObservations(source + source.split("\n")[0] + "\n", { sourceId: "source-1", cursor: first.cursor });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.id).not.toBe(first.events[0]?.id);
    expect(() => importObservations(source.replace('Read', 'Edit'), { sourceId: "source-1", cursor: first.cursor })).toThrow(/cursor prefix/);
    expect(() => importObservations('', { sourceId: "source-1", cursor: first.cursor })).toThrow(/cursor prefix/);
  });
});
