/**
 * @zakkster/lite-loglogn -- StratifiedBitset behaviour tests (API contract).
 *
 * Strict successor / predecessor (> x / < x), out-of-universe queries, empty
 * min / max, clear, the dump() snapshot shape + copy independence, the getters
 * (SPEC pins), U = 1, a full fill / drain at U = 1024 with min / max / succ /
 * pred checked at every step, add chaining, delete return values and size.
 *
 * HANG RULE: every body that can enter a successor / predecessor / min / max
 * loop on a valid key runs in a Worker (test/_worker-run.mjs, kill timer
 * 100000 ms) so a mutant that loops forever FAILS instead of hanging npm test.
 * Those bodies are self-contained `function` expressions (shipped to the worker
 * by source). Bodies that cannot loop (getters, dump, add / delete / has) stay
 * in-process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { StratifiedBitset } from '../LogLogN.js';
import { startFn, expectFn } from './_worker-run.mjs';

const T = { timeout: 120000 };

// --- worker bodies (self-contained; started at load, in parallel) -----------

const JOBS = [];
function job(title, fn) {
    JOBS.push([title, startFn(fn, title)]);
}

job('successor / predecessor are STRICT (> x / < x) on hand-picked words', function strictHand({ StratifiedBitset, assert }) {
    const s = new StratifiedBitset(1025);
    for (const k of [0, 5, 31, 32, 1023, 1024]) s.add(k);
    assert.equal(s.successor(5), 31, 'successor(5) must skip the present key 5');
    assert.equal(s.successor(4), 5);
    assert.equal(s.successor(0), 5);
    assert.equal(s.successor(31), 32);
    assert.equal(s.successor(32), 1023);
    assert.equal(s.successor(1023), 1024);
    assert.equal(s.successor(1024), undefined);
    assert.equal(s.predecessor(5), 0, 'predecessor(5) must skip the present key 5');
    assert.equal(s.predecessor(6), 5);
    assert.equal(s.predecessor(32), 31);
    assert.equal(s.predecessor(1024), 1023);
    assert.equal(s.predecessor(1023), 32);
    assert.equal(s.predecessor(0), undefined);
    assert.equal(s.predecessor(1), 0);
});

job('successor / predecessor are STRICT at every x against a linear scan', function strictScan({ StratifiedBitset, assert }) {
    for (const U of [1, 2, 31, 32, 33, 1025, 4096]) {
        const s = new StratifiedBitset(U);
        const mem = new Uint8Array(U);
        let a = 0x9e3779b9 ^ U;
        for (let n = 0; n < (U >>> 2) + 1; n++) {
            a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
            const k = a % U;
            mem[k] = 1;
            s.add(k);
        }
        for (let x = 0; x < U; x++) {
            let sx;
            for (let k = x + 1; k < U; k++) if (mem[k] === 1) { sx = k; break; }
            let px;
            for (let k = x - 1; k >= 0; k--) if (mem[k] === 1) { px = k; break; }
            assert.equal(s.successor(x), sx, 'U=' + U + ' successor(' + x + ')');
            assert.equal(s.predecessor(x), px, 'U=' + U + ' predecessor(' + x + ')');
        }
    }
});

job('successor / predecessor return undefined out of universe (never clamp)', function outOfUniverse({ StratifiedBitset, assert }) {
    for (const U of [1, 32, 33, 1025, 65536]) {
        const s = new StratifiedBitset(U);
        s.add(0);
        s.add(U - 1);
        for (const x of [U, U + 1, U + 31, 2 ** 32 - 1, 2 ** 32]) {
            assert.equal(s.successor(x), undefined, 'U=' + U + ' successor(' + x + ')');
            assert.equal(s.predecessor(x), undefined, 'U=' + U + ' predecessor(' + x + ') must not clamp to max');
        }
        assert.equal(s.successor(U - 1), undefined);
        assert.equal(s.predecessor(0), undefined);
    }
});

job('empty set: min / max / successor / predecessor are undefined', function emptySet({ StratifiedBitset, assert }) {
    for (const U of [1, 2, 32, 33, 1025, 32768, 65536]) {
        const s = new StratifiedBitset(U);
        assert.equal(s.min(), undefined, 'U=' + U + ' min');
        assert.equal(s.max(), undefined, 'U=' + U + ' max');
        for (const x of [0, U >>> 1, U - 1]) {
            assert.equal(s.successor(x), undefined, 'U=' + U + ' successor(' + x + ')');
            assert.equal(s.predecessor(x), undefined, 'U=' + U + ' predecessor(' + x + ')');
        }
    }
});

job('clear() empties the set, keeps byteLength, and the set stays usable', function clearBody({ StratifiedBitset, assert }) {
    const s = new StratifiedBitset(65536);
    const bytes = s.byteLength;
    for (const k of [0, 31, 32, 1023, 1024, 40000, 65535]) s.add(k);
    assert.equal(s.size, 7);
    s.clear();
    assert.equal(s.size, 0);
    assert.equal(s.byteLength, bytes);
    assert.equal(s.min(), undefined);
    assert.equal(s.max(), undefined);
    assert.equal(s.successor(0), undefined);
    assert.equal(s.predecessor(65535), undefined);
    for (const k of [0, 31, 32, 1023, 1024, 40000, 65535]) assert.equal(s.has(k), false);
    for (const w of s.dump().words) for (let i = 0; i < w.length; i++) assert.equal(w[i], 0);
    s.add(40000);
    assert.equal(s.size, 1);
    assert.equal(s.min(), 40000);
    assert.equal(s.max(), 40000);
    assert.equal(s.successor(0), 40000);
    assert.equal(s.predecessor(65535), 40000);
});

job('U = 1: the single key 0', function universeOne({ StratifiedBitset, assert }) {
    const s = new StratifiedBitset(1);
    assert.equal(s.levels, 1);
    assert.equal(s.byteLength, 4);
    assert.equal(s.universe, 1);
    assert.equal(s.min(), undefined);
    assert.equal(s.add(0), s);
    assert.equal(s.size, 1);
    assert.equal(s.has(0), true);
    assert.equal(s.min(), 0);
    assert.equal(s.max(), 0);
    assert.equal(s.successor(0), undefined);
    assert.equal(s.predecessor(0), undefined);
    assert.throws(() => s.add(1), RangeError);
    assert.equal(s.has(1), false);
    assert.equal(s.delete(1), false);
    assert.equal(s.delete(0), true);
    assert.equal(s.size, 0);
    assert.equal(s.max(), undefined);
});

job('full fill / drain at U = 1024: min / max / succ / pred at every step', function fillDrain({ StratifiedBitset, assert }) {
    const U = 1024;
    const s = new StratifiedBitset(U);
    // ascending fill: set = [0, k]
    for (let k = 0; k < U; k++) {
        assert.equal(s.add(k), s);
        assert.equal(s.size, k + 1);
        assert.equal(s.min(), 0);
        assert.equal(s.max(), k);
        assert.equal(s.successor(k), undefined, 'fill successor(' + k + ')');
        assert.equal(s.predecessor(k), k === 0 ? undefined : k - 1, 'fill predecessor(' + k + ')');
        if (k > 0) assert.equal(s.successor(k - 1), k);
        if (k + 1 < U) assert.equal(s.predecessor(k + 1), k);
    }
    // ascending drain: set = [k+1, U-1]
    for (let k = 0; k < U; k++) {
        assert.equal(s.delete(k), true);
        assert.equal(s.delete(k), false);
        assert.equal(s.size, U - 1 - k);
        const empty = k === U - 1;
        assert.equal(s.min(), empty ? undefined : k + 1, 'drain min after delete(' + k + ')');
        assert.equal(s.max(), empty ? undefined : U - 1);
        assert.equal(s.successor(k), empty ? undefined : k + 1);
        assert.equal(s.predecessor(k + 1 < U ? k + 1 : k), undefined);
    }
    // descending fill: set = [k, U-1]; descending drain: set = [0, k-1]
    for (let k = U - 1; k >= 0; k--) {
        s.add(k);
        assert.equal(s.min(), k);
        assert.equal(s.max(), U - 1);
        assert.equal(s.predecessor(k), undefined);
        if (k > 0) assert.equal(s.successor(k - 1), k);
    }
    assert.equal(s.size, U);
    for (let k = U - 1; k >= 0; k--) {
        assert.equal(s.delete(k), true);
        const empty = k === 0;
        assert.equal(s.min(), empty ? undefined : 0);
        assert.equal(s.max(), empty ? undefined : k - 1, 'drain max after delete(' + k + ')');
        assert.equal(s.predecessor(k), empty ? undefined : k - 1);
        assert.equal(s.successor(k - 1 < 0 ? 0 : k - 1), undefined);
    }
    assert.equal(s.size, 0);
});

const SPIN = startFn(function spin() { for (;;) { /* never returns */ } }, 'spin', 300);

for (const [title, j] of JOBS) {
    test(title, T, async () => {
        await expectFn(j);
    });
}

test('control: a spinning worker body is killed by the timer and FAILs (never hangs)', T, async () => {
    const r = await SPIN;
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
    assert.equal(r.result, null);
    await assert.rejects(expectFn(SPIN), /hang > 300 ms/);
});

test('control: a body that references outer scope FAILs in the worker (fail closed)', T, async () => {
    const outer = 1;
    const r = startFn(function leaky() { return outer; }, 'leaky');
    await assert.rejects(expectFn(r), /ReferenceError/);
});

test('control: nonzero exit, no result, or a non-undefined return (async / generator) FAILs', T, async () => {
    await assert.rejects(expectFn(startFn(function exit3() { process.exit(3); }, 'exit3')), /worker exit code 3/);
    await assert.rejects(expectFn(startFn(function exit0() { process.exit(0); }, 'exit0')), /posted no result/);
    await assert.rejects(expectFn(startFn(function* gen() { }, 'gen')), /must return undefined/);
    await assert.rejects(expectFn(startFn(async function asy() { }, 'asy')), /must return undefined/);
});

// --- in-process (no successor / predecessor / min / max loop) ----------------

test('getters: size / universe / levels / byteLength match the SPEC pins', T, () => {
    const PINS = [[1, 1, 4], [32, 1, 4], [33, 2, 12], [1025, 3, 144], [32768, 3, 4228],
        [65536, 4, 8460], [2 ** 20, 4, 135300]];
    for (const [U, levels, bytes] of PINS) {
        const s = new StratifiedBitset(U);
        assert.equal(s.universe, U);
        assert.equal(s.levels, levels, 'U=' + U + ' levels');
        assert.equal(s.byteLength, bytes, 'U=' + U + ' byteLength');
        assert.equal(s.size, 0);
    }
    const s = new StratifiedBitset(33);
    assert.throws(() => { s.size = 5; }, TypeError);
    assert.throws(() => { s.universe = 5; }, TypeError);
    assert.throws(() => { s.levels = 5; }, TypeError);
    assert.throws(() => { s.byteLength = 5; }, TypeError);
    assert.equal(s.size, 0);
    assert.equal(s.universe, 33);
});

test('add returns this (chaining); delete returns presence; size tracks', T, () => {
    const s = new StratifiedBitset(1025);
    assert.equal(s.add(1).add(2).add(1024), s);
    assert.equal(s.size, 3);
    assert.equal(s.add(2), s, 'existing key still returns this');
    assert.equal(s.size, 3, 'existing key does not change size');
    assert.equal(s.delete(2), true);
    assert.equal(s.delete(2), false);
    assert.equal(s.delete(3), false);
    assert.equal(s.size, 2);
    assert.equal(s.has(1), true);
    assert.equal(s.has(2), false);
    assert.equal(s.has(1024), true);
});

test('dump(): {universe, size, words} with one fresh Uint32Array per level', T, () => {
    const s = new StratifiedBitset(1025);
    s.add(0).add(32).add(1024);
    const d = s.dump();
    assert.deepEqual(Object.keys(d).sort(), ['size', 'universe', 'words']);
    assert.equal(d.universe, 1025);
    assert.equal(d.size, 3);
    assert.ok(Array.isArray(d.words));
    assert.equal(d.words.length, s.levels);
    assert.deepEqual(d.words.map((w) => w.length), [33, 2, 1]);
    for (const w of d.words) assert.ok(w instanceof Uint32Array);
    // level 0: key bits; level 1: nonzero level-0 words 0, 1, 32; level 2: level-1 words 0, 1
    assert.equal(d.words[0][0], 1);
    assert.equal(d.words[0][1], 1);
    assert.equal(d.words[0][32], 1);
    assert.equal(d.words[1][0], 3);
    assert.equal(d.words[1][1], 1);
    assert.equal(d.words[2][0], 3);
    let bytes = 0;
    for (const w of d.words) bytes += w.byteLength;
    assert.equal(bytes, s.byteLength);
});

test('dump(): copy independence both ways', T, () => {
    const s = new StratifiedBitset(1025);
    s.add(0).add(32);
    const d1 = s.dump();
    const d2 = s.dump();
    assert.notEqual(d1, d2);
    for (let L = 0; L < d1.words.length; L++) assert.notEqual(d1.words[L], d2.words[L]);
    // mutating the dump does not touch the set
    d1.words[0][0] = 0xffffffff;
    d1.words[1][0] = 0;
    d1.size = 99;
    assert.equal(s.has(1), false);
    assert.equal(s.has(0), true);
    assert.equal(s.size, 2);
    assert.deepEqual(s.dump(), d2);
    // mutating the set does not touch an earlier dump
    s.add(1).delete(32);
    assert.equal(d2.words[0][0], 1);
    assert.equal(d2.words[0][1], 1);
    assert.equal(d2.size, 2);
});
