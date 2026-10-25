/**
 * @zakkster/lite-loglogn -- YFastTrie BOUNDARY / EDGE tests (0.4.0 G1-B4, A3;
 * DETERMINISTIC). Expectations come from the SPEC (PLAN-yfasttrie C-3 policy, C-7
 * stall rule, strict successor / predecessor, capacity rule), checked against a
 * plain sorted array (`agree`), never copied from engine output.
 *
 * Pins:
 *   - key 4294967295 (the top key) end to end at U = 2^32 (w = 32, K = 64);
 *   - a full add throws /YFastTrie is full/ and leaves dump() deep-equal;
 *   - an EMPTY head: min(), predecessor(), successor() across the empty head;
 *   - delete of a REP key: the rep stays as a separator, queries stay right;
 *   - delete from a bucket whose left neighbour is the head -> a borrow FROM THE
 *     HEAD (spec: s_L + s - 1 > K), counter `_n[2]` + layout checked by hand;
 *   - U = 2 and U = 3: exhaustive over every reachable state and every op;
 *   - clear(): size 0, dump reps [0], `_n` KEPT (cumulative);
 *   - C-7: an inner stall (a REAL rollback through XFastTrie._rebuild) inside a
 *     split and inside a head borrow throws the inner RangeError (/could not
 *     place/, not /YFastTrie/), dump(), `_n`, the inner keys and `_lv` are
 *     unchanged, the deleted key is still there, later ops match the oracle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { YFastTrie, XFastTrie } from '../LogLogN.js';

/** The spec oracle: full agreement of t with the key Set S at U (queries at every interesting x). */
function agree(t, S, U) {
    const ks = [...S].sort((a, b) => a - b);
    assert.equal(t.size, ks.length);
    assert.deepEqual(Array.from(t.dump().keys), ks, 'dump().keys');
    const probes = new Set([0, U - 1]);
    for (const k of ks) {
        probes.add(k);
        if (k > 0) probes.add(k - 1);
        if (k + 1 < U) probes.add(k + 1);
    }
    for (const r of t.dump().reps) {
        probes.add(r);
        if (r > 0) probes.add(r - 1);
        if (r + 1 < U) probes.add(r + 1);
    }
    for (const x of probes) {
        const su = ks.find((k) => k > x);
        let pr;
        for (const k of ks) if (k < x) pr = k;
        assert.equal(t.successor(x), su, 'successor(' + x + ')');
        assert.equal(t.predecessor(x), pr, 'predecessor(' + x + ')');
        assert.equal(t.has(x), S.has(x), 'has(' + x + ')');
    }
    assert.equal(t.min(), ks[0], 'min');
    assert.equal(t.max(), ks[ks.length - 1], 'max');
}

function mk(U, C) {
    const t = new YFastTrie(U, C);
    const S = new Set();
    return {
        t, S,
        A(x) { t.add(x); S.add(x); },
        D(x) { assert.equal(t.delete(x), S.delete(x)); },
    };
}

test('YFastTrieBoundary: key 4294967295 end to end at U = 2^32 (w = 32)', () => {
    const TOP = 4294967295;
    const { t, S, A, D } = mk(4294967296, 200);
    assert.equal(t.bits, 32);
    assert.equal(t.has(TOP), false);
    assert.equal(t.max(), undefined);
    assert.equal(t.successor(TOP), undefined);
    A(TOP);
    assert.equal(t.has(TOP), true);
    assert.equal(t.max(), TOP);
    assert.equal(t.min(), TOP);
    assert.equal(t.predecessor(TOP), undefined);
    assert.equal(t.successor(TOP - 1), TOP);
    assert.equal(t.successor(TOP), undefined);
    assert.equal(t.predecessor(0), undefined);
    A(0);
    assert.equal(t.predecessor(TOP), 0);
    assert.equal(t.successor(0), TOP);
    // keys around the 2^31 / 2^32 words, then enough keys to split with the top key present
    for (const k of [2147483647, 2147483648, 2147483649, 4294967294, 1073741824, 3221225472]) A(k);
    for (let i = 0; i < 100; i++) A(4294967295 - 3 * (i + 1));
    assert.ok(t._n[0] >= 1, 'a split happened with the top key present');
    agree(t, S, 4294967296);
    assert.equal(t.dump().keys[S.size - 1], TOP);
    D(TOP);
    assert.equal(t.has(TOP), false);
    assert.equal(t.max(), 4294967294);
    agree(t, S, 4294967296);
    // bad keys at the top edge touch nothing
    assert.equal(t.has(4294967296), false);
    assert.equal(t.successor(4294967296), undefined);
    assert.equal(t.delete(4294967296), false);
    assert.throws(() => t.add(4294967296), RangeError);
    agree(t, S, 4294967296);
    // top key at a smaller universe is out of range, U - 1 is the last valid key
    const u = new YFastTrie(4294967295, 8);
    assert.throws(() => u.add(4294967295), RangeError);
    u.add(4294967294);
    assert.equal(u.max(), 4294967294);
});

test('YFastTrieBoundary: full add throws /YFastTrie is full/ and dump() is deep-equal before and after', () => {
    for (const [U, C] of [[1024, 50], [4294967296, 70], [17, 3], [8, 1]]) {
        const { t, S, A } = mk(U, C);
        for (let i = 0; S.size < C; i++) A((i * 2654435761 + 7) % U);
        const before = t.dump();
        const n0 = Array.from(t._n);
        for (const x of [0, U - 1, 5 % U, 3 % U]) {
            if (S.has(x)) {
                assert.equal(t.add(x), t, 'add of a PRESENT key at size === C is a no-op, not a throw');
            } else {
                assert.throws(() => t.add(x), /YFastTrie is full/);
                assert.ok(t.add.length === 1);
            }
        }
        assert.deepEqual(t.dump(), before);
        assert.deepEqual(Array.from(t._n), n0);
        assert.equal(t.size, C);
        agree(t, S, U);
        // one delete frees a slot; the same add now works
        const victim = before.keys[before.keys.length >> 1];
        t.delete(victim);
        S.delete(victim);
        t.add(victim);
        S.add(victim);
        agree(t, S, U);
    }
});

test('YFastTrieBoundary: EMPTY head -- min / predecessor / successor cross it (U = 1024, w = 10, K = 20, h = 5)', () => {
    const { t, S, A, D } = mk(1024, 200);
    for (let i = 0; i < 21; i++) A(100 + i); // 21 keys: K = 20, so one split
    assert.equal(t._n[0], 1);
    const d = t.dump();
    assert.equal(d.reps.length, 2);
    assert.equal(d.reps[0], 0);
    for (let k = 100; k < d.reps[1]; k++) D(k); // empties the head completely
    assert.equal(t.dump().sizes[0], 0, 'the head holds 0 keys');
    assert.deepEqual(Array.from(t.dump().reps), [0, d.reps[1]], 'no merge: the head never merges');
    assert.equal(t.min(), d.reps[1]);
    assert.equal(t.predecessor(d.reps[1]), undefined, 'nothing below the first key');
    assert.equal(t.predecessor(1023), 120);
    assert.equal(t.successor(0), d.reps[1]);
    assert.equal(t.successor(99), d.reps[1]);
    assert.equal(t.predecessor(0), undefined);
    assert.equal(t.has(0), false);
    agree(t, S, 1024);
    // drain everything: empty again, both ends undefined
    for (const k of [...S]) D(k);
    assert.equal(t.min(), undefined);
    assert.equal(t.max(), undefined);
    assert.equal(t.size, 0);
    agree(t, S, 1024);
    A(0);
    assert.equal(t.min(), 0);
    assert.equal(t.max(), 0);
});

test('YFastTrieBoundary: delete of a REP key leaves the rep as a separator (spec C-3)', () => {
    const { t, S, A, D } = mk(1024, 200);
    for (let i = 0; i < 21; i++) A(100 + 2 * i); // 21 keys -> one split
    const r = t.dump().reps[1];
    assert.ok(S.has(r), 'the new rep is a stored key');
    D(r);
    assert.equal(t.has(r), false);
    assert.deepEqual(Array.from(t.dump().reps), [0, r], 'the rep key is gone but the separator stays');
    assert.equal(t.successor(r - 1), r + 2);
    assert.equal(t.predecessor(r + 2), r - 2);
    assert.equal(t.predecessor(r), r - 2);
    A(r); // the same key comes back into the same bucket
    assert.equal(t.has(r), true);
    assert.deepEqual(Array.from(t.dump().reps), [0, r]);
    agree(t, S, 1024);
});

test('YFastTrieBoundary: delete that borrows FROM THE HEAD (hand-built, U = 1024, w = 10, K = 20, h = 5)', () => {
    const { t, S, A, D } = mk(1024, 200);
    for (let i = 0; i < 20; i++) A(i * 10); // head full: 0..190 step 10 (K = 20)
    A(200); // 21st key: split at index w = 10 -> rep 100, head keeps 10, bucket gets 11 (incl. 200)
    assert.deepEqual(Array.from(t.dump().reps), [0, 100]);
    assert.deepEqual(Array.from(t.dump().sizes), [10, 11]);
    for (let i = 1; i < 12; i++) A(i); // head: 0, 10..90 + 1..11 (10 is a duplicate: 10 new keys) -> K = 20
    assert.deepEqual(Array.from(t.dump().sizes), [20, 11]);
    assert.deepEqual([t._n[0], t._n[1], t._n[2]], [1, 0, 0]);
    for (const x of [200, 190, 180, 170, 160, 150]) D(x); // bucket 11 -> 5 = h, no restructure yet
    assert.deepEqual(Array.from(t.dump().sizes), [20, 5]);
    assert.deepEqual([t._n[0], t._n[1], t._n[2]], [1, 0, 0]);
    // s = 5 <= h, s_L + s - 1 = 24 > K = 20 -> BORROW. t = 24, new rep = L[ceil(24/2)] = L[12]
    D(140);
    assert.deepEqual([t._n[0], t._n[1], t._n[2]], [1, 0, 1], 'one borrow, no merge');
    const d = t.dump();
    const keys = Array.from(d.keys);
    assert.deepEqual(Array.from(d.reps), [0, keys[12]], 'new rep = combined[ceil(t/2)]');
    assert.deepEqual(Array.from(d.sizes), [12, 12], 'left ceil(t/2) = 12, right t - 12 = 12');
    agree(t, S, 1024);
    // a further delete from the new bucket: 12 > h, plain delete
    D(keys[13]);
    assert.deepEqual([t._n[0], t._n[1], t._n[2]], [1, 0, 1]);
    agree(t, S, 1024);
});

test('YFastTrieBoundary: U = 2 and U = 3 exhaustive -- every reachable state x every op vs the spec', () => {
    for (const U of [2, 3]) {
        for (let C = 1; C <= U; C++) {
            // BFS over key SETS (bitmask); replay a path onto a fresh trie to reach each state
            const seen = new Map([[0, []]]);
            const queue = [0];
            let transitions = 0;
            while (queue.length > 0) {
                const m = queue.shift();
                const path = seen.get(m);
                for (let x = 0; x < U; x++) {
                    for (const op of ['add', 'delete']) {
                        const t = new YFastTrie(U, C);
                        for (const [o, k] of path) t[o](k);
                        const S = new Set();
                        for (let b = 0; b < U; b++) if (m & (1 << b)) S.add(b);
                        agree(t, S, U);
                        let next = m;
                        if (op === 'add') {
                            if (S.has(x)) assert.equal(t.add(x), t);
                            else if (S.size === C) {
                                assert.throws(() => t.add(x), /YFastTrie is full/);
                                agree(t, S, U);
                                continue;
                            } else {
                                t.add(x);
                                next = m | (1 << x);
                            }
                        } else {
                            assert.equal(t.delete(x), S.has(x));
                            next = m & ~(1 << x);
                        }
                        transitions++;
                        const S2 = new Set();
                        for (let b = 0; b < U; b++) if (next & (1 << b)) S2.add(b);
                        agree(t, S2, U);
                        assert.deepEqual([t._n[0], t._n[1], t._n[2]], [0, 0, 0], 'U <= 3: C <= 3 <= K never restructures');
                        if (!seen.has(next)) {
                            seen.set(next, path.concat([[op, x]]));
                            queue.push(next);
                        }
                    }
                }
            }
            assert.equal(seen.size, (() => {
                let n = 0;
                for (let m = 0; m < (1 << U); m++) {
                    let pop = 0;
                    for (let b = 0; b < U; b++) if (m & (1 << b)) pop++;
                    if (pop <= C) n++;
                }
                return n;
            })(), 'U=' + U + ' C=' + C + ': every subset of size <= C is reachable');
            assert.ok(transitions > 0);
        }
    }
});

test('YFastTrieBoundary: clear() -- size 0, one rep 0, `_n` kept, the instance is reusable', () => {
    const { t, S, A } = mk(1024, 200);
    for (let i = 0; i < 80; i++) A((i * 37) % 1024);
    for (let i = 0; i < 40; i++) {
        const k = [...S][i];
        t.delete(k);
        S.delete(k);
    }
    const n = Array.from(t._n);
    assert.ok(n[0] > 0 && n[1] + n[2] > 0, 'the counters moved: ' + n);
    t.clear();
    assert.equal(t.size, 0);
    assert.deepEqual(Array.from(t._n), n, '_n is cumulative: clear() keeps it');
    const d = t.dump();
    assert.deepEqual(Array.from(d.reps), [0]);
    assert.deepEqual(Array.from(d.sizes), [0]);
    assert.equal(d.keys.length, 0);
    assert.equal(t.min(), undefined);
    assert.equal(t.max(), undefined);
    assert.equal(t.has(0), false);
    S.clear();
    for (let i = 0; i < 60; i++) A((i * 53 + 5) % 1024);
    agree(t, S, 1024);
    assert.ok(t._n[0] >= n[0], 'counters keep growing after clear()');
});

// --- C-7: an inner stall inside a split and inside a head borrow ---------------------------

/** Forces the NEXT inner placement to run a REAL rebuild whose fill fails 32 times (a genuine stall + rollback). */
function forceStall(t) {
    const x = t._x;
    let puts = 0;
    let fills = 0;
    x._put = function (L, f) {
        if (puts++ === 0) {
            this._rebuild(L, f);
            return;
        }
        XFastTrie.prototype._put.call(this, L, f);
    };
    x._fill = function (L) {
        if (fills++ < 32) return false;
        return XFastTrie.prototype._fill.call(this, L);
    };
    return () => {
        delete x._put;
        delete x._fill;
    };
}

function snapshot(t) {
    return {
        dump: t.dump(),
        n: Array.from(t._n),
        inner: Array.from(t._x.dump().keys),
        lv: Array.from(t._x._lv),
        size: t.size,
    };
}

test('YFastTrieBoundary: C-7 stall inside a SPLIT -- inner RangeError, nothing changed, later ops match', () => {
    const U = 1 << 20;
    const { t, S, A } = mk(U, 4096);
    const K = 2 * t.bits;
    for (let k = 0; k < K; k++) A(k * 3 + 10); // head full (K keys)
    const before = snapshot(t);
    const undo = forceStall(t);
    let err = null;
    try {
        t.add(11); // a NEW key into the full bucket -> split -> inner add stalls
    } catch (e) {
        err = e;
    }
    undo();
    assert.ok(err instanceof RangeError, 'a RangeError, got ' + err);
    assert.match(err.message, /could not place/);
    assert.doesNotMatch(err.message, /YFastTrie/);
    assert.notEqual(t._x._q, null, 'the inner trie is not poisoned (rollback succeeded)');
    assert.deepEqual(snapshot(t), before, 'dump / _n / inner keys / _lv / size unchanged');
    assert.equal(t.has(11), false);
    agree(t, S, U);
    A(11); // the same add, no stall, now splits
    assert.equal(t._n[0], 1);
    agree(t, S, U);
    for (let k = 0; k < 300; k++) A((k * 7919) % U);
    agree(t, S, U);
});

test('YFastTrieBoundary: C-7 stall inside a BORROW FROM THE HEAD -- delete throws, key still present, later ops match', () => {
    const U = 1024;
    const { t, S, A, D } = mk(U, 200);
    for (let i = 0; i < 20; i++) A(i * 10);
    A(200);
    for (let i = 1; i < 12; i++) A(i); // 10 new keys: the head is full again
    for (const x of [200, 190, 180, 170, 160, 150]) D(x); // heads [20, 5]: the next delete borrows
    assert.deepEqual(Array.from(t.dump().sizes), [20, 5]);
    const before = snapshot(t);
    const undo = forceStall(t);
    let err = null;
    try {
        t.delete(140);
    } catch (e) {
        err = e;
    }
    undo();
    assert.ok(err instanceof RangeError, 'a RangeError, got ' + err);
    assert.match(err.message, /could not place/);
    assert.doesNotMatch(err.message, /YFastTrie/);
    assert.notEqual(t._x._q, null);
    assert.deepEqual(snapshot(t), before, 'dump / _n / inner keys / _lv / size unchanged');
    assert.equal(t.has(140), true, 'the key is still present');
    agree(t, S, U);
    D(140); // retried without the stall: the borrow happens
    assert.deepEqual([t._n[0], t._n[1], t._n[2]], [1, 0, 1]);
    agree(t, S, U);
    for (let k = 0; k < 200; k++) {
        const x = (k * 613) % U;
        if (S.has(x)) D(x);
        else if (S.size < 200) A(x);
    }
    agree(t, S, U);
});
