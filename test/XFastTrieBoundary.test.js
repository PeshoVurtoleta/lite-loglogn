/**
 * @zakkster/lite-loglogn -- XFastTrie BOUNDARY gate (G-B1, G6; DETERMINISTIC).
 * Hand-derived expectations from the SPEC (strict successor > x / predecessor < x,
 * keys are integers in [0, U), capacity fixed, fail closed); no value is copied
 * from running the implementation.
 *
 * Covered: empty instance; single key; x below min / above max / absent; keys 0
 * and U-1; U = 2 full (C = 2); w = 32 with keys 0, 2^31, 2^32-1 (strict succ /
 * pred across 2^31); successor(U-1) and predecessor(0) undefined; non-power-of-two
 * U (33, 65537) top key; clear() then reuse (a full churn stream and dump() equal
 * a fresh instance's); add at full (RangeError /\[lite-loglogn\]/, dump() deep-equal,
 * byteLength identical); add of an existing key at full returns this; -0 aliases 0;
 * constructor rejections.
 *
 * MUST-FAIL CONTROLS (mutants of the REAL LogLogN.js text, anchor replaced exactly
 * once, loaded via a data: URL):
 *   clearNoOcc  clear() forgets to zero `_occ` -> after clear() the instance is NOT
 *               a fresh one (stale prefixes): the clear-reuse gate must diverge;
 *   MX5         add increments size before the full check -> size is counted twice, so a
 *               new key is rejected below capacity (the shipped build fills C keys).
 * The clear-reuse churn runs in a Worker (test/_xft-worker.mjs, job 'clear') under
 * the KILL_MS kill timer: a stale-occupancy mutant can walk a broken thread.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { KILL_MS } from './_worker-run.mjs';
import { XFastTrie } from '../LogLogN.js';

const T = { timeout: 120000 };
const WORKER_URL = new URL('./_xft-worker.mjs', import.meta.url);
const TWO31 = 2147483648;
const TWO32 = 4294967296;

function build(U, C, keys) {
    const t = new XFastTrie(U, Math.min(C, U));
    for (const k of keys) t.add(k);
    return t;
}

// --- empty --------------------------------------------------------------------------

test('boundary: empty instance answers like an empty set', () => {
    for (const [U, C] of [[2, 1], [2, 2], [3, 2], [33, 33], [65537, 64], [TWO32, 16]]) {
        const t = new XFastTrie(U, C);
        assert.equal(t.size, 0);
        assert.equal(t.universe, U);
        assert.equal(t.capacity, C);
        for (const x of [0, 1, U - 1]) {
            if (x >= U) continue;
            assert.equal(t.has(x), false, 'has ' + x);
            assert.equal(t.successor(x), undefined, 'successor ' + x);
            assert.equal(t.predecessor(x), undefined, 'predecessor ' + x);
        }
        assert.equal(t.min(), undefined);
        assert.equal(t.max(), undefined);
        assert.equal(t.delete(0), false);
        const d = t.dump();
        assert.equal(d.size, 0);
        assert.equal(d.keys.length, 0);
        for (const lvl of d.levels) assert.equal(lvl.prefix.length, 0);
    }
});

// --- single key / below / above / absent --------------------------------------------

test('boundary: single key k -- strict neighbours, below, above, absent', () => {
    for (const U of [2, 3, 33, 1025, 65537, TWO32]) {
        for (const k of [0, 1, Math.floor(U / 2), U - 2, U - 1].filter((v) => v >= 0 && v < U)) {
            const t = build(U, 4, [k]);
            assert.equal(t.size, 1);
            assert.equal(t.has(k), true);
            assert.equal(t.min(), k);
            assert.equal(t.max(), k);
            assert.equal(t.successor(k), undefined, 'U=' + U + ' successor(k=' + k + ')');
            assert.equal(t.predecessor(k), undefined, 'U=' + U + ' predecessor(k=' + k + ')');
            if (k > 0) {
                assert.equal(t.successor(0), k, 'successor(0)');
                assert.equal(t.successor(k - 1), k, 'successor(k-1)');
                assert.equal(t.predecessor(k), undefined);
                assert.equal(t.has(k - 1), false);
            }
            if (k < U - 1) {
                assert.equal(t.predecessor(U - 1), k, 'predecessor(U-1)');
                assert.equal(t.predecessor(k + 1), k, 'predecessor(k+1)');
                assert.equal(t.successor(k), undefined);
                assert.equal(t.has(k + 1), false);
            }
        }
    }
});

test('boundary: x below min, above max, between and absent (keys 10, 20, 30 in U=64)', () => {
    const t = build(64, 8, [20, 10, 30]);
    // hand table: strict successor / predecessor
    const succ = [[0, 10], [9, 10], [10, 20], [11, 20], [19, 20], [20, 30], [29, 30], [30, undefined], [31, undefined], [63, undefined]];
    const pred = [[0, undefined], [10, undefined], [11, 10], [20, 10], [21, 20], [30, 20], [31, 30], [63, 30]];
    for (const [x, want] of succ) assert.equal(t.successor(x), want, 'successor(' + x + ')');
    for (const [x, want] of pred) assert.equal(t.predecessor(x), want, 'predecessor(' + x + ')');
    assert.equal(t.min(), 10);
    assert.equal(t.max(), 30);
    for (const x of [0, 9, 11, 19, 21, 29, 31, 63]) assert.equal(t.has(x), false, 'has ' + x);
    assert.equal(t.delete(15), false);
    assert.equal(t.delete(20), true);
    assert.equal(t.successor(10), 30);
    assert.equal(t.predecessor(30), 10);
    assert.equal(t.size, 2);
});

test('boundary: keys 0 and U-1 (pow2 and non-pow2 U)', () => {
    for (const U of [2, 3, 4, 31, 32, 33, 1024, 1025, 65536, 65537, 999983, TWO31, TWO32]) {
        const t = build(U, 3, [U - 1, 0]);
        assert.equal(t.min(), 0, 'U=' + U);
        assert.equal(t.max(), U - 1, 'U=' + U);
        assert.equal(t.successor(0), U - 1, 'U=' + U + ' successor(0)');
        assert.equal(t.predecessor(U - 1), 0, 'U=' + U + ' predecessor(U-1)');
        assert.equal(t.successor(U - 1), undefined, 'U=' + U + ' successor(U-1)');
        assert.equal(t.predecessor(0), undefined, 'U=' + U + ' predecessor(0)');
        assert.equal(t.has(0), true);
        assert.equal(t.has(U - 1), true);
        assert.equal(t.has(U), false);
        assert.equal(t.successor(U), undefined, 'successor(U) is a bad key');
        assert.equal(t.predecessor(U), undefined, 'predecessor(U) is a bad key');
        assert.throws(() => t.add(U), RangeError);
        assert.equal(t.size, 2);
        if (U > 2) {
            assert.equal(t.successor(1), U - 1);
            assert.equal(t.predecessor(U - 2), 0);
        }
    }
});

test('boundary: U = 2 full (C = 2)', () => {
    const t = new XFastTrie(2, 2);
    assert.equal(t.bits, 1);
    t.add(1);
    t.add(0);
    assert.equal(t.size, 2);
    assert.equal(t.min(), 0);
    assert.equal(t.max(), 1);
    assert.equal(t.successor(0), 1);
    assert.equal(t.predecessor(1), 0);
    assert.equal(t.successor(1), undefined);
    assert.equal(t.predecessor(0), undefined);
    assert.equal(t.add(0), t, 'present key at full returns this');
    assert.equal(t.add(1), t);
    assert.throws(() => t.add(2), RangeError, 'key 2 is outside U = 2');
    assert.equal(t.delete(0), true);
    assert.equal(t.successor(0), 1);
    assert.equal(t.min(), 1);
    assert.equal(t.predecessor(1), undefined);
    t.add(0);
    assert.equal(t.size, 2);
    assert.equal(t.delete(1), true);
    assert.equal(t.delete(0), true);
    assert.equal(t.min(), undefined);
    assert.equal(t.size, 0);
});

test('boundary: w = 32 keys 0, 2^31, 2^32-1 (strict across 2^31)', () => {
    const t = build(TWO32, 4, [TWO31, TWO32 - 1, 0]);
    assert.equal(t.bits, 32);
    const succ = [[0, TWO31], [1, TWO31], [TWO31 - 1, TWO31], [TWO31, TWO32 - 1],
        [TWO31 + 1, TWO32 - 1], [TWO32 - 2, TWO32 - 1], [TWO32 - 1, undefined]];
    const pred = [[0, undefined], [1, 0], [TWO31 - 1, 0], [TWO31, 0], [TWO31 + 1, TWO31],
        [TWO32 - 2, TWO31], [TWO32 - 1, TWO31]];
    for (const [x, want] of succ) assert.equal(t.successor(x), want, 'successor(' + x + ')');
    for (const [x, want] of pred) assert.equal(t.predecessor(x), want, 'predecessor(' + x + ')');
    assert.equal(t.min(), 0);
    assert.equal(t.max(), TWO32 - 1);
    assert.equal(t.has(TWO31), true);
    assert.equal(t.has(TWO31 - 1), false);
    assert.equal(t.delete(TWO31), true);
    assert.equal(t.successor(0), TWO32 - 1);
    assert.equal(t.predecessor(TWO32 - 1), 0);
    assert.equal(t.predecessor(TWO31 + 5), 0);
    assert.equal(t.successor(TWO31 + 5), TWO32 - 1);
    // keys in the upper half only: the lower half query still finds the min
    const u = build(TWO32, 2, [TWO31 + 7, TWO32 - 1]);
    assert.equal(u.successor(0), TWO31 + 7);
    assert.equal(u.predecessor(TWO31 + 7), undefined);
    assert.equal(u.predecessor(TWO32 - 1), TWO31 + 7);
    // keys in the lower half only: an upper-half query finds the max
    const v = build(TWO32, 2, [0, 5]);
    assert.equal(v.predecessor(TWO32 - 1), 5);
    assert.equal(v.successor(5), undefined);
    assert.equal(v.successor(6), undefined);
});

test('boundary: non-power-of-two U top key (33 and 65537)', () => {
    // U = 33: w = 6 (64 > 33); the top key is 32
    const a = build(33, 5, [32, 31, 16]);
    assert.equal(a.bits, 6);
    assert.equal(a.max(), 32);
    assert.equal(a.successor(31), 32);
    assert.equal(a.successor(32), undefined);
    assert.equal(a.predecessor(32), 31);
    assert.equal(a.successor(17), 31);
    assert.equal(a.predecessor(31), 16);
    assert.equal(a.has(33), false);
    assert.equal(a.successor(33), undefined);
    // U = 65537: w = 17; 65536 = 2^16 is the only key with the top bit set
    const b = build(65537, 6, [65536, 65535, 0]);
    assert.equal(b.bits, 17);
    assert.equal(b.max(), 65536);
    assert.equal(b.successor(65535), 65536);
    assert.equal(b.successor(65534), 65535);
    assert.equal(b.successor(65536), undefined);
    assert.equal(b.predecessor(65536), 65535);
    assert.equal(b.predecessor(65535), 0);
    assert.equal(b.has(65536), true);
    assert.equal(b.has(65537), false);
    assert.throws(() => b.add(65537), RangeError);
    b.delete(65536);
    assert.equal(b.max(), 65535);
    assert.equal(b.successor(65535), undefined);
});

// --- add at full ----------------------------------------------------------------------

function dumpText(t) {
    return JSON.stringify(t.dump(), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
}

/**
 * The real add-at-full gate. Cls is the shipped class or a mutant; a violation throws an
 * AssertionError. Returns the coverage: { checked, skipped } (configs with a fresh key / without).
 */
function addAtFullGate(Cls) {
    let checked = 0;
    let skipped = 0;
    for (const [U, C] of [[2, 1], [2, 2], [33, 1], [33, 5], [65537, 64], [TWO32, 4], [TWO32, 1]]) {
        const t = new Cls(U, C);
        t.add(U - 1);
        for (let x = 0; t.size < C && x < U; x++) t.add(x);
        assert.equal(t.size, C);
        const before = t.dump();
        const bl = t.byteLength;
        let fresh = -1; // an absent key
        for (let x = U - 1; x >= 0; x--) if (!t.has(x)) { fresh = x; break; }
        if (fresh < 0) {
            // C === U: every key present, so there is no new key to reject
            assert.equal(C, U);
            skipped++;
            continue;
        }
        assert.throws(() => t.add(fresh), (e) => e instanceof RangeError && /\[lite-loglogn\]/.test(e.message));
        assert.equal(t.size, C, 'U=' + U + ' C=' + C + ': a rejected add left size changed');
        assert.deepEqual(t.dump(), before, 'U=' + U + ' C=' + C);
        assert.equal(t.byteLength, bl);
        assert.equal(t.size, C);
        assert.equal(t.has(fresh), false);
        // the instance still works after the rejection
        const k0 = before.keys[0];
        assert.equal(t.delete(k0), true);
        assert.equal(t.add(fresh), t);
        assert.equal(t.size, C);
        assert.equal(t.has(fresh), true);
        checked++;
    }
    return { checked, skipped };
}

test('boundary: add at full throws RangeError [lite-loglogn], dump() deep-equal, byteLength identical', () => {
    const cov = addAtFullGate(XFastTrie);
    assert.equal(cov.checked, 6, 'six configs have a fresh key');
    assert.equal(cov.skipped, 1, '[2, 2] is full of every key');
});

test('boundary: add of an existing key at full returns this (no throw, no change)', () => {
    for (const [U, C] of [[2, 2], [33, 3], [65537, 8], [TWO32, 3]]) {
        const keys = [0, U - 1, Math.floor(U / 2)].slice(0, C);
        for (let x = 1; keys.length < C; x++) if (!keys.includes(x)) keys.push(x);
        const t = build(U, C, keys);
        assert.equal(t.size, C);
        const before = dumpText(t);
        for (const k of keys) assert.equal(t.add(k), t, 'U=' + U + ' add(' + k + ')');
        assert.equal(dumpText(t), before);
        assert.equal(t.size, C);
    }
});

// --- -0 ---------------------------------------------------------------------------------

test('boundary: -0 aliases 0', () => {
    const t = new XFastTrie(64, 4);
    assert.equal(t.add(-0), t);
    assert.equal(t.size, 1);
    assert.equal(t.has(0), true);
    assert.equal(t.has(-0), true);
    assert.ok(Object.is(t.min(), 0), 'min() is +0, not -0');
    assert.ok(Object.is(t.max(), 0));
    assert.equal(t.add(0), t, 'adding 0 after -0 is a present key');
    assert.equal(t.size, 1);
    t.add(5);
    assert.ok(Object.is(t.predecessor(5), 0));
    assert.equal(t.successor(-0), 5);
    assert.equal(t.predecessor(-0), undefined);
    assert.equal(t.delete(-0), true);
    assert.equal(t.has(0), false);
    assert.equal(t.size, 1);
    assert.equal(t.delete(-0), false);
});

// --- constructor ------------------------------------------------------------------------

test('boundary: constructor rejects bad capacity and universe', () => {
    const ok = [[2, 1], [2, 2], [16, 16], [100, 1]];
    for (const [U, C] of ok) assert.doesNotThrow(() => new XFastTrie(U, C));
    const badCap = [0, 17, 1.5, NaN, '16', 16n, null, undefined, -1, Infinity, 2 ** 53, {}, []];
    for (const c of badCap) {
        assert.throws(() => new XFastTrie(16, c), (e) => e instanceof RangeError && /\[lite-loglogn\]/.test(e.message),
            'capacity ' + String(typeof c === 'bigint' ? c + 'n' : c));
    }
    // > min(U, 2^24): above the cap limit for a huge U, above U for a small one
    assert.throws(() => new XFastTrie(TWO32, 16777217), RangeError);
    assert.throws(() => new XFastTrie(TWO32, TWO32), RangeError);
    assert.throws(() => new XFastTrie(16777216, 16777217), RangeError);
    assert.throws(() => new XFastTrie(2, 3), RangeError);
    assert.throws(() => new XFastTrie(1000, 1001), RangeError);
    const badU = [1, 0, -1, TWO32 + 1, 1.5, NaN, '16', 16n, null, undefined, Infinity, {}];
    for (const u of badU) {
        assert.throws(() => new XFastTrie(u, 1), (e) => e instanceof RangeError && /\[lite-loglogn\]/.test(e.message),
            'universe ' + String(typeof u === 'bigint' ? u + 'n' : u));
    }
    assert.throws(() => new XFastTrie(), RangeError);
});

// --- clear() then reuse ----------------------------------------------------------------

const SHIPPED = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const CLEAR_FROM = 'for (let i = 0; i < ts; i++) occ[i] = 0;';
const CLEAR_MATCHES = SHIPPED.split(CLEAR_FROM).length - 1;
const CLEAR_SRC = CLEAR_MATCHES === 1 ? SHIPPED.replace(CLEAR_FROM, '/* clearNoOcc mutant: occ not zeroed */') : null;
const MX5_FROM = 'if (this._size === this._c) throwFull(this._c);';
const MX5_MATCHES = SHIPPED.split(MX5_FROM).length - 1;
const MX5_SRC = MX5_MATCHES === 1
    ? SHIPPED.replace(MX5_FROM, 'this._size++;\n        if (this._size > this._c) throwFull(this._c);\n        this._size--;') : null;

const CLEAR_CONFIGS = [
    { U: 2, C: 2, nOps: 6000, seed: 0x11111111 },
    { U: 3, C: 1, nOps: 6000, seed: 0x22222222 },
    { U: 33, C: 33, nOps: 20000, seed: 0x33333333 },
    { U: 65536, C: 64, nOps: 30000, seed: 0x44444444 },
    { U: 65537, C: 4096, nOps: 30000, seed: 0x55555555 },
    { U: TWO32, C: 64, nOps: 30000, seed: 0x66666666 },
    { U: TWO32, C: 4096, nOps: 30000, seed: 0x77777777 },
];

function clearJob(src, label) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(WORKER_URL, {
            workerData: { xftJob: true, job: 'clear', src, configs: CLEAR_CONFIGS }, stdout: true, stderr: true,
        });
        let errText = '';
        w.stdout.resume();
        w.stderr.setEncoding('utf8');
        w.stderr.on('data', (d) => {
            if (errText.length < 4096) errText += d;
        });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result, error: error === null ? null : error + (errText ? ' | stderr: ' + errText : '') });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + KILL_MS + ' ms: ' + label + ' worker terminated');
        }, KILL_MS);
        w.on('message', (m) => {
            result = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

const CLEAR_MAIN = clearJob(null, 'clear-shipped');
const CLEAR_MUT = CLEAR_SRC === null ? null : clearJob(CLEAR_SRC, 'clear-mutant');

async function clearRuns(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && r.result.ok === true, String(r.result && r.result.message));
    return r.result.result;
}

test('boundary: anchors of the clear / MX5 controls occur exactly once', () => {
    assert.equal(CLEAR_MATCHES, 1);
    assert.equal(MX5_MATCHES, 1);
});

test('boundary: clear() then reuse == a fresh instance under a full churn stream, dump() equal', T, async () => {
    const runs = await clearRuns(CLEAR_MAIN);
    assert.equal(runs.length, CLEAR_CONFIGS.length);
    let ops = 0;
    let dumps = 0;
    for (const r of runs) {
        assert.ok(r.sizeBefore > 0, 'the used instance held keys before clear (U=' + r.U + ' C=' + r.C + ')');
        assert.equal(r.divergences, 0, 'U=' + r.U + ' C=' + r.C + ' ' + r.first);
        ops += r.ops;
        dumps += r.dumpsCompared;
    }
    assert.ok(ops > 0 && dumps >= runs.length * 2);
    console.log('# clear-reuse: ' + runs.length + ' configs, ' + ops + ' ops, ' + dumps + ' dump comparisons');
});

test('boundary: clear() empties in place -- dump() equals a fresh dump, old keys absent', () => {
    for (const [U, C] of [[2, 2], [33, 9], [65537, 100], [TWO32, 50]]) {
        const keys = [];
        for (let i = 0; i < C; i++) keys.push(Math.min(U - 1, Math.floor((i * 2654435761) % U)));
        const t = new XFastTrie(U, C);
        const fresh = new XFastTrie(U, C);
        for (const k of keys) t.add(k);
        const bl = t.byteLength;
        assert.ok(t.size > 0);
        t.clear();
        assert.equal(t.size, 0);
        assert.equal(t.byteLength, bl);
        assert.deepEqual(t.dump(), fresh.dump(), 'U=' + U);
        for (const k of keys) {
            assert.equal(t.has(k), false, 'stale key ' + k);
            assert.equal(t.successor(k), undefined);
            assert.equal(t.predecessor(k), undefined);
        }
        assert.equal(t.min(), undefined);
        assert.equal(t.max(), undefined);
        // refill to capacity, then a full-throw, then clear again
        for (let x = 0; t.size < C && x < U; x++) t.add(x);
        t.clear();
        assert.deepEqual(t.dump(), fresh.dump());
    }
});

test('boundary: control clearNoOcc (clear() forgets _occ) is caught by the clear-reuse gate', T, async () => {
    assert.ok(CLEAR_MUT !== null, 'mutant not built');
    const runs = await clearRuns(CLEAR_MUT);
    const bad = runs.filter((r) => r.divergences > 0);
    assert.ok(bad.length > 0, 'clearNoOcc survived: no config diverged');
    console.log('# clearNoOcc diverged in ' + bad.length + '/' + runs.length + ' configs; first: ' + bad[0].first);
});

test('boundary: control MX5 (size bumped before the full check, left bumped on the reject) is caught by the real add-at-full gate', async () => {
    assert.ok(MX5_SRC !== null);
    const mod = await import('data:text/javascript;base64,' + Buffer.from(MX5_SRC, 'utf8').toString('base64'));
    // below capacity the mutant is the identity (bump, check, undo): the gate's fill phase passes
    const ok = new mod.XFastTrie(33, 4);
    for (const k of [3, 9, 15, 21]) ok.add(k);
    assert.equal(ok.size, 4, 'the mutant accepts C keys: only the full REJECT differs');
    // the real gate must fail on it, by an AssertionError (a crash is not a kill)
    assert.throws(() => addAtFullGate(mod.XFastTrie), { name: 'AssertionError', message: /a rejected add left size changed/ });
    // and the same gate passes on the shipped class (the control is not vacuous)
    assert.equal(addAtFullGate(XFastTrie).checked, 6);
});
