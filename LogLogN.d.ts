/**
 * @zakkster/lite-loglogn -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of LogLogN.js: `VERSION`
 * and the classes `StratifiedBitset`, `XFastTrie`, `YFastTrie`, `vEBTree` and `RoaringSet` (with the chunk and dump snapshot interfaces `RoaringSetChunkDump`, `RoaringSetDump`). The three-place version sync
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

/**
 * vEBTree -- worst-case O(log log U) has / add / delete / successor /
 * predecessor and O(1) min / max over a FIXED universe [0, U), 2 <= U <= 2^32:
 * a flattened van Emde Boas tree in one preallocated Uint32Array. No hashing,
 * no reseed, no amortized restructuring, no capacity: every key in [0, U) is
 * always admissible. SPACE is O(U), allocated up front: with w = ceil(log2 U),
 * a node of width w <= 8 is a bitmap of S(w) = 1 word (w <= 5) or 2^(w-5)
 * words, and a node of width w >= 9 costs S(w) = 2 + S(hi) + 2^hi * S(lo),
 * lo = (w > 24 ? 16 : 8), hi = w - lo. The ROOT holds only ceil(U / 2^lo)
 * clusters, so byteLength = 4 * S(w) for w <= 8 and, for w >= 9,
 * 4 * (2 + S(hi) + ceil(U / 2^lo) * S(lo)) (4 bytes per word).
 * Examples: U = 2 -> 4, U = 2^16 -> 8,232, U = 2^20 -> 131,604,
 * U = 2^24 -> 2,105,392, U = 2^32 -> 539,500,592. A sparse large universe
 * belongs to YFastTrie (O(n) space).
 *
 * successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A bad key
 * (not a number, not an integer in [0, U)) touches nothing: has / delete ->
 * false, successor / predecessor -> undefined, add -> RangeError. Absent =
 * `undefined`. Hot methods allocate 0 bytes for keys < 2^30; a returned key
 * >= 2^31 on Node (>= 2^30 on Chrome / Electron, pointer-compressed) may box as
 * a HeapNumber when the returning call is not inlined. On V8 14.6 (Node v26.8.2)
 * successor / predecessor are never inlined (traced in Maglev and TurboFan:
 * bytecode 850 / 838 B, over the 460 B inlining limit), so a returned key >= 2^31
 * boxes there: 16 B per call (measured, torture control CV7). That trace is scoped to that V8. clear() allocates
 * nothing; the constructor allocates the columns once.
 */
export class vEBTree {
    /**
     * @param universe integer in [2, 2^32]; otherwise throws RangeError
     *   `[lite-loglogn] vEBTree universe must be an integer in [2, 2^32]; got ...`.
     */
    constructor(universe: number);

    /** Number of keys present. */
    readonly size: number;
    /** The fixed universe U (keys are integers in [0, U)). */
    readonly universe: number;
    /** Key bit-width w = ceil(log2 U). */
    readonly bits: number;
    /** Bytes of the one typed array owned: 4 * words, S(w) with the trimmed root (see the class comment). */
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

    /** Cold. Removes every key and restores the constructed (empty) state. */
    clear(): void;
}

/** One live chunk in `RoaringSet#dump()`. */
export interface RoaringSetChunkDump {
    /** Chunk index c = key >>> 16. */
    readonly chunk: number;
    /** Container kind (names, not the internal kind ids). */
    readonly kind: 'single' | 'small' | 'array' | 'bitmap' | 'runs' | 'smallRuns' | 'full';
    /** Keys in the chunk, 1..65536. */
    readonly count: number;
    /** Runs held for 'runs' / 'smallRuns', else 0. */
    readonly runs: number;
}

/** The snapshot returned by `RoaringSet#dump()`. */
export interface RoaringSetDump {
    readonly universe: number;
    readonly size: number;
    readonly paged: boolean;
    /** Live chunks, ascending. */
    readonly chunks: readonly RoaringSetChunkDump[];
}

/**
 * RoaringSet -- a compressed ordered set over a FIXED universe [0, U), 1 <= U <= 2^32,
 * Roaring-style: the key space splits into 2^16-key chunks, each held by the
 * smallest fitting container -- SINGLE (1 key, 0 B), small array (2..64 keys,
 * 128 B small slot), array (up to 4,096 keys, 8 KB large slot), bitmap (8 KB +
 * a 66-word summary), runs (8 KB large slot), small runs (<= 32 runs, 128 B small
 * slot), FULL (all 65,536 keys, 0 B). Promote / demote use hysteresis (a small
 * array moves to a large slot at its 65th key; a large-slot array returns to a
 * small slot when a delete leaves <= 32 keys and a small slot is free; an
 * array promotes to a
 * bitmap at its 4,097th key, a bitmap demotes when a delete leaves 2,048). A
 * three-level top pyramid over the chunks (2,115 words) answers next / previous
 * live chunk; per-chunk [min, max] headers answer min / max and cross-chunk
 * successor / predecessor without a container search.
 *
 * SPACE is fixed at construction: every pool is preallocated and NEVER grows.
 * The chunk table is DIRECT (11 B per chunk) or PAGED (a directory plus pooled
 * 2^pageBits-row pages, 11 B per row, page 0 a shared zero page), chosen once
 * at construction; `paged` reports it. byteLength (direct) =
 * 8,460 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge, C =
 * ceil(U / 65536); paged replaces 11 C by 11 (maxPages + 1) 2^pageBits +
 * 2 ceil(C / 2^pageBits) + 4 maxPages + 2. Examples (U = 2^32): default pools,
 * direct 3,036,180; maxSmall 0 / maxLarge 1, direct 746,270, paged maxPages 1
 * 31,524.
 *
 * Bounds (worst typed-array reads found by search (sweep + hill-climb; ADR 0010,
 * gated by RoaringCount.test.js, reported as LOWER bounds)):
 * has / successor / predecessor search 8 / 8 / 9 in a 64-key small array,
 * 14 / 14 / 15 in a 4,096-key array, 25 / 25 / 27 halfwords in a 2,048-run list,
 * 1 / 6 / 6 words in a bitmap; the next / previous live chunk <= 7 top words;
 * min / max 5 reads (6 paged). A conversion is O(container): for example the
 * 4,097th array add (4,117 reads, 2,118 writes, 2,114 moves, gated in
 * RoaringCount.test.js).
 *
 * successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A bad key
 * (not a number, not an integer in [0, U)) touches nothing: has / delete ->
 * false, successor / predecessor -> undefined, add -> RangeError. Absent =
 * `undefined`. Pool exhaustion throws RangeError BEFORE any write (set
 * unchanged), so `add` AND `delete` can throw on a valid key (a delete may need
 * a slot: deleting from a FULL chunk, or splitting a small-runs run past 32 runs).
 *
 * Hot methods allocate 0 bytes for keys < 2^30. A returned key >= 2^31 on Node
 * (>= 2^30 on Chrome / Electron, pointer-compressed) boxes as a HeapNumber when
 * the returning call is not inlined. On V8 14.6 (Node v26.8.2) successor /
 * predecessor are over the 460 B inlining limit (bytecode 610 / 727 B, one body
 * for both layouts, pinned in test/RoaringBytecode.test.js; 647 / 785 B before
 * the P-5 shrink; ADR 0010), and the measured cost on keys in [2^31, 2^32) is
 * successor ~32, predecessor ~32, min ~16, max ~16 B per call; has 0 from an
 * inlined call site, ~16 B per call from a non-inlined one (the argument boxes;
 * ADR 0010). The ~x figures are REPORTED (failing lanes, run-to-run jitter). That
 * trace is scoped to that V8. For clustered data, see runOptimize / addRange.
 */
export class RoaringSet {
    /**
     * Positional arguments.
     * @param universe integer in [1, 2^32]; otherwise throws RangeError
     *   `[lite-loglogn] RoaringSet universe must be an integer in [1, 2^32]; got ...`.
     * @param maxSmall small-slot pool (128 B data + 2 B free-list entry each), integer in [0, 65535]; default 1024.
     * @param maxLarge large-slot pool (8 KB + 264 B each, plus one spare slab), integer in [1, 65534]; default 256.
     * @param maxPages metadata pages, integer in [1, ceil(C / 2^pageBits)]; default (undefined) = all pages.
     *   The layout is paged iff the paged table is smaller than the direct one at these knobs.
     * @param pageBits rows per page = 2^pageBits, integer in [1, 15]; default 8.
     *   Every bad knob throws RangeError `[lite-loglogn] RoaringSet <knob> must be ...; got ...`.
     */
    constructor(universe: number, maxSmall?: number, maxLarge?: number, maxPages?: number, pageBits?: number);

    /** Number of keys present. */
    readonly size: number;
    /** The fixed universe U (keys are integers in [0, U)). */
    readonly universe: number;
    /** True iff the chunk table is paged (fixed at construction). */
    readonly paged: boolean;
    /** Bytes of every typed array owned (the class comment's formula). */
    readonly byteLength: number;

    /** True iff x is present. A bad key returns false. */
    has(x: number): boolean;
    /**
     * Idempotent. Throws RangeError on a bad key, or `[lite-loglogn] RoaringSet <pool> container pool
     * exhausted (capacity N); ...` / `... metadata page pool exhausted (maxPages N) ...` when the key needs a
     * slot or page the pools no longer hold -- each with no state changed. Returns this.
     */
    add(x: number): this;
    /**
     * Adds every key in [lo, hi), 0 <= lo <= hi <= U (integers); lo === hi adds nothing. The set
     * equals that of `add(x)` for each x in [lo, hi); each touched chunk ends in the container kind
     * `runOptimize()` would choose for the final key set at the post-call pool state (fully covered chunks
     * become FULL, 0 B). Precounts the slots and pages it needs, in the write order, and throws
     * RangeError before any write if the pools cannot hold them (set unchanged):
     * `... addRange metadata page pool exhausted (needs N new pages, F free of maxPages M) ...` or
     * `... <pool> container pool exhausted (capacity C) ...`. It counts only each chunk's final
     * container, so under pool pressure it can succeed where the equivalent add loop would throw
     * part-way; and because the precount follows the write order, a range can throw where its final
     * state would fit. A bad bound throws RangeError with nothing touched.
     * Allocates nothing for bounds < 2^30; a bound >= 2^31 boxes at a non-inlined call site (as has). Returns this.
     */
    addRange(lo: number, hi: number): this;
    /**
     * True if x was present. A bad key returns false. Can throw RangeError (pool exhausted, set unchanged)
     * on a present key: a delete from a FULL chunk takes a small slot, else a large one, and throws only
     * when both pools are empty; a delete splitting a small-runs run past 32 runs needs a large slot.
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
     * Cold, O(live chunks). A 65,536-key chunk becomes FULL; an array with fewer runs than half its keys,
     * or a bitmap with <= 2,047 runs, becomes runs (small runs when <= 32 runs and a small slot is free);
     * a runs slab of <= 32 runs moves to a small slot, else becomes an array when smaller. Other
     * containers are kept. Never throws; allocates nothing (when the small pool is empty a
     * small-runs candidate stays in a large slot). Returns this. See the class comment for the cadence.
     */
    runOptimize(): this;

    /**
     * Counting set ops, cold, O(chunks both sets hold). `other` must be a RoaringSet of the same
     * universe (either layout, a direct x paged pair included; any pageBits): otherwise
     * TypeError (not a RoaringSet) or RangeError (universe mismatch). Allocate nothing for counts < 2^30;
     * a count >= 2^31 on Node (>= 2^30 pointer-compressed) returns boxed (EXPECTED, not measured).
     * Neither set changes.
     */
    intersects(other: RoaringSet): boolean;
    intersectionSize(other: RoaringSet): number;
    unionSize(other: RoaringSet): number;
    differenceSize(other: RoaringSet): number;

    /** Cold. Removes every key and restores the constructed (empty) state. Allocates nothing. */
    clear(): void;
    /** Cold, allocating. A fresh snapshot independent of later mutation. */
    dump(): RoaringSetDump;
}
