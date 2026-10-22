# @zakkster/lite-loglogn

> Zero-GC, sub-logarithmic bounded-integer predecessor / successor structures that PROVE their bound. StratifiedBitset ships in 0.2.0: an array-embedded 32-ary bit pyramid with O(log_32 U) successor / predecessor, O(U/w) space, 0 B/op on every hot method, and the bound gated by exact word-read COUNTS. XFastTrie, YFastTrie and vEBTree are planned.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-loglogn.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-loglogn)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-loglogn?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-loglogn)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-loglogn?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-loglogn)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-loglogn?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-loglogn)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The bounded-integer successor structure the ecosystem was missing

Almost no JavaScript data-structure library ships the evidence that its Big-O claim survives contact with a real engine. `lite-loglogn` is a curated family of sub-logarithmic bounded-integer predecessor / successor structures, each zero-GC. The first member, `StratifiedBitset`, is an integer set over a fixed universe `[0, U)` (U up to 2^32) whose `successor` / `predecessor` read at most `2 * levels - 1` words, with `levels = max(1, ceil(log2(U) / 5))` (at most 7).

```bash
npm install @zakkster/lite-loglogn
```

```js
import { StratifiedBitset } from '@zakkster/lite-loglogn';

const set = new StratifiedBitset(1 << 20);   // universe [0, 2^20)
set.add(5).add(70).add(70).add(1000000);     // add is idempotent and chainable
console.log(set.size, set.levels);           // -> 3 4
console.log(set.has(70), set.has(71));       // -> true false
console.log(set.successor(5), set.successor(70), set.successor(1000000));
                                             // -> 70 1000000 undefined
console.log(set.predecessor(70), set.predecessor(5));  // -> 5 undefined
console.log(set.min(), set.max());           // -> 5 1000000
console.log(set.delete(70), set.delete(70)); // -> true false

const keys = [];
for (let k = set.min(); k !== undefined; k = set.successor(k)) keys.push(k);
console.log(keys.join(','));                 // -> 5,1000000

try { set.add(1 << 20); } catch (e) {        // a bad key never touches a word
  console.log(e instanceof RangeError, e.message);
}                                            // -> true [lite-loglogn] key must be an integer in [0, 1048576); got 1048576
console.log(set.has(-1), set.successor(NaN)); // -> false undefined
```

The family name ties it to the sibling series: [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) is the constant, [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) is the logarithm in `n`, and lite-loglogn is the double logarithm in `U`: the FAMILY bound is O(log log U). StratifiedBitset itself is O(log_32 U), not O(log log U); the strict O(log log U) members (XFastTrie, YFastTrie, vEBTree) are planned.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [Deep dive: the bit pyramid](#deep-dive-the-bit-pyramid)
- [API reference](#api-reference)
  - [Getters](#getters)
  - [Constants](#constants)
- [The roster](#the-roster)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Measured (statistical and reported)](#measured-statistical-and-reported)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

A working programmer with millions of bounded integers -- timestamps, IDs, ports, quantized coordinates -- who needs "the next key above X" reaches for a sorted array (O(log n) binary search, O(n) insert) or a balanced BST (O(log n) everything, and a `new Node` per insert). Both pay the logarithm of the ELEMENT COUNT. When keys live in a bounded universe the problem has a sharper bound in the universe size `U`, not in `n`.

The honesty rules of this family:

- **The bound is in U, not n.** It is never "log log U beats log n" without "on a w-bit universe". Conflating log log U with log log n is the dishonesty this family refuses.
- **The BOUND is proven by COUNTS.** StratifiedBitset's cost is the exact number of `_bits` word reads / writes per op, gated deterministically in `npm test`. Timing is evidence on one host, labelled by tier below.
- **SPACE is a co-headline.** O(U/w), stated with the same prominence as time; U = 2^32 is about 554 MB.

## What you get

- **Zero runtime dependencies.** ESM only, ASCII-only source, one PascalCase main file (`LogLogN.js`), `sideEffects: false`. The shipped surface is exactly `StratifiedBitset` and `VERSION`.
- **0 B/op on every hot method** (DETERMINISTIC, gated by `npm run torture` and `npm run test:perf`).
- **An exact, gated cost model** (read counts per op, below) instead of a fitted line.
- **Strict ordered queries.** `successor(x)` is the smallest key > x, `predecessor(x)` the largest key < x; absent is `undefined`, never `-1` and never `null`.
- **Fail closed.** A bad key (not a number, non-integer, NaN, negative, >= U, null, string, Symbol, BigInt, boxed Number) touches no word: `has` / `delete` return `false`, `successor` / `predecessor` return `undefined`, `add` throws a `RangeError`. `-0` aliases key 0.
- **Tree-shakeable named exports.**

## Deep dive: the bit pyramid

<details>
<summary>Levels, the level-0 peel, and the cost model</summary>

One flat `Uint32Array` holds the whole structure. Level 0 is the key bitmap (bit `x` set means key `x` is present). Level `L+1` has one bit per word of level `L`, set while that word is non-zero, so each level is 32x smaller than the one below. The number of levels is `Lc = max(1, ceil(log2(U) / 5))`: 4 at U = 2^16 and 2^20, 5 at 2^24, 6 at 2^28, 7 at 2^32.

`successor` climbs from level 0 until some word has a set bit above the position, then descends along the lowest set bit with `Math.clz32` word operations. `min` / `max` descend from the top.

**The level-0 peel.** `successor` / `predecessor` first test the level-0 word that holds `x+1` / `x-1` and return from it without touching level 1. No new field, same memory layout, same or lower exact counts than the previous body (gated against `test/vectors/tier-b1a.json`, DETERMINISTIC). On Node 26.8.2 / V8 14.6.202.34 the peel grows the bytecode: successor 264 -> 355 B, predecessor 232 -> 310 B (the peel's own delta; the later B2a-E `| 0` reads make the shipped predecessor 313 B and max 121 -> 127 B), and every hot body stays within 460 B (`--max-inlined-bytecode-size`), gated by `test/TierParity.test.js` (DETERMINISTIC for that V8).

**Cost model (DETERMINISTIC).** Exact `_bits` word reads (R) and writes (Wr), counted by a counting Proxy over the shipped instance's `_bits` in `test/Count.test.js`:

| Op | Reads / writes |
| --- | --- |
| `has(x)` | R = 1 |
| `add(x)` / `delete(x)`, key changes | R = Wr <= Lc (1 + the levels whose word changed emptiness) |
| `add(x)` / `delete(x)`, no change | R = 1, Wr = 0 |
| `successor(x)` / `predecessor(x)` | R <= 2 * Lc - 1 |
| `min()` / `max()` | R = Lc (R = 1 when empty) |

Space is `byteLength = 4 x (total words of all levels)`. Pinned in `test/Space.test.js`:

| U | levels | byteLength |
| --- | --- | --- |
| 1 | 1 | 4 |
| 32 | 1 | 4 |
| 33 | 2 | 12 |
| 1,025 | 3 | 144 |
| 32,768 | 3 | 4,228 |
| 65,536 | 4 | 8,460 |
| 1,048,576 | 4 | 135,300 |
| 16,777,216 | 5 | 2,164,804 |
| 268,435,456 | 6 | 34,636,836 (formula only, never constructed in tests) |
| 4,294,967,296 | 7 | 554,189,332 (formula only; about 554 MB) |

</details>

## API reference

### The class

| Signature | Returns | Notes |
| --- | --- | --- |
| `new StratifiedBitset(universe)` | instance | `universe` an integer in [1, 2^32], else `RangeError` (`[lite-loglogn] universe must be an integer in [1, 2^32]; got ...`). Fixed universe, no resize. Allocates. |
| `has(x)` | `boolean` | Bad key -> `false`. |
| `add(x)` | `this` | Idempotent. Bad key -> `RangeError` (`[lite-loglogn] key must be an integer in [0, U); got ...`), no state touched. |
| `delete(x)` | `boolean` | `true` if `x` was present. Bad key -> `false`. |
| `successor(x)` | `number \| undefined` | Smallest key > x (strict). Bad key -> `undefined`. |
| `predecessor(x)` | `number \| undefined` | Largest key < x (strict). Bad key -> `undefined`. |
| `min()` | `number \| undefined` | `undefined` when empty. |
| `max()` | `number \| undefined` | `undefined` when empty. |
| `clear()` | `void` | Cold. Empties the set; `_bits` is reused. |
| `dump()` | `{ universe, size, words: Uint32Array[] }` | Cold, ALLOCATES. `words[L]` is a copy of level L (level 0 = key bits). |

There is no `forEach` and no iterator: iteration is the `successor` walk (see the quick-start).

### Getters

All cold.

| Getter | Meaning |
| --- | --- |
| `size` | Number of keys present. |
| `universe` | The constructor's `universe`. |
| `levels` | `max(1, ceil(log2(U) / 5))`. |
| `byteLength` | 4 x total words of the one `_bits` Uint32Array (the `_off` table and the object itself are not counted). |

### Constants

| Export | Type | Value | Meaning |
| --- | --- | --- | --- |
| `VERSION` | `string` | the package version string | One of the three version sites (package.json / `LogLogN.js` `VERSION` const / `llms.txt`), kept in lockstep, gated by `test/QaAudit.test.js` in `npm test`. |

## The roster

One member per release, each landing append-only (prior members stay byte-identical). Only StratifiedBitset exists; every row after it is PLANNED.

| Member | Slot | Time (query) | Space | Shape |
| --- | --- | --- | --- | --- |
| **StratifiedBitset** | 0.2.0 | O(log_32 U) successor / predecessor; min / max read Lc words (Lc = levels <= 7) | O(U/w) | array-embedded hierarchical bit tree |
| **XFastTrie** | 0.3.0 (planned) | O(log log U) | O(n*w) | binary search over w pointer-free LevelTables |
| **YFastTrie** | 0.4.0 (planned) | expected O(log log U) | O(n) | x-fast trie over ~n/w representatives + buckets |
| **vEBTree** | 0.5.0 (planned) | O(log log U) worst-case | O(U) | flattened van Emde Boas |

Later tiers (SegmentedU for wider keys, EliasFano, RoaringSet) are queued in [`ROADMAP.md`](./ROADMAP.md).

## Composability

A user-side pipeline, no sibling import required: a day of one-second slots, free for the first half of every hour; find the next free slot, book one, and walk what is left.

```js
import { StratifiedBitset } from '@zakkster/lite-loglogn';

const DAY = 86400;
const free = new StratifiedBitset(DAY);                    // levels = 4
for (let s = 0; s < DAY; s++) if (s % 3600 < 1800) free.add(s);

const nextFree = (t) => (free.has(t) ? t : free.successor(t)); // number | undefined
console.log(nextFree(1000), nextFree(1800), nextFree(86399));  // -> 1000 3600 undefined

free.delete(1799);                                         // book slot 1799
console.log(nextFree(1799), free.size);                    // -> 3600 43199

let count = 0;
for (let s = free.min(); s !== undefined; s = free.successor(s)) count++;
console.log(count, free.max(), free.predecessor(3600));    // -> 43199 84599 1798
```

Keys are integers in [0, U): map timestamps to slots (`Math.floor((ms - origin) / step)`) before the call, and treat `undefined` as "no such key".

## Zero-GC design notes

<details>
<summary>Allocation table, gated numbers, boxing note</summary>

| Op | Allocation |
| --- | --- |
| `has`, `add`, `delete`, `successor`, `predecessor`, `min`, `max` | 0 B (hot) |
| `clear` | 0 B (cold; no new buffer) |
| `new StratifiedBitset(U)` | allocates the one `_bits` Uint32Array (`byteLength` above) |
| `dump()` | allocates (a copy of every level) |

**Boxing note.** A returned key >= 2^31 (>= 2^30 on a pointer-compressed engine) may box as a HeapNumber when the call is not inlined. The B2a-E fix adds three `| 0` reads (predecessor descend, max top, max descend) so a word with bit 31 set stays a Smi-range int32 instead of a HeapNumber.

DETERMINISTIC numbers (2026-10-22, Node v26.8.2, every run of the named script):

- `npm run torture` (`node --expose-gc test/torture.mjs`): T0 runs 2,000,000 ops at U = 2^20 -> retained 0 B/op, transient 0.000 B/op, gc major 0 / minor 0; T1-T2 ok; T3's four must-fail controls (one per T0-T2 check) each flip.
- `npm run test:perf` (`@zakkster/lite-perf-gate`): 7 zero-alloc scenarios (has, add+delete, successor, predecessor, min, max, successor-walk at U = 2^20) + 3 must-fail teeth + flag pin (2) + arrayBuffers attribution (1) = 14/14.

</details>

## Measured (statistical and reported)

The BOUND above is proven by the DETERMINISTIC counts. The numbers below are timing evidence on ONE host, not a law, and not in `npm run verify` (D8).

Provenance for every row: 2026-10-22, MacBook-Pro (Apple M4 Pro, 12 cores), Node v26.8.2 / V8 14.6.202.34, darwin/arm64, shared host under quiet-lock, 1 run each.

### STATISTICAL: `npm run witness` (A8), released once

Protocol (both lanes): K = 15 interleaved ABBA rounds; a "win" needs 13 of 15; one untimed re-warm block per round; a must-fail control; an A/A twin that must not declare a winner; a lite-adaptive DriftDetector over per-round probe timings (drift -> exit 2); load1 > 0.5 x cores -> exit 2. Exit 0 pass / 1 fail / 2 inconclusive (a HOST verdict).

FULL run 2026-10-22T02:00:07Z, load1 3.66 -> 3.71, wall 30.78 s, peak RSS 2.06 GB: EXIT 0 (pass).

n-sweep at w = 28 (U = 2^28), member `successor` vs a local `Uint32Array` binary search (the O(log n) foil): 15/0 wins at all nine n (1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7). Member medians 11.74-17.84 ns/op (no trend); binary search 32.22 ns/op (n = 1e3) -> 197.78 ns/op (n = 1e7). The member won at every tested n, so the crossover is at or below n = 1e3 (the smallest n tested); it is not a measured K.

U-sweep vs `NaiveFlatBitset` at n = 4096 (monotone verdict rule):

| w | member ns/op | NaiveFlatBitset ns/op | Verdict |
| --- | --- | --- | --- |
| 16 | 4.87 | 4.33 | none (member won 4/11) |
| 20 | 5.52 | 12.31 | win |
| 24 | 7.61 | 69.00 | win |
| 28 | 22.04 | 884.42 | win |

The w = 24 -> 28 jump coincides with level 0 growing to 32 MB (cache; an interpretation, not measured).

Controls: NaiveFlatBitset vs binary search at n = 1000, w = 28: 0/15 (must lose) ok. A/A member vs member at n = 4096, w = 20: 7/8, no winner, ok. Drift quiet over 225 probe rounds.

### STATISTICAL: `node test/witness.mjs --tier` (A12), the level-0 peel

FULL run 2026-10-22T02:27:20Z, load1 4.79 (5-min 5.72), wall 0.39 s: EXIT 2 (PENDING, inconclusive). B = the live peel; A = the previous body (rev 00ba7e1) plus the same three `| 0` reads. ns/op medians:

| Scenario | B (peel) | A | Wins B/A | Verdict |
| --- | --- | --- | --- | --- |
| dense-succ (U 2^16, n 32768) | 3.63 | 4.10 | 15/0 | win (B 11.5% faster) |
| sparse-succ (U 2^20, n 4096) | 7.59 | 7.81 | 12/3 | none |
| dense-pred | 3.19 | 3.82 | 14/1 | win (B 16.5% faster) |
| sparse-pred | 6.70 | 6.68 | 8/7 | none |

No scenario lost. Control A x2 vs A: 0/15 ok. Drift quiet over 105 rounds. The exit 2 came from the dense-succ A/A (B vs its byte-identical twin): 1/14 at 3.64 vs 3.60, about a 1% difference on identical code, which K = 15 / need 13 resolves as a "winner". Sparse A/A 5/10 ok.

**Waiver, stated honestly:** the A12 gate itself returned inconclusive; the peel ships by maintainer waiver (2026-10-22), on effect size (11.5% / 16.5% dense wins, about 10x the 1% A/A difference) and because no scenario lost. Open follow-up: an effect-size floor for the A/A rule before the next member's A/B (maintainer call, not decided).

### REPORTED: fits, foils and latency (from the A8 log, gates nothing)

- **Fits.** Measured against the U-sweep: vs log2(w) slope 18.92 ns/doubling, R^2 0.6589; vs w slope 1.3407 ns/bit, R^2 0.7293. The w axis fits better, as expected for an O(log_32 U) member whose level count `ceil(w/5)` is linear in w (ADR 0004 Amendment 1). StratifiedBitset does NOT claim a log2(w) line; "log2(w) must win" belongs to the strict O(log log U) members, proven there by COUNTS. No R^2 floor or slope band is gated.
- **Foils at n = 1e7, w = 28 (ns/op):** lite-logn SortedArray 273.71, Treap 927.84, SkipList 1166.44; lite-o1 EliasFano 173.21; lite-o1 BitSet n/a (U > 2^25).
- **Against lite-o1 BitSet at n = 4096, w = 16..24:** BitSet 4.28-4.82 ns/op vs the member 4.87-7.61 ns/op. BitSet is faster where it applies.
- **Latency** (lite-sketch DDSketch, alpha 0.01, 65536 samples per point): p50 125.22 ns at every n -- the timer's quantisation, not the op cost (about 12-18 ns/op); p99 210.64-290.07 ns; max 6,792-49,000 ns (single-op outliers; scheduler / GC of the harness, not attributed).

## Design decisions worth knowing

- **D1: `-0` aliases key 0.** One key, one bit.
- **D5: iteration is the successor walk.** No `forEach`, no iterator.
- **D6: fixed universe, fail closed.** `add(x >= U)` throws, there is no resize; queries with a bad key return `false` / `undefined` and touch no word.
- **D9: strict successor / predecessor.** `successor(x)` is the smallest key > x, never >= x; use `has(x) ? x : successor(x)` for "at or after".
- **D10: the level-0 peel only.** A/B-gated (A12, above); a `_tier` dispatch and bulk ops were rejected.
- **Amendment 1 (ADR 0004): counts are the hard gate.** The bound is proven by exact word-read counts (D7, counting Proxy over the shipped `_bits`); timing fits are REPORTED, never gated.
- **D8: the witness is out of `verify`.** It is release-time, needs a quiet host, and has a HOST verdict (exit 2) that `verify` cannot express.

See [`decisions/`](./decisions) for the full records.

## Testing

`node:test` only, zero runtime deps. `npm test`: 162 tests, 0 fail (2026-10-22, Node v26.8.2). It covers exact counts (Count), a seeded oracle fuzz (Oracle), sibling oracles (lite-o1 BitSet.nextSet for U <= 2^25, lite-o1 EliasFano.nextGEQ, lite-logn Scapegoat + SortedArray; 0 divergences, each with a must-fail control), FastBit32Cross, Space, TierParity, the witness / tier verdict functions on injected vectors, and the `QaAudit` block (VERSION trinity, frozen export surface, six-file pack, author spelling, ASCII).

| Script | What it does |
| --- | --- |
| `npm test` | The suite above. |
| `npm run test:types` | `tsc` over the ambient `LogLogN.d.ts`. |
| `npm run torture` | `node --expose-gc test/torture.mjs`: 0 B/op, gc major 0 / minor 0. |
| `npm run test:perf` | `@zakkster/lite-perf-gate`: 7 zero-alloc scenarios + 3 teeth, flag pin, attribution. |
| `npm run verify` | The four above in sequence (no witness). |
| `npm run test:big` | Opt-in big-universe suite. |
| `npm run witness` | STATISTICAL A8, release-time, quiet host. |
| `npm run witness:w32` | Opt-in w = 32 witness (about 554 MB). |
| `npm run witness:tier` | STATISTICAL A12, the peel A/B. |

Witness exit codes: 0 pass, 1 fail, 2 inconclusive (host noise, drift, or an A/A winner).

## What this is not

- **Not lite-o1's BitSet.** For U <= 2^25 and successor-only, [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) BitSet (fixed 3 levels, O(1) in U) is the better pick, and measured faster (above). StratifiedBitset owns `predecessor` / `max`, U up to 2^32, labelled O(log_32 U), and returns `undefined` for absent (lite-o1 BitSet returns -1).
- **Not a bounded-integer priority queue.** Use lite-o1's `BucketQueue` (Dial, O(1)).
- **Not a general comparator ordered map.** Non-integer or comparator keys belong in `@zakkster/lite-logn` (O(log n)).
- **Not an approximate-membership library.** Bloom / cuckoo / binary-fuse filters live in [`@zakkster/lite-filter`](https://www.npmjs.com/package/@zakkster/lite-filter); lite-loglogn is exact and has no 0.2.0 use of it.
- **Not a grow-on-demand collection.** The universe is fixed at construction.

## Ecosystem

Part of the `@zakkster/*` LiteLibrariesSuite of zero-GC, single-file ESM micro-libraries.

- [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) -- the O(1) sibling (BitSet, BucketQueue, EliasFano).
- [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) -- the O(log n) sibling (SortedArray, Treap, SkipList).
- [`@zakkster/lite-filter`](https://www.npmjs.com/package/@zakkster/lite-filter) -- approximate / probabilistic membership.
- [`@zakkster/lite-fastbit32`](https://www.npmjs.com/package/@zakkster/lite-fastbit32) -- the `clz32` / word-bit primitives.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
