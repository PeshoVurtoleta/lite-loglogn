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
 *   set byte-identical (fullSnap before == after: dump() plus every own scalar field and typed array, so a throw
 *   after any write shows). (a2) / (a3): S-4 step 3, a covered chunk returns its slot before the partials count.
 * C-25: layout coverage is counted on the BUILT sets (.paged / _pSh) and asserted against expectPaged (C-5 closed form).
 * C-9 (G4-B2b): after every addRange in runCase and fixpointStream, wbError checks every live chunk's _card / _cMin /
 *   _cMax / _runs against its decoded content and every bitmap's L1 / L2 summary bit-exactly (+ the membership model
 *   in runCase and at fixpointStream's walk cadence), every row the top pyramid does not reach (kind 0) and a paged
 *   set's zero page (all zero); its must-fail controls corrupt one L2 bit, one L1 bit, one _cMax, one _cMin, one
 *   _card, one _runs, the kind (unknown -> fail closed), one model bit, a non-live row's kind, a non-live row's _runs,
 *   one zero-page field (paged), one free-page _cMin (paged) and a run chunk shrunk to 1 key (want SINGLE).
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

// ---- white-box header + summary oracle (G4-B2b, SPEC C-9) ----
// The G4-B2 shrink removed every -1 fall-through of successor / predecessor / _bmpNextGEQ / _bmpPrevLEQ: they now
// trust I-hdr (_cMin / _cMax are the chunk's first / last key), I-bmp (a bitmap holds > 2,048 keys) and I-sum (the
// bitmap summary is exact). A broken header or summary gives a WRONG answer, not a miss, so every addRange stream
// here checks them against the CONTENT (decoded per kind, never from the engine's own headers), and against the
// membership model where one is in scope. Checked: every live chunk of the top pyramid (as dump() walks it); a kind
// outside 1..7 fails closed; _card + 1 == the content's key count; _cMin / _cMax == its first / last key; _runs + 1
// bounds the decoded runs (kinds 4 / 5: sorted, disjoint, non-adjacent, inside the chunk, within the kind's cap,
// >= 2 keys: one key is a SINGLE, as checkSet); kinds 1 / 2 strictly increasing within the kind's cap; kind 3:
// > 2,048 keys, L1 bit j of word s iff bitmap word 32s + j != 0, L2 bit s iff L1 word s != 0 (bit-exact); the live
// keys sum to size; a kind without runs (1 / 2 / 3 / 6 / 7) reads _runs 0. Every chunk the pyramid does NOT reach
// reads _kind / _card / _runs 0 (an emptied row keeps _slot / _cMin / _cMax stale by design, never read, while
// _kind / _card / _runs read 0: the _pageZero contract), a paged set's shared zero page (rows 0 .. 2^pageBits - 1,
// what every absent page maps to) is zero in every header field, and so is every free page (_pFree[0, _pTop)).
// With a model (flags over
// [wBase, wBase + flags.length), wBase chunk-aligned) every window chunk's count / min / max equals the model's, a
// live chunk outside the window or a model-filled chunk that is not live fails.
const WB = { checks: 0, chunks: 0, bitmaps: 0, bmpZeroWord: 0, model: 0, zeroPage: 0 };
const pop32 = (v) => {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return Math.imul((v + (v >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
};
function wbError(r, flags, wBase) {
    WB.checks++;
    const c0 = flags ? wBase / 65536 : 0, c1 = flags ? Math.ceil((wBase + flags.length) / 65536) : 0;
    let total = 0;
    const live = new Set();
    for (let c = r._nextChunk(0); c >= 0; c = r._nextChunk(c + 1)) {
        WB.chunks++;
        live.add(c);
        const m = r._mi(c), k = r._kind[m], slot = r._slot[m];
        const at = 'chunk ' + c + ' kind ' + k + ': ';
        let n = 0, mn = -1, mx = -1;
        if (k === 1 || k === 2) {
            const a = k === 1 ? r._sData : r._lU16, b = k === 1 ? slot << 6 : slot << 12;
            n = r._card[m] + 1;
            if (!(n >= 2 && n <= (k === 1 ? 64 : 4096))) return at + 'count ' + n + ' outside the kind';
            for (let i = 1; i < n; i++) if (!(a[b + i] > a[b + i - 1])) return at + 'keys not increasing at #' + i;
            mn = a[b]; mx = a[b + n - 1];
        } else if (k === 4 || k === 5) {
            const a = k === 5 ? r._sData : r._lU16, b = k === 5 ? slot << 6 : slot << 12, R = r._runs[m] + 1;
            if (!(R >= 1 && R <= (k === 5 ? 32 : 2048))) return at + 'runs ' + R + ' outside the kind';
            let end = -2;
            for (let i = 0; i < R; i++) {
                const st = a[b + 2 * i], en = st + a[b + 2 * i + 1];
                if (!(st > end + 1)) return at + 'run #' + i + ' starts ' + st + ' at or next to the previous end ' + end;
                if (!(en <= 65535)) return at + 'run #' + i + ' ends ' + en + ' past the chunk';
                n += en - st + 1;
                end = en;
            }
            if (n === 1) return at + 'holds 1 key (want SINGLE)';
            mn = a[b]; mx = end;
        } else if (k === 3) {
            WB.bitmaps++;
            const u32 = r._lU32, sum = r._bSum, wb = slot << 11, sb = slot * 66;
            let l2a = 0, l2b = 0, zw = 0;
            for (let s1 = 0; s1 < 64; s1++) {
                let m1 = 0;
                for (let j = 0; j < 32; j++) {
                    const w = (s1 << 5) | j, v = u32[wb + w];
                    if (v === 0) { zw = 1; continue; }
                    m1 |= 1 << j;
                    n += pop32(v);
                    if (mn < 0) mn = (w << 5) | (31 - Math.clz32(v & -v));
                    mx = (w << 5) | (31 - Math.clz32(v));
                }
                if ((sum[sb + s1] | 0) !== m1) return at + 'L1 word ' + s1 + ' ' + (sum[sb + s1] >>> 0).toString(16) + ' vs content ' + (m1 >>> 0).toString(16);
                if (m1 !== 0) { if (s1 < 32) l2a |= 1 << s1; else l2b |= 1 << (s1 - 32); }
            }
            if ((sum[sb + 64] | 0) !== l2a || (sum[sb + 65] | 0) !== l2b) {
                return at + 'L2 ' + (sum[sb + 64] >>> 0).toString(16) + '/' + (sum[sb + 65] >>> 0).toString(16) + ' vs content ' + (l2a >>> 0).toString(16) + '/' + (l2b >>> 0).toString(16);
            }
            if (!(n > 2048)) return at + n + ' keys (I-bmp: a bitmap holds > 2,048)';
            WB.bmpZeroWord += zw;                                   // a zero word was checked: its L1 bit must read 0
        } else if (k === 6) {
            n = 65536; mn = 0; mx = 65535;
        } else if (k === 7) {
            n = 1; mn = slot; mx = slot;
            if (!(slot <= 65535)) return at + 'SINGLE key ' + slot;
        } else {
            return at + 'unknown kind (fail closed)';
        }
        if (k !== 4 && k !== 5 && r._runs[m] !== 0) return at + '_runs ' + r._runs[m] + ' on a kind without runs (want 0)';
        if (r._card[m] + 1 !== n) return at + '_card + 1 = ' + (r._card[m] + 1) + ' vs content ' + n;
        if (r._cMin[m] !== mn) return at + '_cMin ' + r._cMin[m] + ' vs content ' + mn;
        if (r._cMax[m] !== mx) return at + '_cMax ' + r._cMax[m] + ' vs content ' + mx;
        total += n;
        if (flags) {
            if (!(c >= c0 && c < c1)) return at + 'live outside the model window';
            const o = c * 65536 - wBase, top = Math.min(o + 65536, flags.length);
            let fn = 0, fmn = -1, fmx = -1;
            for (let i = o; i < top; i++) if (flags[i] !== 0) { fn++; if (fmn < 0) fmn = i - o; fmx = i - o; }
            if (fn !== n || fmn !== mn || fmx !== mx) return at + 'content ' + n + ' keys ' + mn + '..' + mx + ' vs model ' + fn + ' keys ' + fmn + '..' + fmx;
        }
    }
    if (total !== r.size) return 'live chunks hold ' + total + ' keys vs size ' + r.size;
    for (let c = 0; c < r._chunks; c++) {
        if (live.has(c)) continue;
        const m = r._mi(c), k = r._kind[m];
        if ((k | r._card[m] | r._runs[m]) !== 0) return 'chunk ' + c + ' not live (top pyramid) but kind ' + k + ' card ' + r._card[m] + ' runs ' + r._runs[m];
    }
    if (r._pSh !== 0) {
        WB.zeroPage++;
        for (let m = 0; m < 1 << r._pSh; m++) {
            if ((r._kind[m] | r._slot[m] | r._card[m] | r._runs[m] | r._cMin[m] | r._cMax[m]) !== 0) {
                return 'zero page row ' + m + ' written: kind ' + r._kind[m] + ' slot ' + r._slot[m] + ' card ' + r._card[m] + ' runs ' + r._runs[m] +
                    ' cMin ' + r._cMin[m] + ' cMax ' + r._cMax[m];
            }
        }
        // every free page (_pFree[0, _pTop)) is all zero in all 6 arrays: _pageZero resets _slot / _cMin / _cMax on release,
        // and _kind / _card / _runs already read 0 on every emptied row
        for (let q = 0; q < r._pTop; q++) {
            const pg = r._pFree[q], b0 = pg << r._pSh, e0 = b0 + (1 << r._pSh);
            for (let m = b0; m < e0; m++) {
                if ((r._kind[m] | r._slot[m] | r._card[m] | r._runs[m] | r._cMin[m] | r._cMax[m]) !== 0) return 'free page ' + pg + ' row ' + m + ' written';
            }
        }
    }
    if (flags) {
        WB.model++;
        for (let c = c0; c < c1; c++) {
            if (live.has(c)) continue;
            const o = c * 65536 - wBase, top = Math.min(o + 65536, flags.length);
            for (let i = o; i < top; i++) if (flags[i] !== 0) return 'chunk ' + c + ' not live but the model holds ' + (wBase + i);
        }
    }
    return null;
}

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
    const we = wbError(R, flags, wBase);                            // I-hdr / I-bmp / I-sum + model, after the addRange
    assert.equal(we, null, label + ' white-box after addRange: ' + we);
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

test('RoaringRange white-box controls (C-9 teeth): a corrupted L2 / L1 bit, _cMax, _cMin, _card, _runs, kind, model bit, non-live row, zero page or 1-key run chunk is reported', () => {
    const ROWS = [['direct 2^20', () => new RoaringSet(1 << 20, 64, 16), 0], ['REAL paged 2^32 pb8 mp4', () => new RoaringSet(U32, 64, 16, 4, 8), 256]];
    for (const [tag, make, wc] of ROWS) {
        const s = make();
        const w = wc * 65536;
        const flags = new Uint8Array(NW * 65536);
        const put = (x) => { s.add(x); flags[x - w] = 1; };
        const range = (lo, hi) => { s.addRange(lo, hi); for (let x = lo; x < hi; x++) flags[x - w] = 1; };
        // chunk wc: a bitmap of 20,479 keys whose words 0..127 (L1 words 0..3) are EMPTY, so a summary bit set for an
        // empty word shows; then an addRange into it far from word 0 (the bitmap path, _rangeWalk mode 2 rebuild)
        for (let x = 4099; x < 65536; x += 3) put(w + x);
        range(w + 30001, w + 30040);
        range(w + 65536 + 100, w + 65536 + 900);                            // chunk wc + 1: two runs
        range(w + 65536 + 2000, w + 65536 + 2600);
        for (const x of [5, 77, 4000]) put(w + 2 * 65536 + x);              // chunk wc + 2: a small array
        put(w + 3 * 65536 + 123);                                           // chunk wc + 3: a SINGLE
        assert.equal(s.paged, wc !== 0, tag + ' layout');
        assert.equal(wbError(s, flags, w), null, tag + ' clean set reads clean');
        const kinds = s.dump().chunks.map((e) => kindName(e.kind));
        assert.equal(kinds[0], 'bitmap', tag + ' kinds ' + kinds);
        assert.ok(kinds[1] === 'runs' || kinds[1] === 'smallRuns', tag + ' kinds ' + kinds);
        assert.equal(kinds[2], 'small', tag + ' kinds ' + kinds);
        assert.equal(kinds[3], 'single', tag + ' kinds ' + kinds);
        const mB = s._mi(wc), mR = s._mi(wc + 1), mS = s._mi(wc + 2), sb = s._slot[mB] * 66;
        // a 1-key run chunk, consistent in every header and in size (only the SINGLE rule sees it; checked without the
        // model, which would also differ): chunk wc + 1 keeps its first run's start key alone
        const kR = s._kind[mR], rA = kR === 5 ? s._sData : s._lU16, rB = kR === 5 ? s._slot[mR] << 6 : s._slot[mR] << 12;
        const one = [s._runs[mR], rA[rB + 1], s._card[mR], s._cMax[mR], s._size];
        const mN = s._mi(wc + 5), mZ = s._mi(0);                            // a non-live row; chunk 0's row (paged: the zero page)
        assert.equal(s._kind[mN], 0, tag + ' premise: chunk ' + (wc + 5) + ' not live');
        assert.equal(mZ === 0 && s._kind[mZ] === 0, wc !== 0, tag + ' premise: paged chunk 0 maps to zero page row 0');
        if (wc !== 0) assert.ok(s._pTop >= 1, tag + ' premise: >= 1 free page (pTop ' + s._pTop + ')');
        const mF = wc !== 0 ? s._pFree[0] << s._pSh : -1;                  // paged: the first row of a free page
        // [what, corrupt(), restore(), the report it must produce, check without the model]
        const CORRUPT = [
            ['run chunk shrunk to 1 key', () => { s._runs[mR] = 0; rA[rB + 1] = 0; s._card[mR] = 0; s._cMax[mR] = s._cMin[mR]; s._size -= one[2]; },
                () => { [s._runs[mR], rA[rB + 1], s._card[mR], s._cMax[mR], s._size] = one; }, /kind [45]: holds 1 key \(want SINGLE\)/, true],
            ['non-live row kind 7', () => { s._kind[mN] = 7; }, () => { s._kind[mN] = 0; }, new RegExp('chunk ' + (wc + 5) + ' not live \\(top pyramid\\) but kind 7')],
            ['non-live row _runs', () => { s._runs[mN] = 3; }, () => { s._runs[mN] = 0; }, new RegExp('chunk ' + (wc + 5) + ' not live .* runs 3$')],
            ...(wc !== 0 ? [['free page _cMin', () => { s._cMin[mF] = 1; }, () => { s._cMin[mF] = 0; }, /free page \d+ row \d+ written/]] : []),
            ...(wc !== 0 ? [['zero page _cMax', () => { s._cMax[mZ] = 9; }, () => { s._cMax[mZ] = 0; }, /zero page row 0 written: .* cMax 9$/]] : []),
            ['one L2 summary bit', () => { s._bSum[sb + 65] ^= 1 << 7; }, () => { s._bSum[sb + 65] ^= 1 << 7; }, /: L2 /],
            ['one L1 summary bit', () => { s._bSum[sb + 3] ^= 1 << 9; }, () => { s._bSum[sb + 3] ^= 1 << 9; }, /: L1 word 3 /],
            ['bitmap _cMax - 1', () => { s._cMax[mB]--; }, () => { s._cMax[mB]++; }, /kind 3: _cMax 65532 vs content 65533/],
            ['bitmap _runs 1', () => { s._runs[mB] = 1; }, () => { s._runs[mB] = 0; }, /kind 3: _runs 1 on a kind without runs \(want 0\)/],
            ['SINGLE _runs 2', () => { s._runs[s._mi(wc + 3)] = 2; }, () => { s._runs[s._mi(wc + 3)] = 0; }, /kind 7: _runs 2 on a kind without runs \(want 0\)/],
            ['small _cMin + 1', () => { s._cMin[mS]++; }, () => { s._cMin[mS]--; }, /kind 1: _cMin 6 vs content 5/],
            ['bitmap _card + 1', () => { s._card[mB]++; }, () => { s._card[mB]--; }, /kind 3: _card \+ 1 = /],
            ['runs _runs + 1', () => { s._runs[mR]++; }, () => { s._runs[mR]--; }, /kind [45]: /],
            ['kind 9 (unknown)', () => { s._kind[mR] += 9; }, () => { s._kind[mR] -= 9; }, /unknown kind \(fail closed\)/],
            ['kind 8 (one past SINGLE)', () => { s._kind[mS] = 8; }, () => { s._kind[mS] = 1; }, /kind 8: unknown kind/],
            ['model bit', () => { flags[2 * 65536 + 6] = 1; }, () => { flags[2 * 65536 + 6] = 0; }, /vs model 4 keys/],
        ];
        for (const [what, bad, undo, re, noModel] of CORRUPT) {
            bad();
            const e = wbError(s, noModel ? null : flags, noModel ? 0 : w);
            undo();
            assert.ok(e !== null && re.test(e), tag + ' control "' + what + '" not reported as ' + re + ': ' + e);
            assert.equal(wbError(s, flags, w), null, tag + ' clean again after "' + what + '"');
        }
    }
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
    // premise: an empty set with all 4 small slots and the 1 large slot free (2 large-class chunks would not fit)
    assert.deepEqual([t.size, t._sTop, t._lTop], [0, 4, 1], 'maxSmall-4 row premise: size, free small, free large');
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

test('RoaringRange S-3 row: runs at cap 2048 with n <= 4096 -> array (erratum branch)', () => {
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
});

test('RoaringRange A-4 (a3): a covered smallRuns / runs chunk returns its small / large slot before the partial chunk is counted (S-4 step 3)', () => {
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

// ---- F1 (audit cloud-zm96u9; maintainer ruling 2026-11-05): C-8's kind contract at the POST-CALL pool state ----
// The first partial chunk cF is decided before the last partial chunk cL is written; cL can return a small slot
// (a small chunk that leaves the small class), so cF must end in runOptimize()'s kind at the pool state AFTER cL.
// Oracle: runOptimize() itself (not _rangeKind): right after addRange, runOptimize() must leave every touched
// chunk's (kind, count, runs) unchanged; when it also leaves every UNtouched chunk unchanged, the pool tops
// (_sTop, _lTop) must be unchanged too. runOptimize() runs on the set itself and the stream continues from the
// optimized state (the add / delete / runOptimize / addRange mix of the audit's R2 search, xorshift32 streams).
// Also after every addRange: slot conservation (each pool's held slots + free stack (+ _conv) is a permutation of its
// slot ids, so a demotion that pops an empty pool or leaks a slot fails) and the white-box header / summary check
// (wbError, G4-B2b), and every 250 steps a full ordered walk equals a membership model of the focus window and
// wbError against that model (a demotion that copies too few runs fails; one that copies too many is pinned by the F1
// demoted-content row).

function xs32(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const SMALLK = new Set(['small', 'smallRuns']);
const LARGEK = new Set(['array', 'bitmap', 'runs']);

// null, or why the pools are inconsistent: small slots {held by small / smallRuns chunks} + _sFree[0, _sTop) must be
// exactly 0..maxS-1; large slots {held by array / bitmap / runs} + _lFree[0, _lTop) + _conv exactly 0..maxL
function poolError(r) {
    const d = r.dump();
    if (!(r._sTop >= 0 && r._lTop >= 0)) return 'pool top negative s ' + r._sTop + ' l ' + r._lTop;
    const sIds = [], lIds = [r._conv];
    for (const c of d.chunks) {
        const slot = r._slot[r._mi(c.chunk)];
        if (SMALLK.has(c.kind)) sIds.push(slot); else if (LARGEK.has(c.kind)) lIds.push(slot);
    }
    for (let i = 0; i < r._sTop; i++) sIds.push(r._sFree[i]);
    for (let i = 0; i < r._lTop; i++) lIds.push(r._lFree[i]);
    const perm = (ids, n) => ids.length === n && ids.slice().sort((x, y) => x - y).every((v, i) => v === i);
    if (!perm(sIds, r._maxS)) return 'small slots ' + JSON.stringify(sIds) + ' (maxSmall ' + r._maxS + ')';
    if (!perm(lIds, r._maxL + 1)) return 'large slots ' + JSON.stringify(lIds) + ' (maxLarge ' + r._maxL + ' + _conv)';
    return null;
}

// one seeded stream on set r over the focus chunks; returns the counters (violations listed, first 5 kept)
function fixpointStream(r, U, focus, seed, steps) {
    const random = xs32(seed);                    // the op stream
    const rkey = xs32(seed ^ 0x9E3779B9);         // the key / base / span stream (independent of the op draws)
    const out = { ranges: 0, twoPartial: 0, freed: 0, poolChecks: 0, walks: 0, wb: 0, wbModel: 0, violations: 0, first: [] };
    const w0 = focus[0] * 65536, w1 = Math.min(U, (focus[focus.length - 1] + 4) * 65536);   // model window [w0, w1)
    const flags = new Uint8Array(w1 - w0);
    const setF = (x, v) => { assert.ok(x >= w0 && x < w1, 'key ' + x + ' outside the model window'); flags[x - w0] = v; };
    const fail = (msg) => { out.violations++; if (out.first.length < 5) out.first.push(msg); };
    const byChunk = (d) => new Map(d.chunks.map((c) => [c.chunk, c.kind + ':' + c.count + ':' + c.runs]));
    for (let step = 0; step < steps; step++) {
        const base = focus[Math.floor(rkey() * focus.length)] * 65536;
        const op = random();
        try {
            if (op < 0.4) { const x = Math.min(U - 1, base + Math.floor(rkey() * (rkey() < 0.5 ? 65536 : 500))); r.add(x); setF(x, 1); }
            else if (op < 0.6) { const x = Math.min(U - 1, base + Math.floor(rkey() * (rkey() < 0.5 ? 65536 : 500))); r.delete(x); setF(x, 0); }
            else if (op < 0.68) r.runOptimize();
            else {
                let lo = base + Math.floor(rkey() * 65536);
                const span = rkey() < 0.3 ? Math.floor(rkey() * 40) : rkey() < 0.6 ? Math.floor(rkey() * 5000) : Math.floor(rkey() * 150000);
                let hi = Math.min(lo + span, U); lo = Math.min(lo, U); if (hi < lo) hi = lo;
                const pre = byChunk(r.dump());
                r.addRange(lo, hi);
                for (let x = lo; x < hi; x++) setF(x, 1);
                if (hi === lo) continue;
                const pe = poolError(r);
                if (pe !== null) fail('step ' + step + ' addRange(' + lo + ', ' + hi + ') ' + pe);
                const we = wbError(r, null, 0);                  // headers / summaries vs content, every addRange
                if (we !== null) fail('step ' + step + ' addRange(' + lo + ', ' + hi + ') white-box ' + we);
                out.wb++;
                out.ranges++;
                const cF = lo >>> 16, cL = (hi - 1) >>> 16;
                const pF = (lo & 65535) !== 0 || (cF === cL && ((hi - 1) & 65535) !== 65535);
                const pL = cL !== cF && ((hi - 1) & 65535) !== 65535;
                const d0 = r.dump();
                const before = byChunk(d0);
                if (pF && pL) {
                    out.twoPartial++;
                    // witness of the F1 scenario: cL left the small class and cF ends in small runs
                    const lPre = (pre.get(cL) || 'empty').split(':')[0], lPost = before.get(cL).split(':')[0];
                    if (SMALLK.has(lPre) && !SMALLK.has(lPost) && before.get(cF).split(':')[0] === 'smallRuns' &&
                        !SMALLK.has((pre.get(cF) || 'empty').split(':')[0])) out.freed++;
                }
                const sTop = r._sTop, lTop = r._lTop;
                r.runOptimize();
                const after = byChunk(r.dump());
                let untouchedSame = true;
                for (const [c, v] of before) {
                    const touched = c >= cF && c <= cL;
                    if (after.get(c) === v) continue;
                    if (touched) fail('step ' + step + ' addRange(' + lo + ', ' + hi + ') chunk ' + c + ': ' + v + ' -> runOptimize -> ' + after.get(c));
                    else untouchedSame = false;
                }
                if (untouchedSame) {
                    out.poolChecks++;
                    if (r._sTop !== sTop || r._lTop !== lTop) {
                        fail('step ' + step + ' addRange(' + lo + ', ' + hi + ') pool tops s ' + sTop + ' -> ' + r._sTop + ', l ' + lTop + ' -> ' + r._lTop);
                    }
                }
            }
        } catch (e) { if (!(e instanceof RangeError)) throw e; }
        if (step % 250 === 249) {
            out.walks++;
            let x = r.has(w0) ? w0 : r.successor(w0);
            let n = 0, bad = -1;
            for (let i = 0; i < flags.length; i++) {
                if (flags[i] === 0) continue;
                n++;
                if (x !== w0 + i) { bad = w0 + i; break; }
                x = r.successor(x);
            }
            if (bad < 0 && x !== undefined && x < w1) bad = x;
            if (bad >= 0 || r.size !== n) fail('step ' + step + ' model walk differs at ' + bad + ' (size ' + r.size + ' model ' + n + ')');
            const wm = wbError(r, flags, w0);                       // + the model, at the walk cadence (any op mix)
            if (wm !== null) fail('step ' + step + ' white-box vs model ' + wm);
            out.wbModel++;
        }
    }
    return out;
}

test('RoaringRange F1 fixpoint: runOptimize() right after addRange changes no touched chunk (tight pools, direct + paged)', () => {
    // [label, make(), U, focus chunks, seeds]; 2,500 steps per seed. Row 1 uses the audit R2's configuration and seed, not R2's
    // exact stream (op and key draws are split here; audit cloud-zm96u9 R2 still replays that stream).
    const ROWS = [
        ['R2 U=3c s2 l1', () => new RoaringSet(3 * 65536, 2, 1), 3 * 65536, [0, 1, 2], [2675, 11, 97]],
        ['U=3c s1 l2', () => new RoaringSet(3 * 65536, 1, 2), 3 * 65536, [0, 1, 2], [5, 2675]],
        ['U=3c s1 l1', () => new RoaringSet(3 * 65536, 1, 1), 3 * 65536, [0, 1, 2], [7, 1234]],
        ['U=3c s3 l1', () => new RoaringSet(3 * 65536, 3, 1), 3 * 65536, [0, 1, 2], [3, 4242]],
        ['U=2^20 s2 l2', () => new RoaringSet(1 << 20, 2, 2), 1 << 20, [5, 6, 7], [21, 2675]],
        ['FORCED paged 2^20 pb2 mp4 s2 l1', () => new FORCED(1 << 20, 2, 1, 4, 2), 1 << 20, [3, 4, 5], [2675, 31]],
        ['REAL paged 2^32 pb8 mp4 s2 l2', () => new RoaringSet(U32, 2, 2, 4, 8), U32, [255, 256, 257], [2675, 77]],
    ];
    const tot = { ranges: 0, twoPartial: 0, freed: 0, poolChecks: 0, walks: 0, wb: 0, wbModel: 0, violations: 0, paged: 0 };
    const msgs = [];
    for (const [label, make, U, focus, seeds] of ROWS) {
        for (const seed of seeds) {
            const r = make();
            if (label.includes('paged')) { assert.equal(r.paged, true, label + ' built paged'); tot.paged++; }
            else assert.equal(r.paged, false, label + ' built direct');
            const o = fixpointStream(r, U, focus, seed, 2500);
            for (const k of ['ranges', 'twoPartial', 'freed', 'poolChecks', 'walks', 'wb', 'wbModel', 'violations']) tot[k] += o[k];
            for (const m of o.first) msgs.push(label + ' seed ' + seed + ': ' + m);
        }
    }
    console.log('# F1 fixpoint: ' + JSON.stringify(tot));
    assert.equal(tot.violations, 0, 'fixpoint violations:\n' + msgs.join('\n'));
    // floors: the streams reach two-partial ranges, the F1 scenario itself, the pool check, and both paged rows
    assert.ok(tot.ranges >= 5000, 'ranges ' + tot.ranges);
    assert.ok(tot.twoPartial >= 1000, 'two-partial ranges ' + tot.twoPartial);
    assert.ok(tot.freed >= 10, 'F1 scenario witnessed ' + tot.freed);   // head 15, base engine 2
    assert.ok(tot.poolChecks >= 2000, 'pool-top checks ' + tot.poolChecks);
    assert.equal(tot.walks, 15 * 10, 'model walks');
    assert.equal(tot.wb, tot.ranges, 'a white-box check after every non-empty addRange');
    assert.equal(tot.wbModel, tot.walks, 'a white-box + model check at every walk');
    assert.equal(tot.paged, 4);
});

test('RoaringRange F1 R1 (exact): cF ends smallRuns after cL returns the small slot; add(64) then succeeds', () => {
    // U = 3 chunks, maxSmall 1, maxLarge 2. chunk 1: 100 keys -> large array; chunk 2: 60 keys -> small (pool empty).
    const r = new RoaringSet(3 * 65536, 1, 2);
    for (let i = 0; i < 100; i++) r.add(65536 + i);
    for (let i = 0; i < 120; i += 2) r.add(131072 + i);
    assert.deepEqual(r.dump().chunks, [{ chunk: 1, kind: 'array', count: 100, runs: 0 }, { chunk: 2, kind: 'small', count: 60, runs: 0 }]);
    assert.equal(r._sTop, 0);
    // chunk 1 gets [200, 65535] (2 runs, decided with no small slot free); chunk 2 gets [0, 9] -> 65 keys, 55 runs ->
    // large array, returning its small slot. Post-call: a small slot is free, so runOptimize's kind for chunk 1 is smallRuns.
    r.addRange(65536 + 200, 131072 + 10);
    assert.deepEqual(r.dump().chunks, [{ chunk: 1, kind: 'smallRuns', count: 65436, runs: 2 }, { chunk: 2, kind: 'array', count: 65, runs: 0 }]);
    assert.equal(r._sTop, 0, 'chunk 1 holds the small slot chunk 2 returned');
    assert.equal(r._lTop, 1, 'one large slot free (chunk 2 holds the other)');
    assert.equal(r.size, 65436 + 65);
    // the 8 KB slot is free: chunk 0 grows to 65 keys (SINGLE -> large array: no small slot) without a pool throw
    for (let i = 0; i < 64; i++) r.add(i);
    r.add(64);
    assert.equal(r.size, 65436 + 65 + 65);
    assert.deepEqual(r.dump().chunks[0], { chunk: 0, kind: 'array', count: 65, runs: 0 });
    assert.equal(r._lTop, 0);
});

test('RoaringRange F1 demoted content (exact): 32 runs copied whole, neighbour small slot untouched', () => {
    // maxSmall 2 (slot 0 pops first), maxLarge 2. chunk 2 takes small slot 0 (60 keys 0, 2, .., 118); chunk 0 takes slot 1
    // (20 keys 1000 + 3i); chunk 1 gets 31 isolated keys 0, 2, .., 60 in a LARGE array (no small slot free).
    const r = new RoaringSet(3 * 65536, 2, 2);
    for (let i = 0; i < 120; i += 2) r.add(131072 + i);
    for (let i = 0; i < 20; i++) r.add(1000 + 3 * i);
    for (let i = 0; i <= 60; i += 2) r.add(65536 + i);
    assert.deepEqual(r.dump().chunks.map((c) => c.kind), ['small', 'array', 'small']);
    assert.equal(r._sTop, 0);
    // chunk 1 gets [100, 65535]: 31 + 1 = 32 runs (the small-runs cap), decided as a run slab; chunk 2 gets [0, 9] -> large
    // array, returning small slot 0; the demotion copies all 32 runs (64 u16 words) into slot 0, next to chunk 0's slot 1.
    r.addRange(65536 + 100, 131072 + 10);
    assert.deepEqual(r.dump().chunks, [{ chunk: 0, kind: 'small', count: 20, runs: 0 },
        { chunk: 1, kind: 'smallRuns', count: 31 + 65436, runs: 32 }, { chunk: 2, kind: 'array', count: 65, runs: 0 }]);
    assert.equal(r._sTop, 0);
    assert.equal(r._lTop, 1);
    // every run of chunk 1, both ends, and the gaps around them (run 32 = [100, 65535] is the last pair copied)
    const B = 65536;
    for (let i = 0; i <= 60; i += 2) {
        assert.equal(r.has(B + i), true, 'run [' + i + ', ' + i + ']');
        assert.equal(r.has(B + i + 1), false, 'gap after ' + i);
        assert.equal(r.successor(B + i), i === 60 ? B + 100 : B + i + 2, 'successor of run end ' + i);
    }
    for (const x of [100, 101, 32767, 65534, 65535]) assert.equal(r.has(B + x), true, 'run 32 key ' + x);
    for (const x of [61, 98, 99]) assert.equal(r.has(B + x), false, 'gap key ' + x);
    assert.equal(r.predecessor(B + 100), B + 60);
    assert.equal(r.predecessor(B + 65536), B + 65535);
    // chunk 0 (small slot 1, the neighbour) and chunk 2 are exactly their keys: full ordered walks
    const walk = (lo, hi) => { const ks = []; for (let k = lo === 0 && r.has(0) ? 0 : r.successor(lo === 0 ? 0 : lo - 1); k !== undefined && k < hi; k = r.successor(k)) ks.push(k); return ks; };
    assert.deepEqual(walk(0, B), Array.from({ length: 20 }, (_, i) => 1000 + 3 * i));
    const c2 = []; for (let i = 0; i < 10; i++) c2.push(2 * B + i); for (let i = 10; i < 120; i += 2) c2.push(2 * B + i);
    assert.deepEqual(walk(2 * B, 3 * B), c2);
    assert.equal(r.min(), 1000);
    assert.equal(r.max(), 2 * B + 118);
    // the encoded runs themselves: 32 (start, len - 1) pairs in small slot 0
    const m = r._mi(1);
    assert.equal(r._slot[m], 0);
    const want = []; for (let i = 0; i <= 60; i += 2) want.push(i, 0); want.push(100, 65435);
    assert.deepEqual(Array.from(r._sData.subarray(0, 64)), want);
});

test('RoaringRange F1 boundary (exact): a 33-run cF stays a run slab although a small slot is free post-call', () => {
    // maxSmall 2, maxLarge 3. chunk 2: 100 isolated keys 20 + 2i -> large array (101 runs after [0, 9]: stays array).
    // chunk 1: 32 runs of 3 keys (4q + 0..2) -> runOptimize -> smallRuns, 32 runs (the cap).
    const r = new RoaringSet(3 * 65536, 2, 3);
    for (let i = 0; i < 100; i++) r.add(131072 + 20 + 2 * i);
    for (let q = 0; q < 32; q++) for (let i = 0; i < 3; i++) r.add(65536 + 4 * q + i);
    r.runOptimize();
    assert.deepEqual(r.dump().chunks, [{ chunk: 1, kind: 'smallRuns', count: 96, runs: 32 }, { chunk: 2, kind: 'array', count: 100, runs: 0 }]);
    // [200, 65535] is an isolated 33rd run: chunk 1 spills to a run slab (33 > 32) and returns its small slot, so both
    // small slots are free post-call; runOptimize keeps 33 runs in the slab, so the post-pass must not demote it.
    r.addRange(65536 + 200, 131072 + 10);
    assert.deepEqual(r.dump().chunks, [{ chunk: 1, kind: 'runs', count: 96 + 65336, runs: 33 }, { chunk: 2, kind: 'array', count: 110, runs: 0 }]);
    assert.equal(r._sTop, 2);
    assert.equal(poolError(r), null);
    const d = JSON.stringify(r.dump());
    r.runOptimize();
    assert.equal(JSON.stringify(r.dump()), d, 'runOptimize fixpoint');
    for (let q = 0; q < 32; q++) {
        assert.equal(r.has(65536 + 4 * q), true); assert.equal(r.has(65536 + 4 * q + 2), true); assert.equal(r.has(65536 + 4 * q + 3), false);
    }
    assert.equal(r.has(65536 + 199), false); assert.equal(r.has(65536 + 200), true); assert.equal(r.has(65536 + 65535), true);
});

test('RoaringRange white-box coverage (C-9): the header / summary checks ran, reached bitmaps and the model', () => {
    console.log('# white-box (wbError): ' + JSON.stringify(WB));
    // floors well under the seed-0 counts (evidence roaring-g4-b2b.md), so LOGLOGN_SEED re-runs keep them
    // seed 0: checks 12,768, bitmap chunk-checks 224 (runCase's bitmap pre-states; fixpointStream's tight-pool streams
    // rarely reach > 4,096 keys in a chunk), model checks 822
    // bmpZeroWord (fillers-t6): bitmaps checked with >= 1 zero word (an L1 bit that must read 0), from runCase's random
    // 5,000..12,000-key bitmap pre-states; seeds 0 / 7 / 12345 / 99 / 4242 / 31337: 224 / 212 / 208 / 200 / 212 / 208
    // (evidence fillers-t6.md). zeroPage: paged sets whose zero page was checked (3,670 on every seed: no seeded share).
    assert.ok(WB.checks >= 10000, 'white-box checks ' + WB.checks);
    assert.ok(WB.bitmaps >= 150, 'bitmap summary checks ' + WB.bitmaps);
    assert.ok(WB.bmpZeroWord >= 140, 'bitmaps checked with a zero word ' + WB.bmpZeroWord);
    assert.ok(WB.zeroPage >= 2500, 'zero-page checks ' + WB.zeroPage);
    assert.ok(WB.model >= 600, 'model checks ' + WB.model);
});
