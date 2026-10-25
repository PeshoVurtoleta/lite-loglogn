/**
 * @zakkster/lite-loglogn -- YFastTrie COUNT gate (0.4.0 G1-6, ASSERTION A2;
 * DETERMINISTIC hard gate: counts, not timing, prove the cost model -- C-11,
 * decisions/0004 Amendment 1).
 *
 * Proxies on the 10 columns (`_bk`, `_bn` + the inner trie's `_lv _occ _tk _tmin
 * _tmax _key _next _prev`), the inner `_q` and the outer `_n`, swapped in AFTER
 * construction (test/_yft-count-worker.mjs header: what is counted and how).
 * Expected values = the G1 cost table (PLAN-yfasttrie, C-3 / C-8 / C-10)
 * evaluated on the independent policy model YModel, never on the engine.
 *
 * Gate:
 *   exact rows at w = 1, 2, 4, 8, 16, 32 (U = 2^w): every op of the table on
 *     constructed states (empty, s = 2w-1, s = K, a split on each side, merges
 *     and borrows into the head and into a non-head bucket); touches, moves,
 *     key / `_bn` / inner writes, `_n` deltas and the hop exact; `_bk` reads in
 *     the beta range (exact at s = 2^j - 1);
 *   absent successor with s = 2w-1 at w = 2..32: touches + probes = 4, 6, 8, 10,
 *     12; R^2 vs log2(w) = 1.0000, vs w = 0.8710 (REPORTED reading of the
 *     exact counts, computed here);
 *   bad keys: 0 reads / 0 writes on all 10 columns, `_q` and `_n`;
 *   work bounds: a plain update moves <= 2w-1 words (C-8; the worst case 2w-1 is
 *     hit), a split / merge / borrow <= 2w (C-10; the split worst case 2w is hit),
 *     an inner reseed <= 32 tries;
 *   a seeded random stream per w: every kick-free op equals the table on the
 *     model state; kicked ops <= 1%;
 *   C-7 stall in a split / a borrow (from the head and from a non-head bucket):
 *     the inner RangeError passes through, 0 writes on `_bk` / `_bn` / `_n`, the
 *     state unchanged, reseedOps +1 and tries +32.
 * Table-literal findings (the cost table read additively disagrees with the
 * engine's split-left / merge moves) are printed as diagnostics, never re-tuned.
 *
 * Controls (each must FAIL; mutants replace an anchor EXACTLY once in the real
 * LogLogN.js text and load by data: URL in the worker): M-linearBucket (a linear
 * bucket scan: 63 probes at w = 32), M-doubleLocate (add locates twice),
 * M-hopRequery (the successor hop re-locates), M-badQ (has writes `_q` before
 * the key check), M-fullLate (the capacity check after the split), M-splitHalf
 * (the split copies the whole bucket, then trims: 3w moves), M-bnFirst (a borrow
 * writes `_bn` before its inner add: only the C-7 stall row and the `_bn` count
 * see it), and a worker that hangs / exits 1 / posts nothing / posts garbage.
 *
 * HANG SAFETY: every body runs in a Worker under a hang timer; a hang, a nonzero
 * exit or a missing phase is a FAIL. Seed: env LOGLOGN_YFT_COUNT_SEED, else the
 * default (decimal only, fail closed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { rSquared, BAD_OPS } from './_yft-count-worker.mjs';
import { YFastTrie } from '../LogLogN.js';
import { badKeys } from './helpers/xftStream.mjs';

process.stdout.setMaxListeners(64);
process.stderr.setMaxListeners(64);

const T = { timeout: 120000 };
const HANG_MS = 90000;
const N_OPS = 10000;

/** Decimal digits only; anything else is an error (never a silent fallback to the default). */
function parseSeed(v) {
    if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) {
        throw new RangeError('LOGLOGN_YFT_COUNT_SEED must match /^[0-9]+$/, got ' + JSON.stringify(v));
    }
    if (v.length > 10 || Number(v) > 0xFFFFFFFF) {
        throw new RangeError('LOGLOGN_YFT_COUNT_SEED must be <= 4294967295, got ' + JSON.stringify(v));
    }
    return Number(v);
}
const SEED = process.env.LOGLOGN_YFT_COUNT_SEED !== undefined
    ? parseSeed(process.env.LOGLOGN_YFT_COUNT_SEED)
    : 0x7c0ffee5;
console.log('# YftCount.test.js seed=' + SEED);

const WS = [1, 2, 4, 8, 16, 32];
const WORKER_URL = new URL('./_yft-count-worker.mjs', import.meta.url);
const ALL = ['exact', 'bad', 'random', 'stall'];
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
            if (m !== null && typeof m === 'object' && typeof m.phase === 'string' && Array.isArray(m.fails)) parts[m.phase] = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

function job(src, w, nOps, phases, label) {
    return runWorker(WORKER_URL, {
        workerData: { yftCountJob: true, src, w, seed: SEED, nOps, phases },
    }, HANG_MS, label);
}

const JOBS = new Map();
for (const w of WS) JOBS.set(w, job(null, w, N_OPS, ALL, 'w=' + w));

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

const YHAS = "    has(x) {\n        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;\n        this._x._q[0] = x;";
const MUTANTS = {
    // _lb scans the run linearly: the same answers, s reads on an absent-above query
    linearBucket: [['        while (lo < hi) {\n            const m = (lo + hi) >>> 1;\n            if (bk[m] < x) lo = m + 1;\n            else hi = m;\n        }',
        '        while (lo < hi && bk[lo] < x) lo++;']],
    // add locates twice
    doubleLocate: [['let f = this._loc();', 'let f = this._loc();\n        f = this._loc();']],
    // the successor hop re-locates instead of reading the leaf thread of f
    hopRequery: [['const n = this._x._next[f];', 'const n = this._x._next[this._loc()];']],
    // a bad key reaches the shared scratch: has() writes _q[0] before its key check
    badQ: [[YHAS, YHAS.replace('    has(x) {\n', '    has(x) {\n        this._x._q[0] = 0;\n')]],
    // the capacity check moved after the split (a full add into a K-key bucket splits, then throws)
    fullLate: [
        ['        if (this._size === this._c) throwYFull(this._c);\n        if (s === k) {', '        if (s === k) {'],
        ['        const o = f * k;\n        bk.copyWithin(o + j + 1, o + j, o + s);',
            '        if (this._size === this._c) throwYFull(this._c);\n        const o = f * k;\n        bk.copyWithin(o + j + 1, o + j, o + s);'],
    ],
    // the split copies the whole K-word run to the new leaf, then trims it: 3w moves, same state
    splitHalf: [['bk.copyWithin(nf * k, o + w, o + k);',
        'bk.copyWithin(nf * k, o, o + k);\n        bk.copyWithin(nf * k, nf * k + w, nf * k + k);']],
    // a borrow writes the left size before its inner add (C-7: a stall leaves bn[p] changed)
    bnFirst: [['        const nf = t._free;\n        t.add(bk[po + c]);', '        const nf = t._free;\n        bn[p] = c;\n        t.add(bk[po + c]);']],
};
const CTL = {};
for (const [name, edits] of Object.entries(MUTANTS)) {
    const w = name === 'linearBucket' ? 32 : 8;
    CTL[name] = job(mutate(edits), w, 0, ['exact', 'bad', 'stall'], 'mutant ' + name);
}

async function phase(w, name) {
    const r = await JOBS.get(w);
    const part = r.parts[name];
    assert.ok(part !== undefined, 'w=' + w + ' phase ' + name + ' posted no result' +
        (r.error !== null ? ' (' + r.error + ')' : ''));
    assert.equal(r.error, null, 'w=' + w + ': ' + r.error);
    return part;
}

async function ctlFails(name) {
    const r = await CTL[name];
    assert.equal(r.error, null, 'mutant ' + name + ': ' + r.error);
    const out = [];
    for (const p of ['exact', 'bad', 'stall']) {
        assert.ok(r.parts[p] !== undefined, 'mutant ' + name + ' posted no ' + p);
        out.push(...r.parts[p].fails);
    }
    return { fails: out, parts: r.parts };
}

for (const w of WS) {
    test('A2 exact cost-table rows, w=' + w + ' (U=2^' + w + ')', T, async (t) => {
        const p = await phase(w, 'exact');
        t.diagnostic('rows (label kind touches bkReads moves): ' + p.table.join(' | '));
        for (const f of p.findings) t.diagnostic('FINDING table-literal: ' + f);
        assert.deepEqual(p.fails, []);
        assert.equal(p.table.length, p.rows);
        assert.ok(p.rows >= 27, 'rows ran: ' + p.rows);
        assert.equal(p.plainAddMoves, 2 * w - 1, 'the plain-add worst case is 2w-1 moves (C-8)');
        assert.equal(p.plainDelMoves, 2 * w - 1, 'the plain-delete worst case is 2w-1 moves (C-8)');
        if (w >= 4) {
            assert.equal(p.split, 4);
            assert.equal(p.merge, w >= 8 ? 4 : 3);
            assert.equal(p.borrow, w >= 8 ? 3 : 2);
            assert.equal(p.maxRestrMoves, 2 * w, 'the split worst case is exactly 2w moves (C-10)');
        } else {
            assert.equal(p.split + p.merge + p.borrow, 0, 'w <= 2 cannot restructure (U = K)');
        }
    });

    test('A2 bad keys touch nothing (0 reads, 0 writes on the 10 columns, _q, _n), w=' + w, T, async () => {
        const p = await phase(w, 'bad');
        assert.deepEqual(p.fails, []);
        assert.equal(p.rows, badKeys(2 ** w).length * BAD_OPS.length);
        const P = YFastTrie.prototype;
        const KEYED = Object.getOwnPropertyNames(P).filter((n) => n[0] !== '_' && n !== 'constructor' &&
            typeof Object.getOwnPropertyDescriptor(P, n).value === 'function' && P[n].length === 1);
        assert.deepEqual([...BAD_OPS].sort(), KEYED.sort());
    });

    test('A2 ' + N_OPS + ' seeded random ops: every kick-free op == the cost table on the model, w=' + w, T, async (t) => {
        const p = await phase(w, 'random');
        t.diagnostic('seed=' + SEED + ' kinds=' + JSON.stringify(p.kinds) + ' kicked=' + p.kicked +
            ' maxPlainMoves=' + p.maxPlain + ' maxRestrMoves=' + p.maxRestr + ' maxTries=' + p.maxTries +
            ' borrowsFromHead=' + p.fromHead + ' _n=' + p.n.join(','));
        assert.deepEqual(p.fails, [], 'seed=' + SEED + ' w=' + w);
        assert.equal(p.mismatches, 0);
        assert.equal(p.free + p.kicked, N_OPS);
        assert.ok(p.kicked * 100 <= N_OPS, 'kicked ' + p.kicked + ' > 1%');
        assert.ok(p.maxPlain <= 2 * w - 1 && p.maxRestr <= 2 * w);
        for (const k of ['query', 'present', 'absent', 'plain', 'bad']) assert.ok((p.kinds[k] || 0) >= 20, k + ' ran ' + p.kinds[k]);
        if (w >= 4) {
            assert.ok(p.kinds.split >= 5, 'splits ' + p.kinds.split);
            assert.ok(p.kinds.merge >= 5, 'merges ' + p.kinds.merge);
        }
    });

    if (w >= 4) {
        test('C-7 stall inside a split / a borrow: RangeError passes through, 0 outer writes, state unchanged, w=' + w, T, async (t) => {
            const p = await phase(w, 'stall');
            t.diagnostic(p.table.join(' | '));
            assert.deepEqual(p.fails, []);
            assert.equal(p.cases, w >= 8 ? 3 : 2);
            assert.equal(p.rows, p.cases);
        });
    }
}

// --- the cross-w headline -----------------------------------------------------------

const FIT_WS = [2, 4, 8, 16, 32];
const LOG = FIT_WS.map((w) => Math.log2(w));

test('A2 absent successor, s = 2w-1: touches + probes = 4, 6, 8, 10, 12; R^2 vs log2(w) = 1.0000, vs w = 0.8710', T, async (t) => {
    const ys = [];
    const parts = [];
    for (const w of FIT_WS) {
        const a = (await phase(w, 'exact')).absSucc;
        ys.push(a.sum);
        parts.push('w=' + w + ': ' + a.tch + ' + ' + a.probes);
        assert.equal(a.tch, 1 + Math.log2(w), 'w=' + w + ' touches = 1 + T');
        assert.equal(a.probes, 1 + Math.log2(w), 'w=' + w + ' probes = log2(2w) (s = 2w-1 = 2^(T+1)-1)');
    }
    t.diagnostic(parts.join(', ') + ' | R^2 log2(w) ' + rSquared(LOG, ys).toFixed(4) + ', w ' + rSquared(FIT_WS, ys).toFixed(4));
    assert.deepEqual(ys, [4, 6, 8, 10, 12]);
    assert.equal(rSquared(LOG, ys).toFixed(4), '1.0000');
    assert.equal(rSquared(FIT_WS, ys).toFixed(4), '0.8710');
    assert.equal((await phase(1, 'exact')).absSucc.sum, 2, 'w=1: 1 touch + 1 probe');
});

// --- controls: each mutant must FAIL the gate -------------------------------------------

test('control: rSquared is not vacuous (exact line 1, flat noise < 1)', () => {
    assert.equal(rSquared([1, 2, 3], [2, 4, 6]).toFixed(4), '1.0000');
    assert.ok(rSquared([1, 2, 3, 4], [1, 5, 2, 4]) < 0.5);
});

test('control M-linearBucket: a linear bucket scan reads 63 words on the w=32 headline row', T, async () => {
    const { fails, parts } = await ctlFails('linearBucket');
    assert.equal(parts.exact.absSucc.probes, 63);
    assert.ok(fails.some((m) => /headline/.test(m) && /_bk reads 63 not in \[6, 6\]/.test(m)), fails.slice(0, 3).join('\n'));
});

test('control M-doubleLocate: a second locate in add fails the add rows (+lambda touches)', T, async () => {
    const { fails } = await ctlFails('doubleLocate');
    assert.ok(fails.some((m) => /add present 0: .*touches 2 != 1/.test(m)), fails.slice(0, 3).join('\n'));
});

test('control M-hopRequery: a re-locating successor hop fails the hop rows', T, async () => {
    const { fails } = await ctlFails('hopRequery');
    assert.ok(fails.some((m) => /succ absent 2w-1 \(headline\): .*touches 8 != 4/.test(m)), fails.slice(0, 3).join('\n'));
});

test('control M-badQ: a bad key that writes _q fails the bad-key rows', T, async () => {
    const { fails } = await ctlFails('badQ');
    assert.ok(fails.some((m) => /bad .* has: .*_q writes 1/.test(m)), fails.slice(0, 3).join('\n'));
});

test('control M-fullLate: the capacity check after the split fails the full reject into a K-key bucket', T, async () => {
    const { fails } = await ctlFails('fullLate');
    assert.ok(fails.some((m) => /full reject into a K-key bucket: .*read-only op wrote/.test(m)), fails.slice(0, 3).join('\n'));
    assert.ok(!fails.some((m) => /full reject C=1/.test(m)), 'the C=1 reject (no split) cannot see it');
});

test('control M-splitHalf: a copy-then-trim split fails the split rows and the 2w work bound', T, async () => {
    const { fails } = await ctlFails('splitHalf');
    assert.ok(fails.some((m) => /split, x right at the end: .*moves 24 != 8/.test(m)), fails.slice(0, 3).join('\n'));
    assert.ok(fails.some((m) => /split moved \d+ > 2w = 16 \(C-10\)/.test(m)), fails.slice(0, 3).join('\n'));
});

test('control M-bnFirst: a borrow that writes _bn before its inner add fails the C-7 stall row', T, async () => {
    const { fails } = await ctlFails('bnFirst');
    assert.ok(fails.some((m) => /stall in borrow from the head: .*_bn 1/.test(m) && /dump changed/.test(m)), fails.slice(0, 3).join('\n'));
    assert.ok(fails.some((m) => /borrow from the head, delete the rep key: .*_bn writes 4 != 3/.test(m)), fails.slice(0, 3).join('\n'));
});

test('LOGLOGN_YFT_COUNT_SEED: only /^[0-9]+$/ is accepted; anything else is rejected loudly', () => {
    assert.equal(parseSeed('0'), 0);
    assert.equal(parseSeed('4294967295'), 4294967295);
    let rejected = 0;
    for (const bad of ['', 'abc', '-1', '1.5', '0x10', ' 1', '1e3', '+1', undefined, 5, '4294967296', '9'.repeat(400)]) {
        assert.throws(() => parseSeed(bad), RangeError, JSON.stringify(bad));
        rejected++;
    }
    assert.equal(rejected, 12);
});

test('control: every mutant anchor is found exactly once (a missing one throws in mutate)', () => {
    assert.equal(Object.keys(MUTANTS).length, 7);
    assert.throws(() => mutate([['this text is not in LogLogN.js', 'x']]), /not found/);
    assert.throws(() => mutate([['const ', 'let ']]), /more than once/);
});

test('control: a worker that hangs / exits 1 / posts nothing / posts garbage is a FAIL', T, async () => {
    const hang = await runWorker('for (;;) {}', { eval: true }, 300, 'spin');
    assert.ok(hang.error !== null && /^hang > 300 ms/.test(hang.error), String(hang.error));
    const exit1 = await runWorker('process.exit(1)', { eval: true }, 5000, 'exit1');
    assert.ok(exit1.error !== null && /exit code 1/.test(exit1.error), String(exit1.error));
    const empty = await runWorker('0', { eval: true }, 5000, 'empty');
    assert.equal(empty.error, null);
    const garbage = await runWorker("require('node:worker_threads').parentPort.postMessage({ phase: 'exact', fails: 'x' }); " +
        "require('node:worker_threads').parentPort.postMessage('garbage')", { eval: true }, 5000, 'garbage');
    assert.equal(garbage.error, null);
    for (const r of [hang, exit1, empty, garbage]) assert.equal(Object.keys(r.parts).length, 0);
    // phase() turns a missing part into a FAIL
    JOBS.set(-1, Promise.resolve(empty));
    await assert.rejects(phase(-1, 'exact'), /posted no result/);
    JOBS.delete(-1);
});
