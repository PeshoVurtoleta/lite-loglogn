/**
 * @zakkster/lite-loglogn -- vEBTree INDEPENDENT REFERENCE gate (0.5.0 G1-B1,
 * PLAN-vebtree tasks 1-2, A1 / A2 oracle side, DETERMINISTIC).
 *
 * - VebRef (test/helpers/vebRef.mjs: textbook recursion, objects, lazy clusters,
 *   min not in its cluster, the C-2 split) agrees op for op with SetOracle (a JS Set
 *   + linear scans = the true definition) and with the research sketch
 *   (test/helpers/vebSketch.mjs, a different layout, U <= 2^24) on every stream of
 *   test/helpers/vebStream.mjs plus an extra fixed-seed fuzz at 9 odd universes;
 *   the invariant checker runs after EVERY op at U <= 1024 and at every checkpoint
 *   above; the flat decoder reads every checkpoint's serialize() back to the key set.
 * - A1: serialize().length * 4 equals the plan's byteLength at every allocatable
 *   universe; 2^28 / 2^32 by the size formula only (never allocated).
 * - A2 (oracle side): the U = 2^32 single-key sequence on VebRef.
 * - Teeth: hand-broken states hit each checker / decoder clause; three must-fail
 *   mutant references (min stored in its cluster; max not refreshed on delete; an
 *   untrimmed serializer) each FAIL the checks VebRef passes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
    VebRef, checkRef, decodeFlat, vebWords, vebWordsU, rootClusters, bitsOf, splitLo, EMPTY_MIN,
} from './helpers/vebRef.mjs';
import {
    allStreams, runRow, streamOf, SKETCH_MAX_U, opsFor, formatJson, OP_ADD, OP_DELETE, OP_SUCC, OP_PRED,
} from './helpers/vebStream.mjs';
import { vEBTree as Sketch } from './helpers/vebSketch.mjs';

const FULL = { set: true, sketch: true, inv: 'cp', decode: true };
const VEC = JSON.parse(readFileSync(new URL('./vectors/veb-g1.json', import.meta.url), 'utf8'));

/** A1 (PLAN-vebtree ASSERTIONS / C-16): universe -> byteLength. */
const A1 = [
    [65536, 8232], [1048576, 131604], [16777216, 2105392], [268435456, 33718804],
    [4294967296, 539500592], [257, 76], [16777217, 2115708], [2, 4],
];
const ALLOCATABLE = 16777217;

// --- mutants (one hook each) ------------------------------------------------------------

/** min ALSO stored in its cluster (breaks C-3). */
class MinInCluster extends VebRef {
    _insEmpty(n, x) {
        super._insEmpty(n, x);
        this._insCluster(n, x);
    }
}

/** delete never refreshes max. */
class NoMaxRefresh extends VebRef {
    _fixMax() {}
}

/** serializer without the C-13 root trim. */
class Untrimmed extends VebRef {
    _rootClusterCount() {
        const w = this._w;
        return 2 ** (w - splitLo(w));
    }
}

// --- A1 -------------------------------------------------------------------------------------

test('A1: byteLength by formula at every listed universe, by serialize() where allocatable', () => {
    for (const [U, bytes] of A1) {
        assert.equal(vebWordsU(U) * 4, bytes, 'formula U=' + U);
        if (U <= ALLOCATABLE) {
            const r = new VebRef(U);
            assert.equal(r.serialize().length * 4, bytes, 'serialize empty U=' + U);
            assert.equal(r.words() * 4, bytes, 'words() U=' + U);
        }
    }
    // C-16 small widths (untrimmed S): w 9 = 19 words, w 10 = 35 words.
    assert.equal(vebWords(9), 19);
    assert.equal(vebWords(10), 35);
    // C-13: trimming only shrinks non-power-of-two U; at U = 2^w trimmed == untrimmed.
    for (let w = 9; w <= 32; w++) {
        const lo = splitLo(w);
        assert.equal(rootClusters(2 ** w, w), 2 ** (w - lo), 'w=' + w);
        assert.equal(vebWordsU(2 ** w), vebWords(w), 'w=' + w);
    }
});

test('A1: serialize() length unchanged after 1e5 ops at U = 2^16 + every stream row', () => {
    const r = new VebRef(65536);
    let s = 0x2545f491;
    for (let i = 0; i < 100000; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const x = s >>> 16;
        if (s >>> 31) r.add(x);
        else r.delete(x);
    }
    assert.equal(r.serialize().length * 4, 8232);
    assert.equal(checkRef(r), null);
    for (const row of VEC.rows) {
        assert.equal(row.byteLength, vebWordsU(row.U) * 4, row.name);
        for (const cp of row.checkpoints) assert.equal(cp.words * 4, row.byteLength, row.name + '@' + cp.at);
    }
});

test('ctor: U in [2, 2^32] (C-8), RangeError text otherwise', () => {
    for (const U of [1, 0, -1, 4294967297, 1.5, NaN, Infinity, '4', null, undefined]) {
        assert.throws(() => new VebRef(U),
            (e) => e instanceof RangeError &&
                e.message.startsWith('[lite-loglogn] vEBTree universe must be an integer in [2, 2^32]; got '),
            String(U));
    }
    for (const U of [2, 3, 256, 257, 4294967296]) {
        const r = new VebRef(U);
        assert.equal(r.universe, U);
        assert.equal(r.bits, bitsOf(U));
        assert.equal(r.size, 0);
    }
});

test('bad keys touch nothing; -0 aliases 0', () => {
    const r = new VebRef(1000);
    r.add(7);
    const before = r.serialize().join(',');
    for (const x of [-1, 1000, 1000.5, NaN, '3', 4294967296, 1.5, Infinity, -Infinity, null, undefined, 3n, 2 ** 53]) {
        assert.equal(r.has(x), false);
        assert.equal(r.delete(x), false);
        assert.equal(r.successor(x), undefined);
        assert.equal(r.predecessor(x), undefined);
        assert.throws(() => r.add(x), RangeError);
    }
    assert.equal(r.serialize().join(','), before);
    assert.equal(r.add(-0), r);
    assert.equal(r.has(0), true);
    assert.ok(Object.is(r.min(), 0));
    assert.equal(r.delete(-0), true);
    assert.equal(r.size, 1);
});

// --- vebSketch provenance ---------------------------------------------------------------

test('vebSketch.mjs: tail is byte-identical to the recorded source sha256; ASCII only', () => {
    const buf = readFileSync(new URL('./helpers/vebSketch.mjs', import.meta.url));
    const marker = Buffer.from('// ---- verbatim source below ----\n');
    const at = buf.indexOf(marker);
    assert.ok(at > 0, 'marker present');
    const head = buf.subarray(0, at).toString('ascii');
    const m = /source sha256: ([0-9a-f]{64}) \((\d+) bytes\)/.exec(head);
    assert.ok(m, 'header carries sha256 + byte count');
    const tail = buf.subarray(at + marker.length);
    assert.equal(tail.length, Number(m[2]));
    assert.equal(createHash('sha256').update(tail).digest('hex'), m[1]);
    for (const b of buf) assert.ok(b < 128, 'non-ASCII byte');
});

// --- streams vs Set + sketch + invariants ----------------------------------------------------

for (const d of allStreams()) {
    test('VebRef == Set' + (d.U <= SKETCH_MAX_U ? ' == sketch' : '') + ': ' + d.name, () => {
        const opts = { ...FULL, inv: d.U <= 1024 ? 'op' : 'cp' };
        const { row, fault } = runRow(d, opts);
        assert.equal(fault, null);
        if (d.kind === 'random') {
            assert.equal(row.nOps, opsFor(d.U));
            assert.ok(row.drains >= 1, 'stream drains to empty at least once');
            assert.ok(row.maxSize >= Math.min(d.U, 64), 'maxSize ' + row.maxSize);
        }
    });
}

// Fixed seed: the env-seeded (LOGLOGN_SEED) fuzz is task 8 (test/VebFuzz.test.js); an env read here
// would be a sixth parseSeed consumer against XFastTrieOracle.test.js's pinned count of five.
test('extra seeded fuzz at odd universes (fixed seed)', () => {
    const seed = 0x5eb0f022;
    const US = [5, 33, 63, 65, 1000, 4097, 70001, 1048583, 16777215];
    US.forEach((U, i) => {
        const d = { name: 'fuzz-' + U, kind: 'random', U, seed: (seed + Math.imul(i + 1, 0x9e3779b9)) >>> 0,
            nOps: U <= 4097 ? 6000 : 3000 };
        const { fault } = runRow(d, { ...FULL, inv: U <= 4097 ? 'op' : 'cp' });
        assert.equal(fault, null, 'seed ' + seed + ' U ' + U);
    });
});

// --- coverage floors (true-definition state, never VebRef internals) ------------------------

/**
 * Coverage counts of a stream, from a plain Set's state BEFORE each op (valid keys only;
 * -0 normalized). Root clusters = groups of keys by x >>> lo, lo = the root's C-2 lo.
 *   addBelowMin  -- add of a new x < min (size >= 1)
 *   delMin / delMax -- delete of the min / max at size >= 2
 *   succCross    -- successor answer in another root cluster than x
 *   predMinCross -- predecessor answered by the min, from another root cluster than x
 *   openCluster  -- add into a root cluster holding no key
 *   emptyCluster -- delete of the last key of a root cluster
 *   newCluster   -- add into a root cluster never occupied before in the stream
 */
function coverage(d) {
    const U = d.U;
    const P = 2 ** splitLo(bitsOf(U));
    const st = streamOf(d);
    const s = new Set();
    const per = new Map();
    const seen = new Set();
    const c = { addBelowMin: 0, delMin: 0, delMax: 0, succCross: 0, predMinCross: 0,
        openCluster: 0, emptyCluster: 0, newCluster: 0 };
    for (let i = 0; i < st.op.length; i++) {
        const o = st.op[i];
        let x = st.key[i];
        if (!(typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < U)) continue;
        x += 0;
        let mn;
        let mx;
        for (const k of s) {
            if (mn === undefined || k < mn) mn = k;
            if (mx === undefined || k > mx) mx = k;
        }
        const j = Math.floor(x / P);
        if (o === OP_ADD && !s.has(x)) {
            if (s.size >= 1 && x < mn) c.addBelowMin++;
            if (!(per.get(j) > 0)) c.openCluster++;
            if (!seen.has(j)) {
                c.newCluster++;
                seen.add(j);
            }
            s.add(x);
            per.set(j, (per.get(j) || 0) + 1);
        } else if (o === OP_DELETE && s.has(x)) {
            if (s.size >= 2 && x === mn) c.delMin++;
            if (s.size >= 2 && x === mx) c.delMax++;
            s.delete(x);
            per.set(j, per.get(j) - 1);
            if (per.get(j) === 0) c.emptyCluster++;
        } else if (o === OP_SUCC) {
            let a;
            for (const k of s) if (k > x && (a === undefined || k < a)) a = k;
            if (a !== undefined && Math.floor(a / P) !== j) c.succCross++;
        } else if (o === OP_PRED) {
            let a;
            for (const k of s) if (k < x && (a === undefined || k > a)) a = k;
            if (a !== undefined && a === mn && Math.floor(a / P) !== j) c.predMinCross++;
        }
    }
    return c;
}

for (const d of allStreams()) {
    if (d.kind !== 'random' || bitsOf(d.U) < 9) continue;
    test('coverage floors >= 20 per counter: ' + d.name, (t) => {
        const c = coverage(d);
        t.diagnostic(d.name + ' ' + JSON.stringify(c));
        for (const k of ['addBelowMin', 'delMin', 'delMax', 'succCross', 'predMinCross', 'openCluster',
            'emptyCluster']) {
            assert.ok(c[k] >= 20, k + ' = ' + c[k]);
        }
        if (bitsOf(d.U) >= 17) assert.ok(c.newCluster >= 20, 'newCluster = ' + c.newCluster);
    });
}

// --- A2 oracle side -----------------------------------------------------------------------------

test('A2 (oracle side): U = 2^32 with {4294967295}', () => {
    const r = new VebRef(4294967296);
    r.add(4294967295);
    assert.equal(r.has(4294967295), true);
    assert.equal(r.has(0), false);
    assert.equal(r.min(), 4294967295);
    assert.equal(r.max(), 4294967295);
    assert.equal(r.successor(4294967294), 4294967295);
    assert.equal(r.predecessor(4294967295), undefined);
    assert.equal(checkRef(r), null);
    r.add(0);
    assert.equal(r.predecessor(4294967295), 0);
    assert.equal(r.successor(0), 4294967295);
    assert.equal(checkRef(r), null);
    assert.equal(r.delete(4294967295), true);
    assert.equal(r.delete(0), true);
    assert.equal(r.size, 0);
    assert.equal(r.min(), undefined);
    assert.equal(r.has(4294967295), false);
    assert.equal(checkRef(r), null);
});

// --- teeth: checker + decoder clauses ------------------------------------------------------------

function sample() {
    const r = new VebRef(65536);
    for (const k of [5, 300, 301, 302, 40000, 65535]) r.add(k);
    assert.equal(checkRef(r), null);
    return r;
}

test('checkRef: each clause fires on a hand-broken state', () => {
    const cases = [
        ['size', (r) => { r._size++; }],
        ['max', (r) => { r._root.max = 40000; }],
        ['range', (r) => { r._root.min = 70000; }],
        ['summaryBit', (r) => { const s = r._root.summary; s.f[1] = 0; s.n--; }],
        ['summary', (r) => { r._root.summary = null; }],
        ['leafCount', (r) => { r._root.clusters[1].n++; }],
        ['emptyCluster', (r) => { r._root.clusters[7] = { leaf: true, w: 8, f: new Uint8Array(256), n: 0 }; }],
        ['minInCluster', (r) => { const c = r._root.clusters[0] = { leaf: true, w: 8, f: new Uint8Array(256), n: 1 };
            c.f[5] = 1; r._root.summary.f[0] = 1; r._root.summary.n++; }],
        ['minIsMin', (r) => { const c = r._root.clusters[0] = { leaf: true, w: 8, f: new Uint8Array(256), n: 1 };
            c.f[2] = 1; r._root.summary.f[0] = 1; r._root.summary.n++; r._size++; }],
        ['empty', (r) => { r._root.min = -1; }],
        ['shape', (r) => { r._root.clusters.push(null); }],
    ];
    for (const [clause, breakIt] of cases) {
        const r = sample();
        breakIt(r);
        const got = checkRef(r);
        assert.ok(got !== null && got.startsWith(clause + ':'), clause + ' -> ' + got);
    }
});

test('decodeFlat: round trip + each clause fires on corrupted words', () => {
    const r = sample();
    const t = r.serialize();
    assert.deepEqual(decodeFlat(t, 65536).keys, [5, 300, 301, 302, 40000, 65535]);
    // root header [5, 65535]; summary leaf at 2..9; cluster j at 10 + 8j
    assert.equal(t[0], 5);
    assert.equal(t[1], 65535);
    const empty = new VebRef(65536).serialize();
    assert.equal(empty[0], EMPTY_MIN);
    assert.equal(empty[1], 0);
    assert.deepEqual(decodeFlat(empty, 65536).keys, []);
    const cases = [
        ['emptyEncoding', (w) => { w[0] = EMPTY_MIN; w[1] = 1; }],
        ['empty', (w) => { w[0] = EMPTY_MIN; w[1] = 0; }],
        ['summaryBit', (w) => { w[2] |= 1 << 9; }],
        ['minInCluster', (w) => { w[2] |= 1; w[10] |= 1 << 5; }],
        ['max', (w) => { w[1] = 40000; }],
        ['length', (w) => w.subarray(1)],
    ];
    for (const [clause, corrupt] of cases) {
        let w = r.serialize();
        w = corrupt(w) || w;
        const got = decodeFlat(w, 65536);
        assert.ok(got.error !== undefined && got.error.startsWith(clause + ':'), clause + ' -> ' + got.error);
    }
});

// --- must-fail mutant references ------------------------------------------------------------------

/** First fault of Ref over the random streams (full checks), or null. */
function firstFault(Ref, names) {
    for (const d of allStreams()) {
        if (names !== undefined && !names.includes(d.name)) continue;
        const { fault } = runRow(d, { ...FULL, inv: d.U <= 1024 ? 'op' : 'cp', Ref });
        if (fault !== null) return d.name + ': ' + fault;
    }
    return null;
}

/** First checkpoint of Ref (no oracles) that differs from the vector file, or null. */
function vectorDiff(Ref) {
    for (const d of allStreams()) {
        const { row } = runRow(d, { Ref });
        const want = VEC.rows.find((x) => x.name === d.name);
        if (formatJson(row) !== formatJson(want)) return d.name;
    }
    return null;
}

test('mutant: min stored in its cluster FAILS the invariant checker and the vectors', (t) => {
    const f = firstFault(MinInCluster);
    t.diagnostic('MinInCluster first fault: ' + f);
    assert.ok(f !== null && /invariant minInCluster/.test(f), String(f));
    assert.notEqual(vectorDiff(MinInCluster), null);
});

test('mutant: max not refreshed on delete FAILS Set / sketch answers and the vectors', (t) => {
    const f = firstFault(NoMaxRefresh, ['random-256', 'random-65536']);
    t.diagnostic('NoMaxRefresh first fault: ' + f);
    assert.ok(f !== null && /vs (set|sketch)/.test(f), String(f));
    const inv = firstFault(NoMaxRefresh, ['singles-257']);
    t.diagnostic('NoMaxRefresh on singles-257: ' + inv);
    assert.ok(inv !== null, 'singles trace catches it too');
    assert.notEqual(vectorDiff(NoMaxRefresh), null);
});

test('mutant: untrimmed serializer FAILS A1 at U = 2^24+1 and the vectors', (t) => {
    const m = new Untrimmed(16777217);
    t.diagnostic('Untrimmed 2^24+1 bytes: ' + m.words() * 4);
    assert.notEqual(m.words() * 4, 2115708);
    assert.notEqual(m.serialize().length * 4, 2115708);
    assert.notEqual(new Untrimmed(131075).serialize().length, vebWordsU(131075));
    const d = vectorDiff(Untrimmed);
    t.diagnostic('Untrimmed first differing row: ' + d);
    assert.equal(d, 'random-131075');
    // answers stay right (trim is layout only): Set / sketch / invariants alone cannot see it,
    // the flat decoder's length check (vebWordsU) does
    const d131 = allStreams().find((x) => x.name === 'random-131075');
    assert.equal(runRow(d131, { ...FULL, decode: false, Ref: Untrimmed }).fault, null);
    const f = firstFault(Untrimmed, ['random-131075']);
    t.diagnostic('Untrimmed first fault (full checks): ' + f);
    assert.ok(f !== null && /decode length/.test(f), String(f));
});

test('sketch sanity: different layout, same answers on a small universe', () => {
    const s = new Sketch(300);
    const r = new VebRef(300);
    for (const k of [0, 1, 64, 255, 256, 299]) { s.add(k); r.add(k); }
    for (let q = 0; q < 300; q++) {
        assert.equal(s.successor(q), r.successor(q));
        assert.equal(s.predecessor(q), r.predecessor(q));
        assert.equal(s.has(q), r.has(q));
    }
});
