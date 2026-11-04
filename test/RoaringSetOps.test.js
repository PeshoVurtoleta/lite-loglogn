/**
 * @zakkster/lite-loglogn -- RoaringSet set operations (0.6.0 G3-B2a, PLAN-roaringset-G3 A-1 / A-2, SPEC C-6 /
 * C-10 / C-21). intersects / intersectionSize / unionSize / differenceSize against a JS Set model.
 *
 * Every expected value comes from the model (a JS Set of the keys added), never from the engine:
 *   intersectionSize = |A n B|, unionSize = |A| + |B| - |A n B|, differenceSize = |A| - |A n B|,
 *   intersects = |A n B| > 0. Hand-computed fixed rows are in the "fixed rows" test.
 *
 * A-1: 600 seeded pairs; layouts direct, paged pb8 / maxPages 4, pb3 / 64, pb14 / 2 (REAL build at 2^32, the only
 *   universe where C-5 builds them), pb15 and small-U paged (FORCED build, paged x paged only), direct x paged and
 *   pbA != pbB; U in {2^17+3, 2^20, 2^32}; both argument orders and self; floor: all 7 x 7 (kA, kB) container-kind
 *   pairs (kinds read from dump()) are hit on at least one shared chunk; dump() + size of both sets are identical
 *   before and after EVERY call (neither set is written). C-25: layout coverage is counted on the BUILT sets
 *   (.paged / _pSh), and each set's .paged is asserted against the row (and against the C-5 closed form).
 * A-2: `other` not a RoaringSet -> TypeError /expected a RoaringSet/; universe mismatch -> RangeError; dump()
 *   unchanged after each.
 *
 * Must-fail mutants (checked in scratch dirs, evidence P/.handoff/evidence/roaring-g3-b2a.md): M1 (`other`'s
 * metadata row taken from `this`) fails on the 2^32 direct x paged / pbA != pbB A-1 rows and the fixed paged row;
 * M2 (a FULL chunk's cardinality read from `this` instead of `other`) fails the FULL rows.
 *
 * Seed: printed; override with LOGLOGN_SEED (fail-closed parse, test/helpers/seed.mjs). Keys, structure and
 * run-optimize choices come from independent seeded 32-bit-exact PRNG streams.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeed } from './helpers/seed.mjs';
import { readFileSync } from 'node:fs';
import { RoaringSet, vEBTree } from '../LogLogN.js';
import { forcePagedSource, expectPaged } from './helpers/roaringPagedFuzz.mjs';

// FORCED-paged build of the same module file (C-25): the C-5 decision line -> `const paged = true;`. pb15 and small-U
// paged sets cannot be built by the real engine (C-5), so they exist only in this class; a forced set is only ever
// paired with another forced set (the ops check `instanceof` of their own class).
const dataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64');
const FORCED = (await import(dataUrl(forcePagedSource(readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8'))))).RoaringSet;

const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0);
const PAIRS = 600;
const KIND_NAMES = ['empty', 'small', 'array', 'bitmap', 'runs', 'smallRuns', 'full', 'single'];
const KIND_ID = Object.fromEntries(KIND_NAMES.map((n, i) => [n, i]));

// mulberry32: 32-bit exact (Math.imul / >>> 0 only)
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const mix = (i, K) => (Math.imul((i + BASE_SEED) | 0, K) + 0x1234567) >>> 0;

// chunk pools H per universe, chosen so a paged set with the layouts below never runs out of pages
const U32 = 4294967296;
const HOT = {
    [131075]: [0, 1, 2],                                            // chunk 2 is the 3-key tail
    [1 << 20]: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [U32]: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 65532, 65533, 65534, 65535],
};
// layouts: [maxPages, pageBits] or null (direct). REAL build: paged only where C-5 says so (checked with expectPaged
// below); FORCED build: every set paged, maxPages <= ceil(C / 2^pb) (the constructor bound).
const D = null, P8 = [4, 8], P3 = [64, 3], P14 = [2, 14];
const COMBOS = [];
for (const [la, lb] of [[D, D], [D, P8], [P8, D], [P8, P8], [P8, P3], [P3, P8], [P3, P14], [P14, D], [D, P3], [P14, P14]]) COMBOS.push({ U: U32, la, lb, forced: false });
COMBOS.push({ U: 131075, la: D, lb: D, forced: false }, { U: 1 << 20, la: D, lb: D, forced: false });
{
    const f1 = [2, 1], f2 = [1, 2], f15 = [1, 15];                  // 2^17+3: 3 chunks
    for (const [la, lb] of [[f1, f2], [f2, f15], [f15, f1], [f1, f1]]) COMBOS.push({ U: 131075, la, lb, forced: true });
    const g1 = [4, 2], g2 = [8, 1], g15 = [1, 15];                  // 2^20: 16 chunks, HOT pool 0..15
    for (const [la, lb] of [[g1, g2], [g2, g15], [g15, g1], [g1, g1]]) COMBOS.push({ U: 1 << 20, la, lb, forced: true });
    const h15 = [2, 15];                                            // 2^32: dirLen 2
    for (const [la, lb] of [[h15, P8], [P8, h15], [h15, h15]]) COMBOS.push({ U: U32, la, lb, forced: true });
}
const UNIVERSES = [131075, 1 << 20, U32];
const NON_TAIL = COMBOS.filter((c) => c.U !== 131075);

function build(U, lay, forced = false) {
    const C = forced ? FORCED : RoaringSet;
    return lay === null ? new C(U, 16, 16) : new C(U, 16, 16, lay[0], lay[1]);
}

class Model {
    constructor() { this.s = new Set(); }
    add(x) { this.s.add(x); }
}

// chunk builders: kind 1..7 into (set, model, chunk), keys from stream rk; hint = the other set's keys in the chunk
// (so a share of the pairs actually intersect). Returns true when the builder needs a runOptimize pass.
function buildChunk(S, M, c, kind, rk, hint, tail, par = -1) {
    const base = c * 65536;
    // par >= 0 (parity mode, kinds 1..3 only): every key gets bit 0 = par, so an even set and an odd set are disjoint
    const add = (x) => { if (par >= 0) x = x - (x % 2) + par; S.add(x); M.add(x); };
    const ri = (n) => Math.floor(rk() * n);
    if (tail) {                                                      // U = 2^17 + 3: the last chunk holds keys 0..2 only
        if (kind === 7) add(base + ri(3));
        else { add(base); add(base + 2); if (hint.length > 0 && rk() < 0.5) add(hint[0]); }
        return false;
    }
    let opt = false;
    if (kind === 1) { const n = 20 + ri(30); for (let i = 0; i < n; i++) add(base + ri(65536)); }
    else if (kind === 2) { const n = 300 + ri(1200); for (let i = 0; i < n; i++) add(base + ri(65536)); }
    else if (kind === 3) { const n = 5000 + ri(7000); for (let i = 0; i < n; i++) add(base + ri(65536)); }
    else if (kind === 4) {
        opt = true;
        for (let q = 0; q < 50; q++) { const st = q * 1100 + ri(500); const n = 3 + ri(38); for (let i = 0; i < n; i++) add(base + st + i); }
    } else if (kind === 5) {
        opt = true;
        const nr = 10 + ri(15);
        for (let q = 0; q < nr; q++) { const st = q * 2700 + ri(1000); const n = 3 + ri(1498); for (let i = 0; i < n; i++) add(base + st + i); }
    } else if (kind === 6) { for (let i = 0; i < 65536; i++) add(base + i); return false; }
    else { add(hint.length > 0 && rk() < 0.5 ? hint[ri(hint.length)] : base + ri(65536)); return false; }
    if (hint.length > 0 && rk() < 0.55) { const n = 1 + ri(6); for (let i = 0; i < n; i++) add(hint[ri(hint.length)]); }
    return opt;
}

const kindName = (k) => (typeof k === 'number' ? KIND_NAMES[k] : k);
const state = (rs) => rs.size + '|' + JSON.stringify(rs.dump());

function modelInter(ma, mb) {
    const [sm, lg] = ma.s.size <= mb.s.size ? [ma.s, mb.s] : [mb.s, ma.s];
    let n = 0;
    for (const k of sm) if (lg.has(k)) n++;
    return n;
}

function expectOps(a, ma, b, mb, inter, chk) {
    chk(a.intersectionSize(b), inter, 'intersectionSize');
    chk(b.intersectionSize(a), inter, 'intersectionSize swapped');
    chk(a.intersects(b), inter > 0, 'intersects');
    chk(b.intersects(a), inter > 0, 'intersects swapped');
    chk(a.unionSize(b), ma.s.size + mb.s.size - inter, 'unionSize');
    chk(b.unionSize(a), ma.s.size + mb.s.size - inter, 'unionSize swapped');
    chk(a.differenceSize(b), ma.s.size - inter, 'differenceSize');
    chk(b.differenceSize(a), mb.s.size - inter, 'differenceSize swapped');
}

// floors (C-25): <= 0.8 x the count measured on the BUILT sets (default seed 0: DP 107, PP 285, pb15 179, forced 280,
// real paged 242, min per-U 120; hits/misses min over seeds 0/7/12345 = 407 / 180)
const FLOOR_DP = 85, FLOOR_PP = 228, FLOOR_15 = 143, FLOOR_FORCED = 224, FLOOR_REAL = 193, FLOOR_U = 96;
const cov = { kindPairs: new Map(), hits: 0, misses: 0, directPaged: 0, pagedPagedDiff: 0, pb15: 0, forcedPairs: 0, realPaged: 0, byU: new Map(), fullPairs: 0 };

test('RoaringSetOps: seed printed', () => {
    console.log('# RoaringSetOps seed 0x' + BASE_SEED.toString(16) + ', ' + PAIRS + ' pairs, ' + COMBOS.length + ' layout combos');
    assert.ok(Number.isInteger(BASE_SEED) && BASE_SEED >= 0 && BASE_SEED <= 0xFFFFFFFF);
});

test('RoaringSetOps A-1: all four ops == JS Set model on ' + PAIRS + ' seeded pairs; sets unchanged', () => {
    for (let i = 0; i < PAIRS; i++) {
        const { U, la, lb, forced } = i < 49 ? NON_TAIL[i % NON_TAIL.length] : COMBOS[i % COMBOS.length]; // the 49 forced kind pairs skip the tail universe
        const rk = rng(mix(i, 0x9e3779b1));                          // keys
        const ro = rng(mix(i, 0x85ebca6b));                          // structure: which chunks, which kinds
        const rz = rng(mix(i, 0xc2b2ae35));                          // runOptimize choices
        const H = HOT[U];
        const A = build(U, la, forced), B = build(U, lb, forced);
        // C-25: the BUILT layout is asserted (row claim and the C-5 closed form), then counted from the built sets
        assert.equal(A.paged, forced || (la !== null && expectPaged(U, la[0], la[1])), 'pair ' + i + ' A.paged');
        assert.equal(B.paged, forced || (lb !== null && expectPaged(U, lb[0], lb[1])), 'pair ' + i + ' B.paged');
        assert.equal(A.paged, forced || la !== null, 'pair ' + i + ' A.paged vs row');
        assert.equal(B.paged, forced || lb !== null, 'pair ' + i + ' B.paged vs row');
        const mA = new Model(), mB = new Model();
        // deterministic phase: pair i < 49 forces (kA, kB) = (i % 7 + 1, floor(i / 7) + 1) in chunk 0 (the combo skips U = 2^17+3: its tail chunk holds 3 keys)
        const want = i < 49 ? [(i % 7) + 1, Math.floor(i / 7) + 1] : null;
        const nC = 2 + Math.floor(ro() * 4);
        // structure mode: 0 normal, 1 chunk-disjoint (A and B use different chunks), 2 parity (A even keys, B odd keys, kinds 1..3)
        const mode = want !== null || U === 131075 ? 0 : (ro() < 0.6 ? 0 : (ro() < 0.5 ? 1 : 2));
        const chunks = [];
        for (const c of H) chunks.push(c);
        for (let j = chunks.length - 1; j > 0; j--) { const k = Math.floor(ro() * (j + 1)); const t = chunks[j]; chunks[j] = chunks[k]; chunks[k] = t; }
        const pick = want !== null ? [0, ...chunks.filter((c) => c !== 0).slice(0, nC - 1)] : chunks.slice(0, nC);
        const optA = { v: false }, optB = { v: false };
        const fullCount = [0, 0];
        for (let j = 0; j < pick.length; j++) {
            const c = pick[j];
            const tail = U === 131075 && c === 2;
            let kA = 1 + Math.floor(ro() * 7), kB = 1 + Math.floor(ro() * 7);
            if (mode === 2) { kA = 1 + (kA % 3); kB = 1 + (kB % 3); }
            if (j === 0 && want !== null) { kA = want[0]; kB = want[1]; }
            let inA = ro() < 0.9 || (j === 0 && want !== null), inB = ro() < 0.9 || (j === 0 && want !== null);
            if (mode === 1) { inA = (j & 1) === 0; inB = !inA; }
            if (kA === 6 && fullCount[0] >= 1 && !(j === 0 && want !== null)) kA = 2;   // bound the cost: <= 1 random FULL per set
            if (kB === 6 && fullCount[1] >= 1 && !(j === 0 && want !== null)) kB = 3;
            if (inA) { if (kA === 6) fullCount[0]++; if (buildChunk(A, mA, c, kA, rk, [], tail, mode === 2 ? 0 : -1)) optA.v = true; }
            const hint = [];
            for (const k of mA.s) if (Math.floor(k / 65536) === c) hint.push(k);
            if (inB) { if (kB === 6) fullCount[1]++; if (buildChunk(B, mB, c, kB, rk, mode === 2 ? [] : hint, tail, mode === 2 ? 1 : -1)) optB.v = true; }
        }
        if (optA.v || rz() < 0.3) A.runOptimize();
        if (optB.v || rz() < 0.3) B.runOptimize();
        // model sanity: sizes
        assert.equal(A.size, mA.s.size, 'pair ' + i + ' A.size');
        assert.equal(B.size, mB.s.size, 'pair ' + i + ' B.size');
        const stA = state(A), stB = state(B);
        const inter = modelInter(mA, mB);
        const label = 'pair ' + i + ' U=' + U + (forced ? ' FORCED' : '') + ' A=' + JSON.stringify(la) + ' B=' + JSON.stringify(lb);
        // every call is followed by a dump() + size check of both sets (A-1)
        const chk = (got, want, what) => {
            assert.equal(got, want, label + ' ' + what);
            assert.equal(state(A), stA, label + ' A changed by ' + what);
            assert.equal(state(B), stB, label + ' B changed by ' + what);
        };
        expectOps(A, mA, B, mB, inter, chk);
        // self (both sets)
        for (const [S, M, n] of [[A, mA, 'A'], [B, mB, 'B']]) {
            chk(S.intersectionSize(S), M.s.size, n + ' self intersectionSize');
            chk(S.unionSize(S), M.s.size, n + ' self unionSize');
            chk(S.differenceSize(S), 0, n + ' self differenceSize');
            chk(S.intersects(S), M.s.size > 0, n + ' self intersects');
        }
        // coverage
        const dA = new Map(A.dump().chunks.map((x) => [x.chunk, kindName(x.kind)]));
        for (const x of B.dump().chunks) {
            if (!dA.has(x.chunk)) continue;
            const key = KIND_ID[dA.get(x.chunk)] + ',' + KIND_ID[kindName(x.kind)];
            cov.kindPairs.set(key, (cov.kindPairs.get(key) || 0) + 1);
        }
        if (inter > 0) cov.hits++; else cov.misses++;
        if (A.paged !== B.paged) cov.directPaged++;
        if (A.paged && B.paged && A._pSh !== B._pSh) cov.pagedPagedDiff++;
        if ((A.paged && A._pSh === 15) || (B.paged && B._pSh === 15)) cov.pb15++;
        if (forced) cov.forcedPairs++;
        if (!forced && (A.paged || B.paged)) cov.realPaged++;
        cov.byU.set(U, (cov.byU.get(U) || 0) + 1);
    }
});

test('RoaringSetOps A-1 coverage floors: 7 x 7 kind pairs, hits and misses, layouts, universes', () => {
    const missing = [];
    for (let a = 1; a <= 7; a++) for (let b = 1; b <= 7; b++) if (!(cov.kindPairs.get(a + ',' + b) >= 1)) missing.push(KIND_NAMES[a] + 'x' + KIND_NAMES[b]);
    assert.deepEqual(missing, [], 'kind pairs never hit');
    let min = Infinity, minKey = '';
    for (const [k, v] of cov.kindPairs) if (v < min) { min = v; minKey = k; }
    console.log('# RoaringSetOps coverage: kind pairs ' + cov.kindPairs.size + '/49 min ' + min + ' (' + minKey + '), hits ' + cov.hits + ', misses ' + cov.misses +
        ', BUILT direct x paged ' + cov.directPaged + ', BUILT paged pbA != pbB ' + cov.pagedPagedDiff + ', pb15 ' + cov.pb15 + ', forced ' + cov.forcedPairs + ', real paged ' + cov.realPaged + ', by U ' + JSON.stringify([...cov.byU]));
    assert.ok(cov.hits >= 320, 'intersecting pairs ' + cov.hits);
    assert.ok(cov.misses >= 140, 'disjoint pairs ' + cov.misses);
    assert.ok(cov.directPaged >= FLOOR_DP, 'BUILT direct x paged pairs ' + cov.directPaged);
    assert.ok(cov.pagedPagedDiff >= FLOOR_PP, 'BUILT paged pbA != pbB pairs ' + cov.pagedPagedDiff);
    assert.ok(cov.pb15 >= FLOOR_15, 'pb15 pairs ' + cov.pb15);
    assert.ok(cov.forcedPairs >= FLOOR_FORCED, 'forced-build pairs ' + cov.forcedPairs);
    assert.ok(cov.realPaged >= FLOOR_REAL, 'real-build paged pairs ' + cov.realPaged);
    for (const U of UNIVERSES) assert.ok(cov.byU.get(U) >= FLOOR_U, 'pairs at U=' + U);
});

test('RoaringSetOps fixed rows (hand-computed): small sets, empty, FULL against everything, direct x paged', () => {
    const mk = (U, keys, lay = null) => { const s = build(U, lay); for (const k of keys) s.add(k); return s; };
    const U = 1 << 20;
    // A = {1,2,3}, B = {3,4}: |A n B| = 1, union = 3 + 2 - 1 = 4, A - B = 2, B - A = 1
    const a = mk(U, [1, 2, 3]), b = mk(U, [3, 4]);
    assert.deepEqual([a.intersectionSize(b), a.unionSize(b), a.differenceSize(b), b.differenceSize(a), a.intersects(b)], [1, 4, 2, 1, true]);
    // disjoint
    const c = mk(U, [100, 70000]);
    assert.deepEqual([a.intersectionSize(c), a.unionSize(c), a.differenceSize(c), a.intersects(c)], [0, 5, 3, false]);
    // empty
    const e = build(U, null), e2 = build(U, [2, 1]);
    assert.equal(e2.paged, true);
    assert.deepEqual([e.intersects(e2), e.intersectionSize(e2), e.unionSize(e2), e.differenceSize(e2), e.intersects(a), a.differenceSize(e), a.unionSize(e)], [false, 0, 0, 0, false, 3, 3]);
    // FULL (chunk 1: 65536 keys) vs 10 keys in chunk 1 and 5 in chunk 2: intersection 10, union 65536 + 15 - 10, FULL - other = 65526
    const full = build(U, null);
    for (let i = 0; i < 65536; i++) full.add(65536 + i);
    for (const lay of [null, [2, 1], [2, 2]]) {
        const o = mk(U, [...Array.from({ length: 10 }, (_, i) => 65536 + 7 * i + 1), ...Array.from({ length: 5 }, (_, i) => 131072 + i)], lay);
        assert.equal(o.paged, lay !== null);                         // [2,1] and [2,2] are paged at 2^20 (C-5)
        assert.equal(o.dump().chunks.length, 2);
        assert.deepEqual([full.intersectionSize(o), o.intersectionSize(full)], [10, 10], 'FULL x small/array, layout ' + JSON.stringify(lay));
        assert.deepEqual([full.unionSize(o), o.unionSize(full)], [65541, 65541]);
        assert.deepEqual([full.differenceSize(o), o.differenceSize(full)], [65526, 5]);
        assert.equal(full.intersects(o), true);
        assert.equal(o.intersects(full), true);
    }
    // FULL vs FULL, FULL vs a 3000-key bitmap-ish chunk
    const full2 = build(U, null);
    for (let i = 0; i < 65536; i++) full2.add(65536 + i);
    assert.deepEqual([full.intersectionSize(full2), full.unionSize(full2), full.differenceSize(full2)], [65536, 65536, 0]);
    const bm = build(U, null);
    for (let i = 0; i < 6000; i++) bm.add(65536 + i * 10);              // 6000 distinct keys < 65536
    assert.equal(bm.dump().chunks.length, 1);
    assert.deepEqual([full.intersectionSize(bm), bm.intersectionSize(full), full.unionSize(bm), full.differenceSize(bm), bm.differenceSize(full)], [6000, 6000, 65536, 59536, 0]);
    // direct x paged with rows that differ: chunk 5 and chunk 9 live in different pages/rows of a pb3 set
    // (2^32 is the universe where pb3 builds paged under C-5; chunks 5 and 9 are in dir entries 0 and 1)
    const dir = mk(U32, [5 * 65536 + 1, 5 * 65536 + 2, 9 * 65536 + 7]);
    const pg = mk(U32, [9 * 65536 + 7, 9 * 65536 + 8, 5 * 65536 + 2], [8, 3]);
    assert.equal(dir.paged, false);
    assert.equal(pg.paged, true);
    assert.deepEqual([dir.intersectionSize(pg), pg.intersectionSize(dir), dir.unionSize(pg), dir.differenceSize(pg), pg.differenceSize(dir)], [2, 2, 4, 1, 1]);
    // one chunk in A only, a different chunk in B only: no shared chunk
    const p1 = mk(U32, [3 * 65536 + 1], [8, 3]), p2 = mk(U32, [4 * 65536 + 1]);
    assert.equal(p1.paged, true);
    assert.deepEqual([p1.intersects(p2), p1.intersectionSize(p2), p1.unionSize(p2)], [false, 0, 2]);
});

test('RoaringSetOps A-2: other not a RoaringSet -> TypeError; dump() unchanged', () => {
    const a = new RoaringSet(1 << 20);
    a.add(5); a.add(70000);
    const before = state(a);
    const bads = [undefined, null, {}, 0, new vEBTree(1024)];
    for (const op of ['intersects', 'intersectionSize', 'unionSize', 'differenceSize']) {
        for (const bad of bads) {
            assert.throws(() => a[op](bad), (e) => e instanceof TypeError && /expected a RoaringSet/.test(e.message), op + '(' + String(bad && bad.constructor && bad.constructor.name) + ')');
            assert.equal(state(a), before, op + ' changed the set');
        }
    }
});

test('RoaringSetOps A-2: universe mismatch (2^20 vs 2^20 + 1) -> RangeError; neither set changed', () => {
    const a = new RoaringSet(1048576), b = new RoaringSet(1048577);
    a.add(5); b.add(5); b.add(1048576);
    const sa = state(a), sb = state(b);
    for (const op of ['intersects', 'intersectionSize', 'unionSize', 'differenceSize']) {
        assert.throws(() => a[op](b), (e) => e instanceof RangeError && /universe mismatch: expected 1048576, got 1048577/.test(e.message), op + ' a(b)');
        assert.throws(() => b[op](a), (e) => e instanceof RangeError && /universe mismatch: expected 1048577, got 1048576/.test(e.message), op + ' b(a)');
        assert.equal(state(a), sa);
        assert.equal(state(b), sb);
    }
    // same universe, different layout: no error
    const p = new RoaringSet(1048576, 16, 16, 2, 1);
    assert.equal(p.paged, true);                                     // pb1 / 2 pages is paged at 2^20 (C-5)
    p.add(5);
    assert.equal(a.intersectionSize(p), 1);
});
