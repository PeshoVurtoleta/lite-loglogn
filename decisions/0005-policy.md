# 0005 -- 32-bit ceiling / wider-key policy + clz32 boundary (L-05 / L-07)

- Status: ACCEPTED (policy + direction; builds deferred to SegmentedU /
  StratifiedBitset; PENDING USER RATIFICATION)
- Severity: S2 (shapes the universe contract on every member) + S3 (the word
  primitive boundary)
- Date: 2026-09-18
- Session: S0 (scaffold)

## Context

Two calls that must be coherent before member 1, bundled because both concern the
w-bit word the whole family stands on.

**L-05, the 32-bit ceiling.** JS bitwise ops are 32-bit, so the natural universe
is U <= 2^32 (w <= 32). Keys are w-bit integers in [0, U). A 53-bit / 64-bit
universe needs either a split high-word + low-word representation or a BigInt
path -- and a silent BigInt hot path would allocate and blow the 0-B/op law.

**L-07, the clz32 boundary.** The `clz32` / `ctz` / next-set-bit word primitives
StratifiedBitset (and every member) leans on are `@zakkster/lite-fastbit32`'s
territory. Three ways to get them: a tiny shared internal here, a dev-only
cross-check dependency on lite-fastbit32, or a cross-linked recipe. The failure
mode is a DRIFTING reimplementation that disagrees with lite-fastbit32 at an edge.

## Decision

**L-05: 32-bit default; `SegmentedU` as a Tier-2 LABELED variant, never a silent
BigInt hot path.** The Tier-1 members operate on w <= 32 with `Math.clz32` /
`x & -x` word ops. Wider keys are a Tier-2 `SegmentedU` variant -- a labeled
high-word + low-word split (preferred) or a clearly-cold BigInt path -- built in
its own session (SegmentedU), never folded silently into a hot path. `null` is
not zero; an out-of-universe key fails closed with a `[lite-loglogn]` throw.

**L-07: a tiny shared INTERNAL, or a cross-linked recipe -- never a drifting
reimplementation.** The direction: keep the word primitives to a few lines
(`Math.clz32` is a JS builtin; `ctz`, next-set-bit are 2-3 lines each), either as
a tiny internal in `LogLogN.js` cross-linked to lite-fastbit32's recipe, or as a
dev-only cross-check dependency that asserts agreement in a test. Whichever is
chosen in StratifiedBitset, it must be a SINGLE source of truth, byte-verified
against lite-fastbit32, not a fork that can drift.

**Recommended resolution -- PENDING USER RATIFICATION at review.** The 32-bit
default + Tier-2 SegmentedU policy and the no-drift clz32 direction are on the
record; the concrete SegmentedU representation is settled in its session, and the
internal-vs-cross-check clz32 form is settled in StratifiedBitset.

## Consequences

- Every Tier-1 member documents "w <= 32, U <= 2^32" as its universe contract and
  fails closed on out-of-universe keys.
- SegmentedU is a queued Tier-2 session, not a Tier-1 concern; it must keep the
  hot path allocation-free (no per-op BigInt).
- The word primitives are a single source of truth cross-checked against
  lite-fastbit32; a divergence is a test failure, not a silent edge bug.

## Members it shapes

ALL Tier-1 members (the 32-bit universe contract + clz32 word ops). SegmentedU
(the Tier-2 wider-key build). StratifiedBitset settles the concrete clz32 form.

## Alternatives rejected

- **A silent BigInt hot path for wide keys.** Rejected: it allocates per op and
  breaks the 0-B/op law -- the family's hardest invariant.
- **A private clz32 reimplementation per member.** Rejected: it drifts from
  lite-fastbit32; a single cross-checked source of truth is required.
