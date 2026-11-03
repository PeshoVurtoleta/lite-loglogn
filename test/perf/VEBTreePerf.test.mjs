/**
 * @zakkster/lite-loglogn -- the HARD zero-allocation perf gate for vEBTree
 * (@zakkster/lite-perf-gate; PLAN-vebtree G3 TASK 4, C-22, its own file, run
 * by the test:perf glob test/perf/*.test.mjs).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/VEBTreePerf.test.mjs
 *
 * Mirrors test/perf/YFastTriePerf.test.mjs. One zero-alloc scenario per
 * vEBTree hot op at U = 2^20 -- has, add+delete, successor, predecessor, min,
 * max, successor-walk over every key -- plus add+delete at U = 2^16 (the
 * base of the GrowingVeb / SideBufferVeb teeth), the U = 2^25 + 3 delete-heavy
 * max-refresh churn (torture V3's key set and cycle: every delete removes the
 * max, so delete's max refresh runs at the root AND inside an internal w = 16
 * cluster INSIDE the measured window), and successor at U = 2^28 (w = 28, a
 * depth-2 tree over w = 16 clusters). Every key, query and return is < 2^30
 * (Smi on Node and on pointer-compressed V8), so no return value can box.
 * Each scenario is scavenge-scaled at N and k*N with the old-gen and
 * arrayBuffers lanes pinned to 0: the whole tree is the `_t` Uint32Array (plus
 * the `_g` / `_p` Int32Array scratch), so the arrayBuffers lane is
 * load-bearing, and the `grows` counter (byteLength delta) must stay 0 (the
 * layout is fixed at construction, O(U) words).
 *
 * Instances and query rings are built in setup / at module init (cold), never
 * in hot. Each hot keeps its integer sink in a local and writes it to an
 * Int32Array slot once. Coverage floor: setup / statsOf are wrapped (cold) to
 * count calls, and a final test asserts 10 scenarios, each measured at N and
 * k*N with the hot body's sink moving, each population inside its bound, and
 * that the churn refreshed the max on EVERY delete (refreshes == deletes > 0,
 * bad 0) inside BOTH measured windows (read from the hot body's own Int32Array
 * tally, never from a model).
 *
 * Teeth: `mustFail` carries a fresh-array loop (the scavenge lane), a
 * member-shaped GrowingVeb add+delete scenario -- the U = 2^16 add+delete
 * scenario's own hot / statsOf over a subclass whose add reallocates `_t` +1
 * word every 64th add -- that the counter and arrayBuffers lanes MUST flag,
 * and a SideBufferVeb add+delete scenario that grows ArrayBuffer memory OFF
 * the tree (a 1 KB Uint32Array every 1,024th add into a 64-slot table built in
 * the constructor; `_t` identity and byteLength unchanged, so `grows` is
 * blind): its failure MUST be attributed to the arrayBuffers lane alone. Each
 * control has its own attribution test (measure + verdict with the suite's
 * thresholds): fresh-array -> scavenges only; GrowingVeb -> grows AND
 * arrayBuffers; SideBufferVeb -> arrayBuffers only, grows 0. GrowingVeb /
 * SideBufferVeb run the U = 2^16 add+delete scenario's exact hot / statsOf, so
 * the unmutated scenario passing is the baseline of their flip. Never widen a
 * budget to make this pass.
 *
 * FAIL CLOSED: the first test fails when LogLogN.js does not export vEBTree
 * (the namespace import keeps the module linkable on a pre-vEB build, so the
 * failure is a named test, and every scenario's setup throws too).
 *
 * FLAG PIN: the scavenge budgets are calibrated under --max-semi-space-size=4.
 * A run whose execArgv lacks it (or that carries any other semi-space /
 * young-generation flag) is a FAILING test, never a skip; the pin check has its
 * own control.
 *
 * No timing is gated here (C-22: exact counts are the gate; vEBTree timing is
 * REPORTED by `witness --veb`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zgcSuite, measure, verdict, formatResult } from '@zakkster/lite-perf-gate';
import * as LogLogN from '../../LogLogN.js';

const vEBTree = LogLogN.vEBTree;
const MISSING = 'LogLogN.js must export vEBTree';
// A pre-vEB build must still evaluate this module (so the fail-closed test
// below runs and names the cause): the subclasses extend a stub whose
// constructor throws, so every vEB setup fails too.
const VebBase = typeof vEBTree === 'function'
    ? vEBTree
    : class NoVeb { constructor() { throw new TypeError(MISSING); } };

test('fail closed: LogLogN.js exports the vEBTree class', () => {
    assert.equal(typeof vEBTree, 'function', MISSING);
    assert.equal(vEBTree.name, 'vEBTree', MISSING);
    assert.equal(new vEBTree(1 << 16).bits, 16, 'vEBTree(2^16).bits');
});

const U = 1 << 20;          // w = 20, lo = 8: root over 4,096 leaf clusters
const U16 = 1 << 16;        // w = 16, lo = 8: root over 256 leaf clusters
const U28 = 1 << 28;        // w = 28, lo = 16: root over 4,096 internal w = 16 clusters
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
const QRING16 = keyRing(0xc2b2ae35, U16 - 1);
const QRING28 = keyRing(0x85ebca6b, U28 - 1);

// Torture V3's key set (test/_veb-torture-worker.mjs v3Keys, rebuilt here so
// this file imports no torture module): U = 2^25 + 3 (w = 26, lo = 16: every
// root cluster is an INTERNAL w = 16 node over w = 8 leaves), 1,024 keys
// ((8j + 1) << 16) | (s << 8) | l, j 0..63, s in {3, 50, 140, 255},
// l in {1, 9, 77, 200}: 64 root clusters x 4 leaf clusters x 4 keys,
// ascending by construction. Every key < 2^26.
const UR = 33554435;        // 2^25 + 3
const RS = [3, 50, 140, 255];
const RL = [1, 9, 77, 200];
const RM = 1024;            // keys per cycle
const RCYCLE = 2 * RM;      // ops per cycle: RM adds ascending, RM deletes descending
const RKEYS = new Uint32Array(RM);
let rn = 0;
for (let j = 0; j < 64; j++) {
    for (let a = 0; a < RS.length; a++) {
        for (let b = 0; b < RL.length; b++) {
            RKEYS[rn++] = (((8 * j + 1) << 16) | (RS[a] << 8) | RL[b]) >>> 0;
        }
    }
}

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

test('flag pin: VEBTreePerf runs under --max-semi-space-size=4 (its calibration flag)', () => {
    assert.equal(semiPinErr(process.execArgv), null,
        'run: node --expose-gc --max-semi-space-size=4 --test test/perf/VEBTreePerf.test.mjs');
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

// Population = the EVEN ring keys of every 4th slot (16,135 distinct keys at
// U = 2^20, 12,861 at U = 2^16, 16,383 at U = 2^28); add+delete uses odd keys
// only, so every add inserts and every delete removes and `_t` is
// word-identical after any number of iterations.
function build(Ctor, u, ring) {
    const b = new Ctor(u);
    for (let i = 0; i < QN; i += 4) b.add(ring[i] & ~1);
    return { b, q: ring, sink: new Int32Array(1), cur: new Int32Array(1).fill(-1) };
}

function setupSet() { return build(VebBase, U, QRING); }
function setupSet16() { return build(VebBase, U16, QRING16); }
function setupSet28() { return build(VebBase, U28, QRING28); }
// Churn state: an EMPTY tree over U = 2^25 + 3; `ch` = [cycle phase], `cnt` =
// the hot body's tally [adds, deletes, refreshes, bad].
function setupRefresh() {
    return { b: new VebBase(UR), k: RKEYS, sink: new Int32Array(1), ch: new Int32Array(1), cnt: new Int32Array(4) };
}
function grows(s) { return { grows: s.b.byteLength }; }
// The U = 2^16 add+delete statsOf, shared with GrowingVeb / SideBufferVeb:
// `adds` = the subclass's cold add counter (0 on the plain tree), reported by
// formatResult and read by the SideBufferVeb attribution test (no threshold).
function addStats(s) {
    const c = s.b._calls;
    return { grows: s.b.byteLength, adds: c };
}
// Churn counters: `grows` gates; the tally is reported by formatResult and
// read by the coverage floor (no threshold).
function refreshStats(s) {
    return { grows: s.b.byteLength, deletes: s.cnt[1], refreshes: s.cnt[2], bad: s.cnt[3] };
}

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

// Delete-heavy max refresh (torture V3's cycle). Op p = phase in [0, 2,048):
// p < 1,024 adds keys[p] (ascending); else deletes keys[2,047 - p]
// (descending) after checking max() === x -- a hit counts a refresh, so every
// delete removes the current max and runs delete's max refresh. A delete that
// returns false, or size != 0 at a cycle end, counts bad. Phase and tally
// live in Int32Array slots, so the churn resumes across the warmup and
// measured runs.
function refreshHot(s, n) {
    const b = s.b;
    const k = s.k;
    const ch = s.ch;
    const cnt = s.cnt;
    let p = ch[0] | 0;
    let ad = cnt[0] | 0;
    let de = cnt[1] | 0;
    let rf = cnt[2] | 0;
    let bad = cnt[3] | 0;
    let acc = s.sink[0] | 0;
    for (let i = 0; i < n; i++) {
        if (p < RM) {
            b.add(k[p]);
            ad = (ad + 1) | 0;
        } else {
            const x = k[RCYCLE - 1 - p];
            if (b.max() === x) rf = (rf + 1) | 0;
            if (b.delete(x)) acc = (acc + 1) | 0;
            else bad = (bad + 1) | 0;
            de = (de + 1) | 0;
        }
        if (++p === RCYCLE) {
            p = 0;
            if (b.size !== 0) bad = (bad + 1) | 0;
        }
    }
    ch[0] = p;
    cnt[0] = ad;
    cnt[1] = de;
    cnt[2] = rf;
    cnt[3] = bad;
    s.sink[0] = acc;
}

// Coverage floor (cold): every scenario's setup and statsOf calls are counted;
// measure() calls setup twice (N, k*N) and statsOf four times (before / after
// at N, then at k*N). `tl` keeps the churn tally [deletes, refreshes, bad] per
// statsOf call (3 x 4 slots); `lo` / `hi` bound the population at every read.
const RAN = [];
function tracked(name, setup, hot, stats, lo, hi) {
    const rec = { name, setups: 0, stats: 0, moved: 0, minSize: Infinity, maxSize: -1, inBound: 0,
        lo, hi, tl: new Int32Array(12) };
    RAN.push(rec);
    return {
        name,
        setup() { rec.setups++; return setup(); },
        hot,
        statsOf(s) {
            // Records only numbers: no instance outlives its measurement.
            if (rec.stats < 4 && s.cnt !== undefined) {
                rec.tl[rec.stats * 3] = s.cnt[1];
                rec.tl[rec.stats * 3 + 1] = s.cnt[2];
                rec.tl[rec.stats * 3 + 2] = s.cnt[3];
            }
            rec.stats++;
            if (s.sink[0] !== 0) rec.moved++;
            const z = s.b.size;
            if (z >= rec.lo && z <= rec.hi) rec.inBound++;
            if (z < rec.minSize) rec.minSize = z;
            if (z > rec.maxSize) rec.maxSize = z;
            return stats(s);
        },
    };
}

const REFRESH = 'vEBTree max-refresh churn (U=2^25+3)';
const scenarios = [
    tracked('vEBTree has (U=2^20)', setupSet, hasHot, grows, 15000, 16384),
    tracked('vEBTree add+delete (U=2^20)', setupSet, addDeleteHot, grows, 15000, 16384),
    tracked('vEBTree successor (U=2^20)', setupSet, successorHot, grows, 15000, 16384),
    tracked('vEBTree predecessor (U=2^20)', setupSet, predecessorHot, grows, 15000, 16384),
    tracked('vEBTree min (U=2^20)', setupSet, minHot, grows, 15000, 16384),
    tracked('vEBTree max (U=2^20)', setupSet, maxHot, grows, 15000, 16384),
    tracked('vEBTree successor-walk (U=2^20)', setupSet, walkHot, grows, 15000, 16384),
    tracked('vEBTree add+delete (U=2^16)', setupSet16, addDeleteHot, addStats, 12000, 16384),
    tracked(REFRESH, setupRefresh, refreshHot, refreshStats, 1, RM),
    tracked('vEBTree successor (U=2^28, keys < 2^28)', setupSet28, successorHot, grows, 16000, 16384),
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
 * Teeth 2: member-shaped. The U = 2^16 add+delete scenario's own hot /
 * statsOf over a subclass whose add reallocates `_t` +1 word (the extra word
 * is never indexed: the layout is computed from `_g`, never from
 * `_t.length`) before the real add runs, on every 64th add. Growth is
 * cumulative (byteLength +4 B each time). The `grows` counter and the
 * arrayBuffers lane MUST flag it.
 */
class GrowingVeb extends VebBase {
    constructor(u) {
        super(u);
        this._calls = 0;
    }
    add(x) {
        if ((++this._calls & 63) === 0) {
            const old = this._t;
            const next = new Uint32Array(old.length + 1);
            next.set(old);
            this._t = next;
        }
        return super.add(x);
    }
}

const teethMustFailGrow = {
    name: 'teeth: GrowingVeb add reallocates _t (MUST grow)',
    setup() { return build(GrowingVeb, U16, QRING16); },
    hot: addDeleteHot,
    statsOf: addStats,
};

/**
 * Teeth 3: arrayBuffers lane ALONE. A subclass whose add, every 1,024th add,
 * allocates a fresh 1 KB Uint32Array (off-heap backing store) into a
 * preallocated 64-slot side table, never touching `_t`: identity and
 * byteLength are unchanged, so `grows` reads 0. setup's 16,384 population
 * adds plus the 20,000-op warmup fire it 35 times, so each measured window
 * starts with 35 of the 64 slots filled; N (195 fires) and k*N (1,563) both
 * end with the table full, so arrayBuffers reads about +29 KB in both
 * (nominal, from the slot arithmetic; at most 64 x 1 KB = 64 KB of side
 * buffers). The slot table is built in the constructor (cold); the only lane
 * meant to see the side buffers is arrayBuffers.
 */
class SideBufferVeb extends VebBase {
    constructor(u) {
        super(u);
        this._calls = 0;
        this._sideN = 0;
        this._side = new Array(64).fill(null);
    }
    add(x) {
        if ((++this._calls & 1023) === 0) {
            this._side[this._sideN & 63] = new Uint32Array(256);
            this._sideN++;
        }
        return super.add(x);
    }
}

const teethMustFailSide = {
    name: 'teeth: SideBufferVeb add grows ArrayBuffer memory off the tree (MUST fail arrayBuffers)',
    setup() { return build(SideBufferVeb, U16, QRING16); },
    hot: addDeleteHot,
    statsOf: addStats,
};

// The suite's thresholds, shared by zgcSuite and the attribution tests below.
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
// controls (like mustFail) cannot pollute the addDeleteHot feedback the real
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

test('teeth attribution: SideBufferVeb fails ONLY on the arrayBuffers lane (grows blind)', async () => {
    const r = await measure(teethMustFailSide, { N: GATE.N, k: GATE.k });
    const { N: _N, k: _k, ...thresholds } = GATE;
    const v = verdict(r, thresholds);
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'SideBufferVeb passed the gate: ' + line);
    assert.ok(v.reasons.length > 0 && v.reasons.every((s) => s.startsWith('arrayBuffers: ')),
        'failure not attributed to the arrayBuffers lane alone: ' + line);
    assert.equal(r.counters_hi.grows, 0, 'grows must be blind to the side buffers: ' + line);
    assert.ok(r.counters_hi.adds >= 64 * 1024, 'the k*N window added too rarely to fill the side table: ' + line);
    assert.ok(r.arrayBuffersKB_hi > 0, 'arrayBuffers lane read no growth: ' + line);
});

test('teeth: GrowingVeb is flagged by the grows counter AND the arrayBuffers lane', async () => {
    const r = await measure(teethMustFailGrow, { N: GATE.N, k: GATE.k });
    const { N: _N, k: _k, ...thresholds } = GATE;
    const v = verdict(r, thresholds);
    const line = formatResult(r) + ' | reasons=' + JSON.stringify(v.reasons);
    console.log('[perf] ' + line);
    assert.equal(v.pass, false, 'GrowingVeb passed the gate: ' + line);
    assert.ok(r.counters_hi.grows > 0, 'grows counter blind to the reallocation: ' + line);
    assert.ok(v.reasons.some((s) => s.startsWith('grows: ')), 'grows lane did not fail the verdict: ' + line);
    assert.ok(v.reasons.some((s) => s.startsWith('arrayBuffers: ')), 'arrayBuffers lane blind: ' + line);
});

// Last: every scenario was registered, built twice and measured at N and k*N,
// its hot body ran (the sink moved off 0) and its population stayed in bound;
// the churn refreshed the max on every delete in both windows.
test('coverage floor: 10 scenarios, each measured at N and k*N; the churn refreshes the max on every delete in both windows', () => {
    // Pins the GATE key set: a new field forces an edit here AND a decision on
    // whether it is a threshold (passed to verdict) or a non-threshold (destructured out).
    assert.deepEqual(Object.keys(GATE).sort(),
        ['N', 'counters', 'k', 'maxArrayBuffersKB', 'maxOldGen', 'maxRetainedKB', 'maxScavenges']);
    const { N: _N, k: _k, ...thresholds } = GATE;
    assert.deepEqual(Object.keys(thresholds).sort(),
        ['counters', 'maxArrayBuffersKB', 'maxOldGen', 'maxRetainedKB', 'maxScavenges']);
    assert.equal(scenarios.length, 10, 'scenario count');
    assert.equal(RAN.length, 10, 'tracked scenario count');
    let churn = null;
    for (const rec of RAN) {
        assert.equal(rec.setups, 2, rec.name + ': setup calls');
        assert.equal(rec.stats, 4, rec.name + ': statsOf calls');
        // statsOf runs after warmup (before) and after the measured run (after):
        // the sink has moved off 0 at all 4 reads.
        assert.equal(rec.moved, 4, rec.name + ': hot body sink moved at ' + rec.moved + '/4 reads');
        assert.equal(rec.inBound, 4, rec.name + ': population ' + rec.minSize + '..' + rec.maxSize + ' outside [' + rec.lo + ', ' + rec.hi + '] at ' + (4 - rec.inBound) + '/4 reads');
        if (rec.name === REFRESH) churn = rec;
    }
    assert.notEqual(churn, null, 'churn scenario not tracked');
    // Reads 0 / 1 = before / after the N window, 2 / 3 = before / after k*N;
    // each read is [deletes, refreshes, bad].
    const t = churn.tl;
    const line = 'deletes ' + [t[0], t[3], t[6], t[9]].join(',') +
        ' refreshes ' + [t[1], t[4], t[7], t[10]].join(',') + ' bad ' + [t[2], t[5], t[8], t[11]].join(',');
    console.log('[perf] churn tally reads: ' + line);
    for (let w = 0; w < 2; w++) {
        const a = w * 6;
        const del = t[a + 3] - t[a];
        const ref = t[a + 4] - t[a + 1];
        const win = w === 0 ? 'N' : 'k*N';
        assert.ok(del >= RM, 'churn: under one cycle of deletes inside the ' + win + ' window: ' + line);
        assert.equal(ref, del, 'churn: a delete inside the ' + win + ' window did not remove the max: ' + line);
        assert.equal(t[a + 5], 0, 'churn: bad inside the ' + win + ' window: ' + line);
    }
});
