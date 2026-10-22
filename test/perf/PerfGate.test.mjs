/**
 * @zakkster/lite-loglogn -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to torture (0 B/op), not a replacement
 * (PLAN-stratifiedbitset A5). One zero-alloc scenario per StratifiedBitset hot
 * op -- has, add+delete, successor, predecessor, min, max -- plus a
 * successor-walk over every key, each scavenge-scaled at N and k*N with the
 * old-gen and arrayBuffers lanes pinned to 0: every member lives in a
 * typed-array backing store, so the arrayBuffers lane is load-bearing here,
 * and the `grows` counter (byteLength delta) must stay 0 (fixed universe, D6).
 *
 * Instances and query rings are built in setup (cold), never in hot. Each hot
 * keeps its integer sink in a local and writes it to an Int32Array slot once.
 *
 * Teeth: `mustFail` carries a fresh-array loop (the scavenge lane), a
 * member-shaped GrowingBitset successor scenario -- the successor scenario's
 * own hot / statsOf over a subclass whose successor reallocates `_bits` +1
 * word -- that the counter and arrayBuffers lanes MUST flag, and a
 * SideBufferBitset successor scenario that grows ArrayBuffer memory OFF
 * `_bits` (identity and byteLength unchanged, so `grows` is blind): its
 * failure MUST be attributed to the arrayBuffers lane alone (own test, via
 * measure + verdict with the suite's thresholds). Never widen a budget to
 * make this pass.
 *
 * FLAG PIN: the scavenge budgets are calibrated under --max-semi-space-size=4.
 * A run whose execArgv lacks it (or that carries any other semi-space / young-generation
 * flag) is a FAILING test, never a skip; the pin check has its own control.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zgcSuite, measure, verdict, formatResult } from '@zakkster/lite-perf-gate';
import { StratifiedBitset } from '../../LogLogN.js';

const U = 1 << 20;          // 4 levels, 135,300 B
const QN = 65536;           // query ring, power of two
const QMASK = QN - 1;

// Seeded xorshift32 ring masked into [0, U). Built once at module init (cold).
function keyRing(seed) {
    const k = new Uint32Array(QN);
    let s = seed | 0;
    for (let i = 0; i < QN; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        k[i] = (s >>> 0) & (U - 1);
    }
    return k;
}
const QRING = keyRing(0x9e3779b9);

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

test('flag pin: PerfGate runs under --max-semi-space-size=4 (its calibration flag)', () => {
    assert.equal(semiPinErr(process.execArgv), null,
        'run: node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs');
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

// Population = the EVEN ring keys of every 4th slot (~16,384 keys, ~1/64);
// add+delete uses odd keys only, so every add inserts and every delete removes
// and the set is byte-identical after any number of iterations.
function build(Ctor) {
    const b = new Ctor(U);
    for (let i = 0; i < QN; i += 4) b.add(QRING[i] & ~1);
    return { b, q: QRING, sink: new Int32Array(1), cur: new Int32Array(1).fill(-1) };
}

function setupSet() { return build(StratifiedBitset); }
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

const scenarios = [
    { name: 'StratifiedBitset has (U=2^20)', setup: setupSet, hot: hasHot, statsOf: grows },
    { name: 'StratifiedBitset add+delete (U=2^20)', setup: setupSet, hot: addDeleteHot, statsOf: grows },
    { name: 'StratifiedBitset successor (U=2^20)', setup: setupSet, hot: successorHot, statsOf: grows },
    { name: 'StratifiedBitset predecessor (U=2^20)', setup: setupSet, hot: predecessorHot, statsOf: grows },
    { name: 'StratifiedBitset min (U=2^20)', setup: setupSet, hot: minHot, statsOf: grows },
    { name: 'StratifiedBitset max (U=2^20)', setup: setupSet, hot: maxHot, statsOf: grows },
    { name: 'StratifiedBitset successor-walk (U=2^20)', setup: setupSet, hot: walkHot, statsOf: grows },
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
 * over a subclass whose successor reallocates `_bits` +1 word. Growth is
 * cumulative (byteLength +4 B each time), so it fires on every 4,096th call:
 * every call would copy the whole 135 KB pyramid and make k*N = 1.6M calls
 * quadratic. The `grows` counter and the arrayBuffers lane MUST flag it.
 */
class GrowingBitset extends StratifiedBitset {
    constructor(u) {
        super(u);
        this._calls = 0;
    }
    successor(x) {
        if ((++this._calls & 4095) === 0) {
            const old = this._bits;
            const next = new Uint32Array(old.length + 1);
            next.set(old);
            this._bits = next;
        }
        return super.successor(x);
    }
}

const teethMustFailGrow = {
    name: 'teeth: GrowingBitset successor reallocates _bits (MUST grow)',
    setup() { return build(GrowingBitset); },
    hot: successorHot,
    statsOf: grows,
};

/**
 * Teeth 3: arrayBuffers lane ALONE. A subclass whose successor, every 65,536th
 * call, allocates a fresh 1 KB Uint32Array (off-heap backing store) into a
 * preallocated 64-slot side table, never touching `_bits`: identity and
 * byteLength are unchanged, so `grows` reads 0. k*N = 1.6M calls retain 24
 * buffers (24 KB arrayBuffers, nominal); the heap side is 24 small wrappers in
 * a slot table built in the constructor (cold), so retained and scavenges stay
 * under budget and the only lane that can see it is arrayBuffers.
 */
class SideBufferBitset extends StratifiedBitset {
    constructor(u) {
        super(u);
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
    name: 'teeth: SideBufferBitset successor grows ArrayBuffer memory off _bits (MUST fail arrayBuffers)',
    setup() { return build(SideBufferBitset); },
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

// Pins the GATE key set: a new field forces an edit here AND a decision on
// whether it is a threshold (passed to verdict) or a non-threshold (destructured out).
test('GATE key set is the hand-written literal list', () => {
    assert.deepEqual(Object.keys(GATE).sort(),
        ['N', 'counters', 'k', 'maxArrayBuffersKB', 'maxOldGen', 'maxRetainedKB', 'maxScavenges']);
    const { N: _N, k: _k, ...thresholds } = GATE;
    assert.deepEqual(Object.keys(thresholds).sort(),
        ['counters', 'maxArrayBuffersKB', 'maxOldGen', 'maxRetainedKB', 'maxScavenges']);
});

// Registered AFTER zgcSuite: node:test runs in registration order, so this
// control (like mustFail) cannot pollute successorHot feedback the real
// scenarios were measured on.
test('teeth attribution: SideBufferBitset fails ONLY on the arrayBuffers lane (grows blind)', async () => {
    const r = await measure(teethMustFailSide, { N: GATE.N, k: GATE.k });
    const { N: _N, k: _k, ...thresholds } = GATE;
    const v = verdict(r, thresholds);
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'SideBufferBitset passed the gate: ' + line);
    assert.ok(v.reasons.length > 0 && v.reasons.every((s) => s.startsWith('arrayBuffers: ')),
        'failure not attributed to the arrayBuffers lane alone: ' + line);
    assert.equal(r.counters_hi.grows, 0, 'grows must be blind to the side buffers: ' + line);
    assert.ok(r.arrayBuffersKB_hi > 0, 'arrayBuffers lane read no growth: ' + line);
});
