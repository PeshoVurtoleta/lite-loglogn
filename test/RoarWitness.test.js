// RoarWitness.test.js -- gate for `node --expose-gc test/witness-roar.mjs` (PLAN-roaringset-G7 task 5, G7-B2).
// Written FROM THE ASSERTIONS A-1..A-5 (PLAN) + SPEC A14 / A16, never from running the harness and copying it back.
// Every expected number is a literal from the plan / the R0 digest (best / best-paged / cells per op); no timing
// value or timing-dependent verdict is asserted. Mutants run on copies in a mkdtemp dir (test/witness-roar.mjs +
// LogLogN.js + a node_modules symlink), one anchored replacement each; an anchor matching != 1 times is a TEST error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as W from './witness-roar.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'test', 'witness-roar.mjs');
const T = 180000;
const KILL = 150000;
const FIX = JSON.parse(readFileSync(join(ROOT, 'test', 'vectors', 'roar-u6-r0.json'), 'utf8'));

// ---- spawn helper (async so independent spawns overlap); wall recorded for run.log
const walls = [];
function run(name, script, cwd, args) {
    const t0 = Date.now();
    return new Promise((res) => {
        const c = spawn(process.execPath, ['--expose-gc', script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        const k = setTimeout(() => { c.kill('SIGKILL'); }, KILL);
        c.on('close', (status) => {
            clearTimeout(k);
            const wall = (Date.now() - t0) / 1000;
            walls.push(name + ' ' + wall.toFixed(1) + 's exit ' + status);
            res({ status, out, err, wall });
        });
    });
}

// ---- mutant copies: exactly one anchored replacement each
function mutantDir(anchor, repl, more = []) {
    let src = readFileSync(SCRIPT, 'utf8');
    for (const [a, r] of more) {
        const m = src.split(a).length - 1;
        assert.equal(m, 1, 'test error: anchor matches ' + m + 'x, want exactly 1: ' + a);
        src = src.replace(a, () => r);
    }
    const n = src.split(anchor).length - 1;
    assert.equal(n, 1, 'test error: anchor matches ' + n + 'x, want exactly 1: ' + anchor);
    const dir = mkdtempSync(join(tmpdir(), 'roarw-'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test', 'witness-roar.mjs'), src.replace(anchor, () => repl));
    writeFileSync(join(dir, 'LogLogN.js'), readFileSync(join(ROOT, 'LogLogN.js')));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    return dir;
}
const FLOOR = 'if (r0s > mS) mS = r0s;';
const KEY = "'32:4096': 462, ";
const CTRL = 'return m >= CTRL_LO && m <= CTRL_HI;';
const X2 = 'return m >= X2_LO && m <= X2_HI;';
const FILT = 'controlOk(aa.ratioMedian)';
// PLAN A-3 / A-4 / A-5 must-fails in ONE copy (each check prints its own verdict line): mix-P own runner,
// the P child's n=64 set built direct, one module-level reference, one 4 KB retain inside a timed window
const COMBO = [
    ["if (mixFn === null) mixFn = makeRunner('std', op, tagBase + ' ' + op + ' mix (shared: mix-D + mix-P)');\n                fn = mixFn;", "fn = makeRunner('std', op, tagBase + ' ' + op + ' ' + c.label);"],
    ['const s = p.paged ? new lib.RoaringSet', "const s = p.paged && !(L === 'P' && sh.n === 64) ? new lib.RoaringSet"],
    ["    for (const c of cols) tracker.track(c.obj, noop, 'roar-' + L + '-' + c.label, { audit: true });", "    for (const c of cols) tracker.track(c.obj, noop, 'roar-' + L + '-' + c.label, { audit: true });\n    GKEEP.push(cols[0].obj);"],
    ['                    NS[r * C + ci] = OUT[0];\n', "                    NS[r * C + ci] = OUT[0];\n                    if (r === 0 && j === 0 && sh.n === 64 && op === 'min') GKEEP.push(new ArrayBuffer(4096));\n"],
];
const mutants = {};
function mut(name, anchor, repl, args, more) {
    const dir = mutantDir(anchor, repl, more);
    mutants[name] = dir;
    return run(name, join(dir, 'test', 'witness-roar.mjs'), dir, args);
}

// kicked off lazily, at once, so the spawns overlap
let started = null;
function start() {
    if (started) return started;
    started = {
        real: run('real-smoke', SCRIPT, ROOT, ['--smoke']),
        bad: run('bad-flag', SCRIPT, ROOT, ['--smok']),
        floor: mut('mut-floor', FLOOR, '', ['--smoke']),
        key: mut('mut-r0small-key', KEY, '', ['--smoke']),
        ctrl: mut('mut-controlOk-true', CTRL, 'return true;', ['--smoke']),
        x2: mut('mut-x2Ok-true', X2, 'return true;', ['--smoke']),
        combo: mut('mut-iso-ret-gc', COMBO[0][0], COMBO[0][1], ['--smoke'], COMBO.slice(1)),
    };
    return started;
}
const done = () => (started === null ? Promise.resolve() : Promise.all(Object.values(started)));
test.after(async () => {
    await done();
    for (const d of Object.values(mutants)) rmSync(d, { recursive: true, force: true });
    console.log('# RoarWitness walls: ' + walls.join(' | '));
});

const failLines = (s) => s.split('\n').filter((l) => /\bFAIL\b/.test(l));
const NOBANNER = (s) => !/witness:roar --|SMOKE ok|provenance:/.test(s);

// ---------------------------------------------------------------- A-1 digest parity (pure)
const R0 = {
    has: [5.86, 4.52, 14], add: [8.73, 8.94, 15], delete: [8.40, 8.69, 15], successor: [1.84, 2.07, 13],
    predecessor: [1.73, 2.11, 14], min: [0.53, 0.65, 15], max: [0.50, 0.63, 11],
};

test('A-1 digest(fixture) equals the R0 u6 digest per op (best / best-paged / cells)', () => {
    const d = W.digest(FIX);
    assert.deepEqual([...d.order].sort(), Object.keys(R0).sort());
    for (const [op, [b, bp, n]] of Object.entries(R0)) {
        assert.equal(d.ops[op].med.best.toFixed(2), b.toFixed(2), op + ' best');
        assert.equal(d.ops[op].med['best-paged'].toFixed(2), bp.toFixed(2), op + ' best-paged');
        assert.equal(d.ops[op].cells, n, op + ' cells');
    }
    assert.equal(d.cells, 97);
    assert.equal(d.excluded, 8);
    assert.equal(d.cells + d.excluded, 105);
    assert.equal(FIX.cells.length, 105);
});

test('A-1 must-fail: digest with the control filter dropped counts max = 15 cells, nothing excluded', async () => {
    const dir = mutantDir(FILT, 'true');
    try {
        const M = await import(pathToFileURL(join(dir, 'test', 'witness-roar.mjs')).href);
        const d = M.digest(FIX);
        assert.equal(d.ops.max.cells, 15);
        assert.equal(d.excluded, 0);
        assert.notEqual(d.ops.max.cells, R0.max[2]); // the real digest says 11
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('digest fails closed on malformed input and skips non-positive / non-finite columns', () => {
    assert.throws(() => W.digest(null), TypeError);
    assert.throws(() => W.digest({}), TypeError);
    assert.throws(() => W.digest({ cells: [{ op: 'has' }] }), TypeError);
    const cell = (aa, v) => ({ op: 'has', columns: [{ label: 'SB', ratioMedian: 1 }, { label: 'SB-AA', ratioMedian: aa }, { label: 'x', ratioMedian: v }] });
    const d = W.digest({ cells: [cell(1, 2), cell(1.5, 9), cell(1, NaN), cell(1, 0), cell(1, 4)] });
    assert.equal(d.excluded, 1);
    assert.equal(d.ops.has.count.x, 2);
    assert.equal(d.ops.has.med.x, 2); // lower median of [2, 4]
});

// ---------------------------------------------------------------- A-2 classifiers + arg parsing + stats
test('A-2 controlOk: flat +-0.02 accepted; 1.25 step, 0.8 step, NaN, empty rejected', () => {
    const flat = Array.from({ length: 15 }, (_, i) => 1 + ((i % 3) - 1) * 0.02);
    assert.equal(W.controlOk(flat), true);
    assert.equal(W.controlOk(new Float64Array(15).fill(1.25)), false);
    assert.equal(W.controlOk(new Float64Array(15).fill(0.8)), false);
    assert.equal(W.controlOk(new Float64Array(15).fill(NaN)), false);
    assert.equal(W.controlOk([]), false);
    assert.equal(W.controlOk(1.0), true);
    assert.equal(W.controlOk(1.25), false);
    assert.equal(W.controlOk([1, 1, NaN]), false);
});

test('A-2 x2Ok: 2.0 accepted; 1.0, 1.5, NaN, empty rejected', () => {
    assert.equal(W.x2Ok(new Float64Array(15).fill(2.0)), true);
    assert.equal(W.x2Ok(new Float64Array(15).fill(1.0)), false);
    assert.equal(W.x2Ok(new Float64Array(15).fill(1.5)), false);
    assert.equal(W.x2Ok(new Float64Array(15).fill(NaN)), false);
    assert.equal(W.x2Ok([]), false);
    assert.equal(W.x2Ok(2.0), true);
    assert.equal(W.x2Ok(2.45), false); // just above X2_HI 2.4
    assert.equal(W.x2Ok(1.55), false); // just below X2_LO 1.6
});

test('A-2 controlSelfCheck passes', () => { assert.equal(W.controlSelfCheck(), true); });

test('A-2 parseArgs: defaults, good flags, and every bad shape throws', () => {
    assert.deepEqual(W.parseArgs([]), { smoke: false, json: null, child: null, plan: null });
    assert.deepEqual(W.parseArgs(['--smoke']), { smoke: true, json: null, child: null, plan: null });
    assert.equal(W.parseArgs(['--json', 'o.json']).json, 'o.json');
    assert.deepEqual(W.parseArgs(['--child', 'P', '--plan', 'p.json']), { smoke: false, json: null, child: 'P', plan: 'p.json' });
    assert.throws(() => W.parseArgs(['--smok']), /unknown flag.*did you mean --smoke/);
    assert.throws(() => W.parseArgs(['--smoke', '--smoke']), /twice/);
    assert.throws(() => W.parseArgs(['--json']), /needs a value/);
    assert.throws(() => W.parseArgs(['--json', '--smoke']), /needs a value/);
    assert.throws(() => W.parseArgs(['--plan', 'p.json']), /needs --child/);
    assert.throws(() => W.parseArgs(['--child', 'D']), /needs --plan/);
    assert.throws(() => W.parseArgs(['--child', 'X', '--plan', 'p']), /D, P or M/);
    assert.throws(() => W.parseArgs(['--child', 'D', '--plan', 'p', '--smoke']), /only --plan/);
    assert.throws(() => W.parseArgs('--smoke'), TypeError);
    assert.throws(() => W.parseArgs([3]));
});

test('A-2 quant / summarize unit vectors (hand-computed)', () => {
    assert.ok(Number.isNaN(W.quant([], 0.5)));
    assert.ok(Number.isNaN(W.quant([1, 2], 1.5)));
    assert.ok(Number.isNaN(W.quant([1, 2], NaN)));
    assert.equal(W.quant([7], 0.5), 7);
    assert.equal(W.quant([1, 2, 3, 4], 0.5), 2.5);   // h = 1.5 -> 2 + 0.5 * 1
    assert.equal(W.quant([1, 2, 3, 4], 0), 1);
    assert.equal(W.quant([1, 2, 3, 4], 1), 4);
    assert.equal(W.quant([0, 10], 0.25), 2.5);
    const a = [3, 1, 2, 4, 5];
    assert.deepEqual(W.summarize(a), { med: 3, q1: 2, q3: 4 });
    assert.deepEqual(a, [3, 1, 2, 4, 5]); // input untouched
    const e = W.summarize([]);
    assert.ok(Number.isNaN(e.med) && Number.isNaN(e.q1) && Number.isNaN(e.q3));
    assert.ok(Number.isNaN(W.summarize([1, NaN, 3]).med));
    assert.ok(Number.isNaN(W.summarize([1, Infinity]).med));
});

// ---------------------------------------------------------------- A-3 / A-4 / A-5 smoke spawn
test('A-3 smoke: exit 0, 0 FAIL, no timing numbers, cells 28/14/14, ISOLATION lines', { timeout: T }, async () => {
    const r = await start().real;
    assert.equal(r.status, 0, r.out.slice(-1500) + r.err);
    assert.deepEqual(failLines(r.out), []);
    assert.equal(r.out.split('\n').filter((l) => /\bns\b/.test(l)).length, 0, 'a timing number was printed');
    assert.match(r.out, /^SUMMARY cells D 28 \/ P 14 \/ M 14 \(want 28 \/ 14 \/ 14\)$/m);
    assert.match(r.out, /^ISOLATION: D paged instances 0, P direct instances 0, mixed shared runners 14\/14 -- ok$/m);
    assert.match(r.out, /^CENSUS parked chunks: 0 pool\(s\) of \d+ with a large-slot chunk of <= 64 keys -- ok$/m);
    assert.match(r.out, /^WITNESS-ROAR SMOKE ok: 56 cells .*exit 0$/m);
});

test('A-4 GC budget: 56/56 windows, major 0, arrayBuffers +0 B', { timeout: T }, async () => {
    const r = await start().real;
    assert.match(r.out, /^GC windows 56\/56, major 0, arrayBuffers \+0 B \| controls 3\/3 children -- ok$/m);
});

test('A-5 retention: groups 8/8, tracked 26 (D 12 / P 6 / M 8), worst 0', { timeout: T }, async () => {
    const r = await start().real;
    assert.match(r.out, /^RETENTION: groups 8\/8, instances tracked 26 \(D 12 \/ P 6 \/ M 8\), collected 26, errors 0, worst tracker\.size\(\) 0 -- ok$/m);
});

test('bad flag: exit 1, FAIL with did-you-mean, no banner / provenance', { timeout: T }, async () => {
    const r = await start().bad;
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL unknown flag "--smok" \(did you mean --smoke\?\)/);
    assert.ok(NOBANNER(r.out), r.out);
});

// ---------------------------------------------------------------- must-fails (copies of the harness)
test('must-fail (a) A16 floor removed -> exit 1, census message, no SMOKE ok', { timeout: T }, async () => {
    const r = await start().floor;
    assert.equal(r.status, 1, r.out.slice(-800));
    assert.match(r.out, /FAIL parked-chunk census \(before any timing\): D w=16 n=64 RS-D: 1 large-slot chunk/);
    assert.doesNotMatch(r.out, /SMOKE ok/);
});

test('must-fail (b) an R0_SMALL key removed -> exit 1 "no R0_SMALL entry"', { timeout: T }, async () => {
    const r = await start().key;
    assert.equal(r.status, 1, r.out.slice(-800));
    assert.match(r.out, /FAIL pool sizing w=32 n=4096: no R0_SMALL entry for 32:4096/);
    assert.doesNotMatch(r.out, /SMOKE ok/);
});

test('must-fail (c) controlOk always true -> exit 1, "no teeth"', { timeout: T }, async () => {
    const r = await start().ctrl;
    assert.equal(r.status, 1, r.out.slice(-800));
    assert.match(r.out, /FAIL control classifier has no teeth/);
    assert.doesNotMatch(r.out, /SMOKE ok/);
});

test('must-fail (d) x2Ok always true -> exit 1, "no teeth"', { timeout: T }, async () => {
    const r = await start().x2;
    assert.equal(r.status, 1, r.out.slice(-800));
    assert.match(r.out, /FAIL control classifier has no teeth/);
    assert.doesNotMatch(r.out, /SMOKE ok/);
});

test('must-fail (e) mix-P own runner + P direct set + module ref + window retain -> ISOLATION / GC / RETENTION FAIL', { timeout: T }, async () => {
    const r = await start().combo;
    assert.equal(r.status, 1, r.out.slice(-800));
    assert.match(r.out, /^ISOLATION: D paged instances 0, P direct instances 1, mixed shared runners 0\/14, .* -- FAIL$/m);
    assert.match(r.out, /^GC windows 56\/56, major 0, arrayBuffers \+4096 B \| controls 3\/3 children -- FAIL$/m);
    assert.match(r.out, /^RETENTION: .*, worst tracker\.size\(\) 1 -- FAIL$/m);
    assert.doesNotMatch(r.out, /SMOKE ok/);
});

// ---------------------------------------------------------------- makeShape literals (R0 research/roaring/timing-harness.mjs
// makeShape(w, n, Q, false), the low lane; typed arrays as FNV-1a 32; cut 2026-11-05 by the G7-B2 reviewer)
const fnv = (a) => { let x = 0x811c9dc5; for (let i = 0; i < a.length; i++) x = Math.imul(x ^ a[i], 0x01000193); return x >>> 0; };
const SHAPE_R0 = {
    '16:64:256': { U: 65536, L: 65536, n: 64, seed: 2535138433, B: 16, M: 64, bpc: 8, keys: 4005720490, qHas: 2473559752, qSucc: 4135241631,
        qPred: 211325939, DEL: 3213246916, ADD: 2414660012, has: 128, successor: 8329057, predecessor: 7929059, min: 53248, max: 16737280 },
    '32:4096:256': { U: 4294967296, L: 1073741824, n: 4096, seed: 3503728977, B: 256, M: 4096, bpc: 32, keys: 3273871807, qHas: 1429444940,
        qSucc: 3497606604, qPred: 3518185965, DEL: 155566653, ADD: 605507305, has: 128, successor: -374056280, predecessor: -2141454424,
        min: 108099584, max: -44509184 },
};
test('makeShape equals the R0 shape literals; the hit folds match a linear-scan strict oracle', () => {
    for (const [k, e] of Object.entries(SHAPE_R0)) {
        const [w, n0, Q] = k.split(':').map(Number);
        const s = W.makeShape(w, n0, Q);
        for (const f of ['U', 'L', 'n', 'seed', 'B', 'M', 'bpc']) assert.equal(s[f], e[f], k + ' ' + f);
        for (const f of ['keys', 'qHas', 'qSucc', 'qPred', 'DEL', 'ADD']) assert.equal(fnv(s[f]), e[f], k + ' ' + f);
        for (const f of ['has', 'successor', 'predecessor', 'min', 'max']) assert.equal(s.oracle[f], e[f], k + ' oracle.' + f);
        let sh = 0, ph = 0;
        for (let i = 0; i < Q; i++) {
            const x = s.qHas[i];
            let su = -1, pr = -1;
            for (let j = 0; j < s.n; j++) {
                const v = s.keys[j];
                if (v > x && (su < 0 || v < su)) su = v;
                if (v < x && v > pr) pr = v;
            }
            sh = (sh + (su < 0 ? 1 : su)) | 0;
            ph = (ph + (pr < 0 ? 1 : pr)) | 0;
        }
        assert.equal(s.oracle.successorHit, sh, k + ' successorHit');
        assert.equal(s.oracle.predecessorHit, ph, k + ' predecessorHit');
    }
    assert.throws(() => W.makeShape(4, 64, 16), RangeError);
    assert.throws(() => W.makeShape(33, 64, 16), RangeError);
    assert.throws(() => W.makeShape(16, 0, 16), RangeError);
});
