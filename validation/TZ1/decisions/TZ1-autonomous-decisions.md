# TZ1 autonomous decisions

**Item #3 (B8 decouple strategy):** Chose option (a) — repo-local stub script — over option (b) (assert Helm's own callback parser). The test's documented purpose is to validate the callback line FORMAT produced by the emit-status script. Option (a) preserves that intent (same contract, same line format, same assertions) while decoupling from the external path. Option (b) would have changed the test's scope to testing Helm's parser instead.

**Item #1/#2 (makeV8FixtureDb sharing):** Used a single shared helper `makeV8FixtureDb()` for both C1 and C2 migration tests rather than duplicating the DDL. Justified: identical v8 starting point for both tests; DRY in test infra.

All other decisions were fully specified in APPROVED-PLAN.
