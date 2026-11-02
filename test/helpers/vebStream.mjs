/**
 * @zakkster/lite-loglogn -- vEBTree op streams + vectors (0.5.0 G1-B1, PLAN-vebtree
 * task 2). Test helper, not a test file. Zero deps; imports VebRef (the independent
 * reference) only -- never LogLogN.js, so an engine edit cannot move the vectors.
 *
 * Streams (every one deterministic, a function of its descriptor only):
 *   random -- one per universe in UNIVERSES (12): seed = SEED_RULE(index), nOps by
 *     opsFor(U). Phases of PHASE ops cycle grow / mixed / drain / sparse (op weights
 *     in WEIGHTS; sparse keeps the set small and is predecessor-heavy, so predecessor
 *     answers by a min in another root cluster occur -- VebRef.test.js gates >= 20 per
 *     row of each coverage counter). Two PRNG streams: rOp = mulberry32(seed) picks the
 *     op and every gate on it; rKey = mulberry32(seed ^ 0x85ebca6b) makes every key
 *     draw. Keys: 15% uniform; 30% a block boundary (block B in {32, 256, 2^16,
 *     2^lo(root)} below U, offset 0 / 1 / B-1 / B-2); 10% an end (0, 1, U-2, U-1);
 *     15% a lone key in a random root cluster (singleton clusters); 30% a fixed
 *     48-key pool (re-hits, so clusters fill, empty and refill). Deletes in the
 *     mixed / drain / sparse phases pick a PRESENT key 85% of the time (the set drains to
 *     empty); queries pick a present key (or one off it by +-1) 30% of the time.
 *     2% of key-taking ops use a bad-key token (BAD_KEYS); 5% of key-0 picks are -0.
 *   trace -- named boundary traces: singles-<U> (single key 0 / mid / U-1, then the
 *     pair {0, U-1}: has / successor / predecessor around each key and past both
 *     ends, delete twice) at TRACE_SINGLE_U; full-<U> (the whole universe added
 *     ascending, every successor / predecessor / has, evens deleted ascending, odds
 *     descending) at U = 2, 3, 256.
 *
 * Checkpoint: after every EVERY-th op, after every trace PHASE mark (singles: after each
 *   probe block, so the empty / {0} / {mid} / {U-1} / {0, U-1} layouts are pinned; full:
 *   after the fill, after the evens are gone, after the odds are gone) AND after the last
 *   op -- one checkpoint per op index at most:
 *   { at (ops done), resultsHash, size, min, max (null = undefined), words
 *     (serialize().length), layoutHash }.
 *   resultsHash -- FNV-1a 32 over op results, running: per op one tag byte
 *     (1 undefined, 2 false, 3 true, 4 number + its uint32 as 4 LE bytes, 5 the
 *     instance itself, 6 any other value, 7 RangeError thrown, 8 any other throw).
 *   layoutHash -- sha256 hex of the serialize() words as 4-byte LITTLE-ENDIAN
 *     uint32s (the module refuses a big-endian host). Every checkpoint carries it,
 *     at every universe (2^25 = 1,053,717 words: ~10 ms per serialize + hash).
 * Row: { name, kind, U, w, seed (null for traces), nOps, byteLength (4 x words),
 *   maxSize, drains (non-empty -> empty transitions), checkpoints }.
 *
 * runRow(desc, opts) replays one stream on a VebRef (or opts.Ref, a mutant
 *   subclass) and, per opts, in lockstep with SetOracle (the TRUE definition: a JS
 *   Set + linear scans) and the research sketch (U <= SKETCH_MAX_U), the invariant
 *   checker after every op (inv: 'op') or every checkpoint (inv: 'cp'), and the flat
 *   decoder at every checkpoint (decode: true). Returns { row, fault } -- fault is
 *   null or a description of the FIRST disagreement (the replay stops there).
 *
 * CLI: node test/helpers/vebStream.mjs --cut > test/vectors/veb-g1.json
 *   ABORTS (exit 1, nothing on stdout) on any fault with every oracle on.
 */

import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { pathToFileURL } from 'node:url';
import { VebRef, checkRef, decodeFlat, bitsOf, splitLo } from './vebRef.mjs';
import { vEBTree as Sketch } from './vebSketch.mjs';

if (endianness() !== 'LE') throw new Error('vebStream: layoutHash is defined over little-endian words');

export const VEB_STREAM_VERSION = 1;
export const EVERY = 500;
export const PHASE = 1000;
export const BASE_SEED = 0x7eb9e100;
export const SEED_RULE = '(BASE_SEED + imul(index + 1, 0x9e3779b9)) >>> 0';
export const SKETCH_MAX_U = 16777216;
export const UNIVERSES = [2, 3, 256, 257, 512, 1024, 65536, 131072, 131075, 16777216, 16777217, 33554432];
export const TRACE_SINGLE_U = [2, 3, 256, 257, 65536, 131075, 16777217, 33554432];
export const TRACE_FULL_U = [2, 3, 256];

export const OP_ADD = 0;
export const OP_DELETE = 1;
export const OP_HAS = 2;
export const OP_SUCC = 3;
export const OP_PRED = 4;
export const OP_MIN = 5;
export const OP_MAX = 6;
export const OP_NAMES = ['add', 'delete', 'has', 'successor', 'predecessor', 'min', 'max'];

/** Per phase (grow, mixed, drain, sparse): weights of add, delete, has, succ, pred, min, max. */
export const WEIGHTS = [
    [50, 10, 10, 12, 12, 3, 3],
    [30, 30, 10, 12, 12, 3, 3],
    [8, 52, 10, 12, 12, 3, 3],
    [20, 20, 5, 15, 30, 5, 5],
];

/** Op count of the random stream at U. */
export function opsFor(U) {
    if (U <= 1024) return 20000;
    if (U <= 131075) return 12000;
    return 8000;
}

export function streamSeed(i) {
    return (BASE_SEED + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
}

/** Bad-key tokens (never a key: has / delete false, succ / pred undefined, add throws). */
export function badKeys(U) {
    return [-1, U, U + 0.5, NaN, '3', 4294967296, 1.5, Infinity, -Infinity,
        null, undefined, 3n, 2 ** 53];
}

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

export function fnvByte(h, byte) {
    return Math.imul(h ^ (byte & 255), FNV_PRIME) >>> 0;
}

export function fnvWord(h, w) {
    h = fnvByte(h, w);
    h = fnvByte(h, w >>> 8);
    h = fnvByte(h, w >>> 16);
    return fnvByte(h, w >>> 24);
}

export function hex32(h) {
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Folds one op result (tags in the header). */
export function foldResult(h, ret, inst) {
    if (ret === undefined) return fnvByte(h, 1);
    if (ret === false) return fnvByte(h, 2);
    if (ret === true) return fnvByte(h, 3);
    if (typeof ret === 'number') return fnvWord(fnvByte(h, 4), ret >>> 0);
    if (ret === inst) return fnvByte(h, 5);
    return fnvByte(h, 6);
}

export function foldThrow(h, e) {
    return fnvByte(h, e instanceof RangeError ? 7 : 8);
}

/** sha256 hex of a Uint32Array's bytes (little-endian host). */
export function layoutHash(words) {
    return createHash('sha256')
        .update(new Uint8Array(words.buffer, words.byteOffset, words.byteLength))
        .digest('hex');
}

// --- the true definition ------------------------------------------------------------------

/** A JS Set + linear scans; same contract as VebRef / YFastTrie. */
export class SetOracle {
    constructor(universe) {
        this._u = universe;
        this._s = new Set();
    }
    get size() { return this._s.size; }
    _ok(x) { return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < this._u; }
    has(x) { return this._ok(x) && this._s.has(x); }
    add(x) {
        if (!this._ok(x)) throw new RangeError('[set-oracle] bad key');
        this._s.add(x + 0);
        return this;
    }
    delete(x) { return this._ok(x) && this._s.delete(x); }
    successor(x) {
        if (!this._ok(x)) return undefined;
        let r;
        for (const k of this._s) if (k > x && (r === undefined || k < r)) r = k;
        return r;
    }
    predecessor(x) {
        if (!this._ok(x)) return undefined;
        let r;
        for (const k of this._s) if (k < x && (r === undefined || k > r)) r = k;
        return r;
    }
    min() {
        let r;
        for (const k of this._s) if (r === undefined || k < r) r = k;
        return r;
    }
    max() {
        let r;
        for (const k of this._s) if (r === undefined || k > r) r = k;
        return r;
    }
    keys() { return [...this._s].sort((a, b) => a - b); }
}

// --- streams ---------------------------------------------------------------------------------

/** Ops + keys of the seeded random stream at U (key undefined for min / max). */
export function genStream(U, nOps, seed) {
    // Two PRNG streams: rOp decides the op and every gate on it (bad key, present-delete,
    // near-present query, -0); rKey makes every key draw (drawRaw, the pool, the picks).
    const rOp = mulberry32(seed);
    const rKey = mulberry32((seed ^ 0x85ebca6b) >>> 0);
    const ro = (n) => Math.floor(rOp() * n);
    const ri = (n) => Math.floor(rKey() * n);
    const w = bitsOf(U);
    const BAD = badKeys(U);
    const rootB = w <= 8 ? 0 : 2 ** splitLo(w);
    const blocks = [32, 256, 65536, rootB].filter((B, i, a) => B > 0 && B < U && a.indexOf(B) === i);
    const clampKey = (k) => (k < 0 ? 0 : k >= U ? U - 1 : k);
    const drawRaw = () => {
        const r = rKey();
        if (r < 0.15) return ri(U);
        if (r < 0.45 && blocks.length > 0) {
            const B = blocks[ri(blocks.length)];
            const b = ri(Math.ceil(U / B));
            const off = [0, 1, B - 1, B - 2][ri(4)];
            return clampKey(b * B + off);
        }
        if (r < 0.55) return clampKey([0, 1, U - 2, U - 1][ri(4)]);
        if (r < 0.70 && rootB > 0) return clampKey(ri(Math.ceil(U / rootB)) * rootB + ri(rootB));
        return -1;
    };
    const pool = [];
    while (pool.length < 48) {
        const k = drawRaw();
        if (k >= 0) pool.push(k);
    }
    const drawKey = () => {
        const k = drawRaw();
        return k >= 0 ? k : pool[ri(pool.length)];
    };
    const present = [];
    const where = new Map();
    const op = [];
    const key = [];
    for (let i = 0; i < nOps; i++) {
        const wt = WEIGHTS[Math.floor(i / PHASE) % WEIGHTS.length];
        let r = ro(100);
        let o = 0;
        while (r >= wt[o]) r -= wt[o++];
        let x;
        if (o === OP_MIN || o === OP_MAX) {
            x = undefined;
        } else if (rOp() < 0.02) {
            x = BAD[ri(BAD.length)];
        } else if (o === OP_DELETE && wt[1] >= 20 && present.length > 0 && rOp() < 0.85) {
            x = present[ri(present.length)];
        } else if (o >= OP_HAS && present.length > 0 && rOp() < 0.3) {
            x = clampKey(present[ri(present.length)] + ri(3) - 1);
        } else {
            x = drawKey();
        }
        if (x === 0 && rOp() < 0.05) x = -0;
        op.push(o);
        key.push(x);
        // track the true set (generation only)
        const ok = typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < U;
        if (ok && o === OP_ADD && !where.has(x + 0)) {
            where.set(x + 0, present.length);
            present.push(x + 0);
        } else if (ok && o === OP_DELETE && where.has(x + 0)) {
            const at = where.get(x + 0);
            const last = present.pop();
            where.delete(x + 0);
            if (last !== x + 0) {
                present[at] = last;
                where.set(last, at);
            }
        }
    }
    return { op, key, marks: [] };
}

/** The named single-key / pair trace at U. */
export function singlesTrace(U) {
    const op = [];
    const key = [];
    const marks = [];
    const put = (o, x) => {
        op.push(o);
        key.push(x);
    };
    const around = (k) => {
        for (const q of [k - 1, k, k + 1]) {
            put(OP_HAS, q);
            put(OP_SUCC, q);
            put(OP_PRED, q);
        }
        put(OP_SUCC, 0);
        put(OP_PRED, 0);
        put(OP_SUCC, U - 1);
        put(OP_PRED, U - 1);
        put(OP_SUCC, U);
        put(OP_PRED, U);
        put(OP_MIN);
        put(OP_MAX);
        marks.push(op.length); // phase checkpoint: the layout this around() probed
    };
    put(OP_MIN);
    put(OP_MAX);
    around(0);
    for (const k of [0, Math.floor(U / 2), U - 1]) {
        put(OP_ADD, k);
        put(OP_ADD, k);
        around(k);
        put(OP_DELETE, k);
        around(k);
        put(OP_DELETE, k);
    }
    put(OP_ADD, 0);
    put(OP_ADD, U - 1);
    around(0);
    around(U - 1);
    put(OP_DELETE, 0);
    around(U - 1);
    put(OP_ADD, 0);
    put(OP_DELETE, U - 1);
    around(0);
    put(OP_DELETE, 0);
    put(OP_DELETE, U - 1);
    put(OP_MIN);
    put(OP_MAX);
    return { op, key, marks };
}

/** The named full-universe trace at U. */
export function fullTrace(U) {
    const op = [];
    const key = [];
    const marks = [];
    const put = (o, x) => {
        op.push(o);
        key.push(x);
    };
    for (let k = 0; k < U; k++) put(OP_ADD, k);
    put(OP_MIN);
    put(OP_MAX);
    marks.push(op.length); // phase checkpoint: the full universe
    for (let k = 0; k < U; k++) {
        put(OP_HAS, k);
        put(OP_SUCC, k);
        put(OP_PRED, k);
    }
    put(OP_SUCC, U);
    put(OP_PRED, U);
    for (let k = 0; k < U; k += 2) {
        put(OP_DELETE, k);
        put(OP_SUCC, k);
        put(OP_PRED, k);
        put(OP_MIN);
        put(OP_MAX);
    }
    marks.push(op.length); // phase checkpoint: odds only
    for (let k = U - 1; k >= 0; k--) {
        if ((k & 1) === 0) continue;
        put(OP_DELETE, k);
        put(OP_SUCC, k);
        put(OP_PRED, k);
        put(OP_MIN);
        put(OP_MAX);
    }
    marks.push(op.length); // phase checkpoint: empty again
    for (let k = 0; k < U; k++) put(OP_HAS, k);
    return { op, key, marks };
}

/** Every stream descriptor, in vector-file order. */
export function allStreams() {
    const out = [];
    UNIVERSES.forEach((U, i) => {
        out.push({ name: 'random-' + U, kind: 'random', U, seed: streamSeed(i), nOps: opsFor(U) });
    });
    for (const U of TRACE_SINGLE_U) out.push({ name: 'singles-' + U, kind: 'trace', U, seed: null });
    for (const U of TRACE_FULL_U) out.push({ name: 'full-' + U, kind: 'trace', U, seed: null });
    return out;
}

/** The op / key arrays of a descriptor. */
export function streamOf(d) {
    if (d.kind === 'random') return genStream(d.U, d.nOps, d.seed);
    if (d.name.startsWith('singles-')) return singlesTrace(d.U);
    return fullTrace(d.U);
}

export function applyOp(inst, o, x) {
    if (o === OP_ADD) return inst.add(x);
    if (o === OP_DELETE) return inst.delete(x);
    if (o === OP_HAS) return inst.has(x);
    if (o === OP_SUCC) return inst.successor(x);
    if (o === OP_PRED) return inst.predecessor(x);
    if (o === OP_MIN) return inst.min();
    return inst.max();
}

/** Comparable tag of one op outcome. */
export function outcome(inst, o, x) {
    try {
        const r = applyOp(inst, o, x);
        if (r === inst) return 'this';
        if (typeof r === 'number') return Object.is(r, -0) ? 'n:-0' : 'n:' + r;
        return typeof r === 'boolean' ? 'b:' + r : typeof r;
    } catch (e) {
        return e instanceof RangeError ? 'throw:RangeError' : 'throw:' + String(e && e.name);
    }
}

function keyText(x) {
    if (typeof x === 'bigint') return x + 'n';
    if (typeof x === 'string') return JSON.stringify(x);
    return Object.is(x, -0) ? '-0' : String(x);
}

/** Checkpoint of ref (see the header). */
export function checkpoint(ref, at, rh) {
    const words = ref.serialize();
    const mn = ref.min();
    const mx = ref.max();
    return {
        at,
        resultsHash: hex32(rh),
        size: ref.size,
        min: mn === undefined ? null : mn,
        max: mx === undefined ? null : mx,
        words: words.length,
        layoutHash: layoutHash(words),
    };
}

/**
 * Replays descriptor d. opts: { Ref (default VebRef), set, sketch, inv ('op' | 'cp' |
 * false), decode }. Returns { row, fault }.
 */
export function runRow(d, opts = {}) {
    const Ref = opts.Ref || VebRef;
    const U = d.U;
    const st = streamOf(d);
    const marks = new Set(st.marks);
    const nOps = st.op.length;
    const ref = new Ref(U);
    const set = opts.set ? new SetOracle(U) : null;
    const sk = opts.sketch && U <= SKETCH_MAX_U ? new Sketch(U) : null;
    const row = {
        name: d.name, kind: d.kind, U, w: bitsOf(U), seed: d.seed, nOps,
        byteLength: 0, maxSize: 0, drains: 0, checkpoints: [],
    };
    let fault = null;
    let rh = FNV_OFFSET;
    let lastSize = 0;
    const fail = (i, what) => 'op ' + i + ' (' + OP_NAMES[st.op[i]] + ' ' + keyText(st.key[i]) + '): ' + what;
    try {
        row.byteLength = 4 * ref.words();
        for (let i = 0; i < nOps; i++) {
            const o = st.op[i];
            const x = st.key[i];
            let ret;
            let tag;
            try {
                ret = applyOp(ref, o, x);
                rh = foldResult(rh, ret, ref);
                tag = ret === ref ? 'this' : typeof ret === 'number'
                    ? (Object.is(ret, -0) ? 'n:-0' : 'n:' + ret)
                    : typeof ret === 'boolean' ? 'b:' + ret : typeof ret;
            } catch (e) {
                rh = foldThrow(rh, e);
                tag = e instanceof RangeError ? 'throw:RangeError' : 'throw:' + String(e && e.name);
            }
            if (set !== null) {
                const t2 = outcome(set, o, x);
                if (t2 !== tag) { fault = fail(i, 'ref ' + tag + ' vs set ' + t2); break; }
                if (ref.size !== set.size) { fault = fail(i, 'size ' + ref.size + ' vs set ' + set.size); break; }
            }
            if (sk !== null) {
                const t3 = outcome(sk, o, x);
                if (t3 !== tag) { fault = fail(i, 'ref ' + tag + ' vs sketch ' + t3); break; }
                if (ref.size !== sk.size) { fault = fail(i, 'size ' + ref.size + ' vs sketch ' + sk.size); break; }
            }
            const sz = ref.size;
            if (sz > row.maxSize) row.maxSize = sz;
            if (sz === 0 && lastSize > 0) row.drains++;
            lastSize = sz;
            const isCp = (i + 1) % EVERY === 0 || i === nOps - 1 || marks.has(i + 1);
            if (opts.inv === 'op' || (opts.inv === 'cp' && isCp)) {
                const bad = checkRef(ref);
                if (bad !== null) { fault = fail(i, 'invariant ' + bad); break; }
            }
            if (isCp) {
                const cp = checkpoint(ref, i + 1, rh);
                row.checkpoints.push(cp);
                if (cp.words * 4 !== row.byteLength) {
                    fault = fail(i, 'words ' + cp.words + ' vs byteLength ' + row.byteLength);
                    break;
                }
                if (opts.decode) {
                    const dec = decodeFlat(ref.serialize(), U);
                    if (dec.error !== undefined) { fault = fail(i, 'decode ' + dec.error); break; }
                    const want = set !== null ? set.keys() : ref.keys();
                    if (dec.keys.join(',') !== want.join(',')) { fault = fail(i, 'decoded keys differ'); break; }
                }
            }
        }
    } catch (e) {
        fault = 'reference threw ' + String(e && e.name) + ': ' + String(e && e.message);
    }
    return { row, fault };
}

/** Every row (throws on the first fault when opts asks for any oracle). */
export function buildVectors(opts = { set: true, sketch: true, inv: 'cp', decode: true }) {
    const rows = [];
    for (const d of allStreams()) {
        const { row, fault } = runRow(d, opts);
        if (fault !== null) throw new Error('vebStream ' + d.name + ': ' + fault);
        rows.push(row);
    }
    return {
        what: 'lite-loglogn vEBTree G1 vectors (PLAN-vebtree task 2), cut from test/helpers/vebRef.mjs',
        streamVersion: VEB_STREAM_VERSION,
        every: EVERY,
        phase: PHASE,
        baseSeed: BASE_SEED,
        seedRule: SEED_RULE,
        layoutHash: 'sha256 hex of serialize() as little-endian uint32 words (C-10 / C-13 layout)',
        resultsHash: 'FNV-1a 32, running; tags 1 undef, 2 false, 3 true, 4 + uint32 number, 5 this, 6 other, 7 RangeError, 8 other throw',
        universes: UNIVERSES,
        rows,
    };
}

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
    if (ks.every((k) => v[k] === null || typeof v[k] !== 'object')) {
        return '{ ' + ks.map((k) => JSON.stringify(k) + ': ' + JSON.stringify(v[k])).join(', ') + ' }';
    }
    return '{\n' + ks.map((k) => in2 + JSON.stringify(k) + ': ' + formatJson(v[k], in2)).join(',\n') +
        '\n' + ind + '}';
}

/** The exact text of test/vectors/veb-g1.json. */
export function vectorsText(opts) {
    return formatJson(buildVectors(opts)) + '\n';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!process.argv.includes('--cut')) {
        process.stderr.write('usage: node test/helpers/vebStream.mjs --cut > test/vectors/veb-g1.json\n');
        process.exit(2);
    }
    let text;
    try {
        text = vectorsText();
    } catch (e) {
        process.stderr.write('vebStream --cut ABORT: ' + String(e && e.message) + '\n');
        process.exit(1);
    }
    process.stdout.write(text);
}
