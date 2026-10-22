/**
 * @zakkster/lite-loglogn -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of LogLogN.js: `VERSION`
 * and the classes `StratifiedBitset` and `XFastTrie`. The three-place version sync (package.json /
 * LogLogN.js VERSION / llms.txt) is gated by test/QaAudit.test.js. One ambient declaration
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
     */
    constructor(universe: number, capacity: number);

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

    /** Cold. Removes every key and restores the default seeds; revives a poisoned instance. */
    clear(): void;
    /** Cold, allocating. A fresh snapshot independent of later mutation. */
    dump(): XFastTrieDump;
}
