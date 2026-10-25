/**
 * @zakkster/lite-loglogn -- YFastTrie pre-engine vectors (0.4.0 G1-B0, tasks G1-0 /
 * G1-1). Test helper, not a test file (the npm glob `test/*.test.js` never matches
 * it). Zero deps; reuses test/helpers/xftStream.mjs (genStream, SortedOracle,
 * SbCapped, FNV folds, the 15 xft-b0 (U, C)) and imports the shipped
 * StratifiedBitset only through it (the cut's cross-check oracle).
 *
 * Contents (every function is deterministic and depends on its arguments only):
 *   YModel(U, C) -- the PLAN-yfasttrie C-3 policy on plain JS arrays:
 *     w = ceil(log2 U), K = 2w, h = ceil(w/2), Cr = min(2 + floor(C/h), U).
 *     Reps are SEPARATORS: bucket i holds [rep_i, rep_{i+1}); the head rep 0 is
 *     permanent, holds 0..K keys and never merges; every other bucket holds [h, K].
 *     Split: an add of a NEW key into a bucket with s = K; new rep = the key at
 *     index w of the EXISTING K-key run (before x goes in); left keeps run[0..w-1],
 *     right gets run[w..K-1]; then x goes left if x < rep, else right.
 *     Underflow: a delete from a non-head bucket with s <= h (before the delete):
 *     s_L + s - 1 <= K -> merge into the LEFT neighbour and drop the rep; else
 *     borrow: t = s_L + s - 1, combined = L ++ (bucket minus x), new rep =
 *     combined[ceil(t/2)] (always inside L), L keeps combined[0..ceil(t/2)-1],
 *     the bucket gets the rest. Counters splits / merges / borrows; nAdd (adds of
 *     a NEW key = A) / nDel (deletes of a present key = D). Capacity C and bad keys
 *     follow SortedOracle exactly (a full add of a new key throws RangeError, set
 *     unchanged; has / delete false, successor / predecessor undefined).
 *     The policy hooks `_needSplit`, `_splitRep`, `_under`, `_shrink` exist so a
 *     test can build one-mutation must-fail controls by subclassing.
 *   checkModel(m, keys) -- the invariant checker: null, or 'clause: detail' for
 *     the first broken clause (rep0, lens, repsAsc, Cr, sorted, range, headSize,
 *     size, union).
 *   FORCING -- 9 named forcing streams (see FORCING below); xft-b0 streams are
 *     genStream(U, C, N_OPS, streamSeed(i)) exactly as xftStream cuts them.
 *   yReplay(model, U, st, opts) -- replays a stream on a YModel with the SAME
 *     resultsHash / sortedHash folds as xftStream replay() (so a YFastTrie is later
 *     checked against the 15 xft-b0 rows) plus, at every EVERY ops: layoutHash,
 *     splits / merges / borrows, size-band histogram.
 *   buildVectors() / vectorsText() and the CLI:
 *     node test/helpers/yftStream.mjs --cut > test/vectors/yft-b0.json
 *       ABORTS (exit 1, nothing on stdout) when SortedOracle != StratifiedBitset
 *       (U <= 2^28) on any stream, when YModel answers differently from
 *       SortedOracle at any op, breaks an invariant at any op (checked after EVERY
 *       op), or misses an xft-b0.json row (resultsHash / sortedHash / size).
 *     node test/helpers/yftStream.mjs --cut-xft-seed [--build <path>] [--commit <id>]
 *         > test/vectors/xft-seed.json
 *       XFastTrie level-seed vectors cut from the FROZEN build (default
 *       .handoff/yft-before/LogLogN.js = commit fd8fcec, sha256 375caeab...; the
 *       default build ABORTS on any other sha256).
 *
 * Folds (FNV-1a, xftStream helpers):
 *   resultsHash / sortedHash -- identical to xftStream (header there).
 *   layoutHash -- per bucket fnvWord(rep), fnvWord(size), then byte 9 + the
 *     bucket count.
 *   hist -- bucket counts in 5 size bands: [0] [1, h-1] [h, w] [w+1, K-1] [K, ...)
 *     (the head included; a band may be empty for small w).
 * xft-seed hashes are node:crypto sha256 hex: `_lv` = sha256 of the comma-joined
 *   signed int32 decimals of `_lv`; dump = sha256 of JSON.stringify(dump()) (typed
 *   arrays stringify as index-keyed objects); region = sha256 of the UTF-8 bytes of
 *   the XFastTrie region (Parity.test.js rule: from the marker to the "\n" before
 *   the next line starting `// --- `, or EOF).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
    OP_ADD, OP_DELETE, OP_HAS, OP_SUCC, OP_PRED, OP_MIN, OP_MAX,
    STREAMS, N_OPS, EVERY, SB_CROSS_MAX_U, XFT_STREAM_VERSION,
    streamSeed, bitsOf, mulberry32, FNV_OFFSET, fnvByte, fnvWord, hex32,
    badKeys, SortedOracle, SbCapped, genStream, foldResult, foldThrow, applyOp,
    sortedHash, keyAt, lockstep, collide, formatJson, replay,
} from './xftStream.mjs';

export const YFT_STREAM_VERSION = 1;
export const FORCE_SEED = 0x59f70b00;
export const N_BANDS = 5;

// --- YModel -------------------------------------------------------------------------

/** The C-3 policy on plain JS arrays (see the header). */
export class YModel {
    constructor(universe, capacity) {
        const w = bitsOf(universe);
        this._u = universe;
        this._c = capacity;
        this.w = w;
        this.K = 2 * w;
        this.h = Math.ceil(w / 2);
        this.Cr = Math.min(2 + Math.floor(capacity / this.h), universe);
        this.reps = [0];
        this.bks = [[]];
        this._size = 0;
        this.splits = 0;
        this.merges = 0;
        this.borrows = 0;
        this.nAdd = 0;
        this.nDel = 0;
    }
    get size() { return this._size; }
    get universe() { return this._u; }
    get capacity() { return this._c; }
    _ok(x) {
        return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < this._u;
    }
    /** Index of the bucket whose range holds x: the largest i with reps[i] <= x. */
    _find(x) {
        const r = this.reps;
        let lo = 0;
        let hi = r.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (r[mid] <= x) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }
    /** First index j of b with b[j] >= x. */
    static lb(b, x) {
        let lo = 0;
        let hi = b.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (b[mid] < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    // policy hooks (one-mutation controls override exactly one)
    /** Split before inserting a new key into a bucket of size s. */
    _needSplit(s) { return s === this.K; }
    /** Index into the EXISTING run of the new separator. */
    _splitRep(run) { return this.w; }
    /** A delete from bucket i (size s before the delete) underflows. */
    _under(i, s) { return i > 0 && s <= this.h; }
    /** Bucket i underflows on deleting index j: merge into the left neighbour, else borrow. */
    _shrink(i, j) {
        const b = this.bks[i];
        const L = this.bks[i - 1];
        b.splice(j, 1);
        if (L.length + b.length <= this.K) {
            this.bks[i - 1] = L.concat(b);
            this.bks.splice(i, 1);
            this.reps.splice(i, 1);
            this.merges++;
            return;
        }
        const comb = L.concat(b);
        const c = Math.ceil(comb.length / 2);
        this.reps[i] = comb[c];
        this.bks[i - 1] = comb.slice(0, c);
        this.bks[i] = comb.slice(c);
        this.borrows++;
    }
    /** Splits bucket i (a K-key run) at _splitRep; returns the new rep. */
    _split(i) {
        const run = this.bks[i];
        const k = this._splitRep(run);
        const rep = run[k];
        this.reps.splice(i + 1, 0, rep);
        this.bks[i] = run.slice(0, k);
        this.bks.splice(i + 1, 0, run.slice(k));
        this.splits++;
        return rep;
    }
    has(x) {
        if (!this._ok(x)) return false;
        const b = this.bks[this._find(x)];
        return b[YModel.lb(b, x)] === x;
    }
    add(x) {
        if (!this._ok(x)) throw new RangeError('[ymodel] bad key');
        const v = x + 0;
        let i = this._find(v);
        let b = this.bks[i];
        let j = YModel.lb(b, v);
        if (b[j] === v) return this;
        if (this._size === this._c) throw new RangeError('[ymodel] full');
        if (this._needSplit(b.length)) {
            const rep = this._split(i);
            if (!(v < rep)) i++;
            b = this.bks[i];
            j = YModel.lb(b, v);
        }
        b.splice(j, 0, v);
        this._size++;
        this.nAdd++;
        return this;
    }
    delete(x) {
        if (!this._ok(x)) return false;
        const i = this._find(x);
        const b = this.bks[i];
        const j = YModel.lb(b, x);
        if (b[j] !== x) return false;
        if (this._under(i, b.length)) this._shrink(i, j);
        else b.splice(j, 1);
        this._size--;
        this.nDel++;
        return true;
    }
    successor(x) {
        if (!this._ok(x)) return undefined;
        const i = this._find(x);
        const b = this.bks[i];
        let j = YModel.lb(b, x);
        if (b[j] === x) j++;
        if (j < b.length) return b[j];
        for (let k = i + 1; k < this.bks.length; k++) if (this.bks[k].length > 0) return this.bks[k][0];
        return undefined;
    }
    predecessor(x) {
        if (!this._ok(x)) return undefined;
        const i = this._find(x);
        const b = this.bks[i];
        const j = YModel.lb(b, x) - 1;
        if (j >= 0) return b[j];
        for (let k = i - 1; k >= 0; k--) {
            const c = this.bks[k];
            if (c.length > 0) return c[c.length - 1];
        }
        return undefined;
    }
    min() {
        for (const b of this.bks) if (b.length > 0) return b[0];
        return undefined;
    }
    max() {
        for (let k = this.bks.length - 1; k >= 0; k--) {
            const b = this.bks[k];
            if (b.length > 0) return b[b.length - 1];
        }
        return undefined;
    }
}

/**
 * The invariant checker. keys = the SortedOracle contents (ascending) or null to
 * skip the union clause. @returns {string|null} the first broken clause.
 */
export function checkModel(m, keys) {
    const r = m.reps;
    const B = m.bks;
    if (r[0] !== 0) return 'rep0: rep[0] = ' + r[0];
    if (r.length !== B.length) return 'lens: ' + r.length + ' reps, ' + B.length + ' buckets';
    for (let i = 1; i < r.length; i++) {
        if (!(r[i] > r[i - 1])) return 'repsAsc: rep[' + i + '] = ' + r[i] + ' <= ' + r[i - 1];
    }
    if (r.length > m.Cr) return 'Cr: ' + r.length + ' reps > Cr ' + m.Cr;
    let n = 0;
    for (let i = 0; i < B.length; i++) {
        const b = B[i];
        const hi = i + 1 < r.length ? r[i + 1] : m.universe;
        for (let j = 0; j < b.length; j++) {
            if (j > 0 && !(b[j] > b[j - 1])) return 'sorted: bucket ' + i + ' index ' + j;
            if (!(b[j] >= r[i] && b[j] < hi)) {
                return 'range: bucket ' + i + ' key ' + b[j] + ' outside [' + r[i] + ', ' + hi + ')';
            }
        }
        if (i === 0) {
            if (b.length > m.K) return 'headSize: ' + b.length + ' > K ' + m.K;
        } else if (b.length < m.h || b.length > m.K) {
            return 'size: bucket ' + i + ' holds ' + b.length + ', not in [' + m.h + ', ' + m.K + ']';
        }
        n += b.length;
    }
    if (n !== m.size) return 'union: buckets hold ' + n + ' keys, size is ' + m.size;
    if (keys === null) return null;
    if (n !== keys.length) return 'union: buckets hold ' + n + ' keys, oracle ' + keys.length;
    let k = 0;
    for (const b of B) {
        for (const x of b) {
            if (x !== keys[k]) return 'union: key #' + k + ' ' + x + ' vs ' + keys[k];
            k++;
        }
    }
    return null;
}

/** Size band of a bucket of s keys (see the header). */
export function band(m, s) {
    if (s === 0) return 0;
    if (s < m.h) return 1;
    if (s <= m.w) return 2;
    if (s < m.K) return 3;
    return 4;
}

/** layoutHash of a model (reps + sizes). */
export function layoutHash(m) {
    let h = FNV_OFFSET;
    for (let i = 0; i < m.reps.length; i++) {
        h = fnvWord(h, m.reps[i]);
        h = fnvWord(h, m.bks[i].length);
    }
    return hex32(fnvWord(fnvByte(h, 9), m.reps.length));
}

/** Size-band histogram of a model. */
export function histOf(m) {
    const out = new Array(N_BANDS).fill(0);
    for (const b of m.bks) out[band(m, b.length)]++;
    return out;
}

// --- forcing streams ----------------------------------------------------------------

/** Stream builder: updates plus one query after each (seeded), same shape as genStream. */
function builder(U, seed) {
    const rnd = mulberry32(seed);
    const op = [];
    const key = [];
    const int = (k) => Math.floor(rnd() * k);
    const query = (x) => {
        const r = rnd();
        const near = Math.min(U - 1, Math.max(0, x + int(5) - 2));
        if (r < 0.2) { op.push(OP_HAS); key.push(near); }
        else if (r < 0.5) { op.push(OP_SUCC); key.push(near); }
        else if (r < 0.8) { op.push(OP_PRED); key.push(near); }
        else if (r < 0.9) { op.push(OP_MIN); key.push(0); }
        else { op.push(OP_MAX); key.push(0); }
    };
    return {
        rnd, int,
        add(x) { op.push(OP_ADD); key.push(x); query(x); },
        del(x) { op.push(OP_DELETE); key.push(x); query(x); },
        done() {
            return { op: Uint8Array.from(op), key: Float64Array.from(key), bad: new Int8Array(op.length).fill(-1) };
        },
    };
}

/** Deterministic shuffle of a copy. */
function shuffled(arr, int) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
    }
    return a;
}

/** Random churn over a fixed key window: fill-up, drain-down and mixed phases. */
function churn(b, window, C, rounds) {
    const live = new Set();
    const pickIn = () => window[b.int(window.length)];
    const pickLive = () => {
        const arr = Array.from(live);
        return arr[b.int(arr.length)];
    };
    for (let r = 0; r < rounds; r++) {
        const top = Math.min(C, window.length);
        while (live.size < top) {
            const x = pickIn();
            if (!live.has(x)) { b.add(x); live.add(x); }
        }
        const low = b.int(4);
        while (live.size > low) {
            const x = pickLive();
            b.del(x);
            live.delete(x);
        }
        for (let k = 0; k < 2 * top; k++) {
            const x = pickIn();
            if (live.has(x)) { b.del(x); live.delete(x); }
            else if (live.size < C) { b.add(x); live.add(x); }
        }
    }
    for (const x of Array.from(live).sort((p, q) => p - q)) b.del(x);
}

/** F0: ascending fill to C (stride 37), ascending drain; 2 rounds. */
function fAsc(U, C, seed) {
    const b = builder(U, seed);
    for (let r = 0; r < 2; r++) {
        for (let k = 0; k < C; k++) b.add(k * 37 + r);
        for (let k = 0; k < C; k++) b.del(k * 37 + r);
    }
    return b.done();
}

/** F1: descending fill to C (stride 37), descending drain; 2 rounds. */
function fDesc(U, C, seed) {
    const b = builder(U, seed);
    for (let r = 0; r < 2; r++) {
        for (let k = C - 1; k >= 0; k--) b.add(k * 37 + r);
        for (let k = C - 1; k >= 0; k--) b.del(k * 37 + r);
    }
    return b.done();
}

/** F2: every key inside one window of 4w consecutive integers; random churn. */
function fCluster(U, C, seed) {
    const w = bitsOf(U);
    const base = 123457;
    const win = Array.from({ length: 4 * w }, (_, k) => base + k);
    const b = builder(U, seed);
    churn(b, win, C, 12);
    return b.done();
}

/** F3: live count saws between K + 1 + (r & 7) (a split) and h - 1 (merges), 48 teeth. */
function fSaw(U, C, seed) {
    const w = bitsOf(U);
    const K = 2 * w;
    const h = Math.ceil(w / 2);
    const b = builder(U, seed);
    const live = new Set();
    for (let r = 0; r < 48; r++) {
        const lo = (r * 29) % (U - 96);
        const win = Array.from({ length: 96 }, (_, k) => lo + k);
        const top = K + 1 + (r & 7);
        for (const x of shuffled(win, b.int)) {
            if (live.size >= top) break;
            if (!live.has(x)) { b.add(x); live.add(x); }
        }
        const order = (r & 1) === 0 ? Array.from(live).sort((p, q) => q - p) : shuffled(Array.from(live), b.int);
        for (const x of order) {
            if (live.size <= h - 1) break;
            b.del(x);
            live.delete(x);
        }
    }
    for (const x of Array.from(live)) b.del(x);
    return b.done();
}

/** F4 / F5: tiny universe at w = 3: asc / desc fill-and-drain, then random churn. */
function fTiny(U, C, seed) {
    const b = builder(U, seed);
    for (let r = 0; r < 24; r++) {
        const all = Array.from({ length: U }, (_, k) => k).slice(0, C);
        const fill = r % 3 === 0 ? all : r % 3 === 1 ? all.slice().reverse() : shuffled(all, b.int);
        for (const x of fill) b.add(x);
        const drain = r % 2 === 0 ? fill : shuffled(fill, b.int);
        for (const x of drain) b.del(x);
    }
    churn(b, Array.from({ length: U }, (_, k) => k), C, 40);
    return b.done();
}

/** F6: a cluster of C keys ending at 4294967295 (U = 2^32); random churn. */
function fTop(U, C, seed) {
    const win = Array.from({ length: C }, (_, k) => 4294967295 - (C - 1) + k);
    const b = builder(U, seed);
    churn(b, win, C, 8);
    b.add(4294967295);
    b.del(4294967295);
    return b.done();
}

/**
 * F7: one boundary, split and merged again every cycle. Head = keys 0..K-1; add K
 * -> split (rep = w, right = [w .. K], w + 1 keys); delete from the top until the
 * right bucket holds h, then once more (the underflow delete -> merge into the
 * head, w + h - 1 <= K keys); refill the head to 0..K-1. 64 cycles, same rep.
 */
function fPingPong(U, C, seed) {
    const w = bitsOf(U);
    const K = 2 * w;
    const h = Math.ceil(w / 2);
    const b = builder(U, seed);
    for (let k = 0; k < K; k++) b.add(k);
    for (let r = 0; r < 64; r++) {
        b.add(K);
        let top = K;
        for (let s = w + 1; s >= h; s--) b.del(top--);
        for (let k = top + 1; k < K; k++) b.add(k); // refill the head to K
    }
    for (let k = 0; k < K; k++) b.del(k);
    return b.done();
}

/**
 * F8: borrow at w = 4 (U = 16, K = 8, h = 2), the smallest WIDTH where C-3 can borrow (the smallest universe is U = 12; this stream uses 16)
 * Cycle: add 5..12 (head K), 13 (split, rep 9), 0..3 (head K again),
 * delete 13, 12, 11 (right at h), 10 (borrow: rep 6), then drain; 40 cycles with
 * random order variations, then churn.
 */
function fBorrow(U, C, seed) {
    const b = builder(U, seed);
    for (let r = 0; r < 40; r++) {
        for (let x = 5; x <= 12; x++) b.add(x);
        b.add(13);
        for (const x of (r & 1) === 0 ? [0, 1, 2, 3] : shuffled([0, 1, 2, 3], b.int)) b.add(x);
        for (const x of [13, 12, 11, 10]) b.del(x);
        for (const x of shuffled([0, 1, 2, 3, 5, 6, 7, 8, 9], b.int)) b.del(x);
    }
    churn(b, Array.from({ length: U }, (_, k) => k), C, 20);
    return b.done();
}

/**
 * The 9 forcing streams: [name, U, C, generator]. PLAN G1-1 names 8 (asc / desc
 * fill-and-drain, cluster within 4w, sawtooth around K and h, (5,5), (8,8), top
 * cluster at U = 2^32, one of the coder's choice = pingpong); borrow-w4 is added
 * because C-3 cannot borrow at w = 3 (see the report / YftVectors.test.js).
 */
export const FORCING = [
    ['asc-fill-drain', 65536, 1024, fAsc],
    ['desc-fill-drain', 65536, 1024, fDesc],
    ['cluster-4w', 1048576, 80, fCluster],
    ['sawtooth-K-h', 4096, 256, fSaw],
    ['w3-u5', 5, 5, fTiny],
    ['w3-u8', 8, 8, fTiny],
    ['top-cluster-2^32', 4294967296, 128, fTop],
    ['pingpong-one-boundary', 1024, 64, fPingPong],
    ['borrow-w4', 16, 16, fBorrow],
];

/** Stream descriptors in cut order: the 15 xft-b0 streams, then FORCING. */
export function allStreams() {
    const out = [];
    for (let i = 0; i < STREAMS.length; i++) {
        const [U, C] = STREAMS[i];
        out.push({ name: 'xft-b0-' + i, kind: 'xft-b0', U, C, seed: streamSeed(i),
            gen: () => genStream(U, C, N_OPS, streamSeed(i)) });
    }
    for (let i = 0; i < FORCING.length; i++) {
        const [name, U, C, f] = FORCING[i];
        const seed = (FORCE_SEED + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
        out.push({ name, kind: 'forcing', U, C, seed, gen: () => f(U, C, seed) });
    }
    return out;
}

// --- replay -------------------------------------------------------------------------

/** Applies op o to inst: { ret, err } (err !== null when it threw). */
function run(inst, o, x) {
    try {
        return { ret: applyOp(inst, o, x), err: null };
    } catch (e) {
        return { ret: undefined, err: e };
    }
}

/** Comparable tag of a run() outcome (lockstep vs the oracle). */
function tag(inst, r) {
    if (r.err !== null) return r.err instanceof RangeError ? 'throw:RangeError' : 'throw:' + String(r.err && r.err.name);
    const v = r.ret;
    if (v === inst) return 'this';
    if (typeof v === 'number') return Object.is(v, -0) ? 'n:-0' : 'n:' + v;
    return typeof v === 'boolean' ? 'b:' + v : typeof v;
}

/**
 * Replays st on model m. opts.oracle: lockstep vs a SortedOracle at every op;
 * opts.inv: 'op' (invariant after every op) | 'cp' (at every checkpoint and after
 * every split / merge / borrow) | 'none'. Never throws on a model fault: the first
 * fault is returned in `fault` (string) and the replay continues.
 */
export function yReplay(m, U, st, opts = {}) {
    const inv = opts.inv || 'cp';
    const o = opts.oracle ? new SortedOracle(U, m.capacity) : null;
    const BAD = badKeys(U);
    const nOps = st.op.length;
    const cps = { size: [], resultsHash: [], sortedHash: [], layoutHash: [],
        splits: [], merges: [], borrows: [], hist: [] };
    let rh = FNV_OFFSET;
    let fault = null;
    for (let i = 0; i < nOps; i++) {
        const op = st.op[i];
        const x = keyAt(st, BAD, i);
        const ev = m.splits + m.merges + m.borrows;
        const ra = run(m, op, x);
        rh = ra.err === null ? foldResult(rh, ra.ret, m) : foldThrow(rh, ra.err);
        if (o !== null) {
            const ta = tag(m, ra);
            const tb = tag(o, run(o, op, x));
            if (fault === null && ta !== tb) {
                fault = 'oracle: op ' + i + ' (' + op + ', ' + (typeof x === 'bigint' ? x + 'n' : String(x)) + '): ' +
                    ta + ' vs ' + tb;
            }
        }
        const cp = (i + 1) % EVERY === 0;
        if (fault === null && (inv === 'op' || (inv === 'cp' && (cp || m.splits + m.merges + m.borrows !== ev)))) {
            const bad = checkModel(m, o !== null ? o._a : null);
            if (bad !== null) fault = 'invariant after op ' + i + ': ' + bad;
        }
        if (cp) {
            cps.size.push(m.size);
            cps.resultsHash.push(hex32(rh));
            cps.sortedHash.push(sortedHash(m));
            cps.layoutHash.push(layoutHash(m));
            cps.splits.push(m.splits);
            cps.merges.push(m.merges);
            cps.borrows.push(m.borrows);
            cps.hist.push(histOf(m));
        }
    }
    return {
        nOps, A: m.nAdd, D: m.nDel,
        resultsHash: hex32(fnvWord(fnvByte(rh, 9), m.size)),
        finalSize: m.size,
        sortedHash: sortedHash(m),
        layoutHash: layoutHash(m),
        splits: m.splits, merges: m.merges, borrows: m.borrows,
        hist: histOf(m),
        checkpoints: cps,
        fault,
    };
}

/** One stream row of the cut (fault, if any, is returned separately). */
export function cutRow(d, opts = {}, Model = YModel) {
    const m = new Model(d.U, d.C);
    const r = yReplay(m, d.U, d.gen(), opts);
    const row = { name: d.name, kind: d.kind, U: d.U, C: d.C, w: m.w, K: m.K, h: m.h, Cr: m.Cr,
        seed: d.seed, nOps: r.nOps, A: r.A, D: r.D, resultsHash: r.resultsHash, finalSize: r.finalSize,
        sortedHash: r.sortedHash, layoutHash: r.layoutHash, splits: r.splits, merges: r.merges,
        borrows: r.borrows, hist: r.hist, checkpoints: r.checkpoints };
    return { row, fault: r.fault };
}

/** The A1 count bounds of a row: [] when both hold, else descriptions. */
export function boundFailures(row) {
    const out = [];
    const sMax = Math.floor((row.w + row.A + row.D) / row.w);
    const mbMax = Math.floor(row.D / (Math.floor(row.w / 2) + 1));
    if (!(row.splits <= sMax)) out.push('split bound: splits ' + row.splits + ' > floor((w+A+D)/w) = ' + sMax);
    if (!(row.merges + row.borrows <= mbMax)) {
        out.push('shrink bound: merges + borrows ' + (row.merges + row.borrows) + ' > floor(D/(floor(w/2)+1)) = ' + mbMax);
    }
    return out;
}

/** The whole yft-b0.json object. opts as yReplay; faults collected into the array given. */
export function buildVectors(opts = {}, faults = []) {
    const streams = [];
    for (const d of allStreams()) {
        const { row, fault } = cutRow(d, opts);
        if (fault !== null) faults.push(d.name + ': ' + fault);
        streams.push(row);
    }
    return {
        what: 'lite-loglogn YFastTrie pre-engine vectors (0.4.0 G1-B0), cut from YModel (PLAN-yfasttrie C-3); ' +
            'SortedOracle lockstep + invariants after every op; StratifiedBitset cross-checked for U <= 2^28',
        yftStreamVersion: YFT_STREAM_VERSION,
        xftStreamVersion: XFT_STREAM_VERSION,
        every: EVERY,
        xftNOps: N_OPS,
        forceSeed: FORCE_SEED,
        sbCrossMaxU: SB_CROSS_MAX_U,
        policy: 'w = ceil(log2 U), K = 2w, h = ceil(w/2), Cr = min(2 + floor(C/h), U); split at s = K, rep = run[w]; ' +
            'underflow at s <= h (non-head): merge left if s_L + s - 1 <= K, else borrow rep = combined[ceil(t/2)]',
        bands: '[0] [1, h-1] [h, w] [w+1, K-1] [K, ...)',
        nStreams: streams.length,
        streams,
    };
}

/** The exact text of test/vectors/yft-b0.json (inv 'cp', no lockstep: the row does not depend on opts). */
export function vectorsText(opts = {}, faults = []) {
    return formatJson(buildVectors(opts, faults)) + '\n';
}

/** Lockstep SortedOracle vs SbCapped for every stream with U <= 2^28; [] when clean. */
export function crossCheckSb() {
    const bad = [];
    for (const d of allStreams()) {
        if (d.U > SB_CROSS_MAX_U) continue;
        const m = lockstep(new SortedOracle(d.U, d.C), new SbCapped(d.U, d.C), d.U, d.gen());
        if (m !== null) bad.push(d.name + ' U=' + d.U + ' C=' + d.C + ': ' + m);
    }
    return bad;
}

/** Rows of the 15 xft-b0 streams that do not match xft-b0.json; [] when clean. */
export function crossCheckXft(vec) {
    const x = JSON.parse(readFileSync(new URL('../vectors/xft-b0.json', import.meta.url), 'utf8'));
    const bad = [];
    for (let i = 0; i < x.streams.length; i++) {
        const a = x.streams[i];
        const b = vec.streams[i];
        if (b.U !== a.U || b.C !== a.C || b.resultsHash !== a.resultsHash || b.sortedHash !== a.sortedHash ||
            b.finalSize !== a.finalSize ||
            JSON.stringify(b.checkpoints.size) !== JSON.stringify(a.checkpoints.size) ||
            JSON.stringify(b.checkpoints.resultsHash) !== JSON.stringify(a.checkpoints.resultsHash) ||
            JSON.stringify(b.checkpoints.sortedHash) !== JSON.stringify(a.checkpoints.sortedHash)) {
            bad.push('xft-b0 stream ' + i + ' (U=' + a.U + ', C=' + a.C + ')');
        }
    }
    return bad;
}

// --- xft-seed cut (G1-0) --------------------------------------------------------------

export const FROZEN_BUILD = new URL('../../.handoff/yft-before/LogLogN.js', import.meta.url);
export const FROZEN_SHA256 = '375caeab6f5aa15a343254dae252c18f8d34f35b5ac3f162c5f62482f2fd688d';
export const FROZEN_COMMIT = 'fd8fcec';
export const XFT_REGION_FROM = '// --- XFastTrie (0.3.0) ';

/** sha256 hex of a string or buffer. */
export function sha256(v) {
    return createHash('sha256').update(v).digest('hex');
}

/** Region by the markers (Parity.test.js rule), or null when missing / ambiguous. */
export function region(text, from) {
    const s = text.indexOf(from);
    if (s < 0 || text.indexOf(from, s + 1) >= 0) return null;
    const e = text.indexOf('\n// --- ', s + 1);
    return text.slice(s, e < 0 ? text.length : e);
}

/** sha256 of the comma-joined signed int32 decimals of an Int32Array. */
export function lvSha(lv) {
    return sha256(Array.from(lv).join(','));
}

/** The seed fields of one XFastTrie after its ops. */
function seedFields(t, lvCtor) {
    return { lvCtor, lvEnd: lvSha(t._lv), q: [t._q[1], t._q[2], t._q[3]], dump: sha256(JSON.stringify(t.dump())) };
}

/**
 * The xft-seed.json object from a build. Aborts (throws) on: a missing / ambiguous
 * region, the default build with a sha256 other than FROZEN_SHA256, a stream whose
 * replay misses xft-b0.json, or a collide() case without a reseed.
 */
export async function buildXftSeed(buildUrl, commit) {
    const text = readFileSync(buildUrl, 'utf8');
    const sha = sha256(Buffer.from(text, 'utf8'));
    if (buildUrl.href === FROZEN_BUILD.href && sha !== FROZEN_SHA256) {
        throw new Error('frozen build sha256 ' + sha + ' != ' + FROZEN_SHA256);
    }
    const reg = region(text, XFT_REGION_FROM);
    if (reg === null) throw new Error('XFastTrie region marker missing or not unique');
    const { XFastTrie } = await import(buildUrl.href);
    const xv = JSON.parse(readFileSync(new URL('../vectors/xft-b0.json', import.meta.url), 'utf8'));
    const streams = [];
    for (let i = 0; i < STREAMS.length; i++) {
        const [U, C] = STREAMS[i];
        const t = new XFastTrie(U, C);
        const lvCtor = lvSha(t._lv);
        const r = replay(t, U, genStream(U, C, N_OPS, streamSeed(i)));
        if (r.resultsHash !== xv.streams[i].resultsHash || r.sortedHash !== xv.streams[i].sortedHash) {
            throw new Error('build misses xft-b0 stream ' + i);
        }
        streams.push({ i, U, C, streamSeed: streamSeed(i), ...seedFields(t, lvCtor) });
    }
    const U = 65536;
    const C = 16;
    const keys = collide(U, C, 9);
    const t = new XFastTrie(U, C);
    const lvCtor = lvSha(t._lv);
    for (const k of keys) t.add(k);
    const f = seedFields(t, lvCtor);
    if (!(f.q[1] >= 1) || f.lvEnd === lvCtor) throw new Error('collide() case did not reseed: q ' + f.q.join(','));
    return {
        what: 'lite-loglogn XFastTrie level-seed vectors (0.4.0 G1-0, C-4 / C-5 / C-13): seed omitted / ' +
            'undefined / 0 must reproduce every row; cut from the frozen build',
        build: { commit, sha256: sha, regionFrom: XFT_REGION_FROM, regionBytes: Buffer.byteLength(reg, 'utf8'),
            regionSha256: sha256(Buffer.from(reg, 'utf8')) },
        hash: 'node:crypto sha256 hex; lvCtor / lvEnd = sha256(Array.from(_lv).join(",")) after the ctor / ' +
            'at the end; dump = sha256(JSON.stringify(dump())) at the end; q = [_q[1], _q[2], _q[3]] ' +
            '(kicks, reseedOps, tries) at the end',
        xftStreamVersion: XFT_STREAM_VERSION,
        nOps: N_OPS,
        streams,
        collide: { U, C, keys, ...f },
    };
}

// --- CLI ------------------------------------------------------------------------------

function argAfter(name) {
    const k = process.argv.indexOf(name);
    return k >= 0 ? process.argv[k + 1] : undefined;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.includes('--cut')) {
        const sb = crossCheckSb();
        const faults = [];
        const vec = buildVectors({ inv: 'op', oracle: true }, faults);
        const xb = crossCheckXft(vec);
        if (sb.length + faults.length + xb.length > 0) {
            process.stderr.write('yftStream --cut ABORT\n');
            for (const b of sb) process.stderr.write('  SortedOracle vs StratifiedBitset: ' + b + '\n');
            for (const b of faults) process.stderr.write('  YModel: ' + b + '\n');
            for (const b of xb) process.stderr.write('  YModel misses ' + b + '\n');
            process.exit(1);
        }
        process.stdout.write(formatJson(vec) + '\n');
    } else if (process.argv.includes('--cut-xft-seed')) {
        const b = argAfter('--build');
        const url = b === undefined ? FROZEN_BUILD : pathToFileURL(b);
        const commit = argAfter('--commit') ?? (b === undefined ? FROZEN_COMMIT : 'unknown');
        try {
            process.stdout.write(formatJson(await buildXftSeed(url, commit)) + '\n');
        } catch (e) {
            process.stderr.write('yftStream --cut-xft-seed ABORT: ' + (e && e.message) + '\n');
            process.exit(1);
        }
    } else {
        process.stderr.write('usage: node test/helpers/yftStream.mjs --cut > test/vectors/yft-b0.json\n' +
            '       node test/helpers/yftStream.mjs --cut-xft-seed [--build <path>] [--commit <id>] ' +
            '> test/vectors/xft-seed.json\n');
        process.exit(2);
    }
}
