/**
 * @zakkster/lite-loglogn -- XFastTrie VECTORS gate (B0b E3 + B1 E1 / E9,
 * DETERMINISTIC). The oracle side is pinned first; the shipped XFastTrie then
 * replays every stream (see the B1 section below).
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
 * - B1: the shipped XFastTrie replays all 15 streams with 0 divergences and answers
 *   the boundary table, in workers under a kill timer; must-fail controls M-dir and
 *   M-i32key (in-memory mutants through a data: URL) diverge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
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

// --- B1: XFastTrie replays every stream (E1 / E9) ---------------------------------
// replay(new XFastTrie(U, C), U, genStream(U, C, N_OPS, streamSeed(i))) must equal
// VEC.streams[i] (resultsHash, checkpoints, finalSize, sortedHash) for all 15 streams,
// and XFastTrie answers every VEC.boundary state. HANG RULE (TierParity / Count
// pattern): every replay runs in a worker_threads Worker (test/_xftvec-worker.mjs)
// under a KILL_MS timer; a hang, a worker error, a nonzero exit or a missing result
// is a FAIL. All jobs start at module load, in parallel; each test awaits its own.
// Must-fail controls (in-memory mutants of the real source, each anchor replaced
// exactly once, loaded through a data: URL): M-dir (the binary-search direction bit
// inverted) diverges on every stream; M-i32key (`_key` as Int32Array) diverges on
// exactly the w = 32 streams. VEC.collide feeds E5 (B3).

const KILL_MS = 100000;
const XWORKER = new URL('./_xftvec-worker.mjs', import.meta.url);
const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const ALL = STREAMS.map((_, i) => i);
const M_DIR = ['if (((q0 >>> (w - 1 - lo)) & 1) !== 0) {', 'if (((q0 >>> (w - 1 - lo)) & 1) === 0) {'];
const M_I32KEY = ['this._key = new Uint32Array(capacity + 1);', 'this._key = new Int32Array(capacity + 1);'];

/** Occurrences of needle in hay. */
function count(hay, needle) {
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
    return n;
}

/** data: URL of SRC with [from, to] replaced, or null unless `from` occurs exactly once. */
function mutant([from, to]) {
    if (count(SRC, from) !== 1) return null;
    return 'data:text/javascript;base64,' + Buffer.from(SRC.replace(from, to), 'utf8').toString('base64');
}

/** Starts one replay worker; NEVER rejects: resolves { result, error }. */
function xftJob(src, streams, boundary, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(XWORKER, {
            workerData: { xftVecJob: true, src, streams, boundary }, stdout: true, stderr: true,
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
            resolve({ result, error: error === null ? null : error + (errText ? ' | stderr: ' + errText : '') });
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

async function expectJob(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');
    assert.equal(r.result.ok, true, String(r.result.message));
    return r.result.result;
}

/** Stream indices whose replay differs from the JSON in any field. */
function diverging(res) {
    const out = [];
    for (const r of res.streams) {
        const s = VEC.streams[r.i];
        if (r.resultsHash !== s.resultsHash || r.finalSize !== s.finalSize || r.sortedHash !== s.sortedHash ||
            JSON.stringify(r.checkpoints) !== JSON.stringify(s.checkpoints)) out.push(r.i);
    }
    return out;
}

const XJOBS = ALL.map((i) => xftJob(null, [i], null, 'stream ' + i));
const XBOUND = xftJob(null, [], VEC.boundary, 'boundary');
const DIR_SRC = mutant(M_DIR);
const I32_SRC = mutant(M_I32KEY);
const XDIR = DIR_SRC === null ? null : xftJob(DIR_SRC, ALL, null, 'M-dir');
const XI32 = I32_SRC === null ? null : xftJob(I32_SRC, ALL, null, 'M-i32key');

for (const i of ALL) {
    const [U, C] = STREAMS[i];
    test('XFastTrie replays stream ' + i + ' (U=' + U + ', C=' + C + ') with 0 divergences', OPTS, async () => {
        const res = await expectJob(XJOBS[i]);
        assert.equal(res.streams.length, 1);
        const r = res.streams[0];
        const s = VEC.streams[i];
        assert.equal(r.U, s.U);
        assert.equal(r.C, s.C);
        assert.deepEqual(r.checkpoints, s.checkpoints, 'checkpoints');
        assert.equal(r.resultsHash, s.resultsHash, 'resultsHash');
        assert.equal(r.finalSize, s.finalSize, 'finalSize');
        assert.equal(r.sortedHash, s.sortedHash, 'sortedHash');
    });
}

test('XFastTrie answers every boundary-table state (all 15 (U, C))', OPTS, async () => {
    const res = await expectJob(XBOUND);
    assert.deepEqual(res.boundary, []);
    let n = 0;
    for (const row of VEC.boundary) n += row.states.length;
    assert.equal(res.states, n);
    assert.ok(n >= 60, 'states checked: ' + n);
});

test('control M-dir: the binary-search direction bit inverted diverges on every stream', OPTS, async () => {
    assert.equal(count(SRC, M_DIR[0]), 1, 'M-dir anchor must occur exactly once in LogLogN.js');
    assert.notEqual(XDIR, null);
    const res = await expectJob(XDIR);
    assert.equal(res.streams.length, 15);
    assert.deepEqual(diverging(res), ALL);
});

test('control M-i32key: `_key` as Int32Array diverges on exactly the w = 32 streams', OPTS, async () => {
    assert.equal(count(SRC, M_I32KEY[0]), 1, 'M-i32key anchor must occur exactly once in LogLogN.js');
    assert.notEqual(XI32, null);
    const res = await expectJob(XI32);
    assert.equal(res.streams.length, 15);
    const w32 = ALL.filter((i) => bitsOf(STREAMS[i][0]) === 32);
    assert.deepEqual(w32, [12, 13, 14]);
    assert.deepEqual(diverging(res), w32);
});

test('hang rule control: a replay worker that never returns is terminated and FAILS', OPTS, async () => {
    const spin = 'data:text/javascript;base64,' + Buffer.from('for (;;) {}\n', 'utf8').toString('base64');
    const r = await xftJob(spin, [], null, 'spin', 300);
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
    assert.equal(r.result, null);
});

test('foldResult tagging: undefined is never 2^32-1, and -0 is not 0 (header resultsHash rule)', () => {
    assert.notEqual(foldResult(FNV_OFFSET, undefined), foldResult(FNV_OFFSET, 4294967295));
    assert.notEqual(foldResult(FNV_OFFSET, -0), foldResult(FNV_OFFSET, 0));
});
