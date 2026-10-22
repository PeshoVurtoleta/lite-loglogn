/**
 * @zakkster/lite-loglogn -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of LogLogN.js: `VERSION`
 * and the class `StratifiedBitset`. The three-place version sync (package.json /
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
