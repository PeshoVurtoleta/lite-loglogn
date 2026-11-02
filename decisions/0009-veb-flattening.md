# 0009 -- vEBTree: a flattened van Emde Boas tree in one Uint32Array

- Status: PROPOSED (2026-11-02)
- Severity: S1 (the fourth member and the hash-free worst-case reference; it fixes the layout every later vEBTree gate measures)
- Date: 2026-11-02
- Session: vEBTree (0.5.0), unit G1 (L-06 flattening), batch B1h
- Source: `.handoff/PLAN-vebtree.md`, section CURRENT (C-1 .. C-16) and addendum A1 (maintainer
  rulings 2026-11-02); background RESEARCH.md section 14 (14.1 .. 14.5)

## Context

The textbook van Emde Boas tree is recursive: a node owns a summary tree and an array of
cluster trees, each a `new` object, and every op walks them through calls. That allocates
per level and per op, which this package forbids on any hot path (zero allocation, bytes in
a hot body). A vEB tree that cannot be called without garbage is not a member of this suite.

The requirement, in three parts:

- worst-case O(log log U) on EVERY op, with no hashing, no reseed and no amortized
  split (the deterministic reference next to XFastTrie and YFastTrie);
- 0 B/op on the hot path;
- readable enough to teach: one flat store, one offset table, one rule per decision.

This ADR records the flattened layout (rules L1 .. L6). The recursion survives only in the
test-only reference (`test/helpers/vebRef.mjs`) and in cold sizing code.

## Expected loss row (published up front)

vEBTree is EXPECTED TO LOSE ON TIME to StratifiedBitset at every w <= 32. StratifiedBitset
answers `has` and same-word neighbours from one word; a vEB node must read its header
first, and (min not being stored in its cluster) starts every `has` / `add` / `delete` at
the root.

- It WINS on `min` / `max` (a header read against a walk to level 0) and on out-of-range
  `successor` / `predecessor` (answered from a header).
- It LOSES on `has` and on same-word neighbours.
- Per-op word counts are NOT written in this record. They are gated exactly by
  `test/VebCount.test.js` (ADR 0004 Amendment 1); prose never carries counts.

What the member is for: the worst-case reference. No hashing, no reseeds, no amortized
splits, so its single-op tail is flat. Its SPACE is O(U); YFastTrie (ADR 0008) is the
large-U member.

## Decision

One `Uint32Array` `_t` holds the whole tree. A node of width w is a region of `_t`; the
offset of every child is computed from a precomputed size table, never stored.

**L1 -- the split table and the trimmed root (C-1, C-2, C-13, C-5, C-7).**

- A node of width w <= 8 is a LEAF: a plain bitmap with no header and no summary
  (w <= 5: one word; w = 6 / 7 / 8: 2 / 4 / 8 words). The cutoff is uniformly 8; there is
  no whole-tree leaf up to w <= 10 (C-5) and no per-leaf summary word (C-7, A1).
- A node of width w >= 9 is INTERNAL: lo = (w > 24 ? 16 : 8), hi = w - lo. The clusters
  are whole 8- or 16-bit subtrees, the summary takes hi bits (a summary of width <= 8 is
  itself a leaf).
- Size in words: S(w) = 2 + S(hi) + 2^hi * S(lo), with S(w) = the bitmap words at w <= 8.
  The cluster stride S(lo) is in {8, 2058}. The 2 is the [min, max] header.
- Depth D(w) = ceil(log2(w / 8)) <= 2: 0 for w <= 8, 1 for 9 .. 16, 2 for 17 .. 32. This is
  the depth of balanced halving, so the O(log log U) bound is unchanged.
- The ROOT's cluster count is trimmed to ceil(U / 2^lo) (cold sizing only). Nothing
  changes at U = 2^w; U = 2^24 + 1 costs 2,115,708 B, not about 4.2 MB.

Space (exact, from C-16; ratio is words against StratifiedBitset at the same w):

    w        vEB words / ratio vs StratifiedBitset
    9        19 words, 1.118x
    10       35 words, 1.061x
    11       1.000x
    12       0.985x
    13..32   0.973x - 0.977x

    universe     byteLength (bytes)
    2^16                 8,232
    2^20               131,604
    2^24             2,105,392
    2^28            33,718,804
    2^32           539,500,592
    U = 257                 76
    U = 2^24 + 1     2,115,708   (trimmed root)
    U = 2                    4

w = 9 and w = 10 stay slightly above StratifiedBitset: 8 bytes each, inherent at cutoff 8
(RESEARCH 14.5). Space is O(U) at every width. A sparse large universe belongs to
YFastTrie (O(n) space), not to this member.

**L2 -- empty is min > max (C-10, C-3).**

- An internal node's header is [min, max], and min is NOT stored in its cluster.
- EMPTY is `min > max`, stored as [0xFFFFFFFF, 0]. No non-empty node has min > max.
- Header keys are node-relative; only the ROOT header holds full 32-bit keys. No key value
  is reserved as an "empty" sentinel, so key 4294967295 at U = 2^32 is an ordinary key.
- `add` is single-path: an empty cluster gets an O(1) singleton write, then only the summary
  is entered. `delete` is single-path via the singleton test (header min === max, or a
  one-bit leaf (target word first, then the others ascending)).

**L3 -- Uint32 read rules (C-6, C-11, C-8).**

- The word type is `Uint32Array` (one `_t`); the research sketch used Int32Array (ruling (b)).
- Header slots are read raw and compared as uint32 (never `| 0`: that breaks the ordering
  at w = 31 / 32). Bitmap words are read `| 0` for bit tests.
- A composed key `((j << lo) | xl) >>> 0` is normalised before any compare or store, and
  every returned key is `>>> 0`.
- U is an integer in [2, 2^32], the siblings' contract. Otherwise a RangeError
  `'[lite-loglogn] vEBTree universe must be an integer in [2, 2^32]; got ...'`.

**L4 -- exact read order (C-12).** The order is part of the layout: it is what fixes the
counts the count gate pins.

- `has` / `add` / `delete` read min then max at every internal node.
- `successor` reads min, and max only if x >= min; `predecessor` reads max, and min only
  if x <= max.
- `min` / `max` / `successor` / `predecessor` test `_size === 0` first (no reads).
- Leaf scans ascend for `min` / `successor` and descend for `max` / `predecessor`.
- `add`'s empty-cluster test and `delete`'s singleton test read the target word, then the
  others ascending. There is NO `has` pre-pass; writes happen only after presence is proven.
- `delete` keeps at most 2 frames [base, w, acc, mode] in `_p` (Int32Array(8)), refreshing
  max only where x was that node's max.

**L5 -- columns, API, hot / cold split (C-14).**

- Columns: `_t` (Uint32Array, the tree), `_g` Int32Array(33) with g[w] = 2 + S(hi), `_p`
  Int32Array(8) (the delete frames). `byteLength` = `_t.byteLength` only.
- Getters: `size`, `universe`, `bits`, `byteLength`. API: `add`, `delete`, `has`,
  `successor`, `predecessor`, `min`, `max`, `clear`, with the semantics of YFastTrie's
  `.d.ts` (no capacity, no seed).
- HOT = the 7 self-contained loop methods: no helper calls, no recursion, no closures, no
  per-level `new`. COLD = the constructor, `vebWords(w)`, `_init`, `clear`
  (`_t.fill(0)` then `_init`) and `throwKey`.
- Bad keys follow the siblings: `has` / `delete` -> false, `successor` / `predecessor` ->
  undefined, `add` throws, and no column is read or written.

**L6 -- parity of prior members (C-15).** StratifiedBitset, XFastTrie and YFastTrie stay
BYTE-IDENTICAL. The whole pre-vEB prefix is pinned (`test/vectors/parity-prefix.json` and
`test/ParityPrefix.test.js`, cut at 25a7ad1, with controls) BEFORE any engine edit;
`parity.json` is untouched. The frozen before build lives in `.handoff/veb-before/`. The
engine diff against it is the header hunk plus one appended section.

## Boxing note

The siblings' caveat applies unchanged. The hot paths are 0 B/op on keys < 2^30. A returned
key >= 2^31 can box when the call is not inlined, and the hot bodies (inline leaf scans)
are large enough that they are not inlined. Torture steps that use keys >= 2^31 therefore
run on the TRANSIENT lane only.

## Literature (conclusions only)

No hardware, dates or ops-per-second are cited.

- Dementiev, Kettner, Mehnert, Sanders, ALENEX 2004: a direct recursive vEB implementation
  trails good comparison trees; their non-recursive 3-level bit-top structure wins on
  locate. This is why vEBTree is published with its loss row, and why the layout is flat.
- Nash and Gregg, ACM JEA 15 (2010): a comparison study of integer data structures for 32-
  and 64-bit keys. Cited only as a comparison study.
- Dinklage, Fischer, Herlez, SEA 2021, arXiv 2104.06740: engineered predecessor structures,
  including universe reduction and y-fast. Context for YFastTrie being the large-U member.

## Proof obligations

- The flattened form is proven against a test-only RECURSIVE reference
  (`test/helpers/vebRef.mjs`, which also serializes the flat words through its own offset
  recursion) and against the research sketch (U <= 2^24, `test/helpers/vebSketch.mjs`).
- Pinned vectors: `test/vectors/veb-g1.json` (seeded streams and named boundary traces,
  replayed with checkpoints that include a layout hash).
- The U = 2^32 empty-encoding assertion runs in `npm test`, fail closed, one Worker at a
  time (C-9); two sentinel mutants (an empty marker of max === 0xFFFFFFFF, and one of
  min === 0xFFFFFFFF) must each fail it.
- Exact word counts: `test/VebCount.test.js` (ADR 0004 Amendment 1), expected values
  computed from the reference state, never from the engine.

## Alternatives rejected

- **A per-leaf summary word (Stree-style tops).** Rejected (A1): it adds 12.5% to leaf
  space and puts the tree at 1.094 - 1.105x StratifiedBitset at w >= 12 (1.235x at w = 9),
  losing the only space win while saving at most about two leaf scans per
  query, on a structure that already loses on time. At most a later A/B. History: the
  maintainer first answered yes, then reversed it the same day (2026-11-02).
- **A whole-tree leaf up to w <= 10.** Rejected (C-5): it would close the 8-byte gaps at
  w = 9 / 10 at the price of 32-word scans, and it breaks the one-rule cutoff.
- **One Int32Array (the sketch's word type).** Rejected (C-6, ruling (b)): Uint32Array;
  header slots compare as uint32.
- **The balanced split hi = ceil(w / 2).** Rejected: 2.12x StratifiedBitset at w = 18 / 19
  (RESEARCH 14.5). The per-width table keeps the same depth with whole 8- / 16-bit clusters.
- **Leaf cutoff 5 / 6.** Rejected: 5.4x StratifiedBitset at 2^24 with w <= 5 leaves
  (RESEARCH 14.1); the cutoff is 8.
- **Per-leaf helper calls.** Rejected: they spend the inlining budget and force boxing of
  returned keys; the 7 hot methods stay self-contained.

## Consequences and gates

- G2 (zero-GC torture family): lanes for mixed ops at 2^16, depth-2 cluster paths at 2^28,
  delete-heavy max refresh, and keys >= 2^31 on the TRANSIENT lane only; a per-level `new`
  mutant must fail the arrayBuffers gate; a space test from a test-owned formula
  (w = 1 .. 32 plus a trimmed U) with no growth; bytecode SIZE pins.
- G3 (witness / perf family, quiet lock): `witness.mjs --veb` (w sweep, flat MAX single-op
  bar, log2(w) against w fit REPORTED), a perf test, the loss-row timings against
  StratifiedBitset REPORTED, and the inlining budget the same on the siblings.
- G4 (docs): README member section (O(U) space up front, YFastTrie cross-link for large U,
  the loss row with REPORTED timings), llms.txt, `LogLogN.d.ts` plus the type test,
  CHANGELOG [Unreleased].
- Timing is REPORTED with provenance; exact counts and the space table are the hard gates.
