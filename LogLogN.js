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
 * v0.1.0 was the SCAFFOLD release (the `VERSION` const only). StratifiedBitset is
 * the first member and ships in 0.2.0, appended below append-only: this header,
 * the roster comment and the `VERSION` const are the only prior lines that ever
 * change. StratifiedBitset: array-embedded O(log_w U) successor / predecessor over
 * a hierarchical bit tree, O(U/w) space. Still planned: XFastTrie (O(log log U)
 * query over pointer-free open-addressing LevelTables, O(n*w) space), YFastTrie
 * (the O(n)-space fix over x-fast representatives, expected / amortized), and
 * vEBTree (a flattened van Emde Boas keeping worst-case O(log log U) and 0 B/op).
 * Members are independent (no shared mutable module state), so a bundler that
 * imports one drops the others (`sideEffects: false`).
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
            v = b[o[L] + i];
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
        let v = b[o[L]];
        if (v === 0) return undefined;
        let i = 31 - Math.clz32(v);
        while (L > 0) {
            L--;
            v = b[o[L] + i];
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
