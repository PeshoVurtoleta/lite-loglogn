/**
 * @zakkster/lite-loglogn -- XFastTrie COUNT gate (B4 / E11, DETERMINISTIC hard
 * gate; decisions/0004 Amendment 1: counts, not timing, prove the cost model).
 *
 * A Proxy is swapped into each of the 8 columns (_lv _occ _tk _tmin _tmax _key
 * _next _prev) of the shipped instance AFTER construction. 1 touch = 1 `_slot` /
 * `_put` = exactly 4 `_lv` reads; <= 8 `_occ` reads per touch, = 8 on a miss.
 *
 * Gate (PLAN-xfasttrie SPEC (3) + ASSERTIONS E2 / E3 / E4):
 *   E2  exact table rows at w = 1, 2, 4, 8, 16, 32 (U = 2^w) on constructed
 *       states; has(absent) = 8 occ reads, 4 _lv reads, 0 writes; absent
 *       successor at w = 2..32 -> 2, 3, 4, 5, 6 touches, R^2 vs log2(w) =
 *       1.0000 and vs w = 0.8710 (computed here from the measured counts);
 *   E3  add-on-empty 4, 7, 12, 21, 38 touches, R^2 vs w = 0.9983 and vs log2(w)
 *       = 0.8975; add-new / delete rows with m > 0 (early-stop walk); a seeded
 *       random stream per universe (op and key streams split) where every kick-
 *       free op equals xftStream countModel;
 *   E4  full reject and bad-key reject: 0 writes on every column, 0 reads of
 *       _key / _next / _prev; dump() and byteLength unchanged.
 * The R^2 targets were computed independently (separate script) before the run.
 *
 * Controls (each must FAIL the gate; mutants replace an anchor EXACTLY once in
 * the real LogLogN.js text and load by data: URL in the worker): M-linear
 * (`_near` linear walk), M-cachedOcc (`_slot` reads a cached occ reference ->
 * the Proxy sees 0 reads), M-fullwalk (update walk to L > 0), M-fullLate (the
 * capacity check after the leaf pop; the replay cannot see it, only the E4
 * read / write rows can), and a worker that never returns.
 *
 * HANG SAFETY: every body runs in a Worker (test/_xft-count-worker.mjs) under a
 * hang timer; a hang, a nonzero exit or a missing phase is a FAIL.
 * Seed: env LOGLOGN_XFT_COUNT_SEED, else the default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { rSquared } from './_xft-count-worker.mjs';

// 11 workers pipe stdout / stderr through the parent: raise the listener cap
process.stdout.setMaxListeners(64);
process.stderr.setMaxListeners(64);

const T = { timeout: 120000 };
const HANG_MS = 90000;
const N_OPS = 10000;
const SEED = process.env.LOGLOGN_XFT_COUNT_SEED !== undefined
    ? (Number(process.env.LOGLOGN_XFT_COUNT_SEED) >>> 0)
    : 0x7c0ffee3;
console.log('# XftCount.test.js seed=' + SEED);

const WS = [1, 2, 4, 8, 16, 32];
const WORKER_URL = new URL('./_xft-count-worker.mjs', import.meta.url);
const ALL = ['exact', 'bad', 'e4', 'random'];
const SRC_TEXT = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');

// Runs a worker; NEVER rejects. Resolves { parts, error } (error on hang / error / nonzero exit).
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

function job(src, w, nOps, label) {
    return runWorker(WORKER_URL, {
        workerData: { xftCountJob: true, src, U: 2 ** w, seed: SEED, nOps, phases: ALL },
    }, HANG_MS, label);
}

// all shipped per-universe workers and all mutant workers start now, in parallel
const JOBS = new Map();
for (const w of WS) JOBS.set(w, job(null, w, N_OPS, 'w=' + w));

// mutants: each anchor must occur EXACTLY once in the real source text
function mutate(edits) {
    let text = SRC_TEXT;
    for (const [anchor, repl] of edits) {
        const i = text.indexOf(anchor);
        assert.ok(i >= 0, 'mutant anchor not found: ' + JSON.stringify(anchor));
        assert.equal(text.indexOf(anchor, i + 1), -1, 'mutant anchor found more than once: ' + JSON.stringify(anchor));
        text = text.slice(0, i) + repl + text.slice(i + anchor.length);
    }
    return 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
}

const MUTANTS = {
    // _near probes mid = lo + 1: the same answer by a linear walk over levels
    linear: [['const mid = (lo + hi + 1) >>> 1;', 'const mid = lo + 1;']],
    // _slot reads an occ reference cached at construction (raw array, never the Proxy)
    cachedOcc: [
        ['this._occ = new Uint8Array(ts);', 'this._occ = new Uint8Array(ts);\n        this._occC = this._occ;'],
        ['const occ = this._occ;\n        const tk = this._tk;\n        const j = L << 2;',
            'const occ = this._occC;\n        const tk = this._tk;\n        const j = L << 2;'],
    ],
    // the update walk of add runs to level 1 instead of stopping at m
    fullwalk: [['for (let L = w; L > m; L--) {', 'for (let L = w; L > 0; L--) {']],
    // the capacity check moved after the leaf pop
    fullLate: [
        ['        if (this._size === this._c) throwFull(this._c);\n        const sl = this._near();',
            '        const sl = this._near();'],
        ['        this._free = nx[f];\n        ky[f] = x;',
            '        this._free = nx[f];\n        if (this._size === this._c) throwFull(this._c);\n        ky[f] = x;'],
    ],
};
const CTL = {};
for (const [name, edits] of Object.entries(MUTANTS)) CTL[name] = job(mutate(edits), 8, 3000, 'mutant ' + name);

async function phase(w, name) {
    const r = await JOBS.get(w);
    const part = r.parts[name];
    assert.ok(part !== undefined, 'w=' + w + ' phase ' + name + ' posted no result' +
        (r.error !== null ? ' (' + r.error + ')' : ''));
    assert.equal(r.error, null, 'w=' + w + ': ' + r.error);
    return part;
}

// every fail message of a mutant run, or a hard error
async function ctlFails(name) {
    const r = await CTL[name];
    assert.equal(r.error, null, 'mutant ' + name + ': ' + r.error);
    const out = [];
    for (const p of ALL) {
        assert.ok(r.parts[p] !== undefined, 'mutant ' + name + ' posted no ' + p);
        out.push(...r.parts[p].fails);
    }
    return out;
}

const mPosWant = (w) => {
    return 4 * new Set([1, w >> 1, w - 2].filter((j) => j >= 1 && j <= w - 2)).size;
};

for (const w of WS) {
    const U = 2 ** w;

    test('E2 exact count rows, w=' + w + ' (U=2^' + w + ')', T, async (t) => {
        const p = await phase(w, 'exact');
        t.diagnostic('touches/table/thread: ' + p.table.join(' | '));
        assert.deepEqual(p.fails, []);
        assert.ok(p.rows >= 15, 'rows ran: ' + p.rows);
        assert.equal(p.mPos, mPosWant(w), 'w=' + w + ' rows with m > 0 ran');
        assert.equal(p.table.length, p.rows);
    });

    test('E4 bad keys touch nothing (0 reads, 0 writes on all 8 columns), w=' + w, T, async () => {
        const p = await phase(w, 'bad');
        assert.deepEqual(p.fails, []);
        assert.equal(p.rows, 13 * 5);
    });

    test('E4 full reject: 1 touch, 0 writes, _key/_next/_prev unread, state unchanged, w=' + w, T, async (t) => {
        const p = await phase(w, 'e4');
        t.diagnostic(p.table.join(' | '));
        assert.deepEqual(p.fails, []);
        assert.equal(p.rows, 3);
    });

    test('E3 ' + N_OPS + ' seeded random ops: kick-free touches == countModel, w=' + w, T, async (t) => {
        const p = await phase(w, 'random');
        t.diagnostic('seed=' + SEED + ' ops by kind=' + p.opCounts.join(',') + ' rows(' +
            'bad,has,qPres,qAbs,minmax,addPres,addFull,addNew,delAbs,delPres)=' + p.rowCounts.join(',') +
            ' kick-free=' + p.free + ' kicked=' + p.kicked + ' (kicks ' + p.kicks + ') mismatches=' + p.mismatches);
        assert.deepEqual(p.fails, [], 'seed=' + SEED + ' U=' + U);
        assert.equal(p.mismatches, 0);
        assert.equal(p.opCounts.length, 7);
        for (let k = 0; k < 7; k++) {
            assert.ok(p.opCounts[k] >= 1000, 'w=' + w + ' op kind ' + k + ' ran ' + p.opCounts[k] + ' < 1000');
        }
        for (let k = 0; k < p.rowCounts.length; k++) {
            assert.ok(p.rowCounts[k] >= 5, 'w=' + w + ' row kind ' + k + ' ran ' + p.rowCounts[k] + ' < 5');
        }
        assert.ok(p.kicked * 100 <= N_OPS, 'w=' + w + ' kicked ' + p.kicked + ' > 1% of ' + N_OPS + ' ops: the kick-free comparison no longer covers the stream');
        assert.equal(p.free + p.kicked, N_OPS);
    });
}

// --- the cross-w fits -----------------------------------------------------------

const FIT_WS = [2, 4, 8, 16, 32];
const LOG = FIT_WS.map((w) => Math.log2(w));

test('E2 absent successor: 2, 3, 4, 5, 6 touches; R^2 vs log2(w) = 1.0000, vs w = 0.8710', T, async () => {
    const ys = [];
    for (const w of FIT_WS) ys.push((await phase(w, 'exact')).absSucc);
    assert.deepEqual(ys, [2, 3, 4, 5, 6]);
    assert.equal(rSquared(LOG, ys).toFixed(4), '1.0000');
    assert.equal(rSquared(FIT_WS, ys).toFixed(4), '0.8710');
    assert.equal((await phase(1, 'exact')).absSucc, 1, 'w=1: T = 0, one touch');
});

test('E3 add on empty: 4, 7, 12, 21, 38 touches; R^2 vs w = 0.9983, vs log2(w) = 0.8975', T, async () => {
    const ys = [];
    for (const w of FIT_WS) ys.push((await phase(w, 'exact')).addEmpty);
    assert.deepEqual(ys, [4, 7, 12, 21, 38]);
    assert.equal(rSquared(FIT_WS, ys).toFixed(4), '0.9983');
    assert.equal(rSquared(LOG, ys).toFixed(4), '0.8975');
    assert.ok(rSquared(FIT_WS, ys) > rSquared(LOG, ys), 'the update path is honestly O(w)');
    assert.equal((await phase(1, 'exact')).addEmpty, 2, 'w=1: 1 + 0 + 1 touches');
});

// --- controls: each mutant must FAIL the gate -----------------------------------

test('control: rSquared is not vacuous (exact line 1, flat noise < 1)', T, () => {
    assert.equal(rSquared([1, 2, 3], [2, 4, 6]).toFixed(4), '1.0000');
    assert.ok(rSquared([1, 2, 3, 4], [1, 5, 2, 4]) < 0.5);
});

test('control M-linear: a linear walk over levels fails the absent-query rows', T, async () => {
    const f = await ctlFails('linear');
    assert.ok(f.some((m) => /succ absent|pred absent/.test(m) && /touches/.test(m)), f.slice(0, 3).join('\n'));
});

test('control M-cachedOcc: a cached occ reference reads 0 and fails has(absent)', T, async () => {
    const f = await ctlFails('cachedOcc');
    assert.ok(f.some((m) => /has absent/.test(m) && /occ reads 0 != 8/.test(m)), f.slice(0, 3).join('\n'));
});

test('control M-fullwalk: an update walk to L > 0 fails the add rows with m > 0', T, async () => {
    const f = await ctlFails('fullwalk');
    assert.ok(f.some((m) => /add new/.test(m) && /touches/.test(m)), f.slice(0, 3).join('\n'));
});

test('control M-fullLate: the capacity check after the leaf pop fails the E4 full reject', T, async () => {
    const f = await ctlFails('fullLate');
    assert.ok(f.some((m) => /e4 full reject/.test(m) && /_key\/_next\/_prev read/.test(m)), f.slice(0, 3).join('\n'));
});

test('control: every mutant anchor is found exactly once (a missing one throws in mutate)', T, () => {
    assert.equal(Object.keys(MUTANTS).length, 4);
    assert.throws(() => mutate([['this text is not in LogLogN.js', 'x']]), /not found/);
    assert.throws(() => mutate([['const ', 'let ']]), /more than once/);
});

test('control: a worker that never returns is terminated and reported as a FAIL', T, async () => {
    const r = await runWorker('for (;;) {}', { eval: true }, 300, 'spin');
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
    assert.equal(Object.keys(r.parts).length, 0);
});
