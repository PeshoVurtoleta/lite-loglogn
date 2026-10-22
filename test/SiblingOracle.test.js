/**
 * @zakkster/lite-loglogn -- StratifiedBitset SIBLING ORACLES (B2a, ADDENDUM 28,
 * DETERMINISTIC). ADDS to A1 (test/Oracle.test.js stays dependency-free).
 *
 * The seeded A1-style stream (test/helpers/tierStream.mjs genStream: mixed /
 * dense / sparse / edge phases + ~3% bad keys) is replayed on the shipped
 * ../LogLogN.js and every return value and the size are compared, per op,
 * against four oracles from sibling devDependencies (mapping in
 * test/_sibling-worker.mjs):
 *   lite-o1 BitSet.nextSet      successor via nextSet(x + 1) (inclusive -> strict),
 *                               -1 -> undefined, U <= 2^25 (its cap);
 *   lite-o1 EliasFano.nextGEQ   static snapshots of the live set every 1,024 ops;
 *   lite-logn Scapegoat         strict successor / predecessor, deterministic;
 *   lite-logn SortedArray       strict successor / predecessor, min / max;
 * pools sized to the stream's exact maximum live count. Universes: the A1 set
 * {1, 2, 31, 32, 33, 1025, 32768, 65536, 65537, 999983, 2^20} (2^15 and 2^20
 * have a W(L) that is a multiple of 32, ADDENDUM 12) plus 2^25 (BitSet's cap);
 * every oracle supports all twelve. 0 divergences on every oracle and on the
 * bad-key contract. Coverage (computed from the oracle's answers, never from
 * the build): for U >= 32768, successor / predecessor across >= 2 empty
 * 1,024-key blocks; for U in {2^15, 2^16, 2^20, 2^25} (every W(L) a multiple of
 * 32), an undefined successor from the last 1,024 block of a nonempty set (past
 * the last word of every level above 0).
 *
 * MUST-FAIL CONTROL: mutant M1 (the sketch climb `i = (p >>> 5) + 1`) is built
 * from the REAL source text (one exact string replacement in successor's climb
 * loop, asserted to match exactly once, loaded via a data: URL), so the control
 * tracks the shipped body. It must diverge from EACH oracle at U = 2^15 and
 * U = 2^20. MUST-FAIL CONTROL M1P (predecessor's climb `i = (p >>> 5) - 1`) is
 * built the same way and must diverge at both U from EACH oracle that compares
 * predecessor (Scapegoat, SortedArray; BitSet and EliasFano compare successor
 * only).
 *
 * HANG RULE: every replay runs in a worker_threads Worker
 * (test/_sibling-worker.mjs) with the KILL_MS kill timer of test/_worker-run.mjs;
 * a hang, a worker error, a nonzero exit or a missing result is a FAIL. All jobs
 * start at module load, in parallel; each test awaits its own. Every test passes
 * { timeout: 120000 }. Seed: printed; override with env LOGLOGN_SEED.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { KILL_MS } from './_worker-run.mjs';
import { ORACLES } from './_sibling-worker.mjs';

const T = { timeout: 120000 };
const WORKER_URL = new URL('./_sibling-worker.mjs', import.meta.url);
const BASE_SEED = (process.env.LOGLOGN_SEED !== undefined
    ? Number(process.env.LOGLOGN_SEED) : 0x1badf00d) >>> 0;
const PLAN = [
    [1, 30000], [2, 30000], [31, 60000], [32, 60000], [33, 60000],
    [1025, 100000], [32768, 60000], [65536, 60000], [65537, 150000],
    [999983, 250000], [1048576, 250000], [33554432, 100000],
];
const CONTROL_US = [32768, 1048576];
const CONTROL_OPS = 30000;

// M1: successor's climb loop (levels >= 1) steps to (p >>> 5) + 1 instead of p + 1
const M1_FROM = 'i = p + 1;\n            if (i >= o[L + 1] - o[L]) return undefined;';
const M1_TO = 'i = (p >>> 5) + 1;\n            if (i >= o[L + 1] - o[L]) return undefined;';
// M1P: predecessor's climb loop (levels >= 1) steps to (p >>> 5) - 1 instead of p - 1
const M1P_FROM = 'i = p - 1;\n            L++;';
const M1P_TO = 'i = (p >>> 5) - 1;\n            L++;';
// the oracles whose replay compares predecessor (test/_sibling-worker.mjs)
const PRED_ORACLES = ['Scapegoat', 'SortedArray'];

function seedFor(U) {
    return (BASE_SEED ^ Math.imul(U, 0x9E3779B1)) >>> 0;
}

function countOf(text, sub) {
    let n = 0;
    let at = text.indexOf(sub);
    while (at !== -1) {
        n++;
        at = text.indexOf(sub, at + sub.length);
    }
    return n;
}

const SHIPPED = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const M1_MATCHES = countOf(SHIPPED, M1_FROM);
const M1_SRC = M1_MATCHES === 1 ? SHIPPED.replace(M1_FROM, M1_TO) : null;
const M1P_MATCHES = countOf(SHIPPED, M1P_FROM);
const M1P_SRC = M1P_MATCHES === 1 ? SHIPPED.replace(M1P_FROM, M1P_TO) : null;

// --- runner (never rejects) ------------------------------------------------------

function runWorker(spec, options, ms, label) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(spec, { ...options, stdout: true, stderr: true });
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
            finish('hang > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            result = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

function siblingJob(U, nOps, src, label) {
    return runWorker(WORKER_URL, {
        workerData: { siblingJob: true, U, nOps, seed: seedFor(U), src },
    }, KILL_MS, label);
}

async function expectResult(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');
    assert.equal(r.result.ok, true, String(r.result.message));
    return r.result.result;
}

function fmt(first) {
    return first === null ? 'none' : JSON.stringify(first);
}

// --- all jobs start now, in parallel ---------------------------------------------

const MAIN = new Map();
for (const [U, n] of PLAN) MAIN.set(U, siblingJob(U, n, null, 'U=' + U));
const CTRL = new Map();
for (const U of CONTROL_US) {
    CTRL.set(U, M1_SRC === null
        ? Promise.resolve({ result: null, error: 'M1 replacement matched ' + M1_MATCHES + ' times (need exactly 1)' })
        : siblingJob(U, CONTROL_OPS, M1_SRC, 'M1 U=' + U));
}
const CTRLP = new Map();
for (const U of CONTROL_US) {
    CTRLP.set(U, M1P_SRC === null
        ? Promise.resolve({ result: null, error: 'M1P replacement matched ' + M1P_MATCHES + ' times (need exactly 1)' })
        : siblingJob(U, CONTROL_OPS, M1P_SRC, 'M1P U=' + U));
}

// --- tests -------------------------------------------------------------------------

for (const [U, n] of PLAN) {
    test('sibling oracles U=' + U + ': 0 divergences on every return value and size', T, async (t) => {
        const msg = 'seed base=0x' + BASE_SEED.toString(16) + ' U=' + U + ' derived=0x' + seedFor(U).toString(16);
        t.diagnostic(msg);
        console.log('[sibling] ' + msg);
        const r = await expectResult(MAIN.get(U));
        assert.equal(r.nOps, n);
        let line = 'U=' + U + ' ops=' + r.nOps + ' cap=' + r.cap + ' checkpoints=' + r.checkpoints;
        for (const name of ORACLES) {
            const b = r.oracles[name];
            line += ' ' + name + '=' + b.cmp + '/' + b.div;
        }
        line += ' contract=' + r.contract.cmp + '/' + r.contract.div +
            ' sparseCross=' + r.sparseCross + ' cov=' + JSON.stringify(r.cov);
        t.diagnostic(line);
        console.log('[sibling] ' + line);
        for (const name of ORACLES) {
            const b = r.oracles[name];
            assert.ok(b !== null, name + ' must support U=' + U);
            assert.ok(b.cmp > 0, name + ' compared nothing at U=' + U);
            assert.equal(b.div, 0, name + ' U=' + U + ' first divergence: ' + fmt(b.first));
        }
        assert.ok(r.contract.cmp > 0, 'no bad-key / add contract checks at U=' + U);
        assert.equal(r.contract.div, 0, 'contract U=' + U + ' first divergence: ' + fmt(r.contract.first));
        assert.ok(r.checkpoints >= Math.floor(n / 1024), 'EliasFano checkpoints ' + r.checkpoints);
        for (let k = 0; k < 7; k++) assert.ok(r.opCounts[k] > 0, 'U=' + U + ' op ' + k + ' never ran');
        if (U >= 32768) {
            assert.ok(r.sparseCross > 0, 'U=' + U + ' no sparse crossing in the stream');
            assert.ok(r.cov.crossSucc > 0, 'U=' + U + ' no successor across >= 2 empty 1,024 blocks');
            assert.ok(r.cov.crossPred > 0, 'U=' + U + ' no predecessor across >= 2 empty 1,024 blocks');
        }
        // W(L) a multiple of 32 (U a power of two >= 2^15): the answer lies past the
        // last word of every level above 0 (ADDENDUM 12; M2's teeth)
        if (U >= 32768 && (U & (U - 1)) === 0) {
            assert.ok(r.cov.lastBlockUndef > 0, 'U=' + U + ' no undefined successor from the last 1,024 block');
        }
    });
}

test('M1 mutant is built from the shipped source (exactly one replacement)', T, () => {
    assert.equal(M1_MATCHES, 1, 'M1 site in successor\'s climb loop must match exactly once');
    assert.notEqual(M1_SRC, SHIPPED);
    assert.equal(M1_SRC.length, SHIPPED.length + M1_TO.length - M1_FROM.length);
});

for (const name of ORACLES) {
    test('M1 control: the mutant diverges from ' + name + ' at U=2^15 and U=2^20', T, async (t) => {
        for (const U of CONTROL_US) {
            const r = await expectResult(CTRL.get(U));
            const b = r.oracles[name];
            const line = 'M1 U=' + U + ' ops=' + r.nOps + ' ' + name + '=' + b.cmp + '/' + b.div +
                ' first=' + fmt(b.first);
            t.diagnostic(line);
            console.log('[sibling] ' + line);
            assert.ok(b.div > 0, 'M1 shows no divergence from ' + name + ' at U=' + U);
        }
    });
}

test('M1P mutant is built from the shipped source (exactly one replacement)', T, () => {
    assert.equal(M1P_MATCHES, 1, 'M1P site in predecessor\'s climb loop must match exactly once');
    assert.notEqual(M1P_SRC, SHIPPED);
    assert.equal(M1P_SRC.length, SHIPPED.length + M1P_TO.length - M1P_FROM.length);
    for (const name of PRED_ORACLES) assert.ok(ORACLES.includes(name), name + ' missing from ORACLES');
});

for (const name of PRED_ORACLES) {
    test('M1P control: the mutant diverges from ' + name + ' at U=2^15 and U=2^20', T, async (t) => {
        for (const U of CONTROL_US) {
            const r = await expectResult(CTRLP.get(U));
            const b = r.oracles[name];
            const line = 'M1P U=' + U + ' ops=' + r.nOps + ' ' + name + '=' + b.cmp + '/' + b.div +
                ' first=' + fmt(b.first);
            t.diagnostic(line);
            console.log('[sibling] ' + line);
            assert.ok(b.div > 0, 'M1P shows no divergence from ' + name + ' at U=' + U);
        }
    });
}

test('M1P partition: the mutant diverges from exactly PRED_ORACLES', T, async () => {
    for (const U of CONTROL_US) {
        const r = await expectResult(CTRLP.get(U));
        for (const name of ORACLES) {
            const b = r.oracles[name];
            assert.equal(b !== null && b.div > 0, PRED_ORACLES.includes(name), name + ' at U=' + U);
        }
    }
});

test('hang rule control: a worker that never returns is terminated and reported as a FAIL', T, async () => {
    const r = await runWorker('for (;;) {}', { eval: true }, 300, 'spin');
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
    assert.equal(r.result, null);
});
