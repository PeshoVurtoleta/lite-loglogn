# @zakkster/lite-loglogn

> Zero-GC, sub-logarithmic bounded-integer predecessor / successor structures that PROVE their bound. Two members ship. StratifiedBitset (0.2.0): an array-embedded 32-ary bit pyramid, O(log_32 U) successor / predecessor, O(U/w) space. XFastTrie (0.3.0): O(log log U) successor / predecessor over pointer-free cuckoo LevelTables, with honest O(w) updates and O(n*w) space at a fixed capacity. 0 B/op on every hot method of both, and each bound gated by exact COUNTS. YFastTrie and vEBTree are planned.

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

Almost no JavaScript data-structure library ships the evidence that its Big-O claim survives contact with a real engine. `lite-loglogn` is a curated family of sub-logarithmic bounded-integer predecessor / successor structures, each zero-GC. The first member, `StratifiedBitset` (0.2.0), is an integer set over a fixed universe `[0, U)` (U up to 2^32) whose `successor` / `predecessor` read at most `2 * levels - 1` words, with `levels = max(1, ceil(log2(U) / 5))` (at most 7).

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

The second member, `XFastTrie` (0.3.0), is the strict O(log log U) query: a fixed-capacity x-fast trie, fast to query and slow to update, big in space (caveats below, stated up front).

```js
import { XFastTrie } from '@zakkster/lite-loglogn';

const t = new XFastTrie(2 ** 32, 4);         // universe [0, 2^32), at most 4 keys at once
t.add(5).add(70).add(70).add(4000000000);    // add is idempotent and chainable
console.log(t.size, t.bits, t.capacity);     // -> 3 32 4
console.log(t.successor(5), t.successor(70), t.successor(4000000000));
                                             // -> 70 4000000000 undefined
console.log(t.predecessor(70), t.predecessor(5));  // -> 5 undefined
console.log(t.min(), t.max());               // -> 5 4000000000
console.log(t.delete(70), t.delete(70));     // -> true false

t.add(1).add(2);                             // size is 4 = capacity: full
try { t.add(3); } catch (e) {                // a NEW key at capacity throws, nothing is written
  console.log(e instanceof RangeError, t.size);
}                                            // -> true 4
console.log(t.has(-1), t.successor(NaN));    // -> false undefined
```

The family name ties it to the sibling series: [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) is the constant, [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) is the logarithm in `n`, and lite-loglogn is the double logarithm in `U`: the FAMILY bound is O(log log U). StratifiedBitset itself is O(log_32 U), not O(log log U); XFastTrie is the first strict O(log log U) member (queries only: its updates are O(w)); YFastTrie and vEBTree are planned.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [Deep dive: the bit pyramid](#deep-dive-the-bit-pyramid)
- [Deep dive: the XFastTrie](#deep-dive-the-xfasttrie)
- [API reference](#api-reference)
  - [Getters](#getters)
  - [Constants](#constants)
  - [XFastTrie](#xfasttrie)
- [The roster](#the-roster)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Measured (reported)](#measured-reported)
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
- **SPACE is a co-headline.** StratifiedBitset is O(U/w) (U = 2^32 is about 554 MB); XFastTrie is O(n*w), preallocated at its capacity (worst case 4,563,403,308 B at U = 2^32, capacity 2^24). Stated with the same prominence as time.

## What you get

- **Zero runtime dependencies.** ESM only, ASCII-only source, one PascalCase main file (`LogLogN.js`), `sideEffects: false`. The shipped surface is exactly `StratifiedBitset`, `XFastTrie` and `VERSION`.
- **0 B/op on every hot method** of both members, including XFastTrie's cuckoo kicks and in-place reseeds (DETERMINISTIC, gated by `npm run torture` and `npm run test:perf`).
- **An exact, gated cost model** (word reads per op for StratifiedBitset, level-table touches per op for XFastTrie, below) instead of a fitted line.
- **Strict ordered queries.** `successor(x)` is the smallest key > x, `predecessor(x)` the largest key < x; absent is `undefined`, never `-1` and never `null`.
- **Fail closed.** A bad key (not a number, non-integer, NaN, negative, >= U, null, string, Symbol, BigInt, boxed Number) touches no word: `has` / `delete` return `false`, `successor` / `predecessor` return `undefined`, `add` throws a `RangeError`. `-0` aliases key 0. Both members.
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

StratifiedBitset space is `byteLength = 4 x (total words of all levels)`. Pinned in `test/Space.test.js`:

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

## Deep dive: the XFastTrie

<details>
<summary>Layout, the cost model, and the three caveats</summary>

An x-fast trie keeps, for every prefix length L = 1..w (w = ceil(log2 U); level w holds the keys themselves), a hash table of the prefixes present, and the keys in a sorted doubly linked thread. A query binary-searches the w prefix lengths for the longest prefix of x that is present (about log2(w) table probes), then takes one hop along the thread. Each level table is an in-file bucketized cuckoo table (2 tables x B buckets x 4 slots, an occupancy byte, no tombstones, load <= 0.90, in-place reseed of up to 32 tries; design parity with `@zakkster/lite-o1` CuckooMap, no import; ADR 0007). Everything is preallocated in the constructor at a FIXED capacity.

**Cost model (DETERMINISTIC).** Cost is counted in level-table TOUCHES (1 touch = 1 probe = 4 descriptor reads and at most 8 occupancy reads), through a counting Proxy over every column of the shipped instance (`test/XftCount.test.js`). T = the binary-search steps over the w prefix lengths, T = log2(w) exactly for w = 2^j; m = the shorter common prefix length of x with its two thread neighbours (the update walk stops early at m):

| Op | Touches |
| --- | --- |
| `has(x)` | 1 |
| `successor(x)` / `predecessor(x)` | 1 (x present), 1 + T (x absent) |
| `min()` / `max()` | 0 (thread reads only) |
| `add(x)`, new key | 1 + T + (w - m) |
| `add(x)`, present or full | 1 |
| `delete(x)`, key present | w - m |
| `delete(x)`, key absent | 1 |
| any op, bad key | 0 |

Rows are exact when no kick or reseed fires (add only; kicks, reseeds and tries are counted in the instance and REPORTED). Gated values (DETERMINISTIC, `test/XftCount.test.js`, computed independently of the implementation): an ABSENT successor at w = 2, 4, 8, 16, 32 costs 2, 3, 4, 5, 6 touches (R^2 against log2(w) = 1.0000, against w = 0.8710); an add into an EMPTY trie (m = 0) costs 4, 7, 12, 21, 38 touches (it is linear in w: R^2 against w = 0.9983, against log2(w) = 0.8975).

**The three caveats, stated plainly.**

1. **FAST QUERY.** `successor` / `predecessor` of an absent key = 1 + T touches, T = log2(w): 6 touches at w = 32. This is the only strict O(log log U) bound in the package.
2. **O(w) UPDATE.** A new key writes up to w level tables: `add` = 1 + T + (w - m) touches, `delete` = w - m. Updates are O(w), not O(log log U), and an `add` is expected-O(w) (a cuckoo stall reseeds one level, up to 32 passes of O(capacity) each).
3. **O(n*w) SPACE, FIXED capacity.** Memory is preallocated from the capacity C you pass, not from the keys present:

   `byteLength = 13 TS + 12 (C + 1) + 16 (w + 1) + 16`, TS = the total level-table slots (13 bytes per slot, 12 per leaf, 16 per level descriptor, 16 scratch).

   Pinned in `test/XFastTrieSpace.test.js` (DETERMINISTIC):

| U | capacity C | byteLength |
| --- | --- | --- |
| 2 | 1 | 176 |
| 65,536 | 1,024 | 225,580 |
| 65,536 | 4,096 | 688,428 |
| 1,048,576 | 16,384 | 3,604,844 |
| 1,048,576 | 262,144 | 30,409,068 |
| 4,294,967,296 | 1 | 3,896 |
| 4,294,967,296 | 65,536 | 31,457,836 |
| 4,294,967,296 | 16,777,216 (2^24) | 4,563,403,308 (formula only, never allocated in tests; about 4.6 GB) |

   Measured by `node test/space-table.mjs` (REPORTED: deterministic bytes from the formula, 2026-10-22, Node v26.8.2; its self-check constructs 14 cells and compares them to `byteLength`). XFT / SB = XFastTrie bytes over StratifiedBitset bytes at the same U (StratifiedBitset is O(U/w), independent of n):

| U | n (= C unless capped) | XFastTrie | StratifiedBitset | XFT / SB |
| --- | --- | --- | --- | --- |
| 2^16 | 1,000 | 225,292 B | 8,460 B | 26.630 |
| 2^16 | 10,000 | 1,185,260 B | 8,460 B | 140.102 |
| 2^16 | 100,000 (C capped at 65,536) | 4,194,604 B | 8,460 B | 495.816 |
| 2^16 | 1,000,000 (C capped at 65,536) | 4,194,604 B | 8,460 B | 495.816 |
| 2^20 | 1,000 | 331,852 B | 135,300 B | 2.453 |
| 2^20 | 10,000 | 2,037,292 B | 135,300 B | 15.058 |
| 2^20 | 100,000 | 11,423,980 B | 135,300 B | 84.434 |
| 2^20 | 1,000,000 | 66,526,316 B | 135,300 B | 491.695 |
| 2^24 | 1,000 | 438,412 B | 2,164,804 B | 0.203 |
| 2^24 | 10,000 | 2,889,324 B | 2,164,804 B | 1.335 |
| 2^24 | 100,000 | 18,239,788 B | 2,164,804 B | 8.426 |
| 2^24 | 1,000,000 | 175,578,284 B | 2,164,804 B | 81.106 |
| 2^32 | 1,000 | 651,532 B | 554,189,332 B (not built) | 0.001 |
| 2^32 | 10,000 | 4,593,388 B | 554,189,332 B (not built) | 0.008 |
| 2^32 | 100,000 | 31,871,404 B | 554,189,332 B (not built) | 0.058 |
| 2^32 | 1,000,000 | 393,682,220 B | 554,189,332 B (not built) | 0.710 |

   Read it honestly: at a dense universe (U = 2^16 .. 2^20) the x-fast trie costs tens to hundreds of times StratifiedBitset's bytes; it pays off only for a SPARSE set in a huge universe (U = 2^32 with n up to about 10^6 here), and you pay for the capacity you declare, whether or not you fill it.

**Fixed capacity.** `new XFastTrie(universe, capacity)`: capacity is an integer in [1, min(U, 2^24)]. An `add` of a NEW key at `size === capacity` throws a `RangeError` and writes nothing; there is no growth and no hidden rehash beyond the labelled in-place reseed.

**Fixed seeds, hash-flood caveat.** The cuckoo hash seeds are fixed defaults per level (no per-instance randomness). The price: an adversary who controls the keys can craft keys that collide in every bucket pair, forcing kick chains and reseeds. CORRECTNESS holds; TIME suffers (each forced reseed is O(capacity) at one level, up to 32 tries). If 32 tries fail, the `add` is rolled back and throws a `RangeError` (the set is exactly as before); if even the rollback cannot re-place a level, the instance is POISONED: every hot method throws a `TypeError` on a valid key until `clear()`, which restores the default seeds and revives it. Do not feed it untrusted keys without bounding the damage (see ADR 0007).

**Timing.** XFastTrie timing is REPORTED only; see [Measured](#measured-reported).

</details>

## API reference

### StratifiedBitset

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

### XFastTrie

| Signature | Returns | Notes |
| --- | --- | --- |
| `new XFastTrie(universe, capacity)` | instance | `universe` an integer in [2, 2^32] and `capacity` an integer in [1, min(universe, 2^24)], else `RangeError` (`[lite-loglogn] XFastTrie universe must be an integer in [2, 2^32]; got ...` / `... capacity must be an integer in [1, ...] (min(universe, 2^24)); got ...`). Fixed universe and capacity, no resize. Allocates every column. |
| `has(x)` | `boolean` | Bad key -> `false`. |
| `add(x)` | `this` | Idempotent. Bad key -> `RangeError`; a NEW key at `size === capacity` -> `RangeError` (`[lite-loglogn] XFastTrie is full (capacity C); delete a key first -- capacity is fixed at construction`), no state touched. After 32 failed reseed tries the add is rolled back and throws a `RangeError`. |
| `delete(x)` | `boolean` | `true` if `x` was present. Bad key -> `false`. |
| `successor(x)` | `number \| undefined` | Smallest key > x (STRICT). Bad key -> `undefined`. |
| `predecessor(x)` | `number \| undefined` | Largest key < x (STRICT). Bad key -> `undefined`. |
| `min()` / `max()` | `number \| undefined` | `undefined` when empty. 0 touches. |
| `clear()` | `void` | Cold. Removes every key, restores the default seeds, and REVIVES a poisoned instance. |
| `dump()` | `XFastTrieDump` | Cold, ALLOCATES. `{ universe, capacity, size, bits, keys: Uint32Array (ascending), levels: { capacity, prefix, min, max }[] }`; `levels[L - 1]` is prefix length L = 1..w, read from the level table itself. |

Getters (cold): `size`, `universe`, `capacity`, `bits` (w = ceil(log2 U), the number of trie levels), `byteLength` (13 TS + 12 (C + 1) + 16 (w + 1) + 16, every typed array the instance owns).

Limits and failure modes:

| Limit | Value |
| --- | --- |
| Universe U | integer, 2 .. 2^32 |
| Capacity C | integer, 1 .. min(U, 2^24) (the cap keeps every table index a small integer; worst `byteLength` 4,563,403,308 B at U = 2^32, C = 2^24) |
| Add of a new key when full | `RangeError`, no state change |
| Add that cannot place after 32 reseed tries | `RangeError`, the add is rolled back (logical restore) |
| Rollback that cannot re-place a level | POISONED: `Error` thrown, then every hot method throws `TypeError` on a valid key (`min` / `max` always) until `clear()`; a bad key is still rejected first (`false` / `undefined` / `RangeError`) |
| Bad key | not a number, non-integer, NaN, negative, >= U, null, string, Symbol, BigInt, boxed Number: touches nothing; `-0` aliases key 0 |

Reseed and kick counters live in the instance (cumulative; `clear()` keeps them, reviving a poisoned instance resets them to 0) and are REPORTED diagnostics the engine never reads; they are Int32 and wrap at 2^31. Poisoning stores `null` in one field, once, cold; optimized code that assumed an `Int32Array` there deopts.

## The roster

One member per release, each landing append-only (prior members stay byte-identical). StratifiedBitset (0.2.0) and XFastTrie (0.3.0) are shipped; YFastTrie and vEBTree are PLANNED.

| Member | Slot | Time (query) | Space | Shape |
| --- | --- | --- | --- | --- |
| **StratifiedBitset** | 0.2.0 | O(log_32 U) successor / predecessor; min / max read Lc words (Lc = levels <= 7) | O(U/w) | array-embedded hierarchical bit tree |
| **XFastTrie** | 0.3.0 (shipped) | O(log log U) query (1 + log2(w) touches when absent); updates O(w) | O(n*w), preallocated at a fixed capacity | binary search over w pointer-free cuckoo LevelTables + a sorted leaf thread |
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
| **XFastTrie** `has`, `add`, `delete`, `successor`, `predecessor`, `min`, `max` | 0 B (hot), including cuckoo kicks and in-place reseeds (torture X0-X4) |
| **XFastTrie** `clear` | 0 B (cold; no new buffer; restores the default seeds); on a POISONED instance it allocates a fresh 16 B `_q`, counters 0 |
| `new XFastTrie(U, C)` | allocates every column once (`byteLength` above); nothing is ever replaced except `_q` (nulled by a poison, re-created by `clear()`) |
| **XFastTrie** `dump()` | allocates (the keys and one entry per level) |

**Boxing note.** A returned key >= 2^31 (>= 2^30 on a pointer-compressed engine) may box as a HeapNumber when the call is not inlined. The B2a-E fix adds three `| 0` reads (predecessor descend, max top, max descend) so a word with bit 31 set stays a Smi-range int32 instead of a HeapNumber.

DETERMINISTIC numbers (2026-10-22, Node v26.8.2, every run of the named script):

- `npm run torture` (`node --expose-gc test/torture.mjs`): T0 runs 2,000,000 ops at U = 2^20 -> retained 0 B/op, transient 0.000 B/op, gc major 0 / minor 0; T1-T2 ok; T3's five must-fail controls (one per T0-T2 check, plus gcKick) each flip (torture run 2026-10-23, host PRELIMINARY, Node v26.8.2, 1 run; a count gate, not timing).
- XFastTrie torture lanes X0-X4 (QUIET verify run 2026-10-22, load1 1.32 vs baseline 2.21, 12 cores, Node v26.8.2, 1 run; the same counts hold on every run): X0a 2,000,000 ops at U = 2^20, C = 8192 and X0b 2,000,000 ops at U = 2^30, C = 8192 -> alloc 0 B/op, transient 0.000 B/op, gc major 0 / minor 0; X1 200,000 ops at U = 2^32, C = 8192 (byteLength 4,571,692, abGrowth 0, key 4294967295 returned); X2 reseed churn at U = 65536, C = 16, 50,000 cycles each: natural (kicks +2,000,000, reseedOps +50,000, tries +50,000) and forced (kicks +2,000,000, reseedOps +50,000, rebuilds +200,000) -> 0 B/op, abGrowth 0; X3 leak census (4096 create / drop cycles, 4096/4096 collected, 0 findings); X4's six must-fail controls (retain, box, a reallocating reseed, a dropped-reseed count, a retained set, xGcKick) each flip (torture run 2026-10-23, host PRELIMINARY, Node v26.8.2, 1 run; a count gate, not timing).
- `npm run test:perf` also runs `test/perf/XFastTriePerf.test.mjs`: 8 zero-alloc scenarios (has, add+delete, successor, predecessor, min, max, successor-walk at U = 2^20, successor at U = 2^32 (keys < 2^30)), and 3 must-fail teeth (a fresh-array loop, GrowingXft, SideBufferXft) = flag pin (2) + detector (1) + 8 scenarios + 3 teeth + attribution (1) + dual-lane (1) + coverage floor (1) = 17 tests; with PerfGate's 14, the QUIET verify run gave 31/31 pass (2026-10-22, QUIET, same host, 1 run).
- `npm run test:perf` (`@zakkster/lite-perf-gate`), StratifiedBitset file `test/perf/PerfGate.test.mjs`: 7 zero-alloc scenarios (has, add+delete, successor, predecessor, min, max, successor-walk at U = 2^20) + 3 must-fail teeth + flag pin (2) + arrayBuffers attribution (1) = 14/14.

</details>

## Measured (reported)

The BOUND above is proven by the DETERMINISTIC counts. The numbers below are timing evidence on ONE host, not a law, and not in `npm run verify` (D8). There is no CI for this package: every timing claim is REPORTED only (a measurement with provenance that gates nothing), not a gated STATISTICAL claim.

Provenance for every row: 2026-10-22, MacBook-Pro (Apple M4 Pro, 12 cores), Node v26.8.2 / V8 14.6.202.34, darwin/arm64, shared host under quiet-lock, 1 run each.

### REPORTED: `npm run witness` (A8), one run

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

### REPORTED: `npm run witness:tier` (A12), the level-0 peel

FULL run 2026-10-22T02:27:20Z, load1 4.79 (5-min 5.72), wall 0.39 s: EXIT 2 (PENDING, inconclusive). B = the live peel; A = the previous body (rev 00ba7e1) plus the same three `| 0` reads. ns/op medians:

| Scenario | B (peel) | A | Wins B/A | Verdict |
| --- | --- | --- | --- | --- |
| dense-succ (U 2^16, n 32768) | 3.63 | 4.10 | 15/0 | win (B 11.5% faster) |
| sparse-succ (U 2^20, n 4096) | 7.59 | 7.81 | 12/3 | none |
| dense-pred | 3.19 | 3.82 | 14/1 | win (B 16.5% faster) |
| sparse-pred | 6.70 | 6.68 | 8/7 | none |

No scenario lost. Control A x2 vs A: 0/15 ok. Drift quiet over 105 rounds. The exit 2 came from the dense-succ A/A (B vs its byte-identical twin): 1/14 at 3.64 vs 3.60, about a 1% difference on identical code, which K = 15 / need 13 resolves as a "winner". Sparse A/A 5/10 ok.

**Waiver, stated honestly:** the A12 gate itself returned inconclusive; the peel ships by maintainer waiver (2026-10-22), on effect size (11.5% / 16.5% dense wins, about 10x the 1% A/A difference) and because no scenario lost. The follow-up is decided (ADR 0006 amendment): the XFastTrie A/B lane uses a 2% minimum-effect floor (`AB_EFFECT_FLOOR` in `test/helpers/abVerdict.mjs`); `tierVerdict` itself is unchanged.

### REPORTED: `npm run witness:xft` (XFastTrie), release run

The XFastTrie lane (`node test/witness.mjs --xft`; `--smoke` is a counts-only smoke) runs a U-sweep, an n-sweep, an update fit and latency, A/B-timing XFastTrie `successor` against StratifiedBitset (abVerdict: 2% effect floor on every "win" and A/A flag) and, as a REPORTED point verdict with no floor, against a local `Uint32Array` binary search (exit 0 pass / 1 fail / 2 inconclusive). Its timing numbers come from the release run only and are not in `npm test`; the smoke gate (`test/XftWitness.test.js`) asserts counts and strings, never a timing value.

<!-- XFT-WITNESS-BEGIN -->
@@XFT-WITNESS@@
<!-- XFT-WITNESS-END -->

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
- **XFastTrie: fixed capacity, early-stop updates, poison-then-clear (ADR 0007).** `add` of a new key at `size === capacity` throws and writes nothing; the update walk stops at the shorter common prefix with the thread neighbours (`w - m` touches); a failed rollback poisons the instance until `clear()`; the cuckoo seeds are fixed, so adversarial keys can force kicks and reseeds (correctness holds, time suffers).
- **Plain x-fast, not z-fast.** Queries binary-search the prefix lengths over hash probes; a z-fast trie (fewer probes per update, more machinery) is left to the YFastTrie decision.

See [`decisions/`](./decisions) for the full records.

## Testing

`node:test` only, zero runtime deps. `npm test`: 342 tests, 0 fail (DETERMINISTIC; 2026-10-22, Node v26.8.2). It covers, for StratifiedBitset, exact counts (Count), a seeded oracle fuzz (Oracle), sibling oracles (lite-o1 BitSet.nextSet for U <= 2^25, lite-o1 EliasFano.nextGEQ, lite-logn Scapegoat + SortedArray; 0 divergences, each with a must-fail control), FastBit32Cross, Space, TierParity, the witness / tier verdict functions on injected vectors, and the `QaAudit` block (VERSION trinity, frozen export surface, six-file pack, author spelling, ASCII, plus an XFastTrie coercion / boundary block). For XFastTrie: `XftVectors` (15 seeded streams replayed against a stored cut, cross-checked against StratifiedBitset, with a `>=` mutant control), `XftCount` (exact touches through a counting Proxy over all eight columns, with six must-fail mutant controls plus a hang control), `XFastTrie` / `XFastTrieBoundary` / `XFastTrieOracle` (behavior, boundary keys, seeded oracle fuzz), `XFastTrieSpace` (byteLength pins and the identity of every column), `XftBytecode` (every hot body <= 460 B), `Parity` (the StratifiedBitset region of the file is byte-pinned against 0.2.0), `AbVerdict` (the 2% effect floor), and `XftWitness` (the `--xft --smoke` gate, counts and strings only).

| Script | What it does |
| --- | --- |
| `npm test` | The suite above. |
| `npm run test:types` | `tsc` over the ambient `LogLogN.d.ts`. |
| `npm run torture` | `node --expose-gc test/torture.mjs`: lanes T0-T3 (StratifiedBitset) and X0-X4 (XFastTrie, including kicks and reseeds): 0 B/op, gc major 0 / minor 0. |
| `npm run test:perf` | `@zakkster/lite-perf-gate`: PerfGate (7 zero-alloc scenarios + 3 teeth, flag pin, attribution = 14) and XFastTriePerf (8 scenarios, teeth, attribution = 17); 31/31 in the 2026-10-22 QUIET verify run. |
| `npm run verify` | The four above in sequence (no witness). |
| `npm run test:big` | Opt-in big-universe suite. |
| `npm run witness` | REPORTED A8, release-time, quiet host. |
| `npm run witness:w32` | Opt-in w = 32 witness (about 554 MB). |
| `npm run witness:tier` | REPORTED A12, the peel A/B. |
| `npm run witness:xft` | REPORTED, the XFastTrie lane (`node test/witness.mjs --xft`; release-time, quiet host, 2% effect floor). |

Witness exit codes: 0 pass, 1 fail, 2 inconclusive (host noise, drift, or an A/A winner).

## What this is not

- **Not lite-o1's BitSet.** For U <= 2^25 and successor-only, [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) BitSet (fixed 3 levels, O(1) in U) is the better pick, and measured faster (above). StratifiedBitset owns `predecessor` / `max`, U up to 2^32, labelled O(log_32 U), and returns `undefined` for absent (lite-o1 BitSet returns -1).
- **Not a bounded-integer priority queue.** Use lite-o1's `BucketQueue` (Dial, O(1)).
- **Not a general comparator ordered map.** Non-integer or comparator keys belong in `@zakkster/lite-logn` (O(log n)).
- **Not an approximate-membership library.** Bloom / cuckoo / binary-fuse filters live in [`@zakkster/lite-filter`](https://www.npmjs.com/package/@zakkster/lite-filter); lite-loglogn is exact and has no use of it.
- **Not a grow-on-demand collection.** The universe is fixed at construction, and XFastTrie's capacity too: it never grows and never rehashes beyond its labelled in-place reseed.
- **Not a compact structure.** XFastTrie is O(n*w) space, preallocated at the capacity you declare (up to about 4.6 GB at U = 2^32, capacity 2^24), and its updates cost O(w) touches. For O(n) space the answer is the planned YFastTrie; for a dense universe StratifiedBitset is far smaller (table above).
- **Not hash-flood resistant.** XFastTrie's cuckoo seeds are fixed; adversarial keys can force kicks and reseeds (ADR 0007).

## Ecosystem

Part of the `@zakkster/*` LiteLibrariesSuite of zero-GC, single-file ESM micro-libraries.

- [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) -- the O(1) sibling (BitSet, BucketQueue, EliasFano).
- [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) -- the O(log n) sibling (SortedArray, Treap, SkipList).
- [`@zakkster/lite-filter`](https://www.npmjs.com/package/@zakkster/lite-filter) -- approximate / probabilistic membership.
- [`@zakkster/lite-fastbit32`](https://www.npmjs.com/package/@zakkster/lite-fastbit32) -- the `clz32` / word-bit primitives.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
