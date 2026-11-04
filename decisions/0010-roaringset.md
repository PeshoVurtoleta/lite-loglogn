# 0010 -- RoaringSet: a compressed ordered set over a fixed universe, fixed pools, direct or paged

- Status: ACCEPTED (2026-11-04; ships in 0.6.0, version slot ruled P-6)
- Severity: S1 (the fifth member and the compressed-set reference; it fixes the container kinds, the
  pool contract and the layout rule every later RoaringSet gate measures)
- Date: 2026-11-04
- Session: RoaringSet (0.6.0), unit G6 (docs), batch B6b
- Source: `.handoff/SPEC-roaringset.md`, section CURRENT (C-1 .. C-21) and addendum A1;
  `.handoff/PROPOSAL-roaringset.md` (sections 1 - 6, rulings Q-1 .. Q-5); the R0 decision table
  (`.handoff/research/roaring/DECISIONS.md`, 17 rows D-R1 .. V-f, all RULED at the 2026-11-04
  handshake); background RESEARCH.md section 12.13; `.handoff/PLAN-roaringset-G6.md` TASK 3

## Context

A sorted set of 32-bit keys is either a flat bitmap (O(U) space, StratifiedBitset), a trie over
hashes (XFastTrie, YFastTrie) or a fixed tree (vEBTree). None of them compresses the data it
holds: a million clustered keys cost the same as a million scattered ones, and a dense range
costs the same as an empty universe. Roaring bitmaps are the standard answer: split the key
space into 2^16-key chunks and hold each chunk in the smallest container that fits. The usual
implementations allocate a container object per chunk and grow arrays on demand, which this
package forbids on any hot path (zero allocation, bytes in a hot body).

The requirement, in four parts:

- ordered ops (`has`, `add`, `delete`, `successor`, `predecessor`, `min`, `max`) over a FIXED
  universe [0, U), 1 <= U <= 2^32;
- 0 B/op on the hot path for keys < 2^30, with the box above that stated, not hidden;
- space that follows the DATA (singletons, runs and full chunks cost little), with every pool
  preallocated and never grown, so the byte cost is known at construction;
- every failure closed: pool exhaustion throws BEFORE any write and the set is unchanged.

This ADR records the shipped shape: the container kinds, the pool and layout rules, and what the
17 ruled research decisions and the 5 proposal rulings fixed. The R0 drafts (`RoaringDraft.best.mjs`
sha256/8 fd261191, the direct layout; `RoaringDraft.best-paged.mjs` 8a1b4667, the paged layout)
are research copies; the shipped class is appended to `LogLogN.js` under the banner
`// --- RoaringSet (0.6.0) ---` and must be proven against them (see Proof obligations).

## Expected loss row (published up front)

RoaringSet is EXPECTED TO LOSE ON TIME to StratifiedBitset on `has`, `add` and `delete`, and to
WIN only on `min` and `max`. `successor` / `predecessor` also sit above 1 x SB in the table
below. It trades time for space that follows the data.

R0 U6, ratio of median time against StratifiedBitset (x SB; lower is faster), 7 ops, best (the
direct draft fd261191) against best-paged (pageBits 8, 8a1b4667). REPORTED, not a gate:

    op (conclusive cells)   best    best-paged pb8
    has (14)                5.86    4.52
    add (15)                8.73    8.94
    delete (15)             8.40    8.69
    successor (13)          1.84    2.07
    predecessor (14)        1.73    2.11
    min (15)                0.53    0.65
    max (11)                0.50    0.63

- Provenance: 1 run, 2026-11-04 06:38Z, `quiet-lock run --strict`, QUIET (load1 1.54 -> 1.24
  against a baseline of 2.21), Apple M4 Pro (12 cores), Node v26.8.2 / V8 14.6.202.34-node.28,
  K 15 interleaved rounds, 105 cells of which 8 INCONCLUSIVE are excluded, keys < 2^30
  (`u6-best.log`, `u6-best-digest.md`). Worded as a measurement of the R0 DRAFTS, not of the
  shipped build.
- Loses: `has` 4.5 - 5.9 x, `add` 8.7 - 8.9 x and `delete` 8.4 - 8.7 x the time of StratifiedBitset.
  Wins: `min` / `max` at 0.50 - 0.65 x. `successor` / `predecessor` sit at 1.73 - 2.11 x in
  these runs: slower than StratifiedBitset, not a win.
- Paged against direct: +0.12 .. +0.38 x SB on six of the seven ops; `has` is faster paged in
  this run (5.86 -> 4.52), cause unmeasured.
- The shipped build's own timing comes only from this cycle's `npm run witness:roar` run, after
  the final gate run, with provenance (C-16). Until then docs carry no RoaringSet timing and
  point to RESEARCH.md 12.13.
- Per-op read counts quoted in this record are the R0 drafts' (DETERMINISTIC on the drafts); the
  shipped counts are gated exactly by `test/RoaringCount.test.js` (lands with G4).

What the member is for: compressed storage with ordered queries. The space follows the data
(SINGLE 0 B, FULL 0 B, runs for clusters), the pools are fixed so the cost is a constructor
argument, and `min` / `max` are answered from per-chunk headers. It is not the fastest `has`
(that is StratifiedBitset) and not the hash-free worst-case reference (that is vEBTree).

## Decision

One `export class RoaringSet`, appended after vEBTree in `LogLogN.js`. Chunk c = key >>> 16
holds the keys in [c * 65536, c * 65536 + 65535]. Every decision below is quoted as ruled at the
2026-11-04 handshake (every ruling was the recommended option) unless an amendment is named.

**Layout and space (D-R1, amended by Q-1; C-3, C-5, C-19).**

- D-R1: the chunk table is either DIRECT (one row per chunk, always allocated) or PAGED (a
  directory plus pooled 2^pageBits-row pages; page 0 is a shared zero page), chosen ONCE at
  construction. Paged fields are `_kind`, `_slot`, `_card`, `_runs`, `_cMin`, `_cMax`: 11 B per row.
  Ruled: paged at large U (2^32), direct at small U, with the planner fixing the crossover.
- Q-1 AMENDS D-R1. The crossover is a BYTES rule, one line (C-5): the set is paged only when the
  paged metadata is STRICTLY smaller than 11 x C (C = ceil(U / 65536) chunks):

      11 * (maxPages + 1) * 2^pageBits + 2 * ceil(C / 2^pageBits) + 4 * maxPages + 2  <  11 * C

  `maxPages` defaults to ALL pages, so the DEFAULT constructor is direct at every U: with every
  page present, paged costs more bytes and +1 .. +4 reads. "Paged at 2^32" therefore holds only
  when the caller sizes `maxPages`: at 2^32 and pageBits 8 the set is paged iff `maxPages <= 254`
  (of 256). The strict `<` is gated by a TIE row (C-13). The `paged` getter reports the choice.
- Q-2: one exported class; the constructor picks the layout (a row map `_mi(c)`: identity for
  direct, one directory read for paged). A direct set allocates zero-length `_dir` / `_pLive` /
  `_pFree` in the same property order, so there is one hidden class (C-5).
- C-3: the `_q` instrumentation counters of the drafts are DROPPED. Shipped
  `byteLength` (direct) = 8,460 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge;
  paged replaces 11 C by 11 (maxPages + 1) 2^pageBits + 2 ceil(C / 2^pageBits) + 4 maxPages + 2.
  Every byteLength figure in the R0 and PROPOSAL files is 24 B HIGHER than the shipped values.
  Examples at U = 2^32, shipped values: default pools (direct) 3,036,180; `(0, 1)` direct
  746,270; `(0, 1, maxPages 1)` paged 31,524; `(0, 1, maxPages 254)` paged 744,984. At the
  crossover edge: 2^25 with `(0, 1, 1)` is DIRECT at 31,006 (the paged metadata 5,642 B is not
  below the direct 5,632 B); 2^26 with `(0, 1, 1)` is paged at 31,020.
- C-19: PROPOSAL 2.4 column 3 ("paged, all pages") cannot occur under the strict rule and is
  NEVER QUOTED here or in any doc. Paging pays only below the page count.
- R0 evidence behind the ruling (DETERMINISTIC, from the drafts, so 24 B higher than shipped; the
  differences between layouts are unaffected): at 2^32, empty floor 746,294 (direct) against
  31,548 (paged, minimal pools, maxPages 1); 1e6 dense 1,000,034 against 285,288; 1e3 clustered
  after `runOptimize` 746,814 against 40,528. Uniform sparse keys touch every page and gain
  nothing: 1e3 sparse 747,724 against 729,518; 1e6 sparse 9,265,844 against 9,270,198. At 2^20 the
  paged empty floor is +5,464 B over direct. Paging costs +1 read on 175 of 211 changed rows, +2
  on 21, +3 on 8, +4 on 6, and -1 on 1; a page free moves 768 words.

**Container kinds (D-R2, D-R4, V-a, V-b1, V-d, V-e, V-f).** Each chunk is held by the smallest
fitting kind: SINGLE (1 key, 0 B pool), small array (2 .. 64 keys, a 128 B small slot), array
(up to 4,096 keys, an 8 KB large slot), bitmap (8 KB plus a 66-word summary), runs (a large
slot), small runs (<= 32 runs, a 128 B small slot) and FULL (all 65,536 keys, 0 B). The
`dump()` kind names are single, small, array, bitmap, runs, smallRuns, full.

- D-R2 (ruled: keep the summary). The 66-word bitmap summary stays. `successor` / `predecessor`
  inside a bitmap read at most 6 words; without a summary a scan is up to 2,048 words
  (EXPECTED, computed from 65,536 / 32, not measured). Cost: 66 moves on every array -> bitmap
  conversion.
- D-R3 (ruled: fixed pools, no growth). Small pool, large pool and one spare slab; every
  conversion builds aside and swaps handles. vb2 size classes (8 / 16 / 64 in one small-data
  array) are an R2 planner task: they cut 1e6 sparse from 9,003,700 to 4,939,286 B but
  `_promoteSmall` grows to 485 B, over the 460 B single-inline limit.
- D-R4 (ruled: runs ship in R1). Runs, `runOptimize`, small runs (kind 5) and FULL (kind 6) ship.
  1e6 clustered keys at 2^32: 32,862,360 B before `runOptimize`, 1,241,074 B after.
- D-R5 (ruled: oracle / baseline only). PagedBitset is a test and benchmark foil, not a shipped
  tier (17,318,716 B empty at 2^32 against 31,548 B (draft value)).
- V-a (adopt). Small runs (kind 5, <= 32 runs in a 128 B slot) and FULL (kind 6, 0 B): a
  full-65536 `has` drops 3 -> 1 reads and `delete` 4 -> 3. Cost: the 32 / 33-run edge converts
  (runs-32 add 22 -> 103 reads).
- V-b1 (adopt). SINGLE (kind 7): the low 16 bits live in `_slot`, 0 B pool. Singleton `has`
  5 -> 2 reads.
- V-d (adopt, WITHOUT the `has` early reject). Per-chunk `_cMin` / `_cMax` headers: `min` /
  `max` cost 5 reads on every shape. The early reject would have cost +2 `has` reads and is
  not shipped. In the paged layout the two header fields are 4 of the 11 B per row.
- V-e (adopt). Hysteresis, module constants DEMOTE_SMALL 32 and DEMOTE_BITMAP 2048 (not knobs):
  a small array moves to a large slot at its 65th key and returns at <= 32 keys when a small
  slot is free; an array promotes to a bitmap at its 4,097th key and a bitmap demotes when a
  delete leaves 2,048. The 64 / 65 thrash drops from 10,000 to 1 conversion per 10,000 ops.
- V-f (adopt). The bitmap summary is built while setting (one write per slab word): the 4,097th
  add drops from 10,322 to 4,115 reads and a run spill from 8,291 to 6,179.
- A three-level top pyramid over the chunks (2,115 words) answers next / previous live chunk.

**Policy (P-1 .. P-7, Q-2 .. Q-5).**

- P-1 (ruled: document the box, as vEBTree CV7). Keys >= 2^31 box; see the Boxing note. A
  signed or `successorInto(key, out)` result API is an R2 task. Capping U at 2^31 was refused.
- P-2 (ruled). Deleting from a FULL chunk when the small pool is empty falls back to a large
  slot, as `add` does; it throws only when both pools are empty, before any write. So `delete`
  can throw on a present key (pool exhaustion), with the set unchanged.
- P-3 (ruled) + Q-3. `addRange(lo, hi)` over the half-open [lo, hi), 0 <= lo <= hi <= U, builds
  runs directly; `lo === hi` is a no-op; same set as the add loop; each touched chunk ends in
  the kind `runOptimize` would choose at the post-call pool state; it precounts slots and pages
  and throws RangeError before any write; a bad bound throws with nothing touched (C-8). The
  `runOptimize` cadence is documented, not automatic (no hot-path tax on `add`).
- P-4 (ruled). R2 rank is a cold `buildRank()` that freezes the set (no tax on `add` /
  `delete`); not in R1.
- P-5 (ruled). A shrink of `successor` / `predecessor` (dead -1 exits first) is a planned task: the
  in-chunk guards become unconditional and the dead -1 exits of `_bmpNextGEQ` / `_bmpPrevLEQ` go
  (C-9, lands with G4). R0 draft sizes (before the shrink): `successor` 621, `predecessor` 759,
  `add` 946, `delete` 960 B direct (paged draft: `successor` 647, `predecessor` 785), all over the
  460 B limit; `has` 439 and `min` / `max` 45 are within. The shipped bytecode figures are the G4
  pins, not these.
- P-6 / P-7 (ruled). Version slot 0.6.0; this record is `decisions/0010-roaringset.md`.
- Q-4 (ruled). Positional constructor `(universe, maxSmall = 1024, maxLarge = 256, maxPages = all,
  pageBits = 8)`; universe REQUIRED in [1, 2^32]; maxSmall [0, 65535]; maxLarge [1, 65534];
  pageBits [1, 15]; maxPages [1, ceil(C / 2^pageBits)]. No `KNOBS` export (C-4). A bad knob
  throws RangeError; pool exhaustion throws `pool exhausted (capacity N)`; page exhaustion
  throws `metadata page pool exhausted`.
- Q-5 (ruled). R1 has no iterator, `forEach`, rank or select; iteration is the documented
  `min()` / `successor()` loop. `dump()` ships (cold, allocating; kind NAMES, not ids).
- Set ops (C-6): `intersects`, `intersectionSize`, `unionSize`, `differenceSize` count, never
  materialize; `other` must be a RoaringSet of the same universe, either layout, any pageBits
  (a direct x paged pair gets its own fuzz row).
- Semantics: `successor` / `predecessor` are STRICT; -0 aliases key 0; a bad key touches nothing
  (`has` / `delete` -> false, `successor` / `predecessor` -> undefined, `add` -> RangeError).

## Boxing note

The siblings' caveat applies. The hot methods are 0 B/op on keys < 2^30. A returned key >= 2^31
boxes a HeapNumber on Node when the returning call is not inlined (>= 2^30 on Chrome / Electron,
pointer-compressed); P-1 documents it, as vEBTree CV7 does.

- Measured on keys in [2^31, 2^32), identical on the direct and paged drafts (`r3-u4-best.log`,
  `r3-u4-bestp.log`): `has` 0 B/op; `successor` ~32, `predecessor` ~32, `min` ~16, `max` ~16 B/op;
  a non-inlined caller also boxes the ARGUMENT (the non-inlined `has` lane, ~16 B/op). Every
  core lane (42 of 42) reads 0 B/op on both drafts. The ~32 / ~16 figures are REPORTED
  (control lanes that fail by design, run-to-run jitter), not gated values; the gate is a
  torture CONTROL that must read > 0 on the high-key lanes.
- The `ni.*` lanes and the per-lane TurboFan check stay REPORTED from those R0 logs (C-11);
  torture gates only the `hi.*` controls and prints `tf=UNCHECKED`.
- Set-op counts >= 2^31 on Node (>= 2^30 pointer-compressed) return boxed (EXPECTED, not
  measured).
- `addRange` (C-17, verbatim): "Allocates nothing for bounds < 2^30; a bound >= 2^31 boxes at a
  non-inlined call site (as has)."
- Torture steps that use keys >= 2^31 run on the TRANSIENT lane only.

## Literature (conclusions only)

No hardware, dates or ops-per-second are cited.

- Roaring bitmaps (Lemire et al., Software: Practice and Experience, 2018; originating papers Chambi
  et al. and Lemire et al., both 2016): the array / bitmap / run container design over 2^16-key
  chunks is the origin of the chunk size and of the array / bitmap / run kinds here (SINGLE, small
  and FULL are this package's own). This record does NOT adopt its serialization format or its
  growable allocation. Cited from general knowledge, not from an R0 source; no number is taken from
  it.
- The package's own FastBit1024 grown one level is the bitmap summary (D-R2): a bounded
  `successor` inside a bitmap, an edge over the standard bitmap scan.

## Proof obligations

- The shipped class must be proven against a Set model and against the R0 drafts (fd261191 direct,
  8a1b4667 paged) on seeded streams; parity of every prior member stays byte-identical outside
  the appended section (C-20).
- Every behavior change carries a gate that FAILS on the old code (revert check against the
  frozen 'before' build `.handoff/frozen/LogLogN.65b7d53-55efef65.js`); a mutant anchor whose
  count is not 1 is a FAIL.
- Mutant kill sets (what the test gates now): RoaringMutants = 47 fuzz rows (43 killed, 4 reasoned
  equivalents B1, B2c, B2d, S9, 0 unexplained or ABORT) plus 6 CONTRACT rows outside the 47 (the 4
  new throw-site hoists, the universe-default mutant, and the maxSmall-default mutant), the first
  5 killed by an oracle child, the maxSmall-default one in the test process (a default-constructed
  byteLength), with one unmutated control per job kind (a mutant that does not parse is an ABORT
  and FAILS its row): 49 of 53 killed, 4 equivalents (C-10a). After the G4 shrink B2c / B2d will
  be dropped with their code and the broken anchors B2a / va-m9 will be re-cut: 49 of 51 killed, 2
  equivalents (B1, S9) (C-9).
- The crossover mutant `<` -> `<=` is killed by the TIE row (U 184,942,592, `(0, 1, 10, pb8)`);
  the 254 / 255 rows kill the zero-page mutant (C-13).
- Exact byteLength: a test-owned formula (K = 8,460 plus the Q-1 rule) against the engine in
  ten configurations (DocSync rows, PLAN-G6 A-1), expected values never read from the engine.
- Exact read counts: a ledger cut from the DRAFTS before the shrink (C-9); no `addRange` or
  `runOptimize` count rows (C-12): `addRange` is gated by the add-loop identity and the Set
  model.

## Alternatives rejected

- **A direct table at every U (D-R1).** Rejected for large U where the caller sizes the pages:
  746,294 against 31,548 B empty at 2^32 (minimal pools, maxPages 1; draft values). Kept as the
  default (Q-1) and at small U.
- **A fixed U rule (paged iff U > 2^24) and a small default maxPages (Q-1 options 2 / 3).**
  Rejected: option 2 makes the default 2^32 set paged at more bytes than direct and +1 .. +4
  reads for nothing; option 3 makes uniform sparse keys throw `metadata page pool exhausted`
  past the 17th page.
- **One layout only, or two exported classes (Q-2 options 2 / 3).** Rejected: option 2 pays
  +1 .. +4 reads at every U; option 3 voids the single contract and splits the surface.
- **Dropping the bitmap summary (D-R2).** Rejected: a bitmap successor up to 2,048 words
  (EXPECTED) against 6 measured.
- **vb2 size classes in R1 (D-R3).** Rejected for R1: `_promoteSmall` 485 B (> 460 B), `has` +42 B,
  U6 `has` 9.11 x SB (REPORTED: 1 run, 2026-11-04 04:17Z, Apple M4 Pro, Node v26.8.2, QUIET load1
  2.52 vs baseline 2.21, keys < 2^30, u6-timing.log); moved to R2.
- **Runs deferred to R2 (D-R4).** Rejected: 1e6 clustered 32,862,360 -> 1,241,074 B only with
  runs and `runOptimize`.
- **PagedBitset as a shipped tier (D-R5).** Rejected: 17,318,716 B empty at 2^32.
- **Headers WITH the `has` early reject (V-d).** Rejected: +2 `has` reads (13 / 19 / 30 against
  11 / 17 / 28).
- **No hysteresis (V-e).** Rejected: 10,000 conversions per 10,000 ops at the 64 / 65 edge.
- **A signed / Into result API now; capping U at 2^31 (P-1).** Rejected for R1: the box is
  documented (vEBTree parity); the API is R2.
- **Throwing on a FULL delete with no small slot (P-2).** Rejected: asymmetric with `add`.
- **Auto-optimize on chunk close; doc only (P-3).** Rejected: a hot-path tax on `add`; no
  ingestion path.
- **Fenwick rank (P-4).** Rejected: a tax on every `add`; R2 uses a cold `buildRank()`.
- **Accepting the hot-body sizes (P-5).** Rejected: the dead -1 exits are removable bytes.
- **Inclusive or best-effort `addRange` (Q-3 options 2 / 3).** Rejected: option 3 is not
  fail-closed (writes chunks before it throws).
- **A default universe, required pools, an options object (Q-4 options 2 / 3 / 4).** Rejected:
  no sibling defaults its universe; a hidden 2.3 MB default pool is a pool-sizing choice, kept
  visible in the docs; the harnesses port unchanged with the positional order.
- **`forEach`, `[Symbol.iterator]`, no `dump()` (Q-5 options 2 / 3 / 4).** Rejected for R1.
- **Version 0.7.0; another ADR number (P-6 / P-7).** Rejected: 0.6.0 is free; this is the next
  free number.

## Consequences and gates

Tiers: DETERMINISTIC gates run in `npm test` on every run (a flake is a bug in the test);
REPORTED gates nothing. Gates marked "lands with G<n>" do not exist yet at the time of this
record and are not claimed to pass.

- G1 (the engine, DETERMINISTIC): `test/RoaringSet.test.js`; `test/RoaringFuzz.test.js` (seeded
  fuzz against the Set model); `test/RoaringMutants.test.js` (49 of 53 killed, 4 reasoned
  equivalents, C-10a); `test/RoaringVectors.test.js` (pinned traces). Lands with G1.
- G2 (layout, DETERMINISTIC): `test/RoaringPagedSpace.test.js` (byteLength rows incl. the TIE and
  254 / 255 rows); `test/RoaringDirectParity.test.js` (the direct set against its frozen
  hot-body record); `test/RoaringPagedFuzz.test.js`; `test/RoaringPagedMutants.test.js`. Lands
  with G2.
- G3 (set ops and ranges, DETERMINISTIC): `test/RoaringSetOps.test.js`;
  `test/RoaringRange.test.js`. Lands with G3.
- G4 (counts and bytecode, DETERMINISTIC): `test/RoaringCount.test.js` (exact read counts;
  paged rows use maxPages 16); `test/RoaringBytecode.test.js` (post-shrink size pins, cut once,
  C-9). Lands with G4.
- G5 (torture, DETERMINISTIC): `node --expose-gc test/torture.mjs` R lanes 38 -> 76 -> 93 plus
  controls and retention, with the `hi.*` box lanes as CONTROLS that must read > 0 (their
  magnitude is REPORTED). Lands with G5.
- G6 (docs, DETERMINISTIC): the DocSync RoaringSet rows (byteLength formula against engine,
  `paged` against the rule, README and llms sections carrying the byte figures, stale-phrasing
  rows); `npm run test:types` (the RoaringSet block, each `@ts-expect-error` its own control).
  Lands with G6 (B6c).
- G7 (witness, REPORTED): `test/RoarWitness.test.js` is a DETERMINISTIC smoke (the harness runs
  and prints); timing itself is `npm run witness:roar` (`test/witness-roar.mjs`), REPORTED,
  OUTSIDE `verify` and `test:perf`, no exit code gates, one run on the shipped build through
  quiet-lock `run --strict` (C-14, C-15: paged and mixed children at w 32 only). Lands with G7.
- Gates REPORTED only: box B/op (~32 / ~16), the `ni.*` lanes and the TurboFan check (R0 logs),
  every timing figure above.
- README and llms.txt timing comes only from this cycle's G7 run (C-16); none, no numbers.
- Consequence for users: the byte cost is a constructor argument and the default constructor
  is direct at every U; sizing `maxPages` is how a caller buys the small paged floor.
