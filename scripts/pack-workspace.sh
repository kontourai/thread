#!/usr/bin/env bash
# Pack one workspace package with pnpm and print the tarball's absolute path.
#
# usage: scripts/pack-workspace.sh <package-dir> [<dest-dir>]
#
# Why pnpm packs and npm publishes: ferry depends on `@kontourai/thread` as
# `workspace:^` so release-please never has to touch pnpm-lock.yaml. Only
# `pnpm pack` rewrites that to a real range (`^<thread's version>`); `npm pack`
# and `npm publish <dir>` copy `workspace:^` into the tarball verbatim, and the
# package then cannot be installed from the registry. Publishing stays on the
# npm CLI (OIDC trust and provenance belong to it); it just receives this
# tarball instead of a directory.
#
# The last step rejects any tarball that still carries a pnpm-only protocol,
# so a regression here fails the job rather than publishing a broken package.
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
      if (/^(workspace|catalog|link|file):/.test(range)) bad.push(`${field}.${name} = ${range}`);
    }
  }
  if (bad.length > 0) {
    console.error(`pack-workspace: ${manifest.name}@${manifest.version} ships unresolved ranges:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
'; then
  exit 1
fi

echo "${tarball}"
