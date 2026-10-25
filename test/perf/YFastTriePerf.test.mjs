/**
 * @zakkster/lite-loglogn -- the HARD zero-allocation perf gate for YFastTrie
 * (@zakkster/lite-perf-gate; PLAN-yfasttrie G2-6, its own file, run by the
 * test:perf glob test/perf/*.test.mjs).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/YFastTriePerf.test.mjs
 *
 * Mirrors test/perf/XFastTriePerf.test.mjs. One zero-alloc scenario per
 * YFastTrie hot op -- has, add+delete, successor, predecessor, min, max -- plus
 * a split / merge churn (the cold `_split` / `_shrink` run INSIDE the measured
 * window: amortized events, still 0 B), a successor-walk over every key at
 * U = 2^20, and successor at U = 2^32 with keys < 2^30 (Smi on Node, so the
 * return value cannot box; the w = 32 locate + bucket search is what is
 * measured, C-14). Each is scavenge-scaled at N and k*N with the old-gen and
 * arrayBuffers lanes pinned to 0: the pool `_bk`, `_bn`, `_n` and every inner
 * XFastTrie column live in typed-array backing stores, so the arrayBuffers lane
 * is load-bearing, and the `grows` counter (byteLength delta, inner trie
 * included) must stay 0 (fixed capacity).
 *
 * Instances and query rings are built in setup (cold), never in hot. Each hot
 * keeps its integer sink in a local and writes it to an Int32Array slot once.
 * Coverage floor: setup / statsOf are wrapped (cold) to count calls, and a
 * final test asserts 9 scenarios, each measured at N and k*N, and that the
 * churn scenario split AND merged inside BOTH measured windows (read from the
 * engine's cold `_n` counters, never from a model).
 *
 * Teeth: `mustFail` carries a fresh-array loop (the scavenge lane), a
 * member-shaped GrowingYft churn scenario -- the churn scenario's own
 * hot / statsOf over a subclass whose `_split` reallocates the `_bk` pool
 * column +1 word -- that the counter and arrayBuffers lanes MUST flag, and a
 * SideBufferYft churn scenario that grows ArrayBuffer memory OFF the
 * instance's columns (identity and byteLength unchanged, so `grows` is blind):
 * its failure MUST be attributed to the arrayBuffers lane alone. Each control
 * has its own attribution test (measure + verdict with the suite's
 * thresholds): fresh-array -> scavenges only; GrowingYft -> grows AND
 * arrayBuffers; SideBufferYft -> arrayBuffers only. GrowingYft / SideBufferYft
 * run the churn scenario's exact hot / statsOf, so the unmutated churn passing
 * is the baseline of their flip. Never widen a budget to make this pass.
 *
 * FLAG PIN: the scavenge budgets are calibrated under --max-semi-space-size=4.
 * A run whose execArgv lacks it (or that carries any other semi-space /
 * young-generation flag) is a FAILING test, never a skip; the pin check has its
 * own control.
 *
 * No timing is gated here (C-11: exact counts are the gate, timing is REPORTED).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zgcSuite, measure, verdict, formatResult } from '@zakkster/lite-perf-gate';
import { YFastTrie } from '../../LogLogN.js';

const U = 1 << 20;          // w = 20, K = 40, h = 10
const U32 = 4294967296;     // w = 32, K = 64, h = 16
const C = 32768;            // capacity: ~16,384 population + add+delete / churn headroom
const QN = 65536;           // query ring, power of two
const QMASK = QN - 1;

// Seeded xorshift32 ring masked into [0, mask]. Built once at module init (cold).
function keyRing(seed, mask) {
    const k = new Uint32Array(QN);
    let s = seed | 0;
    for (let i = 0; i < QN; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        k[i] = (s >>> 0) & mask;
    }
    return k;
}
const QRING = keyRing(0x9e3779b9, U - 1);
const QRING30 = keyRing(0x85ebca6b, 0x3fffffff);

// Returns null when the ONLY semi-space / young-generation flag in argv is exactly
// `--max-semi-space-size=4`, else a failure string (absent, another value, or
// the two-token form all fail closed).
const SEMI_PIN = '--max-semi-space-size=4';
function semiPinErr(argv) {
    if (!Array.isArray(argv)) return 'execArgv is not an array';
    let last = null;
    for (const a of argv) {
        if (typeof a === 'string' && /semi[-_]space|young[-_]generation/.test(a)) { if (last !== null) return 'more than one semi-space flag: ' + last + ', ' + a; last = a; }
    }
    if (last === null) return 'execArgv ' + JSON.stringify(argv) + ' lacks ' + SEMI_PIN;
    if (last !== SEMI_PIN) return 'last semi-space flag is ' + last + ', need ' + SEMI_PIN;
    return null;
}

test('flag pin: YFastTriePerf runs under --max-semi-space-size=4 (its calibration flag)', () => {
    assert.equal(semiPinErr(process.execArgv), null,
        'run: node --expose-gc --max-semi-space-size=4 --test test/perf/YFastTriePerf.test.mjs');
});

test('control: the flag pin fails on every bad execArgv', () => {
    assert.equal(semiPinErr(['--expose-gc', SEMI_PIN]), null, 'good argv must pass');
    const bad = [
        null,
        [],
        ['--expose-gc'],
        ['--expose-gc', '--max-semi-space-size=8'],
        ['--expose-gc', '--max-semi-space-size=40'],
        ['--expose-gc', '--max-semi-space-size', '4'],
        ['--expose-gc', SEMI_PIN, '--max-semi-space-size=16'],
        ['--expose-gc', '--min-semi-space-size=4'],
        ['--expose-gc', SEMI_PIN, '--min-semi-space-size=4'],
        ['--expose-gc', SEMI_PIN, '--semi-space-growth-factor=2'],
    ];
    for (let i = 0; i < bad.length; i++) {
        assert.notEqual(semiPinErr(bad[i]), null, 'bad argv[' + i + '] passed the pin');
    }
});

// Population = the EVEN ring keys of every 4th slot (~16,384 keys, ~1/64 of
// U = 2^20); add+delete and churn use odd keys only, so every add inserts and
// every delete removes and the KEY set is identical after any number of
// iterations (the rep set may differ: a split in add+delete is never undone,
// and the reps <= 1 + floor(n/h) bound keeps the inner trie inside Cr).
function build(Ctor, u, ring) {
    const b = new Ctor(u, C);
    for (let i = 0; i < QN; i += 4) b.add(ring[i] & ~1);
    return { b, q: ring, sink: new Int32Array(1), cur: new Int32Array(1).fill(-1), ch: new Int32Array(2) };
}

function setupSet() { return build(YFastTrie, U, QRING); }
function setupSet32() { return build(YFastTrie, U32, QRING30); }
function grows(s) { return { grows: s.b.byteLength }; }
// Churn counters: `grows` gates; `splits` / `merges` are the engine's cold `_n`
// slots, reported by formatResult and read by the coverage floor (no threshold).
function churnStats(s) { return { grows: s.b.byteLength, splits: s.b._n[0], merges: s.b._n[1] }; }

function hasHot(s, n) {
    const b = s.b;
    const q = s.q;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        if (b.has(q[i & QMASK])) acc = (acc + 1) | 0;
    }
    s.sink[0] = acc;
}

function addDeleteHot(s, n) {
    const b = s.b;
    const q = s.q;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        const x = q[i & QMASK] | 1;
        b.add(x);
        if (b.delete(x)) acc = (acc + 1) | 0;
    }
    s.sink[0] = acc;
}

// Split / merge churn. One cycle = CM adds of the odd keys base+1, base+3, ...
// of one 2*CM-wide region (CM / K new keys land in one or two buckets -> a
// split every ~w adds), then CM deletes of the same keys in the same order
// (the split-off buckets drain below h -> merge or borrow into the left
// neighbour). base = a ring key rounded down to the region width, so the
// region moves every cycle. Phase and cycle number live in Int32Array slots
// (`ch`), so the churn resumes across the warmup and measured runs.
const CM = 256;             // odd keys per cycle (region width 512)
const CW = 2 * CM;
function churnHot(s, n) {
    const b = s.b;
    const q = s.q;
    const ch = s.ch;
    let p = ch[0] | 0;
    let c = ch[1] | 0;
    let base = q[c & QMASK] & ~(CW - 1);
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        if (p < CM) {
            b.add(base + 2 * p + 1);
        } else if (b.delete(base + 2 * (p - CM) + 1)) {
            acc = (acc + 1) | 0;
        }
        if (++p === CW) {
            p = 0;
            c = (c + 1) | 0;
            base = q[c & QMASK] & ~(CW - 1);
        }
    }
    ch[0] = p;
    ch[1] = c;
    s.sink[0] = acc;
}

function successorHot(s, n) {
    const b = s.b;
    const q = s.q;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        const r = b.successor(q[i & QMASK]);
        acc = (acc + (r === undefined ? 7 : r)) | 0;
    }
    s.sink[0] = acc;
}

function predecessorHot(s, n) {
    const b = s.b;
    const q = s.q;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        const r = b.predecessor(q[i & QMASK]);
        acc = (acc + (r === undefined ? 7 : r)) | 0;
    }
    s.sink[0] = acc;
}

function minHot(s, n) {
    const b = s.b;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        const r = b.min();
        acc = (acc + (r === undefined ? 7 : r)) | 0;
    }
    s.sink[0] = acc;
}

function maxHot(s, n) {
    const b = s.b;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        const r = b.max();
        acc = (acc + (r === undefined ? 7 : r)) | 0;
    }
    s.sink[0] = acc;
}

// Walk every key along the successor chain: min() starts it, undefined past
// the last key restarts it. The cursor lives in an Int32Array slot (-1 =
// restart), so the walk resumes across the warmup and measured runs.
function walkHot(s, n) {
    const b = s.b;
    let x = s.cur[0] | 0;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        const r = x < 0 ? b.min() : b.successor(x);
        if (r === undefined) {
            x = -1;
        } else {
            x = r;
            acc = (acc + r) | 0;
        }
    }
    s.cur[0] = x;
    s.sink[0] = acc;
}

// Coverage floor (cold): every scenario's setup and statsOf calls are counted;
// measure() calls setup twice (N, k*N) and statsOf four times (before / after
// at N, then at k*N). `sp` / `mg` keep the `_n` split / merge reads per call.
const RAN = [];
function tracked(name, setup, hot, stats) {
    const rec = { name, setups: 0, stats: 0, moved: 0, minSize: Infinity,
        sp: new Int32Array(4), mg: new Int32Array(4) };
    RAN.push(rec);
    return {
        name,
        setup() { rec.setups++; return setup(); },
        hot,
        statsOf(s) {
            // Records only numbers: no instance outlives its measurement.
            if (rec.stats < 4) {
                rec.sp[rec.stats] = s.b._n[0];
                rec.mg[rec.stats] = s.b._n[1];
            }
            rec.stats++;
            if (s.sink[0] !== 0) rec.moved++;
            if (s.b.size < rec.minSize) rec.minSize = s.b.size;
            return stats(s);
        },
    };
}

const CHURN = 'YFastTrie split/merge churn (U=2^20)';
const scenarios = [
    tracked('YFastTrie has (U=2^20)', setupSet, hasHot, grows),
    tracked('YFastTrie add+delete (U=2^20)', setupSet, addDeleteHot, grows),
    tracked(CHURN, setupSet, churnHot, churnStats),
    tracked('YFastTrie successor (U=2^20)', setupSet, successorHot, grows),
    tracked('YFastTrie predecessor (U=2^20)', setupSet, predecessorHot, grows),
    tracked('YFastTrie min (U=2^20)', setupSet, minHot, grows),
    tracked('YFastTrie max (U=2^20)', setupSet, maxHot, grows),
    tracked('YFastTrie successor-walk (U=2^20)', setupSet, walkHot, grows),
    tracked('YFastTrie successor (U=2^32, keys < 2^30)', setupSet32, successorHot, grows),
];

/**
 * Teeth 1: a per-op push into a FRESH [] each op -- the array MUST trip the
 * scavenge lane. statsOf returns a constant so the failure is the allocation
 * lanes, not a missing-counter artifact.
 */
const teethMustFailAlloc = {
    name: 'teeth: fresh array per op (MUST allocate)',
    setup() { return { sink: 0 }; },
    hot(s, n) {
        let sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            const arr = []; // fresh array per op -> heap churn
            arr.push(i & 0xffff);
            sink = (sink + arr.length) | 0;
        }
        s.sink = sink | 0;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * Teeth 2: member-shaped. The churn scenario's own setup / hot / statsOf over
 * a subclass whose cold `_split` reallocates the `_bk` pool column +1 word
 * (the extra word is never indexed) before the real split runs. Growth is
 * cumulative (byteLength +4 B each time), so it fires on every 64th split:
 * every split would copy the whole ~512 KB pool tens of thousands of times at
 * k*N. The `grows` counter and the arrayBuffers lane MUST flag it.
 */
class GrowingYft extends YFastTrie {
    constructor(u, c) {
        super(u, c);
        this._calls = 0;
    }
    _split(f) {
        if ((++this._calls & 63) === 0) {
            const old = this._bk;
            const next = new Uint32Array(old.length + 1);
            next.set(old);
            this._bk = next;
        }
        return super._split(f);
    }
}

const teethMustFailGrow = {
    name: 'teeth: GrowingYft _split reallocates the _bk pool (MUST grow)',
    setup() { return build(GrowingYft, U, QRING); },
    hot: churnHot,
    statsOf: churnStats,
};

/**
 * Teeth 3: arrayBuffers lane ALONE. A subclass whose `_split`, every 1,024th
 * split, allocates a fresh 1 KB Uint32Array (off-heap backing store) into a
 * preallocated 64-slot side table, never touching a column: identity and
 * byteLength are unchanged, so `grows` reads 0. The k*N window retains a few
 * dozen buffers (measured 36 KB arrayBuffers and 33 KB retained of the 64 KB
 * budget, 3 of 3 runs; at most 64 slots); the slot table is built in the
 * constructor (cold), so retained and scavenges stay under budget and the only
 * lane that can see it is arrayBuffers.
 */
class SideBufferYft extends YFastTrie {
    constructor(u, c) {
        super(u, c);
        this._calls = 0;
        this._sideN = 0;
        this._side = new Array(64).fill(null);
    }
    _split(f) {
        if ((++this._calls & 1023) === 0) {
            this._side[this._sideN & 63] = new Uint32Array(256);
            this._sideN++;
        }
        return super._split(f);
    }
}

const teethMustFailSide = {
    name: 'teeth: SideBufferYft _split grows ArrayBuffer memory off the columns (MUST fail arrayBuffers)',
    setup() { return build(SideBufferYft, U, QRING); },
    hot: churnHot,
    statsOf: churnStats,
};

// The suite's thresholds, shared by zgcSuite and the attribution test below.
const GATE = {
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
};

zgcSuite({
    ...GATE,
    scenarios,
    mustFail: [teethMustFailAlloc, teethMustFailGrow, teethMustFailSide],
});

// Registered AFTER zgcSuite: node:test runs in registration order, so these
// controls (like mustFail) cannot pollute churnHot feedback the real
// scenarios were measured on.
test('teeth attribution: the fresh-array loop fails ONLY on the scavenge lane', async () => {
    const r = await measure(teethMustFailAlloc, { N: GATE.N, k: GATE.k });
    const { N: _N, k: _k, ...thresholds } = GATE;
    const v = verdict(r, thresholds);
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'fresh-array loop passed the gate: ' + line);
    assert.ok(v.reasons.length > 0 && v.reasons.every((s) => s.startsWith('scavenges: ')),
        'failure not attributed to the scavenge lane alone: ' + line);
    assert.ok(r.minorHi > r.minorLo, 'scavenges did not scale from N to k*N: ' + line);
});

test('teeth attribution: SideBufferYft fails ONLY on the arrayBuffers lane (grows blind)', async () => {
    const r = await measure(teethMustFailSide, { N: GATE.N, k: GATE.k });
    const { N: _N, k: _k, ...thresholds } = GATE;
    const v = verdict(r, thresholds);
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'SideBufferYft passed the gate: ' + line);
    assert.ok(v.reasons.length > 0 && v.reasons.every((s) => s.startsWith('arrayBuffers: ')),
        'failure not attributed to the arrayBuffers lane alone: ' + line);
    assert.equal(r.counters_hi.grows, 0, 'grows must be blind to the side buffers: ' + line);
    assert.ok(r.counters_hi.splits >= 1024, 'the k*N window split too rarely to fire the side buffer: ' + line);
    assert.ok(r.arrayBuffersKB_hi > 0, 'arrayBuffers lane read no growth: ' + line);
});

test('teeth: GrowingYft is flagged by the grows counter AND the arrayBuffers lane', async () => {
    const r = await measure(teethMustFailGrow, { N: GATE.N, k: GATE.k });
    const { N: _N, k: _k, ...thresholds } = GATE;
    const v = verdict(r, thresholds);
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'GrowingYft passed the gate: ' + line);
    assert.ok(r.counters_hi.grows > 0, 'grows counter blind to the reallocation: ' + line);
    assert.ok(v.reasons.some((s) => s.startsWith('grows: ')), 'grows lane did not fail the verdict: ' + line);
    assert.ok(v.reasons.some((s) => s.startsWith('arrayBuffers: ')), 'arrayBuffers lane blind: ' + line);
});

// Last: every scenario was registered, built twice and measured at N and k*N,
// and its hot body ran (the sink moved off 0); the churn split and merged in
// both measured windows.
test('coverage floor: 9 scenarios, each measured at N and k*N; churn splits and merges in both windows', () => {
    // Pins the GATE key set: a new field forces an edit here AND a decision on
    // whether it is a threshold (passed to verdict) or a non-threshold (destructured out).
    assert.deepEqual(Object.keys(GATE).sort(),
        ['N', 'counters', 'k', 'maxArrayBuffersKB', 'maxOldGen', 'maxRetainedKB', 'maxScavenges']);
    const { N: _N, k: _k, ...thresholds } = GATE;
    assert.deepEqual(Object.keys(thresholds).sort(),
        ['counters', 'maxArrayBuffersKB', 'maxOldGen', 'maxRetainedKB', 'maxScavenges']);
    assert.equal(scenarios.length, 9, 'scenario count');
    assert.equal(RAN.length, 9, 'tracked scenario count');
    let churn = null;
    for (const rec of RAN) {
        assert.equal(rec.setups, 2, rec.name + ': setup calls');
        assert.equal(rec.stats, 4, rec.name + ': statsOf calls');
        // statsOf runs after warmup (before) and after the measured run (after):
        // the sink has moved off 0 at all 4 reads.
        assert.equal(rec.moved, 4, rec.name + ': hot body sink moved at ' + rec.moved + '/4 reads');
        assert.ok(rec.minSize > 15000 && rec.minSize <= C, rec.name + ': population ' + rec.minSize);
        if (rec.name === CHURN) churn = rec;
    }
    assert.notEqual(churn, null, 'churn scenario not tracked');
    // [0] / [1] = before / after the N window, [2] / [3] = before / after k*N.
    const line = 'splits ' + Array.from(churn.sp).join(',') + ' merges ' + Array.from(churn.mg).join(',');
    console.log('[perf] churn _n reads: ' + line);
    assert.ok(churn.sp[1] - churn.sp[0] >= 1, 'churn: no split inside the N window: ' + line);
    assert.ok(churn.sp[3] - churn.sp[2] >= 1, 'churn: no split inside the k*N window: ' + line);
    assert.ok(churn.mg[1] - churn.mg[0] >= 1, 'churn: no merge inside the N window: ' + line);
    assert.ok(churn.mg[3] - churn.mg[2] >= 1, 'churn: no merge inside the k*N window: ' + line);
});
