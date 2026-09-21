# Changelog

All notable changes to `@zakkster/lite-loglogn` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_The first member, StratifiedBitset, lands here (still v0.1.0 -- the scaffold
reserves the version for it)._

## [0.1.0] - 2026-09-18

### Added

- **Scaffold release.** Stands up the repo for the O(log log U) family, the
  sibling of `@zakkster/lite-o1` (the constant) and `@zakkster/lite-logn` (the
  logarithm). Ships the six `files[]` entries: `LogLogN.js` (header + the
  `VERSION` const, no member yet), `LogLogN.d.ts`, `llms.txt`, `README.md`,
  `CHANGELOG.md`, and `LICENSE`. Repo-only (not shipped): `GUIDE.md` and the gate
  harnesses (`test/torture.mjs`, `test/witness.mjs`,
  `test/perf/PerfGate.test.mjs`, `test/QaAudit.test.js`, `test/Bench.test.mjs`).
  With zero members the harnesses run green and empty.
- **The witness harness stub.** The log-linear fit machinery
  (`nsPerOp = intercept + slope*log2(w)` -- the universe BIT-WIDTH axis, NOT
  log2(n) -- least-squares `R^2` + slope), the both-axes shape, and an O(log n)
  foil are in place; the `R^2` floor + slope band are deliberately NOT gated yet
  -- they are calibrated in the StratifiedBitset session (decision D-04), which
  also settles which sweep is the HARD gate.
- **Design decisions on the record.** [`decisions/0001-identity.md`](./decisions/0001-identity.md)
  (L-01: the spanning framing, StratifiedBitset as headline),
  [`decisions/0002-name.md`](./decisions/0002-name.md) (L-02: confirm
  `@zakkster/lite-loglogn` / `LogLogN.js` / `[lite-loglogn]`),
  [`decisions/0003-substrate.md`](./decisions/0003-substrate.md) (L-03: reconcile
  the pointer-free LevelTable against the shared suite primitive, do not fork;
  direction only), [`decisions/0004-witness.md`](./decisions/0004-witness.md)
  (L-04: the log2(w) fit plan + the log2(w)-fit-wins assertion + crossover-as-hard
  -gate lean), and [`decisions/0005-policy.md`](./decisions/0005-policy.md)
  (L-05 / L-07: 32-bit default + SegmentedU as Tier 2; clz32 as a shared internal
  / cross-linked recipe, never a drifting reimplementation). Each carries the
  "Recommended resolution -- PENDING USER RATIFICATION at review" stamp.

[Unreleased]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/PeshoVurtoleta/lite-loglogn/releases/tag/v0.1.0
