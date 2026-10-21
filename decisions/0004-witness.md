# 0004 -- Witness fit plan + which sweep is the HARD gate (L-04)

- Status: AMENDED 2026-10-22 (maintainer) -- see "Amendment 1" at the end;
  the timing-fit plan below is superseded where Amendment 1 says so
- Severity: S1 (the family anchor; every member inherits the gate it calibrates)
- Date: 2026-09-18
- Session: S0 (scaffold)

## Context

The witness is the family's proof-of-bound, and its axis is the #1 place this
package can quietly become its sibling by copy-paste. lite-logn fits vs log2(n);
lite-loglogn MUST fit vs log2(w), the universe BIT-WIDTH -- the honest bound is
in U, not n. Conflating log log U with log log n is the dishonesty this family
refuses (RESEARCH.md section 5, honesty hook (a)).

Two sweeps exist (ROADMAP section 5.2):

- **U-sweep double-log FIT, BOTH axes.** Hold n fixed, sweep U = 2^16 .. 2^32;
  fit `nsPerOp = intercept + slope*log2(w)` AND fit vs `w` (the O(log U) impostor
  axis). The log2(w) fit must WIN (higher R^2) -- this catches a mislabeled bound
  (e.g. an x-fast UPDATE path that is really O(log U)).
- **n-sweep CROSSOVER vs the O(log n) foil.** Hold U at 32 bits, sweep
  n = 1e3 .. 1e7; the member stays flat while a lite-logn O(log n) member (the
  foil) climbs and is overtaken. Report the crossover n as a fact.

The short U-axis (~5-9 points, w = 16..32) is noisier than lite-logn's n-sweep --
the real flakiness risk.

## Decision

**Settle the PLAN in S0; calibrate the NUMBERS in StratifiedBitset.**

The plan:

1. **Fit BOTH axes; the log2(w) fit MUST WIN over the O(log U)/w impostor axis.**
   The winning-axis R^2 must clear the floor and its slope must sit in the
   member's band. A candidate whose impostor `w` axis fits better FAILS -- it is
   secretly O(log U), not O(log log U).
2. **The n-sweep crossover vs the O(log n) foil is the candidate HARD gate; the
   U-sweep double-log fit is REPORTED.** Lean per ROADMAP L-04: the crossover is
   the more robust gate on the noisier short axis, and it is the answer users
   actually want ("wins for n above ~K on a 32-bit universe"). Final HARD-vs-
   reported split is confirmed in StratifiedBitset once real numbers exist.
3. **Steady-window / median discipline inherited** from the siblings (lite-o1
   ADR-0004 amendment): geometric sweep, steady window, median-of-N, and DO NOT
   widen the floor to pass. A budget that moves is not a gate.
4. **MAX single-op printed** for amortized / expected members (y-fast) -- a
   rehash / bucket-split spike shows as a tall bar.
5. **Control (law 9):** a deliberately O(log n) member (or the foil itself)
   submitted as the candidate must FAIL the log2(w)-fit-wins assertion.

StratifiedBitset -- the cleanest witness (worst-case O(log_w U), array-embedded,
no rehash noise) -- FILLS the R^2 floor and slope band, and that becomes the
shared FAMILY gate every later member inherits, recorded in its own ADR.

**Recommended resolution -- PENDING USER RATIFICATION at review.** The plan
(log2(w) primary axis, log2(w)-fit-wins, crossover-as-hard-gate lean, U-sweep
fit reported) is on the record; the numeric floor / band and the final HARD-vs-
reported call are ratified in the StratifiedBitset session.

## Consequences

- `test/witness.mjs` ships at v0.1.0 with the log2(w) axis wired (WITNESS_W), the
  n-sweep + O(log n) foil wired (WITNESS_NS, sortedArrayPredecessor), and NO
  thresholds -- it runs green and empty (members=0).
- StratifiedBitset must not copy lite-logn's n-axis floor; it calibrates fresh on
  log2(w).

## Members it shapes

StratifiedBitset (calibrates the family gate). Every later member (XFastTrie /
YFastTrie / vEBTree) inherits the floor + band + the log2(w)-fit-wins assertion.

## Alternatives rejected

- **Copy lite-logn's log2(n) axis + floor.** Rejected: it would prove the wrong
  theorem and hide a mislabeled O(log U) bound. The axis is log2(w).
- **Make the U-sweep fit the sole HARD gate.** Rejected as the DEFAULT: the short
  U-axis is noisy; the crossover is the more robust gate. The U-fit is reported
  and its fit-wins assertion is still enforced.

## Amendment 1 (maintainer, 2026-10-22) -- counts are the hard gate

Two facts found while planning the StratifiedBitset session break the timing
plan above:

1. **The two axes cannot be told apart by timing.** Over w = 16, 20, 24, 28, 32
   the correlation between `w` and `log2(w)` is 0.9948 (computed 2026-10-22). A
   timing R^2 comparison "log2(w) fit beats w fit" over five noisy points is a
   coin flip, so it cannot be a gate.
2. **StratifiedBitset is linear in w, not in log2(w).** Its pyramid has
   ceil(log32(U)) levels: 4, 4, 5, 6, 7 for w = 16, 20, 24, 28, 32 (about w/5).
   It honestly fits the `w` axis and would FAIL "log2(w) must win". That matches
   its O(log_w U) label (RESEARCH.md section 2: "the member declares which axis
   it fits").

Ruling (supersedes Decision items 1-3 above where they conflict):

- **HARD gate = deterministic COUNTS, in `npm test`.** Each member declares its
  axis and its exact per-op cost model (for StratifiedBitset: words touched per
  op as a function of levels(U)); a counting test over the SHIPPED code asserts
  the count, never a twin of it. Counts are the DETERMINISTIC tier: a flake is a
  test bug, never "re-run it".
- **Timing is REPORTED / STATISTICAL.** The U-sweep fit (both axes) and the
  n-sweep crossover vs the O(log n) foil run once per release, under
  `quiet-lock.mjs`, interleaved, K rounds, with a must-fail control, and a HOST
  verdict that exits 2 when inconclusive. They leave `npm run verify`'s fixed
  thresholds. The crossover n is published as a measurement with provenance.
- **"log2(w) must win" moves to the strict O(log log U) members** (XFastTrie
  successor, YFastTrie, vEBTree) and is proven there by COUNTS (probes per op vs
  log2(w)), not by timing R^2.
- **U-sweep range:** w = 16, 20, 24, 28 by default; w = 32 (about 554 MB for a
  StratifiedBitset) only behind an opt-in env flag in the release-time run.
  Constructing a 2^32 universe stays legal and documented.

The StratifiedBitset session records the concrete counting method, the script
names, and the statistical-run protocol in its own ADR (0006).
