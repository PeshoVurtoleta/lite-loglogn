/**
 * @zakkster/lite-loglogn -- XFastTrie pre-engine VECTORS gate (B0b E3,
 * DETERMINISTIC). XFastTrie does not exist yet: this file pins the oracle side.
 *
 * - test/vectors/xft-b0.json regenerates byte for byte from
 *   test/helpers/xftStream.mjs (15 (U, C) streams x 20,000 ops, the boundary
 *   table, the collide() keys): the vectors are a pure function of the helper.
 * - StratifiedBitset (the shipped ../LogLogN.js, behind a capacity door) agrees
 *   with SortedOracle op for op on every stream with U <= 2^28, and its replay
 *   hashes equal the JSON.
 * - Must-fail control: an oracle whose successor is >= x instead of > x
 *   produces a different resultsHash on every stream, and lockstep() reports it
 *   (the detector the cut's abort relies on has teeth).
 * - The count model (PLAN SPEC (3)) gives the planner's touch rows and R^2.
 * - collide() keys really share h1 AND h2 at level w under the default seeds,
 *   recomputed here from an independent copy of the SPEC (1) formulas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    STREAMS, N_OPS, EVERY, FULL_THROWS, SB_CROSS_MAX_U, ROW_NAMES,
    ROW_BAD, ROW_HAS, ROW_Q_PRESENT, ROW_Q_ABSENT, ROW_MINMAX, ROW_ADD_PRESENT,
    ROW_ADD_FULL, ROW_ADD_NEW, ROW_DEL_ABSENT, ROW_DEL_PRESENT,
    SortedOracle, SbCapped, genStream, streamSeed, bitsOf, isPow2, steps,
    countModel, foldResult, FNV_OFFSET, fmix32, levelGeometry, replay, lockstep, crossCheckSb, vectorsText,
} from './helpers/xftStream.mjs';

const FILE = new URL('./vectors/xft-b0.json', import.meta.url);
const TEXT = readFileSync(FILE, 'utf8');
const VEC = JSON.parse(TEXT);
const OPTS = { timeout: 120000 };

/** The planted bug: successor answers >= x (lower bound) instead of > x. */
class GeOracle extends SortedOracle {
    successor(x) {
        if (!this._ok(x)) return undefined;
        return this._a[this._lb(x)];
    }
}

test('xft-b0.json regenerates byte for byte from the helper', OPTS, () => {
    assert.equal(vectorsText(), TEXT);
    assert.equal(VEC.streams.length, 15);
    assert.equal(VEC.nOps, N_OPS);
    assert.deepEqual(VEC.streams.map((s) => [s.U, s.C]), STREAMS);
    for (const s of VEC.streams) {
        assert.equal(s.checkpoints.size.length, N_OPS / EVERY);
        assert.equal(s.checkpoints.resultsHash.length, 20);
        assert.equal(s.checkpoints.sortedHash.length, 20);
        assert.equal(s.w, bitsOf(s.U));
        assert.equal('model' in s, isPow2(s.w), 'model sums exactly for power-of-two w');
    }
});

test('every stream covers every count-model row it can reach', OPTS, () => {
    for (const s of VEC.streams) {
        const tag = 'U=' + s.U + ' C=' + s.C;
        let sum = 0;
        for (const r of ROW_NAMES) sum += s.rows[r];
        assert.equal(sum, N_OPS, tag);
        for (const r of ['bad', 'has', 'qPresent', 'qAbsent', 'minMax', 'addPresent', 'addNew',
            'delAbsent', 'delPresent']) {
            assert.ok(s.rows[r] > 0, tag + ' row ' + r);
        }
        // the 50 full-throws: a RangeError at C < U; at C === U every key is present
        if (s.C < s.U) assert.ok(s.rows.addFull >= FULL_THROWS, tag + ' addFull');
        else assert.equal(s.rows.addFull, 0, tag + ' addFull impossible at C === U');
    }
});

test('StratifiedBitset agrees with SortedOracle op for op (U <= 2^28)', OPTS, () => {
    assert.deepEqual(crossCheckSb(), []);
    let n = 0;
    for (let i = 0; i < STREAMS.length; i++) {
        const [U, C] = STREAMS[i];
        if (U > SB_CROSS_MAX_U) continue;
        const r = replay(new SbCapped(U, C), U, genStream(U, C, N_OPS, streamSeed(i)));
        const s = VEC.streams[i];
        assert.equal(r.resultsHash, s.resultsHash, 'U=' + U);
        assert.equal(r.finalSize, s.finalSize, 'U=' + U);
        assert.equal(r.sortedHash, s.sortedHash, 'U=' + U);
        assert.deepEqual(r.checkpoints, s.checkpoints, 'U=' + U);
        n++;
    }
    assert.equal(n, 12, 'twelve streams sit at U <= 2^28');
});

test('boundary table: StratifiedBitset answers every state (U <= 2^28)', OPTS, () => {
    const nz = (v) => (v === undefined ? null : v);
    let n = 0;
    for (const row of VEC.boundary) {
        if (row.U > SB_CROSS_MAX_U) continue;
        for (const s of row.states) {
            const sb = new SbCapped(row.U, row.C);
            for (const x of s.keys) sb.add(x);
            const tag = 'U=' + row.U + ' ' + s.name;
            assert.equal(nz(sb.min()), s.min, tag);
            assert.equal(nz(sb.max()), s.max, tag);
            assert.deepEqual(row.xs.map((x) => sb.has(x)), s.has, tag);
            assert.deepEqual(row.xs.map((x) => nz(sb.successor(x))), s.succ, tag);
            assert.deepEqual(row.xs.map((x) => nz(sb.predecessor(x))), s.pred, tag);
            n++;
        }
    }
    assert.ok(n >= 48, 'states checked: ' + n);
});

test('control: a >= successor oracle changes every resultsHash and lockstep sees it', OPTS, () => {
    for (let i = 0; i < STREAMS.length; i++) {
        const [U, C] = STREAMS[i];
        const st = genStream(U, C, N_OPS, streamSeed(i));
        const r = replay(new GeOracle(U, C), U, st);
        assert.notEqual(r.resultsHash, VEC.streams[i].resultsHash, 'U=' + U);
        assert.notEqual(lockstep(new SortedOracle(U, C), new GeOracle(U, C), U, st), null, 'U=' + U);
    }
});

test('count model: SPEC (3) rows, log2(w) touch line, O(w) update line, R^2', () => {
    const W = [2, 4, 8, 16, 32];
    const absent = W.map((w) => countModel(ROW_Q_ABSENT, w, 0, 0, steps(w))[0]);
    const addEmpty = W.map((w) => countModel(ROW_ADD_NEW, w, 0, 0, steps(w))[0]);
    assert.deepEqual(absent, [2, 3, 4, 5, 6]);
    assert.deepEqual(addEmpty, [4, 7, 12, 21, 38]);
    const r2 = (x, y) => {
        const n = x.length;
        const mx = x.reduce((a, b) => a + b) / n;
        const my = y.reduce((a, b) => a + b) / n;
        let sxy = 0;
        let sxx = 0;
        let syy = 0;
        for (let i = 0; i < n; i++) {
            sxy += (x[i] - mx) * (y[i] - my);
            sxx += (x[i] - mx) ** 2;
            syy += (y[i] - my) ** 2;
        }
        return (sxy * sxy / (sxx * syy)).toFixed(4);
    };
    const lg = W.map((w) => Math.log2(w));
    assert.equal(r2(lg, absent), '1.0000');
    assert.equal(r2(W, absent), '0.8710');
    assert.equal(r2(W, addEmpty), '0.9983');
    assert.equal(r2(lg, addEmpty), '0.8975');
    // fixed rows, any w
    for (const row of [ROW_BAD, ROW_MINMAX]) assert.deepEqual(countModel(row, 16, 3, 5, 4), [0, 0, 0]);
    for (const row of [ROW_HAS, ROW_Q_PRESENT, ROW_ADD_PRESENT, ROW_ADD_FULL, ROW_DEL_ABSENT]) {
        assert.deepEqual(countModel(row, 16, 3, 5, 4), [1, 0, 0]);
    }
    // add new: l = 5, m = 3 at w = 8, T = 3 -> 1+3+5 touches, 4*3+2 table writes
    assert.deepEqual(countModel(ROW_ADD_NEW, 8, 3, 5, 3), [9, 14, 5]);
    assert.deepEqual(countModel(ROW_DEL_PRESENT, 8, 5, 3, 3), [5, 5, 3]);
    // w = 1 (U = 2): zero search steps
    assert.equal(steps(1), 0);
    assert.deepEqual(countModel(ROW_ADD_NEW, 1, 0, 0, 0), [2, 4, 5]);
    assert.equal(steps(5), null, 'non-power-of-two w has no path-independent T');
});

test('SPEC (1) hash: fmix32 vector, default seeds, TS formula, collide() keys', () => {
    // independent copy of the SPEC formulas
    const mix = (h) => {
        h ^= h >>> 16;
        h = Math.imul(h, 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        return (h ^ (h >>> 16)) | 0;
    };
    assert.equal(fmix32(1) >>> 0, 0x514e28b7, 'MurmurHash3 fmix32(1)');
    assert.equal(fmix32(0), 0);
    for (let i = 0; i < 64; i++) {
        const v = Math.imul(i, 0x9e3779b9);
        assert.equal(fmix32(v), mix(v));
    }
    // TS = (w - c + 2) * 2^(c+1) for C = 2^c, c >= 2
    for (const U of [65536, 1048576, 4294967296]) {
        const w = bitsOf(U);
        for (const c of [2, 3, 8, 12, 16]) {
            assert.equal(levelGeometry(U, 2 ** c).TS, (w - c + 2) * 2 ** (c + 1), 'U=' + U + ' c=' + c);
        }
    }
    const k = VEC.collide;
    assert.equal(k.w, 16);
    assert.equal(k.B, 4, 'capL 16 -> ceil(160/72) = 3 -> B 4');
    assert.equal(k.S, 32);
    const s1 = mix(Math.imul(16, 0x9e3779b1) ^ 32);
    const s2 = mix(s1 ^ 0x85ebca6b);
    assert.equal(k.s1, s1);
    assert.equal(k.s2, s2);
    assert.equal(k.keys.length, 9, '9 keys > the 8 slots of one bucket pair');
    assert.equal(new Set(k.keys).size, 9);
    const h = (p, s) => mix(p ^ s) & (k.B - 1);
    for (const x of k.keys) {
        assert.ok(Number.isInteger(x) && x >= 0 && x < k.U);
        assert.equal(h(x, s1), h(k.keys[0], s1));
        assert.equal(h(x, s2), h(k.keys[0], s2));
    }
});

// B1 replays these streams on XFastTrie: replay(new XFastTrie(U, C), U, genStream(U, C,
// N_OPS, streamSeed(i))) must equal VEC.streams[i] (resultsHash, checkpoints, finalSize,
// sortedHash) for all 15 streams, in a worker with a kill timer (TierParity HANG RULE);
// VEC.boundary answers the boundary table per state; VEC.collide feeds E5.

test('foldResult tagging: undefined is never 2^32-1, and -0 is not 0 (header resultsHash rule)', () => {
    assert.notEqual(foldResult(FNV_OFFSET, undefined), foldResult(FNV_OFFSET, 4294967295));
    assert.notEqual(foldResult(FNV_OFFSET, -0), foldResult(FNV_OFFSET, 0));
});
