# Changelog

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
