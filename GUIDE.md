# lite-loglogn -- which structure to pick (GUIDE)

A repo-only decision guide for the O(log log U) family: which member, reach-for /
avoid, and how to measure the double-logarithm (and the space price) yourself. At
v0.1.0 the family is the SCAFFOLD release -- no member has shipped yet, so this
guide is a skeleton: the one question every member answers, the shape of the
picker, and the family boundary. A per-member section (flowchart leaf + reach-for
/ avoid + measure-it) lands with each member release. It is NOT an API
encyclopedia (that is the README + `LogLogN.d.ts`); it answers "which member, is
my bound real, and what does it cost in space?"

Scope discipline (mirrors lite-o1 / lite-logn GUIDE): a decision flowchart + a
picker table up top, then reach-for / avoid + measure-it per member. No
re-documenting signatures.

---

## The one question every member answers

> Is the predecessor / successor op sub-logarithmic in the UNIVERSE bit-width on a
> REAL engine -- and what does it cost in space?

lite-loglogn's answer is the O(log log U) Witness:
`nsPerOp = intercept + slope*log2(w)` that fits a straight, nearly-flat line as
the universe bit-width `w` grows is the proof (one constant step per doubling of
the universe), AND the `log2(w)` fit must beat the O(log U) impostor axis, AND the
member must overtake an O(log n) foil past a reported crossover. Every "reach for
it" below is conditional on the witness staying above its `R^2` floor and inside
its slope band on the log2(w) axis for YOUR universe -- run `npm run witness` and
read the shape -- AND on the SPACE bound fitting your footprint budget.

The family delta: lite-o1 proves a FLAT ops/ms line (the constant); lite-logn a
STRAIGHT log line vs log2(n) (the logarithm); lite-loglogn a straight, nearly-flat
line vs log2(w), the universe BIT-WIDTH (the double-logarithm). Same discipline,
different axis -- and SPACE is a co-headline here, never an afterthought.

---

## Which member? (decision flowchart)

ASCII, routes on the discriminating questions. Every leaf is a planned member;
`(wc)` = worst-case, `(exp)` = expected / amortized. None have shipped at v0.1.0
-- this fills in per release. All assume keys are w-bit integers in [0, U),
w <= 32.

```
START -- what do you need on a BOUNDED integer universe?
|
+-- Predecessor / successor, teachable + array-embedded,
|   and the universe U/w fits in memory?              -> StratifiedBitset (wc, O(U/w) space)  [v0.1.0]
|
+-- Fastest possible query, space is not the constraint,
|   universe can be up to 2^32?                       -> XFastTrie (wc, O(n*w) space)          [v0.2.0]
|
+-- O(log log U) query but you cannot pay O(n*w) space
|   (many elements)?                                  -> YFastTrie (exp, O(n) space)           [v0.3.0]
|
+-- Worst-case O(log log U) with a compact universe
    and you want the classic structure?              -> vEBTree (wc, O(U) space)              [v0.4.0]
```

---

## Picker table

| Need | Member | Time (query) | Space | Version |
| --- | --- | --- | --- | --- |
| Teachable predecessor / successor, array-embedded | StratifiedBitset | O(log_w U), O(1) min / max | O(U/w) | 0.1.0 |
| Fastest query, space no object | XFastTrie | O(log log U) | O(n*w) | 0.2.0 |
| O(log log U) at O(n) space | YFastTrie | expected O(log log U) | O(n) | 0.3.0 |
| Classic worst-case, compact universe | vEBTree | O(log log U) worst-case | O(U) | 0.4.0 |

Per-member "reach for it / avoid it / measure it yourself" sections land with
each member release.

---

## Family boundary (where NOT to reach for lite-loglogn)

- **Bounded-integer priorities (min / max + insert)** -> `@zakkster/lite-o1`
  `BucketQueue` (Dial, O(1)) or `@zakkster/lite-scheduler` `FastBitScheduler`.
  lite-loglogn owns ORDERED predecessor / successor, not a priority queue.
- **Non-integer or unbounded keys (strings, floats, comparators)** ->
  `@zakkster/lite-logn` (SkipList / balanced structures, O(log n)). lite-loglogn
  needs a bounded integer universe (w <= 32) and beats O(log n) only past the
  reported crossover.
- **Approximate membership** -> `@zakkster/lite-filter` (Bloom / cuckoo /
  binary-fuse). lite-loglogn owns exact ordered integer structures.
- **Caching / eviction** -> `@zakkster/lite-lru`. It uses ordering internally but
  is a cache, not an ordered-collection library.

---

MIT (c) Zahary Shinikchiev
