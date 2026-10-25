/**
 * @zakkster/lite-loglogn -- YFastTrie space tests (PLAN-yfasttrie G2-2; C-3 / C-12;
 * A1 / A2: this file owns every YFastTrie byteLength pin).
 *
 * The model is test/helpers/yftSpace.mjs, written from the SPEC (never read
 * back from an instance):
 *   w = ceil(log2 U), K = 2w, h = ceil(w/2), Cr = min(2 + floor(C/h), U);
 *   byteLength = 4 (Cr+1) K + (Cr+1) + 16 + XFastTrie(U, Cr).byteLength.
 * Pins: literal numbers, checked on constructed instances AND against the model;
 * (2^32, 2^24) = 663,749,975 B is formula-only (never allocated). byteLength also
 * equals the sum of every typed-array column, own + inner (a walk of the
 * instance's fields, so a new column is caught). Control repAtC (inner trie
 * sized at C) must mismatch every pin with C != Cr; control ExtraColYft must
 * break the column sum.
 *
 * O(n) (A2): A -- at fixed C the bytes are flat in U (max/min <= 2.0 over
 * U = 2^16..2^32); control xftSized (a plain XFastTrie(U, C), O(n w)) must fail
 * it. B -- at fixed U the bytes are linear in C (bytes(4C)/bytes(C) in
 * [3.0, 5.0]); control sbSized (bytes independent of C) must fail it.
 *
 * After 1e5 seeded fill / drain ops in a Worker (>= 100 splits AND >= 100
 * merges, read from `_n`), byteLength and the identity of all 12 typed-array
 * columns (own _bk _bn _n; inner _x._lv .. _x._q) and of their buffers are
 * unchanged. Controls GrowingYft (`_split` reallocates `_bk` at the same
 * length: identity only) and ExtraColYft (`_split` adds a typed column: the
 * column set) must be detected.
 *
 * HANG RULE: the ops bodies run successor / predecessor, so they execute in a
 * node:worker_threads Worker with a kill timer (KILL_MS < the test timeout); a
 * hang, a worker error, a nonzero exit or a missing result FAILS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { YFastTrie } from '../LogLogN.js';
import { bitsOf, yftParams, yftBytes, repAtC, xftSized, sbSized } from './helpers/yftSpace.mjs';

const T = { timeout: 120000 };
const KILL_MS = 100000;
const LIB_URL = new URL('../LogLogN.js', import.meta.url).href;

// mulberry32: 32-bit-exact seeded PRNG.
function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// [U, C, byteLength] -- literal pins (constructed).
const PINS = [
    [2, 1, 231],
    [16, 16, 1231],
    [1000, 1000, 35727],
    [65536, 1024, 55383],
    [65536, 4096, 192727],
    [1048576, 16384, 603749],
    [1048576, 262144, 7943781],
    [4294967296, 2, 4695],
    [4294967296, 65536, 3446103],
];
const FORMULA_ONLY = [[4294967296, 16777216, 663749975]];

// Every typed-array field reachable from the instance (own + nested objects),
// as [path, array]. A field that is neither a typed array nor an object is skipped.
function columns(obj, path, out, seen) {
    seen.add(obj);
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (ArrayBuffer.isView(v)) out.push([path + k, v]);
        else if (v !== null && typeof v === 'object' && !seen.has(v)) columns(v, path + k + '.', out, seen);
    }
    return out;
}

function columnSum(s) {
    let sum = 0;
    const cols = columns(s, '', [], new Set());
    for (const [, a] of cols) sum += a.byteLength;
    return { sum, n: cols.length, names: cols.map((c) => c[0]).sort().join() };
}

const COL_NAMES = '_bk,_bn,_n,_x._key,_x._lv,_x._next,_x._occ,_x._prev,_x._q,_x._tk,_x._tmax,_x._tmin';

// --- worker (hang-safe, self-contained eval body) ---------------------------------

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const assert = require('node:assert/strict');
import(workerData.lib).then((m) => {
    let msg;
    try {
        const fn = (0, eval)('"use strict"; (' + workerData.src + ')');
        if (typeof fn !== 'function') throw new TypeError('worker body is not a function');
        const result = fn({ YFastTrie: m.YFastTrie, assert });
        if (result === null || typeof result !== 'object') throw new TypeError('worker body must return a result object');
        msg = { ok: true, result };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}, (e) => {
    parentPort.postMessage({ ok: false, message: 'import failed: ' + String(e && e.stack ? e.stack : e) });
});
`;

// Never rejects: resolves { result, error }; error is a string on a hang /
// worker error / nonzero exit / body failure / missing result, else null.
function startFn(fn, label) {
    const src = fn.toString();
    return new Promise((resolve) => {
        let msg = null;
        let done = false;
        const w = new Worker(WORKER_SRC, { eval: true, workerData: { lib: LIB_URL, src } });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error === null && msg === null) error = label + ': worker posted no result';
            if (error === null && msg.ok !== true) error = label + ': ' + String(msg.message);
            resolve({ result: error === null ? msg.result : null, error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + KILL_MS + ' ms: ' + label + ' worker terminated');
        }, KILL_MS);
        w.on('message', (m) => { msg = m; });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

async function expectFn(job) {
    const r = await job;
    if (r.error !== null) assert.fail(r.error);
    return r.result;
}

// COMMON is prepended as source text; bodies are built with new Function.
const COMMON = `
const YFastTrie = env.YFastTrie, assert = env.assert;
const OWN = ['_bk', '_bn', '_n'];
const INNER = ['_lv', '_occ', '_tk', '_tmin', '_tmax', '_key', '_next', '_prev', '_q'];
function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function fieldSet(o) {
    return Object.keys(o).filter((k) => ArrayBuffer.isView(o[k])).sort().join();
}
function snap(s) {
    const cols = [];
    for (const k of OWN) cols.push({ k, o: s, a: s[k], buf: s[k].buffer, bytes: s[k].byteLength });
    for (const k of INNER) cols.push({ k: '_x.' + k, o: s._x, a: s._x[k], buf: s._x[k].buffer, bytes: s._x[k].byteLength });
    return { byteLength: s.byteLength, x: s._x, cols };
}
// Returns { err, compared }: err null when space is unchanged, else a failure
// string; compared = the number of columns checked (coverage floor: 12).
function spaceCheck(s, ref) {
    if (fieldSet(s) !== OWN.slice().sort().join()) return { err: 'typed-array field set ' + fieldSet(s), compared: 0 };
    if (s._x !== ref.x) return { err: '_x object replaced', compared: 0 };
    if (fieldSet(s._x) !== INNER.slice().sort().join()) return { err: 'inner typed-array field set ' + fieldSet(s._x), compared: 0 };
    if (s.byteLength !== ref.byteLength) return { err: 'byteLength ' + ref.byteLength + ' -> ' + s.byteLength, compared: 0 };
    let compared = 0;
    for (const c of ref.cols) {
        const a = c.o[c.k.startsWith('_x.') ? c.k.slice(3) : c.k];
        if (a !== c.a) return { err: c.k + ' object replaced', compared };
        if (a.buffer !== c.buf) return { err: c.k + '.buffer replaced', compared };
        if (a.byteLength !== c.bytes) return { err: c.k + '.byteLength ' + c.bytes + ' -> ' + a.byteLength, compared };
        compared++;
    }
    return { err: null, compared };
}
// Replaces _bk with a same-length copy on every split: byteLength blind,
// identity must catch it.
class GrowingYft extends YFastTrie {
    _split(f) {
        const old = this._bk;
        const n = new Uint32Array(old.length);
        n.set(old);
        this._bk = n;
        return super._split(f);
    }
}
// Adds a 4th own typed-array field on every split: the column set must catch it.
class ExtraColYft extends YFastTrie { _split(f) { this._aux = new Int32Array(1); return super._split(f); } }
// Seeded fill / drain ops over a Uint32Array pool of 2T keys, T = min(C, 4096):
// fill (60% add, 10% delete) until size >= T, then drain (60% delete of a
// PRESENT key -- k, else its successor -- 10% add) until size <= T/8, so
// buckets split on the way up and merge on the way down; clear() every
// 25,000 ops; never adds a new key past capacity. Returns op-kind counts.
function runOps(s, U, C, seed, nOps) {
    const rk = mulberry32(seed ^ 0x9E3779B9);
    const ro = mulberry32(seed ^ 0x85EBCA6B);
    const TG = C < 4096 ? C : 4096;
    const LO = TG >>> 3;
    const PN = 2 * TG;
    const pool = new Uint32Array(PN);
    for (let i = 0; i < PN; i++) pool[i] = Math.floor(rk() * U);
    let fill = true;
    const cnt = { ops: 0, add: 0, del: 0, has: 0, succ: 0, pred: 0, min: 0, max: 0, clear: 0, phases: 0 };
    for (let i = 0; i < nOps; i++) {
        cnt.ops++;
        if (fill && s.size >= TG) { fill = false; cnt.phases++; }
        else if (!fill && s.size <= LO) { fill = true; cnt.phases++; }
        const k = pool[Math.floor(rk() * PN)];
        const o = ro();
        if (i > 0 && i % 25000 === 0) { s.clear(); cnt.clear++; fill = true; }
        else if (o < 0.7) {
            if ((o < 0.6) === fill) {
                if (s.size < C || s.has(k)) { s.add(k); cnt.add++; } else { s.delete(k); cnt.del++; }
            } else if (fill) { s.delete(k); cnt.del++; }
            else {
                const v = s.has(k) ? k : s.successor(k);
                s.delete(v === undefined ? k : v); cnt.del++;
            }
        }
        else if (o < 0.8) { s.has(k); cnt.has++; }
        else if (o < 0.88) { s.successor(k); cnt.succ++; }
        else if (o < 0.94) { s.predecessor(k); cnt.pred++; }
        else if (o < 0.97) { s.min(); cnt.min++; }
        else { s.max(); cnt.max++; }
    }
    return cnt;
}
`;

function body(src) {
    return new Function('env', COMMON + src);
}

function opsBody(U, C, seed) {
    return body(`
const U = ${U}, C = ${C}, seed = ${seed};
const s = new YFastTrie(U, C);
const ref = snap(s);
const r0 = spaceCheck(s, ref);
assert.equal(r0.err, null, 'fresh instance self-check');
assert.equal(r0.compared, 12, 'fresh self-check compared every column');
const cnt = runOps(s, U, C, seed, 100000);
assert.equal(cnt.ops, 100000, 'ops floor');
for (const k of ['add', 'del', 'has', 'succ', 'pred', 'min', 'max']) assert.ok(cnt[k] >= 1000, 'coverage ' + k + '=' + cnt[k]);
assert.equal(cnt.clear, 3, 'clear() ran 3 times');
const r1 = spaceCheck(s, ref);
assert.equal(r1.err, null);
assert.equal(r1.compared, 12, 'compared all 12 columns');
return { ops: cnt.ops, phases: cnt.phases, compared: r1.compared, size: s.size, byteLength: s.byteLength,
    splits: s._n[0], merges: s._n[1], borrows: s._n[2] };
`);
}

const CONTROL = body(`
const out = {};
for (const [name, Cls] of [['GrowingYft', GrowingYft], ['ExtraColYft', ExtraColYft]]) {
    const g = new Cls(65536, 1024);
    const ref = snap(g);
    const r0 = spaceCheck(g, ref);
    assert.equal(r0.err, null, name + ' passes before any split');
    assert.equal(r0.compared, 12);
    for (let i = 0; i <= 32; i++) g.add(i * 7);
    assert.equal(g._n[0], 1, name + ': 33 adds into the head bucket (K = 32) split exactly once');
    const r1 = spaceCheck(g, ref);
    assert.notEqual(r1.err, null, name + ': the check must fail after one split');
    // A full ops run on the control must also be caught.
    const g2 = new Cls(65536, 1024);
    const ref2 = snap(g2);
    runOps(g2, 65536, 1024, 0xC0FFEE, 5000);
    assert.ok(g2._n[0] >= 1, name + ' ops run reached a split');
    const r2 = spaceCheck(g2, ref2);
    assert.notEqual(r2.err, null, name + ': ops run must be caught');
    out[name] = r1.err + ' | ops: ' + r2.err;
}
assert.ok(out.GrowingYft.startsWith('_bk object replaced'), 'GrowingYft caught by identity: ' + out.GrowingYft);
assert.ok(out.ExtraColYft.startsWith('typed-array field set'), 'ExtraColYft caught by the column set: ' + out.ExtraColYft);
return out;
`);

const OPS_CASES = [[65536, 1024, 0x1A2B3C4D], [1048576, 16384, 0x5E6F7A8B], [4294967296, 65536, 0x2468ACE1]];
const OPS_JOBS = OPS_CASES.map(([U, C, seed]) => startFn(opsBody(U, C, seed), 'ops U=' + U + ' C=' + C));
const CONTROL_JOB = startFn(CONTROL, 'control');

// --- tests ---------------------------------------------------------------------

test('pins: constructed byteLength equals the literal pins and the model', T, () => {
    let n = 0;
    for (const [U, C, by] of PINS) {
        const s = new YFastTrie(U, C);
        assert.equal(s.byteLength, by, 'byteLength at (' + U + ', ' + C + ')');
        assert.equal(yftBytes(U, C), by, 'model at (' + U + ', ' + C + ')');
        n++;
    }
    assert.equal(n, 9, 'coverage floor: 9 constructed pins');
});

test('model reproduces (2^32, 2^24) = 663,749,975 (formula only, never allocated)', T, () => {
    const [U, C, by] = FORMULA_ONLY[0];
    assert.equal(by, 663749975);
    assert.equal(yftBytes(U, C), by);
    assert.equal(yftParams(U, C).Cr, 1048578, 'Cr = 2 + 2^24 / 16');
});

test('byteLength === the sum of every typed-array column, own + inner, on every pin', T, () => {
    let n = 0;
    for (const [U, C, by] of PINS) {
        const s = new YFastTrie(U, C);
        const cs = columnSum(s);
        assert.equal(cs.names, COL_NAMES, 'column walk at (' + U + ', ' + C + ')');
        assert.equal(cs.n, 12, 'coverage floor: 12 columns');
        assert.equal(cs.sum, s.byteLength, 'column sum at (' + U + ', ' + C + ')');
        assert.equal(cs.sum, by);
        n++;
    }
    assert.equal(n, 9);
});

test('control ExtraColYft: an added typed column breaks the column sum; GrowingYft does not (identity owns it)', T, () => {
    class ExtraColYft extends YFastTrie {
        constructor(u, c) { super(u, c); this._aux = new Int32Array(8); }
    }
    class GrowingYft extends YFastTrie {
        _split(f) {
            const n = new Uint32Array(this._bk.length);
            n.set(this._bk);
            this._bk = n;
            return super._split(f);
        }
    }
    const e = new ExtraColYft(65536, 1024);
    const ce = columnSum(e);
    console.log('ExtraColYft column sum ' + ce.sum + ' vs byteLength ' + e.byteLength + ' (' + ce.n + ' columns)');
    assert.equal(ce.n, 13);
    assert.notEqual(ce.sum, e.byteLength, 'ExtraColYft must break byteLength === column sum');
    assert.equal(ce.sum - e.byteLength, 32);
    const g = new GrowingYft(65536, 1024);
    for (let i = 0; i <= 32; i++) g.add(i * 7);
    assert.equal(g._n[0], 1, 'one split ran');
    const cg = columnSum(g);
    assert.equal(cg.sum, g.byteLength, 'a same-length realloc is invisible to the column sum');
});

test('model matches constructed instances on a seeded spread of >= 160 (U, C), U <= 2^32, C <= 2^16', T, () => {
    const seed = 0x5EED0A12 >>> 0;
    console.log('YFastTrieSpace spread seed=0x' + seed.toString(16));
    const r = mulberry32(seed);
    const cases = [];
    for (let k = 1; k <= 32; k++) {
        const p = 2 ** k;
        cases.push([p, 1], [p, Math.min(p, 65536)]);
        if (p > 2) cases.push([p - 1, Math.min(p - 1, 4093)]);
        if (p > 2 && p < 4294967296) cases.push([p + 1, Math.min(p + 1, 7)]);
    }
    while (cases.length < 200) {
        const U = 2 + Math.floor(r() * (4294967296 - 1));
        const C = 1 + Math.floor(r() * Math.min(U, 65536));
        cases.push([U, C]);
    }
    let n = 0;
    for (const [U, C] of cases) {
        const s = new YFastTrie(U, C);
        assert.equal(s.bits, bitsOf(U), 'bits at (' + U + ', ' + C + ')');
        assert.equal(s.byteLength, yftBytes(U, C), 'byteLength at (' + U + ', ' + C + ')');
        n++;
    }
    assert.ok(n >= 160, 'coverage floor: >= 160 configs, got ' + n);
    assert.equal(n, 200);
});

test('control repAtC: an inner trie sized at C mismatches every pin with C != Cr', T, () => {
    const all = PINS.concat(FORMULA_ONLY);
    const miss = [];
    const same = [];
    for (const [U, C, by] of all) {
        const v = repAtC(U, C);
        if (v !== by) miss.push('(' + U + ', ' + C + ') ' + by + ' vs ' + v);
        else same.push([U, C]);
    }
    console.log('repAtC mismatches ' + miss.length + '/' + all.length + ': ' + miss.join('; '));
    // (2^32, 2): C = 2 <= w/2 = 16, so Cr = 2 + floor(2/16) = 2 = C; every other pin has C > w/2 and C != Cr.
    assert.equal(miss.length, 9, 'repAtC must mismatch the 9 pins with C > w/2');
    assert.equal(same.length, 1);
    assert.deepEqual(same[0], [4294967296, 2]);
    assert.equal(yftParams(4294967296, 2).Cr, 2);
    assert.notEqual(repAtC(4294967296, 16777216), 663749975);
});

// A2: bytes over U = 2^16 .. 2^32 at fixed C, and over C -> 4C at fixed U.
const A_CS = [1024, 4096, 16384, 65536];
const B_US = [65536, 16777216, 4294967296];
const B_CS = [64, 256, 1024, 4096, 16384];

function flatInU(fn, C) {
    let mn = Infinity;
    let mx = 0;
    for (let k = 16; k <= 32; k++) {
        const b = fn(2 ** k, C);
        if (!(b > 0)) return NaN;
        if (b < mn) mn = b;
        if (b > mx) mx = b;
    }
    return mx / mn;
}

test('O(n) A: at C in {2^10, 2^12, 2^14, 2^16} bytes are flat in U = 2^16..2^32 (max/min <= 2.0), constructed == model', T, () => {
    const out = [];
    let built = 0;
    for (const C of A_CS) {
        for (let k = 16; k <= 32; k++) {
            assert.equal(new YFastTrie(2 ** k, C).byteLength, yftBytes(2 ** k, C), 'constructed at (2^' + k + ', ' + C + ')');
            built++;
        }
        const q = flatInU(yftBytes, C);
        out.push('C=' + C + ' ' + q.toFixed(4));
        assert.ok(q <= 2.0, 'YFastTrie max/min over U at C=' + C + ' is ' + q + ' > 2.0 (ENGINE FINDING)');
    }
    console.log('O(n) A YFastTrie max/min over U: ' + out.join(', '));
    assert.equal(built, 68, 'coverage floor: 4 C x 17 U constructed');
});

test('control xftSized: a plain XFastTrie(U, C) fails O(n) A at every C', T, () => {
    const out = [];
    for (const C of A_CS) {
        const q = flatInU(xftSized, C);
        out.push('C=' + C + ' ' + q.toFixed(4));
        assert.ok(q > 2.0, 'xftSized must fail the 2.0 gate at C=' + C + ', got ' + q);
    }
    console.log('O(n) A control xftSized max/min over U: ' + out.join(', '));
});

test('control xftSized margin: >= 3.0 at C in {2^12, 2^14, 2^16}; at C = 2^10 it reaches 2.8895 (PLAN finding F-G2-1)', T, () => {
    for (const C of [4096, 16384, 65536]) {
        const q = flatInU(xftSized, C);
        assert.ok(q >= 3.0, 'xftSized margin at C=' + C + ' is ' + q);
    }
    // A2 asked >= 3.0 at EVERY C (nominal 4.5-7.5); the XFastTrie formula gives
    // 2.8895 at C = 2^10 (still > 2.0, so the control fails the gate). C-19:
    // the margin is gated at 2^12..2^16; this cell is pinned and asserted > 2.0
    // in the xftSized test above.
    assert.equal(flatInU(xftSized, 1024).toFixed(4), '2.8895');
});

test('O(n) B: at U in {2^16, 2^24, 2^32}, bytes(4C) / bytes(C) in [3.0, 5.0] for C = 2^6..2^14', T, () => {
    const out = [];
    let n = 0;
    for (const U of B_US) {
        for (const C of B_CS) {
            const q = yftBytes(U, 4 * C) / yftBytes(U, C);
            out.push('U=2^' + bitsOf(U) + ' C=' + C + ' ' + q.toFixed(4));
            assert.ok(q >= 3.0 && q <= 5.0, 'YFastTrie bytes(4C)/bytes(C) at U=' + U + ' C=' + C + ' is ' + q + ' (ENGINE FINDING)');
            n++;
        }
    }
    console.log('O(n) B YFastTrie bytes(4C)/bytes(C): ' + out.join(', '));
    assert.equal(n, 15, 'coverage floor: 3 U x 5 C');
});

test('control sbSized: bytes independent of C fail O(n) B at every cell', T, () => {
    let fails = 0;
    for (const U of B_US) {
        for (const C of B_CS) {
            const q = sbSized(U, 4 * C) / sbSized(U, C);
            assert.equal(q, 1);
            if (!(q >= 3.0 && q <= 5.0)) fails++;
        }
    }
    assert.equal(fails, 15, 'sbSized must fail all 15 cells');
});

for (let i = 0; i < OPS_CASES.length; i++) {
    const [U, C, seed] = OPS_CASES[i];
    test('1e5 seeded fill / drain ops at (U=' + U + ', C=' + C + '): >= 100 splits and merges; byteLength and all 12 column identities unchanged', T, async () => {
        const r = await expectFn(OPS_JOBS[i]);
        console.log('YFastTrieSpace ops U=' + U + ' C=' + C + ' seed=0x' + seed.toString(16) + ' ' + JSON.stringify(r));
        assert.equal(r.ops, 100000, 'worker ran 1e5 ops');
        assert.equal(r.compared, 12, 'worker compared all 12 columns');
        assert.ok(r.splits >= 100, 'splits floor: ' + r.splits);
        assert.ok(r.merges >= 100, 'merges floor: ' + r.merges);
        assert.equal(r.byteLength, yftBytes(U, C), 'byteLength still equals the model');
    });
}

test('control: GrowingYft (identity) and ExtraColYft (column set) are detected', T, async () => {
    const r = await expectFn(CONTROL_JOB);
    console.log('YFastTrieSpace control ' + JSON.stringify(r));
    assert.equal(Object.keys(r).length, 2, 'both controls reported');
});
