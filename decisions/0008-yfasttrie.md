# 0008 -- YFastTrie: sorted-run buckets under an x-fast representative trie

- Status: ACCEPTED (2026-10-25; shipped in 0.4.0)
- Severity: S1 (the second trie member; it fixes the O(n)-space claim and the seed surface)
- Date: 2026-10-25
- Session: YFastTrie (0.4.0), unit U-a (G1-2)
- Source: `.handoff/PLAN-yfasttrie.md`, section CURRENT (C-1 .. C-20, maintainer rulings 2026-10-23 / 2026-10-25)

## Context

XFastTrie (ADR 0007) answers successor / predecessor in O(log log U) but pays O(n log U)
space: one hash-table entry per key per prefix length. The y-fast construction keeps an
x-fast trie over only O(n / w) representatives and stores the keys in small buckets, so
the SPACE is O(n) while the query stays O(log log U). That O(n) space is the co-headline
of this member, stated next to XFastTrie's O(n log U), not behind it.

**C-1 (D-b, maintainer): y-fast, not z-fast.** An inner XFastTrie over O(n/w)
representatives plus buckets. A z-fast trie (R2 in ADR 0007, deferred to this decision)
stays Tier 4: it is more complex for no gain this package can gate with exact counts.

## Decision

**C-2 (D-a): buckets are bounded sorted `Uint32Array` runs in ONE preallocated pool
`_bk`, searched by binary search. No RNG anywhere; the structure is DETERMINISTIC** (a
run is a contiguous slice of the pool, so a bucket costs no pointer and no allocation).

**C-3 -- the policy.**

- w = ceil(log2 U), K = 2w (bucket capacity), h = ceil(w/2) (minimum non-head size).
- Representatives (reps) are SEPARATORS: bucket i holds the keys in [rep_i, rep_{i+1}).
  A rep need not be a live key; it is a split point.
- The head rep 0 is permanent (the constructor and `clear()` add it). The head bucket
  holds 0..K keys and never merges. Every other bucket holds [h, K] keys.
- **Split.** An add of a NEW key into a bucket with s = K keys: the new rep is the key at
  index w of the existing K-key run (the run is sorted, so the lower w keys stay and the
  upper half moves to the new bucket; x is then routed by comparing it with the new rep).
  The inner `add(rep)` happens BEFORE any copy, so a stall there leaves the set unchanged.
- **Underflow** (a non-head bucket with s <= h keys before a delete): let s_L be the size
  of the LEFT neighbour. If s_L + s - 1 <= K, MERGE into the left neighbour and
  `inner.delete(rep)`. Otherwise BORROW: t = s_L + s - 1, the new rep is L's key at index
  ceil(t/2); `inner.add(new)` first, then the moves, then `inner.delete(old)`.
- **Capacity of the inner trie.** Cr = min(2 + floor(C/h), U) representatives at most.
- **Columns.** `_bk` Uint32[(Cr+1) K]; `_bn` Uint8[Cr+1] (bucket sizes); `_n` Int32[4]
  holding the REPORTED counters splits / merges / borrows (cold path only; they wrap at
  2^31; `clear()` keeps them). The inner trie is `XFastTrie(U, Cr, seed)`.
- Cold methods are `_split` and `_shrink` (merge or borrow); the hot bodies hold only
  locate, binary search and the contiguous shift. The section marker in `LogLogN.js` is
  `// --- YFastTrie (0.4.0) ---`, after XFastTrie.

**Seed (C-4, C-5, C-6).** Both constructors take an optional caller seed
(`new XFastTrie(U, C, seed?)`, `new YFastTrie(U, C, seed?)`); see ADR 0007 Amendment 1
for the XFastTrie hunks. YFastTrie validates with its OWN class name, then forwards the
seed to the inner trie:

- undefined -> today's deterministic defaults; otherwise a uint32 integer, else
  `RangeError '[lite-loglogn] YFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ...'`.
- **C-5 (O5):** seed 0 is the same as omitted, bit for bit (documented here, in ADR 0007
  Amendment 1 and in the .d.ts).
- **C-6 (O1):** `clear()` restores the CONSTRUCTED state, including a caller seed.
- Never random-by-default (ADR 0007: it would make the count and replay gates
  non-reproducible). The seed only moves the inner trie's level seeds; the buckets use no
  hash.

## Cost model (pinned by exact counts in test/YftCount.test.js)

`test/YftCount.test.js` pins this table with a counting Proxy on `_bk`, `_bn` and the 8
inner columns, evaluated on an independent policy model (YModel), never on the engine.
lambda = 1 when x is itself a rep, else 1 + T (T = log2 w for
w = 2^j, as in ADR 0004 Amendment 1). beta is the binary-search read count for a run of s
keys: floor(log2(s+1)) <= beta <= ceil(log2(s+1)), exact at s = 2^j - 1. A "hop" is one
thread read plus at most one `_bk` read. lb = the lower-bound index found by the search.
Rows are WHOLE ops: the split row REPLACES the plain add row, and the merge / borrow rows
REPLACE the plain delete row (addendum A3 of the plan corrected the first draft of this
table). s = x's bucket size before the op, lb = x's index in it:

    op                                            inner touches     search reads      moves
    bad key                                       0                 0                 0
    has / add present / add full /
      delete absent                               lambda            beta+[lb<s]       0
    successor / predecessor                       lambda            beta+<=2 (+hop)   0
    min / max                                     0                 <=1 (+hop)        0
    add new, no split                             lambda            beta+[lb<s]       s-lb, +1 key write
    delete present, no merge / borrow             lambda            beta+1            s-lb-1
    add new, split (s = K)                        lambda+1+T+(w-m)  beta+[lb<s]+1     w + (w-lb'), +1 key write
    delete present, merge (s <= h)                lambda+(w-m)      beta+1            s-1
    delete present, borrow (s <= h)               lambda+1+T+(w-m)  beta+2            (s_L-c) + (s-1)
                                                    +(w-m')                           = floor(t/2) <= 2w

m = the ADR 0007 early-stop prefix length of the row's inner add (split) or inner delete
(merge); in the borrow row m is the inner add's and m' the inner delete's. Reading notes:

- **Split moves.** The split copy moves the upper w keys to the new bucket (+w); then x is
  inserted into the half it lands in (a w-key run), costing w - lb' for x's index lb' in
  that half, plus the key write. In terms of lb (x's index in the K-key run): 2w - lb for a
  left-routed x, 3w - lb for a right-routed one (right iff lb > w); at most 2w. The worst
  case is 2w moves (x lands at the front of the left half, lb = 0; a right-routed x moves at most 2w - 1).
- **Merge and borrow REPLACE the plain delete shift.** A merge moves the s-1 surviving keys
  into the left neighbour (the deleted key is skipped during the copy); a borrow moves
  s_L - c keys from the left neighbour's tail and the s-1 survivors, c = ceil(t/2),
  t = s_L + s - 1, so a borrow moves t - c = floor(t/2) <= 2w words. Neither also pays
  s - lb - 1.
- **Search reads.** A split and a borrow each read one more `_bk` word, the new rep
  (a split: beta+[lb<s]+1; a borrow: beta+2, the other read being the equality read). A merge reads no extra word.
- Reading the first draft additively (a split adds +w to the pre-split s-lb; a merge adds
  s-1 to s-lb-1) overstates the moves; `test/YftCount.test.js` asserts the measured moves
  are at most that literal reading and equal to the table above.

Pinned reading (EXACT COUNTS, DETERMINISTIC; a fit reading, not a timing claim): an absent
successor at s = 2w-1 costs touches + probes = 4, 6, 8, 10, 12 for w = 2, 4, 8, 16, 32
(R^2 against log2(w) = 1.0000, against w = 0.8710). The work bounds are also pinned: a
plain update moves at most 2w-1 words (the worst case is hit), a split / merge / borrow at
most 2w (the split worst case is hit), an inner reseed makes at most 32 tries.

## Failure modes (C-7, O3)

- A split or borrow whose inner `add` stalls (hash flood, ADR 0007 caveat) throws a
  `RangeError` with the set UNCHANGED, mirroring `XFastTrie.add`.
- If the inner trie is POISONED (its `_q` is null), YFastTrie is poisoned with it; every
  hot method throws as in XFastTrie, and `clear()` revives both.
- A full set: `add` of a new key at size === capacity throws `RangeError`
  'YFastTrie is full'; the set is unchanged.
- Bad keys mirror XFastTrie exactly: `has` / `delete` -> false, `successor` /
  `predecessor` -> undefined, `add` throws; no column is read or written.

## Claim wording (C-8, C-10, C-9, C-11, C-12)

- **C-8 (O4):** queries are O(log log U). Updates are O(log log U) probes plus at most
  2w-1 contiguous word moves (O(w)); split / merge / borrow are AMORTIZED. The README and
  llms.txt say exactly this; "O(log log U) update" with no qualifier is not claimed.
- **C-10:** the MAX single-op time of the witness tail is PRINTED with attribution
  (reseed > split > merge > plain) and is REPORTED only; no timing verdict is printed.
  The "stated bound" is the deterministic WORK bound gated by counts: a split / merge /
  borrow moves at most 2w words, an inner reseed makes at most 32 tries.
- **C-9 (O2):** the ROADMAP chi-square row is dropped as vacuous (no RNG to test). It is
  replaced by pinned size-band histograms in the vectors plus a check that a seed
  actually changes the level seeds.
- **C-11:** exact COUNTS are the hard gate (ADR 0004 Amendment 1); timing is REPORTED with
  quiet-lock provenance (this package has no CI).
- **C-12:** SPACE O(n) is the co-headline. `byteLength = 4 (Cr+1) K + (Cr+1) + 16 +
  XFastTrie(U, Cr).byteLength`, pinned from a test-owned model, never read back from the
  instance.

## Prior members and zero-box (C-13, C-14)

- StratifiedBitset stays BYTE-identical (Parity pin). XFastTrie stays BEHAVIOR-identical
  with the seed omitted / undefined / 0 (xft-seed.json replay; every existing XFastTrie
  gate unchanged); its region differs from the frozen build fd8fcec (LogLogN.js sha256 375caeab) only in the C-4 hunks.
  `XFastTrie.length` goes 2 -> 3 (no test pins it).
- The hot paths are 0 B/op on keys < 2^30. The 0.3.0 inline caveat applies: a rep >= 2^31
  can box when `inner.add` is not inlined, so the torture straddle step (keys >= 2^31 in
  buckets) runs on the TRANSIENT lane only.

## Alternatives rejected

- **Tree buckets (balanced tree per bucket).** Rejected: pointer / allocation cost and
  worse locality than a sorted run in a flat pool (C-2; planner reasoning).
- **A rep that moves with the bucket minimum.** Rejected: every delete of a bucket's
  minimum would touch the inner trie; separator reps change only on split / merge /
  borrow (planner reasoning).
- **Two-sided lookup (read both neighbouring buckets).** Rejected: it doubles the inner
  touches of every query; the single locate (rep <= x) plus one hop is enough.
- **Merge without borrow.** Rejected: when the merged size exceeds K the bucket would
  split again at once, so a delete / add pair at the h boundary oscillates, and
  always-merge-without-borrow can cost one split plus one merge (O(w) word moves each) on every op at
  the h boundary, so restructures get no O(1) amortized bound; borrow re-balances instead.
- **A z-fast trie.** Rejected for 0.4.0 (C-1): stays Tier 4, complexity.

## Consequences and gates (the files that gate this record)

- test/YftVectors.test.js + test/helpers/yftStream.mjs: C-3 policy replay (YModel),
  size-band histograms (C-9), the 15 xft-b0 streams (C-13).
- test/YftCount.test.js: the cost model above (C-8, C-11, seven must-fail mutants plus a hang control); test/XftSeed.test.js: C-4, C-5,
  C-6 and the xft-seed.json parity (C-13).
- test/YFastTrieOracle.test.js, test/YFastTrieBoundary.test.js: C-3 invariants, C-7 failure
  modes, bad keys, key 4294967295, 'YFastTrie is full'.
- test/QaAudit.test.js: export surface and the seed table for both classes (C-4).
- test/YFastTrieSpace.test.js, test/space-table.mjs: C-12. test/torture.mjs (Y0 .. Y4),
  test/perf/YFastTriePerf.test.mjs: C-14. test/YftBytecode.test.js: hot bodies <= 460 B (C-17).
- test/witness.mjs `--yft`, test/YftWitness.test.js: C-10, C-15 (must-fail fakes), C-16
  (tail seed 0x7A170000 + w).
- Docs batch (README, llms.txt, CHANGELOG, GUIDE): C-8 wording and the SPACE row.
- test/YftWitness.test.js gates the `--yft --smoke` child with counts and strings only
  (five must-fail fakes, `test/fakes/yftw-*`); the timed `--yft` lane is REPORTED.
- Shipped in 0.4.0. Timing, the SPACE table and the witness tail are REPORTED
  measurements (README), not claims of this record.
