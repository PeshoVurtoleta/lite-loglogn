/**
 * @zakkster/lite-loglogn -- the HARD zero-allocation perf gate for XFastTrie
 * (@zakkster/lite-perf-gate; PLAN-xfasttrie G8, ADDENDUM A6: its own file, run by the
 * test:perf glob test/perf/*.test.mjs).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/XFastTriePerf.test.mjs
 *
 * Mirrors test/perf/PerfGate.test.mjs (StratifiedBitset). One zero-alloc
 * scenario per XFastTrie hot op -- has, add+delete, successor, predecessor,
 * min, max -- plus a successor-walk over every key at U = 2^20, and successor
 * at U = 2^32 with keys < 2^30 (Smi on Node, so the return value cannot box;
 * the w = 32 probe path is what is measured). Each is scavenge-scaled at N and
 * k*N with the old-gen and arrayBuffers lanes pinned to 0: every column lives
 * in a typed-array backing store, so the arrayBuffers lane is load-bearing, and
 * the `grows` counter (byteLength delta) must stay 0 (fixed capacity).
 *
 * Instances and query rings are built in setup (cold), never in hot. Each hot
 * keeps its integer sink in a local and writes it to an Int32Array slot once.
 * Coverage floor: setup / statsOf are wrapped (cold) to count calls, and a
 * final test asserts 8 scenarios, each measured at N and k*N.
 *
 * Teeth: `mustFail` carries a fresh-array loop (the scavenge lane), a
 * member-shaped GrowingXft successor scenario -- the successor scenario's own
 * hot / statsOf over a subclass whose successor reallocates the `_occ` level
 * column +1 byte -- that the counter and arrayBuffers lanes MUST flag, and a
 * SideBufferXft successor scenario that grows ArrayBuffer memory OFF the
 * instance's columns (identity and byteLength unchanged, so `grows` is blind):
 * its failure MUST be attributed to the arrayBuffers lane alone (own test, via
 * measure + verdict with the suite's thresholds). Never widen a budget to make
 * this pass.
 *
 * FLAG PIN: the scavenge budgets are calibrated under --max-semi-space-size=4.
 * A run whose execArgv lacks it (or that carries any other semi-space /
 * young-generation flag) is a FAILING test, never a skip; the pin check has its
 * own control.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zgcSuite, measure, verdict, formatResult } from '@zakkster/lite-perf-gate';
import { XFastTrie } from '../../LogLogN.js';

const U = 1 << 20;          // w = 20
const U32 = 4294967296;     // w = 32
const C = 32768;            // capacity: ~16,384 population + add+delete headroom
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

test('flag pin: XFastTriePerf runs under --max-semi-space-size=4 (its calibration flag)', () => {
    assert.equal(semiPinErr(process.execArgv), null,
        'run: node --expose-gc --max-semi-space-size=4 --test test/perf/XFastTriePerf.test.mjs');
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
// U = 2^20); add+delete uses odd keys only, so every add inserts and every
// delete removes and the set is byte-identical after any number of iterations.
function build(Ctor, u, ring) {
    const b = new Ctor(u, C);
    for (let i = 0; i < QN; i += 4) b.add(ring[i] & ~1);
    return { b, q: ring, sink: new Int32Array(1), cur: new Int32Array(1).fill(-1) };
}

function setupSet() { return build(XFastTrie, U, QRING); }
function setupSet32() { return build(XFastTrie, U32, QRING30); }
function grows(s) { return { grows: s.b.byteLength }; }

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
// measure() calls setup twice (N, k*N) and statsOf four times.
const RAN = [];
function tracked(name, setup, hot) {
    const rec = { name, setups: 0, stats: 0, moved: 0, minSize: Infinity };
    RAN.push(rec);
    return {
        name,
        setup() { rec.setups++; return setup(); },
        hot,
        statsOf(s) {
            // Records only numbers: no instance outlives its measurement.
            rec.stats++;
            if (s.sink[0] !== 0) rec.moved++;
            if (s.b.size < rec.minSize) rec.minSize = s.b.size;
            return grows(s);
        },
    };
}

const scenarios = [
    tracked('XFastTrie has (U=2^20)', setupSet, hasHot),
    tracked('XFastTrie add+delete (U=2^20)', setupSet, addDeleteHot),
    tracked('XFastTrie successor (U=2^20)', setupSet, successorHot),
    tracked('XFastTrie predecessor (U=2^20)', setupSet, predecessorHot),
    tracked('XFastTrie min (U=2^20)', setupSet, minHot),
    tracked('XFastTrie max (U=2^20)', setupSet, maxHot),
    tracked('XFastTrie successor-walk (U=2^20)', setupSet, walkHot),
    tracked('XFastTrie successor (U=2^32, keys < 2^30)', setupSet32, successorHot),
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
 * Teeth 2: member-shaped. The successor scenario's own setup / hot / statsOf
 * over a subclass whose successor reallocates the `_occ` level column +1 byte
 * (the extra byte is never indexed). Growth is cumulative (byteLength +1 B each
 * time), so it fires on every 4,096th call: every call would copy the whole
 * 458 KB column and make k*N = 1.6M calls quadratic. The `grows` counter and
 * the arrayBuffers lane MUST flag it.
 */
class GrowingXft extends XFastTrie {
    constructor(u, c) {
        super(u, c);
        this._calls = 0;
    }
    successor(x) {
        if ((++this._calls & 4095) === 0) {
            const old = this._occ;
            const next = new Uint8Array(old.length + 1);
            next.set(old);
            this._occ = next;
        }
        return super.successor(x);
    }
}

const teethMustFailGrow = {
    name: 'teeth: GrowingXft successor reallocates _occ (MUST grow)',
    setup() { return build(GrowingXft, U, QRING); },
    hot: successorHot,
    statsOf: grows,
};

/**
 * Teeth 3: arrayBuffers lane ALONE. A subclass whose successor, every 65,536th
 * call, allocates a fresh 1 KB Uint32Array (off-heap backing store) into a
 * preallocated 64-slot side table, never touching a column: identity and
 * byteLength are unchanged, so `grows` reads 0. k*N = 1.6M calls retain 24
 * buffers (24 KB arrayBuffers, nominal); the heap side is 24 small wrappers in
 * a slot table built in the constructor (cold), so retained and scavenges stay
 * under budget and the only lane that can see it is arrayBuffers.
 */
class SideBufferXft extends XFastTrie {
    constructor(u, c) {
        super(u, c);
        this._calls = 0;
        this._sideN = 0;
        this._side = new Array(64).fill(null);
    }
    successor(x) {
        if ((++this._calls & 65535) === 0) {
            this._side[this._sideN & 63] = new Uint32Array(256);
            this._sideN++;
        }
        return super.successor(x);
    }
}

const teethMustFailSide = {
    name: 'teeth: SideBufferXft successor grows ArrayBuffer memory off the columns (MUST fail arrayBuffers)',
    setup() { return build(SideBufferXft, U, QRING); },
    hot: successorHot,
    statsOf: grows,
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

// Registered AFTER zgcSuite: node:test runs in registration order, so this
// control (like mustFail) cannot pollute successorHot feedback the real
// scenarios were measured on.
test('teeth attribution: SideBufferXft fails ONLY on the arrayBuffers lane (grows blind)', async () => {
    const r = await measure(teethMustFailSide, { N: GATE.N, k: GATE.k });
    const v = verdict(r, {
        maxScavenges: GATE.maxScavenges,
        maxRetainedKB: GATE.maxRetainedKB,
        maxOldGen: GATE.maxOldGen,
        maxArrayBuffersKB: GATE.maxArrayBuffersKB,
        counters: GATE.counters,
    });
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'SideBufferXft passed the gate: ' + line);
    assert.ok(v.reasons.length > 0 && v.reasons.every((s) => s.startsWith('arrayBuffers: ')),
        'failure not attributed to the arrayBuffers lane alone: ' + line);
    assert.equal(r.counters_hi.grows, 0, 'grows must be blind to the side buffers: ' + line);
    assert.ok(r.arrayBuffersKB_hi > 0, 'arrayBuffers lane read no growth: ' + line);
});

test('teeth: GrowingXft is flagged by the grows counter AND the arrayBuffers lane', async () => {
    const r = await measure(teethMustFailGrow, { N: GATE.N, k: GATE.k });
    const v = verdict(r, {
        maxScavenges: GATE.maxScavenges,
        maxRetainedKB: GATE.maxRetainedKB,
        maxOldGen: GATE.maxOldGen,
        maxArrayBuffersKB: GATE.maxArrayBuffersKB,
        counters: GATE.counters,
    });
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'GrowingXft passed the gate: ' + line);
    assert.ok(r.counters_hi.grows > 0, 'grows counter blind to the reallocation: ' + line);
    assert.ok(v.reasons.some((s) => s.startsWith('arrayBuffers: ')), 'arrayBuffers lane blind: ' + line);
});

// Last: every scenario was registered, built twice and measured at N and k*N,
// and its hot body ran (the sink moved off 0).
test('coverage floor: 8 scenarios, each measured at N and k*N', () => {
    assert.equal(scenarios.length, 8, 'scenario count');
    assert.equal(RAN.length, 8, 'tracked scenario count');
    for (const rec of RAN) {
        assert.equal(rec.setups, 2, rec.name + ': setup calls');
        assert.equal(rec.stats, 4, rec.name + ': statsOf calls');
        // statsOf runs after warmup (before) and after the measured run (after):
        // the sink has moved off 0 at all 4 reads.
        assert.equal(rec.moved, 4, rec.name + ': hot body sink moved at ' + rec.moved + '/4 reads');
        assert.ok(rec.minSize > 15000 && rec.minSize <= C, rec.name + ': population ' + rec.minSize);
    }
});
