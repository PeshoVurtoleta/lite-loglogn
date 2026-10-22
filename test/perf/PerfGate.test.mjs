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
 * Teeth: `mustFail` carries a fresh-array loop (the scavenge lane) and a
 * member-shaped GrowingBitset successor scenario -- the successor scenario's
 * own hot / statsOf over a subclass whose successor reallocates `_bits` +1
 * word -- that the counter and arrayBuffers lanes MUST flag. Never widen a
 * budget to make this pass.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
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

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios,
    mustFail: [teethMustFailAlloc, teethMustFailGrow],
});
