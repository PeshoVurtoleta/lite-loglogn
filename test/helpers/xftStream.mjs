/**
 * @zakkster/lite-loglogn -- XFastTrie pre-engine vectors (B0b, E1). Test helper,
 * not a test file (the npm glob `test/*.test.js` never matches it). Zero deps;
 * imports only the shipped StratifiedBitset (cross-check oracle of the cut).
 *
 * Contents (every function is deterministic and depends on its arguments only):
 *   mulberry32, FNV-1a (fnvByte / fnvWord / hex32) -- own copies;
 *   SortedOracle(U, C) -- the TRUE definition: a sorted JS array, binary search,
 *     strict successor (> x) / predecessor (< x), fixed capacity C (add of a NEW
 *     key at size === C throws RangeError), the StratifiedBitset bad-key rule
 *     (has / delete -> false, successor / predecessor -> undefined, add ->
 *     RangeError; -0 aliases 0);
 *   genStream(U, C, nOps, seed) -- fill to C, 50 full-throws, then churn
 *     (MIX / REFILL / DRAIN / CLUSTER phases); keys present / boundary (0 or -0,
 *     1, U-1, U-2, U-3, 2^31-1, 2^31, 2^31+1, 2^30) / clustered x ^ (r & 255) /
 *     uniform, plus the 13 bad-key tokens of badKeys(U) on ~3% of key ops;
 *   the count model of PLAN-xfasttrie SPEC (3) as a pure function
 *     countModel(row, w, cp, cs, T) -> [touches, tableWrites, threadWrites];
 *   the SPEC (1) hash: fmix32 (signed int32 result, lite-o1 parity), level
 *     geometry (capL, B, S, base, mask) and the default seed schedule
 *     s1 = fmix32(imul(L, 0x9e3779b1) ^ S_L), s2 = fmix32(s1 ^ 0x85ebca6b);
 *   collide(U, C, count) -- keys whose level-w prefixes share h1 AND h2 under
 *     the default seeds (a forced cuckoo stall: count > 8 slots);
 *   buildVectors() / crossCheckSb() and the `--cut` CLI:
 *     node test/helpers/xftStream.mjs --cut > test/vectors/xft-b0.json
 *   The cut aborts (exit 1, nothing on stdout) on any SortedOracle vs
 *   StratifiedBitset per-op mismatch for U <= 2^28.
 *
 * Hash folds (B1 / B4 replay with the SAME folds):
 *   resultsHash -- per op: undefined = byte 1, false = 2, true = 3, a number =
 *     byte 4 + its float64 bits (lo word, hi word; so undefined is never 2^32-1
 *     and -0 is not 0), the instance itself = 5, any other value = 6 + typeof,
 *     a thrown RangeError = 7, any other throw = 8 + its name; after the last op
 *     byte 9 + the final size. checkpoints.resultsHash[k] is the running value
 *     after op (k+1) * EVERY, before the final-size fold.
 *   sortedHash -- walk min() -> successor() (public API only): fnvWord per key,
 *     then byte 9 + the key count. A walk longer than capacity + 1 keys yields
 *     'overrun' (a broken thread never hangs the replay).
 *   touchSeqHash (power-of-two w only, where T = log2(w) is path-independent) --
 *     per op fnvWord(touches), fnvWord(tableWrites), fnvWord(threadWrites) of
 *     countModel, the row taken from the oracle state BEFORE the op. 1 touch =
 *     1 `_slot` / `_put` = 4 `_lv` reads; table = `_occ` / `_tk` / `_tmin` /
 *     `_tmax` writes; thread = `_key` / `_next` / `_prev` writes. Kicks and
 *     reseeds are outside the model (exact rows need delta kicks = 0).
 */

import { pathToFileURL } from 'node:url';
import { StratifiedBitset } from '../../LogLogN.js';

export const OP_ADD = 0;
export const OP_DELETE = 1;
export const OP_HAS = 2;
export const OP_SUCC = 3;
export const OP_PRED = 4;
export const OP_MIN = 5;
export const OP_MAX = 6;

export const XFT_STREAM_VERSION = 1;
export const N_OPS = 20000;
export const EVERY = 1000;
export const FULL_THROWS = 50;
export const BASE_SEED = 0x58f7a1c3;
export const SB_CROSS_MAX_U = 268435456; // 2^28
export const SEED_RULE = '(BASE_SEED + imul(index + 1, 0x9e3779b9)) >>> 0';

/** The 15 (U, C) streams of PLAN-xfasttrie E2, in cut order. */
export const STREAMS = [
    [2, 2], [3, 3], [5, 5], [16, 16], [17, 8], [256, 64], [1000, 200],
    [65536, 4096], [65537, 1024], [1048576, 4096], [16777216, 4096],
    [268435456, 4096], [4294967296, 4096], [4294967295, 1024], [2147483649, 512],
];

/** Seed of stream index i. */
export function streamSeed(i) {
    return (BASE_SEED + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
}

/** w = ceil(log2 U) = 32 - clz32(U - 1), U in [2, 2^32]. */
export function bitsOf(U) {
    return 32 - Math.clz32(U - 1);
}

/** True when w is a power of two (T = log2(w) exactly). */
export function isPow2(w) {
    return w > 0 && (w & (w - 1)) === 0;
}

// --- PRNG + FNV-1a ------------------------------------------------------------

/** Seeded PRNG in [0, 1). Own copy (mulberry32). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Folds one byte (0..255). */
export function fnvByte(h, byte) {
    return Math.imul(h ^ (byte & 255), FNV_PRIME) >>> 0;
}

/** Folds a 32-bit word as 4 bytes, little-endian. */
export function fnvWord(h, w) {
    h = Math.imul(h ^ (w & 255), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((w >>> 8) & 255), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((w >>> 16) & 255), FNV_PRIME) >>> 0;
    return Math.imul(h ^ ((w >>> 24) & 255), FNV_PRIME) >>> 0;
}

/** Folds a string's UTF-16 code units (each as 2 bytes). */
export function fnvString(h, s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h = fnvByte(h, c);
        h = fnvByte(h, c >>> 8);
    }
    return h;
}

/** 8 lowercase hex digits. */
export function hex32(h) {
    return (h >>> 0).toString(16).padStart(8, '0');
}

// --- keys -----------------------------------------------------------------------

/** The 13 bad-key tokens (never a key: has / delete false, succ / pred undefined, add throws). */
export function badKeys(U) {
    return [-1, U, U + 0.5, NaN, '3', 4294967296, 1.5, Infinity, -Infinity,
        null, undefined, 3n, 2 ** 53];
}

/** Boundary keys inside [0, U), ascending, distinct. */
export function boundaryKeys(U) {
    const raw = [0, 1, U - 3, U - 2, U - 1, 1073741824, 2147483647, 2147483648, 2147483649];
    const out = [];
    for (const k of raw) if (k >= 0 && k < U && out.indexOf(k) < 0) out.push(k);
    return out.sort((a, b) => a - b);
}

// --- SortedOracle -----------------------------------------------------------------

/** The true definition: a sorted array of distinct keys, capacity C. */
export class SortedOracle {
    constructor(universe, capacity) {
        this._u = universe;
        this._c = capacity;
        this._a = [];
    }
    get size() { return this._a.length; }
    get universe() { return this._u; }
    get capacity() { return this._c; }
    _ok(x) {
        return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < this._u;
    }
    /** First index i with a[i] >= x. */
    _lb(x) {
        const a = this._a;
        let lo = 0;
        let hi = a.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (a[mid] < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    /** First index i with a[i] > x. */
    _ub(x) {
        const a = this._a;
        let lo = 0;
        let hi = a.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (a[mid] <= x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    has(x) {
        if (!this._ok(x)) return false;
        return this._a[this._lb(x)] === x;
    }
    add(x) {
        if (!this._ok(x)) throw new RangeError('[oracle] bad key');
        const v = x + 0;
        const i = this._lb(v);
        if (this._a[i] === v) return this;
        if (this._a.length === this._c) throw new RangeError('[oracle] full');
        this._a.splice(i, 0, v);
        return this;
    }
    delete(x) {
        if (!this._ok(x)) return false;
        const i = this._lb(x);
        if (this._a[i] !== x) return false;
        this._a.splice(i, 1);
        return true;
    }
    successor(x) {
        if (!this._ok(x)) return undefined;
        return this._a[this._ub(x)];
    }
    predecessor(x) {
        if (!this._ok(x)) return undefined;
        const i = this._lb(x) - 1;
        return i >= 0 ? this._a[i] : undefined;
    }
    min() { return this._a[0]; }
    max() { return this._a.length > 0 ? this._a[this._a.length - 1] : undefined; }
    clear() { this._a.length = 0; return this; }
    keys() { return this._a.slice(); }
}

/** StratifiedBitset (the shipped file) behind a capacity-C door, same API as SortedOracle. */
export class SbCapped {
    constructor(universe, capacity) {
        this._sb = new StratifiedBitset(universe);
        this._c = capacity;
    }
    get size() { return this._sb.size; }
    get universe() { return this._sb.universe; }
    get capacity() { return this._c; }
    has(x) { return this._sb.has(x); }
    add(x) {
        if (this._sb.size === this._c && !this._sb.has(x)) throw new RangeError('[sb-capped] full');
        this._sb.add(x);
        return this;
    }
    delete(x) { return this._sb.delete(x); }
    successor(x) { return this._sb.successor(x); }
    predecessor(x) { return this._sb.predecessor(x); }
    min() { return this._sb.min(); }
    max() { return this._sb.max(); }
}

// --- stream -----------------------------------------------------------------------

/**
 * @returns {{ op: Uint8Array, key: Float64Array, bad: Int8Array }}
 * bad[i] >= 0 -> the key is badKeys(U)[bad[i]], else key[i] (may be -0).
 * Depends only on (U, C, nOps, seed), never on a build's answers.
 */
export function genStream(U, C, nOps, seed) {
    const rnd = mulberry32(seed);
    const op = new Uint8Array(nOps);
    const key = new Float64Array(nOps);
    const bad = new Int8Array(nOps).fill(-1);
    const nBad = badKeys(U).length;
    const bnd = boundaryKeys(U);
    const live = [];
    const pos = new Map();
    let n = 0;

    const int = (k) => Math.floor(rnd() * k);
    const uni = () => int(U);
    const present = () => (live.length > 0 ? live[int(live.length)] : uni());
    const boundary = () => {
        const x = bnd[int(bnd.length)];
        return x === 0 && rnd() < 0.5 ? -0 : x;
    };
    const clustered = () => {
        const base = live.length > 0 && rnd() < 0.7 ? live[int(live.length)] : uni();
        const x = (base ^ int(256)) >>> 0;
        return x < U ? x : base;
    };
    const pick = () => {
        const r = rnd();
        if (r < 0.25) return present();
        if (r < 0.37) return boundary();
        if (r < 0.70) return clustered();
        return uni();
    };
    const absent = () => {
        for (let t = 0; t < 64; t++) {
            const x = uni();
            if (!pos.has(x)) return x;
        }
        let x = uni();
        while (pos.has(x)) x = x + 1 === U ? 0 : x + 1;
        return x;
    };
    const emit = (o, x, allowBad) => {
        if (n >= nOps) return;
        if (allowBad && o <= OP_PRED && rnd() < 0.03) bad[n] = int(nBad);
        else key[n] = x;
        op[n] = o;
        if (bad[n] < 0) {
            const v = x + 0;
            if (o === OP_ADD && !pos.has(v) && live.length < C) {
                pos.set(v, live.length);
                live.push(v);
            } else if (o === OP_DELETE && pos.has(v)) {
                const j = pos.get(v);
                const last = live.pop();
                if (last !== v) {
                    live[j] = last;
                    pos.set(last, j);
                }
                pos.delete(v);
            }
        }
        n++;
    };
    const query = (pk) => {
        const r = rnd();
        if (r < 0.25) emit(OP_HAS, pk(), true);
        else if (r < 0.55) emit(OP_SUCC, pk(), true);
        else if (r < 0.85) emit(OP_PRED, pk(), true);
        else if (r < 0.93) emit(OP_MIN, 0, false);
        else emit(OP_MAX, 0, false);
    };
    const fullThrow = () => emit(OP_ADD, live.length < U ? absent() : present(), false);
    const mixedOp = (pk) => {
        const r = rnd();
        if (r < 0.30) emit(OP_ADD, pk(), true);
        else if (r < 0.50) emit(OP_DELETE, live.length > 0 && rnd() < 0.7 ? present() : pk(), true);
        else query(pk);
    };

    // fill to C (adds of fresh keys, a query every ~5 ops)
    while (live.length < C && n < nOps) {
        if (rnd() < 0.8) emit(OP_ADD, rnd() < 0.5 ? absent() : pick(), true);
        else query(pick);
    }
    // 50 full-throws (an add of an absent key at size === C; at C === U every key is
    // present, so the add returns the instance), each followed by a query
    for (let k = 0; k < FULL_THROWS && n < nOps; k++) {
        fullThrow();
        query(pick);
    }
    // churn
    while (n < nOps) {
        const phase = int(4);
        const len = 256 + int(1792);
        if (phase === 0) {
            for (let k = 0; k < len && n < nOps; k++) mixedOp(pick);
        } else if (phase === 1) {
            while (live.length < C && n < nOps) {
                if (rnd() < 0.85) emit(OP_ADD, rnd() < 0.5 ? absent() : clustered(), true);
                else query(pick);
            }
            const m = 1 + int(8);
            for (let k = 0; k < m && n < nOps; k++) {
                fullThrow();
                query(pick);
            }
        } else if (phase === 2) {
            const keep = int(3);
            while (live.length > keep && n < nOps) emit(OP_DELETE, present(), rnd() < 0.5);
            const q = 64 + int(448);
            for (let k = 0; k < q && n < nOps; k++) query(rnd() < 0.5 ? boundary : pick);
        } else {
            const anchor = present();
            const near = () => {
                const x = (anchor ^ int(256)) >>> 0;
                return x < U ? x : anchor;
            };
            for (let k = 0; k < len && n < nOps; k++) mixedOp(near);
        }
    }
    return { op, key, bad };
}

// --- count model (SPEC (3)) ------------------------------------------------------

export const ROW_BAD = 0;
export const ROW_HAS = 1;
export const ROW_Q_PRESENT = 2;
export const ROW_Q_ABSENT = 3;
export const ROW_MINMAX = 4;
export const ROW_ADD_PRESENT = 5;
export const ROW_ADD_FULL = 6;
export const ROW_ADD_NEW = 7;
export const ROW_DEL_ABSENT = 8;
export const ROW_DEL_PRESENT = 9;
export const ROW_NAMES = ['bad', 'has', 'qPresent', 'qAbsent', 'minMax', 'addPresent',
    'addFull', 'addNew', 'delAbsent', 'delPresent'];

/** Common prefix length of two distinct w-bit keys; 0 when the neighbour is absent. */
export function commonPrefix(w, x, k) {
    return k === undefined ? 0 : w - 32 + Math.clz32(x ^ k);
}

/** Binary-search steps over w candidates when that count is path-independent (w = 2^j). */
export function steps(w) {
    return isPow2(w) ? 31 - Math.clz32(w) : null;
}

/**
 * SPEC (3) table as a pure function. cp / cs = common prefix with the predecessor /
 * successor (x excluded), l = max, m = min. Returns [touches, tableWrites, threadWrites].
 */
export function countModel(row, w, cp, cs, T) {
    const l = cp > cs ? cp : cs;
    const m = cp < cs ? cp : cs;
    switch (row) {
        case ROW_BAD: return [0, 0, 0];
        case ROW_HAS: return [1, 0, 0];
        case ROW_Q_PRESENT: return [1, 0, 0];
        case ROW_Q_ABSENT: return [1 + T, 0, 0];
        case ROW_MINMAX: return [0, 0, 0];
        case ROW_ADD_PRESENT: return [1, 0, 0];
        case ROW_ADD_FULL: return [1, 0, 0];
        case ROW_ADD_NEW: return [1 + T + w - m, 4 * (w - l) + (l - m), 5];
        case ROW_DEL_ABSENT: return [1, 0, 0];
        case ROW_DEL_PRESENT: return [w - m, w - m, 3];
        default: throw new RangeError('countModel: unknown row ' + String(row));
    }
}

/**
 * Classifies op o on key x against the oracle state BEFORE the op. Returns
 * [row, cp, cs] (cp / cs only meaningful for addNew / delPresent).
 */
export function classify(oracle, w, o, x) {
    if (o === OP_MIN || o === OP_MAX) return [ROW_MINMAX, 0, 0];
    if (!oracle._ok(x)) return [ROW_BAD, 0, 0];
    const v = x + 0;
    const has = oracle.has(v);
    if (o === OP_HAS) return [ROW_HAS, 0, 0];
    if (o === OP_SUCC || o === OP_PRED) return [has ? ROW_Q_PRESENT : ROW_Q_ABSENT, 0, 0];
    if (o === OP_ADD) {
        if (has) return [ROW_ADD_PRESENT, 0, 0];
        if (oracle.size === oracle.capacity) return [ROW_ADD_FULL, 0, 0];
        return [ROW_ADD_NEW, commonPrefix(w, v, oracle.predecessor(v)),
            commonPrefix(w, v, oracle.successor(v))];
    }
    if (!has) return [ROW_DEL_ABSENT, 0, 0];
    return [ROW_DEL_PRESENT, commonPrefix(w, v, oracle.predecessor(v)),
        commonPrefix(w, v, oracle.successor(v))];
}

// --- SPEC (1) hash + level geometry -------------------------------------------------

/** MurmurHash3 fmix32, signed int32 result (lite-o1 _cuFmix32 parity). */
export function fmix32(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, 0x85ebca6b);
    h = h ^ (h >>> 13);
    h = Math.imul(h, 0xc2b2ae35);
    h = h ^ (h >>> 16);
    return h | 0;
}

/** Default seeds of level L with S_L slots: [s1, s2]. */
export function levelSeeds(L, S) {
    const s1 = fmix32(Math.imul(L, 0x9e3779b1) ^ S);
    return [s1, fmix32(s1 ^ 0x85ebca6b)];
}

/**
 * Reseed try a (1..32) from the seed s1 the level held when the rebuild began
 * (lite-o1 CuckooMap parity: every try derives from that base, s2 re-derived).
 */
export function reseedSeeds(s1, a) {
    const t = fmix32((s1 + Math.imul(a, 0x9e3779b1)) | 0);
    return [t, fmix32(t ^ 0x85ebca6b)];
}

/**
 * Level geometry for L = 1..w: capL = min(C, 2^L); B = pow2 >= ceil(capL * 10 / 72);
 * S = 8B; base = running sum of S; mask = B - 1; default seeds. Index 0 unused.
 */
export function levelGeometry(U, C) {
    const w = bitsOf(U);
    const lv = [null];
    let base = 0;
    for (let L = 1; L <= w; L++) {
        const capL = Math.min(C, 2 ** L);
        const need = Math.ceil(capL * 10 / 72);
        let B = 1;
        while (B < need) B *= 2;
        const S = 8 * B;
        const [s1, s2] = levelSeeds(L, S);
        lv.push({ L, capL, B, S, base, mask: B - 1, s1, s2 });
        base += S;
    }
    return { w, levels: lv, TS: base };
}

/** [h1, h2] of key x at level L of geometry g. p = (x|0) >>> (w - L), shift 0..w-1. */
export function levelHash(g, L, x) {
    const d = g.levels[L];
    const p = (x | 0) >>> (g.w - L);
    return [fmix32(p ^ d.s1) & d.mask, fmix32(p ^ d.s2) & d.mask];
}

/**
 * The first `count` keys (ascending scan of [0, U)) whose level-w prefixes share h1
 * AND h2 under the default seeds of (U, C). count > 8 forces a cuckoo stall. null if
 * the scan (capped at 2^24 keys) finds no such group.
 */
export function collide(U, C, count = 9) {
    const g = levelGeometry(U, C);
    const B = g.levels[g.w].B;
    if (B * B > 4194304) throw new RangeError('collide: level-w table too large (B = ' + B + ')');
    const groups = new Map();
    const lim = Math.min(U, 16777216);
    for (let x = 0; x < lim; x++) {
        const [h1, h2] = levelHash(g, g.w, x);
        const k = h1 * B + h2;
        let arr = groups.get(k);
        if (arr === undefined) groups.set(k, arr = []);
        arr.push(x);
        if (arr.length === count) return arr;
    }
    return null;
}

// --- replay -------------------------------------------------------------------------

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

/** Folds one op result (see the header for the tags). */
export function foldResult(h, ret, inst) {
    if (ret === undefined) return fnvByte(h, 1);
    if (ret === false) return fnvByte(h, 2);
    if (ret === true) return fnvByte(h, 3);
    if (typeof ret === 'number') {
        F64[0] = ret;
        h = fnvByte(h, 4);
        h = fnvWord(h, U32[0]);
        return fnvWord(h, U32[1]);
    }
    if (ret === inst) return fnvByte(h, 5);
    return fnvString(fnvByte(h, 6), typeof ret);
}

/** Folds a thrown value. */
export function foldThrow(h, e) {
    if (e instanceof RangeError) return fnvByte(h, 7);
    return fnvString(fnvByte(h, 8), e !== null && typeof e === 'object' ? String(e.name) : typeof e);
}

/** Runs one op; throws what the instance throws. */
export function applyOp(inst, o, x) {
    if (o === OP_ADD) return inst.add(x);
    if (o === OP_DELETE) return inst.delete(x);
    if (o === OP_HAS) return inst.has(x);
    if (o === OP_SUCC) return inst.successor(x);
    if (o === OP_PRED) return inst.predecessor(x);
    if (o === OP_MIN) return inst.min();
    return inst.max();
}

/** Sorted-walk hash via min() -> successor(); 'overrun' past capacity + 1 keys. */
export function sortedHash(inst) {
    let h = FNV_OFFSET;
    let n = 0;
    const lim = inst.capacity + 1;
    for (let k = inst.min(); k !== undefined; k = inst.successor(k)) {
        if (!(++n <= lim)) return 'overrun';
        h = fnvWord(h, k);
    }
    return hex32(fnvWord(fnvByte(h, 9), n));
}

/** The key of op i of stream st. */
export function keyAt(st, BAD, i) {
    return st.bad[i] >= 0 ? BAD[st.bad[i]] : st.key[i];
}

/**
 * Replays stream st on inst (any class with the XFastTrie API + `capacity`).
 * @returns {{ resultsHash: string, checkpoints: { size: number[], resultsHash: string[],
 *   sortedHash: string[] }, finalSize: number, sortedHash: string }}
 */
export function replay(inst, U, st) {
    const BAD = badKeys(U);
    const nOps = st.op.length;
    const cps = { size: [], resultsHash: [], sortedHash: [] };
    let rh = FNV_OFFSET;
    for (let i = 0; i < nOps; i++) {
        let ret;
        try {
            ret = applyOp(inst, st.op[i], keyAt(st, BAD, i));
            rh = foldResult(rh, ret, inst);
        } catch (e) {
            rh = foldThrow(rh, e);
        }
        if ((i + 1) % EVERY === 0) {
            cps.size.push(inst.size);
            cps.resultsHash.push(hex32(rh));
            cps.sortedHash.push(sortedHash(inst));
        }
    }
    const size = inst.size;
    return {
        resultsHash: hex32(fnvWord(fnvByte(rh, 9), size)),
        checkpoints: cps,
        finalSize: size,
        sortedHash: sortedHash(inst),
    };
}

/** Comparable tag of one op outcome (lockstep diagnostics). */
function outcome(inst, o, x) {
    try {
        const r = applyOp(inst, o, x);
        if (r === inst) return 'this';
        if (typeof r === 'number') return Object.is(r, -0) ? 'n:-0' : 'n:' + r;
        return typeof r === 'boolean' ? 'b:' + r : typeof r;
    } catch (e) {
        return e instanceof RangeError ? 'throw:RangeError' : 'throw:' + String(e && e.name);
    }
}

/**
 * Replays st on a and b in lockstep; returns null when every op (and every EVERY-op
 * sorted walk) agrees, else a description of the first mismatch.
 */
export function lockstep(a, b, U, st) {
    const BAD = badKeys(U);
    for (let i = 0; i < st.op.length; i++) {
        const x = keyAt(st, BAD, i);
        const ra = outcome(a, st.op[i], x);
        const rb = outcome(b, st.op[i], x);
        if (ra !== rb) {
            return 'op ' + i + ' (' + st.op[i] + ', ' + (typeof x === 'bigint' ? x + 'n' : String(x)) +
                '): ' + ra + ' vs ' + rb;
        }
        if ((i + 1) % EVERY === 0 && (a.size !== b.size || sortedHash(a) !== sortedHash(b))) {
            return 'checkpoint after op ' + i + ': size ' + a.size + ' vs ' + b.size +
                ', sortedHash ' + sortedHash(a) + ' vs ' + sortedHash(b);
        }
    }
    return null;
}

// --- the cut ------------------------------------------------------------------------

/** One stream row: oracle hashes + row counts (+ model sums for power-of-two w). */
export function cutStream(i) {
    const [U, C] = STREAMS[i];
    const seed = streamSeed(i);
    const w = bitsOf(U);
    const st = genStream(U, C, N_OPS, seed);
    const BAD = badKeys(U);
    // model pass: classify each op on the oracle state BEFORE applying it
    const mo = new SortedOracle(U, C);
    const T = steps(w);
    const rows = new Array(ROW_NAMES.length).fill(0);
    let th = FNV_OFFSET;
    let sT = 0;
    let sTab = 0;
    let sThr = 0;
    for (let k = 0; k < N_OPS; k++) {
        const o = st.op[k];
        const x = keyAt(st, BAD, k);
        const [row, cp, cs] = classify(mo, w, o, x);
        rows[row]++;
        if (T !== null) {
            const [t, tw, hw] = countModel(row, w, cp, cs, T);
            th = fnvWord(fnvWord(fnvWord(th, t), tw), hw);
            sT += t;
            sTab += tw;
            sThr += hw;
        }
        try { applyOp(mo, o, x); } catch (e) { /* the oracle's own reject */ }
    }
    const r = replay(new SortedOracle(U, C), U, st);
    const out = { U, C, w, seed, resultsHash: r.resultsHash, finalSize: r.finalSize,
        sortedHash: r.sortedHash, checkpoints: r.checkpoints, rows: {} };
    for (let j = 0; j < ROW_NAMES.length; j++) out.rows[ROW_NAMES[j]] = rows[j];
    if (T !== null) {
        out.model = { T, touchSeqHash: hex32(th), touches: sT, tableWrites: sTab, threadWrites: sThr };
    }
    return out;
}

/** Boundary table for (U, C): states x boundary keys, answers from the oracle (null = undefined). */
export function boundaryRow(U, C) {
    const xs = boundaryKeys(U);
    const states = [['empty', []], ['lo', [0]], ['hi', [U - 1]], ['ends', [0, U - 1]]];
    if (U > 2147483648) states.push(['top', [2147483647, 2147483648]]);
    if (C === U && U <= 16) states.push(['full', Array.from({ length: U }, (_, k) => k)]);
    const out = { U, C, xs, states: [] };
    const nz = (v) => (v === undefined ? null : v);
    for (const [name, keys] of states) {
        const o = new SortedOracle(U, C);
        for (const k of keys) o.add(k);
        out.states.push({
            name, keys,
            min: nz(o.min()), max: nz(o.max()),
            has: xs.map((x) => o.has(x)),
            succ: xs.map((x) => nz(o.successor(x))),
            pred: xs.map((x) => nz(o.predecessor(x))),
        });
    }
    return out;
}

/** The whole xft-b0.json object (oracle only, no cross-check). */
export function buildVectors() {
    const g = levelGeometry(65536, 16);
    const d = g.levels[g.w];
    return {
        what: 'lite-loglogn XFastTrie pre-engine vectors (B0b E2), cut from SortedOracle; ' +
            'StratifiedBitset cross-checked per op for U <= 2^28',
        streamVersion: XFT_STREAM_VERSION,
        nOps: N_OPS,
        every: EVERY,
        fullThrows: FULL_THROWS,
        baseSeed: BASE_SEED,
        seedRule: SEED_RULE,
        sbCrossMaxU: SB_CROSS_MAX_U,
        streams: STREAMS.map((_, i) => cutStream(i)),
        boundary: STREAMS.map(([U, C]) => boundaryRow(U, C)),
        collide: { U: 65536, C: 16, w: g.w, B: d.B, S: d.S, s1: d.s1, s2: d.s2,
            keys: collide(65536, 16, 9) },
    };
}

/** Lockstep SortedOracle vs SbCapped for every stream with U <= 2^28; [] when clean. */
export function crossCheckSb() {
    const bad = [];
    for (let i = 0; i < STREAMS.length; i++) {
        const [U, C] = STREAMS[i];
        if (U > SB_CROSS_MAX_U) continue;
        const st = genStream(U, C, N_OPS, streamSeed(i));
        const m = lockstep(new SortedOracle(U, C), new SbCapped(U, C), U, st);
        if (m !== null) bad.push('U=' + U + ' C=' + C + ': ' + m);
    }
    return bad;
}

/** Compact JSON: objects one key per line, arrays of primitives on one line. */
export function formatJson(v, ind = '') {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const in2 = ind + '  ';
    if (Array.isArray(v)) {
        if (v.every((e) => e === null || typeof e !== 'object')) {
            return '[' + v.map((e) => JSON.stringify(e)).join(', ') + ']';
        }
        return '[\n' + v.map((e) => in2 + formatJson(e, in2)).join(',\n') + '\n' + ind + ']';
    }
    const ks = Object.keys(v);
    return '{\n' + ks.map((k) => in2 + JSON.stringify(k) + ': ' + formatJson(v[k], in2)).join(',\n') +
        '\n' + ind + '}';
}

/** The exact text of test/vectors/xft-b0.json. */
export function vectorsText() {
    return formatJson(buildVectors()) + '\n';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!process.argv.includes('--cut')) {
        process.stderr.write('usage: node test/helpers/xftStream.mjs --cut > test/vectors/xft-b0.json\n');
        process.exit(2);
    }
    const bad = crossCheckSb();
    if (bad.length > 0) {
        process.stderr.write('xftStream --cut ABORT: SortedOracle vs StratifiedBitset mismatch\n');
        for (const b of bad) process.stderr.write('  ' + b + '\n');
        process.exit(1);
    }
    process.stdout.write(vectorsText());
}
