# 0001 -- Package identity + headline framing (L-01)

- Status: ACCEPTED (recommended resolution TAKEN; PENDING USER RATIFICATION)
- Severity: S1 (the single most load-bearing decision; outlives every member)
- Date: 2026-09-18
- Session: S0 (scaffold)

## Context

The most consequential wording call in the package. Two framings were on the
table (ROADMAP section 4, L-01):

1. **Strict:** "strictly O(log log U) (vEB / x-fast / y-fast), with
   StratifiedBitset as an O(log_w U) cousin."
2. **Spanning:** "sub-logarithmic bounded-integer predecessor/successor,
   spanning O(log_w U) to O(log log U)."

This choice decides the HEADLINE member (StratifiedBitset vs vEB), the witness's
PRIMARY axis, and every card, README first screen, and GUIDE table. It cannot be
walked back cheaply once members ship.

## Decision

**Adopt the SPANNING framing, with StratifiedBitset as the headline first
member.** The package is a family of sub-logarithmic bounded-integer
predecessor/successor structures spanning O(log_w U) to O(log log U). The strict
O(log log U) members (x-fast / y-fast / vEB) sit inside that span; they are not
excluded, they are the fast end of it.

StratifiedBitset is the headline because it is the honest, teachable entry point:
array-embedded, zero-GC with NO substrate to settle (no LevelTable / NodePool
dependency), and correct in a page. It is O(log_w U) worst-case -- genuinely
sub-logarithmic on a bounded universe -- so it belongs under the spanning banner
without overclaiming O(log log U).

**Recommended resolution -- PENDING USER RATIFICATION at review.** The lean is
the spanning framing + StratifiedBitset first (ROADMAP L-01), but it shapes
everything downstream, so it is settled explicitly, on the record, and the user
ratifies it at review before member 1.

## Consequences

- The witness's PRIMARY fit axis is the universe BIT-WIDTH (log2(w)), NOT
  log2(n) -- because the family's honest bound is in U, not n. See
  decisions/0004-witness.md.
- The README first screen, llms.txt "What it is", and the GUIDE picker all lead
  with the spanning framing and route StratifiedBitset as the entry point.
- Every member states BOTH its time bound and its SPACE bound as co-headlines
  (StratifiedBitset O(U/w), x-fast O(n*w), y-fast O(n), vEB O(U)).

## Members it shapes

ALL members -- this is the family's identity. Directly: StratifiedBitset (the
headline / entry point), and the framing under which XFastTrie / YFastTrie /
vEBTree are presented as the O(log log U) fast end of the span.

## Alternatives rejected

- **Strict O(log log U) framing with vEB as headline.** Rejected: vEB is the
  hardest member to make zero-GC and teachable (a recursion of cluster objects in
  the textbook form); leading with it puts the least approachable member first and
  forces the substrate/flattening call before the family even has a member. The
  spanning framing is more honest about what ships first and lets the teachable
  member lead.
