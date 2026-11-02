/**
 * @zakkster/lite-loglogn -- vEBTree VECTORS gate (0.5.0 G1, PLAN-vebtree task 2 /
 * A2, DETERMINISTIC).
 *
 * ORACLE side (G1-B1, this file today):
 * - test/vectors/veb-g1.json regenerates BYTE FOR BYTE from
 *   test/helpers/vebStream.mjs (VebRef + SetOracle + research sketch in lockstep,
 *   invariants + flat decoder at every checkpoint -- any fault aborts the cut).
 * - VebRef (no oracle attached) replays every row and equals every checkpoint field
 *   (at, resultsHash, size, min, max, words, layoutHash).
 * - Shape: the 12 plan universes in order, the named traces, a checkpoint every
 *   EVERY ops, at every trace phase mark and after the last op, words x 4 = the
 *   C-16 / C-13 byteLength; the singles traces pin the {0} / {mid} / {U-1} /
 *   {0, U-1} layouts (non-empty checkpoints).
 * - Teeth: the row comparator reports a one-field perturbation of a checkpoint.
 *
 * ENGINE side (G1-B3, task 5 / A2): LogLogN.js vEBTree replays every row with the
 * SAME folds (engineRow) and equals every checkpoint field incl. layoutHash over
 * `_t`. Must-fail engine mutants (one anchor replaced exactly once, data: URL, one
 * Worker each with a stall timer -- C-19: a hang is a FAIL) and controls: the clean
 * source through the same path passes; a spinning / throwing engine fails closed.
 * Regenerate: node test/helpers/vebStream.mjs --cut > test/vectors/veb-g1.json
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { vEBTree } from '../LogLogN.js';
import * as VS from './helpers/vebStream.mjs';
import {
    allStreams, runRow, streamOf, vectorsText, UNIVERSES, EVERY, TRACE_SINGLE_U, TRACE_FULL_U,
} from './helpers/vebStream.mjs';
import { vebWordsU } from './helpers/vebRef.mjs';

const TEXT = readFileSync(new URL('./vectors/veb-g1.json', import.meta.url), 'utf8');
const VEC = JSON.parse(TEXT);
const CP_FIELDS = ['at', 'resultsHash', 'size', 'min', 'max', 'words', 'layoutHash'];
const PLAN_U = [2, 3, 256, 257, 512, 1024, 65536, 131072, 131075, 16777216, 16777217, 33554432];

/** Field-level differences of row a against the vector row b ([] when equal). */
function rowDiff(a, b) {
    const out = [];
    for (const k of ['name', 'kind', 'U', 'w', 'seed', 'nOps', 'byteLength', 'maxSize', 'drains']) {
        if (a[k] !== b[k]) out.push(k);
    }
    if (a.checkpoints.length !== b.checkpoints.length) {
        out.push('checkpoints.length');
        return out;
    }
    for (let i = 0; i < a.checkpoints.length; i++) {
        for (const f of CP_FIELDS) {
            if (a.checkpoints[i][f] !== b.checkpoints[i][f]) out.push('cp' + i + '.' + f);
        }
    }
    return out;
}

test('veb-g1.json regenerates byte for byte (all oracles on: a fault aborts the cut)', () => {
    assert.equal(vectorsText(), TEXT);
});

test('shape: 12 plan universes, named traces, checkpoint cadence, A1 byteLength', () => {
    assert.deepEqual(UNIVERSES, PLAN_U);
    assert.deepEqual(VEC.universes, PLAN_U);
    assert.equal(VEC.every, EVERY);
    const names = VEC.rows.map((r) => r.name);
    assert.deepEqual(names, allStreams().map((d) => d.name));
    for (const U of PLAN_U) assert.ok(names.includes('random-' + U), 'random-' + U);
    for (const U of TRACE_SINGLE_U) assert.ok(names.includes('singles-' + U));
    for (const U of TRACE_FULL_U) assert.ok(names.includes('full-' + U));
    for (const U of [2, 3, 256]) assert.ok(names.includes('full-' + U), 'full universe at ' + U);
    const descs = allStreams();
    for (const r of VEC.rows) {
        assert.equal(r.byteLength, vebWordsU(r.U) * 4, r.name);
        const marks = streamOf(descs.find((d) => d.name === r.name)).marks;
        if (r.kind === 'trace') assert.equal(marks.length, r.name.startsWith('singles-') ? 11 : 3, r.name + ' phase marks');
        const at = new Set(marks);
        for (let k = EVERY; k <= r.nOps; k += EVERY) at.add(k);
        at.add(r.nOps);
        const want = [...at].sort((a, b) => a - b);
        assert.deepEqual(r.checkpoints.map((c) => c.at), want, r.name);
        for (const c of r.checkpoints) {
            assert.equal(c.words * 4, r.byteLength, r.name);
            assert.match(c.layoutHash, /^[0-9a-f]{64}$/);
            assert.match(c.resultsHash, /^[0-9a-f]{8}$/);
        }
    }
    const byU = new Map(VEC.rows.filter((r) => r.kind === 'random').map((r) => [r.U, r.byteLength]));
    assert.equal(byU.get(65536), 8232);
    assert.equal(byU.get(16777216), 2105392);
    assert.equal(byU.get(16777217), 2115708);
    assert.equal(byU.get(257), 76);
    assert.equal(byU.get(2), 4);
    // singles-<U>: checkpoints hold sizes 0, 1, 0, 1, 0, 1, 0, 2, 2, 1, 1, 0 (U >= 3:
    // {0}, {mid}, {U-1} and the pair are distinct layouts) -- the layouts are pinned
    for (const r of VEC.rows.filter((x) => x.name.startsWith('singles-'))) {
        const sizes = r.checkpoints.map((c) => c.size);
        assert.deepEqual(sizes, [0, 1, 0, 1, 0, 1, 0, 2, 2, 1, 1, 0], r.name);
        const ones = r.checkpoints.filter((c) => c.size === 1);
        assert.deepEqual(ones.map((c) => c.min), [0, Math.floor(r.U / 2), r.U - 1, r.U - 1, 0], r.name);
        if (r.U >= 3) {
            assert.equal(new Set(ones.slice(0, 3).map((c) => c.layoutHash)).size, 3, r.name + ' distinct layouts');
        }
    }
});

for (const d of allStreams()) {
    test('VebRef replays every checkpoint: ' + d.name, () => {
        const { row, fault } = runRow(d, {});
        assert.equal(fault, null);
        const want = VEC.rows.find((r) => r.name === d.name);
        assert.deepEqual(rowDiff(row, want), []);
    });
}

test('teeth: rowDiff reports a one-field checkpoint perturbation', () => {
    const want = VEC.rows.find((r) => r.name === 'random-65536');
    for (const f of CP_FIELDS) {
        const bad = JSON.parse(JSON.stringify(want));
        const c = bad.checkpoints[3];
        c[f] = typeof c[f] === 'number' ? c[f] + 1 : c[f] === null ? 0 : c[f].slice(0, -1) + 'x';
        assert.deepEqual(rowDiff(bad, want), ['cp3.' + f], f);
    }
});

// =====================================================================================
// ENGINE SIDE (G1-B3, PLAN-vebtree task 5 / A2). engineRow replays one descriptor on
// a vEBTree class with the oracle side's folds (vebStream foldResult / foldThrow, the
// runRow checkpoint cadence and fields), layoutHash over the engine's `_t` words,
// words = `_t.length`; rowDiff against the VEC row must be [] for every row.
// engineRow and rowDiff are SELF-CONTAINED (parameters + CP_FIELDS only): the mutant
// Worker evaluates their source text, so the in-process replay and every mutant run
// the same code.
// =====================================================================================

/** Replays descriptor d on Cls with the oracle folds; h = the vebStream module. */
function engineRow(Cls, h, d) {
    const st = h.streamOf(d);
    const marks = new Set(st.marks);
    const nOps = st.op.length;
    const e = new Cls(d.U);
    const row = {
        name: d.name, kind: d.kind, U: d.U, w: e.bits, seed: d.seed, nOps,
        byteLength: e.byteLength, maxSize: 0, drains: 0, checkpoints: [],
    };
    let rh = h.FNV_OFFSET;
    let last = 0;
    for (let i = 0; i < nOps; i++) {
        try {
            rh = h.foldResult(rh, h.applyOp(e, st.op[i], st.key[i]), e);
        } catch (err) {
            rh = h.foldThrow(rh, err);
        }
        const sz = e.size;
        if (sz > row.maxSize) row.maxSize = sz;
        if (sz === 0 && last > 0) row.drains++;
        last = sz;
        if ((i + 1) % h.EVERY === 0 || i === nOps - 1 || marks.has(i + 1)) {
            const mn = e.min();
            const mx = e.max();
            row.checkpoints.push({
                at: i + 1, resultsHash: h.hex32(rh), size: sz,
                min: mn === undefined ? null : mn, max: mx === undefined ? null : mx,
                words: e._t.length, layoutHash: h.layoutHash(e._t),
            });
        }
    }
    return row;
}

const ENGINE_ROWS = VEC.rows.length;
const ENGINE_CPS = VEC.rows.reduce((n, r) => n + r.checkpoints.length, 0);

test('engine replay covers every vector row: 12 universes + the traces, every checkpoint', () => {
    assert.equal(ENGINE_ROWS, 23);
    assert.equal(ENGINE_CPS, 473);
    assert.deepEqual(VEC.rows.map((r) => r.name), allStreams().map((d) => d.name));
    assert.deepEqual([...new Set(VEC.rows.map((r) => r.U))].sort((a, b) => a - b), PLAN_U);
});

for (const d of allStreams()) {
    test('ENGINE replays every checkpoint (A2): ' + d.name, () => {
        const want = VEC.rows.find((r) => r.name === d.name);
        assert.ok(want !== undefined, d.name + ' missing in veb-g1.json');
        assert.deepEqual(rowDiff(engineRow(vEBTree, VS, d), want), []);
    });
}

// --- engine mutants (must FAIL) ------------------------------------------------------
// Each mutant = LogLogN.js with ONE anchor replaced EXACTLY once (count-checked: an
// anchor count != 1 fails closed), loaded through a data: URL in its own Worker that
// replays the rows in order and stops at the first differing row. C-19: a corrupt
// state can make a leaf scan run off the array forever, so the parent arms a STALL
// timer (no row finished for STALL_MS -> terminate). Outcomes: 'diff' (a row differs),
// 'threw' (the worker body threw), 'hang' (stall timer), 'pass'. A mutant that ends
// 'pass' FAILS its test; the expected kind is pinned (the replay is deterministic:
// 7 of the 16 corrupt state and then spin in a leaf scan -- 6 in random-257, the
// first internal-node row, 1 in random-131072). The clean source through the SAME path must end 'pass' (the
// harness is not always-fail; a clean row takes ~20 ms, the stall is 5000 ms); the
// C-19 hang class (max not refreshed on delete) must end 'hang' (the timer path
// fails closed).

const LIB_SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const HELPERS_URL = new URL('./helpers/vebStream.mjs', import.meta.url).href;
const VEC_PATH = new URL('./vectors/veb-g1.json', import.meta.url);
const SHIPPED_SRC = 'const CP_FIELDS = ' + JSON.stringify(CP_FIELDS) + ';\n' + rowDiff + '\n' + engineRow;
const STALL_MS = 5000;
const POOL = 4;

// [name, kind, anchor, replacement]
const MUTANTS = [
    ['has: header min read `| 0` (EMPTY 0xFFFFFFFF reads -1)', 'diff',
        'const mn = t[b];\n            const mx = t[b + 1];\n            if (mn > mx) return false;',
        'const mn = t[b] | 0;\n            const mx = t[b + 1];\n            if (mn > mx) return false;'],
    ['ctor: untrimmed root (2^hi clusters at every U)', 'diff',
        'words = g[w] + Math.ceil(universe / 2 ** lo) * vebWords(lo);', 'words = vebWords(w);'],
    ['successor: internal cluster `xl <` -> `xl <=` its max', 'diff',
        'if (xl < t[c + 1]) {', 'if (xl <= t[c + 1]) {'],
    ['predecessor: leaf-cluster descending scan stops above word 0', 'diff',
        'while (v === 0 && p > c) v = t[--p] | 0;', 'while (v === 0 && p > c + 1) v = t[--p] | 0;'],
    ['_init: root clusters (lo = 16) min not set EMPTY', 'diff',
        't[cb + j * 2058] = 0xFFFFFFFF;', 't[cb + j * 2058] = 0;'],
    ['delete: max not refreshed (mode 2: cluster kept keys)', 'hang',
        't[fb + 1] = ((j << lo) | m) >>> 0;', ''],
    ['delete: max not refreshed (mode 1: cluster emptied)', 'hang',
        't[fb + 1] = fa >>> 0;', ''],
    ['successor: leaf-cluster ascending scan bound c + 7', 'diff',
        'while (v === 0 && ++p < c + 8) v = t[p] | 0;', 'while (v === 0 && ++p < c + 7) v = t[p] | 0;'],
    ['add: min stored in its cluster (no swap-down)', 'hang',
        't[b] = x;\n                        x = mn;', 't[b] = x;'],
    ['delete: new min from the summary MAX slot', 'diff',
        'j0 = t[b + 2];', 'j0 = t[b + 3];'],
    ['delete: singleton leaf cluster without the other-words scan', 'hang',
        'one = k === b + 8;', 'one = true;'],
    ['add: empty-cluster test inverted', 'hang',
        'if (ps < 0 || v !== 0) break;', 'if (ps < 0 || v === 0) break;'],
    ['predecessor: internal cluster `xl >` -> `xl >=` its min', 'diff',
        'if (xl > t[c]) {', 'if (xl >= t[c]) {'],
    ['delete: max-refresh frame never pushed', 'hang',
        'pr = x === mx;', 'pr = false;'],
    ['delete: emptied-summary flag ignored', 'hang',
        'j = top ? -1 : t[fb + 3];', 'j = t[fb + 3];'],
    ['predecessor: fallback frame swapped', 'diff',
        'r = n === 1 ? a2 | m2 : a1 | m1;', 'r = n === 1 ? a1 | m1 : a2 | m2;'],
];

/** src with anchor replaced; throws unless the anchor occurs EXACTLY once (fail closed). */
function mutate(src, anchor, repl) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) throw new Error('mutant anchor count ' + n + ' (need exactly 1): ' + JSON.stringify(anchor.slice(0, 60)));
    const i = src.indexOf(anchor);
    return src.slice(0, i) + repl + src.slice(i + anchor.length);
}

const REPLAY_WORKER = [
    "'use strict';",
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const { readFileSync } = require('node:fs');",
    'Promise.all([import(workerData.lib), import(workerData.helpers)])',
    '    .then(([lib, h]) => {',
    "        const fns = (0, eval)('\"use strict\"; ' + workerData.src + '\\n({ engineRow, rowDiff })');",
    "        const VEC = JSON.parse(readFileSync(workerData.vec, 'utf8'));",
    '        let rows = 0;',
    '        let cps = 0;',
    '        for (const d of h.allStreams()) {',
    '            const want = VEC.rows.find((r) => r.name === d.name);',
    "            const diff = want === undefined ? ['row missing'] : fns.rowDiff(fns.engineRow(lib.vEBTree, h, d), want);",
    "            if (diff.length > 0) return { kind: 'diff', row: d.name, diff: diff.slice(0, 4), rows, cps };",
    '            rows++;',
    '            cps += want.checkpoints.length;',
    '            parentPort.postMessage({ progress: d.name });',
    '        }',
    "        return { kind: 'pass', rows, cps };",
    '    })',
    "    .catch((e) => ({ kind: 'threw', message: e && e.stack ? String(e.stack) : String(e) }))",
    '    .then((m) => parentPort.postMessage(m));',
].join('\n');

/**
 * Replays the vectors on engine source `src` in a fresh Worker. NEVER rejects: resolves
 * { kind, ... }; kind 'hang' when no row finished for `stall` ms, 'error' on a worker
 * error / nonzero exit / missing result.
 */
function replayIn(src, label, stall = STALL_MS) {
    return new Promise((resolve) => {
        const lib = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
        let result = null;
        let last = '';
        let done = false;
        let timer = null;
        const w = new Worker(REPLAY_WORKER, {
            eval: true, workerData: { lib, helpers: HELPERS_URL, vec: fileURLToPath(VEC_PATH), src: SHIPPED_SRC },
        });
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(r);
        };
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                w.terminate();
                finish({ kind: 'hang', message: 'no row finished for ' + stall + ' ms after ' + (last || 'start') + ': ' + label });
            }, stall);
        };
        arm();
        w.on('message', (m) => {
            if (m !== null && typeof m === 'object' && typeof m.progress === 'string') {
                last = m.progress;
                arm();
                return;
            }
            result = m;
        });
        w.on('error', (e) => finish({ kind: 'error', message: label + ' worker error: ' + String(e && e.stack ? e.stack : e) }));
        w.on('exit', (code) => {
            if (code !== 0) finish({ kind: 'error', message: label + ' worker exit code ' + code });
            else if (result === null || typeof result !== 'object') finish({ kind: 'error', message: label + ' posted no result' });
            else finish(result);
        });
    });
}

// Jobs start lazily from the first worker test (after the in-process replay above, so a
// busy main thread never delays a stall-timer reset), at most POOL Workers at a time.
let JOBS = null;
function jobs() {
    if (JOBS !== null) return JOBS;
    const specs = [['clean', () => LIB_SRC]];
    for (const [name, , anchor, repl] of MUTANTS) specs.push([name, () => mutate(LIB_SRC, anchor, repl)]);
    const queue = [];
    let active = 0;
    const pump = () => {
        while (active < POOL && queue.length > 0) {
            active++;
            queue.shift()();
        }
    };
    JOBS = new Map();
    for (const [name, build] of specs) {
        JOBS.set(name, new Promise((resolve) => {
            queue.push(() => {
                let src;
                try {
                    src = build();
                } catch (e) {
                    active--;
                    resolve({ kind: 'build', message: String(e && e.message) });
                    pump();
                    return;
                }
                replayIn(src, name).then((r) => {
                    active--;
                    resolve(r);
                    pump();
                });
            });
        }));
    }
    pump();
    return JOBS;
}

const TW = { timeout: 120000 };

test('control: mutate() fails closed on an anchor count of 0 or 2, and replaces exactly once', () => {
    assert.throws(() => mutate('a b a', 'c', 'x'), /anchor count 0/);
    assert.throws(() => mutate('a b a', 'a', 'x'), /anchor count 2/);
    assert.equal(mutate('a b c', 'b', 'x'), 'a x c');
    assert.equal(mutate('a b c', 'b', ''), 'a  c');
});

test('control: the clean engine through the SAME Worker / data: URL path PASSES every row', TW, async () => {
    const r = await jobs().get('clean');
    assert.equal(r.kind, 'pass', JSON.stringify(r));
    assert.equal(r.rows, ENGINE_ROWS);
    assert.equal(r.cps, ENGINE_CPS);
});

test('control: the Worker path reports a hang (stall timer) as a FAIL, never a pass', TW, async () => {
    const r = await replayIn('export class vEBTree { constructor() { for (;;) { /* spin */ } } }', 'spin', 1000);
    assert.equal(r.kind, 'hang', JSON.stringify(r));
    const t = await replayIn('export class vEBTree { constructor() { throw new Error("boom"); } }', 'throws');
    assert.equal(t.kind, 'threw', JSON.stringify(t));
});

for (const [name, kind, anchor] of MUTANTS) {
    test('mutant must FAIL (' + kind + '): ' + name, TW, async (t) => {
        assert.equal(LIB_SRC.split(anchor).length - 1, 1, 'anchor occurs exactly once');
        const r = await jobs().get(name);
        t.diagnostic(name + ' -> ' + r.kind + (r.row ? ' at ' + r.row + ' ' + JSON.stringify(r.diff) : '') +
            (r.message ? ' ' + r.message.split('\n')[0] : ''));
        assert.notEqual(r.kind, 'pass', 'mutant PASSED the engine replay: ' + name);
        assert.equal(r.kind, kind, JSON.stringify(r));
    });
}
