// VebWitness.test.js -- smoke gate for `node --expose-gc test/witness.mjs --veb --smoke` (G3-B4 / PLAN G3 TASK 6).
// Counts / strings only: no timing value and no timing-dependent verdict is asserted (C-10 / C-11 / C-22).
// Every expected value below is a literal from the spec / brief, never read back from witness output.
// Mutants run on copies in a mkdtemp dir (witness.mjs + LogLogN.js), one count-checked anchor each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('veb smoke: exit 0, 4 CONTROL, 0 FAIL, VEB SMOKE ok once', { timeout: T }, () => {
    const r = realRun();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(count(/^CONTROL /gm, r.stdout), 4);
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
