# Changelog

All notable changes to `@zakkster/lite-loglogn` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`vEBTree` (0.5.0, unreleased): a flattened van Emde Boas tree.** Worst-case
  O(log log U) `has` / `add` / `delete` / `successor` / `predecessor` and O(1)
  `min` / `max` over a fixed universe U in [2, 2^32], in ONE preallocated
  `Uint32Array` (no hashing, no reseed, no amortized split). Constructor
  `new vEBTree(universe)` (no capacity, no seed); getters `size`, `universe`,
  `bits`, `byteLength`; `clear()`. Layout: leaf cutoff w <= 8, a per-width split
  (lo = 8, or 16 above w = 24), a `[min, max]` header with min not stored in its
  cluster, EMPTY = min > max stored `[0xFFFFFFFF, 0]`, the root's cluster count
  trimmed to ceil(U / 2^lo). Seven self-contained hot loops (no helper call,
  recursion or closure). Appended after `YFastTrie`; the three older members are
  byte-identical.
- **ADR 0009 (`decisions/0009-veb-flattening.md`).** The flattened layout, the
  split table, the trimmed root, and the expected loss row against
  StratifiedBitset published up front (WIN on `min` / `max` and on out-of-range
  queries, LOSE on `has` and on same-word neighbours); per-operation counts are
  gated, never written in prose.
- **Space numbers.** Exact `byteLength` (O(U), the whole universe allocated by
  the constructor): U = 2 -> 4 B, 257 -> 76 B, 2^16 -> 8,232 B, 2^20 -> 131,604 B,
  2^24 -> 2,105,392 B, 2^24 + 1 -> 2,115,708 B (trimmed root), 2^28 -> 33,718,804 B,
  2^32 -> 539,500,592 B. About 0.97 of StratifiedBitset's bytes for w = 13 .. 32.
- **`test/ParityPrefix.test.js` + `test/vectors/parity-prefix.json`.** Everything
  before the vEBTree marker (StratifiedBitset, XFastTrie, YFastTrie and their
  shared prelude) is byte-pinned (bytes + sha256) against the 0.4.1 engine bytes,
  with same-length mutation, grown-region and missing-marker controls;
  `parity.json` is untouched.
- **Test-only vEB reference and vectors.** `test/helpers/vebRef.mjs` (the textbook
  recursion kept out of the engine), `vebSketch.mjs` (the research sketch),
  `vebStream.mjs` (seeded op streams) and `test/vectors/veb-g1.json`, regenerated
  byte for byte and replayed on the reference and on the engine by
  `test/VebVectors.test.js` (engine mutants run in Workers with a kill
  timer; a timeout is a FAIL).
- **`test/VEBTree.test.js` + `test/_veb-big-worker.mjs`.** Units and boundaries
  at several universes, the exact `byteLength` table, `clear()` against a fresh
  layout, a U = 2^31 + 12345 run against the reference, and the U = 2^32
  empty-encoding assertion in its own Worker (one at a time, fail closed), with
  must-fail mutants run through `data:` URLs.
- **`test/VebCount.test.js` + `test/helpers/vebCost.mjs`.** Exact reads and
  writes per operation on the engine's three columns (`_t`, `_g`, `_p`) through
  Proxies, expected values from an independent model walking the reference, the
  loss row against StratifiedBitset (WIN / LOSE per operation), a seeded op
  stream over 12 universes with coverage floors, and must-fail mutants.
- **`test/VebFuzz.test.js`.** A seeded differential fuzz (`LOGLOGN_SEED`, parsed
  by `test/helpers/seed.mjs`, fail closed) of the engine against the reference, a
  `Set` oracle and the sketch, with the layout compared word for word at
  checkpoints and `clear()` mixed in.
- **Type block.** `LogLogN.d.ts` declares `vEBTree` (the exact constructor
  `RangeError` text, read-only getters, no `dump` / `capacity` / `seed`), with
  `test/types/loglogn.test-d.ts` positive uses and `@ts-expect-error` negatives.
- **`test/DocSync.test.js`.** README, llms.txt, GUIDE.md and `LogLogN.d.ts` must
  not call vEBTree planned, and the vEBTree sections of README and llms.txt must
  carry the exact comma-formatted `byteLength` table above, with must-fail
  fixtures.
- **Docs.** README: a fourth quick-start, a vEBTree deep dive (layout, depth,
  trimmed root, space table, the loss row), an API section, roster, design-decision
  and "what this is not" entries; llms.txt: a `### vEBTree` section.

### Changed

- **`LogLogN.js` header and roster comment.** vEBTree is no longer "planned": the
  header comment states its bound and its `byteLength` formula next to the other
  members'. No change to StratifiedBitset, XFastTrie or YFastTrie.
- **`test/QaAudit.test.js`.** The frozen export surface adds `vEBTree`, and a
  vEBTree block covers bad keys (whole-`_t` compare), `-0`, the constructor
  table and leaf-word edges in a Worker, with must-fail controls.
- **`test/XFastTrieOracle.test.js`.** The `parseSeed` consumer pin goes from 5 to 6
  (the vEBTree fuzz reads `LOGLOGN_SEED`).
- **`test/ParityPrefix.test.js` and `test/YftBytecode.test.js`.** Both assumed
  YFastTrie was the last member; both now cut at the vEBTree marker, and every
  control still fails as designed.
- **README, "Y0 floor" wording.** The Y0 split / merge coverage floor is at least
  1 split AND 1 merge in every `measureAllocs` batch; the earlier text read the
  observed per-batch minimum as if it were the floor.

## [0.4.1] - 2026-11-01

### Added

- **Inlining tool (repo-only, not shipped).**
  `test/tools/inlining-budget-diff.sh` is a copy of
  LiteUtils/inlining-budget-diff.sh (source sha256 740da13b) cut to DRIVER mode:
  a TurboFan + Maglev inlining-DECISION diff (multiset compare, null control,
  NO-VERDICT guard; exit 0 SAME / 1 DIFF / 2 NO-VERDICT) plus a REPORTED budget
  report, with drivers `inl-yft` / `inl-xft` / `inl-sb` and `inl-stage.mjs`
  (freezes a LogLogN.js copy per side). Real comparisons are REPORTED and run
  under the host quiet lock, never in `npm test`; `test/InliningTool.test.js`
  (18 tests, the LiteSignal test/94 shape) gates only `--self-test` (canned
  trace text, its 41 `ok` checks pinned; an unmodified copy outside the repo
  must also pass) and two NO-VERDICT exits (a missing driver; no `--fn` or a
  removed mode), plus 13 must-fail mutants of the script (8 of LiteSignal's 12
  that apply to driver mode, 5 on this copy's own guard / null-control /
  driver-exit / removed-mode / worst-verdict paths), each of which must turn the
  self-test red on its named check. `npm run inline-budget-diff -- ...` runs
  it. No devDependency, not in `files[]`.
- **Torture lane Y1b: YFastTrie borrows are now ALLOCATION-gated.** U = 2^16 (w
  = 16, K = 32, h = 8), C = 43; a cycle is 43 adds + 43 deletes + clear(),
  census per cycle 1 split / 1 merge / 1 borrow. Line: `alloc=0 B/op over 5000
  cycles (splits+5000 merges+5000 borrows+5000) ... abGrowth=0 settled=true
  transient nsExcess=0 B / 256 cycles (limit 1024) ... badWindows=0 | ok`
  (torture, 2 runs, 2026-11-01, Node v26.8.2, load1 4.0-4.6 with other node
  processes busy: a PRELIMINARY host, but these are COUNT gates). Two new Y4
  must-fail controls: CY8 AllocBorrow (56 B/op, flips the Y1b allocation gate)
  and CY9 noRefill (borrows +0, flips the borrows floor); must-fail controls are
  now 5 (T3) + 6 (X4) + 9 (Y4) = 20 (was 18). The docs' "no Y lane fires a
  borrow" wording is replaced; inner reseeds are still fired by no Y lane
  (XFastTrie's X2 lane covers kicks and reseeds). Test / tooling only, no
  shipped code.
- **`test/YftSmallScope.test.js` (DB-2 exhaustive small-scope).** Idea from the
  sibling LiteYggdrasil ROADMAP section 4, no code import. YFastTrie at w = 4 (U
  = 12..16, K = 8, h = 2): every add / delete sequence to a fixed depth around
  fixed prefixes, deduplicated on ALL steering state (inner trie typed arrays,
  bucket layout), with a Set oracle and an invariant walker after every op;
  split / merge / borrow / full-capacity floors per U; a dedup hit also
  compares the oracle set stored with the state; three mutants must fail
  (MergeOffByOne, LostDelete, WrongDelete2), plus a clean control. 30 tests (1
  skipped: the opt-in `LOGLOGN_SMALLSCOPE_DEEP=1` run, which reached CLOSURE at
  U = 12, C = 12, seed 0: 644,632 states, depth 65, no violation -- REPORTED,
  one run, 2026-11-01, Node v26.8.2, made BEFORE the dedup-hit oracle compare
  was added and not re-run). Adds about 2.5 s to `npm test` (nominal).

### Changed

- **Witness `--yft` (test / tooling only).** An untimed warm-up of the timed
  tail instance (op #0 no longer carries the cold first touch); the COVERAGE
  fields n-sweep / U-sweep are relabelled `cfg` (config sizes); a short or bad
  probe series is now a printed FAIL (exit 1) at all four hostDrift sites
  instead of an uncaught RangeError (+1 YftWitness test).
- **Torture Y0 coverage floor.** The split / merge floor is now checked per
  measureAllocs batch (floor >= 1 / >= 1 per batch; measured minimum 12 / 12 at
  U = 2^20, 3 / 3 at U = 2^30).
- **Test and doc housekeeping.** QaAudit XFastTrie row fakes deduplicated into
  rowFakes(); the XFT_BAD source-slice asserts its '[' index. ADR 0008 prose
  rewrapped, with a dated 0.4.1 amendment (borrows allocation-gated by Y1b);
  YFastTrieBoundary / yftStream comment nits; the YFastTriePerf SideBufferYft
  JSDoc corrected (the retained ~33 KB is the scenario's fixed offset;
  arrayBuffers 36 KB vs the 0 KB budget, 3 runs, 2026-11-01, PRELIMINARY host
  load1 14-20).
- **Engine comments (no code change).** The YFastTrie cost legend now defines
  s_L (the left neighbour bucket's size); the planning ids (A3, C-4, C-7) are
  removed from shipped comments; the XFastTrie `byteLength` JSDoc names the
  constant 16 B of `_q`. Proven comment-only: the esbuild whitespace-minified
  re-print (`--minify-whitespace`, comments dropped) is byte-identical to the
  0.4.0 build's.

## [0.4.0] - 2026-10-25

### Added

- **`YFastTrie`, the third member (0.4.0).** O(log log U) `successor` /
  `predecessor` in O(n) SPACE over a FIXED universe [0, U), 2 <= U <= 2^32,
  holding at most a FIXED `capacity` of keys: `new YFastTrie(universe, capacity,
  seed?)`. An inner XFastTrie over O(n/w) separator representatives plus bounded
  sorted `Uint32Array` buckets in ONE preallocated pool; DETERMINISTIC, no RNG
  (ADR 0008). Policy: w = ceil(log2 U), K = 2w, h = ceil(w/2); the head rep 0 is
  permanent (0..K keys); every other bucket holds h..K; a new key into a K-key
  bucket splits it, a delete from a non-head bucket of s <= h keys merges into
  the left neighbour or borrows. The same method surface as XFastTrie (hot,
  0 B: `has`, `add`, `delete`, `successor`, `predecessor`, `min`, `max`; cold:
  `clear()`, allocating `dump()` returning `{ universe, capacity, size, bits,
  keys, reps, sizes }`; getters `size`, `universe`, `capacity`, `bits`,
  `byteLength`). Claim, worded exactly: queries are O(log log U); updates are
  O(log log U) probes plus at most 2w - 1 contiguous word moves (O(w)); a
  split / merge / borrow is AMORTIZED. Failure modes: `add` of a NEW key at
  `size === capacity` throws `RangeError` ('YFastTrie is full', nothing
  written); a split or borrow whose inner add stalls throws the inner
  `RangeError` with the set UNCHANGED (so `delete` can throw too); a failed
  inner rollback POISONS the instance until `clear()`.
- **YFastTrie cost model (DETERMINISTIC, gated in `npm test`).** Exact inner
  touches, `_bk` / `_bn` reads and contiguous word moves, counted through a
  Proxy over all ten columns and checked against an independent policy model
  (`test/YftCount.test.js`; the split row replaces the plain add row and the
  merge / borrow rows replace the plain delete row): an absent successor from a
  bucket of 2w - 1 keys costs touches + bucket reads = 4, 6, 8, 10, 12 at
  w = 2, 4, 8, 16, 32 (R^2 against log2(w) 1.0000, against w 0.8710); a plain
  update moves at most 2w - 1 words, a split / merge / borrow at most 2w, an
  inner reseed makes at most 32 tries.
- **YFastTrie SPACE (DETERMINISTIC formula, pinned from a test-owned model).**
  `byteLength = 4 (Cr+1) K + (Cr+1) + 16 + XFastTrie(U, Cr).byteLength`, Cr =
  min(2 + floor(C/h), U). REPORTED (`node test/space-table.mjs`, 2026-10-25,
  Node v26.8.2, untimed): YFastTrie is 0.099 to 0.529 of XFastTrie's bytes in
  every cell of the 16-cell table (n = C = 1,000,000: 27,524,503 B at U = 2^20,
  34,123,672 B at U = 2^24, 47,484,715 B at U = 2^32); a dense universe still
  favours StratifiedBitset.
- **Optional caller seed on BOTH tries.** `new XFastTrie(U, C, seed?)` and `new
  YFastTrie(U, C, seed?)`: a uint32 integer; omitted, `undefined` or 0 = the
  default level seeds bit for bit; anything else throws `RangeError`
  '[lite-loglogn] <Class> seed must be a uint32 integer in [0, 2^32-1]; got ...'
  (validated after universe and capacity). Never random by default. ADR 0007
  Amendment 1 and ADR 0008.
- **Witness `--yft` lane and `witness:yft` script.** `node test/witness.mjs
  --yft` (REPORTED, release-time, quiet host, 2% effect floor): YFastTrie vs
  XFastTrie `successor` A/B in an n-sweep and a U-sweep, with the foils, the
  add+delete lane, fits and latency REPORTED, and a TAIL run per width whose MAX
  single-op time is printed with attribution (reseed > split > merge incl.
  borrow > plain) and carries NO timing verdict (the stated bound is the
  count-gated work bound: a split / merge / borrow moves <= 2w words, an inner
  reseed <= 32 tries). One QUIET run, 2026-10-25 (HEAD 568cd25): successor
  ratio vs XFastTrie 0.5178 at n = 1,000,000 and 0.9154 at n = 1,000 (w = 28),
  a loss (1.0444, 0 / 15 / 0) at w = 16; byteLength YFT / XFT 0.1064 to
  0.1441; slower than a local binary search at every n. README, llms.txt.
- **`--yft --smoke` gate.** `test/YftWitness.test.js` runs the counts-only smoke
  in `npm test` (counts and strings only) with five must-fail fakes
  (`test/fakes/yftw-empty|exit1|garbage|kill|nan.mjs`) plus a good-child
  positive control.
- **Docs.** README, llms.txt, GUIDE.md gain the YFastTrie sections; ADR 0008
  (ACCEPTED) with the corrected cost table (plan addendum A3); ADR 0007
  Amendment 1 accepted; the z-fast question is decided (y-fast; z-fast stays
  future work).

### Changed

- **`XFastTrie` constructor takes an optional third argument** (`seed?`), so
  `XFastTrie.length` goes 2 -> 3. Behavior is identical with the seed omitted,
  `undefined` or 0 (replay-pinned against the 0.3.0 streams); the change is in
  cold code only, no hot body changed.
- **`clear()` restores the CONSTRUCTED state** on both tries, a caller seed
  included (with no seed this is the default seeds, as in 0.3.0).
- **Package description** now lists YFastTrie as shipped (vEBTree stays
  planned).
- **JSDoc (comments only, no code token changed).** The YFastTrie cost table in
  `LogLogN.js` now gives whole-op rows (a split replaces the plain add row, a
  merge / borrow replaces the plain delete row), matching `YftCount`; the
  XFastTrie `clear()` comment says it restores the constructed seeds.

### Tests

- **`npm test` = 535 tests** (0.3.0: 343), 0 fail. New files: `YftVectors`
  (policy replay against an independent model, size-band histograms),
  `YftCount` (the cost model; seven must-fail mutant controls plus a hang
  control), `YFastTrieOracle` / `YFastTrieBoundary` (invariants, failure modes,
  bad keys, key 4294967295, 'YFastTrie is full', poison and revive),
  `YFastTrieSpace` (byteLength from a test-owned model), `YftBytecode` (every
  hot body <= 460 B), `XftSeed` (seed validation, seed 0 == omitted, `clear()`
  restoring the constructed seeds, the `xft-seed.json` replay), `YftWitness`,
  `PeelOutcome`, `WorkerFakes`.
- **FILLERS (test-only).** `PeelOutcome` (+14: every StratifiedBitset
  successor / predecessor classified FOUND / PAST / FALL, a must-diverge
  mutant), `WorkerFakes` (+27: empty / exit1 / garbage / kill / nan fakes
  (+ skip on the launcher) fail the startFn, sibling, big and launcher
  runners); `LOGLOGN_SEED` is fail-closed in the oracle tests;
  `test/big/run.mjs` now needs >= 1 real passing test; torture T3w pins the
  gcLane -> gcVerdict wiring.
- **Torture lanes** (`npm run torture`): T0-T3, X0-X4 and the new Y0a / Y0b /
  Y1 (+ Y1c) / Y2 / Y3 / Y4 (splits and merges at 0 B/op, no lane fires a
  borrow; Y2 includes a straddle step with keys >= 2^31 on the transient
  lane); must-fail controls 5 (T3) + 6 (X4) + 7 (Y4) = 18, all flip.
- **`npm run test:perf` = 51** (PerfGate 15 + XFastTriePerf 17 + YFastTriePerf
  19; YFastTriePerf's three must-fail teeth: a fresh-array loop flips the
  scavenge lane only, GrowingYft flips grows and arrayBuffers, SideBufferYft
  flips arrayBuffers only). verify run 2026-10-25 (load1 6.58, a PRELIMINARY
  host; these are allocation-count gates), Node v26.8.2, 1 run.

## [0.3.0] - 2026-10-23

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
  v26.8.2, 1 run; `test:perf` 32/32 in the QUIET release verify run 2026-10-23).
- **Package scripts.** Added `witness:xft` (`node test/witness.mjs --xft`, the
  XFastTrie lane; REPORTED, release-time, 2% minimum-effect floor).
- **Docs.** README, llms.txt and GUIDE.md gain the XFastTrie sections; ADR 0007
  (LevelTable), ADR 0003 Amendment 1 (L-03 settled: "reconcile" means design
  parity) and an ADR 0006 amendment (the 2% effect floor lives in `abVerdict`).
  The 0.2.0 witness results are re-tiered REPORTED (no CI for this package).
  XFastTrie timing numbers are in README and llms.txt (REPORTED, one run).

### Changed

- **Package scripts.** Added `witness:tier` (`node test/witness.mjs --tier`).
  Removed `bench` and `bench:report`: they pointed at a `benchmark/` directory
  that does not exist yet (it lands with the Bench-ADOPT session).

### Tests

- **XFastTrie gates** (DETERMINISTIC unless noted; `npm test` = 343
  tests, 2026-10-23, Node v26.8.2): `XftVectors` (15 seeded streams replayed
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
  `test/perf/XFastTriePerf.test.mjs` (17 tests; `test:perf` 32/32 with PerfGate's 15).
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
  `torture` script flags. `witness --xft` runs the probe tier-up inside a GC
  window (lite-gc-profiler + arrayBuffers, zero tolerance, CONTROL gc-window
  must-fail rows; a violation prints FAIL and exits 1); its tie column of the --xft lines
  prints rounds - wins - losses. Torture T3 / X4 gained gc-kick must-fail
  controls (gcKick / xGcKick: a forced major GC inside the window must flip
  the gc check).

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

[Unreleased]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PeshoVurtoleta/lite-loglogn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PeshoVurtoleta/lite-loglogn/releases/tag/v0.1.0
