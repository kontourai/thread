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

describe("gemini exporter", () => {
  const thread = sampleThread();
  const contents = exportToGemini(thread);

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

  it("escapes titles that would break YAML", () => {
    const thread = { ...sampleThread(), metadata: { title: 'He said: "quote"' } };
    const md = exportToMarkdown(thread);
    expect(md).toContain('title: "He said: \\"quote\\""');
  });
});
