/**
 * @zakkster/lite-loglogn -- StratifiedBitset TIER PARITY gate (B1c A9 + A10,
 * DETERMINISTIC).
 *
 * A9: the build under test (../LogLogN.js) replays the seeded tier stream
 * (test/helpers/tierStream.mjs: mixed / dense / sparse / edge phases + bad keys)
 * for 11 universes U in {1, 32, 33, 1024, 1025, 32768, 32769, 2^20, 2^20+1,
 * 2^25, 2^25+1}, 2e5 ops each, through the D7 counting Proxy. Its results hash,
 * (R, Wr) hash, sumR and sumWr must EQUAL test/vectors/tier-b1a.json, cut from
 * the frozen B1a body (git blob recorded in the JSON): same answers, same exact
 * word counts, op for op. Controls (each a passing test that proves teeth):
 * one extra `_bits` read in has() changes the counts hash (results unchanged);
 * a successor wrong only at U=33 for x >= 31 changes U=33's results hash and
 * still matches U=32's.
 *
 * A10: `node --print-bytecode --print-bytecode-filter=<name>` (a child process
 * with its own kill timeout) on the driver mode of test/_tier-worker.mjs: every
 * hot method (has / add / delete / successor / predecessor / min / max) is
 * found exactly once (missing or ambiguous = FAIL) and its `Bytecode length`
 * is <= the `--max-inlined-bytecode-size` default read from `node --v8-options`
 * at test time (unparseable = FAIL). Control: a generated function over the cap
 * is reported over.
 *
 * HANG RULE: every replay runs in a worker_threads Worker (test/_tier-worker.mjs)
 * with a 100 s kill timer; a hang, a worker error, a nonzero exit or a missing
 * result is a FAIL. All jobs start at module load, in parallel; each test
 * awaits its own. Every test passes { timeout: 120000 }.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STREAM_VERSION } from './helpers/tierStream.mjs';

const T = { timeout: 120000 };
const KILL_MS = 100000;
const CHILD_MS = 60000;
const WORKER_URL = new URL('./_tier-worker.mjs', import.meta.url);
const WORKER_PATH = fileURLToPath(WORKER_URL);
const VEC = JSON.parse(readFileSync(new URL('./vectors/tier-b1a.json', import.meta.url), 'utf8'));
const US = [1, 32, 33, 1024, 1025, 32768, 32769, 2 ** 20, 2 ** 20 + 1, 2 ** 25, 2 ** 25 + 1];
const HOT = ['has', 'add', 'delete', 'successor', 'predecessor', 'min', 'max'];
const SYNTH = 'tierSyntheticOver';

const ROWS = new Map();
if (Array.isArray(VEC.rows)) for (const r of VEC.rows) ROWS.set(r.U, r);

// --- runners (never reject) ----------------------------------------------------

function runWorker(spec, options, ms, label) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        // own stdio (not piped into process.stdout: 15 workers would trip
        // MaxListenersExceededWarning); stderr is kept for the FAIL message
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

function tierJob(U, variant) {
    const row = ROWS.get(U);
    if (row === undefined) return Promise.resolve({ result: null, error: 'no vector row for U=' + U });
    return runWorker(WORKER_URL, {
        workerData: { tierJob: true, U, nOps: VEC.nOps, seed: row.seed, variant },
    }, KILL_MS, 'U=' + U + ' ' + variant);
}

function runChild(args) {
    return new Promise((resolve) => {
        execFile(process.execPath, args, {
            encoding: 'utf8', timeout: CHILD_MS, killSignal: 'SIGKILL', maxBuffer: 1 << 26,
        }, (err, stdout) => {
            resolve({ error: err ? String(err.message) + (err.signal ? ' signal ' + err.signal : '') : null, stdout });
        });
    });
}

async function expectResult(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');
    assert.equal(r.result.ok, true, String(r.result.message));
    return r.result.result;
}

/** Fail-closed parse of the inlining cap from `node --v8-options` text. */
function parseCap(text) {
    const m = /--max-inlined-bytecode-size=(\d+)\b/.exec(text);
    if (m === null) return NaN;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 ? n : NaN;
}

/** Exactly one `Bytecode length` for a function named `name`, else NaN. */
function parseLength(text, name) {
    const re = /\[generated bytecode for function: (\S*) [^\]]*\]\s*\n\s*Bytecode length: (\d+)/g;
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) hits.push(m);
    const headers = text.split('[generated bytecode for function: ').length - 1;
    if (headers !== 1 || hits.length !== 1 || hits[0][1] !== name) return NaN;
    return Number(hits[0][2]);
}

/** Names whose length is over the cap or not a finite number (fail closed). */
function overCap(lengths, cap) {
    const over = [];
    for (const name of Object.keys(lengths)) {
        const n = lengths[name];
        if (!Number.isFinite(cap) || !Number.isFinite(n) || !(n <= cap)) over.push(name);
    }
    return over;
}

// --- all jobs start now, in parallel ---------------------------------------------

const MAIN = new Map();
for (const U of US) MAIN.set(U, tierJob(U, 'none'));
const CTRL_EXTRA = tierJob(1024, 'extraRead');
const CTRL_S33 = tierJob(33, 'succ33');
const CTRL_S32 = tierJob(32, 'succ33');
const CAP_JOB = runChild(['--v8-options']);
const BC = new Map();
for (const name of [...HOT, SYNTH]) {
    BC.set(name, runChild(['--print-bytecode', '--print-bytecode-filter=' + name, WORKER_PATH,
        '--tier-bytecode-driver']));
}

async function bytecodeLength(name) {
    const r = await BC.get(name);
    assert.equal(r.error, null, name + ' bytecode child: ' + r.error);
    const n = parseLength(r.stdout, name);
    assert.ok(Number.isInteger(n) && n > 0, name + ': bytecode not found exactly once');
    return n;
}

async function inliningCap() {
    const r = await CAP_JOB;
    assert.equal(r.error, null, '--v8-options child: ' + r.error);
    const cap = parseCap(r.stdout);
    assert.ok(Number.isInteger(cap), '--max-inlined-bytecode-size default not parseable');
    return cap;
}

// --- A9 ------------------------------------------------------------------------------

test('A9 vectors file is well formed (11 U, 2e5 ops, stream version, sparse phases)', T, () => {
    assert.equal(VEC.streamVersion, STREAM_VERSION, 'tierStream changed: re-cut the vectors from the frozen B1a');
    assert.equal(VEC.nOps, 200000);
    assert.deepEqual(VEC.rows.map((r) => r.U), US);
    for (const r of VEC.rows) {
        assert.ok(Number.isInteger(r.seed) && r.seed >= 0, 'U=' + r.U + ' seed');
        assert.match(r.resultsHash, /^[0-9a-f]{8}$/);
        assert.match(r.countsHash, /^[0-9a-f]{8}$/);
        assert.ok(Number.isInteger(r.sumR) && Number.isInteger(r.sumWr));
        for (let k = 0; k < 7; k++) assert.ok(r.opCounts[k] >= 5000, 'U=' + r.U + ' op ' + k);
        // successor / predecessor across >= 2 empty 1,024-key blocks
        if (r.U >= 32768) assert.ok(r.sparseCross >= 1000, 'U=' + r.U + ' sparseCross ' + r.sparseCross);
    }
});

for (const U of US) {
    test('A9 tier parity vs B1a vectors, U=' + U, T, async () => {
        const got = await expectResult(MAIN.get(U));
        const want = ROWS.get(U);
        // stream identity first: a changed generator is a stale cut, not a build bug
        assert.deepEqual(got.opCounts, want.opCounts, 'U=' + U + ' stream changed (opCounts)');
        assert.equal(got.sparseCross, want.sparseCross, 'U=' + U + ' stream changed (sparseCross)');
        assert.equal(got.levels, want.levels, 'U=' + U + ' levels');
        assert.equal(got.resultsHash, want.resultsHash, 'U=' + U + ' results hash');
        assert.equal(got.countsHash, want.countsHash, 'U=' + U + ' (R, Wr) hash');
        assert.equal(got.sumR, want.sumR, 'U=' + U + ' sumR');
        assert.equal(got.sumWr, want.sumWr, 'U=' + U + ' sumWr');
        assert.equal(got.size, want.size, 'U=' + U + ' final size');
    });
}

test('A9 control: one extra _bits read in has() changes the counts hash only', T, async () => {
    const base = await expectResult(MAIN.get(1024));
    const c = await expectResult(CTRL_EXTRA);
    assert.notEqual(c.countsHash, base.countsHash);
    assert.equal(c.resultsHash, base.resultsHash);
    assert.equal(c.sumR, base.sumR + base.opCounts[2], 'one extra read per has()');
    assert.equal(c.sumWr, base.sumWr);
});

test('A9 control: successor wrong only at U=33, x >= 31 changes U=33 and matches U=32', T, async () => {
    const b33 = await expectResult(MAIN.get(33));
    const c33 = await expectResult(CTRL_S33);
    assert.notEqual(c33.resultsHash, b33.resultsHash);
    assert.equal(c33.countsHash, b33.countsHash);
    const b32 = await expectResult(MAIN.get(32));
    const c32 = await expectResult(CTRL_S32);
    assert.equal(c32.resultsHash, b32.resultsHash);
    assert.equal(c32.countsHash, b32.countsHash);
});

test('hang rule control: a worker that never returns is terminated and reported as a FAIL', T, async () => {
    const r = await runWorker('for (;;) {}', { eval: true }, 300, 'spin');
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
    assert.equal(r.result, null);
});

// --- A10 -----------------------------------------------------------------------------

test('A10 inlining cap is read from --max-inlined-bytecode-size (fail closed)', T, async () => {
    const cap = await inliningCap();
    assert.ok(cap > 0);
    assert.ok(Number.isNaN(parseCap('no such flag here')));
    assert.ok(Number.isNaN(parseCap('--max-inlined-bytecode-size-cumulative=920')));
});

test('A10 all 7 hot methods are found and each is <= the inlining cap', T, async (t) => {
    const cap = await inliningCap();
    const lengths = {};
    for (const name of HOT) lengths[name] = await bytecodeLength(name);
    t.diagnostic('cap=' + cap + ' ' + JSON.stringify(lengths));
    assert.deepEqual(overCap(lengths, cap), [], 'over the inlining cap ' + cap + ': ' + JSON.stringify(lengths));
});

test('A10 control: a synthetic function over the cap is reported over; missing = over', T, async () => {
    const cap = await inliningCap();
    const n = await bytecodeLength(SYNTH);
    assert.ok(n > cap, SYNTH + ' length ' + n + ' must exceed cap ' + cap);
    assert.deepEqual(overCap({ [SYNTH]: n }, cap), [SYNTH]);
    assert.deepEqual(overCap({ has: NaN }, cap), ['has']);
    assert.deepEqual(overCap({ has: 1 }, NaN), ['has']);
    assert.ok(Number.isNaN(parseLength('', 'has')), 'missing bytecode must not parse');
    const one = '[generated bytecode for function: has (0x1 <SharedFunctionInfo has>)]\nBytecode length: 68\n';
    assert.equal(parseLength(one, 'has'), 68);
    assert.ok(Number.isNaN(parseLength(one + one, 'has')), 'ambiguous match must not parse');
});
