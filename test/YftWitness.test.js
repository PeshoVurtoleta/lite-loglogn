// YftWitness.test.js -- smoke gate for `node test/witness.mjs --yft --smoke` (Y-B2: G3-5 + G3-6, A1-A5).
// Counts / strings only: no timing value and no timing-dependent verdict is asserted (C-10 / C-11).
// Every expected value below is a literal from the spec / brief, never read back from witness output.
// The A3 replay computes per-kind counts independently (own tagging loop, literal seeds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { YFastTrie } from '../LogLogN.js';
import { yftTailKeys } from './witness.mjs';
import { yftSmokeVerdict, YFT_COVERAGE_LITERAL, RE_MAX, RE_COUNTS, RE_GCTAIL, RE_RETENTION, RE_CTRL } from './helpers/yftSmoke.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIT = join(ROOT, 'test', 'witness.mjs');
const T = 60000;

function run(args, script) {
    return spawnSync(process.execPath, [script || 'test/witness.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 55000 });
}
const count = (re, s) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
const failLines = (s) => s.split('\n').filter((l) => l.startsWith('FAIL '));

// spec literals (brief Y-B2 / A1-A5)
const COUNTS16 = 'COUNTS tail w=16 M=4096: splits 181 merges 181 inner kicks 0 inner reseeds 0 | per-kind ops plain 7829 split 181 merge 182 reseed 0 | borrows 1 (tagged merge)';
const COUNTS28 = 'COUNTS tail w=28 M=4096: splits 105 merges 105 inner kicks 0 inner reseeds 0 | per-kind ops plain 7980 split 105 merge 107 reseed 0 | borrows 2 (tagged merge)';
const RETENTION = "RETENTION: tail cycles 2 / 2, instances tracked 4, collected 4, errors 0, worst tracker.size() 0 after a cycle's drop + gc + settle; tracker.size() 0 -- ok";

let real = null; // one shared real smoke run for A1 / A3 / A5 checks
const realRun = () => real || (real = run(['--yft', '--smoke']));

test('A1 smoke run: exit 0, COVERAGE literal, 4 CONTROL, no FAIL, SMOKE ok', { timeout: T }, () => {
    const r = realRun();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.split('\n').includes(YFT_COVERAGE_LITERAL), 'COVERAGE line');
    assert.ok(YFT_COVERAGE_LITERAL.includes('tail runs 2 / 2') && YFT_COVERAGE_LITERAL.includes('gc tail windows 2 / 2'));
    assert.equal(count(/^CONTROL /gm, r.stdout), 4);
    for (const re of RE_CTRL) assert.equal(count(re, r.stdout), 1, String(re));
    assert.equal(count(/^FAIL /gm, r.stdout), 0);
    assert.equal(count(/^YFT SMOKE ok/gm, r.stdout), 1);
    assert.equal(count(/^abVerdict exit \(printed, not used in smoke\): (0 PASS|1 FAIL|2 PENDING)$/gm, r.stdout), 1);
    assert.equal(count(/mode YFT SMOKE/g, r.stdout), 1);
});

test('A1 tail rows of the real run: COUNTS literals, MAX rows, GC tail rows, RETENTION (A2 / A3 / A5 pins)', { timeout: T }, () => {
    const r = realRun();
    const lines = r.stdout.split('\n');
    assert.ok(lines.includes(COUNTS16), 'COUNTS w=16');
    assert.ok(lines.includes(COUNTS28), 'COUNTS w=28');
    assert.equal(count(/^COUNTS tail /gm, r.stdout), 2);
    assert.ok(lines.includes(RETENTION), 'RETENTION literal');
    assert.equal(count(RE_RETENTION, r.stdout), 1);
    const gt = [...r.stdout.matchAll(new RegExp(RE_GCTAIL.source, 'gm'))];
    assert.deepEqual(gt.map((m) => m[1]), ['16', '28']);
    for (const m of gt) assert.ok(/^(0|-\d+)$/.test(m[2]), 'growth <= 0');
    assert.equal(count(/^GC window tail w=/gm, r.stdout), 2);
    assert.equal(count(/^GC window tail w=\d+: .* gc\.major 0 /gm, r.stdout), 2);
    const mx = [...r.stdout.matchAll(new RegExp(RE_MAX.source, 'gm'))];
    assert.deepEqual(mx.map((m) => m[1]), ['16', '28']);
    for (const m of mx) {
        assert.ok(+m[3] >= 0 && +m[3] < 8192, 'op # range');
        // reseed ops are 0 in both COUNTS rows, so the reseed per-kind max is n/a (C-15 n/a rule)
        assert.equal(m[16], 'n/a');
    }
    assert.deepEqual(yftSmokeVerdict({ status: r.status, signal: r.signal, error: r.error, stdout: r.stdout }).fails, []);
});

test('A1 bad flags: --yft beside --xft / --tier / --bogus, either order: exit 1, named, no banner', { timeout: T }, () => {
    for (const f of ['--xft', '--tier', '--bogus']) {
        for (const args of [['--yft', f], [f, '--yft']]) {
            const r = run(args);
            assert.equal(r.status, 1, args.join(' '));
            assert.ok(r.stdout.includes('unknown flag "' + f + '"'), args.join(' '));
            assert.ok(!/mode YFT/.test(r.stdout), 'no mode banner for ' + args.join(' '));
        }
    }
});

function mutantRun(site, to) {
    const src = readFileSync(WIT, 'utf8');
    assert.equal(src.split(site).length - 1, 1, 'replacement site occurs once: ' + site);
    const name = '_yftw-mutant-' + process.pid + '.mjs';
    const mutant = join(ROOT, 'test', name);
    writeFileSync(mutant, src.replace(site, to));
    try {
        return run(['--yft', '--smoke'], 'test/' + name);
    } finally {
        unlinkSync(mutant);
    }
}
function onlyFail(r, want) {
    assert.equal(r.status, 1, r.stderr);
    const fl = failLines(r.stdout);
    assert.equal(fl.length, 1, 'exactly one FAIL line: ' + fl.join(' | '));
    assert.ok(fl[0].startsWith(want), fl[0]);
    assert.ok(!/^YFT SMOKE ok/m.test(r.stdout), 'no SMOKE ok');
}

test('A1 mutant: tail run floor + 1 -> FAIL coverage (tail runs 2 / 3, gc tail windows 2 / 3)', { timeout: T }, () => {
    const r = mutantRun('    const wantTail = WS.length;\n', '    const wantTail = WS.length + 1;\n');
    onlyFail(r, 'FAIL coverage');
    assert.ok(failLines(r.stdout)[0].includes('tail runs 2 / 3, gc tail windows 2 / 3'), failLines(r.stdout)[0]);
});

test('A2 mutant: retained ArrayBuffer in the w=16 tail window -> FAIL gc window tail w=16 alone', { timeout: T }, () => {
    const r = mutantRun('{ yTailReplay(tk, M, TCA); GTN[0]++; }',
        '{ yTailReplay(tk, M, TCA); GTN[0]++; if (w === 16) GKEEP.push(new ArrayBuffer(4096)); }');
    onlyFail(r, 'FAIL gc window tail w=16');
});

test('A2 mutant: forced gc() inside the probe window -> FAIL gc window: gc.major alone', { timeout: T }, () => {
    const r = mutantRun('{ SINK[0] ^= yRun(probe, qAA, Q); GWN[0]++; }',
        '{ SINK[0] ^= yRun(probe, qAA, Q); GWN[0]++; if (i === 0) gcFn(); }');
    onlyFail(r, 'FAIL gc window: gc.major');
});

test('A2 mutant: gc-window control disabled -> FAIL control gc-window: retain did not flip alone', { timeout: T }, () => {
    const r = mutantRun('w.abBad = !Number.isFinite(w.growth) || !(w.growth <= 0);', 'w.abBad = false;');
    onlyFail(r, 'FAIL control gc-window: retain did not flip');
});

test('A3 mutant: split delta forced to 0 -> FAIL attribution lines only', { timeout: T }, () => {
    const r = mutantRun('td[o] = s._n[0] - cb[0];', 'td[o] = 0;');
    assert.equal(r.status, 1, r.stderr);
    const fl = failLines(r.stdout);
    assert.ok(fl.length >= 1, 'at least one FAIL');
    assert.ok(fl.every((l) => l.startsWith('FAIL attribution')), fl.join(' | '));
});

test('A5 mutant: instance retained across cycles -> exactly one FAIL retention line', { timeout: T }, () => {
    const r = mutantRun('    YTAIL[1] = null;\n', '    GKEEP[0] = YTAIL[1]; YTAIL[1] = null;\n');
    onlyFail(r, 'FAIL retention:');
});

// A3: independent replay of the tail workload, per-op kind tagging by each op's own deltas.
// kind rule (highest wins): reseed (inner _x._q[2]) > split (_n[0]) > merge (_n[1] or borrow _n[2]) > plain.
function replay(w, seed) {
    const M = 4096;
    const keys = yftTailKeys(M, 2 ** w, seed);
    const s = new YFastTrie(2 ** w, M);
    const per = { plain: 0, split: 0, merge: 0, reseed: 0 };
    let kicks0 = s._x._q[1], reseeds0 = s._x._q[2];
    const k0 = [kicks0, reseeds0];
    const tag = (op) => {
        const a0 = s._n[0], a1 = s._n[1], a2 = s._n[2], r0 = s._x._q[2];
        op();
        let kind = 'plain';
        if (s._x._q[2] !== r0) kind = 'reseed';
        else if (s._n[0] !== a0) kind = 'split';
        else if (s._n[1] !== a1 || s._n[2] !== a2) kind = 'merge';
        per[kind]++;
    };
    for (let i = 0; i < M; i++) tag(() => s.add(keys[i]));
    for (let i = 0; i < M; i++) tag(() => s.delete(keys[i]));
    return { splits: s._n[0], merges: s._n[1], borrows: s._n[2], kicks: s._x._q[1] - k0[0], reseeds: s._x._q[2] - k0[1], per };
}
const row = (w, c) => 'COUNTS tail w=' + w + ' M=4096: splits ' + c.splits + ' merges ' + c.merges + ' inner kicks ' + c.kicks +
    ' inner reseeds ' + c.reseeds + ' | per-kind ops plain ' + c.per.plain + ' split ' + c.per.split + ' merge ' + c.per.merge +
    ' reseed ' + c.per.reseed + ' | borrows ' + c.borrows + ' (tagged merge)';

test('A3 replay: independent per-op tagging reproduces the COUNTS literals and the witness rows; seed + 1 does not', { timeout: T }, () => {
    const r = realRun();
    const lit = { 16: COUNTS16, 28: COUNTS28 };
    for (const w of [16, 28]) {
        const c = replay(w, 0x7A170000 + w);
        assert.equal(row(w, c), lit[w], 'replay vs literal w=' + w);
        assert.ok(r.stdout.split('\n').includes(row(w, c)), 'replay vs witness row w=' + w);
        assert.equal(c.per.plain + c.per.split + c.per.merge + c.per.reseed, 8192);
        const c2 = replay(w, 0x7A170000 + w + 1);
        assert.notEqual(row(w, c2), lit[w], 'control: seed + 1 must not match w=' + w);
    }
});

// A4: yftSmokeVerdict over the six fakes
test('A4 fakes: good -> [], each bad fake -> exactly its named fail', { timeout: T }, () => {
    const want = { good: [], empty: ['empty stdout'], exit1: ['status 1'], garbage: ['mode banner'], kill: ['signal SIGKILL'], nan: ['non-finite'] };
    for (const [n, w] of Object.entries(want)) {
        const r = spawnSync(process.execPath, ['test/fakes/yftw-' + n + '.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
        assert.deepEqual(yftSmokeVerdict({ status: r.status, signal: r.signal, error: r.error, stdout: r.stdout }).fails, w, n);
    }
});

test('A4 verdict controls: counts parsed; n/a rule both directions; op # range; coverage literal', () => {
    const good = readFileSync(join(ROOT, 'test', 'fakes', 'yftw-good.mjs'), 'utf8');
    const T0 = JSON.parse(good.match(/const T = (".*");\n/)[1]);
    const ok = (s) => yftSmokeVerdict({ status: 0, signal: null, error: undefined, stdout: s });
    const v = ok(T0);
    assert.deepEqual(v.fails, []);
    assert.equal(v.counts[16].plain, 7829);
    assert.equal(v.counts[28].borrows, 2);
    // inverted n/a: a number where the count is 0 (reseed -1.00 style), and n/a where the count is > 0
    assert.ok(ok(T0.replace('merge 2000.00, reseed n/a', 'merge 2000.00, reseed -1.00')).fails.some((f) => f.startsWith('n/a rule reseed')));
    assert.ok(ok(T0.replace('plain 51291.00, split 2500.00', 'plain n/a, split 2500.00')).fails.some((f) => f.startsWith('n/a rule plain')));
    assert.ok(ok(T0.replace('op #4441', 'op #8192')).fails.some((f) => f.startsWith('op # range')));
    assert.ok(ok(T0.replace('tail runs 2 / 2', 'tail runs 2 / 3')).fails.includes('coverage row'));
    assert.ok(ok(T0.replace('max 9625.00 ns', 'max -5.00 ns')).fails.some((f) => f.startsWith('negative')));
});
