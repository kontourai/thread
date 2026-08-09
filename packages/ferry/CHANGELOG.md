# Changelog

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
