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
 * strict O(log log U) members (x-fast / y-fast / vEB) follow. The witness's
 * PRIMARY axis is the universe BIT-WIDTH w, never a copied log2(n).
 *
 * v0.1.0 was the SCAFFOLD release (the `VERSION` const only). Members are
 * appended below append-only: this header, the roster comment and the `VERSION`
 * const are the only prior lines that ever change. StratifiedBitset (0.2.0):
 * array-embedded O(log_w U) successor / predecessor over a hierarchical bit
 * tree, O(U/w) space. XFastTrie (0.3.0): O(log log U) successor / predecessor
 * over pointer-free bucketized-cuckoo LevelTables, one per prefix length, plus a
 * sorted leaf thread; updates are honestly O(w); O(n*w) space, preallocated at a
 * FIXED capacity. Still planned: YFastTrie (the O(n)-space fix over x-fast
 * representatives, expected / amortized) and vEBTree (a flattened van Emde Boas
 * keeping worst-case O(log log U) and 0 B/op).
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
 * expected O(1) per level, with an in-place reseed on a stall), worst-case unless
 * labelled expected / amortized -- and allocates ZERO bytes after construction.
 *
 * The SPACE price is a co-headline, stated on every member with the same
 * prominence as the time bound (vEB O(U), x-fast O(n*w), y-fast O(n),
 * StratifiedBitset O(U/w)) -- this family's defining honesty hook. XFastTrie
 * allocates its O(C*w) worst case up front, sized by its capacity C, not by the
 * keys present: byteLength = 13 TS + 12 (C+1) + 16 (w+1) + 16 (see its class
 * comment). The witness harness (never imported here) REPORTS fits on both the
 * log2(w) and the w axis and gates on neither: the w axis fit StratifiedBitset
 * better in the 2026-10-22 run (R^2 0.7293 vs 0.6589), as its O(log_32 U) label
 * predicts.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.3.0';

// --- members land here, append-only, one tree-shakeable class each -----------
// StratifiedBitset (v0.2.0)         -- array-embedded O(log_w U) successor / predecessor
// XFastTrie        (v0.3.0)         -- O(log log U) query over pointer-free LevelTables
// YFastTrie        (v0.4.0)         -- the O(n)-space fix over x-fast representatives
// vEBTree          (v0.5.0)         -- flattened van Emde Boas, worst-case O(log log U)

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
     */
    constructor(universe, capacity) {
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

    /** Bytes of every typed array the instance owns (13 TS + 12 (C+1) + 16 (w+1) + 16). */
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
     * Cold. Removes every key and restores the default seeds (the constructed
     * state; the `_q` counters are kept). Revives a poisoned instance (a fresh
     * `_q`, counters zero).
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

    /** Cold. Default seeds per level, empty thread, free list 1..C, size 0. */
    _init() {
        const lv = this._lv;
        const nx = this._next;
        const pv = this._prev;
        const w = this._w;
        const c = this._c;
        for (let L = 1; L <= w; L++) {
            const j = L << 2;
            const s1 = fmix32(Math.imul(L, 0x9e3779b1) ^ ((lv[j + 1] + 1) << 3));
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

    /** Cold. Poisons the instance (A3): `_q = null`, loud Error; clear() revives it. */
    _poison(why) {
        this._q = null;
        throw new Error('[lite-loglogn] XFastTrie invariant: rollback failed (' + why +
            '); the instance is POISONED -- every hot method throws until clear()');
    }
}
