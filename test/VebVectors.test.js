/**
 * @zakkster/lite-loglogn -- vEBTree VECTORS gate (0.5.0 G1, PLAN-vebtree task 2 /
 * A2, DETERMINISTIC).
 *
 * ORACLE side (G1-B1, this file today):
 * - test/vectors/veb-g1.json regenerates BYTE FOR BYTE from
 *   test/helpers/vebStream.mjs (VebRef + SetOracle + research sketch in lockstep,
 *   invariants + flat decoder at every checkpoint -- any fault aborts the cut).
 * - VebRef (no oracle attached) replays every row and equals every checkpoint field
 *   (at, resultsHash, size, min, max, words, layoutHash).
 * - Shape: the 12 plan universes in order, the named traces, a checkpoint every
 *   EVERY ops, at every trace phase mark and after the last op, words x 4 = the
 *   C-16 / C-13 byteLength; the singles traces pin the {0} / {mid} / {U-1} /
 *   {0, U-1} layouts (non-empty checkpoints).
 * - Teeth: the row comparator reports a one-field perturbation of a checkpoint.
 *
 * ENGINE side (G1-B3, task 5): NOT HERE YET -- see the marked block at the end.
 * Regenerate: node test/helpers/vebStream.mjs --cut > test/vectors/veb-g1.json
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    allStreams, runRow, streamOf, vectorsText, UNIVERSES, EVERY, TRACE_SINGLE_U, TRACE_FULL_U,
} from './helpers/vebStream.mjs';
import { vebWordsU } from './helpers/vebRef.mjs';

const TEXT = readFileSync(new URL('./vectors/veb-g1.json', import.meta.url), 'utf8');
const VEC = JSON.parse(TEXT);
const CP_FIELDS = ['at', 'resultsHash', 'size', 'min', 'max', 'words', 'layoutHash'];
const PLAN_U = [2, 3, 256, 257, 512, 1024, 65536, 131072, 131075, 16777216, 16777217, 33554432];

/** Field-level differences of row a against the vector row b ([] when equal). */
function rowDiff(a, b) {
    const out = [];
    for (const k of ['name', 'kind', 'U', 'w', 'seed', 'nOps', 'byteLength', 'maxSize', 'drains']) {
        if (a[k] !== b[k]) out.push(k);
    }
    if (a.checkpoints.length !== b.checkpoints.length) {
        out.push('checkpoints.length');
        return out;
    }
    for (let i = 0; i < a.checkpoints.length; i++) {
        for (const f of CP_FIELDS) {
            if (a.checkpoints[i][f] !== b.checkpoints[i][f]) out.push('cp' + i + '.' + f);
        }
    }
    return out;
}

test('veb-g1.json regenerates byte for byte (all oracles on: a fault aborts the cut)', () => {
    assert.equal(vectorsText(), TEXT);
});

test('shape: 12 plan universes, named traces, checkpoint cadence, A1 byteLength', () => {
    assert.deepEqual(UNIVERSES, PLAN_U);
    assert.deepEqual(VEC.universes, PLAN_U);
    assert.equal(VEC.every, EVERY);
    const names = VEC.rows.map((r) => r.name);
    assert.deepEqual(names, allStreams().map((d) => d.name));
    for (const U of PLAN_U) assert.ok(names.includes('random-' + U), 'random-' + U);
    for (const U of TRACE_SINGLE_U) assert.ok(names.includes('singles-' + U));
    for (const U of TRACE_FULL_U) assert.ok(names.includes('full-' + U));
    for (const U of [2, 3, 256]) assert.ok(names.includes('full-' + U), 'full universe at ' + U);
    const descs = allStreams();
    for (const r of VEC.rows) {
        assert.equal(r.byteLength, vebWordsU(r.U) * 4, r.name);
        const marks = streamOf(descs.find((d) => d.name === r.name)).marks;
        if (r.kind === 'trace') assert.equal(marks.length, r.name.startsWith('singles-') ? 11 : 3, r.name + ' phase marks');
        const at = new Set(marks);
        for (let k = EVERY; k <= r.nOps; k += EVERY) at.add(k);
        at.add(r.nOps);
        const want = [...at].sort((a, b) => a - b);
        assert.deepEqual(r.checkpoints.map((c) => c.at), want, r.name);
        for (const c of r.checkpoints) {
            assert.equal(c.words * 4, r.byteLength, r.name);
            assert.match(c.layoutHash, /^[0-9a-f]{64}$/);
            assert.match(c.resultsHash, /^[0-9a-f]{8}$/);
        }
    }
    const byU = new Map(VEC.rows.filter((r) => r.kind === 'random').map((r) => [r.U, r.byteLength]));
    assert.equal(byU.get(65536), 8232);
    assert.equal(byU.get(16777216), 2105392);
    assert.equal(byU.get(16777217), 2115708);
    assert.equal(byU.get(257), 76);
    assert.equal(byU.get(2), 4);
    // singles-<U>: checkpoints hold sizes 0, 1, 0, 1, 0, 1, 0, 2, 2, 1, 1, 0 (U >= 3:
    // {0}, {mid}, {U-1} and the pair are distinct layouts) -- the layouts are pinned
    for (const r of VEC.rows.filter((x) => x.name.startsWith('singles-'))) {
        const sizes = r.checkpoints.map((c) => c.size);
        assert.deepEqual(sizes, [0, 1, 0, 1, 0, 1, 0, 2, 2, 1, 1, 0], r.name);
        const ones = r.checkpoints.filter((c) => c.size === 1);
        assert.deepEqual(ones.map((c) => c.min), [0, Math.floor(r.U / 2), r.U - 1, r.U - 1, 0], r.name);
        if (r.U >= 3) {
            assert.equal(new Set(ones.slice(0, 3).map((c) => c.layoutHash)).size, 3, r.name + ' distinct layouts');
        }
    }
});

for (const d of allStreams()) {
    test('VebRef replays every checkpoint: ' + d.name, () => {
        const { row, fault } = runRow(d, {});
        assert.equal(fault, null);
        const want = VEC.rows.find((r) => r.name === d.name);
        assert.deepEqual(rowDiff(row, want), []);
    });
}

test('teeth: rowDiff reports a one-field checkpoint perturbation', () => {
    const want = VEC.rows.find((r) => r.name === 'random-65536');
    for (const f of CP_FIELDS) {
        const bad = JSON.parse(JSON.stringify(want));
        const c = bad.checkpoints[3];
        c[f] = typeof c[f] === 'number' ? c[f] + 1 : c[f] === null ? 0 : c[f].slice(0, -1) + 'x';
        assert.deepEqual(rowDiff(bad, want), ['cp3.' + f], f);
    }
});

// =====================================================================================
// ENGINE SIDE -- TODO(G1-B3, PLAN-vebtree task 5). Reserved for the engine replay:
// import { vEBTree } from '../LogLogN.js' (B3 owns that edit; no engine import before
// it exists), replay every allStreams() descriptor on the engine with the SAME folds
// (vebStream.mjs foldResult / foldThrow / checkpoint fields), layoutHash over the
// engine's `_t` words (sha256 of the little-endian bytes, vebStream.mjs layoutHash),
// words = `_t.length`, and assert rowDiff(engineRow, VEC row) is [] for every row --
// all 12 universes + the traces (A2). Engine mutants through data: URLs must FAIL.
// =====================================================================================
