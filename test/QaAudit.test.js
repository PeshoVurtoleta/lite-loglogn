/**
 * @zakkster/lite-loglogn -- cross-cutting QA audit.
 *
 * The suite-law regression guard. It enforces the invariants every release
 * must hold, independent of any one member:
 *   - the VERSION trinity (LogLogN.js const === package.json === llms.txt), the
 *     version check of record (no test pins a version literal);
 *   - the frozen export surface (exactly StratifiedBitset + VERSION + XFastTrie);
 *   - the six-file pack discipline (files[] exact; repo-only dirs absent);
 *   - no "Karadjov" anywhere in the shipped source / docs;
 *   - ASCII-only source in LogLogN.js (this family needs NO Unicode exception --
 *     even U+00D7 / U+00B5 are spelled out as "x" / "mu");
 *   - the gate flag pins in package.json scripts: test:perf carries
 *     --expose-gc and --max-semi-space-size=4 (PerfGate's calibration flag),
 *     torture carries --expose-gc and NO semi-space flag (its transient lane is
 *     calibrated under the default new space).
 * Each member session appends its coercion / boundary block below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as LogLogNModule from '../LogLogN.js';
import { VERSION, StratifiedBitset } from '../LogLogN.js';
import { startFn, expectFn } from './_worker-run.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// --- VERSION trinity: LogLogN.js const === package.json === llms.txt ---------

test('VERSION trinity: LogLogN.js const, package.json, and llms.txt agree byte-for-byte', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(VERSION, pkg.version, 'LogLogN.js VERSION const !== package.json version');
    const llms = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
    const m = llms.match(/^Version:\s*(\S+)/m);
    assert.ok(m, 'llms.txt must carry a "Version: <x>" header line');
    assert.equal(m[1], VERSION, 'llms.txt Version header !== LogLogN.js VERSION const');
});

// --- frozen export surface: StratifiedBitset + VERSION + XFastTrie ---------

test('LogLogN.js exports exactly StratifiedBitset, VERSION and XFastTrie -- nothing else has leaked in', () => {
    const exportedNames = Object.keys(LogLogNModule).sort();
    assert.deepEqual(exportedNames, ['StratifiedBitset', 'VERSION', 'XFastTrie'],
        'LogLogN.js export surface drifted from the frozen surface (StratifiedBitset, VERSION, XFastTrie)');
    assert.equal(typeof VERSION, 'string');
    assert.equal(typeof LogLogNModule.StratifiedBitset, 'function');
});

// --- six-file pack discipline (L-08 / decisions/0003) -----------------------

test('package.json files[] ships exactly the six shipped files', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const expected = ['LogLogN.js', 'LogLogN.d.ts', 'llms.txt', 'README.md', 'CHANGELOG.md', 'LICENSE'];
    assert.deepEqual([...pkg.files].sort(), [...expected].sort(),
        'files[] drifted from the six shipped files');
});

test('files[] contains none of the repo-only paths', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const repoOnly = ['test', 'benchmark', 'decisions', 'demo', 'ROADMAP.md', 'RESEARCH.md', 'GUIDE.md'];
    for (const f of pkg.files) {
        for (const banned of repoOnly) {
            assert.ok(!f.startsWith(banned),
                'files[] must not ship the repo-only path ' + f);
        }
    }
});

// --- no "Karadjov" anywhere in the shipped source / docs --------------------

test('no "Karadjov" in the shipped files (the name is always Shinikchiev)', () => {
    const files = ['LogLogN.js', 'LogLogN.d.ts', 'llms.txt', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'];
    for (const f of files) {
        const text = readFileSync(join(ROOT, f), 'utf8');
        assert.ok(!/Karadjov/i.test(text), f + ' must not contain "Karadjov"');
    }
    // the copyright holder is spelled correctly where attribution lives
    const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    assert.ok(/Zahary Shinikchiev/.test(license), 'LICENSE must credit Zahary Shinikchiev');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.ok(/Zahary Shinikchiev/.test(pkg.author), 'package.json author must be Zahary Shinikchiev');
});

// --- ASCII-only source in LogLogN.js (this family needs NO exception) --------

test('LogLogN.js is ASCII-only (this family spells out x / mu; no Unicode exception used)', () => {
    const src = readFileSync(join(ROOT, 'LogLogN.js'), 'utf8');
    let bad = 0;
    for (let i = 0; i < src.length; i++) {
        const c = src.charCodeAt(i);
        // U+00D7 and U+00B5 are the ONLY suite-permitted exceptions, but
        // lite-loglogn needs neither -- so any byte > 0x7f is a defect here.
        if (c > 0x7f) {
            bad++;
        }
    }
    assert.equal(bad, 0, 'LogLogN.js contains ' + bad + ' non-ASCII code unit(s)');
});

// --- gate flag pins in package.json scripts --------------------------------
// Returns null when the scripts pin holds, else a failure string. Tokens are
// whitespace-split, so `--max-semi-space-size=40` or a two-token
// `--max-semi-space-size 4` do not satisfy the pin.

const SEMI_FLAG = /semi[-_]space|young[-_]generation/;

function scriptsPinErr(scripts) {
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
        return 'scripts is not a plain object';
    }
    const perf = Object.hasOwn(scripts, 'test:perf') ? scripts['test:perf'] : undefined;
    if (typeof perf !== 'string') return 'scripts["test:perf"] missing';
    const pt = perf.split(/\s+/);
    if (!pt.includes('--expose-gc')) return 'test:perf lacks --expose-gc';
    const pSemi = pt.filter((t) => SEMI_FLAG.test(t));
    if (pSemi.length !== 1 || pSemi[0] !== '--max-semi-space-size=4') {
        return 'test:perf semi-space flags ' + JSON.stringify(pSemi) + ', need exactly ["--max-semi-space-size=4"]';
    }
    const tor = Object.hasOwn(scripts, 'torture') ? scripts.torture : undefined;
    if (typeof tor !== 'string') return 'scripts.torture missing';
    const tt = tor.split(/\s+/);
    if (!tt.includes('--expose-gc')) return 'torture lacks --expose-gc';
    const tSemi = tt.filter((t) => SEMI_FLAG.test(t));
    if (tSemi.length !== 0) return 'torture carries semi-space flag(s) ' + JSON.stringify(tSemi);
    return null;
}

test('package.json scripts pin the gate flags (test:perf --max-semi-space-size=4, torture --expose-gc)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(scriptsPinErr(pkg.scripts), null);
});

test('control: the scripts pin check fails on every bad scripts object', () => {
    const PERF = 'node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs';
    const TOR = 'node --expose-gc test/torture.mjs';
    assert.equal(scriptsPinErr({ 'test:perf': PERF, torture: TOR }), null, 'good scripts must pass');
    const bad = [
        null,
        [],
        { torture: TOR },
        { 'test:perf': 'node --expose-gc --test test/perf/PerfGate.test.mjs', torture: TOR },
        { 'test:perf': 'node --expose-gc --max-semi-space-size=8 --test x', torture: TOR },
        { 'test:perf': 'node --expose-gc --max-semi-space-size=40 --test x', torture: TOR },
        { 'test:perf': 'node --expose-gc --max-semi-space-size 4 --test x', torture: TOR },
        { 'test:perf': 'node --max-semi-space-size=4 --test x', torture: TOR },
        { 'test:perf': PERF + ' --min-semi-space-size=1', torture: TOR },
        { 'test:perf': PERF },
        { 'test:perf': PERF, torture: 'node test/torture.mjs' },
        { 'test:perf': PERF, torture: 'node --expose-gc --max-semi-space-size=4 test/torture.mjs' },
        Object.create({ 'test:perf': PERF, torture: TOR }),
    ];
    for (let i = 0; i < bad.length; i++) {
        assert.notEqual(scriptsPinErr(bad[i]), null, 'bad scripts[' + i + '] passed the pin');
    }
});

// --- member coercion / boundary blocks land below (one per member) ----------

// --- StratifiedBitset coercion / boundary block (A6) ------------------------
// Guards, constructor and add / delete / has cannot loop: in-process. The
// bit-0 / bit-31 block calls min / max / successor / predecessor on valid keys,
// so it runs in a Worker (test/_worker-run.mjs, kill timer 100000 ms).

const T = { timeout: 120000 };
const LITE = /^\[lite-loglogn\] /;

const BIT_EDGES = startFn(function bitEdges({ StratifiedBitset, assert }) {
    // bit 0 and bit 31 of a word, at level 0 and (via 992 / 1023 / 1024) above
    for (const U of [32, 33, 1025, 2 ** 24]) {
        const singles = [0, 31, 32, 63, 992, 1023, 1024, U - 1].filter((k) => k < U);
        for (const k of singles) {
            const s = new StratifiedBitset(U);
            s.add(k);
            const tag = 'U=' + U + ' {' + k + '} ';
            assert.equal(s.min(), k, tag + 'min');
            assert.equal(s.max(), k, tag + 'max');
            if (k > 0) assert.equal(s.successor(k - 1), k, tag + 'successor(k-1)');
            if (k > 0) assert.equal(s.successor(0), k, tag + 'successor(0)');
            if (k + 1 < U) assert.equal(s.predecessor(k + 1), k, tag + 'predecessor(k+1)');
            if (k + 1 < U) assert.equal(s.predecessor(U - 1), k, tag + 'predecessor(U-1)');
            assert.equal(s.successor(k), undefined, tag + 'successor(k)');
            assert.equal(s.predecessor(k), undefined, tag + 'predecessor(k)');
        }
        // both ends of one word: bit 0 and bit 31 together
        const s = new StratifiedBitset(U);
        s.add(0).add(31);
        assert.equal(s.min(), 0);
        assert.equal(s.max(), 31);
        assert.equal(s.successor(0), 31);
        assert.equal(s.predecessor(31), 0);
        if (U > 32) {
            s.add(32);
            assert.equal(s.successor(31), 32, 'U=' + U + ' bit 31 -> next word bit 0');
            assert.equal(s.predecessor(32), 31, 'U=' + U + ' next word bit 0 -> bit 31');
            assert.equal(s.max(), 32);
        }
    }
}, 'bitEdges');

const BAD_KEYS = (U) => [Symbol('k'), 1n, { valueOf() { return 1; } }, new Number(1), NaN, null,
    undefined, '1', -1, 1.5, U, 2 ** 32];

test('A6 bad keys: has / delete false, succ / pred undefined, add throws; no state change', T, () => {
    for (const U of [1, 32, 33, 1025]) {
        const s = new StratifiedBitset(U);
        s.add(0).add(U - 1);
        const before = s.dump();
        const keys = BAD_KEYS(U);
        for (let j = 0; j < keys.length; j++) {
            const k = keys[j];
            const tag = 'U=' + U + ' bad[' + j + '] (' + typeof k + ')';
            assert.equal(s.has(k), false, tag + ' has');
            assert.equal(s.delete(k), false, tag + ' delete');
            assert.equal(s.successor(k), undefined, tag + ' successor');
            assert.equal(s.predecessor(k), undefined, tag + ' predecessor');
            assert.throws(() => s.add(k), (e) => e instanceof RangeError && LITE.test(e.message), tag + ' add');
        }
        assert.deepEqual(s.dump(), before, 'U=' + U + ' bad keys changed state');
    }
});

test('A6 add({toString() { throw }}) throws the RangeError, never the user error', T, () => {
    const s = new StratifiedBitset(64);
    const evil = { toString() { throw new Error('x'); }, valueOf() { throw new Error('x'); } };
    assert.throws(() => s.add(evil), (e) => e instanceof RangeError && LITE.test(e.message));
    assert.equal(s.has(evil), false);
    assert.equal(s.delete(evil), false);
    assert.equal(s.size, 0);
});

test('A6 -0 as a key aliases 0 (uint32 coercion), not a distinct or rejected key', T, () => {
    const s = new StratifiedBitset(8);
    assert.equal(s.has(-0), false);
    s.add(-0);
    assert.equal(s.size, 1);
    assert.equal(s.has(0), true);   // -0 filled the same bit as 0
    assert.equal(s.has(-0), true);
    s.add(0);
    assert.equal(s.size, 1);        // 0 is the same key
    assert.equal(s.delete(-0), true);
    assert.equal(s.has(0), false);
    assert.equal(s.size, 0);
});

test('A6 constructor rejects 0, -1, 1.5, 2^32+1, NaN, \'16\', 16n, null with a RangeError', T, () => {
    for (const u of [0, -1, 1.5, 2 ** 32 + 1, NaN, '16', 16n, null, undefined, Infinity, new Number(16)]) {
        assert.throws(() => new StratifiedBitset(u), (e) => e instanceof RangeError && LITE.test(e.message),
            'universe ' + (typeof u === 'bigint' ? '16n' : String(u)));
    }
    assert.equal(new StratifiedBitset(1).universe, 1);
    assert.equal(new StratifiedBitset(2 ** 20).universe, 2 ** 20);
});

test('A6 bit 0 and bit 31 of a word are correct for min, max, successor, predecessor', T, async () => {
    await expectFn(BIT_EDGES);
});
