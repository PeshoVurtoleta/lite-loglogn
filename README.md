# @zakkster/lite-loglogn

> Zero-GC, sub-logarithmic bounded-integer predecessor / successor structures that PROVE their bound. Four members ship. StratifiedBitset (0.2.0): an array-embedded 32-ary bit pyramid, O(log_32 U) successor / predecessor, O(U/w) space. XFastTrie (0.3.0): O(log log U) successor / predecessor over pointer-free cuckoo LevelTables, with honest O(w) updates and O(n*w) space at a fixed capacity. YFastTrie (0.4.0): the same O(log log U) queries in O(n) space, over an x-fast trie of O(n/w) representatives and bounded sorted buckets. vEBTree (0.5.0): a flattened van Emde Boas tree in one `Uint32Array`, worst-case O(log log U) for every operation and O(1) `min` / `max`, in O(U) space. 0 B/op on every hot method of all four members (keys below 2^30), and each bound gated by exact COUNTS.

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

Almost no JavaScript data-structure library ships the evidence that its Big-O claim survives contact with a real engine. `lite-loglogn` is a curated family of sub-logarithmic bounded-integer predecessor / successor structures; StratifiedBitset, XFastTrie, YFastTrie and vEBTree are each zero-GC. The first member, `StratifiedBitset` (0.2.0), is an integer set over a fixed universe `[0, U)` (U up to 2^32) whose `successor` / `predecessor` read at most `2 * levels - 1` words, with `levels = max(1, ceil(log2(U) / 5))` (at most 7).

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

The third member, `YFastTrie` (0.4.0), keeps the O(log log U) query and fixes the space: O(n) instead of O(n*w), with updates that cost O(log log U) probes plus at most 2w - 1 contiguous word moves (a bucket split / merge / borrow is amortized; caveats below, stated up front). The optional third argument is a uint32 seed that only moves the inner trie's hash layout (omitted or 0 = the defaults, never random).

```js
import { YFastTrie } from '@zakkster/lite-loglogn';

const y = new YFastTrie(2 ** 32, 1000);      // universe [0, 2^32), at most 1000 keys at once
y.add(5).add(70).add(70).add(4000000000);    // add is idempotent and chainable
console.log(y.size, y.bits, y.capacity);     // -> 3 32 1000
console.log(y.successor(5), y.successor(70), y.successor(4000000000));
                                             // -> 70 4000000000 undefined
console.log(y.predecessor(70), y.predecessor(5));  // -> 5 undefined
console.log(y.min(), y.max());               // -> 5 4000000000
console.log(y.delete(70), y.delete(70));     // -> true false

try { new YFastTrie(2 ** 32, 4, -1); } catch (e) {   // a bad seed fails closed
  console.log(e instanceof RangeError, e.message);
}                                            // -> true [lite-loglogn] YFastTrie seed must be a uint32 integer in [0, 2^32-1]; got -1
console.log(y.has(-1), y.successor(NaN));    // -> false undefined
```

The fourth member, `vEBTree` (0.5.0), is the worst-case O(log log U) structure: no hashing, no reseed, no amortized step, at the price of O(U) space (the whole universe is allocated up front; for a sparse large universe use `YFastTrie`). It takes only the universe (the `// ->` outputs below are from a real run).

```js
import { vEBTree } from '@zakkster/lite-loglogn';

const v = new vEBTree(2 ** 16);              // universe [0, 2^16): one Uint32Array, allocated up front
v.add(5).add(70).add(70).add(65535);         // add is idempotent and chainable
console.log(v.size, v.bits, v.byteLength);   // -> 3 16 8232
console.log(v.successor(5), v.successor(70), v.successor(65535));
                                             // -> 70 65535 undefined
console.log(v.predecessor(70), v.predecessor(5));  // -> 5 undefined
console.log(v.min(), v.max());               // -> 5 65535
console.log(v.delete(70), v.delete(70));     // -> true false

const keys = [];
for (let k = v.min(); k !== undefined; k = v.successor(k)) keys.push(k);
console.log(keys.join(','));                 // -> 5,65535

try { v.add(2 ** 16); } catch (e) {          // a bad key never touches a word
  console.log(e instanceof RangeError, e.message);
}                                            // -> true [lite-loglogn] key must be an integer in [0, 65536); got 65536
try { new vEBTree(1); } catch (e) {          // the universe is checked first
  console.log(e instanceof RangeError, e.message);
}                                            // -> true [lite-loglogn] vEBTree universe must be an integer in [2, 2^32]; got 1
console.log(v.has(-1), v.successor(NaN));    // -> false undefined
```

The family name ties it to the sibling series: [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) is the constant, [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) is the logarithm in `n`, and lite-loglogn is the double logarithm in `U`: the FAMILY bound is O(log log U). StratifiedBitset itself is O(log_32 U), not O(log log U); XFastTrie is the first strict O(log log U) member (queries only: its updates are O(w)); YFastTrie (0.4.0) keeps the O(log log U) query at O(n) space (updates are O(log log U) probes plus at most 2w - 1 word moves, restructuring amortized); vEBTree (0.5.0) is the worst-case member: O(log log U) for every operation, O(U) space.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [Deep dive: the bit pyramid](#deep-dive-the-bit-pyramid)
- [Deep dive: the XFastTrie](#deep-dive-the-xfasttrie)
- [Deep dive: the YFastTrie](#deep-dive-the-yfasttrie)
- [Deep dive: the vEBTree](#deep-dive-the-vebtree)
- [API reference](#api-reference)
  - [Getters](#getters)
  - [Constants](#constants)
  - [XFastTrie](#xfasttrie)
  - [YFastTrie](#yfasttrie)
  - [vEBTree](#vebtree)
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
- **SPACE is a co-headline.** StratifiedBitset is O(U/w) (U = 2^32 is about 554 MB); XFastTrie is O(n*w), preallocated at its capacity (worst case 4,563,403,308 B at U = 2^32, capacity 2^24); YFastTrie is O(n), preallocated at its capacity too (formula in its deep dive); vEBTree is O(U), the whole universe allocated up front (8,232 B at U = 2^16, 539,500,592 B at U = 2^32; table in its deep dive). Stated with the same prominence as time.

## What you get

- **Zero runtime dependencies.** ESM only, ASCII-only source, one PascalCase main file (`LogLogN.js`), `sideEffects: false`. The shipped surface is exactly `StratifiedBitset`, `XFastTrie`, `YFastTrie`, `vEBTree` and `VERSION`.
- **0 B/op on every hot method** of all four members (StratifiedBitset, XFastTrie, YFastTrie and vEBTree), including XFastTrie's cuckoo kicks and in-place reseeds, YFastTrie's bucket splits and merges and vEBTree's delete max refresh (DETERMINISTIC, gated by `npm run torture`, and for all four members also by `npm run test:perf`; keys below 2^30, see the boxing note).
- **An exact, gated cost model** (word reads per op for StratifiedBitset, level-table touches per op for XFastTrie, touches plus bucket reads and word moves per op for YFastTrie, below) instead of a fitted line.
- **Strict ordered queries.** `successor(x)` is the smallest key > x, `predecessor(x)` the largest key < x; absent is `undefined`, never `-1` and never `null`.
- **Fail closed.** A bad key (not a number, non-integer, NaN, negative, >= U, null, string, Symbol, BigInt, boxed Number) touches no word: `has` / `delete` return `false`, `successor` / `predecessor` return `undefined`, `add` throws a `RangeError`. `-0` aliases key 0. All four members.
- **Tree-shakeable named exports.**

## Deep dive: the bit pyramid

<details>
<summary>Levels, the level-0 peel, and the cost model</summary>

One flat `Uint32Array` holds the whole structure. Level 0 is the key bitmap (bit `x` set means key `x` is present). Level `L+1` has one bit per word of level `L`, set while that word is non-zero, so each level is 32x smaller than the one below. The number of levels is `Lc = max(1, ceil(log2(U) / 5))`: 4 at U = 2^16 and 2^20, 5 at 2^24, 6 at 2^28, 7 at 2^32.

`successor` climbs from level 0 until some word has a set bit above the position, then descends along the lowest set bit with `Math.clz32` word operations. `min` / `max` descend from the top.

**The level-0 peel.** `successor` / `predecessor` first test the level-0 word that holds `x+1` / `x-1` and return from it without touching level 1. No new field, same memory layout, same or lower exact counts than the previous body (gated against `test/vectors/tier-b1a.json`, DETERMINISTIC). On Node 26.8.2 / V8 14.6.202.34 the peel grows the bytecode: successor 264 -> 355 B, predecessor 232 -> 310 B (the peel's own delta; the later `| 0` reads make the shipped predecessor 313 B and max 121 -> 127 B), and every hot body stays within 460 B (`--max-inlined-bytecode-size`), gated by `test/TierParity.test.js` (DETERMINISTIC for that V8).

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

**Fixed seeds, hash-flood caveat.** The cuckoo hash seeds are fixed defaults per level (no per-instance randomness; since 0.4.0 an OPTIONAL caller seed, `new XFastTrie(universe, capacity, seed?)`, moves them deterministically: a uint32 integer, omitted / `undefined` / 0 = the defaults bit for bit, anything else a `RangeError`; it is never random by default and is not a defence against an attacker who knows it). The price: an adversary who controls the keys can craft keys that collide in every bucket pair, forcing kick chains and reseeds. CORRECTNESS holds; TIME suffers (each forced reseed is O(capacity) at one level, up to 32 tries). If 32 tries fail, the `add` is rolled back and throws a `RangeError` (the set is exactly as before); if even the rollback cannot re-place a level, the instance is POISONED: every hot method throws a `TypeError` on a valid key until `clear()`, which restores the CONSTRUCTED seeds (the defaults, or your seed) and revives it. Do not feed it untrusted keys without bounding the damage (see ADR 0007).

**Timing.** XFastTrie timing is REPORTED only; see [Measured](#measured-reported).

</details>

## Deep dive: the YFastTrie

<details>
<summary>Layout, the policy, the cost model, SPACE, and the claim wording</summary>

A y-fast trie keeps the keys in small sorted BUCKETS and an x-fast trie over only one REPRESENTATIVE (rep) per bucket, so the trie holds O(n/w) entries instead of O(n) and the space falls from O(n*w) to O(n). Here (ADR 0008) the inner trie is a plain `XFastTrie(U, Cr)` and the buckets are bounded sorted `Uint32Array` runs in ONE preallocated pool: no pointer, no allocation, no RNG (the structure is DETERMINISTIC). A query asks the inner trie for the bucket whose rep is the largest one <= x, binary-searches that bucket's run, and, if the answer lies past the end of the run, takes one hop along the inner leaf thread to the next bucket.

**The policy (ADR 0008).** w = ceil(log2 U), K = 2w (bucket capacity), h = ceil(w/2) (minimum size of a non-head bucket). Reps are SEPARATORS: bucket i holds the keys in [rep_i, rep_{i+1}); a rep is a split point and need not be a live key. The head rep 0 is permanent, its bucket holds 0..K keys and never merges; every other bucket holds h..K keys.

- **Split.** Adding a NEW key into a bucket of K keys: the new rep is the key at index w, the upper w keys move to the new bucket, x goes to whichever half it belongs to. The inner `add(rep)` runs BEFORE any copy, so a stall there leaves the set unchanged.
- **Underflow.** Deleting from a non-head bucket of s <= h keys: with s_L the size of the LEFT neighbour, if s_L + s - 1 <= K the bucket MERGES into its left neighbour and its rep is dropped; otherwise it BORROWS (t = s_L + s - 1, the new rep is the left bucket's key at index ceil(t/2)).
- **Inner capacity.** The inner trie holds at most Cr = min(2 + floor(C/h), U) reps.

**Cost model (DETERMINISTIC).** Counted through a Proxy over every column of the shipped instance (`_bk`, `_bn` and the inner trie's eight columns) in `test/YftCount.test.js`, with expected values from an independent policy model. lambda = inner level-table touches of one locate = 1 when x is a rep, else 1 + T (T = log2(w) for w = 2^j); beta = binary-search reads over a bucket of s keys, floor(log2(s+1)) <= beta <= ceil(log2(s+1)) (exact at s = 2^j - 1); lb = the lower-bound index the search finds; m, m' = the early-stop prefix lengths of the inner add / delete walk (ADR 0007):

| Op | Inner touches | Bucket search reads | Word moves |
| --- | --- | --- | --- |
| any op, bad key | 0 | 0 | 0 |
| `has(x)`, `add` present or full, `delete` absent | lambda | beta + [lb < s] | 0 |
| `successor(x)` / `predecessor(x)` | lambda | beta + at most 2 (+ the hop) | 0 |
| `min()` / `max()` | 0 | at most 1 (+ the hop) | 0 |
| `add(x)`, new key, no split | lambda | beta + [lb < s] | s - lb, plus 1 key write |
| `delete(x)`, present, no merge / borrow | lambda | beta + 1 | s - lb - 1 |
| `add(x)`, new key, SPLIT (s = K) | lambda + 1 + T + (w - m) | beta + [lb < s] + 1 | w + (w - lb'), plus 1 key write |
| `delete(x)`, present, MERGE (s <= h) | lambda + (w - m) | beta + 1 | s - 1 |
| `delete(x)`, present, BORROW (s <= h) | lambda + 1 + T + (w - m) + (w - m') | beta + 2 | (s_L - c) + (s - 1) = floor(t/2) <= 2w, c = ceil(t/2) |

Rows are WHOLE ops (s = x's bucket size before the op; t = s_L + s - 1): the split row replaces the plain add row, the merge / borrow rows replace the plain delete row. A split moves w words to the new bucket, then inserts x into the half it lands in (w - lb' more, lb' = x's index in that half; in all 2w - lb moves for a left-routed x, 3w - lb for a right-routed one, at most 2w, reached only by a left-routed x at lb = 0). A merge or borrow does not add to the plain delete shift, and a split or borrow also reads the new rep (one more `_bk` word; a borrow's other extra read is the equality read). Gated values (DETERMINISTIC, computed independently of the implementation): an ABSENT successor from a bucket of s = 2w - 1 keys costs touches + bucket reads = 4, 6, 8, 10, 12 at w = 2, 4, 8, 16, 32 (R^2 against log2(w) = 1.0000, against w = 0.8710); a plain update moves at most 2w - 1 words (the worst case is hit), a split / merge / borrow at most 2w (the split worst case is hit), an inner reseed makes at most 32 tries. Rows are exact when no inner kick or reseed fires (add only; at most 1% of a seeded random stream is kicked).

**The claim, worded exactly (ADR 0008).**

1. **Queries are O(log log U)**: one inner locate (lambda <= 1 + log2(w) touches) plus one binary search of a bucket of at most 2w keys.
2. **Updates are O(log log U) probes plus at most 2w - 1 contiguous word moves (O(w)).** The moves are a `copyWithin` over one bucket in the pool.
3. **A split / merge / borrow is AMORTIZED**, not worst-case: it moves at most 2w words and runs one inner add (split), one inner delete (merge) or both (borrow). A merge can be followed at once by one split of the merged bucket; a split or borrow leaves each bucket it touches Omega(w) updates away from its next restructure. The inner trie's own cuckoo insert keeps its XFastTrie bound (an add is expected-O(w) with an in-place reseed on a stall; the caveats above apply to it).

"O(log log U) update" with no qualifier is NOT claimed.

**SPACE (DETERMINISTIC formula, pinned from a test-owned model in `test/YFastTrieSpace.test.js`).** Preallocated from the capacity C:

`byteLength = 4 (Cr + 1) K + (Cr + 1) + 16 + XFastTrie(U, Cr).byteLength`, with Cr = min(2 + floor(C/h), U), K = 2w.

Measured by `node test/space-table.mjs` (REPORTED: deterministic bytes from the formulas, 2026-10-25, Node v26.8.2, untimed; its self-check constructs 14 XFastTrie and 16 YFastTrie cells and compares them to `byteLength`). Y / X = YFastTrie bytes over XFastTrie bytes, Y / SB over StratifiedBitset bytes, at the same U and the same C (n = C unless capped at min(U, 2^24)):

| U | n (= C unless capped) | XFastTrie | YFastTrie | Y / X | StratifiedBitset | Y / SB |
| --- | --- | --- | --- | --- | --- | --- |
| 2^16 | 1,000 | 225,292 B | 54,960 B | 0.244 | 8,460 B | 6.496 |
| 2^16 | 10,000 | 1,185,260 B | 389,969 B | 0.329 | 8,460 B | 46.096 |
| 2^16 | 100,000 (C capped at 65,536) | 4,194,604 B | 2,220,759 B | 0.529 | 8,460 B | 262.501 |
| 2^16 | 1,000,000 (C capped at 65,536) | 4,194,604 B | 2,220,759 B | 0.529 | 8,460 B | 262.501 |
| 2^20 | 1,000 | 331,852 B | 44,811 B | 0.135 | 135,300 B | 0.331 |
| 2^20 | 10,000 | 2,037,292 B | 493,375 B | 0.242 | 135,300 B | 3.647 |
| 2^20 | 100,000 | 11,423,980 B | 3,647,815 B | 0.319 | 135,300 B | 26.961 |
| 2^20 | 1,000,000 | 66,526,316 B | 27,524,503 B | 0.414 | 135,300 B | 203.433 |
| 2^24 | 1,000 | 438,412 B | 51,342 B | 0.117 | 2,164,804 B | 0.024 |
| 2^24 | 10,000 | 2,889,324 B | 398,116 B | 0.138 | 2,164,804 B | 0.184 |
| 2^24 | 100,000 | 18,239,788 B | 4,478,208 B | 0.246 | 2,164,804 B | 2.069 |
| 2^24 | 1,000,000 | 175,578,284 B | 34,123,672 B | 0.194 | 2,164,804 B | 15.763 |
| 2^32 | 1,000 | 651,532 B | 64,637 B | 0.099 | 554,189,332 B (not built) | 0.000 |
| 2^32 | 10,000 | 4,593,388 B | 502,292 B | 0.109 | 554,189,332 B (not built) | 0.001 |
| 2^32 | 100,000 | 31,871,404 B | 4,025,529 B | 0.126 | 554,189,332 B (not built) | 0.007 |
| 2^32 | 1,000,000 | 393,682,220 B | 47,484,715 B | 0.121 | 554,189,332 B (not built) | 0.086 |

Read it honestly: YFastTrie is smaller than XFastTrie at every cell (Y / X 0.099 to 0.529; the worst cell is U = 2^16 with C capped at 65,536, where the inner trie is nearly as large as the universe allows), but a dense universe still belongs to StratifiedBitset: Y / SB is 6.496 to 262.501 at U = 2^16 and 0.331 to 203.433 at U = 2^20 (YFastTrie is smaller only at n = 1,000 there), and it is smaller at U = 2^32 and at U = 2^24 for n up to 10,000. The O(n) bound is a statement about growth in C: in the `witness:yft` run below (w = 28, C = n + 1) YFastTrie costs 31.7 to 58.0 B per declared key (n = 1,000 .. 10,000,000), against XFastTrie's 251 to 545 B per key (n = 1,000 .. 1,000,000, same run).

**Failure modes (ADR 0008).**

- **Full.** `add` of a NEW key at `size === capacity` throws `RangeError` `[lite-loglogn] YFastTrie is full (capacity C); delete a key first -- capacity is fixed at construction`; the set is unchanged.
- **A split or borrow whose inner add stalls** (hash flood, ADR 0007) throws the inner XFastTrie `RangeError` (its text, not "YFastTrie") with the set UNCHANGED. So `add` AND `delete` (a delete may borrow) can throw on a valid key.
- **Poison.** If the inner rollback itself fails, an `Error` is thrown and the YFastTrie is POISONED with its inner trie: every hot method throws `TypeError` on a valid key (`min` / `max` always) until `clear()`, which revives both.
- **Bad keys** mirror XFastTrie exactly: `has` / `delete` return `false`, `successor` / `predecessor` return `undefined`, `add` throws; no column is read or written.

**Seed.** `new YFastTrie(universe, capacity, seed?)`: omitted, `undefined` or 0 = the default level seeds bit for bit; otherwise a uint32 integer or `RangeError` `[lite-loglogn] YFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ...`. The seed is forwarded to the inner trie and only moves its hash layout (whether an inner add stalls depends on that layout); the buckets use no hash, and a successful answer never depends on the seed. `clear()` restores the CONSTRUCTED state, the caller's seed included.

**Timing.** YFastTrie timing is REPORTED only; see [Measured](#measured-reported).

</details>

## Deep dive: the vEBTree

<details>
<summary>Layout, depth, the trimmed root, SPACE, and the loss row</summary>

A van Emde Boas tree answers `has`, `add`, `delete`, `successor` and `predecessor` by recursing into ONE half-width subtree per level, so the depth is O(log w) = O(log log U) and every operation has a worst-case bound: no hashing, no reseed, no amortized split. Here (ADR 0009, `decisions/0009-veb-flattening.md`) the recursion is flattened: ONE `Uint32Array` (`_t`) holds the whole tree, the offset of every child is computed from a precomputed size table (`_g`, an `Int32Array(33)`), never stored, and the hot methods are seven self-contained loops (no recursion, no helper call, no closure). The recursion survives only in the test-only reference (`test/helpers/vebRef.mjs`) and in cold sizing code.

**Layout.** A node of width w (its keys have w bits):

- **Leaf, w <= 8.** A plain bitmap of ceil(2^w / 32) words (w <= 5: one word; w = 6 / 7 / 8: 2 / 4 / 8 words), key k = bit `k & 31` of word `k >>> 5`. No header, no summary.
- **Internal, w >= 9.** lo = (w > 24 ? 16 : 8), hi = w - lo. A two-word header `[min, max]`, then the summary (a node of width hi; a summary of width <= 8 is a leaf), then 2^hi clusters of width lo. Size in words: S(w) = 2 + S(hi) + 2^hi * S(lo), so a cluster is 8 words (lo = 8) or 2,058 words (lo = 16).
- **`min` is NOT stored in its cluster.** The header holds the node's smallest key outright and the cluster holds only the rest, so an `add` into an empty cluster is a single header write (then only the summary is entered) and a `delete` of a one-key node is a single header reset: one path per update, never two recursive calls.
- **EMPTY** is min > max, stored as `[0xFFFFFFFF, 0]`. Header keys are node-relative; only the ROOT header holds full 32-bit keys, and header slots are compared as uint32.
- **Depth** is ceil(log2(w / 8)): 0 for w <= 8, 1 for w = 9 .. 16, 2 for w = 17 .. 32 (depth <= 2 for every w <= 32, so the O(log log U) bound stands).
- **Trimmed root.** Only the root's cluster count is trimmed to ceil(U / 2^lo): U = 2^24 + 1 costs 2,115,708 B, not about 4.2 MB. Nothing changes at U = 2^w.

**SPACE (DETERMINISTIC; formula and the engine agree, gated in `test/VEBTree.test.js` and `test/DocSync.test.js`).** `byteLength = 4 x words` of `_t` (`_g`, `_p` and the object are not counted), the whole universe allocated up front whatever the keys present. SB = StratifiedBitset bytes at the same U (engine byteLength values), vEB / SB = the ratio:

| U | w | byteLength | StratifiedBitset (bytes) | vEB / SB |
| --- | --- | --- | --- | --- |
| 2 | 1 | 4 B | 4 | 1.000 |
| 257 | 9 | 76 B | 40 | 1.900 |
| 2^16 | 16 | 8,232 B | 8,460 | 0.973 |
| 2^20 | 20 | 131,604 B | 135,300 | 0.973 |
| 2^24 | 24 | 2,105,392 B | 2,164,804 | 0.973 |
| 2^24 + 1 | 25 | 2,115,708 B (trimmed root) | 2,164,820 | 0.977 |
| 2^28 | 28 | 33,718,804 B | 34,636,836 | 0.973 |
| 2^32 | 32 | 539,500,592 B (about 540 MB) | 554,189,332 | 0.973 |

Read it honestly: vEBTree is NOT a space win. It costs about 0.97 of StratifiedBitset's bytes for w = 13 .. 32 (exactly 1.000 at w = 11, 0.985 at w = 12), and a little MORE below that: at U = 2^9 and U = 2^10 it is 1.118 and 1.061 of StratifiedBitset (the leaf cutoff is a uniform 8, ADR 0009), and U = 257 (w = 9, two root clusters) is 1.9. The space is O(U), the same order as StratifiedBitset's O(U/w) times a constant; the structure is for its WORST-CASE operation bound, and for a sparse key set in a large universe the answer is `YFastTrie` (O(n) space, amortized restructuring).

**The expected loss row, published up front (ADR 0009).** vEBTree is expected to LOSE to StratifiedBitset on work per operation wherever StratifiedBitset answers from one word: a vEB node must read its header first, and (min not being stored in its cluster) every `has` / `add` / `delete` starts at the root. Per-op word counts are NOT written in this README (ADR 0004 Amendment 1: counts are gated, exactly, in `test/VebCount.test.js`; prose never carries them). The verdicts, by word reads against StratifiedBitset on the same keys, each tied to the test that gates it:

| Operation (VebCount row) | vs StratifiedBitset | Gating test title (`test/VebCount.test.js`) |
| --- | --- | --- |
| `min` / `max` on `{5, U-1}` | WIN | `A3 exact rows, all 3 columns == vebCost, ...` and `A3 StratifiedBitset side via the Count.test.js harness, ...` at w = 16, 20, 24, 28 |
| out-of-range `successor` / `predecessor` (`successor(0)` on `{U-1}`, `predecessor(U-1)` on `{0}`), answered from the header | WIN (expected, ADR 0009) | vEB side only: `A3 exact rows, all 3 columns == vebCost, ...` at w = 16, 20, 24, 28; the StratifiedBitset side of this row is not measured |
| `successor(0)` on `{0, 65535}` (far gap, through the summary) | LOSE at U = 2^16 | `A3 vEB vs SB loss row, U=2^16 (...)` |
| `successor(5)` on `{0, 5, 6, 65535}` (same-word neighbour) | LOSE at U = 2^16 | `A3 vEB vs SB loss row, U=2^16 (...)` |
| `has(5)` on `{0, 5, 6, U-1}` | LOSE at U = 2^16 | `A3 vEB vs SB loss row, U=2^16 (...)` |

(The `(...)` in the last title stands for the gated counts that the title carries; they are deliberately not repeated here. Every other VebCount test, including the seeded op stream over 12 universes, gates each operation's count exactly, on all three columns `_t`, `_g` and `_p`, against a model that is independent of the engine.) What the member is for is the worst case: no hashing, no reseeds, no amortized splits, so a single operation has no restructuring tail. Timing is REPORTED only, per family and with ranges, in the `npm run witness:veb` block below; it gates nothing. The honest sentence is: StratifiedBitset reads fewer words outside min / max and header-decided successor / predecessor; vEBTree is the textbook O(log log U) member.

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
| `new XFastTrie(universe, capacity, seed?)` | instance | `universe` an integer in [2, 2^32] and `capacity` an integer in [1, min(universe, 2^24)], else `RangeError` (`[lite-loglogn] XFastTrie universe must be an integer in [2, 2^32]; got ...` / `... capacity must be an integer in [1, ...] (min(universe, 2^24)); got ...`). Optional `seed`: a uint32 integer in [0, 2^32-1]; omitted, `undefined` or 0 = the default level seeds bit for bit, else `RangeError` (`[lite-loglogn] XFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ...`), validated after universe and capacity. Fixed universe and capacity, no resize. Allocates every column. |
| `has(x)` | `boolean` | Bad key -> `false`. |
| `add(x)` | `this` | Idempotent. Bad key -> `RangeError`; a NEW key at `size === capacity` -> `RangeError` (`[lite-loglogn] XFastTrie is full (capacity C); delete a key first -- capacity is fixed at construction`), no state touched. After 32 failed reseed tries the add is rolled back and throws a `RangeError`. |
| `delete(x)` | `boolean` | `true` if `x` was present. Bad key -> `false`. |
| `successor(x)` | `number \| undefined` | Smallest key > x (STRICT). Bad key -> `undefined`. |
| `predecessor(x)` | `number \| undefined` | Largest key < x (STRICT). Bad key -> `undefined`. |
| `min()` / `max()` | `number \| undefined` | `undefined` when empty. 0 touches. |
| `clear()` | `void` | Cold. Removes every key, restores the constructed seeds (the defaults, or those derived from the caller's seed, even after an in-place reseed), and REVIVES a poisoned instance. |
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

### YFastTrie

| Signature | Returns | Notes |
| --- | --- | --- |
| `new YFastTrie(universe, capacity, seed?)` | instance | `universe` an integer in [2, 2^32] and `capacity` an integer in [1, min(universe, 2^24)], else `RangeError` (`[lite-loglogn] YFastTrie universe must be an integer in [2, 2^32]; got ...` / `... capacity must be an integer in [1, ...] (min(universe, 2^24)); got ...`). Optional `seed`: a uint32 integer; omitted, `undefined` or 0 = the default level seeds, else `RangeError` (`[lite-loglogn] YFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ...`). Fixed universe and capacity, no resize. Allocates every column (and the inner XFastTrie) once. |
| `has(x)` | `boolean` | Bad key -> `false`. |
| `add(x)` | `this` | Idempotent. Bad key -> `RangeError`; a NEW key at `size === capacity` -> `RangeError` (`[lite-loglogn] YFastTrie is full (capacity C); delete a key first -- capacity is fixed at construction`); a split whose inner add stalls -> the inner `RangeError`. Each with no state changed. After a failed inner rollback: `Error`, POISONED until `clear()`. |
| `delete(x)` | `boolean` | `true` if `x` was present. Bad key -> `false`. A delete that borrows can throw the inner `RangeError` (set unchanged), or the poison `Error`. |
| `successor(x)` | `number \| undefined` | Smallest key > x (STRICT). Bad key -> `undefined`. |
| `predecessor(x)` | `number \| undefined` | Largest key < x (STRICT). Bad key -> `undefined`. |
| `min()` / `max()` | `number \| undefined` | `undefined` when empty. |
| `clear()` | `void` | Cold. Removes every key, restores the constructed state (rep 0 re-added, the inner trie's constructed seeds, the caller's seed included), and REVIVES a poisoned instance. |
| `dump()` | `YFastTrieDump` | Cold, ALLOCATES. `{ universe, capacity, size, bits, keys: Uint32Array (ascending), reps: Uint32Array (ascending; reps[0] is always 0), sizes: Uint8Array }`; `sizes[i]` = the keys in the bucket of `reps[i]`, i.e. in [reps[i], reps[i+1]). |

The same method surface as XFastTrie (no new method). Getters (cold): `size`, `universe`, `capacity`, `bits` (w = ceil(log2 U)), `byteLength` (`4 (Cr+1) K + (Cr+1) + 16 +` the inner trie's `byteLength`, every typed array owned).

Limits and failure modes:

| Limit | Value |
| --- | --- |
| Universe U | integer, 2 .. 2^32 |
| Capacity C | integer, 1 .. min(U, 2^24) |
| Add of a new key when full | `RangeError`, no state change |
| Split / borrow whose inner add cannot place after 32 reseed tries | the inner `RangeError`, the set is unchanged (`add` and `delete` can both throw) |
| Inner rollback that cannot re-place a level | POISONED: `Error` thrown, then every hot method throws `TypeError` on a valid key (`min` / `max` always) until `clear()`; a bad key is still rejected first |
| Bad key | not a number, non-integer, NaN, negative, >= U, null, string, Symbol, BigInt, boxed Number: touches nothing; `-0` aliases key 0 |

The split / merge / borrow counters live in the instance (cumulative; `clear()` keeps them; Int32, wrap at 2^31) and are REPORTED diagnostics the engine never reads; they are not part of the typed surface. The inner trie keeps its own kick / reseed counters.

### vEBTree

| Signature | Returns | Notes |
| --- | --- | --- |
| `new vEBTree(universe)` | instance | `universe` an integer in [2, 2^32], else `RangeError` (`[lite-loglogn] vEBTree universe must be an integer in [2, 2^32]; got ...`). Fixed universe, no resize, no capacity, no seed. Allocates the whole tree once (O(U) bytes, table below). |
| `has(x)` | `boolean` | Bad key -> `false`. |
| `add(x)` | `this` | Idempotent. Bad key -> `RangeError` (`[lite-loglogn] key must be an integer in [0, U); got ...`), no state touched. |
| `delete(x)` | `boolean` | `true` if `x` was present. Bad key -> `false`. |
| `successor(x)` | `number \| undefined` | Smallest key > x (STRICT). Bad key -> `undefined`. |
| `predecessor(x)` | `number \| undefined` | Largest key < x (STRICT). Bad key -> `undefined`. |
| `min()` / `max()` | `number \| undefined` | `undefined` when empty. O(1). |
| `clear()` | `void` | Cold. Empties the set and rewrites the constructed (EMPTY-header) layout in place. |

Worst-case O(log log U) for `has` / `add` / `delete` / `successor` / `predecessor`, O(1) for `min` / `max`; no hashing, no reseed, no amortized step. No `dump()`, no `capacity`, no `seed`, no `forEach` and no iterator: iteration is the `successor` walk (see the quick-start). Getters (cold): `size`, `universe`, `bits` (w = ceil(log2 U)), `byteLength` (4 x the words of the one `_t` Uint32Array; `_g`, `_p` and the object are not counted). All four are read-only. A returned key >= 2^31 (>= 2^30 on a pointer-compressed engine) may box as a HeapNumber when the call is not inlined (the boxing note below).

Limits and failure modes:

| Limit | Value |
| --- | --- |
| Universe U | integer, 2 .. 2^32 (a non-integer, NaN, a string, a value below 2 or above 2^32 is a `RangeError`) |
| Capacity | none: every key in [0, U) fits, nothing is ever full |
| Memory | O(U), allocated by the constructor; `byteLength` below (539,500,592 B at U = 2^32) |
| Bad key | not a number, non-integer, NaN, negative, >= U, null, string, Symbol, BigInt, boxed Number: touches nothing (`has` / `delete` -> `false`, `successor` / `predecessor` -> `undefined`, `add` -> `RangeError`); `-0` aliases key 0 |

`byteLength` (exact; the root's cluster count is trimmed to ceil(U / 2^lo), ADR 0009 L1):

| U | w | byteLength |
| --- | --- | --- |
| 2 | 1 | 4 B |
| 257 | 9 | 76 B |
| 2^16 | 16 | 8,232 B |
| 2^20 | 20 | 131,604 B |
| 2^24 | 24 | 2,105,392 B |
| 2^24 + 1 | 25 | 2,115,708 B (trimmed root) |
| 2^28 | 28 | 33,718,804 B |
| 2^32 | 32 | 539,500,592 B (about 540 MB) |

For a sparse key set in a large universe use `YFastTrie` (O(n) space) instead.

## The roster

One member per release, each landing append-only (StratifiedBitset stays byte-identical, pinned by Parity; XFastTrie stays behavior-identical with the seed omitted). StratifiedBitset (0.2.0), XFastTrie (0.3.0), YFastTrie (0.4.0) and vEBTree (0.5.0) are published.

| Member | Slot | Time (query) | Space | Shape |
| --- | --- | --- | --- | --- |
| **StratifiedBitset** | 0.2.0 (shipped) | O(log_32 U) successor / predecessor; min / max read Lc words (Lc = levels <= 7) | O(U/w) | array-embedded hierarchical bit tree |
| **XFastTrie** | 0.3.0 (shipped) | O(log log U) query (1 + log2(w) touches when absent); updates O(w) | O(n*w), preallocated at a fixed capacity | binary search over w pointer-free cuckoo LevelTables + a sorted leaf thread |
| **YFastTrie** | 0.4.0 (shipped) | O(log log U) query; updates O(log log U) probes + at most 2w-1 word moves, split / merge / borrow amortized | O(n), preallocated at a fixed capacity | x-fast trie over ~n/w representatives + bounded sorted buckets in one pool |
| **vEBTree** | 0.5.0 (shipped) | O(log log U) worst-case for every operation; min / max O(1) | O(U), the whole universe allocated up front | flattened van Emde Boas in one `Uint32Array` |

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
| **XFastTrie** `clear` | 0 B (cold; no new buffer; restores the constructed seeds); on a POISONED instance it allocates a fresh 16 B `_q`, counters 0 |
| `new XFastTrie(U, C, seed?)` | allocates every column once (`byteLength` above); nothing is ever replaced except `_q` (nulled by a poison, re-created by `clear()`) |
| **XFastTrie** `dump()` | allocates (the keys and one entry per level) |
| **YFastTrie** `has`, `add`, `delete`, `successor`, `predecessor`, `min`, `max` | 0 B (hot) for keys < 2^30, including bucket splits, merges and borrows (torture Y0-Y2; Y1b allocation-gates the borrow path since 0.4.1, and YftCount still count-gates it; no Y lane fires an inner reseed: that path is count-gated in YftCount, not allocation-gated; the inner trie's kicks and reseeds are XFastTrie's, 0 B in X2). A rep or returned key >= 2^31 on Node (>= 2^30 on Chrome / Electron) may box as a HeapNumber when the call is not inlined (the boxing note below); the torture straddle step with keys >= 2^31 runs on the TRANSIENT lane only |
| **YFastTrie** `clear` | 0 B (cold; no new buffer; restores the constructed state and re-adds rep 0); on a POISONED instance it allocates a fresh 16 B inner `_q`, counters 0 |
| `new YFastTrie(U, C, seed?)` | allocates every column once (`_bk`, `_bn`, `_n` and the inner XFastTrie; `byteLength` above); nothing is ever replaced except the inner `_q` |
| **YFastTrie** `dump()` | allocates (the keys, the reps and the bucket sizes) |
| **vEBTree** `has`, `add`, `delete`, `successor`, `predecessor`, `min`, `max` | 0 B (hot) for keys < 2^30, including delete's max refresh (torture V1-V5). A key >= 2^31 returned by `successor` / `predecessor` boxes a HeapNumber on V8 14.6 (Node v26.8.2): 16 B per call (torture control CV7); see the boxing note |
| **vEBTree** `clear` | 0 B (cold; no new buffer: `_t.fill(0)` and the EMPTY headers rewritten in place) |
| `new vEBTree(U)` | allocates `_t`, `_g` and `_p` once (`byteLength` counts `_t`); nothing is ever replaced |

**Boxing note.** A returned key >= 2^31 (>= 2^30 on a pointer-compressed engine) may box as a HeapNumber when the call is not inlined. A later StratifiedBitset fix adds three `| 0` reads (predecessor descend, max top, max descend) so a word with bit 31 set stays a Smi-range int32 instead of a HeapNumber. vEBTree: on V8 14.6 (Node v26.8.2) successor / predecessor are never inlined (traced 2026-11-03 in Maglev and TurboFan, default flags, untimed: their bytecode, 850 / 838 B, exceeds the 460 B TurboFan limit and the 100 B Maglev limit; every decision is "exceeds bytecode limit"), so a returned key >= 2^31 boxes a HeapNumber: 16 B per call (measured, torture control CV7: 1,048,584 B over 65,536 calls). This trace is scoped to that V8; other engines or versions are not claimed. The key 2^31 is STORED and queried at U = 2^31 + 1 with 0 B/op (torture V4: every argument and return stays below 2^30). YFastTrie adds one cold case: a representative >= 2^31 passed to the inner `add` / `delete` of a split, merge or borrow can box when that call is not inlined; the hot query and plain-update bodies stay 0 B on keys < 2^30.

DETERMINISTIC numbers (2026-10-22, Node v26.8.2, every run of the named script):

- `npm run torture` (`node --expose-gc test/torture.mjs`): T0 runs 2,000,000 ops at U = 2^20 -> retained 0 B/op, transient 0.000 B/op, gc major 0 / minor 0; T1-T2 ok; T3's five must-fail controls (retain, box, growing, retained, gcKick) each flip (QUIET release verify run 2026-10-23, Node v26.8.2, 1 run; a count gate, not timing).
- vEBTree torture lanes V1-V5 (QUIET verify run 2026-11-03, load1 1.63 vs baseline 2.21, 12 cores, Darwin arm64, Node v26.8.2 / V8 14.6.202.34; V1 / V2 / V5 gave identical values in 3 logged runs and V3 / V4 / CV5-CV7 in 2; count gates, not timing): V1 2,000,000 mixed ops (add / has / delete / successor / predecessor / min / max) at U = 2^16 -> alloc 0 B/op, transient 0.000 B/op (limit 1024 B / 65536 ops), gc major 0 / minor 0, maxPauseMs 0.00; V2a 1,000,000 ops at U = 2^28 (depth 2, byteLength 33,718,804) -> alloc 0 B/op, and V2b (Worker) 200,000 ops, abGrowth 0; V3 (Worker) U = 2^25 + 3, delete-heavy, 3,493,888 ops with 1,746,944 deletes each refreshing a max (refreshes == deletes) -> alloc 0 B/op, transient 0.000 B/op; V4 U = 2^31 + 1 (byteLength 269,762,648), the key 2^31 stored (max 2147483648), every argument and return < 2^30 -> transient 0.000 B/op over 16 valid windows; V5 leak census (4096 create / drop cycles at U = 1024, 4096/4096 collected, size 0/0, 0 findings); the veb GATE segment: leak 0/0, alloc 0 B/op, transient 0.000 B/op, abGrowth 0. The nine must-fail controls CV1-CV9 each flip (CV7 bigSucc: a successor returning a key >= 2^31, nsExcess 1,048,584 B over 65,536 calls = 16 B per call, a boxed HeapNumber; CV9 v3WorkerBox: one box every 8th op on V3's step inside the V3 Worker). V3's Worker, its warm baseline ceiling and CV9 landed after that verify run: torture x3 on 2026-11-03, PRELIMINARY host, count gates, V3 alloc 0 B/op each time, 29 of 29 controls flip.
- XFastTrie torture lanes X0-X4 (QUIET verify run 2026-10-22, load1 1.32 vs baseline 2.21, 12 cores, Node v26.8.2, 1 run; the same counts hold on every run): X0a 2,000,000 ops at U = 2^20, C = 8192 and X0b 2,000,000 ops at U = 2^30, C = 8192 -> alloc 0 B/op, transient 0.000 B/op, gc major 0 / minor 0; X1 200,000 ops at U = 2^32, C = 8192 (byteLength 4,571,692, abGrowth 0, key 4294967295 returned); X2 reseed churn at U = 65536, C = 16, 50,000 cycles each: natural (kicks +2,000,000, reseedOps +50,000, tries +50,000) and forced (kicks +2,000,000, reseedOps +50,000, rebuilds +200,000) -> 0 B/op, abGrowth 0; X3 leak census (4096 create / drop cycles, 4096/4096 collected, 0 findings); X4's six must-fail controls (retain, box, a reallocating reseed, a dropped per-reseed snapshot, a retained set, xGcKick) each flip (QUIET release verify run 2026-10-23, Node v26.8.2, 1 run; a count gate, not timing).
- YFastTrie torture lanes Y0-Y4 (verify run 2026-10-25, Node v26.8.2, 1 run; load1 6.58 vs baseline 2.21 at its start, so a PRELIMINARY host, but these are COUNT gates and do not depend on it): Y0a 2,000,000 ops at U = 2^20, C = 8192 and Y0b 2,000,000 ops at U = 2^30, C = 8192 -> alloc 0 B/op, transient 0.000 B/op, gc major 0 / minor 0 (with splits and merges firing inside the windows); Y1 split / merge storm at U = 65536, C = 664, 5,000 cycles (splits +200,000, merges +200,000, borrows +0) -> 0 B/op, abGrowth 0, and its transient twin Y1c (64 cycles per window, nsExcess 0); Y2 200,000 ops at U = 2^32, C = 8192 (byteLength 471,895, abGrowth 0, key 4294967295 returned) plus a straddle step with 32 keys >= 2^31 in the buckets, transient 0.000 B/op; Y3 leak census (4096 create / drop cycles, 4096/4096 collected, 0 findings); Y4's seven must-fail controls (retain, box, a reallocating split, a dropped per-split snapshot, a retained set, yGcKick, flatKeys) each flip (a count gate, not timing). Since 0.4.1 Y1b also allocation-gates borrows (torture, 2 runs, 2026-11-01, Node v26.8.2, load1 4.0-4.6 with other node processes busy, so a PRELIMINARY host, but these are COUNT gates): at U = 2^16 (w = 16, K = 32, h = 8), C = 43, one cycle is 43 adds + 43 deletes + clear() with a census of 1 split / 1 merge / 1 borrow per cycle -> `alloc=0 B/op over 5000 cycles (splits+5000 merges+5000 borrows+5000) window 1000 cycles splits+1000 merges+1000 borrows+1000 (census 1/1/1 per cycle) abGrowth=0 settled=true transient nsExcess=0 B / 256 cycles (limit 1024) ... badWindows=0 | ok`; Y4 gains two must-fail controls, CY8 AllocBorrow (56 B/op, flips the Y1b allocation gate) and CY9 noRefill (borrows +0, flips the borrows floor), so Y4 runs nine; Y0's split / merge coverage floor is checked per measureAllocs batch: every one of the 8 batches must contain at least 1 split AND at least 1 merge (the gated floor is 1 / 1, not the observed minimum); the cold replay of 2026-11-01 saw a minimum per batch of 12 / 12 at U = 2^20 and 3 / 3 at U = 2^30, an observation that gates nothing. No Y lane fires an inner reseed (XFastTrie's X2 covers kicks and reseeds). The torture lanes run 5 (T3) + 6 (X4) + 9 (Y4) + 9 (CV) = 29 must-fail controls in all (18 in 0.4.0, with Y4 at seven).
- `npm run test:perf` also runs `test/perf/VEBTreePerf.test.mjs` (21 tests; allocation COUNTS only, never a timing threshold): 10 zero-alloc scenarios, every key, query and return below 2^30 (at U = 2^20: has, add+delete, successor, predecessor, min, max, successor-walk; at U = 2^16: add+delete; at U = 2^25 + 3: delete-heavy max-refresh churn where every delete removes the max; at U = 2^28: successor), and 3 must-fail teeth (a fresh-array loop must flip the scavenge lane only; GrowingVeb, whose `add` reallocates `_t`, must flip the grows counter and the arrayBuffers lane; SideBufferVeb, whose `add` grows ArrayBuffer memory off the tree, must flip the arrayBuffers lane only), each with an attribution test, plus a flag pin and its control and a coverage floor. The first test fails when vEBTree is not exported. PerfGate 15 + XFastTriePerf 17 + YFastTriePerf 19 + VEBTreePerf 21 = 72 tests in `npm run test:perf`.
- `npm run test:perf` also runs `test/perf/YFastTriePerf.test.mjs`: 9 zero-alloc scenarios (has, add+delete, split / merge churn, successor, predecessor, min, max, successor-walk at U = 2^20, successor at U = 2^32 (keys < 2^30)), each measured at N and k*N, the churn splitting and merging in both windows, and 3 must-fail teeth (a fresh-array loop must flip the scavenge lane only; GrowingYft, whose `_split` reallocates the `_bk` pool, must flip the grows counter and the arrayBuffers lane; SideBufferYft, whose `_split` grows ArrayBuffer memory off the columns, must flip the arrayBuffers lane only) = flag pin (2) + detector (1) + 9 scenarios + 3 teeth + attribution (3: the scavenge-only and arrayBuffers-only pins plus the GrowingYft grows + arrayBuffers pin) + coverage floor (1) = 19 tests; PerfGate 15 + XFastTriePerf 17 + YFastTriePerf 19 = 51/51 pass in the 2026-10-25 verify run (load1 6.58 at its start, PRELIMINARY host; these are allocation-count gates, Node v26.8.2, 1 run).
- `npm run test:perf` also runs `test/perf/XFastTriePerf.test.mjs`: 8 zero-alloc scenarios (has, add+delete, successor, predecessor, min, max, successor-walk at U = 2^20, successor at U = 2^32 (keys < 2^30)), and 3 must-fail teeth (a fresh-array loop, GrowingXft, SideBufferXft) = flag pin (2) + detector (1) + 8 scenarios + 3 teeth + attribution (1) + dual-lane (1) + coverage floor (1) = 17 tests; with PerfGate's 15, the 0.3.0 release verify run gave 32/32 pass (2026-10-23, quiet-lock QUIET, load1 2.84 at start vs baseline 2.21, Node v26.8.2, 1 run).
- `npm run test:perf` (`@zakkster/lite-perf-gate`), StratifiedBitset file `test/perf/PerfGate.test.mjs`: 7 zero-alloc scenarios (has, add+delete, successor, predecessor, min, max, successor-walk at U = 2^20) + 3 must-fail teeth + flag pin (2) + detector (1) + arrayBuffers attribution (1) + GATE key-set pin (1) = 15/15.

</details>

## Measured (reported)

The BOUND above is proven by the DETERMINISTIC counts. The numbers below are timing evidence on ONE host, not a law, and not in `npm run verify` (D8). There is no CI for this package: every timing claim is REPORTED only (a measurement with provenance that gates nothing), not a gated STATISTICAL claim.

Provenance for every row: 2026-10-22, MacBook-Pro (Apple M4 Pro, 12 cores), Node v26.8.2 / V8 14.6.202.34, darwin/arm64, shared host under quiet-lock, 1 run each.

### REPORTED: `npm run witness`, one run

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

### REPORTED: `npm run witness:tier`, the level-0 peel

FULL run 2026-10-22T02:27:20Z, load1 4.79 (5-min 5.72), wall 0.39 s: EXIT 2 (PENDING, inconclusive). B = the live peel; A = the previous body (rev 00ba7e1) plus the same three `| 0` reads. ns/op medians:

| Scenario | B (peel) | A | Wins B/A | Verdict |
| --- | --- | --- | --- | --- |
| dense-succ (U 2^16, n 32768) | 3.63 | 4.10 | 15/0 | win (B 11.5% faster) |
| sparse-succ (U 2^20, n 4096) | 7.59 | 7.81 | 12/3 | none |
| dense-pred | 3.19 | 3.82 | 14/1 | win (B 16.5% faster) |
| sparse-pred | 6.70 | 6.68 | 8/7 | none |

No scenario lost. Control A x2 vs A: 0/15 ok. Drift quiet over 105 rounds. The exit 2 came from the dense-succ A/A (B vs its byte-identical twin): 1/14 at 3.64 vs 3.60, about a 1% difference on identical code, which K = 15 / need 13 resolves as a "winner". Sparse A/A 5/10 ok.

**Waiver, stated honestly:** the tier gate itself returned inconclusive; the peel ships by maintainer waiver (2026-10-22), on effect size (11.5% / 16.5% dense wins, about 10x the 1% A/A difference) and because no scenario lost. The follow-up is decided (ADR 0006 amendment): the XFastTrie A/B lane uses a 2% minimum-effect floor (`AB_EFFECT_FLOOR` in `test/helpers/abVerdict.mjs`); `tierVerdict` itself is unchanged.

### REPORTED: `npm run witness:xft` (XFastTrie), release run

The XFastTrie lane (`node test/witness.mjs --xft`; `--smoke` is a counts-only smoke) runs a U-sweep, an n-sweep, an update fit and latency, A/B-timing XFastTrie `successor` against StratifiedBitset (abVerdict: 2% effect floor on every "win" and A/A flag) and, as a REPORTED point verdict with no floor, against a local `Uint32Array` binary search (exit 0 pass / 1 fail / 2 inconclusive). Its timing numbers are REPORTED from one release run (below) and are not in `npm test`; the smoke gate (`test/XftWitness.test.js`) asserts counts and strings, never a timing value. Before round 1 the untimed probe tier-up runs in a GC window (gc.major 0, arrayBuffers growth 0 B, both zero tolerance); a violation prints FAIL and exits 1, also in smoke.

<!-- XFT-WITNESS-BEGIN -->
**One run, a measurement, not a law (REPORTED).** 2026-10-23 (log ISO 2026-10-22T23:27:09Z), Apple M4 Pro, 12 cores, Node v26.8.2 (V8 14.6.202.34-node.28), darwin/arm64, quiet-lock QUIET (load1 2.72 at start, 2.77 at end, baseline 2.21), 1 run, K 15, need 13, floor 0.02, 65536 queries per block, HEAD c930000, LogLogN.js sha256 ee895d54, wall 28.66 s, exit 0 (decision PASS). No CI runs this lane; ns/op medians, ratio = XFastTrie / comparator, so a ratio above 1 means XFastTrie is slower.

**What PASS means here.** XFastTrie LOSES every successor A/B scenario against StratifiedBitset (all 11 verdicts are `lose`, 0 wins / 15 losses of K 15 each). `decision PASS` (exit 0) does not say XFastTrie is faster. It says the run was valid: load1 at most 0.5 x cores, no drift, no A/A winner above the floor, and the double-work control lost as it must (so the verdict can fail). Per-scenario win/lose verdicts do not set the exit code.

n-sweep at w 28 (successor; "vs SB" is the A/B scenario, "vs u32" a REPORTED point verdict against a local `Uint32Array` binary search, its ratio being the XFastTrie median of the interleaved u32 pair over the u32 median, also `lose` 0 / 15 / 0 at every n):

| n | XFastTrie | StratifiedBitset | ratio vs SB | XFastTrie (u32 pair) | u32 binary search | ratio vs u32 |
| --- | --- | --- | --- | --- | --- | --- |
| 1000 | 102.25 | 23.63 | 4.3264 | 101.57 | 30.89 | 3.2882 |
| 3000 | 106.47 | 22.46 | 4.7413 | 105.98 | 37.64 | 2.8154 |
| 10000 | 119.52 | 21.25 | 5.6230 | 118.79 | 44.54 | 2.6674 |
| 30000 | 130.97 | 21.29 | 6.1506 | 122.62 | 51.19 | 2.3955 |
| 100000 | 156.37 | 21.24 | 7.3631 | 157.42 | 65.32 | 2.4099 |
| 300000 | 264.49 | 21.63 | 12.2259 | 251.53 | 78.31 | 3.2120 |
| 1000000 | 397.08 | 16.89 | 23.5067 | 400.47 | 93.94 | 4.2630 |

U-sweep at n 4096 (XFastTrie vs StratifiedBitset; every cell 0 / 15 / 0, `lose`):

| w | successor XFastTrie | successor SB | successor ratio | add+delete XFastTrie | add+delete SB | add+delete ratio |
| --- | --- | --- | --- | --- | --- | --- |
| 16 | 87.16 | 5.30 | 16.4483 | 326.63 | 3.32 | 98.2686 |
| 20 | 100.18 | 5.58 | 17.9664 | 462.00 | 4.42 | 104.5031 |
| 24 | 110.41 | 8.20 | 13.4708 | 597.84 | 7.41 | 80.7244 |
| 28 | 113.88 | 20.78 | 5.4801 | 709.44 | 19.38 | 36.6041 |

Fits (REPORTED timing; the O(w) update bound itself is proven by the exact touch counts in `test/XftCount.test.js`, DETERMINISTIC): successor vs log2(w) slope 34.08 ns/doubling, R^2 0.9755; successor vs w slope 2.2596 ns/bit, R^2 0.9454; add+delete vs w slope 32.1067 ns/bit, R^2 0.9979; add+delete vs log2(w) slope 476.58 ns/doubling, R^2 0.9976.

Controls: the A/B control (XFastTrie x2, double work, vs XFastTrie, n 4096 w 20) ratio 2.0050, 0 / 15 / 0, must lose and did. A/A (n 4096 w 20): successor 7 / 8 / 0 ratio 0.9947, add+delete 9 / 6 / 0 ratio 0.9912 (no winner above the floor). Drift: false over 375 probe rounds. COVERAGE: n-sweep 7 points, U-sweep 4 widths, ABBA runs 25 / 25, probe rounds 375, latency runs 22 / 22, A/B scenarios 11, pre-pass queries 1667825, gc window blocks 16 / 16.
<!-- XFT-WITNESS-END -->

### REPORTED: `npm run witness:yft` (YFastTrie), release run

The YFastTrie lane (`node test/witness.mjs --yft`) runs an n-sweep at w = 28 and a U-sweep at n 4096 A/B-timing YFastTrie `successor` against XFastTrie (abVerdict: 2% effect floor on every "win" and A/A flag; the only A/B pair), and REPORTS (no verdict) the add+delete lane, the foils (lite-logn SortedArray and Scapegoat, lite-o1 EliasFano and BitSet, a local `Uint32Array` binary search), per-op latency, and a TAIL run per width. `--yft --smoke` is a counts-only smoke gated by `test/YftWitness.test.js` in `npm test` (counts and strings only; five must-fail fakes, `test/fakes/yftw-*`: empty, exit 1, garbage, kill, NaN). The timed lane is not in `npm test`, and its exit code (0 pass / 1 fail / 2 inconclusive) is never a release gate. Before round 1 the untimed probe tier-up runs in a GC window (gc.major 0, arrayBuffers growth 0 B, zero tolerance).

**The tail.** For each w in 16, 20, 24, 28 the lane fills M = 4096 keys and drains them (8192 ops; keys from a fixed tail seed, 0x7A170000 + w), replays them once untimed in a GC window, then times every op on a second instance. The MAX single-op time is PRINTED with its attribution (kind: reseed > split > merge, which includes a borrow > plain) and is REPORTED only: NO timing verdict. The stated bound is the count-gated WORK bound (`test/YftCount.test.js`, DETERMINISTIC): a split / merge / borrow moves at most 2w words and an inner reseed makes at most 32 tries.

<!-- YFT-WITNESS-BEGIN -->
**One run, a measurement, not a law (REPORTED).** 2026-10-25, Apple M4 Pro, 12 cores, Node v26.8.2 (V8 14.6.202.34-node.28), darwin/arm64, quiet-lock QUIET (load1 2.63 at start, 2.98 at end, baseline 2.21), 1 run, K 15, need 13, floor 0.02, 65536 queries per block, HEAD 568cd25, LogLogN.js sha256 7ecfe459, wall 38.46 s, exit 0 (decision PASS). No CI runs this lane; ns/op medians, ratio = YFastTrie / comparator, so a ratio below 1 means YFastTrie is faster. The clock granularity is 41.00 ns (zero deltas 6.40% of 131072 pairs), so differences of a few ns/op are inside it.

n-sweep at w 28 (successor; "vs XFT" is the A/B scenario, wins / losses / ties of K 15; byteLength is the instance's, C = n + 1):

| n | YFastTrie | XFastTrie | ratio vs XFT | wins / losses / ties | byteLength YFT / XFT | YFT B per key |
| --- | --- | --- | --- | --- | --- | --- |
| 1000 | 94.48 | 103.21 | 0.9154 | 15 / 0 / 0 | 57,970 / 544,984 (0.1064) | 57.97 |
| 3000 | 107.02 | 109.96 | 0.9732 | 12 / 3 / 0 | 128,469 / 1,048,216 (0.1226) | 42.82 |
| 10000 | 112.20 | 122.05 | 0.9193 | 14 / 1 / 0 | 449,977 / 3,741,368 (0.1203) | 45.00 |
| 30000 | 125.93 | 128.07 | 0.9833 | 12 / 3 / 0 | 1,520,573 / 13,140,024 (0.1157) | 50.69 |
| 100000 | 147.27 | 160.88 | 0.9154 | 15 / 0 / 0 | 3,610,789 / 25,055,608 (0.1441) | 36.11 |
| 300000 | 166.11 | 275.94 | 0.6020 | 15 / 0 / 0 | 11,895,387 / 85,389,432 (0.1393) | 39.65 |
| 1000000 | 207.34 | 400.45 | 0.5178 | 15 / 0 / 0 | 40,784,747 / 284,630,264 (0.1433) | 40.78 |

For n above 1,000,000 XFastTrie is not built; the REPORTED comparator is a local `Uint32Array` binary search: n = 3,000,000 YFastTrie 336.45 vs 110.80 (ratio 3.0364, 0 / 15 / 0), n = 10,000,000 YFastTrie 499.93 vs 174.63 (ratio 2.8628, 0 / 15 / 0); byteLength YFastTrie 95,089,088 B and 319,233,120 B (31.70 and 31.92 B per key). YFastTrie is SLOWER than that binary search at every n: the foil successor medians at n = 1000 .. 10,000,000 are `Uint32Array` 28.50 .. 156.97, SortedArray 37.46 .. 226.93, EliasFano 99.70 .. 158.17 ns/op (Scapegoat 40.60 .. 214.40 up to n = 1,000,000; BitSet n/a, U > 2^25).

U-sweep at n 4096 (YFastTrie vs XFastTrie; successor A/B, add+delete REPORTED):

| w | successor YFT | successor XFT | successor ratio | wins / losses / ties | add+delete YFT | add+delete XFT | add+delete ratio | byteLength YFT / XFT |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | 94.73 | 90.70 | 1.0444 | 0 / 15 / 0 | 230.73 | 331.84 | 0.6953 | 192,727 / 688,440 |
| 20 | 99.72 | 107.57 | 0.9270 | 15 / 0 / 0 | 241.52 | 457.96 | 0.5274 | 164,828 / 1,114,488 |
| 24 | 104.82 | 118.65 | 0.8834 | 15 / 0 / 0 | 252.73 | 585.56 | 0.4316 | 190,760 / 1,540,536 |
| 28 | 105.29 | 119.61 | 0.8803 | 15 / 0 / 0 | 260.28 | 725.69 | 0.3587 | 216,843 / 1,966,584 |

Reading the successor cells: YFastTrie wins 5 of the 7 n-sweep A/B cells outright (K 15, need 13), 2 (n = 3000, 30000) are no verdict (12 / 3 / 0), and at w = 16 it LOSES (ratio 1.0444, 0 / 15 / 0, the worst A/B successor cell). The A/A twin (YFastTrie vs itself, n 4096, w 20) read ratio 1.0112 on successor (6 / 9 / 0) and 1.0108 on add+delete (2 / 13 / 0), so a ratio within about 0.989 .. 1.012 is the noise of identical code; the 0.9732 and 0.9833 cells sit just outside it and did not reach need 13. The double-work control (YFastTrie x2 vs YFastTrie, n 4096, w 20) read ratio 2.0061, 0 / 15 / 0, and lost as it must.

Fits (REPORTED timing; the work bounds themselves are proven by the exact counts in `test/YftCount.test.js`, DETERMINISTIC; four widths only, so the two axes are not separable at this resolution): successor vs log2(w) slope 13.91 ns/doubling, R^2 0.9497; successor vs w slope 0.9199 ns/bit, R^2 0.9158; add+delete vs log2(w) slope 37.14 ns/doubling, R^2 0.9977; add+delete vs w slope 2.4964 ns/bit, R^2 0.9932.

Tail MAX (one run, REPORTED, no timing verdict; M = 4096, fill + drain = 8192 timed ops per width; max/p50 from the printed bars):

| w | MAX ns | op # / phase | kind | per-kind max: plain / split / merge | p50 / p99 | max / p50 | splits / merges / borrows | inner kicks / reseeds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | 5,917 | #2971 / fill | plain | 5,917 / 2,000 / 2,208 | 165.69 / 539.24 | 35.7 | 181 / 181 / 1 | 0 / 0 |
| 20 | 52,542 | #6102 / drain | merge | 18,833 / 11,292 / 52,542 | 252.18 / 871.46 | 208.4 | 146 / 146 / 0 | 0 / 0 |
| 24 | 12,416 | #6417 / drain | plain | 12,416 / 1,542 / 12,208 | 210.64 / 837.29 | 58.9 | 115 / 115 / 2 | 0 / 0 |
| 28 | 9,416 | #1429 / fill | plain | 9,416 / 4,709 / 2,583 | 165.69 / 742.61 | 56.8 | 105 / 105 / 2 | 0 / 0 |

The worst row is w = 20: a 52,542 ns merge, 208 times the p50. Three of the four MAX rows are tagged `plain` (no restructure, no reseed fired in the op), so no restructure or reseed is attributed to them (their cause is not measured); the one restructuring MAX (w = 20, merge) is also the largest. No reseed fired in any tail run (inner reseeds 0), so that attribution class is empty here. Latency (lite-sketch DDSketch, alpha 0.01, 65536 samples per point): successor p50 125.22 .. 584.15 ns, p99 165.69 .. 1,002.43 ns, add p50 125.22 .. 584.15 ns, p99 210.64 .. 1,300.09 ns; the 125.22 ns floor is the timer's quantisation. The per-op MAX over all sweep points ran from 9,625 ns (add, n = 3000) to 934,541 ns (add, n = 3,000,000, kind plain) and 828,625 ns (successor, n = 1,000,000): single-op outliers, not an O(1)-per-op figure.

Coverage: n-sweep 9 points (A/B 7), U-sweep 4 widths, ABBA runs 20 / 20, probe rounds 300, latency runs 26 / 26, foil medians 53 / 53, tail runs 4 / 4, A/B scenarios 11, pre-pass queries 4,586,587, gc window blocks 16 / 16, gc tail windows 4 / 4, retention 4 / 4 tail cycles (8 instances tracked, 8 collected). Drift: false over 300 probe rounds.
<!-- YFT-WITNESS-END -->

### REPORTED: `npm run witness:veb` (vEBTree), four QUIET runs

The vEBTree lane (`node test/witness.mjs --veb`) A/B-times vEBTree `successor` / `predecessor` / `min` / `max` and `add` + `delete` against StratifiedBitset on the same keys in 38 scenarios in four families (abVerdict: 2% effect floor on every "win" and A/A flag; K 15 interleaved ABBA rounds, need 13), and REPORTS (no verdict) per-op latency, fits against log2(w) and w, and a MAX single-op tail of vEBTree against YFastTrie. The families: C7 (w 16 .. 24, random and leaf-far keys; informs a future per-leaf-summary member), PAR (w 28 and 32), SH1 (w 16, 24 and 32, band keys; informs a future S-H1 StratifiedBitset variant member) and PRED (w 16 and 32). `--veb --smoke` is a counts-only smoke gated by `test/VebWitness.test.js` in `npm test` (counts and strings only). The timed lane is not in `npm test`; its exit code (0 pass / 1 fail / 2 inconclusive) is never a release gate, and no CI runs it.

<!-- VEB-WITNESS-BEGIN -->
**Four runs, a measurement, not a law (REPORTED).** 2 runs at 2026-11-03T03:20Z (the build before G3-B5, exit 2 PENDING: the per-round drift detector tripped) and 2 runs at 04:25Z (the G3-B5 build, exit 0 PASS). The timed bodies are byte-identical across the two builds; G3-B5 changed only the drift feed. Apple M4 Pro (12 cores), each run `quiet-lock run --strict`, QUIET (load1 at admission 2.23 / 2.42 / 2.91 / 2.84 vs baseline 2.21), Node v26.8.2 (V8 14.6), 4 runs, K 15 ABBA rounds, need 13, floor 0.02 (`AB_EFFECT_FLOOR`), D-host none (never a release gate; no host-free law is claimed). Each ratio is vEBTree ns/op over StratifiedBitset ns/op on the same keys, so a ratio below 1 means vEBTree is faster; it is quoted as the min-max range over the 4 runs. WIN / LOSE is written only where all 4 printed abVerdict verdicts agree; otherwise the cell is "mixed across runs".

**Reading.** StratifiedBitset reads fewer words outside min / max and header-decided successor / predecessor; vEBTree is the textbook O(log log U) member. The bound itself is proven by exact counts (`test/VebCount.test.js`, DETERMINISTIC), not by this table. Of the 38 cells, 32 have four agreeing verdicts and 6 are mixed across runs.

| Family | Cells (n; workload) | Ratio, min-max of 4 runs | Verdict |
| --- | --- | --- | --- |
| C7 successor, w 16 | 3 (random n 64, random n 4096, leaf-far n 64) | 1.94 .. 3.36 | LOSE |
| C7 add+delete, w 16 | 3 (same) | 3.51 .. 5.26 | LOSE |
| C7 successor, w 20 | 3 (random n 64, random n 4096, leaf-far n 1024) | 2.63 .. 4.63 | LOSE |
| C7 add+delete, w 20 | 3 (same) | 5.00 .. 6.65 | LOSE |
| C7 successor, w 24 | 3 (random n 64, random n 4096, leaf-far n 4096) | 2.56 .. 5.05 | LOSE |
| C7 add+delete, w 24 | 3 (same) | 4.32 .. 6.77 | LOSE |
| PAR add+delete, w 28 | 1 (random n 4096) | 2.71 .. 4.15 | LOSE |
| PAR add+delete, w 32 | 1 (random n 4096) | 1.89 .. 2.88 | LOSE |
| PAR successor, w 28 | n 64 | 0.87 .. 1.69 | mixed across runs |
| PAR successor, w 28 | n 4096 | 0.96 .. 1.69 | mixed across runs |
| PAR successor, w 32 | n 64 | 0.84 .. 1.55 | mixed across runs |
| PAR successor, w 32 | n 4096 | 0.70 .. 1.09 | mixed across runs |
| PRED predecessor, w 16 | random n 4096 | 1.90 .. 1.95 | LOSE |
| PRED predecessor, w 32 | random n 4096 | 0.77 .. 1.19 | mixed across runs |
| SH1 min, w 16 | band n 4096 | 0.37 .. 0.47 | WIN |
| SH1 max, w 16 | band n 4096 | 0.40 .. 0.47 | WIN |
| SH1 successor past max, w 16 | band n 4096 | 0.95 .. 0.99 | mixed across runs |
| SH1 predecessor below min, w 16 | band n 4096 | 1.14 .. 1.21 | LOSE |
| SH1 min, w 24 | band n 4096 | 0.29 .. 0.36 | WIN |
| SH1 max, w 24 | band n 4096 | 0.30 .. 0.42 | WIN |
| SH1 successor past max, w 24 | band n 4096 | 0.60 .. 0.65 | WIN |
| SH1 predecessor below min, w 24 | band n 4096 | 0.72 .. 0.76 | WIN |
| SH1 min, w 32 | band n 4096 | 0.21 .. 0.22 | WIN |
| SH1 max, w 32 | band n 4096 | 0.22 .. 0.27 | WIN |
| SH1 successor past max, w 32 | band n 4096 | 0.26 .. 0.46 | WIN |
| SH1 predecessor below min, w 32 | band n 4096 | 0.40 .. 0.69 | WIN |

The cells in the table add up to 38 (18 C7, 6 PAR, 2 PRED, 12 SH1). Every add+delete cell is a LOSE in all 4 runs; the PAR successor cells at w 28 and 32, the w 32 PRED predecessor cell and the w 16 SH1 successor past max cell are the six whose printed verdict changed from run to run.

**MAX tail (REPORTED, NO timing verdict).** vEBTree against YFastTrie on the same keys (a fixed tail seed per width), M 4096, fill + drain, w 16 .. 28; the MAX single-op time is a noisy statistic and moves a lot between runs. Ranges over the 4 runs, ns:

| w | vEBTree max | vEBTree p50 | YFastTrie max | YFastTrie p50 |
| --- | --- | --- | --- | --- |
| 16 | 875 .. 14,542 | 82.28 | 100,625 .. 150,583 | 415.78 .. 459.51 |
| 20 | 792 .. 63,041 | 82.28 .. 125.22 | 13,958 .. 28,667 | 290.07 .. 415.78 |
| 24 | 1,792 .. 33,291 | 125.22 .. 252.18 | 24,791 .. 97,208 | 415.78 .. 459.51 |
| 28 | 583 .. 12,208 | 125.22 .. 252.18 | 16,250 .. 203,959 | 415.78 .. 713.49 |

Over all four widths: vEBTree max 583-63,041 ns; YFastTrie max 13,958-203,959 ns. The 82.28 .. 125.22 ns p50 values are at the timer's quantisation. No fit or latency number from this lane is quoted here.
<!-- VEB-WITNESS-END -->

### REPORTED: fits, foils and latency (from the witness log, gates nothing)

- **Fits.** Measured against the U-sweep: vs log2(w) slope 18.92 ns/doubling, R^2 0.6589; vs w slope 1.3407 ns/bit, R^2 0.7293. The w axis fits better, as expected for an O(log_32 U) member whose level count `ceil(w/5)` is linear in w (ADR 0004 Amendment 1). StratifiedBitset does NOT claim a log2(w) line; "log2(w) must win" belongs to the strict O(log log U) members, proven there by COUNTS. No R^2 floor or slope band is gated.
- **Foils at n = 1e7, w = 28 (ns/op):** lite-logn SortedArray 273.71, Treap 927.84, SkipList 1166.44; lite-o1 EliasFano 173.21; lite-o1 BitSet n/a (U > 2^25).
- **Against lite-o1 BitSet at n = 4096, w = 16..24:** BitSet 4.28-4.82 ns/op vs the member 4.87-7.61 ns/op. BitSet is faster where it applies.
- **Latency** (lite-sketch DDSketch, alpha 0.01, 65536 samples per point): p50 125.22 ns at every n -- the timer's quantisation, not the op cost (about 12-18 ns/op); p99 210.64-290.07 ns; max 6,792-49,000 ns (single-op outliers; scheduler / GC of the harness, not attributed).

## Design decisions worth knowing

- **D1: `-0` aliases key 0.** One key, one bit.
- **D5: iteration is the successor walk.** No `forEach`, no iterator.
- **D6: fixed universe, fail closed.** `add(x >= U)` throws, there is no resize; queries with a bad key return `false` / `undefined` and touch no word.
- **D9: strict successor / predecessor.** `successor(x)` is the smallest key > x, never >= x; use `has(x) ? x : successor(x)` for "at or after".
- **D10: the level-0 peel only.** A/B-gated (see the tier section above); a `_tier` dispatch and bulk ops were rejected.
- **Amendment 1 (ADR 0004): counts are the hard gate.** The bound is proven by exact word-read counts (D7, counting Proxy over the shipped `_bits`); timing fits are REPORTED, never gated.
- **D8: the witness is out of `verify`.** It is release-time, needs a quiet host, and has a HOST verdict (exit 2) that `verify` cannot express.
- **XFastTrie: fixed capacity, early-stop updates, poison-then-clear (ADR 0007).** `add` of a new key at `size === capacity` throws and writes nothing; the update walk stops at the shorter common prefix with the thread neighbours (`w - m` touches); a failed rollback poisons the instance until `clear()`; the cuckoo seeds are fixed, so adversarial keys can force kicks and reseeds (correctness holds, time suffers).
- **Plain x-fast, y-fast on top, not z-fast (ADR 0008).** Queries binary-search the prefix lengths over hash probes; the O(n)-space member is a y-fast trie (an x-fast trie over O(n/w) separator representatives plus bounded sorted buckets). A z-fast trie (fewer probes per update, more machinery) is decided against for now and stays future work.
- **YFastTrie: deterministic buckets, no RNG, claim worded exactly (ADR 0008).** Policy w = ceil(log2 U), K = 2w, h = ceil(w/2); split at K, merge or borrow at h; queries O(log log U); updates O(log log U) probes plus at most 2w - 1 contiguous word moves; split / merge / borrow amortized, never "expected". A split or borrow whose inner add stalls throws with the set unchanged.
- **vEBTree: flat, worst-case, published with its loss row (ADR 0009).** One `Uint32Array`, leaf cutoff w <= 8, a per-width split (lo = 8, or 16 above w = 24), a `[min, max]` header with min not stored in its cluster, a trimmed root; it is expected to LOSE to StratifiedBitset on work per operation wherever one word answers, and to WIN on `min` / `max`, and that verdict per operation is gated by `test/VebCount.test.js`, never written as counts in prose. Timing is REPORTED only (`npm run witness:veb`): StratifiedBitset reads fewer words outside min / max and header-decided successor / predecessor; vEBTree is the textbook O(log log U) member. Full record: [`decisions/0009-veb-flattening.md`](./decisions/0009-veb-flattening.md).
- **Optional seed on both tries (ADR 0007 Amendment 1, ADR 0008).** `new XFastTrie(U, C, seed?)` / `new YFastTrie(U, C, seed?)`: a uint32 integer, omitted / `undefined` / 0 = the defaults bit for bit, `clear()` restores the constructed state including the seed, never random by default.

See [`decisions/`](./decisions) for the full records.

## Testing

`node:test` only, zero runtime deps. `npm test`: 852 tests, 851 pass, 1 skipped (the opt-in DEEP small-scope run), 0 fail (DETERMINISTIC; 2026-11-03, Node v26.8.2). It covers, for StratifiedBitset, exact counts (Count), a seeded oracle fuzz (Oracle), sibling oracles (lite-o1 BitSet.nextSet for U <= 2^25, lite-o1 EliasFano.nextGEQ, lite-logn Scapegoat + SortedArray; 0 divergences, each with a must-fail control), FastBit32Cross, Space, TierParity, the witness / tier verdict functions on injected vectors, and the `QaAudit` block (VERSION trinity, frozen export surface, six-file pack, author spelling, ASCII, plus an XFastTrie coercion / boundary block). For XFastTrie: `XftVectors` (15 seeded streams replayed against a stored cut, cross-checked against StratifiedBitset, with a `>=` mutant control), `XftCount` (exact touches through a counting Proxy over all eight columns, with six must-fail mutant controls plus a hang control), `XFastTrie` / `XFastTrieBoundary` / `XFastTrieOracle` (behavior, boundary keys, seeded oracle fuzz), `XFastTrieSpace` (byteLength pins and the identity of every column), `XftBytecode` (every hot body <= 460 B), `Parity` (the StratifiedBitset region of the file is byte-pinned against 0.2.0), `AbVerdict` (the 2% effect floor), `XftWitness` (the `--xft --smoke` gate, counts and strings only), and `XftSeed` (the optional seed: validation, seed 0 == omitted, the `xft-seed.json` replay, `clear()` restoring the constructed seeds). For YFastTrie: `YftVectors` (seeded streams replayed against an independent policy model, size-band histograms), `YftCount` (exact touches, `_bk` / `_bn` reads and word moves through a counting Proxy over all ten columns, with seven must-fail mutant controls plus a hang control), `YFastTrieOracle` / `YFastTrieBoundary` (the policy invariants, the failure modes, bad keys, key 4294967295, 'YFastTrie is full', poison and revive, against sibling oracles), `YFastTrieSpace` (the byteLength formula from a test-owned model), `YftBytecode` (every hot body <= 460 B), `YftSmallScope` (exhaustive small-scope BFS at w = 4, U = 12..16: Set oracle + invariant walker, the oracle set compared on every dedup hit, split / merge / borrow / full-capacity floors, three must-fail mutants), `InliningTool` (the repo-only inlining tool's `--self-test` with its check count pinned, its NO-VERDICT exits, and 13 must-fail mutants of the script), and `YftWitness` (the `--yft --smoke` gate, counts and strings only, five must-fail fakes). For vEBTree: `VEBTree` (units and boundaries at several universes, the exact `byteLength` table, `clear()` against a fresh layout, a U = 2^31 + 12345 run against the reference, and the U = 2^32 empty-encoding assertion in its own Worker, with must-fail mutants), `VebRef` (the test-only recursive reference against a plain `Set` oracle and the research sketch, with must-fail reference mutants), `VebVectors` (the stored `veb-g1.json` stream replayed on the reference and on the engine, engine mutants run in Workers with a kill timer), `VebCount` (exact word reads and writes per operation through Proxies over `_t`, `_g` and `_p`, expected values from an independent model, the WIN / LOSE loss row against StratifiedBitset, a seeded op stream, six must-fail mutants), `VebSpace` (the `byteLength` table and the identity of the `_t` / `_g` / `_p` columns), `VebBytecode` (every hot body's bytecode size pinned on V8 14.6, and delete / successor / predecessor required over the 460 B inlining limit on any V8; fails closed on an unpinned V8), `VebFuzz` (a seeded differential fuzz of the engine against the reference, a `Set` oracle and the sketch, in Workers), `VebWitness` (the `--veb --smoke` gate, counts and strings only: the five startup CONTROL lines, the COVERAGE and RETENTION lines, every bad flag beside `--veb`, mutants of the witness, each exiting 1 with one named FAIL) and `ParityPrefix` (everything before the vEBTree marker is byte-pinned against the 0.4.1 engine bytes, so the three older members stay byte-identical, with controls) and `DocSync` (the vEBTree sections of README and llms.txt carry the exact `byteLength` table, and the pre-implementation wording about vEBTree is gone; it checks README, llms.txt, GUIDE.md, LogLogN.d.ts and the package.json description).

| Script | What it does |
| --- | --- |
| `npm test` | The suite above. |
| `npm run test:types` | `tsc` over the ambient `LogLogN.d.ts`. |
| `npm run torture` | `node --expose-gc test/torture.mjs`: lanes T0-T3 (StratifiedBitset), X0-X4 (XFastTrie, including kicks and reseeds), Y0a / Y0b / Y1 (+ Y1c) / Y1b / Y2 / Y3 / Y4 (YFastTrie, including splits, merges and borrows) and V1 / V2a / V2b / V3 (Worker) / V4 / V5 (vEBTree, including delete's max refresh and the key 2^31 at U = 2^31 + 1): 0 B/op, gc major 0 / minor 0; 5 + 6 + 9 + 9 = 29 must-fail controls (T3, X4, Y4, CV1-CV9). |
| `npm run test:perf` | `@zakkster/lite-perf-gate`: PerfGate (7 zero-alloc scenarios + 3 teeth, flag pin, detector, attribution, GATE key-set pin = 15) XFastTriePerf (8 scenarios, teeth, attribution = 17), YFastTriePerf (9 scenarios, 3 teeth, flag pin, detector, attribution, coverage floor = 19) and VEBTreePerf (10 scenarios, 3 teeth, flag pin, attribution, coverage floor = 21): 72 tests (allocation-count gates). |
| `npm run verify` | The four above in sequence (no witness). |
| `npm run test:big` | Opt-in big-universe suite. |
| `npm run inline-budget-diff` | REPORTED, repo-only: `bash test/tools/inlining-budget-diff.sh` in driver mode (drivers `inl-sb` / `inl-xft` / `inl-yft` / `test/tools/inl-veb.mjs`) (`-- --fn LIST DRIVER_BEFORE DRIVER_AFTER`; exit 0 SAME / 1 DIFF / 2 NO-VERDICT; real runs under the host quiet lock). Only `--self-test` and its 13 must-fail mutants are gated, in `npm test`. |
| `npm run witness` | REPORTED, release-time, quiet host. |
| `npm run witness:w32` | Opt-in w = 32 witness (about 554 MB). |
| `npm run witness:tier` | REPORTED, the peel A/B. |
| `npm run witness:xft` | REPORTED, the XFastTrie lane (`node test/witness.mjs --xft`; release-time, quiet host, 2% effect floor). |
| `npm run witness:yft` | REPORTED, the YFastTrie lane (`node test/witness.mjs --yft`; release-time, quiet host, 2% effect floor; YFastTrie vs XFastTrie successor A/B, foils and the tail MAX REPORTED; `--yft --smoke` is the counts-only gate in `npm test`). |
| `npm run witness:veb` | REPORTED, the vEBTree lane (`node test/witness.mjs --veb`; release-time, quiet host, 2% effect floor; vEBTree vs StratifiedBitset A/B in 38 scenarios, latency, fits and the tail MAX REPORTED; `--veb --smoke` is the counts-only gate in `npm test`). |

Witness exit codes: 0 pass, 1 fail, 2 inconclusive (host noise, drift, or an A/A winner).

## What this is not

- **Not lite-o1's BitSet.** For U <= 2^25 and successor-only, [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) BitSet (fixed 3 levels, O(1) in U) is the better pick, and measured faster (above). StratifiedBitset owns `predecessor` / `max`, U up to 2^32, labelled O(log_32 U), and returns `undefined` for absent (lite-o1 BitSet returns -1).
- **Not a bounded-integer priority queue.** Use lite-o1's `BucketQueue` (Dial, O(1)).
- **Not a general comparator ordered map.** Non-integer or comparator keys belong in `@zakkster/lite-logn` (O(log n)).
- **Not an approximate-membership library.** Bloom / cuckoo / binary-fuse filters live in [`@zakkster/lite-filter`](https://www.npmjs.com/package/@zakkster/lite-filter); lite-loglogn is exact and has no use of it.
- **Not a grow-on-demand collection.** The universe is fixed at construction, and the capacity of XFastTrie and YFastTrie too (vEBTree has no capacity: its whole universe is allocated up front): they never grow and never rehash beyond the labelled in-place reseed.
- **Not a compact structure.** XFastTrie is O(n*w) space, preallocated at the capacity you declare (up to about 4.6 GB at U = 2^32, capacity 2^24), and its updates cost O(w) touches. For O(n) space the answer is YFastTrie (0.4.0; its updates cost O(log log U) probes plus at most 2w - 1 word moves, amortized restructuring); for a dense universe StratifiedBitset is far smaller (tables above). vEBTree is O(U) space: about as large as StratifiedBitset, never sub-linear in U.
- **Not hash-flood resistant.** XFastTrie's cuckoo seeds are fixed by default (and YFastTrie's inner trie shares them); adversarial keys can force kicks and reseeds, and a caller seed is no defence against an attacker who knows it (ADR 0007).
- **Not a worst-case O(log log U) update.** YFastTrie's updates carry up to 2w - 1 contiguous word moves, and a split / merge / borrow is amortized; vEBTree (0.5.0) is the worst-case member, at O(U) space.

## Ecosystem

Part of the `@zakkster/*` LiteLibrariesSuite of zero-GC, single-file ESM micro-libraries.

- [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) -- the O(1) sibling (BitSet, BucketQueue, EliasFano).
- [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) -- the O(log n) sibling (SortedArray, Treap, SkipList).
- [`@zakkster/lite-filter`](https://www.npmjs.com/package/@zakkster/lite-filter) -- approximate / probabilistic membership.
- [`@zakkster/lite-fastbit32`](https://www.npmjs.com/package/@zakkster/lite-fastbit32) -- the `clz32` / word-bit primitives.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
