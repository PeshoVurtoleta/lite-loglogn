// Oracle.test.js -- independent oracle fuzz for StratifiedBitset (assertion A1).
//
// What this proves: over >= 1,000,000 seeded operations across universes
// {1, 2, 31, 32, 33, 1025, 32768, 65536, 65537, 999983, 2^20}, every return
// value (add -> this, delete, has, successor, predecessor, min, max) and
// `size` after EVERY op equals an independent reference. Phases cover random
// and boundary keys, sparse sets (successor/predecessor crossing >= 2 empty
// 1,024-key blocks), dense fill/drain of a whole 1,024 block, queries in the
// last 32-bit word / last 1,024 block of the universe with a nonempty set and
// an undefined answer (gives a dropped level-end bound teeth), and periodic
// clear(). A broken subclass (control) must show > 0 divergences.
//
// Oracle design (test/_oracle-harness.mjs): Uint8Array membership. For
// U <= 2^16, successor / predecessor / min / max are linear scans. For
// U > 2^16 a sorted plain array of members is maintained on add/delete and
// queried with the harness's OWN binary search. No code is shared with
// LogLogN.js.
//
// Hang safety: each universe runs in a worker_threads Worker; the parent
// terminates it after 100 s (before the 120 s test timeout) and FAILS the test, because a synchronous
// infinite loop in the implementation cannot be stopped by a test timeout.
// All jobs are spawned up front (parallel), so a fully hanging build fails in
// ~100 s total instead of 100 s per universe.
//
// Written from the SPEC (API and semantics) without reading LogLogN.js.
// Seed: printed per run; override with env LOGLOGN_SEED (32-bit integer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { parseSeed } from './helpers/seed.mjs';

const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0x1badf00d);
const TIMEOUT = { timeout: 120000 };
const HARNESS = new URL('./_oracle-harness.mjs', import.meta.url);

function runJob(job) {
    return new Promise((resolve, reject) => {
        let done = false;
        const w = new Worker(HARNESS, { workerData: { oracleJob: true, ...job } });
        const fin = (fn, v) => { if (done) return; done = true; clearTimeout(tm); w.terminate(); fn(v); };
        const tm = setTimeout(() => fin(reject, new Error('hang > 100 s: worker terminated')), 100000);
        w.on('message', (m) => fin(resolve, m));
        w.on('error', (e) => fin(reject, e));
        w.on('exit', (c) => fin(reject, new Error('worker exited (code ' + c + ') without a result')));
    });
}

const PLAN = [
    [1, 30000], [2, 30000], [31, 60000], [32, 60000], [33, 60000],
    [1025, 100000], [32768, 60000], [65536, 60000], [65537, 150000],
    [999983, 250000], [1048576, 250000],
];
let totalOps = 0;
const cov = {
    undefNonEmptySucc: 0, crossSucc: 0, crossPred: 0, lastWordSucc: 0,
};

const JOBS = new Map();
for (const [U, n] of PLAN) {
    const seed = (BASE_SEED ^ Math.imul(U, 0x9E3779B1)) >>> 0;
    const p = runJob({ mode: 'fuzz', U, n, seed });
    p.catch(() => {}); // awaited (and asserted) inside the test below
    JOBS.set(U, p);
}
const CONTROL = runJob({ mode: 'control', U: 65537, n: 10000, seed: (BASE_SEED ^ 0x51ED270B) >>> 0 });
const SELF = runJob({ mode: 'selfcheck', seed: (BASE_SEED ^ 0xABCDEF) >>> 0 });
CONTROL.catch(() => {}); SELF.catch(() => {});

for (const [U, n] of PLAN) {
    test('oracle fuzz U=' + U, TIMEOUT, async (t) => {
        const seed = (BASE_SEED ^ Math.imul(U, 0x9E3779B1)) >>> 0;
        const msg = 'seed base=0x' + BASE_SEED.toString(16) + ' U=' + U + ' derived=0x' + seed.toString(16);
        t.diagnostic(msg);
        console.log('[oracle] ' + msg);
        const st = await JOBS.get(U);
        totalOps += st.ops;
        for (const k in cov) cov[k] += st.cov[k];
        t.diagnostic('ops=' + st.ops + ' divergences=' + st.div);
        console.log('[oracle] U=' + U + ' ops=' + st.ops + ' div=' + st.div);
        assert.equal(st.div, 0, 'first divergence: ' + JSON.stringify(st.first, (k, v) => v === undefined ? 'undefined' : v));
        assert.ok(st.ops >= n, 'op budget met');
    });
}

test('oracle fuzz totals and coverage floors', TIMEOUT, (t) => {
    t.diagnostic('total ops=' + totalOps + ' cov=' + JSON.stringify(cov));
    console.log('[oracle] total ops=' + totalOps + ' cov=' + JSON.stringify(cov));
    assert.ok(totalOps >= 1000000, 'total ops >= 1e6, got ' + totalOps);
    assert.ok(cov.undefNonEmptySucc >= 1000, 'undefined-answer successor on nonempty set: ' + cov.undefNonEmptySucc);
    assert.ok(cov.lastWordSucc >= 200, 'successor in last word, undefined answer: ' + cov.lastWordSucc);
    assert.ok(cov.crossSucc >= 1000, 'successor crossing >= 2 empty blocks: ' + cov.crossSucc);
    assert.ok(cov.crossPred >= 1000, 'predecessor crossing >= 2 empty blocks: ' + cov.crossPred);
});

// Control (A1): a deliberately broken subclass (successor(x) -> super.successor(x + 1),
// defined inside the worker, mode 'control') must be seen by the same harness.
test('oracle control: Broken successor is detected', TIMEOUT, async () => {
    const st = await CONTROL;
    console.log('[oracle] control divergences=' + st.div);
    assert.ok(st.div > 0, 'harness must report divergences for a broken successor');
});

// Self-check of the oracle itself: binary-search path vs brute-force linear scan.
test('oracle self-check: binary-search path agrees with linear scan', TIMEOUT, async () => {
    const st = await SELF;
    assert.equal(st.div, 0);
});
