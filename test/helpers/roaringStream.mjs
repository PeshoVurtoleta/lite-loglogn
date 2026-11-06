/**
 * @zakkster/lite-loglogn -- RoaringSet op streams + transcript recorder (0.6.0 G1-B3,
 * PLAN-roaringset-G1 task 3 / S-4 / A-1; SPEC-roaringset C-1, C-3, C-6, C-21). Test
 * helper, not a test file. Zero deps. It never imports LogLogN.js: the caller hands
 * in the RoaringSet class AND the row function, so an engine edit cannot move the
 * streams and the vectors are cut from ONE module only.
 *
 * Rows (every one deterministic, a function of its descriptor and of the pool-exhausted
 * throws it meets -- the throws are themselves in the transcript):
 *   SCEN  (6 scenarios)  random add / delete / runOptimize / clear on two sets A, B
 *   RSCEN (5 scenarios)  + bulk RANGE adds / deletes (word-aligned holes, 32..9,000-key
 *                        spans, whole chunks: FULL chunks), runOptimize at 5%
 *   CSCEN (2 scenarios)  bitmap churn: dense chunks, whole words / L1 groups / spans
 *                        across L1 / L2 edges emptied and refilled
 *   -- each at SEEDS (2) x OPS (1000) ops; the scenario tables, key generators and op
 *   mixes are those of the R0 fuzz (roaring-fuzz.best.mjs) minus the set-op pair checks
 *   (G3) and with MODEL-FREE query points (the queries never read the model, so the
 *   query stream does not depend on the oracle). A pool-exhausted throw inside an op is
 *   folded, then both the set and the generator's model are cleared (as the R0 fuzz
 *   does); the clear is a transcript op.
 *   T-*   targeted rows: pool exhaustion at every throw site (_promoteSingle,
 *         _promoteSmallToArray, _deleteFull, _promoteSmallRunToRun via add and via
 *         delete), FULL chunks, runOptimize to kinds 4 / 5 (and back to an array), the
 *         runOptimize conversion ties (array, runs slab, bitmap 2047 / 2048 runs), clear,
 *         the DEMOTE_SMALL / DEMOTE_BITMAP edges, boundary keys 0 / U-1 / 2^31 /
 *         2^32-1, bad keys (throwKey texts). No clear after a throw: the checkpoint
 *         right after it pins the fail-closed state.
 *
 * Transcript (per checkpoint; S-4):
 *   rh    -- FNV-1a 32, running over every op answer of the row: tag 1 undefined,
 *            2 false, 3 true, 4 + uint32 (4 LE bytes), 5 the instance, 6 + typeof text,
 *            9 + String(n) (a number that is not a uint32), 7 + error name, 0, message
 *            text (every throw, so throw TEXTS are pinned).
 *   Part A (layout-independent; G2 replays it on paged sets): rh, the op count, and per
 *            set: size, _sTop, _lTop, _conv, the live free lists _sFree[0, _sTop) /
 *            _lFree[0, _lTop), sha256 of the chunk-indexed top pyramid _top, and every
 *            live chunk c (kind != 0, read at row = rowOf(s, c)) as [c, kind, slot, card,
 *            runs, cMin, cMax, sha256 of the container's bytes] -- kinds 1 / 5: the
 *            128 B small slot; 2 / 4: the 8,192 B slab; 3: the slab + its 66-word
 *            summary; 6 / 7: none ('-').
 *   Part B (direct only): sha256 of each metadata array (_kind, _slot, _card, _runs,
 *            _cMin, _cMax) and of each whole pool array (_sData, _sFree, _lU16, _bSum,
 *            _lFree), stale bytes included.
 *   The checkpoint stores { id, n (ops so far), size [A, B], a, b } with a / b = the
 *   first 8 hex of sha256(Part A text) / sha256(Part B text). Random rows checkpoint
 *   after every EVERY ops (CSCEN also after the initial fill); targeted rows at their
 *   named marks; every row once more at 'end' unless its last checkpoint is already
 *   after the last op.
 * byteLength (row field) = draft byteLength - 24 (C-3: the shipped engine drops `_q`,
 *   an Int32Array(6)); the draft's `_q` never enters the transcript.
 *
 * rowOf is an EXPLICIT parameter (never a typeof fallback): the draft has no `_mi`, so
 * its cut passes ROW_DIRECT ((s, c) => c); the shipped engine reads per-chunk metadata
 * at row s._mi(c) and its replay passes ROW_MI.
 *
 * CLI: node test/helpers/roaringStream.mjs --cut <module path>
 *   Writes test/vectors/roaring-g1.json. Refuses (exit 1) unless sha256(<module>) starts
 *   with DRAFT_SHA8 (R/RoaringDraft.best.mjs). The cut runs the TRUE-definition oracle
 *   (a JS Set, linear walks) beside every op and ABORTS on the first disagreement.
 */

import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

if (endianness() !== 'LE') throw new Error('roaringStream: container hashes are defined over little-endian bytes');

export const ROARING_STREAM_VERSION = 1;
export const DRAFT_SHA8 = 'fd261191';
export const Q_BYTES = 24;
export const SEEDS = [1, 2];
export const OPS = 1000;
export const EVERY = 100;
export const RCAP = 100000;

/** Draft row function (no `_mi`): the chunk is its own row. */
export const ROW_DIRECT = (s, c) => c;
/** Shipped row function (C-1 / C-6). */
export const ROW_MI = (s, c) => s._mi(c);

export const SCEN = [
    { name: 'U=2^32 mix', U: 4294967296, mode: 'mix', maxS: 64, maxL: 32 },
    { name: 'U=2^20 dense', U: 1 << 20, mode: 'dense', maxS: 16, maxL: 16 },
    { name: 'U=2^20 runs', U: 1 << 20, mode: 'runs', maxS: 16, maxL: 16 },
    { name: 'U=2^20 stride', U: 1 << 20, mode: 'stride', maxS: 16, maxL: 16 },
    { name: 'U=200001 mix', U: 200001, mode: 'mix', maxS: 8, maxL: 8 },
    { name: 'U=2^20 mix small pool 0', U: 1 << 20, mode: 'mix', maxS: 0, maxL: 24 },
];
export const RSCEN = [
    { name: 'R U=2^20 range+opt mix', U: 1 << 20, mode: 'mix', maxS: 16, maxL: 16, every: 25 },
    { name: 'R U=2^18 range+opt runs', U: 1 << 18, mode: 'runs', maxS: 8, maxL: 8, every: 25 },
    { name: 'R U=2^32 range+opt mix', U: 4294967296, mode: 'mix', maxS: 64, maxL: 32, every: 25 },
    { name: 'R U=2^20 range+opt pool0', U: 1 << 20, mode: 'stride', maxS: 0, maxL: 24, every: 25 },
    { name: 'R U=200001 range+opt', U: 200001, mode: 'mix', maxS: 8, maxL: 8, every: 25 },
];
export const CSCEN = [
    { name: 'C U=2^18 bitmap churn', U: 1 << 18, maxS: 8, maxL: 8, every: 50, hot: 'rand4' },
    { name: 'C U=2^32 bitmap churn hi', U: 4294967296, maxS: 8, maxL: 8, every: 50, hot: 'hi' },
];

// --- PRNG, hashes ----------------------------------------------------------------------------

/** mulberry32 in [0, 1) (the R0 fuzz's rng). */
export function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
function fb(h, byte) { return Math.imul(h ^ (byte & 255), FNV_PRIME) >>> 0; }
function fw(h, w) { return fb(fb(fb(fb(h, w), w >>> 8), w >>> 16), w >>> 24); }
function fs(h, str) { for (let i = 0; i < str.length; i++) h = fb(h, str.charCodeAt(i)); return h; }
export function hex32(h) { return (h >>> 0).toString(16).padStart(8, '0'); }

/** Folds one op answer (tags in the header). */
export function foldAnswer(h, ret, inst) {
    if (ret === undefined) return fb(h, 1);
    if (ret === false) return fb(h, 2);
    if (ret === true) return fb(h, 3);
    if (ret === inst) return fb(h, 5);
    if (typeof ret === 'number') {
        if (Number.isInteger(ret) && ret >= 0 && ret <= 0xFFFFFFFF && !Object.is(ret, -0)) return fw(fb(h, 4), ret >>> 0);
        return fs(fb(h, 9), String(ret));
    }
    return fs(fb(h, 6), typeof ret);
}

/** Folds one throw: name and message TEXT. */
export function foldThrow(h, e) {
    const name = e !== null && typeof e === 'object' ? String(e.name) : typeof e;
    const msg = e !== null && typeof e === 'object' ? String(e.message) : String(e);
    return fs(fb(fs(fb(h, 7), name), 0), msg);
}

function sha(view) {
    return createHash('sha256').update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
}
function shaText(t) { return createHash('sha256').update(t).digest('hex'); }

// --- transcript ------------------------------------------------------------------------------

/** sha256 of the bytes of the container of live chunk row m (kind k); '-' for kinds 6 / 7. */
function containerHash(s, k, slot) {
    if (k === 1 || k === 5) return sha(s._sData.subarray(slot << 6, (slot << 6) + 64));
    if (k === 2 || k === 4) return sha(s._lU16.subarray(slot << 12, (slot << 12) + 4096));
    if (k === 3) {
        return shaText(sha(s._lU16.subarray(slot << 12, (slot << 12) + 4096)) + ':' +
            sha(s._bSum.subarray(slot * 66, slot * 66 + 66)));
    }
    if (k === 6 || k === 7) return '-';
    throw new Error('roaringStream: unknown container kind ' + k);
}

/** Part A of one set (layout-independent). rowOf(s, c) -> the metadata row of chunk c. */
export function partA(s, rowOf) {
    const chunks = Math.ceil(s.universe / 65536);
    const live = [];
    for (let c = 0; c < chunks; c++) {
        const m = rowOf(s, c);
        const k = s._kind[m];
        if (k === 0) continue;
        const slot = s._slot[m];
        live.push([c, k, slot, s._card[m], s._runs[m], s._cMin[m], s._cMax[m], containerHash(s, k, slot)]);
    }
    return {
        size: s.size, sTop: s._sTop, lTop: s._lTop, conv: s._conv,
        sFree: Array.from(s._sFree.subarray(0, s._sTop)),
        lFree: Array.from(s._lFree.subarray(0, s._lTop)),
        top: sha(s._top), chunks: live,
    };
}

const B_ARRAYS = ['_kind', '_slot', '_card', '_runs', '_cMin', '_cMax', '_sData', '_sFree', '_lU16', '_bSum', '_lFree'];

/** Part B of one set (direct layout only): sha256 of every metadata and pool array. */
export function partB(s) {
    const o = {};
    for (const f of B_ARRAYS) {
        if (!ArrayBuffer.isView(s[f])) throw new Error('roaringStream: ' + f + ' is not a typed array');
        o[f] = sha(s[f]);
    }
    return o;
}

// --- the true definition (cut-time oracle) ---------------------------------------------------

class Model {
    constructor(U) { this.U = U; this.s = new Set(); }
    add(x) { this.s.add(x + 0); }
    delete(x) { return this.ok(x) && this.s.delete(x + 0); }
    clear() { this.s.clear(); }
    ok(x) { return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < this.U; }
    has(x) { return this.ok(x) && this.s.has(x + 0); }
    succ(x) {
        if (!this.ok(x)) return undefined;
        const lim = Math.min(this.U, x + 4097);
        for (let y = x + 1; y < lim; y++) if (this.s.has(y)) return y;
        if (lim === this.U) return undefined;
        let b = Infinity;
        for (const k of this.s) if (k > x && k < b) b = k;
        return b === Infinity ? undefined : b;
    }
    pred(x) {
        if (!this.ok(x)) return undefined;
        const lim = Math.max(-1, x - 4097);
        for (let y = x - 1; y > lim; y--) if (this.s.has(y)) return y;
        if (lim === -1) return undefined;
        let b = -1;
        for (const k of this.s) if (k < x && k > b) b = k;
        return b === -1 ? undefined : b;
    }
    min() { let r; for (const k of this.s) if (r === undefined || k < r) r = k; return r; }
    max() { let r; for (const k of this.s) if (r === undefined || k > r) r = k; return r; }
}

/** Raised (after the throw is folded) so a random scenario clears, as the R0 fuzz does. */
class PoolStop extends Error {}

function isPool(e) { return e instanceof RangeError && /pool exhausted/.test(String(e.message)); }

function keyText(x) {
    if (typeof x === 'bigint') return x + 'n';
    if (typeof x === 'string') return JSON.stringify(x);
    if (typeof x === 'object' && x !== null) return 'object';
    return Object.is(x, -0) ? '-0' : String(x);
}

/**
 * The op context of one row on class Cls. Every op runs on the set, folds its answer,
 * mirrors the model (generation state) and, with oracle on, checks the TRUE definition.
 */
function makeCtx(Cls, rowOf, d, oracle, poolStop) {
    const X = {
        rh: FNV_OFFSET, n: 0, sets: [], models: [], cps: [], fault: null,
    };
    for (let i = 0; i < 2; i++) {
        X.sets.push(new Cls(d.U, d.maxS, d.maxL));
        X.models.push(new Model(d.U));
    }
    const bad = (i, what, x) => {
        if (X.fault === null) X.fault = 'op ' + X.n + ' (' + keyText(x) + ' on set ' + i + '): ' + what;
    };
    const check = (i, what, x, got, want) => {
        if (oracle && got !== want && X.fault === null) {
            X.fault = 'op ' + X.n + ' (' + what + ' ' + keyText(x) + ' on set ' + i + '): ' + String(got) + ' vs ' + String(want);
        }
    };
    const run = (i, what, x, fn, want) => {
        const S = X.sets[i];
        let ret;
        X.n++;
        try {
            ret = fn(S);
        } catch (e) {
            X.rh = foldThrow(X.rh, e);
            if (oracle && want !== 'throw' && !isPool(e) && X.fault === null) {
                X.fault = 'op ' + X.n + ' (' + what + ' ' + keyText(x) + ' on set ' + i + '): threw ' + String(e && e.message);
            }
            if (poolStop && isPool(e)) {
                if (oracle && S.size !== X.models[i].s.size && X.fault === null) {
                    X.fault = 'op ' + X.n + ' after pool throw: size ' + S.size + ' vs ' + X.models[i].s.size;
                }
                throw new PoolStop();
            }
            return 'throw';
        }
        X.rh = foldAnswer(X.rh, ret, S);
        return ret;
    };
    X.add = (i, x) => {
        const r = run(i, 'add', x, (S) => S.add(x), X.models[i].ok(x) ? 'set' : 'throw');
        if (r !== 'throw') {
            if (oracle && r !== X.sets[i]) bad(i, 'add returned non-this', x);
            if (oracle && !X.models[i].ok(x)) bad(i, 'add of a bad key did not throw', x);
            X.models[i].add(x);
        }
        return r;
    };
    X.del = (i, x) => {
        const r = run(i, 'delete', x, (S) => S.delete(x));
        const want = X.models[i].delete(x);
        if (r !== 'throw') check(i, 'delete', x, r, want);
        else if (want) X.models[i].add(x); // a failed delete (pool throw) keeps the key
        return r;
    };
    X.has = (i, x) => check(i, 'has', x, run(i, 'has', x, (S) => S.has(x)), X.models[i].has(x));
    X.succ = (i, x) => check(i, 'successor', x, run(i, 'successor', x, (S) => S.successor(x)), X.models[i].succ(x));
    X.pred = (i, x) => check(i, 'predecessor', x, run(i, 'predecessor', x, (S) => S.predecessor(x)), X.models[i].pred(x));
    X.min = (i) => check(i, 'min', '', run(i, 'min', '', (S) => S.min()), X.models[i].min());
    X.max = (i) => check(i, 'max', '', run(i, 'max', '', (S) => S.max()), X.models[i].max());
    X.opt = (i) => run(i, 'runOptimize', '', (S) => S.runOptimize());
    X.clr = (i) => {
        run(i, 'clear', '', (S) => S.clear());
        X.models[i].clear();
    };
    X.q3 = (i, x) => {
        if (!(x >= 0 && x < d.U)) return;
        X.has(i, x);
        X.succ(i, x);
        X.pred(i, x);
    };
    X.cp = (id) => {
        const A = [];
        const B = [];
        for (let i = 0; i < 2; i++) {
            const S = X.sets[i];
            if (oracle) {
                const M = X.models[i];
                if (S.size !== M.s.size && X.fault === null) X.fault = 'cp ' + id + ': size ' + S.size + ' vs ' + M.s.size + ' on set ' + i;
                for (const k of M.s) {
                    if (!S.has(k) && X.fault === null) { X.fault = 'cp ' + id + ': key ' + k + ' missing on set ' + i; break; }
                }
            }
            A.push(partA(S, rowOf));
            B.push(partB(S));
        }
        X.cps.push({
            id, n: X.n, size: [X.sets[0].size, X.sets[1].size],
            a: shaText(JSON.stringify({ rh: hex32(X.rh), n: X.n, sets: A })).slice(0, 8),
            b: shaText(JSON.stringify(B)).slice(0, 8),
        });
    };
    return X;
}

// --- R0 key generators (verbatim semantics) ----------------------------------------------------

function makeGen(r, U, mode) {
    const chunks = Math.ceil(U / 65536);
    const hot = [0, Math.min(chunks - 1, 1), Math.min(chunks - 1, 7), chunks - 1, Math.floor(r() * chunks)];
    const pickChunk = () => hot[Math.floor(r() * hot.length)];
    const clampU = (x) => (x >= U ? U - 1 : x);
    let runPos = Math.floor(r() * 65536);
    const denseOff = Math.floor(r() * 59000);
    return () => {
        const c = pickChunk();
        const base = c * 65536;
        const m = mode === 'mix' ? ['sparse', 'dense', 'runs', 'stride'][Math.floor(r() * 4)] : mode;
        if (m === 'sparse') return clampU(Math.floor(r() * U));
        if (m === 'dense') return clampU(base + denseOff + Math.floor(r() * 6000));
        if (m === 'runs') { runPos = (runPos + 1 + (r() < 0.05 ? Math.floor(r() * 300) : 0)) & 0xFFFF; return clampU(base + runPos); }
        return clampU(base + 2 * Math.floor(r() * 2400));
    };
}

function hotChunks(r, U) {
    const chunks = Math.ceil(U / 65536);
    return [0, Math.min(chunks - 1, 1), Math.min(chunks - 1, 7), chunks - 1, Math.floor(r() * chunks)];
}

function pickRange(r, U, hot, forDelete) {
    const c = hot[Math.floor(r() * hot.length)];
    const base = c * 65536;
    const t = r();
    let lo;
    let len;
    if (t < 0.35) {
        lo = base + Math.floor(r() * 65536);
        if (r() < 0.5) { lo -= lo % 32; len = 32 * (1 + Math.floor(r() * 3)); } else len = 1 + Math.floor(r() * 64);
    } else if (t < 0.65) { lo = base + Math.floor(r() * 65536); len = 32 + Math.floor(r() * 2000); }
    else if (t < 0.9) { lo = base + Math.floor(r() * 60000); len = 3000 + Math.floor(r() * 6000); }
    else {
        const v = r();
        lo = base + (v < 0.15 ? 1 : 0);
        len = 65536 - (v < 0.15 ? 1 : (v < 0.3 ? 1 : 0));
    }
    if (forDelete && r() < 0.3) { lo -= lo % 1024; len = 1024 * (1 + Math.floor(r() * 2)); }
    const hi = Math.min(U, lo + len);
    return [Math.min(lo, U - 1), hi];
}

function fillChunk(X, i, r, c) {
    const base = c * 65536;
    const dens = 0.1 + 0.6 * r();
    const blk = r() < 0.5;
    for (let lo = 0; lo < 65536; lo++) {
        const on = blk ? (((lo >>> 7) & 3) !== 0 && r() < dens + 0.1) : r() < dens;
        if (on) X.add(i, base + lo);
    }
}

function wordSpan(r, base) {
    const t = r();
    let w0;
    let nw;
    if (t < 0.45) { w0 = Math.floor(r() * 2048); nw = 1; }
    else if (t < 0.7) { const g = Math.floor(r() * 64); w0 = g * 32 + (r() < 0.5 ? 0 : 31); nw = 1; }
    else if (t < 0.8) { w0 = r() < 0.5 ? 1023 : 1024; nw = 1; }
    else if (t < 0.92) { const g = Math.floor(r() * 64); w0 = g * 32; nw = 32; }
    else { const g = 1 + Math.floor(r() * 63); const k = 1 + Math.floor(r() * 40); w0 = Math.max(0, g * 32 - k); nw = Math.min(2048 - w0, 2 * k); }
    return [base + w0 * 32, base + (w0 + nw) * 32];
}

// --- model-free probes -------------------------------------------------------------------------

/** min / max, 4 generator keys (has / succ / pred), one hot chunk's L1 / L2 edges. */
function probeBlock(X, i, r, U, hot, G) {
    X.min(i);
    X.max(i);
    for (let t = 0; t < 4; t++) X.q3(i, G());
    const base = hot[Math.floor(r() * hot.length)] * 65536;
    for (let g = 0; g <= 64; g += 4) {
        X.q3(i, base + g * 1024 - 1);
        X.q3(i, base + g * 1024);
    }
}

function spanProbe(X, i, U, lo, hi) {
    for (const q of [lo - 2, lo - 1, lo, lo + 1, hi - 2, hi - 1, hi, hi + 1]) X.q3(i, q);
}

// --- random families ---------------------------------------------------------------------------

function runScen(X, sc, seed) {
    const U = sc.U;
    const r = rng(seed * 7919 + U);
    const gens = [makeGen(r, U, sc.mode), makeGen(r, U, sc.mode)];
    const hots = [hotChunks(r, U), hotChunks(r, U)];
    for (let op = 0; op < OPS; op++) {
        const i = r() < 0.5 ? 0 : 1;
        const x = gens[i]();
        const roll = r();
        try {
            if (roll < 0.62) X.add(i, x);
            else if (roll < 0.97) X.del(i, x);
            else if (roll < 0.99) X.opt(i);
            else X.clr(i);
        } catch (e) {
            if (!(e instanceof PoolStop)) throw e;
            X.clr(i);
        }
        if (op % 25 === 0 || op === OPS - 1) probeBlock(X, i, r, U, hots[i], gens[i]);
        if ((op + 1) % EVERY === 0) X.cp('op' + (op + 1));
    }
}

function runRscen(X, sc, seed) {
    const U = sc.U;
    const r = rng(seed * 104729 + U);
    const ro = rng((seed * 104729 + U) ^ 0x9e3779b9);
    const gens = [makeGen(r, U, sc.mode), makeGen(r, U, sc.mode)];
    const hots = [hotChunks(r, U), hotChunks(r, U)];
    for (let op = 0; op < OPS; op++) {
        const i = ro() < 0.5 ? 0 : 1;
        const M = X.models[i];
        let roll = ro();
        if (M.s.size > RCAP) roll = 0.9;
        let opt = false;
        let span = null;
        try {
            if (roll < 0.45) X.add(i, gens[i]());
            else if (roll < 0.68) X.del(i, gens[i]());
            else if (roll < 0.73) { X.opt(i); opt = ro() < 0.3; }
            else if (roll < 0.86) {
                const [lo, hi] = pickRange(r, U, hots[i], false);
                span = [lo, hi];
                for (let x = lo; x < hi; x++) X.add(i, x);
            } else if (roll < 0.997) {
                let lo;
                let hi;
                if (M.s.size > RCAP) {
                    const fc = Math.floor(M.s.values().next().value / 65536) * 65536;
                    lo = fc;
                    hi = Math.min(U, fc + 65536);
                } else {
                    [lo, hi] = pickRange(r, U, hots[i], true);
                }
                span = [lo, hi];
                const down = ro() < 0.5;
                for (let j = lo; j < hi; j++) X.del(i, down ? hi - 1 - (j - lo) : j);
            } else X.clr(i);
        } catch (e) {
            if (!(e instanceof PoolStop)) throw e;
            X.clr(i);
            span = null;
        }
        if (span !== null && ro() < 0.25) spanProbe(X, i, U, span[0], span[1]);
        if (op % sc.every === 0 || op === OPS - 1 || opt) probeBlock(X, i, r, U, hots[i], gens[i]);
        if ((op + 1) % EVERY === 0) X.cp('op' + (op + 1));
    }
}

function runCscen(X, sc, seed) {
    const U = sc.U;
    const r = rng(seed * 15485863 + U);
    const ro = rng((seed * 15485863 + U) ^ 0x9e3779b9);
    const hot = () => (sc.hot === 'hi' ? [65535, 32768] : [Math.floor(r() * 4), Math.floor(r() * 4)]);
    const hots = [hot(), hot()];
    const G = (i) => () => hots[i][Math.floor(r() * hots[i].length)] * 65536 + Math.floor(r() * 65536);
    const gens = [G(0), G(1)];
    for (let i = 0; i < 2; i++) {
        try {
            for (const c of hots[i]) fillChunk(X, i, r, c);
        } catch (e) {
            if (!(e instanceof PoolStop)) throw e;
            X.clr(i);
        }
    }
    X.cp('fill');
    for (let op = 0; op < OPS; op++) {
        const i = ro() < 0.5 ? 0 : 1;
        const M = X.models[i];
        const c = hots[i][Math.floor(r() * hots[i].length)];
        const base = c * 65536;
        const roll = ro();
        let span = null;
        let opt = false;
        try {
            if (roll < 0.40) {
                span = wordSpan(r, base);
                const down = ro() < 0.5;
                for (let j = span[0]; j < span[1]; j++) X.del(i, down ? span[1] - 1 - (j - span[0]) : j);
            } else if (roll < 0.58) {
                span = wordSpan(r, base);
                const one = ro() < 0.3;
                for (let x = span[0]; x < span[1]; x += 32) {
                    const m = one ? (1 << Math.floor(r() * 32)) >>> 0 : (Math.floor(r() * 4294967296) >>> 0);
                    for (let b = 0; b < 32; b++) if ((m >>> b) & 1) X.add(i, x + b);
                }
            } else if (roll < 0.88) {
                const x = base + Math.floor(r() * 65536);
                if (ro() < 0.5) X.add(i, x);
                else X.del(i, x);
            } else if (roll < 0.92) { X.opt(i); opt = ro() < 0.3; }
            else if (roll < 0.995) { if (M.s.size < 200000) fillChunk(X, i, r, c); }
            else { X.clr(i); fillChunk(X, i, r, c); }
        } catch (e) {
            if (!(e instanceof PoolStop)) throw e;
            X.clr(i);
            span = null;
        }
        if (span !== null) spanProbe(X, i, U, span[0], span[1]);
        if (op % sc.every === 0 || op === OPS - 1 || opt) probeBlock(X, i, r, U, hots[i], gens[i]);
        if ((op + 1) % EVERY === 0) X.cp('op' + (op + 1));
    }
}

// --- targeted rows (set 0 is the subject; set 1 stays empty unless named) ----------------------

const BAD_KEYS = (U) => [-1, U, U + 0.5, 1.5, NaN, Infinity, -Infinity, '3', null, undefined, 3n, 4294967296, 2 ** 53, {}];

function fill(X, i, lo, hi, step = 1) { for (let x = lo; x < hi; x += step) X.add(i, x); }
function around(X, i, U, keys) {
    X.min(i);
    X.max(i);
    for (const k of keys) for (const q of [k - 1, k, k + 1]) X.q3(i, q);
}

export const TARGETED = [
    {
        name: 'T pool _promoteSingle (both pools empty)', U: 1 << 20, maxS: 0, maxL: 1,
        run(X) {
            X.add(0, 5); X.add(0, 6);                    // chunk 0: 2-key full array in the one large slot
            X.add(0, 65536 + 1);                         // chunk 1: SINGLE (no pool)
            X.cp('before');
            X.add(0, 65536 + 2);                         // SINGLE + 1 -> no small, no large: throws
            X.cp('after-throw');
            around(X, 0, 1 << 20, [5, 6, 65537, 65538]);
            X.del(0, 6);                                 // chunk 0 -> SINGLE, frees the large slot
            X.add(0, 65536 + 2);                         // now promotes into the freed slot
            X.cp('after-retry');
        },
    },
    {
        name: 'T pool _promoteSmallToArray (large exhausted)', U: 1 << 20, maxS: 1, maxL: 1,
        run(X) {
            fill(X, 0, 0, 64);                           // chunk 0: small array (64 keys)
            X.add(0, 65536); X.add(0, 65537);            // chunk 1: small pool empty -> the large slot
            X.cp('before');
            X.add(0, 64);                                // 65th key -> array needs a large slot: throws
            X.cp('after-throw');
            around(X, 0, 1 << 20, [0, 63, 64, 65536]);
        },
    },
    {
        name: 'T pool _deleteFull (both pools empty)', U: 1 << 20, maxS: 0, maxL: 1,
        run(X) {
            fill(X, 0, 0, 65536);                        // chunk 0 FULL
            X.opt(0);
            X.add(0, 65536 + 3); X.add(0, 65536 + 9);    // chunk 1 takes the large slot
            X.cp('before');
            X.del(0, 5);                                 // FULL minus 1 -> no slot: throws
            X.cp('after-throw');
            around(X, 0, 1 << 20, [0, 5, 65535]);
            X.del(0, 65536 + 3);                         // chunk 1 -> SINGLE, frees the slot
            X.del(0, 5);                                 // FULL delete with maxSmall 0 + a free large slot -> runs (kind 4)
            X.cp('full-delete-to-runs');
            around(X, 0, 1 << 20, [4, 5, 6]);
        },
    },
    {
        name: 'T pool _promoteSmallRunToRun (via add and via delete)', U: 1 << 20, maxS: 1, maxL: 1,
        run(X) {
            for (let i = 0; i < 32; i++) fill(X, 0, 10 * i, 10 * i + 3); // 96 keys, 32 runs -> array (kind 2)
            X.opt(0);                                    // -> small runs (kind 5), frees the slab
            X.add(0, 65536 + 1); X.add(0, 65536 + 2);    // chunk 1: small pool empty -> the large slot
            X.cp('before');
            X.add(0, 10 * 32 + 5);                       // a 33rd run -> slab needed: throws (via _addRun)
            X.cp('after-add-throw');
            X.del(0, 10 * 7 + 1);                        // splits run 7 -> 33 runs: throws (via _deleteRun)
            X.cp('after-delete-throw');
            around(X, 0, 1 << 20, [70, 71, 72, 325]);
        },
    },
    {
        name: 'T FULL chunks', U: 1 << 20, maxS: 4, maxL: 4,
        run(X) {
            fill(X, 0, 2 * 65536, 3 * 65536);            // chunk 2 filled key by key -> FULL
            X.cp('full');
            around(X, 0, 1 << 20, [2 * 65536, 2 * 65536 + 30000, 3 * 65536 - 1]);
            X.del(0, 2 * 65536);                         // lo 0 -> 1 run (small runs)
            X.cp('minus-lo0');
            X.add(0, 2 * 65536);                         // back to FULL
            X.del(0, 3 * 65536 - 1);                     // lo 65535
            X.del(0, 2 * 65536 + 30000);                 // a hole -> 2 runs
            X.cp('two-holes');
            around(X, 0, 1 << 20, [2 * 65536 + 30000, 3 * 65536 - 1]);
            X.add(0, 3 * 65536 - 1); X.add(0, 2 * 65536 + 30000);
            X.opt(0);
            X.cp('refilled-opt');
            fill(X, 1, 0, 65536, 1);                     // set 1: chunk 0 FULL through the bitmap path
            X.opt(1);
            X.cp('set1-full');
        },
    },
    {
        name: 'T runOptimize kinds 4 / 5 / back to array', U: 1 << 20, maxS: 4, maxL: 4,
        run(X) {
            fill(X, 0, 60000, 60100);                    // chunk 0: 100 keys, 1 run
            X.opt(0);                                    // -> small runs (kind 5)
            for (let j = 0; j < 40; j++) fill(X, 0, 65536 + 50 * j, 65536 + 50 * j + 10); // chunk 1: 40 runs
            X.opt(0);                                    // -> runs slab (kind 4)
            fill(X, 0, 2 * 65536, 2 * 65536 + 10000, 2); // chunk 2: 5,000 isolated keys (bitmap)
            X.opt(0);
            X.cp('opt-4-5');
            around(X, 0, 1 << 20, [60000, 60099, 65536 + 9, 65536 + 50, 2 * 65536 + 4]);
            fill(X, 1, 60000, 60100);                    // set 1: run -> array
            X.opt(1);
            fill(X, 1, 0, 600, 2);
            X.opt(1);
            X.cp('runs-to-array');
            for (let j = 0; j < 40; j++) X.del(0, 65536 + 50 * j + 5); // split runs in the slab
            fill(X, 0, 2 * 65536, 2 * 65536 + 10000);    // chunk 2 dense run
            X.opt(0);
            X.cp('opt-again');
        },
    },
    {
        // runOptimize's three conversion bounds at the tie and one key / run past it:
        // array -> runs iff 2 runs < card; runs slab -> array iff 2 card < 4 nRuns;
        // bitmap -> array iff card <= 4096 and card < 2 runs, else runs iff runs <= 2047.
        name: 'T runOptimize ties (array 2r == card, runs 2card == 4r, bitmap 2047 / 2048 runs)', U: 1 << 20, maxS: 4, maxL: 8,
        run(X) {
            for (let j = 0; j < 40; j++) fill(X, 0, 10 * j, 10 * j + 2);  // chunk 0: 40 runs x 2 = 80 keys (kind 2)
            X.opt(0);                                    // tie 80 < 80 false: stays an array
            X.cp('array-tie');
            const b1 = 65536;
            for (let j = 0; j < 40; j++) fill(X, 0, b1 + 10 * j, b1 + 10 * j + (j === 0 ? 3 : 2)); // 81 keys, 40 runs
            X.opt(0);                                    // 80 < 81: -> runs (kind 4)
            X.cp('array-81-to-runs');
            const b2 = 2 * 65536;
            for (let j = 0; j < 40; j++) fill(X, 0, b2 + 10 * j, b2 + 10 * j + 3);  // 120 keys, 40 runs
            X.opt(0);                                    // -> runs (kind 4)
            for (let j = 0; j < 40; j++) X.del(0, b2 + 10 * j + 2);               // 40 runs x 2 = 80 keys
            X.opt(0);                                    // tie 160 < 160 false: stays runs
            X.cp('runs-tie');
            X.del(0, b2 + 1);                            // 79 keys, 40 runs
            X.opt(0);                                    // 158 < 160: -> array (kind 2)
            X.cp('runs-79-to-array');
            const b3 = 3 * 65536;
            for (let j = 0; j < 2048; j++) { X.add(0, b3 + 3 * j); X.add(0, b3 + 3 * j + 1); }
            X.add(0, b3 + 3 * 2048);                     // 4,097 keys -> bitmap
            X.del(0, b3 + 3 * 2048);                     // 4,096 keys, 2,048 runs
            X.opt(0);                                    // 2048 <= 2047 false: stays a bitmap
            X.cp('bitmap-2048-runs');
            X.del(0, b3 + 3 * 2047); X.del(0, b3 + 3 * 2047 + 1); // 4,094 keys, 2,047 runs
            X.opt(0);                                    // -> runs (kind 4)
            X.cp('bitmap-2047-to-runs');
            around(X, 0, 1 << 20, [0, 11, b1, b1 + 2, b2 + 1, b2 + 2, b3 + 3 * 2047, b3 + 3 * 2046 + 1]);
        },
    },
    {
        name: 'T demote edges (DEMOTE_SMALL 32, DEMOTE_BITMAP 2048)', U: 1 << 20, maxS: 4, maxL: 4,
        run(X) {
            fill(X, 0, 0, 210, 3);                       // chunk 0: 70 keys -> full array (kind 2)
            X.cp('array-70');
            for (let k = 69; k >= 30; k--) {             // drain to 30 keys
                X.del(0, 3 * k);
                if (k <= 35) X.cp('array-' + k);
            }
            fill(X, 0, 65536, 65536 + 3 * 4100, 3);      // chunk 1: 4,100 keys -> bitmap
            X.cp('bitmap-4100');
            for (let k = 4099; k >= 2046; k--) {
                X.del(0, 65536 + 3 * k);
                if (k <= 2050) X.cp('bitmap-' + k);
            }
            around(X, 0, 1 << 20, [0, 87, 90, 65536, 65536 + 3 * 2045]);
        },
    },
    {
        name: 'T clear', U: 1 << 20, maxS: 4, maxL: 4,
        run(X) {
            fill(X, 0, 0, 9000);                         // promotions swap the spare slab
            fill(X, 0, 200000, 200070);
            X.add(0, 3 * 65536 + 7);
            fill(X, 0, 5 * 65536, 6 * 65536);
            X.opt(0);
            X.cp('built');
            X.clr(0);
            X.cp('cleared');                             // == fresh layout (set 1 is fresh)
            around(X, 0, 1 << 20, [0, 200000]);
            fill(X, 0, 100, 200);
            X.cp('rebuilt');
            X.clr(0);
            X.clr(0);
            X.cp('cleared-twice');
        },
    },
    {
        name: 'T boundary keys U=2^32', U: 4294967296, maxS: 4, maxL: 4,
        run(X) {
            const U = 4294967296;
            const ks = [0, 1, 65535, 65536, 2147483647, 2147483648, 2147483649, 4294901760, 4294967294, 4294967295];
            X.min(0); X.max(0);
            around(X, 0, U, ks);
            for (const k of ks) X.add(0, k);
            X.cp('added');
            around(X, 0, U, ks);
            for (const k of [0, 2147483648, 4294967295]) X.del(0, k);
            X.cp('deleted-edges');
            around(X, 0, U, ks);
            X.add(1, 4294967295);
            X.add(1, 2147483648);
            X.cp('set1');
            around(X, 1, U, [2147483648, 4294967295]);
        },
    },
    {
        name: 'T boundary keys U=65537', U: 65537, maxS: 2, maxL: 2,
        run(X) {
            X.add(0, 65536); X.add(0, 0); X.add(0, 65535);
            X.cp('added');
            around(X, 0, 65537, [0, 65535, 65536]);
            X.del(0, 65536);
            X.cp('deleted');
            around(X, 0, 65537, [65535, 65536]);
        },
    },
    {
        name: 'T bad keys (throwKey texts)', U: 1 << 20, maxS: 4, maxL: 4,
        run(X) {
            const U = 1 << 20;
            X.add(0, 7);
            X.add(0, -0);                                // -0 is key 0
            for (const k of BAD_KEYS(U)) {
                X.add(0, k);                             // throws throwKey's text
                X.has(0, k);
                X.del(0, k);
                X.succ(0, k);
                X.pred(0, k);
            }
            X.cp('bad');
            X.add(1, U - 1);
            X.add(1, U);                                 // throws
            X.succ(1, U - 1); X.pred(1, U);
            X.cp('edge');
        },
    },
    {
        name: 'T bad keys U=2^32', U: 4294967296, maxS: 1, maxL: 1,
        run(X) {
            for (const k of [4294967296, -1, 4294967295.5, 2 ** 53, -(2 ** 31)]) {
                X.add(0, k);
                X.has(0, k);
                X.del(0, k);
                X.succ(0, k);
                X.pred(0, k);
            }
            X.add(0, 4294967295);
            X.cp('bad');
        },
    },
];

// --- rows --------------------------------------------------------------------------------------

/** Every row descriptor, in vector-file order. */
export function allRows() {
    const out = [];
    for (const [fam, list] of [['SCEN', SCEN], ['RSCEN', RSCEN], ['CSCEN', CSCEN]]) {
        for (const sc of list) {
            for (const seed of SEEDS) {
                out.push({ name: sc.name + ' / seed ' + seed, family: fam, U: sc.U, maxS: sc.maxS, maxL: sc.maxL, seed, sc });
            }
        }
    }
    for (const t of TARGETED) out.push({ name: t.name, family: 'T', U: t.U, maxS: t.maxS, maxL: t.maxL, seed: null, t });
    return out;
}

/**
 * Replays row d on class Cls. rowOf(s, c) is REQUIRED (ROW_DIRECT for the draft, ROW_MI
 * for the shipped engine). opts: { oracle, qBytes (bytes byteLength sheds; the draft's
 * `_q`: 24, the shipped engine: 0) }. Returns { row, fault }.
 */
export function runRow(d, Cls, rowOf, opts = {}) {
    if (typeof rowOf !== 'function') throw new TypeError('roaringStream.runRow: rowOf must be a function (ROW_DIRECT / ROW_MI)');
    const oracle = opts.oracle === true;
    const qBytes = opts.qBytes === undefined ? 0 : opts.qBytes;
    const X = makeCtx(Cls, rowOf, d, oracle, d.family !== 'T');
    const S0 = X.sets[0];
    if (qBytes !== 0 && !(S0._q instanceof Int32Array && S0._q.byteLength === qBytes)) {
        throw new Error('roaringStream: qBytes ' + qBytes + ' but the module has no Int32Array _q of that size');
    }
    const row = {
        name: d.name, family: d.family, U: d.U, maxS: d.maxS, maxL: d.maxL, seed: d.seed,
        byteLength: S0.byteLength - qBytes, ops: 0, checkpoints: [],
    };
    let fault = null;
    try {
        if (d.family === 'SCEN') runScen(X, d.sc, d.seed);
        else if (d.family === 'RSCEN') runRscen(X, d.sc, d.seed);
        else if (d.family === 'CSCEN') runCscen(X, d.sc, d.seed);
        else d.t.run(X);
        if (X.cps.length === 0 || X.cps[X.cps.length - 1].n !== X.n) X.cp('end');
        fault = X.fault;
    } catch (e) {
        fault = 'replay threw ' + String(e && e.stack ? e.stack : e);
    }
    row.ops = X.n;
    row.checkpoints = X.cps;
    return { row, fault };
}

export const CP_FIELDS = ['id', 'n', 'a', 'b'];
export const ROW_FIELDS = ['name', 'family', 'U', 'maxS', 'maxL', 'seed', 'byteLength', 'ops'];

/**
 * First difference of row a against the vector row b, or null. fields = the checkpoint
 * fields compared (G2 on paged sets passes ['id', 'n', 'a']).
 */
export function firstDiff(a, b, fields = CP_FIELDS) {
    for (const k of ROW_FIELDS) {
        if (k === 'byteLength' && !fields.includes('b')) continue;
        if (a[k] !== b[k]) return { cp: null, field: k, got: a[k], want: b[k] };
    }
    const n = Math.min(a.checkpoints.length, b.checkpoints.length);
    for (let i = 0; i < n; i++) {
        const x = a.checkpoints[i];
        const y = b.checkpoints[i];
        for (const f of fields) {
            if (x[f] !== y[f]) return { cp: b.name + ' @ ' + y.id, field: f, got: x[f], want: y[f], n: y.n };
        }
        if (x.size[0] !== y.size[0] || x.size[1] !== y.size[1]) {
            return { cp: b.name + ' @ ' + y.id, field: 'size', got: x.size, want: y.size, n: y.n };
        }
    }
    if (a.checkpoints.length !== b.checkpoints.length) {
        return { cp: null, field: 'checkpoints.length', got: a.checkpoints.length, want: b.checkpoints.length };
    }
    return null;
}

export function formatJson(v, ind = '') {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const in2 = ind + '  ';
    if (Array.isArray(v)) {
        if (v.every((e) => e === null || typeof e !== 'object')) return '[' + v.map((e) => JSON.stringify(e)).join(', ') + ']';
        if (v.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e) &&
            Object.keys(e).every((k) => e[k] === null || typeof e[k] !== 'object' ||
                (Array.isArray(e[k]) && e[k].every((z) => z === null || typeof z !== 'object'))))) {
            return '[\n' + v.map((e) => in2 + JSON.stringify(e)).join(',\n') + '\n' + ind + ']';
        }
        return '[\n' + v.map((e) => in2 + formatJson(e, in2)).join(',\n') + '\n' + ind + ']';
    }
    const ks = Object.keys(v);
    return '{\n' + ks.map((k) => in2 + JSON.stringify(k) + ': ' + formatJson(v[k], in2)).join(',\n') + '\n' + ind + '}';
}

/** The vector document around rows (in allRows() order). */
export function vectorDoc(rows) {
    return {
        what: 'lite-loglogn RoaringSet G1 vectors (PLAN-roaringset-G1 task 3 / S-4), cut from .handoff/research/roaring/RoaringDraft.best.mjs',
        cutFrom: 'RoaringDraft.best.mjs sha256/8 ' + DRAFT_SHA8,
        streamVersion: ROARING_STREAM_VERSION,
        seeds: SEEDS,
        ops: OPS,
        every: EVERY,
        byteLength: 'shipped = draft - ' + Q_BYTES + ' (C-3: `_q` dropped)',
        a: 'sha256/8 of Part A (rh, op count, per set: size, pool tops, live free lists, _conv, sha256(_top), live chunks [c, kind, slot, card, runs, cMin, cMax, sha256(container)] read at rowOf(s, c))',
        b: 'sha256/8 of Part B (direct only: sha256 of _kind, _slot, _card, _runs, _cMin, _cMax, _sData, _sFree, _lU16, _bSum, _lFree)',
        rh: 'FNV-1a 32 running; tags 1 undef, 2 false, 3 true, 4 + uint32, 5 this, 6 + typeof, 9 + String(n), 7 + name 0 message (throws)',
        rows,
    };
}

/** The vector document of every row replayed on Cls (throws on the first fault). */
export function buildVectors(Cls, rowOf, opts = {}) {
    const rows = [];
    for (const d of allRows()) {
        const { row, fault } = runRow(d, Cls, rowOf, opts);
        if (fault !== null) throw new Error('roaringStream ' + d.name + ': ' + fault);
        rows.push(row);
    }
    return vectorDoc(rows);
}

/** The exact text of test/vectors/roaring-g1.json for (Cls, rowOf, opts). */
export function vectorsText(Cls, rowOf, opts) {
    return formatJson(buildVectors(Cls, rowOf, opts)) + '\n';
}

export const VECTOR_PATH = fileURLToPath(new URL('../vectors/roaring-g1.json', import.meta.url));

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const at = process.argv.indexOf('--cut');
    if (at < 0 || process.argv[at + 1] === undefined) {
        process.stderr.write('usage: node test/helpers/roaringStream.mjs --cut <RoaringDraft.best.mjs>\n');
        process.exit(2);
    }
    const path = resolve(process.argv[at + 1]);
    const sha8 = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8);
    if (sha8 !== DRAFT_SHA8) {
        process.stderr.write('roaringStream --cut REFUSED: ' + path + ' sha256/8 ' + sha8 + ' (need ' + DRAFT_SHA8 + ')\n');
        process.exit(1);
    }
    const { RoaringSet } = await import(pathToFileURL(path).href);
    let text;
    try {
        text = vectorsText(RoaringSet, ROW_DIRECT, { oracle: true, qBytes: Q_BYTES });
    } catch (e) {
        process.stderr.write('roaringStream --cut ABORT: ' + String(e && e.message) + '\n');
        process.exit(1);
    }
    writeFileSync(VECTOR_PATH, text);
    process.stdout.write('wrote ' + VECTOR_PATH + ' (' + text.length + ' B, sha256/8 ' +
        createHash('sha256').update(text).digest('hex').slice(0, 8) + ')\n');
}
