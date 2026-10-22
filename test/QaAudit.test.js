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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as LogLogNModule from '../LogLogN.js';
import { VERSION, StratifiedBitset, XFastTrie } from '../LogLogN.js';
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
    const conc = pt.filter((t) => /test-concurrency/.test(t));
    if (conc.length !== 1 || conc[0] !== '--test-concurrency=1') {
        return 'test:perf concurrency flags ' + JSON.stringify(conc) + ', need exactly ["--test-concurrency=1"]';
    }
    const tgt = pt.slice(pt.indexOf('--test') + 1);
    if (tgt.length !== 1 || tgt[0] !== 'test/perf/*.test.mjs') return 'test:perf must run test/perf/*.test.mjs, got ' + JSON.stringify(tgt);
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
    const PERF = 'node --expose-gc --max-semi-space-size=4 --test-concurrency=1 --test test/perf/*.test.mjs';
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
        { 'test:perf': PERF.replace('--test-concurrency=1', '--test-concurrency=2'), torture: TOR },
        { 'test:perf': PERF.replace('--test-concurrency=1 ', ''), torture: TOR },
        { 'test:perf': PERF.replace('--test-concurrency=1', '--test-concurrency 1'), torture: TOR },
        { 'test:perf': PERF + ' --test-concurrency=1', torture: TOR },
        { 'test:perf': PERF, torture: 'node test/torture.mjs' },
        { 'test:perf': PERF, torture: 'node --expose-gc --max-semi-space-size=4 test/torture.mjs' },
        Object.create({ 'test:perf': PERF, torture: TOR }),
        { 'test:perf': 'node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs', torture: TOR },
    ];
    for (let i = 0; i < bad.length; i++) {
        assert.notEqual(scriptsPinErr(bad[i]), null, 'bad scripts[' + i + '] passed the pin');
    }
});

test('test/perf holds both perf gates the test:perf glob must run', () => {
    const files = readdirSync(join(ROOT, 'test', 'perf')).filter((f) => f.endsWith('.test.mjs'));
    assert.ok(files.includes('PerfGate.test.mjs'), 'PerfGate.test.mjs missing: ' + JSON.stringify(files));
    assert.ok(files.includes('XFastTriePerf.test.mjs'), 'XFastTriePerf.test.mjs missing: ' + JSON.stringify(files));
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

// --- XFastTrie coercion / boundary block (A6, G-B5) --------------------------
// Expected outcomes are hand-written literals (spec: bad key -> has / delete
// false, successor / predecessor undefined, add RangeError, no state change).
// xftRowErr is the ONE checker; it runs on the real class and on hand-made
// fakes that must each be flagged (must-fail controls).

const XFT_BAD = (U) => [Symbol('k'), 1n, { valueOf() { return 1; } }, new Number(1), NaN, null,
    undefined, '1', -1, 1.5, U, 2 ** 32,
    { toString() { throw new Error('user'); }, valueOf() { throw new Error('user'); } }];

// Returns { rows, errs }: rows = checks made, errs = failure strings.
function xftRowErr(Cls, U, C) {
    const errs = [];
    let rows = 0;
    const s = new Cls(U, C);
    s.add(0);
    s.add(U - 1);
    const before = JSON.stringify(s.dump());
    const bytes = s.byteLength;
    const keys = XFT_BAD(U);
    for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        const tag = 'U=' + U + ' bad[' + j + '] ';
        rows++; if (s.has(k) !== false) errs.push(tag + 'has');
        rows++; if (s.delete(k) !== false) errs.push(tag + 'delete');
        rows++; if (s.successor(k) !== undefined) errs.push(tag + 'successor');
        rows++; if (s.predecessor(k) !== undefined) errs.push(tag + 'predecessor');
        rows++;
        try { s.add(k); errs.push(tag + 'add did not throw'); } catch (e) {
            if (!(e instanceof RangeError && LITE.test(e.message))) errs.push(tag + 'add threw wrong error');
        }
    }
    if (JSON.stringify(s.dump()) !== before) errs.push('U=' + U + ' dump changed');
    if (s.byteLength !== bytes) errs.push('U=' + U + ' byteLength changed');
    return { rows, errs };
}

// ctor rows: [universe, capacity-or-MISSING]; returns failure strings.
const MISSING = Symbol('missing');
function xftCtorErr(Cls, rejects, accepts) {
    const errs = [];
    for (const [u, c] of rejects) {
        try {
            if (c === MISSING) new Cls(u); else new Cls(u, c);
            errs.push('accepted bad ctor ' + String(typeof u === 'bigint' ? 'big' : typeof u === 'symbol' ? 'sym' : u) + ',' + (typeof c === 'bigint' ? 'big' : typeof c === 'symbol' ? 'sym' : String(c)));
        } catch (e) {
            if (!(e instanceof RangeError && LITE.test(e.message))) errs.push('wrong error for ' + String(u) + ',' + String(c));
        }
    }
    for (const [u, c, wu, wc, wb] of accepts) {
        const s = new Cls(u, c);
        if (s.universe !== wu) errs.push('universe ' + u + ' -> ' + s.universe);
        if (s.capacity !== wc) errs.push('capacity ' + c + ' -> ' + s.capacity);
        if (s.bits !== wb) errs.push('bits ' + u + ' -> ' + s.bits);
        if (s.size !== 0) errs.push('size not 0');
    }
    return errs;
}

// legal (U, C): U = 2 is the minimum; 33 and 1025 are non-pow2; 2^32 is w = 32.
const XFT_ROWS = [[2, 2], [33, 8], [1025, 16], [2 ** 32, 4]];

test('A6 XFastTrie bad keys: has / delete false, succ / pred undefined, add throws; no state change', T, () => {
    let rows = 0;
    for (const [U, C] of XFT_ROWS) {
        const r = xftRowErr(XFastTrie, U, C);
        assert.deepEqual(r.errs, [], 'U=' + U);
        rows += r.rows;
    }
    // 4 universes x 13 tokens x 5 methods = 260 (hand count)
    assert.equal(rows, 260);
});

test('A6 XFastTrie: a bad key leaves the instance live and valid keys still work', T, () => {
    const s = new XFastTrie(33, 8);
    s.add(0); s.add(32);
    for (const k of XFT_BAD(33)) { try { s.add(k); } catch (e) { /* expected */ } }
    assert.equal(s.size, 2);
    assert.equal(s.successor(0), 32);
    assert.equal(s.predecessor(32), 0);
    assert.equal(s.min(), 0);
    assert.equal(s.max(), 32);
});

test('A6 XFastTrie -0 aliases 0 (add(-0) -> has(0), size 1; add(0) no-op; delete(-0) true)', T, () => {
    const s = new XFastTrie(8, 4);
    assert.equal(s.has(-0), false);
    s.add(-0);
    assert.equal(s.size, 1);
    assert.equal(s.has(0), true);
    assert.equal(s.has(-0), true);
    s.add(0);
    assert.equal(s.size, 1);
    assert.equal(s.delete(-0), true);
    assert.equal(s.has(0), false);
    assert.equal(s.size, 0);
});

const XFT_REJECT = [
    [2 ** 32, 0], [2 ** 32, 2 ** 24 + 1], [33, 34], [2, 3], [33, 1.5], [33, NaN], [33, '16'], [33, 16n],
    [33, null], [33, undefined], [33, MISSING], [33, -1], [33, Infinity],
    [1, 1], [0, 1], [-1, 1], [2 ** 32 + 1, 1], [33.5, 4], [NaN, 4], ['16', 4], [16n, 4], [null, 4], [undefined, 4],
];
const XFT_ACCEPT = [
    // [U, C, universe, capacity, bits]
    [2, 1, 2, 1, 1], [2, 2, 2, 2, 1], [33, 33, 33, 33, 6], [1025, 1, 1025, 1, 11],
    [2 ** 32, 16, 2 ** 32, 16, 32], [2 ** 32, 2 ** 24, 2 ** 32, 2 ** 24, 32],
];

test('A6 XFastTrie constructor rejects bad (U, C) with a RangeError and accepts legal ones', T, () => {
    assert.equal(XFT_REJECT.length, 23);
    assert.equal(XFT_ACCEPT.length, 6);
    assert.deepEqual(xftCtorErr(XFastTrie, XFT_REJECT, XFT_ACCEPT), []);
});

// --- must-fail controls: the SAME checkers must flag each wrong answer -------

const isNaNKey = (k) => typeof k === 'number' && k !== k;
class FakeHas extends XFastTrie { has(k) { return typeof k === 'symbol' ? true : super.has(k); } }
class FakeAddNoThrow extends XFastTrie { add(k) { return isNaNKey(k) ? this : super.add(k); } }
class FakeDelete extends XFastTrie { delete(k) { return k === null ? true : super.delete(k); } }
class FakeSucc extends XFastTrie { successor(k) { return k === '1' ? 0 : super.successor(k); } }
class FakePred extends XFastTrie { predecessor(k) { return k === -1 ? 0 : super.predecessor(k); } }
class FakeUserErr extends XFastTrie {
    add(k) { if (typeof k === 'object' && k !== null && k.toString !== Object.prototype.toString) throw new Error('user'); return super.add(k); }
}
class FakeMutates extends XFastTrie {
    delete(k) { if (isNaNKey(k)) { super.delete(0); return false; } return super.delete(k); }
}
class FakeCtorLax { constructor() { this.universe = 0; this.capacity = 0; this.bits = 0; this.size = 0; } }
class FakeWrongBits extends XFastTrie { get bits() { return 0; } }
class FakeNoPrefix extends XFastTrie { add(k) { if (k === '1') throw new RangeError('bad key'); return super.add(k); } }
class FakeGrows extends XFastTrie { add(k) { if (k === '1') this._grew = 8; return super.add(k); } get byteLength() { return super.byteLength + (this._grew === 8 ? 8 : 0); } }
class FakeWrongCap extends XFastTrie { get capacity() { return 0; } }
class FakeNonEmpty extends XFastTrie { get size() { return 1; } }
class FakeCtorNoPrefix { constructor() { throw new RangeError('bad ctor'); } }

test('control: xftRowErr flags every wrong answer kind (has / add / delete / succ / pred / user error / state change)', T, () => {
    const fakes = [FakeHas, FakeAddNoThrow, FakeDelete, FakeSucc, FakePred, FakeUserErr, FakeMutates, FakeNoPrefix, FakeGrows];
    assert.equal(fakes.length, 9);
    for (const F of fakes) {
        const r = xftRowErr(F, 33, 8);
        assert.ok(r.errs.length > 0, F.name + ' was not flagged');
    }
    // FakeMutates at U = 33 changes dump: key 0 gone
    assert.ok(xftRowErr(FakeMutates, 33, 8).errs.some((e) => /dump changed/.test(e)));
    assert.ok(xftRowErr(FakeNoPrefix, 33, 8).errs.some((e) => /add threw wrong error/.test(e)));
    assert.ok(xftRowErr(FakeGrows, 33, 8).errs.some((e) => /byteLength changed/.test(e)));
});

test('control: xftCtorErr flags a ctor that accepts bad input and one that misreports universe / bits', T, () => {
    assert.ok(xftCtorErr(FakeCtorLax, XFT_REJECT, []).length > 0, 'lax ctor not flagged (reject rows)');
    assert.equal(xftCtorErr(FakeCtorLax, [], XFT_ACCEPT).length > 0, true, 'lax ctor not flagged (accept rows)');
    assert.ok(xftCtorErr(FakeWrongBits, [], [[33, 8, 33, 8, 6]]).length > 0, 'wrong bits not flagged');
    assert.deepEqual(xftCtorErr(FakeWrongCap, [], [[33, 8, 33, 8, 6]]), ['capacity 8 -> 0']);
    assert.deepEqual(xftCtorErr(FakeNonEmpty, [], [[33, 8, 33, 8, 6]]), ['size not 0']);
    assert.ok(xftCtorErr(FakeCtorNoPrefix, [[1, 1]], []).length > 0, 'unprefixed RangeError not flagged');
    // a ctor that throws a plain Error instead of RangeError is flagged
    class FakeTypeErr { constructor() { throw new TypeError('x'); } }
    assert.ok(xftCtorErr(FakeTypeErr, [[1, 1]], []).length > 0, 'wrong error class not flagged');
});
