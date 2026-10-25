# 0007 -- LevelTable: the in-file bucketized cuckoo table (L-03 settled)

- Status: ACCEPTED (maintainer, 2026-10-22)
- Severity: S1 (the substrate every trie member binds: XFastTrie now, YFastTrie later)
- Date: 2026-10-22
- Session: XFastTrie (0.3.0)

## Context

ADR 0003 (L-03) set the DIRECTION only: reconcile against one shared pointer-free
substrate, do not fork it, and record the concrete table in the first trie member's
own ADR. XFastTrie is that member. It needs one hash table per prefix length
L = 1..w (level w holds the keys), keyed by the prefix, whose value is the leaf
index of the smallest and the largest key under that prefix, plus a sorted leaf
thread of index columns.

Facts that frame the choice (checked 2026-10-22): `@zakkster/lite-o1` rejected a
public `SlotPool` (its ADR 0021) and keeps its pools private; `@zakkster/lite-logn`'s
NodePool is internal; the sibling rule forbids a runtime import into `LogLogN.js`
(zero runtime dependencies, one main file, tree-shakeable). lite-o1 `CuckooMap`
already runs the table this problem wants: 2 tables x 4-slot buckets, at most 8
slot probes per lookup, an occupancy byte (no sentinel key, so 0 is a legal key),
no tombstones, load ceiling 0.90, an in-place reseed of up to 32 tries.

## Decision

**R1 (maintainer): a LevelTable is an in-file bucketized cuckoo table in
`LogLogN.js`, design parity with lite-o1 `CuckooMap` -- no import, no fork of its
code.** "Reconcile" (ADR 0003) means design parity: the same layout rules, the same
fmix32 finalizer (`Math.imul` with 0x85ebca6b and 0xc2b2ae35), the same load
ceiling, the same reseed budget. CuckooMap stays a devDependency cross-check
oracle only.

- **Layout.** One LevelTable per level, all back to back in shared typed-array
  columns `_occ` (Uint8), `_tk` (Int32 prefix), `_tmin` / `_tmax` (Int32 leaf
  index of the prefix subtree's min / max key). Per level: capL = min(C, 2^L),
  B_L = the power of two >= ceil(capL * 10 / 72) (load <= 0.90), S_L = 8 B_L slots
  (2 tables x B_L buckets x 4 slots). A descriptor column `_lv` holds base, mask
  and the two seeds per level. The keys live in a sorted doubly linked thread
  (`_key`, `_next`, `_prev`, length C + 1, slot 0 the circular sentinel, free
  leaves a LIFO list through `_next`).
- **Space.** `byteLength = 13 TS + 12 (C + 1) + 16 (w + 1) + 16`, TS = sum of S_L
  (13 bytes per slot, 12 per leaf, 16 per descriptor row, 16 scratch). O(n*w),
  allocated up front from the capacity.
- **Fixed capacity, cap 2^24 (A2, maintainer).** `new XFastTrie(universe, capacity)`
  with capacity in [1, min(U, 2^24)]; every column is allocated in the constructor
  and never replaced (except `_q`: poison nulls it, clear() re-creates it); `add` of a NEW key at `size === capacity` throws a
  `RangeError` and writes nothing. The cap keeps TS below 2^29, so every table
  index stays a small integer, and bounds the worst case: 4,563,403,308 B at
  U = 2^32, C = 2^24 (DETERMINISTIC, a formula pin; never allocated in tests).
- **Early-stop update walk (A1, maintainer).** `add` and `delete` walk the levels
  from w down only as far as the shorter common prefix length m of x with its two
  thread neighbours: `add` of a new key = 1 + T + (w - m) touches, `delete` of a
  present key = w - m. Levels at or above m are untouched. The counts are
  DETERMINISTIC (`test/XftCount.test.js`).
- **Failure ladder (poison step: A3, maintainer).** A cuckoo stall first tries the kick chain,
  then an in-place reseed of that level from the leaf thread (the thread is the
  snapshot, so 0 B): up to 32 tries. If all 32 fail the `add` is rolled back by a
  logical restore (levels above the failed one are undone, the leaf is unspliced,
  the failed level is rebuilt under its start seeds) and a `RangeError` is thrown.
  If even the rebuild cannot re-place a level, the instance is POISONED: the
  scratch column is set to `null`, a loud `Error` is thrown, every hot method then
  throws a `TypeError` on a valid key (`min` / `max` always), and only `clear()`
  revives it (it restores the default seeds). A bad key is rejected before the
  scratch column is read, so it still gives `false` / `undefined` / `RangeError`.
  Storing `null` widens that field's type once, cold; optimized code that assumed
  an `Int32Array` there deopts.
- **Counters (A10).** Kicks, reseed operations and tries are cumulative Int32
  counters in slots 1..3 of the scratch column `_q` (slot 0 is the key scratch).
  `clear()` keeps them (reviving a poisoned instance resets them to 0); they wrap at 2^31 (no saturation); they are REPORTED
  diagnostics and the engine never reads them. Torture X2 / X3 / X4 read them to
  prove the reseed path allocates 0 B and to tooth the gate.
- **Hot-body shape.** The kick chain, the rebuild, the rollback, the poison path
  and every error string live in cold helpers; the hot probe (`_slot`) and insert
  (`_put`) are small (every hot body <= 460 B of bytecode on Node 26.8.2, gated by
  `test/XftBytecode.test.js`; whether V8 inlines them is not gated).

**The hash-flood caveat, stated plainly.** The seeds are FIXED defaults per level
(a pure function of the level and its size; there is no per-instance randomness and
no entropy source), so a run is reproducible and the stream-replay gates are exact.
The price: anyone who controls the keys can compute keys that share both home
buckets at a level (the test helper `collide()` does exactly that), forcing kick
chains and reseeds. CORRECTNESS holds (the reseed re-places a level from the sorted
thread; after 32 failed tries the add rolls back or, at worst, poisons the
instance); TIME suffers (each forced reseed is O(capacity) at one level, up to 32
tries, and an add can then fail with a `RangeError` although the set is not full).
Do not feed XFastTrie untrusted keys without bounding that.

## Consequences

- L-03 is settled for the trie members: a single in-file table design, no import,
  no fork. YFastTrie (built over x-fast representatives) reuses the design rather
  than a second variant.
- Query cost is the exact touches in ADR 0004 Amendment 1 terms: an absent
  `successor` / `predecessor` is 1 + T touches, T = log2(w) for w = 2^j; update
  cost is O(w); space is O(n*w), paid at construction. All three are stated in the
  README with the same prominence.
- Rows of the cost model are exact only while no kick or reseed fires (`add`); kicks
  and tries are REPORTED, not gated.
- `LogLogN.js` grows by one member appended after StratifiedBitset; the 0.2.0
  region is byte-pinned (`test/Parity.test.js`).

## Alternatives rejected

- **Import lite-o1 `CuckooMap`.** Rejected: a runtime dependency into the one main
  file (the sibling rule).
- **Fork lite-o1's private pools or code into a second, subtly different variant.**
  Rejected (ADR 0003): the exact substrate fork the suite refuses; design parity
  with a devDependency oracle is the reconciliation.
- **A public shared `SlotPool` / LevelTable export.** Rejected: lite-o1 itself
  rejected a public SlotPool (its ADR 0021) and lite-logn keeps its NodePool
  internal; a public primitive here would be a fourth surface to keep in lockstep.
- **Open-addressing `Uint32Array` tables (ADR 0003's original sketch).** Superseded by R1:
  the bucketized cuckoo table has a hard bound of 8 slot probes per lookup and
  needs no tombstones on delete; the hash-flood caveat applies to either.
- **A z-fast trie instead of a plain x-fast trie (R2, maintainer).** Deferred to the
  YFastTrie decision.
- **Growth on demand / hidden rehash (R3, maintainer).** Rejected: capacity is fixed
  at construction; the only rebuild is the labelled in-place reseed.
- **Per-instance random seeds.** Not shipped (maintainer ruling, 2026-10-23). 0.3.0 keeps
  the fixed default seeds plus the hash-flood caveat above. Never random-by-default: it
  would make the deterministic count, replay and reseed-census gates non-reproducible.
  Planned for 0.4.0 with YFastTrie: an OPTIONAL caller-supplied ctor seed, CuckooMap-style
  (a uint32 validated fail-closed, RangeError; omitted = today's deterministic defaults).
  XFastTrie gains the same optional argument additively (maintainer ruling 2026-10-25; an additive exception to 'prior members BYTE-IDENTICAL').
  (This decisions/ folder is not shipped: it is not in package.json files[].)

## Amendment

(none yet)
