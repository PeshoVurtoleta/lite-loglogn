# 0003 -- LevelTable / NodePool direction (L-03)

- Status: ACCEPTED (direction only; concrete table deferred to XFastTrie;
  RATIFIED by the maintainer 2026-10-22)
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
