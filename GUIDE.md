# lite-loglogn -- which structure to pick (GUIDE)

A repo-only decision guide for the sub-logarithmic family: which member, which
bitset, reach-for / avoid, and how to measure the bound and the space price
yourself. StratifiedBitset (0.2.0),
XFastTrie (0.3.0) and YFastTrie (0.4.0) are shipped; vEBTree is PLANNED. It is NOT an API
encyclopedia (that is the README + `LogLogN.d.ts`); it answers "which member,
is my bound real, and what does it cost in space?"

Every number below names its tier: DETERMINISTIC (gated in `npm test` /
`npm run verify`) or REPORTED (a measurement with provenance, gates nothing).
This package has no CI, so every timing claim (`npm run witness`,
`witness:tier`, `witness:xft`, `witness:yft`) is REPORTED, not a gated STATISTICAL claim.

---

## The one question every member answers

> Is the predecessor / successor op sub-logarithmic in the UNIVERSE size on a
> REAL engine -- and what does it cost in space?

The family name ties to the series: lite-o1 is the constant, lite-logn the
logarithm in n, lite-loglogn the double logarithm in U. The FAMILY bound is
O(log log U), in U; StratifiedBitset itself is O(log_32 U) (about w/5 levels).

The bound is proven by COUNTS (DETERMINISTIC): a counting test over the shipped
code asserts the exact words touched per op as a function of `levels` (ADR 0004
Amendment 1, ADR 0006). Timing is evidence on one host, not the proof: no R^2
floor and no slope band is gated. Each member declares which axis it fits;
StratifiedBitset fits the `w` axis (REPORTED, A8 2026-10-22, Apple M4 Pro 12 cores, Node 26.8.2, load1 3.66: R^2 0.7293 vs 0.6589
for log2(w), 1 run), and does not claim a log2(w) line. "log2(w) must win" belongs
to the strict O(log log U) members (XFastTrie and YFastTrie shipped, vEBTree planned), proven
there by counts.

---

## Which member? (decision flowchart)

`(wc)` = worst-case, `(am)` = amortized (YFastTrie restructuring). All assume keys are integers
in [0, U), U <= 2^32.

```
START -- what do you need on a BOUNDED integer universe?
|
+-- Predecessor / successor, teachable + array-embedded,
|   and the universe U/w fits in memory?              -> StratifiedBitset (wc, O(U/w) space)  [0.2.0]
|
+-- Fastest possible query, space is not the constraint,
|   universe can be up to 2^32, and updates are rare
|   or the set is sparse in a huge universe?          -> XFastTrie (wc query, O(w) update, O(n*w) space)  [0.3.0]
|
+-- O(log log U) query but you cannot pay O(n*w) space
|   (many elements)?                                  -> YFastTrie (wc query, am update, O(n) space)      [0.4.0]
|
+-- Worst-case O(log log U) with a compact universe
    and you want the classic structure?              -> vEBTree (wc, O(U) space)              [planned 0.5.0]
```

## Picker table

| Need | Member | Time (query) | Space | Version |
| --- | --- | --- | --- | --- |
| Teachable predecessor / successor, array-embedded | StratifiedBitset | O(log_32 U); min / max read Lc words (Lc = levels <= 7) | O(U/w) | 0.2.0 |
| Fastest query, sparse set in a huge universe, space and update cost accepted | XFastTrie | O(log log U) query; O(w) update | O(n*w), preallocated at a FIXED capacity | 0.3.0 |
| O(log log U) query at O(n) space | YFastTrie | O(log log U) query; update O(log log U) probes + at most 2w-1 word moves, split / merge / borrow amortized | O(n), preallocated at a FIXED capacity | 0.4.0 |
| Classic worst-case, compact universe | vEBTree | O(log log U) worst-case | O(U) | planned 0.5.0 |

---

## StratifiedBitset

### Reach for it

- You need STRICT successor AND predecessor, plus min / max, on integer keys with
  U up to 2^32 (DETERMINISTIC: successor / predecessor read <= 2Lc-1 words, min /
  max read Lc, Lc = levels = 4 at U = 2^16 and 2^20, 5 at 2^24, 6 at 2^28, 7 at 2^32).
- You want `undefined` for "absent" (never -1, never null) and a bad key that
  touches nothing.
- You want 0 B/op hot paths (DETERMINISTIC: torture T0, 2,000,000 ops at U = 2^20 ->
  0 B/op, gc major 0 / minor 0).
- Your universe is large and the set is dense or clustered enough that O(U/w)
  bits is acceptable.

### Avoid it

- The set is sparse in a huge universe: space is O(U/w) regardless of n (U = 2^32 is
  about 554 MB; w = 28 level 0 alone is 32 MB). Use XFastTrie (O(n*w), fixed
  capacity; see below), YFastTrie, or a sorted array.
- U <= 2^25 and you only need successor: lite-o1 `BitSet` has a fixed 3 levels
  (O(1) in U) and bulk and / or / xor + popcount; see the table below.
- Non-integer or unbounded keys: see the family boundary.
- You need bulk set algebra or an iterator: iteration here is a successor walk
  only, and there is no and / or / xor.

### Measure it yourself

- Bound (DETERMINISTIC): `npm test` runs the exact word counts (`test/Count.test.js`).
- Zero-GC (DETERMINISTIC): `npm run torture`, `npm run test:perf`.
- Speed (REPORTED, release-time, on a quiet host):
  `node ~/.claude/hooks/quiet-lock.mjs run "loglogn witness" -- npm run witness`
  (exit 0 pass / 1 fail / 2 inconclusive host); `npm run witness:w32` adds the
  opt-in w = 32 (about 554 MB); `npm run witness:tier` is the peel A/B.
- A8 headline (REPORTED, 2026-10-22, Apple M4 Pro 12 cores, Node 26.8.2, load1
  3.66 -> 3.71, 1 run): at w = 28 the member beat a local binary search at all 9
  n from 1e3 to 1e7 (15/0 each; member 11.74-17.84 ns/op, binary search
  32.22 -> 197.78), so the crossover is at or below n = 1e3, the smallest n tested.

---

## XFastTrie

### Reach for it

- Query speed in a HUGE universe: an absent `successor` / `predecessor` costs
  1 + log2(w) level-table touches (DETERMINISTIC, `test/XftCount.test.js`: 2, 3,
  4, 5, 6 touches at w = 2, 4, 8, 16, 32), 6 at w = 32, and a present key costs 1.
- The set is SPARSE in a big universe (U = 2^32, n up to about 10^6): there it
  is smaller than StratifiedBitset (REPORTED, `node test/space-table.mjs`,
  2026-10-22: n = C = 1,000,000 at U = 2^32 -> 393,682,220 B vs 554,189,332 B).
- You can name a capacity up front and can live with it (fixed, never grows).

### Avoid it

- Frequent updates: `add` of a new key is 1 + T + (w - m) touches and `delete`
  is w - m (DETERMINISTIC; 38 touches for an add into an empty trie at w = 32).
  Updates are O(w), not O(log log U).
- A dense or small universe: space is O(n*w), preallocated at the CAPACITY you
  pass, not the keys present (`byteLength = 13 TS + 12 (C+1) + 16 (w+1) + 16`;
  worst case 4,563,403,308 B at U = 2^32, C = 2^24). At U = 2^20, n = C =
  1,000,000 it is 66,526,316 B against StratifiedBitset's 135,300 B (REPORTED
  bytes, 491.7x). Use StratifiedBitset there.
- Untrusted keys: the cuckoo seeds are fixed, so adversarial keys can force
  kicks and reseeds (correctness holds, time suffers; ADR 0007).
- A growing set: add of a new key at `size === capacity` throws a RangeError.

### Measure it yourself

- Bound (DETERMINISTIC): `npm test` (`XftCount`, `XFastTrieSpace`).
- Zero-GC (DETERMINISTIC): `npm run torture` lanes X0-X4, `npm run test:perf`.
- Speed (REPORTED, release-time, quiet host): `npm run witness:xft` (2% minimum
  effect floor on every XFastTrie-vs-StratifiedBitset win; the binary-search comparison is a REPORTED point verdict without it; exit 0 / 1 / 2). No XFastTrie timing is quoted in
  the docs until the release run.

---

## YFastTrie

### Reach for it

- You want the XFastTrie query (`successor` / `predecessor` O(log log U)) but cannot pay O(n*w) space: YFastTrie is O(n), preallocated at the CAPACITY you pass (`byteLength = 4 (Cr+1) K + (Cr+1) + 16 +` the inner XFastTrie's, Cr = min(2 + floor(C/h), U), K = 2w, h = ceil(w/2); DETERMINISTIC, pinned in `test/YFastTrieSpace.test.js`). REPORTED bytes (`node test/space-table.mjs`, 2026-10-25): n = C = 1,000,000 at U = 2^32 -> 47,484,715 B against XFastTrie's 393,682,220 B (0.121) and StratifiedBitset's 554,189,332 B.
- Updates probe fewer levels than XFastTrie's: O(log log U) probes plus at most 2w - 1 contiguous word moves, and a bucket split / merge / borrow is AMORTIZED (at most 2w word moves plus an inner XFastTrie update). The costs are counted exactly (DETERMINISTIC, `test/YftCount.test.js`: an absent successor from a bucket of 2w - 1 keys costs touches + bucket reads = 4, 6, 8, 10, 12 at w = 2, 4, 8, 16, 32).
- You want the optional ctor seed (`new YFastTrie(U, C, seed?)`, deterministic, never random by default) or fully deterministic buckets (no RNG).

### Avoid it

- A dense universe: StratifiedBitset is far smaller (YFastTrie is 6.496 to 262.501 times its bytes at U = 2^16, REPORTED) and its query is a handful of words.
- Anything where a plain binary search over a sorted array suffices: in the 2026-10-25 `witness:yft` run (REPORTED, one run) YFastTrie `successor` was slower than a local `Uint32Array` binary search at every n tested (ratio 3.0364 at n = 3,000,000, 2.8628 at n = 10,000,000, w = 28).
- A hard worst-case update bound: the single-op tail is REPORTED, not bounded in time (the stated bound is the count-gated work bound: a split / merge / borrow moves <= 2w words). vEBTree (planned) is the worst-case member.
- Untrusted keys: the inner trie's cuckoo seeds are fixed by default, so adversarial keys can force kicks and reseeds; a stalled inner add during a split or borrow throws a `RangeError` with the set unchanged (so `delete` can throw too; ADR 0007, ADR 0008).
- A growing set: add of a new key at `size === capacity` throws a RangeError.

### Measure it yourself

- Bound (DETERMINISTIC): `npm test` (`YftCount`, `YFastTrieSpace`, `YftVectors`, `YFastTrieOracle`).
- Zero-GC (DETERMINISTIC): `npm run torture` lanes Y0a / Y0b / Y1 (+ Y1c) / Y2 / Y3 / Y4, `npm run test:perf`.
- Speed (REPORTED, release-time, quiet host): `npm run witness:yft` (YFastTrie vs XFastTrie successor A/B with the 2% effect floor; foils, add+delete and the tail MAX are REPORTED with no timing verdict; `--yft --smoke` is the counts-only gate in `npm test`). The 2026-10-25 run (QUIET, 1 run): successor ratio vs XFastTrie 0.5178 at n = 1,000,000 and 0.9154 at n = 1,000 (w = 28); 1.0444, a LOSS, at w = 16, n = 4096.

---

## Which bitset? (the suite's tiers)

Timsort runs insertion sort on short runs and merges above them, because each wins
in its own range. The suite's bitsets split the same way: pick by universe and by
which operations you need. Word counts are REPORTED from sibling source read
2026-10-22 (words of the bit arrays read per op, worst case); the StratifiedBitset
row is DETERMINISTIC (counts gated by Count.test.js and TierParity.test.js); the
XFastTrie row counts level-table touches, not words, and is DETERMINISTIC
(XftCount.test.js); the YFastTrie row counts touches, bucket reads and word moves
(YftCount.test.js, DETERMINISTIC).

| Universe | Structure | next / prev / min-max | Extras | Absent |
| --- | --- | --- | --- | --- |
| U <= 32 | FastBit32 | next 1 / prev 1 / min-max 1 | flag ops | -1 |
| U <= 1,024 | FastBit1024 | next 2 + field / prev none / 1 + field | `acquire` (lowest free slot) | -1 |
| U <= 2^25, next only | lite-o1 BitSet | next 7 (U <= 2^20) / 38 (U = 2^25), no prev, first only | and / or / xor + popcount, size O(words) | -1 |
| U <= 2^32 | StratifiedBitset | next <= 2Lc-1 / prev <= 2Lc-1 / min-max Lc | size O(1) | `undefined` |
| U <= 2^32, sparse | XFastTrie | next / prev 1 + log2(w) touches (absent) / min-max 0; update w - m | fixed capacity, size O(1) | `undefined` |
| U <= 2^32, sparse, many keys | YFastTrie | next / prev lambda touches + a bucket search (touch counts as XFastTrie); update lambda + at most 2w-1 word moves | fixed capacity, size O(1), O(n) space | `undefined` |

At U <= 1,024 StratifiedBitset touches the same number of words as the sibling
(Lc <= 2); pick the sibling for its surface. The boundary row: U <= 2^25 and
successor-only -> lite-o1 `BitSet` (fixed 3 levels, O(1) in U); StratifiedBitset
owns predecessor / max and U up to 2^32, labelled O(log_32 U), and returns
`undefined` where `BitSet` returns -1.

Speed (REPORTED, A8 2026-10-22, Apple M4 Pro 12 cores, Node 26.8.2, load1 3.66, 1 run, n = 4096,
w = 16..24): lite-o1 `BitSet` 4.28-4.82 ns/op vs the member 4.87-7.61 ns/op, so
`BitSet` was faster where it applies. At n = 1e7, w = 28 (REPORTED): lite-logn
`SortedArray` 273.71, `Treap` 927.84, `SkipList` 1166.44, lite-o1 `EliasFano`
173.21 ns/op (`BitSet` n/a, U > 2^25).

### Composition recipe (user-side)

Nothing is imported by the package; this is a recipe you own. It picks the smallest
tier that covers the universe and puts one strict-successor surface over them,
mapping the siblings' -1 to `undefined` at the seam. Sibling surfaces (read from
source 2026-10-22): `FastBit1024` has `add` / `has` / `nextSetBit(from)`, and
`has` THROWS on a bad index; `nextSetBit` accepts from in 0..capacity and returns
-1 for none. lite-o1 `BitSet` has `set` / `test` / `nextSet(from)`; `test` and
`nextSet` never throw on a bad index (`nextSet` returns -1). The recipe ran under
Node 26.8.2.

```js
import { StratifiedBitset } from '@zakkster/lite-loglogn';
import { FastBit1024 } from '@zakkster/lite-fastbit32';
import { BitSet } from '@zakkster/lite-o1';

// Pick the smallest tier that covers the universe; one strict-successor surface.
class TieredSet {
  constructor(universe) {
    this.u = universe;
    if (universe <= 1024) { this.kind = 0; this.s = new FastBit1024(universe); }
    else if (universe <= 2 ** 25) { this.kind = 1; this.s = new BitSet(universe); }
    else { this.kind = 2; this.s = new StratifiedBitset(universe); }
  }
  add(x) {                         // every tier throws on a bad key
    if (this.kind === 1) this.s.set(x); else this.s.add(x);
    return this;
  }
  has(x) {                         // FastBit1024.has THROWS on a bad key: guard it
    if (!Number.isInteger(x) || x < 0 || x >= this.u) return false;
    return this.kind === 1 ? this.s.test(x) : this.s.has(x);
  }
  successor(x) {                   // strictly greater than x, or undefined
    if (!Number.isInteger(x) || x < 0 || x >= this.u) return undefined;
    if (this.kind === 2) return this.s.successor(x);
    let r = -1;
    if (this.kind === 0) r = this.s.nextSetBit(x + 1);        // from <= capacity is legal
    else if (x + 1 < this.u) r = this.s.nextSet(x + 1);       // BitSet: -1 when none
    return r === -1 ? undefined : r;                          // the seam: -1 -> undefined
  }
}

const t = new TieredSet(2 ** 28);   // StratifiedBitset tier
t.add(7).add(300).add(2 ** 28 - 1);
console.log(t.successor(7), t.successor(2 ** 28 - 1));   // 300 undefined
```

---

## Family boundary (where NOT to reach for lite-loglogn)

- **Bounded-integer priorities (min / max + insert)** -> `@zakkster/lite-o1`
  `BucketQueue` (Dial, O(1)) or `@zakkster/lite-scheduler` `FastBitScheduler`.
  lite-loglogn owns ORDERED predecessor / successor, not a priority queue.
- **Non-integer or unbounded keys (strings, floats, comparators)** ->
  `@zakkster/lite-logn` (SkipList / balanced structures, O(log n)). lite-loglogn
  needs a bounded integer universe (w <= 32).
- **Approximate membership** -> `@zakkster/lite-filter` (Bloom / cuckoo /
  binary-fuse). lite-loglogn owns exact ordered integer structures; it has no
  use of lite-filter.
- **Caching / eviction** -> `@zakkster/lite-lru`. It uses ordering internally but
  is a cache, not an ordered-collection library.

---

MIT (c) Zahary Shinikchiev
