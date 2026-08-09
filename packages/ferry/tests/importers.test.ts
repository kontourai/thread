import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getReasoning,
  getTextContent,
  getToolCalls,
  Thread,
  threadFromJson,
  threadToJson,
} from "@kontourai/thread";
import {
  importFromChatGPTExport,
  importFromClaudeCode,
  importFromCodex,
  importFromOpenCode,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf-8");

describe("claude-code importer", () => {
  const thread = importFromClaudeCode(fixture("claude-code-session.jsonl"));

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    expect(thread.metadata?.source).toBe("claude-code");
    expect(thread.metadata?.cwd).toBe("/Users/dev/example");
    expect(thread.metadata?.sourceVersion).toBe("2.0.14");
    expect(thread.metadata?.git?.branch).toBe("main");
    expect(thread.metadata?.title).toBe("Fix the flaky retry test");
  });

  it("yields user → assistant → tool → assistant messages with sidechains and meta dropped", () => {
    expect(thread.messages.map((m) => m.role)).toEqual([
      "user", "assistant", "tool", "assistant", "assistant", "assistant", "assistant",
    ]);
    const allText = JSON.stringify(thread.messages);
    expect(allText).not.toContain("Subagent");
    expect(allText).not.toContain("Caveat");
    expect(allText).not.toContain("should not be imported"); // toolUseResult sidecar
  });

  it("merges split assistant events sharing one API message id", () => {
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.id).toBe("msg_01AAA");
    expect(assistant.content.map((c) => c.type)).toEqual(["reasoning", "text", "tool_call"]);
    expect(getReasoning(assistant)).toContain("timing race");
    const [call] = getToolCalls(assistant);
    expect(call?.id).toBe("toolu_01XYZ");
    expect(call?.name).toBe("Read");
    expect(call?.parsedArguments).toEqual({
      file_path: "/Users/dev/example/tests/retry.test.ts",
    });
    expect(assistant.finishReason).toBe("tool_calls");
    expect(assistant.model).toBe("claude-sonnet-5");
    expect(assistant.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 16,
    });
    // Usage and pricing/deduplication extras are last-wins together: this is
    // the final split record's request id and usage, not the earlier one.
    expect(assistant.metadata?.["claudeUsageExtras"]).toEqual({
      cacheCreation5m: 4,
      cacheCreation1h: 12,
      serviceTier: "priority",
      requestId: "req_1",
      serverToolUse: {
        web_search_requests: 2,
        web_fetch_requests: 3,
      },
    });
  });

  it("removes stale Claude usage extras when the winning split usage has none", () => {
    const assistant = thread.messages.find((message) => message.id === "msg_01STALE");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(getTextContent(assistant)).toContain("Earlier split content with extras.");
    expect(getTextContent(assistant)).toContain("Winning split content without extras.");
    expect(assistant.usage).toEqual({ inputTokens: 410, outputTokens: 12 });
    expect(assistant.metadata?.["claudeUsageExtras"]).toBeUndefined();
    expect(assistant.metadata).toBeUndefined();
  });

  it("imports a null service_tier without inventing a serviceTier extra", () => {
    const assistant = thread.messages.find((message) => message.id === "msg_01NULL");
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(getTextContent(assistant)).toBe("A synthetic assistant response with a null service tier.");
    expect(assistant.usage).toEqual({ inputTokens: 250, outputTokens: 25 });
    expect(assistant.metadata?.["claudeUsageExtras"]).toEqual({ requestId: "req_null_tier" });
    expect(assistant.metadata?.["claudeUsageExtras"]).not.toHaveProperty("serviceTier");
  });

  it("deduplicates usage repeated on every split content-block record", () => {
    const assistants = thread.messages.filter(
      (message) => message.role === "assistant" && message.id === "msg_01REPEAT",
    );
    expect(assistants).toHaveLength(1);
    const [assistant] = assistants;
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(getTextContent(assistant)).toBe(
      "Repeated usage first content block.\nRepeated usage second content block.",
    );
    expect(assistant.usage).toEqual({
      inputTokens: 300,
      outputTokens: 80,
      cacheReadTokens: 120,
      cacheWriteTokens: 20,
    });
  });

  it("surfaces requestId for messageId:requestId usage deduplication", () => {
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    const extras = assistant.metadata?.["claudeUsageExtras"] as { requestId?: string } | undefined;
    expect(`${assistant.id}:${extras?.requestId}`).toBe("msg_01AAA:req_1");
  });

  it("pairs tool results with their calls and keeps ISO timestamps as epoch ms", () => {
    const tool = thread.messages[2];
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.toolCallId).toBe("toolu_01XYZ");
    expect(tool.toolResults[0]?.content[0]).toEqual({
      type: "text",
      text: "it('retries', async () => { await sleep(50); })",
    });
    expect(thread.messages[0]?.timestamp).toBe(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(thread.createdAt).toBe(Date.parse("2026-08-01T10:00:00.000Z"));
    expect(thread.updatedAt).toBe(Date.parse("2026-08-01T10:00:19.000Z"));
  });

  it("keeps sidechains when asked", () => {
    const withSidechains = importFromClaudeCode(fixture("claude-code-session.jsonl"), {
      includeSidechains: true,
    });
    expect(JSON.stringify(withSidechains.messages)).toContain("Subagent");
  });

  it("throws on input with no conversation events", () => {
    expect(() => importFromClaudeCode('{"type":"mode","mode":"default"}')).toThrow(
      /No Claude Code conversation events/,
    );
  });
});

describe("codex importer", () => {
  const thread = importFromCodex(fixture("codex-rollout.jsonl"));

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("019f0000-1111-2222-3333-444444444444");
    expect(thread.metadata?.source).toBe("codex");
    expect(thread.metadata?.cwd).toBe("/Users/dev/example");
    expect(thread.metadata?.sourceVersion).toBe("0.21.0");
  });

  it("folds assistant items per turn and pairs both tool call kinds", () => {
    expect(thread.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);

    const first = thread.messages[1];
    if (first?.role !== "assistant") throw new Error("expected assistant");
    expect(getReasoning(first)).toBe("Find every caller before renaming.");
    const [shellCall] = getToolCalls(first);
    expect(shellCall?.id).toBe("call_alpha");
    expect(shellCall?.name).toBe("shell");
    expect(shellCall?.parsedArguments).toEqual({ command: ["rg", "old_flag"] });
    expect(first.model).toBe("gpt-5.4-codex");
    expect(first.provider).toBe("openai");

    const patch = thread.messages[3];
    if (patch?.role !== "assistant") throw new Error("expected assistant");
    const [patchCall] = getToolCalls(patch);
    expect(patchCall?.id).toBe("call_beta");
    expect(patchCall?.name).toBe("apply_patch");
    expect(patchCall?.arguments).toContain("*** Begin Patch");

    const outputs = thread.messages.filter((m) => m.role === "tool");
    expect(outputs[0]?.toolResults[0]?.toolCallId).toBe("call_alpha");
    expect(outputs[1]?.toolResults[0]?.toolCallId).toBe("call_beta");
  });

  it("skips inter-agent chatter and keeps encrypted reasoning out", () => {
    const text = JSON.stringify(thread.messages);
    expect(text).not.toContain("inter-agent chatter");
    expect(text).not.toContain("opaque-not-imported");
  });

  it("normalizes modern and historical token counts and preserves their complete raw metadata", () => {
    const first = thread.messages[1];
    const modern = thread.messages[3];
    const second = thread.messages[5];
    if (first?.role !== "assistant" || modern?.role !== "assistant" || second?.role !== "assistant") {
      throw new Error("expected assistant messages");
    }
    expect(first.usage).toBeUndefined();
    expect(modern.usage).toEqual({
      inputTokens: 4918,
      outputTokens: 249,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(second.usage).toEqual({
      inputTokens: 20706,
      outputTokens: 217,
      reasoningTokens: 20,
      cacheReadTokens: 9600,
      cacheWriteTokens: 0,
    });
    expect(modern.metadata?.codexTokenUsage).toEqual({
      input_tokens: 4918,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 249,
      reasoning_output_tokens: 0,
      total_tokens: 5167,
    });
    expect(second.metadata?.codexTokenUsage).toEqual({
      input_tokens: 30306,
      cached_input_tokens: 9600,
      output_tokens: 217,
      reasoning_output_tokens: 20,
      total_tokens: 30523,
    });
    expect(modern.metadata?.codexRateLimits).toEqual({
      limit_id: "codex",
      limit_name: null,
      primary: null,
      secondary: null,
      credits: null,
      individual_limit: null,
      spend_control_reached: null,
      plan_type: null,
      rate_limit_reached_type: null,
    });
    expect(thread.metadata?.custom?.codexRateLimits).toEqual({
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1774689802 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1775276602 },
      credits: null,
      plan_type: "plus",
    });
  });

  it("attaches the latest forked count to the first assistant and rolls up its superseded predecessor", () => {
    const forked = importFromCodex(fixture("codex-forked-rollout.jsonl"));
    expect(forked.metadata?.custom?.codexUnattributedUsage).toEqual({
      inputTokens: 21293,
      outputTokens: 182,
      reasoningTokens: 39,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      events: 1,
    });
    const assistant = forked.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.usage).toEqual({
      inputTokens: 6687,
      outputTokens: 262,
      reasoningTokens: 63,
      cacheReadTokens: 20224,
      cacheWriteTokens: 0,
    });
  });

  it("holds a token count before any assistant and attaches it to the first assistant that follows", () => {
    const jsonl = [
      '{"timestamp":"2026-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"held-count"}}',
      '{"timestamp":"2026-06-15T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20}}}}',
      '{"timestamp":"2026-06-15T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"receives held usage"}]}}',
    ].join("\n");
    const held = importFromCodex(jsonl);
    const assistant = held.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("never retroactively attaches a new count to a stale usage-less assistant", () => {
    const jsonl = [
      '{"timestamp":"2026-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"stale-count"}}',
      '{"timestamp":"2026-06-15T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"old pre-format assistant"}]}}',
      '{"timestamp":"2026-06-15T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20}}}}',
      '{"timestamp":"2026-06-15T10:00:03.000Z","type":"response_item","payload":{"type":"agent_message","content":[{"type":"output_text","text":"ignored"}]}}',
      '{"timestamp":"2026-06-15T10:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"new assistant"}]}}',
    ].join("\n");
    const imported = importFromCodex(jsonl);
    const [oldAssistant, newAssistant] = imported.messages;
    if (oldAssistant?.role !== "assistant" || newAssistant?.role !== "assistant") {
      throw new Error("expected assistant messages");
    }
    expect(oldAssistant.usage).toBeUndefined();
    expect(newAssistant.usage?.inputTokens).toBe(100);
  });

  it("imports observed nullable-info, missing-cache-write, and modern rate-limit variants", () => {
    const variants = importFromCodex(fixture("codex-rollout-variants.jsonl"));
    expect(variants.messages).toHaveLength(2);
    const [, missingCacheWrite] = variants.messages;
    if (missingCacheWrite?.role !== "assistant") {
      throw new Error("expected assistant messages");
    }
    expect(variants.metadata?.custom?.codexRateLimits).toEqual({
      limit_id: "codex",
      limit_name: "weekly",
      primary: { used_percent: 5, window_minutes: 300, resets_at: 1781517722 },
      secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1782117722 },
      credits: null,
      individual_limit: { used_percent: 2, window_minutes: 60, resets_at: 1781503322 },
      spend_control_reached: false,
      plan_type: "pro",
      rate_limit_reached_type: null,
    });
    expect(missingCacheWrite.usage).toEqual({
      inputTokens: 20706,
      outputTokens: 217,
      reasoningTokens: 20,
      cacheReadTokens: 9600,
      cacheWriteTokens: 0,
    });
    expect(missingCacheWrite.metadata?.codexTokenUsage).toEqual({
      input_tokens: 30306,
      cached_input_tokens: 9600,
      output_tokens: 217,
      reasoning_output_tokens: 20,
      total_tokens: 30523,
    });
  });

  it("marks synthetic impossible exclusive input without inventing raw usage fields", () => {
    // Synthetic anomaly probe: real samples contained no negative exclusive input.
    const jsonl = [
      '{"timestamp":"2026-06-15T10:00:00.000Z","type":"session_meta","payload":{"id":"negative-count"}}',
      '{"timestamp":"2026-06-15T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":20,"output_tokens":5}}}}',
      '{"timestamp":"2026-06-15T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"anomaly recipient"}]}}',
    ].join("\n");
    const imported = importFromCodex(jsonl);
    const assistant = imported.messages[0];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.usage?.inputTokens).toBe(0);
    expect(assistant.metadata?.codexTokenUsage).toEqual({
      input_tokens: 10,
      cached_input_tokens: 20,
      output_tokens: 5,
      inconsistent: true,
    });
  });

  it("rolls up counts that have no assistant after their preceding count boundary", () => {
    const [firstCount, secondCount, assistant] = fixture("codex-forked-rollout.jsonl").trim().split("\n");
    const repeated = importFromCodex([assistant, firstCount, secondCount].join("\n"));
    const importedAssistant = repeated.messages[0];
    if (importedAssistant?.role !== "assistant") throw new Error("expected assistant");
    expect(repeated.metadata?.custom?.codexUnattributedUsage).toEqual({
      inputTokens: 27980,
      outputTokens: 444,
      reasoningTokens: 102,
      cacheReadTokens: 20224,
      cacheWriteTokens: 0,
      events: 2,
    });
    expect(importedAssistant.usage).toBeUndefined();
  });

  it("throws when no response items exist", () => {
    expect(() => importFromCodex('{"type":"event_msg","payload":{"type":"noise"}}')).toThrow(
      /No Codex response items/,
    );
  });
});

describe("opencode importer", () => {
  const thread = importFromOpenCode(fixture("opencode-export.json"));

  it("produces a schema-valid thread with session metadata", () => {
    expect(Thread.parse(thread)).toBeTruthy();
    expect(thread.id).toBe("ses_0abc111defV0Example00001");
    expect(thread.metadata?.title).toBe("Clean up merged worktrees");
    expect(thread.metadata?.cwd).toBe("/Users/dev/example");
    expect(thread.metadata?.sourceVersion).toBe("1.18.11");
    expect(thread.createdAt).toBe(1785432240000);
    expect(thread.updatedAt).toBe(1785432299000);
  });

  it("splits embedded tool state into call + result and maps tokens", () => {
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const assistant = thread.messages[1];
    if (assistant?.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.content.map((c) => c.type)).toEqual(["reasoning", "text", "tool_call"]);
    expect(assistant.model).toBe("glm-5.2");
    expect(assistant.provider).toBe("zai-coding-plan");
    expect(assistant.usage).toEqual({
      inputTokens: 31405,
      outputTokens: 83,
      reasoningTokens: 55,
      cacheReadTokens: 128,
      cacheWriteTokens: 0,
    });

    const [call] = getToolCalls(assistant);
    expect(call?.id).toBe("call_06d8469b26674bf7a0f80d15");
    expect(call?.name).toBe("bash");
    expect(call?.parsedArguments).toEqual({ command: "git worktree list" });

    const tool = thread.messages[2];
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.toolCallId).toBe("call_06d8469b26674bf7a0f80d15");
    expect(tool.toolResults[0]?.name).toBe("bash");
    expect(getToolResultText(tool.toolResults[0]?.content)).toContain("abc1234 [main]");
  });

  it("rejects non-opencode json", () => {
    expect(() => importFromOpenCode('{"foo":1}')).toThrow(/Not an OpenCode session export/);
  });
});

function getToolResultText(content: unknown): string {
  return JSON.stringify(content ?? "");
}

describe("chatgpt export importer", () => {
  const threads = importFromChatGPTExport(fixture("chatgpt-conversations.json"));

  it("follows current_node, not the abandoned branch", () => {
    expect(threads).toHaveLength(2);
    const thread = threads[0];
    if (!thread) throw new Error("expected thread");
    expect(Thread.parse(thread)).toBeTruthy();
    const text = JSON.stringify(thread.messages);
    expect(text).not.toContain("ABANDONED BRANCH");
    expect(text).toContain("feed it twice daily");
  });

  it("tolerates a malformed children field without deleting the conversation", () => {
    const second = threads[1];
    if (!second) throw new Error("expected second thread");
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(second.messages)).toContain("Second conversation answer");
  });

  it("keeps a codex mid-session model switch per turn", () => {
    const thread = importFromCodex(fixture("codex-rollout.jsonl"));
    const assistants = thread.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.model).toBe("gpt-5.4-codex");
    expect(assistants[assistants.length - 1]?.model).toBe("gpt-5.5");
  });

  it("does not unwrap legitimate JSON tool output lacking the metadata sibling", () => {
    const jsonl = [
      '{"timestamp":"2026-08-01T12:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
      '{"timestamp":"2026-08-01T12:00:01.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}',
      `{"timestamp":"2026-08-01T12:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\\"output\\":\\"dist\\",\\"clean\\":true}"}}`,
    ].join("\n");
    const thread = importFromCodex(jsonl);
    const tool = thread.messages.find((m) => m.role === "tool");
    if (tool?.role !== "tool") throw new Error("expected tool");
    // No metadata sibling → this is real tool output, kept verbatim.
    expect(tool.toolResults[0]?.content[0]?.type).toBe("text");
    expect(JSON.stringify(tool.toolResults[0]?.content)).toContain("clean");
  });

  it("backfills the session model for items before the first turn_context", () => {
    const jsonl = [
      '{"timestamp":"2026-08-01T12:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
      '{"timestamp":"2026-08-01T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"early"}]}}',
      '{"timestamp":"2026-08-01T12:00:02.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}',
      '{"timestamp":"2026-08-01T12:00:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}}',
      '{"timestamp":"2026-08-01T12:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"late"}]}}',
    ].join("\n");
    const thread = importFromCodex(jsonl);
    const assistants = thread.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.model).toBe("gpt-5.5"); // backfilled
    expect(assistants[1]?.model).toBe("gpt-5.5");
  });

  it("unwraps codex {output, metadata} wrappers in tool results", () => {
    const jsonl = [
      '{"timestamp":"2026-08-01T12:00:00.000Z","type":"session_meta","payload":{"id":"s1","cwd":"/x"}}',
      '{"timestamp":"2026-08-01T12:00:01.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}',
      `{"timestamp":"2026-08-01T12:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\\"output\\":\\"unwrapped text\\",\\"metadata\\":{\\"exit_code\\":0}}"}}`,
    ].join("\n");
    const thread = importFromCodex(jsonl);
    const tool = thread.messages.find((m) => m.role === "tool");
    if (tool?.role !== "tool") throw new Error("expected tool");
    expect(tool.toolResults[0]?.content[0]).toEqual({ type: "text", text: "unwrapped text" });
  });

  it("does not delete a user event because one content block is malformed", () => {
    const warnings: string[] = [];
    const jsonl = [
      '{"type":"user","uuid":"u1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{"role":"user","content":[null,{"type":"text","text":"IMPORTANT USER SPEECH"}]}}',
      '{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:01.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      "corrupt line",
    ].join("\n");
    const thread = importFromClaudeCode(jsonl, { onWarn: (m) => warnings.push(m) });
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(thread.messages)).toContain("IMPORTANT USER SPEECH");
    expect(warnings.join(" ")).toContain("skipped 1");
  });

  it("merges split assistant messages across interleaved sidechain lines", () => {
    const jsonl = [
      '{"type":"user","uuid":"u1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:01.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"part one"}]}}',
      '{"type":"user","uuid":"side1","isSidechain":true,"sessionId":"s","timestamp":"2026-08-01T10:00:02.000Z","message":{"role":"user","content":"sidechain prompt"}}',
      '{"type":"assistant","uuid":"a2","sessionId":"s","timestamp":"2026-08-01T10:00:03.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"part two"}]}}',
    ].join("\n");
    const thread = importFromClaudeCode(jsonl, { includeSidechains: true });
    const ids = thread.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    const merged = thread.messages.find((m) => m.id === "m1");
    if (merged?.role !== "assistant") throw new Error("expected assistant");
    expect(merged.content).toHaveLength(2);
    const sidechain = thread.messages.find((m) => m.metadata?.["sidechain"] === true);
    expect(sidechain).toBeTruthy();
  });

  it("preserves redacted thinking data for replay", () => {
    const jsonl =
      '{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"2026-08-01T10:00:00.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"redacted_thinking","data":"OPAQUE_REPLAY_MATERIAL"}]}}';
    const thread = importFromClaudeCode(jsonl);
    expect(JSON.stringify(thread.messages)).toContain("OPAQUE_REPLAY_MATERIAL");
  });

  it("maps roles, thoughts, hidden system messages, and second-based times", () => {
    const thread = threads[0];
    if (!thread) throw new Error("expected thread");
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    const thoughts = thread.messages[1];
    if (thoughts?.role !== "assistant") throw new Error("expected assistant");
    expect(getReasoning(thoughts)).toContain("hungry, not dead");
    expect(thoughts.model).toBe("gpt-5");
    expect(thoughts.provider).toBe("openai");
    expect(thread.messages[0]?.timestamp).toBe(1754040001000);
    expect(thread.createdAt).toBe(1754040000123);
    expect(thread.metadata?.title).toBe("Sourdough starter help");
  });
});

describe("round trips", () => {
  const imports: Array<[string, () => Thread]> = [
    ["claude-code", () => importFromClaudeCode(fixture("claude-code-session.jsonl"))],
    ["codex", () => importFromCodex(fixture("codex-rollout.jsonl"))],
    ["opencode", () => importFromOpenCode(fixture("opencode-export.json"))],
    ["chatgpt", () => importFromChatGPTExport(fixture("chatgpt-conversations.json"))[0]!],
  ];
  type Thread = ReturnType<typeof importFromClaudeCode>;

  for (const [name, load] of imports) {
    it(`${name} → thread JSON → thread preserves everything`, () => {
      const thread = load();
      const restored = threadFromJson(threadToJson(thread));
      expect(restored).toEqual(thread);
      // Byte stability holds from the first zod-parsed generation onward.
      const canonical = threadToJson(restored);
      expect(threadToJson(threadFromJson(canonical))).toBe(canonical);
    });
  }

  it("preserves text and tool calls through the canonical format", () => {
    const thread = importFromClaudeCode(fixture("claude-code-session.jsonl"));
    const restored = threadFromJson(threadToJson(thread));
    for (let i = 0; i < thread.messages.length; i++) {
      const original = thread.messages[i]!;
      const back = restored.messages[i]!;
      expect(getTextContent(back)).toBe(getTextContent(original));
      if (original.role === "assistant" && back.role === "assistant") {
        expect(getToolCalls(back)).toEqual(getToolCalls(original));
      }
    }
  });
});
