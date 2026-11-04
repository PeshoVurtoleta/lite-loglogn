/**
 * @zakkster/lite-loglogn -- RoaringSet PAGED differential fuzz (0.6.0 G2-B3, PLAN-roaringset-G2 task 5, A-3;
 * SPEC C-5, C-6, C-10, C-13, C-20). Logic only: no timers, no Workers, no file I/O. The Worker
 * (test/_roaring-paged-worker.mjs) and the test (test/RoaringPagedFuzz.test.js) drive it.
 *
 * Ported from the R0 research harness roaring-fuzz.best-paged.mjs, which is roaring-fuzz.best.mjs plus paged
 * parts. The best.mjs part is NOT copied: it is G1's port (./roaringFuzz.mjs, runRoaringFuzz), imported
 * read-only and run on an INSTRUMENTED subclass that passes the lane's (maxPages, pageBits) to every set the
 * harness builds (R0's XK knob) and checks the page invariants after every K mutating ops. Added here, from
 * the paged harness: its checkSet (rows through `_mi`, + checkPages at every check point), the vc targeted
 * cases and vc scenarios, the bestp cases (each minus checkPair / the set-op kind-pair half: G3, SPEC C-21),
 * with the KNOBS check DROPPED and every universe explicit. New in the port (A-3): the real-module 2^32 page
 * streams, the mixed direct / paged rows and the full-page-pool snapshot.
 *
 * Lanes (a lane = one call of runPagedLane; each paged lane must show >= 1 page-pool throw and >= 1 page
 * release, else a FAIL row):
 *   F6 / F8 / F10  FORCED build (forcePagedSource: the C-5 decision line -> `const paged = true;`): G1 harness
 *                  at pageBits P (every set paged, asserted), vc cases at P, bestp cases at P; F8 also runs the
 *                  vc cases at pb 1 / 15, the vc scenarios and the bestp p6 x p10 rows.
 *   B6 / B8 / B10  REAL module at 2^32, maxPages 1014 / 254 / 62: G1 harness R / C 2^32 scenarios + a 20,000-op
 *                  page stream; every 2^32 instance must be paged.
 *   M              REAL module mixed rows: 2^32 direct vs 2^32 maxPages 254; 2^26 direct vs (2^26, 14, pb6);
 *                  the C-13 TIE (184,942,592, 0, 1, 10) direct vs maxPages 9 paged. One 20,000-op stream per
 *                  row; every op result / size / dump (minus `.paged`) / own-key order equal.
 *   X              full page pool (2^32, 8, 8, 2): the add throws the exact page text, every owned array, EVERY
 *                  own scalar (incl. `_pTop`) and `_size` unchanged; a control add changes the snapshot.
 *
 * Page invariants (checkPages, from the G2-B1 reviewer's check.mjs + R0 checkPages): the zero page is all
 * zero in the 6 row arrays; every mapped page id in [1, maxPages], mapped once, `_pLive` == its live rows
 * (counted from `_kind`) == the model's live chunks of that directory entry, never 0; the free list holds
 * distinct ids in [1, maxPages], none mapped, `_pLive` 0, EVERY row of every free page 0 in all 6 arrays;
 * free + mapped == maxPages (no page lost). A direct set: zero-length page arrays, `_pSh` / `_pTop` / `_maxP` 0.
 *
 * API: runPagedLane({ real, forced }, lane, opts) -> { rows: [{ ok, text }], failing, stats, cov, lines }
 *   real / forced = the RoaringSet classes of the module and of its forced-paged build.
 *   opts = { g: { seeds, ops } | null, vc: { seeds, ops }, streamOps, base, K, floors: 'reduced' | 'full' }
 */

import { createHash } from 'node:crypto';
import { runRoaringFuzz, floorMisses } from './roaringFuzz.mjs';

export const LANES = ['F6', 'F8', 'F10', 'B6', 'B8', 'B10', 'M', 'X'];
export const U32 = 4294967296;
export const PAGE_TEXT_2 = '[lite-loglogn] RoaringSet metadata page pool exhausted (maxPages 2); increase maxPages at construction';
const PAGE_RE = /metadata page pool exhausted/;
const POOL_RE = /pool exhausted/;
const ROWS6 = ['_kind', '_slot', '_card', '_runs', '_cMin', '_cMax'];
const ZERO = Buffer.alloc(2 * 32768); // one page of the widest row array at pageBits 15
// G1's floor rows (`seed all op -: coverage floor < 100`): a budget artifact below the full budget (C-22)
export const G1_FLOOR_ROW = /^FAIL .* seed all op -: coverage floor < 100: /;
export const STREAM_K = 128;      // page-invariant period inside the streams (the lane K elsewhere)
export const B_MAXPAGES = { 6: 1014, 8: 254, 10: 62 };
const OPT_KEYS = ['g', 'vc', 'streamOps', 'base', 'K', 'floors'];

/** The C-5 decision line -> `const paged = true;` (count must be exactly 1, else throws). */
export function forcePagedSource(src) {
    const re = /const paged = [^;\n]+;/g;
    const n = (src.match(re) || []).length;
    if (n !== 1) throw new Error('forcePagedSource: decision line count ' + n + ' (want 1)');
    return src.replace(re, 'const paged = true;');
}

/** C-5 closed form (the SPEC text, independent of the engine): true = paged. */
export function expectPaged(U, maxPages, pageBits) {
    const chunks = Math.ceil(U / 65536);
    const dirLen = Math.ceil(chunks / 2 ** pageBits);
    const mp = maxPages === undefined ? dirLen : maxPages;
    return 11 * (mp + 1) * 2 ** pageBits + 2 * dirLen + 4 * mp + 2 < 11 * chunks;
}

export function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// incremental model: Set + sorted array (binary insert / splice)
export class Model {
    constructor() { this.s = new Set(); this.a = []; }
    lb(x) { const a = this.a; let l = 0, h = a.length; while (l < h) { const m = (l + h) >>> 1; if (a[m] < x) l = m + 1; else h = m; } return l; }
    add(x) { if (!this.s.has(x)) { this.s.add(x); this.a.splice(this.lb(x), 0, x); } }
    delete(x) { if (!this.s.delete(x)) return false; this.a.splice(this.lb(x), 1); return true; }
    clear() { this.s.clear(); this.a.length = 0; }
    arr() { return this.a; }
    succ(x) { const j = this.lb(x + 1); return j < this.a.length ? this.a[j] : undefined; }
    pred(x) { const j = this.lb(x); return j > 0 ? this.a[j - 1] : undefined; }
    min() { return this.a.length ? this.a[0] : undefined; }
    max() { return this.a.length ? this.a[this.a.length - 1] : undefined; }
}

// ---- page invariants ----------------------------------------------------------------------------------------

/** every row of page pg is 0 in all 6 row arrays (memcmp per array); null = fresh */
export function pageFresh(rs, pg) {
    const E = 1 << rs._pSh;
    for (const f of ROWS6) {
        const a = rs[f];
        const w = a.BYTES_PER_ELEMENT;
        const v = Buffer.from(a.buffer, a.byteOffset + pg * E * w, E * w);
        if (Buffer.compare(v, ZERO.subarray(0, E * w)) !== 0) {
            for (let r = 0; r < E; r++) if (a[pg * E + r] !== 0) return f + '[row ' + (pg * E + r) + '] = ' + a[pg * E + r] + ' (want 0)';
        }
    }
    return null;
}

/** livePer: Map(dir entry -> live chunks) from a MODEL, or null (then only the row count is used) */
export function checkPages(rs, livePer) {
    if (rs._pSh === 0) {
        if (rs._dir.length !== 0 || rs._pLive.length !== 0 || rs._pFree.length !== 0 || rs._pTop !== 0 || rs._maxP !== 0) {
            return 'direct set with page state: dir ' + rs._dir.length + ' pLive ' + rs._pLive.length + ' pFree ' + rs._pFree.length + ' pTop ' + rs._pTop + ' maxP ' + rs._maxP;
        }
        return null;
    }
    const sh = rs._pSh, E = 1 << sh, mP = rs._maxP;
    if (rs._kind.length !== (mP + 1) * E) return 'row arrays ' + rs._kind.length + ' != (maxPages + 1) 2^pb';
    if (!(rs._pTop >= 0 && rs._pTop <= mP)) return 'pTop ' + rs._pTop + ' out of [0, ' + mP + ']';
    const z0 = pageFresh(rs, 0);
    if (z0) return 'zero page written: ' + z0;
    const seen = new Uint8Array(mP + 1);
    let mapped = 0;
    for (let d = 0; d < rs._dir.length; d++) {
        const pg = rs._dir[d];
        if (livePer !== null) {
            const want = livePer.get(d) || 0;
            if ((pg !== 0) !== (want !== 0)) return 'dir[' + d + ']=' + pg + ' but model live chunks ' + want;
            if (pg !== 0 && rs._pLive[pg] !== want) return 'page ' + pg + ' _pLive ' + rs._pLive[pg] + ' vs model ' + want;
        }
        if (pg === 0) continue;
        if (pg > mP || seen[pg]) return 'dir[' + d + '] page id ' + pg + ' out of range or mapped twice';
        seen[pg] = 1;
        mapped++;
        let live = 0;
        for (let j = 0; j < E; j++) if (rs._kind[(pg << sh) | j] !== 0) live++;
        if (live !== rs._pLive[pg]) return 'page ' + pg + ' _pLive ' + rs._pLive[pg] + ' != live rows ' + live;
        if (live === 0) return 'mapped page ' + pg + ' (dir ' + d + ') with 0 live chunks';
    }
    for (let i = 0; i < rs._pTop; i++) {
        const pg = rs._pFree[i];
        if (pg < 1 || pg > mP || seen[pg]) return 'free list [' + i + '] = ' + pg + ' out of range, duplicate or mapped';
        seen[pg] = 1;
        if (rs._pLive[pg] !== 0) return 'free page ' + pg + ' _pLive ' + rs._pLive[pg];
        const z = pageFresh(rs, pg);
        if (z) return 'free page ' + pg + ' not zero: ' + z;
    }
    if (rs._pTop + mapped !== mP) return 'page pool: free ' + rs._pTop + ' + mapped ' + mapped + ' != ' + mP;
    for (let pg = 1; pg <= mP; pg++) if (!seen[pg]) return 'page ' + pg + ' lost';
    return null;
}

// ---- instrumented class: a lane's (maxPages, pageBits) injected, invariants every K mutating ops --------------

function instrument(Base, inject, st, K) {
    let n = 0;
    const tick = (rs) => {
        if (++n % K !== 0) return;
        st.checks++;
        const e = checkPages(rs, null);
        if (e && st.viol.length < 4) st.viol.push('op ' + n + ': ' + e);
    };
    return class PagedLane extends Base {
        constructor(u, s, l, mp, pb) {
            if (mp === undefined && pb === undefined) [mp, pb] = inject(u);
            super(u, s, l, mp, pb);
            st.instances++;
            const want = st.expect(u, mp, pb);
            if (want !== null && this.paged !== want && st.viol.length < 4) st.viol.push('instance (' + u + ', ' + mp + ', ' + pb + ') paged ' + this.paged + ' want ' + want);
            if (this.paged) st.paged++;
        }
        add(x) {
            try { super.add(x); } catch (e) {
                if (PAGE_RE.test(String(e && e.message))) st.pageThrows++;
                tick(this);
                throw e;
            }
            tick(this);
        }
        delete(x) {
            const t = this._pTop;
            const r = super.delete(x);
            if (this._pTop > t) st.releases++;
            tick(this);
            return r;
        }
        clear() { super.clear(); tick(this); }
        runOptimize() { super.runOptimize(); tick(this); }
    };
}

function newStats(expect) {
    return { instances: 0, paged: 0, pageThrows: 0, releases: 0, checks: 0, viol: [], expect };
}

// ---- the paged harness's checkSet (rows through _mi; checkPages at every check point) ----------------------

function checkSummary(rs, c, row, want, cv) {
    const wb = rs._slot[row] << 11, sb = rs._slot[row] * 66;
    let pc = 0, l2a = 0, l2b = 0, zero = 0;
    for (let s1 = 0; s1 < 64; s1++) {
        let m1 = 0;
        for (let b = 0; b < 32; b++) {
            const v = rs._lU32[wb + (s1 << 5) + b];
            if (v !== 0) { m1 |= 1 << b; for (let x = v; x !== 0; x &= x - 1) pc++; } else zero++;
        }
        if ((rs._bSum[sb + s1] | 0) !== m1) return 'chunk ' + c + ' _bSum L1[' + s1 + '] ' + (rs._bSum[sb + s1] | 0) + ' vs rescan ' + m1;
        if (m1 !== 0) { if (s1 < 32) l2a |= 1 << s1; else l2b |= 1 << (s1 - 32); }
    }
    if ((rs._bSum[sb + 64] | 0) !== l2a || (rs._bSum[sb + 65] | 0) !== l2b) return 'chunk ' + c + ' _bSum L2 vs rescan';
    if (pc !== want) return 'chunk ' + c + ' bitmap popcount ' + pc + ' vs model ' + want;
    if (zero !== 0 && cv) cv.bmpZeroWord++;
    return null;
}

export function checkSet(rs, md, r, U, cv) {
    if (rs.size !== md.s.size) return 'size ' + rs.size + ' vs ' + md.s.size;
    const a = md.arr();
    const probes = [0, 1, U - 1, U - 2, 65535, 65536, 65537];
    for (let i = 0; i < 24; i++) probes.push(Math.floor(r() * U));
    for (let i = 0; i < 24 && a.length; i++) { const k = a[Math.floor(r() * a.length)]; probes.push(k, k - 1, k + 1); }
    for (const q of probes) {
        if (q < 0 || q >= U) continue;
        if (rs.has(q) !== md.s.has(q)) return 'has(' + q + ') ' + rs.has(q);
        const s1 = rs.successor(q), s2 = md.succ(q);
        if (s1 !== s2) return 'successor(' + q + ') ' + s1 + ' vs ' + s2;
        const p1 = rs.predecessor(q), p2 = md.pred(q);
        if (p1 !== p2) return 'predecessor(' + q + ') ' + p1 + ' vs ' + p2;
    }
    if (rs.min() !== md.min()) return 'min ' + rs.min() + ' vs ' + md.min();
    if (rs.max() !== md.max()) return 'max ' + rs.max() + ' vs ' + md.max();
    const per = new Map(), cMn = new Map(), cMx = new Map();
    for (const k of md.s) {
        const c = Math.floor(k / 65536), l = k % 65536;
        per.set(c, (per.get(c) || 0) + 1);
        if (!cMn.has(c) || l < cMn.get(c)) cMn.set(c, l);
        if (!cMx.has(c) || l > cMx.get(c)) cMx.set(c, l);
    }
    let small = 0, large = 0;
    const livePer = new Map();
    for (let c = 0; c < rs._chunks; c++) {
        const row = rs._mi(c);
        const k = rs._kind[row];
        const want = per.get(c) || 0;
        if (k === 0) { if (want !== 0) return 'chunk ' + c + ' kind 0 but model has ' + want; continue; }
        if (cv) cv.k[k] = (cv.k[k] || 0) + 1;
        if (rs._pSh !== 0) { const d = c >>> rs._pSh; livePer.set(d, (livePer.get(d) || 0) + 1); }
        if (rs._card[row] + 1 !== want) return 'chunk ' + c + ' kind ' + k + ' _card+1=' + (rs._card[row] + 1) + ' vs model ' + want;
        if (rs._cMin[row] !== cMn.get(c)) return 'chunk ' + c + ' kind ' + k + ' _cMin=' + rs._cMin[row] + ' vs model ' + cMn.get(c);
        if (rs._cMax[row] !== cMx.get(c)) return 'chunk ' + c + ' kind ' + k + ' _cMax=' + rs._cMax[row] + ' vs model ' + cMx.get(c);
        if (k < 1 || k > 7) return 'chunk ' + c + ' bad kind ' + k;
        if (k === 7) {
            if (!md.s.has(c * 65536 + rs._slot[row])) return 'chunk ' + c + ' SINGLE _slot=' + rs._slot[row] + ' not in model';
            continue;
        }
        if (want < 2) return 'chunk ' + c + ' kind ' + k + ' holds ' + want + ' key (want SINGLE)';
        if (k === 1) { if (want > 64) return 'chunk ' + c + ' kind 1 with ' + want + ' keys'; small++; }
        else if (k === 5) { if (rs._runs[row] > 31) return 'chunk ' + c + ' kind 5 with ' + (rs._runs[row] + 1) + ' runs'; small++; }
        else if (k === 6) { if (want !== 65536) return 'chunk ' + c + ' kind 6 (FULL) with ' + want + ' keys'; }
        else {
            if (k === 2 && want > 4096) return 'chunk ' + c + ' kind 2 with ' + want + ' keys';
            if (k === 3) {
                if (want <= 2048) return 'chunk ' + c + ' kind 3 with ' + want + ' keys (<= 2048)';
                const e = checkSummary(rs, c, row, want, cv); if (e) return e;
            }
            large++;
        }
    }
    if (rs._sTop + small !== rs._maxS) return 'small pool: free ' + rs._sTop + ' + used ' + small + ' != ' + rs._maxS;
    if (rs._lTop + large !== rs._maxL) return 'large pool: free ' + rs._lTop + ' + used ' + large + ' != ' + rs._maxL;
    return checkPages(rs, livePer);
}

function kindOf(rs, c) { return rs._kind[rs._mi(c)]; }

/** every own typed array (bytes) + every own number field, hashed */
export function snap(rs) {
    const h = createHash('sha256');
    for (const k of Object.keys(rs).sort()) {
        const v = rs[k];
        if (ArrayBuffer.isView(v)) h.update(k + ':').update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        else if (typeof v === 'number') h.update(k + '=' + v + ';');
    }
    return h.digest('hex');
}

/** the owned state, field by field: arrays as Buffers, scalars as values (X lane: names the field that moved) */
export function ownedState(rs) {
    const arrays = {}, scalars = {};
    for (const k of Object.keys(rs)) {
        const v = rs[k];
        if (ArrayBuffer.isView(v)) arrays[k] = Buffer.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        else scalars[k] = v;
    }
    return { arrays, scalars };
}

export function stateDiff(a, b) {
    const ka = Object.keys(a.arrays).concat(Object.keys(a.scalars)).join();
    const kb = Object.keys(b.arrays).concat(Object.keys(b.scalars)).join();
    if (ka !== kb) return 'own keys ' + ka + ' -> ' + kb;
    for (const k of Object.keys(a.arrays)) if (Buffer.compare(a.arrays[k], b.arrays[k]) !== 0) return 'array ' + k + ' changed';
    for (const k of Object.keys(a.scalars)) if (!Object.is(a.scalars[k], b.scalars[k])) return 'scalar ' + k + ' ' + a.scalars[k] + ' -> ' + b.scalars[k];
    return null;
}

// ---- lanes ---------------------------------------------------------------------------------------------------

export function runPagedLane(mods, lane, opts) {
    if (!LANES.includes(lane)) throw new RangeError('runPagedLane: unknown lane ' + JSON.stringify(lane));
    for (const k of Object.keys(opts)) if (!OPT_KEYS.includes(k)) throw new TypeError('runPagedLane: unknown option ' + JSON.stringify(k));
    const K = opts.K === undefined ? 1024 : opts.K;
    const BASE = opts.base === undefined ? 0 : opts.base;
    const FLOORS = opts.floors === undefined ? 'reduced' : opts.floors;
    const VC = opts.vc;
    const SOPS = opts.streamOps;
    const rows = [], lines = [], cov = [];
    let failing = 0;
    const out = (ok, name, detail) => {
        const text = (ok ? 'ok   ' : 'FAIL ') + lane + ' ' + name + (detail ? ' ' + detail : '');
        rows.push({ ok, text }); lines.push(text);
        if (!ok) failing++;
    };
    const tryRow = (name, fn) => {
        let d;
        try { d = fn(); } catch (e) { d = 'threw ' + (e && e.message ? e.message : String(e)); }
        out(!d, name, d || '');
    };
    let tPart = performance.now();
    const part = (name) => { const t = performance.now(); lines.push('# ' + lane + ' part ' + name + ' ' + ((t - tPart) / 1000).toFixed(1) + ' s'); tPart = t; };
    const sd = (k) => (Math.imul((k + BASE) | 0, 104729) + 0x51ed) >>> 0;

    const forced = lane[0] === 'F';
    const P = forced || lane[0] === 'B' ? Number(lane.slice(1)) : 0;
    const st = newStats(forced ? () => true : (u, mp, pb) => (u === U32 && mp === B_MAXPAGES[P] ? true : null));
    const Base = forced ? mods.forced : mods.real;
    const RS = instrument(Base, forced ? () => [undefined, P] : (u) => (u === U32 && lane[0] === 'B' ? [B_MAXPAGES[P], P] : [undefined, undefined]), st, K);

    // (1) G1's harness on the instrumented class
    if (opts.g && lane !== 'M' && lane !== 'X') {
        const o = { seeds: opts.g.seeds, ops: opts.g.ops, base: BASE };
        if (!forced) { o.only = ['R', 'C']; o.names = ['R U=2^32 range+opt mix', 'C U=2^32 bitmap churn hi']; }
        if (opts.g.seedsBy) o.seedsBy = opts.g.seedsBy;
        const r = runRoaringFuzz(RS, o);
        let real = 0, floorRows = 0;
        for (const x of r.rows) {
            if (x.ok) continue;
            if (FLOORS !== 'full' && G1_FLOOR_ROW.test(x.text)) { floorRows++; continue; }
            real++; out(false, 'G1 ' + x.text);
        }
        for (const c of r.cov) cov.push(c);
        // R0's own floors (>= 100, G1 floorMisses) at R0's budget (floors 'full'); below it they are budget artifacts
        if (FLOORS === 'full') { const miss = floorMisses(r.cov); out(miss.length === 0, 'G1 harness floors >= 100', miss.join('; ')); }
        part('G1');
        if (real === 0) out(true, 'G1 harness ' + r.rows.length + ' rows (' + o.seeds + ' x ' + o.ops + ', floor rows below budget ' + floorRows + ')');
    }

    // (2) vc + bestp targeted cases (forced build only: the default maxPages pages only there)
    if (forced && VC) {
        const pbs = lane === 'F8' ? [P, 1, 15] : [P];
        for (const pb of pbs) vcCases(RS, pb, tryRow);
        bestpCases(RS, P, tryRow);
        if (lane === 'F8') {
            vcScenario(RS, 'vc U=2^32 mix maxPages 3 p8 / p6', U32, 'mix', 64, 32, [3, 8], [12, 6], VC, sd, out);
            vcScenario(RS, 'vc U=2^32 mix maxPages 2 p10 / p8', U32, 'mix', 64, 32, [2, 10], [5, 8], VC, sd, out);
            vcScenario(RS, 'vc U=200001 mix p1 / p15', 200001, 'mix', 8, 8, [undefined, 1], [undefined, 15], VC, sd, out);
            tryRow('bestp kinds p6 x p10 (checkSet; the checkPair half is G3)', () => bestpKindRows(RS));
        }
        part('vc+bestp');
    }

    // (3) real-module page streams
    if (lane[0] === 'B' && SOPS) {
        tryRow('stream 2^32 (64, 32, ' + B_MAXPAGES[P] + ', pb' + P + ') ' + SOPS + ' ops', () =>
            stream(RS, [[U32, 64, 32, B_MAXPAGES[P], P]], SOPS, sd(P), STREAM_K, st));
    }
    if (lane === 'M' && SOPS) {
        const M = [
            ['direct 2^32 vs paged 2^32 maxPages 254', [[U32, 64, 32, undefined, 8], [U32, 64, 32, 254, 8]]],
            ['direct 2^26 vs paged (2^26, 14, pb6)', [[67108864, 64, 32, undefined, 8], [67108864, 64, 32, 14, 6]]],
            ['TIE 184942592 (0, 1, 10, pb8) direct vs maxPages 9 paged', [[184942592, 0, 1, 10, 8], [184942592, 0, 1, 9, 8]]],
        ];
        st.expect = (u, mp, pb) => expectPaged(u, mp, pb);
        M.forEach(([name, cfgs], i) => tryRow('mixed ' + name + ' ' + SOPS + ' ops', () => stream(RS, cfgs, SOPS, sd(100 + i), STREAM_K, st)));
    }
    if (lane === 'X') {
        st.expect = (u, mp, pb) => expectPaged(u, mp, pb);
        tryRow('full page pool (2^32, 8, 8, 2): exact text, every array + own scalar unchanged', () => fullPool(RS));
    }

    if (st.viol.length) out(false, 'page invariants every ' + K + ' ops', st.viol.join(' | '));
    else out(true, 'page invariants every ' + K + ' ops (' + st.checks + ' checks)');
    if (lane !== 'X') {
        const pagedLane = st.paged > 0;
        if (!pagedLane) out(false, 'paged instances', '0 of ' + st.instances);
        out(st.pageThrows >= 1 && st.releases >= 1, 'page floors: throws ' + st.pageThrows + ' (>= 1), releases ' + st.releases + ' (>= 1)');
    }
    const stats = { instances: st.instances, paged: st.paged, pageThrows: st.pageThrows, releases: st.releases, checks: st.checks };
    lines.push('# ' + lane + ' stats ' + JSON.stringify(stats));
    return { rows, failing, stats, cov, lines };
}

export { floorMisses };

// ---- vc targeted cases (R0, minus KNOBS) --------------------------------------------------------------------

function pair(RS, U, maxS, maxL, maxP, P) {
    const rs = new RS(U, maxS, maxL, maxP, P), md = new Model();
    return {
        rs, md,
        add(x) { rs.add(x); md.add(x); },
        del(x) { const a = rs.delete(x), b = md.delete(x); if (a !== b) throw new Error('delete(' + x + ') ' + a); },
        check(edges) {
            for (const e of edges || []) for (const q of [e - 1, e, e + 1]) {
                if (q < 0 || q >= U) continue;
                if (rs.has(q) !== md.s.has(q)) return 'has(' + q + ')';
                if (rs.successor(q) !== md.succ(q)) return 'successor(' + q + ') ' + rs.successor(q) + ' vs ' + md.succ(q);
                if (rs.predecessor(q) !== md.pred(q)) return 'predecessor(' + q + ') ' + rs.predecessor(q) + ' vs ' + md.pred(q);
            }
            return checkSet(rs, md, rng(7), U, null);
        },
    };
}

function vcCases(RS, P, tryRow) {
    const E = 1 << P;
    const tag = ' p' + P;
    tryRow('vc page alloc on first add' + tag, () => {
        const t = pair(RS, U32, 8, 8, undefined, P), rs = t.rs, mp = rs._maxP;
        if (mp !== 65536 / E || rs._pTop !== mp) return 'fresh maxP ' + mp + ' pTop ' + rs._pTop;
        t.add(5);
        if (rs._pTop !== mp - 1 || rs._dir[0] !== 1 || rs._pLive[1] !== 1) return 'first add: pTop ' + rs._pTop + ' dir0 ' + rs._dir[0];
        t.add(6); t.add(((E - 1) * 65536) + 3);
        if (rs._pTop !== mp - 1 || rs._pLive[1] !== 2) return 'same page: pTop ' + rs._pTop + ' live ' + rs._pLive[1];
        t.add(E * 65536);
        if (rs._pTop !== mp - 2 || rs._dir[1] !== 2 || rs._pLive[2] !== 1) return 'second page: pTop ' + rs._pTop + ' dir1 ' + rs._dir[1];
        return t.check([5, ((E - 1) * 65536) + 3, E * 65536]);
    });
    tryRow('vc page free when last chunk empties' + tag, () => {
        const t = pair(RS, U32, 8, 8, undefined, P), rs = t.rs, mp = rs._maxP;
        const cs = E >= 4 ? [0, 1, 2, 3] : [0, 1];
        const keys = [];
        const put = (x) => { t.add(x); keys.push(x); };
        put(cs[0] * 65536 + 7); put(cs[0] * 65536 + 9);
        for (let i = 0; i < 100; i++) put(cs[1] * 65536 + 3 * i);
        if (cs.length > 2) {
            for (let i = 0; i < 5000; i++) put(cs[2] * 65536 + 13 * i);
            for (let i = 0; i < 300; i++) put(cs[3] * 65536 + 1000 + i);
        }
        rs.runOptimize();
        let d = t.check(keys.slice(0, 4));
        if (d) return d;
        if (rs._pTop !== mp - 1) return 'one page expected, pTop ' + rs._pTop;
        for (let j = 0; j < cs.length; j++) {
            const c = cs[j];
            for (let i = keys.length - 1; i >= 0; i--) if (Math.floor(keys[i] / 65536) === c) t.del(keys[i]);
            const left = cs.length - 1 - j;
            if (left > 0 && (rs._pTop !== mp - 1 || rs._pLive[1] !== left)) return 'after chunk ' + c + ': pTop ' + rs._pTop + ' live ' + rs._pLive[1];
            d = t.check(); if (d) return d;
        }
        if (rs._pTop !== mp || rs._dir[0] !== 0 || rs._pLive[1] !== 0) return 'page not returned: pTop ' + rs._pTop + ' dir0 ' + rs._dir[0];
        t.add(0); t.add(E * 65536); t.del(0); t.del(E * 65536);
        t.add(1);
        if (rs._dir[0] !== 2) return 'LIFO reuse: dir[0]=' + rs._dir[0] + ' want 2';
        return t.check([1]);
    });
    tryRow('vc page pool exhausted fails closed' + tag, () => {
        const t = pair(RS, U32, 8, 8, 1, P), rs = t.rs;
        const nx = E * 65536 + 5;
        t.add(1);
        const before = snap(rs);
        let threw = null;
        try { rs.add(nx); } catch (e) { threw = e; }
        if (!threw || !PAGE_RE.test(threw.message)) return 'no page-pool throw: ' + (threw && threw.message);
        if (!(threw instanceof RangeError)) return 'not a RangeError';
        if (snap(rs) !== before) return 'state changed by the failed add';
        let d = t.check([nx]); if (d) return d;
        t.add(2); t.add((E - 1) * 65536 + 9);
        if (rs._pTop !== 0 || rs._pLive[1] !== 2) return 'pTop ' + rs._pTop + ' live ' + rs._pLive[1];
        t.del(1); t.del(2); t.del((E - 1) * 65536 + 9);
        if (rs._pTop !== 1) return 'freed: pTop ' + rs._pTop;
        t.add(nx);
        d = t.check([nx]); if (d) return d;
        const u = pair(RS, U32, 0, 1, 1, P), r2 = u.rs;
        u.add(3); u.add(4);
        u.add(65536 + 9);
        const cs = 65536 + 10;
        let b2 = snap(r2), e2 = null;
        try { r2.add(cs); } catch (e) { e2 = e; }
        if (!e2 || !/small\/large container pool exhausted/.test(e2.message)) return 'container throw: ' + (e2 && e2.message);
        if (snap(r2) !== b2) return 'state changed by the container-pool throw';
        e2 = null; b2 = snap(r2);
        try { r2.add(E * 65536); } catch (e) { e2 = e; }
        if (!e2 || !PAGE_RE.test(e2.message)) return 'page throw with empty container pools: ' + (e2 && e2.message);
        if (snap(r2) !== b2) return 'state changed by the page-pool throw';
        return u.check([E * 65536, cs]);
    });
    tryRow('vc chunk ids at page edges' + tag, () => {
        const t = pair(RS, U32, 8, 8, undefined, P), rs = t.rs;
        const a = (E - 1) * 65536 + 65535, b = E * 65536;
        const z = 65536 * 65536 - 1;
        t.add(a); t.add(b); t.add(z); t.add(0);
        let d = t.check([a, b, z, 0]); if (d) return d;
        if (rs.successor(a) !== b || rs.predecessor(b) !== a) return 'cross-page succ/pred';
        if (rs.max() !== z || rs.min() !== 0) return 'min/max';
        t.del(a);
        if (rs._dir[0] === 0 || rs._dir[1] === 0) return 'edge delete freed the wrong page';
        t.del(0);
        if (rs._dir[0] !== 0 || rs._dir[1] === 0) return 'page 0 should be free, page 1 live';
        d = t.check([a, b, z, 0]); if (d) return d;
        if (rs.predecessor(b) !== undefined || rs.successor(b) !== z) return 'succ/pred after page free';
        return null;
    });
    tryRow('vc U=200001 last partial page' + tag, () => {
        const U = 200001, t = pair(RS, U, 4, 4, undefined, P), rs = t.rs;
        if (rs._dir.length !== Math.ceil(4 / E)) return 'dirLen ' + rs._dir.length;
        t.add(U - 1); t.add(3 * 65536); t.add(0); t.add(65535);
        let d = t.check([U - 1, 3 * 65536, 0, 65535]); if (d) return d;
        if (rs.max() !== U - 1) return 'max';
        t.del(U - 1); t.del(3 * 65536);
        d = t.check([U - 1]); if (d) return d;
        const U2 = E * 65536 + 1, t2 = pair(RS, U2, 4, 4, undefined, P);
        if (t2.rs._dir.length !== 2) return 'U2 dirLen ' + t2.rs._dir.length;
        t2.add(U2 - 1); t2.add(1);
        d = t2.check([U2 - 1, 1]); if (d) return d;
        if (t2.rs.max() !== U2 - 1 || t2.rs._dir[1] === 0) return 'last page not mapped';
        t2.del(U2 - 1);
        if (t2.rs._dir[1] !== 0) return 'last page not freed';
        return t2.check([U2 - 1]);
    });
    tryRow('vc clear() == fresh page layout' + tag, () => {
        const mp = Math.min(4, 65536 / E);
        const rs = new RS(U32, 8, 8, mp, P), fresh = new RS(U32, 8, 8, mp, P);
        const last = 65535 * 65536;
        for (let x = 0; x < 9000; x++) rs.add(x);
        for (let x = 0; x < 70; x++) rs.add(E * 65536 + x);
        for (let x = 0; x < 300; x++) rs.add(last + 500 + x);
        rs.runOptimize();
        rs.add(1); rs.delete(E * 65536 + 3);
        rs.clear();
        const eq = (k) => Buffer.compare(Buffer.from(rs[k].buffer), Buffer.from(fresh[k].buffer)) === 0;
        for (const k of ['_dir', '_pLive', '_pFree', '_kind', '_card', '_runs', '_slot', '_cMin', '_cMax', '_sFree', '_lFree', '_top']) if (!eq(k)) return k + ' differs from fresh';
        if (rs._pTop !== fresh._pTop || rs._conv !== fresh._conv || rs._size !== 0) return 'pTop / conv / size';
        const dl = rs._dir.length - 1;
        rs.add(last); fresh.add(last);
        if (rs._dir[dl] !== fresh._dir[dl] || rs._dir[dl] !== 1) return 'post-clear page id ' + rs._dir[dl] + ' vs ' + fresh._dir[dl];
        return null;
    });
    if (P === 8) {
        tryRow('vc knob validation (KNOBS check dropped)', () => {
            const bad = [[0, undefined], [16, undefined], [7.5, undefined], ['8', undefined], [8, 0], [8, 257], [8, 1.5], [8, null], [6, 1025]];
            for (const [pb, mp] of bad) {
                let ok = false;
                try { new RS(U32, 4, 4, mp, pb); } catch (e) { ok = e instanceof RangeError && /RoaringSet (pageBits|maxPages)/.test(e.message); }
                if (!ok) return 'accepted pageBits ' + pb + ' maxPages ' + mp;
            }
            const a = new RS(U32, 4, 4, undefined, 8), b = new RS(1, 4, 4, undefined, 8), c = new RS(1 << 20, 4, 4, undefined, 6);
            if (a._maxP !== 256 || a._dir.length !== 256 || b._maxP !== 1 || c._maxP !== 1) return 'defaults ' + a._maxP + ' ' + b._maxP + ' ' + c._maxP;
            if (new RS(U32, 4, 4, 1, 8)._maxP !== 1 || new RS(U32, 4, 4, 256, 8)._maxP !== 256) return 'explicit maxPages';
            return null;
        });
    }
}

// R0 vcScenario: tight page pools, A and B on different pageBits; checkPair dropped (G3)
function vcScenario(RS, name, U, mode, maxS, maxL, pa, pb, VC, sd, out) {
    let first = null, throws = 0;
    for (let seed = 1; seed <= VC.seeds && first === null; seed++) {
        const r = rng(sd(seed) + U);
        const A = new RS(U, maxS, maxL, pa[0], pa[1]), B = new RS(U, maxS, maxL, pb[0], pb[1]);
        if (!A.paged || !B.paged) { first = { seed, op: -1, d: 'not paged' }; break; }
        const mA = new Model(), mB = new Model();
        const gA = makeGen(r, U, mode), gB = makeGen(r, U, mode);
        for (let op = 0; op < VC.ops && first === null; op++) {
            const which = r() < 0.5;
            const [S, M, G] = which ? [A, mA, gA] : [B, mB, gB];
            const x = G();
            const roll = r();
            try {
                if (roll < 0.62) { S.add(x); M.add(x); }
                else if (roll < 0.97) { const got = S.delete(x), want = M.delete(x); if (got !== want) first = { seed, op, d: 'delete(' + x + ') ' + got }; }
                else if (roll < 0.99) S.runOptimize();
                else { S.clear(); M.clear(); }
            } catch (e) {
                if (POOL_RE.test(String(e.message))) {
                    throws++;
                    const d = checkSet(S, M, r, U, null);
                    if (d) first = { seed, op, d: 'after pool throw: ' + d };
                    continue;
                }
                first = { seed, op, d: 'threw ' + e.message };
                break;
            }
            if (first) break;
            if (op % 25 === 0 || op === VC.ops - 1) {
                const d = checkSet(S, M, r, U, null);
                if (d) first = { seed, op, d };
            }
        }
    }
    if (first) out(false, name, 'seed ' + first.seed + ' op ' + first.op + ': ' + first.d);
    else out(true, name + ' (' + VC.seeds + ' seeds x ' + VC.ops + ' ops, pool throws ' + throws + ')');
}

// R0 makeGen (verbatim)
function makeGen(r, U, mode) {
    const chunks = Math.ceil(U / 65536);
    const hot = [0, Math.min(chunks - 1, 1), Math.min(chunks - 1, 7), chunks - 1, Math.floor(r() * chunks)];
    const pickChunk = () => hot[Math.floor(r() * hot.length)];
    const clampU = (x) => (x >= U ? U - 1 : x);
    let runPos = Math.floor(r() * 65536);
    const denseOff = Math.floor(r() * 59000);
    return () => {
        const c = pickChunk();
        const base = c * 65536;
        const m = mode === 'mix' ? ['sparse', 'dense', 'runs', 'stride'][Math.floor(r() * 4)] : mode;
        if (m === 'sparse') return clampU(Math.floor(r() * U));
        if (m === 'dense') return clampU(base + denseOff + Math.floor(r() * 6000));
        if (m === 'runs') { runPos = (runPos + 1 + (r() < 0.05 ? Math.floor(r() * 300) : 0)) & 0xFFFF; return clampU(base + runPos); }
        return clampU(base + 2 * Math.floor(r() * 2400));
    };
}

// ---- bestp cases (R0) ----------------------------------------------------------------------------------------

const BP_KINDS = [
    ['single', (b) => [b + 40000]],
    ['small', (b) => [b + 3, b + 900, b + 901, b + 30000, b + 65000]],
    ['array', (b) => { const a = []; for (let i = 0; i < 100; i++) a.push(b + 17 + 3 * i); return a; }],
    ['bitmap', (b) => { const a = []; for (let i = 0; i < 5000; i++) a.push(b + 5 + 13 * i); return a; }],
    ['smallruns', (b) => { const a = []; for (let i = 0; i < 300; i++) a.push(b + 1000 + i); return a; }],
    ['runs', (b) => { const a = []; for (let r = 0; r < 40; r++) for (let j = 0; j < 10; j++) a.push(b + 200 + 50 * r + j); return a; }],
    ['full', (b) => { const a = []; for (let i = 0; i < 65536; i++) a.push(b + i); return a; }],
];

function bestpCases(RS, P, tryRow) {
    const E = 1 << P, tag = ' p' + P;
    tryRow('bestp page free resets every field' + tag, () => {
        const t = pair(RS, U32, 32, 32, undefined, P), rs = t.rs, mp = rs._maxP;
        const c0 = 3 * E;
        const kinds = new Set();
        BP_KINDS.forEach(([, f], i) => { for (const x of f((c0 + i) * 65536)) t.add(x); });
        rs.runOptimize();
        for (let i = 0; i < BP_KINDS.length; i++) kinds.add(kindOf(rs, c0 + i));
        if ([...kinds].sort().join() !== '1,2,3,4,5,6,7') return 'kinds ' + [...kinds].sort().join();
        let d = t.check([c0 * 65536 + 40000, (c0 + 6) * 65536]); if (d) return d;
        if (rs._pTop !== mp - 1 || rs._dir[3] !== 1) return 'one page: pTop ' + rs._pTop + ' dir3 ' + rs._dir[3];
        for (let i = BP_KINDS.length - 1; i >= 0; i--) {
            const ks = BP_KINDS[i][1]((c0 + i) * 65536);
            for (const x of ks) t.del(x);
            if (i > 0 && rs._pLive[1] !== i) return 'live ' + rs._pLive[1] + ' after chunk ' + (c0 + i);
            d = t.check([(c0 + i) * 65536]); if (d) return d;
        }
        if (rs._pTop !== mp || rs._dir[3] !== 0) return 'page not freed';
        const z = pageFresh(rs, 1); if (z) return 'freed page 1 not fresh: ' + z;
        t.add((c0 + 5) * 65536 + 77);
        if (rs._dir[3] !== 1) return 'reuse dir3 ' + rs._dir[3];
        const r5 = rs._mi(c0 + 5);
        if (rs._cMin[r5] !== 77 || rs._cMax[r5] !== 77 || kindOf(rs, c0 + 5) !== 7) return 'reused row header / kind';
        if (rs.successor(c0 * 65536) !== (c0 + 5) * 65536 + 77 || rs.predecessor((c0 + 6) * 65536) !== (c0 + 5) * 65536 + 77) return 'succ / pred over a reused page';
        return t.check([(c0 + 5) * 65536 + 77]);
    });
    tryRow('bestp SINGLE page churn maxPages 2' + tag, () => {
        const t = pair(RS, U32, 2, 2, 2, P), rs = t.rs;
        const k = [0, 1, 2].map((i) => (i * E + ((5 * i) % E)) * 65536 + ((i * 7919 + 1) & 0xFFFF));
        for (let it = 0; it < 150; it++) {
            const [a, b, c] = it % 2 ? [k[0], k[1], k[2]] : [k[2], k[0], k[1]];
            t.add(a); t.add(b);
            const before = snap(rs);
            let e = null;
            try { rs.add(c); } catch (x) { e = x; }
            if (!e || !PAGE_RE.test(e.message)) return 'it ' + it + ': no page throw';
            if (snap(rs) !== before) return 'it ' + it + ': page throw changed state';
            t.del(a); t.add(c);
            let d = t.check(k); if (d) return 'it ' + it + ': ' + d;
            t.del(b); t.del(c);
            if (rs._pTop !== 2 || rs.size !== 0) return 'it ' + it + ': pTop ' + rs._pTop;
            d = t.check(k); if (d) return 'it ' + it + ': ' + d;
        }
        return null;
    });
    tryRow('bestp min pages = distinct x >>> (16 + P)' + tag, () => {
        const groups = [0, 7, 7 * E + 1, (65536 / E - 1) * E].map((c) => c * 65536 + 11);
        const want = new Set(groups.map((x) => Math.floor(x / 65536 / E))).size;
        const ok = pair(RS, U32, 4, 4, want, P);
        for (const x of groups) ok.add(x);
        let d = ok.check(groups); if (d) return d;
        if (ok.rs._pTop !== 0) return 'maxPages ' + want + ' left ' + ok.rs._pTop + ' free';
        const short = pair(RS, U32, 4, 4, want - 1, P);
        let e = null, before = null;
        for (const x of groups) {
            before = snap(short.rs);
            try { short.add(x); } catch (x2) { e = x2; break; }
        }
        if (!e || !PAGE_RE.test(e.message)) return 'maxPages ' + (want - 1) + ' did not throw';
        if (snap(short.rs) !== before) return 'short pool throw changed state';
        return short.check(groups);
    });
}

function bestpKindRows(RS) {
    const A = new RS(U32, 32, 32, undefined, 6), B = new RS(U32, 32, 32, undefined, 10);
    const mA = new Model(), mB = new Model();
    const n = BP_KINDS.length, seen = new Set();
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const c = ((i * n + j) * 1031 + 17) % 65536;
        for (const x of BP_KINDS[i][1](c * 65536)) { A.add(x); mA.add(x); }
        for (const x of BP_KINDS[j][1](c * 65536)) { B.add(x); mB.add(x); }
    }
    A.runOptimize(); B.runOptimize();
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const c = ((i * n + j) * 1031 + 17) % 65536;
        seen.add(kindOf(A, c) + '' + kindOf(B, c));
    }
    if (seen.size !== n * n) return 'kind pairs ' + seen.size + ' (want ' + n * n + ')';
    return checkSet(A, mA, rng(11), U32, null) || checkSet(B, mB, rng(12), U32, null);
}

// ---- real-module page stream: N sets, ONE op stream, one model -----------------------------------------------
// cfgs = [[U, maxS, maxL, maxPages, pageBits], ...] (same U). Every op on every set; results / throws / sizes
// equal (a page throw on a paged set only: the key is taken back out of the sets that did not throw); every 500
// ops checkSet on each, dumps (minus .paged) and own-key order equal; runOptimize every 2,500; clear at ops / 2.
function stream(RS, cfgs, OPS, seed, K, st) {
    const U = cfgs[0][0];
    const sets = cfgs.map(([u, s, l, mp, pb]) => new RS(u, s, l, mp, pb));
    const pagedOf = sets.map((s) => s.paged);
    for (let i = 0; i < sets.length; i++) {
        const want = expectPaged(...[cfgs[i][0], cfgs[i][3], cfgs[i][4]]);
        if (sets[i].paged !== want) return 'set ' + i + ' paged ' + sets[i].paged + ' want ' + want;
    }
    if (sets.length > 1 && !(pagedOf.includes(true) && pagedOf.includes(false))) return 'mixed row needs a direct and a paged set';
    const keys0 = Object.keys(sets[0]).join();
    for (const s of sets) if (Object.keys(s).join() !== keys0) return 'own keys differ: ' + Object.keys(s).join();
    const md = new Model();
    const r = rng(seed), ro = rng(seed ^ 0x9e3779b9);
    const C = Math.ceil(U / 65536);
    // the paged set with the fewest pages sets the page spread: maxPages + 8 candidate pages (capped at dirLen)
    const pg = sets.filter((s) => s.paged).sort((a, b) => a._maxP - b._maxP)[0];
    const E = 1 << pg._pSh, dirLen = pg._dir.length;
    const nCand = Math.min(dirLen, pg._maxP + 8);
    const cand = [];
    for (let i = 0; i < nCand; i++) cand.push(Math.floor((i * dirLen) / nCand));
    const hot = [0, C - 1, C >>> 1, Math.floor(r() * C)];
    const spread = [];                       // spread keys present (swap-remove)
    let runPos = Math.floor(r() * 65536), rr = 0;
    // each half: RAMP (first 40%: spread keys only grow, round-robin over the candidate pages, so live pages outgrow
    // maxPages -> page-pool throws), then DRAIN (spread keys mostly deleted -> pages empty -> releases)
    let ramp = true;
    const gen = (forAdd) => {
        if (ro() < (ramp ? 0.6 : 0.1)) {
            const c = Math.min(C - 1, cand[(forAdd ? rr++ : Math.floor(r() * nCand)) % nCand] * E + Math.floor(r() * E));
            const x = c * 65536 + Math.floor(r() * 65536);
            return [x < U ? x : U - 1, true];
        }
        const c = hot[Math.floor(r() * 4)], b = c * 65536, m = Math.floor(ro() * 3);
        let x;
        if (m === 0) x = b + 1000 + Math.floor(r() * 6000);
        else if (m === 1) { runPos = (runPos + 1 + (r() < 0.05 ? Math.floor(r() * 300) : 0)) & 0xFFFF; x = b + runPos; }
        else x = b + 2 * Math.floor(r() * 2400);
        return [x < U ? x : U - 1, false];
    };
    const cmp = (what, vals) => { for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[0]) return what + ' set ' + i + ' ' + vals[i] + ' vs ' + vals[0]; return null; };
    const half = OPS >> 1;
    for (let op = 0; op < OPS; op++) {
        ramp = op % half < 0.4 * half;
        if (op === OPS >> 1) { for (const s of sets) s.clear(); md.clear(); spread.length = 0; }
        if (op > 0 && op % 2500 === 0) for (const s of sets) s.runOptimize();
        const roll = ro();
        let d = null;
        if (roll < 0.5) {
            const [x, isSpread] = gen(true);
            const had = md.s.has(x);
            const errs = sets.map((s) => { try { s.add(x); return null; } catch (e) { return String(e && e.message); } });
            const pageThrew = errs.map((e) => e !== null && PAGE_RE.test(e));
            const any = errs.some((e) => e !== null);
            if (any) {
                for (let i = 0; i < sets.length; i++) {
                    if (errs[i] !== null && !POOL_RE.test(errs[i])) return 'op ' + op + ' add(' + x + ') threw ' + errs[i];
                    if (errs[i] !== null && sets[i].has(x) !== had) return 'op ' + op + ' failed add(' + x + ') changed has';
                }
                const nonPage = errs.map((e, i) => (pageThrew[i] ? '#page' : e));
                const firstNon = nonPage.find((e) => e !== '#page');
                for (let i = 0; i < sets.length; i++) if (!pageThrew[i] && nonPage[i] !== firstNon) return 'op ' + op + ' add(' + x + ') throws differ: ' + JSON.stringify(errs);
                if (!had && firstNon === null) for (let i = 0; i < sets.length; i++) if (!pageThrew[i]) sets[i].delete(x); // take it back out
                if (!had && pageThrew.some((p, i) => p && !pagedOf[i])) return 'op ' + op + ' a DIRECT set threw the page text';
            } else {
                md.add(x);
                if (isSpread && !had) spread.push(x);
            }
        } else if (roll < 0.85) {
            let x;
            const pick = ro();
            if (ramp) { x = gen(false)[0]; if (spread.includes(x)) x = hot[0] * 65536 + 1; }
            else if (pick < 0.8 && spread.length) { const j = Math.floor(r() * spread.length); x = spread[j]; spread[j] = spread[spread.length - 1]; spread.pop(); }
            else if (pick < 0.9 && md.a.length) x = md.a[Math.floor(r() * md.a.length)];
            else x = gen(false)[0];
            const want = md.delete(x);
            if (want && (ramp || pick >= 0.8)) { const j = spread.indexOf(x); if (j >= 0) { spread[j] = spread[spread.length - 1]; spread.pop(); } }
            d = cmp('op ' + op + ' delete(' + x + ')', sets.map((s) => s.delete(x)).concat([want]));
        } else if (roll < 0.97) {
            const x = gen(false)[0];
            for (const q of [x - 1, x, x + 1]) {
                if (q < 0 || q >= U) continue;
                d = d || cmp('op ' + op + ' has(' + q + ')', sets.map((s) => s.has(q)).concat([md.s.has(q)])) ||
                    cmp('op ' + op + ' successor(' + q + ')', sets.map((s) => s.successor(q)).concat([md.succ(q)])) ||
                    cmp('op ' + op + ' predecessor(' + q + ')', sets.map((s) => s.predecessor(q)).concat([md.pred(q)]));
            }
        } else {
            d = cmp('op ' + op + ' min', sets.map((s) => s.min()).concat([md.min()])) || cmp('op ' + op + ' max', sets.map((s) => s.max()).concat([md.max()]));
        }
        if (d) return d;
        d = cmp('op ' + op + ' size', sets.map((s) => s.size).concat([md.s.size]));
        if (d) return d;
        if (op % K === K - 1) for (let i = 0; i < sets.length; i++) { st.checks++; const e = checkPages(sets[i], null); if (e) return 'op ' + op + ' set ' + i + ' page invariants: ' + e; }
        if (op % 500 === 499 || op === OPS - 1) {
            for (let i = 0; i < sets.length; i++) { const e = checkSet(sets[i], md, rng(op + i), U, null); if (e) return 'op ' + op + ' set ' + i + ': ' + e; }
            const dumps = sets.map((s) => { const o = s.dump(); return JSON.stringify({ ...o, paged: null }); });
            d = cmp('op ' + op + ' dump', dumps);
            if (d) return d.slice(0, 200);
            for (let i = 0; i < sets.length; i++) if (sets[i].dump().paged !== pagedOf[i] || sets[i].paged !== pagedOf[i]) return 'op ' + op + ' .paged moved on set ' + i;
            for (const s of sets) if (Object.keys(s).join() !== keys0) return 'op ' + op + ' own keys differ';
        }
    }
    return null;
}

// ---- X: the full page pool -------------------------------------------------------------------------------------
function fullPool(RS) {
    const s = new RS(U32, 8, 8, 2, 8);
    if (!s.paged) return 'not paged';
    s.add(0); s.add(256 * 65536 * 3 + 5);
    if (s._pTop !== 0) return 'pool not full: pTop ' + s._pTop;
    const before = ownedState(s);
    for (const k of ['_pTop', '_size', '_maxP', '_pSh', '_pMask', '_sTop', '_lTop', '_conv', '_u', '_chunks']) {
        if (!(k in before.scalars)) return 'own scalar ' + k + ' not enumerated';
    }
    const size0 = s._size;
    let err = null;
    try { s.add(256 * 65536 * 7); } catch (e) { err = e; }
    if (err === null) return 'no throw';
    if (!(err instanceof RangeError)) return 'not a RangeError: ' + err;
    if (err.message !== PAGE_TEXT_2) return 'text ' + JSON.stringify(err.message);
    const diff = stateDiff(before, ownedState(s));
    if (diff) return 'failed add changed state: ' + diff;
    if (s._size !== size0 || s.size !== 2) return '_size moved';
    const md = new Model(); md.add(0); md.add(256 * 65536 * 3 + 5);
    const e = checkSet(s, md, rng(3), U32, null); if (e) return e;
    // control (teeth): an add on a mapped page succeeds and moves the snapshot
    s.add(1); s.add(65536 * 4 + 9);
    if (stateDiff(before, ownedState(s)) === null) return 'control: a successful add did not move the snapshot';
    return null;
}
