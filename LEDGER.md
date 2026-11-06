# lite-loglogn -- the ledger

*Every design refused, every defect caught, every measurement trap, and the laws they produced,
for the StratifiedBitset / XFastTrie / YFastTrie / vEBTree / RoaringSet line. Each entry names
the commit, sha8 or `.handoff/` evidence it rests on; nothing here comes from memory. Nothing
here is re-litigated without a new mechanism that clears every gate the original decision
cleared.*

Numbering note: entries are numbered once, in section order (A #1-#16, B #17-#29, C #30-#39,
D #40-#46); #47-#51 are the 2026-11-06 pre-release audit (end of section B). A new entry
takes the next free number (#52 on) and is placed at the end of its section; existing numbers
never move. Commit ids are as on `main` after the maintainer's message rewrites (see #42); a
pre-rewrite id appears only in #42, as the id that moved (a57c46f, f480ab4, 5601706 are not on
main). `.handoff/` is gitignored: its paths resolve in the maintainer's main checkout only; so
does `audit/` (gitignored: each audit's <model>_FINDINGS.md, <model>_reproductions.mjs and
TRIAGE.md). SPEC = `.handoff/SPEC-roaringset.md` (A-ids are its addenda, C-ids its CURRENT
rules); PROPOSAL = `.handoff/PROPOSAL-roaringset.md`; DECISIONS =
`.handoff/research/roaring/DECISIONS.md`; HISTORY.md = `.handoff/HISTORY.md`; NEXT.md =
`.handoff/NEXT.md`; vEB PLAN = `.handoff/archive/0.5.0/PLAN-vebtree.md` (its ids are written
vEB PLAN A9, vEB PLAN C-19).

---

## The laws that fell out (read this first)

1. **A gate fails open until a control proves it closed.** Every checker row needs a control
   that fails on that row alone; an unknown kind, a NaN, a write undone before the compare, a
   crashed or timed-out mutant is a FAIL, never a pass. An exemption outlives the line it
   excused unless a must-fail deletes it with that line. *(#22, #23, #24, #25, #26, #28, #49)*
2. **An expected value never comes from the thing it checks.** Not from the code or list under
   test, not from a constant, not from one PRNG stream that also draws the ops. *(#27, #46)*
3. **Bytes in a hot body are the budget.** A dead exit, an inline `instanceof`, an early reject
   or a size-class promote costs bytecode the inliner counts; every hot body is pinned and
   every shrink is re-counted. *(#3, #5, #11, #35)*
4. **No hot-path tax for a cold benefit.** Optimise, rank and reject in a cold call the user
   chooses, never on every add / delete / has. *(#5, #7)*
5. **At large U, space picks the layout.** A design that costs a fixed share of U up front
   loses to one that pays per live chunk, even at +1 to +4 reads. *(#1, #4, #9)*
6. **A timing verdict is only as good as its control's isolation and the host state.** A
   shared instance, a lane-structural probe drift or a loaded host each moved a verdict; quote
   ranges across runs, never one run. *(#31, #33, #34)*
7. **Timers and floors come from a measured worst, with headroom, on the build they guard.**
   *(#32, #37)*
8. **Counts, traces and searches each prove one thing.** Counts are not time; EXPECTED is not
   TRACED; a hill-climb maximum is a lower bound. *(#35, #36)*
9. **A doc claim is gated, engine-derived, or removed.** An exception recorded in one place
   (an ADR) reaches every surface that states the rule. *(#29, #40, #48)*
10. **A REJECT chain names a class: close the class, not the survivor; park after the second
    REJECT.** *(#40, #41)*
11. **Name a build by its content, not its commit id.** Rewrites and autostash move ids and
    files under a running burst. *(#42, #44)*
12. **When engine and contract disagree, the maintainer picks which one moves, and the loser
    is recorded.** *(#12, #17, #21)*
13. **Quote the claim, not the reviewer's sentence.** *(#45, single incident)*
14. **A DETERMINISTIC gate may not rest on an unverified JIT decision.** A control that only
    flips when TurboFan boxes a value either checks the tier or reports no verdict; otherwise
    load turns it into a coin. *(#31, #50)*
15. **One auditor is a sample, not a census.** Two blind auditors with one brief found
    disjoint sets; a cold pass that "checks" a contract once can miss its second application.
    *(#47, #51)*

---

## A. Designs refused or parked

### #1 -- One direct chunk table as the only layout *(RULED 2026-11-04)*
- R0 measured the direct table (`best`) against a paged table (`best-paged`, pageBits 8) at
  U = 2^32: empty floor 746,294 vs 31,548 B; the paged table costs +1 to +4 reads per op.
- Ruled D-R1, then amended by Q-1: the default constructor stays direct at every U; paging is
  chosen by C-5's bytes rule when the caller lowers maxPages (`paged` is the getter). Paged < direct at 2^32 pb8 iff maxPages <= 254 (computed, re-derived by
  the PROPOSAL reviewer).
- Sources: DECISIONS D-R1; PROPOSAL section 3 and section 6 (Q-1 / Q-2); 65b7d53; 789f6d8.
- Rule: a paged layout is an option the caller sizes, not a default that moves every read.

### #2 -- Dropping the bitmap summary *(RULED 2026-11-04)*
- With the 66-word summary a bitmap successor / predecessor read at most 6 words; without it a
  scan is up to 2,048 words (EXPECTED, computed, not measured). Cost: 66 `_bSum` moves per
  array -> bitmap conversion.
- Sources: DECISIONS D-R2; PROPOSAL section 3.
- Rule: the summary is the bounded-successor edge over standard Roaring; it stays.

### #3 -- vb2 size classes in R1 *(RULED 2026-11-04; moved to R2)*
- vb2 (classes 8 / 16 / 64) shrank 1e6 sparse at 2^32 from 9,003,700 to 4,939,286 B, but
  `_promoteSmall` grew to 485 B (over the 460 B single-inline limit), has +42 B, and U6 timed
  has at 9.11 x SB, the highest of the variants (REPORTED, 1 run).
- Sources: DECISIONS D-R3; PROPOSAL section 3.
- Rule: a space win that pushes a hot helper over the inline limit waits for its own planner.

### #4 -- PagedBitset as a shipped tier *(RULED 2026-11-04)*
- At U = 2^32: 17,318,716 B empty, 138,366,876 B at 1e6 sparse, vs best-paged pb8 31,548 /
  9,270,198 B.
- Ruled oracle / baseline only (a test and benchmark foil).
- Sources: DECISIONS D-R5; PROPOSAL section 3.

### #5 -- Per-chunk headers WITH the has early reject *(RULED 2026-11-04)*
- V-d's `_cMin` / `_cMax` headers cut min / max to 5 reads in every row; its has early reject
  added +2 has reads (13 / 19 / 30 vs 11 / 17 / 28).
- Adopted without the early reject. P-5 also ruled a shrink task for the bodies V-d had made
  dead (the -1 exits; landed as #35).
- Sources: DECISIONS V-d, P-5; PROPOSAL section 3.

### #6 -- No hysteresis between kinds *(RULED 2026-11-04)*
- At the 64 / 65 edge a no-hysteresis build converted 10,000 times per 10,000 ops; with
  DEMOTE_SMALL 32 / DEMOTE_BITMAP 2048, once. bitmap-4097 delete 2,116 -> 4 reads. Cost:
  delete +6 B.
- Sources: DECISIONS V-e (ve-thrash.log, u1-ve.log); PROPOSAL section 3.
- Rule: every promote / demote pair keeps a gap; a thrash row is part of the count ledger.

### #7 -- Auto-optimize on chunk close; Fenwick rank *(RULED 2026-11-04)*
- P-3: auto-optimize lost as a hot-path tax on add; the clustered win ships as `addRange` plus
  a documented `runOptimize` cadence (1e6 clustered 32,862,360 -> 1,241,074 B).
- P-4: a Fenwick rank lost as a tax on every add; R2 gets a cold `buildRank()` (no measurement
  in R0: EXPECTED only).
- Sources: DECISIONS P-3, P-4; PROPOSAL section 3.

### #8 -- A result API or a U cap for keys >= 2^31 *(RULED 2026-11-04; API deferred to R2)*
- A returned key >= 2^31 is not a Smi on Node: RoaringSet hi.successor / hi.predecessor ~32,
  hi.min / hi.max ~16 B/op (r3-u4-best.log); vEBTree CV7 1,048,584 B / 65,536 calls = 16 B per
  call, cause traced on V8 14.6 (the bodies are not inlined).
- Ruled: document the box in R1 as vEBTree does; `successorInto(key, out)` / a signed API is R2;
  capping U at 2^31 lost.
- Sources: DECISIONS P-1; RESEARCH.md 14.7; `.handoff/evidence/veb-g4bi-inlining-trace-2026-11-03.log`.

### #9 -- vEBTree per-leaf summary word and a whole-tree leaf to w = 10 *(RULED 2026-11-02)*
- The maintainer first said yes to a per-leaf summary word, then reversed it on the space
  table: 1.094 - 1.105x StratifiedBitset at w >= 12, 1.235x at w = 9. A whole-tree leaf up to
  w <= 10 would close w = 9 / 10 at the price of a 32-word scan; refused.
- Shipped: leaf cutoff w <= 8, per-width split table, no leaf summary (L-06, ADR 0009). The
  14.8 sweep later showed the leaves are exactly where vEB reads more than SB; reopening it
  needs a vebCost re-model first.
- Sources: 7911358; 1bfc4e3; RESEARCH.md 14.5, 14.6, 14.8; ROADMAP.md L-06.

### #10 -- Lookup tables for vEBTree *(REFUSED 2026-11-03)*
- In-word scans are already `31 - Math.clz32(...)`; a byte LUT adds a loop and table reads
  that raise the pinned counts; the real leaf cost (finding the next non-empty word) is
  something only the refused leaf summary (#9) could skip.
- The one LUT that pays is in-word select, for a future rank / select. Argued from code and
  instruction counts, not timed.
- Sources: 03767e6; RESEARCH.md 14.7.

### #11 -- Inline `instanceof` guard in the set ops *(REFUSED 2026-11-05, A8)*
- `!(other instanceof RoaringSet)` inside the 4 set-op methods moved add 838 -> 840 and delete
  899 -> 903 B: naming the class inside its body gives the class a context, so module binding
  reads go one context deeper. Shipped: a module-private `isRoaringSet(o)` helper.
- The G4 bytecode pins (#35) now catch any later class-body reference.
- Sources: a8ec86d; SPEC A8 (C-2, C-6).

### #12 -- A joint precount engine change for the transient-slot throw *(RULED docs-only 2026-11-05, A15)*
- Pre-existing before and after F1 (#17): U = 3 chunks, maxSmall 1, maxLarge 1, chunk 0 a
  100-key array, chunk 2 smallRuns [10, 65535]: `addRange(65536 + 65000, 131082)` throws pool
  exhausted because the first partial chunk needs a large slot transiently in write order;
  two calls succeed.
- Ruled: clarify the docs (write-order precount) and pin the row (C-27), not amend C-8.
- Sources: SPEC A15; `.handoff/evidence/roaring-f1-review.md` r1 design note (1).

### #13 -- A steady-state runOptimize lane; a 4 ms pause gate in torture *(RULED 2026-11-05, A13 / A10)*
- A13: "runOptimize allocates nothing" closes on the 6 gated torture lanes that call it every
  cycle; the docs scope it to conversions; no `runOpt.steady` lane (R count stays 93).
- A10: the page-churn lane gates gc maxMajor 0 only; `maxPauseMs: 4` is a fixed timing
  threshold, which the tier rule keeps out of verify, so its maxMs is REPORTED.
- Sources: SPEC A10, A13; 11e7304; a91a6f8.

### #14 -- A per-round drift detector as the witness --veb verdict feed *(REPLACED 2026-11-03)*
- The per-round Page-Hinkley detector tripped on 6 / 6 FULL runs (#34). Its replacement feeds
  the verdict from per-ABBA-run medians (`hostDriftRuns`, DRIFT_RUN_THRESHOLD 0.75 NOMINAL);
  the per-round line stays REPORTED. Its must-fail mutants show why both knobs matter: threshold
  2.0 misses a sustained 1.10x step, k = 1 fires on the lane pattern.
- Sources: c227030; `.handoff/research/veb-drift-2026-11-03.md` sections 5 and TASK 4.

### #15 -- The YFastTrie chi-square row *(DROPPED 2026-10-25)*
- The bucket chi-square row was dropped: the structure draws no RNG, so it would be vacuous.
  The vectors pin size-band histograms and a seed-changes-levels check instead.
- Source: ROADMAP.md (YFastTrie ASSERTIONS, "The chi-square row is DROPPED, RULED 2026-10-25").
- Rule: a statistical row on a deterministic structure gates nothing; drop it.

### #16 -- The draft's `_q` field *(DROPPED 2026-11-04, planner)*
- The planners dropped `_q`: the byteLength constant is 8,460 and every shipped byteLength is
  24 B below the PROPOSAL's (2^32 default 3,036,204 -> 3,036,180 B; SPEC C-3). R0's counts already excluded `_q` reads; the d.ts
  "2,184 writes" figure later proved stale because R0 counted 65 `_q` writes.
- Sources: HISTORY.md 2026-11-04 planner burst; ROADMAP.md (RoaringSet planned); 4602bcc;
  `.handoff/evidence/roaring-g4-b1-review.md` r1 (FILLERS A2).

---

## B. Defects found and fixed

### #17 -- addRange left the first partial chunk in the wrong kind *(FIXED 2026-11-05, U0 / audit F1)*
- In a two-chunk range, addRange decided the FIRST partial chunk's kind before the LAST partial
  chunk returned a small slot: kind 4 (runs, 8 KB) where runOptimize picks kind 5; a later add
  could then throw "large container pool exhausted".
- Ruled "fix the engine" (C-8 text unchanged): a cold post-pass demotes the first chunk when
  the last one freed a small slot. Gates fail on the frozen f9e7f613 build; reviewer fuzz
  ~407k ranges: head 0 violations, base 33. LogLogN.js 73293e41.
- Sources: be8bdea; SPEC A12; `.handoff/evidence/roaring-f1.md`, `roaring-f1-review.md`.

### #18 -- `_rangeKind` off by one at the 2,049th run *(FIXED 2026-11-05, G3-B3a)*
- r1 REJECTED 2 LITERAL: `_rangeKind` was off by one at a 2,049th run with n0 = 4,095, and the
  self-check missed the exact cap edges. Fixed with a PLAN S-3 erratum; r2 APPROVED.
- Sources: c95451c; HISTORY.md 2026-11-05 G3 burst 2.
- Rule: a capacity cap is tested AT the cap and one past it, in the self-check too.

### #19 -- The runOptimize crossover tie survived the vectors *(FIXED 2026-11-04, G1-B3)*
- The B1 reviewer found that the `<` -> `<=` crossover mutant survived; it is killed only by a
  tie row (U 184,942,592), not the 254 / 255 rows the brief had named. G1-B3 gained a
  runOptimize ties row and 3 must-fail tie mutants.
- Sources: 4d9c29a; HISTORY.md 2026-11-04 planner burst and G1 coder burst.
- Rule: a comparison's mutant is killed by the equality row; name the tie explicitly.

### #20 -- R0 draft boxed on bitmap predecessor / max; 12.11 bounds wrong *(FOUND 2026-11-04, research)*
- The base draft boxed 16 B/call on bitmap predecessor / max: a raw Uint32Array load fed into
  `clz32`; `| 0` fixes it. Summary reads were doubled (bitmap successor / predecessor 7, min 5).
  The 12.11 run / predecessor bounds were wrong (runs-2048 has 25, not 13).
- All fixed in `RoaringDraft.best.mjs` before the planners.
- Sources: 65b7d53; `.handoff/research/roaring/R0-FINDINGS.md`; HISTORY.md 2026-11-04 R0 session 1.

### #21 -- A corrupt vEB layout hangs instead of misanswering *(GATED 2026-11-02)*
- 7 of the B2 reviewer's 20 vEB mutants HANG (unbounded leaf scans). Mutation gates over the
  engine run in a Worker with a kill timer (vEB PLAN C-19); the later in-process V3 torture lane hung
  the same way and moved into a Worker (FILLER 1).
- Same unit: the absent delete stops at a header that proves the key absent where the literal
  vEB PLAN C-12 descended (F-B5-1); the maintainer ruled "Stop at header" and the count gate models it.
- Sources: ef16b2b; 48323bd; c455782; RESEARCH.md 14.7.

### #22 -- The count-ledger Meter failed open five ways *(FIXED 2026-11-05, G4-B1)*
- r1: `Object.keys` missed non-enumerable fields; the Proxy lacked descriptor traps; a query's
  write was undone before the hash compare. r2: the own-key set was frozen at construction
  (parked `g4-b1`). r3: no field-identity check (a replaced typed array was hidden by the
  restore), non-index keys passed the Proxy, the shape check compared names only. r4 APPROVED:
  25/25, each fix piece ablated fails exactly one test.
- Sources: 3768dfa; `.handoff/evidence/roaring-g4-b1-review.md`; `.handoff/rejected/g4-b1.restored-*`.
- Rule: an instrumenting harness checks what the measured call can change -- keys, identity,
  descriptors, prototype -- both since construction and inside the call.

### #23 -- witness:roar: fail-open stats, unjudged x2, a parked chunk, an unknown kind *(FIXED 2026-11-05, G7-B1)*
- r1: `quant([1,2,3], 2)` returned undefined (now NaN); an unjudged x2 control could exit 0
  (A14: exit 2). r2: the sizing searched maxSmall against the minimal maxLarge, so a <= 64-key
  chunk parked in a large slot in 5 D groups, the timed container in two (parked `g7-b1`; A16:
  R0 maxSmall floor + a parked-chunk census). r3: the census counted any other `_kind` as no
  slot, and a non-integer `inconclusive` made NaN, so `NaN * 4 > cellsAll` was false -> exit 0.
- Sources: b271ee4; SPEC A14, A16; `.handoff/evidence/g7/g7-b1.md`.
- Rule: a verdict input is validated before the comparison; NaN through `>` is a pass.

### #24 -- RoarWitness gate had no teeth on shape, verdicts or units *(FIXED 2026-11-05 / 2026-11-06)*
- G7-B2 r1: `makeShape` never called (a qHas seed-salt mutant passed 16/16); iso / gc / ret
  verdicts forced ok passed (must-fails missing); the no-timing regex let `-0.12 ns` through.
  FILLER A24's r1 then REJECTED 3 LITERAL again: fail-open content, fail-open class, no must-fail.
- Sources: 96d7a46; 575aa88; `.handoff/evidence/g7/b2/README.md`; HISTORY.md 2026-11-06.

### #25 -- wbError read non-live rows and free pages as clean *(FIXED 2026-11-05, FILLERS t6)*
- r1: rows the top pyramid does not reach and a paged set's zero page were never checked. r2:
  the new `_runs` check had no control. The final gate kills an engine mutant (`_rangeFull`
  without `this._runs[m] = 0;`) that the frozen 88d5f5bd test passes 21/21.
- Sources: 52dae44 (landed with G4-B2); `.handoff/evidence/fillers-t6.md`.

### #26 -- A mutant that never ran counted as a kill *(FIXED 2026-11-04 / 2026-11-05)*
- G1-B5 r1: a non-parsing mutant counted as killed -> ABORT class (88e6cdc). vEB B4: a crashed
  mutant counted as a kill (48323bd). R0 harness r2: a crashed u1-teeth child passed. FILLERS
  t6 A12c: a hanging mutant's TIMEOUT counted as a kill on the frozen 34c8e28d test; a TIMEOUT
  now kills only with `mayTimeout: true` and its `want` reason seen.
- Sources: 88e6cdc; 48323bd; 52dae44; `.handoff/evidence/fillers-t6.md`; HISTORY.md 2026-11-04.
- Rule: a kill is the named FAIL reason, seen; abort, crash and timeout are their own classes.

### #27 -- Ops and keys drawn from one PRNG stream *(FIXED three times)*
- vEB B1 r1: shared PRNG, no coverage floor (e8999c9). vEB B5 r1: one PRNG for ops and keys
  (48323bd). U0 F1 r1: `fixpointStream` drew op and keys from one xorshift stream; fixed with
  `rkey = xs32(seed ^ 0x9E3779B9)` for all 11 key draws (be8bdea).
- Sources: e8999c9; 48323bd; be8bdea; `.handoff/evidence/roaring-f1-review.md`.
- Rule: independent op and key streams, every time; a reviewer checks it first.

### #28 -- Gates that passed without exercising their target *(FIXED 2026-11-04 / 2026-11-05)*
- G5-B1a: ops / gap lanes passed without running their method (0c51510). G5-B2: required
  controls matched across jobs, not per job (761005e). G5-B3a: the retention universe was
  posted from a constant; G5-B3b: counts printed, never asserted (11e7304). G3-B2a: coverage
  floors counted REQUESTED layouts, while C-5 never built a paged set at the planned args (C-25,
  ce1bf73). G5-B1b: the CR-box control read clean twice under load (be60851, #31).
- Sources: the commits above; HISTORY.md 2026-11-04 / 2026-11-05.

### #29 -- Doc claims no gate could see *(FIXED 2026-11-03 .. 2026-11-06)*
- G2-B1: the class JSDoc stated the direct byteLength for every set (DESIGN; C-23, 789f6d8).
  G4-B2: a JSDoc "never -1" was false after the shrink (52dae44). G6-B6a / B6b r1: 11 LITERAL,
  incl. present-tense unlanded gates and a "torture" source for an R0-only figure (f5b999f).
  vEB G4a: a shipped `.handoff/` path and an unmeasured SB WIN row (aea631e). G6-B6d / e r1:
  leaked `.handoff` paths and SPEC C-ids, a missing addRange write-order caveat (b90e054).
- Sources: the commits above; SPEC A4; HISTORY.md.
- Rule: DocSync checks numbers against the engine (C-26); every other claim names its gate.

### Pre-release audit 2026-11-06

Two blind auditors, one brief, on a `git archive` of b90e054 (LogLogN.js 0bc05f40): Opus 5.5
and Fable 5.1 (high). Neither found an engine wrong answer or a zero-GC breach (Opus: 2.94M
seeded ops on 980 sets; Fable: a seeded model, all 49 set-op kind pairs, 0 B/call controls).
Sources: audit/2026-11-06/TRIAGE.md; SPEC A19 (C-27 amended, C-28, C-29).

### #47 -- runOptimize() was not idempotent *(FIXED 2026-11-06, f97f1b0)*
- The bitmap branch re-encoded as runs whenever runs <= 2047, with no array compare
  (LogLogN.js:3153 at 0bc05f40); the next call turned the same chunk into an array (:3207).
  Repro: 2,400 keys in 2,000 runs: bitmap -> runs -> array. `_rangeKind` k = 3 mirrors it.
- No earlier gate compared two runOptimize() passes on a 2,049..4,096-key bitmap: runCase
  calls it 3x with no compare between passes, roaringFuzz's "idempotent" row is a FULL chunk,
  and the F1 fixpoint gate checks addRange's result (test/RoaringRange.test.js:247, :927;
  test/helpers/roaringFuzz.mjs:928 at b90e054).
- Fixed: the bitmap branch and `_rangeKind` k = 3 pick an array when card <= 4096 and card <
  2 x runs (SPEC C-28, ties in A20); an idempotence gate fails on 0bc05f40 (f97f1b0).
- Sources: audit/2026-11-06/opus-5.5_FINDINGS.md O-2; TRIAGE.md; SPEC C-28, A20; f97f1b0.
- Rule: a normalising operation is gated by f(f(x)) == f(x) on seeded states, not by one call.

### #48 -- A contract exception lived only in the ADR *(FIXED 2026-11-06, f97f1b0 / 787df11)*
- addRange can leave its first partial chunk as a large-slot array (n < 2r) where an add loop
  + runOptimize() gives small runs; runOptimize() keeps it, so the fixpoint gate holds. ADR
  0010 P-3 recorded the exception; the d.ts, JSDoc, README, llms.txt and CHANGELOG stated C-8
  without it.
- Sources: opus-5.5_FINDINGS.md O-3; SPEC C-27 (A19 amendment), A20 (JSDoc + RoaringRange row in
  f97f1b0); 787df11 (d.ts / README / llms / CHANGELOG / ADR).
- Rule: an exception is written wherever the rule is written, in the same unit.

### #49 -- A doc-gate exemption outlived its line *(FIXED 2026-11-06, 787df11)*
- DocSync still exempted README_B6D_LINE ("Later tiers (..., RoaringSet) are queued") after
  G6-B6d removed the line (b90e054); re-inserting the stale line left DocSync (R d) green.
- Sources: opus-5.5_FINDINGS.md O-4 (mutant run in a temp copy); 787df11.
- Rule: deleting a doc line deletes its exemption, and a must-fail proves the gate closed.

### #50 -- A DETERMINISTIC control flipped on host load *(FIXED 2026-11-06, 97e806c / 787df11)*
- torture's vEBTree CV7 box control read 72 B instead of 1,048,584 B in 1 of 2 runs on
  identical bytes (load1 ~40-50 vs 5-8), so `npm run torture` exited 1; README / llms said
  these count gates "do not depend on" host load. The lane tier is UNCHECKED (tf=UNCHECKED).
- Fixed for the true JIT-inlining controls only (vEBTree CV7, RoaringSet hi.*); CR-box, CV9 and CV2
  allocate at every tier, so their non-flip is a blind lane and stays FAIL (SPEC A21, 97e806c).
- Sources: fable-5.1_FINDINGS.md F-1 (two logged runs); NEXT.md FILLER 33; SPEC C-29, A21;
  97e806c (torture verdict); 787df11 (README / llms provenance).
- Rule: an UNCHECKED tier + a non-flipping JIT-dependent control = INCONCLUSIVE (exit 2), never
  FAIL or PASS; a control that allocates at every tier is not JIT-dependent.

### #51 -- Two blind auditors, disjoint findings *(process, 2026-11-05 / 2026-11-06)*
- 2026-11-06: Opus 5.5 found O-1..O-5, Fable 5.1 found F-1; zero overlap. 2026-11-05: the
  local Fable audit missed the cloud review's F1 (addRange kind), fixed in be8bdea.
- Sources: audit/2026-11-06/TRIAGE.md "Cross-auditor misses"; audit/2026-11-05/
  fable-5.1_TRIAGE.md; SPEC A12.
- Rule: a release audit runs >= 2 independent auditors on one frozen snapshot, then a triage
  that re-runs every reproduction.

---

## C. Measurement lessons

### #30 -- The quiet lock is a host fact: BUSY means PENDING *(standing)*
- vEB burst 4: the closing verify found the lock BUSY at two checks (lite-signal); not retried
  in a loop; one run after the commits. Roaring burst 4: every timed channel PENDING while
  lite-fastbit32 held the lock 02:39-~05:50Z. Burst 7: the closing verify BUSY -> PENDING.
- Sources: HISTORY.md 2026-11-03 vEB burst 4, 2026-11-05 burst 4, 2026-11-06 burst 7;
  `.handoff/evidence/veb-g4bi-verify-2026-11-03.log`.

### #31 -- PRELIMINARY is not QUIET: load flips gates that look deterministic *(standing)*
- CV7 bigSucc flaked on every heavy-load run (load1 48-118) and flipped at load1 <= 6
  (FILLER 33); it flaked once at load1 92 in the G2 burst and passed at 3.8.
- The G5-B1b CR-box control read its transient half clean twice under load (an all-surviving
  box); the fix is a throttled heap-slot box, ~458,7xx B per window.
- Sources: HISTORY.md 2026-11-04 G2 burst, 2026-11-05 G3 burst 1 and burst 3; be60851.
- Rule: a control's signal must survive the loaded host the suite actually runs on.

### #32 -- KILL_MS sized from a quiet guess timed out on a loaded host *(FIXED 2026-11-05, U-0)*
- KILL_MS 120,000 timed out the live direct-setops / paged-setops / mixed-pair torture jobs at
  load1 17.9 -> 25.1. New rule: max(120,000, 4.5 x the slowest COMPLETED job wall), rounded up
  to 10 s: 4.5 x 90.5 s -> 410,000. The driver's own "550000" counted a 120 s TIMEOUT wall as a
  job wall; not used. Must-fail: 18/18 jobs at 300 ms -> TIMEOUT, exit 1.
- Sources: be4b770; `.handoff/evidence/roaring-u0-killms.md`; `.handoff/evidence/burst-close/README.md`.
- Rule: a timeout never takes a timed-out wall as its input.

### #33 -- The x2 control shared its instance with a third runner *(FIXED 2026-11-06, FILLER A24 / SPEC A18)*
- G7-B3 attempts 1 and 2 exited 2 ONLY on the x2 cell (D w16 n4096 successor): SB-AA / SB
  drifted HIGH both times (x1.110, x1.188) while SB-x2 / SB sat in band (x1.760, x1.784). That
  cell alone ran a 4th runner on the SB instance.
- Fix: SB-x2 on its own StratifiedBitset (a shared instance is a FAIL); ONE --strict attempt 3:
  exit 0, x2 x1.695, 3 / 147 INCONCLUSIVE. Lost: shipping G6 with no timing, quoting attempt 2
  as INCONCLUSIVE, a blind third attempt.
- Sources: 575aa88; SPEC A18; `.handoff/evidence/g7/a2/g7-b3.md`, `.handoff/evidence/g7/a3/`.
- Rule: a systematic exit on the same cell twice is a harness question, not a re-run.

### #34 -- The witness --veb drift trip was lane-structural *(DIAGNOSED 2026-11-03)*
- Both QUIET FULL runs exited 2 at probe round 100 / 103 of 615; 4 instrumented runs fired too
  (6 / 6). The probe carries a scenario-family modulation (random-key runs above the median,
  leaf-far + SH1 band runs below, gap 3.9 - 8.2 %); a synthetic lane-shaped series fires at
  +-4 %. Ruled out: warm-up residue, shared JIT feedback, GC.
- Per-cell spread across the 4 QUIET logs reached 171.3 % (SH1 successor past max, w = 32);
  6 / 38 verdicts disagree, so docs quote min-max ranges, never one run.
- Sources: b483bd9; c227030; RESEARCH.md 14.9; `.handoff/research/veb-drift-2026-11-03.md`.

### #35 -- Bytecode budgets: EXPECTED inlining is not TRACED inlining *(standing)*
- vEB G4b-i: "never inlined" was EXPECTED, not traced. Traced on V8 14.6 / node v26.8.2
  (Maglev 100 B, TurboFan 460 B): every decision on successor / predecessor = "exceeds bytecode
  limit"; TurboFan declines delete; has / add inline. The sb inlining check on the default
  `--fn` list is NO-VERDICT; the padded control DIFFs.
- RoaringSet G4-B2 dropped the dead miss exits: succ 647 -> 610, pred 785 -> 727, NextGEQ
  411 -> 363, PrevLEQ 373 -> 332 B, 0 count rows moved. G4-B3 pins every hot body.
- Sources: edcf851; `.handoff/evidence/veb-g4bi-inlining-trace-2026-11-03.log`;
  `.handoff/evidence/veb-g3-inl-*.log`; 52dae44; ac50b34; DECISIONS P-5.

### #36 -- Counts are not time; a searched maximum is a lower bound *(standing)*
- 14.8: vEB reads fewer words only where a header answers (min / max 1 vs SB 2 - 7); SB reads
  fewer everywhere else (has 1 vs 3 - 5). The sweep says what to time, not what users feel.
- R0 U1 counts are "lower bounds by search"; the PROPOSAL r1 review required the count tier
  to say so ("LOWER bounds found by search").
- Sources: 366605b; RESEARCH.md 14.8; `.handoff/research/roaring/R0-FINDINGS.md` (U1);
  HISTORY.md 2026-11-04 PROPOSAL pass.

### #37 -- A probe baseline is bimodal across fresh Workers *(FIXED 2026-11-03, fillers-1-2)*
- vEB PLAN A9 read the nsExcess offset (~-1,088) as baseMin; the real baseMin was ~2,872 B, so the STOP
  line (2,048) and the ceiling margin were wrong (DESIGN REJECT, parked). The probe: 40 fresh
  Workers, cold 1,784 x24 / 2,760-2,872 x16, warm 1,784-1,816. vEB PLAN A12: warm once at the call site,
  NS_BASE_MAX by formula from a measured warm max (4,096); a cold 8,192 ceiling was rejected.
- Sources: c455782; HISTORY.md 2026-11-03 vEB bursts 5 and 6.
- Rule: measure the baseline distribution before setting a bound on it.

### #38 -- The R0 harnesses needed their own review before their numbers counted *(2026-11-04)*
- U2 round 2 fixed two fairness bugs (a knob-aware fit; a generous-pool runOptimize lane). The
  harness review r1 found a shared step call site behind the hi.has flake, a fail-open GC
  window and nsBase drift; r2 found the eval cache still shared the site. After r3: U4 verdicts
  55 / 55 identical across two sequential base runs.
- Sources: 65b7d53; HISTORY.md 2026-11-04 R0 sessions 1 and 2.

### #39 -- Iterate on targeted tests; prove at the boundary *(standing)*
- Re-running the full suite on every coder iteration wasted wall time; one full run at burst
  end caught everything in lite-loglogn ("good"). Each burst records a boundary `npm test`
  (e.g. 1098 = 1097 + 1 skip, 0 fail, HEAD + U0 + G5-B4) and a closing verify.
- Sources: ~/.claude/LESSONS.md 2026-10-12; HISTORY.md 2026-11-05 bursts 4-6;
  `.handoff/evidence/burst5/`, `burst6/`, `burst7/`.

---

## D. Process lessons

### #40 -- The DocSync REJECT chain: eight rounds on one test-only unit *(2026-11-04 .. 2026-11-05)*
- G6-B6c: r1 3 LITERAL; r2 a prefix exemption (3-line fix, over the 2-line allowance: parked);
  r4 unanchored `includes` let digit-extended formulas pass; maintainer: "the next round must
  close the class (anchored tokens everywhere, fixtures per hole class), not one survivor".
  r5 8 LITERAL + 1 DESIGN; r6 4 LITERAL (allow-list '1' masked engine bounds; NUM_RE skipped
  glued numbers); A10: one literal fix round + re-review; r7 3 LITERAL; r8 APPROVED.
- The same shape earlier: "3 of 3 r1 reviews REJECTED again despite the briefed rule".
- Sources: 755634f; SPEC A9 (C-26), A10; HISTORY.md 2026-11-04 / 2026-11-05;
  `.handoff/archive/HISTORY-2026-10-22-to-2026-11-01.md`.

### #41 -- Park after the second REJECT; restore by sha *(standing)*
- Parked units: `g2-b1`, `g5-b1a`, `g6-b6c` (four times), `g3-b2a`, `g4-b1`, `g7-b1`, each
  kept under `.handoff/rejected/<unit>.restored-*`. The next burst restored them "with matching
  shas" before the fix round. A fix over the 2-line third-round allowance parks the unit.
- Sources: `.handoff/rejected/`; HISTORY.md 2026-11-04 G2 burst 2; `.handoff/evidence/roaring-g4-b1-review.md` r2.

### #42 -- Rewords and autostash move ids and files mid-burst *(standing)*
- The maintainer reworded commits mid-burst (same trees): G2-B2 / B3 -> 62905d7 / ead5c90;
  G3-B4 / G5-B3 / G6-B6c -> f51bc5d / 11e7304 / 755634f; G3-B5 a57c46f -> c227030. A rebase
  autostash reset torture.mjs (to an old rejected 3411b668) and QaAudit (to HEAD); both were
  restored from the review overlays. Earlier: NEXT.md named f480ab4 / 5601706, the log had 09cf045 / ad6ecf7.
- Sources: HISTORY.md 2026-11-03 vEB bursts 4, 5, 8; 2026-11-05 G3 burst 1, burst 4;
  `.handoff/archive/HISTORY-2026-10-22-to-2026-11-01.md`.
- Rule: verify a build by sha8 and tree, never by an announced commit id.

### #43 -- Turn caps are a sizing signal *(standing)*
- The G2-B1 paging coder hit its 70-turn cap once; the vEB G2 planner and the G6-B6e docs
  helper were each resumed once at their caps; an earlier gates planner hit its 25-turn cap.
- Sources: HISTORY.md 2026-11-02 vEB burst 2, 2026-11-04 G2 burst, 2026-11-06 burst 7;
  `.handoff/archive/HISTORY-2026-10-22-B2b-to-XftB2.md`.
- Rule: resume, never restart; size the next plan smaller.

### #44 -- Unique scratch dirs; verify before the last docs review *(2026-10-23)*
- A shared scratchpad dir named `revert` was overwritten by a coder (LogLogN.js symlinked to
  the live file): a revert check silently tested 0.3.0. The same burst's verify found stale
  counts two reviews had missed.
- Source: `.handoff/archive/HISTORY-2026-10-22-to-2026-11-01.md` (lessons (1) and (2)).
- Rule: every agent gets a unique dir prefix; run verify BEFORE the last docs review.

### #45 -- A spec quoted a reviewer's sentence that the same delta made false *(2026-11-03)*
- vEB PLAN A14: the CV9 comment text came from REVIEW.txt, whose sentence was false once cv9Flip
  gained nsBaseOk; r1 REJECTED 1 LITERAL on the comments.
- Source: HISTORY.md 2026-11-03 vEB burst 6 ("Lesson: ... the spec should quote the claim,
  not the sentence").

### #46 -- Expected values from the list they check; controls masked by siblings *(2026-10-22 .. 2026-10-23)*
- 3 of 5 r1 rejects were GATE TEETH sub-classes: an oracle derived from the code under test
  (BAD_OPS, hard-coded COLS), an unpinned file list, a printed-not-asserted count. Later: a
  checker row with no fake that trips ONLY it, and a control that flips on ANY violation.
- Brief rules that followed: "an expected value must never be computed from the list / code it
  checks"; a per-control mutant table; "each control must fail on the ONE row / metric it
  names, alone".
- Sources: `.handoff/archive/HISTORY-2026-10-22-B2b-to-XftB2.md`;
  `.handoff/archive/HISTORY-2026-10-22-to-2026-11-01.md`.
