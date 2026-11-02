/**
 * @zakkster/lite-loglogn -- vEBTree units / boundaries / sentinel mutants (0.5.0 G1-B4,
 * PLAN-vebtree task 6, C-9, C-19). Deterministic tier: no timing assertion anywhere.
 *
 * Every expected value comes from the SPEC (PLAN A1 byteLength table, C-8, C-10,
 * C-13, C-16, C-19, the strict successor / predecessor contract) or from a formula
 * written here / test/helpers/vebRef.mjs (VebRef is a separate recursive reference);
 * nothing is copied from a run of the engine.
 *
 *   1. units + boundaries at U = 2, 3, 256, 257, 512, 2^16, 2^17+3, 2^24+1
 *   2. A1 byteLength table (2^28 included) + unchanged after 1e5 ops
 *   3. clear(): `_t` word-for-word equal to a fresh instance at 7 universes (C-19)
 *   4. keys >= 2^31 (U = 2^31 + 12345) in a Worker, + 4 must-fail mutants (C-19)
 *   5. U = 2^32 empty-encoding list (C-9 / A2) in its own Worker, + 2 must-fail
 *      sentinel mutants. One Worker at a time (539.5 MB each); a Worker error / exit /
 *      timeout is a FAIL for the engine and the expected kill for a mutant.
 * The unit tests (1-3) are a regression pin for the vEBTree class, and they FAIL on
 * the pre-vEB build (.handoff/veb-before: no export).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vEBTree } from '../LogLogN.js';
import { VebRef, vebWordsU } from './helpers/vebRef.mjs';
import { outcome, mulberry32, genStream } from './helpers/vebStream.mjs';
import { startJob } from './_veb-big-worker.mjs';

const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const MUT_MS = 40000; // a mutant that loops forever is killed here (C-19)
const ENG_MS = 100000;

/** w = ceil(log2 U), by a loop (independent of the engine's clz32 formula). */
function bitsOf(U) {
    let w = 0;
    while (2 ** w < U) w++;
    return w;
}

// --- 1. units ---------------------------------------------------------------------------

const UNIS = [2, 3, 256, 257, 512, 65536, 131075, 16777217];

for (const U of UNIS) {
    test('vEBTree U=' + U + ': empty answers, getters, bad keys', () => {
        const t = new vEBTree(U);
        assert.equal(t.universe, U);
        assert.equal(t.bits, bitsOf(U));
        assert.equal(t.size, 0);
        assert.equal(t.min(), undefined);
        assert.equal(t.max(), undefined);
        for (const q of [0, 1, U >> 1, U - 1]) {
            assert.equal(t.has(q), false);
            assert.equal(t.successor(q), undefined);
            assert.equal(t.predecessor(q), undefined);
            assert.equal(t.delete(q), false);
        }
        // bad keys: has / delete false, successor / predecessor undefined, add throws
        for (const bad of [-1, U, U + 0.5, 1.5, NaN, '1', null, undefined, 1n, Infinity, 2 ** 53]) {
            assert.equal(t.has(bad), false);
            assert.equal(t.delete(bad), false);
            assert.equal(t.successor(bad), undefined);
            assert.equal(t.predecessor(bad), undefined);
            assert.throws(() => t.add(bad), RangeError);
        }
        assert.equal(t.size, 0);
        assert.equal(t.byteLength, vebWordsU(U) * 4);
    });

    test('vEBTree U=' + U + ': single key 0 / U-1 / mid', () => {
        for (const k of [0, U - 1, Math.floor(U / 2)]) {
            const t = new vEBTree(U);
            assert.equal(t.add(k), t, 'add returns this');
            assert.equal(t.size, 1);
            assert.equal(t.add(k), t, 'idempotent add returns this');
            assert.equal(t.size, 1);
            assert.equal(t.has(k), true);
            if (k > 0) assert.equal(t.has(k - 1), false);
            if (k < U - 1) assert.equal(t.has(k + 1), false);
            assert.equal(t.min(), k);
            assert.equal(t.max(), k);
            // strict: nothing above / below k itself
            assert.equal(t.successor(k), undefined);
            assert.equal(t.predecessor(k), undefined);
            assert.equal(t.successor(U - 1), undefined);
            assert.equal(t.predecessor(0), undefined);
            if (k > 0) {
                assert.equal(t.successor(k - 1), k);
                assert.equal(t.successor(0), k);
            }
            if (k < U - 1) {
                assert.equal(t.predecessor(k + 1), k);
                assert.equal(t.predecessor(U - 1), k);
            }
            assert.equal(t.delete(k), true);
            assert.equal(t.delete(k), false);
            assert.equal(t.size, 0);
            assert.equal(t.min(), undefined);
            assert.equal(t.max(), undefined);
            assert.equal(t.has(k), false);
            assert.equal(t.successor(0), undefined);
            assert.equal(t.predecessor(U - 1), undefined);
        }
    });

    test('vEBTree U=' + U + ': pair {0, U-1}, ends are strict', () => {
        const t = new vEBTree(U);
        t.add(U - 1);
        t.add(0);
        assert.equal(t.size, 2);
        assert.equal(t.min(), 0);
        assert.equal(t.max(), U - 1);
        assert.equal(t.successor(0), U - 1);
        assert.equal(t.predecessor(U - 1), 0);
        assert.equal(t.successor(U - 1), undefined);
        assert.equal(t.predecessor(0), undefined);
        if (U >= 3) {
            assert.equal(t.successor(1), U - 1);
            assert.equal(t.predecessor(U - 2), 0);
        }
        assert.equal(t.delete(0), true);
        assert.equal(t.min(), U - 1);
        assert.equal(t.max(), U - 1);
        assert.equal(t.predecessor(U - 1), undefined);
        assert.equal(t.add(0), t);
        assert.equal(t.delete(U - 1), true);
        assert.equal(t.min(), 0);
        assert.equal(t.max(), 0);
        assert.equal(t.successor(0), undefined);
        assert.equal(t.delete(0), true);
        assert.equal(t.size, 0);
        assert.equal(t.min(), undefined);
    });
}

test('vEBTree: -0 aliases key 0', () => {
    for (const U of [2, 257, 131075]) {
        const t = new vEBTree(U);
        t.add(-0);
        assert.equal(t.has(0), true);
        assert.equal(t.has(-0), true);
        assert.equal(t.min(), 0); // Object.is: +0, not -0
        assert.equal(t.delete(-0), true);
        assert.equal(t.size, 0);
    }
});

// Full universe at small U. successor / predecessor of the odd-only set by formula.
for (const U of [2, 3, 256, 257, 512, 65536]) {
    test('vEBTree U=' + U + ': full universe, evens out, odds out', () => {
        const t = new vEBTree(U);
        for (let k = 0; k < U; k++) t.add(k);
        assert.equal(t.size, U);
        assert.equal(t.min(), 0);
        assert.equal(t.max(), U - 1);
        for (let k = 0; k < U; k++) {
            assert.equal(t.has(k), true);
            assert.equal(t.successor(k), k + 1 < U ? k + 1 : undefined);
            assert.equal(t.predecessor(k), k > 0 ? k - 1 : undefined);
        }
        let evens = 0;
        for (let k = 0; k < U; k += 2) {
            assert.equal(t.delete(k), true);
            evens++;
        }
        assert.equal(t.size, U - evens);
        for (let k = 0; k < U; k++) {
            assert.equal(t.has(k), k % 2 === 1);
            // next odd key above k / below k
            const s = k % 2 === 0 ? k + 1 : k + 2;
            const p = k % 2 === 0 ? k - 1 : k - 2;
            assert.equal(t.successor(k), s < U ? s : undefined, 'succ ' + k);
            assert.equal(t.predecessor(k), p >= 1 ? p : undefined, 'pred ' + k);
        }
        const firstOdd = U >= 2 ? 1 : undefined;
        assert.equal(t.min(), firstOdd);
        assert.equal(t.max(), (U - 1) % 2 === 1 ? U - 1 : U - 2);
        for (let k = U - 1; k >= 0; k--) {
            if (k % 2 === 0) {
                assert.equal(t.delete(k), false);
            } else {
                assert.equal(t.delete(k), true);
            }
        }
        assert.equal(t.size, 0);
        assert.equal(t.min(), undefined);
        assert.equal(t.max(), undefined);
        for (let k = 0; k < U; k++) assert.equal(t.has(k), false);
    });
}

test('vEBTree: constructor rejects a bad universe (C-8)', () => {
    for (const bad of [0, 1, -2, 2.5, 4294967297, 2 ** 40, NaN, Infinity, '5', null, undefined, 5n, {}]) {
        assert.throws(() => new vEBTree(bad), RangeError, String(bad));
    }
    assert.equal(new vEBTree(2).universe, 2);
});

// --- 2. byteLength ------------------------------------------------------------------------

test('vEBTree: A1 byteLength table (spec values, not run values)', () => {
    const table = [
        [2, 4],
        [257, 76],
        [65536, 8232],
        [1048576, 131604],
        [16777216, 2105392],
        [16777217, 2115708],
        [268435456, 33718804], // 2^28: 33.7 MB, fine on the main thread
    ];
    for (const [U, bytes] of table) {
        const t = new vEBTree(U);
        assert.equal(t.byteLength, bytes, 'U=' + U);
        assert.equal(t.byteLength, vebWordsU(U) * 4, 'VebRef formula U=' + U);
    }
    // 2^32 (539,500,592) is asserted only in the Worker below, never on the main thread.
    assert.equal(vebWordsU(4294967296) * 4, 539500592);
});

test('vEBTree: byteLength unchanged after 1e5 ops', () => {
    for (const U of [257, 65536, 131075, 1048576, 16777216]) {
        const t = new vEBTree(U);
        const before = t.byteLength;
        const ro = mulberry32(0xb4b4b4b4 ^ U);
        const rk = mulberry32(0x1234abcd ^ Math.imul(U, 0x9e3779b1));
        for (let i = 0; i < 100000; i++) {
            const x = Math.floor(rk() * U);
            const c = Math.floor(ro() * 4);
            if (c === 0) t.add(x);
            else if (c === 1) t.delete(x);
            else if (c === 2) t.successor(x);
            else t.predecessor(x);
        }
        assert.equal(t.byteLength, before, 'U=' + U);
        t.clear();
        assert.equal(t.byteLength, before, 'after clear U=' + U);
    }
});

// --- 3. clear -----------------------------------------------------------------------------

test('vEBTree: clear() restores a fresh `_t` word for word (C-19), 7 universes', () => {
    for (const U of [2, 3, 257, 65536, 131075, 16777217, 33554435]) {
        const t = new vEBTree(U);
        const fresh = new vEBTree(U);
        const ro = mulberry32(0xc1ea0001 ^ U);
        const rk = mulberry32(0xc1ea0002 ^ Math.imul(U, 0x85ebca6b));
        const n = U < 1000 ? 4 * U : 20000;
        for (let i = 0; i < n; i++) {
            const x = Math.floor(rk() * U);
            if (ro() < 0.8) t.add(x);
            else t.delete(x);
        }
        t.add(0);
        t.add(U - 1);
        assert.ok(t.size > 0);
        t.clear();
        assert.equal(t.size, 0);
        assert.equal(t._t.length, fresh._t.length);
        assert.ok(Buffer.from(t._t.buffer).equals(Buffer.from(fresh._t.buffer)), 'U=' + U + ' layout differs from fresh');
        assert.equal(t.min(), undefined);
        assert.equal(t.max(), undefined);
        assert.equal(t.successor(0), undefined);
        assert.equal(t.predecessor(U - 1), undefined);
        assert.equal(t.has(0), false);
        // clear on an already empty tree is a no-op
        t.clear();
        assert.ok(Buffer.from(t._t.buffer).equals(Buffer.from(fresh._t.buffer)));
        // ops after clear behave: engine vs VebRef over a short seeded stream
        const ref = new VebRef(U);
        const st = genStream(U, 3000, (0x5eb0c1ea ^ U) >>> 0);
        for (let i = 0; i < 3000; i++) {
            assert.equal(outcome(t, st.op[i], st.key[i]), outcome(ref, st.op[i], st.key[i]), 'U=' + U + ' op ' + i);
        }
        assert.equal(t.size, ref.size);
        // and a second clear after use gives a fresh layout again
        t.clear();
        assert.ok(Buffer.from(t._t.buffer).equals(Buffer.from(fresh._t.buffer)), 'second clear U=' + U);
    }
});

// --- mutants ------------------------------------------------------------------------------

/** Replaces `anchor` by `repl` in SRC; the anchor must occur exactly once (else FAIL). */
function mutate(src, anchor, repl, name) {
    const n = src.split(anchor).length - 1;
    assert.equal(n, 1, name + ': anchor occurs ' + n + ' times, need exactly 1');
    return src.replace(anchor, () => repl);
}

/** Runs a job; returns { killed, how }. killed = timeout / error / any failure. */
async function runMutant(src, kind, extra, name) {
    const r = await startJob({ kind, src, ...extra }, name, MUT_MS);
    if (r.error !== null) {
        if (r.error.startsWith('TIMEOUT')) return { killed: true, how: 'TIMEOUT' };
        assert.fail(name + ': mutant run errored, not a kill: ' + r.error);
    }
    if (r.result === null || r.result.ok !== true) assert.fail(name + ': mutant did not load / run: ' + String(r.result && r.result.message));
    if (r.result.failures.length > 0) return { killed: true, how: 'FAIL(' + r.result.failures.length + ' checks: ' + r.result.failures[0] + ')' };
    return { killed: false, how: 'SURVIVED' };
}

async function runEngine(kind, extra, name) {
    const r = await startJob({ kind, src: null, ...extra }, name, ENG_MS);
    if (r.error !== null) assert.fail(r.error);
    if (r.result === null || r.result.ok !== true) assert.fail(name + ': ' + String(r.result && r.result.message));
    assert.deepEqual(r.result.failures, [], name);
    return r.result;
}

// --- 4. keys >= 2^31 ----------------------------------------------------------------------

const HIGH_SEED = 0x7eb20231;

test('vEBTree U=2^31+12345: keys >= 2^31 vs VebRef, layout word for word (Worker)', async () => {
    const r = await runEngine('high', { seed: HIGH_SEED }, 'high engine');
    assert.ok(r.hi[3] >= 20 && r.hi[4] >= 20 && r.hi[6] >= 20);
});

const HIGH_MUTANTS = [
    // M01: successor reads the max header slot with `| 0` (negative for a key >= 2^31)
    ['M01 successor max read | 0', 'if (!(x < t[b + 1])) return undefined;',
        'if (!(x < (t[b + 1] | 0))) return undefined;'],
    // M11: successor returns a signed int32 (no >>> 0); the anchor is successor's tail
    ['M11 successor signed return', 'return r >>> 0;\n    }\n\n    /** Largest key < x, or undefined.',
        'return r | 0;\n    }\n\n    /** Largest key < x, or undefined.'],
    // M12: add splits the key with >> (signed) instead of >>>; the anchor is add's descent
    ['M12 add >> instead of >>>', '                    pw = w - lo;\n                    pj = x >>> lo;',
        '                    pw = w - lo;\n                    pj = x >> lo;'],
    // M19: min() returns the root slot with | 0
    ['M19 min() | 0', 'if (this._w > 8) return t[0] >>> 0;', 'if (this._w > 8) return t[0] | 0;'],
];

const mutantTable = [];

for (const [name, anchor, repl] of HIGH_MUTANTS) {
    test('vEBTree mutant ' + name + ' is killed by the >= 2^31 run (Worker, kill timer)', async () => {
        const src = mutate(SRC, anchor, repl, name);
        const m = await runMutant(src, 'high', { seed: HIGH_SEED }, name);
        mutantTable.push(name + ' -> ' + m.how);
        assert.ok(m.killed, name + ' SURVIVED the >= 2^31 run');
    });
}

// --- 5. U = 2^32 (C-9 / A2) ---------------------------------------------------------------

test('vEBTree U=2^32: empty encoding A2 list + byteLength 539,500,592 (own Worker)', async () => {
    await runEngine('u32', {}, 'u32 engine');
});

test('vEBTree controls: the clean source through the mutant data: URL path passes', async () => {
    const h = await runMutant(SRC, 'high', { seed: HIGH_SEED }, 'clean high');
    assert.equal(h.how, 'SURVIVED');
    const u = await runMutant(SRC, 'u32', {}, 'clean u32');
    assert.equal(u.how, 'SURVIVED');
});

// Sentinel mutants: empty tested by one sentinel half only. Each anchor is a real empty
// test of the engine (has / add / delete); every occurrence is replaced, count-checked.
const EMPTY_SITES = [
    ['if (mn > mx) return false;', 'if (SENT) return false;'],
    ['if (mn > mx) {', 'if (SENT) {'],
    ['if (mn > mx || x < mn || x > mx) return false;', 'if (SENT || x < mn || x > mx) return false;'],
];

function sentinelMutant(test) {
    let src = SRC;
    for (const [a, r] of EMPTY_SITES) src = mutate(src, a, r.replace('SENT', test), 'sentinel ' + test);
    return src;
}

test('vEBTree mutant (a) empty := max === 0xFFFFFFFF is killed by the U=2^32 list', async () => {
    const m = await runMutant(sentinelMutant('mx === 0xFFFFFFFF'), 'u32', {}, 'sentinel max');
    mutantTable.push('(a) empty as max === 0xFFFFFFFF -> ' + m.how);
    assert.ok(m.killed, 'mutant (a) SURVIVED');
});

test('vEBTree mutant (b) empty := min === 0xFFFFFFFF only is killed by the U=2^32 list', async () => {
    const m = await runMutant(sentinelMutant('mn === 0xFFFFFFFF'), 'u32', {}, 'sentinel min');
    mutantTable.push('(b) empty as min === 0xFFFFFFFF -> ' + m.how);
    assert.ok(m.killed, 'mutant (b) SURVIVED');
});

test('vEBTree: mutant table (printed)', () => {
    for (const line of mutantTable) console.log('# mutant ' + line);
    assert.equal(mutantTable.length, HIGH_MUTANTS.length + 2);
});
