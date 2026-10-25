/**
 * @zakkster/lite-loglogn -- worker / subprocess gates never pass vacuously (F10,
 * from the lite-pick QA harness 2026-10-23).
 *
 * Every gate that spawns a child is fed five fakes (test/fakes/): no result, a
 * nonzero exit, garbage, a hang past the kill timer, and NaN. Each (gate, fake)
 * row must report a FAIL; a gate that reports a pass on any of them is vacuous.
 *
 *   startFn   test/_worker-run.mjs startFn + expectFn (the real exports, ms = 300)
 *   sibling   the runner of SiblingOracle.test.js, simplified copy, pinned by the drift test (it is local to
 *             that file), + its expectResult checks, over test/_sibling-worker.mjs
 *   big       the runner of big/BigUniverse.test.js, simplified copy, pinned by the drift test, + its
 *             expectObs checks, over test/big/_big-worker.mjs
 *   launcher  test/big/run.mjs (copied next to a fake BigUniverse.test.js)
 *
 * The expected outcome of every row is "FAIL" and is hand-written here, never read
 * from a run. Each gate also has a positive control (a good input passes) so the
 * verdict functions cannot be always-fail. Fast: the kill timer is 300 ms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFn, expectFn } from './_worker-run.mjs';
import startEmpty from './fakes/startfn-empty.mjs';
import startExit1 from './fakes/startfn-exit1.mjs';
import startGarbage from './fakes/startfn-garbage.mjs';
import startKill from './fakes/startfn-kill.mjs';
import startNan from './fakes/startfn-nan.mjs';

const KILL = 300;
const FAKES = ['empty', 'exit1', 'garbage', 'kill', 'nan'];
const SIBLING_URL = new URL('./_sibling-worker.mjs', import.meta.url);
const BIG_URL = new URL('./big/_big-worker.mjs', import.meta.url);
const FAKE_DIR = new URL('./fakes/', import.meta.url);
// env override exists only for the before/after proof on a scratch copy of run.mjs
const RUN_MJS = process.env.WORKERFAKES_RUN_MJS || fileURLToPath(new URL('./big/run.mjs', import.meta.url));

const rows = [];   // [gate, fake, failed] -- the coverage floor counts these

function moduleSrc(fake) {
    return readFileSync(new URL('module-' + fake + '.mjs', FAKE_DIR), 'utf8');
}

// --- runner copy (SiblingOracle.test.js runWorker / BigUniverse.test.js runWorker) ----

function runWorker(spec, options, ms, label) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(spec, { ...options, stdout: true, stderr: true });
        w.stdout.resume();
        w.stderr.resume();
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result, error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            result = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + String(e)));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

// --- verdicts: mirror the consumer asserts; return a reason string or null (= pass) ----

function siblingVerdict(r) {
    if (r.error !== null) return 'error: ' + r.error;
    if (r.result === null || typeof r.result !== 'object') return 'no result';
    if (r.result.ok !== true) return 'not ok: ' + r.result.message;
    const x = r.result.result;
    for (const name of ['BitSet', 'EliasFano', 'Scapegoat', 'SortedArray']) {
        const b = x.oracles[name];
        if (b === null || !(b.cmp > 0)) return name + ' compared nothing';
        if (b.div !== 0) return name + ' diverged';
    }
    if (!(x.contract.cmp > 0)) return 'no contract checks';
    if (x.contract.div !== 0) return 'contract diverged';
    return null;
}

function bigVerdict(r) {
    if (r.error !== null) return 'error: ' + r.error;
    if (r.result === null || typeof r.result !== 'object') return 'no result';
    if (r.result.ok !== true) return 'not ok: ' + r.result.message;
    const o = r.result.obs;
    // hand-written spec values (BigUniverse.test.js lines 122-140): U = 2^31 + 64, key = 2^31 + 5
    const want = [['universe', 2147483712], ['levels', 7], ['sizeEmpty', 0], ['size1', 1],
        ['has', true], ['succPeel', 2147483653], ['min', 2147483653], ['size2', 2]];
    for (const [k, v] of want) if (!Object.is(o[k], v)) return k + ' = ' + o[k];
    return null;
}

function record(gate, fake, reason) {
    rows.push([gate, fake, reason !== null]);
}

// --- gate 1: startFn / expectFn ----------------------------------------------------

const START = { empty: startEmpty, exit1: startExit1, garbage: startGarbage, kill: startKill, nan: startNan };

for (const fake of FAKES) {
    test('startFn gate fails on fake ' + fake, async () => {
        const job = startFn(START[fake], 'fake-' + fake, KILL);
        const r = await job;
        let reason = null;
        try {
            await expectFn(Promise.resolve(r));
        } catch (e) {
            reason = String(e && e.message);
        }
        record('startFn', fake, reason);
        assert.ok(reason !== null, 'expectFn passed fake ' + fake);
        if (fake === 'kill') assert.match(r.error, /^hang > 300 ms/);
        if (fake === 'empty') assert.equal(r.result, null);
    });
}

test('startFn gate positive control: a good body passes', async () => {
    await expectFn(startFn(function ({ assert }) { assert.equal(1 + 1, 2); }, 'good', 5000));
});

// --- gate 2: sibling worker ----------------------------------------------------------

function siblingJob(src, ms, nOps = 300) {
    return runWorker(SIBLING_URL, { workerData: { siblingJob: true, U: 4096, nOps, seed: 12345, src } }, ms, 'sibling');
}

for (const fake of FAKES) {
    test('sibling gate fails on fake ' + fake, async () => {
        const r = await siblingJob(moduleSrc(fake), KILL);
        const reason = siblingVerdict(r);
        record('sibling', fake, reason);
        assert.ok(reason !== null, 'sibling gate passed fake ' + fake);
        if (fake === 'kill') assert.match(r.error, /^hang > 300 ms/);
        if (fake === 'empty') assert.ok(r.result === null && r.error === null);
        if (fake === 'exit1') assert.match(r.error, /exit code 1/);
        if (fake === 'garbage') assert.equal(r.result.ok, false);
        if (fake === 'nan') assert.ok(r.result.ok === true && r.result.result.oracles.EliasFano.div > 0);
    });
}

test('sibling gate positive control: the shipped build passes', async () => {
    const r = await siblingJob(null, 20000, 2048);
    assert.equal(siblingVerdict(r), null);
});

// --- gate 3: big worker --------------------------------------------------------------

for (const fake of FAKES) {
    test('big gate fails on fake ' + fake, async () => {
        const r = await runWorker(BIG_URL, { workerData: { bigJob: true, src: moduleSrc(fake) } }, KILL, 'big');
        const reason = bigVerdict(r);
        record('big', fake, reason);
        assert.ok(reason !== null, 'big gate passed fake ' + fake);
        if (fake === 'kill') assert.match(r.error, /^hang > 300 ms/);
        if (fake === 'empty') assert.ok(r.result === null && r.error === null);
        if (fake === 'exit1') assert.match(r.error, /exit code 1/);
        if (fake === 'garbage') assert.equal(r.result.ok, false);
        if (fake === 'nan') assert.ok(r.result.ok === true && Number.isNaN(r.result.obs.universe));
    });
}

test('big gate positive control: a correct observation passes the verdict', () => {
    const o = { universe: 2147483712, levels: 7, sizeEmpty: 0, size1: 1, has: true,
        succPeel: 2147483653, min: 2147483653, size2: 2 };
    assert.equal(bigVerdict({ result: { ok: true, obs: o }, error: null }), null);
});

// --- gate 4: big/run.mjs launcher ------------------------------------------------------

function launch(fakeFile) {
    const dir = mkdtempSync(join(tmpdir(), 'loglogn-f10-'));
    try {
        copyFileSync(RUN_MJS, join(dir, 'run.mjs'));
        copyFileSync(fakeFile, join(dir, 'BigUniverse.test.js'));
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;   // a nested node --test must not join this run
        return spawnSync(process.execPath, [join(dir, 'run.mjs')], { env, encoding: 'utf8', timeout: 20000 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

for (const fake of [...FAKES, 'skip']) {
    test('launcher gate fails on fake ' + fake, () => {
        const r = launch(fileURLToPath(new URL('launcher-' + fake + '.mjs', FAKE_DIR)));
        const reason = r.status === 0 ? null : 'exit ' + r.status;
        record('launcher', fake, reason);
        assert.notEqual(r.status, 0, 'launcher exited 0 on fake ' + fake + ' | ' + r.stdout.slice(-200));
    });
}

test('launcher gate positive control: one passing test exits 0', () => {
    const r = launch(fileURLToPath(new URL('launcher-good.mjs', FAKE_DIR)));
    assert.equal(r.status, 0, String(r.stdout).slice(-300) + String(r.stderr).slice(-300));
});

// --- drift pin: the runner / verdict copies above vs the two consumer files ---------

test('drift pin: pinned runner and assert lines occur exactly once in both consumers', () => {
    const PINNED = [
        "w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));",
        'result = m;',
        'if (done) return;',
        'assert.equal(r.error, null, String(r.error));',
        "assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');",
        'assert.equal(r.result.ok, true, String(r.result.message));',
    ];
    for (const rel of ['./SiblingOracle.test.js', './big/BigUniverse.test.js']) {
        const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
        for (const line of PINNED) {
            assert.equal(text.split(line).length - 1, 1, rel + ' must contain exactly once: ' + line);
        }
    }
});

// --- coverage floor ----------------------------------------------------------------------

test('coverage floor: 21 (gate, fake) rows ran and every one failed', () => {
    assert.equal(rows.length, 21);
    for (const [gate, fake, failed] of rows) assert.ok(failed, gate + '/' + fake + ' did not fail');
});
