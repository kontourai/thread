#!/usr/bin/env bash
# Pack one workspace package with pnpm and print the tarball's absolute path.
#
# usage: scripts/pack-workspace.sh <package-dir> [<dest-dir>]
#
# Why pnpm packs and npm publishes: ferry depends on `@kontourai/thread` as
# `workspace:^` so release-please never has to touch pnpm-lock.yaml. `pnpm pack`
# rewrites that to a real range (`^<thread's version>`); `npm pack` and
# `npm publish <dir>` copy `workspace:^` into the tarball verbatim, and the
# package then cannot be installed from the registry. Publishing stays on the
# npm CLI so the existing trusted-publishing (OIDC) and provenance setup does
# not change; npm just gets this tarball instead of a directory.
#
# The last step fails if the packed package.json still has a local-only range
# (workspace:, catalog:, link:, file:, portal:, git+file:, or a bare path), so a
# broken pack stops the job instead of publishing a package nobody can install.
set -euo pipefail

dir="${1:?usage: pack-workspace.sh <package-dir> [<dest-dir>]}"
dest="${2:-$(mktemp -d)}"
mkdir -p "${dest}"
dest="$(cd "${dest}" && pwd)"

if ! (cd "${dir}" && pnpm pack --pack-destination "${dest}") > "${dest}/pack.log" 2>&1; then
  cat "${dest}/pack.log" >&2
  echo "pack-workspace: pnpm pack failed for ${dir}" >&2
  exit 1
fi

tarballs=("${dest}"/*.tgz)
if [ "${#tarballs[@]}" -ne 1 ] || [ ! -f "${tarballs[0]}" ]; then
  echo "pack-workspace: expected exactly one .tgz in ${dest}, found ${#tarballs[@]}" >&2
  exit 1
fi
tarball="${tarballs[0]}"

# Read the packed manifest, not the source one: the source is expected to say
# `workspace:^`; the tarball is what must not.
if ! tar -xzOf "${tarball}" package/package.json | node -e '
  const manifest = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const bad = [];
  for (const field of fields) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      // A local-only range: a pnpm/local protocol, or a bare path. trim() and /i
      // because " file:../x" and "FILE:../x" are still local paths.
      if (/^(?:(?:workspace|catalog|link|file|portal|git\+file):|\.{0,2}\/|~\/)/i.test(String(range).trim())) bad.push(`${field}.${name} = ${range}`);
    }
  }
  if (bad.length > 0) {
    console.error(`pack-workspace: ${manifest.name}@${manifest.version} has local-only ranges npm cannot install:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
'; then
  exit 1
fi

echo "${tarball}"
