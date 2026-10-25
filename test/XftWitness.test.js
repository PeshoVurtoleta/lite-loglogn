// XftWitness.test.js -- smoke gate for `node test/witness.mjs --xft --smoke` (G-B4).
// Counts / strings only: no timing value and no timing-dependent verdict is asserted.
// Every expected value below is a literal taken from the spec, never read back from witness.mjs output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIT = join(ROOT, 'test', 'witness.mjs');
const T = 60000;

function run(args, script) {
    return spawnSync(process.execPath, [script || 'test/witness.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 55000 });
}

// matchers (shared by the real checks and the doctored-string controls)
const RE_COVERAGE = /^COVERAGE: n-sweep 2 points, U-sweep 2 widths, ABBA runs 11 \/ 11 \(K 3 rounds each\), probe rounds 33, latency runs 8 \/ 8, A\/B scenarios 4, pre-pass queries 78521, gc window blocks 16 \/ 16$/m;
const RE_ABV = /^abVerdict exit \(printed, not used in smoke\): (0 PASS|1 FAIL|2 PENDING)$/m;
const RE_OK = /^XFT SMOKE ok/m;
const RE_FAIL = /^FAIL /m;
const RE_MODE = /mode XFT/;
const RE_CTRL_NAMES = [/^CONTROL drift: /gm, /^CONTROL abVerdict self-check: .* -- ok$/gm, /^CONTROL pre-pass: .* -- ok$/gm,
    /^CONTROL gc-window: empty major 0 growth -?\d+ B clean; retained 1048576 B ArrayBuffer major 0 growth \d+ B flips arrayBuffers only; forced gc\(\) major [1-9]\d* growth -?\d+ B flips gc\.major only -- ok$/gm];
// the real GC window row (the --xft untimed probe tier-up): tolerance zero on both metrics
const RE_GCW = /^GC window: 16 untimed XFastTrie successor probe blocks of 4096 queries \(the tier-up before round 1\): gc\.major 0 minor \d+ arrayBuffers growth (0|-\d+) B \(tolerance: major 0, growth 0 B\) -- ok$/gm;
const count = (re, s) => (s.match(re) || []).length;

test('smoke run: exit 0, COVERAGE literal, abVerdict line, SMOKE ok, no FAIL', { timeout: T }, () => {
    const r = run(['--xft', '--smoke']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(RE_COVERAGE.test(r.stdout), 'COVERAGE line');
    assert.equal(count(new RegExp(RE_ABV.source, 'gm'), r.stdout), 1);
    assert.equal(count(new RegExp(RE_OK.source, 'gm'), r.stdout), 1);
    assert.ok(!RE_FAIL.test(r.stdout), 'no FAIL line');
    for (const re of RE_CTRL_NAMES) assert.equal(count(re, r.stdout), 1, String(re));
    // coverage floor: the control lines in the output are exactly four
    assert.equal(count(/^CONTROL /gm, r.stdout), 4);
    assert.equal(count(RE_GCW, r.stdout), 1, 'GC window row');
    assert.equal(count(/^GC window: /gm, r.stdout), 1, 'exactly one GC window row');
});

test('unknown flags: exit 1, named, before the mode banner', { timeout: T }, () => {
    for (const f of ['--bogus', '--tier']) {
        const r = run(['--xft', f]);
        assert.equal(r.status, 1, f);
        assert.ok(r.stdout.includes('unknown flag "' + f + '"'), f);
        assert.ok(!RE_MODE.test(r.stdout), 'no mode banner for ' + f);
    }
});

test('source pins on witness.mjs', () => {
    const src = readFileSync(WIT, 'utf8');
    const all = src.match(/^(import [^\n]* from ')([^']+)(';)$/gm) || [];
    assert.equal(all.length, 11);
    assert.equal((src.match(/^import\b/gm) || []).length, 11, 'every top-level import statement, any form');
    const nonNode = all.filter((l) => !/from 'node:/.test(l));
    assert.equal(nonNode.length, 6);
    assert.equal(src.split("import('../LogLogN.js')").length - 1, 1);
    assert.equal(src.split("import('./helpers/abVerdict.mjs')").length - 1, 1);
    assert.equal(src.split("import('@zakkster/lite-gc-profiler')").length - 1, 1);
    assert.equal(src.split("import('node:v8')").length - 1, 1);
    assert.equal(src.split("import('node:vm')").length - 1, 1);
});

// must-fail control (c): the GC check disabled, one metric at a time, or a dirty real window.
// Each mutant leaves the other metric live, so the run must FAIL on the row it names, alone.
test('must-fail control (c): mutants with a disabled GC metric, a non-finite growth or an unobserved metric, or a dirty real window, exit 1 with FAIL on that row', { timeout: T }, () => {
    const src = readFileSync(WIT, 'utf8');
    const cases = [
        ['w.abBad = !Number.isFinite(w.growth) || !(w.growth <= 0);', 'w.abBad = false;',
            'FAIL control gc-window: retain did not flip arrayBuffers ('],
        ['w.majorBad = !w.observed || !Number.isInteger(w.major) || !(w.major <= 0);', 'w.majorBad = false;',
            'FAIL control gc-window: forced gc() did not flip gc.major ('],
        ['{ SINK[0] ^= xRun(probe, qAA, Q); GWN[0]++; }', '{ SINK[0] ^= xRun(probe, qAA, Q); GWN[0]++; GKEEP.push(new ArrayBuffer(4096)); }', 'FAIL gc window: arrayBuffers growth '],
        ['{ SINK[0] ^= xRun(probe, qAA, Q); GWN[0]++; }', '{ SINK[0] ^= xRun(probe, qAA, Q); GWN[0]++; if (i === 0) gcFn(); }', 'FAIL gc window: gc.major '],
        // guard-clause pins (each row is flagged ONLY by the clause named): growth NaN on the retain step (GCC 2)
        // makes abBad true with growth > 0 false -> only `!(wR.growth > 0)` can flag it.
        ['growth: ab1 - ab0,', 'growth: GCC[0] === 2 ? NaN : ab1 - ab0,',
            'FAIL control gc-window: retain did not flip arrayBuffers ('],
        // observed false on the forced-gc step (GCC 3) makes majorBad true with a real major > 0 -> only
        // `!(wK.observed && wK.major > 0)` can flag it.
        ['observed: s.gc.observed === true,', 'observed: GCC[0] === 3 ? false : s.gc.observed === true,',
            'FAIL control gc-window: forced gc() did not flip gc.major ('],
    ];
    for (const [site, to, want] of cases) {
        assert.equal(src.split(site).length - 1, 1, 'replacement site occurs once: ' + site);
        const name = '_xftw-mutant-gc-' + process.pid + '.mjs';
        const mutant = join(ROOT, 'test', name);
        writeFileSync(mutant, src.replace(site, to));
        try {
            const r = run(['--xft', '--smoke'], 'test/' + name);
            assert.equal(r.status, 1, r.stderr);
            assert.ok(RE_FAIL.test(r.stdout), 'FAIL line');
            const fl = r.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
            assert.equal(fl.length, 1, 'exactly one FAIL line: ' + fl.join(' | '));
            assert.ok(fl[0].startsWith(want) && !fl[0].includes('; '), 'only the named row fails: ' + fl[0]);
            assert.ok(!RE_OK.test(r.stdout), 'no SMOKE ok');
        } finally {
            unlinkSync(mutant);
        }
    }
});

test('must-fail control (a): mutant with a broken latency floor exits 1 with FAIL', { timeout: T }, () => {
    const src = readFileSync(WIT, 'utf8');
    const site = 'const wantLat = 2 * (NS.length + WS.length);';
    assert.equal(src.split(site).length - 1, 1, 'replacement site occurs once');
    const mutant = join(ROOT, 'test', '_xftw-mutant-' + process.pid + '.mjs');
    writeFileSync(mutant, src.replace(site, 'const wantLat = 2 * (NS.length + WS.length) + 1;'));
    try {
        const r = run(['--xft', '--smoke'], 'test/' + '_xftw-mutant-' + process.pid + '.mjs');
        assert.equal(r.status, 1, r.stderr);
        assert.ok(RE_FAIL.test(r.stdout), 'FAIL line');
        assert.ok(!RE_OK.test(r.stdout), 'no SMOKE ok');
    } finally {
        unlinkSync(mutant);
    }
});

test('must-fail control (b): each matcher rejects a doctored string', () => {
    const good = 'COVERAGE: n-sweep 2 points, U-sweep 2 widths, ABBA runs 11 / 11 (K 3 rounds each), probe rounds 33, latency runs 8 / 8, A/B scenarios 4, pre-pass queries 78521, gc window blocks 16 / 16';
    assert.ok(RE_COVERAGE.test(good), 'baseline accepts the literal');
    assert.ok(!RE_COVERAGE.test(good.replace('ABBA runs 11', 'ABBA runs 10')));
    assert.ok(!RE_COVERAGE.test(good.replace('latency runs 8 / 8', 'latency runs 7 / 8')));
    assert.ok(!RE_COVERAGE.test(good.replace('queries 78521', 'queries 0')));
    assert.ok(RE_ABV.test('abVerdict exit (printed, not used in smoke): 2 PENDING'));
    assert.ok(!RE_ABV.test('abVerdict exit (printed, not used in smoke): 3 PENDING'));
    assert.ok(!RE_ABV.test('abVerdict exit (printed, not used in smoke): 1 MAYBE'));
    assert.ok(!RE_ABV.test('abVerdict exit (printed, not used in smoke): 0 FAIL'));
    assert.ok(RE_OK.test('XFT SMOKE ok (x)') && !RE_OK.test('XFT SMOKE failed'));
    assert.ok(RE_FAIL.test('a\nFAIL x\nb') && !RE_FAIL.test('a\nPASS x\nb'));
    assert.equal(count(RE_CTRL_NAMES[1], 'CONTROL abVerdict self-check: a -- ok'), 1);
    assert.equal(count(RE_CTRL_NAMES[1], 'CONTROL abVerdict self-check: a -- bad'), 0);
    assert.equal(count(RE_CTRL_NAMES[2], 'CONTROL pre-pass: a -- ok\nCONTROL pre-pass: b -- ok'), 2);
    assert.equal(count(RE_CTRL_NAMES[2], 'CONTROL pre-pass: a'), 0);
    const gcOk = 'CONTROL gc-window: empty major 0 growth 0 B clean; retained 1048576 B ArrayBuffer major 0 growth 1048576 B' +
        ' flips arrayBuffers only; forced gc() major 1 growth 0 B flips gc.major only -- ok';
    assert.equal(count(RE_CTRL_NAMES[3], gcOk), 1, 'baseline accepts the gc-window literal');
    assert.equal(count(RE_CTRL_NAMES[3], gcOk.replace(' -- ok', ' -- bad')), 0);
    assert.equal(count(RE_CTRL_NAMES[3], gcOk.replace('forced gc() major 1', 'forced gc() major 0')), 0);
    assert.equal(count(RE_CTRL_NAMES[3], gcOk.replace('empty major 0', 'empty major 1')), 0);
    assert.equal(count(RE_CTRL_NAMES[3], gcOk.replace('ArrayBuffer major 0', 'ArrayBuffer major 2')), 0);
    assert.equal(count(RE_CTRL_NAMES[3], gcOk.replace('retained 1048576 B', 'retained 0 B')), 0);
    const gwOk = 'GC window: 16 untimed XFastTrie successor probe blocks of 4096 queries (the tier-up before round 1):' +
        ' gc.major 0 minor 3 arrayBuffers growth 0 B (tolerance: major 0, growth 0 B) -- ok';
    assert.equal(count(RE_GCW, gwOk), 1, 'baseline accepts the GC window literal');
    assert.equal(count(RE_GCW, gwOk.replace('growth 0 B (', 'growth -64 B (')), 1, 'a concurrent free is accepted');
    assert.equal(count(RE_GCW, gwOk.replace('gc.major 0', 'gc.major 1')), 0);
    assert.equal(count(RE_GCW, gwOk.replace('growth 0 B (', 'growth 8 B (')), 0);
    assert.equal(count(RE_GCW, gwOk.replace('GC window: 16', 'GC window: 0')), 0);
    assert.equal(count(RE_GCW, gwOk.replace(' -- ok', ' -- FAIL')), 0);
    const cov = 'COVERAGE: n-sweep 2 points, U-sweep 2 widths, ABBA runs 11 / 11 (K 3 rounds each), probe rounds 33,' +
        ' latency runs 8 / 8, A/B scenarios 4, pre-pass queries 78521, gc window blocks 16 / 16';
    assert.ok(RE_COVERAGE.test(cov));
    assert.ok(!RE_COVERAGE.test(cov.replace('gc window blocks 16 / 16', 'gc window blocks 0 / 16')));
});
