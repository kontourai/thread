import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
const packageTarball = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "kontour-thread-pack-"));
const consumerDirectory = join(temporaryDirectory, "consumer");

try {
  execFileSync("npm", ["pack", "--pack-destination", temporaryDirectory], {
    cwd: packageDirectory,
    stdio: "inherit",
  });
  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", join(temporaryDirectory, packageTarball)], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  writeFileSync(
    join(consumerDirectory, "smoke.mjs"),
    `import { THREAD_SCHEMA_VERSION, ToolResult, createToolResult, isIdentifiedToolResult, projectToolResult, SafeToolResultProjection } from "@kontourai/thread";
import { createObservedMessageIdentity, createThreadAnswerRef, projectAssistantAnswer } from "@kontourai/thread/answer";
const authorityDecision = { decision: "denied", authority: "policy", policyId: "policy-1" };
const correlations = [{ namespace: "source", kind: "event", id: "event-1" }];
const result = createToolResult({ toolCallId: "call", name: "tool", content: [], resultId: "result", terminalStatus: "error", isError: true, authorityDecision, correlations });
if (!isIdentifiedToolResult(result) || ToolResult.parse(result).resultId !== "result") process.exit(1);
const safe = SafeToolResultProjection.parse({ resultId: "result", name: "tool", terminalStatus: "error", authorityDecision, correlations, content: [], truncated: false, omittedParts: 0, omittedTextBytes: 0, omittedMetadataBytes: 0 });
const outcome = projectToolResult(result);
const answerRef = createThreadAnswerRef(createObservedMessageIdentity("thread", "message"));
const answer = projectAssistantAnswer(answerRef, { id: "message", threadId: "thread", role: "assistant", timestamp: 1, content: [{ type: "text", text: "answer" }] });
if (THREAD_SCHEMA_VERSION !== "1.2.0" || outcome.state !== "available" || safe.resultId !== "result" || answer.state !== "available" || answer.answer.content[0].text !== "answer") process.exit(1);
`,
  );
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumerDirectory, stdio: "inherit" });
  writeFileSync(
    join(consumerDirectory, "smoke.ts"),
    `import { ToolResult, createToolResult, isIdentifiedToolResult, projectToolResult, SafeToolResultProjection, type IdentifiedToolResult, type ToolResultAuthorityDecision, type ToolResultCorrelation, type ToolResultProjectionOutcome, type ToolResultTerminalStatus } from "@kontourai/thread";
import { createObservedMessageIdentity, createThreadAnswerRef, projectAssistantAnswer, type AssistantAnswerProjectionOutcome, type SafeAssistantAnswerProjection, type ThreadAnswerRef } from "@kontourai/thread/answer";
const status: ToolResultTerminalStatus = "error";
const authorityDecision: ToolResultAuthorityDecision = { decision: "denied", authority: "policy" };
const correlations: ToolResultCorrelation[] = [{ namespace: "source", kind: "event", id: "event-1" }];
const result: IdentifiedToolResult = createToolResult({ toolCallId: "call", name: "tool", content: [], resultId: "result", terminalStatus: status, isError: true, authorityDecision, correlations });
const parsed = ToolResult.parse(result);
if (!isIdentifiedToolResult(parsed)) throw new Error("lost identity");
const safe = SafeToolResultProjection.parse({ resultId: parsed.resultId, name: "tool", terminalStatus: parsed.terminalStatus, authorityDecision, correlations, content: [], truncated: false, omittedParts: 0, omittedTextBytes: 0, omittedMetadataBytes: 0 });
const outcome: ToolResultProjectionOutcome = projectToolResult(result);
const answerRef: ThreadAnswerRef = createThreadAnswerRef(createObservedMessageIdentity("thread", "message"));
const answer: AssistantAnswerProjectionOutcome = projectAssistantAnswer(answerRef, { id: "message", threadId: "thread", role: "assistant", timestamp: 1, content: [{ type: "text", text: "answer" }] });
const safeAnswer: SafeAssistantAnswerProjection | undefined = answer.state === "available" ? answer.answer : undefined;
void safe;
void outcome;
void safeAnswer;
`,
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true } }),
  );
  execFileSync(process.execPath, [join(workspaceDirectory, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  writeFileSync(
    join(consumerDirectory, "browser-smoke.mjs"),
    `// Browser-like: the public answer projection must not require Node globals.
const savedProcess = globalThis.process;
globalThis.process = undefined;
try {
  const { createObservedMessageIdentity, createThreadAnswerRef, projectAssistantAnswer } = await import("@kontourai/thread/answer");
  const ref = createThreadAnswerRef(createObservedMessageIdentity("thread", "message"));
  const outcome = projectAssistantAnswer(ref, { id: "message", threadId: "thread", role: "assistant", timestamp: 1, content: [{ type: "text", text: "<b>inert</b>" }] });
  if (outcome.state !== "available" || outcome.answer.content[0].text !== "<b>inert</b>") throw new Error("browser-like answer projection failed");
} finally {
  globalThis.process = savedProcess;
}
`,
  );
  execFileSync(process.execPath, ["browser-smoke.mjs"], { cwd: consumerDirectory, stdio: "inherit" });
  writeFileSync(
    join(consumerDirectory, "browser-tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, types: [] } }),
  );
  execFileSync(process.execPath, [join(workspaceDirectory, "node_modules/typescript/bin/tsc"), "-p", "browser-tsconfig.json"], {
    cwd: consumerDirectory,
    stdio: "inherit",
  });
  console.log("packed Node/browser-like public root runtime and type smoke passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
