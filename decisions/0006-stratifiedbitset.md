# 0006 -- StratifiedBitset: peel (D10), counting method (D7), witness protocol (D8), A12 + waiver

- Status: ACCEPTED (maintainer, 2026-10-22; AMENDED 2026-10-22 -- see Amendment 1)
- Severity: S1 (the first member; its gates are the template for every later member)
- Date: 2026-10-22
- Session: StratifiedBitset (B1 .. B-docs)

## Context

ADR 0004 Amendment 1 ruled that deterministic COUNTS are the hard gate and that
timing is STATISTICAL / REPORTED, and left the concrete counting method, the
script names and the statistical protocol to this record. The StratifiedBitset
session also had to decide whether to add tiered fast paths (a Timsort-style
split by universe size, RESEARCH.md section 12.10) to the one class.

Facts that frame the choice (PLAN-stratifiedbitset.md ADDENDUM 19, counted in
words of `_bits`): no tier reads or writes fewer words than the general pyramid
body. Worst successor / predecessor is Lc=1 -> 1 word, Lc=2 -> 3 (FastBit1024
reads 2 words plus its `_active` field), U = 2^20 -> 7 (lite-o1 BitSet 7),
U = 2^25 -> 9 (BitSet up to 38). has is 1, add / delete 1 + c, min / max Lc: all
already minimal for a pyramid with a one-word top. The level count already IS the
tier choice.

## Decision

### D10 -- level-0 peel only, A/B-gated (maintainer, AskUserQuestion)

`successor` / `predecessor` first test the level-0 word that holds x+1 / x-1 and
return from it without touching level 1. No new field, no `_tier`, no private
helper, no subclass; the hidden class, the `_bits` / `_off` layout, the byteLength
pins, `dump` and `levels` are unchanged. It is kept only because the A12 A/B
(below) showed it faster on the dense walks and losing on no scenario.
Bytecode on Node 26.8.2 / V8 14.6.202.34: successor 264 -> 355 B, predecessor
232 -> 310 B (the peel alone; the B2a-E `| 0` reads then made the shipped predecessor 313 B and max 121 -> 127 B); every hot body <= 460 B (the `--max-inlined-bytecode-size`
default), gated by A10 (DETERMINISTIC for that V8).

### D7 -- the counting method (Amendment 1 made concrete)

A counting `Proxy` wraps the SHIPPED instance's own `_bits` typed array and
counts exact word reads R and writes Wr per operation. The test asserts the
shipped code's counts against the cost model as a function of Lc = levels(U),
never against a twin of the code. Model: has R=1; add / delete R=Wr <= Lc when
the key changes (1 + the levels whose word changed emptiness), else R=1 Wr=0;
successor / predecessor R <= 2Lc-1; min / max R=Lc (1 if empty). Lc = 4 at
U = 2^16 and 2^20, 5 at 2^24, 6 at 2^28, 7 at 2^32. A9 (tier parity) compares
results hash, (R, Wr) hash, sumR and sumWr at 11 universes against
`test/vectors/tier-b1a.json`, cut from the frozen pre-peel body: the peel may
only keep or lower the exact counts. DETERMINISTIC, in `npm test`.

### D8 -- the witness is a release-time STATISTICAL script

`npm run verify` = test + test:types + torture + test:perf; the witness is NOT in
it. Scripts: `npm run witness` (A8: n-sweep at w = 28, U-sweep w = 16, 20, 24,
28, control, A/A), `npm run witness:w32` (opt-in w = 32, about 554 MB),
`node test/witness.mjs --tier` (A12). Protocol for both lanes: K = 15
interleaved ABBA rounds; a "win" needs 13 of 15; one untimed re-warm block per
round; a must-fail control; an A/A twin that must NOT declare a winner; a
lite-adaptive DriftDetector over per-round probe timings (median-normalised,
clamped to [2/3, 1.5], threshold 2.0) -> drift = exit 2; load1 > 0.5 x cores ->
exit 2. Run under `quiet-lock.mjs`. Exit 0 pass / 1 fail / 2 inconclusive (a HOST
verdict, never a pass or fail). The n-sweep foil is a local `Uint32Array` binary
search (D4). Related rulings: D9 strict successor / predecessor; D1 -0 aliases
key 0; D5 iteration is a successor walk only; D6 fixed universe, fail closed.

## A8 result (STATISTICAL, 1 run)

2026-10-22T02:00:07Z, MacBook-Pro (Apple M4 Pro, 12 cores), Node v26.8.2 / V8
14.6.202.34, darwin/arm64, load1 3.66 -> 3.71 (shared host, under quiet-lock),
wall 30.78 s, peak RSS 2.06 GB. EXIT 0.
(.handoff/bstat-witness-full-2026-10-22.log)

- n-sweep at w = 28, member `successor` vs a local binary search, n = 1e3, 3e3,
  1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7: 15/0 wins at all 9 n. Member medians
  11.74-17.84 ns/op (no trend); binary search 32.22 (1e3) -> 197.78 (1e7). The
  member wins at every n tested, so the crossover is at or below n = 1e3, not a
  measured K.
- U-sweep vs NaiveFlatBitset at n = 4096 (ns/op): w = 16 4.87 vs 4.33 (4/11,
  none); w = 20 5.52 vs 12.31 (win); w = 24 7.61 vs 69.00 (win); w = 28 22.04 vs
  884.42 (win). The w = 24 -> 28 jump coincides with level 0 growing to 32 MB
  (cache; an interpretation, not measured).
- Control NaiveFlatBitset vs binary search at n = 1000, w = 28: 0/15 (must lose),
  ok. A/A member vs member at n = 4096, w = 20: 7/8 (no winner), ok. Drift quiet
  over 225 probe rounds.
- REPORTED fits: vs log2(w) slope 18.92 ns/doubling, R^2 0.6589; vs w slope
  1.3407 ns/bit, R^2 0.7293. The w axis fits better, as Amendment 1 predicted
  for an O(log_32 U) member (about w/5 levels). StratifiedBitset does not claim
  a log2(w) line. REPORTED foils at n = 1e7, w = 28 (ns/op): SortedArray 273.71,
  Treap 927.84, SkipList 1166.44, EliasFano 173.21, lite-o1 BitSet n/a (U > 2^25).

## A12 result (STATISTICAL, 1 run) and the waiver

`node test/witness.mjs --tier`, FULL, 2026-10-22T02:27:20Z, same host / Node, load1
4.79 (5-min 5.72), wall 0.39 s. EXIT 2 (inconclusive).
(.handoff/bstat-tier-full-2026-10-22.log) B = live peel; A = the pre-peel body
(rev 00ba7e1) plus the same three ` | 0` reads. ns/op medians:

| Scenario | B | A | Wins B/A/none | Verdict |
| --- | --- | --- | --- | --- |
| dense-succ (U 2^16, n 32768) | 3.63 | 4.10 | 15 / 0 | win, 11.5% faster |
| sparse-succ (U 2^20, n 4096) | 7.59 | 7.81 | 12 / 3 | none |
| dense-pred | 3.19 | 3.82 | 14 / 1 | win, 16.5% faster |
| sparse-pred | 6.70 | 6.68 | 8 / 7 | none |

No scenario lost. Control (A x2 vs A) 0/15 ok; drift quiet over 105 rounds. Exit 2
cause: the dense-succ A/A (B against its byte-identical twin) went 1/14 -- 3.64 vs
3.60, about a 1% difference on identical code, which K = 15 / need 13 resolves as
a "winner". The sparse A/A (5/10) was ok.

RULING (maintainer, AskUserQuestion, 2026-10-22): WAIVE A12's A/A rule for this
run and KEEP THE PEEL, on effect size (11.5% and 16.5% dense wins, about 10x the 1%
A/A difference) and because no scenario lost. Honest wording: the A12 gate itself
returned inconclusive; the peel ships by maintainer waiver.

Open question (not decided): an effect-size floor for the A/A rule (an A/A "winner"
below some minimum relative difference is noise) before the next member's A/B.

## Consequences

- The BOUND is proven by the DETERMINISTIC counts; the timing numbers are evidence
  on one host and are worded as measurements with provenance, never as laws.
- Every later member declares its axis and its exact cost model and ships a
  counting gate like D7; "log2(w) must win" is proven by counts on the strict
  O(log log U) members.
- A change to the successor / predecessor bodies re-cuts `tier-b1a.json` and
  re-runs A9 / A10; a future A/B repeats the A12 protocol.
- The waiver is a one-run exception. Until the effect-size floor is decided, an
  A/A "winner" on a gate returns exit 2 and needs a maintainer ruling.

## Alternatives rejected

- **(b) No change (ship the pre-peel body).** Rejected: A12 measured the peel 11.5%
  / 16.5% faster on the dense walks with no scenario lost.
- **(c) A `_tier` dispatch (unrolled bodies per level count).** Rejected: it saves
  0 words (counts above) and costs about 3-4x the bytes of an unrolled body; a
  top word cached in a field would leave the typed array (zero-box rule) and
  escape the D7 Proxy.
- **(d) Bulk and / or / xor / popcount / acquire.** Rejected for 0.2.0: that is new
  SURFACE, not a tier; it belongs to the planned hybrid tiered member.
- **A timing R^2 floor / slope band as the gate.** Rejected (Amendment 1): w and
  log2(w) correlate at 0.9948 over five points.

## Amendment 1 (maintainer, 2026-10-22) -- the effect floor (R4)

The open question in "A12 result and the waiver" above (an effect-size floor for the
A/A rule before the next member's A/B) is decided for the XFastTrie A/B lane.

- **Ruling R4: the floor is 2%.** An A/A twin is flagged as a "winner" only if it
  reaches `need` of K rounds AND `|median ratio - 1| >= 0.02`; an A/B "win" also
  needs a median effect of at least 2%. The constant is `AB_EFFECT_FLOOR = 0.02`.
- **Where it lives.** In `abVerdict` (`test/helpers/abVerdict.mjs`), the pure
  verdict used by `node test/witness.mjs --xft` (`npm run witness:xft`), gated on
  injected vectors by `test/AbVerdict.test.js` (DETERMINISTIC).
- **What did not change (A5).** `tierVerdict` and the A12 lane keep their shipped
  behavior, including the exit 2 on an A/A "winner" and the waiver recorded in
  "A12 result"; the floor is NOT retrofitted into the `--tier` verdict. The A8 and
  A12 result sections above stay as the historical record of those runs.
- **Re-tier of the A8 / A12 timing.** The A8 and A12 results above are now tiered REPORTED, not STATISTICAL (D-host: this package has no CI, so statistical claims are REPORTED only). The numbers and their provenance are unchanged; only the tier label and any "gated" wording moved.
- **Tier.** A verdict from this lane is a timing measurement on one host: it is
  REPORTED (this package has no CI), never part of `npm test` or `npm run verify`.
