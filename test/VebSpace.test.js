/**
 * @zakkster/lite-loglogn -- vEBTree space tests (0.5.0 G2-B3; PLAN-vebtree
 * task 6; C-1 / C-2 / C-13 / C-14 / C-16 / C-17 / C-19; ASSERTION A4).
 *
 * The model is TEST-OWNED, written from the C-1 / C-2 / C-13 text (never
 * imported from test/helpers/vebRef.mjs, never read back from an instance):
 *   w = bits = ceil(log2 U); leaf (w <= 8): w <= 5 one word, 6 / 7 / 8 -> 2 / 4 / 8;
 *   internal: lo = (w > 24 ? 16 : 8), hi = w - lo, S(w) = 2 + S(hi) + 2^hi * S(lo);
 *   the ROOT's cluster count is trimmed to ceil(U / 2^lo); bytes = 4 * words.
 * Rows: constructed (formula == new vEBTree(U).byteLength) for U = 2^w, w = 1..28,
 * and 2^17+3, 2^24+1, 2^25+3; literal-only (never allocated) w = 29..32 and 2^31+1.
 * StratifiedBitset ratio table: ratio = vEB bytes / SB bytes, both constructed.
 * No-growth: 1e5 mixed ops in a Worker with a kill timer (a timeout = FAIL).
 * Controls (each flips in-test): untrimmed root (must mismatch ALL of the three
 * trimmed rows, never the 257 row, C-17), per-leaf summary word, GrowingVeb
 * (identity), ExtraColVeb (typed-array column set).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { vEBTree, StratifiedBitset } from '../LogLogN.js';
import { startJob } from './_veb-space-worker.mjs';

const T = { timeout: 120000 };

// --- test-owned space model (words) ------------------------------------------------

function bitsOf(U) {
    let w = 0;
    while (2 ** w < U) w++;
    return w;
}

// opts.leafExtra: words added per leaf (control: per-leaf summary word).
function S(w, leafExtra) {
    if (w <= 5) return 1 + leafExtra;
    if (w <= 8) return 2 ** (w - 5) + leafExtra;
    const lo = w > 24 ? 16 : 8;
    const hi = w - lo;
    return 2 + S(hi, leafExtra) + 2 ** hi * S(lo, leafExtra);
}

function words(U, trim = true, leafExtra = 0) {
    const w = bitsOf(U);
    if (w <= 8) return S(w, leafExtra);
    const lo = w > 24 ? 16 : 8;
    const hi = w - lo;
    const clusters = trim ? Math.ceil(U / 2 ** lo) : 2 ** hi;
    return 2 + S(hi, leafExtra) + clusters * S(lo, leafExtra);
}

const bytes = (U, trim, leafExtra) => 4 * words(U, trim, leafExtra);

const TRIMMED = [2 ** 17 + 3, 2 ** 24 + 1, 2 ** 25 + 3];

const CONSTRUCTED = [];
for (let w = 1; w <= 28; w++) CONSTRUCTED.push(2 ** w);
for (const u of TRIMMED) CONSTRUCTED.push(u);

// [U, bytes] literal-only rows (formula only).
const LITERAL = [
    [2 ** 29, 67437588],
    [2 ** 30, 134875160],
    [2 ** 31, 269750304],
    [2 ** 32, 539500592],
    [2 ** 31 + 1, 269762648],
];

// A4 / C-16 literals (constructed or formula-checked).
const PINS = [
    [2 ** 24 + 1, 2115708],
    [2 ** 16, 8232],
    [2 ** 20, 131604],
    [2 ** 24, 2105392],
    [2 ** 28, 33718804],
    [2 ** 25 + 3, 4223164],
    [257, 76],
    [2, 4],
];

test('constructed rows: formula == new vEBTree(U).byteLength (w 1..28 + 3 trimmed rows)', T, () => {
    assert.equal(CONSTRUCTED.length, 31);
    for (const U of CONSTRUCTED) {
        const v = new vEBTree(U);
        assert.equal(v.byteLength, bytes(U), 'U=' + U + ' bits=' + v.bits);
        assert.equal(v.bits, bitsOf(U), 'bits U=' + U);
    }
});

test('literal-only rows: w 29..32 and 2^31+1 (formula == literal, never allocated)', T, () => {
    for (const [U, b] of LITERAL) assert.equal(bytes(U), b, 'U=' + U);
});

test('A4 / C-16 literal pins hold on the formula and on constructed instances', T, () => {
    for (const [U, b] of PINS) {
        assert.equal(bytes(U), b, 'formula U=' + U);
        assert.equal(new vEBTree(U).byteLength, b, 'engine U=' + U);
    }
    assert.equal(new vEBTree(2 ** 24 + 1).byteLength, 2115708);
});

test('trimmed root is genuinely smaller than untrimmed on the three trimmed rows (C-13)', T, () => {
    for (const U of TRIMMED) assert.ok(bytes(U) < bytes(U, false), 'U=' + U);
});

// --- StratifiedBitset ratio table ---------------------------------------------------

test('ratio vs StratifiedBitset: w 9/10/11/12 = 1.118/1.061/1.000/0.985, w 13..28 in [0.973, 0.977]', T, () => {
    const exact = { 9: '1.118', 10: '1.061', 11: '1.000', 12: '0.985' };
    const rows = [];
    for (let w = 9; w <= 28; w++) {
        const U = 2 ** w;
        const r = new vEBTree(U).byteLength / new StratifiedBitset(U).byteLength;
        rows.push(w + ':' + r.toFixed(4));
        // w 13 (0.9774) and w 19..24 (0.9726-0.9728) rely on 3-decimal rounding to sit in [0.973, 0.977].
        if (w <= 12) assert.equal(r.toFixed(3), exact[w], 'w=' + w + ' ratio ' + r);
        else assert.ok(Number(r.toFixed(3)) >= 0.973 && Number(r.toFixed(3)) <= 0.977, 'w=' + w + ' ratio ' + r); // 3-decimal table
    }
    console.log('ratio ' + rows.join(' '));
});

// --- controls: model variants -------------------------------------------------------

test('control: untrimmed root mismatches ALL of 2^17+3, 2^24+1, 2^25+3 (never relies on 257)', T, () => {
    for (const U of TRIMMED) {
        assert.notEqual(bytes(U, false), new vEBTree(U).byteLength, 'untrimmed must mismatch U=' + U);
    }
    // 257 is NOT used as a control row: there trimmed == untrimmed (C-17).
    assert.equal(bytes(257, false), bytes(257, true));
});

test('control: per-leaf summary word variant mismatches the engine on every pin', T, () => {
    for (const [U, b] of PINS) {
        assert.notEqual(bytes(U, true, 1), b, 'U=' + U);
    }
    for (const U of [2 ** 12, 2 ** 20]) {
        assert.notEqual(bytes(U, true, 1), new vEBTree(U).byteLength, 'U=' + U);
    }
});

// --- no-growth (Worker, kill timer) --------------------------------------------------

const NOPS = 100000;
const U_NG = 2 ** 20;
const jobs = {
    real: startJob({ kind: 'real', U: U_NG, nOps: NOPS, seed: 20260511 }, 'real'),
    growing: startJob({ kind: 'growing', U: U_NG, nOps: NOPS, seed: 20260511 }, 'GrowingVeb'),
    extra: startJob({ kind: 'extra', U: U_NG, nOps: NOPS, seed: 20260511 }, 'ExtraColVeb'),
};

function verdict(r) {
    if (r.failure !== undefined) return 'worker failure: ' + r.failure;
    if (r.byteBefore !== r.byteAfter) return 'byteLength changed ' + r.byteBefore + ' -> ' + r.byteAfter;
    for (const k of ['_t', '_g', '_p']) if (!r.ident[k]) return k + ' object replaced';
    if (r.fieldsBefore !== r.fieldsAfter) return 'typed-array field set ' + r.fieldsBefore + ' -> ' + r.fieldsAfter;
    if (r.fieldsAfter !== '_g,_p,_t') return 'typed-array field set ' + r.fieldsAfter;
    return null;
}

test('no growth: 1e5 mixed ops at U = 2^20 keep byteLength and the identity of _t / _g / _p', T, async () => {
    const { result, error } = await jobs.real;
    assert.equal(error, null, String(error));
    assert.equal(verdict(result), null);
    assert.equal(result.byteBefore, 131604);
    const c = result.counts;
    assert.equal(c.add + c.del + c.query, NOPS);
    assert.ok(c.add >= 30000 && c.del >= 30000 && c.query >= 15000, JSON.stringify(c));
    assert.ok(c.hits >= 5000 && c.size > 0, 'coverage floor ' + JSON.stringify(c));
});

test('control GrowingVeb: replacing _t / _g / _p during ops is caught by identity', T, async () => {
    const { result, error } = await jobs.growing;
    assert.equal(error, null, String(error));
    const v = verdict(result);
    assert.ok(v !== null && v.startsWith('_t object replaced'), String(v));
    assert.equal(result.byteBefore, result.byteAfter, 'bytes alone would miss it');
    assert.deepEqual(result.ident, { _t: false, _g: false, _p: false }, 'all three identities must flip');
});

test('control ExtraColVeb: an extra typed column is caught by the column set', T, async () => {
    const { result, error } = await jobs.extra;
    assert.equal(error, null, String(error));
    const v = verdict(result);
    assert.ok(v !== null && v.startsWith('typed-array field set'), String(v));
});
