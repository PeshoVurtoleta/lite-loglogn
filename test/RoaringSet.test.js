/**
 * @zakkster/lite-loglogn -- RoaringSet black-box contract units (0.6.0 G1-B2, PLAN-roaringset-G1 task 6,
 * assertions A-3 and A-4; SPEC C-4, C-7, C-10a). Deterministic tier, no timing.
 *
 * Written FROM THE ASSERTIONS (an oracle independent of the engine): expected values are the PROPOSAL
 * section 1 / SPEC C-3, C-4 texts and the byteLength figures of A-4 (8,460 + 11 C + 130 maxSmall +
 * 8,456 (maxLarge + 1) + 2 maxLarge, C = ceil(U / 65536)); the throw-site states are built from the
 * documented container rules, never read out of the engine.
 *
 * The oracle itself lives in test/helpers/roaringFuzz.mjs (ownedSnapshot, A3_CASES, runA3Case,
 * checkFullDeleteFallback, checkA3, checkUniverse, checkA4) so G1-B5's RoaringMutants can run the same
 * checks against data: URL mutants through test/_roaring-fuzz-worker.mjs (job kinds 'a3' / 'a4' /
 * 'universe'; a non-empty `failures` = killed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoaringSet } from '../LogLogN.js';
import {
    A3_CASES, runA3Case, checkFullDeleteFallback, checkUniverse, checkA4, ownedSnapshot,
} from './helpers/roaringFuzz.mjs';

// --- A-3: the five throw sites ---------------------------------------------------------------

for (const c of A3_CASES) {
    test('RoaringSet A-3 ' + c.name + ': RangeError, state byte-identical', () => {
        assert.deepEqual(runA3Case(RoaringSet, c), []);
    });
}

test('RoaringSet A-3: a FULL delete with maxSmall 0 and a free large slot becomes runs', () => {
    assert.deepEqual(checkFullDeleteFallback(RoaringSet), []);
});

test('RoaringSet A-3 snapshot oracle has teeth: it sees a one-byte change in any owned typed array', () => {
    const s = new RoaringSet(1 << 20, 4, 4);
    for (let x = 0; x < 100; x++) s.add(x * 5);
    const before = ownedSnapshot(s);
    assert.ok(Object.keys(before.typed).length >= 8, 'enumerates the owned typed arrays: ' + Object.keys(before.typed).join(','));
    for (const key of Object.keys(before.typed)) {
        const a = s[key];
        const old = a[0];
        a[0] = (old + 1) & 0xFF;
        assert.notDeepEqual(ownedSnapshot(s), before, 'a change in ' + key + ' must change the snapshot');
        a[0] = old;
        assert.deepEqual(ownedSnapshot(s), before);
    }
    const sizeBefore = s.size;
    s.add(1);
    assert.equal(s.size, sizeBefore + 1);
    assert.notDeepEqual(ownedSnapshot(s), before);
});

// --- A-4: constructor knobs, byteLength, dump --------------------------------------------------

test('RoaringSet A-4: new RoaringSet() throws the universe RangeError text exactly', () => {
    assert.throws(
        () => new RoaringSet(),
        (e) => e instanceof RangeError &&
            e.message === '[lite-loglogn] RoaringSet universe must be an integer in [1, 2^32]; got undefined',
    );
});

test('RoaringSet A-4: universe is required and bounded', () => {
    assert.deepEqual(checkUniverse(RoaringSet), []);
});

test('RoaringSet A-4: maxSmall 65536 / -1 / 1.5 and maxLarge 0 / 65535 throw their texts', () => {
    const P = '[lite-loglogn] RoaringSet ';
    const bad = (args, msg) => assert.throws(() => new RoaringSet(...args), (e) => e instanceof RangeError && e.message === msg);
    bad([1 << 20, 65536], P + 'maxSmall must be an integer in [0, 65535]; got 65536');
    bad([1 << 20, -1], P + 'maxSmall must be an integer in [0, 65535]; got -1');
    bad([1 << 20, 1.5], P + 'maxSmall must be an integer in [0, 65535]; got 1.5');
    bad([1 << 20, 0, 0], P + 'maxLarge must be an integer in [1, 65534]; got 0');
    bad([1 << 20, 0, 65535], P + 'maxLarge must be an integer in [1, 65534]; got 65535');
    // the boundaries themselves are legal
    assert.doesNotThrow(() => new RoaringSet(65536, 65535, 1));
    assert.doesNotThrow(() => new RoaringSet(65536, 0, 65534));
});

test('RoaringSet A-4: byteLength (2^32,1024,256) 3,036,180; (2^32,0,1) 746,270; (2^16,1024,256) 2,315,295; (1,0,1) 25,385', () => {
    assert.equal(new RoaringSet(4294967296, 1024, 256).byteLength, 3036180);
    assert.equal(new RoaringSet(4294967296, 0, 1).byteLength, 746270);
    assert.equal(new RoaringSet(65536, 1024, 256).byteLength, 2315295);
    assert.equal(new RoaringSet(1, 0, 1).byteLength, 25385);
    // cross-check against the closed form of C-3, computed here (not read from the engine)
    const form = (U, s, l) => 8460 + 11 * Math.ceil(U / 65536) + 130 * s + 8456 * (l + 1) + 2 * l;
    for (const [U, s, l] of [[4294967296, 1024, 256], [4294967296, 0, 1], [65536, 1024, 256], [1, 0, 1], [200001, 8, 8]]) {
        assert.equal(new RoaringSet(U, s, l).byteLength, form(U, s, l), 'U=' + U + ' ' + s + ' ' + l);
    }
});

test('RoaringSet A-4: universe, size, paged, defaults', () => {
    const s = new RoaringSet(100000);
    assert.equal(s.universe, 100000);
    assert.equal(s.size, 0);
    assert.equal(s.paged, false);
    assert.equal(s.byteLength, 8460 + 11 * 2 + 130 * 1024 + 8456 * 257 + 2 * 256, 'defaults maxSmall 1024, maxLarge 256');
});

test('RoaringSet A-4: dump() kind names, paged false, snapshot independent of later mutation', () => {
    assert.deepEqual(checkA4(RoaringSet), []);
});
