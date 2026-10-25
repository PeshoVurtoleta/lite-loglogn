/**
 * @zakkster/lite-loglogn -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of LogLogN.js: `VERSION`
 * and the classes `StratifiedBitset`, `XFastTrie` and `YFastTrie`. The three-place version sync
 * (package.json / LogLogN.js VERSION / llms.txt) is gated by test/QaAudit.test.js. One ambient declaration
 * block per member is appended below as each member ships. ASCII-only.
 *
 * @license MIT
 */

/** Package version string. */
export const VERSION: string;

// --- member type blocks land here, append-only, one per shipped member -------

/** The snapshot returned by `StratifiedBitset#dump()`. */
export interface StratifiedBitsetDump {
    /** The fixed universe U. */
    universe: number;
    /** Number of keys present. */
    size: number;
    /** `words[L]` is a copy of level L's words (level 0 = the key bits). */
    words: Uint32Array[];
}

/**
 * StratifiedBitset -- array-embedded O(log_32 U) successor / predecessor over a
 * hierarchical bit tree on a FIXED universe [0, U), 1 <= U <= 2^32. SPACE O(U/w).
 *
 * Cost (words of the one flat Uint32Array read R / written Wr; Lc = `levels`):
 * has R=1; add / delete R=Wr <= Lc when the key changes (else R=1 Wr=0);
 * successor / predecessor R <= 2Lc-1; min / max R=Lc (1 if empty).
 * Hot methods allocate 0 bytes; a returned key >= 2^31 (>= 2^30 on a
 * pointer-compressed engine) may box as a HeapNumber when the call is not inlined.
 * successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A bad key
 * (not a number, not an integer in [0, U)) touches no word: has / delete -> false,
 * successor / predecessor -> undefined, add -> RangeError. Absent = `undefined`.
 */
export class StratifiedBitset {
    /**
     * @param universe integer in [1, 2^32]; otherwise throws RangeError
     *   `[lite-loglogn] universe must be an integer in [1, 2^32]; got ...`.
     */
    constructor(universe: number);

    /** Number of keys present. */
    readonly size: number;
    /** The fixed universe U (keys are integers in [0, U)). */
    readonly universe: number;
    /** Number of levels in the bit tree, max(1, ceil(log2(U)/5)). */
    readonly levels: number;
    /** Bytes held by the bit tree: 4 x total words (the offset table and the object are not counted). */
    readonly byteLength: number;

    /** True iff x is present. A bad key returns false. */
    has(x: number): boolean;
    /** Idempotent. Throws RangeError on a bad key, with no state touched. Returns this. */
    add(x: number): this;
    /** True if x was present. A bad key returns false. */
    delete(x: number): boolean;
    /** Smallest key strictly greater than x, or undefined. */
    successor(x: number): number | undefined;
    /** Largest key strictly less than x, or undefined. */
    predecessor(x: number): number | undefined;
    /** Smallest key, or undefined if empty. */
    min(): number | undefined;
    /** Largest key, or undefined if empty. */
    max(): number | undefined;

    /** Cold. Removes every key. */
    clear(): void;
    /** Cold, allocating. A fresh snapshot independent of later mutation. */
    dump(): StratifiedBitsetDump;
}

/** The snapshot returned by `XFastTrie#dump()`. */
export interface XFastTrieDump {
    /** The fixed universe U. */
    universe: number;
    /** The fixed capacity C (most keys held at once). */
    capacity: number;
    /** Number of keys present. */
    size: number;
    /** Key bit-width w = ceil(log2 U) (the number of trie levels). */
    bits: number;
    /** Every key present, ascending (walked from the leaf thread). */
    keys: Uint32Array;
    /**
     * `levels[L - 1]` for prefix length L = 1..w (level w = the keys), read from
     * the level table itself: `capacity` = its usable slots floor(0.9 S_L),
     * `prefix` ascending, with the subtree `min` / `max` KEY of each prefix.
     */
    levels: {
        capacity: number;
        prefix: Uint32Array;
        min: Uint32Array;
        max: Uint32Array;
    }[];
}

/**
 * XFastTrie -- O(log log U) successor / predecessor over a FIXED universe
 * [0, U), 2 <= U <= 2^32, holding at most `capacity` keys (fixed at
 * construction, fail closed). SPACE O(C*w), preallocated:
 * byteLength = 13 TS + 12 (C+1) + 16 (w+1) + 16 (TS = total level-table slots).
 *
 * Cost in level-table probes (T = log2(w) binary-search steps for w = 2^j; m =
 * the shorter common prefix length of x with its thread neighbours): has 1;
 * successor / predecessor 1 (x present) or 1 + T (absent); min / max 0; add of a
 * new key 1 + T + (w - m) (exact when no kick / reseed fires); delete of a
 * present key w - m. Queries are O(log log U); delete is O(w) worst-case, add
 * expected O(w) (a stall reseeds one level: up to 32 passes, O(C) each). Hot
 * methods allocate 0 bytes; a returned key >= 2^31 on Node (>= 2^30 on Chrome /
 * Electron, pointer-compressed) may box as a HeapNumber when the call is not
 * inlined.
 * successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A bad key
 * (not a number, not an integer in [0, U)) touches nothing: has / delete ->
 * false, successor / predecessor -> undefined, add -> RangeError. Absent =
 * `undefined`. A failed placement after 32 in-place reseed tries rolls the add
 * back and throws RangeError; if the rollback itself fails the instance is
 * POISONED (an Error is thrown; every hot method then throws TypeError on a valid
 * key (min / max always)) until `clear()`.
 */
export class XFastTrie {
    /**
     * @param universe integer in [2, 2^32]; otherwise throws RangeError.
     * @param capacity integer in [1, min(universe, 2^24)]; otherwise throws RangeError.
     * @param seed optional level-seed salt, a uint32 integer in [0, 2^32-1].
     *   Omitted, `undefined` or 0 gives the default level seeds bit for bit; any
     *   other value changes every level's hash seed (deterministic, never random).
     *   Anything else throws RangeError
     *   `[lite-loglogn] XFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ...`.
     *   Validated after universe and capacity.
     */
    constructor(universe: number, capacity: number, seed?: number);

    /** Number of keys present. */
    readonly size: number;
    /** The fixed universe U (keys are integers in [0, U)). */
    readonly universe: number;
    /** The fixed capacity (most keys held at once). */
    readonly capacity: number;
    /** Key bit-width w = ceil(log2 U) (the number of trie levels). */
    readonly bits: number;
    /** Bytes of every typed array the instance owns: 13 TS + 12 (C+1) + 16 (w+1) + 16. */
    readonly byteLength: number;

    /** True iff x is present. A bad key returns false. */
    has(x: number): boolean;
    /**
     * Idempotent. Throws RangeError on a bad key, or on a NEW key at
     * size === capacity, with no state touched. Returns this.
     */
    add(x: number): this;
    /** True if x was present. A bad key returns false. */
    delete(x: number): boolean;
    /** Smallest key strictly greater than x, or undefined. */
    successor(x: number): number | undefined;
    /** Largest key strictly less than x, or undefined. */
    predecessor(x: number): number | undefined;
    /** Smallest key, or undefined if empty. */
    min(): number | undefined;
    /** Largest key, or undefined if empty. */
    max(): number | undefined;

    /**
     * Cold. Removes every key and restores the CONSTRUCTED level seeds (the
     * caller's seed included, even after an in-place reseed); revives a poisoned
     * instance.
     */
    clear(): void;
    /** Cold, allocating. A fresh snapshot independent of later mutation. */
    dump(): XFastTrieDump;
}

/** The snapshot returned by `YFastTrie#dump()`. */
export interface YFastTrieDump {
    /** The fixed universe U. */
    universe: number;
    /** The fixed capacity C (most keys held at once). */
    capacity: number;
    /** Number of keys present. */
    size: number;
    /** Key bit-width w = ceil(log2 U). */
    bits: number;
    /** Every key present, ascending (walked bucket by bucket from the rep thread). */
    keys: Uint32Array;
    /** The representatives, ascending; `reps[0]` is always 0 (the permanent head rep). */
    reps: Uint32Array;
    /** `sizes[i]` = the number of keys in the bucket of `reps[i]` (keys in [reps[i], reps[i+1])). */
    sizes: Uint8Array;
}

/**
 * YFastTrie -- O(log log U) successor / predecessor in O(n) space over a FIXED
 * universe [0, U), 2 <= U <= 2^32, holding at most `capacity` keys (fixed at
 * construction, fail closed). An inner XFastTrie holds O(n/w) representatives;
 * each owns a bounded sorted bucket of keys (w = ceil(log2 U), K = 2w, h =
 * ceil(w/2): the permanent head rep 0 holds 0..K keys, every other bucket h..K).
 * Deterministic: no RNG. SPACE O(C), preallocated: Cr = min(2 + floor(C/h), U),
 * byteLength = 4 (Cr+1) K + (Cr+1) + 16 + the inner XFastTrie(U, Cr).byteLength.
 *
 * Bounds: queries are O(log log U) (one inner locate plus a binary search of
 * one bucket); updates are O(log log U) probes plus at most 2w - 1 contiguous
 * word moves (O(w)); a bucket split / merge / borrow (at most 2w word moves plus
 * one inner add (split), one inner delete (merge) or both (borrow), the inner
 * add expected O(w)) is AMORTIZED. Hot methods
 * allocate 0 bytes for keys < 2^30; a returned key >= 2^31 on Node (>= 2^30 on
 * Chrome / Electron, pointer-compressed) may box as a HeapNumber when the call is
 * not inlined.
 * successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A bad key
 * (not a number, not an integer in [0, U)) touches nothing: has / delete ->
 * false, successor / predecessor -> undefined, add -> RangeError. Absent =
 * `undefined`. A split or borrow whose inner add stalls throws the inner
 * XFastTrie RangeError (its text, not "YFastTrie") with the set UNCHANGED -- so
 * `add` AND `delete` (a delete may borrow) can throw on a valid key. If the
 * inner rollback itself fails, an Error is thrown and the instance is POISONED:
 * every hot method then throws TypeError on a valid key (min / max always) until
 * `clear()`.
 */
export class YFastTrie {
    /**
     * @param universe integer in [2, 2^32]; otherwise throws RangeError.
     * @param capacity integer in [1, min(universe, 2^24)]; otherwise throws RangeError.
     * @param seed optional uint32 integer in [0, 2^32-1], forwarded to the inner
     *   XFastTrie (omitted, `undefined` or 0 = the default level seeds); anything
     *   else throws RangeError
     *   `[lite-loglogn] YFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ...`.
     *   The seed never changes a successful answer, only the inner hash layout
     *   (whether an add stalls depends on that layout).
     */
    constructor(universe: number, capacity: number, seed?: number);

    /** Number of keys present. */
    readonly size: number;
    /** The fixed universe U (keys are integers in [0, U)). */
    readonly universe: number;
    /** The fixed capacity (most keys held at once). */
    readonly capacity: number;
    /** Key bit-width w = ceil(log2 U). */
    readonly bits: number;
    /** Bytes of every typed array owned, the inner trie included: 4 (Cr+1) K + (Cr+1) + 16 + inner. */
    readonly byteLength: number;

    /** True iff x is present. A bad key returns false. */
    has(x: number): boolean;
    /**
     * Idempotent. Throws RangeError on a bad key, on a NEW key at size ===
     * capacity (`YFastTrie is full`), or when a split's inner add stalls -- each
     * with no state changed -- or the poison Error if that rollback fails. Returns
     * this.
     */
    add(x: number): this;
    /**
     * True if x was present. A bad key returns false. Can throw RangeError on a
     * present key when the borrow it triggers stalls in the inner add (set
     * unchanged), or the poison Error if that rollback fails.
     */
    delete(x: number): boolean;
    /** Smallest key strictly greater than x, or undefined. */
    successor(x: number): number | undefined;
    /** Largest key strictly less than x, or undefined. */
    predecessor(x: number): number | undefined;
    /** Smallest key, or undefined if empty. */
    min(): number | undefined;
    /** Largest key, or undefined if empty. */
    max(): number | undefined;

    /**
     * Cold. Removes every key and restores the constructed state (the inner
     * trie's constructed seeds, the caller's seed included; rep 0 re-added);
     * revives a poisoned instance.
     */
    clear(): void;
    /** Cold, allocating. A fresh snapshot independent of later mutation. */
    dump(): YFastTrieDump;
}
