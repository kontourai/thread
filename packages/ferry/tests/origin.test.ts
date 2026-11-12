/**
 * Message origin derivation (#76, #78).
 *
 * Fixture provenance: `claude-code-provenance.jsonl`,
 * `claude-code-subagent.jsonl`, `codex-root-provenance.jsonl`, and
 * `codex-forked-subagent-provenance.jsonl` are real local records with keys,
 * nesting, key order, booleans, numbers, and enumerated values as the
 * harness wrote them. Every free-text value, id, path, branch, and timestamp
 * is replaced with synthetic content; wrapper tags around injected text are
 * kept with synthetic bodies. The two Codex forked/subagent records keep
 * their real `ordinal` values; the Claude and Codex root fixtures are
 * composed from several real sessions. The legacy (no-passthrough) Codex
 * cases below are composed inline, as #78's reproduction was.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTextContent, Thread, threadFromJson, threadToJson, type Message } from "@kontourai/thread";
import { createCodexImporter, importFromClaudeCode, importFromCodex } from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf-8");

/** [role, first 41 chars of text, origin] per non-tool message. */
const origins = (messages: readonly Message[]) =>
  messages
    .filter((m) => m.role === "user" || m.role === "system")
    .map((m) => [m.role, getTextContent(m).slice(0, 41), "origin" in m ? m.origin : undefined]);

describe("claude-code message origin", () => {
  const thread = importFromClaudeCode(fixture("claude-code-provenance.jsonl"));

  it("derives each user turn's author from the record's own signals", () => {
    expect(origins(thread.messages)).toEqual([
      ["user", "Why does the retry test fail on the secon",
        { kind: "human", evidence: "claude-code:origin.kind=human" }],
      // A slash command: the wrapper is reported, but nothing on the record
      // says who invoked it.
      ["user", "<command-name>/compact</command-name>\n   ",
        { kind: "unknown", evidence: "claude-code:no-origin-signal", envelope: "command-name" }],
      ["user", "<local-command-stdout>Compacted </local-c",
        { kind: "harness", evidence: "claude-code:envelope", envelope: "local-command-stdout" }],
      ["user", "This session is being continued from a pr",
        { kind: "compaction", evidence: "claude-code:isCompactSummary" }],
      ["user", "<task-notification>\n<task-id>fixture-task",
        { kind: "task-notification", evidence: "claude-code:origin.kind=task-notification", envelope: "task-notification" }],
      // An SDK-submitted brief: an orchestrator or a relayed person, and the
      // record does not say which.
      ["user", "Act as the reviewer for this change. Repo",
        { kind: "unknown", evidence: "claude-code:promptSource=sdk" }],
      // The same SDK path with the harness's own human classification.
      ["user", "Thanks. Please also add a regression test",
        { kind: "human", evidence: "claude-code:origin.kind=human" }],
      ["user", "[Request interrupted by user]",
        { kind: "harness", evidence: "claude-code:envelope", envelope: "request-interrupted" }],
    ]);
  });

  it("still skips isMeta records, including peer messages", () => {
    expect(JSON.stringify(thread.messages)).not.toContain("Another session sent this report");
  });

  it("labels a subagent transcript's user turn as agent-authored", () => {
    const subagent = importFromClaudeCode(fixture("claude-code-subagent.jsonl"), { includeSidechains: true });
    expect(origins(subagent.messages)).toEqual([
      ["user", "Run the test suite and report which tests",
        { kind: "agent", evidence: "claude-code:isSidechain" }],
    ]);
  });

  it("survives canonical serialization", () => {
    const back = threadFromJson(threadToJson(thread));
    expect(origins(back.messages)).toEqual(origins(thread.messages));
  });

  it("prefers the record's origin.kind over promptSource and isSidechain", () => {
    const base = { type: "user", isSidechain: true, sessionId: "s", timestamp: "2026-08-01T10:00:00.000Z" };
    const lines = [
      { ...base, uuid: "u1", message: { role: "user", content: "a" }, origin: { kind: "coordinator" } },
      { ...base, uuid: "u2", message: { role: "user", content: "b" }, origin: { kind: "unclassified" } },
      { ...base, uuid: "u3", isSidechain: false, message: { role: "user", content: "c" }, origin: { kind: "auto-continuation" } },
    ].map((line) => JSON.stringify(line));
    const imported = importFromClaudeCode(lines, { includeSidechains: true });
    expect(imported.messages.map((m) => (m.role === "user" ? m.origin : undefined))).toEqual([
      { kind: "agent", evidence: "claude-code:origin.kind=coordinator" },
      // "unclassified" is the harness saying it does not know, so the
      // sidechain signal still applies.
      { kind: "agent", evidence: "claude-code:isSidechain" },
      { kind: "harness", evidence: "claude-code:origin.kind=auto-continuation" },
    ]);
  });
});

describe("codex message origin", () => {
  it("separates developer instructions, injected context, notifications, and agent input in a root session", () => {
    const thread = importFromCodex(fixture("codex-root-provenance.jsonl"));
    expect(Thread.parse(thread)).toBeTruthy();
    expect(origins(thread.messages)).toEqual([
      ["system", "Follow the repository instructions.",
        { kind: "harness", evidence: "codex:role=developer" }],
      ["user", "# AGENTS.md instructions for /Users/dev/e",
        { kind: "harness", evidence: "codex:provenance.type=agents_md,harness", envelope: "AGENTS.md" }],
      // Submitted through the user-input path by an app-server client, which
      // relays both people and orchestrators.
      ["user", "Fix the flaky retry test.",
        { kind: "unknown", evidence: "codex:session_meta.source=vscode" }],
      ["system", "Hook context: the test runner is npm test",
        { kind: "hook", evidence: "codex:role=developer,provenance.hook" }],
      ["user", "<subagent_notification>\n{\"agent_path\":\"/r",
        { kind: "task-notification", evidence: "codex:content_item_kinds=multi_agent.subagent_notification", envelope: "subagent_notification" }],
      ["user", "The retry test passed twice.",
        { kind: "agent", evidence: "codex:agent_message" }],
      ["user", "Continue from the summary of the earlier ",
        { kind: "unknown", evidence: "codex:content_item_kinds=unknown" }],
      ["user", "<turn_aborted>\nsynthetic harness text\n</t",
        { kind: "harness", evidence: "codex:provenance.type=harness", envelope: "turn_aborted" }],
    ]);
    const fromChild = thread.messages.find((m) => getTextContent(m) === "The retry test passed twice.");
    expect(fromChild?.metadata).toEqual({ codexAgentMessage: { author: "/root/worker", recipient: "/root" } });
  });

  it("attributes a forked subagent's inherited parent history to the parent's source", () => {
    const thread = importFromCodex(fixture("codex-forked-subagent-provenance.jsonl"));
    const users = origins(thread.messages).filter(([role]) => role === "user");
    expect(users).toEqual([
      ["user", "<environment_context>\n  <cwd>/Users/dev/e",
        { kind: "harness", evidence: "codex:provenance.type=harness", envelope: "environment_context" }],
      // Ordinal 11 < subagent_history_start_ordinal 17: the parent's prompt,
      // from a vscode session, so not attributable.
      ["user", "Fix the flaky retry test.",
        { kind: "unknown", evidence: "codex:session_meta.source=vscode,forked-parent-history" }],
      // The child's own brief arrives from its parent agent.
      ["user", "Run the retry test twice and report the r",
        { kind: "agent", evidence: "codex:agent_message" }],
    ]);
    expect(thread.messages.filter((m) => m.role === "system").every((m) => m.role === "system" && m.origin?.kind === "harness")).toBe(true);
  });

  it("labels a child session's own user-path input as agent-authored", () => {
    const lines = fixture("codex-forked-subagent-provenance.jsonl").trim().split("\n");
    const parentPrompt = lines.find((line) => line.includes('"ordinal":11,'))!;
    // The same real user.text record, re-stamped past the history start.
    const ownPrompt = parentPrompt.replace('"ordinal":11,', '"ordinal":40,');
    const thread = importFromCodex([...lines, ownPrompt]);
    const last = thread.messages.at(-1);
    expect(last?.role === "user" ? last.origin : undefined).toEqual({
      kind: "agent",
      evidence: "codex:session_meta.source=subagent",
    });
  });

  it("falls back to wrapper envelopes and the session source on legacy rollouts (#78 reproduction)", () => {
    const item = (role: string, text: string) => JSON.stringify({
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    });
    const meta = (source: string) => JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "t1", cwd: "/w", source },
    });
    const body = [
      item("developer", "<permissions instructions>x</permissions instructions>"),
      item("user", "<environment_context><cwd>/w</cwd></environment_context>"),
      item("user", "# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>"),
      item("user", "<subagent_notification>{}</subagent_notification>"),
      item("user", "<environment_context>x</environment_context>\nreal prompt after a wrapper"),
      item("user", "real prompt"),
    ];
    const cli = importFromCodex([meta("cli"), ...body]);
    expect(origins(cli.messages)).toEqual([
      ["system", "<permissions instructions>x</permissions ",
        { kind: "harness", evidence: "codex:role=developer", envelope: "permissions instructions" }],
      ["user", "<environment_context><cwd>/w</cwd></envir",
        { kind: "harness", evidence: "codex:envelope", envelope: "environment_context" }],
      ["user", "# AGENTS.md instructions for /w\n\n<INSTRUC",
        { kind: "harness", evidence: "codex:envelope", envelope: "AGENTS.md" }],
      ["user", "<subagent_notification>{}</subagent_notif",
        { kind: "task-notification", evidence: "codex:envelope", envelope: "subagent_notification" }],
      // Mixed: the wrapper does not make the trailing prompt harness text.
      ["user", "<environment_context>x</environment_conte",
        { kind: "human", evidence: "codex:session_meta.source=cli" }],
      ["user", "real prompt", { kind: "human", evidence: "codex:session_meta.source=cli" }],
    ]);
    const exec = importFromCodex([meta("exec"), ...body]);
    expect(exec.messages.at(-1)).toMatchObject({ origin: { kind: "unknown", evidence: "codex:session_meta.source=exec" } });
  });

  it("resolves user-path origins when session_meta arrives after the prompt", () => {
    const prompt = '{"timestamp":"2026-08-01T00:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"before metadata"}]}}';
    const meta = '{"timestamp":"2026-08-01T00:00:01.000Z","type":"session_meta","payload":{"id":"late","source":"cli"}}';
    const importer = createCodexImporter();
    expect(importer.pushLines([prompt])).toEqual([]);
    expect(importer.thread().messages[0]).toMatchObject({ origin: { kind: "unknown", evidence: "codex:no-session-source" } });
    const announced = importer.pushLines([meta]);
    expect(announced[0]).toMatchObject({ origin: { kind: "human", evidence: "codex:session_meta.source=cli" } });
    expect(importFromCodex([prompt, meta]).messages[0]).toMatchObject({ origin: { kind: "human" } });
  });
});
