// YftSmallScope.test.js -- DB-2 exhaustive small-scope test for YFastTrie at w = 4 (U = 12..16).
//
// Bugs show up in small cases: enumerate EVERY op sequence (add(k) / delete(k) for every
// k in [0, U)) up to a bounded depth and run the oracle (Set) plus an independent
// invariant walker after each op. The search itself (BFS, dedup signature, replay on a
// fresh instance, checks) lives in test/helpers/yftSmallScope.mjs; its header states the
// design. Expected values come from the SPEC (Set semantics, STRICT successor /
// predecessor, bucket-size bounds head 0..K, others h..K, reps are separators), never
// from running the engine.
//
// Two runs per config, both deterministic (no Math.random, no timing):
//   COLD  exhaustive BFS from the empty set, bounded by a state budget (reaches split /
//         merge only at larger U: the full space is ~645k states at U = 12, closure at
//         depth 65, ~80 s -- that is the DEEP run, LOGLOGN_SMALLSCOPE_DEEP=1).
//   WARM  exhaustive BFS to depth 5 from a fixed prefix (add 4..11, then 3, 2, 1, 0:
//         head holds 8 keys {0..7}, one split bucket {8..11}). Depth 3 reaches a BORROW
//         (delete 9, 10, 8: s_p + s - 1 = 9 > K = 8) and depth 4 a MERGE
//         (delete 0 first: 7 + 2 - 1 = 8 <= K). A borrow needs 12 distinct keys, so
//         a cold search cannot reach it cheaply; the prefix is the directed start,
//         the depth-5 ball around it is still exhaustive.
//   C = 10 (< U) WARM from a 10-key prefix reaches the full-capacity RangeError.
// Coverage floor per U (asserted): >= 1 split, merge, borrow, full-capacity RangeError.
// Must-fail control: a mutant whose merge threshold is off by one (merges when
// s_p + s - 1 <= K + 1, i.e. a 9-key bucket in an 8-slot run) -- the existing randomized
// tests only hit the t = K + 1 corner by chance; the exhaustive depth-3 ball always does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YFastTrie } from '../LogLogN.js';
import { search } from './helpers/yftSmallScope.mjs';

const DEEP = process.env.LOGLOGN_SMALLSCOPE_DEEP === '1';
const W = (a) => a; // readability
const adds = (ks) => ks.map((k) => k * 2);
const PRE_BORROW = W(adds([4, 5, 6, 7, 8, 9, 10, 11, 3, 2, 1, 0]));
const PRE_FULL10 = W(adds([4, 5, 6, 7, 8, 9, 10, 11, 3, 2]));
const UNIVERSES = [12, 13, 14, 15, 16];
const SEEDS = [0, 0x9e3779b1];

// Mutant: _shrink with the merge threshold off by one (K + 1). Body otherwise copied.
class MergeOffByOne extends YFastTrie {
    _shrink(f, j) {
        const t = this._x, bk = this._bk, bn = this._bn, k = this._k;
        const o = f * k, s = bn[f], p = t._prev[f], po = p * k, sl = bn[p];
        if (sl + s - 1 <= k + 1) { // BUG: should be <= k
            bk.copyWithin(po + sl, o, o + j);
            bk.copyWithin(po + sl + j, o + j + 1, o + s);
            bn[p] = sl + s - 1;
            bn[f] = 0;
            t.delete(t._key[f]);
            this._n[1] = (this._n[1] + 1) | 0;
            return;
        }
        super._shrink(f, j);
    }
}

// Reviewer mutants (fail-open on a dedup hit): a lost update and a wrong-key delete.
class LostDelete extends YFastTrie {
    delete(x) { // delete of the last key of a 7-key bucket is a silent no-op returning true
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        this._x._q[0] = x;
        const f = this._loc(), s = this._bn[f], o = f * this._k, j = this._lb(o, s);
        if (j < s && this._bk[o + j] === x && j === s - 1 && s === 7) return true; // BUG
        return super.delete(x);
    }
}
class WrongDelete2 extends YFastTrie {
    delete(x) { // 7-key head: delete of the last key removes the FIRST key instead (size, return, structure valid)
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        this._x._q[0] = x;
        const f = this._loc(), s = this._bn[f], o = f * this._k, j = this._lb(o, s);
        if (j === s - 1 && j > 0 && this._bk[o + j] === x && s === 7 && f === this._hd) { // BUG
            this._bk.copyWithin(o, o + 1, o + s); this._bn[f] = s - 1; this._size--; return true;
        }
        return super.delete(x);
    }
}

const floors = new Map(); // U -> { split, merge, borrow, fullHit }
function note(U, r) {
    const f = floors.get(U) || { split: 0, merge: 0, borrow: 0, fullHit: 0 };
    f.split += r.split; f.merge += r.merge; f.borrow += r.borrow; f.fullHit += r.fullHit;
    floors.set(U, f);
}
function line(t, tag, r) {
    t.diagnostic(tag + ': depth ' + r.depth + ' states ' + r.states + ' ops ' + r.ops +
        ' closed ' + r.closed + ' split ' + r.split + ' merge ' + r.merge +
        ' borrow ' + r.borrow + ' fullHit ' + r.fullHit);
}

for (const U of UNIVERSES) {
    for (const seed of SEEDS) {
        test('warm depth-5 ball around the borrow prefix, U=' + U + ' C=U seed=' + seed, (t) => {
            const r = search({ Cls: YFastTrie, universe: U, capacity: U, seed, prefix: PRE_BORROW, maxDepth: 5 });
            line(t, 'U' + U + ' C' + U + ' s' + seed + ' warm', r);
            assert.equal(r.violation, null, 'violation: ' + r.violation + ' after ' + r.trace);
            assert.equal(r.depth, 5);
            assert.ok(r.borrow >= 1 && r.merge >= 1, 'borrow/merge not reached');
            note(U, r);
        });
        test('warm depth-3 ball, full-capacity RangeError, U=' + U + ' C=10 seed=' + seed, (t) => {
            const r = search({ Cls: YFastTrie, universe: U, capacity: 10, seed, prefix: PRE_FULL10, maxDepth: 3 });
            line(t, 'U' + U + ' C10 s' + seed + ' warm', r);
            assert.equal(r.violation, null, 'violation: ' + r.violation + ' after ' + r.trace);
            assert.ok(r.fullHit >= 1, 'full-capacity RangeError not reached');
            note(U, r);
        });
    }
    test('cold exhaustive BFS (state budget), U=' + U + ' C=U seed=0', (t) => {
        const r = search({ Cls: YFastTrie, universe: U, capacity: U, seed: 0, maxStates: 6000 });
        line(t, 'U' + U + ' C' + U + ' s0 cold', r);
        assert.equal(r.violation, null, 'violation: ' + r.violation + ' after ' + r.trace);
        assert.ok(r.depth >= 4 && r.states >= 1000);
        note(U, r);
    });
}

test('coverage floor per U: split, merge, borrow and the full-capacity RangeError all fired', () => {
    // runs after the loops above (node:test runs a file's tests in order)
    for (const U of UNIVERSES) {
        const f = floors.get(U);
        assert.ok(f, 'no runs recorded for U=' + U);
        assert.ok(f.split >= 1, 'U=' + U + ' no split');
        assert.ok(f.merge >= 1, 'U=' + U + ' no merge');
        assert.ok(f.borrow >= 1, 'U=' + U + ' no borrow');
        assert.ok(f.fullHit >= 1, 'U=' + U + ' no full-capacity RangeError');
    }
});

test('must-fail control: merge threshold off by one is reported as a violation', (t) => {
    for (const U of [12, 16]) {
        const r = search({ Cls: MergeOffByOne, universe: U, capacity: U, seed: 0, prefix: PRE_BORROW, maxDepth: 4 });
        t.diagnostic('mutant U' + U + ': ' + r.violation + ' after ' + r.trace);
        assert.notEqual(r.violation, null, 'the mutant was NOT caught at U=' + U);
    }
});

test('must-fail control: LostDelete and WrongDelete2 (oracle compared on a dedup hit)', (t) => {
    for (const Cls of [LostDelete, WrongDelete2]) {
        const r = search({ Cls, universe: 12, capacity: 12, seed: 0, prefix: PRE_BORROW, maxDepth: 2 });
        t.diagnostic(Cls.name + ': ' + r.violation + ' after ' + r.trace);
        assert.notEqual(r.violation, null, Cls.name + ' was NOT caught');
    }
});

test('control: the same search without the mutant is clean (so the line above is the mutant)', () => {
    const r = search({ Cls: YFastTrie, universe: 12, capacity: 12, seed: 0, prefix: PRE_BORROW, maxDepth: 4 });
    assert.equal(r.violation, null);
});

test('DEEP: cold BFS to closure at U=12 (LOGLOGN_SMALLSCOPE_DEEP=1)', { skip: DEEP ? false : 'set LOGLOGN_SMALLSCOPE_DEEP=1', timeout: 600000 }, (t) => {
    const r = search({ Cls: YFastTrie, universe: 12, capacity: 12, seed: 0 });
    line(t, 'DEEP U12 C12 s0 cold', r);
    assert.equal(r.violation, null, 'violation: ' + r.violation + ' after ' + r.trace);
    assert.equal(r.closed, true);
    assert.ok(r.split >= 1 && r.merge >= 1 && r.borrow >= 1);
});
