// VebWitness.test.js -- smoke gate for `node --expose-gc test/witness.mjs --veb --smoke` (G3-B4 / PLAN G3 TASK 6).
// Counts / strings only: no timing value and no timing-dependent verdict is asserted (C-10 / C-11 / C-22).
// Every expected value below is a literal from the spec / brief, never read back from witness output.
// Mutants run on copies in a mkdtemp dir (witness.mjs + LogLogN.js), one count-checked anchor each.
// G3-B5 (A15 / A16): 5 CONTROL lines (drift runs is the 2nd); hostDriftRuns unit vectors + throws, the TH / kRun
// teeth and the two abVerdict-input wiring mutants are written from the delta ASSERTIONS A3' / A6 / A7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as W from './witness.mjs';
import { mulberry32 } from './helpers/tierStream.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = 180000;
const KILL = 150000; // a child that outlives this is killed: status null -> the assertions fail

// pinned literal (brief G3-B4); stable over 3 smoke runs (probe rounds and queries are deterministic counts)
const COVERAGE = 'COVERAGE: widths 2 [16, 28] dropped 2 / 2, A/B scenarios 14 / 14 (C7 6, PAR 3, SH1 4, PRED 1), ABBA runs 17 / 17 (K 3 rounds each), probe rounds 51, pre-pass keysets 7 / 7, queries 281267, min/max checks 28, add+delete checks 12, gc window blocks 16 / 16, latency runs 12 / 12, tail runs 2 / 2, gc tail windows 2 / 2';
const RETENTION = "RETENTION: tail cycles 2 / 2, instances tracked 6, collected 6, errors 0, worst tracker.size() 0 after a cycle's drop + gc + settle; tracker.size() 0 -- ok";

const count = (re, s) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
const failLines = (s) => s.split('\n').filter((l) => l.startsWith('FAIL '));

function runIn(cwd, args, env) {
    return spawnSync(process.execPath, ['--expose-gc', 'test/witness.mjs', ...args],
        { cwd, encoding: 'utf8', timeout: KILL, env: env || process.env });
}

let real = null;
const realRun = () => real || (real = runIn(ROOT, ['--veb', '--smoke']));

test('veb smoke: exit 0, 5 CONTROL, 0 FAIL, VEB SMOKE ok once', { timeout: T }, () => {
    const r = realRun();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(count(/^CONTROL /gm, r.stdout), 5);
    assert.equal(count(/^FAIL /gm, r.stdout), 0);
    assert.equal(count(/^VEB SMOKE ok/gm, r.stdout), 1);
    assert.equal(count(/mode VEB SMOKE/g, r.stdout), 1);
});

test('veb smoke: COVERAGE literal (A/B 14, ABBA 17, latency 12, tail 2, gc tail 2) and RETENTION line', { timeout: T }, () => {
    const r = realRun();
    const lines = r.stdout.split('\n');
    assert.equal(lines.filter((l) => l.startsWith('COVERAGE')).length, 1);
    assert.ok(lines.includes(COVERAGE), 'COVERAGE line');
    assert.equal(lines.filter((l) => l === RETENTION).length, 1, 'RETENTION literal');
    assert.equal(count(/^RETENTION: /gm, r.stdout), 1);
});

test('veb bad flags beside --veb (--xft --yft --tier --w32 --bogus, LOGLOGN_W32=1): exit 1, flag named, no banner', { timeout: T }, () => {
    for (const f of ['--xft', '--yft', '--tier', '--w32', '--bogus']) {
        for (const args of [['--veb', f], [f, '--veb']]) {
            const r = runIn(ROOT, args);
            assert.equal(r.status, 1, args.join(' '));
            assert.ok(r.stdout.includes('unknown flag "' + f + '"'), args.join(' ') + ': ' + r.stdout);
            assert.ok(!/mode VEB/.test(r.stdout), 'no banner for ' + args.join(' '));
        }
    }
    const e = runIn(ROOT, ['--veb', '--smoke'], { ...process.env, LOGLOGN_W32: '1' });
    assert.equal(e.status, 1);
    assert.ok(e.stdout.includes('LOGLOGN_W32=1'), e.stdout);
    assert.ok(!/mode VEB/.test(e.stdout), 'no banner for LOGLOGN_W32=1');
});

// ---- mutants ----
const WSRC = readFileSync(join(ROOT, 'test', 'witness.mjs'), 'utf8');
const LSRC = readFileSync(join(ROOT, 'LogLogN.js'), 'utf8');
function once(src, site, to) {
    const n = src.split(site).length - 1;
    assert.equal(n, 1, 'anchor must occur exactly once (got ' + n + '): ' + JSON.stringify(site));
    return src.replace(site, to);
}
function mutantRun(witness, lib) {
    const dir = mkdtempSync(join(tmpdir(), 'vebw-mutant-'));
    try {
        mkdirSync(join(dir, 'test'));
        writeFileSync(join(dir, 'test', 'witness.mjs'), witness);
        writeFileSync(join(dir, 'LogLogN.js'), lib);
        writeFileSync(join(dir, 'package.json'), readFileSync(join(ROOT, 'package.json')));
        symlinkSync(join(ROOT, 'test', 'helpers'), join(dir, 'test', 'helpers'));
        symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
        return runIn(dir, ['--veb', '--smoke']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
function onlyFail(r, want) {
    assert.equal(r.status, 1, 'exit 1 expected; signal ' + r.signal + ' ' + r.stderr);
    const fl = failLines(r.stdout);
    assert.equal(fl.length, 1, 'exactly one FAIL line: ' + fl.join(' | '));
    assert.ok(fl[0].startsWith(want), fl[0]);
    assert.ok(!/^VEB SMOKE ok/m.test(r.stdout), 'no SMOKE ok');
}

test('mutant: tail coverage floor + 1 -> FAIL coverage: tail runs 2 / 3 alone', { timeout: T }, () => {
    onlyFail(mutantRun(once(WSRC, '    const wantTail = tailWS.length;\n', '    const wantTail = tailWS.length + 1;\n'), LSRC),
        'FAIL coverage: tail runs 2 / 3');
});

test('mutant: ArrayBuffer kept in the w=16 tail window -> FAIL gc window tail w=16 alone', { timeout: T }, () => {
    onlyFail(mutantRun(once(WSRC, '{ vTailReplay(tk, M, TSZ); GTN[0]++; }',
        '{ vTailReplay(tk, M, TSZ); GTN[0]++; if (w === 16) GKEEP.push(new ArrayBuffer(4096)); }'), LSRC),
    'FAIL gc window tail w=16: arrayBuffers growth ');
});

test('mutant: gc() inside the probe window -> FAIL gc window: gc.major alone', { timeout: T }, () => {
    const r = mutantRun(once(WSRC, '{ SINK[0] ^= vRun(probe, qAA, Q); GWN[0]++; }',
        '{ SINK[0] ^= vRun(probe, qAA, Q); GWN[0]++; if (i === 0) gcFn(); }'), LSRC);
    onlyFail(r, 'FAIL gc window: gc.major');
    assert.match(failLines(r.stdout)[0], /^FAIL gc window: gc\.major [1-9]\d* > 0 \(observed true\)$/);
});

test('mutant: instance kept across tail cycles -> exactly one FAIL retention line', { timeout: T }, () => {
    onlyFail(mutantRun(once(WSRC, '    VTAIL[1] = null;\n', '    GKEEP[0] = VTAIL[1]; VTAIL[1] = null;\n'), LSRC),
        'FAIL retention: tracker.size() 1 after a tail cycle (want 0)');
});

test('mutant: LogLogN.js without a vEBTree export -> FAIL vEB: LogLogN.js must export vEBTree', { timeout: T }, () => {
    onlyFail(mutantRun(WSRC, once(LSRC, 'export class vEBTree {', 'class vEBTree {')),
        'FAIL vEB: LogLogN.js must export vEBTree');
});

// ---- G3-B5: drift runs (A3' / A6 / A7) ----
const CTL_DRIFT = 'CONTROL drift: FLAT {"drift":false,"index":-1} STEP {"drift":true,"index":71} SPIKES {"drift":false,"index":-1}';
const CTL_RUNS = 'CONTROL drift runs: FLAT {"drift":false,"index":-1} STEP 1.25x {"drift":true,"index":24} STEP 0.8x {"drift":true,"index":23} STEP 1.10x {"drift":true,"index":27} MOD +-8% {"drift":false,"index":-1} MOD per-round {"drift":true,"index":91}';
const REASON = '  reason drift: host drift detected in the probe series (inconclusive)';

test('veb smoke: the 5 CONTROL lines once each, in order drift, drift runs, abVerdict, gc-window, pre-pass (FILLER 31)', { timeout: T }, () => {
    const r = realRun();
    const ctl = r.stdout.split('\n').filter((l) => l.startsWith('CONTROL '));
    assert.equal(ctl.length, 5);
    assert.equal(ctl.filter((l) => l === CTL_DRIFT).length, 1, 'drift literal');
    assert.equal(ctl.filter((l) => l === CTL_RUNS).length, 1, 'drift runs literal');
    assert.equal(ctl[0], CTL_DRIFT);
    assert.equal(ctl[1], CTL_RUNS);
    for (const [i, name] of [[2, 'abVerdict self-check'], [3, 'gc-window'], [4, 'pre-pass']]) {
        assert.match(ctl[i], new RegExp('^CONTROL ' + name + ': .* -- ok$'), name);
        assert.equal(count(new RegExp('^CONTROL ' + name + ': .* -- ok$', 'm'), r.stdout), 1, name + ' once');
    }
});

test('veb smoke: host: drift x1, host: drift runs line x1 (17 medians, k 3, TH 0.75), abVerdict exit line x1', { timeout: T }, () => {
    const o = realRun().stdout;
    assert.equal(count(/^host: drift \{/m, o), 1);
    assert.equal(count(/^host: drift runs \{"drift":(true|false),"index":-?\d+\} over 17 ABBA-run medians \(k 3, threshold 0\.75\) -- the abVerdict drift input \(A15\); the per-round host: drift line is REPORTED$/m, o), 1);
    assert.equal(count(/^abVerdict exit \(printed, not used in smoke\): [012] (PASS|FAIL|PENDING)$/m, o), 1);
});

test('hostDriftRuns: DRIFT_RUN_THRESHOLD 0.75 and every refusal throws the named class with the prefix', () => {
    assert.equal(W.DRIFT_RUN_THRESHOLD, 0.75);
    const P = /^\[lite-loglogn\] hostDriftRuns: /;
    const good = () => new Float64Array(120).fill(25);
    const bad = (i, x) => { const v = good(); v[i] = x; return v; };
    const cases = [
        [() => W.hostDriftRuns({}, 15), TypeError],
        [() => W.hostDriftRuns(good(), 0), RangeError],
        [() => W.hostDriftRuns(good(), 1.5), RangeError],
        [() => W.hostDriftRuns(good(), NaN), RangeError],
        [() => W.hostDriftRuns(new Float64Array(125).fill(25), 15), RangeError, /is not a multiple of k 15$/],
        [() => W.hostDriftRuns(new Float64Array(105).fill(25), 15), RangeError, /needs >= 8 blocks, got 7$/],
        [() => W.hostDriftRuns(bad(17, 0), 15), RangeError],
        [() => W.hostDriftRuns(bad(17, -1), 15), RangeError],
        [() => W.hostDriftRuns(bad(17, NaN), 15), RangeError],
        [() => W.hostDriftRuns(bad(17, Infinity), 15), RangeError],
        [() => { const a = Array.from(good()); a[3] = 'x'; return W.hostDriftRuns(a, 15); }, TypeError],
    ];
    cases.forEach(([f, E, tail], i) => assert.throws(f, (e) => e.constructor === E && P.test(e.message) && (!tail || tail.test(e.message)), 'case ' + i));
});

// the B5-4 vectors, rebuilt here from the spec text
const SHAPE = [1,1,1,1,1,-1,-1,-1,-1,-1,-1,1,1,1,1,-1,-1,1,1,1,1,-1,-1,-1,-1,-1,-1,1,1,1,1,1,1,1,-1,-1,-1,-1,1,-1,1];
function vec(lvl) {
    const r = mulberry32(0xC0FFEE);
    const v = new Float64Array(41 * 15);
    for (let i = 0; i < v.length; i++) v[i] = 25 * (1 + 0.03 * (2 * r() - 1)) * lvl(Math.floor(i / 15));
    return v;
}
const vFlat = () => vec(() => 1);
const vUp = () => vec((j) => (j >= 20 ? 1.25 : 1));
const vMod = () => vec((j) => 1 + 0.08 * SHAPE[j]);

test('hostDriftRuns vectors (41 x 15): FLAT -1, 1.25x@20 24, 0.8x@20 23, 1.10x@10 27, MOD +-8% -1; hostDrift(MOD) 91', () => {
    assert.equal(SHAPE.length, 41);
    assert.deepEqual(W.hostDriftRuns(vFlat(), 15), { drift: false, index: -1 });
    assert.deepEqual(W.hostDriftRuns(vUp(), 15), { drift: true, index: 24 });
    assert.deepEqual(W.hostDriftRuns(vec((j) => (j >= 20 ? 0.8 : 1)), 15), { drift: true, index: 23 });
    assert.deepEqual(W.hostDriftRuns(vec((j) => (j >= 10 ? 1.1 : 1)), 15), { drift: true, index: 27 });
    assert.deepEqual(W.hostDriftRuns(vMod(), 15), { drift: false, index: -1 });
    assert.deepEqual(W.hostDrift(vMod()), { drift: true, index: 91 });
});

test('hostDriftRuns block semantics: a median ignores one outlier per block; a 2x block is clamped; a uniform x3 scale changes nothing', () => {
    const f = vFlat();
    for (let r = 20; r < 41; r++) f[r * 15 + 7] = 400;
    assert.deepEqual(W.hostDriftRuns(f, 15), W.hostDriftRuns(vFlat(), 15));
    assert.deepEqual(W.hostDriftRuns(vec((j) => (j === 20 ? 2 : 1)), 15), { drift: false, index: -1 }); // one 2x block clamps to 1.5
    const u = vUp();
    for (let i = 0; i < u.length; i++) u[i] *= 3;
    assert.deepEqual(W.hostDriftRuns(u, 15), W.hostDriftRuns(vUp(), 15));
    assert.deepEqual(W.hostDriftRuns(u, 15), { drift: true, index: 24 });
});

test('mutant: DRIFT_RUN_THRESHOLD 0.75 -> 2.0 -> FAIL control drift runs: STEP 1.10x missed alone', { timeout: T }, () => {
    const r = mutantRun(once(WSRC, 'export const DRIFT_RUN_THRESHOLD = 0.75;', 'export const DRIFT_RUN_THRESHOLD = 2.0;'), LSRC);
    onlyFail(r, 'FAIL control drift runs: STEP 1.10x missed');
    assert.equal(failLines(r.stdout)[0], 'FAIL control drift runs: STEP 1.10x missed');
});

test('mutant: kRun 15 -> 1 -> FAIL control drift runs: MOD +-8% fired alone', { timeout: T }, () => {
    const r = mutantRun(once(WSRC, 'const kRun = 15;', 'const kRun = 1;'), LSRC);
    onlyFail(r, 'FAIL control drift runs: MOD +-8% fired');
    assert.equal(failLines(r.stdout)[0], 'FAIL control drift runs: MOD +-8% fired');
});

test('wiring: abVerdict drift input is the per-run result (A: runs fire -> reason x1; B: runs quiet -> x0, exit 0; C: refused series -> one FAIL drift runs line, exit 1)', { timeout: 3 * T }, () => {
    const site = '    const hdR = driftRunsOrFail(series, ST.pos, K, fails);\n';
    const a = mutantRun(once(WSRC, site, '    const hdR = { drift: true, index: 0 }; hd.drift = false;\n'), LSRC);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout.split('\n').filter((l) => l === REASON).length, 1, 'wiring A');
    const b = mutantRun(once(WSRC, site, '    const hdR = { drift: false, index: -1 }; hd.drift = true;\n'), LSRC);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(b.stdout.split('\n').filter((l) => l === REASON).length, 0, 'wiring B');
    const c = mutantRun(once(WSRC, site, '    const hdR = driftRunsOrFail(series, ST.pos - 1, K, fails);\n'), LSRC);
    onlyFail(c, 'FAIL drift runs: hostDriftRuns refused the probe series (50 rounds, k 3): [lite-loglogn] hostDriftRuns: series length 50 is not a multiple of k 3');
});
