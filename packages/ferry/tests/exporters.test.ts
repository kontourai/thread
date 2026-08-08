import { describe, expect, it } from "vitest";
import {
  createAssistantMessage,
  createSystemMessage,
  createThread,
  createToolMessage,
  createUserMessage,
  type Thread,
} from "@kontourai/thread";
import {
  exportToAnthropicMessages,
  exportToGemini,
  exportToMarkdown,
  exportToOpenAIChat,
  extractSystemInstruction,
  extractSystemPrompt,
} from "../src/index.js";

function sampleThread(): Thread {
  const t = "thread-x";
  return createThread([
    createSystemMessage(t, "You are terse."),
    createUserMessage(t, "List the files."),
    createAssistantMessage(t, [
      { type: "reasoning", reasoning: { type: "reasoning", text: "ls is enough", signature: "sig1" } },
      { type: "text", text: "Listing now." },
      {
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "bash",
          arguments: '{"command":"ls"}',
          parsedArguments: { command: "ls" },
        },
      },
    ]),
    createToolMessage(t, [
      { toolCallId: "call-1", name: "bash", content: [{ type: "text", text: "a.txt\nb.txt" }] },
    ]),
    createAssistantMessage(t, [{ type: "text", text: "Two files: a.txt and b.txt." }]),
  ]);
}

describe("anthropic exporter", () => {
  const thread = sampleThread();
  const messages = exportToAnthropicMessages(thread);

  it("hoists system content out and starts with the user turn", () => {
    expect(extractSystemPrompt(thread)).toBe("You are terse.");
    expect(messages[0]?.role).toBe("user");
  });

  it("emits tool results exactly once, as tool_result blocks", () => {
    const toolResultCarrier = messages[2];
    expect(toolResultCarrier?.role).toBe("user");
    expect(toolResultCarrier?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: [{ type: "text", text: "a.txt\nb.txt" }],
      },
    ]);
  });

  it("round-trips thinking with signature and structured tool input", () => {
    const assistant = messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toEqual([
      { type: "thinking", thinking: "ls is enough", signature: "sig1" },
      { type: "text", text: "Listing now." },
      { type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } },
    ]);
  });

  it("alternates roles strictly", () => {
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i]?.role).not.toBe(messages[i - 1]?.role);
    }
  });

  it("drops unsigned reasoning instead of emitting API-rejectable thinking", () => {
    const t = "thread-r";
    const thread = createThread([
      createUserMessage(t, "q"),
      createAssistantMessage(t, [
        { type: "reasoning", reasoning: { type: "reasoning", text: "unsigned" } },
        { type: "text", text: "answer" },
      ]),
    ]);
    const messages = exportToAnthropicMessages(thread);
    expect(JSON.stringify(messages)).not.toContain("unsigned");
    expect(messages[1]?.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("re-emits redacted thinking data as redacted_thinking blocks", () => {
    const t = "thread-red";
    const thread = createThread([
      createUserMessage(t, "q"),
      createAssistantMessage(t, [
        {
          type: "reasoning",
          reasoning: {
            type: "reasoning",
            providerMetadata: { redacted: true, data: "OPAQUE_REPLAY_MATERIAL" },
          },
        },
        { type: "text", text: "a" },
      ]),
    ]);
    const messages = exportToAnthropicMessages(thread);
    expect(messages[1]?.content[0]).toEqual({
      type: "redacted_thinking",
      data: "OPAQUE_REPLAY_MATERIAL",
    });
  });

  it("omits empty text parts everywhere (the API rejects empty text blocks)", () => {
    const t = "thread-e";
    const thread = createThread([
      createUserMessage(t, [{ type: "text", text: "" }, { type: "text", text: "real" }]),
      createAssistantMessage(t, [
        { type: "tool_call", toolCall: { id: "c1", name: "x", arguments: "{}" } },
      ]),
      createToolMessage(t, [
        { toolCallId: "c1", name: "x", content: [{ type: "text", text: "" }] },
      ]),
    ]);
    const messages = exportToAnthropicMessages(thread);
    const flat = JSON.stringify(messages);
    expect(flat).not.toContain('{"type":"text","text":""}');
    const toolResult = messages[2]?.content[0];
    // content key omitted entirely — an empty array is untested against the API
    expect(toolResult).toEqual({ type: "tool_result", tool_use_id: "c1" });
  });

  it("survives unparseable tool arguments without throwing", () => {
    const t = "thread-y";
    const thread = createThread([
      createAssistantMessage(t, [
        {
          type: "tool_call",
          toolCall: { id: "c", name: "custom", arguments: "*** not json ***" },
        },
      ]),
    ]);
    expect(exportToAnthropicMessages(thread)[0]?.content[0]).toEqual({
      type: "tool_use",
      id: "c",
      name: "custom",
      input: {},
    });
  });
});

describe("openai exporter", () => {
  const messages = exportToOpenAIChat(sampleThread());

  it("keeps system inline and pairs tool results by tool_call_id", () => {
    expect(messages[0]).toEqual({ role: "system", content: "You are terse." });
    const assistant = messages[2];
    expect(assistant?.tool_calls?.[0]).toEqual({
      id: "call-1",
      type: "function",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    });
    expect(messages[3]).toEqual({
      role: "tool",
      content: "a.txt\nb.txt",
      tool_call_id: "call-1",
    });
  });
});

describe("openai exporter edge cases", () => {
  it("keeps file-only user messages as placeholders instead of deleting the turn", () => {
    const t = "thread-f";
    const thread = createThread([
      createUserMessage(t, [
        { type: "file", name: "spec.pdf", mediaType: "application/pdf", data: "u" },
      ]),
      createAssistantMessage(t, [{ type: "text", text: "read it" }]),
    ]);
    const messages = exportToOpenAIChat(thread);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "[file: spec.pdf (application/pdf)]" });
  });
});

describe("gemini exporter", () => {
  const thread = sampleThread();
  const contents = exportToGemini(thread);

  it("merges a tool response and a following user turn into one user content", () => {
    const t = "thread-g";
    const thread = createThread([
      createUserMessage(t, "start"),
      createAssistantMessage(t, [
        { type: "tool_call", toolCall: { id: "c1", name: "bash", arguments: "{}" } },
      ]),
      createToolMessage(t, [
        { toolCallId: "c1", name: "bash", content: [{ type: "text", text: "out" }] },
      ]),
      createUserMessage(t, "next question"),
    ]);
    const roles = exportToGemini(thread).map((c) => c.role);
    expect(roles).toEqual(["user", "model", "user"]); // response + user question folded
  });

  it("hoists system, uses camelCase parts, pairs function responses by name", () => {
    expect(extractSystemInstruction(thread)).toBe("You are terse.");
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "List the files." }] });
    expect(contents[1]?.parts).toContainEqual({
      functionCall: { name: "bash", args: { command: "ls" } },
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "bash", response: { content: "a.txt\nb.txt" } } }],
    });
  });
});

describe("markdown exporter", () => {
  it("renders frontmatter, roles, reasoning and truncated tool results", () => {
    const md = exportToMarkdown(sampleThread(), { maxToolResultLength: 5 });
    expect(md).toContain("## User");
    expect(md).toContain("## Assistant");
    expect(md).toContain("Reasoning");
    expect(md).toContain("**→ bash**");
    expect(md).toContain("more characters)");
    expect(md.startsWith("---\n")).toBe(true);
  });

  it("cannot be broken out of a fence by backticks in tool output", () => {
    const t = "thread-m";
    const thread = createThread([
      createAssistantMessage(t, [
        { type: "tool_call", toolCall: { id: "c1", name: "web", arguments: "{}" } },
      ]),
      createToolMessage(t, [
        {
          toolCallId: "c1",
          name: "web",
          content: [{ type: "text", text: "safe\n```\n# INJECTED HEADING\n```\nmore" }],
        },
      ]),
    ]);
    const md = exportToMarkdown(thread);
    const fenced = md.slice(md.indexOf("← web result"));
    expect(fenced).toMatch(/````\n[\s\S]*# INJECTED HEADING[\s\S]*\n````/);
  });

  it("escapes titles that would break YAML", () => {
    const thread = { ...sampleThread(), metadata: { title: 'He said: "quote"' } };
    const md = exportToMarkdown(thread);
    expect(md).toContain('title: "He said: \\"quote\\""');
  });
});
