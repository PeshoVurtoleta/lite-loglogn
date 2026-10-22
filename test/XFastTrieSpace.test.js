/**
 * @zakkster/lite-loglogn -- XFastTrie space tests (PLAN-xfasttrie G10; A2 cap 2^24; A11:
 * this file owns every XFastTrie byteLength pin).
 *
 * The test's OWN formula, written from the SPEC (never from the engine):
 *   w    = smallest integer with 2^w >= U (exact integer loop, no clz32);
 *   capL = min(C, 2^L) for L = 1..w;  B_L = smallest power of two >= ceil(capL * 10 / 72);
 *   S_L  = 8 * B_L;  TS = sum of S_L;
 *   byteLength = 13 TS + 12 (C + 1) + 16 (w + 1) + 16.
 * Pins: literal numbers, checked on constructed instances AND against the formula;
 * (2^32, 2^24) = 4,563,403,308 B is formula-only (never allocated). Control M-noMin
 * (every level sized at C) must mismatch the pins.
 *
 * After 1e5 seeded mixed ops in a Worker, byteLength and the identity of all 9
 * typed-array columns (_lv _occ _tk _tmin _tmax _key _next _prev _q) and of
 * their buffers are unchanged. Control GrowingXft (one subclass reallocates
 * `_tk` at the same length, one grows `_key` by one element) must be detected.
 *
 * HANG RULE: the ops bodies run successor / predecessor loops, so they execute
 * in a node:worker_threads Worker with a kill timer (KILL_MS < the test
 * timeout); a hang, a worker error, a nonzero exit or a missing result FAILS.
 * test/_worker-run.mjs hands its bodies StratifiedBitset only, so this file
 * carries its own eval worker (same contract: self-contained body, fail closed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { XFastTrie } from '../LogLogN.js';

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

// --- the test's own formula ----------------------------------------------------

function bitsOf(U) {
    let w = 0;
    let p = 1;
    while (p < U) { p *= 2; w++; }
    return w;
}

// noMin = true is the must-fail variant M-noMin: every level sized at C.
function model(U, C, noMin) {
    const w = bitsOf(U);
    let ts = 0;
    for (let L = 1; L <= w; L++) {
        const capL = noMin ? C : Math.min(C, 2 ** L);
        const need = Math.ceil(capL * 10 / 72);
        let b = 1;
        while (b < need) b *= 2;
        ts += 8 * b;
    }
    return 13 * ts + 12 * (C + 1) + 16 * (w + 1) + 16;
}

// [U, C, byteLength] -- literal pins.
const PINS = [
    [2, 1, 176],
    [65536, 1024, 225580],
    [1048576, 16384, 3604844],
    [4294967296, 1, 3896],
    [4294967296, 65536, 31457836],
    [65536, 4096, 688428],
    [1048576, 262144, 30409068],
];
const FORMULA_ONLY = [[4294967296, 16777216, 4563403308]];

// --- worker (hang-safe, self-contained eval body) ---------------------------------

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const assert = require('node:assert/strict');
import(workerData.lib).then((m) => {
    let msg;
    try {
        const fn = (0, eval)('"use strict"; (' + workerData.src + ')');
        if (typeof fn !== 'function') throw new TypeError('worker body is not a function');
        const result = fn({ XFastTrie: m.XFastTrie, assert });
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
const XFastTrie = env.XFastTrie, assert = env.assert;
const COLS = ['_lv', '_occ', '_tk', '_tmin', '_tmax', '_key', '_next', '_prev', '_q'];
function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function snap(s) {
    const live = Object.keys(s).filter((k) => ArrayBuffer.isView(s[k])).sort().join();
    if (live !== COLS.slice().sort().join()) throw new TypeError('typed-array field set ' + live);
    const cols = [];
    for (const k of COLS) {
        const a = s[k];
        if (!ArrayBuffer.isView(a)) throw new TypeError(k + ' is not a typed array');
        cols.push({ k, a, buf: a.buffer, bytes: a.byteLength });
    }
    return { byteLength: s.byteLength, cols };
}
// Returns { err, compared }: err null when space is unchanged, else a failure
// string; compared = the number of columns checked (coverage floor: 9).
function spaceCheck(s, ref) {
    const live = Object.keys(s).filter((k) => ArrayBuffer.isView(s[k])).sort().join();
    if (live !== COLS.slice().sort().join()) return { err: 'typed-array field set ' + live, compared: 0 };
    if (s.byteLength !== ref.byteLength) return { err: 'byteLength ' + ref.byteLength + ' -> ' + s.byteLength, compared: 0 };
    let compared = 0;
    for (const c of ref.cols) {
        const a = s[c.k];
        if (a !== c.a) return { err: c.k + ' object replaced', compared };
        if (a.buffer !== c.buf) return { err: c.k + '.buffer replaced', compared };
        if (a.byteLength !== c.bytes) return { err: c.k + '.byteLength ' + c.bytes + ' -> ' + a.byteLength, compared };
        compared++;
    }
    return { err: null, compared };
}
// Replaces _tk with a same-length copy on every successor: byteLength blind,
// identity must catch it.
class GrowingXft extends XFastTrie {
    successor(x) {
        const old = this._tk;
        const n = new Int32Array(old.length);
        n.set(old);
        this._tk = n;
        return super.successor(x);
    }
}
// Grows _key by one element on every successor: byteLength +4 per call.
class GrowingKeyXft extends XFastTrie {
    successor(x) {
        const old = this._key;
        const n = new Uint32Array(old.length + 1);
        n.set(old);
        this._key = n;
        return super.successor(x);
    }
}
// Adds a 10th typed-array field on every successor: column set must catch it.
class ExtraColXft extends XFastTrie { successor(x) { this._aux = new Int32Array(1); return super.successor(x); } }
// Seeded mixed ops over a pool of 2C keys (so add / delete hit), never adding
// past capacity; clear() every 25,000 ops. Returns op-kind counts.
function runOps(s, U, C, seed, nOps) {
    const rk = mulberry32(seed ^ 0x9E3779B9);
    const ro = mulberry32(seed ^ 0x85EBCA6B);
    const PN = 2 * C;
    const pool = new Array(PN);
    for (let i = 0; i < PN; i++) pool[i] = Math.floor(rk() * U);
    const cnt = { ops: 0, add: 0, del: 0, has: 0, succ: 0, pred: 0, min: 0, max: 0, clear: 0 };
    for (let i = 0; i < nOps; i++) {
        cnt.ops++;
        const k = pool[Math.floor(rk() * PN)];
        const o = ro();
        if (i > 0 && i % 25000 === 0) { s.clear(); cnt.clear++; }
        else if (o < 0.3) {
            if (s.size < C || s.has(k)) { s.add(k); cnt.add++; } else { s.delete(k); cnt.del++; }
        }
        else if (o < 0.5) { s.delete(k); cnt.del++; }
        else if (o < 0.65) { s.has(k); cnt.has++; }
        else if (o < 0.8) { s.successor(k); cnt.succ++; }
        else if (o < 0.9) { s.predecessor(k); cnt.pred++; }
        else if (o < 0.95) { s.min(); cnt.min++; }
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
const s = new XFastTrie(U, C);
const ref = snap(s);
const r0 = spaceCheck(s, ref);
assert.equal(r0.err, null, 'fresh instance self-check');
assert.equal(r0.compared, 9, 'fresh self-check compared every column');
const cnt = runOps(s, U, C, seed, 100000);
assert.equal(cnt.ops, 100000, 'ops floor');
for (const k of ['add', 'del', 'has', 'succ', 'pred', 'min', 'max']) assert.ok(cnt[k] >= 1000, 'coverage ' + k + '=' + cnt[k]);
assert.equal(cnt.clear, 3, 'clear() ran 3 times');
const r1 = spaceCheck(s, ref);
assert.equal(r1.err, null);
assert.equal(r1.compared, 9, 'compared all 9 columns');
return { ops: cnt.ops, compared: r1.compared, size: s.size, byteLength: s.byteLength,
    kicks: s._q[1], reseedOps: s._q[2], tries: s._q[3] };
`);
}

const CONTROL = body(`
const out = {};
for (const [name, Cls] of [['GrowingXft', GrowingXft], ['GrowingKeyXft', GrowingKeyXft], ['ExtraColXft', ExtraColXft]]) {
    const g = new Cls(65536, 1024);
    const ref = snap(g);
    const r0 = spaceCheck(g, ref);
    assert.equal(r0.err, null, name + ' passes before any query');
    assert.equal(r0.compared, 9);
    g.successor(0);
    const r1 = spaceCheck(g, ref);
    assert.notEqual(r1.err, null, name + ': the check must fail after one successor');
    // A full ops run on the control must also be caught.
    const g2 = new Cls(65536, 1024);
    const ref2 = snap(g2);
    const cnt = runOps(g2, 65536, 1024, 0xC0FFEE, 2000);
    assert.ok(cnt.succ > 0, name + ' ops run reached successor');
    const r2 = spaceCheck(g2, ref2);
    assert.notEqual(r2.err, null, name + ': ops run must be caught');
    out[name] = r1.err + ' | ops: ' + r2.err;
}
assert.ok(out.GrowingXft.startsWith('_tk object replaced'), 'GrowingXft caught by identity: ' + out.GrowingXft);
assert.ok(out.GrowingKeyXft.startsWith('byteLength '), 'GrowingKeyXft caught by byteLength: ' + out.GrowingKeyXft);
assert.ok(out.ExtraColXft.startsWith('typed-array field set'), 'ExtraColXft caught by the column set: ' + out.ExtraColXft);
return out;
`);

const OPS_CASES = [[65536, 1024, 0x1A2B3C4D], [1048576, 16384, 0x5E6F7A8B], [4294967296, 65536, 0x2468ACE1]];
const OPS_JOBS = OPS_CASES.map(([U, C, seed]) => startFn(opsBody(U, C, seed), 'ops U=' + U + ' C=' + C));
const CONTROL_JOB = startFn(CONTROL, 'control');

// --- tests ---------------------------------------------------------------------

test('pins: constructed byteLength equals the literal pins', T, () => {
    let n = 0;
    for (const [U, C, by] of PINS) {
        const s = new XFastTrie(U, C);
        assert.equal(s.byteLength, by, 'byteLength at (' + U + ', ' + C + ')');
        n++;
    }
    assert.equal(n, 7, 'coverage floor: 7 constructed pins');
});

test('own formula reproduces every pin, plus (2^32, 2^24) = 4,563,403,308 (formula only)', T, () => {
    let n = 0;
    for (const [U, C, by] of PINS.concat(FORMULA_ONLY)) {
        assert.equal(model(U, C, false), by, 'formula at (' + U + ', ' + C + ')');
        n++;
    }
    assert.equal(n, 8, 'coverage floor: 8 formula pins');
    assert.equal(FORMULA_ONLY[0][2], 4563403308);
    assert.equal(model(4294967296, 16777216, false), 4563403308);
    assert.equal(model(65536, 4096, false), 688428);
});

test('formula matches constructed instances on a seeded spread of (U, C), U <= 2^20, C <= 2^14', T, () => {
    const seed = 0x5EED0A11 >>> 0;
    console.log('XFastTrieSpace spread seed=0x' + seed.toString(16));
    const r = mulberry32(seed);
    const cases = [];
    for (let k = 1; k <= 20; k++) {
        const p = 2 ** k;
        cases.push([p, 1], [p, Math.min(p, 16384)]);
        if (p > 2) cases.push([p - 1, Math.min(p - 1, 16384)], [p + 1, Math.min(p + 1, 7)]);
    }
    while (cases.length < 160) {
        const U = 2 + Math.floor(r() * (1048576 - 1));
        const C = 1 + Math.floor(r() * Math.min(U, 16384));
        cases.push([U, C]);
    }
    let n = 0;
    for (const [U, C] of cases) {
        const s = new XFastTrie(U, C);
        assert.equal(s.bits, bitsOf(U), 'bits at (' + U + ', ' + C + ')');
        assert.equal(s.byteLength, model(U, C, false), 'byteLength at (' + U + ', ' + C + ')');
        n++;
    }
    assert.ok(n >= 160, 'coverage floor: >= 160 configs, got ' + n);
});

test('control M-noMin: a formula sizing every level at C mismatches the pins', T, () => {
    const all = PINS.concat(FORMULA_ONLY);
    const miss = [];
    for (const [U, C, by] of all) {
        const v = model(U, C, true);
        if (v !== by) miss.push('(' + U + ', ' + C + ') ' + by + ' vs ' + v);
    }
    console.log('M-noMin mismatches ' + miss.length + '/' + all.length + ': ' + miss.join('; '));
    // (2, 1) and (2^32, 1) have min(C, 2^L) = C at every level; every other pin must differ.
    assert.equal(miss.length, 6, 'M-noMin must mismatch the 6 pins with C > 2');
    assert.notEqual(model(65536, 4096, true), 688428);
    assert.notEqual(model(4294967296, 16777216, true), 4563403308);
});

for (let i = 0; i < OPS_CASES.length; i++) {
    const [U, C, seed] = OPS_CASES[i];
    test('1e5 seeded mixed ops at (U=' + U + ', C=' + C + '): byteLength and all 9 column identities unchanged', T, async () => {
        const r = await expectFn(OPS_JOBS[i]);
        console.log('XFastTrieSpace ops U=' + U + ' C=' + C + ' seed=0x' + seed.toString(16) + ' ' + JSON.stringify(r));
        assert.equal(r.ops, 100000, 'worker ran 1e5 ops');
        assert.equal(r.compared, 9, 'worker compared all 9 columns');
        assert.equal(r.byteLength, model(U, C, false), 'byteLength still equals the formula');
    });
}

test('control: GrowingXft (identity), GrowingKeyXft (byteLength) and ExtraColXft (column set) are detected', T, async () => {
    const r = await expectFn(CONTROL_JOB);
    console.log('XFastTrieSpace control ' + JSON.stringify(r));
    assert.equal(Object.keys(r).length, 3, 'all 3 controls reported');
});
