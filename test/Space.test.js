/**
 * @zakkster/lite-loglogn -- StratifiedBitset space tests (ASSERTION A3).
 *
 * byteLength and levels equal the SPEC pins; the test's OWN formula reproduces
 * every pin (and 2^28 / 2^32, formula only, never constructed) and is
 * cross-checked on a seeded spread of U <= 2^20; after 1e5 seeded mixed ops
 * byteLength and the `_bits` object / buffer are unchanged. Control:
 * GrowingBitset reallocates `_bits` (+1 word) per successor and must FAIL the
 * same check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { StratifiedBitset } from '../LogLogN.js';
import { startFn, expectFn } from './_worker-run.mjs';

const T = { timeout: 120000 };

// mulberry32: 32-bit-exact seeded PRNG.
function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The test's own formula (independent of the implementation).
function model(U) {
    let w = Math.ceil(U / 32);
    let sum = w;
    let n = 1;
    while (w > 1) { w = Math.ceil(w / 32); sum += w; n++; }
    return { levels: n, bytes: 4 * sum };
}
function levelsClosed(U) {
    // ceil(log2(U)/5) done in exact integers: smallest L with 32^L >= U.
    let L = 0;
    let p = 1;
    while (p < U) { p *= 32; L++; }
    return Math.max(1, L);
}

const PINS = [
    [1, 1, 4], [32, 1, 4], [33, 2, 12], [1025, 3, 144], [32768, 3, 4228],
    [65536, 4, 8460], [1048576, 4, 135300], [16777216, 5, 2164804],
];
const FORMULA_ONLY = [[268435456, 6, 34636836], [4294967296, 7, 554189332]];

// --- worker bodies -------------------------------------------------------------
// HANG RULE: bodies that run successor / predecessor loops execute in a Worker
// (test/_worker-run.mjs) so a looping mutant FAILS instead of hanging. Each body
// is self-contained: COMMON (mulberry32, runOps, snap, spaceCheck, GrowingBitset)
// is prepended as source text and the result is built with new Function.

const COMMON = `
const StratifiedBitset = env.StratifiedBitset, assert = env.assert;
function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// Returns null when space is unchanged, else a failure string.
function spaceCheck(s, ref) {
    if (s.byteLength !== ref.byteLength) return 'byteLength ' + ref.byteLength + ' -> ' + s.byteLength;
    if (s._bits !== ref.bits) return '_bits object replaced';
    if (s._bits.buffer !== ref.buffer) return '_bits.buffer replaced';
    if (s._bits.byteLength !== ref.bitsBytes) return '_bits.byteLength ' + ref.bitsBytes + ' -> ' + s._bits.byteLength;
    return null;
}
function snap(s) {
    return { byteLength: s.byteLength, bits: s._bits, buffer: s._bits.buffer, bitsBytes: s._bits.byteLength };
}
class GrowingBitset extends StratifiedBitset {
    successor(x) {
        const old = this._bits;
        const n = new old.constructor(old.length + 1);
        n.set(old);
        this._bits = n;
        return super.successor(x);
    }
}
// Seeded mixed ops; independent key and op streams. Returns op-kind counts.
function runOps(s, U, seed, nOps) {
    const rk = mulberry32(seed ^ 0x9E3779B9);
    const ro = mulberry32(seed ^ 0x85EBCA6B);
    const cnt = { add: 0, del: 0, has: 0, succ: 0, pred: 0, min: 0, max: 0 };
    for (let i = 0; i < nOps; i++) {
        const k = Math.floor(rk() * U);
        const o = ro();
        if (o < 0.3) { s.add(k); cnt.add++; }
        else if (o < 0.5) { s.delete(k); cnt.del++; }
        else if (o < 0.65) { s.has(k); cnt.has++; }
        else if (o < 0.8) { s.successor(k); cnt.succ++; }
        else if (o < 0.9) { s.predecessor(k); cnt.pred++; }
        else if (o < 0.95) { s.min(); cnt.min++; }
        else { s.max(); cnt.max++; }
    }
    return cnt;
}
`;

function body(src) {
    return new Function('env', COMMON + src);
}

function opsBody(U, seed) {
    return body(`
const U = ${U}, seed = ${seed};
const s = new StratifiedBitset(U);
const ref = snap(s);
assert.equal(spaceCheck(s, ref), null, 'fresh instance self-check');
const cnt = runOps(s, U, seed, 100000);
// Coverage floor: every op kind exercised.
for (const k of Object.keys(cnt)) assert.ok(cnt[k] >= 1000, 'coverage ' + k + '=' + cnt[k]);
assert.equal(spaceCheck(s, ref), null);
`);
}

const CONTROL = body(`
const U = 65536;
const g = new GrowingBitset(U);
const ref = snap(g);
assert.equal(spaceCheck(g, ref), null, 'control passes before any query');
for (let q = 1; q <= 5; q++) {
    g.successor(0);
    assert.equal(g._bits.byteLength, ref.bitsBytes + 4 * q, 'control grew 4 B per query (q=' + q + ')');
    assert.notEqual(spaceCheck(g, ref), null, 'check must return a failure after query ' + q);
}
assert.notEqual(g._bits.buffer, ref.buffer);
// A full ops run on the control must also be caught.
const g2 = new GrowingBitset(65536);
const ref2 = snap(g2);
runOps(g2, 65536, 0xC0FFEE, 2000);
assert.notEqual(spaceCheck(g2, ref2), null);
`);

const OPS_CASES = [[65536, 0x1A2B3C4D], [1048576, 0x5E6F7A8B]];
const OPS_JOBS = OPS_CASES.map(([U, seed]) => startFn(opsBody(U, seed), 'ops U=' + U));
const CONTROL_JOB = startFn(CONTROL, 'control');

// --- tests ---------------------------------------------------------------------

test('SPEC pins: constructed byteLength and levels (U <= 2^24)', T, () => {
    for (const [U, lv, by] of PINS) {
        const s = new StratifiedBitset(U);
        assert.equal(s.levels, lv, 'levels at U=' + U);
        assert.equal(s.byteLength, by, 'byteLength at U=' + U);
    }
});

test('own formula reproduces every pin, plus 2^28 and 2^32 (formula only, never constructed)', T, () => {
    for (const [U, lv, by] of PINS.concat(FORMULA_ONLY)) {
        const m = model(U);
        assert.equal(m.levels, lv, 'formula levels at U=' + U);
        assert.equal(m.bytes, by, 'formula bytes at U=' + U);
        assert.equal(levelsClosed(U), lv, 'closed-form levels at U=' + U);
    }
});

test('formula matches constructed instances for a seeded spread of U <= 2^20', T, () => {
    const seed = 0xA3A3 >>> 0;
    console.log('Space spread seed=' + seed);
    const r = mulberry32(seed);
    const us = [];
    for (let k = 0; k <= 20; k++) {
        const p = 2 ** k;
        us.push(p, p + 1);
        if (p > 1) us.push(p - 1);
    }
    while (us.length < 200) us.push(1 + Math.floor(r() * 1048576));
    assert.ok(us.length >= 200, 'coverage floor: >= 200 universes');
    for (const U of us) {
        if (U < 1 || U > 1048576) continue;
        const s = new StratifiedBitset(U);
        const m = model(U);
        assert.equal(s.levels, m.levels, 'levels at U=' + U);
        assert.equal(s.byteLength, m.bytes, 'byteLength at U=' + U);
        assert.equal(m.levels, levelsClosed(U), 'closed form at U=' + U);
    }
});

for (let i = 0; i < OPS_CASES.length; i++) {
    const [U, seed] = OPS_CASES[i];
    test('1e5 seeded mixed ops at U=' + U + ': byteLength and _bits identity unchanged', T, async () => {
        console.log('Space ops U=' + U + ' seed=0x' + seed.toString(16));
        await expectFn(OPS_JOBS[i]);
        assert.equal(new StratifiedBitset(U).byteLength, model(U).bytes);
    });
}

test('control: GrowingBitset grows +4 B per query and the same check FAILS', T, async () => {
    await expectFn(CONTROL_JOB);
});
