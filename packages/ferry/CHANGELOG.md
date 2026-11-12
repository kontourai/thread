# Changelog

## [0.8.0](https://github.com/kontourai/thread/compare/ferry-v0.7.0...ferry-v0.8.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **ferry:** Codex `developer` items are imported as `system` messages instead of `user` messages, and Codex `response_item` `agent_message` items (previously dropped) are imported as `user` messages with `origin.kind: "agent"`. Consumers that treat every user-role message as human input must filter on `origin`. Claude Code and Codex user and system messages now carry `origin`.

### Features

* **ferry:** stream large files, count import losses, and import Claude Code subagent transcripts ([#92](https://github.com/kontourai/thread/issues/92)) ([ef47002](https://github.com/kontourai/thread/commit/ef470024031da17b7a2a3b9ea30faff1b0822887)), closes [#35](https://github.com/kontourai/thread/issues/35)
* **ferry:** typed message origin for human vs harness- and agent-authored turns ([#76](https://github.com/kontourai/thread/issues/76), [#78](https://github.com/kontourai/thread/issues/78)) ([#91](https://github.com/kontourai/thread/issues/91)) ([060e285](https://github.com/kontourai/thread/commit/060e2850f927507eba1055a6e73321d120767ac7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @kontourai/thread bumped to 0.7.0

## [0.7.0](https://github.com/kontourai/thread/compare/ferry-v0.6.0...ferry-v0.7.0) (2026-11-05)


### Features

* import observed tool events with replay provenance ([#81](https://github.com/kontourai/thread/issues/81)) ([6d2e4bd](https://github.com/kontourai/thread/commit/6d2e4bd52c717b0fc9467bbe9389e1fed74d5d5b))


### Fixes

* make release PRs install by declaring ferry's thread dependency as workspace:^ ([#83](https://github.com/kontourai/thread/issues/83)) ([e1410c3](https://github.com/kontourai/thread/commit/e1410c3b18e239b53d9fcfe3f38e64c3ecf0e007))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @kontourai/thread bumped to 0.6.0

## [0.6.0](https://github.com/kontourai/thread/compare/ferry-v0.5.0...ferry-v0.6.0) (2026-08-25)


### Features

* **thread:** publish safe assistant answer references ([1f3d927](https://github.com/kontourai/thread/commit/1f3d927f75d42b9c8aa5cc1ee21f747de0ec1d9a))


### Fixes

* **ferry:** preserve imported answer identity standing ([0669a21](https://github.com/kontourai/thread/commit/0669a2140ae1ab9d5fb4cdfbe926c011c7411872))
* **thread:** harden answer reference projection ([9b6660a](https://github.com/kontourai/thread/commit/9b6660a73092717e514900e4abdf9afe8d3262d1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @kontourai/thread bumped from ^0.4.0 to ^0.5.0

## [0.5.0](https://github.com/kontourai/thread/compare/ferry-v0.4.0...ferry-v0.5.0) (2026-08-25)


### Features

* **ferry:** retain observed tool result identity ([98b67d2](https://github.com/kontourai/thread/commit/98b67d211ae9d53d6b99174e1b5b3c8299a97c64))
* **ferry:** row emitter, harness dimension, and a streaming usage fold ([#41](https://github.com/kontourai/thread/issues/41)) ([5b335fe](https://github.com/kontourai/thread/commit/5b335fed1ac5fd97199e737fa18f045826207f7d))
* publish stable tool result identity ([fe490e7](https://github.com/kontourai/thread/commit/fe490e7344bcf72726c2432c2645416ddd03ab84))
* **thread:** add stable tool result identity ([74c17a0](https://github.com/kontourai/thread/commit/74c17a0539c8e9842b59588aaa39d21ea0970a36))


### Fixes

* **ferry:** ground result identity in source records ([c559f74](https://github.com/kontourai/thread/commit/c559f74f80ae1b122d8d8500757f608727396a36))
* **ferry:** make Codex exec legible and name tool results after their calls ([#39](https://github.com/kontourai/thread/issues/39)) ([96c605a](https://github.com/kontourai/thread/commit/96c605a255fcff1dddd0985abc2ac68db4cf6ab4))
* **ferry:** separate fallback provenance from source ([8e52a88](https://github.com/kontourai/thread/commit/8e52a88ef3c87c0796412e74e3be683801027e73))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @kontourai/thread bumped from ^0.3.0 to ^0.4.0

## [0.4.0](https://github.com/kontourai/thread/compare/ferry-v0.3.0...ferry-v0.4.0) (2026-08-10)


### Features

* **ferry:** import Muse Code session transcripts ([#26](https://github.com/kontourai/thread/issues/26)) ([5fb227c](https://github.com/kontourai/thread/commit/5fb227cc06564638152f7cae33cce1c890ccbbec))
* **ferry:** incremental importer API — bounded per-record state machines ([#11](https://github.com/kontourai/thread/issues/11)) ([#28](https://github.com/kontourai/thread/issues/28)) ([7958355](https://github.com/kontourai/thread/commit/79583559a147b0c5864aa5cbd44362f175d693c9))


### Fixes

* **ferry:** disclose ChatGPT branch loss instead of dropping it silently ([#23](https://github.com/kontourai/thread/issues/23)) ([ade28fb](https://github.com/kontourai/thread/commit/ade28fbeffe43474dcb26e5571dea2643fca4c17))
* **ferry:** import forked-rollout agent_message/agent_reasoning as messages ([#12](https://github.com/kontourai/thread/issues/12)) ([#27](https://github.com/kontourai/thread/issues/27)) ([a2ebc1a](https://github.com/kontourai/thread/commit/a2ebc1a321b612e89ace0ca9557e0a8117d68f09))

## [0.3.0](https://github.com/kontourai/thread/compare/ferry-v0.2.0...ferry-v0.3.0) (2026-08-09)


### ⚠ BREAKING CHANGES

* **deps:** typescript 7 — name node types explicitly in ferry ([#22](https://github.com/kontourai/thread/issues/22))
* **deps:** vitest 4 — stop emitting tests into the published build ([#21](https://github.com/kontourai/thread/issues/21))
* **deps:** migrate to zod 4 ([#20](https://github.com/kontourai/thread/issues/20))

### Fixes

* **deps:** bump @types/node from 25.9.5 to 26.1.2 ([#5](https://github.com/kontourai/thread/issues/5)) ([86b644c](https://github.com/kontourai/thread/commit/86b644cb32bbd2459bd93fd265d492edf55e1e3a))
* **deps:** bump commander from 14.0.3 to 15.0.0 ([#6](https://github.com/kontourai/thread/issues/6)) ([fea97d0](https://github.com/kontourai/thread/commit/fea97d01fa63b3604ec345342289e4deff430cbd))
* **deps:** migrate to zod 4 ([#20](https://github.com/kontourai/thread/issues/20)) ([7f68727](https://github.com/kontourai/thread/commit/7f6872764d8b03178e14ebd28779140ccd4df6c2))
* **deps:** typescript 7 — name node types explicitly in ferry ([#22](https://github.com/kontourai/thread/issues/22)) ([06aa417](https://github.com/kontourai/thread/commit/06aa417dea03d1ffb4e766a3322f490973f96d27))
* **deps:** vitest 4 — stop emitting tests into the published build ([#21](https://github.com/kontourai/thread/issues/21)) ([c8c2f54](https://github.com/kontourai/thread/commit/c8c2f5406ef302ed2296b04dbd491edd03ad8fc5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @kontourai/thread bumped from ^0.2.0 to ^0.3.0

## [0.2.0](https://github.com/kontourai/thread/compare/ferry-v0.1.0...ferry-v0.2.0) (2026-08-09)


### Features

* **ferry:** claude-code importer preserves pricing-relevant usage extras ([#9](https://github.com/kontourai/thread/issues/9)) ([#14](https://github.com/kontourai/thread/issues/14)) ([6895752](https://github.com/kontourai/thread/commit/68957525e30c84286690889f34fb8aeb20532dc0))
* **ferry:** codex importer reads event_msg token_count — usage, reasoning tokens, rate-limits ([#8](https://github.com/kontourai/thread/issues/8)) ([#13](https://github.com/kontourai/thread/issues/13)) ([51c2c58](https://github.com/kontourai/thread/commit/51c2c5892071ba54d8860678034a523ef82becb8))
* portable AI conversation layer — @kontourai/thread schema + @kontourai/ferry migration CLI ([bef68b9](https://github.com/kontourai/thread/commit/bef68b9dbfd143f6c520fdf24479b39762b4d67b))
* **thread,ferry:** aggregateUsage rollup + 'ferry usage' CLI ([#10](https://github.com/kontourai/thread/issues/10)) ([#15](https://github.com/kontourai/thread/issues/15)) ([aadc1be](https://github.com/kontourai/thread/commit/aadc1bee6edcd05510fd0c425e530a0489270b58))


### Fixes

* apply independent review findings; feat: kiro and pi importers ([545791a](https://github.com/kontourai/thread/commit/545791a0137817f05734f489152251bb9ad71dfb))
* delta-review round — codex unwrap over-match, pi error-turn loss, codex model backfill ([fe6698b](https://github.com/kontourai/thread/commit/fe6698be4cb20beb6293ccb8ea47bce75c15c6fd))
* **ferry:** codex attribution windows — repair the one-turn shift merged in [#13](https://github.com/kontourai/thread/issues/13) ([#8](https://github.com/kontourai/thread/issues/8)) ([#18](https://github.com/kontourai/thread/issues/18)) ([2ac0d1c](https://github.com/kontourai/thread/commit/2ac0d1c3996cb7c096505d9859650705debdda0e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @kontourai/thread bumped from ^0.1.0 to ^0.2.0
