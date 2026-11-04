/**
 * @zakkster/lite-loglogn -- RoaringSet VECTORS gate (0.6.0 G1-B3, PLAN-roaringset-G1
 * task 3 / A-1, SPEC C-1 / C-3 / C-6; DETERMINISTIC).
 *
 * test/vectors/roaring-g1.json was cut ONCE from the R0 draft (RoaringDraft.best.mjs
 * sha256/8 fd261191, the TRUE-definition oracle beside every op) by
 *   node test/helpers/roaringStream.mjs --cut .handoff/research/roaring/RoaringDraft.best.mjs
 * This file never reads the research folder: it replays every row of
 * test/helpers/roaringStream.mjs on LogLogN.js's RoaringSet, reading per-chunk
 * metadata at row s._mi(c) (ROW_MI), and requires:
 *   - every checkpoint equal (id, op count, sizes, Part A hash, Part B hash) and the
 *     rebuilt vector document equal to the file BYTE FOR BYTE (A-1);
 *   - byteLength = the C-3 formula (8,460 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1)
 *     + 2 maxLarge) on every row, i.e. the draft's minus its 24 B `_q`, and no `_q`;
 *   - shape: 13 scenarios x 2 seeds + the targeted rows, checkpoint cadence.
 * Must-fail controls (same file):
 *   (a) the LIVE LogLogN.js text with `const DEMOTE_SMALL = 32;` -> 33 (anchor count must
 *       be exactly 1, else FAIL), loaded through a data: URL, diverges at the named
 *       checkpoints FIRST_DIVERGENCE (the first row that moves) and DEMOTE_DIVERGENCE
 *       (the targeted demote row, at 33 keys);
 *   (b) a 1-hex tamper of an in-memory copy of the vector file fails the comparison at
 *       the tampered checkpoint, and the text comparison;
 *   (c) runOptimize tie mutants of the LIVE text (each anchor count exactly 1, data: URL):
 *       array -> runs `<` -> `<=` (the B1 review's mutant), runs -> array `<` -> `<=`, and
 *       bitmap -> runs `runs <= 2047` -> 2048, each diverging at its named checkpoint of
 *       the targeted ties row.
 * A live-vs-vector mismatch is a finding (first divergent checkpoint + op count), never
 * a re-cut from the engine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    allRows, runRow, firstDiff, vectorDoc, formatJson, ROW_MI, ROW_DIRECT, SEEDS, OPS, EVERY,
    SCEN, RSCEN, CSCEN, TARGETED, DRAFT_SHA8, ROARING_STREAM_VERSION,
} from './helpers/roaringStream.mjs';

const LIB_URL = new URL('../LogLogN.js', import.meta.url);
const lib = await import(LIB_URL.href);
const { RoaringSet } = lib;

const TEXT = readFileSync(new URL('./vectors/roaring-g1.json', import.meta.url), 'utf8');
const VEC = JSON.parse(TEXT);
const ROWS = allRows();

const FIRST_DIVERGENCE = 'R U=2^20 range+opt mix / seed 1 @ op900';
const DEMOTE_ROW = 'T demote edges (DEMOTE_SMALL 32, DEMOTE_BITMAP 2048)';
const DEMOTE_DIVERGENCE = DEMOTE_ROW + ' @ array-33';
const ANCHOR = 'const DEMOTE_SMALL = 32;';
const TIE_ROW = 'T runOptimize ties (array 2r == card, runs 2card == 4r, bitmap 2047 / 2048 runs)';
// [label, anchor, replacement, expected first divergent checkpoint id in TIE_ROW]
const TIE_MUTANTS = [
    ['array -> runs on a tie', 'if ((runs << 1) < card && runs <= 2048) {', 'if ((runs << 1) <= card && runs <= 2048) {', 'array-tie'],
    ['runs -> array on a tie', '} else if ((card << 1) < (nRuns << 2)) {', '} else if ((card << 1) <= (nRuns << 2)) {', 'runs-tie'],
    ['bitmap -> runs at 2048 runs', 'if (runs > 0 && runs <= 2047) {', 'if (runs > 0 && runs <= 2048) {', 'bitmap-2048-runs'],
];

/** C-3 byteLength (direct). */
function c3Bytes(U, maxS, maxL) {
    return 8460 + 11 * Math.ceil(U / 65536) + 130 * maxS + 8456 * (maxL + 1) + 2 * maxL;
}

/** src with anchor replaced; throws unless the anchor occurs EXACTLY once (fail closed). */
function mutate(src, anchor, repl) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) throw new Error('mutant anchor count ' + n + ' (need exactly 1): ' + JSON.stringify(anchor));
    const i = src.indexOf(anchor);
    return src.slice(0, i) + repl + src.slice(i + anchor.length);
}

function where(df) {
    return df === null ? 'equal' : (df.cp || 'row') + ' field ' + df.field + ' got ' + JSON.stringify(df.got) +
        ' want ' + JSON.stringify(df.want) + (df.n !== undefined ? ' (after op ' + df.n + ')' : '');
}

test('LogLogN.js exports RoaringSet with the row hook _mi (C-1) and no _q (C-3)', () => {
    assert.equal(typeof RoaringSet, 'function', 'RoaringSet export missing from LogLogN.js');
    const s = new RoaringSet(1 << 20, 4, 4);
    assert.equal(typeof s._mi, 'function', '_mi(c) row hook missing');
    for (const c of [0, 1, 15]) assert.equal(s._mi(c), c, '_mi is identity in G1');
    assert.equal('_q' in s, false, 'the research counter _q must be dropped');
    assert.equal(s.byteLength, c3Bytes(1 << 20, 4, 4));
});

test('shape: header, 13 scenarios x 2 seeds + targeted rows, checkpoint cadence, C-3 byteLength', () => {
    assert.equal(VEC.streamVersion, ROARING_STREAM_VERSION);
    assert.equal(VEC.cutFrom, 'RoaringDraft.best.mjs sha256/8 ' + DRAFT_SHA8);
    assert.equal(DRAFT_SHA8, 'fd261191');
    assert.deepEqual(VEC.seeds, SEEDS);
    assert.deepEqual(SEEDS, [1, 2]);
    assert.equal(VEC.ops, OPS);
    assert.equal(OPS, 1000);
    assert.equal(VEC.every, EVERY);
    assert.equal(SCEN.length + RSCEN.length + CSCEN.length, 13);
    assert.equal(VEC.rows.length, 13 * 2 + TARGETED.length);
    assert.deepEqual(VEC.rows.map((r) => r.name), ROWS.map((d) => d.name));
    let cps = 0;
    for (const r of VEC.rows) {
        assert.equal(r.byteLength, c3Bytes(r.U, r.maxS, r.maxL), r.name + ' byteLength (C-3)');
        if (r.family !== 'T') {
            const want = [];
            if (r.family === 'CSCEN') want.push('fill');
            for (let k = EVERY; k <= OPS; k += EVERY) want.push('op' + k);
            assert.deepEqual(r.checkpoints.map((c) => c.id), want, r.name + ' cadence');
        }
        assert.ok(r.checkpoints.length > 0, r.name);
        let n = -1;
        for (const c of r.checkpoints) {
            assert.match(c.a, /^[0-9a-f]{8}$/, r.name);
            assert.match(c.b, /^[0-9a-f]{8}$/, r.name);
            assert.ok(c.n >= n, r.name + ' op count non-decreasing');
            n = c.n;
        }
        assert.equal(n, r.ops, r.name + ' last checkpoint after the last op');
        cps += r.checkpoints.length;
    }
    assert.equal(cps, 321);
    const byName = new Map(VEC.rows.map((r) => [r.name, r]));
    assert.equal(byName.get('U=2^32 mix / seed 1').byteLength, 1016788);
    assert.ok(byName.get(DEMOTE_ROW).checkpoints.some((c) => c.id === 'array-33'));
    for (const [, , , id] of TIE_MUTANTS) assert.ok(byName.get(TIE_ROW).checkpoints.some((c) => c.id === id), id);
});

test('control: runRow requires an explicit row function (no typeof fallback)', () => {
    assert.throws(() => runRow(ROWS[0], RoaringSet), /rowOf must be a function/);
    assert.throws(() => runRow(ROWS[0], RoaringSet, undefined), /rowOf must be a function/);
    assert.equal(ROW_DIRECT(null, 7), 7);
});

const LIVE = new Map();

for (const d of ROWS) {
    test('A-1 live RoaringSet replays every checkpoint: ' + d.name, () => {
        const want = VEC.rows.find((r) => r.name === d.name);
        assert.ok(want !== undefined, d.name + ' missing in roaring-g1.json');
        const { row, fault } = runRow(d, RoaringSet, ROW_MI);
        assert.equal(fault, null, d.name + ': ' + fault);
        LIVE.set(d.name, row);
        const df = firstDiff(row, want);
        assert.equal(df, null, 'first divergence: ' + where(df));
    });
}

test('A-1 the live vector document equals roaring-g1.json byte for byte', () => {
    assert.equal(LIVE.size, ROWS.length, 'every row replayed');
    const text = formatJson(vectorDoc(ROWS.map((d) => LIVE.get(d.name)))) + '\n';
    assert.equal(text, TEXT);
});

test('must-fail (a): DEMOTE_SMALL 32 -> 33 data: URL mutant of the LIVE LogLogN.js diverges at the named checkpoints', async () => {
    const src = readFileSync(LIB_URL, 'utf8');
    assert.equal(src.split(ANCHOR).length - 1, 1, 'anchor ' + JSON.stringify(ANCHOR) + ' occurs exactly once');
    assert.throws(() => mutate('a b a', 'a', 'x'), /anchor count 2/);
    assert.throws(() => mutate('a b', 'c', 'x'), /anchor count 0/);
    const mut = mutate(src, ANCHOR, 'const DEMOTE_SMALL = 33;');
    const M = (await import('data:text/javascript;base64,' + Buffer.from(mut, 'utf8').toString('base64'))).RoaringSet;
    assert.equal(typeof M, 'function');
    let first = null;
    for (const d of ROWS) {
        const { row } = runRow(d, M, ROW_MI);
        const df = firstDiff(row, VEC.rows.find((r) => r.name === d.name));
        if (df !== null) { first = df; break; }
    }
    assert.notEqual(first, null, 'the DEMOTE_SMALL mutant PASSED every row');
    assert.equal(first.cp, FIRST_DIVERGENCE, where(first));
    const dd = ROWS.find((d) => d.name === DEMOTE_ROW);
    const dm = firstDiff(runRow(dd, M, ROW_MI).row, VEC.rows.find((r) => r.name === DEMOTE_ROW));
    assert.notEqual(dm, null, 'the targeted demote row did not move');
    assert.equal(dm.cp, DEMOTE_DIVERGENCE, where(dm));
});

test('must-fail (b): a 1-hex tamper of an in-memory copy of roaring-g1.json fails at the tampered checkpoint', () => {
    assert.equal(LIVE.size, ROWS.length, 'every row replayed');
    const key = '"a":"';
    const at = TEXT.indexOf(key, TEXT.indexOf(FIRST_DIVERGENCE.split(' @ ')[0])) + key.length;
    const ch = TEXT[at];
    assert.match(ch, /[0-9a-f]/);
    const bad = TEXT.slice(0, at) + (ch === '0' ? '1' : '0') + TEXT.slice(at + 1);
    assert.equal(bad.length, TEXT.length);
    let diffs = 0;
    for (let i = 0; i < TEXT.length; i++) if (bad[i] !== TEXT[i]) diffs++;
    assert.equal(diffs, 1, 'exactly one character changed');
    const BV = JSON.parse(bad);
    const name = FIRST_DIVERGENCE.split(' @ ')[0];
    const df = firstDiff(LIVE.get(name), BV.rows.find((r) => r.name === name));
    assert.notEqual(df, null, 'the tamper was not detected');
    assert.equal(df.cp, name + ' @ op100');
    assert.equal(df.field, 'a');
    const text = formatJson(vectorDoc(ROWS.map((d) => LIVE.get(d.name)))) + '\n';
    assert.notEqual(text, bad);
});

for (const [label, anchor, repl, id] of TIE_MUTANTS) {
    test('must-fail (c): runOptimize ' + label + ' (data: URL mutant of the LIVE LogLogN.js) diverges at ' + id, async () => {
        const src = readFileSync(LIB_URL, 'utf8');
        assert.equal(src.split(anchor).length - 1, 1, 'anchor ' + JSON.stringify(anchor) + ' occurs exactly once');
        const M = (await import('data:text/javascript;base64,' + Buffer.from(mutate(src, anchor, repl), 'utf8').toString('base64'))).RoaringSet;
        const d = ROWS.find((r) => r.name === TIE_ROW);
        const df = firstDiff(runRow(d, M, ROW_MI).row, VEC.rows.find((r) => r.name === TIE_ROW));
        assert.notEqual(df, null, 'the ' + label + ' mutant PASSED the ties row');
        assert.equal(df.cp, TIE_ROW + ' @ ' + id, where(df));
    });
}
