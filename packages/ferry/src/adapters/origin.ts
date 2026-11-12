/**
 * Harness-envelope detection shared by importers that derive `Message.origin`.
 *
 * An envelope is a wrapper block the harness writes around content it injects
 * into the user role, such as `<system-reminder>…</system-reminder>`. Only a
 * message whose ENTIRE text is one or more known wrapper blocks counts: a
 * leading wrapper followed by other text is a mixed message, and the origin of
 * the other text is not something the wrapper can tell us.
 */

import type { ContentPart } from "@kontourai/thread";

/**
 * A heading line that opens an injected block rather than a tag. Codex writes
 * `# AGENTS.md instructions for <dir>` immediately before `<INSTRUCTIONS>`.
 */
export interface EnvelopeHeading {
  prefix: string;
  name: string;
}

export interface EnvelopeVocabulary {
  /** Exact wrapper tag names, which may contain spaces (`permissions instructions`). */
  tags: ReadonlySet<string>;
  headings?: readonly EnvelopeHeading[];
  /** Whole-text markers that are not tags, such as `[Request interrupted by user]`. */
  markers?: ReadonlyMap<string, string>;
}

/**
 * Returns the leading envelope name when every text part consists solely of
 * known wrapper blocks (whitespace between them is allowed); otherwise
 * undefined. Any non-text part (an image a person attached) disqualifies it.
 */
export function wholeEnvelope(
  content: readonly ContentPart[],
  vocabulary: EnvelopeVocabulary,
): string | undefined {
  if (content.length === 0 || content.some((part) => part.type !== "text")) return undefined;
  let first: string | undefined;
  for (const part of content) {
    if (part.type !== "text") return undefined;
    const name = envelopeOfText(part.text, vocabulary);
    if (name === undefined) return undefined;
    first ??= name;
  }
  return first;
}

function envelopeOfText(text: string, vocabulary: EnvelopeVocabulary): string | undefined {
  const marker = vocabulary.markers?.get(text.trim());
  if (marker !== undefined) return marker;
  let index = skipWhitespace(text, 0);
  if (index >= text.length) return undefined;
  let first: string | undefined;
  while (index < text.length) {
    const heading = vocabulary.headings?.find((candidate) => text.startsWith(candidate.prefix, index));
    if (heading !== undefined) {
      const lineEnd = text.indexOf("\n", index);
      // A heading alone, with no block after it, is not an injected envelope.
      if (lineEnd === -1) return undefined;
      first ??= heading.name;
      index = skipWhitespace(text, lineEnd + 1);
      if (index >= text.length) return undefined;
      continue;
    }
    const tag = openingTagAt(text, index, vocabulary.tags);
    if (tag === undefined) return undefined;
    const close = `</${tag.name}>`;
    const closeAt = text.indexOf(close, tag.end);
    if (closeAt === -1) return undefined;
    first ??= tag.name;
    index = skipWhitespace(text, closeAt + close.length);
  }
  return first;
}

function openingTagAt(
  text: string,
  index: number,
  tags: ReadonlySet<string>,
): { name: string; end: number } | undefined {
  if (text[index] !== "<") return undefined;
  const end = text.indexOf(">", index);
  if (end === -1) return undefined;
  const inner = text.slice(index + 1, end);
  // Exact match first, because some names contain spaces; then a name
  // followed by attributes (`<codex_internal_context source="goal">`).
  if (tags.has(inner)) return { name: inner, end: end + 1 };
  const space = inner.search(/\s/);
  if (space > 0 && tags.has(inner.slice(0, space))) return { name: inner.slice(0, space), end: end + 1 };
  return undefined;
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  return index;
}
