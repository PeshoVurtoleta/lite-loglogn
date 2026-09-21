/**
 * @zakkster/lite-loglogn -- benchmark anti-vacuity + determinism gate.
 *
 * The benchmark suite (the eight-dimension Bench v2 ADOPTED from lite-o1, plus
 * the U-sweep double-log fit and the loglogn MEMORY co-headline kernel) lands in
 * its own later session (COPY-AND-WIRE, not a rebuild). When it does, this file
 * gates it: every applicable cell is numeric, every inapplicable cell is the
 * string "n/a" (never a numeric 0), and a fixed seed reproduces the traceHash.
 *
 * v0.1.0 is the SCAFFOLD release: there is no `benchmark/` directory yet, so
 * this gate asserts only the scaffold invariants (the harness is wired into the
 * `npm test` glob and the version const is reachable), and runs GREEN. The
 * Benchmark-ADOPT session replaces the body below with the real vacuity +
 * determinism assertions over benchmark/Matrix.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../LogLogN.js';

test('Bench gate scaffold: the benchmark suite lands in a later session', () => {
    // No benchmark/ directory yet (repo-only Bench v2 is a copy-and-wire session).
    // This placeholder keeps `test/Bench.test.mjs` in the `npm test` glob green
    // and non-empty so the Benchmark-ADOPT session has a wired gate to fill.
    assert.equal(typeof VERSION, 'string');
    assert.equal(VERSION, '0.1.0');
});
