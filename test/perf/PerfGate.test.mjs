/**
 * @zakkster/lite-loglogn -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to torture (0 B/op), not a replacement. Each
 * member session adds a zero-alloc scenario per hot op (add / delete / has /
 * successor / predecessor / min / max for StratifiedBitset; then the trie
 * members), scavenge-scaled at N and k*N with the old-gen and external /
 * arrayBuffers lanes pinned to 0 -- the family lives in typed-array backing
 * stores, so the arrayBuffers lane is load-bearing here.
 *
 * v0.1.0 is the SCAFFOLD release: there is NO member yet, so the gated scenarios
 * list is EMPTY (`allowEmpty: true` -- a controls-only detector smoke run). The
 * teeth are already wired: `mustFail` carries an allocating loop that MUST trip
 * the gate, proving the instrument can fail before any member relies on it (suite
 * law 9: every gate must be provably able to FAIL). Never widen a budget to make
 * this pass.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
// >>> WIRE: import the members here as each ships. None at v0.1.0 (scaffold).
import { VERSION } from '../../LogLogN.js';

/**
 * The teeth: a per-op push into a FRESH [] each op -- the array MUST trip the
 * gate (scavenges scale with n), proving the instrument has teeth before any
 * member depends on it. statsOf returns a constant so the failure is the
 * allocation lanes, not a missing-counter artifact.
 */
const teethMustFailAlloc = {
    name: 'scaffold teeth: fresh array per op (MUST allocate)',
    setup() { return { v: VERSION.length | 0, sink: 0 }; },
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

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    allowEmpty: true,           // scaffold: no member scenarios yet
    scenarios: [],
    mustFail: [teethMustFailAlloc],
});
