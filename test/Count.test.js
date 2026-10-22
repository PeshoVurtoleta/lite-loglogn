/**
 * @zakkster/lite-loglogn -- StratifiedBitset COUNT gate (A2, DETERMINISTIC).
 *
 * The cost model is gated by COUNTING, never by timing: a Proxy is swapped into
 * the shipped instance's `_bits` AFTER construction and counts every numeric-key
 * get (R = words read) and set (Wr = words written). The shipped class reads
 * `this._bits` on every hot call, so the Proxy sees every word access; a
 * reference cached elsewhere would count 0 and fail the exact table (control
 * below). clear() / dump() are never called while wrapped (typed-array methods
 * do not work through a Proxy).
 *
 * Exact table (constructed states) for U in {1, 32, 33, 1025, 32768, 65536,
 * 2^20, 2^24} (Lc = levels = 1,1,2,3,3,4,4,5), including the partial climbs
 * (c = 0 / 1 for add and delete); upper bounds on 1e4 seeded random ops per
 * universe (op and key streams split; every op kind >= 1000 times); every bad
 * key = 0/0. Controls: a 3-read probe counts exactly 3; has() counts exactly 1
 * (a cached-reference bypass counts 0 and FAILs); a test-local NaiveFlatBitset
 * successor(0) on {0, 65535} counts 2048 > 7 and checkBound returns FAIL; a
 * worker that never returns is terminated and reported as a FAIL.
 *
 * HANG SAFETY: node:test's timeout cannot interrupt a synchronous infinite loop,
 * so every per-universe body runs in a Worker
 * (test/_count-worker.mjs, one per universe, all started at load). The parent
 * arms a hang timer that terminates the worker; a hang, a nonzero exit or a
 * missing phase result is a FAIL, never a stuck run. Kept in its own file so
 * the Proxy never shares a process with the perf gate.
 * Seed: env LOGLOGN_COUNT_SEED, else the default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { StratifiedBitset } from '../LogLogN.js';
import { makeWrapped, checkBound, checkExact } from './_count-worker.mjs';

const T = { timeout: 120000 };
const HANG_MS = 100000;
const SEED = process.env.LOGLOGN_COUNT_SEED !== undefined
    ? (Number(process.env.LOGLOGN_COUNT_SEED) >>> 0)
    : 0x5eed2a2;
console.log('# Count.test.js seed=' + SEED);

const UNIVERSES = [
    [1, 1], [32, 1], [33, 2], [1025, 3], [32768, 3], [65536, 4], [2 ** 20, 4], [2 ** 24, 5],
];
// exact rows per universe: 15 base, +3 for U >= 2 (same-word add, absent
// delete, delete(1)), +2 partial climbs for Lc >= 2, +1 worst-case predecessor
const EXACT_ROWS = { 1: 15, 32: 18, 33: 20, 1025: 20, 32768: 21, 65536: 21, 1048576: 21, 16777216: 21 };
const WORKER_URL = new URL('./_count-worker.mjs', import.meta.url);

// Runs a worker; NEVER rejects. Resolves { parts: {phase -> msg}, error }, where
// error is set on a hang (terminated after ms), a worker error, or a nonzero exit.
function runWorker(spec, options, ms, label) {
    return new Promise((resolve) => {
        const parts = Object.create(null);
        let done = false;
        const w = new Worker(spec, options);
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ parts, error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            if (m !== null && typeof m === 'object' && typeof m.phase === 'string') parts[m.phase] = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

// all per-universe workers start now (in parallel), each test awaits its own
const JOBS = new Map();
for (const [U, Lc] of UNIVERSES) {
    JOBS.set(U, runWorker(WORKER_URL, { workerData: { countJob: true, U, Lc, seed: SEED } },
        HANG_MS, 'U=' + U));
}

async function phase(U, name) {
    const r = await JOBS.get(U);
    const part = r.parts[name];
    assert.ok(part !== undefined, 'U=' + U + ' phase ' + name + ' posted no result' +
        (r.error !== null ? ' (' + r.error + ')' : ''));
    assert.equal(r.error, null, 'U=' + U + ': ' + r.error);
    return part;
}

for (const [U, Lc] of UNIVERSES) {
    test('A2 exact counts, U=' + U + ' (Lc=' + Lc + ')', T, async () => {
        const p = await phase(U, 'exact');
        assert.deepEqual(p.fails, []);
        assert.equal(p.rows, EXACT_ROWS[U], 'U=' + U + ' exact rows ran');
    });

    test('A2 bad keys touch no word, U=' + U, T, async () => {
        const p = await phase(U, 'bad');
        assert.deepEqual(p.fails, []);
        assert.equal(p.rows, 13 * 5);
    });

    test('A2 1e4 seeded random ops stay within 1 / Lc / 2Lc-1 / Lc, U=' + U, T, async (t) => {
        t.diagnostic('seed=' + SEED);
        const p = await phase(U, 'random');
        assert.deepEqual(p.fails, [], 'seed=' + SEED + ' U=' + U);
        assert.equal(p.opCounts.length, 7);
        for (let k = 0; k < 7; k++) {
            assert.ok(p.opCounts[k] >= 1000, 'U=' + U + ' op kind ' + k + ' ran ' + p.opCounts[k] + ' < 1000');
        }
    });
}

// --- controls ---------------------------------------------------------------

test('control: a 3-read probe through this._bits counts exactly 3', T, () => {
    const { s, h } = makeWrapped(StratifiedBitset, 1025, [5]);
    const m = h.measure(() => {
        const b = s._bits;
        return b[0] + b[1] + b[33];
    });
    h.unwrap();
    assert.equal(m.R, 3);
    assert.equal(m.Wr, 0);
});

test('control: has() counts exactly 1 -- a cached-reference bypass counts 0 and FAILs', T, () => {
    const { s, h } = makeWrapped(StratifiedBitset, 65536, [7]);
    const m = h.measure(() => s.has(7));
    h.unwrap();
    assert.equal(m.R, 1, 'shipped has() must read exactly one word through this._bits');
    assert.equal(checkExact(m, { R: 1, Wr: 0 }), 'PASS');

    // a variant that caches the array before the swap bypasses the Proxy
    class CachedHas extends StratifiedBitset {
        constructor(u) {
            super(u);
            this._cached = this._bits;
        }
        has(x) {
            return (this._cached[x >>> 5] & (1 << (x & 31))) !== 0;
        }
    }
    const c = makeWrapped(CachedHas, 65536, [7]);
    const mc = c.h.measure(() => c.s.has(7));
    c.h.unwrap();
    assert.equal(mc.ret, true);
    assert.equal(mc.R, 0);
    assert.equal(checkExact(mc, { R: 1, Wr: 0 }), 'FAIL', 'the exact check must catch a bypass');
});

class NaiveFlatBitset {
    constructor(u) {
        this._u = u;
        this._w = Math.ceil(u / 32);
        this._bits = new Uint32Array(this._w);
    }
    add(x) {
        this._bits[x >>> 5] |= 1 << (x & 31);
        return this;
    }
    successor(x) {
        const i = x + 1;
        if (i >= this._u) return undefined;
        const b = this._bits;
        let p = i >>> 5;
        let v = b[p] & (-1 << (i & 31));
        while (v === 0) {
            p++;
            if (p >= this._w) return undefined;
            v = b[p];
        }
        return ((p << 5) | (31 - Math.clz32(v & -v))) >>> 0;
    }
}

test('control: NaiveFlatBitset successor(0) on {0, 65535} counts 2048 > 7 and FAILs checkBound', T, () => {
    const Lc = 4;
    const { s, h } = makeWrapped(NaiveFlatBitset, 65536, [0, 65535]);
    const m = h.measure(() => s.successor(0));
    h.unwrap();
    assert.equal(m.ret, 65535);
    assert.equal(m.R, 2048);
    assert.equal(checkBound(m.R, 2 * Lc - 1), 'FAIL');
    // the shipped side (successor(0) on {0, 65535} = 7 = 2Lc-1) is the exact
    // row 'successor(0) on {0,U-1}' at U=65536, run in the worker above
});

test('control: a worker that never returns is terminated and reported as a FAIL', T, async () => {
    const r = await runWorker('for (;;) {}', { eval: true }, 300, 'spin');
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
    assert.equal(Object.keys(r.parts).length, 0);
});
