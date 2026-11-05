/**
 * @zakkster/lite-loglogn -- RoaringSet#addRange (0.6.0 G3-B2b, PLAN-roaringset-G3 A-3 / A-4, SPEC C-4 / C-5 / C-8 /
 * C-12 / C-17 / C-25). Written FROM THE ASSERTIONS: an oracle independent of the implementation.
 *
 * Oracles (none is the engine's addRange):
 *   - a JS-side membership model (a Uint8Array over the 4-chunk window the case lives in): size and has() of every
 *     probed key are computed from it, never from the engine;
 *   - the ADD LOOP twin: a second set built identically, then `for x in [lo, hi) add(x)` and runOptimize(), the
 *     identity A-3 names. Compared on size, has, and every per-chunk field dump() exposes (chunk, kind, count, runs,
 *     plus size, universe, paged);
 *   - hand-derived rows from SPEC C-8 / PLAN S-3 for kinds and bounds (each commented where used).
 *
 * A-3: 400 seeded cases, ample pools (1024 / 256), both sets runOptimize'd 3 times first; chunks outside [cF, cL]
 *   equal their pre-call dump; both layouts (direct, REAL paged pb3 / pb8 / pb14 at 2^32, FORCED paged incl. pb15 and
 *   small U via forcePagedSource); bounds at chunk edges +-1, hi = U, 1..3 chunks; fixed rows for lo = 0, hi = 2^32,
 *   lo === hi (also 2^32), single chunk, chunk-aligned, cross-chunk, a full chunk, every existing kind 1..7, runs at
 *   cap (32 smallRuns / 2048 runs with an isolated first key).
 * A-4: (a) pool exhaustion all-or-nothing (C-4 text), (b) page-pool exhaustion, both layouts; bad bounds leave the
 *   set byte-identical (dump before == after).
 * C-25: layout coverage is counted on the BUILT sets (.paged / _pSh) and asserted against expectPaged (C-5 closed form).
 *
 * Seed: printed; override with LOGLOGN_SEED (fail-closed parse, test/helpers/seed.mjs). Bounds, structure and
 * key streams are independent seeded 32-bit-exact PRNG streams.
 *
 * Guard: a build without RoaringSet#addRange makes this file THROW at import (never skip).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSeed } from './helpers/seed.mjs';
import { RoaringSet } from '../LogLogN.js';
import { forcePagedSource, expectPaged, snap } from './helpers/roaringPagedFuzz.mjs';

if (typeof RoaringSet.prototype.addRange !== 'function') {
    throw new Error('RoaringRange.test.js: RoaringSet#addRange is missing from ../LogLogN.js (this file never skips)');
}

const dataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64');
const FORCED = (await import(dataUrl(forcePagedSource(readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8'))))).RoaringSet;

const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0);
const CASES = 400;
const U32 = 4294967296;
const KIND_NAMES = ['empty', 'small', 'array', 'bitmap', 'runs', 'smallRuns', 'full', 'single'];
const KIND_ID = Object.fromEntries(KIND_NAMES.map((n, i) => [n, i]));
const NW = 4;                                                       // window: 4 chunks

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

// layouts: lay = null (direct) or [maxPages, pageBits]; forced = FORCED class (C-5 decision line -> true)
const CONFIGS = [
    { U: U32, lay: null, wins: [0, 254, 65532] },
    { U: U32, lay: [4, 8], wins: [0, 253, 65532] },                  // REAL paged: pb8 mp4
    { U: U32, lay: [64, 3], wins: [0, 252, 65532] },                 // REAL paged: pb3 mp64
    { U: U32, lay: [2, 14], wins: [0, 65532] },                      // REAL paged: pb14 mp2
    { U: 1 << 20, lay: null, wins: [0, 4, 12] },
    { U: 131075, lay: null, wins: [0] },                             // chunk 2 is the 3-key tail
    { U: 1 << 20, lay: [4, 2], wins: [0, 4, 12], forced: true },
    { U: 1 << 20, lay: [8, 1], wins: [0, 6, 12], forced: true },
    { U: 1 << 20, lay: [1, 15], wins: [0, 4, 12], forced: true },    // pb15
    { U: 131075, lay: [2, 1], wins: [0], forced: true },
    { U: 131075, lay: [1, 15], wins: [0], forced: true },
    { U: U32, lay: [2, 15], wins: [0, 65532], forced: true },        // pb15 at 2^32 (dirLen 2)
    { U: 65536, lay: null, wins: [0] },                              // one chunk, D = 1
];
function mk(cfg, maxS = 1024, maxL = 256) {
    const C = cfg.forced ? FORCED : RoaringSet;
    return cfg.lay === null ? new C(cfg.U, maxS, maxL) : new C(cfg.U, maxS, maxL, cfg.lay[0], cfg.lay[1]);
}
const kindName = (k) => (typeof k === 'number' ? KIND_NAMES[k] : k);
const chunkCount = (U) => Math.ceil(U / 65536);

// dump equality with a field-level message (chunk, kind, count, runs, size, universe, paged)
function sameDump(a, b, label) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    for (const f of ['universe', 'size', 'paged']) assert.equal(a[f], b[f], label + ' dump.' + f);
    assert.equal(a.chunks.length, b.chunks.length, label + ' live chunk count');
    for (let i = 0; i < a.chunks.length; i++) {
        for (const f of ['chunk', 'kind', 'count', 'runs']) assert.equal(a.chunks[i][f], b.chunks[i][f], label + ' chunk #' + i + ' ' + f);
    }
    assert.deepEqual(a, b, label + ' dump');
}
const snapOf = (s) => JSON.stringify(s.dump());
// full snapshot: dump + every own scalar field and typed array (pool tops, headers, summaries): sees a throw after a write
const fullSnap = (s) => JSON.stringify(s.dump()) + snap(s);
const kindOf = (d, c) => { const e = d.chunks.find((x) => x.chunk === c); return e ? KIND_ID[kindName(e.kind)] : 0; };

// ---- coverage (built counts, C-25) ----
const cov = { k0: new Array(8).fill(0), k1: new Array(8).fill(0), cases: 0, direct: 0, realPaged: 0, forced: 0, pb15: 0,
    pbSeen: new Set(), covered: 0, cross: 0, single: 0, loZero: 0, hiU: 0, empty: 0, partial2: 0, tail: 0, edge: 0 };

// ---- the identity engine: pre-state keys -> R (addRange) vs L (add loop) vs the membership model ----
// pre: array of absolute keys inside the window [w, w + NW) chunks; lo, hi: the range. deep: full-key has() sweep.
function runCase(cfg, w, pre, lo, hi, label, deep, record, post) {
    const U = cfg.U;
    const R = mk(cfg), L = mk(cfg);
    for (let i = 0; i < pre.length; i++) { R.add(pre[i]); L.add(pre[i]); }
    for (let i = 0; i < 3; i++) { R.runOptimize(); L.runOptimize(); }
    if (post) { for (const x of post) { R.add(x); L.add(x); pre.push(x); } }   // keys added AFTER the optimize passes (runs at cap)
    const wBase = w * 65536;
    const flags = new Uint8Array(NW * 65536);                       // the model: membership in the window
    for (let i = 0; i < pre.length; i++) flags[pre[i] - wBase] = 1;
    let preCount = 0;
    for (let i = 0; i < flags.length; i++) preCount += flags[i];
    assert.equal(R.size, preCount, label + ' pre size');
    const dPre = R.dump();
    sameDump(dPre, L.dump(), label + ' pre R vs L');
    // C-25: built layout asserted, then counted
    if (cfg.forced) assert.equal(R.paged, true, label + ' forced paged');
    else assert.equal(R.paged, cfg.lay !== null && expectPaged(cfg.U, cfg.lay[0], cfg.lay[1]), label + ' built layout vs C-5 closed form');
    assert.equal(R.paged, cfg.forced || cfg.lay !== null, label + ' paged vs row');

    const ret = R.addRange(lo, hi);
    assert.equal(ret, R, label + ' returns this');
    for (let x = lo; x < hi; x++) L.add(x);
    L.runOptimize();
    for (let x = lo; x < hi; x++) flags[x - wBase] = 1;
    let want = 0;
    for (let i = 0; i < flags.length; i++) want += flags[i];

    assert.equal(R.size, want, label + ' size vs model');
    assert.equal(L.size, want, label + ' loop size vs model');
    const dR = R.dump(), dL = L.dump();
    sameDump(dR, dL, label + ' R vs add loop + runOptimize');
    assert.equal(R.min(), L.min(), label + ' min');
    assert.equal(R.max(), L.max(), label + ' max');
    assert.equal(R._sTop, L._sTop, label + ' sTop');                 // pool accounting: a leaked slot shows here
    assert.equal(R._lTop, L._lTop, label + ' lTop');
    assert.equal(R._pTop, L._pTop, label + ' pTop');
    // chunks outside [cF, cL] are byte-identical to the pre-call dump
    if (lo < hi) {
        const cF = Math.floor(lo / 65536), cL = Math.floor((hi - 1) / 65536);
        const out = (d) => d.chunks.filter((e) => e.chunk < cF || e.chunk > cL);
        assert.deepEqual(out(dR), out(dPre), label + ' untouched chunks changed');
    } else {
        sameDump(dR, dPre, label + ' lo === hi changed the set');
    }
    // has(): probes (edges of the range, every pre key, seeded interior), against the model
    const probe = (x) => {
        if (x < 0 || x >= U) return;
        const exp = x >= wBase && x < wBase + flags.length ? flags[x - wBase] === 1 : false;
        assert.equal(R.has(x), exp, label + ' has(' + x + ')');
        assert.equal(R.successor(x), L.successor(x), label + ' successor(' + x + ')');
        assert.equal(R.predecessor(x), L.predecessor(x), label + ' predecessor(' + x + ')');
    };
    for (const d of [-2, -1, 0, 1, 2]) { probe(lo + d); probe(hi + d); probe(hi - 1 + d); }
    for (let i = 0; i < pre.length; i += 1 + (pre.length >> 7)) probe(pre[i]);
    if (deep) {
        const top = Math.min(wBase + flags.length, U);
        for (let x = wBase; x < top; x++) if (R.has(x) !== (flags[x - wBase] === 1)) assert.fail(label + ' has(' + x + ') sweep');
    }
    // runOptimize after: both converge (idempotent over the range's result)
    const sR = snapOf(R);
    R.runOptimize(); L.runOptimize();
    assert.equal(snapOf(R), sR, label + ' runOptimize after addRange moved a kind (addRange should already end optimal)');
    sameDump(R.dump(), L.dump(), label + ' after runOptimize');
    if (record) {
        record(R, dPre, dL, lo, hi);
    }
    return { R, L, dPre, dR };
}

// ---- pre-state builders (chunk-local, kinds 1..7, from stream rk) ----
function buildPre(keys, c, kind, rk, sp) {
    const base = c * 65536;
    const ri = (n) => Math.floor(rk() * n);
    if (sp < 65536) {                                                // the 3-key tail: kinds empty / small / single only
        if (kind === 7) keys.push(base + ri(sp));
        else if (kind !== 0) { keys.push(base); keys.push(base + sp - 1); }
        return;
    }
    if (kind === 0) return;
    if (kind === 1) { const n = 2 + ri(40); for (let i = 0; i < n; i++) keys.push(base + ri(65536)); }
    else if (kind === 2) { const n = 300 + ri(1200); for (let i = 0; i < n; i++) keys.push(base + ri(65536)); }
    else if (kind === 3) { const n = 5000 + ri(7000); for (let i = 0; i < n; i++) keys.push(base + ri(65536)); }
    else if (kind === 4) { for (let q = 0; q < 50; q++) { const st = q * 1100 + ri(500); const n = 3 + ri(38); for (let i = 0; i < n; i++) keys.push(base + st + i); } }
    else if (kind === 5) { const nr = 10 + ri(15); for (let q = 0; q < nr; q++) { const st = q * 2700 + ri(1000); const n = 3 + ri(1498); for (let i = 0; i < n; i++) keys.push(base + st + i); } }
    else if (kind === 6) { for (let i = 0; i < 65536; i++) keys.push(base + i); }
    else keys.push(base + ri(65536));
}

// bounds generator (stream rb): returns [lo, hi] inside the window
function genBounds(rb, U, w) {
    const lowK = w * 65536, hiK = Math.min(U, (w + NW) * 65536);
    const nCh = Math.min(NW, chunkCount(U) - w);
    const ri = (n) => Math.floor(rb() * n);
    const c = w + ri(nCh);
    const pick = (a) => a[ri(a.length)];
    let lo, hi;
    const m = ri(10);
    if (m === 0) { lo = c * 65536 + ri(65536); hi = lo + 1 + ri(3000); }
    else if (m === 1) { lo = c * 65536; hi = lo + 65536 * (1 + ri(3)); }
    else if (m === 2) { const e = (c + 1) * 65536; lo = e - 1 - ri(5000); hi = e + 1 + ri(5000); }
    else if (m === 3) { lo = c * 65536 + pick([-1, 0, 1]); hi = lo + pick([1, 2, 65535, 65536, 65537, 131071, 131072, 131073, 196607]); }
    else if (m === 4) { lo = c * 65536; hi = lo + 65536; }
    else if (m === 5) { hi = hiK; lo = hiK - pick([1, 2, 100, 65535, 65536, 65537, 70000, 140000]); }
    else if (m === 6) { lo = c * 65536 + ri(65536); hi = lo + pick([1, 1, 2, 3]); }
    else if (m === 7) { lo = c * 65536 + ri(65536); hi = lo + 4000 + ri(30000); }
    else if (m === 8) { lo = c * 65536 + pick([0, 65535, 65534]); hi = lo + pick([0, 1, 2]); }
    else { lo = lowK + ri(NW * 65536); hi = lo + pick([0, 1, 100, 5000, 65536, 100000, 200000]); }
    lo = Math.max(lowK, Math.min(lo, hiK));
    hi = Math.max(lo, Math.min(hi, hiK));
    return [lo, hi];
}

function recorder(cfg, R) {
    cov.cases++;
    if (R.paged) { if (cfg.forced) cov.forced++; else cov.realPaged++; cov.pbSeen.add(R._pSh); if (R._pSh === 15) cov.pb15++; }
    else cov.direct++;
    if (R.dump().universe % 65536 !== 0) cov.tail++;
}

test('RoaringRange: seed printed', () => {
    console.log('# RoaringRange seed 0x' + BASE_SEED.toString(16) + ', ' + CASES + ' cases, ' + CONFIGS.length + ' layout configs');
    assert.ok(Number.isInteger(BASE_SEED) && BASE_SEED >= 0 && BASE_SEED <= 0xFFFFFFFF);
});

test('RoaringRange A-3: addRange == add loop + runOptimize == Set model on ' + CASES + ' seeded cases (both layouts)', () => {
    for (let i = 0; i < CASES; i++) {
        const cfg = CONFIGS[i % CONFIGS.length];
        const rk = rng(mix(i, 0x9e3779b1));                          // keys
        const ro = rng(mix(i, 0x85ebca6b));                          // structure: kinds, hints
        const rb = rng(mix(i, 0xc2b2ae35));                          // bounds, window
        const w = cfg.wins[Math.floor(rb() * cfg.wins.length)];
        let [lo, hi] = genBounds(rb, cfg.U, w);
        if (i % 16 === 5) { lo = Math.min(lo, cfg.U - 1); hi = lo + 1; }   // deterministic share: a 1-key range into an empty window (SINGLE)
        const C = chunkCount(cfg.U);
        const pre = [];
        let fulls = 0;
        for (let j = 0; j < NW && w + j < C; j++) {
            const c = w + j;
            const sp = Math.min(65536, cfg.U - c * 65536);
            let kind = Math.floor(ro() * 8);
            if (kind === 6) { if (fulls >= 1) kind = 3; else fulls++; }
            buildPre(pre, c, kind, rk, sp);
            if (ro() < 0.4) {                                        // hint keys around the bounds: isolated / adjacent first key
                for (const b of [lo, hi - 1]) for (let d = -3; d <= 2; d++) {
                    const x = b + d;
                    if (ro() < 0.35 && x >= c * 65536 && x < Math.min(cfg.U, c * 65536 + sp)) pre.push(x);
                }
            }
        }
        if (i % 16 === 5) pre.length = 0;
        if (i % 16 === 9 && cfg.U - w * 65536 >= 65536) {                // deterministic share: a short range into a scattered array chunk (stays array)
            pre.length = 0;
            for (let q = 0; q < 400; q++) pre.push(w * 65536 + Math.floor(rk() * 65536));
            lo = w * 65536 + 1000 + Math.floor(rb() * 60000); hi = lo + 1 + Math.floor(rb() * 20);
        }
        const label = 'case ' + i + ' U=' + cfg.U + (cfg.forced ? ' FORCED' : '') + ' lay=' + JSON.stringify(cfg.lay) + ' [' + lo + ', ' + hi + ')';
        runCase(cfg, w, pre, lo, hi, label, i % 10 === 0, (R, dPre, dL, l, h) => {
            recorder(cfg, R);
            if (l === h) { cov.empty++; return; }
            const cF = Math.floor(l / 65536), cL = Math.floor((h - 1) / 65536);
            for (let c = cF; c <= cL; c++) { cov.k0[kindOf(dPre, c)]++; cov.k1[kindOf(dL, c)]++; }
            if (cF !== cL) cov.cross++; else cov.single++;
            for (let c = cF; c <= cL; c++) {
                const lc = Math.max(l, c * 65536), hc = Math.min(h, (c + 1) * 65536);
                if (hc - lc === 65536) { cov.covered++; break; }
            }
            if (cF !== cL && (l % 65536 !== 0) && (h % 65536 !== 0)) cov.partial2++;
            if (l === 0) cov.loZero++;
            if (h === cfg.U) cov.hiU++;
            if (l % 65536 <= 1 || l % 65536 === 65535 || h % 65536 <= 1 || h % 65536 === 65535) cov.edge++;
        });
    }
});

// Floors = 0.8 x the minimum over 9 seeds (0 / 7 / 12345 / 99 / 4242 / 31337 / 5 / 777 / 2024) measured on the REAL engine (G3-B2b
// final pass, c44c3dd / f9e7f613) from the BUILT sets (.paged / _pSh) and the pre-state / add-loop-twin kinds (C-25).
const FLOORS = { k0: [41, 71, 48, 39, 36, 32, 25, 28], k1: [0, 35, 27, 20, 32, 79, 106, 20], cases: 400, direct: 98, realPaged: 74, forced: 147, pb15: 72,
    covered: 62, cross: 61, single: 210, loZero: 17, hiU: 43, empty: 16, partial2: 28, tail: 73, edge: 140 };
test('RoaringRange A-3 coverage floors: kinds 0..7 before, 1..7 after, layouts, bound shapes', () => {
    console.log('# RoaringRange coverage: k0 ' + JSON.stringify(cov.k0) + ' k1 ' + JSON.stringify(cov.k1) + ' cases ' + cov.cases + ' direct ' + cov.direct +
        ' realPaged ' + cov.realPaged + ' forced ' + cov.forced + ' pb15 ' + cov.pb15 + ' pbSeen ' + JSON.stringify([...cov.pbSeen].sort((a, b) => a - b)) +
        ' covered ' + cov.covered + ' cross ' + cov.cross + ' single ' + cov.single + ' loZero ' + cov.loZero + ' hiU ' + cov.hiU + ' empty ' + cov.empty +
        ' partial2 ' + cov.partial2 + ' tail ' + cov.tail + ' edge ' + cov.edge);
    for (let k = 0; k < 8; k++) {
        assert.ok(cov.k0[k] >= FLOORS.k0[k], 'pre kind ' + KIND_NAMES[k] + ' touched ' + cov.k0[k]);
        assert.ok(cov.k1[k] >= FLOORS.k1[k], 'post kind ' + KIND_NAMES[k] + ' produced ' + cov.k1[k]);
    }
    for (const f of ['cases', 'direct', 'realPaged', 'forced', 'pb15', 'covered', 'cross', 'single', 'loZero', 'hiU', 'empty', 'partial2', 'tail', 'edge']) {
        assert.ok(cov[f] >= FLOORS[f], f + ' = ' + cov[f] + ' < floor ' + FLOORS[f]);
    }
    for (const pb of [3, 8, 14, 15]) assert.ok(cov.pbSeen.has(pb), 'pageBits ' + pb + ' never built');
});

// ---- fixed rows ----
const D20 = { U: 1 << 20, lay: null };
const P8 = { U: U32, lay: [4, 8] };
const F20 = { U: 1 << 20, lay: [1, 15], forced: true };
const keysRange = (a, b) => { const o = []; for (let x = a; x < b; x++) o.push(x); return o; };

test('RoaringRange fixed: single key, single chunk, chunk-aligned, cross-chunk, tail (hand-derived kinds)', () => {
    for (const cfg of [D20, P8, F20, { U: 1 << 20, lay: [8, 1], forced: true }]) {
        const tag = JSON.stringify(cfg.lay) + (cfg.forced ? 'F' : '');
        // n = 1 -> SINGLE (S-3 fixed rule)
        let r = runCase(cfg, 0, [], 5, 6, 'single ' + tag, true);
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'single', count: 1, runs: 0 }]);
        // one aligned chunk -> FULL, 65536 keys (fully covered)
        r = runCase(cfg, 0, [], 65536, 131072, 'aligned ' + tag, true);
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 1, kind: 'full', count: 65536, runs: 0 }]);
        assert.equal(r.R.size, 65536);
        // 3 keys on each side of a chunk edge: n = 3 each -> small (n <= 64, small slot free)
        r = runCase(cfg, 0, [], 65536 - 3, 65536 + 3, 'cross ' + tag, true);
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'small', count: 3, runs: 0 }, { chunk: 1, kind: 'small', count: 3, runs: 0 }]);
        assert.equal(r.R.size, 6);
        // 3 chunks: partial / full / partial. n = 4096 -> array; n = 65536 full; 5000 -> runs (1 run, bitmap-class: r <= 2047)
        r = runCase(cfg, 0, [], 65536 - 4096, 2 * 65536 + 5000, 'three ' + tag, true);
        const ch = r.R.dump().chunks;
        assert.equal(ch.length, 3);
        // S-3 step 2 (hand): chunk 0 holds ONE run of 4096 keys: K' array (n <= 4096); 2r = 2 < 4096 and r = 1 <= 32 with a free
        // small slot -> smallRuns. Chunk 1 is covered -> full. Chunk 2: 5000 keys, K' bitmap, r = 1 <= 2047 -> smallRuns.
        assert.deepEqual(ch[0], { chunk: 0, kind: 'smallRuns', count: 4096, runs: 1 });
        assert.deepEqual(ch[1], { chunk: 1, kind: 'full', count: 65536, runs: 0 });
        assert.deepEqual(ch[2], { chunk: 2, kind: 'smallRuns', count: 5000, runs: 1 });
        assert.equal(r.R.size, 4096 + 65536 + 5000);
    }
    // the non-aligned U's last chunk is never covered: [0, U) at U = 2^17 + 3 -> full, full, small(3)
    for (const cfg of [{ U: 131075, lay: null }, { U: 131075, lay: [2, 1], forced: true }, { U: 131075, lay: [1, 15], forced: true }]) {
        const r = runCase(cfg, 0, [], 0, 131075, 'tail ' + JSON.stringify(cfg.lay), true);
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'full', count: 65536, runs: 0 }, { chunk: 1, kind: 'full', count: 65536, runs: 0 },
            { chunk: 2, kind: 'small', count: 3, runs: 0 }]);
        assert.equal(r.R.size, 131075);
    }
    // D = 1: [0, 65536) covers the whole universe
    const one = runCase({ U: 65536, lay: null }, 0, [], 0, 65536, 'D=1', true);
    assert.deepEqual(one.R.dump().chunks, [{ chunk: 0, kind: 'full', count: 65536, runs: 0 }]);
});

// every existing kind 1..7 as the old container, over ranges inside / at the edge / covering / crossing / ending at the chunk end
const KIND_BUILD = {
    1: () => keysRange(70000, 70010).concat([80000, 90000]),                          // 12 keys -> small
    2: () => { const o = []; for (let i = 0; i < 500; i++) o.push(65536 + ((i * 131) % 65536)); return o; },   // ~500 keys -> array
    3: () => { const o = []; for (let i = 0; i < 9000; i++) o.push(65536 + ((i * 7) % 65536)); return o; },     // ~9000 keys -> bitmap
    4: () => { const o = []; for (let q = 0; q < 50; q++) for (let i = 0; i < 20; i++) o.push(65536 + q * 1100 + i); return o; },   // 50 runs -> runs
    5: () => { const o = []; for (let q = 0; q < 12; q++) for (let i = 0; i < 300; i++) o.push(65536 + q * 2700 + i); return o; }, // 12 runs -> smallRuns
    6: () => keysRange(65536, 131072),
    7: () => [65536 + 777],
};
test('RoaringRange fixed: every existing container kind 1..7 under inside / edge / covering / crossing / end ranges', () => {
    const hit = new Array(8).fill(0);
    for (const cfg of [D20, P8, F20]) {
        for (let k = 1; k <= 7; k++) {
            const pre = KIND_BUILD[k]();
            const base = 65536;
            const ranges = [[base + 10, base + 20], [base - 1, base + 1], [base, base + 65536], [base + 65000, base + 66000], [base + 65535, base + 65536],
                [base + 777, base + 778], [base + 700, base + 800], [base + 30000, base + 30000 + 4100], [base - 2000, base + 2000], [base + 60000, base + 65536 + 1]];
            ranges.forEach(([lo, hi], j) => {
                const label = 'kind ' + k + ' ' + JSON.stringify(cfg.lay) + ' row ' + j + ' [' + lo + ', ' + hi + ')';
                const r = runCase(cfg, 0, pre, lo, hi, label, j === 2);
                assert.equal(kindOf(r.dPre, 1), k, label + ' pre-state is the intended kind');
                hit[kindOf(r.dPre, 1)]++;
            });
        }
    }
    for (let k = 1; k <= 7; k++) assert.ok(hit[k] >= 25, 'kind ' + KIND_NAMES[k] + ' rows ' + hit[k]);
});

test('RoaringRange fixed: runs at cap (32 smallRuns / 2048 runs) with an isolated first key (S-3 nr rule, hand-derived)', () => {
    for (const cfg of [D20, P8, F20]) {
        const tag = JSON.stringify(cfg.lay);
        // 32 runs of 3 keys at 100q.. : n0 = 96, 2r = 64 < 96, r <= 32 -> smallRuns, r0 = 32
        const sr = []; for (let q = 0; q < 32; q++) for (let i = 0; i < 3; i++) sr.push(100 * q + i);
        let r = runCase(cfg, 0, sr.slice(), 3250, 3252, 'smallRuns cap nr ' + tag, true);
        assert.deepEqual(r.dPre.chunks, [{ chunk: 0, kind: 'smallRuns', count: 96, runs: 32 }]);
        // I = {3250, 3251}: isolated (3249, 3252 absent): r = 33 (> 32, so never smallRuns), n = 98, 2r = 66 < 98 -> runs
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'runs', count: 98, runs: 33 }]);
        // the same cap, I extends an existing run (not isolated): r stays 32, n = 98 -> smallRuns
        r = runCase(cfg, 0, sr.slice(), 3103, 3105, 'smallRuns cap extend ' + tag, true);
        // run 31 is 3100..3102; [3103, 3105) extends it: r = 32, n = 98 -> smallRuns count 98 runs 32
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'smallRuns', count: 98, runs: 32 }]);
        // I = {3097, 3098, 3099} touches run 31 (3100..3102) from the left: merged (b1 = b + 1), r stays 32, n = 99 -> smallRuns
        r = runCase(cfg, 0, sr.slice(), 3097, 3100, 'smallRuns cap left-merge ' + tag, true);
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'smallRuns', count: 99, runs: 32 }]);
        // 2048 runs of 3 keys at 32q.. : n0 = 6144, r0 = 2048 -> runs
        // (2047 runs optimize to 'runs'; a bitmap with 2048 runs would stay a bitmap, so the 2048th run is added after the passes)
        const rr = []; for (let q = 0; q < 2047; q++) for (let i = 0; i < 3; i++) rr.push(32 * q + i);
        const post = [32 * 2047, 32 * 2047 + 1, 32 * 2047 + 2];
        r = runCase(cfg, 0, rr.slice(), 32 * 5 + 10, 32 * 5 + 12, 'runs cap nr ' + tag, true, null, post);
        assert.deepEqual(r.dPre.chunks, [{ chunk: 0, kind: 'runs', count: 6144, runs: 2048 }]);
        // r = 2049 > 2047: bitmap-class stays bitmap (K': r0 = 2048 and nr, n0 >= 4095 -> bitmap; step 2 r > 2047 -> bitmap)
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'bitmap', count: 6146, runs: 0 }]);
        // the 2048 cap, I extends a run: r = 2048, n = 6146 -> stays runs
        r = runCase(cfg, 0, rr.slice(), 32 * 5 + 3, 32 * 5 + 5, 'runs cap extend ' + tag, true, null, post);
        assert.deepEqual(r.R.dump().chunks, [{ chunk: 0, kind: 'runs', count: 6146, runs: 2048 }]);
    }
});

test('RoaringRange boundaries: lo === hi (also 2^32) returns this and reads nothing; lo = 0; hi = 2^32', () => {
    const pre = keysRange(10, 14).concat([70000]);
    for (const cfg of [{ U: U32, lay: null }, { U: U32, lay: [4, 8] }, { U: U32, lay: [2, 15], forced: true }, { U: 1 << 20, lay: null }]) {
        const s = mk(cfg);
        for (const x of pre) s.add(x);
        const before = fullSnap(s);
        const ends = [0, 1, 123, 65536, cfg.U - 1, cfg.U];
        for (const e of ends) {
            assert.equal(s.addRange(e, e), s, 'lo === hi === ' + e + ' returns this');
            assert.equal(fullSnap(s), before, 'lo === hi === ' + e + ' changed the set');
        }
        // an empty set too (2^32: `lo >>> 16` would wrap to 0 if the early return were missing)
        const e0 = mk(cfg);
        const d0 = fullSnap(e0);
        assert.equal(e0.addRange(cfg.U, cfg.U), e0);
        assert.equal(fullSnap(e0), d0, 'U,U on an empty set');
        assert.equal(e0.size, 0);
    }
    // lo = 0 with hi at 1 / 65536 / 65537 (identity engine), and hi = U for several U
    for (const [hi, tag] of [[1, 'single'], [65536, 'full'], [65537, 'full+single'], [70000, 'cross']]) {
        runCase(D20, 0, pre, 0, hi, 'lo=0 ' + tag, true);
    }
    runCase({ U: 1 << 20, lay: null }, 12, [12 * 65536 + 5, 15 * 65536 + 9], 12 * 65536 + 100, 1 << 20, 'hi=U 2^20', true);
    runCase({ U: U32, lay: null }, 65532, [65535 * 65536 + 1], 65535 * 65536 + 10, U32, 'hi=2^32 tail window', true);
    runCase({ U: U32, lay: [4, 8] }, 65532, [], 65532 * 65536 + 3, U32, 'hi=2^32 paged window', false);
});

test('RoaringRange fixed: addRange(0, 2^32) on a direct 2^32 set -> size 2^32, 65,536 full chunks, byteLength unchanged', () => {
    const s = new RoaringSet(U32);
    const bl = s.byteLength;
    assert.equal(s.addRange(0, U32), s);
    assert.equal(s.size, 4294967296);                                // hand: 65,536 chunks x 65,536 keys
    const d = s.dump();
    assert.equal(d.size, 4294967296);
    assert.equal(d.chunks.length, 65536);
    let bad = 0;
    for (let c = 0; c < 65536; c++) { const e = d.chunks[c]; if (e.chunk !== c || e.kind !== 'full' || e.count !== 65536 || e.runs !== 0) bad++; }
    assert.equal(bad, 0, 'chunks that are not exact full rows');
    assert.equal(s.byteLength, bl, 'byteLength moved');
    assert.equal(s.has(0), true); assert.equal(s.has(U32 - 1), true); assert.equal(s.has(2147483648), true);
});

test('RoaringRange fixed: addRange over a whole forced-paged universe (pb15, 2^20): every chunk full', () => {
    const s = new FORCED(1 << 20, 1024, 256, 1, 15);
    assert.equal(s.paged, true);
    s.addRange(0, 1 << 20);
    assert.equal(s.size, 1 << 20);
    const d = s.dump();
    assert.equal(d.chunks.length, 16);
    assert.ok(d.chunks.every((e, c) => e.chunk === c && e.kind === 'full' && e.count === 65536 && e.runs === 0));
});

// ---- A-4 / bad bounds ----
const BAD = [[NaN, 5], [5, NaN], [NaN, NaN], ['1', 5], [1, '5'], [0.5, 3], [1, 3.5], [-1, 3], [-1, -1], [9, 3], [undefined, 3], [3, undefined],
    [Infinity, Infinity], [0, Infinity], [-Infinity, 0], [2 ** 53, 2 ** 53], [2 ** 53, 2 ** 53 + 2], [null, 3], [3, null], [true, 1], [1n, 2n], [{}, 3], [[], 3]];
test('RoaringRange A-4 bad bounds: RangeError, nothing mutated, on both layouts and for U + 1', () => {
    for (const cfg of [D20, P8, F20, { U: 131075, lay: null }]) {
        const s = mk(cfg);
        for (const x of keysRange(100, 130).concat([65536 + 5, 70000, 131073])) s.add(x);
        s.runOptimize();
        const before = fullSnap(s);
        const U = cfg.U;
        const cases = BAD.concat([[0, U + 1], [U + 1, U + 1], [U, U + 1], [U + 1, U + 2], [U - 1, U + 1], [1, 0]]);
        for (const [lo, hi] of cases) {
            assert.throws(() => s.addRange(lo, hi), (e) => e instanceof RangeError && /addRange bounds must be integers/.test(e.message), 'addRange(' + String(lo) + ', ' + String(hi) + ') U=' + U);
            assert.equal(fullSnap(s), before, 'addRange(' + String(lo) + ', ' + String(hi) + ') mutated the set');
        }
        assert.throws(() => s.addRange(), (e) => e instanceof RangeError && /addRange bounds must be integers/.test(e.message), 'no arguments');
        assert.equal(fullSnap(s), before, 'no arguments mutated');
    }
});

const POOL_RE = /RoaringSet small\/large container pool exhausted \(capacity \d+\)/;
test('RoaringRange A-4 (a): large-pool exhaustion is all-or-nothing (C-4 text), then a smaller range succeeds', () => {
    // U 2^20, maxSmall 0, maxLarge 1: [3*65536 - 5000, 3*65536 + 5000) needs one large slot in chunk 2 (5000 keys) and one in chunk 3
    // (5000 keys): 2 large slots, the pool holds 1. Precount (S-4): sA = 0 so the text names small/large; set unchanged.
    for (const forced of [false, true]) {
        const C = forced ? FORCED : RoaringSet;
        const s = forced ? new C(1 << 20, 0, 1, 1, 15) : new C(1 << 20, 0, 1);
        s.add(7);
        const before = fullSnap(s), size0 = s.size;
        assert.throws(() => s.addRange(3 * 65536 - 5000, 3 * 65536 + 5000), (e) => e instanceof RangeError && POOL_RE.test(e.message));
        assert.equal(fullSnap(s), before, 'set changed by a failed addRange (forced=' + forced + ')');
        assert.equal(s.size, size0);
        assert.equal(s.has(3 * 65536 - 1), false, 'first-chunk half written (best-effort)');
        assert.equal(s.has(3 * 65536), false);
        // a 5,000-key range in chunk 9 succeeds: K' bitmap, r = 1 <= 2047, no small slot (maxSmall 0) -> runs
        s.addRange(9 * 65536 + 100, 9 * 65536 + 5100);
        assert.equal(s.size, size0 + 5000);
        const e = s.dump().chunks.find((x) => x.chunk === 9);
        assert.deepEqual(e, { chunk: 9, kind: 'runs', count: 5000, runs: 1 });
        assert.equal(s.has(9 * 65536 + 100), true); assert.equal(s.has(9 * 65536 + 5099), true); assert.equal(s.has(9 * 65536 + 5100), false);
    }
    // a free small slot class (maxSmall 4): S-3 s = true, both chunks end smallRuns (2 small, 0 large): the call SUCCEEDS
    const t = new RoaringSet(1 << 20, 4, 1);
    t.addRange(3 * 65536 - 5000, 3 * 65536 + 5000);
    assert.equal(t.size, 10000);
    assert.deepEqual(t.dump().chunks, [{ chunk: 2, kind: 'smallRuns', count: 5000, runs: 1 }, { chunk: 3, kind: 'smallRuns', count: 5000, runs: 1 }]);
    // the large pool alone (text without 'small/'): maxSmall 4, maxLarge 1. Chunk 5 (100 scattered keys) takes the one large slot;
    // [1000, 1030) turns chunk 0's 40 scattered keys + 30 contiguous into a large-class container: a second large slot (ruled
    // by the engine review, gate 7 (a)).
    const u = new RoaringSet(1 << 20, 4, 1);
    for (let i = 0; i < 40; i++) u.add(i * 3);
    for (let i = 0; i < 100; i++) u.add(5 * 65536 + i * 3);
    const ub = fullSnap(u);
    // premise: the equivalent add loop on a twin throws the same large-pool text part-way (addRange sizes the final state only)
    const ul = new RoaringSet(1 << 20, 4, 1);
    for (let i = 0; i < 40; i++) ul.add(i * 3);
    for (let i = 0; i < 100; i++) ul.add(5 * 65536 + i * 3);
    assert.throws(() => { for (let x = 1000; x < 1030; x++) ul.add(x); }, (e) => e instanceof RangeError && /large container pool exhausted \(capacity 1\)/.test(e.message));
    assert.throws(() => u.addRange(1000, 1030), (e) => e instanceof RangeError && /RoaringSet large container pool exhausted \(capacity 1\)/.test(e.message));
    assert.equal(fullSnap(u), ub);
});

test('RoaringRange A-4 (a2): covered chunks return their slot before the partial chunks are counted (S-4 step 3)', () => {
    // maxLarge 1 held by chunk 4 (an array of 300 keys). [4*65536, 5*65536 + 5000): chunk 4 becomes FULL (slot back),
    // chunk 5 takes it for 5000 keys. Only succeeds if the precount credits the covered chunk's slot.
    const s = new RoaringSet(1 << 20, 0, 1);
    for (let i = 0; i < 300; i++) s.add(4 * 65536 + i * 3);
    assert.equal(s.dump().chunks[0].kind, 'array');
    s.addRange(4 * 65536, 5 * 65536 + 5000);
    assert.equal(s.size, 65536 + 5000);
    assert.deepEqual(s.dump().chunks, [{ chunk: 4, kind: 'full', count: 65536, runs: 0 }, { chunk: 5, kind: 'runs', count: 5000, runs: 1 }]);
    // and a conversion class change is counted: an array chunk (large) gets 20 more keys that stay array: no extra slot needed
    const t = new RoaringSet(1 << 20, 0, 1);
    for (let i = 0; i < 300; i++) t.add(i * 3);
    t.addRange(2000, 2020);
    assert.equal(t.size, 320);
    assert.equal(t.dump().chunks[0].kind, 'array');
});

test('RoaringRange A-4 (b): page-pool exhaustion (paged pb4, maxPages 2) -> the page error, set unchanged, then adds succeed', () => {
    const PAGE_RE = /RoaringSet addRange metadata page pool exhausted \(needs \d+ new pages?, \d+ free of maxPages 2\)/;
    for (const forced of [false, true]) {
        const C = forced ? FORCED : RoaringSet;
        // pb4: pages of 16 chunks. Range [15*65536 + 5, 33*65536 + 5) touches pages 0, 1, 2 (chunks 15, 16..32, 33): 3 absent pages, 2 free.
        const s = forced ? new C(U32, 1024, 256, 2, 4) : new RoaringSet(U32, 1024, 256, 2, 4);
        assert.equal(s.paged, true);
        const before = fullSnap(s);
        assert.throws(() => s.addRange(15 * 65536 + 5, 33 * 65536 + 5), (e) => e instanceof RangeError && PAGE_RE.test(e.message));
        assert.equal(fullSnap(s), before, 'page failure mutated the set');
        assert.equal(s.size, 0);
        assert.equal(s.has(15 * 65536 + 5), false, 'first page half written (best-effort)');
        // adds on 2 new pages succeed afterwards (the pool was not leaked by the failed call)
        s.add(5); s.add(16 * 65536 + 9);
        assert.equal(s.size, 2);
        // a range over the two present pages succeeds; one more absent page fails with the set unchanged
        const mid = fullSnap(s);
        s.addRange(10, 20 * 65536);
        assert.equal(s.size, 20 * 65536 - 10 + 1);                  // [10, 20*65536) plus the key 5 outside it
        const after = fullSnap(s);
        assert.notEqual(after, mid);
        assert.throws(() => s.addRange(32 * 65536, 32 * 65536 + 3), (e) => e instanceof RangeError && PAGE_RE.test(e.message));
        assert.equal(fullSnap(s), after);
    }
    // 3 absent pages needed, 2 present free: pNeed counts COVERED chunks' pages too (all-covered range, no partial chunk)
    const t = new RoaringSet(U32, 1024, 256, 2, 4);
    const tb = fullSnap(t);
    assert.throws(() => t.addRange(0, 48 * 65536), (e) => e instanceof RangeError && PAGE_RE.test(e.message)); // needs 3 new pages, 2 free
    assert.equal(fullSnap(t), tb);
    t.addRange(0, 32 * 65536);                                        // exactly 2 pages: succeeds
    assert.equal(t.size, 32 * 65536);
    assert.equal(t.dump().chunks.length, 32);
});

test('RoaringRange S-3 rows: runs at cap 2048 with n <= 4096 -> array (erratum branch); covered smallRuns / runs return their slot', () => {
    // (A) 2047 runs of 3 at 32q optimize to 'runs'; a 2048th run is added, then keys deleted so n0 = 4094 (hand: 6144 - 2048 - 2),
    // r0 = 2048. I = {170}: isolated (169, 171 absent) -> r = 2049, n = 4095 <= 4096, n0 < 4095: K' array (S-3 k0 = runs); step 2
    // array: 2r = 4098 >= n -> array stays. Count 4095, runs 0.
    const build = (S) => {
        for (let q = 0; q < 2047; q++) for (let i = 0; i < 3; i++) S.add(32 * q + i);
        for (let i = 0; i < 3; i++) { S.runOptimize(); }
        for (let i = 0; i < 3; i++) S.add(32 * 2047 + i);
        for (let q = 0; q < 2048; q++) S.delete(32 * q + 2);
        S.delete(32 * 2047 + 1); S.delete(32 * 2046 + 1);
    };
    const R = new RoaringSet(1 << 20), L = new RoaringSet(1 << 20);
    build(R); build(L);
    assert.deepEqual(R.dump().chunks, [{ chunk: 0, kind: 'runs', count: 4094, runs: 2048 }]);
    R.addRange(170, 171);
    L.add(170); L.runOptimize();
    assert.deepEqual(R.dump().chunks, [{ chunk: 0, kind: 'array', count: 4095, runs: 0 }]);
    sameDump(R.dump(), L.dump(), 'A: R vs add loop');
    assert.equal(R.size, 4095);
    // (C) covered smallRuns returns its SMALL slot: maxSmall 1 / maxLarge 1; chunk 4 smallRuns (3 runs of 30) holds the small slot,
    // chunk 8 an array holds the large slot; [4*65536, 5*65536 + 10): chunk 4 FULL (small slot back), chunk 5 takes it for 10 keys -> small.
    const c = new RoaringSet(1 << 20, 1, 1);
    for (let q = 0; q < 3; q++) for (let i = 0; i < 30; i++) c.add(4 * 65536 + 100 * q + i);
    c.runOptimize();
    assert.deepEqual(c.dump().chunks, [{ chunk: 4, kind: 'smallRuns', count: 90, runs: 3 }]);
    for (let i = 0; i < 100; i++) c.add(8 * 65536 + 3 * i);
    c.addRange(4 * 65536, 5 * 65536 + 10);
    assert.deepEqual(c.dump().chunks, [{ chunk: 4, kind: 'full', count: 65536, runs: 0 }, { chunk: 5, kind: 'small', count: 10, runs: 0 },
        { chunk: 8, kind: 'array', count: 100, runs: 0 }]);
    // (D) covered runs returns its LARGE slot: maxSmall 0 / maxLarge 1; chunk 4 runs (50 runs of 20); chunk 5 gets 5000 keys -> runs.
    const d = new RoaringSet(1 << 20, 0, 1);
    for (let q = 0; q < 50; q++) for (let i = 0; i < 20; i++) d.add(4 * 65536 + 1100 * q + i);
    d.runOptimize();
    assert.deepEqual(d.dump().chunks, [{ chunk: 4, kind: 'runs', count: 1000, runs: 50 }]);
    d.addRange(4 * 65536, 5 * 65536 + 5000);
    assert.deepEqual(d.dump().chunks, [{ chunk: 4, kind: 'full', count: 65536, runs: 0 }, { chunk: 5, kind: 'runs', count: 5000, runs: 1 }]);
});
