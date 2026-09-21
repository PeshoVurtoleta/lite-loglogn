# @zakkster/lite-loglogn

> Zero-GC, sub-logarithmic bounded-integer predecessor/successor structures that PROVE their bound. The O(log log U) sibling of `@zakkster/lite-o1` (the constant) and `@zakkster/lite-logn` (the logarithm): lite-loglogn holds the double-logarithm -- a straight, nearly-flat line vs `log2(w)`, the universe BIT-WIDTH, one constant step per doubling of the universe. The identity is the SPANNING framing -- the family spans O(log_w U) to O(log log U) over a bounded integer universe. v0.1.0 is the scaffold release; the planned roster is StratifiedBitset (array-embedded O(log_w U) successor/predecessor, O(U/w) space), XFastTrie (O(log log U) query over pointer-free LevelTables, O(n*w) space), YFastTrie (the O(n)-space fix over x-fast representatives), and vEBTree (a flattened van Emde Boas at worst-case O(log log U)) -- each zero-GC, each shipped with a Witness that fits `nsPerOp = intercept + slope*log2(w)` and reports the n-sweep crossover over an O(log n) foil, with SPACE stated as a co-headline.

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

## The O(log log U) toolkit the ecosystem was missing

Almost no JavaScript data-structure library ships the evidence that its Big-O claim survives contact with a real engine -- megamorphic call sites, GC pauses, cache misses, deopts. `lite-loglogn` is a curated, tree-shakeable family of the sub-logarithmic bounded-integer predecessor/successor structures that actually matter, each zero-GC, each written to teach the trick that buys the double-logarithm, and each shipped with a harness that DEMONSTRATES its bound rather than asserting it. The complexity class IS the product.

lite-loglogn is the O(log log U) sibling of [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) and [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn). lite-o1 proves a FLAT ops/ms line on a log-x axis (the constant -- slope ~ 0); lite-logn proves a STRAIGHT line vs `log2(n)` (the logarithm -- one added level per doubling of `n`); lite-loglogn proves a straight, NEARLY-FLAT line vs `log2(w)` -- the universe BIT-WIDTH -- one constant additive step per doubling of the universe. The axis is the whole point: the honest bound is in `U`, not `n`. Same discipline as its siblings: zero allocation on every hot path and a witness that turns "trust me, it is sub-logarithmic" into a line you can see, with an O(log n) foil it overtakes.

Three honesty hooks make this family carry one more than its siblings:

- **The bound is in U, not n.** O(log log U) is in the UNIVERSE bit-width, never the element count. For 32-bit keys `log log U <= 5`, so on a fixed universe these are small-constant-time structures whose win over O(log n) is real but BOUNDED and materializes only as `n` grows past a crossover. This README never implies "log log U beats log n" without "for n above K on a w-bit universe." Conflating log log U with log log n is the dishonesty this family refuses.
- **The time flavor is always labeled** -- worst-case (vEB; StratifiedBitset as O(log_w U)) vs expected / amortized (y-fast). The witness reports MAX single-op time so a bucket-split or level-table rehash spike shows as a tall bar.
- **The SPACE price is a co-headline** -- stated on every member with the same prominence as the time bound (vEB O(U), x-fast O(n*w), y-fast O(n), StratifiedBitset O(U/w)). Speed is half an honest claim here; footprint is the other half.

**v0.1.0 is the scaffold release.** It ships only the `VERSION` const -- there is no member yet. This first cut stands up the repo, the gates (torture / witness / perf / space), and the design decisions that outlive member 1 (see [`decisions/`](./decisions)). The planned roster below lands one member per session, each append-only so prior members stay byte-identical.

```bash
npm install @zakkster/lite-loglogn
```

```js
import { VERSION } from '@zakkster/lite-loglogn';

console.log(VERSION); // -> '0.1.0'  (scaffold release; members land per session)
```

Once StratifiedBitset ships (v0.1.0 member session), the quick-start becomes an integer set whose `successor` / `predecessor` are O(log_w U) worst-case and allocate zero bytes after construction, and `npm run witness` proves it holds the straight `log2(w)` line while an O(log n) sorted-array foil climbs and is overtaken.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The planned roster](#the-planned-roster)
- [The O(log log U) Witness](#the-olog-log-u-witness)
- [API reference](#api-reference)
  - [Constants](#constants)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

A working programmer with millions of bounded integers -- timestamps, IDs, ports, quantized coordinates -- who needs "the next key at or above X" reaches for a sorted array (O(log n) binary search, O(n) insert) or a balanced BST (O(log n) everything, and a `new Node` per insert that the GC will not honor). Both pay the logarithm of the ELEMENT COUNT. But when the keys live in a bounded universe, the predecessor problem has a sharper bound: O(log log U) in the universe bit-width, or O(log_w U) for the array-embedded stratified structure -- sub-logarithmic, and on a 32-bit universe a small constant.

lite-loglogn ships those structures with the allocation removed (array-embedded members are naturally node-free; trie members use pointer-free open-addressing LevelTables) and the bound proven (the witness fits a straight `log2(w)` line, asserts it beats the O(log U) impostor axis, and reports the `n` at which it overtakes an O(log n) foil). The complexity class is the product: you get the structure AND the evidence its bound is real on a real engine -- AND its space price, stated up front.

## What you get

- **Zero runtime dependencies.** ESM only, ASCII-only source, one PascalCase main file (`LogLogN.js`), `sideEffects: false`.
- **Zero allocation on every hot path.** Proven by `node --expose-gc test/torture.mjs` (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`): 0 B/op, `gc major = 0`, leak tracker `size 0/0`, AND the arrayBuffers-no-growth tier (this family lives in typed-array backing stores where a heap-growth gate alone is blind).
- **A double-logarithm you can see.** `npm run witness` fits `nsPerOp = intercept + slope*log2(w)` across a universe bit-width sweep, asserts the `log2(w)` fit beats the O(log U) impostor axis, and reports the crossover `n` where it overtakes an O(log n) foil.
- **SPACE as a co-headline.** Every member states and asserts its footprint (bytes vs U and vs n); a member whose backing array silently grows fails the space gate.
- **Tree-shakeable named exports.** Members share no mutable module state, so a bundler that imports one drops the others.
- **Fail closed.** Bounded universe (keys in [0, U), w <= 32); a `typeof`-guard at the door of every mutating op; `null` is not zero; an out-of-universe key fails closed; an unknown option key is an error with a hint, never a silent ignore.

## The planned roster

One member per session, each landing append-only (prior members stay byte-identical). At v0.1.0 none are shipped yet -- this is the scaffold.

| Member | Version | Time (query) | Space | Shape |
| --- | --- | --- | --- | --- |
| **StratifiedBitset** | 0.1.0 | O(log_w U), O(1) min / max | O(U/w) | array-embedded hierarchical bit tree; the headline / teachable entry point |
| **XFastTrie** | 0.2.0 | O(log log U) | O(n*w) | binary search over w pointer-free open-addressing LevelTables |
| **YFastTrie** | 0.3.0 | expected O(log log U) | O(n) | x-fast trie over ~n/w representatives + balanced buckets |
| **vEBTree** | 0.4.0 | O(log log U) worst-case | O(U) | flattened van Emde Boas (vEB-layout array / iterative high-low split) |

Later tiers (SegmentedU for wider keys, EliasFano, RoaringSet, and presets) are queued in [`ROADMAP.md`](./ROADMAP.md).

## The O(log log U) Witness

The family anchor, and the one place this package refuses to become its `log2(n)` sibling by copy-paste. Time a fixed batch of the hot op at each universe bit-width `w` in a sweep, fit `nsPerOp = intercept + slope * log2(w)` by least squares, and:

- fit BOTH axes and assert the `log2(w)` fit WINS over the `w` (O(log U)) impostor axis -- this catches a mislabeled bound (an x-fast update path that is really O(log U)), AND
- `R^2 >= floor` (a straight `log2(w)` line fits -- genuinely double-logarithmic), AND
- `slope` inside the member's band (the per-level cost, ns/level), AND
- report the CROSSOVER `n` (hold U at 32 bits, sweep `n`): the member stays flat while an O(log n) foil climbs and is overtaken -- "wins for n above ~K on a 32-bit universe."

For amortized / expected members (y-fast) the witness also prints the MAX single-op time -- the honesty hook: a bucket-split or rehash spike shows as a tall bar even when the mean still fits. The `R^2` floor + slope band are calibrated in StratifiedBitset and become the shared FAMILY gate (see [`decisions/0004-witness.md`](./decisions/0004-witness.md)); which sweep is the HARD gate (lean: the crossover) is settled there too. At v0.1.0 the witness harness is a stub: with zero members it runs green and empty (there is no member to fit yet).

## API reference

### Constants

| Export | Type | Value | Meaning |
| --- | --- | --- | --- |
| `VERSION` | `string` | `'0.1.0'` | The package version. One of the three version sites (package.json / `LogLogN.js` `VERSION` const / `llms.txt`), kept in lockstep and enforced in review. |

Member signatures (constructors, hot ops, a per-member SPACE bound, and a per-member constants table) are appended here as each member ships.

## Zero-GC design notes

- **Array-embedded members allocate no nodes.** StratifiedBitset (and a flattened vEB) live in flat typed arrays; there is no `new Node` per op, so there is nothing to collect. The parent / child relationships are index arithmetic and `clz32` word ops, not pointers.
- **Trie members use pointer-free LevelTables.** XFastTrie and the x-fast layer of YFastTrie allocate a slot INDEX from open-addressing `Uint32Array` LevelTables with threaded index columns -- never a heap object. `NIL = 0`, slot 0 unused. The substrate is reconciled against the shared suite primitive, never forked (see [`decisions/0003-substrate.md`](./decisions/0003-substrate.md)).
- **Bounded universe, 32-bit word.** Keys are w-bit integers in [0, U), w <= 32 (JS bitwise ops are 32-bit). Wider keys are a labeled Tier-2 `SegmentedU` variant, never a silent BigInt hot path (see [`decisions/0005-policy.md`](./decisions/0005-policy.md)). Out-of-universe keys fail closed with a `[lite-loglogn]` throw.
- **SPACE is gated, not commented.** Every member asserts its backing-store footprint (bytes vs U and vs n) and that it does not grow per query -- the arrayBuffers-no-growth tier in torture is where a level-table rehash gets caught.

| Op class | Allocation |
| --- | --- |
| (v0.1.0 scaffold: no member yet) | n/a |

The allocation table is filled in per member as each lands, with the gated `R^2` / slope numbers from its witness run and its SPACE bound.

## Testing

`node:test` only, zero runtime deps. At v0.1.0 the harnesses are scaffolds that run green and empty (no member to exercise yet); each member session fills its tier.

- `npm test` -- per-member contract + boundary + fuzz-vs-oracle suites, plus the cross-member `QaAudit` block (VERSION trinity, author-spelling guard, ASCII-only source, the six-file pack).
- `npm run torture` -- `node --expose-gc test/torture.mjs`: 0 B/op on every hot path, `gc major = 0`, leak tracker `size 0/0`, arrayBuffers no-growth.
- `npm run witness` -- the O(log log U) witness harness: log-linear `R^2` + slope fit on the `log2(w)` axis, the `log2(w)`-fit-wins assertion, and an O(log n) foil crossover.
- `npm run test:perf` -- `@zakkster/lite-perf-gate` zero-alloc scenarios, each with a must-fail teeth case that proves the instrument has teeth.
- `npm run test:types` -- `tsc` over the ambient `LogLogN.d.ts` surface.
- `npm run verify` -- all of the above in sequence.

## What this is not

- **Not a bounded-integer priority queue.** If you need the min / max repeatedly with insert on small bounded integers, use `@zakkster/lite-o1`'s `BucketQueue` (Dial, O(1)). lite-loglogn owns ordered predecessor / successor.
- **Not a general comparator ordered map.** If keys are not bounded integers (strings, floats, comparators), use `@zakkster/lite-logn`'s SkipList (O(log n)). lite-loglogn beats it only for `n` above the reported crossover on a bounded (w-bit) universe.
- **Not an approximate-membership library.** Bloom / cuckoo / binary-fuse filters live in `@zakkster/lite-filter`. lite-loglogn owns exact ordered integer structures.
- **Not a grow-on-demand collection.** The universe is bounded at construction and out-of-universe keys fail closed.

## Ecosystem

Part of the `@zakkster/*` LiteLibrariesSuite of zero-GC, single-file ESM micro-libraries.

- [`@zakkster/lite-o1`](https://www.npmjs.com/package/@zakkster/lite-o1) -- the O(1) sibling. Holds the constant (a flat ops/ms line).
- [`@zakkster/lite-logn`](https://www.npmjs.com/package/@zakkster/lite-logn) -- the O(log n) sibling. Holds the logarithm (a straight line vs `log2(n)`); lite-loglogn is the O(log log U) fast end of the same idea on a bounded universe.
- [`@zakkster/lite-filter`](https://www.npmjs.com/package/@zakkster/lite-filter) -- approximate / probabilistic membership.
- [`@zakkster/lite-fastbit32`](https://www.npmjs.com/package/@zakkster/lite-fastbit32) -- the `clz32` / word-bit primitives lite-loglogn cross-links.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
