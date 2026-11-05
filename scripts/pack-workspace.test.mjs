// Runs scripts/pack-workspace.sh as a child process against throwaway
// workspaces and asserts its exit status and output. Run: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "pack-workspace.sh");

/**
 * Build and install a two-package pnpm workspace in which `app` depends on
 * `lib` as `workspace:^`. `pnpm pack` only resolves that once the workspace is
 * installed. `extraDeps` are added to app's manifest AFTER the install, so
 * pnpm is not asked to resolve deliberately bad ranges; `pnpm pack` does not
 * validate them, which is why the script has a guard.
 */
function makeWorkspace(extraDeps = {}) {
  const root = mkdtempSync(join(tmpdir(), "pack-ws-test-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const manifests = {
    lib: { name: "@t/lib", version: "2.3.4" },
    app: { name: "@t/app", version: "1.0.0", dependencies: { "@t/lib": "workspace:^" } },
  };
  for (const [name, manifest] of Object.entries(manifests)) {
    const dir = join(root, "packages", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, files: ["index.js"] }));
    writeFileSync(join(dir, "index.js"), "export {};\n");
  }
  try {
    const install = spawnSync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], { cwd: root, encoding: "utf8" });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    if (Object.keys(extraDeps).length > 0) {
      const file = join(root, "packages", "app", "package.json");
      const manifest = { ...manifests.app, files: ["index.js"] };
      manifest.dependencies = { ...manifest.dependencies, ...extraDeps };
      writeFileSync(file, JSON.stringify(manifest));
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true }); // don't leak the directory when setup fails
    throw error;
  }
  return root;
}

function pack(root) {
  const dest = join(root, "out");
  const run = spawnSync(script, [join(root, "packages", "app"), dest], { encoding: "utf8" });
  return { ...run, dest };
}

function packedDependencies(tarball) {
  const out = spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout).dependencies;
}

test("workspace:^ is packed as a real range and the tarball path is printed", () => {
  const root = makeWorkspace();
  try {
    const run = pack(root);
    assert.equal(run.status, 0, run.stderr);
    const tarball = run.stdout.trim();
    assert.match(tarball, /app-1\.0\.0\.tgz$/);
    assert.equal(packedDependencies(tarball)["@t/lib"], "^2.3.4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// pnpm leaves these alone on pack, so the guard is the only thing stopping them
// from being published. The padded and upper-case forms are real bypasses that
// a plain /^file:/ test lets through; bare paths and portal: are local too.
const localRanges = [
  "file:../lib",
  " file:../lib",
  "FILE:../lib",
  "link:../lib",
  "portal:../lib",
  "git+file:///opt/lib",
  "../lib",
  "./lib",
  "/opt/lib",
  "~/lib",
];
for (const range of localRanges) {
  test(`rejects a tarball that still has ${JSON.stringify(range)}`, () => {
    const root = makeWorkspace({ "@t/other": range });
    try {
      const run = pack(root);
      assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stdout}\n${run.stderr}`);
      assert.equal(run.stdout, "", "a rejected pack must not print a tarball path");
      assert.match(run.stderr, /has local-only ranges/);
      assert.ok(run.stderr.includes(`dependencies.@t/other = ${range}`), run.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
