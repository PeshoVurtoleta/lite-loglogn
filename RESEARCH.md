# lite-loglogn Research Notes

**Status**: Living research document
**Scope**: Design decisions, theoretical anchors, and experimental directions for a tree-shakeable,
zero-GC family of **sub-logarithmic integer data structures** in JavaScript/TypeScript that doubles as a
teachable textbook -- each member solves a real predecessor/successor/ordered-integer problem AND proves
that it beats O(log n) by exploiting a bounded integer universe under the word-RAM model. It is the
deliberate O(log log U) sibling of [[lite-logn]] (O(log n)) and [[lite-o1]] (O(1)); the three span the
"how fast is your structure, and can you prove it?" spectrum from the constant, through the logarithm, to
the double-logarithm.

> **The one honesty that governs everything below**: these structures are O(log log **U**) in the
> UNIVERSE size U (the key bit-width), NOT O(log log n) in the element count. They win ONLY for integer
> keys drawn from a bounded universe [0, U). Outside that niche they lose to [[lite-logn]]'s comparator
> structures. The package name is the banner; the bound, the model, and the space cost are stated on every
> member. See sections 2 and 5.

---

## 1. Core Identity

- **The complexity class IS the product.** Every member's headline op (predecessor / successor / member /
  min / max over an ordered integer domain) is O(log log U) -- worst-case (van Emde Boas), or expected /
  amortized (y-fast trie) -- and the library's job is to PROVE the double-logarithm, not assert it (see
  section 2). "O(log log U)" without evidence is a claim; the witness makes it a shape you can see.
- **Bounded integer universe, word-RAM model.** Keys are w-bit integers in [0, U), U = 2^w. The
  sub-logarithmic bound depends on standard arithmetic and bitwise ops on a w-bit word being O(1) (the
  word-RAM model). In JS that means w <= 32 naturally (bitwise ops are 32-bit); wider universes need a
  labeled split-word or BigInt variant (section 5). `null` is not zero; an absent key returns `undefined`,
  never key 0. Fail closed on every unverified state.
- Zero garbage collection on the steady-state hot path (0 B/op). This is the family's HARDEST problem yet:
  a textbook vEB is a RECURSIVE tree of cluster objects, an x-fast trie is w hash tables of node objects --
  both allocate per level. lite-loglogn removes it by flattening every recursion into typed arrays and
  bit-packed level tables (see "the honest unifying thread").
- Structure-of-Arrays (SoA) + typed-array substrate for cache locality. Ordering is by the integer key
  itself (the universe is the order) -- never by boxing keys into comparator objects.
- Tree-shakeable: import ONE structure and extend it. No barrel forces the others into the bundle.
- Single-file ESM per package, zero runtime dependencies, `node:test` only, ASCII-only source.
- **"Measure the double-logarithm, and state the space" as the primary product differentiators** (sections
  2 and 5). Speed is half the story here; space is the other half, and the honest members say so.

The library does not compete on generality with a comparator BST, nor on breadth with a collections
package. It wins on a narrow, sharp axis: the integer predecessor/successor structures that actually beat
O(log n) when your keys are bounded integers (entity IDs, timestamps compressed into a universe, ports,
LBAs, priorities), each zero-GC, each shipped with a harness that DEMONSTRATES the doubly-logarithmic cost
curve against an O(log n) foil, and each written to teach the trick -- recursing on the universe, not on
the data -- that buys the log log.

### The honest unifying thread

O(log log U) structures are heterogeneous the same way the O(log n) family is: a van Emde Boas tree, an
x-fast trie, and a fusion tree share no single swappable interface. What unifies them is:

1. **The complexity guarantee** -- every member's headline op is O(log log U) (or O(log_w U) for the
   stratified-bitset member), ALWAYS labeled which flavor: worst-case, expected, or amortized (section 5),
   and ALWAYS in U, never in n.
2. **The bounded-integer domain** -- keys are w-bit integers in [0, U); the order is the integer order.
   Every member supports the predecessor/successor spine (`has` / `min` / `max` / `successor(x)` /
   `predecessor(x)` / `add` / `delete`); structure-specific extras extend it.
3. **The recurse-on-the-universe substrate** -- two shapes, chosen per member:
   - **Array-embedded / bit-packed** structures (the stratified hierarchical bitset; a flattened vEB
     layout) live in flat `Uint32Array`s with implicit index arithmetic (`x >>> 5` to climb a summary
     level, `& 31` for the bit) -- no nodes at all, naturally zero-GC. The count-trailing-zeros /
     count-leading-zeros word primitive (`Math.clz32`) is the O(1) word-RAM op the whole family leans on.
   - **Pointer-free node/level tables** (x-fast / y-fast trie) replace `new Node` and hash-table objects
     with open-addressing `Uint32Array` level tables (one bit-prefix table per trie level) plus a
     pointer-free representative index. A "pointer" is an integer index; a "null pointer" is a reserved
     sentinel (`NIL = 0`). This is the family's teachable substrate and the counterpart to [[lite-logn]]'s
     `NodePool` and [[lite-o1]]'s `SlotPool` -- reconcile, do not fork (section 6).
4. **The doubly-logarithmic-growth witness** -- one measurement harness (section 2) proves the log log for
   every member the same way: a straight line against `log2(w)` (the universe bit-width axis), far flatter
   than the O(log n) foil.

The predecessor/successor spine DOES fit every member here (unlike the heterogeneous O(log n) family),
because the whole package is about one operation: "given x, what is the nearest present key?" over a
bounded integer universe. That shared spine is a real asset lite-logn could not claim.

---

## 2. The Analytical Anchor: The O(log log U) Witness (doubly-logarithmic growth)

### Why it belongs in the project

lite-lru's killer feature is "% of Belady optimal." lite-filter's is "measured vs theoretical FPR."
[[lite-o1]]'s is the **O(1) Witness** (flat ops/ms). [[lite-logn]]'s is the **O(log n) Witness** (a
straight line vs `log2(n)`). lite-loglogn inherits the discipline (measure the real structure against a
provable reference, never a marketing number) but its anchor is a different, subtler shape:

> **lite-loglogn's analytical anchor is doubly-logarithmic growth made visible: per-op cost that rises by
> a CONSTANT ADDITIVE STEP each time the universe BIT-WIDTH `w` DOUBLES (i.e., each time `log U` doubles)
> -- one extra level of the universe recursion per doubling of the bit-width. The bound is O(log log U).**

The critical twist versus lite-logn: the independent variable is NOT `n`, it is the universe bit-width `w
= log2(U)`. Plot per-op time against `log2(w)` and an O(log log U) structure draws a STRAIGHT LINE:
doubling the bit-width (16-bit keys -> 32-bit keys) adds one constant step of work. Because `w` itself
only ranges over a handful of values in practice (16, 24, 32, ... up to 32 in JS), the ABSOLUTE movement
is tiny -- and that near-flatness, contrasted with an O(log n) structure whose cost climbs steadily with
`n` on the SAME data, is exactly the theorem made visible.

Two complementary sweeps make the shape legible, and the witness runs BOTH:

- **The U-sweep (the defining shape).** Hold `n` fixed (a dense-enough fill), sweep the universe
  `U = 2^16, 2^20, 2^24, 2^28, 2^32`. ns/op vs `log2(w)` is the doubly-logarithmic straight line; the fit
  `nsPerOp = intercept + slope*log2(w)` gives `R^2 >= floor` and a small `slope`. (For the stratified
  bitset the natural axis is `w` itself, giving O(log_w U) = O(w / log w) levels -- still far flatter than
  log n; the member declares which axis it fits.)
- **The n-sweep (the payoff vs the foil).** Hold `U` fixed at 32 bits, sweep `n = 1e3 .. 1e7`. The
  member's ns/op stays NEARLY FLAT (its cost is bounded by `log log U <= 5`, independent of n) while the
  O(log n) foil -- a balanced BST / skip list, or [[lite-logn]]'s own members -- climbs its straight
  `log2(n)` line and crosses above the member as `n` grows. This is the "why you would ever use this"
  panel.

**Why it is a killer feature**:

- "A vEB tree is fast" is meaningless without the axis. "vEB predecessor's ns/op fits `a + b*log2(w)` with
  R^2 = 0.98, slope ~ constant across w = 16..32, and on a fixed 32-bit universe it stays flat at ~X ns/op
  from n=1e3 to n=1e7 while a red-black-tree foil climbs from Y to 3Y" is immediately convincing: the
  double-log is real, it is bounded by the WORD SIZE not the data, and it overtakes the O(log n) default a
  working programmer would reach for.
- Almost no JS library ships an O(log log U) integer structure at all, let alone the evidence that the
  bound survives a real engine (megamorphic sites, GC, cache misses) AND an honest accounting of its space
  cost. This one does both.

### The witness, precisely

Per member, over each sweep:

- **ns/op at each point** across the geometric sweep (U-sweep: over w; n-sweep: over n).
- **The log-linear fit** on the U-sweep: least-squares `nsPerOp = intercept + slope * log2(w)`.
  O(log log U) => high `R^2` (a straight line fits vs `log2(w)`) and a small bounded `slope`. An
  accidentally-O(log U) member (e.g. an x-fast UPDATE path) would fit `log2(w)` poorly but fit `w` well --
  the harness fits both axes and reports which wins, so a mislabeled bound is caught.
- **The crossover** on the n-sweep: the `n` at which the member's ns/op drops below the O(log n) foil's.
  Reported as a fact ("wins for n above ~K on a 32-bit universe"), the honest answer to "is this worth it
  for my size?"
- **Step constancy**: the first-difference of ns/op per bit-width doubling should stay ~constant. A rising
  trend betrays a hidden O(log U) or O(w) term masquerading as O(log log U).

Paired with the suite's zero-alloc proof (`0 B/op` via lite-leak + lite-gc-profiler) AND the space report
(section 5), the witness closes all THREE parts of an honest O(log log U) claim: **the double-log is a
straight line, there is no per-op allocation, and the space cost is stated.** Space is not optional
color here -- a vEB's O(U) space is the reason the whole niche is "bounded universe," so the space number
sits beside the speed number, always.

### Reference harness (the witness)

```js
/**
 * The O(log log U) Witness: doubly-logarithmic growth under a growing universe.
 *
 * U-sweep: times a fixed batch of the hot op at each universe bit-width w, reports ns/op,
 * then fits ns/op = intercept + slope*log2(w). O(log log U) => a straight line vs log2(w)
 * with a small slope; an O(log U) impostor fits w (not log2(w)) far better -- so the
 * harness fits BOTH axes and returns both R^2 values, and the caller asserts the log2(w)
 * fit wins. Warms up to defeat JIT tiering, then measures. An OFFLINE proof tool, never a
 * hot-path dependency.
 *
 * @param {(w:number)=>{op:(i:number)=>void}} build  builds a warmed structure over a
 *                                                   universe of 2^w keys and returns its
 *                                                   hot op closure
 * @param {number[]} widths   bit-width sweep, ascending (e.g. [16,20,24,28,32])
 * @param {number}   batch    ops timed per width (fixed, so ns/op is comparable)
 * @returns {{rows:{w,opsPerMs,nsPerOp}[], slopeLogW:number, r2LogW:number, slopeW:number, r2W:number, steps:number[]}}
 */
export function logLogWitness(build, widths, batch) {
    const rows = [];
    for (let s = 0; s < widths.length; s++) {
        const w = widths[s] | 0;
        const { op } = build(w);
        for (let i = 0; i < batch; i++) op(i);            // warm-up: tier up to optimized code
        const t0 = performance.now();
        for (let i = 0; i < batch; i++) op(i);
        const dt = performance.now() - t0;
        rows.push({ w, opsPerMs: dt > 0 ? batch / dt : Infinity, nsPerOp: dt > 0 ? (dt * 1e6) / batch : 0 });
    }
    const ys = rows.map(r => r.nsPerOp);
    const fit = (xs) => {                                  // least-squares slope + R^2 of ys vs xs
        const m = xs.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = 0; i < m; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
        const denom = m * sxx - sx * sx;
        const slope = denom !== 0 ? (m * sxy - sx * sy) / denom : 0;
        const intercept = (sy - slope * sx) / m;
        let ssTot = 0, ssRes = 0; const ymean = sy / m;
        for (let i = 0; i < m; i++) {
            const pred = intercept + slope * xs[i];
            ssRes += (ys[i] - pred) * (ys[i] - pred);
            ssTot += (ys[i] - ymean) * (ys[i] - ymean);
        }
        return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
    };
    const logW = fit(rows.map(r => Math.log2(r.w)));       // the O(log log U) axis
    const linW = fit(rows.map(r => r.w));                  // the O(log U) impostor axis
    const steps = [];                                      // ns added per bit-width doubling
    const lx = rows.map(r => Math.log2(r.w));
    for (let i = 1; i < ys.length; i++) steps.push((ys[i] - ys[i - 1]) / ((lx[i] - lx[i - 1]) || 1));
    return { rows, slopeLogW: logW.slope, r2LogW: logW.r2, slopeW: linW.slope, r2W: linW.r2, steps };
}
```

### The foil (making the shape legible)

Every member's bench ships two foils on the identical data, so the reader sees the payoff and the price:

- **The O(log n) foil (the payoff).** A balanced BST / skip list from [[lite-logn]] (or a sorted array
  with binary search) doing the SAME predecessor/successor queries. On the n-sweep at a fixed 32-bit
  universe, the member stays flat (log log U) while the foil climbs log n and is overtaken -- the honest
  "this is when the double-log wins" picture. This is the primary foil.
- **The O(1) hash-set counter-foil (what you give up in ORDER, what they give up in SPACE).** A native
  `Set` answers `has` in O(1) but CANNOT answer `successor`/`predecessor`/`min` without an O(n) scan; the
  bench shows the `Set` winning raw membership and losing the moment order is required -- and, on the
  space axis, shows the member's universe-proportional footprint versus the `Set`'s n-proportional one
  (the honest reverse: sometimes the hash set is the right tool precisely because of space).
- **The naive bitset foil (the family's own poor cousin).** A single flat bitset answers `has` in O(1)
  but `successor` by a linear word scan (O(U/w)); the stratified member adds the summary pyramid to make
  that scan O(log_w U). Showing both makes the summary hierarchy's value legible.

---

## 3. The Benchmark Suite (the ecosystem MVP)

**`benchmark/` is the flagship deliverable, not a supporting tool** -- exactly as in [[lite-o1]] and
[[lite-logn]]. The O(log log U) Witness of section 2 is the analytical ANCHOR, but the growth shape is
NECESSARY and far from SUFFICIENT: for this family especially, it hides the SPACE cost that defines the
whole niche, plus latency tails, cache effects, GC jitter, and real workloads. The suite ships both
TABLES and GRAPHS and compares every member against the language builtins (`Set`/`Map`) and against a
[[lite-logn]] O(log n) baseline, so a user sees exactly where the library wins and where it does not.

The witness (section 2) is dimension 1. **These are the same eight dimensions [[lite-o1]] defines** (the
user's authoritative benchmark spec), adapted where O(log log U) changes the emphasis:

1. **Growth shape + fit quality (the witness).** The U-sweep double-log fit AND the n-sweep crossover vs
   the O(log n) foil. Reports which axis (log2(w) vs w) the member fits -- catching a mislabeled bound.
2. **Latency distribution.** p50/p90/p99/p99.9/max per op, WITH and WITHOUT forced GC. The y-fast trie's
   bucket splits/merges and any rehash of a level table produce a tail; the vEB's recursion is worst-case
   flat -- the distribution proves which member is truly worst-case and which is amortized/expected.
3. **Amortized cost over long mixed traces.** Millions of interleaved add/delete/successor ops; cumulative
   cost/op should track `log log U`, not drift as the structure fills and empties.
4. **MEMORY footprint and stability -- promoted to co-headline here.** Bytes per LIVE element AND bytes
   per UNIVERSE slot. This is THE dimension for this package: a vEB is O(U) (a 2^24 universe is already
   heavy; 2^32 is infeasible), an x-fast trie is O(n*w), a y-fast trie is O(n), a stratified bitset is
   O(U/w). The suite plots footprint vs both U and n so the reader sees exactly which member to pick for
   their density. High-water after fill -> delete -> refill; retained bytes after `clear()`.
5. **Cache and memory-subsystem behaviour.** Array-embedded/bit-packed members (stratified bitset,
   flattened vEB) are cache-friendly; the level-table members chase indices across `Uint32Array`s. The
   `Math.clz32` word primitive's throughput matters. Sequential vs random-key access gap.
6. **GC pressure and allocation rate.** Allocs/op and total GC pause -- the axis that exposes a per-level
   `new` in a naive recursive vEB. Extends the `0 B/op` gate into a curve.
7. **Scalability across universe sizes, densities, and key distributions.** U = 2^16 .. 2^32; density
   n/U from sparse to near-full; sequential vs random vs clustered vs adversarial key streams (clustered
   keys are where a stratified bitset's summaries stay hot and where an x-fast trie's shared prefixes
   matter). Load factor of the level tables.
8. **Workload micro-benches.** Predecessor/successor sweeps (IP-longest-prefix-ish, interval stabbing by
   nearest key), ordered iteration by repeated `successor`, min-drain (priority-queue-by-integer-key),
   nearest-timestamp lookup, gap-finding (`successor(x) - x`).

> **Authoritative steer (user, 2026-09-16):** the eight-dimension benchmark suite is **COMPLETE** and is
> NOT to be reinvented. lite-o1 shipped it as Bench v2 -- the full-rigor blueprint (strong baselines +
> bootstrap CI + Mann-Whitney + overhead-subtraction + a load-factor curve) with a `Template.mjs` and a
> `METHODOLOGY.md` **written expressly for the siblings to copy**. lite-loglogn ADOPTS that framework
> wholesale: copy the harness, the child-process-per-cell orchestrator, the honesty header, the vacuity
> gate, and the inline-SVG report renderer verbatim, then swap in only what is genuinely O(log log U)-
> specific -- the U-sweep double-log FIT (both axes, section 2) in dimension 1, the O(log n) [[lite-logn]]
> foil with its crossover, and the MEMORY kernel (footprint vs U AND vs n), which is this family's
> co-headline dimension. There is no "design the suite" session and no reuse-vs-fork question: the suite
> exists as a dev-only shared blueprint; the member-specific work is a port plus the memory kernel and the
> double-log fit, not a rebuild.

---

## 4. The Candidate Roster (all candidates)

O(log log U) here means the HEADLINE op; every member states its exact bound, its flavor (worst-case /
expected / amortized), AND its space bound (the honesty co-headline, section 5). Build order is one concept
per release, simplest-and-most-implementable-zero-GC first. **The roster folds in the user's candidate
list (van Emde Boas, x-fast trie, y-fast trie, fusion tree) as the authoritative input, plus the
stratified bitset as the practical array-embedded entry point.**

### Tier 1 -- core roster (the members to ship)

| Structure        | Headline op(s)                                   | Time bound (flavor)          | Space   | Why it earns a slot |
|------------------|--------------------------------------------------|------------------------------|---------|---------------------|
| **StratifiedBitset** | add / delete / has / successor / predecessor / min / max | O(log_w U) worst-case (w=32) | O(U/w)  | The array-embedded, naturally-zero-GC ENTRY POINT -- a pyramid of `Uint32` summary words, find-next via `clz32`. Not strictly O(log log U) (it is O(log_w U) = a handful of levels for 32-bit keys), but it TEACHES the "recurse on the universe" idea with real, correct, allocation-free code and gives the cleanest witness. The BinaryHeap-equivalent headline: simplest correct member first. |
| XFastTrie        | successor / predecessor / has                     | successor O(log log U) worst; update O(w) | O(n*w)  | The teachable building block: a bit-prefix trie whose `successor` is a BINARY SEARCH over the `w` levels (O(log w) = O(log log U)). Introduces the level-table substrate. The honest caveat is baked in: fast query, O(w) update, O(n*w) space -- which y-fast then fixes. |
| YFastTrie        | add / delete / successor / predecessor            | O(log log U) expected/amortized | O(n) | The PRACTICAL member: an x-fast trie over O(n/w) representatives + balanced buckets of O(w) keys, dropping space to O(n) and making update O(log log U) amortized. The "you can actually use this on a 32-bit universe" answer, and the space-fix teaching beat. |
| vEBTree          | add / delete / has / successor / predecessor / min / max | O(log log U) worst-case      | O(U)    | THE named structure and the worst-case showpiece: every op deterministically O(log log U) via the recurse-on-sqrt(U) split (summary + clusters). Flattened into typed arrays for zero-GC. The O(U) space is the honest ceiling -- ship it for modest universes and cross-link y-fast for large ones. |

### Tier 2 -- strong candidates (next releases)

| Structure        | Headline op(s)                        | Bound (flavor)                 | Note |
|------------------|---------------------------------------|--------------------------------|------|
| FusionTree       | predecessor / successor                | O(log_w n) worst-case (static) | Word-level parallelism packs `w` keys into one machine word and compares in O(1); beats a BST only for large `w` and is notoriously subtle (sketch compression, most-significant-differing-bit). Likely a RESEARCH-track member with an honest "why this is hard and when it pays" note, not an early ship. In JS w=32 caps the win; label it. |
| IntUniverseMap   | successor + a VALUE column (handle)    | inherits the chosen index      | Any Tier-1 member + a parallel value/handle column so it maps integer keys to payloads (the ordered-int-map use case), not just membership. A composition, shipped once the index members exist. |
| SegmentedU       | 53-bit / split-word keys              | O(log log U) with a 2-level split | The honest answer to "JS bitwise is 32-bit": split a wider key into a high word (a Tier-1 structure) and low words, or use BigInt on a cold path. A labeled variant, not the default. |
| EliasFano        | successor / predecessor / select / access | successor O(log(U/n)); select O(1) | **SHIPPED IN lite-o1 1.9.0 (amended 2026-10-20; ADR 0025 there): re-adopt, do not rebuild. Since lite-o1 1.11.2, access is O(1) typical / worst-case O(log n).** The SUCCINCT monotone-sequence member: store a sorted set of n keys from [0, U) in ~`n(2 + log2(U/n))` bits -- near the information-theoretic minimum -- with `select(k)` (the k-th key) in O(1) via a rank/select bitvector and `successor` in O(log(U/n)). Old but gold (Elias 1974 / Fano). The space HERO of the family: where vEB is O(U) and y-fast is O(n) pointers, Elias-Fano is compressed n-proportional bits. STATIC (build-once from a sorted array). The niche: huge sparse sorted-integer sets, inverted-index postings, compressed successor. |
| RoaringSet       | add / delete / has / successor / rank / iterate | bounded O(log) has (amended 2026-10-20: array containers are binary-searched); O(log) successor, or a bounded walk with the section 12 summaries | The PRACTICAL space-adaptive integer set: partition the 32-bit universe into 2^16 chunks, each stored as whichever container is smallest -- a sorted `Uint16` array (sparse), a bitset (dense), or a run-length list (clustered). The real-world workhorse (Lucene / Druid / Spark all ship Roaring). Not asymptotically exotic, but the honest "what you actually reach for when the density varies across the universe" member, with predecessor/successor and rank/select over the containers. The adaptivity is the teaching beat: no single representation wins every density. |

### Tier 3 -- adjacent / substrate (evaluate; may fold in or cross-reference)

| Structure        | Role                                   | Note |
|------------------|----------------------------------------|------|
| LevelTable       | open-addressing `Uint32Array` integer->slot table | The pointer-free hash substrate the x-fast / y-fast tries need. Shares DNA with [[lite-o1]]'s SparseSet and [[lite-logn]]'s NodePool -- reconcile, cross-link, do NOT fork (section 6). Substrate, not a headline member. |
| clz/ctz helpers  | `Math.clz32`-based word primitives     | The O(1) word-RAM ops (highest/lowest set bit, next-set-bit-in-word). Possibly a tiny shared internal; if it grows, it belongs in [[lite-fastbit32]], not reimplemented here. |
| RankSelectBits   | rank(i) / select(k) over a bitvector   | O(1) rank/select with an o(U) index | **SHIPPED IN lite-o1 1.8.0 as RankSelect (amended 2026-10-20; ADR 0024 there): re-adopt as substrate, never fork. As of lite-o1 1.11.2, select is worst-case O(log(nbits/2048)), bounded but not O(1).** The succinct PRIMITIVE under EliasFano, RoaringSet, and any wavelet member: `rank(i)` = set bits <= i, `select(k)` = position of the k-th set bit, both O(1) via a two-level (superblock + block) `Uint32` index costing o(U) extra bits (rank9 / poppy layout). Substrate, not a headline member -- but the reusable engine three Tier-1/2 members lean on. Shares DNA with StratifiedBitset's summary pyramid; reconcile, do NOT fork. |

### Tier 4 -- exotic but a golden niche (research track; each a dedicated future member with an honest "when it pays" note)

The far corners of the bounded-integer / succinct-predecessor literature. Each owns a niche no Tier 1-2
member covers; each is "old but gold" in its subfield; each ships ONLY with the witness AND the honest
caveat (expected-not-worst-case, a distribution assumption, or a within-a-word constant). Build any of
these only after the core roster and only when a real use case names it.

| Structure            | Headline op(s)                        | Bound (flavor)                        | The golden niche it owns |
|----------------------|---------------------------------------|---------------------------------------|--------------------------|
| ExponentialSearchTree | successor / predecessor / add / delete | O(log log n) or O((log log n)^2) DETERMINISTIC dynamic | The deterministic dynamic predecessor structure (Andersson-Thorup): O(log log U) WITHOUT the randomized hashing y-fast leans on. The "I need the double-log AND worst-case determinism" member. Subtle (a tree of exponentially-growing degree over sketched keys); the honest "here is the price of dropping the coin flip" teaching case. |
| InterpolationSearchTree | successor / predecessor / member    | O(log log n) EXPECTED (smooth key distribution) | The distribution-aware member: for keys drawn from a smooth/near-uniform distribution, interpolation search hits O(log log n) EXPECTED -- and degrades to O(log n) / O(n) on adversarial keys, which the witness must show. Old but gold (Willard, Mehlhorn-Tsakalidis). The honest "measure YOUR key distribution" specialist, the loglogn cousin of lite-filter's "measure your own keys". |
| WaveletMatrix        | rank / select / quantile / rangeCount  | O(log sigma) per op                    | Rank/select/quantile over a sequence from an integer alphabet -- the succinct range member. Overlaps [[lite-logn]]'s WaveletTree candidate; the boundary call is which package owns it (lean: the succinct/bit-packed WaveletMatrix form lives HERE, on the RankSelectBits substrate; the pointer form is lite-logn's). Cross-linked, not duplicated. |
| DynamicFusionNode    | predecessor within one node            | O(1) predecessor over ~w^{1/2} keys    | The modern building block (Patrascu-Thorup): pack ~sqrt(w) keys into a single machine word and answer predecessor in O(1) by word-parallel comparison -- the deterministic dynamic replacement for a fusion-tree node. Deeply exotic, w=32-capped in JS; a research-track note on "how O(1)-within-a-word predecessor is even possible", not an early ship. |
| VebLayoutSearch      | static predecessor over a sorted array | O(log n) but CACHE-OBLIVIOUS (van Emde Boas memory layout) | Not a new bound but a new LAYOUT: store a static search tree in van-Emde-Boas memory order so binary search is cache-oblivious (O(log_B n) block transfers with no knowledge of B). The bridge between the vEB NAME (recursion) and the vEB LAYOUT (memory); a beautiful teaching cross-link to lite-o1's cache-proxy benchmark dimension. Static. |

### The boundary -- explicitly NOT in lite-loglogn (out of scope, and why)

Naming the boundary is the honesty discipline (as lite-lru kept LIRS out of v1, lite-o1 keeps heaps out,
and lite-logn keeps vEB out -- pointing HERE). These are fine structures, but they do not belong here:

- **O(1) integer structures** -- sparse set, ring deque, union-find, bucket queue, hash map. That is
  [[lite-o1]]. A bounded-integer priority queue by bucket is O(1) (Dial); lite-loglogn's members answer
  ORDER (predecessor/successor), which a bucket queue cannot in O(1).
- **O(log n) comparator structures** -- binary heap, skip list, Fenwick, segment tree, balanced BST. That
  is [[lite-logn]]. lite-loglogn beats O(log n) ONLY by requiring bounded INTEGER keys; the moment keys
  are general comparables or the universe is unbounded, the correct tool is a lite-logn member. The README
  must say this in the first screen.
- **General comparator keys / strings / floats-as-keys** -- the word-RAM trick needs integer keys in a
  known universe. Float or string keys must be order-preservingly encoded into integers by the CALLER (a
  documented recipe), or they belong in lite-logn.
- **Unbounded / 64-bit-plus universes on the hot path** -- JS bitwise ops are 32-bit. A > 32-bit universe
  is a labeled `SegmentedU` variant (Tier 2) or out of scope; never a silent BigInt hot path.
- **Approximate membership / sketches** -- Bloom/quotient/cuckoo/HLL are [[lite-filter]]. lite-loglogn is
  EXACT.

If a use case wants "sub-logarithmic but the keys are not bounded integers," the honest answer is: there
is no such deterministic structure -- use [[lite-logn]]. lite-loglogn holds the line at the
double-logarithm precisely because it holds the line at the bounded integer universe.

---

## 5. The Honesty Hooks (bound-in-U, the flavor, and the SPACE price)

This family carries THREE honesty hooks, one more than its siblings, because the double-logarithm comes
with strings the reader must see:

**(a) The bound is in U, not n.** O(log log U) is stated with U, always. For 32-bit keys `log log U <= 5`,
so on a FIXED universe these are effectively small-constant-time structures whose win over O(log n) is a
real but BOUNDED factor that only materializes as `n` grows past the crossover (section 2's n-sweep). The
witness reports the crossover `n` as a fact; the README never implies "log log U beats log n" without "for
n above K on a w-bit universe." Conflating log log U with log log n is the dishonesty this family refuses.

**(b) The time flavor.** Like lite-logn:
- **Worst-case O(log log U)** -- vEB, StratifiedBitset (as O(log_w U)). Every single op is bounded. The
  strongest promise; preferred for the core.
- **Expected / amortized O(log log U)** -- y-fast trie (bucket splits/merges amortize; the representative
  BSTs are expected). Ship deterministic seeding where RNG is involved, document the tail, let the witness
  report the ACTUAL distribution. This is lite-loglogn's "measure your own workload."
The witness reports MAX single-op time so an amortized spike or a rehash shows as a tall bar.

**(c) The SPACE price -- the defining caveat (this family's BlockedBloom-FPR-floor).** Speed is only half
an honest claim here; the other half is footprint, and it is stated on every member with the SAME
prominence as the time bound:
- **vEB: O(U).** A 2^24 universe is ~megabytes of summary/cluster arrays even for a handful of keys; 2^32
  is infeasible. vEB is for MODEST universes; the card and README say so and point to y-fast for large U.
- **x-fast: O(n*w).** Fast query, but w level-entries per key.
- **y-fast: O(n).** The space fix -- the practical member for large universes.
- **StratifiedBitset: O(U/w).** One bit per universe slot plus the summary pyramid (~1/31 overhead);
  excellent when the universe is modest OR dense, independent of a per-key node cost.
The benchmark's dimension 4 (memory) is a co-headline, not an afterthought, precisely because of this.

Fixed-capacity / fixed-universe members that fail closed (rather than silently growing a level table and
paying an amortized rehash) are PREFERRED, matching the suite's "fail closed on every unverified state"
law. Where growth is offered (the level tables), its amortized cost and its rehash tail are labeled.

---

## 6. Boundaries with sibling packages (no duplication)

The suite ships one clear niche per package. lite-loglogn must not re-implement what a sibling owns:

- **[[lite-logn]]** (the O(log n) family) is the closest sibling and the intended pair: lite-logn holds
  the logarithm with GENERAL comparator keys; lite-loglogn beats it to the double-logarithm by REQUIRING
  bounded integer keys. Cross-link heavily; the O(log n) foil in every lite-loglogn witness IS a lite-logn
  member (or an equivalent), and the "when do I use which" table lives in both GUIDEs. Keep the witness
  harnesses recognizably kin (flat / straight-log / straight-loglog lines, same fit machinery).
- **[[lite-o1]]** (the O(1) family) -- a bounded-integer O(1) membership/priority need goes there
  (SparseSet, Dial). lite-loglogn is chosen only when ORDER (predecessor/successor) is required.
- **NodePool / LevelTable / lite-o1 `SlotPool` / lite-arena** -- ONE free-list / open-addressing integer
  substrate across the suite. The x-fast/y-fast level tables and lite-o1's SparseSet and lite-logn's
  NodePool are the same DNA; reconcile ownership before the first level-table member. Do NOT fork. (The
  single most important cross-package call, shared with lite-logn.)
- **[[lite-fastbit32]]** (branchless 32-bit flag manager) -- the `clz32`/`ctz`/next-set-bit word
  primitives the stratified bitset needs are its territory; use it as a policy-local dev dependency or
  cross-link the recipe, never a reimplementation that drifts.
- **[[lite-filter]]** owns approximate membership; lite-loglogn is EXACT. No overlap.

---

## 7. Reference Implementation: StratifiedBitset (the headline member)

The cleanest demonstration of "recurse on the universe" with real, correct, allocation-free code:
array-embedded, no nodes, no level tables. A pyramid of `Uint32` bitsets, each higher level a summary of
the level below (one bit per 32 words), so `successor` climbs to find the next nonzero summary and
descends picking the lowest set bit -- O(log_w U) levels, each a single `clz32`-class word op.

```js
/**
 * StratifiedBitset -- a zero-GC sub-logarithmic integer set over a bounded universe [0, U).
 *
 * Bits live in a pyramid of Uint32Array levels: level 0 is the raw bitset (U bits), and
 * each higher level has one bit per 32-bit WORD of the level below (set iff that word is
 * nonzero). add/delete/has are O(levels); successor/predecessor climb to the next nonzero
 * summary then descend by lowest/highest set bit. levels = ceil(log32(U)) -- 7 for U=2^32.
 * That is O(log_w U): a handful of `clz32` word ops, no allocation per op, no nodes. `null`
 * is not zero: an absent successor returns undefined, never key 0.
 *
 * Space is O(U/w) (~1.03 bits per universe slot) -- footprint scales with the UNIVERSE, the
 * family's defining trade (section 5). Best for modest or dense universes.
 */
export class StratifiedBitset {
    constructor(universe) {
        if (!Number.isInteger(universe) || universe < 1 || universe > 2 ** 32)
            throw new RangeError("[lite-loglogn] universe must be an integer in [1, 2^32]: " + String(universe));
        this._u = universe;
        this._levels = [];
        let words = Math.ceil(universe / 32);
        for (;;) {                                   // build the summary pyramid bottom-up
            this._levels.push(new Uint32Array(words));
            if (words <= 1) break;
            words = Math.ceil(words / 32);
        }
        this._size = 0;
    }

    get size() { return this._size; }
    get universe() { return this._u; }

    /** Membership. O(1). A bad key is ABSENT, never a throw (null is not key 0). */
    has(x) {
        if (typeof x !== "number" || (x >>> 0) !== x || x >= this._u) return false;
        return (this._levels[0][x >>> 5] & (1 << (x & 31))) !== 0;
    }

    /** Insert x. O(levels): set the bit at every level. Fail closed on a bad key. */
    add(x) {
        if (typeof x !== "number" || (x >>> 0) !== x || x >= this._u)
            throw new RangeError("[lite-loglogn] key out of universe [0, " + this._u + "): " + String(x));
        if (this.has(x)) return this;                // idempotent; size counts distinct keys
        let idx = x;
        for (let L = 0; L < this._levels.length; L++) {
            this._levels[L][idx >>> 5] |= (1 << (idx & 31));
            idx >>>= 5;                              // one summary bit per 32 words below
        }
        this._size++;
        return this;
    }

    /** Remove x. O(levels): clear upward while a word empties. true iff present. Never throws. */
    delete(x) {
        if (!this.has(x)) return false;
        let idx = x;
        for (let L = 0; L < this._levels.length; L++) {
            const word = idx >>> 5, bit = 1 << (idx & 31);
            this._levels[L][word] &= ~bit;
            if (this._levels[L][word] !== 0) break;  // stop climbing once the word is still nonzero
            idx = word;                              // the emptied word clears its summary bit above
        }
        this._size--;
        return true;
    }

    /** Smallest present key > x (STRICT, as shipped), or undefined. O(levels): climb to a nonzero summary, descend. */
    successor(x) {
        if (typeof x !== "number" || (x >>> 0) !== x) return undefined;
        if (x >= this._u) return undefined;
        let idx = x, L = 0;
        // Climb: at each level, mask the current word for bits at/above idx; if none, go up.
        for (; L < this._levels.length; L++) {
            const word = idx >>> 5;
            const masked = this._levels[L][word] & (0xFFFFFFFF << (idx & 31)); // bits >= idx in this word
            if (masked !== 0) { idx = (word << 5) + ctz32(masked); break; }    // found in this word
            idx = (word >>> 5) + 1;                  // advance to the next word's summary position
            if ((idx << (5 * L)) >= this._u && L + 1 >= this._levels.length) return undefined;
        }
        if (L >= this._levels.length) return undefined;
        // Descend: from the summary bit just found, pick the lowest set bit at each lower level.
        for (; L > 0; L--) {
            L--;                                     // paired step handled by the loop body below
            const child = this._levels[L][idx];
            idx = (idx << 5) + ctz32(child);
            L++;
        }
        return idx < this._u ? idx : undefined;
    }

    /** The minimum present key, or undefined. O(levels): descend from the top summary. */
    min() {
        const top = this._levels[this._levels.length - 1];
        if (top[0] === 0 && this._size === 0) return undefined;
        let idx = 0;
        for (let L = this._levels.length - 1; L >= 0; L--) {
            const child = this._levels[L][idx];
            if (child === 0) return undefined;
            idx = (idx << 5) + ctz32(child);
        }
        return idx < this._u ? idx : undefined;
    }

    /** Empty in O(total words): zero every level. Not a hot-path op. */
    clear() { for (let L = 0; L < this._levels.length; L++) this._levels[L].fill(0); this._size = 0; }
}

/** Count trailing zeros of a nonzero 32-bit word, via clz32 -- the O(1) word-RAM primitive. */
function ctz32(v) { return 31 - Math.clz32(v & -v); }
```

The teaching beat: `add`/`delete`/`successor` each touch one word per level, and there are
`ceil(log32(U))` levels (7 for a full 32-bit universe), so the cost is a small constant number of `clz32`
word ops -- the witness's near-flat line, made of bitwise ops and zero allocation. The foil (a lite-logn
skip list, or a single flat bitset scanned linearly for the successor) climbs off that line as the data
grows or the gaps widen. (The `successor` descend loop above is written to show the climb/descend
structure; the coder session will tighten its index bookkeeping and prove it against a brute-force oracle
-- see section 11's threshold note.)

Why it is the headline (the BinaryHeap-equivalent, per lite-logn): it is the ONE member that is fully
array-embedded, provably zero-GC with no substrate to settle first, correct in a page of code, and gives
the cleanest witness -- so it brings up the `logLogWitness` harness and the standing torture/perf gates in
session 1, before the harder recursive/level-table members.

---

## 8. Experimental Direction: the x-fast trie (the trick worth teaching)

The member whose Big-O is most delightfully non-obvious and most in need of the witness: `successor` in
O(log log U) by BINARY-SEARCHING the `w` levels of a bit-prefix trie. "How is finding the next integer a
binary search over the KEY'S BITS rather than over the data?" is exactly the claim a reader should demand
proof of.

The idea (substrate to be finalized in its session, hence "direction," as lite-logn treated SkipList):

- A key `x` of `w` bits has `w+1` prefixes (the empty prefix, the top bit, the top two bits, ...). Level
  `k` holds the set of length-`k` prefixes that are prefixes of some present key -- stored as an
  open-addressing `Uint32Array` LevelTable (prefix -> slot), NOT a hash of node objects.
- A present prefix at level `k` records, on a leaf-threaded doubly-linked list of the actual keys, the
  MIN and MAX key under it. The leaves (level `w`) are the keys themselves, threaded in sorted order by
  `succ`/`pred` index columns (pointer-free).
- **`successor(x)`**: binary-search the `w` levels for the LONGEST present prefix of `x` (present at level
  `mid` => search longer; absent => search shorter). That longest present prefix's stored min/max leaf,
  plus one hop on the threaded leaf list, is the successor. The binary search is `O(log w) = O(log log U)`
  level probes, each an O(1) LevelTable lookup.
- **`add`/`delete`**: touch all `w` levels (insert/remove each prefix) and splice the leaf thread --
  O(w) = O(log U), and O(n*w) space. THIS is the honest caveat, and it is the whole motivation for the
  y-fast trie (section 4): put only O(n/w) REPRESENTATIVES in the x-fast trie and hang balanced buckets of
  O(w) keys off each, dropping space to O(n) and update to O(log log U) amortized.

```js
// Sketch of the successor binary-search over levels (the log log U heart):
//   lo = 0, hi = w;  // search the prefix LENGTH
//   while (lo < hi) {
//       const mid = (lo + hi + 1) >> 1;
//       if (levelTable[mid].has(x >>> (w - mid))) lo = mid;   // this prefix is present -> go longer
//       else hi = mid - 1;                                    // absent -> go shorter
//   }
//   // levelTable[lo] holds the longest present prefix p of x; its stored min/max leaf +
//   // one threaded-leaf hop gives successor(x). Each `has` is an O(1) Uint32 LevelTable probe;
//   // the loop runs O(log w) = O(log log U) times. Zero allocation per query.
```

Why it is the "experimental direction" slot (the Fenwick / UnionFind counterpart in the siblings): the
binary-search-over-bit-lengths is the trick that BUYS the double-log, it is invisible until you see it, and
the witness turns "trust me, successor is O(log log U)" into a measured near-flat line across the U-sweep.
The full zero-GC x-fast trie (LevelTable substrate + threaded pointer-free leaves) and its y-fast wrapper
are their own sessions once the LevelTable ownership (section 6) is settled.

---

## 9. The Demo (in the style of lite-lru / lite-o1 / lite-logn)

A repo-only dev artifact, never shipped in the tarball, modeled beat-for-beat on the siblings' demos:

- **One shared op-stream fed to all members side by side.** The "trace" is a seeded stream of integer ops
  (adds/deletes/successor/predecessor queries) over a chosen universe U and size n. Each panel is drawn
  STRICTLY from that member's live `dump()`/`inspect()` snapshot -- no shadow state.
- **The headline stat is the O(log log U) witness -- shown as TWO dials.** A ns/op reading with the
  double-log fit, AND, crucially for this family, a bytes/element (or bytes/universe-slot) reading beside
  it: the demo never shows speed without space. As you crank U up by orders of magnitude, the member's
  latency point barely moves (the double-log) while its MEMORY dial climbs for vEB and holds for y-fast --
  the trade-off made visible. A second lane runs the O(log n) [[lite-logn]] foil, whose latency climbs and
  crosses above as n grows: the "when the double-log wins" moment, live.
- **Each panel draws the STRUCTURE, from its snapshot.** StratifiedBitset: the summary pyramid, the
  climb/descend path lighting up on each successor. vEB: the summary + clusters recursion, the O(log log U)
  descent highlighted. x-fast/y-fast: the level tables and the binary-search-over-levels probing, the
  threaded leaf list.
- **Architecture mirrors the five-file demo.** `Visualize.mjs` (headless engine, imports only the package
  main, Node-main prints a per-member ns/op + fit + bytes table), `renderers.mjs` (pure, one renderer per
  member, each declares its snapshot `fields` + a `model(snap)` the test deep-equals against `dump()`),
  `serve.mjs` (zero-dep http, computes the seeded op-stream + the foil timings, serves statics),
  `visuals.html` (dark terminal-green, one canvas panel per member, controls: structure / workload / seed
  / **U** / **n** / play / step / speed), `Demo.test.mjs` (model==dump, renderer teeth, determinism,
  zero-alloc engine step, leak-free build/run/reset, fail-closed serve + fetch matrix).
- **The honesty caveats rendered:** the max single-op bar for the amortized y-fast trie; the SPACE dial
  always beside the speed dial; and a "universe" readout so the viewer never forgets the bound is in U.

The demo and any build/insertion animations are their own later sessions, as with the siblings; the first
demo shows steady-state ops + the doubly-logarithmic-growth witness + the space dial.

---

## 10. Recommended Path

1. Settle the model + substrate FIRST (a short pre-member-1 discussion, section 11): the word-RAM /
   bounded-universe framing and the EXACT identity wording (O(log log U), bound-in-U, space co-headline);
   the LevelTable/NodePool ownership against [[lite-o1]]'s SlotPool / [[lite-logn]]'s NodePool /
   lite-arena (so the x-fast/y-fast members do not fork an allocator); and the `clz32` word-primitive
   boundary vs [[lite-fastbit32]].
2. Ship **StratifiedBitset** as the headline member (array-embedded, provably zero-GC with no substrate to
   settle first, the cleanest witness) + the `logLogWitness` harness (section 2, both sweeps) as a core
   feature from day one, alongside the standing zero-alloc perf gate (@zakkster/lite-perf-gate).
3. Add **XFastTrie** (the trick worth teaching -- binary search over levels; introduces the LevelTable
   substrate) once LevelTable ownership is settled, then **YFastTrie** (the O(n)-space fix, the practical
   member), then **vEBTree** (the worst-case recursive showpiece, flattened for zero-GC, O(U) space stated
   up front).
4. Ship the demo (section 9) once 3-4 members exist, so the witness comparison and the space dial have
   range.
5. **ADOPT the completed benchmark suite (section 3):** the eight-dimension framework is DONE in lite-o1
   (Bench v2 -- `Template.mjs` + `METHODOLOGY.md` written for the siblings to copy). Port it verbatim,
   then add the U-sweep double-log fit (dimension 1), the O(log n) foil + crossover, and the loglogn-
   specific MEMORY kernel (footprint vs U AND n) promoted to co-headline. A copy-and-wire session (plus
   the one new kernel), not a design-from-scratch one; do it once 3-4 members exist.
6. Move into Tier 2: EliasFano (amended 2026-10-20: shipped in lite-o1 1.9.0; re-adopt, do not rebuild), RoaringSet (the
   practical space-adaptive set), FusionTree (research-track, honest "when it pays" note), IntUniverseMap
   (value column), SegmentedU (wider keys) -- one concept per release.
7. **Tier 4 (exotic but a golden niche)** -- ExponentialSearchTree (deterministic dynamic log log n),
   InterpolationSearchTree (expected log log n for smooth keys), WaveletMatrix (succinct range, boundary
   with lite-logn), DynamicFusionNode (O(1)-within-a-word predecessor), VebLayoutSearch (the cache-
   oblivious vEB LAYOUT) -- each a dedicated future member built ONLY when a real use case names it, each
   shipped with the witness AND its honest caveat (expected-not-worst, a distribution assumption, or a
   within-a-word constant). The "old but gold / exotic" reserve, not the near-term queue.
8. [Gate wording superseded 2026-10-22 by decisions/0004 Amendment 1: counts are the hard gate, fits REPORTED.] Every member proven by `node --expose-gc test/torture.mjs` (0 B/op) AND the witness gate (the
   double-log fit stays within its `R^2` floor and slope band across the U-sweep, and beats the O(log n)
   foil past the reported crossover on the n-sweep) AND the perf gate AND a stated SPACE number. No gate
   output is a FAIL.

Cadence (per the user, mirroring lite-o1 / lite-logn): ONE member per session, DISCUSSION-DRIVEN -- the
planner produces the spec, it comes back to the user to study and refine BEFORE any code, then
coder -> reviewer -> qa + the torture, witness, and perf gates. A+ bar per member.

---

## 11. Open Questions

- **The package name.** RECOMMENDED: `@zakkster/lite-loglogn` -- folder `LiteLogLogN` (already created),
  single PascalCase main file `LogLogN.js`, error tags `[lite-loglogn]`; the exact parallel of
  `lite-logn` / `LogN.js`. Rejected leans (confirm with the user): `lite-loglog` (drops the `n`, reads as
  "log of a log" with no structure connotation) and `lite-log-log-n` (npm hyphen-token discoverability
  problem, the same reason `lite-logn` beat `lite-log-n`). DECIDE before scaffolding.
- **The identity wording -- the load-bearing call.** Is the package "strictly O(log log U)
  (vEB/x-fast/y-fast), with StratifiedBitset as an O(log_w U) practical cousin," or "sub-logarithmic
  bounded-integer predecessor/successor, spanning O(log_w U) to O(log log U)"? This decides the headline
  member (StratifiedBitset vs vEB), the witness's primary axis, and every card. Lean: the latter, honest
  framing with StratifiedBitset first -- but it is the user's call and shapes everything.
- **The witness's fit thresholds.** [SETTLED 2026-10-22 by decisions/0004 Amendment 1 + 0006: no R^2 floor or slope band is gated.] What `R^2` floor and slope band make a fair, non-flaky gate across a
  SHORT bit-width sweep (only ~5 points: w = 16..32) and CI noise? The short axis is the real risk -- fewer
  points than lite-logn's n-sweep. Settle empirically in the StratifiedBitset session; expect the same
  steady-window / median-of-9 / do-not-widen-the-floor discipline as lite-o1's flatness gate
  (ADR-0004 amendment), and record it in an ADR. The n-sweep crossover vs the O(log n) foil may be the
  more robust gate than the U-sweep fit -- decide which is the hard gate and which is reported.
- **LevelTable / NodePool ownership.** Re-export lite-o1's `SlotPool`, depend on lite-arena, share
  lite-logn's NodePool, or ship a separate open-addressing integer table? The single most consequential
  cross-package call (section 6). Blocks x-fast/y-fast; StratifiedBitset and vEB (flattened) do not need
  it, so it can wait until the XFastTrie session -- but decide the DIRECTION before member 1.
- **The 32-bit ceiling.** JS bitwise ops are 32-bit, so the natural universe is <= 2^32. Is a 53-bit
  (double-safe-integer) or 64-bit `SegmentedU` variant in scope, and is it a split-word Tier-1 concern or
  a Tier-2 labeled variant? Lean: 32-bit default, `SegmentedU` as Tier 2.
- **vEB flattening strategy.** Recursive-object vEB is the textbook form but allocates; the zero-GC form
  flattens the summary+clusters recursion into typed arrays (a vEB-layout array, or an iterative
  high/low-word split). Which flattening keeps the worst-case O(log log U) AND 0 B/op AND stays readable
  enough to teach? Settle in the vEBTree session.
- **Benchmark framework -- RESOLVED (user, 2026-09-16): ADOPT, do not fork or reinvent.** lite-o1's
  Bench v2 is complete and shipped a `Template.mjs` + `METHODOLOGY.md` expressly for the siblings to copy.
  lite-loglogn ports that harness verbatim (a dev-only shared blueprint, zero RUNTIME deps preserved) and
  adds only the U-sweep double-log fit, the O(log n) crossover foil, and the loglogn-specific MEMORY
  kernel (footprint vs U) as the co-headline dimension. The only open sub-questions are calibrating the
  witness thresholds over the short bit-width sweep (the item above), not the harness.
- **What does further user research add or reorder?** (This roster folds in the user's candidate list --
  vEB, x-fast, y-fast, fusion -- plus the StratifiedBitset entry point; treat any additional notes as
  authoritative input at planning time.)

---

## 12. RoaringSet -- design notes (addendum 2026-10-20)

Sources: a maintainer Q&A in the lite-o1 session of 2026-10-20; the papers (Chambi, Lemire,
Kaser, Godin 2016; Lemire et al. 2016 for run containers); `../Research/BITWISE_RESEARCH.md`
section 10 (the five tests, the summary-generalization rule, the bitset size ladder). Nothing
here is measured. Brief: `ROADMAP.md` section 10 (R1-R3, D-R1 to D-R4).

### 12.1 Standard Roaring, as the starting point

- **Two-level split.** For a 32-bit value v, the high 16 bits (`v >>> 16`) pick the chunk, and
  the low 16 bits (`v & 0xFFFF`) are stored in that chunk's container. Only non-empty chunks
  exist. The top level is a sorted array of keys with parallel container and type-code columns.
- **Three containers:**

| Container | Used when | Space | `has` | Notes |
| --- | --- | --- | --- | --- |
| array | cardinality <= 4,096 | 2 B per value (sorted `Uint16`) | binary search, <= 12 probes | insertion shifts up to 4,096 entries |
| bitmap | cardinality > 4,096 | 8 KB fixed (2,048 `Uint32` words in JS) | one bit test, O(1) | bulk AND / OR word by word |
| run | `runOptimize` finds runs smaller | 2 + 4 x runs bytes, as (start, length - 1) pairs | binary search over runs, <= 11 probes (<= 2,048 runs) | for clustered / sorted data |

- **Why 4,096:** 2 B x 4,096 = 8,192 B = one bitmap container, so the representations cost the
  same there. Below it the array is smaller; above it the bitmap is.
- **Set algebra** aligns the two key arrays, then combines containers by type pair (bitmap x
  bitmap is word-wise; array x array uses galloping intersection). A container present in only
  one operand is copied or dropped, depending on the operation.
- **Portable format** (RoaringFormatSpec): a cookie, a header with (key, cardinality - 1) per
  container, an optional offset table, then the containers. Java / C / Go / Rust bitmaps are
  interchangeable through it.

### 12.2 The proposed change: a summary pyramid at both levels

Standard Roaring finds the next non-empty chunk by binary search over the keys, and finds the
next set bit inside a bitmap container by scanning up to 2,048 words. Both can be replaced by
lite-o1 BitSet's existential summary (BITWISE 10.1 explains why this is exact for "non-empty"):

- **Between chunks:** a 2^16-bit presence bitmap over the keys, with summary levels, so the next
  non-empty chunk is a bounded walk.
- **Inside bitmap containers:** a FastBit1024-style two-level summary (2,048 words -> 64 -> 2).
  It costs about 3% per container, and the next set bit becomes a bounded walk. Copied by design
  parity from lite-fastbit32; no dependency.
- **Result:** `successor` over the full 32-bit universe touches about 30 directory words in the
  worst case, independent of n. That number is NOMINAL and unmeasured; the witness must count
  probes, not time them.
- **Risk:** every bulk op (union / intersect / clear / conversion) must leave both summaries
  coherent. A stale summary bit silently corrupts `successor`. This is the same trap
  `../LiteO1/ROADMAP.md` records for BitSet's bulk ops.

### 12.3 Honest bounds (state them in the README from the first draft)

| Op | Bound | Why |
| --- | --- | --- |
| `has` | bounded O(log): <= 16 key probes (or O(1) with a direct key table) + <= 12 inside an array container | never "O(1)" for the set as a whole |
| `successor` / `predecessor` | bounded walk (nominal ~30 words) with 12.2; O(log) without it | independent of n either way |
| `add` / `delete` | bounded, but up to a 4,096-entry shift in an array container, plus conversions | prints a max-single-op line |
| `union` / `intersect` | O(containers + their sizes) | bulk, disclosed |
| space | adaptive; never above about 8 KB per non-empty chunk + the top level | the SPACE co-headline (section 5) |

### 12.4 Zero-GC in JS

- Container growth and conversion allocate unless they come from a pool. Use fixed 8 KB slabs for
  bitmaps, and capacity classes for array and run containers; a conversion moves a container
  between pools.
- Pool growth is a cold, disclosed allocation, never on a hot op. Peer: lite-arena, by design
  parity.
- There is no SIMD and no 64-bit popcount in JS: use `Uint32` words and the SWAR popcount from
  lite-fastbit32's field guide. Never BigInt (BITWISE section 7: 30x slower, and it allocates).

### 12.5 Open questions

1. Is there a real consumer? lite-search keeps `Map<gram, Set<id>>` (`../LiteSearch/Search.js:189`),
   but it scores overlap counts rather than intersecting sets. Find one before positioning this
   as a product rather than a teaching member.
2. Prior art in JS: native and WASM ports exist. Is any of them pure JS and zero-GC? Verify
   before claiming the gap. **Answered 2026-10-21 (12.6): one pure-TS port exists (`bitrun`), and
   it allocates per operation. No pure-JS, zero-GC Roaring was found.**
3. D-R1 to D-R4 in `ROADMAP.md` section 10.

### 12.6 JS prior art (addendum 2026-10-21; registry and GitHub pages fetched that day)

**Source:** a maintainer note on Roaring in JS and what it combines with, fact-checked against
registry.npmjs.org and GitHub on 2026-10-21. Download counts are one week (2026-10-12 to 10-18).
The npm search for "roaring bitmap" returns over 1,000 hits, so "none found" below is a lead,
not proof.

| Package | Kind | Facts (2026-10-21) | Zero-GC? |
| --- | --- | --- | --- |
| `roaring` (Salvatore Previti, `SalvatorePreviti/roaring-node`) | native Node addon over CRoaring 4.5.0 | 2.7.0 (2025-12-19); prebuilt binaries via node-pre-gyp, source-build fallback; AVX2 / SSE4.2; portable format; Node only (no browser); Apache-2.0; ~10.7k/week | not applicable: the memory is native and is not visible to the JS heap |
| `roaring-wasm` (same author) | CRoaring compiled to WASM (Emscripten) | 1.1.0 (2024-10-08); Node, browser, Deno (browsers call `roaringLibraryInitialize()` first); portable format; Apache-2.0; ~2.8k/week | the WASM heap is outside the JS GC |
| `@jeange/roaring-wasm` (Jean Ge) | Rust -> WASM (wasm-pack) | 0.1.4 (2026-08-10, first published 2026-08-04); no repo link in its metadata; MIT; ~8/week; portable format UNVERIFIED | unknown |
| `bitrun` (David Estevez, `destbreso/bitrun`) | **pure TypeScript**, zero dependencies | 0.1.3 (2026-08-13); array / bitmap / run containers on typed arrays; claims portable-format byte compatibility (tests against `roaring`, not checked); MIT; ~8/week, 0 stars | **no**: set algebra returns a fresh result per operation, `deserialize` copies into fresh containers, and its README gives ~300 B of typed-array wrapper overhead per non-empty block |
| `fastbitset`, `typedfastbitset` (Daniel Lemire) | pure JS, **plain** (uncompressed) bitsets | 0.5.2 / 0.8.0 (2026-02-26); `typedfastbitset` has in-place ops and a `SparseTypedFastBitSet` | not Roaring; the comparison point for dense sets, like lite-o1 BitSet |

- The RoaringBitmap GitHub org has 22 repositories and none of them is JS, TS or WASM. The Node
  and WASM ports are third-party, though `roaring` calls itself the "official port".
- Not Roaring implementations: `@cloudbitmaps/roaring` (object-storage plumbing over native
  `roaring`), plus several WASM forks and templates (`roaring-wasm-papandreou`,
  `smart-roaring-bitmap-wasm`), and `roaringbun` (Bun FFI to CRoaring).
- **The gap, stated precisely:** native and WASM ports are fast but cannot run where native
  addons are banned (`roaring`), or keep memory outside the GC that must be freed by hand
  (WASM). The only pure-TS port allocates on every set operation. A pure-JS Roaring with POOLED
  containers, in-place / out-param set algebra and 0 B/op hot paths does not exist on npm as far
  as this search found. That is a real niche, **but test 1 (a consumer) is still open (12.8)**.
- Consequences for the API (they go into R2 / R3, see `ROADMAP.md` section 10):
  - set algebra writes into a caller-supplied target (`a.and(b, out)`) or works in place
    (`a.andInPlace(b)`); it never returns a fresh set on a hot path;
  - add counting forms that materialize nothing: `intersectionSize(a, b)`, `intersects(a, b)`,
    `unionSize(a, b)`. CRoaring has the same idea (`and_cardinality`);
  - deserialization fills pooled containers, so it allocates only on pool growth.

### 12.7 Reading the portable format in JS: traps (from the spec; not yet prototyped)

Spec: `github.com/RoaringBitmap/RoaringFormatSpec` (checked 2026-10-21). Cookie 12346 =
`SERIAL_COOKIE_NO_RUNCONTAINER`, 12347 = `SERIAL_COOKIE`, and the offset header is present for
12346, or for 12347 when there are at least `NO_OFFSET_THRESHOLD` = 4 containers.

- **Alignment.** With cookie 12347, the run-container bitset is ceil(n / 8) bytes, so every field
  after it can start at an ODD byte offset. `new Uint16Array(buf, off)` throws a `RangeError` on an
  odd offset, and a `Uint32Array` view over a bitmap container needs a multiple of 4. A reader
  must use `DataView` reads, or copy each container into an aligned pooled slab. Never assume
  aligned views over a foreign stream.
- **Endianness.** The format is little-endian. Typed arrays use the host's byte order. Every
  practical JS host is little-endian, but the reader checks once at load (a `Uint16Array` /
  `Uint8Array` probe) and fails closed on a big-endian host, or reads through `DataView` with
  `littleEndian = true`.
- **Validation (fail closed, each with a must-fail stream):**
  - keys strictly increasing;
  - each container's type matches its cardinality (cardinality - 1 <= 4,095 is an array unless
    the run bit is set);
  - run pairs neither overlap nor pass 65,535;
  - offsets and lengths stay inside the buffer;
  - the stream does not end early.

  A malformed stream must throw, never yield a partial set.
- **A zero-copy read-only view** (a candidate, not yet in R1-R3): with the offset header, `has`
  and `successor` can binary-search the keys and jump straight to one container without parsing
  the rest. That gives a `RoaringView` over an `ArrayBuffer` with no per-container allocation,
  which suits sets shipped to a browser or a worker. It inherits the alignment trap above, so it
  reads through `DataView`, or it requires the caller to pass a stream that is aligned and was
  validated once.
- CRoaring's "frozen" serialization is a different, aligned format and is not portable across
  implementations. Do not confuse the two (UNVERIFIED detail: check the CRoaring docs before
  citing it).

### 12.8 What Roaring combines with, scored against this suite (addendum 2026-10-21)

The maintainer note lists the standard combinations (A-J). Roaring is a 32-bit integer-set
primitive inside an outer index. Each combination is scored here against a real consumer in this
suite. Consumers were found by sweeping every package's main source for "key -> set of numeric
ids" on 2026-10-21.

| # | Combination | Suite consumer (file:line) | Verdict |
| --- | --- | --- | --- |
| A | inverted index (term -> ids) | **lite-search** `gramIndex: Map<gram, Set<id>>` (`../LiteSearch/Search.js:175`, `:189`). Ids come from `++autoId` for objects (`:168`), but `Search.d.ts:36` allows `string \| number`, so string ids need interning first | **the only real lead.** The query scores n-gram OVERLAP with a counting `Map` (`:181`), which is the T-occurrence problem (ScanCount / MergeOpt; Li, Lu, Lu, ICDE 2008), not a plain AND. Roaring helps memory and candidate iteration. A threshold count needs counters or a bit-sliced sum (row K). Measure memory against `Set` first |
| B | map of bitmaps (tag -> ids) | `../LiteAudioManager/AudioManager.js:23-24` (sound name -> active play ids), `../LiteAudio/Compat.js:110`, `../LiteMedia/Media.js:217` (root -> rule ids) | no: these sets hold a handful of ids, and `Set` wins below thousands |
| C | ordered map whose values are bitmaps | none; lite-logn C1 `BPlusTree` is awaiting a decision, and section 7's `IntUniverseMap` is the composition point | later, as a recipe once both exist |
| D | per-value bitmap index for low-cardinality columns | lite-table T2 (`../LiteDataTable/ROADMAP.md`) is a bitmap index inside a bounded row universe | no: rows <= 2^25 fit lite-o1 BitSet or a rank directory. Roaring only above 2^25 rows or for very sparse columns |
| E | graph adjacency | the suite's graphs (lite-di-graph, lite-canvas-graph) are small | no consumer |
| F | hierarchical index over Roaring | this IS RoaringSet's D-R1 (b) + D-R2 design (12.2) | already planned |
| G | ECS live-slot set | lite-ecs E1 (`../LiteEcs/ROADMAP.md`) | no: slot ids are dense, so SparseSet / BitSet beat Roaring. E1 uses query sets |
| H | event / version sets | lite-journal keeps per-reader cursors over a ring; a "changed since T" bitmap cannot serve several readers | no |
| I | ACL / feature flags | none in the suite | no consumer |
| J | dense BitSet for the hot window + Roaring for the cold tail | none | hold. Note BITWISE 10.1: an AND across the two tiers cannot use the summaries |
| **K** | **bit-sliced index (BSI)**: one bitmap per bit of a numeric column, so `value >= x`, `between` and `sum over a set` become bitmap arithmetic (O'Neil and Quass, SIGMOD 1997; RoaringBitmap Java ships a `bsi` package, UNVERIFIED here) | lite-table numeric column filters (none today); lite-search threshold counts (A) | hold: not in the note, and the natural R2 follow-up if A becomes a consumer |
| **L** | Roaring next to EliasFano (lite-o1 1.9.0) | boundary docs | a boundary line, not a feature: EliasFano is smaller for STATIC sorted lists with uniform gaps; Roaring is dynamic, with fast set algebra |
| **M** | Roaring next to HyperLogLog (lite-sketch) | boundary docs | Roaring gives EXACT union and intersection sizes; HLL gives approximate ones across thousands of sets in kilobytes. A boundary line |

- **The pattern the note names is right:** an outer index (hash / B-tree / sorted array) -> a
  Roaring set of 32-bit ids -> an optional per-id payload. In this suite: interning (strings ->
  dense ints) -> RoaringSet -> `IntUniverseMap` for payloads.
- **The note's practical advice ("prefer the native `roaring` on Node") holds for applications.**
  It cannot apply inside this suite, because of the zero-runtime-deps law. It also hides two
  costs worth stating:
  - every single-element call into a native addon crosses the N-API boundary, so per-element
    `add` / `has` loops lose to batch APIs (EXPECTED, not measured);
  - WASM memory is outside the GC. Sets must be freed by hand, and a `memory.grow` detaches
    every typed-array view over the old buffer.
- **Corrections to the note:**
  - `roaring` is a native addon with prebuilt binaries, and has no browser support;
  - `roaring-wasm` and `@jeange/roaring-wasm` are different packages by different authors, and
    the second is six weeks old;
  - `bitrun` exists but is weeks old and lightly used (about 8 downloads a week, 0 stars), with
    self-reported benchmarks only (1.3-14x slower than native);
  - Lemire's JS packages are plain bitsets, not Roaring;
  - "Redis modules" should read "Redis". The project's own adopter list (`roaringbitmap.org`)
    includes Lucene, Elasticsearch, Druid, Pinot, ClickHouse, Spark, Bleve, Redis, InfluxDB and
    Netflix Atlas;
  - Pilosa / FeatureBase is not on that list (UNVERIFIED).
- **Papers (confirmed via `roaringbitmap.org/publications/`):**
  - Chambi, Lemire, Kaser, Godin, SPE 46(5):709-719, 2016, arXiv 1402.6407;
  - Lemire, Ssi-Yan-Kai, Kaser, SPE 46(11):1547-1569, 2016, arXiv 1603.06549 (run containers);
  - Lemire, Kaser, Kurz, Deri, O'Hara, Saint-Jacques, Ssi-Yan-Kai, SPE 48(4), 2018,
    arXiv 1709.07821 (the CRoaring implementation paper).

### 12.9 "RoaringSet" vs "Roaring bitmap"

The two names are the same structure. "Roaring bitmap" is the published design. **RoaringSet**
is this package's name for its own member: an integer SET (has / successor / iterate), not a
bitmap of fixed width. It keeps the 2^16 chunking, the array / bitmap
/ run containers, the 4,096 crossover and the portable format (R3), so it reads and writes the
same bytes. It adds three things standard Roaring does not have:
- a summary pyramid at BOTH levels (D-R1 (b), D-R2), so `successor` is a bounded walk;
- pooled containers with 0 B/op hot paths;
- out-param / in-place set algebra.

Without those three it would be a plain port, and there would be no reason to build it next to
`bitrun`.

### 12.10 Tiers at their best -- the Timsort analogy (maintainer, 2026-10-22)

Timsort does not pick one algorithm: it runs insertion sort on short runs and merges above them,
because each wins in its own range. The suite's bitsets split the same way. Nothing below is
measured; every speed line is EXPECTED until a release-time A/B says otherwise.

| Tier | Model (suite) | Universe | Best at | Missing |
| --- | --- | --- | --- | --- |
| one word | lite-fastbit32 FastBit32 | U <= 32 | flags, masks, lowest / highest in one op | anything past 32 bits |
| 32 words + summary | lite-fastbit32 FastBit1024 | U <= 1,024 | lowest free slot (`acquire`), next set bit through its summary word | predecessor past 1,024 |
| fixed 3-level summary | lite-o1 BitSet | U <= 2^25 | O(1) nextSet; bulk and / or / xor, popcount | predecessor, max, U above 2^25 |
| log_32 U pyramid | StratifiedBitset (this package) | U <= 2^32 | strict successor AND predecessor, min / max, U to 2^32 | bulk set algebra (not in 0.2.0) |
| per-chunk choice | RoaringSet (Tier 2) | 2^32, any density | sparse or clustered sets, compressed space | worst-case O(1) anything |

Where the idea lands: (1) GUIDE.md gets this table as a "which bitset" guide plus a user-side
recipe that imports the packages it needs (docs burst). (2) RoaringSet uses it as its design
rule (ROADMAP section 10). (3) A hybrid tiered member is queued as PROPOSED (ROADMAP section 7,
Tier 2). (4) StratifiedBitset 0.2.0 gets tiered fast paths in one class, a new rung after the
general pyramid is approved, with the general form as its parity oracle
(`.handoff/PLAN-stratifiedbitset.md` ADDENDUM 15+).

---

## 13. Research intake (2026-10-22) -- inverse Ackermann, compositions, exotic candidates

Source: a maintainer Q&A in the StratifiedBitset B1c session, 2026-10-22, added at the maintainer's
request. Every citation was web-checked on 2026-10-22 (venues, bounds and models corrected inline;
the remaining gaps are named where they sit). Nothing here is measured or scheduled. Verdicts: 13.4.

### 13.1 Inverse Ackermann alpha(n): where it applies, and where it cannot

- General dynamic predecessor cannot reach alpha(n). The optimum is a min over regimes (fusion-like
  log_w n, vEB-like log log U), and nothing near alpha is possible with polynomial space (Patrascu and
  Thorup, STOC 2006, pp. 232-240, "Time-space trade-offs for predecessor search"; a STATIC
  cell-probe result whose optimum is a min of four terms; vEB is optimal when w = Theta(log n)
  and space is n polylog n).
- alpha appears only in RESTRICTED problems:
  - **Decremental successor** ("next free slot", delete-only): union-find gives alpha(n) amortized.
    Gabow and Tarjan (JCSS 30(2):209-221, 1985; STOC 1983) give O(m + n) TOTAL time when the
    union tree is known in advance (interval union-find qualifies, general union-find does not),
    on a RAM, with table look-up on small sets plus the general algorithm over blocks. That is StratifiedBitset's level 0 plus union-find over
    its summary.
  - **Interval union-split-find** (both operations): Theta(log log n), the Mehlhorn, Naher and Alt
    lower bound (SIAM J. Comput. 17(6):1093-1102, 1988; ICALP 1987) in the POINTER-MACHINE model, so
    it does not bind word-RAM structures. It is the package's own bound turning up as a lower bound, which makes it a
    good teaching beat.
- Verdict: implementable zero-GC (Int32Array parents, path halving), but at U <= 2^32
  StratifiedBitset's worst successor is 2Lc-1 = 13 word reads at about 1 bit per universe slot, while
  union-find costs 4+ bytes per key and is amortized. A note and maybe a demo comparison, NOT a
  member. Section 4's boundary already puts union-find in lite-o1; a "NextFree" member would need its
  own scope ruling.

### 13.2 Compositions keep the double-log (and JS flattens the ranking)

- Most classic bounds ARE compositions: y-fast = x-fast over representatives + buckets of size
  log U (indirection), log log U time with O(n) space; exponential search trees (Andersson and
  Thorup, JACM 54(3), 2007) make a static polynomial-space structure dynamic in linear space,
  deterministic O(sqrt(log n / log log n)); Beame and Fich (STOC 1999; JCSS 65(1):38-72, 2002) give
  static Theta(min(log log U / log log log U, sqrt(log n / log log n))).
- Rule: stacked layers ADD their costs; a dispatch by regime gets the MIN of the bounds. That is the
  theory behind the Hybrid tiered member (ROADMAP section 7, Tier 2) and RoaringSet's two summaries.
- **Ranking frame for every candidate (proposed):** with w = 32, log log 2^32 = 5 and
  log_32 2^32 = 6.4, so the asymptotic gaps collapse into small constants. Rank candidates by WORDS and
  cache lines touched per op (the count model StratifiedBitset gates as A2 / A9), not by big-O. The
  B1c finding that no tier saves a word (plan ADDENDUM 19) is the first instance.

### 13.3 Exotic candidates not yet in the roster

| Candidate | Bound | Note |
| --- | --- | --- |
| **Z-fast trie** (Belazzougui, Boldi, Vigna, "Dynamic z-fast tries", SPIRE 2010, LNCS 6393; static roots SODA 2009 with Pagh) | predecessor O(log max(abs(x), abs(x+), abs(x-))) = O(log w) = O(log log U) for w-bit keys; updates in EXPECTATION (hashing); 12n pointers + n integers beyond the keys (CHECKED, from the abstract) | the practical successor of x-/y-fast ("fat binary search"), no bucket juggling. Strongest pick; needs the zero-GC LevelTable (L-03). |
| **PGM-index** (Ferragina, Vinciguerra, PVLDB 13(8):1162-1175, 2020) | worst-case bounded predecessor / range / update, optimal for static predecessor; space grows with the number of linear segments, set by the error eps (CHECKED). The intake's "~O(log log n) on smooth data" is NOT supported by any source found; dropped | the modern InterpolationSearchTree: a "measure your key distribution" member. Exact query formula UNVERIFIED (paper section 3). |
| **Decremental successor / interval union-find** (Gabow-Tarjan) | O(1) amortized | see 13.1; niche, teaching value |
| **Monotone integer priority queues**: radix heap (Ahuja, Mehlhorn, Orlin, Tarjan, JACM 37(2), 1990); Thorup (STOC 2003 / JCSS 2004: monotone PQ, O(1) insert + decrease-key; JACM 54(6), 2007: PQ = sorting, deterministic O(log log n) per op via Han's sort) | radix heap O(log C) per element over a monotone drain (the per-op split depends on the potential) | a successor structure used as a Dijkstra queue; overlap with lite-o1 BucketQueue checked in 13.4 |
| **Tango / multi-splay trees** (Demaine, Harmon, Iacono, Patrascu, FOCS 2004 / SICOMP 2007; Wang, Derryberry, Sleator, SODA 2006) | O(log log n)-COMPETITIVE | log log n as a competitive ratio, not a time bound: a docs aside, never code |

### 13.4 Verdicts, and the Timsort-style combinations (evaluated 2026-10-22)

How this was checked (2026-10-22): every citation in 13.1-13.3 web-checked; a prior-art sweep of npm
and GitHub (registry search, exact-name probes, `gh api`); a sweep of every suite main file for a
consumer of an ordered integer set. "None found" below is a lead, not proof.

**Shared result, test 1 (a real consumer): NONE.** No suite main file consumes an ordered integer
set today; the only hits are lite-fastbit32's own word scans and two lowest-set-bit channel picks in
LiteAudio (`Audio.js:2782`, `:2878`). This holds for StratifiedBitset too: every member below is a
TEACHING member until a consumer turns up, and the README says so.

**Shared result, test 3 (JS prior art): the gap is real.** The only JS vEB trees (`van-emde-boas`
1.0.1, `vebt` 1.0.1) are object-based, at about 2 and 6 downloads a week. No JS x-, y- or z-fast
trie, PGM-index, radix heap or fusion tree was found (the npm names `radix-heap`, `xfast`,
`pgm-index`, `vebtree` are unclaimed). The popular bitsets (`fastbitset`, `typedfastbitset`,
`bitset`, `mnemonist`) are flat, with no successor / predecessor; `hibitset-js` (4 Uint32Array
layers) has no next / prev query and allocates iterators.

Ranked by the 13.2 frame (words touched per op at w = 32), best first:

| # | Candidate | Verdict | Why |
| --- | --- | --- | --- |
| 1 | **Stree, the 32-bit stratified tree** (Dementiev, Kettner, Mehnert, Sanders, ALENEX 2004, pp. 142-151; read from the KIT PDF) | **ADOPT as a design: the strongest combination found** | It IS the FastBit32 + BitSet + level-table combination, published and measured. A NON-recursive 3-level tree: a 2^16-entry root array (key bits 16-31), then open-addressing hash tables on 8-bit chunks (sizes 4..256, a 256-table is perfect), a singleton stored as a direct pointer, min / max per node, and 32-ary OR-summary bit pyramids on every level (root t1[65536] / t2[4096] / t3[64]; lower levels t1[256] / t2[8]) over a sorted doubly linked list. Measured fastest for locate against STL map, LEDA (2,16)-trees and two plain vEB codes (up to 4.1x for small n, 2.9x at the largest; insert / delete comparable; 2 GHz Xeon, 2004). Uses: the reference for vEBTree's flattening (L-06), for RoaringSet D-R1 (b) (the same 2^16 root with a summary), and a likely shape for the Hybrid tiered member. Zero-GC needs pooled hash tables and an index-threaded list. |
| 2 | **Z-fast trie** (13.3) | **Tier 4 candidate; decide against YFastTrie at its planning** | O(log w) predecessor, O(n) space, no bucket juggling, but updates are EXPECTED (hashing) and it needs the LevelTable (L-03). No JS port anywhere (one Rust repo). Make "y-fast or z-fast" a D-call of the YFastTrie session. **2026-10-22:** plain x-fast was ruled for 0.3.0 (PLAN-xfasttrie); z-fast remains that YFastTrie D-call. |
| 3 | **PGM-index** (13.3) | **Tier 4 candidate; it takes the InterpolationSearchTree slot** | Worst-case bounded, distribution-adaptive space; no JS or WASM port (C++, Rust, Go only). Static at heart, so it sits next to lite-o1 EliasFano as a comparison point (the "measure your key distribution" member). |
| 4 | **Small-n front, then promote** (Timsort's minimum run) | **A POLICY, not a member** | A sorted inline Uint32Array scanned linearly until n > K, then promotion. It already exists as RoaringSet's array container (<= 4,096) and as y-fast's buckets. Record K as a calibrated constant inside those members and the Hybrid member. |
| 5 | **BucketQueue + a summary pyramid over its buckets** | **Cross-package suggestion for lite-o1, not a member here** | lite-o1 BucketQueue (O1.js:1573-1587) is amortized O(1) over a monotone drain, but one extractMin is O(gap) and its buckets cost O(ceiling) memory (ceiling <= 2^31 - 1). A StratifiedBitset-style "bucket non-empty" pyramid bounds a single extractMin to O(log_32 ceiling) words with the amortized O(1) kept. Record it for lite-o1's own roadmap session (one package at a time). |
| 6 | **Radix heap** (+ a FastBit32 mask over its log C buckets, so the min bucket is one ctz) | **Note; not this package** | It is the low-memory answer for a large key range (O(n + log C) memory against BucketQueue's O(ceiling)), but its bound is O(log C) = O(log U) per element, not sub-logarithmic. Boundary: a lite-logn candidate, or a lite-o1 note beside BucketQueue. No JS prior art at all. |
| 7 | **Decremental successor / interval union-find** (13.1) | **Note only** | O(m + n) total only with a known union tree; amortized; 4+ bytes per key. The zero-GC, worst-case answer to "lowest free slot above 1,024" is a second "not full" summary pyramid (`../Research/BITWISE_RESEARCH.md` 10.2 G), which also has no consumer yet. |
| 8 | **Elias-Fano + a pyramid over its upper bits** | **Drop** | The known worst-case nextGEQ is already O(1 + log(U/n)) via select0 plus a binary search in one bucket (Pibiri and Venturini, ACM Computing Surveys 2021); Vigna's skip pointers (WSDM 2013) are expected-constant only. A pyramid over the upper bits does not replace select0, so it adds space for no bound. Partitioned EF (Ottaviano and Venturini, SIGIR 2014) is the real two-level form; it is lite-o1's to weigh. |
| 9 | **Bentley-Saxe / LSM run merging** (Timsort's merge stack; J. Algorithms 1(4), 1980) | **Drop** | The logarithmic method multiplies the query by O(log n) and has no deletions in its basic form, so it gives back the bound this package exists for. |
| 10 | **Tango / multi-splay** (13.3) | **Docs aside** | a competitive ratio, not a time bound |

Test 5 (a must-fail control) is available for every adopted row: a stale summary bit (rows 1, 5), a
wrong-level hash probe (rows 1, 2), a model error past eps (row 3), and a promotion at the wrong K
(row 4).

---

## 14. vEBTree research intake (2026-11-01) -- for the 0.5.0 planner

Source: maintainer-supplied notes from an outside LLM (two drafts plus its own audit round, and a hybrid
question), kept verbatim at `.handoff/research/veb-notes-2026-11-01.md`. Everything below is marked
VERIFIED (checked here, how) or UNVERIFIED. Treat the notes as leads, not verdicts.

### 14.1 Verified

- **A flat vEB sketch that passes an oracle fuzz.** The notes' final code (`.handoff/research/veb-sketch.mjs`)
  keeps the whole tree in ONE Int32Array: internal nodes hold a [min, max] header with min NOT stored in
  its cluster; bitmap leaves at w <= 5 (1 word) and w = 6 (2 words) carry no header; child offsets come
  from a precomputed size table (summary at base + 2, cluster i at base + 2 + S(ceil(w/2)) + i * S(floor(w/2))).
  add is single-path (an empty cluster gets an O(1) singleton write, then only the summary is entered);
  delete is single-path via the singleton test (header min === max, or `(v & (v - 1)) === 0` on a leaf
  word) plus a <= 4-frame preallocated `_path` to refresh max on the way up. VERIFIED 2026-11-01 by
  `.handoff/research/veb-fuzz.mjs`: a seeded fuzz against a `Set` over 22 universes (2 .. 2^20 + 7,
  odd and non-power-of-two) on add / delete / has / successor / predecessor / min / max / size, 0
  divergences. A scratch check, not a shipped gate.
- **Memory** (measured `byteLength`, both built here):

  | U    | flat vEB (leaf w <= 6) | flat vEB (leaf w <= 5 only) | StratifiedBitset 0.2.0 |
  |------|------------------------|-----------------------------|------------------------|
  | 2^16 | 19,540 B               | 19,540 B                    | 8,460 B                |
  | 2^20 | 143,508 B              | 143,508 B                   | 135,300 B              |
  | 2^24 | 2,163,224 B            | 11,750,204 B (5.4x)         | 2,164,804 B            |
  | 2^28 | 160,769,628 B (computed) | same                      | ~34.7 MB (formula)     |
  | 2^32 | 1,280,592,988 B (computed) | same                    | ~555 MB (formula)      |

  NEW (computed here, not in the notes): the leaf cutoff must be a per-width table, not "5 or 6". With
  bitmap leaves up to w <= 8 (8 words = 256 bits) and the sketch's balanced split: 8,232 B at 2^16,
  143,508 B at 2^20, 2,163,224 B at 2^24, 33,949,728 B at 2^28, 539,500,592 B at 2^32. CORRECTED in 14.5:
  that is NOT "at or below StratifiedBitset at every width" (2^20 is 1.06x, and w = 18 / 19 are 2.12x);
  the bound needs a per-width SPLIT table too. The price of 256-bit leaves is a leaf scan of <= 8 words;
  still O(1) per leaf, so the worst-case O(log log U) bound holds.
- **Siblings:** FastBit1024 has `nextSetBit` but no `prevSetBit` (LiteFastBit32/FastBit32.js:540-705);
  lite-o1 BitSet is successor-only; both are design-parity only, never runtime imports. The notes' first
  code round broke all of this (imports, a `new FlatVEB` per level per op, leaf objects detached from
  the store, -1 vs `undefined`, `delete` returning `this`); its own audit round caught it.
- **Sources exist** (abstracts / records found 2026-11-01): Dementiev, Kettner, Mehnert, Sanders, ALENEX
  2004 (abstract: direct vEB implementations do not compete with good comparison-based trees; their
  tuned non-recursive 3-level structure beats them on SEARCH); Nash and Gregg, ACM JEA 15 (2010),
  "Comparing integer data structures for 32- and 64-bit keys"; Dinklage, Fischer, Herlez, SEA 2021,
  arXiv 2104.06740 (engineered predecessor structures incl. universe reduction and y-fast, up to 4x
  faster than STL with under a third of the memory).

### 14.2 Corrections to the notes

- **Stree is not a vEB.** Dementiev's structure is a fixed 16-8-8 radix split with hashed L2 / L3 tables
  (expected, not worst-case) and flat 32-ary bit-array "tops" -- a StratifiedBitset-style pyramid. Its
  delete is not the vEB delete. The notes' first round conflated the two; their audit round fixed it.
- **"StratifiedBitset uses half the memory of a flat vEB"** holds only at 2^16 (2.3x); parity at 2^20 /
  2^24 with w = 6 leaves; 4.6x / 2.3x the other way at 2^28 / 2^32 unless leaves widen (14.1).
- **"Iterative"** is not quite true: successor's summary step (`_succFrom`) and `predecessor` (`_predFrom`)
  recurse (bounded depth <= 3, no allocation). `successor` carries a dead `shift` variable; `add` calls
  `has` first (a second descent -- count it). The sketch caps U at 2^24.
- **The benchmark table** (hardware, dates, ops/s per study) is UNVERIFIED: none of it appears in the
  abstracts found. Cite the papers' conclusions, never those numbers.
- **The word-count crossover** ("vEB reads fewer words only from w >= 36") is derived in the notes and
  UNVERIFIED here. Our count gates are the arbiter: the planner derives exact per-op counts from the
  chosen layout (as XftCount / YftCount do) and the README's loss row cites measured counts plus
  REPORTED timings against StratifiedBitset.

### 14.3 What this means for the vEBTree 0.5.0 planner

- **Expected loss row:** every source found agrees a direct vEB loses on time to word-parallel bit
  structures at practical U; expect vEBTree to lose to StratifiedBitset for all w <= 32. That is not a
  reason to drop it: it is the deterministic worst-case reference (no hashing, no reseeds, no amortized
  splits) and its witness MAX bar is the flat one (ROADMAP gate_note). Publish the loss row up front.
- **L-06 (flattening) candidate:** the sketch's layout -- one Int32Array, size-table offsets, header-free
  bitmap leaves -- with the leaf cutoff chosen PER WIDTH (up to 256-bit leaves) so space never exceeds
  StratifiedBitset's, and the sketch kept as an independent oracle, not as the engine.

### 14.4 Hybrids proposed in the notes (candidates only; none scheduled)

- H1 dual-width / wider bitmap leaves: part of L-06 above.
- H2 bit-bucketed y-fast (an upper XFastTrie over 1024-key chunks, FastBit1024-parity pages): a real
  idea (Dinklage et al. study bucketed universe reduction). Density-dependent: one key per chunk costs
  ~132 B / key vs YFastTrie's ~32 B / key measured; "beats y-fast at all densities" is UNVERIFIED. Tier 3.
- H3 paged StratifiedBitset (a pyramid top + pooled 1024-bit pages): overlaps RoaringSet (Tier 2,
  section 12); fold into the RoaringSet notes, not a new member.
- H4 Stree-style (vEB min / max headers + bitset summaries): this IS Stree, and likely converges on
  StratifiedBitset plus headers; consider only if the measured vEBTree is disappointing.

### 14.5 Settled with the maintainer (2026-11-01, second round)

The maintainer's outside reviewer agreed with 14.2's three critiques and extended the leaf finding.
Checked here; what holds is settled, what does not is marked.

- **Literature: conclusions only.** Docs cite a paper's qualitative conclusion, never its hardware,
  dates or ops/s. VERIFIED (abstract): ALENEX 2004 -- direct recursive vEB implementations trail good
  comparison trees; their non-recursive 3-level bit-top structure (Stree) wins on locate. UNVERIFIED
  paraphrase: "SEA 2021 shows two-level bit-vector hierarchies beating O(log log U) tries" -- not in
  the abstract found; do not cite it until checked against the paper.
- **Word counts belong to the count gates** (decisions/0004 Amendment 1), never to prose. The notes'
  per-op counts are ASSERTION candidates for the vEBTree count test, to be derived from the chosen
  layout: vEB `min` / `max` = 1 header read vs StratifiedBitset's top-to-level-0 walk (4, 4, 5, 6, 7
  reads at w = 16 .. 32; LogLogN.js:275-305); StratifiedBitset `has` = 1 read (LogLogN.js:155-157) vs
  vEB's per-level header checks (min is not in its cluster, so has / add / delete start at the root);
  vEB `successor(x < min)` = 1 read. Expected verdict stays 14.3's loss row; the counts decide the
  per-op table.
- **L-06 leaf cutoff + split table (computed; `.handoff/research/veb-size.mjs`, words, exact).** Leaf
  cutoff w <= 8. Depth D(w) = ceil(log2(w / 8)): 0 for w <= 8, 1 for 9 .. 16, 2 for 17 .. 32 -- the same
  depth as balanced halving, so the bound is unchanged. Within that depth the space-minimal split makes
  the clusters whole 8- or 16-bit subtrees (lo = 8 for w <= 24 at depth 2 and for w <= 16 at depth 1,
  else lo = 16) and gives the summary the rest (hi = w - lo). Result vs StratifiedBitset:

  | split rule (leaf w <= 8)     | worst ratio            | above StratifiedBitset at        | w >= 16  |
  |------------------------------|------------------------|----------------------------------|----------|
  | balanced, hi = ceil(w / 2)   | 2.12x (w = 18, 19)     | w = 9, 10, 11, 18 .. 23          | 0.97 - 2.12x |
  | per-width table (above)      | 1.118x (w = 9)         | w = 9 (19 vs 17 words), 10 (35 vs 33) | 0.973x |

  w = 9 / 10 are inherent at cutoff 8 (8 bytes each); a whole-tree leaf up to w <= 10 would close them
  at the price of a 32-word scan -- the planner's call. A 1-word summary per leaf (Stree tops) costs
  +12.5% and puts the vEB above StratifiedBitset (~1.09x); not free.
- **Notes' numbers rechecked:** the w = 16 / 24 / 28 / 32 word totals and the 4.64x / 2.31x w <= 6 bloat
  match 14.1. "14.69 MiB smaller at 2^32" is 14,688,740 B = 14.69 MB = 14.01 MiB. Its w = 20 alternatives
  (8 / 12 -> 33,802 words; 4 / 16 -> 32,931) are right; the table above finds 32,901 (12 / 8).
- **Where vEB wins, where it cannot** (structural, EXPECTED until counted and timed): wins on `min` /
  `max`, out-of-range successor / predecessor, and singleton clusters answered from the header; loses on
  `has`, same-word neighbours and common-case add / delete, which StratifiedBitset does in one word.
  Keeping min inside the leaf bitmaps to fix that turns the structure back into a bit pyramid.
- **Industry context: prose only, UNVERIFIED, never cited.** Fixed / dense domains use multi-level
  word bitmaps (Linux sbitmap, TLSF's two-level bitmaps); sparse ones use radix / B-tree hybrids (Linux
  XArray re-implements the radix tree; the Maple Tree replaced the VMA rbtree) and Roaring-style
  containers (array / bitmap / run). The reviewer's "Linux has zero vEB trees" and "IBM DB2 BLU" lines
  are not checked here.

### 14.6 As settled for 0.5.0 (2026-11-02; ADR 0009, `.handoff/PLAN-vebtree.md` CURRENT)

- The maintainer ruled: leaf cutoff w <= 8 (no whole-tree leaf to w = 10); Uint32Array(s); U <= 2^32;
  NO per-leaf summary word. The last was first "yes", then reversed on the 14.5 space table; the planner's
  recomputation with the split table confirms the cost: 1.094 - 1.105x StratifiedBitset at w >= 12, 1.235x
  at w = 9.
- The sketch (14.1) is superseded where the spec differs: Int32Array -> Uint32Array; the -1 empty marker
  -> EMPTY = min > max (stored [0xFFFFFFFF, 0]; 0xFFFFFFFF is a real key at U = 2^32); U <= 2^24 ->
  U <= 2^32; the 4-frame `_path` -> <= 2 frames (depth <= 2). It stays an oracle only.
- New, not in 14.x: the ROOT's cluster count is trimmed to ceil(U / 2^lo) (C-13; cold, only shrinks
  non-power-of-two U: U = 2^24 + 1 costs 2,115,708 B, not ~4.2 MB).

### 14.7 What the G1 engine showed (2026-11-02; fceb851 / 998bcbd, LogLogN.js 538a16dc)

- Bytecode sizes of the flattened hot bodies (node v26.8.2): has 218, add 450, delete 1285, successor 850,
  predecessor 838, min 114, max 133. delete / successor / predecessor exceed V8's default inlining bytecode
  limit (460), so they are EXPECTED to stay out-of-line calls; has / add sit under it. Expected, not traced:
  the G2 VebBytecode / inlining-tool lane is the gate.
- With unbounded leaf scans, a corrupt layout HANGS rather than misanswers (7 of the B2 reviewer's 20 mutants).
  Mutation gates over the engine therefore run in a Worker with a kill timer (PLAN C-19).
- Absent deletes: the engine stops at an internal node whose header proves the key absent; the literal C-12
  reading descended. Maintainer ruling F-B5-1 "Stop at header" kept the engine; the count gate models the
  stop (PLAN C-18 (6)).
- Lookup tables (2026-11-03, maintainer question): none helps vEBTree.
  - In-word scans are already `31 - Math.clz32(v & -v)` / `31 - Math.clz32(v)`: one clz plus a few ALU
    ops, no memory read. A byte LUT adds a loop plus bounds-checked table reads, which also raise the
    counts VebCount pins.
  - Leaves are up to 8 words (w <= 8), not one 32 / 64-bit word. Their real cost is finding the next
    non-empty word, which a byte table cannot skip; only the rejected per-leaf summary word could (C-7).
  - Successor inside one summary word is a mask plus `clz32`.
  - The per-width table already exists: `_g` (Int32Array(33)). The split `w > 24 ? 16 : 8` is one compare.
  - vEBTree has no rank / select (size is a counter).
  - The one LUT that pays is in-word select (byte popcount + a 256 x 8 table), for a future rank / select:
    see the lite-pick consumer lead (ROADMAP section 7).
  - Argued from the code and instruction counts; not timed.
- Keys >= 2^31 (G2 torture, 2026-11-03, PRELIMINARY host, 1 run each; .handoff/evidence/veb-g2-b2-torture-*):
  - STORED keys >= 2^31 add 0 B per 65,536 ops while every argument / return stays < 2^30 (V4, U = 2^31 + 1,
    16 / 16 windows): the raw uint32 header slots (C-11) do not box.
  - A RETURNED key >= 2^31 boxes: 16 B per call (CV7: 1,048,584 B / 65,536 calls). Cause TRACED on V8 14.6
    (Node v26.8.2, default flags, untimed, 4 runs): successor / predecessor (850 / 838 B) exceed Maglev's 100 B
    and TurboFan's 460 B limits and every traced decision declines them; TurboFan also declines delete; has /
    add inline into a hot caller (.handoff/evidence/veb-g4bi-inlining-trace-2026-11-03.log). Other V8s: not
    claimed.
  - The siblings' boxing caveat applies unchanged.

### 14.8 vEBTree vs StratifiedBitset: word reads per op (2026-11-03, sweep)

Method:
- Exact counts with the VebCount / Count technique: a Proxy counts every numeric-key read on vEB `_t` and SB `_bits`.
  vEB's `_g` reads (1 - 4 per op) are NOT added to its column, so the comparison is generous to vEB.
- Engine code of 998bcbd (538a16dc; 53cba8a / f8915227 differs only in a header comment). Every answer is
  cross-checked vEB == SB == a `Set` model (0 mismatches).
- TYPICAL: random sets n = 64 / 4096 / min(65536, U / 4), 20,000 random queries per op.
- ADVERSARIAL: a hill-climb over sets (|S| <= 48) and the query, 4 objectives (max vEB, max SB, max and min of the
  gap), 2 seeds at w = 9 .. 28, 1 seed at w = 32. The maxima are LOWER bounds on the true worst case.
- DETERMINISTIC counts, not timings. Script and logs: `.handoff/research/veb-sb-sweep.mjs`,
  `veb-sb-sweep-{a,b,w32,w32-typical}-2026-11-03.log`.

Worst found, vEB `_t` reads / SB reads (each column's maximum is searched separately):

| w | has | add | delete | successor | predecessor | min / max |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | 3 / 1 | 11 / 2 | 21 / 2 | 19 / 3 | 17 / 3 | 1 / 2 |
| 12 | 3 / 1 | 11 / 3 | 21 / 3 | 19 / 5 | 19 / 5 | 1 / 3 |
| 16 | 3 / 1 | 11 / 4 | 35 / 4 | 26 / 7 | 22 / 7 | 1 / 4 |
| 20 | 3 / 1 | 21 / 4 | 39 / 4 | 37 / 7 | 37 / 7 | 1 / 4 |
| 24 | 3 / 1 | 21 / 5 | 54 / 5 | 44 / 9 | 40 / 9 | 1 / 5 |
| 28 | 5 / 1 | 15 / 6 | 39 / 6 | 29 / 11 | 29 / 11 | 1 / 6 |
| 32 | 5 / 1 | 15 / 7 | 41 / 7 | 29 / 13 | 29 / 13 | 1 / 7 |

Typical means, vEB / SB (`has` is always 3 - 5 vs 1; min / max always 1 vs SB's level count):

| w | add, n = 64 | successor, n = 64 | add, n = 4096 | successor, n = 4096 |
| --- | --- | --- | --- | --- |
| 16 | 9.99 / 2.35 | 10.35 / 4.15 | 3.14 / 1.13 | 3.53 / 1.81 |
| 20 | 14.77 / 3.06 | 14.96 / 5.67 | 8.52 / 1.90 | 9.92 / 3.32 |
| 24 | 19.98 / 3.88 | 21.98 / 7.42 | 12.75 / 2.77 | 14.06 / 4.94 |
| 28 | 8.85 / 4.77 | 8.83 / 8.86 | 10.79 / 3.60 | 7.20 / 6.61 |
| 32 | 13.99 / 5.60 | 14.28 / 10.49 | 7.52 / 4.33 | 7.43 / 8.20 |

What it shows:
- vEB reads fewer words only where a header answers:
  - min / max: 1 vs SB's 2 - 7;
  - successor / predecessor decided at a header (x beyond the max or below the min): 1 vs up to 13 at w = 32;
  - typical successor / predecessor at w >= 28 on sparse sets: rough parity (vEB 7.43 vs 8.20 at w = 32, n = 4096).
- Everywhere else SB reads fewer: `has` 1 vs 3 - 5 always; worst add / delete / successor 2 - 10x fewer.
- Cause: leaf clusters (w <= 8, up to 8 words) carry no header and no summary (C-7).
  - add's emptiness test, delete's emptied test and every successor / predecessor leaf visit scan up to 8 words.
  - At w <= 24 (lo = 8), a miss routes through two such leaves.
  - At w >= 25 (lo = 16), clusters are internal nodes with headers, which is why w = 28 / 32 cost less than w = 24.
- S-H1 targets exactly vEB's wins. With [min, max] headers, SB would answer min / max and out-of-range
  successor / predecessor in 1 read. It would then read no more than vEB on every op class found here (EXPECTED;
  S-H1 is not built).
- Counts are not time. vEB keeps every op inside one array at depth <= 2, while SB's top levels stay cache-hot. G3
  (timing, QUIET window) decides what users feel. These counts say what to time: sparse w = 16 .. 24 add / delete /
  successor, and w = 28 / 32 successor.
- Maintainer decisions this raises (none taken here):
  - (1) ship 0.5.0 as built, positioned honestly (WIN / LOSE wording, no counts, per C-4);
  - (2) reopen C-7 before the release: a per-leaf summary word (1.094 - 1.105x SB space at w >= 12) is EXPECTED to cap
    a leaf visit at about 2 - 3 reads (needs a vebCost re-model, then an engine change: planner + coder + review;
    HOLD-RELEASE already holds 0.5.0);
  - (3) S-H1's priority, now that its target is measured.

## 15. Cross-primitive intake (2026-11-01) -- FastBit32 / FastBit1024 / lite-o1 BitSet / StratifiedBitset

Source: a maintainer-supplied outside review comparing `LogLogN.js`, lite-fastbit32 `FastBit32.js` and
lite-o1 `O1.js`, with a PagedBitset sketch. Checked here against the live files (`LogLogN.js` at
e0d3191, `../LiteO1/O1.js` at 1.11.3, `../LiteFastBit32/FastBit32.js`). Leads, not verdicts.

### 15.1 What holds

- StratifiedBitset already uses the FastBit32 word idioms (`31 - Math.clz32(v & -v)` / `31 -
  Math.clz32(v)`, LogLogN.js:275-305) and its pyramid ends in one top word. Nothing to port there.
- lite-o1 BitSet (`O1.js:3739-4158`): the summary stops at `_s3` (<= 32 words), `_firstWordFrom`
  scans the rest of `_s3` in a loop (`:4026-4069`), `clear()` fills all four arrays (`:3828-3833`),
  `size` is a full popcount (`:3766`), there is no `lastSet` / `prevSet`, and `and` / `or` / `xor` /
  `andNot` run over every word then rebuild the summary. All as the review says.
- FastBit1024 (`FastBit32.js:540-710`) keeps `_n`, `_active`, `_full` incrementally and clears /
  intersects by walking `_active` -- the patterns the review proposes to copy.
- Drop the runtime facade that swaps BitSet <-> StratifiedBitset by density: both preallocate
  Theta(U / 32) words, so a swap saves nothing, and a swap after construction allocates.
- **The PagedBitset sketch is correct.** `.handoff/research/paged-sketch.mjs` (its logic, verbatim,
  over the shipped StratifiedBitset) passes `.handoff/research/paged-fuzz.mjs`: a seeded fuzz vs a
  `Set` over 9 universe / pool shapes (U = 1 .. 70,000, pool-full throws included) plus the 2^31 /
  2^32 - 1 edge keys, 0 divergences. Pool exhaustion fails closed before any write.

### 15.2 Corrections

- **"nextSet drops from 35 word reads to 4" with a 1-word `_s4` root:** counted from the code it is
  <= 38 -> <= 9 typed-array reads (from-word, `_s1`, `_s2`, `_s3`, then the 31-word loop, the
  descent and the data word; with `_s4`: one field read replaces the loop). And it only matters for
  nbits > 2^20 (below that `_s3` is one word and the loop never runs). A constant-factor cut; the
  bound is already worst-case O(1) because the 2^25 cap fixes the loop length.
- **PagedBitset space, "554 MiB -> a few MiB" at 2^32: false.** Measured `byteLength`: the page table
  alone (`Int32Array(2^22)`) is 16 MiB, so the floor is 17,318,692 B with one page; 26,231,452 B with
  65,536 pages (scattered keys) -- about XFastTrie's footprint and ~12x YFastTrie's ~32 B / key. At
  2^24 with every page live it is 2,296,012 B vs StratifiedBitset's 2,164,804 (1.06x). Its win is
  CLUSTERED keys in a huge universe with hash-free worst-case O(log_32 U) ops, not sparse space.
  Fixes worth a planner's look: a `Uint16Array` page table when maxPages < 2^16 (halves the floor),
  or a two-level page table (directory + pooled leaf tables, a second capacity knob, one more read).
- **Top-down pruned intersection is not O(k log_32 U).** Pruning only skips subtrees where one side's
  summary bit is 0. Evens vs odds: every summary word ANDs non-zero, every data word ANDs to 0, so
  `intersects` / `forEachIntersection` read every word: worst case O(U / 32), output-insensitive.
  "Disjoint in 1 read" holds only when the sets are disjoint at the top word's granularity.
- **A `_full` pyramid** (FastBit1024's `_full`, scaled up) gives bounded `nextClear` / `acquire`, but
  it taxes every add / delete with a second summary update and ~3% more words. lite-o1 already holds
  this exact idea as Q1 (`../LiteO1/ROADMAP.md` section 10: maintainer decision, hold for a
  consumer); it is the same decision for StratifiedBitset.

### 15.3 Where each idea lands

| idea | home | status |
| --- | --- | --- |
| BitSet `_s4` root scalar; O(1) `size` counter; summary-guided bulk ops; `lastSet` / `prevSet` | lite-o1 (`../LiteO1/ROADMAP.md` section 11) | proposed there |
| BitSet summary-guided `clear()` | lite-o1 P2 | already planned |
| `nextClear` / `acquire` via a "not full" pyramid | lite-o1 Q1 + StratifiedBitset (same hold) | hold for a consumer |
| StratifiedBitset `intersects` / `intersectionSize` (pruned, materialize nothing) | lite-loglogn, beside RoaringSet R2's counting forms | candidate (ROADMAP section 10) |
| PagedBitset (StratifiedBitset directory + pooled FastBit1024 pages) | lite-loglogn RoaringSet line: the bitmap-only, fixed-pool core | candidate D-R5 (ROADMAP section 10) |
| BitSet <-> StratifiedBitset facade | -- | dropped |

### 15.4 Second round (2026-11-02; checked by the vEBTree planner burst against the code and 14 / 15)

- **[min, max] headers inside StratifiedBitset** (the reverse of Stree / H4): two header words in the
  same typed array turn `min` / `max` from 4 - 7 reads (w = 16 .. 32, LogLogN.js:275-305) into 1, and
  answer an out-of-range successor / predecessor in 1 read. Cost: two compares per add, plus a bounded
  O(log_32 U) successor / predecessor search when the min or max itself is deleted. It erases most of
  vEBTree's measured wins, so it is decided AFTER vEBTree's count gate (B5) measures them; a behaviour
  change to a shipped member, so never in 0.5.0 (prior members stay byte-identical). Candidate S-H1.
- **"O(1) page free" in a paged design: wrong bound.** Freeing an emptied page still clears summary bits
  up the levels until a word stays non-zero: O(log_32 U), as StratifiedBitset's delete already does in
  one pass. What a paged design needs is a live-bit counter per page (FastBit1024's `_n`), so an empty
  page is found without a popcount. A detail of D-R5, not a separate idea.
- **Range ops do not need a path stack.** StratifiedBitset can clear / set a range with no allocation:
  mask the level-0 words, then recompute the touched summary words level by level. In vEBTree a range
  delete stays O(k log log U), one key at a time (its path stack exists only because a cluster does not
  store its own min). `clearRange` / `addRange`: a feature only when a consumer asks.
- Already covered: per-width leaves (14.5 / 14.6), the bitmap y-fast bucket (H2, 14.4), the flat
  offset layout (StratifiedBitset is already one Uint32Array with a level-offset table, LogLogN.js:129-139).

### 15.5 Three sparse-bitset patterns (2026-11-02; maintainer-supplied overview, checked here)

The overview names three patterns: paged / blocked, hierarchical sparse, and offset + bit-block lists.

Space model: U = 2^32 with 1,024-bit pages (2^22 page ids). It counts page and table words only, without the
directory. It is a COMPUTED model, not a measured implementation: `.handoff/research/sparse-shapes.mjs` and its
2026-11-02 log.

| shape | flat table (D-R5 as filed) | 2-level 11/11 table (+1 read) | fanout-32 hierarchy (+4 reads) | offset + word list |
| --- | --- | --- | --- | --- |
| 65,536 scattered pages | 24.25 MiB | 24.26 MiB | 15.26 MiB | 0.50 MiB |
| 65,536 clustered pages | 24.25 MiB | 8.52 MiB | 8.52 MiB | 16.00 MiB |
| 100 clusters | 24.25 MiB | 9.27 MiB | 8.55 MiB | 16.00 MiB |
| 10 pages | 16.00 MiB | 0.09 MiB | 0.01 MiB | ~0 |

- **Paged / blocked = D-R5 (a candidate, not approved).** Its open ship / oracle / drop decision waits for
  RoaringSet's settle step.
  - Corrections to the overview:
    - space is NOT proportional to live pages with a flat table: the table alone is 16 MiB;
    - has / add / delete are O(1), but successor is O(log_32 U) through the directory.
  - The table shows the floor fix: a 2-level 11 / 11 page table costs one read and no space in the scattered
    worst case, and removes the floor when pages are few or clustered. It supersedes the `Uint16Array` option
    as D-R5's recommended floor fix.
  - "A small vEB as the directory" buys nothing: vEBTree is ~0.973x StratifiedBitset's space at 2^22 (14.6),
    and StratifiedBitset has shipped.
- **Hierarchical sparse bitsets: a note, not a member.**
  - It is the D-R5 floor fix applied at every level. Against the 2-level table it saves < 1 MiB clustered
    and ~9 MiB scattered, for 6 reads per op instead of 3.
  - RoaringSet with D-R1 (b) + D-R2 is already a two-level hierarchical sparse bitset with adaptive leaves
    (12.8 row F).
  - "Fast set algebra by skipping empty subtrees" carries 15.2's caveat: pruning skips only where one side
    is empty, so evens vs odds is still output-insensitive.
  - `hi_sparse_bitset` (Rust; docs.rs, checked 2026-11-02) is a FIXED three-level tree whose AND-ed level
    masks prune empty branches. That depth caps the index (16,777,216 with 256-bit blocks), so it does not
    reach 2^32.
  - Java `SparseBitSet` (com.zaxxer; Haddon's design, preserved by Brett Wooldridge) is real, but its
    "three levels" are UNVERIFIED: its README says only "virtual-memory-like".
- **Offset + bit-block lists: dropped.**
  - The overview describes Mercury's `sparse_bitset` correctly (mercurylang.org, checked 2026-11-02): a
    sorted linked list of (offset, bits) cells, a cell deleted when its bits reach 0, plus "fat" / "fatter"
    variants with more bit words per cell.
  - In a typed array, add / delete shift entries: O(#blocks), n-dependent, outside this family's
    bounded-in-U theme.
  - Its one win, scattered sparse keys (0.50 vs 24 MiB), is RoaringSet's array container (~2 B / key,
    bounded search).
  - Clustered, it is ~2x the pages (16 vs 8.5 MiB).
  - Static read-only lists already have lite-o1 EliasFano.
  - At most a boundary line in RoaringSet's docs.

*This document consolidates the design identity, the doubly-logarithmic-growth-witness anchor, the full
candidate roster with its explicit boundary, the space-honesty hook that defines the niche, reference
implementations, and the demo direction for the lite-loglogn project. It is an internal research
reference, modeled on lite-logn/RESEARCH.md and lite-o1/RESEARCH.md, and is a PLAN, not a go: no building
until the user greenlights it, and every member's load-bearing design is settled with the user first.*
