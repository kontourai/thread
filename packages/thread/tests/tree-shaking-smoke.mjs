import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "kontour-thread-tree-shaking-"));

try {
  const rootEntry = join(temporaryDirectory, "root-entry.mjs");
  const answerEntry = join(temporaryDirectory, "answer-entry.mjs");
  writeFileSync(rootEntry, 'import { Thread } from "@kontourai/thread"; console.log(Thread);');
  writeFileSync(answerEntry, 'import { createObservedMessageIdentity, createThreadAnswerRef } from "@kontourai/thread/answer"; console.log(createThreadAnswerRef(createObservedMessageIdentity("t", "m")));');
  const nodeModules = join(temporaryDirectory, "node_modules");
  mkdirSync(join(nodeModules, "@kontourai"), { recursive: true });
  // Resolve through the packed package's actual export map, as a browser
  // consumer does, rather than bundling source by a private relative path.
  symlinkSync(packageDirectory, join(nodeModules, "@kontourai", "thread"));
  const root = await build({
    absWorkingDir: temporaryDirectory,
    entryPoints: [rootEntry], bundle: true, platform: "browser", format: "esm",
    metafile: true, write: false,
  });
  const answer = await build({
    absWorkingDir: temporaryDirectory,
    entryPoints: [answerEntry], bundle: true, platform: "browser", format: "esm",
    metafile: true, write: false,
  });
  const rootInputs = Object.keys(root.metafile.inputs);
  const answerInputs = Object.keys(answer.metafile.inputs);
  if (rootInputs.some((input) => input.endsWith("/answer.js"))) throw new Error("root bundle retained answer module");
  if (!answerInputs.some((input) => input.endsWith("/answer.js"))) throw new Error("answer subpath did not bundle answer module");
  console.log("browser metafile proves root import omits answer and ./answer bundles");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
