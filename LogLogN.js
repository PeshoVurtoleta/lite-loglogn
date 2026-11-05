/**
 * @zakkster/lite-loglogn -- a tree-shakeable, zero-GC family of sub-logarithmic
 * bounded-integer predecessor/successor data structures that doubles as a
 * teachable textbook: each member solves a real ordered-integer problem AND
 * proves its bound is real. The proof is deterministic COUNTS (exact words /
 * probes per op, gated in `npm test`; decisions/0004 Amendment 1); timing
 * (test/witness.mjs) is REPORTED, never the gate.
 *
 * The identity is the SPANNING framing: this is a family of sub-logarithmic
 * bounded-integer predecessor/successor structures spanning O(log_w U) to
 * O(log log U), NOT a strict "O(log log U) only" package. The headline first
 * member is StratifiedBitset -- the honest, teachable entry point (array-embedded,
 * zero-GC with no substrate to settle), an O(log_w U) hierarchical bit tree; the
 * strict O(log log U) members (x-fast / y-fast / vEB) are appended after it.
 * The witness's PRIMARY axis is the universe BIT-WIDTH w, never a copied log2(n).
 *
 * v0.1.0 was the SCAFFOLD release (the `VERSION` const only). Members are
 * appended below append-only: this header, the roster comment and the `VERSION`
 * const are the only prior lines that ever change. StratifiedBitset (0.2.0):
 * array-embedded O(log_w U) successor / predecessor over a hierarchical bit
 * tree, O(U/w) space. XFastTrie (0.3.0): O(log log U) successor / predecessor
 * over pointer-free bucketized-cuckoo LevelTables, one per prefix length, plus a
 * sorted leaf thread; updates are honestly O(w); O(n*w) space, preallocated at a
 * FIXED capacity. YFastTrie (0.4.0): O(log log U) successor / predecessor over
 * an inner XFastTrie of O(n/w) representatives, each owning a bounded sorted
 * bucket of <= 2w keys; an update is O(log log U) probes plus at most 2w - 1
 * contiguous word moves, and a bucket split / merge / borrow is AMORTIZED
 * (deterministic buckets, no RNG); O(n) space, preallocated at a FIXED capacity.
 * vEBTree (0.5.0): a flattened van Emde Boas tree in ONE preallocated
 * Uint32Array; worst-case O(log log U) has / add / delete / successor /
 * predecessor and O(1) min / max, with no hashing, no reseed and no amortized
 * split; O(U) space, the whole universe allocated up front.
 * Members are independent (no shared mutable module state), so a bundler that
 * imports one drops the others (`sideEffects: false`).
 *
 * The family delta: lite-o1 proves a FLAT ops/ms line on a log-x axis (the
 * constant, slope ~ 0); lite-logn proves a STRAIGHT line vs log2(n) (one added
 * level per doubling of n); lite-loglogn's bound is in the UNIVERSE, not n.
 * StratifiedBitset is O(log_32 U): levels = max(1, ceil(w/5)), linear in the
 * bit-width w. XFastTrie's absent-key query is 1 + T level-table probes, T =
 * log2(w) binary-search steps for w = 2^j: one step per doubling of w. The HARD
 * proof is deterministic COUNTS (exact words / probes read and written per op,
 * gated in `npm test`; decisions/0004 Amendment 1, 0006). Timing is REPORTED: a
 * release-time run reports the n-sweep crossover over an O(log n) foil (the
 * "when does this beat a binary search" answer as a number) and gates nothing.
 * Keys are w-bit integers in [0, U), U = 2^w, with w <= 32 in JS (bitwise ops
 * are 32-bit); wider keys are a labeled SegmentedU variant, never a silent
 * BigInt hot path.
 * Every hot op each member ships states its bound -- O(log_w U) (StratifiedBitset),
 * O(log log U) queries and O(w) updates (XFastTrie; an update's cuckoo insert is
 * expected O(1) per level, with an in-place reseed on a stall), O(log log U)
 * queries and O(log log U)-probe updates with at most 2w - 1 word moves
 * (YFastTrie; a bucket split / merge / borrow is amortized and adds one inner
 * XFastTrie update (a borrow two: an inner add, then an inner delete)),
 * O(log log U) has / add / delete / successor / predecessor and O(1) min / max
 * (vEBTree; no hashing, no amortized step), worst-case unless labelled
 * expected / amortized -- and allocates ZERO bytes after construction.
 *
 * The SPACE price is a co-headline, stated on every member with the same
 * prominence as the time bound (vEB O(U), x-fast O(n*w), y-fast O(n),
 * StratifiedBitset O(U/w)) -- this family's defining honesty hook. XFastTrie
 * allocates its O(C*w) worst case up front, sized by its capacity C, not by the
 * keys present: byteLength = 13 TS + 12 (C+1) + 16 (w+1) + 16 (see its class
 * comment). YFastTrie allocates O(C) words up front: byteLength = 4 (Cr+1) K +
 * (Cr+1) + 16 + the inner XFastTrie(U, Cr).byteLength, Cr = min(2 + floor(C/h),
 * U), K = 2w, h = ceil(w/2) (see its class comment). vEBTree allocates its O(U)
 * words up front, the whole universe, independent of the keys present; with
 * w = bits = ceil(log2 U) = 32 - clz32(U - 1) for every U in [2, 2^32] (U = 2
 * -> w = 1; U = 2^k -> w = k; any other U -> w = floor(log2 U) + 1):
 * byteLength = 4 ceil(2^w / 32) for w <= 8, else
 * 4 (2 + S(hi) + ceil(U / 2^lo) S(lo)), S(w) = 2 + S(hi) + 2^hi S(lo) for
 * w >= 9 and ceil(2^w / 32) for w <= 8, lo = w > 24 ? 16 : 8, hi = w - lo (only
 * the root's cluster count is trimmed to ceil(U / 2^lo); see its class
 * comment). The witness harness (never imported here) REPORTS fits on both the
 * log2(w) and the w axis and gates on neither: the w axis fit StratifiedBitset
 * better in the 2026-10-22 run (R^2 0.7293 vs 0.6589), as its O(log_32 U) label
 * predicts.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.5.0';

// --- members land here, append-only, one tree-shakeable class each -----------
// StratifiedBitset (v0.2.0)         -- array-embedded O(log_w U) successor / predecessor
// XFastTrie        (v0.3.0)         -- O(log log U) query over pointer-free LevelTables
// YFastTrie        (v0.4.0)         -- the O(n)-space fix over x-fast representatives
// vEBTree          (v0.5.0)         -- flattened van Emde Boas, worst-case O(log log U)
// RoaringSet       (v0.6.0)         -- Roaring-container compressed 32-bit set

// --- StratifiedBitset (0.2.0) ------------------------------------------------

/**
 * Cold. Throws the RangeError for a bad key passed to add(). Kept out of add's
 * body so the error-string bytes never sit in the hot method. Describes x
 * without calling any user toString / valueOf (a Symbol never throws TypeError).
 * @param {*} x
 * @param {number} u
 */
function throwKey(x, u) {
    throw new RangeError('[lite-loglogn] key must be an integer in [0, ' + u + '); got ' +
        (typeof x === 'number' ? String(x) : typeof x));
}

/**
 * StratifiedBitset -- array-embedded O(log_32 U) successor / predecessor over a
 * hierarchical bit tree on a FIXED universe [0, U), 1 <= U <= 2^32.
 *
 * Layout: ONE flat Uint32Array `_bits` holding every level back to back (level 0
 * = the key bits, level L+1 bit i = "level L word i is nonzero"), plus an
 * Int32Array `_off` (length levels+1, `_off[levels]` = total words).
 * W0 = ceil(U/32), W(L+1) = ceil(W(L)/32), stop at W = 1; levels =
 * max(1, ceil(log2(U)/5)). SPACE = byteLength = 4 x total words.
 *
 * Cost (words of `_bits` read R / written Wr; Lc = levels): has R=1; add/delete
 * R=Wr <= Lc (1 + levels whose word changed emptiness) when the key changes, else
 * R=1 Wr=0 (no-op); successor/predecessor R <= 2Lc-1; min/max R=Lc (1 if empty).
 * Hot methods allocate 0 bytes; a returned key >= 2^31 (>= 2^30 on a pointer-
 * compressed engine) may box as a HeapNumber when the call is not inlined.
 * successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A bad key
 * (not a number, not an integer in [0, U)) touches no word: has/delete -> false,
 * successor/predecessor -> undefined, add -> RangeError.
 */
export class StratifiedBitset {
    /** @param {number} universe integer in [1, 2^32] */
    constructor(universe) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 1 || universe > 4294967296) {
            throw new RangeError('[lite-loglogn] universe must be an integer in [1, 2^32]; got ' +
                (typeof universe === 'number' ? String(universe) : typeof universe));
        }
        let w = Math.ceil(universe / 32);
        let levels = 1;
        let total = w;
        while (w > 1) {
            w = Math.ceil(w / 32);
            total += w;
            levels++;
        }
        const off = new Int32Array(levels + 1);
        w = Math.ceil(universe / 32);
        for (let L = 0; L < levels; L++) {
            off[L + 1] = off[L] + w;
            w = Math.ceil(w / 32);
        }
        this._u = universe;
        this._top = levels - 1;
        this._size = 0;
        this._off = off;
        this._bits = new Uint32Array(total);
    }

    /** Number of keys present. */
    get size() { return this._size; }

    /** The fixed universe U (keys are integers in [0, U)). */
    get universe() { return this._u; }

    /** Number of levels in the bit tree, max(1, ceil(log2(U)/5)). */
    get levels() { return this._top + 1; }

    /** Bytes held by the bit tree: 4 x total words (`_off` and the object not counted). */
    get byteLength() { return this._bits.byteLength; }

    /** @param {number} x @returns {boolean} */
    has(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        return (this._bits[x >>> 5] & (1 << (x & 31))) !== 0;
    }

    /** @param {number} x @returns {this} throws RangeError on a bad key (no state touched) */
    add(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) throwKey(x, this._u);
        const b = this._bits;
        const o = this._off;
        const t = this._top;
        let p = x >>> 5;
        let m = 1 << (x & 31);
        let v = b[p];
        if ((v & m) !== 0) return this;
        b[p] = v | m;
        this._size++;
        let i = p;
        let L = 0;
        while (v === 0 && L < t) {
            L++;
            p = o[L] + (i >>> 5);
            m = 1 << (i & 31);
            v = b[p];
            b[p] = v | m;
            i >>>= 5;
        }
        return this;
    }

    /** @param {number} x @returns {boolean} true if x was present */
    delete(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        const b = this._bits;
        const o = this._off;
        const t = this._top;
        let p = x >>> 5;
        const m = 1 << (x & 31);
        let v = b[p];
        if ((v & m) === 0) return false;
        v &= ~m;
        b[p] = v;
        this._size--;
        let i = p;
        let L = 0;
        while (v === 0 && L < t) {
            L++;
            p = o[L] + (i >>> 5);
            v = b[p] & ~(1 << (i & 31));
            b[p] = v;
            i >>>= 5;
        }
        return true;
    }

    /** Smallest key > x, or undefined. @param {number} x @returns {number|undefined} */
    successor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        let i = x + 1;
        if (i >= this._u) return undefined;
        const b = this._bits;
        const o = this._off;
        let p = i >>> 5;
        let v = b[p] & (-1 << (i & 31));
        if (v !== 0) return ((p << 5) | (31 - Math.clz32(v & -v))) >>> 0;
        i = p + 1;
        if (i >= o[1]) return undefined;
        let L = 1;
        for (;;) {
            p = i >>> 5;
            v = b[o[L] + p] & (-1 << (i & 31));
            if (v !== 0) {
                i = (p << 5) | (31 - Math.clz32(v & -v));
                break;
            }
            i = p + 1;
            if (i >= o[L + 1] - o[L]) return undefined;
            L++;
        }
        while (L > 0) {
            L--;
            v = b[o[L] + i];
            i = (i << 5) | (31 - Math.clz32(v & -v));
        }
        return i >>> 0;
    }

    /** Largest key < x, or undefined. @param {number} x @returns {number|undefined} */
    predecessor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        if (x === 0) return undefined;
        const b = this._bits;
        const o = this._off;
        let i = x - 1;
        let p = i >>> 5;
        let v = b[p] & ~(-2 << (i & 31));
        if (v !== 0) return ((p << 5) | (31 - Math.clz32(v))) >>> 0;
        if (p === 0) return undefined;
        i = p - 1;
        let L = 1;
        for (;;) {
            p = i >>> 5;
            v = b[o[L] + p] & ~(-2 << (i & 31));
            if (v !== 0) {
                i = (p << 5) | (31 - Math.clz32(v));
                break;
            }
            if (p === 0) return undefined;
            i = p - 1;
            L++;
        }
        while (L > 0) {
            L--;
            v = b[o[L] + i] | 0;
            i = (i << 5) | (31 - Math.clz32(v));
        }
        return i >>> 0;
    }

    /** Smallest key, or undefined if empty. @returns {number|undefined} */
    min() {
        const b = this._bits;
        const o = this._off;
        let L = this._top;
        let v = b[o[L]];
        if (v === 0) return undefined;
        let i = 31 - Math.clz32(v & -v);
        while (L > 0) {
            L--;
            v = b[o[L] + i];
            i = (i << 5) | (31 - Math.clz32(v & -v));
        }
        return i >>> 0;
    }

    /** Largest key, or undefined if empty. @returns {number|undefined} */
    max() {
        const b = this._bits;
        const o = this._off;
        let L = this._top;
        let v = b[o[L]] | 0;
        if (v === 0) return undefined;
        let i = 31 - Math.clz32(v);
        while (L > 0) {
            L--;
            v = b[o[L] + i] | 0;
            i = (i << 5) | (31 - Math.clz32(v));
        }
        return i >>> 0;
    }

    /** Cold. Removes every key. */
    clear() {
        this._bits.fill(0);
        this._size = 0;
    }

    /**
     * Cold, allocating. A fresh snapshot: `words[L]` is a copy of level L's words
     * (level 0 = the key bits), independent of later mutation.
     * @returns {{universe: number, size: number, words: Uint32Array[]}}
     */
    dump() {
        const b = this._bits;
        const o = this._off;
        const n = this._top + 1;
        const words = new Array(n);
        for (let L = 0; L < n; L++) words[L] = b.slice(o[L], o[L + 1]);
        return { universe: this._u, size: this._size, words };
    }
}

// --- XFastTrie (0.3.0) -------------------------------------------------------

/**
 * MurmurHash3 32-bit finalizer (fmix32), lite-o1 CuckooMap parity. The result is
 * a SIGNED int32 (`| 0`), so on Node (32-bit Smi) it never boxes at a call
 * boundary. On a pointer-compressed engine (31-bit Smi: Chrome / Electron, d8) a
 * result outside [-2^30, 2^30) boxes when the call is NOT inlined; its hot
 * callers can inline it (<= 460 B, gated by test/XftBytecode.test.js; inlining
 * itself is not gated). Every consumer masks it.
 * @param {number} h an int32 @returns {number} a signed int32
 */
function fmix32(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, 0x85ebca6b);
    h = h ^ (h >>> 13);
    h = Math.imul(h, 0xc2b2ae35);
    h = h ^ (h >>> 16);
    return h | 0;
}

/**
 * Cold. Throws the RangeError for an add() of a NEW key at size === capacity.
 * Kept out of add's body so the error-string bytes never sit in the hot method.
 * @param {number} c
 */
function throwFull(c) {
    throw new RangeError('[lite-loglogn] XFastTrie is full (capacity ' + c +
        '); delete a key first -- capacity is fixed at construction');
}

/**
 * XFastTrie -- O(log log U) successor / predecessor over a FIXED universe
 * [0, U), 2 <= U <= 2^32, holding at most `capacity` keys (fixed, fail closed).
 *
 * Layout (every typed array preallocated in the constructor and never replaced,
 * except `_q`: _poison() sets it to null and clear() of a poisoned instance
 * allocates a fresh Int32Array(4)):
 * one LevelTable per level L = 1..w (w = ceil(log2 U); level w = the keys), all
 * back to back in shared columns `_occ` U8 / `_tk` I32 (prefix | 0) / `_tmin` /
 * `_tmax` I32 (leaf index of the prefix subtree's min / max key). A LevelTable is
 * an in-file bucketized cuckoo table (lite-o1 CuckooMap design parity: 2 tables x
 * B_L buckets x 4 slots, occupancy byte, no tombstones, load <= 0.90, in-place
 * reseed of up to 32 tries). capL = min(C, 2^L), B_L = pow2 >= ceil(capL*10/72),
 * S_L = 8 B_L. `_lv` I32[4(w+1)] holds base, mask, s1, s2 per level. The keys
 * live in a sorted doubly linked leaf thread `_key` U32 / `_next` / `_prev` I32
 * (length C+1; slot 0 = the circular sentinel: next[0] = min leaf, prev[0] = max
 * leaf; free leaves form a LIFO list through `_next`). `_q` I32[4] = scratch x|0,
 * then the REPORTED counters kicks, reseedOps, tries (cumulative; clear() keeps
 * them). The counters are Int32 and WRAP at 2^31 (to -2^31, no saturation);
 * they are REPORTED diagnostics and the engine never reads them. byteLength
 * (every typed array plus the 16 B of `_q`) = 13 TS + 12 (C+1) + 16 (w+1) + 16,
 * TS = sum S_L (13 = occ 1 + tk 4 + tmin 4 + tmax 4 B per slot; 12 = key +
 * next + prev).
 *
 * Cost in level-table TOUCHES (1 touch = 1 probe = 4 `_lv` reads, <= 8 `_occ`
 * reads, = 8 on a miss; T = binary-search steps over the w prefix lengths,
 * = log2(w) for w = 2^j; m = the shorter common prefix length of x with its two
 * thread neighbours -- the update walk stops early at m):
 *
 *   op                              touches
 *   has                             1
 *   successor / predecessor         1 (x present), 1 + T (x absent)
 *   min / max                       0 (thread reads only)
 *   add, new key                    1 + T + (w - m)
 *   add, present or full            1
 *   delete, key present             w - m
 *   delete, key absent              1
 *   any op, bad key                 0
 * Rows are exact when no kick / reseed fires (add only; kicks / tries are
 * REPORTED in _q).
 *
 * Queries are O(log log U); delete is O(w) worst-case, add expected O(w) (a stall
 * reseeds one level: up to 32 passes, O(C) each). Hot methods allocate 0
 * bytes; a returned key >= 2^31 on Node (>= 2^30 on Chrome / Electron, pointer-
 * compressed) may box as a HeapNumber when the call is not inlined.
 * successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A bad key
 * touches nothing: has / delete -> false, successor / predecessor -> undefined,
 * add -> RangeError. add of a NEW key at size === capacity -> RangeError, nothing
 * written. A cuckoo stall reseeds that level in place from the leaf thread (0 B);
 * if 32 tries fail the add is rolled back (logical restore) and throws
 * RangeError; if even the rollback cannot re-place a level, the instance is
 * POISONED (`_q = null`, loud Error) and only clear() revives it. Poisoned, every
 * hot method throws TypeError on a VALID key (min / max always); a bad key is
 * rejected before `_q` is read, so it still gives false / undefined / RangeError.
 * Storing null widens the `_q` field type of the XFastTrie shape (cold, once:
 * optimized code that assumed an Int32Array there deopts).
 */
export class XFastTrie {
    /**
     * @param {number} universe integer in [2, 2^32]
     * @param {number} capacity integer in [1, min(universe, 2^24)]
     * @param {number} [seed] optional uint32 level-seed salt: undefined or 0
     *   gives the default seeds bit for bit; any other value is XORed into every
     *   level's s1 (s1 = fmix32(imul(L, 0x9e3779b1) ^ S_L ^ seed)). Deterministic,
     *   never random; clear() restores the seeds it gives. Anything else -> RangeError.
     */
    constructor(universe, capacity, seed) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 2 || universe > 4294967296) {
            throw new RangeError('[lite-loglogn] XFastTrie universe must be an integer in [2, 2^32]; got ' +
                (typeof universe === 'number' ? String(universe) : typeof universe));
        }
        const lim = universe < 16777216 ? universe : 16777216;
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > lim) {
            throw new RangeError('[lite-loglogn] XFastTrie capacity must be an integer in [1, ' + lim +
                '] (min(universe, 2^24)); got ' +
                (typeof capacity === 'number' ? String(capacity) : typeof capacity));
        }
        if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed) ||
            seed < 0 || seed > 4294967295)) {
            throw new RangeError('[lite-loglogn] XFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ' +
                (typeof seed === 'number' ? String(seed) : typeof seed));
        }
        const w = 32 - Math.clz32(universe - 1);
        const lv = new Int32Array(4 * (w + 1));
        let ts = 0;
        for (let L = 1; L <= w; L++) {
            const capL = Math.min(capacity, 2 ** L);
            const need = Math.ceil(capL * 10 / 72);
            let b = 1;
            while (b < need) b *= 2;
            lv[4 * L] = ts;
            lv[4 * L + 1] = b - 1;
            ts += 8 * b;
        }
        this._u = universe;
        this._w = w;
        this._c = capacity;
        this._sd = seed | 0;
        this._size = 0;
        this._free = 1;
        this._lv = lv;
        this._occ = new Uint8Array(ts);
        this._tk = new Int32Array(ts);
        this._tmin = new Int32Array(ts);
        this._tmax = new Int32Array(ts);
        this._key = new Uint32Array(capacity + 1);
        this._next = new Int32Array(capacity + 1);
        this._prev = new Int32Array(capacity + 1);
        this._q = new Int32Array(4);
        this._init();
    }

    /** Number of keys present. */
    get size() { return this._size; }

    /** The fixed universe U (keys are integers in [0, U)). */
    get universe() { return this._u; }

    /** The fixed capacity (most keys held at once). */
    get capacity() { return this._c; }

    /** Key bit-width w = ceil(log2 U) (the number of trie levels). */
    get bits() { return this._w; }

    /**
     * Bytes of every typed array the instance owns (13 TS + 12 (C+1) + 16 (w+1) + 16).
     * The trailing 16 is `_q` (I32[4]), counted as a constant because a poisoned
     * instance holds `_q = null` (clear() re-creates it).
     */
    get byteLength() {
        return this._lv.byteLength + this._occ.byteLength + this._tk.byteLength +
            this._tmin.byteLength + this._tmax.byteLength + this._key.byteLength +
            this._next.byteLength + this._prev.byteLength + 16;
    }

    /**
     * Hot helper. Probes level L for the prefix of x (x|0 in `_q[0]`): 4 `_lv`
     * reads, occupancy first on each of <= 8 slots. @returns {number} slot or -1
     */
    _slot(L) {
        const lv = this._lv;
        const occ = this._occ;
        const tk = this._tk;
        const j = L << 2;
        const base = lv[j];
        const mask = lv[j + 1];
        const s1 = lv[j + 2];
        const s2 = lv[j + 3];
        const p = (this._q[0] >>> (this._w - L)) | 0;
        let i = base + ((fmix32(p ^ s1) & mask) << 2);
        let e = i + 4;
        for (; i < e; i++) if (occ[i] !== 0 && tk[i] === p) return i;
        i = base + ((mask + 1) << 2) + ((fmix32(p ^ s2) & mask) << 2);
        e = i + 4;
        for (; i < e; i++) if (occ[i] !== 0 && tk[i] === p) return i;
        return -1;
    }

    /**
     * Hot helper. Inserts the (absent) level-L prefix of x as a subtree holding
     * only leaf f: first empty slot of its two buckets, else the cold kick chain.
     */
    _put(L, f) {
        const lv = this._lv;
        const occ = this._occ;
        const j = L << 2;
        const base = lv[j];
        const mask = lv[j + 1];
        const s1 = lv[j + 2];
        const s2 = lv[j + 3];
        const p = (this._q[0] >>> (this._w - L)) | 0;
        let i = base + ((fmix32(p ^ s1) & mask) << 2);
        let e = i + 4;
        for (; i < e; i++) if (occ[i] === 0) break;
        if (i === e) {
            i = base + ((mask + 1) << 2) + ((fmix32(p ^ s2) & mask) << 2);
            e = i + 4;
            for (; i < e; i++) if (occ[i] === 0) break;
            if (i === e) {
                this._kick(L, f);
                return;
            }
        }
        occ[i] = 1;
        this._tk[i] = p;
        this._tmin[i] = f;
        this._tmax[i] = f;
    }

    /**
     * Hot helper, x (in `_q[0]`) absent. Binary search over prefix lengths
     * 0..w-1 for the longest present prefix, then one thread hop.
     * @returns {number} the successor leaf of x (0 = none); prev of it = predecessor
     */
    _near() {
        const q0 = this._q[0];
        const w = this._w;
        let lo = 0;
        let hi = w - 1;
        let hs = 0;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            const s = this._slot(mid);
            if (s >= 0) {
                lo = mid;
                hs = s;
            } else {
                hi = mid - 1;
            }
        }
        if (((q0 >>> (w - 1 - lo)) & 1) !== 0) {
            return this._next[lo === 0 ? this._prev[0] : this._tmax[hs]];
        }
        return lo === 0 ? this._next[0] : this._tmin[hs];
    }

    /** @param {number} x @returns {boolean} */
    has(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        this._q[0] = x;
        return this._slot(this._w) >= 0;
    }

    /** @param {number} x @returns {this} throws RangeError on a bad key or when full (no state touched) */
    add(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) throwKey(x, this._u);
        const q = this._q;
        q[0] = x;
        const w = this._w;
        if (this._slot(w) >= 0) return this;
        if (this._size === this._c) throwFull(this._c);
        const sl = this._near();
        const nx = this._next;
        const pv = this._prev;
        const ky = this._key;
        const pl = pv[sl];
        const f = this._free;
        this._free = nx[f];
        ky[f] = x;
        nx[f] = sl;
        pv[f] = pl;
        nx[pl] = f;
        pv[sl] = f;
        this._size++;
        const xi = q[0];
        const cp = pl === 0 ? 0 : w - 32 + Math.clz32(xi ^ ky[pl]);
        const cs = sl === 0 ? 0 : w - 32 + Math.clz32(xi ^ ky[sl]);
        const l = cp > cs ? cp : cs;
        const m = cp < cs ? cp : cs;
        for (let L = w; L > m; L--) {
            if (L > l) {
                this._put(L, f);
            } else if (L > cp) {
                this._tmin[this._slot(L)] = f;
            } else {
                this._tmax[this._slot(L)] = f;
            }
        }
        return this;
    }

    /** @param {number} x @returns {boolean} true if x was present */
    delete(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        const q = this._q;
        q[0] = x;
        const w = this._w;
        let s = this._slot(w);
        if (s < 0) return false;
        const occ = this._occ;
        const tmin = this._tmin;
        const tmax = this._tmax;
        const nx = this._next;
        const pv = this._prev;
        const ky = this._key;
        const f = tmin[s];
        const pl = pv[f];
        const sl = nx[f];
        const xi = q[0];
        const cp = pl === 0 ? 0 : w - 32 + Math.clz32(xi ^ ky[pl]);
        const cs = sl === 0 ? 0 : w - 32 + Math.clz32(xi ^ ky[sl]);
        const l = cp > cs ? cp : cs;
        const m = cp < cs ? cp : cs;
        let L = w;
        for (;;) {
            if (L > l) occ[s] = 0;
            else if (L > cp) tmin[s] = sl;
            else tmax[s] = pl;
            if (--L <= m) break;
            s = this._slot(L);
        }
        nx[pl] = sl;
        pv[sl] = pl;
        nx[f] = this._free;
        this._free = f;
        this._size--;
        return true;
    }

    /** Smallest key > x, or undefined. @param {number} x @returns {number|undefined} */
    successor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        this._q[0] = x;
        const s = this._slot(this._w);
        const sl = s >= 0 ? this._next[this._tmin[s]] : this._near();
        return sl === 0 ? undefined : this._key[sl];
    }

    /** Largest key < x, or undefined. @param {number} x @returns {number|undefined} */
    predecessor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        this._q[0] = x;
        const s = this._slot(this._w);
        const pl = this._prev[s >= 0 ? this._tmin[s] : this._near()];
        return pl === 0 ? undefined : this._key[pl];
    }

    /** Smallest key, or undefined if empty. @returns {number|undefined} */
    min() {
        void this._q[0]; // poisoned (_q === null) -> TypeError, as in every hot method
        const f = this._next[0];
        return f === 0 ? undefined : this._key[f];
    }

    /** Largest key, or undefined if empty. @returns {number|undefined} */
    max() {
        void this._q[0]; // poisoned (_q === null) -> TypeError, as in every hot method
        const f = this._prev[0];
        return f === 0 ? undefined : this._key[f];
    }

    /**
     * Cold. Removes every key and restores the constructed seeds (the defaults,
     * or those derived from the caller's seed); the `_q` counters are kept.
     * Revives a poisoned instance (a fresh `_q`, counters zero).
     */
    clear() {
        if (this._q === null) this._q = new Int32Array(4);
        else this._q[0] = 0;
        const lv = this._lv;
        const occ = this._occ;
        const j = this._w << 2;
        const ts = lv[j] + ((lv[j + 1] + 1) << 3);
        for (let i = 0; i < ts; i++) occ[i] = 0;
        this._init();
    }

    /**
     * Cold, allocating. A fresh snapshot: `keys` (U32, ascending, walked from the
     * leaf thread) and `levels[L - 1]` for L = 1..w (level w = the keys), read
     * from the level table itself: `capacity` = usable slots floor(0.9 S_L)
     * (CuckooMap parity), `prefix` (U32, ascending) with the subtree `min` /
     * `max` KEY of each prefix.
     * @returns {{universe: number, capacity: number, size: number, bits: number,
     *   keys: Uint32Array, levels: {capacity: number, prefix: Uint32Array,
     *   min: Uint32Array, max: Uint32Array}[]}}
     */
    dump() {
        const w = this._w;
        const n = this._size;
        const lv = this._lv;
        const occ = this._occ;
        const tk = this._tk;
        const tmin = this._tmin;
        const tmax = this._tmax;
        const ky = this._key;
        const nx = this._next;
        const keys = new Uint32Array(n);
        let k = 0;
        for (let i = nx[0]; i !== 0; i = nx[i]) {
            if (k === n) {
                throw new Error('[lite-loglogn] XFastTrie invariant: the leaf thread holds more than size ' +
                    n + ' keys');
            }
            keys[k++] = ky[i];
        }
        if (k !== n) {
            throw new Error('[lite-loglogn] XFastTrie invariant: the leaf thread holds ' + k +
                ' keys, size is ' + n);
        }
        const levels = new Array(w);
        for (let L = 1; L <= w; L++) {
            const j = L << 2;
            const base = lv[j];
            const sz = (lv[j + 1] + 1) << 3;
            const idx = [];
            for (let i = base; i < base + sz; i++) if (occ[i] !== 0) idx.push(i);
            idx.sort((a, b) => (tk[a] >>> 0) - (tk[b] >>> 0));
            const prefix = new Uint32Array(idx.length);
            const min = new Uint32Array(idx.length);
            const max = new Uint32Array(idx.length);
            for (let t = 0; t < idx.length; t++) {
                prefix[t] = tk[idx[t]];
                min[t] = ky[tmin[idx[t]]];
                max[t] = ky[tmax[idx[t]]];
            }
            levels[L - 1] = { capacity: Math.floor(sz * 9 / 10), prefix, min, max };
        }
        return { universe: this._u, capacity: this._c, size: n, bits: w, keys, levels };
    }

    // ---- cold path: seeds, kick chain, reseed, rollback, poison -----------------

    /** Cold. Seeds per level from `_sd` (0 = the defaults), empty thread, free list 1..C, size 0. */
    _init() {
        const lv = this._lv;
        const nx = this._next;
        const pv = this._prev;
        const w = this._w;
        const c = this._c;
        for (let L = 1; L <= w; L++) {
            const j = L << 2;
            const s1 = fmix32(Math.imul(L, 0x9e3779b1) ^ ((lv[j + 1] + 1) << 3) ^ this._sd);
            lv[j + 2] = s1;
            lv[j + 3] = fmix32(s1 ^ 0x85ebca6b);
        }
        nx[0] = 0;
        pv[0] = 0;
        for (let i = 1; i < c; i++) nx[i] = i + 1;
        nx[c] = 0;
        this._free = 1;
        this._size = 0;
    }

    /** Cold. Both home buckets of x's level-L prefix are full: kick chain, else reseed L. */
    _kick(L, f) {
        if (!this._chain(L, f, f, f)) this._rebuild(L, f);
    }

    /**
     * Cold. The cuckoo eviction chain (CuckooMap `_evict` parity) for the level-L
     * prefix of leaf lf's key with subtree leaves (mn, mx), starting at its
     * table-0 bucket; at most 8 max(1, ceil(log2(floor(0.9 S_L) + 1))) steps,
     * kicking slot n & 3. On a stall the carried entry is dropped (the reseed
     * re-places the whole level from the leaf thread). @returns {boolean} placed
     */
    _chain(L, lf, mn, mx) {
        const lv = this._lv;
        const occ = this._occ;
        const tk = this._tk;
        const tmin = this._tmin;
        const tmax = this._tmax;
        const q = this._q;
        const j = L << 2;
        const base = lv[j];
        const mask = lv[j + 1];
        const s1 = lv[j + 2];
        const s2 = lv[j + 3];
        const four = (mask + 1) << 2;
        const loops = 8 * Math.max(1, 32 - Math.clz32(Math.floor(four * 2 * 9 / 10)));
        let ck = (this._key[lf] >>> (this._w - L)) | 0;
        let cn = mn;
        let cx = mx;
        let ti = 0;
        let bb = fmix32(ck ^ s1) & mask;
        for (let n = 0; n < loops; n++) {
            const b0 = base + (ti === 0 ? 0 : four) + (bb << 2);
            for (let i = b0; i < b0 + 4; i++) {
                if (occ[i] === 0) {
                    occ[i] = 1;
                    tk[i] = ck;
                    tmin[i] = cn;
                    tmax[i] = cx;
                    return true;
                }
            }
            const v = b0 + (n & 3);
            const t0 = tk[v];
            const t1 = tmin[v];
            const t2 = tmax[v];
            tk[v] = ck;
            tmin[v] = cn;
            tmax[v] = cx;
            ck = t0;
            cn = t1;
            cx = t2;
            q[1]++;
            ti ^= 1;
            bb = fmix32(ck ^ (ti === 0 ? s1 : s2)) & mask;
        }
        return false;
    }

    /** Cold. Places one prefix group (CuckooMap `_place` parity): empty slot, else the chain. */
    _place(L, lf, mn, mx) {
        const lv = this._lv;
        const occ = this._occ;
        const j = L << 2;
        const base = lv[j];
        const mask = lv[j + 1];
        const p = (this._key[lf] >>> (this._w - L)) | 0;
        let i = base + ((fmix32(p ^ lv[j + 2]) & mask) << 2);
        for (let t = 0; t < 8; t++, i++) {
            if (t === 4) i = base + ((mask + 1) << 2) + ((fmix32(p ^ lv[j + 3]) & mask) << 2);
            if (occ[i] === 0) {
                occ[i] = 1;
                this._tk[i] = p;
                this._tmin[i] = mn;
                this._tmax[i] = mx;
                return true;
            }
        }
        return this._chain(L, lf, mn, mx);
    }

    /**
     * Cold. Clears level L and re-places every prefix group from the sorted leaf
     * thread (the thread IS the snapshot: 0 B) under the current seeds.
     * @returns {boolean} every group placed
     */
    _fill(L) {
        const lv = this._lv;
        const occ = this._occ;
        const ky = this._key;
        const nx = this._next;
        const j = L << 2;
        const base = lv[j];
        const end = base + ((lv[j + 1] + 1) << 3);
        for (let i = base; i < end; i++) occ[i] = 0;
        const sh = this._w - L;
        let i = nx[0];
        while (i !== 0) {
            const p = ky[i] >>> sh;
            let e = i;
            let k = nx[i];
            while (k !== 0 && (ky[k] >>> sh) === p) {
                e = k;
                k = nx[k];
            }
            if (!this._place(L, i, i, e)) return false;
            i = k;
        }
        return true;
    }

    /**
     * Cold. ONE in-place reseed operation of level L (leaf f = the key being
     * added, already spliced): up to 32 tries, try a deriving from the seed the
     * level held when the rebuild began (lite-o1 CuckooMap parity):
     * s1 = fmix32(s1_start + imul(a, 0x9e3779b1)), s2 = fmix32(s1 ^ 0x85ebca6b).
     * All 32 fail -> the start seeds are restored and the add is rolled back.
     */
    _rebuild(L, f) {
        const lv = this._lv;
        const q = this._q;
        const j = L << 2;
        const s1 = lv[j + 2];
        const s2 = lv[j + 3];
        q[2]++;
        for (let a = 1; a <= 32; a++) {
            q[3]++;
            const t = fmix32((s1 + Math.imul(a, 0x9e3779b1)) | 0);
            lv[j + 2] = t;
            lv[j + 3] = fmix32(t ^ 0x85ebca6b);
            if (this._fill(L)) return;
        }
        lv[j + 2] = s1;
        lv[j + 3] = s2;
        this._undo(L, f);
    }

    /**
     * Cold. Logical restore of a failed add (x in `_q[0]`, leaf f): removes x's
     * prefixes at levels w..L+1 (each was inserted for x alone), unsplices x,
     * frees its leaf, rebuilds level L under its start seeds, then throws
     * RangeError. A restore that cannot re-place a level poisons the instance.
     */
    _undo(L, f) {
        const occ = this._occ;
        for (let k = this._w; k > L; k--) {
            const s = this._slot(k);
            if (s < 0) this._poison('a level ' + k + ' prefix of the rolled-back key is missing');
            occ[s] = 0;
        }
        const nx = this._next;
        const pv = this._prev;
        const pl = pv[f];
        const sl = nx[f];
        nx[pl] = sl;
        pv[sl] = pl;
        nx[f] = this._free;
        this._free = f;
        this._size--;
        if (!this._fill(L)) this._poison('level ' + L + ' could not be re-placed under its start seeds');
        throw new RangeError('[lite-loglogn] XFastTrie: level ' + L +
            ' could not place the key after 32 reseed tries; add rolled back (size ' + this._size + ')');
    }

    /** Cold. Poisons the instance: `_q = null`, loud Error; clear() revives it. */
    _poison(why) {
        this._q = null;
        throw new Error('[lite-loglogn] XFastTrie invariant: rollback failed (' + why +
            '); the instance is POISONED -- every hot method throws until clear()');
    }
}

// --- YFastTrie (0.4.0) -------------------------------------------------------

/**
 * Cold. Throws the RangeError for an add() of a NEW key at size === capacity.
 * Kept out of add's body so the error-string bytes never sit in the hot method.
 * @param {number} c
 */
function throwYFull(c) {
    throw new RangeError('[lite-loglogn] YFastTrie is full (capacity ' + c +
        '); delete a key first -- capacity is fixed at construction');
}

/**
 * YFastTrie -- O(log log U) successor / predecessor in O(n) space over a FIXED
 * universe [0, U), 2 <= U <= 2^32, holding at most `capacity` keys (fixed, fail
 * closed). An inner XFastTrie `_x` holds O(n/w) REPRESENTATIVES; each rep owns a
 * bounded sorted bucket of keys (decisions/0008). Deterministic: no RNG.
 *
 * Policy (w = ceil(log2 U), K = 2w, h = ceil(w/2)): reps are SEPARATORS --
 * bucket i holds the keys in [rep_i, rep_{i+1}); reps do not move on delete, so a
 * bucket's min may sit above its rep. The head rep 0 is permanent (the ctor and
 * clear() add it), holds 0..K keys and never merges; every other bucket holds
 * h..K keys. Split: an add of a NEW key into a bucket of K keys; the new rep is
 * the key at index w, the right half (w keys) moves to the new rep's bucket, then
 * x goes left or right. Underflow: a delete from a non-head bucket of s <= h
 * keys: s_L + s - 1 <= K -> merge into the LEFT neighbour and drop the rep; else
 * borrow (t = s_L + s - 1, the new rep = the left bucket's key at index
 * ceil(t/2); the moved run becomes the new rep's bucket, the old rep is dropped).
 *
 * Layout (every typed array preallocated in the constructor and never replaced):
 * Cr = min(2 + floor(C/h), U) inner capacity (never exceeded: reps <= 1 +
 * floor(n/h), and a borrow, +1 rep while it runs, needs s_L >= 3h, which forces
 * reps + 1 <= floor(C/h)); `_bk` U32[(Cr+1)K] one pool of K-word runs,
 * bucket f = `_bk[f*K .. f*K + _bn[f])` where f is the rep's inner LEAF index;
 * `_bn` U8[Cr+1] bucket sizes; `_n` I32[4] = the REPORTED counters splits,
 * merges, borrows (cold path only, cumulative, clear() keeps them, WRAP at 2^31
 * with `| 0`; [3] reserved). The inner trie is `new XFastTrie(U, Cr, seed)`;
 * its own `_q[1]` / `_q[2]` / `_q[3]` count kicks / reseedOps / tries.
 * `_hd` = the head rep 0's inner leaf, always leaf 1 (the ctor and clear() add
 * rep 0 to an empty inner trie, whose free list starts at leaf 1).
 * byteLength = 4 (Cr+1) K + (Cr+1) + 16 + inner XFastTrie(U, Cr).byteLength.
 *
 * Cost (lambda = inner level-table touches of one locate: 1 when x is a rep, else
 * 1 + T; beta = binary-search reads over a bucket of s keys, in
 * [floor(log2(s+1)), ceil(log2(s+1))]; hop = one leaf-thread read + <= 1 `_bk`
 * read; m = the early stop of the inner add (split, borrow) or delete (merge)
 * walk, m' = that of the borrow's inner delete; s = the size of x's bucket
 * before the op, lb = x's index in it, s_L = the left neighbour bucket's size):
 *
 *   op                                    inner touches        search reads         moves
 *   bad key                               0                    0                    0
 *   has / add present / full / del absent lambda               beta + [lb < s]      0
 *   successor / predecessor               lambda               beta + <=2 (+hop)    0
 *   min / max                             0                    <=1 (+hop)           0
 *   add, new key, no split                lambda               beta + [lb < s]      s - lb, +1 write
 *   delete, key present, no merge/borrow  lambda               beta + 1             s - lb - 1
 *   add, new key, split (s = K)           lambda + 1 + T       beta + [lb < s] + 1  w + (w - lb'), +1 write
 *                                         + (w - m)
 *   delete, key present, merge            lambda + (w - m)     beta + 1             s - 1
 *   delete, key present, borrow           lambda + 1 + T       beta + 2             (s_L - c) + (s - 1)
 *                                         + (w - m) + (w - m')                      = floor(t/2) <= 2w
 *
 * Every row is a WHOLE op, read as written: the split row REPLACES the plain
 * add row and the merge / borrow rows REPLACE the plain delete row (they are
 * not added to them). Split: w words move to the new rep's bucket, then x is
 * inserted into the half it lands in (right iff lb > w; lb' = x's index in that
 * half), so moves = 2w - lb for a left-routed x and 3w - lb for a right-routed
 * one, at most 2w; the +1 read is the new rep's `_bk` word. Merge: the s - 1
 * remaining keys move into the left bucket (they replace the plain shift).
 * Borrow: c = ceil(t/2), t = s_L + s - 1; the left bucket's s_L - c keys from
 * index c and the s - 1 remaining keys move to the new rep's bucket; the +2
 * reads are the equality read and the new rep's `_bk` word.
 *
 * Claim: queries are O(log log U); updates are O(log log U) probes plus at
 * most 2w - 1 contiguous word moves (O(w)), and a split / merge / borrow (at
 * most 2w word moves plus one inner add (split), one inner delete (merge) or
 * both (borrow), an inner add expected O(w)) is amortized (a merge can be
 * followed at once by one split of the merged bucket; a split or borrow
 * leaves each bucket it touches Omega(w) updates from its next restructure).
 * Hot methods allocate 0 bytes for keys < 2^30; a returned key >= 2^31 on Node
 * (>= 2^30 on Chrome / Electron) may box when the call is not inlined, and a
 * rep >= 2^31 passed to the inner add / delete of a split / merge / borrow may
 * box (cold path). successor / predecessor are STRICT (> x / < x). -0 aliases
 * key 0. A bad key touches nothing: has / delete -> false, successor /
 * predecessor -> undefined, add -> RangeError. add of a NEW key at size ===
 * capacity -> RangeError, nothing written. A split or borrow whose inner add
 * stalls throws the inner RangeError with the set UNCHANGED (the inner add runs
 * before any copy; so a delete that borrows can throw). An inner poison poisons
 * the YFastTrie (every hot method throws TypeError on a valid key, min / max
 * always); clear() revives both.
 */
export class YFastTrie {
    /**
     * @param {number} universe integer in [2, 2^32]
     * @param {number} capacity integer in [1, min(universe, 2^24)]
     * @param {number} [seed] optional uint32, forwarded to the inner XFastTrie
     *   (undefined or 0 = the default level seeds); anything else -> RangeError.
     */
    constructor(universe, capacity, seed) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 2 || universe > 4294967296) {
            throw new RangeError('[lite-loglogn] YFastTrie universe must be an integer in [2, 2^32]; got ' +
                (typeof universe === 'number' ? String(universe) : typeof universe));
        }
        const lim = universe < 16777216 ? universe : 16777216;
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > lim) {
            throw new RangeError('[lite-loglogn] YFastTrie capacity must be an integer in [1, ' + lim +
                '] (min(universe, 2^24)); got ' +
                (typeof capacity === 'number' ? String(capacity) : typeof capacity));
        }
        if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed) ||
            seed < 0 || seed > 4294967295)) {
            throw new RangeError('[lite-loglogn] YFastTrie seed must be a uint32 integer in [0, 2^32-1]; got ' +
                (typeof seed === 'number' ? String(seed) : typeof seed));
        }
        const w = 32 - Math.clz32(universe - 1);
        const k = 2 * w;
        const h = (w + 1) >>> 1;
        const cr = Math.min(2 + Math.floor(capacity / h), universe);
        this._u = universe;
        this._w = w;
        this._k = k;
        this._h = h;
        this._c = capacity;
        this._size = 0;
        this._hd = 0;
        this._x = new XFastTrie(universe, cr, seed);
        this._bk = new Uint32Array((cr + 1) * k);
        this._bn = new Uint8Array(cr + 1);
        this._n = new Int32Array(4);
        this._x.add(0);
        this._hd = this._x._next[0];
    }

    /** Number of keys present. */
    get size() { return this._size; }

    /** The fixed universe U (keys are integers in [0, U)). */
    get universe() { return this._u; }

    /** The fixed capacity (most keys held at once). */
    get capacity() { return this._c; }

    /** Key bit-width w = ceil(log2 U). */
    get bits() { return this._w; }

    /** Bytes of every typed array owned, inner trie included (4 (Cr+1) K + (Cr+1) + 16 + inner). */
    get byteLength() {
        return this._bk.byteLength + this._bn.byteLength + 16 + this._x.byteLength;
    }

    /**
     * Hot helper, x|0 already in the inner `_q[0]`. @returns {number} the inner
     * leaf (= bucket id) of the largest rep <= x (rep 0 is always present).
     */
    _loc() {
        const t = this._x;
        const s = t._slot(this._w);
        return s >= 0 ? t._tmin[s] : t._prev[t._near()];
    }

    /**
     * Hot helper. Lower bound of x (read from the inner `_q[0] >>> 0`) in the run
     * `_bk[o .. o+s)`. @returns {number} the first index j in [0, s] with key >= x
     */
    _lb(o, s) {
        const bk = this._bk;
        const x = this._x._q[0] >>> 0;
        let lo = o;
        let hi = o + s;
        while (lo < hi) {
            const m = (lo + hi) >>> 1;
            if (bk[m] < x) lo = m + 1;
            else hi = m;
        }
        return lo - o;
    }

    /** @param {number} x @returns {boolean} */
    has(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        this._x._q[0] = x;
        const f = this._loc();
        const s = this._bn[f];
        const o = f * this._k;
        const j = this._lb(o, s);
        return j < s && this._bk[o + j] === x;
    }

    /** @param {number} x @returns {this} throws RangeError on a bad key or when full (no state touched) */
    add(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) throwKey(x, this._u);
        this._x._q[0] = x;
        let f = this._loc();
        const bn = this._bn;
        const k = this._k;
        let s = bn[f];
        let j = this._lb(f * k, s);
        const bk = this._bk;
        if (j < s && bk[f * k + j] === x) return this;
        if (this._size === this._c) throwYFull(this._c);
        if (s === k) {
            const nf = this._split(f);
            const ls = bn[f];
            if (j > ls) {
                f = nf;
                j -= ls;
            }
            s = bn[f];
        }
        const o = f * k;
        bk.copyWithin(o + j + 1, o + j, o + s);
        bk[o + j] = x;
        bn[f] = s + 1;
        this._size++;
        return this;
    }

    /** @param {number} x @returns {boolean} true if x was present */
    delete(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        this._x._q[0] = x;
        const f = this._loc();
        const bn = this._bn;
        const s = bn[f];
        const o = f * this._k;
        const j = this._lb(o, s);
        const bk = this._bk;
        if (j === s || bk[o + j] !== x) return false;
        if (s <= this._h && f !== this._hd) {
            this._shrink(f, j);
        } else {
            bk.copyWithin(o + j, o + j + 1, o + s);
            bn[f] = s - 1;
        }
        this._size--;
        return true;
    }

    /** Smallest key > x, or undefined. @param {number} x @returns {number|undefined} */
    successor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        this._x._q[0] = x;
        const f = this._loc();
        const s = this._bn[f];
        const k = this._k;
        const o = f * k;
        let j = this._lb(o, s);
        const bk = this._bk;
        if (j < s && bk[o + j] === x) j++;
        if (j < s) return bk[o + j];
        const n = this._x._next[f];
        return n === 0 ? undefined : bk[n * k];
    }

    /** Largest key < x, or undefined. @param {number} x @returns {number|undefined} */
    predecessor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        this._x._q[0] = x;
        const f = this._loc();
        const k = this._k;
        const o = f * k;
        const j = this._lb(o, this._bn[f]);
        const bk = this._bk;
        if (j > 0) return bk[o + j - 1];
        const p = this._x._prev[f];
        if (p === 0) return undefined;
        const n = this._bn[p];
        return n === 0 ? undefined : bk[p * k + n - 1];
    }

    /** Smallest key, or undefined if empty. @returns {number|undefined} */
    min() {
        const t = this._x;
        void t._q[0]; // poisoned (inner _q === null) -> TypeError, as in every hot method
        const f = this._hd;
        const k = this._k;
        if (this._bn[f] !== 0) return this._bk[f * k];
        const n = t._next[f];
        return n === 0 ? undefined : this._bk[n * k];
    }

    /** Largest key, or undefined if empty. @returns {number|undefined} */
    max() {
        const t = this._x;
        void t._q[0]; // poisoned (inner _q === null) -> TypeError, as in every hot method
        const f = t._prev[0];
        const n = this._bn[f];
        return n === 0 ? undefined : this._bk[f * this._k + n - 1];
    }

    /**
     * Cold. Removes every key: clears the inner trie (its constructed seeds, a
     * poisoned one revived) and re-adds rep 0. The `_n` counters are kept.
     */
    clear() {
        const t = this._x;
        t.clear();
        this._bn.fill(0);
        this._size = 0;
        t.add(0);
        this._hd = t._next[0];
    }

    /**
     * Cold, allocating. A fresh snapshot walked from the inner leaf thread: `keys`
     * (U32, ascending), `reps` (U32, ascending, reps[0] = 0) and `sizes` (U8, the
     * bucket size of each rep).
     * @returns {{universe: number, capacity: number, size: number, bits: number,
     *   keys: Uint32Array, reps: Uint32Array, sizes: Uint8Array}}
     */
    dump() {
        const t = this._x;
        const k = this._k;
        const bk = this._bk;
        const bn = this._bn;
        const nx = t._next;
        const ky = t._key;
        const n = this._size;
        const nr = t._size;
        const keys = new Uint32Array(n);
        const reps = new Uint32Array(nr);
        const sizes = new Uint8Array(nr);
        let r = 0;
        let q = 0;
        for (let f = nx[0]; f !== 0; f = nx[f]) {
            const s = bn[f];
            if (r === nr || q + s > n) {
                throw new Error('[lite-loglogn] YFastTrie invariant: the buckets hold more than size ' + n +
                    ' keys or the rep thread more than ' + nr + ' reps');
            }
            reps[r] = ky[f];
            sizes[r++] = s;
            keys.set(bk.subarray(f * k, f * k + s), q);
            q += s;
        }
        if (r !== nr || q !== n) {
            throw new Error('[lite-loglogn] YFastTrie invariant: ' + r + ' reps / ' + q +
                ' keys walked, expected ' + nr + ' / ' + n);
        }
        return { universe: this._u, capacity: this._c, size: n, bits: this._w, keys, reps, sizes };
    }

    // ---- cold path: split, merge / borrow ---------------------------------------

    /**
     * Cold. Splits the full bucket of leaf f (K keys): the new rep = its key at
     * index w is added to the inner trie FIRST (a stall throws with nothing
     * changed), then keys w..K-1 move to the new leaf's bucket.
     * Overridable (test controls replace it). @returns {number} the new leaf
     */
    _split(f) {
        const t = this._x;
        const bk = this._bk;
        const bn = this._bn;
        const k = this._k;
        const w = this._w;
        const o = f * k;
        const nf = t._free;
        t.add(bk[o + w]);
        bk.copyWithin(nf * k, o + w, o + k);
        bn[f] = w;
        bn[nf] = k - w;
        this._n[0] = (this._n[0] + 1) | 0;
        return nf;
    }

    /**
     * Cold. Deletes index j of the non-head bucket of leaf f (s <= h keys) and
     * repairs the underflow against its left neighbour p: s_p + s - 1 <= K ->
     * merge into p and drop f's rep; else borrow: the new rep = p's key at index
     * ceil(t/2), t = s_p + s - 1, is added to the inner trie FIRST (a stall throws
     * with nothing changed), p's keys from there on plus f's remaining keys
     * become the new leaf's bucket, then f's rep is dropped. Overridable.
     */
    _shrink(f, j) {
        const t = this._x;
        const bk = this._bk;
        const bn = this._bn;
        const k = this._k;
        const o = f * k;
        const s = bn[f];
        const p = t._prev[f];
        const po = p * k;
        const sl = bn[p];
        if (sl + s - 1 <= k) {
            bk.copyWithin(po + sl, o, o + j);
            bk.copyWithin(po + sl + j, o + j + 1, o + s);
            bn[p] = sl + s - 1;
            bn[f] = 0;
            t.delete(t._key[f]);
            this._n[1] = (this._n[1] + 1) | 0;
            return;
        }
        const c = (sl + s) >>> 1;
        const nf = t._free;
        t.add(bk[po + c]);
        const no = nf * k;
        const m = sl - c;
        bk.copyWithin(no, po + c, po + sl);
        bk.copyWithin(no + m, o, o + j);
        bk.copyWithin(no + m + j, o + j + 1, o + s);
        bn[p] = c;
        bn[nf] = m + s - 1;
        bn[f] = 0;
        t.delete(t._key[f]);
        this._n[2] = (this._n[2] + 1) | 0;
    }
}

// --- vEBTree (0.5.0) ---------------------------------------------------------

/**
 * Cold. S(w): Uint32 words of an untrimmed vEBTree node of width w (decisions/
 * 0009 L1). A leaf (w <= 8) is a plain bitmap of ceil(2^w / 32) words; an
 * internal node (w >= 9) is [min, max] + the summary (width hi) + 2^hi clusters
 * (width lo), lo = (w > 24 ? 16 : 8), hi = w - lo.
 * @param {number} w
 * @returns {number}
 */
function vebWords(w) {
    if (w <= 8) return w <= 5 ? 1 : 1 << (w - 5);
    const lo = w > 24 ? 16 : 8;
    return 2 + vebWords(w - lo) + 2 ** (w - lo) * vebWords(lo);
}

/**
 * vEBTree -- a flattened van Emde Boas tree: worst-case O(log log U) has / add /
 * delete / successor / predecessor and O(1) min / max over a FIXED universe
 * [0, U), 2 <= U <= 2^32, in ONE preallocated Uint32Array (decisions/0009).
 * No hashing, no reseed, no amortized split. SPACE is O(U): the whole universe
 * is allocated up front (byteLength below); a sparse large universe belongs to
 * YFastTrie (O(n) space).
 *
 * Layout (L1, L2). Node of width w <= 8 = LEAF: a bitmap of ceil(2^w / 32)
 * words, key k = bit (k & 31) of word (k >>> 5), no header. Node of width w >= 9
 * = INTERNAL at base: `_t[base]` = min, `_t[base + 1]` = max (node-relative; the
 * root's are full keys), EMPTY = min > max, stored [0xFFFFFFFF, 0]; min is NOT
 * stored in its cluster; the summary (width hi) at base + 2; cluster j at
 * base + `_g[w]` + j * S(lo), `_g[w]` = 2 + S(hi), S(lo) in {8, 2058}. Only the
 * ROOT's cluster count is trimmed to ceil(U / 2^lo). Depth <= 2 internal levels.
 * byteLength = 4 x words: w <= 8 -> 4 ceil(2^w / 32); else
 * 4 (2 + S(hi) + ceil(U / 2^lo) S(lo)), S(w) = 2 + S(hi) + 2^hi S(lo).
 *
 * Reads (L4, exact; `_t` only unless named). Header slots compare as uint32,
 * bitmap words are read `| 0`. A leaf "scan" reads words one at a time and stops
 * at the first nonzero (masked) word: ascending for min / successor, descending
 * for max / predecessor; a scan whose start bit is past the leaf reads nothing.
 * - `_g`: one read of `_g[w]` per internal node left through a cluster or
 *   whose cluster / summary is examined (successor / predecessor: past the
 *   header tests; delete: also per refreshed frame unless max becomes min).
 * - has / add / delete: min then max at every internal node on the path; the
 *   leaf: its target word. No has pre-pass; `_t` / `_p` writes only once presence (delete) or
 *   absence (add) is proven by a read.
 * - add: an internal node that is EMPTY takes [x, x] and stops (a cluster: then
 *   its parent's summary takes j). x < min swaps x with min, x > max sets max;
 *   then x enters cluster j = x >>> lo. A leaf cluster: target word, then (only
 *   when it was 0) the other words ascending -- all 0 means the cluster was empty
 *   and the parent's summary takes j. One path; the summary is entered only from
 *   an emptied-before cluster.
 * - delete: a node holding only x (internal min === max; a leaf cluster whose
 *   target word is the bit alone, then the other words ascending all 0) is
 *   emptied in O(1) and the parent's summary loses j. x === min (>= 2 keys):
 *   the summary's min (internal: its min slot; leaf: ascending scan), then that
 *   cluster's min (same rule) become the new min. Where x was a node's max, a
 *   frame [base, w, acc, mode] goes to `_p` (4 writes; <= 2 frames) when the
 *   child's outcome is known; after the walk each frame is read back (4 `_p`
 *   reads, LIFO) and refreshes max: mode 2 (cluster acc = j kept keys)
 *   -> j's max (internal: max slot; leaf: descending scan); mode 1 (cluster
 *   emptied, acc = the node's min) -> the summary's max (internal: its max slot,
 *   0 reads when that summary was the node emptied last; leaf: descending scan)
 *   and that cluster's max, or min when the summary is empty.
 * - successor: 0 reads when empty; min, then max only if x >= min (x < min ->
 *   min; x >= max -> none). Leaf cluster: an ascending scan from xl + 1 inside
 *   it; internal cluster: its max slot, then (xl < it) the cluster is visited
 *   like a node (min, max again). Otherwise the summary is visited for j, and
 *   the answer cluster's min (internal: min slot; leaf: ascending scan) ends it.
 * - predecessor: the mirror -- max, then min only if x <= max; leaf cluster: a
 *   descending scan from xl - 1; internal cluster: its min slot; a summary with
 *   no predecessor of j falls back to that node's min (no read).
 * - min / max: 0 reads when empty; else the root's slot (1 read), or a scan of
 *   a root leaf (U <= 256).
 * Hot methods (the 7 above) allocate 0 bytes; a returned key >= 2^31 (>= 2^30
 * on a pointer-compressed engine) may box as a HeapNumber when the call is not
 * inlined. successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A
 * bad key (not a number, not an integer in [0, U)) touches no column: has /
 * delete -> false, successor / predecessor -> undefined, add -> RangeError.
 */
export class vEBTree {
    /** @param {number} universe integer in [2, 2^32] */
    constructor(universe) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 2 || universe > 4294967296) {
            throw new RangeError('[lite-loglogn] vEBTree universe must be an integer in [2, 2^32]; got ' +
                (typeof universe === 'number' ? String(universe) : typeof universe));
        }
        const w = 32 - Math.clz32(universe - 1);
        const g = new Int32Array(33);
        for (let k = 9; k <= 32; k++) g[k] = 2 + vebWords(k - (k > 24 ? 16 : 8));
        let words = vebWords(w);
        if (w > 8) {
            const lo = w > 24 ? 16 : 8;
            words = g[w] + Math.ceil(universe / 2 ** lo) * vebWords(lo);
        }
        this._u = universe;
        this._w = w;
        this._size = 0;
        this._g = g;
        this._p = new Int32Array(8);
        this._t = new Uint32Array(words);
        this._init();
    }

    /** Number of keys present. */
    get size() { return this._size; }

    /** The fixed universe U (keys are integers in [0, U)). */
    get universe() { return this._u; }

    /** Key bit-width w = ceil(log2 U). */
    get bits() { return this._w; }

    /** Bytes of the tree `_t` (4 x words; `_g`, `_p` and the object not counted). */
    get byteLength() { return this._t.byteLength; }

    /**
     * Cold. Writes the EMPTY header [0xFFFFFFFF, 0] at every internal node of a
     * zeroed `_t`: the root, the root's summary when hi >= 9, every root cluster
     * when lo = 16 (deeper nodes are all leaves).
     */
    _init() {
        const t = this._t;
        const w = this._w;
        if (w <= 8) return;
        const lo = w > 24 ? 16 : 8;
        t[0] = 0xFFFFFFFF;
        t[1] = 0;
        if (w - lo > 8) {
            t[2] = 0xFFFFFFFF;
            t[3] = 0;
        }
        if (lo > 8) {
            const cb = this._g[w];
            const nc = Math.ceil(this._u / 65536);
            for (let j = 0; j < nc; j++) {
                t[cb + j * 2058] = 0xFFFFFFFF;
                t[cb + j * 2058 + 1] = 0;
            }
        }
    }

    /** @param {number} x @returns {boolean} */
    has(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        const t = this._t;
        const g = this._g;
        let b = 0;
        let w = this._w;
        while (w > 8) {
            const mn = t[b];
            const mx = t[b + 1];
            if (mn > mx) return false;
            if (x === mn || x === mx) return true;
            const lo = w > 24 ? 16 : 8;
            b = b + g[w] + (x >>> lo) * (lo > 8 ? 2058 : 8);
            x &= (1 << lo) - 1;
            w = lo;
        }
        return ((t[b + (x >>> 5)] | 0) & (1 << (x & 31))) !== 0;
    }

    /** @param {number} x @returns {this} throws RangeError on a bad key (no state touched) */
    add(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) throwKey(x, this._u);
        const t = this._t;
        const g = this._g;
        let b = 0;
        let w = this._w;
        let ps = -1;
        let pw = 0;
        let pj = 0;
        for (;;) {
            if (w <= 8) {
                const p = b + (x >>> 5);
                const m = 1 << (x & 31);
                const v = t[p] | 0;
                if ((v & m) !== 0) return this;
                t[p] = v | m;
                if (ps < 0 || v !== 0) break;
                let k = b;
                while (k < b + 8 && (k === p || (t[k] | 0) === 0)) k++;
                if (k < b + 8) break;
            } else {
                const mn = t[b];
                const mx = t[b + 1];
                if (mn > mx) {
                    t[b] = x;
                    t[b + 1] = x;
                    if (ps < 0) break;
                } else {
                    if (x === mn || x === mx) return this;
                    if (x < mn) {
                        t[b] = x;
                        x = mn;
                    } else if (x > mx) {
                        t[b + 1] = x;
                    }
                    const lo = w > 24 ? 16 : 8;
                    ps = b + 2;
                    pw = w - lo;
                    pj = x >>> lo;
                    b = b + g[w] + pj * (lo > 8 ? 2058 : 8);
                    x &= (1 << lo) - 1;
                    w = lo;
                    continue;
                }
            }
            b = ps;
            w = pw;
            x = pj;
            ps = -1;
        }
        this._size++;
        return this;
    }

    /** @param {number} x @returns {boolean} true if x was present */
    delete(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        const t = this._t;
        const g = this._g;
        const q = this._p;
        let b = 0;
        let w = this._w;
        let pb = -1;
        let pw = 0;
        let pj = 0;
        let pm = 0;
        let pr = false;
        let n = 0;
        let fe = false;
        for (;;) {
            let one = false;
            let mn = 0;
            let mx = 0;
            if (w <= 8) {
                const p = b + (x >>> 5);
                const m = 1 << (x & 31);
                const v = t[p] | 0;
                if ((v & m) === 0) return false;
                if (pb >= 0 && v === m) {
                    let k = b;
                    while (k < b + 8 && (k === p || (t[k] | 0) === 0)) k++;
                    one = k === b + 8;
                }
                t[p] = v ^ m;
            } else {
                mn = t[b];
                mx = t[b + 1];
                if (mn > mx || x < mn || x > mx) return false;
                if (mn === mx) {
                    one = true;
                    t[b] = 0xFFFFFFFF;
                    t[b + 1] = 0;
                }
            }
            if (pr) {
                const o = n << 2;
                q[o] = pb;
                q[o + 1] = pw;
                q[o + 2] = one ? pm : pj;
                q[o + 3] = one ? 1 : 2;
                n++;
                pr = false;
            }
            if (one) {
                if (pb < 0) {
                    fe = true;
                    break;
                }
                b = pb + 2;
                w = pw - (pw > 24 ? 16 : 8);
                x = pj;
                pb = -1;
                continue;
            }
            if (w <= 8) break;
            const lo = w > 24 ? 16 : 8;
            const st = lo > 8 ? 2058 : 8;
            const cb = b + g[w];
            if (x === mn) {
                let j0;
                if (w - lo > 8) {
                    j0 = t[b + 2];
                } else {
                    let p = b + 2;
                    let v = t[p] | 0;
                    while (v === 0) v = t[++p] | 0;
                    j0 = ((p - b - 2) << 5) | (31 - Math.clz32(v & -v));
                }
                const c = cb + j0 * st;
                let m0;
                if (lo > 8) {
                    m0 = t[c];
                } else {
                    let p = c;
                    let v = t[p] | 0;
                    while (v === 0) v = t[++p] | 0;
                    m0 = ((p - c) << 5) | (31 - Math.clz32(v & -v));
                }
                x = ((j0 << lo) | m0) >>> 0;
                t[b] = x;
                mn = x;
            }
            pb = b;
            pw = w;
            pj = x >>> lo;
            pm = mn;
            pr = x === mx;
            b = cb + pj * st;
            x &= (1 << lo) - 1;
            w = lo;
        }
        this._size--;
        while (n > 0) {
            n--;
            const o = n << 2;
            const fb = q[o];
            const fw = q[o + 1];
            const fa = q[o + 2];
            const md = q[o + 3];
            const top = fe;
            fe = false;
            const lo = fw > 24 ? 16 : 8;
            let j = fa;
            if (md === 1) {
                const hi = fw - lo;
                if (hi > 8) {
                    j = top ? -1 : t[fb + 3];
                } else {
                    const s = fb + 2;
                    let p = s + (hi > 5 ? 1 << (hi - 5) : 1) - 1;
                    let v = t[p] | 0;
                    while (v === 0 && p > s) v = t[--p] | 0;
                    j = v === 0 ? -1 : ((p - s) << 5) | (31 - Math.clz32(v));
                }
                if (j < 0) {
                    t[fb + 1] = fa >>> 0;
                    continue;
                }
            }
            let m;
            if (lo > 8) {
                m = t[fb + g[fw] + j * 2058 + 1];
            } else {
                const c = fb + g[fw] + (j << 3);
                let p = c + 7;
                let v = t[p] | 0;
                while (v === 0) v = t[--p] | 0;
                m = ((p - c) << 5) | (31 - Math.clz32(v));
            }
            t[fb + 1] = ((j << lo) | m) >>> 0;
        }
        return true;
    }

    /** Smallest key > x, or undefined. @param {number} x @returns {number|undefined} */
    successor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        if (this._size === 0) return undefined;
        const t = this._t;
        const g = this._g;
        let b = 0;
        let w = this._w;
        let a = 0;
        let r = 0;
        let n = 0;
        let c1 = 0;
        let l1 = 0;
        let a1 = 0;
        let c2 = 0;
        let l2 = 0;
        let a2 = 0;
        for (;;) {
            if (w <= 8) {
                const s = x + 1;
                if (s >= 1 << w) return undefined;
                const e = b + (w > 5 ? 1 << (w - 5) : 1);
                let p = b + (s >>> 5);
                let v = (t[p] | 0) & (-1 << (s & 31));
                while (v === 0) {
                    if (++p === e) return undefined;
                    v = t[p] | 0;
                }
                r = ((p - b) << 5) | (31 - Math.clz32(v & -v));
                break;
            }
            const mn = t[b];
            if (x < mn) {
                r = mn;
                break;
            }
            if (!(x < t[b + 1])) return undefined;
            const lo = w > 24 ? 16 : 8;
            const j = x >>> lo;
            const xl = x & ((1 << lo) - 1);
            const cb = b + g[w];
            if (lo > 8) {
                const c = cb + j * 2058;
                if (xl < t[c + 1]) {
                    a |= j << 16;
                    b = c;
                    w = 16;
                    x = xl;
                    continue;
                }
            } else if (xl < 255) {
                const c = cb + (j << 3);
                const s = xl + 1;
                let p = c + (s >>> 5);
                let v = (t[p] | 0) & (-1 << (s & 31));
                while (v === 0 && ++p < c + 8) v = t[p] | 0;
                if (v !== 0) {
                    r = (j << 8) | ((p - c) << 5) | (31 - Math.clz32(v & -v));
                    break;
                }
            }
            if (n === 0) {
                c1 = cb;
                l1 = lo;
                a1 = a;
            } else {
                c2 = cb;
                l2 = lo;
                a2 = a;
            }
            n++;
            a = 0;
            b += 2;
            w -= lo;
            x = j;
        }
        r |= a;
        while (n > 0) {
            let cb = c1;
            let lo = l1;
            let fa = a1;
            if (n === 2) {
                cb = c2;
                lo = l2;
                fa = a2;
            }
            n--;
            let m;
            if (lo > 8) {
                m = t[cb + r * 2058];
            } else {
                const c = cb + (r << 3);
                let p = c;
                let v = t[p] | 0;
                while (v === 0) v = t[++p] | 0;
                m = ((p - c) << 5) | (31 - Math.clz32(v & -v));
            }
            r = fa | (r << lo) | m;
        }
        return r >>> 0;
    }

    /** Largest key < x, or undefined. @param {number} x @returns {number|undefined} */
    predecessor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        if (this._size === 0) return undefined;
        const t = this._t;
        const g = this._g;
        let b = 0;
        let w = this._w;
        let a = 0;
        let r = 0;
        let n = 0;
        let c1 = 0;
        let l1 = 0;
        let a1 = 0;
        let m1 = 0;
        let c2 = 0;
        let l2 = 0;
        let a2 = 0;
        let m2 = 0;
        for (;;) {
            if (w <= 8) {
                if (x !== 0) {
                    const s = x - 1;
                    let p = b + (s >>> 5);
                    let v = (t[p] | 0) & ~(-2 << (s & 31));
                    while (v === 0 && p > b) v = t[--p] | 0;
                    if (v !== 0) {
                        r = ((p - b) << 5) | (31 - Math.clz32(v));
                        break;
                    }
                }
            } else {
                const mx = t[b + 1];
                if (x > mx) {
                    r = mx;
                    break;
                }
                const mn = t[b];
                if (x > mn) {
                    const lo = w > 24 ? 16 : 8;
                    const j = x >>> lo;
                    const xl = x & ((1 << lo) - 1);
                    const cb = b + g[w];
                    if (lo > 8) {
                        const c = cb + j * 2058;
                        if (xl > t[c]) {
                            a |= j << 16;
                            b = c;
                            w = 16;
                            x = xl;
                            continue;
                        }
                    } else if (xl !== 0) {
                        const c = cb + (j << 3);
                        const s = xl - 1;
                        let p = c + (s >>> 5);
                        let v = (t[p] | 0) & ~(-2 << (s & 31));
                        while (v === 0 && p > c) v = t[--p] | 0;
                        if (v !== 0) {
                            r = (j << 8) | ((p - c) << 5) | (31 - Math.clz32(v));
                            break;
                        }
                    }
                    if (n === 0) {
                        c1 = cb;
                        l1 = lo;
                        a1 = a;
                        m1 = mn;
                    } else {
                        c2 = cb;
                        l2 = lo;
                        a2 = a;
                        m2 = mn;
                    }
                    n++;
                    a = 0;
                    b += 2;
                    w -= lo;
                    x = j;
                    continue;
                }
            }
            if (n === 0) return undefined;
            n--;
            r = n === 1 ? a2 | m2 : a1 | m1;
            a = 0;
            break;
        }
        r |= a;
        while (n > 0) {
            let cb = c1;
            let lo = l1;
            let fa = a1;
            if (n === 2) {
                cb = c2;
                lo = l2;
                fa = a2;
            }
            n--;
            let m;
            if (lo > 8) {
                m = t[cb + r * 2058 + 1];
            } else {
                const c = cb + (r << 3);
                let p = c + 7;
                let v = t[p] | 0;
                while (v === 0) v = t[--p] | 0;
                m = ((p - c) << 5) | (31 - Math.clz32(v));
            }
            r = fa | (r << lo) | m;
        }
        return r >>> 0;
    }

    /** Smallest key, or undefined if empty. @returns {number|undefined} */
    min() {
        if (this._size === 0) return undefined;
        const t = this._t;
        if (this._w > 8) return t[0] >>> 0;
        let p = 0;
        let v = t[0] | 0;
        while (v === 0) v = t[++p] | 0;
        return ((p << 5) | (31 - Math.clz32(v & -v))) >>> 0;
    }

    /** Largest key, or undefined if empty. @returns {number|undefined} */
    max() {
        if (this._size === 0) return undefined;
        const t = this._t;
        const w = this._w;
        if (w > 8) return t[1] >>> 0;
        let p = (w > 5 ? 1 << (w - 5) : 1) - 1;
        let v = t[p] | 0;
        while (v === 0) v = t[--p] | 0;
        return ((p << 5) | (31 - Math.clz32(v))) >>> 0;
    }

    /** Cold. Removes every key. */
    clear() {
        this._t.fill(0);
        this._init();
        this._size = 0;
    }
}

// --- RoaringSet (0.6.0) ------------------------------------------------------

/** Hysteresis: a large-slot array returns to a small slot when a delete leaves <= 32 keys (promote stays at 65). */
const DEMOTE_SMALL = 32;
/** Hysteresis: a bitmap becomes an array when a delete leaves 2,048 keys (promote stays at 4,097). */
const DEMOTE_BITMAP = 2048;

/**
 * Cold. Throws RangeError when a container pool is exhausted on add(),
 * delete() or a conversion, before any write. Kept out of hot bodies so the
 * string concat never bloats their bytecode.
 * @param {string} pool
 * @param {number} cap
 */
function throwRPool(pool, cap) {
    throw new RangeError('[lite-loglogn] RoaringSet ' + pool +
        ' container pool exhausted (capacity ' + cap + '); increase pool capacity at construction');
}

/**
 * Cold. Population count of a 32-bit word (SWAR, lite-fastbit32 / lite-o1 parity).
 * @param {number} x
 * @returns {number}
 */
function popcnt32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
}

/**
 * Cold. True iff o is a RoaringSet. The set ops' `other` guard calls this module helper rather than naming
 * the class inside its own body: a class-body reference to `RoaringSet` gives the class a context, and every
 * method that reads a module binding (throwKey, throwRPool, DEMOTE_*) then reads it one context deeper
 * (+2 / +4 B of bytecode on add / delete).
 * @param {*} o
 * @returns {boolean}
 */
function isRoaringSet(o) {
    return o instanceof RoaringSet;
}

/**
 * Cold. Throws when a counting set op receives a bad `other`: TypeError when it is not a RoaringSet,
 * RangeError when its universe differs. Kept out of the set-op bodies (string concat stays cold).
 * @param {*} other
 * @param {number} u this set's universe
 */
function throwROther(other, u) {
    if (!(other instanceof RoaringSet)) {
        throw new TypeError('[lite-loglogn] RoaringSet expected a RoaringSet; got ' +
            (other === null ? 'null' : typeof other));
    }
    throw new RangeError('[lite-loglogn] RoaringSet universe mismatch: expected ' +
        u + ', got ' + other._u);
}

/**
 * Cold. Throws RangeError for a bad addRange bound (lo or hi not a number, not an integer, or not
 * 0 <= lo <= hi <= U), before anything of the set is read. Kept out of the range body (string concat stays cold).
 * @param {*} lo
 * @param {*} hi
 * @param {number} u this set's universe
 */
function throwRRange(lo, hi, u) {
    throw new RangeError('[lite-loglogn] RoaringSet addRange bounds must be integers with 0 <= lo <= hi <= ' + u +
        '; got lo ' + (typeof lo === 'number' ? String(lo) : typeof lo) +
        ', hi ' + (typeof hi === 'number' ? String(hi) : typeof hi));
}

/**
 * RoaringSet -- a compressed ordered set over a FIXED universe [0, U),
 * 1 <= U <= 2^32, Roaring-style: the key space splits into 2^16-key chunks,
 * each held by the smallest fitting container (kind ids in `_kind`):
 * 7 SINGLE (1 key, its low 16 bits in `_slot`, 0 B), 1 small array (2..64
 * keys, a 128 B small slot), 2 array (up to 4,096 keys, an 8 KB large slot),
 * 3 bitmap (8 KB + a 66-word summary), 4 runs (an 8 KB large slot, <= 2,048
 * runs as (start, len - 1) pairs), 5 small runs (<= 32 runs in a small slot),
 * 6 FULL (all 65,536 keys, 0 B). Promote / demote use hysteresis: a small
 * array moves to a large slot at its 65th key, a large-slot array returns to a
 * small slot when a delete leaves <= DEMOTE_SMALL keys and a small slot is
 * free; an array becomes a bitmap at its 4,097th key, a bitmap becomes an
 * array when a delete leaves DEMOTE_BITMAP keys. A three-level top pyramid
 * over the chunks (`_top`, 2,115 words) answers next / previous live chunk;
 * per-chunk [min, max] headers (`_cMin` / `_cMax`) answer min / max and
 * cross-chunk successor / predecessor without a container search. Runs come
 * only from runOptimize() (add never re-encodes).
 *
 * SPACE is fixed at construction: every pool is preallocated and NEVER grows.
 * The chunk table is DIRECT (11 B per chunk) or PAGED (a directory plus pooled
 * 2^pageBits-row pages, 11 B per row, page 0 a shared zero page), chosen once
 * at construction; `paged` reports it. Per-chunk metadata is read through a
 * row m = `_mi(c)` (direct: the row is the chunk; paged: `_dir` maps the
 * chunk's page). byteLength (direct) =
 * 8,460 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge, C =
 * ceil(U / 65536); paged replaces 11 C by 11 (maxPages + 1) 2^pageBits +
 * 2 ceil(C / 2^pageBits) + 4 maxPages + 2. Examples (U = 2^32): default pools,
 * direct 3,036,180; maxSmall 0 / maxLarge 1, direct 746,270, paged maxPages 1
 * 31,524.
 *
 * Hot methods (has / add / delete / successor / predecessor / min / max)
 * allocate 0 bytes for keys < 2^30; a returned key >= 2^31 (>= 2^30 on a
 * pointer-compressed engine) may box as a HeapNumber when the call is not
 * inlined. successor / predecessor are STRICT (> x / < x). -0 aliases key 0. A
 * bad key (not a number, not an integer in [0, U)) touches nothing: has /
 * delete -> false, successor / predecessor -> undefined, add -> RangeError.
 * Pool exhaustion throws RangeError BEFORE any write (set unchanged), so add
 * AND delete can throw on a valid key (a delete from a FULL chunk takes a small
 * slot, else a large one; splitting a small-runs run past 32 runs takes a large
 * slot).
 */
export class RoaringSet {
    /**
     * @param {number} universe integer in [1, 2^32] (required)
     * @param {number} [maxSmall=1024] small-slot pool, integer in [0, 65535]
     * @param {number} [maxLarge=256] large-slot pool, integer in [1, 65534] (plus one spare slab)
     * @param {number} [maxPages] metadata page pool, integer in [1, ceil(C / 2^pageBits)]; default (undefined): all pages
     * @param {number} [pageBits=8] chunks per metadata page = 2^pageBits, integer in [1, 15]
     *
     * Layout (fixed here): PAGED iff 11 (maxPages + 1) 2^pageBits + 2 ceil(C / 2^pageBits) + 4 maxPages + 2 <
     * 11 C (the paged metadata is strictly smaller than the direct table), else DIRECT. The default (all pages) is
     * direct at every universe. Both layouts own the same fields in the same order (one hidden class).
     */
    constructor(universe, maxSmall = 1024, maxLarge = 256, maxPages = undefined, pageBits = 8) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 1 || universe > 4294967296) {
            throw new RangeError('[lite-loglogn] RoaringSet universe must be an integer in [1, 2^32]; got ' +
                (typeof universe === 'number' ? String(universe) : typeof universe));
        }
        if (typeof maxSmall !== 'number' || !Number.isInteger(maxSmall) ||
            maxSmall < 0 || maxSmall > 65535) {
            throw new RangeError('[lite-loglogn] RoaringSet maxSmall must be an integer in [0, 65535]; got ' +
                (typeof maxSmall === 'number' ? String(maxSmall) : typeof maxSmall));
        }
        if (typeof maxLarge !== 'number' || !Number.isInteger(maxLarge) ||
            maxLarge < 1 || maxLarge > 65534) {
            throw new RangeError('[lite-loglogn] RoaringSet maxLarge must be an integer in [1, 65534]; got ' +
                (typeof maxLarge === 'number' ? String(maxLarge) : typeof maxLarge));
        }
        if (typeof pageBits !== 'number' || !Number.isInteger(pageBits) || pageBits < 1 || pageBits > 15) {
            throw new RangeError('[lite-loglogn] RoaringSet pageBits must be an integer in [1, 15]; got ' +
                (typeof pageBits === 'number' ? String(pageBits) : typeof pageBits));
        }
        const chunks = Math.ceil(universe / 65536);
        const dirLen = (chunks + (1 << pageBits) - 1) >>> pageBits;
        if (maxPages === undefined) maxPages = dirLen;
        if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > dirLen) {
            throw new RangeError('[lite-loglogn] RoaringSet maxPages must be an integer in [1, ' + dirLen +
                '] for this universe and pageBits; got ' +
                (typeof maxPages === 'number' ? String(maxPages) : typeof maxPages));
        }
        // layout decision (C-5): paged only when its metadata bytes are strictly below the direct table's
        const paged = 11 * (maxPages + 1) * (1 << pageBits) + 2 * dirLen + 4 * maxPages + 2 < 11 * chunks;
        // paged: rows of pooled pages of 2^pageBits chunks, page 0 the never-written ZERO page (an absent page
        // reads kind 0); direct: the row is the chunk, the page arrays are empty and _pSh 0 marks the layout
        const rows = paged ? (maxPages + 1) << pageBits : chunks;
        this._u = universe;
        this._chunks = chunks;
        this._maxS = maxSmall;
        this._maxL = maxLarge;
        this._size = 0;
        this._top = new Uint32Array(2115);
        this._pSh = paged ? pageBits : 0;
        this._pMask = paged ? (1 << pageBits) - 1 : 0;
        this._maxP = paged ? maxPages : 0;
        this._dir = new Uint16Array(paged ? dirLen : 0);
        this._pLive = new Uint16Array(paged ? maxPages + 1 : 0);
        this._pFree = new Uint16Array(paged ? maxPages : 0);
        this._pTop = paged ? maxPages : 0;
        for (let i = 0; i < this._pTop; i++) this._pFree[i] = maxPages - i;
        this._kind = new Uint8Array(rows);
        this._slot = new Uint16Array(rows);
        this._card = new Uint16Array(rows);
        this._runs = new Uint16Array(rows);
        this._cMin = new Uint16Array(rows);
        this._cMax = new Uint16Array(rows);
        this._sData = new Uint16Array(maxSmall * 64);
        this._sFree = new Uint16Array(maxSmall);
        this._sTop = maxSmall;
        for (let i = 0; i < maxSmall; i++) this._sFree[i] = maxSmall - 1 - i;
        const totalLarge = maxLarge + 1;
        const slabBuf = new ArrayBuffer(totalLarge * 8192);
        this._lU16 = new Uint16Array(slabBuf);
        this._lU32 = new Uint32Array(slabBuf);
        this._bSum = new Uint32Array(totalLarge * 66);
        this._lFree = new Uint16Array(maxLarge);
        this._lTop = maxLarge;
        for (let i = 0; i < maxLarge; i++) this._lFree[i] = maxLarge - 1 - i;
        this._conv = maxLarge;
    }

    get size() { return this._size; }
    get universe() { return this._u; }
    /** True iff the chunk metadata is paged (fixed at construction by the constructor's layout rule). */
    get paged() { return this._pSh !== 0; }
    /**
     * Bytes of every typed array owned: direct 8,460 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge;
     * paged replaces 11 C by 11 (maxPages + 1) 2^pageBits + 2 ceil(C / 2^pageBits) + 4 maxPages + 2.
     */
    get byteLength() {
        return this._top.byteLength + this._kind.byteLength + this._slot.byteLength +
            this._card.byteLength + this._runs.byteLength +
            this._cMin.byteLength + this._cMax.byteLength + this._sData.byteLength +
            this._sFree.byteLength + this._lU16.byteLength + this._bSum.byteLength +
            this._lFree.byteLength +
            this._dir.byteLength + this._pLive.byteLength + this._pFree.byteLength;
    }

    /**
     * Hot helper. Metadata row of chunk c. Direct (_pSh 0): the row is the chunk. Paged: one directory read; an
     * absent page maps to the zero page, whose rows read kind 0.
     */
    _mi(c) {
        const sh = this._pSh;
        return sh === 0 ? c : (this._dir[c >>> sh] << sh) | (c & this._pMask);
    }

    /**
     * Cold-ish. First key `lo` of the empty chunk c (row m) -> SINGLE: no container
     * pool, both headers, the top pyramid, the size. Paged: the chunk's page is mapped
     * first (_pageAcquire; the only pool a new chunk needs), so an empty page pool
     * throws before any write and the zero page is never written. Direct: cannot throw.
     */
    _addChunk(c, m, lo) {
        if (this._pSh !== 0) m = this._pageAcquire(c);
        this._kind[m] = 7;
        this._slot[m] = lo;
        this._card[m] = 0;
        this._cMin[m] = lo;
        this._cMax[m] = lo;
        this._topSet(c);
        this._size++;
    }

    /**
     * Cold. Paged only. Maps chunk c's page when absent (LIFO pop; throws the page-pool
     * RangeError BEFORE any write when the pool is empty), counts
     * c as a live chunk of it and returns c's row. The caller makes c non-empty.
     */
    _pageAcquire(c) {
        const sh = this._pSh;
        const d = c >>> sh;
        let pg = this._dir[d];
        if (pg === 0) {
            if (this._pTop === 0) {
                throw new RangeError('[lite-loglogn] RoaringSet metadata page pool exhausted (maxPages ' + this._maxP +
                    '); increase maxPages at construction');
            }
            pg = this._pFree[--this._pTop];
            this._dir[d] = pg;
        }
        this._pLive[pg]++;
        return (pg << sh) | (c & this._pMask);
    }

    /**
     * Cold. Pages a write to chunks c0..c1 (inclusive, c0 <= c1) would map: the absent
     * pages among them (0 when direct). Read-only, for a fail-closed precount.
     */
    _pagesNeeded(c0, c1) {
        const sh = this._pSh;
        if (sh === 0) return 0;
        const dir = this._dir;
        const e = c1 >>> sh;
        let n = 0;
        for (let d = c0 >>> sh; d <= e; d++) if (dir[d] === 0) n++;
        return n;
    }

    /**
     * Cold-ish. Chunk c just emptied (kind 0, top bit cleared). Direct: nothing to release.
     * Paged: when c was its page's last live chunk, the page is reset (_pageZero) and
     * pushed back on the LIFO pool, so a free page equals a fresh one.
     */
    _pageRelease(c) {
        const sh = this._pSh;
        if (sh === 0) return;
        const d = c >>> sh;
        const pg = this._dir[d];
        const live = this._pLive[pg] - 1;
        this._pLive[pg] = live;
        if (live !== 0) return;
        this._dir[d] = 0;
        this._pageZero(pg);
        this._pFree[this._pTop++] = pg;
    }

    /**
     * Cold. Page pg's rows back to 0 in the fields an emptied row leaves stale (_slot:
     * a SINGLE's key; the _cMin / _cMax headers); _kind / _card / _runs are already 0 on
     * an empty row. 3 x 2^pageBits writes.
     */
    _pageZero(pg) {
        const b = pg << this._pSh;
        const e = b + (1 << this._pSh);
        this._slot.fill(0, b, e);
        this._cMin.fill(0, b, e);
        this._cMax.fill(0, b, e);
    }

    _topSet(c) {
        const t = this._top;
        let p = c >>> 5;
        let m = 1 << (c & 31);
        let v = t[p];
        if ((v & m) !== 0) return;
        t[p] = v | m;
        if (v !== 0) return;
        let i = p;
        p = 2048 + (i >>> 5);
        m = 1 << (i & 31);
        v = t[p];
        t[p] = v | m;
        if (v !== 0) return;
        i >>>= 5;
        p = 2112 + (i >>> 5);
        m = 1 << (i & 31);
        v = t[p];
        t[p] = v | m;
        if (v !== 0) return;
        t[2114] |= 1 << (i >>> 5);
    }

    _topClear(c) {
        const t = this._top;
        let p = c >>> 5;
        const m = 1 << (c & 31);
        let v = t[p];
        if ((v & m) === 0) return;
        v &= ~m;
        t[p] = v;
        if (v !== 0) return;
        let i = p;
        p = 2048 + (i >>> 5);
        v = t[p] & ~(1 << (i & 31));
        t[p] = v;
        if (v !== 0) return;
        i >>>= 5;
        p = 2112 + (i >>> 5);
        v = t[p] & ~(1 << (i & 31));
        t[p] = v;
        if (v !== 0) return;
        t[2114] &= ~(1 << (i >>> 5));
    }

    _nextChunk(c) {
        if (c >= this._chunks) return -1;
        const t = this._top;
        let p = c >>> 5;
        let v = t[p] & (-1 << (c & 31));
        if (v !== 0) return (p << 5) | (31 - Math.clz32(v & -v));
        let i = p + 1;
        if (i >= 2048) return -1;
        p = i >>> 5;
        v = t[2048 + p] & (-1 << (i & 31));
        if (v !== 0) {
            i = (p << 5) | (31 - Math.clz32(v & -v));
            v = t[i];
            return (i << 5) | (31 - Math.clz32(v & -v));
        }
        i = p + 1;
        if (i >= 64) return -1;
        p = i >>> 5;
        v = t[2112 + p] & (-1 << (i & 31));
        if (v === 0) {
            if (p === 0 && (t[2114] & 2) !== 0) {
                v = t[2113];
                p = 1;
            } else {
                return -1;
            }
        }
        i = (p << 5) | (31 - Math.clz32(v & -v));
        v = t[2048 + i];
        i = (i << 5) | (31 - Math.clz32(v & -v));
        v = t[i];
        return (i << 5) | (31 - Math.clz32(v & -v));
    }

    _prevChunk(c) {
        if (c < 0) return -1;
        const t = this._top;
        let p = c >>> 5;
        let v = t[p] & ~(-2 << (c & 31));
        if (v !== 0) return (p << 5) | (31 - Math.clz32(v));
        if (p === 0) return -1;
        let i = p - 1;
        p = i >>> 5;
        v = t[2048 + p] & ~(-2 << (i & 31));
        if (v !== 0) {
            i = (p << 5) | (31 - Math.clz32(v));
            v = t[i] | 0;
            return (i << 5) | (31 - Math.clz32(v));
        }
        if (p === 0) return -1;
        i = p - 1;
        p = i >>> 5;
        v = t[2112 + p] & ~(-2 << (i & 31));
        if (v === 0) {
            if (p === 1 && (t[2114] & 1) !== 0) {
                v = t[2112] | 0;
                p = 0;
            } else {
                return -1;
            }
        }
        i = (p << 5) | (31 - Math.clz32(v));
        v = t[2048 + i] | 0;
        i = (i << 5) | (31 - Math.clz32(v));
        v = t[i] | 0;
        return (i << 5) | (31 - Math.clz32(v));
    }

    /** Hot helper. Smallest non-empty chunk; the set must be non-empty. 4 top-pyramid reads. */
    _firstChunk() {
        const t = this._top;
        const v3 = t[2114];
        let i = 31 - Math.clz32(v3 & -v3);
        let v = t[2112 + i];
        i = (i << 5) | (31 - Math.clz32(v & -v));
        v = t[2048 + i];
        i = (i << 5) | (31 - Math.clz32(v & -v));
        v = t[i];
        return (i << 5) | (31 - Math.clz32(v & -v));
    }

    /** Hot helper. Largest non-empty chunk; the set must be non-empty. 4 top-pyramid reads. */
    _lastChunk() {
        const t = this._top;
        let i = 31 - Math.clz32(t[2114] | 0);
        let v = t[2112 + i] | 0;
        i = (i << 5) | (31 - Math.clz32(v));
        v = t[2048 + i] | 0;
        i = (i << 5) | (31 - Math.clz32(v));
        v = t[i] | 0;
        return (i << 5) | (31 - Math.clz32(v));
    }

    _lb16(arr, base, len, lo) {
        let l = 0;
        let h = len;
        while (l < h) {
            const m = (l + h) >>> 1;
            if (arr[base + m] < lo) l = m + 1;
            else h = m;
        }
        return l;
    }

    _lbRun(u16, base, nRuns, lo) {
        let l = 0;
        let h = nRuns;
        while (l < h) {
            const m = (l + h) >>> 1;
            const idx = base + (m << 1);
            if (u16[idx] + u16[idx + 1] < lo) l = m + 1;
            else h = m;
        }
        return l;
    }

    _bmpSet(slot, lo) {
        const wBase = slot << 11;
        const sBase = slot * 66;
        const wIdx = lo >>> 5;
        const mask = 1 << (lo & 31);
        const u32 = this._lU32;
        const old = u32[wBase + wIdx];
        if ((old & mask) !== 0) return false;
        u32[wBase + wIdx] = old | mask;
        if (old === 0) {
            const sum = this._bSum;
            const s1Idx = wIdx >>> 5;
            const s1Old = sum[sBase + s1Idx];
            sum[sBase + s1Idx] = s1Old | (1 << (wIdx & 31));
            if (s1Old === 0) {
                sum[sBase + 64 + (s1Idx >>> 5)] |= 1 << (s1Idx & 31);
            }
        }
        return true;
    }

    _bmpClear(slot, lo) {
        const wBase = slot << 11;
        const sBase = slot * 66;
        const wIdx = lo >>> 5;
        const mask = 1 << (lo & 31);
        const u32 = this._lU32;
        const old = u32[wBase + wIdx];
        if ((old & mask) === 0) return false;
        const next = old & ~mask;
        u32[wBase + wIdx] = next;
        if (next === 0) {
            const sum = this._bSum;
            const s1Idx = wIdx >>> 5;
            const s1Next = sum[sBase + s1Idx] & ~(1 << (wIdx & 31));
            sum[sBase + s1Idx] = s1Next;
            if (s1Next === 0) {
                sum[sBase + 64 + (s1Idx >>> 5)] &= ~(1 << (s1Idx & 31));
            }
        }
        return true;
    }

    _bmpNextGEQ(slot, lo) {
        const wBase = slot << 11;
        const sBase = slot * 66;
        const u32 = this._lU32;
        const sum = this._bSum;
        let wIdx = lo >>> 5;
        let v = u32[wBase + wIdx] & (-1 << (lo & 31));
        if (v !== 0) return (wIdx << 5) | (31 - Math.clz32(v & -v));
        let i = wIdx + 1;
        if (i >= 2048) return -1;
        let s1Idx = i >>> 5;
        v = sum[sBase + s1Idx] & (-1 << (i & 31));
        if (v === 0) {
            const s2Idx = s1Idx + 1;
            if (s2Idx >= 64) return -1;
            const l2p = s2Idx >>> 5;
            let l2v = sum[sBase + 64 + l2p] & (-1 << (s2Idx & 31));
            if (l2v === 0) {
                if (l2p !== 0) return -1;
                l2v = sum[sBase + 65];
                if (l2v === 0) return -1;
                s1Idx = 32 + (31 - Math.clz32(l2v & -l2v));
            } else {
                s1Idx = (l2p << 5) | (31 - Math.clz32(l2v & -l2v));
            }
            v = sum[sBase + s1Idx];
        }
        wIdx = (s1Idx << 5) | (31 - Math.clz32(v & -v));
        v = u32[wBase + wIdx];
        return (wIdx << 5) | (31 - Math.clz32(v & -v));
    }

    _bmpPrevLEQ(slot, lo) {
        const wBase = slot << 11;
        const sBase = slot * 66;
        const u32 = this._lU32;
        const sum = this._bSum;
        let wIdx = lo >>> 5;
        let v = u32[wBase + wIdx] & ~(-2 << (lo & 31));
        if (v !== 0) return (wIdx << 5) | (31 - Math.clz32(v));
        if (wIdx === 0) return -1;
        let i = wIdx - 1;
        let s1Idx = i >>> 5;
        v = sum[sBase + s1Idx] & ~(-2 << (i & 31));
        if (v === 0) {
            if (s1Idx === 0) return -1;
            const s2Idx = s1Idx - 1;
            const l2p = s2Idx >>> 5;
            let l2v = sum[sBase + 64 + l2p] & ~(-2 << (s2Idx & 31));
            if (l2v === 0) {
                if (l2p !== 1) return -1;
                l2v = sum[sBase + 64] | 0;
                if (l2v === 0) return -1;
                s1Idx = 31 - Math.clz32(l2v);
            } else {
                s1Idx = (l2p << 5) | (31 - Math.clz32(l2v));
            }
            v = sum[sBase + s1Idx] | 0;
        }
        wIdx = (s1Idx << 5) | (31 - Math.clz32(v));
        v = u32[wBase + wIdx] | 0;
        return (wIdx << 5) | (31 - Math.clz32(v));
    }

    /** Hot helper. Min header of row m: 1 read on every kind (the chunk must be non-empty). */
    _chunkMin(m) {
        return this._cMin[m];
    }

    /** Hot helper. Max header of row m: 1 read on every kind (the chunk must be non-empty). */
    _chunkMax(m) {
        return this._cMax[m];
    }

    has(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        const c = x >>> 16;
        const m = this._mi(c);
        const k = this._kind[m];
        if (k === 0) return false;
        if (k === 6) return true;
        const lo = x & 0xFFFF;
        const slot = this._slot[m];
        if (k === 7) return slot === lo;
        if (k === 1) {
            const len = this._card[m] + 1;
            const base = slot << 6;
            const j = this._lb16(this._sData, base, len, lo);
            return j < len && this._sData[base + j] === lo;
        }
        if (k === 2) {
            const len = this._card[m] + 1;
            const base = slot << 12;
            const j = this._lb16(this._lU16, base, len, lo);
            return j < len && this._lU16[base + j] === lo;
        }
        if (k === 3) {
            return (this._lU32[(slot << 11) + (lo >>> 5)] & (1 << (lo & 31))) !== 0;
        }
        const nRuns = this._runs[m] + 1;
        const u16 = k === 5 ? this._sData : this._lU16;
        const base = k === 5 ? slot << 6 : slot << 12;
        const r = this._lbRun(u16, base, nRuns, lo);
        return r < nRuns && u16[base + (r << 1)] <= lo;
    }

    add(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) throwKey(x, this._u);
        const c = x >>> 16;
        const m = this._mi(c);
        const lo = x & 0xFFFF;
        const k = this._kind[m];
        if (k === 0) {
            // a new chunk is a SINGLE (0 B, no pool slot) with both headers (_addChunk)
            this._addChunk(c, m, lo);
            return this;
        }
        const slot = this._slot[m];
        if (k === 7) {
            if (slot === lo) return this;
            this._promoteSingle(m, slot, lo);
            this._size++;
            return this;
        }
        if (k === 1) {
            const len = this._card[m] + 1;
            const base = slot << 6;
            const sData = this._sData;
            const j = this._lb16(sData, base, len, lo);
            if (j < len && sData[base + j] === lo) return this;
            if (len < 64) {
                sData.copyWithin(base + j + 1, base + j, base + len);
                sData[base + j] = lo;
                this._card[m] = len;
                if (j === 0) this._cMin[m] = lo;
                else if (j === len) this._cMax[m] = lo;
                this._size++;
                return this;
            }
            this._promoteSmallToArray(m, slot, j, lo);
            this._size++;
            return this;
        }
        if (k === 2) {
            const len = this._card[m] + 1;
            const base = slot << 12;
            const lU16 = this._lU16;
            const j = this._lb16(lU16, base, len, lo);
            if (j < len && lU16[base + j] === lo) return this;
            if (len < 4096) {
                lU16.copyWithin(base + j + 1, base + j, base + len);
                lU16[base + j] = lo;
                this._card[m] = len;
                if (j === 0) this._cMin[m] = lo;
                else if (j === len) this._cMax[m] = lo;
                this._size++;
                return this;
            }
            this._promoteArrayToBitmap(m, slot, lo);
            this._size++;
            return this;
        }
        if (k === 3) {
            if (this._bmpSet(slot, lo)) {
                if (lo < this._cMin[m]) this._cMin[m] = lo;
                else if (lo > this._cMax[m]) this._cMax[m] = lo;
                if (++this._card[m] === 65535) this._toFull(m, 3, slot);
                this._size++;
            }
            return this;
        }
        this._addRun(m, slot, lo, k);
        return this;
    }

    delete(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        const c = x >>> 16;
        const m = this._mi(c);
        const k = this._kind[m];
        if (k === 0) return false;
        const lo = x & 0xFFFF;
        const slot = this._slot[m];
        if (k === 7) {
            // the last key of a chunk (headers left stale, as every emptied chunk's)
            if (slot !== lo) return false;
            this._kind[m] = 0;
            this._topClear(c);
            this._pageRelease(c);
            this._size--;
            return true;
        }
        if (k === 1) {
            const len = this._card[m] + 1;
            const base = slot << 6;
            const sData = this._sData;
            const j = this._lb16(sData, base, len, lo);
            if (j >= len || sData[base + j] !== lo) return false;
            if (len === 2) {
                this._toSingle(m, 1, slot, sData[base + 1 - j]);
            } else {
                sData.copyWithin(base + j, base + j + 1, base + len);
                this._card[m] = len - 2;
                if (j === 0) this._cMin[m] = sData[base];
                else if (j === len - 1) this._cMax[m] = sData[base + len - 2];
            }
            this._size--;
            return true;
        }
        if (k === 2) {
            const len = this._card[m] + 1;
            const base = slot << 12;
            const lU16 = this._lU16;
            const j = this._lb16(lU16, base, len, lo);
            if (j >= len || lU16[base + j] !== lo) return false;
            if (len === 2) {
                this._toSingle(m, 2, slot, lU16[base + 1 - j]);
            } else if (len - 1 <= DEMOTE_SMALL && this._sTop > 0) {
                this._demoteArrayToSmall(m, slot, j, len);
            } else {
                lU16.copyWithin(base + j, base + j + 1, base + len);
                this._card[m] = len - 2;
                if (j === 0) this._cMin[m] = lU16[base];
                else if (j === len - 1) this._cMax[m] = lU16[base + len - 2];
            }
            this._size--;
            return true;
        }
        if (k === 3) {
            if (!this._bmpClear(slot, lo)) return false;
            // a bitmap holds >= 2,049 keys here, so a removed min / max always has a successor / predecessor
            if (lo === this._cMin[m]) this._cMin[m] = this._bmpNextGEQ(slot, lo);
            else if (lo === this._cMax[m]) this._cMax[m] = this._bmpPrevLEQ(slot, lo);
            const newCard = this._card[m] - 1;
            if (newCard < DEMOTE_BITMAP) {
                this._demoteBitmapToArray(m, slot);
            } else {
                this._card[m] = newCard;
            }
            this._size--;
            return true;
        }
        return this._deleteRun(m, slot, lo, k);
    }

    successor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        if (this._size === 0 || x + 1 >= this._u) return undefined;
        const q = x + 1;
        let c = q >>> 16;
        const m = this._mi(c);
        const lo = q & 0xFFFF;
        const k = this._kind[m];
        // lo > max skips the in-chunk search; lo <= min answers from the header. A SINGLE (min == max) never
        // gets past these two tests, so it needs no branch below; inside (min, max] every search hits.
        if (k !== 0 && lo <= this._cMax[m]) {
            const mn = this._cMin[m];
            if (lo <= mn) return ((c << 16) | mn) >>> 0;
            if (k === 6) return ((c << 16) | lo) >>> 0;
            const slot = this._slot[m];
            if (k === 1) {
                const len = this._card[m] + 1;
                const base = slot << 6;
                const j = this._lb16(this._sData, base, len, lo);
                if (j < len) return ((c << 16) | this._sData[base + j]) >>> 0;
            } else if (k === 2) {
                const len = this._card[m] + 1;
                const base = slot << 12;
                const j = this._lb16(this._lU16, base, len, lo);
                if (j < len) return ((c << 16) | this._lU16[base + j]) >>> 0;
            } else if (k === 3) {
                const b = this._bmpNextGEQ(slot, lo);
                if (b >= 0) return ((c << 16) | b) >>> 0;
            } else {
                const nRuns = this._runs[m] + 1;
                const u16 = k === 5 ? this._sData : this._lU16;
                const base = k === 5 ? slot << 6 : slot << 12;
                const r = this._lbRun(u16, base, nRuns, lo);
                if (r < nRuns) {
                    const start = u16[base + (r << 1)];
                    return ((c << 16) | (start > lo ? start : lo)) >>> 0;
                }
            }
        }
        c = this._nextChunk(c + 1);
        if (c < 0) return undefined;
        return ((c << 16) | this._chunkMin(this._mi(c))) >>> 0;
    }

    predecessor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        if (this._size === 0 || x === 0) return undefined;
        const q = x - 1;
        let c = q >>> 16;
        const m = this._mi(c);
        const lo = q & 0xFFFF;
        const k = this._kind[m];
        // lo < min skips the in-chunk search; lo >= max answers from the header (SINGLE: as in successor)
        if (k !== 0 && lo >= this._cMin[m]) {
            const mx = this._cMax[m];
            if (lo >= mx) return ((c << 16) | mx) >>> 0;
            if (k === 6) return ((c << 16) | lo) >>> 0;
            const slot = this._slot[m];
            if (k === 1) {
                const len = this._card[m] + 1;
                const base = slot << 6;
                const j = this._lb16(this._sData, base, len, lo);
                if (j < len && this._sData[base + j] === lo) return ((c << 16) | lo) >>> 0;
                if (j > 0) return ((c << 16) | this._sData[base + j - 1]) >>> 0;
            } else if (k === 2) {
                const len = this._card[m] + 1;
                const base = slot << 12;
                const j = this._lb16(this._lU16, base, len, lo);
                if (j < len && this._lU16[base + j] === lo) return ((c << 16) | lo) >>> 0;
                if (j > 0) return ((c << 16) | this._lU16[base + j - 1]) >>> 0;
            } else if (k === 3) {
                const b = this._bmpPrevLEQ(slot, lo);
                if (b >= 0) return ((c << 16) | b) >>> 0;
            } else {
                const nRuns = this._runs[m] + 1;
                const u16 = k === 5 ? this._sData : this._lU16;
                const base = k === 5 ? slot << 6 : slot << 12;
                const r = this._lbRun(u16, base, nRuns, lo);
                if (r < nRuns && u16[base + (r << 1)] <= lo) return ((c << 16) | lo) >>> 0;
                if (r > 0) {
                    const idx = base + ((r - 1) << 1);
                    return ((c << 16) | (u16[idx] + u16[idx + 1])) >>> 0;
                }
            }
        }
        c = this._prevChunk(c - 1);
        if (c < 0) return undefined;
        return ((c << 16) | this._chunkMax(this._mi(c))) >>> 0;
    }

    min() {
        // empty -> undefined; else the first live chunk and its min header
        if (this._size === 0) return undefined;
        const c = this._firstChunk();
        return ((c << 16) | this._chunkMin(this._mi(c))) >>> 0;
    }

    max() {
        // empty -> undefined; else the last live chunk and its max header
        if (this._size === 0) return undefined;
        const c = this._lastChunk();
        return ((c << 16) | this._chunkMax(this._mi(c))) >>> 0;
    }

    /**
     * Cold. Removes every key; pools, free-list order and the spare slab equal a fresh instance's. Paged: every
     * mapped page (found through _dir, never through row contents) is reset and the page pool refilled in the
     * constructor's order.
     */
    clear() {
        for (let c = this._nextChunk(0); c >= 0; c = this._nextChunk(c + 1)) {
            const m = this._mi(c);
            const k = this._kind[m];
            if (k === 1 || k === 5) this._sFree[this._sTop++] = this._slot[m];
            else if (k !== 6 && k !== 7) this._lFree[this._lTop++] = this._slot[m];
            this._kind[m] = 0;
            this._card[m] = 0;
            this._runs[m] = 0;
            this._cMin[m] = 0;
            this._cMax[m] = 0;
        }
        this._top.fill(0);
        if (this._pSh !== 0) {
            // also clears the stale rows of chunks that emptied earlier on a still-mapped page
            const dir = this._dir;
            for (let d = 0; d < dir.length; d++) if (dir[d] !== 0) this._pageZero(dir[d]);
            dir.fill(0);
            this._pLive.fill(0);
            const mP = this._maxP;
            for (let i = 0; i < mP; i++) this._pFree[i] = mP - i;
            this._pTop = mP;
        }
        this._size = 0;
        // same free-list order and spare slab as a fresh instance (deterministic slot reuse)
        const mS = this._maxS;
        const mL = this._maxL;
        for (let i = 0; i < mS; i++) this._sFree[i] = mS - 1 - i;
        this._sTop = mS;
        for (let i = 0; i < mL; i++) this._lFree[i] = mL - 1 - i;
        this._lTop = mL;
        this._conv = mL;
    }

    /** Cold-ish. SINGLE (`old`) + a new key `lo` -> a 2-key small array, else a 2-key full array; fails closed first. */
    _promoteSingle(m, old, lo) {
        const a = old < lo ? old : lo;
        const b = old < lo ? lo : old;
        if (this._sTop > 0) {
            const s = this._sFree[--this._sTop];
            this._sData[s << 6] = a;
            this._sData[(s << 6) + 1] = b;
            this._kind[m] = 1;
            this._slot[m] = s;
        } else if (this._lTop > 0) {
            const s = this._lFree[--this._lTop];
            this._lU16[s << 12] = a;
            this._lU16[(s << 12) + 1] = b;
            this._kind[m] = 2;
            this._slot[m] = s;
        } else {
            throwRPool('small/large', this._maxS + this._maxL);
        }
        this._card[m] = 1;
        this._cMin[m] = a;
        this._cMax[m] = b;
    }

    /** Cold-ish. Chunk of kind k (1, 2, 4 or 5) in `slot` left with the one key `keep` -> SINGLE; frees the slot. */
    _toSingle(m, k, slot, keep) {
        if (k === 1 || k === 5) this._sFree[this._sTop++] = slot;
        else this._lFree[this._lTop++] = slot;
        this._kind[m] = 7;
        this._slot[m] = keep;
        this._card[m] = 0;
        this._runs[m] = 0;
        this._cMin[m] = keep;
        this._cMax[m] = keep;
    }

    /** Cold-ish. Small array (64 keys in `slot`) + `lo` at rank j -> full array; fails closed first. */
    _promoteSmallToArray(m, slot, j, lo) {
        if (this._lTop === 0) throwRPool('large', this._maxL);
        const sData = this._sData;
        const base = slot << 6;
        const lSlot = this._lFree[--this._lTop];
        const lBase = lSlot << 12;
        const lU16 = this._lU16;
        for (let i = 0; i < j; i++) lU16[lBase + i] = sData[base + i];
        lU16[lBase + j] = lo;
        for (let i = j; i < 64; i++) lU16[lBase + i + 1] = sData[base + i];
        this._sFree[this._sTop++] = slot;
        this._kind[m] = 2;
        this._slot[m] = lSlot;
        this._card[m] = 64;
        if (j === 0) this._cMin[m] = lo;
        else if (j === 64) this._cMax[m] = lo;
    }

    /** Cold-ish. Full array of `len` keys minus the key at rank j -> a small array (caller checked the pool). */
    _demoteArrayToSmall(m, slot, j, len) {
        const lU16 = this._lU16;
        const base = slot << 12;
        const sSlot = this._sFree[--this._sTop];
        const sBase = sSlot << 6;
        const sData = this._sData;
        for (let i = 0; i < j; i++) sData[sBase + i] = lU16[base + i];
        for (let i = j + 1; i < len; i++) sData[sBase + i - 1] = lU16[base + i];
        this._lFree[this._lTop++] = slot;
        this._kind[m] = 1;
        this._slot[m] = sSlot;
        this._card[m] = len - 2;
        if (j === 0) this._cMin[m] = sData[sBase];
        else if (j === len - 1) this._cMax[m] = sData[sBase + len - 2];
    }

    _promoteArrayToBitmap(m, slot, lo) {
        const dst = this._conv;
        const u16 = this._lU16;
        const u32 = this._lU32;
        const sum = this._bSum;
        const srcBase = slot << 12;
        const dstBase = dst << 11;
        const sBase = dst * 66;
        u32.fill(0, dstBase, dstBase + 2048);
        sum.fill(0, sBase, sBase + 66);
        // sorted keys -> non-decreasing word index; word, L1 and L2 accumulate in registers
        let w = u16[srcBase] >>> 5;
        let acc = 0;
        let s1 = w >>> 5;
        let m1 = 0;
        let l2a = 0;
        let l2b = 0;
        for (let i = 0; i < 4096; i++) {
            const v = u16[srcBase + i];
            const vw = v >>> 5;
            if (vw !== w) {
                u32[dstBase + w] = acc;
                m1 |= 1 << (w & 31);
                acc = 0;
                w = vw;
                const vs1 = vw >>> 5;
                if (vs1 !== s1) {
                    sum[sBase + s1] = m1;
                    if (s1 < 32) l2a |= 1 << s1;
                    else l2b |= 1 << (s1 - 32);
                    m1 = 0;
                    s1 = vs1;
                }
            }
            acc |= 1 << (v & 31);
        }
        u32[dstBase + w] = acc;
        m1 |= 1 << (w & 31);
        sum[sBase + s1] = m1;
        if (s1 < 32) l2a |= 1 << s1;
        else l2b |= 1 << (s1 - 32);
        sum[sBase + 64] = l2a;
        sum[sBase + 65] = l2b;
        // the new key: same 0 -> nonzero summary transitions as _bmpSet
        const lw = lo >>> 5;
        const old = u32[dstBase + lw];
        u32[dstBase + lw] = old | (1 << (lo & 31));
        if (old === 0) {
            const ls1 = lw >>> 5;
            const s1Old = sum[sBase + ls1];
            sum[sBase + ls1] = s1Old | (1 << (lw & 31));
            if (s1Old === 0) {
                sum[sBase + 64 + (ls1 >>> 5)] |= 1 << (ls1 & 31);
            }
        }
        this._slot[m] = dst;
        this._conv = slot;
        this._kind[m] = 3;
        this._card[m] = 4096;
        if (lo < this._cMin[m]) this._cMin[m] = lo;
        else if (lo > this._cMax[m]) this._cMax[m] = lo;
    }

    _demoteBitmapToArray(m, slot) {
        const dst = this._conv;
        const u16 = this._lU16;
        const u32 = this._lU32;
        const sum = this._bSum;
        const dstBase = dst << 12;
        const srcBase = slot << 11;
        const sBase = slot * 66;
        let out = 0;
        for (let s1 = 0; s1 < 64; s1++) {
            for (let bits = sum[sBase + s1]; bits !== 0; bits &= bits - 1) {
                const b = 31 - Math.clz32(bits & -bits);
                const w = (s1 << 5) | b;
                const baseVal = w << 5;
                for (let d = u32[srcBase + w]; d !== 0; d &= d - 1) {
                    u16[dstBase + out++] = baseVal | (31 - Math.clz32(d & -d));
                }
            }
        }
        this._slot[m] = dst;
        this._conv = slot;
        this._kind[m] = 2;
        this._card[m] = out - 1; // spill paths demote with fewer than 4096 keys
    }

    _promoteRunToBitmap(m, slot) {
        const dst = this._conv;
        const u16 = this._lU16;
        const u32 = this._lU32;
        const sum = this._bSum;
        const srcBase = slot << 12;
        const dstBase = dst << 11;
        const sBase = dst * 66;
        const nRuns = this._runs[m] + 1;
        u32.fill(0, dstBase, dstBase + 2048);
        sum.fill(0, sBase, sBase + 66);
        // sorted disjoint runs -> non-decreasing touched words; L1 / L2 accumulate in registers
        let s1 = -1;
        let m1 = 0;
        let l2a = 0;
        let l2b = 0;
        for (let r = 0; r < nRuns; r++) {
            const start = u16[srcBase + (r << 1)];
            const end = start + u16[srcBase + (r << 1) + 1];
            const wStart = start >>> 5;
            const wEnd = end >>> 5;
            if (wStart === wEnd) {
                u32[dstBase + wStart] |= (-1 << (start & 31)) & (-1 >>> (31 - (end & 31)));
            } else {
                u32[dstBase + wStart] |= -1 << (start & 31);
                for (let w = wStart + 1; w < wEnd; w++) u32[dstBase + w] = 0xFFFFFFFF;
                u32[dstBase + wEnd] |= -1 >>> (31 - (end & 31));
            }
            for (let a = wStart; a <= wEnd;) {
                const as1 = a >>> 5;
                const lastW = (as1 << 5) | 31;
                const b = lastW < wEnd ? lastW : wEnd;
                if (as1 !== s1) {
                    if (s1 >= 0) {
                        sum[sBase + s1] = m1;
                        if (s1 < 32) l2a |= 1 << s1;
                        else l2b |= 1 << (s1 - 32);
                    }
                    s1 = as1;
                    m1 = 0;
                }
                m1 |= (-1 << (a & 31)) & (-1 >>> (31 - (b & 31)));
                a = b + 1;
            }
        }
        sum[sBase + s1] = m1;
        if (s1 < 32) l2a |= 1 << s1;
        else l2b |= 1 << (s1 - 32);
        sum[sBase + 64] = l2a;
        sum[sBase + 65] = l2b;
        this._slot[m] = dst;
        this._conv = slot;
        this._kind[m] = 3;
        this._runs[m] = 0;
    }

    runOptimize() {
        const u16 = this._lU16;
        const u32 = this._lU32;
        for (let c = this._nextChunk(0); c >= 0; c = this._nextChunk(c + 1)) {
            const m = this._mi(c);
            const k = this._kind[m];
            const slot = this._slot[m];
            const card = this._card[m] + 1;
            if (card === 65536) {
                if (k !== 6) this._toFull(m, k, slot);
            } else if (k === 2) {
                const srcBase = slot << 12;
                let runs = 1;
                for (let i = 1; i < card; i++) {
                    if (u16[srcBase + i] !== u16[srcBase + i - 1] + 1) runs++;
                }
                if ((runs << 1) < card && runs <= 2048) {
                    const toSmall = runs <= 32 && this._sTop > 0;
                    const dst = toSmall ? this._sFree[--this._sTop] : this._conv;
                    const out = toSmall ? this._sData : u16;
                    const dstBase = toSmall ? dst << 6 : dst << 12;
                    let rOut = 0;
                    let start = u16[srcBase];
                    let prev = start;
                    for (let i = 1; i < card; i++) {
                        const v = u16[srcBase + i];
                        if (v !== prev + 1) {
                            out[dstBase + (rOut << 1)] = start;
                            out[dstBase + (rOut << 1) + 1] = prev - start;
                            rOut++;
                            start = v;
                        }
                        prev = v;
                    }
                    out[dstBase + (rOut << 1)] = start;
                    out[dstBase + (rOut << 1) + 1] = prev - start;
                    rOut++;
                    this._slot[m] = dst;
                    if (toSmall) {
                        this._lFree[this._lTop++] = slot;
                        this._kind[m] = 5;
                    } else {
                        this._conv = slot;
                        this._kind[m] = 4;
                    }
                    this._runs[m] = rOut - 1;
                }
            } else if (k === 3) {
                const wBase = slot << 11;
                let runs = 0;
                let prev = 0;
                for (let w = 0; w < 2048; w++) {
                    const v = u32[wBase + w];
                    runs += popcnt32(v & ~((v << 1) | (prev >>> 31)));
                    prev = v;
                }
                if (runs > 0 && runs <= 2047) {
                    const toSmall = runs <= 32 && this._sTop > 0;
                    const dst = toSmall ? this._sFree[--this._sTop] : this._conv;
                    const out = toSmall ? this._sData : u16;
                    const b16 = toSmall ? dst << 6 : dst << 12;
                    let rOut = 0;
                    let inRun = false;
                    let rStart = 0;
                    for (let w = 0; w < 2048; w++) {
                        const v = u32[wBase + w];
                        if (v === 0) {
                            if (inRun) {
                                out[b16 + (rOut << 1)] = rStart;
                                out[b16 + (rOut << 1) + 1] = (w << 5) - 1 - rStart;
                                rOut++;
                                inRun = false;
                            }
                            continue;
                        }
                        if (v === 0xFFFFFFFF) {
                            if (!inRun) { rStart = w << 5; inRun = true; }
                            continue;
                        }
                        for (let b = 0; b < 32; b++) {
                            const set = ((v >>> b) & 1) !== 0;
                            if (set && !inRun) { rStart = (w << 5) | b; inRun = true; }
                            else if (!set && inRun) {
                                out[b16 + (rOut << 1)] = rStart;
                                out[b16 + (rOut << 1) + 1] = ((w << 5) | b) - 1 - rStart;
                                rOut++;
                                inRun = false;
                            }
                        }
                    }
                    if (inRun) {
                        out[b16 + (rOut << 1)] = rStart;
                        out[b16 + (rOut << 1) + 1] = 65535 - rStart;
                        rOut++;
                    }
                    this._slot[m] = dst;
                    if (toSmall) {
                        this._lFree[this._lTop++] = slot;
                        this._kind[m] = 5;
                    } else {
                        this._conv = slot;
                        this._kind[m] = 4;
                    }
                    this._runs[m] = rOut - 1;
                }
            } else if (k === 4) {
                // 2 B per key vs 4 B per run; runs <= 2048 keeps card < 4096 here
                const nRuns = this._runs[m] + 1;
                if (nRuns <= 32 && this._sTop > 0) {
                    this._demoteRunToSmall(m, slot, nRuns);
                } else if ((card << 1) < (nRuns << 2)) {
                    const srcBase = slot << 12;
                    const dst = this._conv;
                    const dstBase = dst << 12;
                    let out = 0;
                    for (let r = 0; r < nRuns; r++) {
                        const start = u16[srcBase + (r << 1)];
                        const end = start + u16[srcBase + (r << 1) + 1];
                        for (let v = start; v <= end; v++) u16[dstBase + out++] = v;
                    }
                    this._slot[m] = dst;
                    this._conv = slot;
                    this._kind[m] = 2;
                    this._runs[m] = 0;
                }
            }
        }
        return this;
    }

    /**
     * Run add for kind 4 (slab) and kind 5 (small slot); kind 6 already holds every key. A new key at rank 0
     * (nRuns) is the new min (max); the header write sits AFTER the branch chain so the small-run spill (which can
     * throw on an empty large pool) stays fail-closed, and the spill re-enters through the kind 4 call.
     */
    _addRun(m, slot, lo, k) {
        if (k === 6) return;
        const small = k === 5;
        const u16 = small ? this._sData : this._lU16;
        const base = small ? slot << 6 : slot << 12;
        const nRuns = this._runs[m] + 1;
        const r = this._lbRun(u16, base, nRuns, lo);
        if (r < nRuns && u16[base + (r << 1)] <= lo) return;
        const prevAdj = r > 0 && (u16[base + ((r - 1) << 1)] + u16[base + ((r - 1) << 1) + 1] + 1 === lo);
        const nextAdj = r < nRuns && (u16[base + (r << 1)] - 1 === lo);
        if (prevAdj && nextAdj) {
            const pIdx = base + ((r - 1) << 1);
            const nIdx = base + (r << 1);
            u16[pIdx + 1] = (u16[nIdx] + u16[nIdx + 1]) - u16[pIdx];
            u16.copyWithin(nIdx, nIdx + 2, base + (nRuns << 1));
            this._runs[m] = nRuns - 2;
            this._size++;
            if (++this._card[m] === 65535) this._toFull(m, k, slot);
            else if (!small && nRuns <= 33 && this._sTop > 0) this._demoteRunToSmall(m, slot, nRuns - 1);
        } else if (prevAdj) {
            u16[base + ((r - 1) << 1) + 1]++;
            this._size++;
            if (++this._card[m] === 65535) this._toFull(m, k, slot);
        } else if (nextAdj) {
            const nIdx = base + (r << 1);
            u16[nIdx]--;
            u16[nIdx + 1]++;
            this._size++;
            if (++this._card[m] === 65535) this._toFull(m, k, slot);
        } else if (nRuns < (small ? 32 : 2048)) {
            const ins = base + (r << 1);
            u16.copyWithin(ins + 2, ins, base + (nRuns << 1));
            u16[ins] = lo;
            u16[ins + 1] = 0;
            this._runs[m] = nRuns;
            this._card[m]++;
            this._size++;
        } else if (small) {
            this._promoteSmallRunToRun(m, slot, nRuns);
            this._addRun(m, this._slot[m], lo, 4);
            return;
        } else {
            this._promoteRunToBitmap(m, slot);
            const newSlot = this._slot[m];
            this._bmpSet(newSlot, lo);
            const newCard = this._card[m] + 1;
            this._card[m] = newCard;
            if (newCard < 4096) this._demoteBitmapToArray(m, newSlot);
            this._size++;
        }
        if (r === 0) this._cMin[m] = lo;
        else if (r === nRuns) this._cMax[m] = lo;
    }

    /**
     * Run delete for kind 4 (slab) and kind 5 (small slot); kind 6 goes to the cold _deleteFull. 2 keys -> 1
     * makes a SINGLE (so no run container ever empties here). Removing the min (max) re-derives it by rank;
     * a split / spill deletes an interior key, headers untouched.
     */
    _deleteRun(m, slot, lo, k) {
        if (k === 6) return this._deleteFull(m, lo);
        const small = k === 5;
        const u16 = small ? this._sData : this._lU16;
        const base = small ? slot << 6 : slot << 12;
        const nRuns = this._runs[m] + 1;
        const r = this._lbRun(u16, base, nRuns, lo);
        if (r >= nRuns) return false;
        const idx = base + (r << 1);
        const start = u16[idx];
        if (start > lo) return false;
        const len = u16[idx + 1];
        const end = start + len;
        if (this._card[m] === 1) {
            // 2 keys -> 1: one 2-key run (keep its other end) or two 1-key runs (keep the other one's start)
            this._toSingle(m, k, slot, nRuns === 1 ? (lo === start ? end : start) : u16[base + ((1 - r) << 1)]);
        } else if (len === 0) {
            u16.copyWithin(idx, idx + 2, base + (nRuns << 1));
            this._runs[m] = nRuns - 2;
            this._card[m]--;
            if (r === 0) this._cMin[m] = u16[base];
            else if (r === nRuns - 1) {
                const pIdx = base + ((nRuns - 2) << 1);
                this._cMax[m] = u16[pIdx] + u16[pIdx + 1];
            }
            if (!small && nRuns <= 33 && this._sTop > 0) this._demoteRunToSmall(m, slot, nRuns - 1);
        } else if (lo === start) {
            u16[idx] = start + 1;
            u16[idx + 1] = len - 1;
            this._card[m]--;
            if (r === 0) this._cMin[m] = start + 1;
        } else if (lo === end) {
            u16[idx + 1] = len - 1;
            this._card[m]--;
            if (r === nRuns - 1) this._cMax[m] = end - 1;
        } else if (nRuns < (small ? 32 : 2048)) {
            u16.copyWithin(idx + 4, idx + 2, base + (nRuns << 1));
            u16[idx + 1] = lo - 1 - start;
            u16[idx + 2] = lo + 1;
            u16[idx + 3] = end - (lo + 1);
            this._runs[m] = nRuns;
            this._card[m]--;
        } else if (small) {
            this._promoteSmallRunToRun(m, slot, nRuns);
            return this._deleteRun(m, this._slot[m], lo, 4);
        } else {
            this._promoteRunToBitmap(m, slot);
            const newSlot = this._slot[m];
            this._bmpClear(newSlot, lo);
            const newCard = this._card[m] - 1;
            this._card[m] = newCard;
            if (newCard <= 4095) this._demoteBitmapToArray(m, newSlot);
        }
        this._size--;
        return true;
    }

    /**
     * Cold. A container now holding all 65,536 keys -> FULL (kind 6); its slot returns to its pool. The headers
     * are already [0, 65535] (every caller keeps them exact), so none is written here.
     */
    _toFull(m, k, slot) {
        if (k === 5) this._sFree[this._sTop++] = slot;
        else this._lFree[this._lTop++] = slot;
        this._kind[m] = 6;
        this._slot[m] = 0;
        this._card[m] = 65535;
        this._runs[m] = 0;
    }

    /**
     * Cold. FULL minus `lo` -> 1 run (lo 0 / 65535) or 2 runs, in a small slot (kind 5), else a slab (kind 4).
     * Fails closed (throws before any write) with both pools empty.
     */
    _deleteFull(m, lo) {
        let u16;
        let s;
        let base;
        if (this._sTop > 0) {
            s = this._sFree[--this._sTop];
            u16 = this._sData;
            base = s << 6;
            this._kind[m] = 5;
        } else if (this._lTop > 0) {
            s = this._lFree[--this._lTop];
            u16 = this._lU16;
            base = s << 12;
            this._kind[m] = 4;
        } else {
            throwRPool('small/large', this._maxS + this._maxL);
        }
        if (lo === 0 || lo === 65535) {
            u16[base] = lo === 0 ? 1 : 0;
            u16[base + 1] = 65534;
            this._runs[m] = 0;
        } else {
            u16[base] = 0;
            u16[base + 1] = lo - 1;
            u16[base + 2] = lo + 1;
            u16[base + 3] = 65534 - lo;
            this._runs[m] = 1;
        }
        this._slot[m] = s;
        this._card[m] = 65534;
        if (lo === 0) this._cMin[m] = 1;
        else if (lo === 65535) this._cMax[m] = 65534;
        this._size--;
        return true;
    }

    /** Cold. A run slab of n <= 32 runs -> small runs (kind 5); the caller checked the small pool. */
    _demoteRunToSmall(m, slot, n) {
        const lU16 = this._lU16;
        const base = slot << 12;
        const sSlot = this._sFree[--this._sTop];
        const sBase = sSlot << 6;
        const sData = this._sData;
        const n2 = n << 1;
        for (let i = 0; i < n2; i++) sData[sBase + i] = lU16[base + i];
        this._lFree[this._lTop++] = slot;
        this._kind[m] = 5;
        this._slot[m] = sSlot;
    }

    /** Cold. Small runs (n = 32 runs in `slot`) -> a run slab (kind 4) before a 33rd run; fails closed first. */
    _promoteSmallRunToRun(m, slot, n) {
        if (this._lTop === 0) throwRPool('large', this._maxL);
        const sData = this._sData;
        const base = slot << 6;
        const lSlot = this._lFree[--this._lTop];
        const lBase = lSlot << 12;
        const lU16 = this._lU16;
        const n2 = n << 1;
        for (let i = 0; i < n2; i++) lU16[lBase + i] = sData[base + i];
        this._sFree[this._sTop++] = slot;
        this._kind[m] = 4;
        this._slot[m] = lSlot;
    }

    /**
     * Cold, O(chunks both sets hold). True iff the two sets share at least one key (stops at the first
     * shared key). `other` must be a RoaringSet of the same universe (either layout, a direct x paged pair
     * included; any pageBits): otherwise TypeError (not a RoaringSet) or RangeError (universe mismatch).
     * Neither set changes. Allocates nothing.
     * @param {RoaringSet} other
     * @returns {boolean}
     */
    intersects(other) {
        if (!isRoaringSet(other) || other._u !== this._u) throwROther(other, this._u);
        const tA = this._top;
        const tB = other._top;
        for (let m3 = tA[2114] & tB[2114]; m3 !== 0; m3 &= m3 - 1) {
            const i2 = 31 - Math.clz32(m3 & -m3);
            for (let m2 = tA[2112 + i2] & tB[2112 + i2]; m2 !== 0; m2 &= m2 - 1) {
                const i1 = (i2 << 5) | (31 - Math.clz32(m2 & -m2));
                for (let m1 = tA[2048 + i1] & tB[2048 + i1]; m1 !== 0; m1 &= m1 - 1) {
                    const w = (i1 << 5) | (31 - Math.clz32(m1 & -m1));
                    for (let m0 = tA[w] & tB[w]; m0 !== 0; m0 &= m0 - 1) {
                        const c = (w << 5) | (31 - Math.clz32(m0 & -m0));
                        if (this._chunkIntersectionSize(c, other, true) > 0) return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Cold, O(chunks both sets hold). |this AND other|. Same `other` contract as intersects(). Neither set
     * changes. Allocates nothing for counts < 2^30; a count >= 2^31 on Node (>= 2^30 pointer-compressed)
     * returns boxed (expected, not measured).
     * @param {RoaringSet} other
     * @returns {number}
     */
    intersectionSize(other) {
        if (!isRoaringSet(other) || other._u !== this._u) throwROther(other, this._u);
        const tA = this._top;
        const tB = other._top;
        let total = 0;
        for (let m3 = tA[2114] & tB[2114]; m3 !== 0; m3 &= m3 - 1) {
            const i2 = 31 - Math.clz32(m3 & -m3);
            for (let m2 = tA[2112 + i2] & tB[2112 + i2]; m2 !== 0; m2 &= m2 - 1) {
                const i1 = (i2 << 5) | (31 - Math.clz32(m2 & -m2));
                for (let m1 = tA[2048 + i1] & tB[2048 + i1]; m1 !== 0; m1 &= m1 - 1) {
                    const w = (i1 << 5) | (31 - Math.clz32(m1 & -m1));
                    for (let m0 = tA[w] & tB[w]; m0 !== 0; m0 &= m0 - 1) {
                        const c = (w << 5) | (31 - Math.clz32(m0 & -m0));
                        total += this._chunkIntersectionSize(c, other, false);
                    }
                }
            }
        }
        return total;
    }

    /**
     * Cold, O(chunks both sets hold). |this OR other| = size + other.size - intersectionSize(other) (one
     * intersection pass). Same `other` contract and allocation note as intersectionSize().
     * @param {RoaringSet} other
     * @returns {number}
     */
    unionSize(other) {
        if (!isRoaringSet(other) || other._u !== this._u) throwROther(other, this._u);
        return this._size + other._size - this.intersectionSize(other);
    }

    /**
     * Cold, O(chunks both sets hold). |this AND NOT other| = size - intersectionSize(other) (one
     * intersection pass). Same `other` contract and allocation note as intersectionSize().
     * @param {RoaringSet} other
     * @returns {number}
     */
    differenceSize(other) {
        if (!isRoaringSet(other) || other._u !== this._u) throwROther(other, this._u);
        return this._size - this.intersectionSize(other);
    }

    /**
     * Cold. |chunk c of this AND chunk c of other| as a Smi (<= 65,536); with stopAtOne, 1 at the first
     * shared key. Each set reads chunk c through ITS OWN row (`this._mi(c)` / `other._mi(c)`) and its own
     * arrays, so a direct x paged pair and differing pageBits are exact (C-6). Kind 0 on either side -> 0.
     */
    _chunkIntersectionSize(c, other, stopAtOne) {
        const mA0 = this._mi(c);
        const mB0 = other._mi(c);
        const kA = this._kind[mA0];
        const kB = other._kind[mB0];
        if (kA === 0 || kB === 0) return 0;
        if (kA === 6) return stopAtOne ? 1 : other._card[mB0] + 1;
        if (kB === 6) return stopAtOne ? 1 : this._card[mA0] + 1;
        if (kA === 7) return other._chunkHasLo(mB0, kB, this._slot[mA0]);
        if (kB === 7) return this._chunkHasLo(mA0, kA, other._slot[mB0]);
        const pA = kA <= 2 ? 0 : (kA === 3 ? 2 : 1);
        const pB = kB <= 2 ? 0 : (kB === 3 ? 2 : 1);
        let setA = this;
        let setB = other;
        let leftK = kA;
        let rightK = kB;
        let mA = mA0;
        let mB = mB0;
        if (pA > pB) {
            setA = other;
            setB = this;
            leftK = kB;
            rightK = kA;
            mA = mB0;
            mB = mA0;
        }
        const sA = setA._slot[mA];
        const sB = setB._slot[mB];
        if (leftK <= 2) {
            const lenA = setA._card[mA] + 1;
            const baseA = sA << (leftK === 1 ? 6 : 12);
            const arrA = leftK === 1 ? setA._sData : setA._lU16;
            if (rightK <= 2) {
                const lenB = setB._card[mB] + 1;
                const baseB = sB << (rightK === 1 ? 6 : 12);
                const arrB = rightK === 1 ? setB._sData : setB._lU16;
                return this._intersectArrayArray(baseA, lenA, baseB, lenB, stopAtOne, arrA, arrB);
            }
            if (rightK === 3) {
                return this._intersectArrayBitmap(baseA, lenA, sB, stopAtOne, arrA, setB._lU32);
            }
            const runsB = setB._runs[mB] + 1;
            const baseB = sB << (rightK === 5 ? 6 : 12);
            const arrB = rightK === 5 ? setB._sData : setB._lU16;
            return this._intersectArrayRun(baseA, lenA, baseB, runsB, stopAtOne, arrA, arrB);
        }
        if (leftK !== 3) {
            const runsA = setA._runs[mA] + 1;
            const baseA = sA << (leftK === 5 ? 6 : 12);
            const arrA = leftK === 5 ? setA._sData : setA._lU16;
            if (rightK !== 3) {
                const runsB = setB._runs[mB] + 1;
                const baseB = sB << (rightK === 5 ? 6 : 12);
                const arrB = rightK === 5 ? setB._sData : setB._lU16;
                return this._intersectRunRun(baseA, runsA, baseB, runsB, stopAtOne, arrA, arrB);
            }
            return this._intersectRunBitmap(baseA, runsA, sB, stopAtOne, arrA, setB._lU32, setB._bSum);
        }
        return this._intersectBitmapBitmap(sA, sB, stopAtOne, setA._lU32, setB._lU32, setA._bSum, setB._bSum);
    }

    /** Cold. has() of low bits `lo` in row m of kind k (1-5 or 7; FULL is handled by the caller), as 1 / 0. */
    _chunkHasLo(m, k, lo) {
        const slot = this._slot[m];
        if (k === 7) return slot === lo ? 1 : 0;
        if (k === 1) {
            const len = this._card[m] + 1;
            const base = slot << 6;
            const j = this._lb16(this._sData, base, len, lo);
            return j < len && this._sData[base + j] === lo ? 1 : 0;
        }
        if (k === 2) {
            const len = this._card[m] + 1;
            const base = slot << 12;
            const j = this._lb16(this._lU16, base, len, lo);
            return j < len && this._lU16[base + j] === lo ? 1 : 0;
        }
        if (k === 3) return (this._lU32[(slot << 11) + (lo >>> 5)] & (1 << (lo & 31))) !== 0 ? 1 : 0;
        const nRuns = this._runs[m] + 1;
        const u16 = k === 5 ? this._sData : this._lU16;
        const base = k === 5 ? slot << 6 : slot << 12;
        const r = this._lbRun(u16, base, nRuns, lo);
        return r < nRuns && u16[base + (r << 1)] <= lo ? 1 : 0;
    }

    /** Cold. Sorted array x sorted array (uA / uB, lenA / lenB keys at baseA / baseB): galloping merge. */
    _intersectArrayArray(baseA, lenA, baseB, lenB, stopAtOne, uA, uB) {
        if (lenA > lenB) return this._intersectArrayArray(baseB, lenB, baseA, lenA, stopAtOne, uB, uA);
        let count = 0;
        let idxB = 0;
        for (let i = 0; i < lenA; i++) {
            const target = uA[baseA + i];
            if (idxB >= lenB) break;
            if (uB[baseB + idxB] === target) {
                if (stopAtOne) return 1;
                count++;
                idxB++;
                continue;
            }
            if (uB[baseB + idxB] > target) continue;
            let step = 1;
            let next = idxB + step;
            while (next < lenB && uB[baseB + next] < target) {
                idxB = next;
                step <<= 1;
                next = idxB + step;
            }
            let l = idxB;
            let h = next < lenB ? next : lenB - 1;
            while (l <= h) {
                const m = (l + h) >>> 1;
                const val = uB[baseB + m];
                if (val === target) {
                    if (stopAtOne) return 1;
                    count++;
                    l = m + 1;
                    break;
                }
                if (val < target) l = m + 1;
                else h = m - 1;
            }
            idxB = l;
        }
        return count;
    }

    /** Cold. Sorted array x bitmap (slotB of uB = _lU32): one bit probe per array key. */
    _intersectArrayBitmap(baseA, lenA, slotB, stopAtOne, uA, uB) {
        const bBase = slotB << 11;
        let count = 0;
        for (let i = 0; i < lenA; i++) {
            const lo = uA[baseA + i];
            if ((uB[bBase + (lo >>> 5)] & (1 << (lo & 31))) !== 0) {
                if (stopAtOne) return 1;
                count++;
            }
        }
        return count;
    }

    /** Cold. Sorted array x runs ((start, len - 1) pairs at baseB of uB): galloping run cursor. */
    _intersectArrayRun(baseA, lenA, baseB, runsB, stopAtOne, uA, uB) {
        let count = 0;
        let rIdx = 0;
        for (let i = 0; i < lenA; i++) {
            const target = uA[baseA + i];
            if (rIdx >= runsB) break;
            let idx = baseB + (rIdx << 1);
            let start = uB[idx];
            let end = start + uB[idx + 1];
            if (target > end) {
                let step = 1;
                let next = rIdx + step;
                while (next < runsB) {
                    const nIdx = baseB + (next << 1);
                    if (uB[nIdx] + uB[nIdx + 1] < target) {
                        rIdx = next;
                        step <<= 1;
                        next = rIdx + step;
                    } else {
                        break;
                    }
                }
                let l = rIdx + 1;
                let h = next < runsB ? next : runsB - 1;
                while (l < h) {
                    const m = (l + h) >>> 1;
                    const mIdx = baseB + (m << 1);
                    if (uB[mIdx] + uB[mIdx + 1] < target) l = m + 1;
                    else h = m;
                }
                rIdx = l;
                if (rIdx >= runsB) break;
                idx = baseB + (rIdx << 1);
                start = uB[idx];
                end = start + uB[idx + 1];
                if (target > end) break;
            }
            if (target >= start) {
                if (stopAtOne) return 1;
                count++;
            }
        }
        return count;
    }

    /** Cold. Runs x runs: a two-cursor overlap sweep. */
    _intersectRunRun(baseA, runsA, baseB, runsB, stopAtOne, uA, uB) {
        let iA = 0;
        let iB = 0;
        let count = 0;
        while (iA < runsA && iB < runsB) {
            const startA = uA[baseA + (iA << 1)];
            const endA = startA + uA[baseA + (iA << 1) + 1];
            const startB = uB[baseB + (iB << 1)];
            const endB = startB + uB[baseB + (iB << 1) + 1];
            if (endA < startB) {
                iA++;
            } else if (endB < startA) {
                iB++;
            } else {
                const lo = startA > startB ? startA : startB;
                const hi = endA < endB ? endA : endB;
                if (hi >= lo) {
                    if (stopAtOne) return 1;
                    count += hi - lo + 1;
                }
                if (endA < endB) iA++;
                else if (endB < endA) iB++;
                else { iA++; iB++; }
            }
        }
        return count;
    }

    /** Cold. Runs x bitmap (slotB, its 66-word summary sumB): masked edge words, summary-driven middle words. */
    _intersectRunBitmap(baseA, runsA, slotB, stopAtOne, uA, uB, sumB) {
        const bBase = slotB << 11;
        const sBase = slotB * 66;
        let count = 0;
        for (let r = 0; r < runsA; r++) {
            const start = uA[baseA + (r << 1)];
            const end = start + uA[baseA + (r << 1) + 1];
            const wStart = start >>> 5;
            const wEnd = end >>> 5;
            if (wStart === wEnd) {
                const w = uB[bBase + wStart] & (-1 << (start & 31)) & (-1 >>> (31 - (end & 31)));
                if (w !== 0) {
                    if (stopAtOne) return 1;
                    count += popcnt32(w);
                }
            } else {
                let w = uB[bBase + wStart] & (-1 << (start & 31));
                if (w !== 0) {
                    if (stopAtOne) return 1;
                    count += popcnt32(w);
                }
                const firstFull = wStart + 1;
                const lastFull = wEnd - 1;
                if (firstFull <= lastFull) {
                    const s1Start = firstFull >>> 5;
                    const s1End = lastFull >>> 5;
                    for (let s1 = s1Start; s1 <= s1End; s1++) {
                        const bLo = s1 === s1Start ? (firstFull & 31) : 0;
                        const bHi = s1 === s1End ? (lastFull & 31) : 31;
                        const mask = (-1 << bLo) & (-1 >>> (31 - bHi));
                        for (let m = sumB[sBase + s1] & mask; m !== 0; m &= m - 1) {
                            const bit = 31 - Math.clz32(m & -m);
                            const fw = uB[bBase + (s1 << 5) + bit];
                            if (stopAtOne) return 1;
                            count += popcnt32(fw);
                        }
                    }
                }
                w = uB[bBase + wEnd] & (-1 >>> (31 - (end & 31)));
                if (w !== 0) {
                    if (stopAtOne) return 1;
                    count += popcnt32(w);
                }
            }
        }
        return count;
    }

    /** Cold. Bitmap x bitmap: AND of the two summaries picks the words both sides hold. */
    _intersectBitmapBitmap(slotA, slotB, stopAtOne, uA, uB, sumA, sumB) {
        const bA = slotA << 11;
        const bB = slotB << 11;
        const sA = slotA * 66;
        const sB = slotB * 66;
        let count = 0;
        for (let s1 = 0; s1 < 64; s1++) {
            for (let m = sumA[sA + s1] & sumB[sB + s1]; m !== 0; m &= m - 1) {
                const i = (s1 << 5) | (31 - Math.clz32(m & -m));
                const w = uA[bA + i] & uB[bB + i];
                if (w !== 0) {
                    if (stopAtOne) return 1;
                    count += popcnt32(w);
                }
            }
        }
        return count;
    }

    /**
     * Adds every key in [lo, hi), 0 <= lo <= hi <= U (integers); lo === hi adds nothing. The set equals that of
     * `add(x)` for each x in [lo, hi); each touched chunk ends in the container kind `runOptimize()` would choose
     * for the final key set at the post-call pool state (fully covered chunks become FULL, 0 B). Precounts the
     * slots and pages it needs and throws RangeError before any write if the pools cannot hold them (set
     * unchanged); a bad bound throws RangeError with nothing touched. Allocates nothing for bounds < 2^30; a
     * bound >= 2^31 boxes at a non-inlined call site (as has). Returns this.
     * @param {number} lo first key
     * @param {number} hi one past the last key
     * @returns {this}
     */
    addRange(lo, hi) {
        if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isInteger(lo) || !Number.isInteger(hi) ||
            !(lo >= 0) || !(lo <= hi) || !(hi <= this._u)) throwRRange(lo, hi, this._u);
        if (lo === hi) return this;
        const cF = lo >>> 16;
        const a = lo & 65535;
        const cL = (hi - 1) >>> 16;
        const b = (hi - 1) & 65535;
        this._rangePre(cF, a, cL, b);
        // write pass (S-5), in the precount's order: every pop / page below was proven by _rangePre, so no throw
        const pF = a !== 0 || (cF === cL && b !== 65535);
        const pL = cL !== cF && b !== 65535;
        const e = pL ? cL - 1 : cL;
        for (let c = pF ? cF + 1 : cF; c <= e; c++) this._rangeFull(c);
        if (pF) this._rangePart(cF, a, cF === cL ? b : 65535);
        if (pL) this._rangePart(cL, 0, b);
        return this;
    }

    /**
     * Cold, read-only (S-4): throws the RangeError a range write over chunks cF..cL (local span [a, 65535] in
     * cF, [0, b] in cL; [a, b] when cF === cL) would hit, before any write. Absent metadata pages first; then
     * the container pools in the write pass's order (covered chunks ascending, then cF, then cL). sA / lA
     * mirror _sTop / _lTop; _conv is build scratch and is never counted. A covered chunk (local span all of
     * [0, 65535]) becomes FULL and returns its old slot. A partial chunk whose _rangeKind changes slot class
     * (small {1, 5}, large {2, 3, 4}, none {0, 6, 7}) takes one -- small: free by _rangeKind's choice; large:
     * may throw -- and then returns its old slot.
     */
    _rangePre(cF, a, cL, b) {
        const need = this._pagesNeeded(cF, cL);
        if (need > this._pTop) {
            throw new RangeError('[lite-loglogn] RoaringSet addRange metadata page pool exhausted (needs ' + need +
                (need === 1 ? ' new page, ' : ' new pages, ') + this._pTop + ' free of maxPages ' + this._maxP +
                '); increase maxPages at construction');
        }
        const kind = this._kind;
        let sA = this._sTop;
        let lA = this._lTop;
        const pF = a !== 0 || (cF === cL && b !== 65535);
        const pL = cL !== cF && b !== 65535;
        const e = pL ? cL - 1 : cL;
        for (let c = pF ? cF + 1 : cF; c <= e; c++) {
            const k = kind[this._mi(c)];
            if (k === 1 || k === 5) sA++;
            else if (k === 2 || k === 3 || k === 4) lA++;
        }
        for (let end = 0; end < 2; end++) {
            if (end === 0 ? !pF : !pL) continue;
            const m = this._mi(end === 0 ? cF : cL);
            const k0 = kind[m];
            const k1 = this._rangeKind(m, k0, end === 0 ? a : 0, end === 0 && cF !== cL ? 65535 : b, sA);
            const c0 = k0 === 1 || k0 === 5 ? 1 : k0 === 2 || k0 === 3 || k0 === 4 ? 2 : 0;
            const c1 = k1 === 1 || k1 === 5 ? 1 : k1 === 2 || k1 === 3 || k1 === 4 ? 2 : 0;
            if (c1 === c0) continue;
            if (c1 === 1) {
                sA--;
            } else if (c1 === 2) {
                if (lA === 0) {
                    throwRPool(sA === 0 ? 'small/large' : 'large', sA === 0 ? this._maxS + this._maxL : this._maxL);
                }
                lA--;
            }
            if (c0 === 1) sA++;
            else if (c0 === 2) lA++;
        }
    }

    /**
     * Cold, pure (S-3). The kind (Smi 1..7) partial chunk row m (old kind k0) ends in after a range write of
     * the local span [a, b], sA = the small slots free at that point of the precount: the kind the add loop
     * over [a, b] ends in (K'), then runOptimize's rule on K'. s = a small slot is free OR the chunk already
     * holds one. n = 65536 or k0 FULL -> FULL; n = 1 -> SINGLE.
     */
    _rangeKind(m, k0, a, b, sA) {
        if (k0 === 6) return 6;
        const n = this._rangeScanN(m, k0, a, b);
        if (n === 65536) return 6;
        if (n === 1) return 7;
        const s = sA !== 0 || k0 === 1 || k0 === 5;
        let k = 3;
        if (k0 === 0 || k0 === 7 || k0 === 1) {
            k = n <= 64 ? (k0 === 1 || s ? 1 : 2) : n <= 4096 ? 2 : 3;
        } else if (k0 === 2) {
            k = n <= 4096 ? 2 : 3;
        } else if (k0 === 5) {
            // a 33rd run (the range's first key isolated, no merge after) spills the small runs to a slab
            k = this._runs[m] === 31 && this._rangeNewRun(m, k0, a) === 1 &&
                this._rangeScanR(m, k0, a, b) === 33 ? 4 : 5;
        } else if (k0 === 4) {
            // a 2,049th run makes a bitmap, back to an array at most 4,096 keys
            if (this._runs[m] === 2047 && this._rangeNewRun(m, k0, a) === 1) {
                k = n <= 4096 ? 2 : 3;
            } else {
                k = 4;
            }
        }
        if (k === 2 || k === 3) {
            const r = this._rangeScanR(m, k0, a, b);
            if (k === 2 ? (r << 1) < n : r <= 2047) return r <= 32 && s ? 5 : 4;
            return k;
        }
        if (k === 4) {
            const r = this._rangeScanR(m, k0, a, b);
            if (r <= 32 && s) return 5;
            return n < (r << 1) ? 2 : 4;
        }
        return k;
    }

    /** Cold, read-only. |E u [a, b]| (Smi <= 65,536) for row m of kind k (E = its keys; 0 <= a <= b <= 65535). */
    _rangeScanN(m, k, a, b) {
        const w = b - a + 1;
        if (k === 0) return w;
        if (k === 6) return 65536;
        const slot = this._slot[m];
        if (k === 7) return slot >= a && slot <= b ? w : w + 1;
        const n0 = this._card[m] + 1;
        if (k === 1 || k === 2) {
            const u16 = k === 1 ? this._sData : this._lU16;
            const base = k === 1 ? slot << 6 : slot << 12;
            return n0 + w - (this._lb16(u16, base, n0, b + 1) - this._lb16(u16, base, n0, a));
        }
        let inI = 0;
        if (k === 3) {
            const u32 = this._lU32;
            const wBase = slot << 11;
            const wa = a >>> 5;
            const wb = b >>> 5;
            for (let i = wa; i <= wb; i++) {
                let mk = -1;
                if (i === wa) mk &= -1 << (a & 31);
                if (i === wb) mk &= -1 >>> (31 - (b & 31));
                inI += popcnt32(u32[wBase + i] & mk);
            }
            return n0 + w - inI;
        }
        const u16 = k === 5 ? this._sData : this._lU16;
        const base = k === 5 ? slot << 6 : slot << 12;
        const nRuns = this._runs[m] + 1;
        for (let r = this._lbRun(u16, base, nRuns, a); r < nRuns; r++) {
            const s0 = u16[base + (r << 1)];
            if (s0 > b) break;
            const e0 = s0 + u16[base + (r << 1) + 1];
            inI += (e0 < b ? e0 : b) - (s0 > a ? s0 : a) + 1;
        }
        return n0 + w - inI;
    }

    /**
     * Cold, read-only. Runs of E u [a, b] (Smi <= 32,768) for row m of kind k: every run of E meeting
     * [a - 1, b + 1] merges with the span into one run; a bitmap counts run starts with the span OR-ed in.
     */
    _rangeScanR(m, k, a, b) {
        if (k === 0 || k === 6) return 1;
        const slot = this._slot[m];
        const a1 = a === 0 ? 0 : a - 1;
        const b1 = b === 65535 ? 65535 : b + 1;
        if (k === 7) return slot >= a1 && slot <= b1 ? 1 : 2;
        if (k === 3) {
            const u32 = this._lU32;
            const wBase = slot << 11;
            const wa = a >>> 5;
            const wb = b >>> 5;
            let runs = 0;
            let prev = 0;
            for (let i = 0; i < 2048; i++) {
                let v = u32[wBase + i];
                if (i >= wa && i <= wb) {
                    let mk = -1;
                    if (i === wa) mk &= -1 << (a & 31);
                    if (i === wb) mk &= -1 >>> (31 - (b & 31));
                    v |= mk;
                }
                runs += popcnt32(v & ~((v << 1) | (prev >>> 31)));
                prev = v;
            }
            return runs;
        }
        if (k === 1 || k === 2) {
            const u16 = k === 1 ? this._sData : this._lU16;
            const base = k === 1 ? slot << 6 : slot << 12;
            const n0 = this._card[m] + 1;
            let r0 = 1;
            for (let i = 1; i < n0; i++) if (u16[base + i] !== u16[base + i - 1] + 1) r0++;
            // t = runs of E inside [a1, b1] = the runs of E meeting it
            const j0 = this._lb16(u16, base, n0, a1);
            const j1 = this._lb16(u16, base, n0, b1 + 1);
            let t = j1 > j0 ? 1 : 0;
            for (let i = j0 + 1; i < j1; i++) if (u16[base + i] !== u16[base + i - 1] + 1) t++;
            return r0 - t + 1;
        }
        const u16 = k === 5 ? this._sData : this._lU16;
        const base = k === 5 ? slot << 6 : slot << 12;
        const nRuns = this._runs[m] + 1;
        let t = 0;
        for (let r = this._lbRun(u16, base, nRuns, a1); r < nRuns && u16[base + (r << 1)] <= b1; r++) t++;
        return nRuns - t + 1;
    }

    /** Cold, read-only. 1 iff the span's first key a starts an isolated run in row m of kind k (a, a +- 1 not in E). */
    _rangeNewRun(m, k, a) {
        if (k === 0) return 1;
        if (k === 6) return 0;
        if (this._chunkHasLo(m, k, a) !== 0) return 0;
        if (a !== 0 && this._chunkHasLo(m, k, a - 1) !== 0) return 0;
        return a === 65535 || this._chunkHasLo(m, k, a + 1) === 0 ? 1 : 0;
    }

    /** Cold. Guarded small-slot pop for the range write pass (pool RangeError; unreachable after _rangePre). */
    _rangeTakeS() {
        if (this._sTop === 0) throwRPool('small', this._maxS);
        return this._sFree[--this._sTop];
    }

    /** Cold. Guarded large-slot pop for the range write pass (pool RangeError; unreachable after _rangePre). */
    _rangeTakeL() {
        if (this._lTop === 0) {
            const both = this._sTop === 0;
            throwRPool(both ? 'small/large' : 'large', both ? this._maxS + this._maxL : this._maxL);
        }
        return this._lFree[--this._lTop];
    }

    /**
     * Cold, write pass (S-5). Chunk c, covered by the range (local span all of [0, 65535]) -> FULL: an empty chunk
     * maps its page (paged; proven free by _rangePre) and sets its top bit; any other kind returns its old slot to
     * its pool (small {1, 5}, large {2, 3, 4}). Headers [0, 65535]; size += 65536 - n0. FULL stays as it is.
     */
    _rangeFull(c) {
        let m = this._mi(c);
        const k0 = this._kind[m];
        if (k0 === 6) return;
        if (k0 === 0) {
            m = this._pSh === 0 ? m : this._pageAcquire(c);
            this._topSet(c);
        } else if (k0 === 1 || k0 === 5) {
            this._sFree[this._sTop++] = this._slot[m];
        } else if (k0 !== 7) {
            this._lFree[this._lTop++] = this._slot[m];
        }
        this._size += k0 === 0 ? 65536 : 65535 - this._card[m];
        this._kind[m] = 6;
        this._slot[m] = 0;
        this._card[m] = 65535;
        this._runs[m] = 0;
        this._cMin[m] = 0;
        this._cMax[m] = 65535;
    }

    /**
     * Cold, write pass (S-5). Partial chunk c gets the local span [a, b] (0 <= a <= b <= 65535, not all of it):
     * it ends in the kind _rangeKind predicts at this pool state (the precount's). E u [a, b] is built aside in
     * _conv (sorted keys, (start, len - 1) run pairs, or a bitmap + its 66-word summary), then placed: a small
     * kind copies into the chunk's own small slot or a popped one; a large kind takes _conv, and _conv becomes the
     * chunk's old large slot or a popped one. The old slot of another class returns to its pool. Every pop goes
     * through _rangeTakeS / _rangeTakeL (unreachable throws after _rangePre).
     */
    _rangePart(c, a, b) {
        let m = this._mi(c);
        const k0 = this._kind[m];
        const k1 = this._rangeKind(m, k0, a, b, this._sTop);
        if (k1 === 6) {
            this._rangeFull(c);
            return;
        }
        const n = this._rangeScanN(m, k0, a, b);
        const slot = this._slot[m];
        const n0 = k0 === 0 ? 0 : this._card[m] + 1;
        const mn = k0 === 0 || a < this._cMin[m] ? a : this._cMin[m];
        const mx = k0 === 0 || b > this._cMax[m] ? b : this._cMax[m];
        if (k0 === 0) {
            m = this._pSh === 0 ? m : this._pageAcquire(c);
            this._topSet(c);
        }
        let runs = 0;
        if (k1 === 7) {
            // n = 1: an empty chunk + one key, or a SINGLE re-adding its own key
            this._slot[m] = a;
        } else {
            const mode = k1 === 3 ? 2 : k1 === 4 || k1 === 5 ? 1 : 0;
            const o = this._rangeWalk(m, k0, a, b, mode);
            if (mode === 1) runs = (o >>> 1) - 1;
            const c0 = k0 === 1 || k0 === 5 ? 1 : k0 === 2 || k0 === 3 || k0 === 4 ? 2 : 0;
            if (k1 === 1 || k1 === 5) {
                const s = c0 === 1 ? slot : this._rangeTakeS();
                const sData = this._sData;
                const lU16 = this._lU16;
                const d = this._conv << 12;
                const sb = s << 6;
                for (let i = 0; i < o; i++) sData[sb + i] = lU16[d + i];
                if (c0 === 2) this._lFree[this._lTop++] = slot;
                this._slot[m] = s;
            } else {
                const s = this._conv;
                this._conv = c0 === 2 ? slot : this._rangeTakeL();
                if (c0 === 1) this._sFree[this._sTop++] = slot;
                this._slot[m] = s;
            }
        }
        this._kind[m] = k1;
        this._card[m] = n - 1;
        this._runs[m] = runs;
        this._cMin[m] = mn;
        this._cMax[m] = mx;
        this._size += n - n0;
    }

    /**
     * Cold. Writes E u [a, b] (E = row m's keys, kind k0) into _conv in ascending order: mode 0 sorted keys (u16),
     * mode 1 (start, len - 1) run pairs (u16), mode 2 a bitmap (2,048 words) + its 66-word summary. Returns the
     * u16 count written (mode 0: n, mode 1: 2r; mode 2: 0). The caller picked a mode whose result fits the slab.
     */
    _rangeWalk(m, k0, a, b, mode) {
        const conv = this._conv;
        const d = mode === 2 ? conv << 11 : conv << 12;
        const slot = this._slot[m];
        let o = 0;
        let done = false;
        if (mode === 2) {
            if (k0 === 3) this._lU32.copyWithin(d, slot << 11, (slot << 11) + 2048);
            else this._lU32.fill(0, d, d + 2048);
        }
        if (k0 === 7) {
            if (slot >= a) {
                o = this._rangePush(mode, d, o, a, b);
                done = true;
            }
            o = this._rangePush(mode, d, o, slot, slot);
        } else if (k0 === 1 || k0 === 2) {
            const u16 = k0 === 1 ? this._sData : this._lU16;
            const base = k0 === 1 ? slot << 6 : slot << 12;
            const n0 = this._card[m] + 1;
            for (let i = 0; i < n0; i++) {
                const x = u16[base + i];
                if (!done && x >= a) {
                    o = this._rangePush(mode, d, o, a, b);
                    done = true;
                }
                o = this._rangePush(mode, d, o, x, x);
            }
        } else if (k0 === 4 || k0 === 5) {
            const u16 = k0 === 5 ? this._sData : this._lU16;
            const base = k0 === 5 ? slot << 6 : slot << 12;
            const nRuns = this._runs[m] + 1;
            for (let r = 0; r < nRuns; r++) {
                const s0 = u16[base + (r << 1)];
                if (!done && s0 >= a) {
                    o = this._rangePush(mode, d, o, a, b);
                    done = true;
                }
                o = this._rangePush(mode, d, o, s0, s0 + u16[base + (r << 1) + 1]);
            }
        } else if (k0 === 3 && mode !== 2) {
            const u32 = this._lU32;
            const wb = slot << 11;
            for (let w = 0; w < 2048; w++) {
                const v = u32[wb + w] | 0;
                if (v === 0) continue;
                const x0 = w << 5;
                if (!done && x0 + 31 >= a) {
                    // the span goes before the first E key >= a: flush this word's keys below a first
                    for (let t = v; t !== 0; t &= t - 1) {
                        const x = x0 | (31 - Math.clz32(t & -t));
                        if (x >= a) break;
                        o = this._rangePush(mode, d, o, x, x);
                    }
                    o = this._rangePush(mode, d, o, a, b);
                    done = true;
                }
                if (v === -1) {
                    o = this._rangePush(mode, d, o, x0, x0 + 31);
                } else {
                    for (let t = v; t !== 0; t &= t - 1) o = this._rangePush(mode, d, o, x0 | (31 - Math.clz32(t & -t)), x0 | (31 - Math.clz32(t & -t)));
                }
            }
        }
        if (!done) o = this._rangePush(mode, d, o, a, b);
        if (mode === 2) {
            // the summary is a function of the words: bit w of L1 iff word w != 0, bit s of L2 iff L1 word s != 0
            const u32 = this._lU32;
            const sum = this._bSum;
            const sBase = conv * 66;
            let l2a = 0;
            let l2b = 0;
            for (let s1 = 0; s1 < 64; s1++) {
                let m1 = 0;
                const w0 = d + (s1 << 5);
                for (let j = 0; j < 32; j++) if (u32[w0 + j] !== 0) m1 |= 1 << j;
                sum[sBase + s1] = m1;
                if (m1 !== 0) {
                    if (s1 < 32) l2a |= 1 << s1;
                    else l2b |= 1 << (s1 - 32);
                }
            }
            sum[sBase + 64] = l2a;
            sum[sBase + 65] = l2b;
        }
        return o;
    }

    /**
     * Cold. Appends keys [s, e] (s >= every earlier s) to the _conv build at d, o u16 written so far; returns the
     * new count. Mode 0: keys not yet written; mode 1: merges into the last run when s <= its end + 1; mode 2:
     * sets the bits (order-free; returns 0).
     */
    _rangePush(mode, d, o, s, e) {
        if (mode === 2) {
            const u32 = this._lU32;
            const ws = s >>> 5;
            const we = e >>> 5;
            if (ws === we) {
                u32[d + ws] |= (-1 << (s & 31)) & (-1 >>> (31 - (e & 31)));
            } else {
                u32[d + ws] |= -1 << (s & 31);
                for (let w = ws + 1; w < we; w++) u32[d + w] = 0xFFFFFFFF;
                u32[d + we] |= -1 >>> (31 - (e & 31));
            }
            return 0;
        }
        const u16 = this._lU16;
        if (mode === 1) {
            if (o !== 0) {
                const ls = u16[d + o - 2];
                const le = ls + u16[d + o - 1];
                if (s <= le + 1) {
                    if (e > le) u16[d + o - 1] = e - ls;
                    return o;
                }
            }
            u16[d + o] = s;
            u16[d + o + 1] = e - s;
            return o + 2;
        }
        let x = o !== 0 && u16[d + o - 1] >= s ? u16[d + o - 1] + 1 : s;
        for (; x <= e; x++) u16[d + o++] = x;
        return o;
    }

    /** Cold, allocating. A fresh snapshot ({ universe, size, paged, chunks }) independent of later mutation. */
    dump() {
        const names = ['empty', 'small', 'array', 'bitmap', 'runs', 'smallRuns', 'full', 'single'];
        const chunks = [];
        for (let c = this._nextChunk(0); c >= 0; c = this._nextChunk(c + 1)) {
            const m = this._mi(c);
            const k = this._kind[m];
            chunks.push({
                chunk: c,
                kind: names[k],
                count: this._card[m] + 1,
                runs: k === 4 || k === 5 ? this._runs[m] + 1 : 0
            });
        }
        return { universe: this._u, size: this._size, paged: this.paged, chunks };
    }
}
