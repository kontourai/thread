# Contributing and documentation ownership

## Verify a checkout

Use Node 22 or later and the `pnpm@11.25.0` version in the root
`packageManager` field. The repository's script interface is `npm run`:

```sh
pnpm install --frozen-lockfile
npm run verify
npm run docs:check
npm run docs:build
```

`verify` builds, typechecks, and tests both packages. Thread also runs packed
consumer and tree-shaking smoke checks. Workspace membership and local sibling
linking live in `pnpm-workspace.yaml`; npm's `-w` selection is not configured.
Do not replace the managed install with a raw npm install in this checkout.

Importer changes require real writer output, accurate fixture provenance,
and a review of the adapter's declared fidelity losses. Invented transcript
shapes do not establish source compatibility. Schema changes affect every
adapter; review schema-version compatibility and both package contracts.

## Docs source and freshness

`corpus.json` is the v2 manifest for the Pages site and `docs-bundle.json`
consumed by documentation tools. It names the landing page, published
documents, topic routes, purpose, and product dependencies. Its empty
`builtOn` list reflects no dependency on another first-party product; Ferry
and Thread are packages within this product.

Maintain the document owning a changed contract in the same change:

| Changed area | Canonical document |
| --- | --- |
| Package setup and workspace linking | [Get started](getting-started.md) |
| CLI, dispatch/output, tool-call rows | [Ferry CLI](cli.md) |
| Adapters and detection | [Formats and fidelity](formats.md) |
| Schema, usage library, answer identities/projections | [Canonical contracts](contracts.md) |
| Root scripts and workflows | This document |

The manifest's `covers` patterns route source changes to those documents.
`docs:check` validates the manifest, topics, links/anchors, and reachability.
To include scoped freshness locally, supply the review base:

```sh
npm run docs:check -- --base origin/main
```

`docs:build` renders the site and MCP-readable bundle under ignored `dist-pages/`.
The scripts and workflow explicitly select Corpus commit
`340b66fc8f723c1babe35fce8240c82cd196b0db` so local and hosted checks use the
same reviewed implementation.

## Hosted and release boundaries

The Docs workflow calls the shared `kontourai/.github` docs gate for pull
requests, merge groups, pushes to main, and manual dispatch. On main pushes
or dispatch, the Pages job waits for that gate, builds the site/bundle, and
uses the reusable workflow's `github-pages` environment. The repository must
have GitHub Actions selected as its Pages source. Hub registration, hosted
deployment, and aggregate MCP discovery require their own configuration and
successful hosted runs; a local build proves only local output.

The ordinary CI runs verification on Node 22/24 and package publish-path dry
runs. Release-please manages each package's versions/changelogs; the publishing
workflow handles `thread-v*` and `ferry-v*` component tags, verifies the checkout,
checks tag/version and main ancestry, and publishes each member separately.
Do not hand-edit versions or publish locally. Docs publication and npm package
publication are separate operations.
