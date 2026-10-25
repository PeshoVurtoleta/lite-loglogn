/**
 * @zakkster/lite-loglogn -- YFastTrie FUZZ ORACLES (0.4.0 G1-B4, A3; DETERMINISTIC).
 * Independent of the engine: every expectation comes from the SPEC (strict
 * successor / predecessor, capacity rule, bad-key rule, PLAN C-3 policy via the
 * plain-array YModel of test/helpers/yftStream.mjs), never from running YFastTrie.
 *
 * Each (U, C) stream (test/_yft-worker.mjs runYft, seeded, two independent u32
 * streams for ops and keys, 150,000 ops) is replayed in a Worker on
 * new YFastTrie(U, C) and every return value and the size is compared per op with
 * SortedArray, Scapegoat (lite-logn, oracle only), StratifiedBitset (U <= 2^25)
 * and an XFastTrie(U, C) in lockstep. Every 1,024 ops: min -> successor and
 * max -> predecessor walks == truth; the INVARIANTS (rep[0] = 0, reps strictly
 * ascending and == the inner trie's keys, bucket keys inside [rep_i, rep_i+1), the
 * head <= K, every other bucket in [h, K], inner size <= Cr); and the MODEL bucket
 * (dump() reps / sizes and the `_n[0..2]` counters == YModel).
 *
 * U set {2, 3, 5, 8, 17, 1025, 2^16, 2^20, 2^32} x C {1, 2w, 2w+1, 64, M} with
 * M = min(U, 4096) ("max live": the largest pool a 150k-op stream can use at
 * U = 2^32), those <= U, deduplicated.
 *
 * COVERAGE FLOORS (asserted per config, derived from the spec, not from the engine):
 *   C <= K = 2w          no bucket can reach K and still take a NEW key: splits =
 *                        merges = borrows = 0 exactly;
 *   C >= K + 1           splits >= 10 and merges >= 10 (a split needs K keys + 1);
 *   C <= K + 1           borrows = 0 exactly (a borrow needs s_L + s - 1 > K with
 *                        s <= h, i.e. >= K + 2 keys held);
 *   C >= K + h + 2, h >= 2   borrows >= 5 AND head borrows >= 5 (a borrow whose left
 *                        neighbour is the head), counted by YModel on the oracle side;
 *   every config with C < U: full-throws > 0; 200 absent + 200 present successor /
 *   predecessor; the engine `_n` counters equal the oracle's.
 *
 * MUST-FAIL CONTROLS (count-checked data: URL copies of the real LogLogN.js text):
 *   MY1 merge / borrow never (underflow ignored);
 *   MY2 split at K + 1 keys instead of K (bucket overflows into the next run);
 *   MY3 merge drops the LEFT neighbour's rep instead of its own;
 *   MY4 borrow picks the new rep one past ceil(t/2);
 *   MY5 merge only when s_L + s - 1 < K (the exact-K case borrows instead);
 *   MY6 MY4 only when the left neighbour is the head (the head-borrow floor's teeth);
 *   MY7 add of a bad key returns instead of throwing (contract bucket).
 * Each is proven by running it; the table prints which bucket(s) diverge.
 *
 * SEEDS: the same stream on seed omitted / undefined / 0 / 1 / 0xffffffff gives
 * the same answers and layout (the seed reaches only the inner level hashes).
 *
 * HANG RULE: every job runs under the KILL_MS kill timer of test/_worker-run.mjs.
 * Seed: printed; override with LOGLOGN_SEED (fail-closed parse).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { KILL_MS } from './_worker-run.mjs';
import { parseSeed } from './helpers/seed.mjs';
import { YFastTrie } from '../LogLogN.js';

const T = { timeout: 120000 };
const WORKER_URL = new URL('./_yft-worker.mjs', import.meta.url);
const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0x3a91c5e7);
const US = [2, 3, 5, 8, 17, 1025, 65536, 1048576, 4294967296];
const OPS = 150000;
const MUT_OPS = 60000;
const BUCKETS = ['contract', 'SortedArray', 'Scapegoat', 'StratifiedBitset', 'XFastTrie', 'walks', 'invariants', 'model'];
const ANSWER_BUCKETS = ['contract', 'SortedArray', 'Scapegoat', 'StratifiedBitset', 'XFastTrie', 'walks'];

function seedFor(U, C) {
    return (BASE_SEED ^ Math.imul(U, 0x9E3779B1) ^ Math.imul(C, 0x85EBCA6B)) >>> 0;
}

function capsFor(U) {
    const w = 32 - Math.clz32(U - 1);
    const set = new Set();
    for (const c of [1, 2 * w, 2 * w + 1, 64, Math.min(U, 4096)]) if (c <= U) set.add(c);
    return [...set];
}

function configsFor(U, nOps) {
    return capsFor(U).map((C) => ({ U, C, nOps, seed: seedFor(U, C) }));
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

// --- mutants of the real source text ------------------------------------------------

const SHIPPED = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const MUTANTS = {
    MY1: ['if (s <= this._h && f !== this._hd) {', 'if (false) {'],
    MY2: ['if (s === k) {\n            const nf = this._split(f);', 'if (s === k + 1) {\n            const nf = this._split(f);'],
    MY3: ['bn[f] = 0;\n            t.delete(t._key[f]);', 'bn[f] = 0;\n            t.delete(t._key[p]);'],
    MY4: ['const c = (sl + s) >>> 1;', 'const c = ((sl + s) >>> 1) + 1;'],
    MY5: ['if (sl + s - 1 <= k) {', 'if (sl + s - 1 < k) {'],
    MY7: ['x >= this._u) throwKey(x, this._u);\n        this._x._q[0] = x;\n        let f = this._loc();', 'x >= this._u) return this;\n        this._x._q[0] = x;\n        let f = this._loc();'],
    MY6: ['const c = (sl + s) >>> 1;', 'const c = p === this._hd ? ((sl + s) >>> 1) + 1 : (sl + s) >>> 1;'],
};
const MATCHES = {};
const MSRC = {};
for (const [name, [from, to]] of Object.entries(MUTANTS)) {
    MATCHES[name] = countOf(SHIPPED, from);
    MSRC[name] = MATCHES[name] === 1 ? SHIPPED.replace(from, to) : null;
}

// --- runner (never rejects) ----------------------------------------------------------

function runWorker(configs, src, ms, label) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const t0 = Date.now();
        const w = new Worker(WORKER_URL, { workerData: { yftJob: true, src, configs }, stdout: true, stderr: true });
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
            resolve({ result, ms: Date.now() - t0, error: error === null ? null : error + (errText ? ' | stderr: ' + errText : '') });
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

async function expectResult(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');
    assert.equal(r.result.ok, true, String(r.result.message));
    return { runs: r.result.result, ms: r.ms };
}

function fmt(first) {
    return first === null || first === undefined ? 'none' : JSON.stringify(first);
}

function divOf(runs, bucket) {
    let n = 0;
    for (const r of runs) if (r.buckets[bucket] !== null) n += r.buckets[bucket].div;
    return n;
}

function sum(runs, pick) {
    let n = 0;
    for (const r of runs) n += pick(r);
    return n;
}

// --- all jobs start now, in parallel ---------------------------------------------------

const MAIN = new Map();
for (const U of US) MAIN.set(U, runWorker(configsFor(U, OPS), null, KILL_MS, 'U=' + U));

// seed families: same stream, five ways of passing the seed
const SEED_ARGS = ['omit', 'undef', 0, 1, 0xffffffff];
const SEED_CFG = [[1025, 200], [65536, 512], [4294967296, 512]].map(([U, C]) => ({ U, C, nOps: 50000, seed: seedFor(U, C) }));
const SEEDJOBS = SEED_ARGS.map((a) => runWorker(SEED_CFG.map((c) => ({ ...c, seedArg: a })), null, KILL_MS, 'seed ' + String(a)));

const MUT_CFG = [[1025, 200], [65536, 1024]].map(([U, C]) => ({ U, C, nOps: MUT_OPS, seed: seedFor(U, C) }));
const MUT = new Map();
for (const name of Object.keys(MUTANTS)) {
    MUT.set(name, MSRC[name] === null ? null : runWorker(MUT_CFG, MSRC[name], KILL_MS, name));
}

// --- tests -------------------------------------------------------------------------------

test('YFastTrieOracle: seed', () => {
    console.log('# YFastTrieOracle seed 0x' + BASE_SEED.toString(16));
    assert.ok(Number.isInteger(BASE_SEED));
});

test('YFastTrieOracle: the config grid covers every U and every C family', () => {
    assert.deepEqual(US, [2, 3, 5, 8, 17, 1025, 65536, 1048576, 4294967296]);
    for (const U of US) {
        const w = 32 - Math.clz32(U - 1);
        const caps = capsFor(U);
        assert.ok(caps.includes(1), 'C = 1 at U=' + U);
        assert.ok(caps.includes(Math.min(U, 4096)), 'max live at U=' + U);
        if (2 * w <= U) assert.ok(caps.includes(2 * w), 'C = 2w at U=' + U);
        if (2 * w + 1 <= U) assert.ok(caps.includes(2 * w + 1), 'C = 2w+1 at U=' + U);
    }
    assert.ok(US.some((U) => U <= 3) && US.some((U) => U > 2 ** 25));
});

for (const [name, [from]] of Object.entries(MUTANTS)) {
    test('YFastTrieOracle: anchor of ' + name + ' occurs exactly once in LogLogN.js', T, () => {
        assert.equal(MATCHES[name], 1, name + ' anchor ' + JSON.stringify(from) + ' matched ' + MATCHES[name] + ' times');
        assert.notEqual(MSRC[name], SHIPPED);
    });
}

for (const U of US) {
    test('YFastTrieOracle: U=' + U + ' 0 divergences vs 4 oracles + invariants + model, coverage floors', T, async () => {
        const { runs, ms } = await expectResult(MAIN.get(U));
        const caps = capsFor(U);
        assert.deepEqual(runs.map((r) => r.C), caps);
        const w = 32 - Math.clz32(U - 1);
        let line = '# U=' + U + ' ops/stream=' + OPS + ' wall=' + ms + 'ms';
        for (const r of runs) {
            const where = ' (U=' + U + ' C=' + r.C + ')';
            for (const b of BUCKETS) {
                const bk = r.buckets[b];
                if (b === 'StratifiedBitset' && U > 2 ** 25) {
                    assert.equal(bk, null);
                    continue;
                }
                assert.ok(bk !== null && bk.cmp > 0, b + ' compared 0 times' + where);
                assert.equal(bk.div, 0, b + where + ' ' + fmt(bk.first));
            }
            assert.ok(r.checkpoints >= Math.floor(OPS / 1024), 'checkpoints' + where);
            for (let o = 0; o < 7; o++) assert.ok(r.opCounts[o] > 0, 'no op kind ' + o + where);
            assert.ok(r.absQ >= 200 && r.presQ >= 200, 'successor / predecessor mix' + where + ' ' + r.absQ + '/' + r.presQ);
            if (r.C < U) assert.ok(r.fullThrows > 0, 'no full-throw' + where);
            assert.deepEqual(r.engine, [r.splits, r.merges, r.borrows], 'engine _n vs oracle counters' + where);
            // coverage floors (header)
            if (r.C <= r.K) {
                assert.deepEqual([r.splits, r.merges, r.borrows], [0, 0, 0], 'C <= K restructured' + where);
            } else {
                assert.ok(r.splits >= 10 && r.merges >= 10, 'splits / merges floor' + where + ' ' + r.splits + '/' + r.merges);
            }
            if (r.C <= r.K + 1) assert.equal(r.borrows, 0, 'C <= K+1 cannot borrow' + where);
            if (r.h >= 2 && r.C >= r.K + r.h + 2) {
                assert.ok(r.borrows >= 5, 'borrow floor' + where + ' ' + r.borrows);
                assert.ok(r.headBorrows >= 5, 'head-borrow floor' + where + ' ' + r.headBorrows);
            }
            line += '\n#   C=' + r.C + ' splits=' + r.splits + ' merges=' + r.merges + ' borrows=' + r.borrows +
                ' headBorrows=' + r.headBorrows + ' fullThrows=' + r.fullThrows + ' absQ=' + r.absQ + ' presQ=' + r.presQ;
        }
        assert.ok(w >= 1);
        console.log(line);
    });
}

test('YFastTrieOracle: coverage floors are reached in every family that allows them (no vacuous grid)', T, async () => {
    // eligibility is the header rule (C and w only); the per-U tests assert each eligible config
    let splitEl = 0;
    let borrowEl = 0;
    let splitHit = 0;
    let borrowHit = 0;
    let headHit = 0;
    for (const U of US) {
        const { runs } = await expectResult(MAIN.get(U));
        for (const r of runs) {
            if (r.C >= r.K + 1) {
                splitEl++;
                if (r.splits >= 10 && r.merges >= 10) splitHit++;
            }
            if (r.h >= 2 && r.C >= r.K + r.h + 2) {
                borrowEl++;
                if (r.borrows >= 5) borrowHit++;
                if (r.headBorrows >= 5) headHit++;
            }
        }
    }
    assert.ok(splitEl >= 15 && borrowEl >= 8, 'eligible configs: split ' + splitEl + ' borrow ' + borrowEl);
    assert.equal(splitHit, splitEl);
    assert.equal(borrowHit, borrowEl);
    assert.equal(headHit, borrowEl);
    console.log('# floors reached: split/merge ' + splitHit + '/' + splitEl + ', borrow ' + borrowHit + '/' + borrowEl +
        ', head borrow ' + headHit + '/' + borrowEl);
});

test('YFastTrieOracle: seed omitted / undefined / 0 / 1 / 0xffffffff give the same answers and layout', T, async () => {
    const outs = [];
    for (const j of SEEDJOBS) outs.push((await expectResult(j)).runs);
    for (let a = 0; a < SEED_ARGS.length; a++) {
        for (let c = 0; c < SEED_CFG.length; c++) {
            const r = outs[a][c];
            const where = ' (seedArg ' + String(SEED_ARGS[a]) + ' U=' + r.U + ')';
            for (const b of BUCKETS) {
                if (r.buckets[b] === null) continue;
                assert.equal(r.buckets[b].div, 0, b + where + ' ' + fmt(r.buckets[b].first));
            }
            assert.equal(r.resHash, outs[0][c].resHash, 'answers differ' + where);
            assert.equal(r.layHash, outs[0][c].layHash, 'layout differs' + where);
            assert.deepEqual(r.engine, outs[0][c].engine, 'counters differ' + where);
            assert.ok(r.splits > 0 && r.merges > 0, 'seed stream restructures' + where);
        }
    }
    console.log('# seeds: ' + SEED_ARGS.length + ' variants x ' + SEED_CFG.length + ' configs, identical answer + layout hashes');
});

test('YFastTrieOracle: the YFastTrie ctor forwards the seed without changing the policy (ctor smoke)', () => {
    for (const s of [undefined, 0, 1, 0xffffffff]) {
        const t = new YFastTrie(1025, 64, s);
        for (let i = 0; i < 64; i++) t.add(i * 16);
        assert.equal(t.size, 64);
        assert.equal(t.successor(16), 32);
    }
});

// --- must-fail controls --------------------------------------------------------------------

async function mutantRuns(name) {
    const job = MUT.get(name);
    assert.ok(job !== null && job !== undefined, name + ' mutant not built (anchor mismatch)');
    return (await expectResult(job)).runs;
}

function tableRow(name, runs) {
    let first = null;
    for (const b of BUCKETS) {
        for (const r of runs) {
            if (first === null && r.buckets[b] !== null && r.buckets[b].first !== null) first = b + ' ' + fmt(r.buckets[b].first);
        }
    }
    return '# ' + name + ' divergences: ' + BUCKETS.map((b) => b + '=' + divOf(runs, b)).join(' ') + ' | first ' + (first === null ? 'none' : first);
}

function answerDiv(runs) {
    return ANSWER_BUCKETS.reduce((n, b) => n + divOf(runs, b), 0);
}

test('YFastTrieOracle: control MY1 (underflow ignored) is caught by the invariants and the model', T, async () => {
    const runs = await mutantRuns('MY1');
    console.log(tableRow('MY1', runs));
    assert.ok(divOf(runs, 'invariants') > 0, 'MY1 not caught by the invariants');
    assert.ok(divOf(runs, 'model') > 0, 'MY1 not caught by the model');
});

test('YFastTrieOracle: control MY2 (split at K+1) diverges', T, async () => {
    const runs = await mutantRuns('MY2');
    console.log(tableRow('MY2', runs));
    assert.ok(answerDiv(runs) + divOf(runs, 'invariants') + divOf(runs, 'model') > 0);
    assert.ok(divOf(runs, 'invariants') > 0 || divOf(runs, 'model') > 0);
});

test('YFastTrieOracle: control MY3 (merge drops the wrong rep) diverges', T, async () => {
    const runs = await mutantRuns('MY3');
    console.log(tableRow('MY3', runs));
    assert.ok(answerDiv(runs) + divOf(runs, 'invariants') + divOf(runs, 'model') > 0);
    assert.ok(divOf(runs, 'invariants') > 0 || divOf(runs, 'model') > 0);
});

test('YFastTrieOracle: control MY4 (borrow rep one past ceil(t/2)) is caught by the model', T, async () => {
    const runs = await mutantRuns('MY4');
    console.log(tableRow('MY4', runs));
    assert.ok(divOf(runs, 'model') > 0, 'MY4 not caught by the model');
    assert.equal(answerDiv(runs), 0, 'MY4 changed an answer');
    assert.equal(divOf(runs, 'invariants'), 0, 'MY4 broke an invariant');
});

test('YFastTrieOracle: control MY5 (merge only below K) is caught by the model ALONE', T, async () => {
    const runs = await mutantRuns('MY5');
    console.log(tableRow('MY5', runs));
    // spec: s_L + s - 1 == K still merges (C-3); a borrow there keeps every size in [h, K]
    // and every answer right, so only the layout / counter comparison can see it
    assert.ok(divOf(runs, 'model') > 0, 'MY5 not caught by the model');
    assert.equal(answerDiv(runs), 0, 'MY5 changed an answer');
    assert.equal(divOf(runs, 'invariants'), 0, 'MY5 broke an invariant');
});

test('YFastTrieOracle: control MY6 (wrong borrow rep from the head) is caught by the model ALONE, on streams with head borrows', T, async () => {
    const runs = await mutantRuns('MY6');
    console.log(tableRow('MY6', runs));
    assert.ok(divOf(runs, 'model') > 0, 'MY6 not caught by the model');
    assert.equal(answerDiv(runs), 0, 'MY6 changed an answer');
    assert.equal(divOf(runs, 'invariants'), 0, 'MY6 broke an invariant');
    assert.ok(sum(runs, (r) => r.headBorrows) > 0, 'the control streams contain no head borrow');
});

test('YFastTrieOracle: control MY7 (add of a bad key returns instead of throwing) is caught by the contract bucket', T, async () => {
    const runs = await mutantRuns('MY7');
    console.log(tableRow('MY7', runs));
    assert.ok(divOf(runs, 'contract') > 0, 'MY7 not caught by the contract bucket');
});
