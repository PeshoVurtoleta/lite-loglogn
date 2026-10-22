/**
 * @zakkster/lite-loglogn -- benchmark anti-vacuity + determinism gate.
 *
 * The benchmark suite (the eight-dimension Bench v2 ADOPTED from lite-o1, plus
 * the U-sweep double-log fit and the loglogn MEMORY co-headline kernel) lands in
 * its own later session (COPY-AND-WIRE, not a rebuild). When it does, this file
 * gates it: every applicable cell is numeric, every inapplicable cell is the
 * string "n/a" (never a numeric 0), and a fixed seed reproduces the traceHash.
 *
 * There is no `benchmark/` directory yet, so this gate asserts only the
 * scaffold invariants (the harness is wired into the `npm test` glob and the
 * version const is reachable and equals package.json), and runs GREEN. The
 * Benchmark-ADOPT session replaces the body below with the real vacuity +
 * determinism assertions over benchmark/Matrix.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../LogLogN.js';

test('Bench gate scaffold: the benchmark suite lands in a later session', () => {
    // No benchmark/ directory yet (repo-only Bench v2 is a copy-and-wire session).
    // This placeholder keeps `test/Bench.test.mjs` in the `npm test` glob green
    // and non-empty so the Benchmark-ADOPT session has a wired gate to fill.
    assert.equal(typeof VERSION, 'string');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version, 'LogLogN.js VERSION const !== package.json version');
});
