/**
 * File-level import: the bulk path for transcripts too large for one string.
 *
 * V8 caps a string at `buffer.constants.MAX_STRING_LENGTH` UTF-16 units
 * (about 512 Mi), and real Codex rollouts exceed it (a 962 MB rollout throws
 * "Cannot create a string longer than 0x1fffffe8 characters"). Above
 * `streamThresholdBytes`, JSONL inputs are therefore never read into one
 * string: Claude Code and Codex stream through their incremental importers
 * in bounded batches, and the other JSONL formats are read as a line array.
 */

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { constants as bufferConstants } from "node:buffer";
import type { Thread } from "@kontourai/thread";
import type { MessageIdentityObservation } from "@kontourai/thread/answer";
import {
  ferryMessageIdentityObservationFromStanding,
  normalizeMessageIdentityObservations,
  type MessageIdentityObservationSink,
} from "./answer.js";
import { importFromClaudeCodeLines } from "./adapters/claude-code.js";
import { importFromCodexLines } from "./adapters/codex.js";
import type { ImportLoss } from "./adapters/shared.js";
import { importThreadsWithIdentityObservations, type ImportOptions, type ImportResult } from "./convert.js";
import { detectFormat, type InputFormat } from "./detect.js";

/** Default size above which JSONL inputs are streamed rather than read whole. */
export const DEFAULT_STREAM_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** Bytes read from the head of a large file to detect its format. */
const DETECTION_SAMPLE_BYTES = 4 * 1024 * 1024;

export interface ImportFileOptions extends ImportOptions {
  /**
   * Files larger than this many bytes take the streaming path. A whole-file
   * string is only ever built at or below it (or, for single-document JSON
   * formats that cannot stream, below the V8 string limit).
   */
  streamThresholdBytes?: number;
  /** Lines per incremental batch on the streaming path. */
  batchLines?: number;
}

export interface ImportFileResult extends ImportResult {
  /** The format used, after detection when `"auto"` was requested. */
  format: InputFormat;
  /** `whole`: read into one string. `streamed`: read line by line, never one string. */
  read: "whole" | "streamed";
}

/** The input cannot be imported in one piece and its format cannot stream. */
export class FerryInputTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
    readonly format: InputFormat | "unknown",
  ) {
    super(
      `${path} is ${bytes} bytes, larger than one JavaScript string can hold, and ` +
        `${format === "unknown" ? "its format could not be detected from its first lines" : `${format} is a single JSON document that cannot be streamed`}`,
    );
    this.name = "FerryInputTooLargeError";
  }
}

export class FerryFormatDetectionError extends Error {
  constructor(readonly path: string) {
    super(`could not detect the format of ${path}`);
    this.name = "FerryFormatDetectionError";
  }
}

/**
 * Yields the lines of a JSONL file, split on `\n` only (a trailing `\r` is
 * dropped). Node's `readline` must not be used for JSONL: it also breaks
 * lines at U+2028 and U+2029, which JSON allows raw inside strings, so it
 * cuts real records in two (observed: 174 broken fragments in one rollout).
 */
export async function* readJsonlLines(path: string): AsyncGenerator<string> {
  yield* splitJsonlChunks(createReadStream(path, { encoding: "utf8" }) as AsyncIterable<string>);
}

/**
 * Splits text chunks into lines in linear time. A partial line is kept as an
 * array of pieces and joined once, and each chunk is searched for `\n` only
 * once: re-scanning an ever-growing carry string made one 32 MiB line take
 * about 12 seconds.
 */
export async function* splitJsonlChunks(chunks: AsyncIterable<string> | Iterable<string>): AsyncGenerator<string> {
  let pieces: string[] = [];
  for await (const chunk of chunks) {
    let start = 0;
    let newline = chunk.indexOf("\n");
    while (newline !== -1) {
      pieces.push(chunk.slice(start, newline));
      yield stripCarriageReturn(pieces.join(""));
      pieces = [];
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) pieces.push(chunk.slice(start));
  }
  if (pieces.length > 0) yield stripCarriageReturn(pieces.join(""));
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

const STREAMING_FORMATS: ReadonlySet<InputFormat> = new Set(["claude-code", "codex"]);
/** JSONL formats whose importers accept a line array but have no incremental core. */
const LINE_ARRAY_FORMATS: ReadonlySet<InputFormat> = new Set(["kiro", "pi", "observed-tool-events"]);

/**
 * Imports a transcript file. At or below `streamThresholdBytes` this is
 * `importThreadsWithIdentityObservations` on the file's text. Above it, no
 * whole-file string is built for a JSONL format.
 */
export async function importThreadsFromFile(
  path: string,
  format: InputFormat | "auto",
  options: ImportFileOptions = {},
): Promise<ImportFileResult> {
  const { size } = await stat(path);
  const threshold = options.streamThresholdBytes ?? DEFAULT_STREAM_THRESHOLD_BYTES;
  if (size <= threshold) {
    const content = await readFile(path, "utf8");
    const resolved = format === "auto" ? detectFormat(content) : format;
    if (resolved === undefined) throw new FerryFormatDetectionError(path);
    return { ...importThreadsWithIdentityObservations(content, resolved, options), format: resolved, read: "whole" };
  }

  const resolved = format === "auto" ? await detectFromHead(path) : format;
  if (resolved !== undefined && STREAMING_FORMATS.has(resolved)) {
    return { ...(await streamImport(path, resolved, options)), format: resolved, read: "streamed" };
  }
  if (resolved !== undefined && LINE_ARRAY_FORMATS.has(resolved)) {
    const lines: string[] = [];
    for await (const line of readJsonlLines(path)) lines.push(line);
    return { ...importThreadsWithIdentityObservations(lines, resolved, options), format: resolved, read: "streamed" };
  }
  // A single JSON document (or an undetected head) has to be read whole.
  // A UTF-8 file decodes to at most one UTF-16 unit per byte, so any file
  // within the string limit is safe to read.
  if (size > bufferConstants.MAX_STRING_LENGTH) throw new FerryInputTooLargeError(path, size, resolved ?? "unknown");
  const content = await readFile(path, "utf8");
  const whole = resolved ?? detectFormat(content);
  if (whole === undefined) throw new FerryFormatDetectionError(path);
  return { ...importThreadsWithIdentityObservations(content, whole, options), format: whole, read: "whole" };
}

/**
 * Detects from a bounded byte prefix, keeping only its complete lines: a
 * file with no newline at all must not become one giant string here.
 */
async function detectFromHead(path: string): Promise<InputFormat | undefined> {
  let head = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8", start: 0, end: DETECTION_SAMPLE_BYTES - 1 })) {
    head += chunk as string;
  }
  const lastNewline = head.lastIndexOf("\n");
  return lastNewline === -1 ? undefined : detectFormat(head.slice(0, lastNewline));
}

async function streamImport(
  path: string,
  format: InputFormat,
  options: ImportFileOptions,
): Promise<ImportResult> {
  const raw: MessageIdentityObservation[] = [];
  const onMessageIdentity: MessageIdentityObservationSink = (message, standing) => {
    raw.push(ferryMessageIdentityObservationFromStanding(message, standing));
  };
  const losses: ImportLoss[] = [];
  const onLosses = (reported: ImportLoss[]): void => { losses.push(...reported); };
  const common = { onWarn: options.onWarn, onMessageIdentity, onLosses, batchLines: options.batchLines };
  let thread: Thread;
  if (format === "claude-code") thread = await importFromClaudeCodeLines(readJsonlLines(path), common);
  else thread = await importFromCodexLines(readJsonlLines(path), common);
  return { threads: [thread], messageIdentityObservations: normalizeMessageIdentityObservations(raw), losses };
}
