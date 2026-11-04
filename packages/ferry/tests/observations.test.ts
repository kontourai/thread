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
    expect(result.events.map(x => x.ordinal)).toEqual([1, 2]);
    expect(result.events.map(x => x.event)).toEqual(["tool_start", "tool_complete"]);
    expect(result.events[0]?.input).toBe('{"file_path": "example.txt"}');
    expect(result.events[1]?.output).toBe("example output");
    expect(result.events[0]?.timestamp).toBe("2026-01-02T03:04:05Z");
    expect(result.events.every(x => ObservedToolEvent.safeParse(x).success)).toBe(true);
    expect(new Set(result.events.map(x => x.id)).size).toBe(2);
  });
  it("refuses beyond the malformed bound without exposing content", () => {
    expect(() => importObservations(source, { sourceId: "source-1", maxMalformed: 0 })).toThrow(/bound exceeded \(1 > 0\)/);
    try { importObservations('private-value', { sourceId: 'x', maxMalformed: 0 }); }
    catch (error) { expect(String(error)).not.toContain('private-value'); }
  });
  it("replays without duplicates and refuses changed or truncated prefixes", () => {
    const first = importObservations(source, { sourceId: "source-1" });
    const replay = importObservations(source, { sourceId: "source-1", cursor: first.cursor });
    expect(replay.events).toEqual([]);
    const next = importObservations(source + source.split("\n")[0] + "\n", { sourceId: "source-1", cursor: first.cursor });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.id).not.toBe(first.events[0]?.id);
    expect(() => importObservations(source.replace('Read', 'Edit'), { sourceId: "source-1", cursor: first.cursor })).toThrow(/prefix changed/);
    expect(() => importObservations('', { sourceId: "source-1", cursor: first.cursor })).toThrow(/prefix changed/);
  });
});
