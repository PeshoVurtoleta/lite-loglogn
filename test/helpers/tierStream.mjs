/**
 * @zakkster/lite-loglogn -- tier parity stream (B1c, A9). Test helper, not a
 * test file (the npm glob `test/*.test.js` never matches it). Zero deps.
 *
 * genStream(U, nOps, seed) builds a seeded A1-style op stream for universe U:
 * add / delete / has / successor / predecessor / min / max in four phase kinds
 *   MIXED  -- uniform keys, keys near live keys, edge keys;
 *   DENSE  -- an add-heavy window of 4096 keys, then queries inside it;
 *   SPARSE -- drain every live key, add 1..6 keys, then successor / predecessor
 *             at uniform x: the queries that cross >= 2 empty aligned 1,024-key
 *             blocks are counted in `sparseCross` (from the stream's own sorted
 *             live set, never from the build under test);
 *   EDGE   -- 0, 1, U-1, U-2, word (32) / block (1,024) / 32,768 boundaries +-1;
 * plus BAD keys (~3% of key-taking ops): -1, U, U+0.5, NaN, '3', -0, 2^32, ...
 * The stream depends only on (U, nOps, seed), never on a build's answers.
 *
 * runTier(Cls, U, nOps, seed) replays the stream on `new Cls(U)` with the D7
 * counting Proxy swapped into the instance's `_bits` after construction
 * (numeric-key get = R, set = Wr) and returns FNV-1a 32-bit hashes:
 *   resultsHash -- every op's result (undefined / false / true / number as
 *                  float64 bits / the instance itself / thrown RangeError /
 *                  other throw by name, each a distinct tag), then the final size;
 *   countsHash  -- every op's (R, Wr) pair;
 * plus sumR, sumWr, opCounts[7], sparseCross. The class is a parameter, so the
 * same code runs any build (the frozen B1a cut and the live file alike).
 */

export const OP_ADD = 0;
export const OP_DELETE = 1;
export const OP_HAS = 2;
export const OP_SUCC = 3;
export const OP_PRED = 4;
export const OP_MIN = 5;
export const OP_MAX = 6;

export const STREAM_VERSION = 1;

const LIVE_CAP = 2048;
const BLOCK = 1024;

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

// --- FNV-1a 32-bit ------------------------------------------------------------

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

// --- bad keys -------------------------------------------------------------------

/** Keys outside the contract (plus -0, which aliases key 0 by D1). */
export function badKeys(U) {
    return [-1, U, U + 0.5, NaN, '3', -0, 4294967296, 1.5, Infinity, -Infinity,
        null, undefined, true, 3n, '0', -0.5, 2 ** 53, U - 0.5];
}

// --- stream ---------------------------------------------------------------------

/**
 * @returns {{ op: Uint8Array, key: Float64Array, bad: Int8Array, sparseCross: number }}
 * bad[i] >= 0 -> the key is badKeys(U)[bad[i]], else key[i].
 */
export function genStream(U, nOps, seed) {
    const rnd = mulberry32(seed);
    const op = new Uint8Array(nOps);
    const key = new Float64Array(nOps);
    const bad = new Int8Array(nOps).fill(-1);
    const nBad = badKeys(U).length;
    const live = [];
    const pos = new Map();
    let n = 0;
    let sparseCross = 0;

    const int = (k) => Math.floor(rnd() * k);
    const uni = () => int(U);
    const clampKey = (x) => (x < 0 ? 0 : x > U - 1 ? U - 1 : x);
    const edge = () => {
        const r = int(12);
        let x;
        if (r === 0) x = 0;
        else if (r === 1) x = 1;
        else if (r === 2) x = U - 1;
        else if (r === 3) x = U - 2;
        else if (r === 4) x = U - 32 + int(3) - 1;
        else if (r === 5) x = U - BLOCK + int(3) - 1;
        else if (r <= 7) x = 32 * int(Math.ceil(U / 32)) + int(3) - 1;
        else if (r <= 9) x = BLOCK * int(Math.ceil(U / BLOCK)) + int(3) - 1;
        else x = 32768 * int(Math.ceil(U / 32768)) + int(3) - 1;
        return clampKey(x);
    };
    const nearLive = () => {
        if (live.length === 0) return uni();
        return clampKey(live[int(live.length)] + int(81) - 40);
    };
    const emit = (o, x) => {
        if (n >= nOps) return;
        if (o <= OP_PRED && rnd() < 0.03) {
            bad[n] = int(nBad);
        } else {
            key[n] = x;
        }
        op[n] = o;
        if (bad[n] < 0) {
            if (o === OP_ADD && !pos.has(x)) {
                pos.set(x, live.length);
                live.push(x);
            } else if (o === OP_DELETE && pos.has(x)) {
                const j = pos.get(x);
                const last = live.pop();
                if (last !== x) {
                    live[j] = last;
                    pos.set(last, j);
                }
                pos.delete(x);
            }
        }
        n++;
    };
    // one op of the mixed distribution with the given key picker
    const mixedOp = (pick) => {
        const r = rnd();
        if (r < 0.28) {
            if (live.length >= LIVE_CAP) emit(OP_DELETE, live[int(live.length)]);
            else emit(OP_ADD, pick());
        } else if (r < 0.48) {
            emit(OP_DELETE, live.length > 0 && rnd() < 0.7 ? live[int(live.length)] : pick());
        } else if (r < 0.62) emit(OP_HAS, pick());
        else if (r < 0.76) emit(OP_SUCC, pick());
        else if (r < 0.90) emit(OP_PRED, pick());
        else if (r < 0.95) emit(OP_MIN, 0);
        else emit(OP_MAX, 0);
    };

    while (n < nOps) {
        const phase = int(4);
        const len = 512 + int(3585);
        if (phase === 0) {
            for (let k = 0; k < len && n < nOps; k++) {
                const r = rnd();
                mixedOp(r < 0.4 ? uni : r < 0.8 ? nearLive : edge);
            }
        } else if (phase === 1) {
            const span = U < 4096 ? U : 4096;
            const base = U <= 4096 ? 0 : int(U - 4096 + 1);
            const win = () => base + int(span);
            for (let k = 0; k < len && n < nOps; k++) {
                if (k < (len >>> 1)) {
                    if (live.length >= LIVE_CAP) emit(OP_DELETE, live[int(live.length)]);
                    else emit(rnd() < 0.8 ? OP_ADD : OP_DELETE, win());
                } else {
                    mixedOp(win);
                }
            }
        } else if (phase === 2) {
            // drain: delete every live key (the stream's own copy)
            while (live.length > 0 && n < nOps) emit(OP_DELETE, live[live.length - 1]);
            const m = 1 + int(6);
            for (let k = 0; k < m; k++) emit(OP_ADD, uni());
            const sorted = live.slice().sort((a, b) => a - b);
            for (let k = 0; k < len && n < nOps; k++) {
                const r = rnd();
                const x = uni();
                const before = n;
                if (r < 0.42) emit(OP_SUCC, x);
                else if (r < 0.84) emit(OP_PRED, x);
                else if (r < 0.92) emit(OP_HAS, x);
                else if (r < 0.96) emit(OP_MIN, 0);
                else emit(OP_MAX, 0);
                if (n === before || bad[before] >= 0) continue;
                const o = op[before];
                if (o === OP_SUCC) {
                    let ans = -1;
                    for (let j = 0; j < sorted.length; j++) {
                        if (sorted[j] > x) { ans = sorted[j]; break; }
                    }
                    const ab = ans < 0 ? Math.floor((U - 1) / BLOCK) + 1 : Math.floor(ans / BLOCK);
                    if (ab - Math.floor(x / BLOCK) >= 3) sparseCross++;
                } else if (o === OP_PRED) {
                    let ans = -1;
                    for (let j = sorted.length - 1; j >= 0; j--) {
                        if (sorted[j] < x) { ans = sorted[j]; break; }
                    }
                    const ab = ans < 0 ? -1 : Math.floor(ans / BLOCK);
                    if (Math.floor(x / BLOCK) - ab >= 3) sparseCross++;
                }
            }
        } else {
            for (let k = 0; k < len && n < nOps; k++) {
                const r = rnd();
                if (r < 0.2) emit(OP_ADD, edge());
                else if (r < 0.3) emit(OP_DELETE, edge());
                else if (r < 0.4) emit(OP_HAS, edge());
                else if (r < 0.65) emit(OP_SUCC, edge());
                else if (r < 0.9) emit(OP_PRED, edge());
                else if (r < 0.95) emit(OP_MIN, 0);
                else emit(OP_MAX, 0);
            }
        }
    }
    return { op, key, bad, sparseCross };
}

// --- D7 counting harness ----------------------------------------------------------

/** True for a canonical array-index string ('0', '17'; not '-0', '01', '1.5'). */
function isIndexKey(k) {
    if (typeof k !== 'string' || k.length === 0) return false;
    const c0 = k.charCodeAt(0);
    if (c0 === 48) return k.length === 1;
    if (c0 < 49 || c0 > 57) return false;
    for (let i = 1; i < k.length; i++) {
        const c = k.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

/**
 * Swaps a counting Proxy into inst._bits. cnt[0] = R (numeric gets), cnt[1] = Wr
 * (numeric sets). unwrap() restores the real array.
 */
export function wrapCounting(inst) {
    const target = inst._bits;
    const cnt = new Float64Array(2);
    inst._bits = new Proxy(target, {
        get(t, k) {
            if (isIndexKey(k)) cnt[0]++;
            return Reflect.get(t, k);
        },
        set(t, k, v) {
            if (isIndexKey(k)) {
                cnt[1]++;
                t[k] = v;
                return true;
            }
            return Reflect.set(t, k, v);
        },
    });
    return { cnt, unwrap() { inst._bits = target; } };
}

// --- replay -------------------------------------------------------------------------

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

function foldResult(h, ret, inst) {
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

/**
 * Replays genStream(U, nOps, seed) on new Cls(U) through the counting Proxy.
 * @returns {{ U: number, levels: number, resultsHash: string, countsHash: string,
 *   sumR: number, sumWr: number, opCounts: number[], sparseCross: number, size: number }}
 */
export function runTier(Cls, U, nOps, seed) {
    const st = genStream(U, nOps, seed);
    const BAD = badKeys(U);
    const inst = new Cls(U);
    const w = wrapCounting(inst);
    const cnt = w.cnt;
    let rh = FNV_OFFSET;
    let ch = FNV_OFFSET;
    let sumR = 0;
    let sumWr = 0;
    const opCounts = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < nOps; i++) {
        const o = st.op[i];
        const x = st.bad[i] >= 0 ? BAD[st.bad[i]] : st.key[i];
        opCounts[o]++;
        cnt[0] = 0;
        cnt[1] = 0;
        let ret;
        try {
            if (o === OP_ADD) ret = inst.add(x);
            else if (o === OP_DELETE) ret = inst.delete(x);
            else if (o === OP_HAS) ret = inst.has(x);
            else if (o === OP_SUCC) ret = inst.successor(x);
            else if (o === OP_PRED) ret = inst.predecessor(x);
            else if (o === OP_MIN) ret = inst.min();
            else ret = inst.max();
            rh = foldResult(rh, ret, inst);
        } catch (e) {
            if (e instanceof RangeError) rh = fnvByte(rh, 7);
            else rh = fnvString(fnvByte(rh, 8), e !== null && typeof e === 'object' ? String(e.name) : typeof e);
        }
        const R = cnt[0];
        const Wr = cnt[1];
        ch = fnvWord(fnvWord(ch, R), Wr);
        sumR += R;
        sumWr += Wr;
    }
    w.unwrap();
    const size = inst.size;
    rh = fnvWord(fnvByte(rh, 9), size);
    return {
        U,
        levels: inst.levels,
        resultsHash: hex32(rh),
        countsHash: hex32(ch),
        sumR,
        sumWr,
        opCounts,
        sparseCross: st.sparseCross,
        size,
    };
}
