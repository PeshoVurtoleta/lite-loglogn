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
const RE_COVERAGE = /^COVERAGE: n-sweep 2 points, U-sweep 2 widths, ABBA runs 11 \/ 11 \(K 3 rounds each\), probe rounds 33, latency runs 8 \/ 8, A\/B scenarios 4, pre-pass queries 78521$/m;
const RE_ABV = /^abVerdict exit \(printed, not used in smoke\): (0 PASS|1 FAIL|2 PENDING)$/m;
const RE_OK = /^XFT SMOKE ok/m;
const RE_FAIL = /^FAIL /m;
const RE_MODE = /mode XFT/;
const RE_CTRL_NAMES = [/^CONTROL drift: /gm, /^CONTROL abVerdict self-check: .* -- ok$/gm, /^CONTROL pre-pass: .* -- ok$/gm];
const count = (re, s) => (s.match(re) || []).length;

test('smoke run: exit 0, COVERAGE literal, abVerdict line, SMOKE ok, no FAIL', { timeout: T }, () => {
    const r = run(['--xft', '--smoke']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(RE_COVERAGE.test(r.stdout), 'COVERAGE line');
    assert.equal(count(new RegExp(RE_ABV.source, 'gm'), r.stdout), 1);
    assert.equal(count(new RegExp(RE_OK.source, 'gm'), r.stdout), 1);
    assert.ok(!RE_FAIL.test(r.stdout), 'no FAIL line');
    for (const re of RE_CTRL_NAMES) assert.equal(count(re, r.stdout), 1, String(re));
    // coverage floor: the control lines in the output are exactly three
    assert.equal(count(/^CONTROL /gm, r.stdout), 3);
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
    assert.equal((src.match(/^import\b/gm) || []).length, 11, "every top-level import statement, any form");
    const nonNode = all.filter((l) => !/from 'node:/.test(l));
    assert.equal(nonNode.length, 6);
    assert.equal(src.split("import('../LogLogN.js')").length - 1, 1);
    assert.equal(src.split("import('./helpers/abVerdict.mjs')").length - 1, 1);
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
    const good = 'COVERAGE: n-sweep 2 points, U-sweep 2 widths, ABBA runs 11 / 11 (K 3 rounds each), probe rounds 33, latency runs 8 / 8, A/B scenarios 4, pre-pass queries 78521';
    assert.ok(RE_COVERAGE.test(good), 'baseline accepts the literal');
    assert.ok(!RE_COVERAGE.test(good.replace('ABBA runs 11', 'ABBA runs 10')));
    assert.ok(!RE_COVERAGE.test(good.replace('latency runs 8 / 8', 'latency runs 7 / 8')));
    assert.ok(!RE_COVERAGE.test(good.replace('queries 78521', 'queries 0')));
    assert.ok(RE_ABV.test('abVerdict exit (printed, not used in smoke): 2 PENDING'));
    assert.ok(!RE_ABV.test('abVerdict exit (printed, not used in smoke): 3 PENDING'));
    assert.ok(!RE_ABV.test('abVerdict exit (printed, not used in smoke): 1 MAYBE'));
    assert.ok(!RE_ABV.test("abVerdict exit (printed, not used in smoke): 0 FAIL"));
    assert.ok(RE_OK.test('XFT SMOKE ok (x)') && !RE_OK.test('XFT SMOKE failed'));
    assert.ok(RE_FAIL.test('a\nFAIL x\nb') && !RE_FAIL.test('a\nPASS x\nb'));
    assert.equal(count(RE_CTRL_NAMES[1], 'CONTROL abVerdict self-check: a -- ok'), 1);
    assert.equal(count(RE_CTRL_NAMES[1], 'CONTROL abVerdict self-check: a -- bad'), 0);
    assert.equal(count(RE_CTRL_NAMES[2], 'CONTROL pre-pass: a -- ok\nCONTROL pre-pass: b -- ok'), 2);
    assert.equal(count(RE_CTRL_NAMES[2], 'CONTROL pre-pass: a'), 0);
});
