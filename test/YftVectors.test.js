/**
 * @zakkster/lite-loglogn -- YFastTrie VECTORS gate, ORACLE side (0.4.0 G1-B0,
 * PLAN-yfasttrie A1 / C-3 / C-9, DETERMINISTIC).
 *
 * - test/vectors/yft-b0.json regenerates byte for byte from
 *   test/helpers/yftStream.mjs (YModel = the C-3 policy on plain JS arrays): the
 *   15 xft-b0 (U, C) streams + 9 named forcing streams, checkpoints every 1000 ops
 *   (resultsHash, sortedHash, layoutHash, splits / merges / borrows, size-band
 *   histogram). The replay here runs SortedOracle lockstep + the invariant checker
 *   after EVERY op, and must report no fault.
 * - YModel answers the 15 xft-b0.json rows exactly (resultsHash / sortedHash / size
 *   at every checkpoint), so a YFastTrie can later be held to the same rows.
 * - Not vacuous: >= 1 split AND >= 1 merge on each forcing stream that can split;
 *   >= 1 borrow on borrow-w4. FINDING (reported, not loosened): C-3 cannot borrow
 *   at w = 3 (exhaustive state search below), and at (5, 5) it cannot split at all
 *   (C < K + 1), so the plan's "(5,5) and (8,8) where w = 3 borrows" is impossible.
 * - A1 count bounds per stream: splits <= floor((w+A+D)/w), merges + borrows <=
 *   floor(D/(floor(w/2)+1)) (A = adds of a new key, D = deletes of a present key).
 * - Must-fail controls: one-mutation YModel subclasses, each asserted to fail the
 *   floor / bound / layout / invariant it targets; plus one hand-broken state per
 *   invariant-checker clause.
 * - ENGINE side (U-c, G1-B2): the shipped YFastTrie replays all 24 streams and
 *   equals the cut row field for field (answers, layout from dump().reps / sizes,
 *   the `_n` counters, size bands) and the 15 xft-b0.json rows; engine mutants
 *   through data: URLs must fail (see the ENGINE section at the end).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
    YModel, checkModel, buildVectors, cutRow, allStreams, boundFailures, FORCING,
} from './helpers/yftStream.mjs';
import { formatJson, N_OPS, EVERY } from './helpers/xftStream.mjs';
import { KILL_MS } from './_worker-run.mjs';

const TEXT = readFileSync(new URL('./vectors/yft-b0.json', import.meta.url), 'utf8');
const VEC = JSON.parse(TEXT);
const XVEC = JSON.parse(readFileSync(new URL('./vectors/xft-b0.json', import.meta.url), 'utf8'));
const STRICT = { inv: 'op', oracle: true };
const FAULTS = [];
const BUILT = buildVectors(STRICT, FAULTS);
const DESCS = allStreams();
const FORCE_DESCS = DESCS.filter((d) => d.kind === 'forcing');

const NAMES = [
    'xft-b0-0', 'xft-b0-1', 'xft-b0-2', 'xft-b0-3', 'xft-b0-4', 'xft-b0-5', 'xft-b0-6', 'xft-b0-7',
    'xft-b0-8', 'xft-b0-9', 'xft-b0-10', 'xft-b0-11', 'xft-b0-12', 'xft-b0-13', 'xft-b0-14',
    'asc-fill-drain', 'desc-fill-drain', 'cluster-4w', 'sawtooth-K-h', 'w3-u5', 'w3-u8',
    'top-cluster-2^32', 'pingpong-one-boundary', 'borrow-w4',
];
const NOPS = [
    20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000,
    8192, 8192, 6872, 4532, 1752, 2904, 7424, 1872, 4264,
];
/** Forcing streams where C-3 makes a split impossible: C < K + 1 (proved below). */
const NO_SPLIT = ['w3-u5'];
/** Forcing streams whose borrow floor is gated (C-3 can borrow only from w = 4 on). */
const BORROW_FLOOR = ['borrow-w4'];

/** Floor failures of a forcing row ([] when every floor holds). */
function floorFailures(row) {
    const out = [];
    if (row.kind !== 'forcing') return out;
    if (!NO_SPLIT.includes(row.name)) {
        if (!(row.splits >= 1)) out.push('split floor');
        if (!(row.merges >= 1)) out.push('merge floor');
    }
    if (BORROW_FLOOR.includes(row.name) && !(row.borrows >= 1)) out.push('borrow floor');
    return out;
}

/** Field-level differences of a row against the cut row of the same name. */
function cutDiff(row) {
    const ref = VEC.streams.find((s) => s.name === row.name);
    const out = [];
    for (const k of Object.keys(ref)) {
        if (JSON.stringify(row[k]) !== JSON.stringify(ref[k])) out.push(k);
    }
    return out;
}

test('yft-b0.json regenerates byte for byte from the helper (YModel, strict replay)', () => {
    assert.equal(formatJson(BUILT) + '\n', TEXT);
});

test('header pins: version, stream count, names, op counts, checkpoint lengths', () => {
    assert.equal(VEC.yftStreamVersion, 1);
    assert.equal(VEC.xftStreamVersion, 1);
    assert.equal(VEC.every, 1000);
    assert.equal(EVERY, 1000);
    assert.equal(VEC.xftNOps, 20000);
    assert.equal(N_OPS, 20000);
    assert.equal(VEC.nStreams, 24);
    assert.equal(VEC.streams.length, 24);
    assert.deepEqual(VEC.streams.map((s) => s.name), NAMES);
    assert.deepEqual(VEC.streams.map((s) => s.nOps), NOPS);
    assert.equal(FORCING.length, 9);
    for (const s of VEC.streams) {
        const n = Math.floor(s.nOps / 1000);
        for (const k of ['size', 'resultsHash', 'sortedHash', 'layoutHash', 'splits', 'merges', 'borrows', 'hist']) {
            assert.equal(s.checkpoints[k].length, n, s.name + ' checkpoints.' + k);
        }
        assert.equal(s.w, 32 - Math.clz32(s.U - 1), s.name + ' w');
        assert.equal(s.K, 2 * s.w);
        assert.equal(s.h, Math.ceil(s.w / 2));
        assert.equal(s.Cr, Math.min(2 + Math.floor(s.C / s.h), s.U));
    }
    // the top cluster really ends at 4294967295 at U = 2^32
    const top = VEC.streams.find((s) => s.name === 'top-cluster-2^32');
    assert.equal(top.U, 4294967296);
    const st = DESCS.find((d) => d.name === 'top-cluster-2^32').gen();
    assert.equal(Math.max(...st.key), 4294967295);
});

test('YModel replay == the cut at every checkpoint for every stream', () => {
    assert.equal(BUILT.streams.length, VEC.streams.length);
    for (let i = 0; i < VEC.streams.length; i++) {
        const a = BUILT.streams[i];
        const b = VEC.streams[i];
        for (const k of Object.keys(b.checkpoints)) {
            assert.deepEqual(a.checkpoints[k], b.checkpoints[k], b.name + ' checkpoints.' + k);
        }
        assert.deepEqual(a, b, b.name);
    }
});

test('strict replay: SortedOracle lockstep and every invariant hold after every op', () => {
    assert.deepEqual(FAULTS, []);
});

test('YModel answers the 15 xft-b0.json rows (resultsHash / sortedHash / size at every checkpoint)', () => {
    assert.equal(XVEC.streams.length, 15);
    for (let i = 0; i < 30; i++) {
        // rows 0..14: the cut file; rows 15..29: the live replay (BUILT)
        const x = XVEC.streams[i % 15];
        const y = i < 15 ? VEC.streams[i] : BUILT.streams[i - 15];
        const tag = (i < 15 ? 'cut ' : 'replay ') + y.name + ' U=' + x.U;
        assert.equal(y.U, x.U, tag);
        assert.equal(y.C, x.C, tag);
        assert.equal(y.resultsHash, x.resultsHash, tag);
        assert.equal(y.sortedHash, x.sortedHash, tag);
        assert.equal(y.finalSize, x.finalSize, tag);
        assert.deepEqual(y.checkpoints.size, x.checkpoints.size, tag);
        assert.deepEqual(y.checkpoints.resultsHash, x.checkpoints.resultsHash, tag);
        assert.deepEqual(y.checkpoints.sortedHash, x.checkpoints.sortedHash, tag);
    }
});

test('not vacuous: split / merge floors on every forcing stream, borrow floor on borrow-w4', () => {
    const forcing = VEC.streams.filter((s) => s.kind === 'forcing');
    assert.equal(forcing.length, 9);
    for (const s of forcing) assert.deepEqual(floorFailures(s), [], s.name);
    // the one exemption is proved, not assumed: C < K + 1 means no bucket reaches K + 1
    for (const name of NO_SPLIT) {
        const s = VEC.streams.find((r) => r.name === name);
        assert.ok(s.C < s.K + 1, name + ': C ' + s.C + ' < K + 1 = ' + (s.K + 1));
        assert.equal(s.splits + s.merges + s.borrows, 0, name);
    }
    // w = 3 streams: splits and merges where C >= K + 1, and (FINDING) never a borrow
    const w3 = forcing.filter((s) => s.w === 3);
    assert.deepEqual(w3.map((s) => s.name), ['w3-u5', 'w3-u8']);
    for (const s of w3) assert.equal(s.borrows, 0, s.name + ': C-3 cannot borrow at w = 3');
});

test('FINDING: C-3 never borrows at w = 3 (exhaustive reachable-state search, U = 5..8, C = U)', () => {
    const clone = (m) => {
        const c = new YModel(m.universe, m.capacity);
        c.reps = m.reps.slice();
        c.bks = m.bks.map((b) => b.slice());
        c._size = m._size;
        return c;
    };
    const want = { 5: [32, 0, 0], 6: [64, 0, 0], 7: [279, 7, 192], 8: [759, 56, 544] };
    for (const U of [5, 6, 7, 8]) {
        const seen = new Set();
        const q = [new YModel(U, U)];
        seen.add(JSON.stringify(q[0].bks) + JSON.stringify(q[0].reps));
        let splits = 0;
        let merges = 0;
        let borrows = 0;
        while (q.length > 0) {
            const m = q.pop();
            for (let x = 0; x < U; x++) {
                for (const op of ['add', 'delete']) {
                    const c = clone(m);
                    try {
                        c[op](x);
                    } catch (e) {
                        continue;
                    }
                    assert.equal(checkModel(c, null), null, 'U=' + U);
                    splits += c.splits;
                    merges += c.merges;
                    borrows += c.borrows;
                    const k = JSON.stringify(c.bks) + JSON.stringify(c.reps);
                    if (!seen.has(k)) {
                        seen.add(k);
                        q.push(c);
                    }
                }
            }
        }
        assert.deepEqual([seen.size, splits, merges], want[U].slice(0, 3), 'U=' + U + ' states / split / merge edges');
        assert.equal(borrows, 0, 'U=' + U + ': no reachable state borrows');
    }
    // and from w = 4 on it does (the borrow-w4 forcing stream)
    assert.ok(VEC.streams.find((s) => s.name === 'borrow-w4').borrows >= 1);
});

test('A1 count bounds hold on every stream (24)', () => {
    for (const s of VEC.streams) {
        assert.deepEqual(boundFailures(s), [], s.name);
        assert.equal(s.A + s.D > 0, true, s.name);
    }
});

// --- must-fail controls: one mutation each ------------------------------------------

/** M-splitNever: never splits (split floor). */
class MSplitNever extends YModel {
    _needSplit() { return false; }
}
/** M-mergeNever: an underflow that should merge just deletes (merge floor). */
class MMergeNever extends YModel {
    _shrink(i, j) {
        if (this.bks[i - 1].length + this.bks[i].length - 1 <= this.K) this.bks[i].splice(j, 1);
        else super._shrink(i, j);
    }
}
/** M-borrowNever: an underflow that should borrow just deletes (borrow floor). */
class MBorrowNever extends YModel {
    _shrink(i, j) {
        if (this.bks[i - 1].length + this.bks[i].length - 1 > this.K) this.bks[i].splice(j, 1);
        else super._shrink(i, j);
    }
}
/** M-splitEager: splits a bucket of >= h + 1 keys at its middle (split bound). */
class MSplitEager extends YModel {
    _needSplit(s) { return s >= this.h + 1; }
    _splitRep(run) { return Math.ceil(run.length / 2); }
}
/** M-shrinkEager: every non-head delete merges or borrows (merge + borrow bound). */
class MShrinkEager extends YModel {
    _under(i) { return i > 0; }
}
/** M-splitK1: splits at s = K + 1 instead of K (layout + size invariant). */
class MSplitK1 extends YModel {
    _needSplit(s) { return s === this.K + 1; }
}
/** M-repMax: the new rep is the run's max, not run[w] (layout + size invariant). */
class MRepMax extends YModel {
    _splitRep(run) { return run.length - 1; }
}
/** M-wrongRep: a merge drops the RIGHT neighbour's rep (layout + range invariant). */
class MWrongRep extends YModel {
    _shrink(i, j) {
        const b = this.bks[i];
        const L = this.bks[i - 1];
        if (L.length + b.length - 1 <= this.K && i + 1 < this.reps.length) {
            b.splice(j, 1);
            this.bks[i - 1] = L.concat(b);
            this.bks.splice(i, 1);
            this.reps.splice(i + 1, 1);
            this.merges++;
            return;
        }
        super._shrink(i, j);
    }
}

/** Every assertion family a model fails over the forcing streams. */
function verdict(Model) {
    const fails = new Set();
    for (const d of FORCE_DESCS) {
        const { row, fault } = cutRow(d, STRICT, Model);
        for (const f of floorFailures(row)) fails.add(f);
        for (const f of boundFailures(row)) fails.add(f.slice(0, f.indexOf(':')));
        if (cutDiff(row).length > 0) fails.add('cut');
        if (fault !== null) fails.add(fault.startsWith('oracle') ? 'oracle' : 'invariant:' + fault.split(': ')[1]);
    }
    return [...fails].sort();
}

const FLOOR_BOUND = ['borrow floor', 'merge floor', 'shrink bound', 'split bound', 'split floor'];

test('control: the real YModel fails nothing over the forcing streams', () => {
    assert.deepEqual(verdict(YModel), []);
});

/**
 * [name, Model, target, the EXACT verdict over the 9 forcing streams]. A split-never
 * model has no non-head bucket, so it cannot merge or borrow either: the split floor
 * cannot fail alone. Every other floor / bound has a control failing it ALONE
 * among the floors / bounds (merge floor, borrow floor, shrink bound) or with the
 * shrink bound (split bound: every policy that splits more makes small buckets).
 */
const MUTANTS = [
    ['M-splitNever', MSplitNever, 'split floor',
        ['borrow floor', 'cut', 'invariant:headSize', 'merge floor', 'split floor']],
    ['M-mergeNever', MMergeNever, 'merge floor', ['cut', 'invariant:size', 'merge floor']],
    ['M-borrowNever', MBorrowNever, 'borrow floor', ['borrow floor', 'cut', 'invariant:size']],
    ['M-splitEager', MSplitEager, 'split bound',
        ['borrow floor', 'cut', 'invariant:size', 'shrink bound', 'split bound']],
    ['M-shrinkEager', MShrinkEager, 'shrink bound', ['cut', 'shrink bound']],
    ['M-splitK1', MSplitK1, 'invariant:headSize', ['cut', 'invariant:headSize', 'merge floor', 'split floor']],
    ['M-repMax', MRepMax, 'invariant:size', ['cut', 'invariant:size', 'shrink bound', 'split bound']],
    ['M-wrongRep', MWrongRep, 'invariant:range', ['cut', 'invariant:range']],
];

for (const [name, Model, target, exact] of MUTANTS) {
    test('control ' + name + ': fails ' + target + ' and the cut (exact verdict pinned)', () => {
        const v = verdict(Model);
        assert.ok(v.includes(target), name + ' -> ' + v.join(', '));
        assert.ok(v.includes('cut'), name + ' -> ' + v.join(', '));
        assert.deepEqual(v, exact, name);
    });
}

test('control: each invariant-checker clause rejects one hand-broken state', () => {
    const base = () => {
        const m = new YModel(1024, 64); // w 10, K 20, h 5, Cr 14
        for (let k = 0; k < 21; k++) m.add(k * 3); // one split: reps [0, 30]
        return m;
    };
    const ok = base();
    assert.deepEqual(ok.reps, [0, 30]);
    assert.equal(checkModel(ok, ok.bks.flat()), null);
    const cases = [
        ['rep0', (m) => { m.reps[0] = 1; }],
        ['lens', (m) => { m.reps.push(900); }],
        ['repsAsc', (m) => { m.reps[1] = 0; }],
        ['Cr', (m) => { m.Cr = 1; }],
        ['sorted', (m) => { const b = m.bks[1]; const t = b[0]; b[0] = b[1]; b[1] = t; }],
        ['range', (m) => { m.bks[1][0] = 29; m.bks[1].sort((p, q) => p - q); }],
        ['headSize', (m) => { m.K = m.bks[0].length - 1; }],
        ['size', (m) => { m.h = m.bks[1].length + 1; }],
        ['union', (m) => { m._size++; }],
        ['union', (m) => { const b = m.bks[1]; b[b.length - 1]++; }],
    ];
    for (const [clause, breakIt] of cases) {
        const m = base();
        const keys = m.bks.flat();
        breakIt(m);
        const r = checkModel(m, keys);
        assert.ok(r !== null && r.startsWith(clause + ':'), clause + ' -> ' + r);
    }
});

test('C-3 borrow rep literal: combined[ceil(t/2)] (U = 16)', () => {
    const m = new YModel(16, 16); // w 4, K 8, h 2
    for (const x of [5, 6, 7, 8, 9, 10, 11, 12, 13, 0, 1, 2, 3]) m.add(x);
    assert.deepEqual(m.reps, [0, 9]);
    for (const x of [13, 12, 11, 10]) m.delete(x); // t = 9 -> rep = combined[5] = 6
    assert.deepEqual(m.reps, [0, 6]);
    assert.deepEqual(m.bks, [[0, 1, 2, 3, 5], [6, 7, 8, 9]]);
    assert.equal(m.borrows, 1);
});

// --- ENGINE side (0.4.0 U-c, G1-B2, task G1-5; PLAN-yfasttrie A1 / C-3 / C-9) -------
// The shipped YFastTrie replays every yft-b0 stream with the SAME folds as the cut
// and must equal the cut row field for field, in three independent families:
//   answers -- resultsHash, finalSize, sortedHash and checkpoints.size /
//              resultsHash / sortedHash (what any correct ordered set must give);
//   layout  -- w, K, h, Cr, A, D, layoutHash (from dump().reps / sizes), splits /
//              merges / borrows (from the `_n[0..2]` counters), hist (size bands
//              of dump().sizes), at the end and at every checkpoint (C-3 policy);
//   xft     -- the 15 xft-b0 rows equal test/vectors/xft-b0.json (resultsHash,
//              sortedHash, finalSize, checkpoint size / resultsHash / sortedHash).
// HANG RULE: every replay runs in a worker_threads Worker (an inline eval worker:
// this batch adds no file) under the KILL_MS timer of test/_worker-run.mjs; a hang,
// a worker error, a nonzero exit or a missing result is a FAIL. Jobs start at
// module load, in parallel. Must-fail controls are in-memory mutants of the real
// source, each anchor replaced exactly once, loaded through a data: URL:
//   M-i32bk  -- `_bk` as Int32Array: diverges on exactly the 4 w = 32 streams;
//   M-staleQ -- add() repeats the bucket search after a split, reading the
//               inner `_q[0]` the split's inner add overwrote with the new rep;
//   M-repMax -- a split's new rep is the run's max (index K-1), not index w:
//               the layout fails on every splitting stream, the answers where
//               one-key buckets outgrow the inner capacity Cr;
//   M-repW1  -- a split's new rep at index w+1: answers right, ONLY layout fails;
//   M-mergeCount -- a merge skips its `_n[1]` increment: ONLY the merges fields
//               fail (the counter pin is not implied by layoutHash).

const ENGINE_SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const ENGINE_URL = new URL('../LogLogN.js', import.meta.url).href;
const XS_URL = new URL('./helpers/xftStream.mjs', import.meta.url).href;
const YS_URL = new URL('./helpers/yftStream.mjs', import.meta.url).href;
const W32 = ['xft-b0-12', 'xft-b0-13', 'xft-b0-14', 'top-cluster-2^32'];
const ANSWER_KEYS = ['resultsHash', 'finalSize', 'sortedHash'];
const ANSWER_CPS = ['size', 'resultsHash', 'sortedHash'];
const LAYOUT_KEYS = ['w', 'K', 'h', 'Cr', 'A', 'D', 'layoutHash', 'splits', 'merges', 'borrows', 'hist'];
const LAYOUT_CPS = ['layoutHash', 'splits', 'merges', 'borrows', 'hist'];
const M_I32BK = ['this._bk = new Uint32Array((cr + 1) * k);', 'this._bk = new Int32Array((cr + 1) * k);'];
const M_STALEQ = ['            s = bn[f];\n        }\n        const o = f * k;',
    '            s = bn[f];\n            j = this._lb(f * k, s);\n        }\n        const o = f * k;'];
const M_REPW1 = ['        const w = this._w;\n        const o = f * k;\n        const nf = t._free;',
    '        const w = this._w + 1;\n        const o = f * k;\n        const nf = t._free;'];
const M_MCOUNT = ['            this._n[1] = (this._n[1] + 1) | 0;\n', ''];
const M_REPMAX = ['        const w = this._w;\n        const o = f * k;\n        const nf = t._free;',
    '        const w = this._k - 1;\n        const o = f * k;\n        const nf = t._free;'];

/**
 * Worker body, shipped by toString(): SELF-CONTAINED (parameters and globals only).
 * Replays the named streams on mod.YFastTrie with the cut's folds; returns one row
 * per stream in the cut's row shape (no fault field).
 */
function yEngineRun(mod, xs, ys, names) {
    const { FNV_OFFSET, fnvByte, fnvWord, hex32, badKeys, keyAt, foldResult, foldThrow, applyOp,
        sortedHash, EVERY } = xs;
    // a broken build's dump() may throw its invariant Error: that row then carries a
    // marker instead of a hash (it differs from the cut), never a crashed job
    const snap = (t) => {
        try {
            return t.dump();
        } catch (e) {
            return null;
        }
    };
    const layout = (d) => {
        if (d === null) return 'dump threw';
        let h = FNV_OFFSET;
        for (let i = 0; i < d.reps.length; i++) {
            h = fnvWord(h, d.reps[i]);
            h = fnvWord(h, d.sizes[i]);
        }
        return hex32(fnvWord(fnvByte(h, 9), d.reps.length));
    };
    const hist = (t, d) => {
        if (d === null) return null;
        const w = t._w;
        const K = t._k;
        const h = t._h;
        const out = [0, 0, 0, 0, 0];
        for (const s of d.sizes) out[s === 0 ? 0 : s < h ? 1 : s <= w ? 2 : s < K ? 3 : 4]++;
        return out;
    };
    const rows = [];
    for (const d of ys.allStreams()) {
        if (!names.includes(d.name)) continue;
        const t = new mod.YFastTrie(d.U, d.C);
        const st = d.gen();
        const BAD = badKeys(d.U);
        const cps = { size: [], resultsHash: [], sortedHash: [], layoutHash: [],
            splits: [], merges: [], borrows: [], hist: [] };
        let rh = FNV_OFFSET;
        let A = 0;
        let D = 0;
        for (let i = 0; i < st.op.length; i++) {
            const n0 = t.size;
            try {
                rh = foldResult(rh, applyOp(t, st.op[i], keyAt(st, BAD, i)), t);
            } catch (e) {
                rh = foldThrow(rh, e);
            }
            if (t.size > n0) A++;
            else if (t.size < n0) D++;
            if ((i + 1) % EVERY === 0) {
                const dd = snap(t);
                cps.size.push(t.size);
                cps.resultsHash.push(hex32(rh));
                cps.sortedHash.push(sortedHash(t));
                cps.layoutHash.push(layout(dd));
                cps.splits.push(t._n[0]);
                cps.merges.push(t._n[1]);
                cps.borrows.push(t._n[2]);
                cps.hist.push(hist(t, dd));
            }
        }
        const dd = snap(t);
        rows.push({ name: d.name, kind: d.kind, U: d.U, C: d.C, w: t._w, K: t._k, h: t._h, Cr: t._x.capacity,
            seed: d.seed, nOps: st.op.length, A, D, resultsHash: hex32(fnvWord(fnvByte(rh, 9), t.size)),
            finalSize: t.size, sortedHash: sortedHash(t), layoutHash: layout(dd), splits: t._n[0],
            merges: t._n[1], borrows: t._n[2], hist: hist(t, dd), checkpoints: cps });
    }
    return rows;
}

const ENGINE_WORKER = [
    "'use strict';",
    "const { parentPort, workerData } = require('node:worker_threads');",
    'Promise.all([import(workerData.src), import(workerData.xs), import(workerData.ys)])',
    "    .then(([mod, xs, ys]) => ({ ok: true, result: (0, eval)('(' + workerData.fn + ')')(mod, xs, ys, workerData.names) }))",
    '    .catch((e) => ({ ok: false, message: e && e.stack ? String(e.stack) : String(e) }))',
    '    .then((m) => parentPort.postMessage(m));',
].join('\n');

/** Occurrences of needle in hay. */
function count(hay, needle) {
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
    return n;
}

/** data: URL of the engine source with [from, to] replaced, or null unless `from` occurs exactly once. */
function mutant([from, to]) {
    if (count(ENGINE_SRC, from) !== 1) return null;
    return 'data:text/javascript;base64,' + Buffer.from(ENGINE_SRC.replace(from, () => to), 'utf8').toString('base64');
}

/** A worker message without the base64 body of a data: URL build (stacks quote it). */
function clip(m) {
    return typeof m === 'string' ? m.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, 'data:<build>') : m;
}

/** Starts one engine replay worker; NEVER rejects: resolves { result, error }. */
function yJob(src, names, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(ENGINE_WORKER, {
            eval: true, stdout: true, stderr: true,
            workerData: { src, xs: XS_URL, ys: YS_URL, fn: yEngineRun.toString(), names },
        });
        let errText = '';
        w.stdout.resume();
        w.stderr.setEncoding('utf8');
        w.stderr.on('data', (d) => {
            if (errText.length < 4096) errText += d;
        });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result: result === null ? null : { ...result, message: clip(result.message) },
                error: error === null ? null : clip(error + (errText ? ' | stderr: ' + errText : '')) });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            result = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

async function expectRows(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');
    assert.equal(r.result.ok, true, String(r.result.message));
    assert.deepEqual(r.result.result.map((x) => x.name), NAMES, 'one row per stream, cut order');
    return r.result.result;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Names of the streams whose rows differ from the cut / xft-b0.json, per family. */
function families(rows) {
    const out = { answers: [], layout: [], xft: [] };
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const c = VEC.streams[i];
        if (ANSWER_KEYS.some((k) => !same(r[k], c[k])) ||
            ANSWER_CPS.some((k) => !same(r.checkpoints[k], c.checkpoints[k]))) out.answers.push(r.name);
        if (LAYOUT_KEYS.some((k) => !same(r[k], c[k])) ||
            LAYOUT_CPS.some((k) => !same(r.checkpoints[k], c.checkpoints[k]))) out.layout.push(r.name);
        if (i < 15) {
            const x = XVEC.streams[i];
            if (r.U !== x.U || r.C !== x.C || ANSWER_KEYS.some((k) => !same(r[k], x[k])) ||
                ANSWER_CPS.some((k) => !same(r.checkpoints[k], x.checkpoints[k]))) out.xft.push(r.name);
        }
    }
    return out;
}

const YJOB = yJob(ENGINE_URL, NAMES, 'YFastTrie');
const I32BK_SRC = mutant(M_I32BK);
const STALEQ_SRC = mutant(M_STALEQ);
const REPMAX_SRC = mutant(M_REPMAX);
const YI32 = I32BK_SRC === null ? null : yJob(I32BK_SRC, NAMES, 'M-i32bk');
const YSTALE = STALEQ_SRC === null ? null : yJob(STALEQ_SRC, NAMES, 'M-staleQ');
const YREPMAX = REPMAX_SRC === null ? null : yJob(REPMAX_SRC, NAMES, 'M-repMax');
const REPW1_SRC = mutant(M_REPW1);
const MCOUNT_SRC = mutant(M_MCOUNT);
const YREPW1 = REPW1_SRC === null ? null : yJob(REPW1_SRC, NAMES, 'M-repW1');
const YMCOUNT = MCOUNT_SRC === null ? null : yJob(MCOUNT_SRC, NAMES, 'M-mergeCount');

const ENG = { timeout: 120000 };

test('engine: YFastTrie answers == the cut on all 24 streams (results / sorted / size, every checkpoint)', ENG, async () => {
    const rows = await expectRows(YJOB);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const c = VEC.streams[i];
        for (const k of ANSWER_KEYS) assert.deepEqual(r[k], c[k], c.name + ' ' + k);
        for (const k of ANSWER_CPS) assert.deepEqual(r.checkpoints[k], c.checkpoints[k], c.name + ' checkpoints.' + k);
    }
    assert.deepEqual(families(rows).answers, []);
});

test('engine: YFastTrie layout == the cut on all 24 streams (reps / sizes / _n counters / bands, every checkpoint)', ENG, async () => {
    const rows = await expectRows(YJOB);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const c = VEC.streams[i];
        for (const k of LAYOUT_KEYS) assert.deepEqual(r[k], c[k], c.name + ' ' + k);
        for (const k of LAYOUT_CPS) assert.deepEqual(r.checkpoints[k], c.checkpoints[k], c.name + ' checkpoints.' + k);
    }
    assert.deepEqual(families(rows).layout, []);
    // the whole row, every field the cut pins
    for (let i = 0; i < rows.length; i++) assert.deepEqual(rows[i], VEC.streams[i], VEC.streams[i].name);
    // not vacuous: the engine itself splits, merges and borrows on these streams
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    assert.ok(sum('splits') > 0 && sum('merges') > 0 && sum('borrows') > 0,
        'splits ' + sum('splits') + ' merges ' + sum('merges') + ' borrows ' + sum('borrows'));
});

test('engine: YFastTrie == xft-b0.json on the 15 xft-b0 rows (results / sorted / size, every checkpoint)', ENG, async () => {
    const rows = await expectRows(YJOB);
    for (let i = 0; i < 15; i++) {
        const r = rows[i];
        const x = XVEC.streams[i];
        assert.equal(r.U, x.U, r.name);
        assert.equal(r.C, x.C, r.name);
        for (const k of ANSWER_KEYS) assert.deepEqual(r[k], x[k], r.name + ' ' + k);
        for (const k of ANSWER_CPS) assert.deepEqual(r.checkpoints[k], x.checkpoints[k], r.name + ' checkpoints.' + k);
    }
    assert.deepEqual(families(rows).xft, []);
});

test('engine control M-i32bk: `_bk` as Int32Array diverges on exactly the 4 w = 32 streams', ENG, async () => {
    assert.equal(count(ENGINE_SRC, M_I32BK[0]), 1, 'M-i32bk anchor must occur exactly once in LogLogN.js');
    assert.notEqual(YI32, null);
    const f = families(await expectRows(YI32));
    assert.deepEqual(VEC.streams.filter((s) => s.w === 32).map((s) => s.name), W32);
    assert.deepEqual(f.answers, W32);
    assert.deepEqual(f.layout, W32);
    assert.deepEqual(f.xft, W32.slice(0, 3));
});

/** Streams that split at least once in the cut (every split-based mutant changes them). */
const SPLITTERS = VEC.streams.filter((s) => s.splits > 0).map((s) => s.name);

/** Field names (checkpoints.<k> for a checkpoint column) where a row differs from the cut. */
function fieldDiff(r, c) {
    const out = [];
    for (const k of Object.keys(c)) {
        if (k !== 'checkpoints' && !same(r[k], c[k])) out.push(k);
    }
    for (const k of Object.keys(c.checkpoints)) {
        if (!same(r.checkpoints[k], c.checkpoints[k])) out.push('checkpoints.' + k);
    }
    return out;
}

test('engine control M-staleQ: a bucket search repeated after a split (stale inner _q[0]) fails every family on every splitting stream', ENG, async () => {
    assert.equal(count(ENGINE_SRC, M_STALEQ[0]), 1, 'M-staleQ anchor must occur exactly once in LogLogN.js');
    assert.notEqual(YSTALE, null);
    const f = families(await expectRows(YSTALE));
    assert.equal(SPLITTERS.length, 19);
    assert.deepEqual(f.answers, SPLITTERS);
    assert.deepEqual(f.layout, SPLITTERS);
    assert.deepEqual(f.xft, SPLITTERS.filter((n) => n.startsWith('xft-b0-')));
});

test('engine control M-repMax: a split rep at index K-1 fails the layout on every splitting stream and the answers where reps outgrow Cr', ENG, async () => {
    assert.equal(count(ENGINE_SRC, M_REPMAX[0]), 1, 'M-repMax anchor must occur exactly once in LogLogN.js');
    assert.notEqual(YREPMAX, null);
    const f = families(await expectRows(YREPMAX));
    assert.deepEqual(f.layout, SPLITTERS);
    // one-key buckets break reps <= 1 + floor(n/h): the inner trie fills and adds throw
    const ans = ['xft-b0-5', 'xft-b0-6', 'xft-b0-7', 'xft-b0-8', 'xft-b0-9', 'xft-b0-10', 'xft-b0-11',
        'xft-b0-12', 'xft-b0-13', 'xft-b0-14', 'desc-fill-drain', 'cluster-4w', 'top-cluster-2^32'];
    assert.deepEqual(f.answers, ans);
    assert.deepEqual(f.xft, ans.slice(0, 10));
});

test('engine control M-repW1: a split rep at index w+1 keeps every answer and fails ONLY the layout family', ENG, async () => {
    assert.equal(count(ENGINE_SRC, M_REPW1[0]), 1, 'M-repW1 anchor must occur exactly once in LogLogN.js');
    assert.notEqual(YREPW1, null);
    const f = families(await expectRows(YREPW1));
    assert.deepEqual(f, { answers: [], layout: SPLITTERS, xft: [] });
});

test('engine control M-mergeCount: a merge that skips its _n[1] increment fails ONLY the merges counter fields', ENG, async () => {
    assert.equal(count(ENGINE_SRC, M_MCOUNT[0]), 1, 'M-mergeCount anchor must occur exactly once in LogLogN.js');
    assert.notEqual(YMCOUNT, null);
    const rows = await expectRows(YMCOUNT);
    const f = families(rows);
    const mergers = VEC.streams.filter((s) => s.merges > 0).map((s) => s.name);
    assert.deepEqual(mergers, SPLITTERS);
    assert.deepEqual(f, { answers: [], layout: mergers, xft: [] });
    const fields = new Set();
    for (let i = 0; i < rows.length; i++) for (const k of fieldDiff(rows[i], VEC.streams[i])) fields.add(k);
    assert.deepEqual([...fields].sort(), ['checkpoints.merges', 'merges']);
});

test('engine hang rule control: an engine replay worker that never returns is terminated and FAILS', ENG, async () => {
    const spin = 'data:text/javascript;base64,' + Buffer.from('for (;;) {}\n', 'utf8').toString('base64');
    const r = await yJob(spin, NAMES, 'spin', 300);
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
    assert.equal(r.result, null);
});

test('engine control: a worker whose build throws posts ok: false (fail closed, never an empty pass)', ENG, async () => {
    const boom = 'data:text/javascript;base64,' + Buffer.from('throw new Error("boom");\n', 'utf8').toString('base64');
    const r = await yJob(boom, NAMES, 'boom');
    assert.equal(r.error, null);
    assert.equal(r.result.ok, false);
    assert.match(r.result.message, /boom/);
});
