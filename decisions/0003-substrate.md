# 0003 -- LevelTable / NodePool direction (L-03)

- Status: ACCEPTED (direction only; concrete table deferred to XFastTrie;
  RATIFIED by the maintainer 2026-10-22; AMENDED 2026-10-22 -- see Amendment 1)
- Severity: S1 (outlives many members; the single most consequential
  cross-package call, shared with lite-logn)
- Date: 2026-09-18
- Session: S0 (scaffold)

## Context

The trie members (XFastTrie, and YFastTrie built over its representatives) need
a pointer-free integer substrate: open-addressing `Uint32Array` LevelTables and
threaded index columns (`NIL = 0`, slot 0 unused), allocating a slot INDEX rather
than a heap object so nothing is collected per insert. This is the SAME class of
primitive as `@zakkster/lite-o1`'s `SlotPool`, `@zakkster/lite-arena`'s Arena,
and the NodePool `@zakkster/lite-logn` reserves for its SkipList (lite-logn
D-01 / decisions/0001-nodepool.md).

The failure mode is forking it: lite-o1 has private pools and a DEFERRED public
`SlotPool`, lite-arena has its own, lite-logn reserves one. A fourth,
subtly-different fork in lite-loglogn would leave the suite with no shared
correctness story for its most delicate primitive.

Note the scope: this call BLOCKS only the trie members. The array-embedded
members -- StratifiedBitset, and a flattened vEB in vEB-layout typed arrays --
live in flat typed arrays with index arithmetic and need NO LevelTable / NodePool
at all. So the direction must be coherent now (so the array members do not paint
the substrate into a corner), but the CONCRETE table is not needed until the
first trie member.

## Decision

**Set the DIRECTION only in S0: reconcile against ONE shared pointer-free
slot-allocator primitive; do NOT fork it.** Follow lite-logn D-01: lite-loglogn
records the INTENT to reconcile into a single shared primitive (leaning toward
depending on / re-exporting lite-o1's `SlotPool` once it is public, or a single
shared promoted primitive), rather than shipping yet another private variant.

Until a trie member (XFastTrie, v0.2.0) actually needs it, lite-loglogn ships
NOTHING public and NOTHING private for the substrate -- there is no
implementation in this session. StratifiedBitset (and a flattened vEB) do NOT use
it and are unaffected.

**Recommended resolution -- PENDING USER RATIFICATION at review.** The direction
(reconcile-not-fork) is set; the CONCRETE open-addressing LevelTable table is
finalized by the XFastTrie session at the latest, recorded in its own ADR.

## Consequences

- S0 through StratifiedBitset (v0.1.0) ship with no substrate code at all.
- XFastTrie (v0.2.0) is where L-03 BINDS: it reconciles against the shared
  primitive, not a private fork, and records the concrete table (open-addressing
  Uint32Array LevelTables, load factor, rehash policy) in its own ADR.
- The suite-wide invariant holds: one free-list slot allocator across the suite,
  reconciled, never forked.

## Members it shapes

XFastTrie and YFastTrie (they BIND this substrate). StratifiedBitset and the
flattened vEBTree do NOT (array-embedded, index-arithmetic, no pool).

## Alternatives rejected

- **Fork a private lite-loglogn LevelTable now.** Rejected: it is the exact
  substrate failure the suite refuses, and nothing in S0..StratifiedBitset needs
  it.
- **Ship a public LevelTable member in S0.** Rejected: the S0 non-goals forbid a
  substrate implementation; deciding the direction is enough, and the real design
  pressure (what XFastTrie needs -- load factor, rehash, threaded columns) is not
  present yet.

## Amendment 1 (maintainer, 2026-10-22) -- L-03 settled by ADR 0007

The "concrete table" this record deferred is now decided; see
`decisions/0007-leveltable.md`.

- **The concrete call is SETTLED (2026-10-22): ADR 0007.** The LevelTable is an
  in-file bucketized cuckoo table in `LogLogN.js`, with a fixed capacity, shipped
  with XFastTrie in 0.3.0. The Status line above ("concrete table deferred to
  XFastTrie") is therefore closed.
- **"Reconcile" means design parity (ruling R1).** It does NOT mean importing
  lite-o1's code or a shared primitive: lite-o1 rejected a public `SlotPool` (its
  ADR 0021), lite-logn's NodePool is internal, and the sibling rule forbids a
  runtime import into `LogLogN.js`. XFastTrie follows the lite-o1 `CuckooMap`
  design (2 tables x 4-slot buckets, occupancy byte, no tombstones, load <= 0.90,
  fmix32, in-place reseed of up to 32 tries) in its own file; `CuckooMap` is a
  devDependency cross-check oracle only. No fork of its code.
- **Open-addressing is not what shipped.** The body above sketches
  open-addressing `Uint32Array` LevelTables with a load factor and a rehash policy;
  the shipped table is the bucketized cuckoo design and has no growth rehash
  (capacity is fixed; ADR 0007).
- **Version labels in the body above are stale; the correct ones are:**
  XFastTrie is **0.3.0** (the body says "v0.2.0" in the Decision and Consequences
  sections), and StratifiedBitset is **0.2.0** (the body says "v0.1.0"; 0.1.0 was
  the scaffold, `VERSION` only). The body is left as written, as history.
