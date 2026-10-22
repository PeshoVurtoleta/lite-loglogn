# Changelog

All notable changes to `@zakkster/lite-loglogn` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`XFastTrie`, the second member (0.3.0).** O(log log U) `successor` /
  `predecessor` over a FIXED universe [0, U), 2 <= U <= 2^32, holding at most a
  FIXED `capacity` (an integer in [1, min(U, 2^24)]) of keys:
  `new XFastTrie(universe, capacity)`. One pointer-free in-file bucketized
  cuckoo LevelTable per prefix length (2 tables x B buckets x 4 slots, occupancy
  byte, no tombstones, load <= 0.90, in-place reseed of up to 32 tries; design
  parity with lite-o1 CuckooMap, no import; ADR 0007) plus a sorted leaf thread.
  Hot (0 B): `has`, `add` (idempotent, chainable), `delete`, `successor`,
  `predecessor` (both STRICT), `min`, `max`; absent = `undefined`; a bad key
  touches nothing; -0 aliases key 0. Cold: `clear()` (restores the default
  seeds and revives a poisoned instance), allocating `dump()`, getters `size`,
  `universe`, `capacity`, `bits`, `byteLength`. `add` of a NEW key at
  `size === capacity` throws a `RangeError` and writes nothing; after 32 failed
  reseed tries the add is rolled back and throws; if the rollback cannot
  re-place a level the instance is POISONED until `clear()`.
- **XFastTrie cost model (DETERMINISTIC, gated in `npm test`).** Exact
  level-table touches (T = binary-search steps, log2(w) for w = 2^j; m = the
  shorter common prefix length with the thread neighbours; the update walk stops
  early at m): `has` 1; `successor` / `predecessor` 1 (present) or 1 + T
  (absent); `min` / `max` 0; `add` new key 1 + T + (w - m); `delete` present
  w - m. Absent successor at w = 2, 4, 8, 16, 32 -> 2, 3, 4, 5, 6 touches; add
  into an empty trie 4, 7, 12, 21, 38.
- **XFastTrie caveats, stated plainly.** FAST QUERY (1 + log2(w) touches when
  absent), but O(w) UPDATE (not O(log log U)) and O(n*w) SPACE preallocated at
  the declared capacity: `byteLength = 13 TS + 12 (C+1) + 16 (w+1) + 16`
  (DETERMINISTIC pins; worst case 4,563,403,308 B at U = 2^32, C = 2^24,
  formula only). The cuckoo seeds are fixed defaults, so adversarial keys can
  force kicks and reseeds: correctness holds, time suffers. Capacity never
  grows. Hot methods allocate 0 B/op including kicks and reseeds (torture
  X0-X4; QUIET verify run 2026-10-22, load1 1.32, 12 cores, Node
  v26.8.2, 1 run, plus `test:perf` 31/31).
- **Package scripts.** Added `witness:xft` (`node test/witness.mjs --xft`, the
  XFastTrie lane; REPORTED, release-time, 2% minimum-effect floor).
- **Docs.** README, llms.txt and GUIDE.md gain the XFastTrie sections; ADR 0007
  (LevelTable), ADR 0003 Amendment 1 (L-03 settled: "reconcile" means design
  parity) and an ADR 0006 amendment (the 2% effect floor lives in `abVerdict`).
  The 0.2.0 witness results are re-tiered REPORTED (no CI for this package).
  XFastTrie timing numbers are filled from the release run only.

### Changed

- **Package scripts.** Added `witness:tier` (`node test/witness.mjs --tier`).
  Removed `bench` and `bench:report`: they pointed at a `benchmark/` directory
  that does not exist yet (it lands with the Bench-ADOPT session).

### Tests

- **XFastTrie gates** (DETERMINISTIC unless noted; `npm test` = 342
  tests, 2026-10-22, Node v26.8.2): `XftVectors` (15 seeded streams replayed
  against `test/vectors/xft-b0.json`, StratifiedBitset cross-check, a `>=`
  successor mutant control); `XftCount` (exact touches through a counting Proxy
  over all eight columns; the absent-successor and add-on-empty rows above;
  six must-fail mutant controls plus a hang control); `XFastTrie` / `XFastTrieBoundary` /
  `XFastTrieOracle` (behavior, boundary keys, seeded oracle fuzz);
  `XFastTrieSpace` (byteLength pins, identity of every column, growth
  controls); `XftBytecode` (every hot body <= 460 B); `Parity` (the
  StratifiedBitset region of `LogLogN.js` is pinned against 0.2.0 by
  `test/vectors/parity.json`); `AbVerdict` (the pure A/B verdict with a 2%
  minimum-effect floor, `test/helpers/abVerdict.mjs`; `tierVerdict` unchanged);
  `QaAudit` gains the XFastTrie coercion / boundary block (A6) and the export
  surface now includes `XFastTrie`; `XftWitness` (smoke gate for
  `node test/witness.mjs --xft --smoke`: counts and strings, never a timing).
- `npm run torture` lanes X0-X4 (0 B/op over 2,000,000 ops at U = 2^20 and
  2^30, reseed and kick churn, leak census, six must-fail controls) and
  `test/perf/XFastTriePerf.test.mjs` (17 tests; `test:perf` 31/31 with PerfGate).
- REPORTED: `node test/witness.mjs --xft` (U-sweep, n-sweep, update fit,
  latency, A/B via `abVerdict`) and `node test/space-table.mjs` (deterministic
  bytes, XFastTrie vs StratifiedBitset).
- Repo-only harness fixes (no StratifiedBitset behavior changes; its region of
  `LogLogN.js` is byte-identical to 0.2.0, gated by `Parity`). `witnessVerdict` / `tierVerdict` reject inherited
  and unknown keys (TypeError). New drift controls SPIKES3 / DIPS3 gate both
  clamp bounds. The `--tier` pre-pass control now covers each of its three
  checks. Latency lines report the clock granularity instead of a clock-floor
  p50; the w = 32 lane prints a key-boxing caveat. SiblingOracle gains a
  predecessor mutant control; torture prints its transient limit and refuses a
  semi-space flag; PerfGate requires `--max-semi-space-size=4` and proves its
  arrayBuffers lane with a side-buffer mutant; QaAudit pins the `test:perf` /
  `torture` script flags.

## [0.2.0] - 2026-10-22

### Added

- **`StratifiedBitset`, the first member.** Array-embedded O(log_32 U)
  successor / predecessor over a hierarchical bit tree on a fixed universe
  [0, U), 1 <= U <= 2^32, in ONE flat `Uint32Array`. Hot: `has`, `add`
  (idempotent, chainable), `delete`, `successor`, `predecessor` (both STRICT,
  > x / < x), `min`, `max`; absent = `undefined`. Cold: `clear`, allocating
  `dump()`, getters `size`, `universe`, `levels` (max(1, ceil(log2(U)/5))),
  `byteLength`. A bad key touches no word (`has` / `delete` false,
  `successor` / `predecessor` undefined, `add` RangeError); -0 aliases key 0;
  iteration is a successor walk only (no `forEach`, no iterator).
- **Cost model (DETERMINISTIC, gated in `npm test`).** Exact `_bits` word
  reads R / writes Wr, Lc = levels: `has` R=1; `add` / `delete` R=Wr <= Lc when
  the key changes (else R=1 Wr=0); `successor` / `predecessor` R <= 2Lc-1;
  `min` / `max` R=Lc (1 if empty). Lc = 4 at U = 2^16 and 2^20, 5 at 2^24, 6 at
  2^28, 7 at 2^32. Space is O(U/w): U = 2^32 is about 554 MB (ADR 0004
  Amendment 1); at w = 28 level 0 alone is 32 MB.
- **Level-0 peel (B1c, ADR 0006 D10).** `successor` / `predecessor` first test
  the level-0 word that holds x+1 / x-1 and return from it without touching
  level 1. No new field, same layout, same or lower exact counts than the
  pre-peel body (DETERMINISTIC tier parity against `test/vectors/tier-b1a.json`).
  Bytecode on Node 26.8.2 / V8 14.6.202.34: `successor` 264 -> 355 B,
  `predecessor` 232 -> 310 B (then 313 B, and `max` 121 -> 127 B, after the B2a-E `| 0` reads); every hot body stays <= 460 B
  (`--max-inlined-bytecode-size`), gated.
  STATISTICAL A12 result (2026-10-22, Apple M4 Pro 12 cores, Node 26.8.2,
  load1 4.79, 1 run, ns/op medians, B = peel vs A = pre-peel + the same three
  `| 0` reads): dense-succ 3.63 vs 4.10 (15/0, 11.5% faster); sparse-succ 7.59
  vs 7.81 (12/3, none); dense-pred 3.19 vs 3.82 (14/1, 16.5% faster);
  sparse-pred 6.70 vs 6.68 (8/7, none); no scenario lost. The A12 gate itself
  returned EXIT 2 (inconclusive): the dense-succ A/A twin went 1/14 (3.64 vs
  3.60, about a 1% difference on identical code). The peel ships by maintainer
  waiver of the A/A rule for this run (effect size about 10x the A/A
  difference, no loss). Open: an effect-size floor for the A/A rule.
- **Gates.** `npm test` = 151 tests (Node 26.8.2, 2026-10-22): Count (exact
  R / Wr through a counting Proxy over the shipped `_bits`), Oracle (seeded fuzz
  vs an independent oracle), SiblingOracle (lite-o1 `BitSet.nextSet` U <= 2^25,
  lite-o1 `EliasFano.nextGEQ`, lite-logn `Scapegoat` + `SortedArray`; each with a
  must-fail control), FastBit32Cross, Space (byteLength pins + a growing-bitset
  control), TierParity (tier parity + bytecode caps), WitnessVerdict /
  TierVerdict, QaAudit. `npm run torture`: T0 2,000,000 ops at U = 2^20 ->
  retained 0 B/op, transient 0.000 B/op, gc major 0 / minor 0; T1-T3 ok.
  `npm run test:perf`: 7 zero-alloc scenarios + 2 must-fail teeth = 10/10.
  `npm run test:big`: opt-in big-universe suite.
- **STATISTICAL witness (release-time, NOT in `verify`).** `npm run witness`
  (A8), `npm run witness:w32` (opt-in w = 32, about 554 MB) and
  `node test/witness.mjs --tier` (A12): K = 15 interleaved ABBA rounds, a win
  needs 13 of 15, a must-fail control, an A/A twin, a lite-adaptive drift check,
  load1 > 0.5 x cores -> exit 2; exit 0 pass / 1 fail / 2 inconclusive. Headline
  (A8, FULL, 2026-10-22, Apple M4 Pro 12 cores, Node 26.8.2, load1 3.66 -> 3.71,
  shared host under quiet-lock, 1 run, EXIT 0): member `successor` at w = 28
  beat a local `Uint32Array` binary search at all 9 n from 1e3 to 1e7 (15/0 each;
  member 11.74-17.84 ns/op, binary search 32.22 -> 197.78), so the crossover is
  at or below n = 1e3 (the smallest n tested). U-sweep vs a flat bitset at
  n = 4096: w = 16 4.87 vs 4.33 (none), w = 20 5.52 vs 12.31, w = 24 7.61 vs
  69.00, w = 28 22.04 vs 884.42 (wins). Control 0/15 and A/A 7/8 as required.
  REPORTED fits: the w axis fits better (R^2 0.7293) than log2(w) (R^2 0.6589),
  as expected for an O(log_32 U) member; no `log2(w)` line is claimed.
  Timing is evidence on one host; the BOUND is proven by the counts.
- **Decision record.** [`decisions/0006-stratifiedbitset.md`](./decisions/0006-stratifiedbitset.md)
  (D10, A12 and the waiver, the counting method, the D8 protocol).
- **Docs.** `GUIDE.md` gains the "which bitset" table and a user-side
  composition recipe; `LogLogN.d.ts` and `test/types/loglogn.test-d.ts` cover the
  class.
- **devDependencies** (none ship): `@zakkster/lite-fastbit32`,
  `@zakkster/lite-o1`, `@zakkster/lite-logn`, `@zakkster/lite-sketch`,
  `@zakkster/lite-adaptive`, `@zakkster/lite-perf-gate`,
  `@zakkster/lite-gc-profiler`, `@zakkster/lite-leak`, `esbuild`, `typescript`.

### Fixed

- **No-box reads (B2a-E).** Three ` | 0` reads (`predecessor` descend, `max`
  top, `max` descend) keep a word with bit 31 set a Smi-range int32 instead of a
  HeapNumber.
- **Torture null reading.** A null `bytesPerCall` in `test/torture.mjs` is now a
  FAIL (it was treated as 0; null is not zero).

### Changed

- **The witness is no longer in `verify`.** `npm run verify` = test +
  test:types + torture + test:perf (ADR 0006 D8); the witness is a
  release-time STATISTICAL script.
- **Counts are the hard gate** (ADR 0004 Amendment 1). No R^2 floor or slope
  band is gated; "log2(w) must win" moves to the strict O(log log U) members
  (planned), proven there by counts. The harness stub described under 0.1.0 is
  replaced by the D8 protocol above.
- **Roster.** StratifiedBitset 0.2.0; XFastTrie 0.3.0, YFastTrie 0.4.0 and
  vEBTree 0.5.0 are PLANNED.

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

[Unreleased]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PeshoVurtoleta/lite-loglogn/releases/tag/v0.1.0
