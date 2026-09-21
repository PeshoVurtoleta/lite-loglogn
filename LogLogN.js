/**
 * @zakkster/lite-loglogn -- a tree-shakeable, zero-GC family of sub-logarithmic
 * bounded-integer predecessor/successor data structures that doubles as a
 * teachable textbook: each member solves a real ordered-integer problem AND
 * proves its bound is real (the O(log log U) Witness -- see test/witness.mjs).
 *
 * The identity is the SPANNING framing: this is a family of sub-logarithmic
 * bounded-integer predecessor/successor structures spanning O(log_w U) to
 * O(log log U), NOT a strict "O(log log U) only" package. The headline first
 * member is StratifiedBitset -- the honest, teachable entry point (array-embedded,
 * zero-GC with no substrate to settle), an O(log_w U) hierarchical bit tree; the
 * strict O(log log U) members (x-fast / y-fast / vEB) follow. The witness's
 * PRIMARY axis is the universe BIT-WIDTH w, never a copied log2(n).
 *
 * v0.1.0 is the SCAFFOLD release: it ships only the `VERSION` const. No member
 * exists yet -- StratifiedBitset is the first member (a later session) and lands
 * append-only, leaving this header and the `VERSION` const the only prior lines
 * that ever change. Planned roster: StratifiedBitset (array-embedded O(log_w U)
 * successor / predecessor over a hierarchical bit tree, O(U/w) space), XFastTrie
 * (O(log log U) query over pointer-free open-addressing LevelTables, O(n*w)
 * space), YFastTrie (the O(n)-space fix over x-fast representatives, expected /
 * amortized), and vEBTree (a flattened van Emde Boas keeping worst-case
 * O(log log U) and 0 B/op). Members are independent (no shared mutable module
 * state), so a bundler that imports one drops the others (`sideEffects: false`).
 *
 * The family delta: lite-o1 proves a FLAT ops/ms line on a log-x axis (the
 * constant, slope ~ 0); lite-logn proves a STRAIGHT line vs log2(n) (one added
 * level per doubling of n); lite-loglogn proves a straight, nearly-flat line vs
 * log2(w) -- one constant additive step per doubling of the universe BIT-WIDTH,
 * the double-logarithm made visible -- AND reports the n-sweep crossover over an
 * O(log n) foil (the "when does this beat a BST" answer as a number). Keys are
 * w-bit integers in [0, U), U = 2^w, with w <= 32 in JS (bitwise ops are 32-bit);
 * wider keys are a labeled SegmentedU variant, never a silent BigInt hot path.
 * Every hot op each member ships is O(log log U) worst-case (or O(log_w U) /
 * expected / amortized where stated) and allocates ZERO bytes after construction.
 *
 * The SPACE price is a co-headline, stated on every member with the same
 * prominence as the time bound (vEB O(U), x-fast O(n*w), y-fast O(n),
 * StratifiedBitset O(U/w)) -- this family's defining honesty hook. The witness
 * harness (never imported here) fits both axes and asserts the log2(w) fit WINS
 * over the O(log U)/w impostor axis -- that line is the theorem made visible.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.1.0';

// --- members land here, append-only, one tree-shakeable class each -----------
// StratifiedBitset (v0.1.0 session) -- array-embedded O(log_w U) successor / predecessor
// XFastTrie        (v0.2.0)         -- O(log log U) query over pointer-free LevelTables
// YFastTrie        (v0.3.0)         -- the O(n)-space fix over x-fast representatives
// vEBTree          (v0.4.0)         -- flattened van Emde Boas, worst-case O(log log U)
