/**
 * @zakkster/lite-loglogn -- StratifiedBitset at a >= 2^31 universe (D11, OPT-IN,
 * DETERMINISTIC). NOT in the default `npm test` glob (test/*.test.js): run it
 * with `node test/big/run.mjs` (the `test:big` script), which sets
 * LOGLOGN_BIG=1 and propagates the exit code.
 *
 * Inside a worker_threads Worker (test/big/_big-worker.mjs) with the KILL_MS
 * kill timer of test/_worker-run.mjs: U = 2^31 + 64 (7 levels, ~277 MB),
 * add(2^31 + 5); successor(2^31) === 2^31 + 5 and predecessor(2^31 + 10) ===
 * 2^31 + 5 (the level-0 peel returns: a dropped `>>> 0` yields a negative key),
 * min / max, the climb + descend returns, and a second key at U - 1. Keys >= 2^31
 * exist only here; below 2^31 a missing `>>> 0` is unobservable.
 *
 * Flag contract (fail closed): LOGLOGN_BIG unset or '' -> every test is a SKIP
 * whose reason names the flag and the script. LOGLOGN_BIG=1 -> ANY failure to
 * build or probe (a RangeError, a worker OOM / nonzero exit, a hang, a missing
 * result) is a FAIL, never a skip. Any other value -> FAIL (a typo never skips).
 *
 * Control (must fail, flag set): the shipped source with the `>>> 0` dropped
 * from successor's level-0 peel return (one exact replacement, asserted to
 * match once, loaded via a data: URL) must answer successor(2^31) !== 2^31 + 5.
 * Every test passes { timeout: 120000 }.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { KILL_MS } from '../_worker-run.mjs';
import { BIG_U, BIG_KEY } from './_big-worker.mjs';

const T = { timeout: 120000 };
const WORKER_URL = new URL('./_big-worker.mjs', import.meta.url);
const FLAG = process.env.LOGLOGN_BIG;
const ENABLED = FLAG === '1';
const SKIP = FLAG === undefined || FLAG === ''
    ? 'opt-in: set LOGLOGN_BIG=1 (or run `node test/big/run.mjs`, the test:big script); allocates ~277 MB'
    : false;

const NOSHR_FROM = 'if (v !== 0) return ((p << 5) | (31 - Math.clz32(v & -v))) >>> 0;';
const NOSHR_TO = 'if (v !== 0) return ((p << 5) | (31 - Math.clz32(v & -v)));';

function countOf(text, sub) {
    let n = 0;
    let at = text.indexOf(sub);
    while (at !== -1) {
        n++;
        at = text.indexOf(sub, at + sub.length);
    }
    return n;
}

/** The test's own SPEC formula: 4 x sum W(L), W0 = ceil(U/32), stop at W = 1. */
function specBytes(U) {
    let w = Math.ceil(U / 32);
    let total = w;
    while (w > 1) {
        w = Math.ceil(w / 32);
        total += w;
    }
    return total * 4;
}

function runWorker(src, label) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(WORKER_URL, { workerData: { bigJob: true, src }, stdout: true, stderr: true });
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

async function expectObs(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');
    assert.equal(r.result.ok, true, String(r.result.message));
    return r.result.obs;
}

// One big allocation at a time (~277 MB each): the control starts after the main job.
let MAIN = null;
let CTRL = null;
if (ENABLED) {
    MAIN = runWorker(null, 'U=2^31+64');
    CTRL = MAIN.then(() => {
        const text = readFileSync(new URL('../../LogLogN.js', import.meta.url), 'utf8');
        const n = countOf(text, NOSHR_FROM);
        if (n !== 1) return { result: null, error: 'NOSHR replacement matched ' + n + ' times (need exactly 1)' };
        return runWorker(text.replace(NOSHR_FROM, NOSHR_TO), 'NOSHR U=2^31+64');
    });
}

test('D11 flag: LOGLOGN_BIG is unset, empty or exactly 1 (a typo never skips)', { ...T, skip: SKIP }, () => {
    assert.equal(FLAG, '1', 'LOGLOGN_BIG must be 1 to run (got ' + JSON.stringify(FLAG) + ')');
});

test('D11 U=2^31+64: keys >= 2^31 come back as uint32 (peel, climb, min / max)', { ...T, skip: SKIP }, async (t) => {
    assert.ok(ENABLED, 'LOGLOGN_BIG=' + JSON.stringify(FLAG) + ' is not 1');
    const o = await expectObs(MAIN);
    t.diagnostic(JSON.stringify(o));
    assert.equal(o.universe, BIG_U);
    assert.equal(o.levels, 7);
    assert.equal(o.byteLength, specBytes(BIG_U));
    assert.equal(o.sizeEmpty, 0);
    assert.equal(o.minEmpty, undefined);
    assert.equal(o.size1, 1);
    assert.equal(o.has, true);
    assert.equal(o.succPeel, BIG_KEY, 'successor(2^31) (level-0 peel)');
    assert.equal(o.predPeel, BIG_KEY, 'predecessor(2^31 + 10) (level-0 peel)');
    assert.equal(o.min, BIG_KEY);
    assert.equal(o.max, BIG_KEY);
    assert.equal(o.succClimb, BIG_KEY, 'successor(0) (climb + descend)');
    assert.equal(o.predClimb, BIG_KEY, 'predecessor(U - 1) (climb + descend)');
    assert.equal(o.succNone, undefined);
    assert.equal(o.predNone, undefined);
    assert.equal(o.succTop, BIG_U - 1);
    assert.equal(o.predTop, BIG_KEY);
    assert.equal(o.maxTop, BIG_U - 1);
    assert.equal(o.size2, 2);
});

test('D11 control: successor peel without `>>> 0` returns a negative key at 2^31', { ...T, skip: SKIP }, async (t) => {
    assert.ok(ENABLED, 'LOGLOGN_BIG=' + JSON.stringify(FLAG) + ' is not 1');
    const o = await expectObs(CTRL);
    t.diagnostic('NOSHR succPeel=' + o.succPeel + ' predPeel=' + o.predPeel);
    assert.notEqual(o.succPeel, BIG_KEY, 'the control must diverge');
    assert.equal(o.succPeel, BIG_KEY - 4294967296);
    assert.equal(o.predPeel, BIG_KEY, 'only successor was mutated');
});
