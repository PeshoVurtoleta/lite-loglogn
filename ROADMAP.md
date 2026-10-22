# lite-loglogn -- pre-build roadmap

Seven BRIEF sessions to a shippable Tier-1 core, plus a shared gate/torture/witness
spec and a queued Tier 2-4 backlog. This is the executable plan for @zakkster/lite-loglogn:
a zero-GC, sub-logarithmic bounded-integer data-structure family (folder LiteLogLogN,
main LogLogN.js) -- the O(log log U) sibling of lite-logn (O(log n)) and lite-o1 (O(1)).

**How this roadmap is shaped.** It follows the session-brief form of
`BLUEPRINT_ROADMAP.md`: a shared law, a severity-tagged pre-code table, one
torture/witness/gate spec built once and extended, an ASCII session-order graph,
and one self-contained BRIEF per session (frontmatter budget + PURPOSE / TASKS /
ASSERTIONS / HOT PATH / NON-GOALS / DONE WHEN). It differs from the blueprint in
one way that changes everything downstream: **the blueprint audited three SHIPPED,
published packages and its section 2 is thirty-three REPRODUCED findings. Nothing
here is built.** There is no code to reproduce a bug in, so this roadmap replaces
"Verified findings" with **"Design calls to settle before code"** (section 4) --
severity-tagged the same way, but each row is a decision to make, not a bug to fix.

This is a PLAN, not a go. No member is built until you greenlight that member's
session, and each member's load-bearing design is settled WITH you before any code
(the same cadence lite-o1 and lite-logn actually ran): ONE member per session,
discussion-driven, A+ bar. YOU commit / publish / tag; `/release <semver>` is a
gate skill only, it does not publish. RESEARCH.md is the ground truth for the
roster, the O(log log U) witness anchor, the three honesty hooks, and every design
call; this file sequences them, it does not repeat them.

> Sibling-coordination note: the suite law is "work on ONE package at a time."
> lite-loglogn, lite-logn and lite-o1 are separate repos and separate sessions --
> run them as parallel learning tracks, never edit two in one session, and keep the
> shared substrate decision (LevelTable / NodePool, section 4) reconciled, not forked.

---

## 0. Scope + name correction (do this before anything else)

The published scope is **`@zakkster`** (one `s`). Verified in the tree: a grep for
`@zakksters` across LiteLogLogN returns nothing, and every dev-dep line below uses
`@zakkster/`. The blueprint caught a `@zakksters/lite-gc-profiler` typo in a sibling
roadmap (that scope 404s on the registry); do not reintroduce it. Grep for
`@zakksters` before you trust any devDep line you copy from a sibling.

| Fact | State |
| --- | --- |
| npm scope | `@zakkster` (one `s`) -- CONFIRMED, not `@zakksters` |
| Package name | `@zakkster/lite-loglogn` -- RECOMMENDED, **confirm with user still open** (S1, section 4) |
| Folder | `LiteLogLogN/` -- already created |
| Main file | `LogLogN.js` -- single PascalCase, planned |
| Error tag | `[lite-loglogn]` -- planned |
| Registry state | **UNPUBLISHED** -- not on npm; `git init` needed (only RESEARCH.md + this file exist) |

Rejected name leans (confirm with the user, RESEARCH.md section 11): `lite-loglog`
(drops the `n`, reads as "log of a log" with no structure connotation) and
`lite-log-log-n` (npm hyphen-token discoverability problem -- the same reason
`lite-logn` beat `lite-log-n`). The name is settled in S0, before scaffolding.

---

## 1. Shared law (holds every session)

Inherited suite law, non-negotiable and identical to lite-o1 / lite-logn:

1. **Zero runtime deps. `node:test` only. ASCII-only source** -- U+00D7 and U+00B5
   the sole exceptions, and lite-loglogn needs neither: use `->`, `<=`, `x`,
   "log2", "log log U", "2^32", "clz32", "degrees" spelled out.
2. **Single PascalCase main file `LogLogN.js`.** `sideEffects: false`. Tree-shakeable
   named exports, no barrel. `llms.txt` + `CHANGELOG.md` per package. README ships
   in `files[]`; GUIDE / RESEARCH / ROADMAP do not.
3. **MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. Never "Karadjov".**
4. **Bounded integer universe, word-RAM model.** Keys are w-bit integers in [0, U),
   U = 2^w; the sub-logarithmic bound rests on O(1) arithmetic/bitwise ops on a
   w-bit word, so **w <= 32 in JS** (bitwise ops are 32-bit). Wider keys are a
   labeled `SegmentedU` variant, never a silent BigInt hot path.
5. **`null` is not zero. Fail closed on every unverified state, typeof-guard FIRST**
   before any coercion (the recurring Symbol/BigInt/`{valueOf}`/boxed-Number footgun
   -- it has bitten multiple packages; make it impossible here). An absent
   successor/predecessor returns `undefined`, never key 0; an out-of-universe key
   fails closed.
6. **Zero allocation on every steady-state hot path (0 B/op),** proven by
   `node --expose-gc test/torture.mjs` (@zakkster/lite-leak + @zakkster/lite-gc-profiler).
   This is the family's HARDEST version of the law: a textbook vEB is a recursion of
   cluster OBJECTS and an x-fast trie is `w` hash tables of node OBJECTS -- both
   allocate per level. Array-embedded members (StratifiedBitset, a flattened vEB) are
   node-free; the trie members use pointer-free open-addressing `Uint32Array`
   LevelTables + threaded index columns (`NIL = 0`, slot 0 unused). No gate output
   is a FAIL.

The family delta (what makes this package its own thing):

7. **The witness proves a near-flat STRAIGHT line vs `log2(w)`** -- one constant
   additive step per bit-width doubling (one extra level of the universe recursion),
   the double-logarithm made visible -- **AND** the n-sweep crossover over the
   O(log n) foil (the "when does this beat a BST" answer, as a number). lite-o1
   proves a FLAT ops/ms line; lite-logn a straight line vs `log2(n)`; lite-loglogn a
   straight, nearly-flat line vs `log2(w)`, the universe BIT-WIDTH. Same discipline,
   different axis.
8. **The SPACE price is a co-headline, stated on every member** with the same
   prominence as the time bound (vEB O(U), x-fast O(n*w), y-fast O(n),
   StratifiedBitset O(U/w)). Speed is half an honest claim here; footprint is the
   other half, and it is gated/reported on every member (RESEARCH.md section 5). This
   is the family's defining honesty hook -- its BlockedBloom-FPR-floor.
9. **Every gate must be provably able to FAIL.** Every torture tier, the witness fit,
   the perf gate, and the space assertion each ship with a deliberately-broken
   control that makes the gate exit non-zero. A gate that cannot fail is decorative.

---

## 2. The three honesty hooks (why this family carries one more than its siblings)

Stated here because they drive the gate spec and every brief (RESEARCH.md section 5):

- **(a) The bound is in U, not n.** O(log log U) is in the UNIVERSE bit-width, never
  the element count. For 32-bit keys `log log U <= 5`, so on a fixed universe these
  are small-constant-time structures whose win over O(log n) is real but BOUNDED and
  materializes only as `n` grows past the crossover. The README never implies
  "log log U beats log n" without "for n above K on a w-bit universe." Conflating
  log log U with log log n is the dishonesty this family refuses.
- **(b) The time flavor** is always labeled: worst-case (vEB; StratifiedBitset as
  O(log_w U)) vs expected/amortized (y-fast -- bucket splits/merges amortize, the
  representative structures are expected). The witness reports MAX single-op time so
  an amortized spike or a level-table rehash shows as a tall bar.
- **(c) The SPACE price** -- law 8 above. The benchmark's memory dimension is a
  co-headline, not an afterthought, precisely because of this.

---

## 3. Scaffolding + package.json (mirror LiteO1 / LiteLogN exactly)

`git init` first (LiteLogLogN is not yet a repo). Create the repo to the siblings'
shape so every tool, script and doc lands where muscle memory expects it:

```
LiteLogLogN/
  LogLogN.js           # the single main file; one tree-shakeable class per member
  LogLogN.d.ts         # ambient TS types, one block per member
  llms.txt             # API surface (exports, per-member signatures, design bounds incl. SPACE)
  README.md            # modeled on LiteSepforge/README.md (the blueprint spine)
  GUIDE.md             # "which structure to pick" -- same structure as LiteO1/GUIDE.md
  CHANGELOG.md         # Keep-a-Changelog; one version heading per member release
  LICENSE              # MIT (c) Zahary Shinikchiev
  RESEARCH.md          # already drafted (the ground truth)
  ROADMAP.md           # this file
  package.json         # see below
  decisions/           # ADRs, 0001.. -- one per load-bearing call (as LiteO1/decisions)
  test/
    <Member>.test.js         # per-member contract + boundary + fuzz-vs-oracle
    QaAudit.test.js          # cross-member adversarial block (coercion, re-entrancy)
    witness.mjs              # the O(log log U) witness harness (repo-only, NOT in files[])
    torture.mjs              # lite-leak + lite-gc-profiler 0-B/op gate (repo-only)
    Bench.test.mjs           # anti-vacuity + fixed-seed determinism gate for benchmark/
    perf/PerfGate.test.mjs   # @zakkster/lite-perf-gate zero-alloc scenarios
    types/loglogn.test-d.ts  # + types/tsconfig.json
  benchmark/           # ADOPTED lite-o1 Bench v2 (repo-only), memory kernel added; see section 5
    Harness.mjs Template.mjs METHODOLOGY.md Dimensions.mjs Matrix.mjs Bench.mjs Report.mjs
  .gitignore           # ignore benchmark/results.json + benchmark/report.html
```

`files[]` ships ONLY the six:
`["LogLogN.js","LogLogN.d.ts","llms.txt","README.md","CHANGELOG.md","LICENSE"]`.
`test/`, `benchmark/`, `decisions/`, `demo/` NEVER ship -- assert it in the
`/release` pack check (`npm pack --dry-run` = exactly those six files). The witness
harness and the benchmark suite are repo-only dev infra: no version bump of their
own, `LogLogN.js` stays byte-identical when they change; their value is the published
RESULTS (tables + graphs in README/GUIDE), the lite-o1 / lite-logn pattern.

package.json (copy lite-logn's, rename):

```jsonc
{
  "name": "@zakkster/lite-loglogn",   // RECOMMENDED; confirm in S0 (section 4, S1)
  "version": "0.1.0",                 // one minor per shipped member (0.1.0, 0.2.0, ...)
  "type": "module",
  "main": "./LogLogN.js",
  "sideEffects": false,
  "exports": { ".": { "types": "./LogLogN.d.ts", "node": "./LogLogN.js",
                      "import": "./LogLogN.js", "default": "./LogLogN.js" } },
  "files": ["LogLogN.js","LogLogN.d.ts","llms.txt","README.md","CHANGELOG.md","LICENSE"],
  "scripts": {
    "test":        "node --test test/*.test.js test/Bench.test.mjs",
    "test:types":  "tsc -p test/types/tsconfig.json",
    "torture":     "node --expose-gc test/torture.mjs",
    "witness":     "node test/witness.mjs",
    "test:perf":   "node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs",
    "bench":       "node benchmark/Bench.mjs",
    "bench:report":"node benchmark/Bench.mjs && node benchmark/Report.mjs",
    "verify":      "npm test && npm run test:types && npm run torture && npm run witness && npm run test:perf"
  },
  "devDependencies": {
    "@zakkster/lite-gc-profiler": "^1.16.0",
    "@zakkster/lite-leak":        "^1.10.0",
    "@zakkster/lite-perf-gate":   "^1.4.2",
    "esbuild":                    "^0.28.2",   // D6 bundle-size dimension only
    "typescript":                 "^7.0.2"
  }
}
```

The three lite-* dev-deps are the standing gate stack: **lite-leak** (retention) +
**lite-gc-profiler** (alloc/GC) drive `torture.mjs`; **lite-perf-gate** drives
`test:perf`. `esbuild` is the bundle bencher, dev-only -- zero RUNTIME deps preserved.
`lite-fastbit32` may join as a dev-only cross-check for the `clz32` word primitives,
or stay a cross-linked recipe -- decided in S0 (section 4, S3).

---

## 4. Design calls to settle before code

The findings-analog. Because nothing is built, these are DECISIONS, not reproduced
bugs. Severity: **S1** = blocks everything / outlives many members; **S2** = shapes
one member; **S3** = hygiene / scaffolding. Each row: the call, the recommended
resolution, and which session settles it. Lead with the identity call -- it is the
most load-bearing decision in the document.

| ID | Sev | Design call | Recommended resolution | Settled in |
| --- | --- | --- | --- | --- |
| **L-01** | **S1** | **The IDENTITY WORDING.** Is the package "strictly O(log log U) (vEB/x-fast/y-fast), with StratifiedBitset as an O(log_w U) cousin" or "sub-logarithmic bounded-integer predecessor/successor, spanning O(log_w U) to O(log log U)"? This decides the HEADLINE member (StratifiedBitset vs vEB), the witness's PRIMARY axis, and every card, README first screen, and GUIDE table. | **Lean: the spanning framing, StratifiedBitset first** -- the honest, teachable entry point (array-embedded, zero-GC with no substrate to settle, correct in a page). But it is the user's call and it shapes everything, so it is settled explicitly, on the record, before any code. | **S0** |
| **L-02** | **S1** | **The package NAME.** `@zakkster/lite-loglogn` / `LogLogN.js` / `[lite-loglogn]` is RECOMMENDED but unconfirmed; the package is unpublished. | Confirm the recommendation (parallels `lite-logn` / `LogN.js`); reject `lite-loglog` and `lite-log-log-n`. Confirm before `git init` / scaffolding. | **S0** |
| **L-03** | **S1** | **LevelTable / NodePool ownership.** Re-export lite-o1's `SlotPool`, depend on lite-arena, share lite-logn's `NodePool`, or ship a separate open-addressing integer table? The single most consequential cross-package call (shared with lite-logn). Reconcile, do NOT fork. | **Decide the DIRECTION in S0**; it BLOCKS XFastTrie and YFastTrie. StratifiedBitset and (flattened) vEB do NOT need it, so the concrete substrate can be finalized by the XFastTrie session at the latest -- but the direction is set before member 1 so the trie members do not fork an allocator. | **S0** (direction) / **XFastTrie** (concrete) |
| **L-04** | **S1** | **The witness fit thresholds + which sweep is the HARD gate.** What `R^2` floor + slope band make a fair, non-flaky gate over a SHORT ~5-point bit-width sweep (w = 16..32)? Is the U-sweep double-log fit the hard gate, or the n-sweep crossover vs the O(log n) foil? The short axis is noisier than lite-logn's n-sweep -- the real risk. | Settle empirically in StratifiedBitset (the cleanest witness); expect the siblings' steady-window / median-of-9 / do-not-widen-the-floor discipline (lite-o1 ADR-0004 amendment). **Lean: the n-sweep crossover is the more robust HARD gate, the U-sweep fit reported.** Record in an ADR; it becomes the FAMILY gate. | **StratifiedBitset** (using S0 direction) |
| **L-05** | **S2** | **The 32-bit ceiling / wider-key policy.** JS bitwise ops are 32-bit, so the natural universe is <= 2^32. Is a 53-bit / 64-bit `SegmentedU` variant a Tier-1 split-word concern or a Tier-2 labeled variant? | **Lean: 32-bit default, `SegmentedU` as Tier 2** (a labeled high-word + low-word split, or a cold BigInt path -- never a silent BigInt hot path). | **S0** (policy) / **SegmentedU** (build) |
| **L-06** | **S2** | **vEB flattening strategy.** The textbook recursive-object vEB allocates per level. Which flattening -- a vEB-layout typed array, or an iterative high/low-word split -- keeps worst-case O(log log U) AND 0 B/op AND stays readable enough to teach? | Settle in the vEBTree session; prove the chosen flattening against the recursive reference for correctness and against the torture gate for 0 B/op. | **vEBTree** |
| **L-07** | **S3** | **The `clz32` word-primitive boundary vs lite-fastbit32.** The `clz32` / `ctz` / next-set-bit ops the stratified bitset (and every member) leans on are lite-fastbit32's territory. | A tiny shared internal here, a dev-only cross-check dependency on lite-fastbit32, or a cross-linked recipe -- never a drifting reimplementation. Decide the direction in S0; keep it a few lines if internal. | **S0** |
| **L-08** | **S3** | **Scaffolding hygiene.** `git init`; the six-file `files[]`; `npm pack --dry-run` excludes test/benchmark/decisions/demo; three-place VERSION sync from the first release; the standing gate stack wired. | Stand it all up in S0 / the StratifiedBitset session per section 3; assert the pack check in `/release`. | **S0** / **StratifiedBitset** |

The one invariant that guards the whole family across members (the blueprint-analog
of its free-list conservation law): **prior members stay BYTE-IDENTICAL when a new
member lands.** `git diff LogLogN.js` shows only the header comment, the VERSION const,
and a pure append. The reviewer checks it on every diff, exactly as on every sibling
member.

---

## 5. The gate + torture / witness / perf / bench / space spec

One spec, built once (StratifiedBitset brings up the harnesses) and extended by each
later member. A member is DONE only when ALL of these are green and reported with
REAL numbers. **Every gate ships a deliberately-broken control (law 9).**

### 5.1 The torture gate (`test/torture.mjs`, `npm run torture`)

`0 B/op` on every hot path for the new member AND every prior member still 0 B/op,
via lite-leak + lite-gc-profiler. Tiers, shared shape across members:

- **T0 -- steady-state alloc.** `add`/`delete`/`has`/`successor`/`predecessor`/`min`/`max`
  in a mixed loop: `gc major = 0`, `gc_maxPauseMs = 4`, `alloc_bytes_per_op = 0`.
- **T1 -- arrayBuffers no-growth.** The family's blind-spot gate: assert the typed-array
  backing stores do not grow per op (`maxArrayBuffersGrowth: 0`, `stabilize: 'deep'`).
  lite-gc-profiler documents a measured ~152x blind spot on ArrayBuffer backing stores
  outside the V8 heap -- where every one of this package's structures lives -- so a
  heap-growth gate alone is insufficient. This is where a naive recursive vEB's
  per-level `new`, or a level-table rehash, gets caught.
- **T2 -- leak / soak.** `leak_cycles: 4096` build-up / tear-down cycles; leak tracker
  reports `size 0/0`; sample the heap ACROSS cycles, not within one.
- **T3 -- controls.** Each of the above, deliberately broken (an allocating op loop; a
  member that grows a backing array per query; a retained reference across cycles),
  must exit non-zero.

Profiler discipline (inherited): one measurement at a time (`measureOps` etc. share
the heap and throw "already in flight" if nested -- tiers run sequentially); unknown
rule keys throw as of profiler v1.10.0; never resolve an unexpected `inconclusive`
with `allowInconclusive`.

### 5.2 The witness gate (`test/witness.mjs`, `npm run witness`)

The O(log log U) proof, RESEARCH.md section 2. Uses the `logLogWitness` harness
(reference in RESEARCH.md section 2 -- an OFFLINE proof tool, never a hot-path dep):

- **U-sweep double-log FIT, BOTH axes.** Hold n fixed, sweep U = 2^16 .. 2^32; fit
  `nsPerOp = intercept + slope*log2(w)` and ALSO fit vs `w` (the O(log U) impostor
  axis). Assert the **`log2(w)` fit WINS** (higher R^2) -- this catches a mislabeled
  bound (e.g. an x-fast UPDATE path that is really O(log U)). `R^2 >= floor` and
  `slope` in the member's band on the winning axis.
- **n-sweep CROSSOVER vs the O(log n) foil.** Hold U at 32 bits, sweep n = 1e3 .. 1e7;
  the member stays flat while a lite-logn O(log n) member (the foil) climbs and is
  overtaken. Report the crossover `n` as a fact ("wins for n above ~K on a 32-bit
  universe").
- **Step constancy.** The first-difference of ns/op per bit-width doubling stays
  ~constant; a rising trend betrays a hidden O(log U) / O(w) term.
- **MAX single-op printed** for amortized / expected members (y-fast) -- the honesty
  hook so a rehash / bucket-split spike shows as a tall bar.
- **Control:** a deliberately O(log n) member (or the foil itself) submitted as the
  candidate must FAIL the `log2(w)`-fit-wins assertion.

Which sweep is the HARD gate vs reported is L-04, settled in StratifiedBitset and
recorded in an ADR; it then becomes the family gate.

### 5.3 The perf gate (`test/perf/PerfGate.test.mjs`, `npm run test:perf`)

@zakkster/lite-perf-gate zero-alloc scenarios for each hot op, an isolated
iterate/`successor`-walk alloc-free scenario, and a must-fail teeth case.

### 5.4 The SPACE report (this family's extra gate)

Every member STATES and ASSERTS its footprint bound: bytes vs U and bytes vs n at
fixed points -- a canary that the backing arrays are the expected size for a given U
(and, for y-fast, grow only with n) and do NOT grow per query. **Speed is never
reported without space** (law 8). This is a gate, not a comment: the assertion has a
broken control (a member whose backing array silently grows) that must fail it.

### 5.5 The benchmark suite = ADOPT lite-o1 Bench v2 (NOT a rebuild)

**RESOLVED (user, 2026-09-16). The eight-dimension suite is COMPLETE and must NOT be
reinvented.** lite-o1 shipped it as **Bench v2** -- the full-rigor blueprint (strong
baselines + bootstrap CI + Mann-Whitney + overhead-subtraction + a load-factor curve)
with a **`Template.mjs` and a `METHODOLOGY.md` written expressly for the siblings to
copy.** lite-loglogn **ADOPTS** it: port the harness, the child-process-per-cell
orchestrator, the honesty header (seed/node/arch/universe/date), the vacuity gate (it
emits the string `"n/a"`, never numeric 0), the `traceHash` determinism check, and the
hand-rolled zero-dep inline-SVG HTML report renderer **verbatim.** Then add ONLY the
three things that are genuinely O(log log U)-specific:

1. the **U-sweep double-log FIT** (both axes, section 5.2) into dimension 1, plus the
   **O(log n) lite-logn crossover FOIL**;
2. the **loglogn MEMORY kernel** -- footprint vs U AND vs n -- **promoted to
   co-headline** (dimension 4): the vEB O(U) vs y-fast O(n) vs stratified O(U/w) story
   is the whole reason a user picks one member over another;
3. the baselines from RESEARCH.md section 2: a lite-logn O(log n) member (or sorted-array
   binary search) for the payoff, and a native `Set` (O(1) but UNORDERED, O(n)-space)
   for the counter-trade.

**There is NO "design the benchmark suite" session and NO reuse-vs-fork open question.**
The Benchmark-ADOPT session (section 7) is a COPY-AND-WIRE-PLUS-ONE-KERNEL session, a
settled decision. Anywhere earlier planning said "dedicated session to design/build the
suite" or "reuse vs fork the framework," that is superseded by this adoption.

---

## 6. Session order

```
S0 (settle identity + name + substrate direction + witness-threshold plan + 32-bit ceiling)
      |
      v
StratifiedBitset (v0.1.0)  <-- headline; brings up witness (both sweeps) + torture + perf + SPACE gates;
      |                         witness thresholds settled here BECOME the family gate (L-04)
      |
      +--> XFastTrie (v0.2.0)  <-- NEEDS the LevelTable direction from S0 (L-03)
      |          |
      |          v
      |     YFastTrie (v0.3.0) <-- the O(n)-space fix, over x-fast representatives
      |
      +--> vEBTree (v0.4.0)    <-- does NOT need LevelTable (flattened typed arrays)
                 |
                 v
              Demo  (once 3-4 members exist)
                 |
                 v
        Benchmark-ADOPT (port lite-o1 Bench v2 + double-log fit + crossover foil + memory kernel)
                 |
                 v
              Tier 2 (EliasFano, RoaringSet, FusionTree, IntUniverseMap, SegmentedU -- one per session)
```

Blockers, precisely:

- **The LevelTable direction (L-03, settled in S0) blocks XFastTrie and YFastTrie.**
  StratifiedBitset and (flattened) vEBTree do NOT need it, so they can proceed on the
  S0 direction alone while the concrete table is finalized in the XFastTrie session.
- **StratifiedBitset comes first regardless.** It is the headline, it has no substrate
  to settle, and it brings up the witness / torture / perf / SPACE gates. The witness
  thresholds calibrated there (L-04) become the standing family gate every later member
  leans on.
- **YFastTrie depends on XFastTrie** (it wraps an x-fast trie over O(n/w) representatives).
- **Demo and Benchmark-ADOPT wait until 3-4 members exist** so the witness comparison
  and the space dial have range.

---

## 7. The briefs

===============================================================================
# S0 -- settle-first -- identity, name, substrate direction, witness plan
===============================================================================

```markdown
---
package: "@zakkster/lite-loglogn"
version_target: n/a (no code; a decisions + scaffolding session)
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
depends_on: []
blocks: [StratifiedBitset, XFastTrie, YFastTrie, vEBTree]
gate_note: no witness/SPACE gate yet -- this session STANDS UP the harnesses' home
           (scaffolding) and RECORDS the calls the gates will enforce
---

# lite-loglogn -- settle the load-bearing calls, then scaffold

PURPOSE
  Nothing is built and several decisions outlive many members. Settle them WITH the
  user, on the record (ADRs), before a line of member code -- the identity wording
  above all, because it decides the headline member, the witness's primary axis, and
  every card. Then scaffold the repo to the siblings' shape.

TASKS
  - **L-01 identity wording.** Decide: "strictly O(log log U) with StratifiedBitset an
    O(log_w U) cousin" vs "sub-logarithmic bounded-integer predecessor/successor
    spanning O(log_w U) to O(log log U)." Record in decisions/0001-identity.md with the
    consequence for the headline member and the witness axis. Lean: the spanning framing,
    StratifiedBitset first.
  - **L-02 name.** Confirm @zakkster/lite-loglogn / LogLogN.js / [lite-loglogn]; reject
    lite-loglog and lite-log-log-n. Record in the same ADR or 0002-name.md.
  - **L-03 substrate DIRECTION.** Decide the LevelTable / NodePool direction (re-export
    lite-o1 SlotPool / depend on lite-arena / share lite-logn NodePool / separate open-
    addressing table). Reconcile, do NOT fork. Record in decisions/0003-substrate.md.
    The concrete table is finalized in XFastTrie; only the DIRECTION is needed now.
  - **L-04 witness-threshold PLAN.** Not the numbers (those are empirical, in
    StratifiedBitset) -- the PLAN: both-axes fit, `log2(w)`-fit-must-win, which sweep is
    the candidate hard gate, the steady-window discipline. Record the intent in the ADR
    so member 1 fills in the floor/band.
  - **L-05 / L-07 policy.** 32-bit default + SegmentedU as Tier 2 (L-05); the clz32
    boundary vs lite-fastbit32 (L-07). Record.
  - **L-08 scaffold.** `git init`. Create the section-3 tree and package.json (name from
    L-02, version 0.1.0). Wire the standing gate stack (lite-leak + lite-gc-profiler +
    lite-perf-gate dev-deps). Confirm `@zakkster` one-`s` everywhere (grep `@zakksters`).
    Empty (registered) witness.mjs / torture.mjs / PerfGate scaffolds that later members
    fill. LICENSE = MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>.

ASSERTIONS
  - decisions/0001..0003 (and name) exist, each stating the decision, the recommended
    resolution taken, and the members it shapes.
  - `git status` is a real repo; `npm pack --dry-run` lists exactly the six files[]
    (no LogLogN.js body yet is fine -- an empty stub with VERSION + header is acceptable).
  - grep `@zakksters` returns nothing; grep "Karadjov" returns nothing.
  - The gate stack dev-deps resolve; the empty torture/witness/perf scaffolds run and
    print "ok" (vacuously, no member registered yet).

HOT PATH
  None -- no member code. The only "hot path" concern recorded here is the substrate
  direction (L-03), which will BE a hot path for the trie members.

NON-GOALS
  No member. No witness numbers (empirical, member 1). No concrete LevelTable (XFastTrie).
  No benchmark (adopted later, section 5.5). Do not build ahead of a settled call.

DONE WHEN
  identity + name + substrate direction + witness plan + 32-bit/clz32 policy each recorded
  in an ADR; repo scaffolded to the six-file shape; gate stack wired; scope/name grep clean
```

===============================================================================
# StratifiedBitset -- v0.1.0 -- the headline + the family gates
===============================================================================

```markdown
---
package: "@zakkster/lite-loglogn"
version_target: 0.1.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
depends_on: [S0]
blocks: [Demo, Benchmark-ADOPT]
gate_note: brings up logLogWitness (BOTH sweeps) + torture + perf + SPACE gates;
           SETTLES L-04 (the witness floor/band + which sweep is the hard gate) as the family gate
---

# lite-loglogn -- StratifiedBitset: recurse on the universe, in a page, zero-GC

PURPOSE
  The headline member and the reference member (the BinaryHeap-equivalent per lite-logn):
  a pyramid of Uint32Array summary levels, each higher level one bit per 32-bit WORD of
  the level below. add/delete/has are O(levels); successor/predecessor climb to the next
  nonzero summary then descend by lowest/highest set bit via clz32. Array-embedded, no
  nodes, no level tables -- provably zero-GC with NO substrate to settle first, correct in
  a page (RESEARCH.md section 7 has the reference impl). It brings up the witness and every
  standing gate before the harder recursive/level-table members. Bound O(log_w U) (~7
  levels for 32-bit keys), stated HONESTLY -- not "strictly O(log log U)."

TASKS
  - Implement StratifiedBitset in LogLogN.js per RESEARCH.md section 7: the summary pyramid,
    `add`/`delete`/`has`/`successor`/`predecessor`/`min`/`max`/`clear`, `ctz32` via clz32.
    typeof-guard FIRST on every key entry (law 5); a bad key is ABSENT for `has` / throws
    for `add` / returns `undefined` for `successor` -- null is not key 0.
  - Tighten the `successor` descend bookkeeping (the reference sketch shows the climb/descend
    structure; prove the index arithmetic against a brute-force oracle).
  - Bring up test/witness.mjs with `logLogWitness` (BOTH sweeps): U-sweep double-log fit
    (both axes, `log2(w)` must win) + n-sweep crossover vs a lite-logn O(log n) foil.
    Foils: a single flat bitset scanned linearly for the successor (the family's poor cousin)
    and a lite-logn member on the n-sweep.
  - **SETTLE L-04:** calibrate the R^2 floor + slope band over the ~5-point w=16..32 sweep;
    decide the hard gate (lean: n-sweep crossover) vs reported; record in
    decisions/0004-witness-thresholds.md. These become the FAMILY gate.
  - Bring up test/torture.mjs (T0-T3) and test/perf/PerfGate.test.mjs for every hot op.
  - Assert the SPACE bound: O(U/w) (~1.03 bits per universe slot); backing arrays are the
    expected size for a given U and do NOT grow per op.
  - Docs: llms.txt + README member section (bound + SPACE) + GUIDE section + CHANGELOG 0.1.0
    + decisions/0005-stratifiedbitset.md.

ASSERTIONS
  - >= 1e5..1e6-op fuzz vs a brute-force oracle (plain sorted array / naive full-bitset
    linear-scan predecessor): 0 divergences. successor past max = `undefined`; universe=1,
    empty, full, single-key, keys at 0 and U-1, non-power-of-two universe all correct.
  - QaAudit: Symbol / BigInt / {valueOf} / boxed Number / NaN / null / -1 / 1.5 / >= U
    rejected typeof-first with `[lite-loglogn]` and a byte-identical no-op; `-0` does not
    alias key 0; clz32/ctz correct at bit 0, bit 31, all-zero word never dereferenced.
  - witness: `log2(w)` fit R^2 >= floor, slope in band, and BEATS the `w`-axis fit;
    n-sweep crossover reported; the O(log n) foil submitted as candidate FAILS the
    fit-wins control.
  - torture "ok", 0 B/op on every hot path, arrayBuffers no-growth, leak 0/0; T3 controls
    exit non-zero. test:perf green + teeth case fails.
  - SPACE canary passes; a control member that grows a backing array per query fails it.

HOT PATH
  add/delete/successor each touch ONE word per level, `ceil(log32(U))` levels: a small
  constant of clz32 word ops, no allocation, no closures. Diff proves the hot bodies
  allocate nothing.

NON-GOALS
  No level tables (XFastTrie). No recursion (vEBTree). No wider-than-32-bit keys (SegmentedU).
  No benchmark suite yet (adopted later). Do not claim strict O(log log U) for this member.

DONE WHEN
  StratifiedBitset shipped + fuzz-vs-oracle green; witness (both sweeps) + torture + perf +
  SPACE gates up and green with controls that fail; L-04 thresholds recorded as the family gate
```

===============================================================================
# XFastTrie -- v0.2.0 -- binary search over the bit-levels (the trick)
===============================================================================

```markdown
---
package: "@zakkster/lite-loglogn"
version_target: 0.2.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
depends_on: [StratifiedBitset]
blocks: [YFastTrie]
gate_note: FINALIZES the concrete LevelTable substrate (L-03 direction from S0);
           witness must catch the O(w) UPDATE path as NOT O(log log U) (fit-both-axes)
---

# lite-loglogn -- XFastTrie: successor is a binary search over the KEY'S BITS

PURPOSE
  The member whose Big-O is most delightfully non-obvious and most in need of the witness:
  `successor(x)` in O(log log U) by BINARY-SEARCHING the `w` prefix levels of a bit-prefix
  trie for the longest present prefix, then one hop on a threaded leaf list (RESEARCH.md
  section 8). Introduces the pointer-free open-addressing LevelTable substrate. The honest
  caveat is baked in: query O(log log U) worst-case, but UPDATE O(w) = O(log U) and space
  O(n*w) -- which is the whole motivation for YFastTrie next.

TASKS
  - Finalize the concrete LevelTable per the S0 direction (L-03): open-addressing
    `Uint32Array` prefix->slot tables (one per trie level), `NIL = 0` sentinel, slot 0
    unused, pointer-free representative index. Reconcile with lite-o1 SparseSet /
    lite-logn NodePool DNA; do NOT fork. Record the final substrate in
    decisions/NNNN-leveltable.md.
  - Implement XFastTrie: `w` prefix levels; each present prefix records min/max leaf on a
    threaded (succ/pred index columns) doubly-linked leaf list; `successor`/`predecessor`
    via the level binary search; `add`/`delete` touch all `w` levels + splice the thread.
  - Extend witness.mjs: assert `successor` fits `log2(w)` (O(log log U)) AND that the
    `add`/`delete` UPDATE path fits `w` (O(log U)) -- the harness fitting BOTH axes must
    label the update path honestly, catching a mislabeled bound.
  - Extend torture (level-table rehash must not allocate per op or the design fails the
    arrayBuffers gate), perf, and SPACE (assert O(n*w), stated as the honest caveat).
  - Docs: member section with the fast-query / O(w)-update / O(n*w)-space caveat spelled out;
    CHANGELOG 0.2.0; ADR. Prior member (StratifiedBitset) BYTE-IDENTICAL.

ASSERTIONS
  - Fuzz vs oracle 0 divergences incl. the threaded-leaf order (successor/predecessor walk
    the sorted keys exactly). Boundary: absent x, x below min, x above max, single key.
  - LevelTable: open-addressing probe correct at load-factor edges; NIL=0 never a valid key;
    a rehash (if growth is offered) is labeled and its tail reported, not silent.
  - witness: successor `log2(w)` fit wins; the update path is REPORTED as O(w) not disguised.
  - torture 0 B/op incl. the level-table hot paths; StratifiedBitset still 0 B/op; controls fail.
  - SPACE: O(n*w) asserted and stated as the caveat that motivates y-fast.

HOT PATH
  `successor` = O(log w) LevelTable probes, each an O(1) Uint32 lookup, zero allocation.
  `add`/`delete` walk `w` levels -- O(w), no per-level `new`, no closures. The rehash (if any)
  is amortized and off the steady-state path; label it.

NON-GOALS
  No y-fast wrapper (next session). No representative buckets. Do not hide the O(w) update
  or O(n*w) space -- they are the teaching beat.

DONE WHEN
  XFastTrie + concrete LevelTable shipped, fuzz-vs-oracle green; witness shows successor
  O(log log U) and update O(w) honestly; substrate ADR recorded; StratifiedBitset byte-identical
```

===============================================================================
# YFastTrie -- v0.3.0 -- the O(n)-space fix (the practical member)
===============================================================================

```markdown
---
package: "@zakkster/lite-loglogn"
version_target: 0.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
depends_on: [XFastTrie]
gate_note: the amortized/expected member -- deterministic seed; witness MUST print MAX
           single-op time (bucket split/merge + rehash tail), the honesty hook (hook b)
---

# lite-loglogn -- YFastTrie: an x-fast trie over O(n/w) representatives

PURPOSE
  The PRACTICAL member: an x-fast trie over O(n/w) representatives, each carrying a balanced
  bucket of O(w) keys -- dropping space to O(n) and update to O(log log U) amortized/expected.
  The "you can actually use this on a 32-bit universe" answer and the space-fix teaching beat.
  It is the family's amortized/expected-honesty member: bucket splits/merges amortize and any
  representative structure is expected, so the tail is REPORTED, not hidden.

TASKS
  - Implement YFastTrie wrapping XFastTrie's substrate: O(n/w) representatives in the x-fast
    trie; each representative owns a bucket (design call below) of ~w keys; split when a
    bucket exceeds 2w, merge when below w/2.
  - **Design call (settle with user):** the bucket structure -- a small sorted `Uint32Array`
    (cache-friendly, binary search) vs a tiny tree. Lean: sorted array of bounded size, so it
    is pointer-free and zero-GC; record in an ADR with the split/merge policy.
  - Deterministic seeding wherever RNG enters (the repo LCG `seed = (seed*1664525 +
    1013904223) >>> 0`, instance-local, never module state). A fixed seed -> identical sequence.
  - Extend witness.mjs: n-sweep + the U-sweep fit AND **print MAX single-op time** so a
    split/merge or rehash spike shows as a tall bar (honesty hook b).
  - Extend torture (split/merge must not allocate per steady-state op), perf, SPACE (assert
    O(n), the space fix).
  - Docs: member section stating O(log log U) EXPECTED/AMORTIZED + O(n) space + the tail;
    CHANGELOG 0.3.0; ADR. Prior members BYTE-IDENTICAL.

ASSERTIONS
  - Fuzz vs oracle 0 divergences across add/delete/successor/predecessor with splits and
    merges triggered. A deterministic distribution assertion for the seeded bucket policy
    (fixed seed, count bands + a chi-square bound with the CORRECT degrees of freedom --
    lite-o1 RandomSet is the template); never loosened into vacuity.
  - witness: MAX single-op time PRINTED and within a stated bound; the amortized mean still
    fits the double-log; n-sweep crossover reported.
  - torture 0 B/op steady-state (splits/merges amortized, not per-op alloc); all prior
    members still 0 B/op; controls fail.
  - SPACE: O(n) asserted (grows with n, not U) -- the fix over x-fast's O(n*w).

HOT PATH
  Steady-state successor/add/delete are O(log log U) amortized: the x-fast representative
  probe + an in-bucket binary search, zero allocation. Splits/merges are amortized and off
  the steady path; the seeded RNG uses instance-local integer state, no allocation.

NON-GOALS
  No worst-case claim (that is vEBTree). No unbounded bucket growth. Do not hide the tail --
  the MAX bar is the whole honesty point of this member.

DONE WHEN
  YFastTrie shipped, O(n) space asserted, fuzz-vs-oracle green; witness prints the MAX single-op
  tail; determinism proven; prior members byte-identical
```

===============================================================================
# vEBTree -- v0.4.0 -- the worst-case showpiece, flattened for zero-GC
===============================================================================

```markdown
---
package: "@zakkster/lite-loglogn"
version_target: 0.4.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
depends_on: [StratifiedBitset]
gate_note: worst-case O(log log U) EVERY op (no amortized tail); witness MAX bar must be
           flat; SPACE O(U) stated UP FRONT -- the honest ceiling, cross-link y-fast for large U
---

# lite-loglogn -- vEBTree: every op deterministically O(log log U)

PURPOSE
  THE named structure and the worst-case showpiece: every op deterministically O(log log U)
  via the recurse-on-sqrt(U) summary+clusters split. The textbook form is a recursion of
  cluster OBJECTS and allocates per level -- forbidden here -- so it is FLATTENED into typed
  arrays for zero-GC (the flattening strategy is L-06, settled this session). Space O(U) is
  the honest ceiling, stated UP FRONT: ship for modest universes, cross-link y-fast for large U.
  It does NOT need the LevelTable substrate, so it can run in parallel with the trie line.

TASKS
  - **Settle L-06 (flattening strategy) with the user:** a vEB-layout typed array vs an
    iterative high/low-word split. Requirement: worst-case O(log log U) AND 0 B/op AND
    readable enough to teach. Record in decisions/NNNN-veb-flattening.md; prove the flattened
    form against a recursive reference for correctness.
  - Implement vEBTree flattened: summary + clusters in flat Uint32Array(s) with implicit index
    arithmetic; `add`/`delete`/`has`/`successor`/`predecessor`/`min`/`max`, every op worst-case
    O(log log U). typeof-guard first; `undefined` for absent, never key 0.
  - Extend witness (worst-case: the MAX single-op bar must be FLAT -- no amortized spike),
    torture, perf, SPACE (assert O(U); a canary that the arrays are sized to the universe and
    do not grow per op).
  - Docs: member section with O(U) space stated as prominently as the time bound + the explicit
    cross-link to y-fast for large universes; CHANGELOG 0.4.0; ADR. Prior members BYTE-IDENTICAL.

ASSERTIONS
  - Fuzz vs oracle 0 divergences; boundary incl. U=2 base case, single key, full universe,
    successor/predecessor past the ends = `undefined`.
  - The flattened form matches the recursive reference bit-for-bit across the fuzz corpus.
  - witness: worst-case flat MAX bar (contrast with y-fast's tall bar); `log2(w)` fit wins.
  - torture 0 B/op EVERY op incl. the deepest recursion depth flattened -- the arrayBuffers
    gate catches any per-level allocation the naive form would incur; controls fail.
  - SPACE: O(U) asserted and stated up front; the card/README point to y-fast for large U.

HOT PATH
  Every op is O(log log U) worst-case: a bounded descent through the flattened summary/cluster
  arrays, indexed reads only, no recursion frame that allocates, no closures, no per-level `new`.

NON-GOALS
  No O(U)-space apology beyond the honest statement -- it is the correct trade for modest
  universes. No recursion-of-objects (the forbidden textbook form). No large-U default (that
  is y-fast's job).

DONE WHEN
  vEBTree shipped flattened + proven against the recursive reference; every op worst-case
  O(log log U) with a flat witness MAX bar; 0 B/op; O(U) space stated up front; prior members
  byte-identical
```

===============================================================================
# Demo -- the five-file demo (witness line + SPACE dial + crossover foil)
===============================================================================

```markdown
---
package: "@zakkster/lite-loglogn"
version_target: repo-only (no version bump; LogLogN.js byte-identical)
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
depends_on: [YFastTrie, vEBTree]
gate_note: repo-only dev artifact, NEVER in files[]; the engine step must be zero-alloc;
           headline = the witness line WITH the SPACE dial beside it (never speed without space)
---

# lite-loglogn -- the demo: speed and space, side by side, live

PURPOSE
  A repo-only dev artifact modeled beat-for-beat on the lite-lru / lite-o1 / lite-logn demos
  (RESEARCH.md section 9). One shared seeded integer op-stream feeds every member side by side;
  each panel is drawn STRICTLY from that member's live `dump()`/`inspect()` snapshot (no shadow
  state). It ships once 3-4 members exist so the witness comparison and the space dial have range.

TASKS
  - Five-file architecture: `Visualize.mjs` (headless engine, imports only the package main,
    Node-main prints a per-member ns/op + fit + bytes table), `renderers.mjs` (pure, one
    renderer per member, each declares its snapshot `fields` + a `model(snap)` the test
    deep-equals against `dump()`), `serve.mjs` (zero-dep http, computes the seeded op-stream +
    the foil timings, serves statics), `visuals.html` (dark terminal-green, one canvas panel
    per member; controls: structure / workload / seed / **U** / **n** / play / step / speed),
    `Demo.test.mjs` (model==dump, renderer teeth, determinism, zero-alloc engine step,
    leak-free build/run/reset, fail-closed serve + fetch matrix).
  - **The headline is TWO dials, never one:** a ns/op reading with the double-log fit AND a
    bytes/element (or bytes/universe-slot) reading BESIDE it. Cranking U up moves the latency
    dial barely (the double-log) while the MEMORY dial climbs for vEB and holds for y-fast --
    the trade made visible.
  - A second lane runs the O(log n) lite-logn foil whose latency climbs and CROSSES above as n
    grows: the "when the double-log wins" moment, live.
  - Each panel draws the STRUCTURE from its snapshot: StratifiedBitset's summary pyramid with
    the climb/descend path lighting up; vEB's summary+clusters recursion; x-fast/y-fast's level
    tables + the binary-search-over-levels probing + the threaded leaf list.
  - Render the caveats: the MAX-single-op bar for the amortized y-fast; the SPACE dial always
    beside the speed dial; a "universe" readout so the viewer never forgets the bound is in U.

ASSERTIONS
  - Demo.test: `model(snap)` deep-equals `dump()` for every member (no shadow state);
    renderer teeth (a mutated snapshot changes the drawing); determinism (fixed seed ->
    identical op-stream); the engine step is zero-alloc under the gate; build/run/reset leak-free;
    serve fail-closed on a bad fetch.
  - `npm pack --dry-run` still lists exactly the six files[] -- demo/ never ships.
  - LogLogN.js byte-identical (no member change this session).

HOT PATH
  The engine step (advance the shared op-stream, snapshot each member) is zero-alloc -- it is
  gated like a member hot path. Rendering is off the measured path.

NON-GOALS
  No shipped artifact (repo-only). No new member. No LogLogN.js change. No speed shown without
  its space dial.

DONE WHEN
  five-file demo runs; two-dial headline (speed + space) + the O(log n) crossover foil + the
  y-fast MAX bar all render from live dumps; Demo.test green; demo/ excluded from the pack
```

===============================================================================
# Benchmark-ADOPT -- port lite-o1 Bench v2 + double-log fit + memory kernel
===============================================================================

```markdown
---
package: "@zakkster/lite-loglogn"
version_target: repo-only (no version bump; LogLogN.js byte-identical)
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
depends_on: [YFastTrie, vEBTree]
gate_note: this is a COPY-AND-WIRE-PLUS-ONE-KERNEL session, a SETTLED decision --
           NOT a design-the-suite session and NOT a reuse-vs-fork question (section 5.5)
---

# lite-loglogn -- adopt the completed Bench v2, add the loglogn-specific bits

PURPOSE
  The eight-dimension benchmark suite is COMPLETE (user, 2026-09-16) and must NOT be
  reinvented. lite-o1 shipped it as Bench v2 with a `Template.mjs` + `METHODOLOGY.md` written
  expressly for the siblings to copy. This session ADOPTS it: port the framework verbatim, then
  add ONLY the three O(log log U)-specific pieces. There is no "design the suite" work and no
  reuse-vs-fork call to make -- that is settled.

TASKS
  - Port from lite-o1 Bench v2 VERBATIM: the harness, the child-process-per-cell orchestrator,
    the honesty header (seed/node/arch/universe/date), the vacuity/applicability gate (emits the
    string `"n/a"`, never numeric 0), the `traceHash` determinism check, and the hand-rolled
    zero-dep inline-SVG HTML report renderer. Bring `Template.mjs` + `METHODOLOGY.md` across.
  - ADD (the only new work):
    1. **Dimension 1:** the U-sweep double-log FIT (both axes, `log2(w)` must win) + the
       O(log n) lite-logn crossover FOIL.
    2. **Dimension 4 (memory), the MEMORY KERNEL promoted to CO-HEADLINE:** footprint vs U AND
       vs n -- the vEB O(U) / y-fast O(n) / stratified O(U/w) story, plotted so the reader picks
       a member by density.
    3. Baselines: a lite-logn O(log n) member (or sorted-array binary search) for the payoff,
       and a native `Set` (O(1) but UNORDERED, O(n)-space) for the counter-trade.
  - Wire every existing member into Matrix/Dimensions; update Bench.test.mjs counts (anti-vacuity
    + fixed-seed determinism gate).

ASSERTIONS
  - `node --test test/Bench.test.mjs` green: applicability matrix emits `"n/a"` not 0;
    `traceHash` identical across runs at a fixed seed; the memory kernel reports bytes vs U and
    vs n for every member.
  - Dimension 1 reports which axis each member fits and the crossover n vs the O(log n) foil.
  - `npm pack --dry-run` still lists exactly the six files[] -- benchmark/ never ships.
  - LogLogN.js byte-identical.

HOT PATH
  N/A -- benchmark is offline dev infra. The MEASURED members' hot paths are already gated
  by torture/perf; the suite reports, it does not add a hot path.

NON-GOALS
  NOT a design-from-scratch suite. NOT a fork of the framework. No new member. No LogLogN.js
  change. Do not rebuild what Bench v2 already provides -- port it and add the three pieces only.

DONE WHEN
  Bench v2 ported verbatim (+ Template.mjs + METHODOLOGY.md); the double-log fit, the crossover
  foil, and the memory co-headline kernel added; every member wired; Bench.test green; nothing
  new shipped in the pack
```

### Tier 2 -- queued, one per session (RESEARCH.md section 4, Tier 2)

Each is a full BRIEF at planning time, same frontmatter budget and gate set as above
(torture 0 B/op + witness both-sweeps + perf + SPACE co-headline), prior members
byte-identical. Order and space bound stated up front on each:

- ~~**EliasFano** (v0.5.0)~~ -- **SHIPPED ELSEWHERE (amended 2026-10-20):** lite-o1 shipped
  `EliasFano` in 1.9.0 (ADR 0025: a STATIC codec lives in lite-o1, not here). Since lite-o1
  1.11.2, its `access` is O(1) typical / worst-case O(log n) and `nextGEQ` is O(1) typical /
  O(log n) worst. Do NOT rebuild it here. Re-adopt it (design parity, or cite it as the
  succinct comparison point) and use the v0.5.0 slot for the next Tier 2 member.
- **RoaringSet** (v0.6.0) -- the PRACTICAL space-adaptive set: partition the 32-bit universe
  into 2^16 chunks, each stored as whichever container is smallest (sorted Uint16 / bitset /
  run-length). The real-world workhorse; the adaptivity is the teaching beat. `has` is
  bounded O(log), not O(1): array containers are binary-searched, at most 12 probes over
  4,096 entries (amended 2026-10-20). `successor` is O(log); with the summary pyramid of
  section 10 it is a bounded walk. Design notes: section 10 here and RESEARCH.md section 12.
- **Sibling dependency rule (maintainer, 2026-10-22).** lite-o1, lite-logn, lite-adaptive,
  lite-filter and lite-sketch are finished packages meant to improve every module. Use them at
  full potential as devDependencies (oracles, foils, latency / drift harness pieces) or as an
  OPTIONAL, caller-injected peerDependency; never a hard runtime dependency, never an import in
  LogLogN.js. StratifiedBitset 0.2.0 uses lite-o1 + lite-logn as fuzz oracles and REPORTED
  witness foils, lite-sketch DDSketch for latency quantiles, and lite-adaptive DriftDetector to
  flag a drifting host (plan ADDENDUM 28-33).
- **Hybrid tiered bitset** (PROPOSED, maintainer 2026-10-22; name and version slot open) -- one
  ordered integer set that picks the best tier for its universe and workload, Timsort-style:
  a one-word tier, a 32-word + summary tier, a fixed-depth tier (O(1) to 2^25), and the
  log_32 U pyramid above that, plus bulk and / or / xor / popcount written in place. Every tier
  is written in-file (design parity with lite-fastbit32 and lite-o1 BitSet, no imports). Needs
  its own planner pass after 0.2.0. That pass must first show what it adds over (a)
  StratifiedBitset with the 0.2.0 tiered fast paths (plan ADDENDUM 15+) and (b) RoaringSet,
  which already adapts by density; if it adds nothing, it folds into one of them. Gates: a
  parity fuzz against each tier's general form; tier-boundary mutants (U = 32/33, 1024/1025,
  2^25/2^25+1); speed claims STATISTICAL and release-time only.
- **FusionTree** (v0.7.0) -- RESEARCH-TRACK: word-level parallelism packs `w` keys into one
  word; O(log_w n) static predecessor. Notoriously subtle (sketch compression, msb-differing-bit)
  and w=32-capped in JS -- ship with the honest "why this is hard and when word-parallelism pays"
  note, not an early ship.
- **IntUniverseMap** (v0.8.0) -- a composition: any Tier-1 index + a parallel value/handle
  column, turning membership into an ordered integer->payload map. Inherits the chosen index's
  bound and space.
- **SegmentedU** (v0.9.0) -- the 32-bit-ceiling answer (L-05): a labeled 53-bit / split-word
  variant (high word = a Tier-1 structure + low words, or a cold BigInt path). O(log log U) with
  a 2-level split. A variant, never the default; never a silent BigInt hot path.

### Tier 3 -- substrate (evaluate; fold in or cross-reference, not headline members)

- **LevelTable** -- the pointer-free open-addressing `Uint32Array` integer->slot table the
  x-fast/y-fast tries need; FINALIZED in the XFastTrie session (L-03). Shares DNA with lite-o1
  SparseSet / lite-logn NodePool -- reconcile, do NOT fork.
- ~~**RankSelectBits**~~ -- **SHIPPED ELSEWHERE (amended 2026-10-20):** lite-o1 shipped
  `RankSelect` in 1.8.0 (ADR 0024: lite-loglogn RE-ADOPTS it as substrate, never forks). As
  of lite-o1 1.11.2, rank / access are worst-case O(1) and select is worst-case
  O(log(nbits/2048)), bounded but NOT O(1). RoaringSet does not need it: its rank is a
  prefix sum of container cardinalities plus a rank inside one container.
- **clz/ctz helpers** -- the `Math.clz32`-based word primitives (L-07); a tiny shared internal
  here, or a cross-link to lite-fastbit32, never a drifting reimplementation.

### Tier 4 -- exotic reserve (build ONLY when a real use case names it)

Each owns a niche no Tier 1-2 member covers, each "old but gold," each ships ONLY with the
witness AND its honest caveat. Not a near-term queue -- a reserve:

- **ExponentialSearchTree** -- deterministic dynamic O(log log n) predecessor (no randomized
  hashing); the "double-log AND worst-case determinism" member.
- **InterpolationSearchTree** -- O(log log n) EXPECTED for smooth key distributions, degrading
  to O(log n)/O(n) on adversarial keys (the witness must show it); the "measure YOUR distribution"
  specialist.
- **WaveletMatrix** -- succinct rank/select/quantile/rangeCount over an integer alphabet; boundary
  with lite-logn's WaveletTree (lean: the bit-packed matrix form lives HERE on RankSelectBits,
  the pointer form is lite-logn's). Cross-linked, not duplicated.
- **DynamicFusionNode** -- O(1) predecessor over ~sqrt(w) keys packed in one word (Patrascu-Thorup);
  deeply exotic, w=32-capped; a research note on "how O(1)-within-a-word predecessor is possible."
- **VebLayoutSearch** -- not a new bound but a cache-OBLIVIOUS memory LAYOUT for a static search
  tree (van-Emde-Boas order); the bridge between the vEB NAME (recursion) and the vEB LAYOUT.

---

## 8. Cross-package boundaries (state them in the README, do not re-implement)

- **lite-logn** -- the O(log n) sibling and the primary PAIR. lite-logn holds the logarithm with
  GENERAL comparator keys; lite-loglogn beats it to the double-logarithm by REQUIRING bounded
  integer keys past a crossover n. **The O(log n) foil in every lite-loglogn witness IS a
  lite-logn member** (or an equivalent). The "when do I use which" table lives in BOTH GUIDEs.
  Keep the witnesses recognizably kin (flat / straight-log / straight-loglog lines, same fit
  machinery). General comparator keys, strings, floats-as-keys, or an unbounded universe -> a
  lite-logn member, not here.
- **lite-o1** -- the O(1) sibling. Bounded-integer O(1) membership/priority (SparseSet, Dial)
  belongs THERE; lite-loglogn is chosen only when ORDER (predecessor/successor) is required.
- **LevelTable / NodePool / lite-o1 SlotPool / lite-arena** -- ONE free-list / open-addressing
  integer substrate across the suite. Reconcile ownership (L-03) before the first level-table
  member (XFastTrie). Do NOT fork. The single most consequential cross-package call, shared
  with lite-logn.
- **lite-fastbit32** -- the branchless 32-bit flag manager owns the `clz32`/`ctz`/next-set-bit
  word primitives (L-07): dev-only cross-check dependency or a cross-linked recipe, never a
  drifting reimplementation.
- **lite-filter** -- owns APPROXIMATE membership and sketches (Bloom/quotient/cuckoo/HLL).
  lite-loglogn is EXACT. No overlap.

---

## 9. How to run it

In order. `status: planned -> shipped` after each `/release`. Per session, once you
greenlight it: **planner** drafts the spec + atomic tasks + falsifiable assertions and
SURFACES the load-bearing design calls with a recommendation each -> **the design calls
come back to YOU to settle before any code** (for this family, one call is ALWAYS the
space/universe trade) -> **coder -> reviewer -> qa** + the torture / witness / perf /
bench / space gates. Reviewer REJECTED goes back to the coder, NOT forward. Turn limits:
coder 40, reviewer 15, qa 30 (resume via SendMessage, never a fresh Agent). YOU commit /
publish / tag; `/release <semver>` is a gate skill only. After you publish, sync the
catalog card (`~/LiteCatalog/catalog/lite-loglogn.md` + `_index.md`, created on the first
release). The frontmatter budget is IDENTICAL everywhere: `gc_maxMajor: 0`,
`gc_maxPauseMs: 4`, `alloc_bytes_per_op: 0`, `leak_cycles: 4096` -- and none of those
numbers ever moves.

### If you only do a subset

1. **Settle the IDENTITY wording (L-01) first, regardless.** It decides the headline
   member, the witness's primary axis, and every card and README first screen. It is the
   one call that shapes everything else in the document; make it before any code exists to
   contradict it.
2. **StratifiedBitset first.** It is the headline, it has NO substrate to settle, it is
   correct in a page, and it brings up the witness / torture / perf / SPACE gates and
   settles the witness thresholds (L-04) that become the family gate. Everything downstream
   leans on those gates.
3. **The LevelTable direction (L-03) before XFastTrie.** The trie members fork an allocator
   if the substrate direction is not set first. StratifiedBitset and vEBTree do not need it,
   so the concrete table can wait until the XFastTrie session -- but the DIRECTION is an S0
   decision.
4. **Adopt the benchmark, do not build it.** If you reach for the suite, it is a
   copy-and-wire-plus-one-kernel session (section 5.5), never a design session.

### The habit this roadmap is built around

Measure the double-log AND state the space -- never one without the other; the SPACE
co-headline is the honesty hook that defines this niche (law 8). Prove the witness can
FAIL: submit the O(log n) foil as the candidate and watch it fail the `log2(w)`-fit-wins
assertion; that control is why the gate means something. The harness fits BOTH axes
(`log2(w)` and `w`) precisely to catch a mislabeled bound -- an x-fast UPDATE path that is
secretly O(log U) does not get to wear the O(log log U) banner. And when the reviewer
subagent reads a test, the question is not "does this test the feature" -- it is
**"would this test fail if the member were broken."** A test that names a hazard and then
does not touch the code path where the hazard lives is a green light over a hole.

---

## 10. Research intake (2026-10-20) -- RoaringSet with a summary pyramid  [PROPOSED, not scheduled]

**Sources:** `RESEARCH.md` section 12 (the design), and `../Research/BITWISE_RESEARCH.md`
section 10 (the generalization rule, the five tests, the bitset size ladder). Nothing here is
measured. The suite-wide order is `../Research/SUMMARY.md` (items #22 and #23). Nothing starts
before the members ahead of RoaringSet in section 6 have shipped.

**What changes from the Tier 2 line:** standard Roaring plus a summary pyramid at BOTH levels.
That turns `successor` into a bounded walk over the full 32-bit universe, independent of n,
which fits this family's bounded-in-U theme (section 2).

| id | milestone | content | size |
| --- | --- | --- | --- |
| **R1** | core set | top-level chunk index + array / bitmap / run containers from a slab pool; `add` / `delete` / `has` / `successor` / `predecessor` / `size` / iterate; conversions at the 4,096 crossover | large |
| **R2** | set algebra | `union` / `intersect` / `difference` / `xor` container by container (galloping intersection for array x array); `rank` / `select` from a prefix-cardinality column | medium |
| **R3** | interop | read / write the portable RoaringFormatSpec; deserialize into pooled containers; fail closed on a malformed stream | medium |
| R4 *(candidate, 2026-10-21)* | zero-copy view | a read-only `RoaringView` over an `ArrayBuffer` in the portable format: `has` / `successor` jump to one container through the offset header, with no per-container allocation. Reads go through `DataView` (cookie-12347 streams can put containers at odd offsets) | medium |

**Amendments (2026-10-21, from RESEARCH.md 12.6-12.8):**
- **Prior art checked.** `bitrun` (pure TS, 0.1.3) exists but allocates a fresh result per set
  operation. The other JS options are native (`roaring`) or WASM. No pure-JS, zero-GC Roaring was
  found, so R1-R3 fill a real gap, but test 1 (a consumer) is still open. lite-search is the only
  lead.
- **R2 API.** Set algebra writes into a caller-supplied target or works in place, never returning
  a fresh set on a hot path. Add `intersectionSize` / `intersects` / `unionSize`, which
  materialize nothing.
- **R3 reader.** Read through `DataView` (alignment), check byte order once, and run the five
  fail-closed validations in RESEARCH.md 12.7, each with a must-fail stream.
- **Hold:** a bit-sliced index (BSI) for numeric ranges and threshold counts (RESEARCH.md 12.8
  row K). It becomes the R2 follow-up only if lite-search becomes a consumer.
- **Sequencing (maintainer, 2026-10-18):** the lite-signal 1.6.0 release comes first, suite-wide.
- **Tiers at their best (maintainer, 2026-10-22).** The Timsort analogy: Timsort runs insertion
  sort on short runs and merge sort above them; RoaringSet picks a representation per chunk the
  same way. The models for each tier are lite-fastbit32 FastBit32 (one word), FastBit1024 (32
  words + a 1-word summary), lite-o1 BitSet (a fixed 3-level summary, O(1) to 2^25) and
  StratifiedBitset (log_32 U levels to 2^32). D-R1 (b) is a StratifiedBitset over the 2^16
  chunk keys; D-R2 is a FastBit1024-style summary inside each bitmap. Copied by design parity
  in the main file (never a runtime import); the siblings serve as devDep oracles and foils.
  RESEARCH.md 12.10.

**Settle before R1 (maintainer):**
- **D-R1 top-level index.** (a) A sorted key array with binary search, at most 16 probes (the
  standard). (b) A 2^16-bit presence bitmap (8 KB) with summary levels, giving a bounded
  next-non-empty-chunk lookup, plus a key -> container map. That map is either a direct table
  (128-256 KB, O(1)) or a rank over the presence bits (bounded, small). (b) is the
  differentiator; (a) is smaller for tiny sets.
- **D-R2 summary inside bitmap containers.** A FastBit1024-style two-level summary (2,048 words
  -> 64 -> 2), about 3% per container, versus no summary (the standard: scan up to 2,048 words).
- **D-R3 pool sizing.** Capacity classes for array and run containers, and how the pool grows.
  Growth is a cold, disclosed allocation, never on a hot op. Peer: lite-arena, by design parity.
- **D-R4 scope.** `run` containers in R1, or a later `runOptimize()` milestone.

**Gates (in addition to section 5):**
- torture 0 B/op on `add` / `delete` / `has` / `successor` in a warmed pool. A conversion lane
  (array <-> bitmap <-> run, back and forth across 4,096) must also run at 0 B/op once warm.
- must-fail controls: a summary left stale after a bulk op; a `has()` that ignores the type
  code; an allocating conversion.
- a differential fuzz against `Set<number>` + a sorted array over the full 32-bit range,
  including 0, 2^16 - 1, 2^16, 2^32 - 1 and every crossover cardinality.
- witness: successor probe COUNTS (deterministic) on gappy inputs, never timing alone. This is
  the lite-o1 1.11.2 lesson: a sampled scan is not O(1).
- `add` / `delete` on an array container shift up to 4,096 entries, so they print a
  max-single-op line. They are bounded but spiky, and never labelled O(1).

**Not this:** 64-bit Roaring (an ART over the high 48 bits) is out of scope until SegmentedU
settles the 32-bit ceiling. A lite-o1 member: the roster is closed. A RUNTIME dependency on lite-o1 or
lite-fastbit32 (amended 2026-10-22: devDependencies for oracles / foils / harness pieces, or an
OPTIONAL caller-injected peer, are allowed and encouraged; the main file never imports one).

MIT (c) Zahary Shinikchiev
