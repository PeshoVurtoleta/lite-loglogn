/**
 * @zakkster/lite-loglogn -- RoaringSet randomized differential fuzz (0.6.0 G1-B2, SPEC C-10 / C-10a,
 * PLAN-roaringset-G1 task 2, A-2). Logic only: no timers, no Workers, no file I/O. The Worker
 * (test/_roaring-fuzz-worker.mjs) and the test (test/RoaringFuzz.test.js) drive it.
 *
 * Ported from the R0 research harness roaring-fuzz.best.mjs (sha256/8 of the draft it ran on: fd261191).
 * What changed in the port (every edit is a removal or a parameter, never a new expectation):
 *   - the model (Set + sorted array), the key generators, the six random scenarios, the R scenarios
 *     (runOptimize + bulk ranges), the C scenarios (bitmap churn) and every targeted case are the draft's;
 *   - the white-box block is FIXED to the shipped kinds (1 small, 2 array, 3 bitmap, 4 runs, 5 smallRuns,
 *     6 full, 7 single) with per-chunk metadata read through the row of `rs._mi(c)`. A draft without `_mi`
 *     (R/RoaringDraft.best.mjs) is supported ONLY through the explicit option { draft: true } (row = c);
 *   - G3-B2a RESTORED (SPEC C-21): checkPair and its calls, the bitmap x bitmap / va kind-pair / vb SINGLE x kinds /
 *     kind x kind intersection cases (B ctor args (2, 3): direct on the real build (C-5); paged pb3 vs the lane's pbP only under RoaringPagedFuzz forced lanes). Was REMOVED in G1: the bitmap x bitmap /
 *     kind-pair / SINGLE x kinds intersection cases (set ops), the XK (pageBits) argument, the vc
 *     paged-row checks, the vb2 size-class paths and the `_q` counter read;
 *   - the six basic scenarios now draw ops from their own PRNG stream (keys and ops are independent
 *     streams in every scenario);
 *   - seeds: scenario seed s = 1..seeds, mixed with `base` (LOGLOGN_SEED) by sd(s, K, U) =
 *     (imul((s + base) | 0, K) + U) >>> 0 -- 32-bit exact, and identical to the draft's `s * K + U` at base 0.
 *
 * Coverage floors (asserted, A-2): per R scenario each of kinds 1..7, per C scenario kinds 1..4, and
 * bitmapsWithZeroWord, summed over the scenario's check points, reaches 100. Exempt by design: R pool0
 * (maxSmall 0) for kinds 1 and 5 (they need a small slot). A scenario below a floor is a FAIL row.
 *
 * API:  runRoaringFuzz(RoaringSet, { seeds, ops, base?, draft?, only?, seedsBy?, names? }) ->
 *         { failures, rows: [{ ok, text }], cov: [...], lines, seeds, ops, base, only }
 *       failures = number of FAIL rows (0 = green). `only` = a subset of SECTIONS (default all); `seedsBy` = { scenarioName: seeds } overrides `seeds` for R / C scenarios; `names` = run only those R / C scenarios; `trace` in the result = per-seed cumulative R / C coverage. RSCEN / CSCEN (exported) are the registry.
 *       floorMisses(cov) -> string[] (independent re-check of the floors; [] = met).
 *       The A-3 / A-4 contract oracle (ownedSnapshot, A3_CASES, A4_CASES, checkA3, checkA4,
 *       checkUniverse) is at the end of this file.
 */

import { createHash } from 'node:crypto';

export const SECTIONS = ['SCEN', 'R', 'C', 'T', 'V', 'D', 'E', 'B'];

const OPT_KEYS = ['seeds', 'ops', 'base', 'draft', 'only', 'seedsBy', 'names'];

// the R / C scenario registry (module scope so the test derives its expectations from it)
export const RSCEN = [
    { name: 'R U=2^20 range+opt mix', U: 1 << 20, mode: 'mix', maxS: 16, maxL: 16, every: 25 },
    { name: 'R U=2^18 range+opt runs', U: 1 << 18, mode: 'runs', maxS: 8, maxL: 8, every: 25 },
    { name: 'R U=2^32 range+opt mix', U: 4294967296, mode: 'mix', maxS: 64, maxL: 32, every: 25 },
    { name: 'R U=2^20 range+opt pool0', U: 1 << 20, mode: 'stride', maxS: 0, maxL: 24, every: 25 },
    { name: 'R U=200001 range+opt', U: 200001, mode: 'mix', maxS: 8, maxL: 8, every: 25 },
];

export const CSCEN = [
    { name: 'C U=2^18 bitmap churn', U: 1 << 18, maxS: 8, maxL: 8, every: 50, hot: (r) => [Math.floor(r() * 4), Math.floor(r() * 4)] },
    { name: 'C U=2^32 bitmap churn hi', U: 4294967296, maxS: 8, maxL: 8, every: 50, hot: () => [65535, 32768] },
];

export function runRoaringFuzz(RoaringSet, opts) {
    if (typeof RoaringSet !== 'function') throw new TypeError('runRoaringFuzz: RoaringSet must be a class');
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('runRoaringFuzz: opts must be a plain object');
    for (const k of Object.keys(opts)) {
        if (!OPT_KEYS.includes(k)) throw new TypeError('runRoaringFuzz: unknown option ' + JSON.stringify(k) + ' (known: ' + OPT_KEYS.join(', ') + ')');
    }
    const SEEDS = opts.seeds;
    const OPS = opts.ops;
    const BASE = opts.base === undefined ? 0 : opts.base;
    const DRAFT = opts.draft === undefined ? false : opts.draft;
    // seedsBy: { scenarioName: seeds } overrides `seeds` for R / C scenarios; names: run only those R / C scenarios
    const SEEDS_BY = opts.seedsBy === undefined ? {} : opts.seedsBy;
    const NAMES = opts.names === undefined ? null : opts.names;
    const seedsFor = (sc) => (SEEDS_BY[sc.name] === undefined ? SEEDS : SEEDS_BY[sc.name]);
    const picked = (sc) => NAMES === null || NAMES.includes(sc.name);
    const trace = [];
    const only = opts.only === undefined ? SECTIONS : opts.only;
    if (!Number.isInteger(SEEDS) || SEEDS < 1) throw new RangeError('runRoaringFuzz: seeds must be an integer >= 1');
    if (!Number.isInteger(OPS) || OPS < 1) throw new RangeError('runRoaringFuzz: ops must be an integer >= 1');
    if (!Number.isInteger(BASE) || BASE < 0 || BASE > 0xFFFFFFFF) throw new RangeError('runRoaringFuzz: base must be an integer in [0, 2^32 - 1]');
    if (typeof DRAFT !== 'boolean') throw new TypeError('runRoaringFuzz: draft must be a boolean');
    if (!Array.isArray(only) || only.length === 0 || only.some((n) => !SECTIONS.includes(n))) {
        throw new RangeError('runRoaringFuzz: only must be a non-empty subset of ' + SECTIONS.join(','));
    }

    let failures = 0;
    const lines = [];
    const rows = [];
    const cov = [];
    const log = (line) => {
        lines.push(line);
        if (line.startsWith('FAIL ')) rows.push({ ok: false, text: line });
        else if (line.startsWith('ok   ')) rows.push({ ok: true, text: line });
    };
    const sd = (seed, K, U) => (Math.imul((seed + BASE) | 0, K) + U) >>> 0;
    // the metadata row of chunk c: the shipped engine reads it through _mi; the explicit draft option reads c
    const rw = (rs, c) => (DRAFT ? c : rs._mi(c));
    function kindOf(rs, c) { return rs._kind[rw(rs, c)]; }

    // fixed to the shipped kinds (the draft's feature detection is gone)
    const WB_SINGLE = true;
    const WB_SK = 7;
    const WB_CLASSES = false;
    const WB_SMALLRUNS = true;
    const WB_HYST = true;
    const WB_HDR = true;
    const WB_PROBE = new RoaringSet(65536, 1, 1);
    const WB_SUM_LAYOUT = WB_PROBE._bSum instanceof Uint32Array && WB_PROBE._lU32 instanceof Uint32Array &&
        WB_PROBE._bSum.length === (WB_PROBE._maxL + 1) * 66 && WB_PROBE._lU32.length === (WB_PROBE._maxL + 1) * 2048;
    const WB_SUM = WB_SUM_LAYOUT;
    log('# white-box: kinds fixed 1..7 draft=' + DRAFT + ' summary=' + (WB_SUM ? 'on' : 'SKIP (layout differs: floor will FAIL)'));

    function vaSnap(rs) {
        const o = [];
        for (const key of Object.keys(rs)) {
            const v = rs[key];
            o.push(key + '=' + (ArrayBuffer.isView(v) ? Array.prototype.join.call(v, ',') : String(v)));
        }
        return o.join('|');
    }

    function covRow(sc, isR) {
        return {
            scenario: sc.name, isR, maxS: sc.maxS, checks: KSTAT.checks,
            kinds: Object.fromEntries([...KSTAT.k.entries()]), bmpZeroWord: KSTAT.bmpZeroWord,
        };
    }

    function rng(seed) {
        let s = seed >>> 0;
        return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }

    class Model {
        constructor() { this.s = new Set(); this.sorted = null; }
        add(x) { if (!this.s.has(x)) { this.s.add(x); this.sorted = null; } }
        delete(x) { const had = this.s.delete(x); if (had) this.sorted = null; return had; }
        arr() { if (this.sorted === null) this.sorted = Float64Array.from(this.s).sort(); return this.sorted; }
        lb(x) { const a = this.arr(); let l = 0, h = a.length; while (l < h) { const m = (l + h) >>> 1; if (a[m] < x) l = m + 1; else h = m; } return l; }
        succ(x) { const a = this.arr(); const j = this.lb(x + 1); return j < a.length ? a[j] : undefined; }
        pred(x) { const a = this.arr(); const j = this.lb(x); return j > 0 ? a[j - 1] : undefined; }
        min() { const a = this.arr(); return a.length ? a[0] : undefined; }
        max() { const a = this.arr(); return a.length ? a[a.length - 1] : undefined; }
    }

    // Key generators, chosen so every container kind and every conversion fires.
    function makeGen(r, U, mode) {
        const chunks = Math.ceil(U / 65536);
        const hot = [0, Math.min(chunks - 1, 1), Math.min(chunks - 1, 7), chunks - 1, Math.floor(r() * chunks)];
        const pickChunk = () => hot[Math.floor(r() * hot.length)];
        const clampU = (x) => (x >= U ? U - 1 : x);
        let runPos = Math.floor(r() * 65536);
        const denseOff = Math.floor(r() * 59000);                                    // differs per set
        return () => {
            const c = pickChunk();
            const base = c * 65536;
            const m = mode === 'mix' ? ['sparse', 'dense', 'runs', 'stride'][Math.floor(r() * 4)] : mode;
            if (m === 'sparse') return clampU(Math.floor(r() * U));
            if (m === 'dense') return clampU(base + denseOff + Math.floor(r() * 6000)); // crosses 4096 in one chunk
            if (m === 'runs') { runPos = (runPos + 1 + (r() < 0.05 ? Math.floor(r() * 300) : 0)) & 0xFFFF; return clampU(base + runPos); }
            return clampU(base + 2 * Math.floor(r() * 2400));                          // isolated keys: many runs
        };
    }
    const KSTAT = { k: new Map(), bmpZeroWord: 0, checks: 0 };                             // coverage at check points
    function kstatReset() { KSTAT.k = new Map(); KSTAT.bmpZeroWord = 0; KSTAT.checks = 0; KSTAT.floorNote = null; }
    const FLOOR = 100;
    const FLOOR_SINGLE_R = true;                                                // best: R floor on SINGLE (kind 7)
    // sc: the scenario; isR: an R scenario. Returns null or the floor failure text.
    function kstatFloor(sc, isR) {
        const need = [1, 2, 3, 4];
        if (isR && WB_SMALLRUNS) need.push(5, 6);
        if (isR && WB_SINGLE && WB_SK !== 7) need.push(WB_SK);                              // vb: SINGLE = kind 5
        else if (isR && WB_SINGLE && FLOOR_SINGLE_R) need.push(WB_SK);                      // best: SINGLE = kind 7
        const exempt = [];
        const miss = [];
        for (const k of need) {
            if (isR && sc.maxS === 0 && ((k === 1 && !WB_CLASSES) || (k === 5 && WB_SMALLRUNS))) { exempt.push(k); continue; }
            const n = KSTAT.k.get(k) || 0;
            if (n < FLOOR) miss.push('kind ' + k + ' ' + n);
        }
        if (KSTAT.bmpZeroWord < FLOOR) miss.push('bitmapsWithZeroWord ' + KSTAT.bmpZeroWord + (WB_SUM_LAYOUT ? '' : ' (no base word layout: unmeasurable)'));
        KSTAT.floorNote = 'floors >= ' + FLOOR + ' on kinds ' + need.filter((k) => !exempt.includes(k)).join(',') + ' + bitmapsWithZeroWord' + (exempt.length ? ' (exempt by design: kind ' + exempt.join(',') + ')' : '');
        return miss.length ? 'coverage floor < ' + FLOOR + ': ' + miss.join(', ') : null;
    }
    function kstatLine() {
        const ks = [...KSTAT.k.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => k + ':' + n).join(' ');
        return 'kinds@check {' + ks + '} bitmapsWithZeroWord ' + KSTAT.bmpZeroWord + ' checks ' + KSTAT.checks + (KSTAT.floorNote ? ' | ' + KSTAT.floorNote : '');
    }

    // vef + W2: a bitmap's 66-word summary must equal a rescan of its 2,048 words; popcount must equal the model.
    function checkSummary(rs, c, row, want) {
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
        if ((rs._bSum[sb + 64] | 0) !== l2a || (rs._bSum[sb + 65] | 0) !== l2b) return 'chunk ' + c + ' _bSum L2 ' + (rs._bSum[sb + 64] | 0) + ',' + (rs._bSum[sb + 65] | 0) + ' vs rescan ' + l2a + ',' + l2b;
        if (pc !== want) return 'chunk ' + c + ' bitmap popcount ' + pc + ' vs model ' + want;
        if (zero !== 0) KSTAT.bmpZeroWord++;
        return null;
    }

    function hasZeroWord(rs, row) {                                               // r2: coverage count without the summary check
        const wb = rs._slot[row] << 11;
        for (let i = 0; i < 2048; i++) if (rs._lU32[wb + i] === 0) return true;
        return false;
    }

    function checkSet(rs, md, r, U) {
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
        // per-chunk cardinality, headers and pool accounting (white-box)
        const per = new Map();
        const cMn = new Map(), cMx = new Map();
        for (const k of md.s) {
            const c = Math.floor(k / 65536); per.set(c, (per.get(c) || 0) + 1);
            const l = k % 65536;
            if (!cMn.has(c) || l < cMn.get(c)) cMn.set(c, l);
            if (!cMx.has(c) || l > cMx.get(c)) cMx.set(c, l);
        }
        let small = 0, large = 0;
        KSTAT.checks++;
        for (let c = 0; c < rs._chunks; c++) {
            const row = rw(rs, c);
            const k = rs._kind[row];
            const want = per.get(c) || 0;
            if (k === 0) { if (want !== 0) return 'chunk ' + c + ' kind 0 but model has ' + want; continue; }
            KSTAT.k.set(k, (KSTAT.k.get(k) || 0) + 1);
            if (rs._card[row] + 1 !== want) return 'chunk ' + c + ' kind ' + k + ' _card+1=' + (rs._card[row] + 1) + ' vs model ' + want;
            if (rs._cMin[row] !== cMn.get(c)) return 'chunk ' + c + ' kind ' + k + ' _cMin=' + rs._cMin[row] + ' vs model ' + cMn.get(c);
            if (rs._cMax[row] !== cMx.get(c)) return 'chunk ' + c + ' kind ' + k + ' _cMax=' + rs._cMax[row] + ' vs model ' + cMx.get(c);
            if (k > 7) return 'chunk ' + c + ' bad kind ' + k;
            if (k === 7) {                                                       // SINGLE: no pool slot, _slot = the low key
                if (!md.s.has(c * 65536 + rs._slot[row])) return 'chunk ' + c + ' SINGLE _slot=' + rs._slot[row] + ' not in model';
                continue;
            }
            if (want < 2) return 'chunk ' + c + ' kind ' + k + ' holds ' + want + ' key (want SINGLE)';
            if (k === 1) {
                if (want > 64) return 'chunk ' + c + ' kind 1 with ' + want + ' keys';
                small++;
            } else if (k === 5) {                                                // small runs in a small slot
                if (rs._runs[row] > 31) return 'chunk ' + c + ' kind 5 with ' + (rs._runs[row] + 1) + ' runs (> 32)';
                small++;
            } else if (k === 6) {                                                // FULL, no slot
                if (want !== 65536) return 'chunk ' + c + ' kind 6 (FULL) with ' + want + ' keys';
            } else {
                if (k === 2 && want > 4096) return 'chunk ' + c + ' kind 2 with ' + want + ' keys';
                if (k === 3) {
                    if (want <= 2048) return 'chunk ' + c + ' kind 3 with ' + want + ' keys (<= 2048)';
                    if (WB_SUM) { const e = checkSummary(rs, c, row, want); if (e) return e; }
                    else if (WB_SUM_LAYOUT && hasZeroWord(rs, row)) KSTAT.bmpZeroWord++;
                }
                large++;
            }
        }
        if (rs._sTop + small !== rs._maxS) return 'small pool: free ' + rs._sTop + ' + used ' + small + ' != ' + rs._maxS;
        if (rs._lTop + large !== rs._maxL) return 'large pool: free ' + rs._lTop + ' + used ' + large + ' != ' + rs._maxL;
        return null;
    }

    // Set ops (G3, SPEC C-21): all four against the model, both argument orders, self, and neither set written
    // (size + dump() before == after). Expected values come from the JS Set model only.
    const stateKey = (rs) => rs.size + '|' + JSON.stringify(rs.dump());
    function checkPair(a, ma, b, mb) {
        const ka = stateKey(a), kb = stateKey(b);
        let inter = 0;
        const [sm, lg] = ma.s.size <= mb.s.size ? [ma.s, mb.s] : [mb.s, ma.s];
        for (const k of sm) if (lg.has(k)) inter++;
        // one call, one compare, then dump() + size of both sets must be unchanged (A-1: after EVERY call)
        const one = (name, got, want) => {
            if (got !== want) return name + ' ' + got + ' vs ' + want;
            if (stateKey(a) !== ka || stateKey(b) !== kb) return name + ' changed a set (size / dump)';
            return null;
        };
        const un = ma.s.size + mb.s.size - inter;
        return one('intersectionSize', a.intersectionSize(b), inter) || one('intersectionSize (swapped)', b.intersectionSize(a), inter) ||
            one('intersects', a.intersects(b), inter > 0) || one('intersects (swapped)', b.intersects(a), inter > 0) ||
            one('unionSize', a.unionSize(b), un) || one('unionSize (swapped)', b.unionSize(a), un) ||
            one('differenceSize', a.differenceSize(b), ma.s.size - inter) || one('differenceSize (swapped)', b.differenceSize(a), mb.s.size - inter) ||
            one('a self intersectionSize', a.intersectionSize(a), ma.s.size) || one('a self unionSize', a.unionSize(a), ma.s.size) ||
            one('a self differenceSize', a.differenceSize(a), 0) || one('a self intersects', a.intersects(a), ma.s.size > 0) ||
            one('b self intersectionSize', b.intersectionSize(b), mb.s.size) || one('b self unionSize', b.unionSize(b), mb.s.size) ||
            one('b self differenceSize', b.differenceSize(b), 0) || one('b self intersects', b.intersects(b), mb.s.size > 0);
    }

    // ---- W2 probes ---------------------------------------------------------------------------------------------
    // One query point against the sorted-array model.
    function probeQ(rs, md, q, U, what) {
        if (q < 0 || q >= U || q !== Math.floor(q)) return null;
        if (rs.has(q) !== md.s.has(q)) return what + 'has(' + q + ') ' + rs.has(q);
        const s1 = rs.successor(q), s2 = md.succ(q);
        if (s1 !== s2) return what + 'successor(' + q + ') ' + s1 + ' vs ' + s2;
        const p1 = rs.predecessor(q), p2 = md.pred(q);
        if (p1 !== p2) return what + 'predecessor(' + q + ') ' + p1 + ' vs ' + p2;
        return null;
    }
    // Walk oracle: the TRUE definition over the Set (no sorted array, no geometry); past 4,096 steps (a long gap)
    // it falls back to a linear scan of the Set (min key > q / max key < q), still the definition, no sort.
    function walkSucc(md, q, U) {
        const lim = Math.min(U, q + 4097);
        for (let x = q + 1; x < lim; x++) if (md.s.has(x)) return x;
        if (lim === U) return undefined;
        let b = Infinity;
        for (const k of md.s) if (k > q && k < b) b = k;
        return b === Infinity ? undefined : b;
    }
    function walkPred(md, q) {
        const lim = Math.max(-1, q - 4097);
        for (let x = q - 1; x > lim; x--) if (md.s.has(x)) return x;
        if (lim === -1) return undefined;
        let b = -1;
        for (const k of md.s) if (k < q && k > b) b = k;
        return b === -1 ? undefined : b;
    }
    function probeW(rs, md, q, U, what) {
        if (q < 0 || q >= U) return null;
        if (rs.has(q) !== md.s.has(q)) return what + 'has(' + q + ') ' + rs.has(q);
        const s1 = rs.successor(q), s2 = walkSucc(md, q, U);
        if (s1 !== s2) return what + 'successor(' + q + ') ' + s1 + ' vs ' + s2;
        const p1 = rs.predecessor(q), p2 = walkPred(md, q);
        if (p1 !== p2) return what + 'predecessor(' + q + ') ' + p1 + ' vs ' + p2;
        return null;
    }
    // Right after a span [lo, hi) was emptied or refilled: probe just below / above it and from the nearest keys
    // outside it (the stale-summary shape: a miss in an earlier word of the same L1 group).
    function spanProbes(rs, md, lo, hi, U, what) {
        const pb = walkPred(md, lo), sa = walkSucc(md, hi - 1, U);
        const qs = [lo - 2, lo - 1, lo, lo + 1, hi - 2, hi - 1, hi, hi + 1];
        if (pb !== undefined) qs.push(pb, pb + 1, pb - 1);
        if (sa !== undefined) qs.push(sa, sa - 1, sa + 1);
        for (const q of qs) { const e = probeW(rs, md, q, U, what); if (e) return e; }
        return null;
    }
    // L1 boundaries (every 1,024 lows = 32 words) and the L2 boundary (low 32,768) of a chunk, plus word edges.
    function boundaryProbes(rs, md, c, U, what) {
        const base = c * 65536;
        if (base >= U) return null;
        for (let g = 0; g <= 64; g++) {
            const e = probeQ(rs, md, base + g * 1024 - 1, U, what) || probeQ(rs, md, base + g * 1024, U, what);
            if (e) return e;
        }
        return null;
    }
    // Gap edges near random model keys: the last key before a hole and the first after, and the word edges there.
    function gapProbes(rs, md, r, U, n, what) {
        const a = md.arr();
        if (a.length === 0) return null;
        for (let t = 0; t < n; t++) {
            let j = Math.floor(r() * a.length);
            for (let s = 0; s < 64 && j + 1 < a.length && a[j + 1] === a[j] + 1; s++) j++;
            const k = a[j], nx = j + 1 < a.length ? a[j + 1] : U;
            const qs = [k, k + 1, k - (k % 32) + 31, k - (k % 32) + 32, nx - 1, nx, nx - (nx % 32) - 1, nx - (nx % 32)];
            for (const q of qs) { const e = probeQ(rs, md, q, U, what); if (e) return e; }
        }
        return null;
    }

    function sec_SCEN() {
    const SCEN = [
        { name: 'U=2^32 mix', U: 4294967296, mode: 'mix', maxS: 64, maxL: 32 },
        { name: 'U=2^20 dense', U: 1 << 20, mode: 'dense', maxS: 16, maxL: 16 },
        { name: 'U=2^20 runs', U: 1 << 20, mode: 'runs', maxS: 16, maxL: 16 },
        { name: 'U=2^20 stride', U: 1 << 20, mode: 'stride', maxS: 16, maxL: 16 },
        { name: 'U=200001 mix', U: 200001, mode: 'mix', maxS: 8, maxL: 8 },
        { name: 'U=2^20 mix small pool 0', U: 1 << 20, mode: 'mix', maxS: 0, maxL: 24 },
    ];
    for (const sc of SCEN) {
        let first = null;
        for (let seed = 1; seed <= SEEDS && first === null; seed++) {
            const r = rng(sd(seed, 7919, sc.U));
            const ro = rng(sd(seed, 7919, sc.U) ^ 0x9e3779b9);
            const A = new RoaringSet(sc.U, sc.maxS, sc.maxL), B = new RoaringSet(sc.U, sc.maxS, sc.maxL);
            const mA = new Model(), mB = new Model();
            const gA = makeGen(r, sc.U, sc.mode), gB = makeGen(r, sc.U, sc.mode);
            for (let op = 0; op < OPS && first === null; op++) {
                const which = ro() < 0.5;
                const [S, M, G] = which ? [A, mA, gA] : [B, mB, gB];
                const x = G();
                const roll = ro();
                try {
                    if (roll < 0.62) { S.add(x); M.add(x); }
                    else if (roll < 0.97) { const got = S.delete(x), want = M.delete(x); if (got !== want) first = { op, d: 'delete(' + x + ') ' + got }; }
                    else if (roll < 0.99) { S.runOptimize(); }
                    else { S.clear(); M.s.clear(); M.sorted = null; }
                } catch (e) {
                    if (/pool exhausted/.test(String(e.message))) { // fail-closed: state must equal the model
                        const d = checkSet(S, M, r, sc.U);
                        if (d) first = { op, d: 'after pool throw: ' + d };
                        S.clear(); M.s.clear(); M.sorted = null;
                        continue;
                    }
                    first = { op, d: 'threw ' + e.message };
                    break;
                }
                if (first) break;
                if (op % 25 === 0 || op === OPS - 1) {
                    const d = checkSet(S, M, r, sc.U) || checkPair(A, mA, B, mB);
                    if (d) first = { op, d };
                }
            }
            if (first) first.seed = seed;
        }
        if (first) failures++;
        log((first ? 'FAIL ' : 'ok   ') + sc.name.padEnd(26) + (first ? ' seed ' + first.seed + ' op ' + first.op + ': ' + first.d : ' (' + SEEDS + ' seeds x ' + OPS + ' ops)'));
    }
    }

    function sec_R() {
    // ---- R scenarios: runOptimize + bulk ranges ---------------------------------------------------------------
    const RCAP = 100000;                                                             // model size bound (sort cost)
    function hotChunks(r, U) {
        const chunks = Math.ceil(U / 65536);
        return [0, Math.min(chunks - 1, 1), Math.min(chunks - 1, 7), chunks - 1, Math.floor(r() * chunks)];
    }
    function pickRange(r, U, hot, forDelete) {
        const c = hot[Math.floor(r() * hot.length)], base = c * 65536;
        const t = r();
        let lo, len;
        if (t < 0.35) {
            lo = base + Math.floor(r() * 65536);
            if (r() < 0.5) { lo -= lo % 32; len = 32 * (1 + Math.floor(r() * 3)); } else len = 1 + Math.floor(r() * 64);
        } else if (t < 0.65) { lo = base + Math.floor(r() * 65536); len = 32 + Math.floor(r() * 2000); }
        else if (t < 0.9) { lo = base + Math.floor(r() * 60000); len = 3000 + Math.floor(r() * 6000); }
        else {                                                                       // a whole chunk, or off by one
            const v = r();
            lo = base + (v < 0.15 ? 1 : 0); len = 65536 - (v < 0.15 ? 1 : (v < 0.3 ? 1 : 0));
        }
        if (forDelete && r() < 0.3) { lo -= lo % 1024; len = 1024 * (1 + Math.floor(r() * 2)); } // whole L1 group(s)
        const hi = Math.min(U, lo + len);
        return [Math.min(lo, U - 1), hi];
    }
    for (const sc of RSCEN.filter(picked)) {
        let first = null;
        kstatReset();
        for (let seed = 1; seed <= seedsFor(sc) && first === null; seed++) {
            const r = rng(sd(seed, 104729, sc.U));                                     // keys / spans / chunks / probes
            const ro = rng(sd(seed, 104729, sc.U) ^ 0x9e3779b9);                     // r2: ops
            const A = new RoaringSet(sc.U, sc.maxS, sc.maxL), B = new RoaringSet(sc.U, sc.maxS, sc.maxL);
            const mA = new Model(), mB = new Model();
            const gA = makeGen(r, sc.U, sc.mode), gB = makeGen(r, sc.U, sc.mode);
            const hA = hotChunks(r, sc.U), hB = hotChunks(r, sc.U);
            for (let op = 0; op < OPS && first === null; op++) {
                const which = ro() < 0.5;
                const [S, M, G, H] = which ? [A, mA, gA, hA] : [B, mB, gB, hB];
                let roll = ro();
                if (M.s.size > RCAP) roll = 0.9;                                     // force a range delete
                let opt = false, span = null;
                try {
                    if (roll < 0.45) { const x = G(); S.add(x); M.add(x); }
                    else if (roll < 0.68) { const x = G(); const got = S.delete(x), want = M.delete(x); if (got !== want) first = { op, d: 'delete(' + x + ') ' + got }; }
                    else if (roll < 0.73) { S.runOptimize(); opt = ro() < 0.3; }
                    else if (roll < 0.86) {
                        const [lo, hi] = pickRange(r, sc.U, H, false);
                        span = [lo, hi];
                        for (let x = lo; x < hi; x++) { S.add(x); M.add(x); }
                    } else if (roll < 0.997) {
                        const fc = Math.floor(M.s.values().next().value / 65536) * 65536;     // the chunk of the oldest live key
                        const [lo, hi] = M.s.size > RCAP ? [fc, Math.min(sc.U, fc + 65536)] : pickRange(r, sc.U, H, true);
                        span = [lo, hi];
                        const down = ro() < 0.5;
                        for (let i = lo; i < hi && first === null; i++) {
                            const x = down ? hi - 1 - (i - lo) : i;
                            const got = S.delete(x), want = M.delete(x);
                            if (got !== want) first = { op, d: 'range delete(' + x + ') ' + got };
                        }
                    } else { S.clear(); M.s.clear(); M.sorted = null; }
                } catch (e) {
                    if (/pool exhausted/.test(String(e.message))) { // fail-closed: state must equal the model
                        const d = checkSet(S, M, r, sc.U);
                        if (d) first = { op, d: 'after pool throw: ' + d };
                        S.clear(); M.s.clear(); M.sorted = null;
                        continue;
                    }
                    first = { op, d: 'threw ' + e.message };
                    break;
                }
                if (first) break;
                if (span !== null && ro() < 0.25) { const d = spanProbes(S, M, span[0], span[1], sc.U, 'span '); if (d) { first = { op, d }; break; } }
                if (op % sc.every === 0 || op === OPS - 1 || opt) {
                    let d = checkSet(S, M, r, sc.U) || gapProbes(S, M, r, sc.U, 24, 'gap ');
                    for (let i = 0; i < H.length && d === null; i++) d = boundaryProbes(S, M, H[i], sc.U, 'L1/L2 ');
                    d = d || checkPair(A, mA, B, mB);
                    if (d) first = { op, d: (opt ? 'after runOptimize: ' : '') + d };
                }
            }
            if (first) first.seed = seed;
            trace.push({ scenario: sc.name, seed, kinds: Object.fromEntries([...KSTAT.k.entries()]), bzw: KSTAT.bmpZeroWord });
        }
        if (first === null) { const f = kstatFloor(sc, true); if (f) first = { seed: 'all', op: '-', d: f }; }
        if (first) failures++;
        log((first ? 'FAIL ' : 'ok   ') + sc.name.padEnd(26) + (first ? ' seed ' + first.seed + ' op ' + first.op + ': ' + first.d : ' (' + seedsFor(sc) + ' seeds x ' + OPS + ' ops)'));
        log('     ' + kstatLine());
        cov.push(covRow(sc, true));
    }
    }

    function sec_C() {
    // ---- C scenarios: bitmap churn (empty / refill whole words, L1 groups, spans across L1 / L2 edges) ---------
    function fillChunk(S, M, r, c) {
        const base = c * 65536, dens = 0.1 + 0.6 * r(), blk = r() < 0.5;
        for (let lo = 0; lo < 65536; lo++) {
            const on = blk ? (((lo >>> 7) & 3) !== 0 && r() < dens + 0.1) : r() < dens;
            if (on) { S.add(base + lo); M.add(base + lo); }
        }
    }
    function wordSpan(r, base) {                                                     // [lo, hi) of 1+ words, edges favoured
        const t = r();
        let w0, nw;
        if (t < 0.45) { w0 = Math.floor(r() * 2048); nw = 1; }
        else if (t < 0.7) { const g = Math.floor(r() * 64); w0 = g * 32 + (r() < 0.5 ? 0 : 31); nw = 1; } // first / last word of a group
        else if (t < 0.8) { w0 = r() < 0.5 ? 1023 : 1024; nw = 1; }                      // the L2 edge (L1 group 31 / 32)
        else if (t < 0.92) { const g = Math.floor(r() * 64); w0 = g * 32; nw = 32; }          // a whole L1 group
        else { const g = 1 + Math.floor(r() * 63), k = 1 + Math.floor(r() * 40); w0 = Math.max(0, g * 32 - k); nw = Math.min(2048 - w0, 2 * k); } // across an L1 edge
        return [base + w0 * 32, base + (w0 + nw) * 32];
    }
    for (const sc of CSCEN.filter(picked)) {
        let first = null;
        kstatReset();
        for (let seed = 1; seed <= seedsFor(sc) && first === null; seed++) {
            const r = rng(sd(seed, 15485863, sc.U));                                   // keys / spans / chunks / probes / fills
            const ro = rng(sd(seed, 15485863, sc.U) ^ 0x9e3779b9);                   // r2: ops
            const A = new RoaringSet(sc.U, sc.maxS, sc.maxL), B = new RoaringSet(sc.U, sc.maxS, sc.maxL);
            const mA = new Model(), mB = new Model();
            const hA = sc.hot(r), hB = sc.hot(r);
            try {
                for (const c of hA) fillChunk(A, mA, r, c);
                for (const c of hB) fillChunk(B, mB, r, c);
            } catch (e) { first = { op: -1, d: 'fill threw ' + e.message }; }
            for (let op = 0; op < OPS && first === null; op++) {
                const which = ro() < 0.5;
                const [S, M, H] = which ? [A, mA, hA] : [B, mB, hB];
                const c = H[Math.floor(r() * H.length)], base = c * 65536;
                const roll = ro();
                let span = null, opt = false;
                try {
                    if (roll < 0.40) {                                               // EMPTY a span of whole words
                        span = wordSpan(r, base);
                        const down = ro() < 0.5;
                        for (let i = span[0]; i < span[1] && first === null; i++) {
                            const x = down ? span[1] - 1 - (i - span[0]) : i;
                            const got = S.delete(x), want = M.delete(x);
                            if (got !== want) first = { op, d: 'delete(' + x + ') ' + got };
                        }
                    } else if (roll < 0.58) {                                        // REFILL: a random mask, or one bit
                        span = wordSpan(r, base);
                        const one = ro() < 0.3;
                        for (let x = span[0]; x < span[1]; x += 32) {
                            const m = one ? (1 << Math.floor(r() * 32)) >>> 0 : (Math.floor(r() * 4294967296) >>> 0);
                            for (let b = 0; b < 32; b++) if ((m >>> b) & 1) { S.add(x + b); M.add(x + b); }
                        }
                    } else if (roll < 0.88) {                                        // single add / delete
                        const x = base + Math.floor(r() * 65536);
                        if (ro() < 0.5) { S.add(x); M.add(x); }
                        else { const got = S.delete(x), want = M.delete(x); if (got !== want) first = { op, d: 'delete(' + x + ') ' + got }; }
                    } else if (roll < 0.92) { S.runOptimize(); opt = ro() < 0.3; }
                    else if (roll < 0.995) { if (M.s.size < 200000) fillChunk(S, M, r, c); } // bulk refill (stays a bitmap)
                    else { S.clear(); M.s.clear(); M.sorted = null; fillChunk(S, M, r, c); }
                } catch (e) {
                    if (/pool exhausted/.test(String(e.message))) {
                        const d = checkSet(S, M, r, sc.U);
                        if (d) first = { op, d: 'after pool throw: ' + d };
                        S.clear(); M.s.clear(); M.sorted = null;
                        continue;
                    }
                    first = { op, d: 'threw ' + e.message };
                    break;
                }
                if (first) break;
                if (span !== null) { const d = spanProbes(S, M, span[0], span[1], sc.U, 'span [' + span[0] + ',' + span[1] + ') '); if (d) { first = { op, d }; break; } }
                if (op % sc.every === 0 || op === OPS - 1 || opt) {
                    let d = checkSet(S, M, r, sc.U) || gapProbes(S, M, r, sc.U, 24, 'gap ');
                    for (let i = 0; i < H.length && d === null; i++) d = boundaryProbes(S, M, H[i], sc.U, 'L1/L2 ');
                    d = d || checkPair(A, mA, B, mB);
                    if (d) first = { op, d: (opt ? 'after runOptimize: ' : '') + d };
                }
            }
            if (first) first.seed = seed;
            trace.push({ scenario: sc.name, seed, kinds: Object.fromEntries([...KSTAT.k.entries()]), bzw: KSTAT.bmpZeroWord });
        }
        if (first === null) { const f = kstatFloor(sc, false); if (f) first = { seed: 'all', op: '-', d: f }; }
        if (first) failures++;
        log((first ? 'FAIL ' : 'ok   ') + sc.name.padEnd(26) + (first ? ' seed ' + first.seed + ' op ' + first.op + ': ' + first.d : ' (' + seedsFor(sc) + ' seeds x ' + OPS + ' ops)'));
        log('     ' + kstatLine());
        cov.push(covRow(sc, false));
    }
    }

    function sec_T() {
    // Targeted: a 2048-run container that must spill (add of a 2049th isolated run; delete splitting a run).
    function targeted(name, build) {
        const rs = new RoaringSet(1 << 20, 4, 4), md = new Model();
        const add = (x) => { rs.add(x); md.add(x); };
        const del = (x) => { rs.delete(x); md.delete(x); };
        let d;
        try { build(rs, add, del); d = checkSet(rs, md, rng(1), 1 << 20); } catch (e) { d = 'threw ' + e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + name.padEnd(26) + (d ? ' ' + d : ''));
    }
    targeted('run spill on add', (rs, add) => {
        for (let x = 60000; x < 60100; x++) add(x);          // 100 keys: a full array (kind 2)
        rs.runOptimize();                                    // array -> run container (1 run)
        for (let x = 0; x <= 2 * 2047; x += 2) add(x);       // 2048 isolated keys -> the 2049th run spills
    });
    targeted('run spill on delete', (rs, add, del) => {
        for (let x = 60000; x < 60100; x++) add(x);          // 100 keys: a full array (kind 2)
        rs.runOptimize();                                    // array -> run container (1 run)
        for (let x = 0; x < 2 * 2047; x += 2) add(x);        // + 2047 isolated keys = 2048 runs
        del(60050);                                          // splits a run -> 2049 runs -> spill
    });

    {
        // bitmap x bitmap in one chunk, different slots and different summaries in A and B (G3, SPEC C-21); B ctor args (2, 3): direct on the real build (C-5); paged pb3 vs the lane's pbP only under RoaringPagedFuzz forced lanes
        let d = null;
        try {
            for (const extra of [[], [2, 3]]) {
                const A = new RoaringSet(1 << 20, 4, 8), B = new RoaringSet(1 << 20, 4, 8, ...extra);
                const mA = new Model(), mB = new Model();
                const aa = (x) => { A.add(x); mA.add(x); }, ab = (x) => { B.add(x); mB.add(x); };
                for (let x = 0; x < 5000; x++) aa(65536 + 60000 + (x % 5536));   // A chunk 1 bitmap first
                for (let x = 0; x < 5000; x++) aa(x * 13);                       // A chunk 0: spread bitmap
                for (let x = 0; x < 5000; x++) ab(x * 13);                       // B chunk 0: same keys
                if (kindOf(A, 0) !== 3 || kindOf(A, 1) !== 3 || kindOf(B, 0) !== 3) throw new Error('bitmap x bitmap kinds ' + kindOf(A, 0) + kindOf(A, 1) + kindOf(B, 0));
                let want = 0; for (let x = 0; x < 5000; x++) if (mA.s.has(x * 13)) want++;
                if (want !== 5000) throw new Error('model intersection ' + want);
                d = d || checkPair(A, mA, B, mB) || checkPair(B, mB, A, mA);
                if (d) d = 'B extra [' + extra.join() + ']: ' + d;
            }
        } catch (e) { d = 'threw ' + e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + 'bitmap x bitmap slots'.padEnd(26) + (d ? ' ' + d : ''));
    }
    targeted('runOptimize run -> array', (rs, add) => {
        for (let x = 60000; x < 60100; x++) add(x);          // full array, 1 run
        rs.runOptimize();                                    // -> run container
        for (let x = 0; x < 600; x += 2) add(x);             // 300 isolated runs: 400 keys, 301 runs
        rs.runOptimize();                                    // array (800 B) beats runs (1204 B)
        if (kindOf(rs, 0) !== 2) throw new Error('kind ' + kindOf(rs, 0) + ' (want 2: array is smaller)');
    });
    {
        // clear() leaves the same layout as a fresh instance (free lists, spare slab)
        const rs = new RoaringSet(1 << 20, 4, 4), fresh = new RoaringSet(1 << 20, 4, 4);
        for (let x = 0; x < 9000; x++) rs.add(x);            // promotions swap the spare slab
        for (let x = 0; x < 70; x++) rs.add(200000 + x);
        rs.clear();
        const same = rs._conv === fresh._conv && rs._sTop === fresh._sTop && rs._lTop === fresh._lTop &&
            rs._sFree.join() === fresh._sFree.join() && rs._lFree.join() === fresh._lFree.join();
        if (!same) failures++;
        log((same ? 'ok   ' : 'FAIL ') + 'clear() == fresh layout'.padEnd(26) + (same ? '' : ' conv ' + rs._conv + ' vs ' + fresh._conv + ', lFree ' + rs._lFree.join() + ' vs ' + fresh._lFree.join()));
    }

    // ---- W2 targeted -------------------------------------------------------------------------------------------
    const TU = 1 << 20;
    function tcase(name, maxS, maxL, build) {
        const rs = new RoaringSet(TU, maxS, maxL), md = new Model();
        const add = (x) => { rs.add(x); md.add(x); };
        const del = (x) => { const g = rs.delete(x), w = md.delete(x); if (g !== w) throw new Error('delete(' + x + ') ' + g + ' vs ' + w); };
        const want = (got, exp, what) => { if (got !== exp) throw new Error(what + ' ' + got + ' (want ' + exp + ')'); };
        const exhaust = (c, what) => {                                               // all 65,536 lows of chunk c
            for (let lo = 0; lo < 65536; lo++) {
                const e = probeQ(rs, md, c * 65536 + lo, TU, what + ' chunk ' + c + ' kind ' + kindOf(rs, c) + ': ');
                if (e) throw new Error(e);
            }
        };
        let d = null, info = '';
        try { info = build(rs, md, add, del, want, exhaust) || ''; d = checkSet(rs, md, rng(5), TU); } catch (e) { d = e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + name.padEnd(26) + (d ? ' ' + d : (info ? ' ' + info : '')));
    }
    tcase('T stale-demo successor', 4, 4, (rs, md, add, del, want) => {
        for (let x = 0; x < 5000; x++) add(x);               // one bitmap chunk
        for (let x = 32; x < 64; x++) del(x);                // data word 1 empties: its L1 bit must clear
        for (let x = 20; x < 32; x++) del(x);                // word 0 keeps 0..19
        want(rs.successor(19), 64, 'successor(19)');
        return 'kind ' + kindOf(rs, 0);
    });
    tcase('T stale-demo predecessor', 4, 4, (rs, md, add, del, want) => {
        for (let x = 0; x < 5000; x++) add(x);
        for (let x = 4960; x < 4992; x++) del(x);            // word 155 empties (L1 group 4)
        for (let x = 4992; x < 4996; x++) del(x);            // word 156 keeps 4996..4999
        want(rs.predecessor(4996), 4959, 'predecessor(4996)');
        return 'kind ' + kindOf(rs, 0);
    });
    tcase('T stale L1 group / L2 edge', 4, 4, (rs, md, add, del, want) => {
        for (let x = 0; x < 40000; x++) if (x % 5 !== 0) add(x); // 32,000 keys: a bitmap across the L2 edge
        for (let x = 1024; x < 2048; x++) if (md.s.has(x)) del(x); // L1 group 1 empties: its L2 bit must clear
        for (let x = 20; x < 1024; x++) if (md.s.has(x)) del(x);
        want(rs.successor(19), 2048, 'successor(19)');  // 2048 % 5 = 3: present
        want(rs.predecessor(2048), 19, 'predecessor(2048)');
        for (let x = 31744; x < 33792; x++) if (md.s.has(x)) del(x); // groups 31 and 32 (both sides of the L2 edge)
        want(rs.successor(31743), 33792, 'successor(31743)');
        want(rs.predecessor(33792), 31743, 'predecessor(33792)');
        return 'kind ' + kindOf(rs, 0);
    });
    tcase('T bitmap word-empty sweep', 4, 4, (rs, md, add, del, want, exhaust) => {
        for (let x = 0; x < 65536; x++) if (x % 3 !== 0) add(x); // 43,690 keys, 21,845 runs: a bitmap everywhere
        const words = [0, 1, 30, 31, 32, 33, 63, 64, 511, 512, 1022, 1023, 1024, 1025, 1055, 1056, 2015, 2016, 2046, 2047];
        for (const w of words) {
            for (let x = w * 32; x < w * 32 + 32; x++) if (md.s.has(x)) del(x);
            const e = spanProbes(rs, md, w * 32, w * 32 + 32, TU, 'word ' + w + ': ');
            if (e) throw new Error(e);
        }
        for (const g of [0, 31, 32, 63]) {                   // whole L1 groups, both L2 halves
            for (let x = g * 1024; x < g * 1024 + 1024; x++) if (md.s.has(x)) del(x);
            const e = spanProbes(rs, md, g * 1024, g * 1024 + 1024, TU, 'group ' + g + ': ');
            if (e) throw new Error(e);
        }
        exhaust(0, 'sweep');
        return 'kind ' + kindOf(rs, 0);
    });
    tcase('T has() every kind exhaustive', 8, 12, (rs, md, add, del, want, exhaust) => {
        for (let i = 0; i < 50; i++) add(0 * 65536 + 37 * i + 5);                   // c0 small array
        for (let i = 0; i < 1000; i++) add(1 * 65536 + 7 * i + 3);                  // c1 full array
        for (let i = 0; i < 5000; i++) add(2 * 65536 + 13 * i);                     // c2 bitmap (words non-zero, bits clear)
        for (let i = 0; i < 40; i++) for (let j = 0; j < 10; j++) add(3 * 65536 + 1000 * i + 500 + j); // c3 40 runs
        for (let i = 0; i < 5; i++) for (let j = 0; j < 100; j++) add(4 * 65536 + 9000 * i + 77 + j);  // c4 5 runs
        for (let x = 0; x < 65536; x++) add(5 * 65536 + x);                          // c5 FULL (-> runs below)
        for (let x = 65000; x < 65536; x++) add(8 * 65536 + x);                      // c8 one run ending at 65535
        add(9 * 65536 + 4000); add(9 * 65536 + 4001);                                // c9 a 2-key run
        for (let i = 0; i < 2100; i++) add(10 * 65536 + 2 * i + 9);                  // c10 2,100 isolated keys (an array: runs never win)
        rs.runOptimize();
        for (let x = 0; x < 65536; x++) add(6 * 65536 + x);                          // c6 FULL after runOptimize (bitmap / FULL)
        add(7 * 65536 + 12345);                                                      // c7 one key
        const kinds = [];
        for (const c of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) { exhaust(c, 'exhaustive'); kinds.push(c + ':' + kindOf(rs, c)); }
        return 'chunk:kind ' + kinds.join(' ');
    });
    tcase('T has() wrong-layout lows', 8, 8, (rs, md, add, del, want) => {
        // runs > 32 (kind 4 everywhere): stored halfwords are starts 500 + 1000 i and lengths-1 = 9
        for (let i = 0; i < 40; i++) for (let j = 0; j < 10; j++) add(1000 * i + 500 + j);
        // runs <= 32 (va: small runs): stored starts 200 + 9000 i, length-1 = 99 (absent)
        for (let i = 0; i < 5; i++) for (let j = 0; j < 100; j++) add(65536 + 9000 * i + 200 + j);
        rs.runOptimize();
        want(rs.has(505), true, 'runs: has(505) inside a run, no stored halfword');
        want(rs.has(1503), true, 'runs: has(1503)');
        want(rs.has(509), true, 'runs: has(509) run end');
        want(rs.has(9), false, 'runs: has(9) == a stored length, absent');
        want(rs.has(510), false, 'runs: has(510) one past a run');
        want(rs.has(65536 + 9200 + 50), true, 'small runs: has(inside)');
        want(rs.has(65536 + 99), false, 'small runs: has(99) == a stored length, absent');
        want(rs.has(65536 + 299), true, 'small runs: has(299) run end');
        // bitmap: lo whose word is non-zero but whose bit is clear
        for (let i = 0; i < 5000; i++) add(2 * 65536 + 13 * i);
        want(rs.has(2 * 65536 + 13), true, 'bitmap: has(13)');
        want(rs.has(2 * 65536 + 14), false, 'bitmap: has(14) word 0 non-zero, bit clear');
        want(rs.has(2 * 65536 + 31), false, 'bitmap: has(31) bit 31 clear, word non-zero');
        want(rs.has(2 * 65536 + 4000 * 13 + 1), false, 'bitmap: has(52001)');
        return 'kinds ' + kindOf(rs, 0) + '/' + kindOf(rs, 1) + '/' + kindOf(rs, 2);
    });
    }

    function sec_V() {
    // ===== APPENDED from roaring-fuzz.va.mjs (va-fuzz-diff.txt), renamed va*; edits marked best: ==========
    // ---- va (RESEARCH 12.12 candidate 1): kind 5 small runs (<= 32 runs in a small slot), kind 6 FULL ----------
    // Black-box checks are the model (checkSet); `kind` asserts are white-box (they name the variant's
    // kinds, so they FAIL on the base by design: the base has no kind 5 / 6).
    const VA_U = 1 << 20;
    function vaCase(name, maxS, maxL, build) {
        const rs = new RoaringSet(VA_U, maxS, maxL), md = new Model();
        const add = (x) => { rs.add(x); md.add(x); };
        const del = (x) => { const g = rs.delete(x), w = md.delete(x); if (g !== w) throw new Error('delete(' + x + ') ' + g + ' vs ' + w); };
        const kind = (c, want, what) => { if (rs._kind[rw(rs, c)] !== want) throw new Error((what ? what + ': ' : '') + 'chunk ' + c + ' kind ' + rs._kind[rw(rs, c)] + ' (want ' + want + ')'); };
        const chk = (what) => { const e = checkSet(rs, md, rng(3), VA_U); if (e) throw new Error(what + ': ' + e); };
        const probe = (xs, what) => {
            for (const q of xs) {
                if (q < 0 || q >= VA_U) continue;
                if (rs.has(q) !== md.s.has(q)) throw new Error(what + ': has(' + q + ')');
                if (rs.successor(q) !== md.succ(q)) throw new Error(what + ': successor(' + q + ') ' + rs.successor(q) + ' vs ' + md.succ(q));
                if (rs.predecessor(q) !== md.pred(q)) throw new Error(what + ': predecessor(' + q + ') ' + rs.predecessor(q) + ' vs ' + md.pred(q));
            }
        };
        // a pool throw must leave every own field byte-identical and the set equal to the (unchanged) model
        const failClosed = (fn, what) => {
            const before = vaSnap(rs);
            let threw = null;
            try { fn(); } catch (e) { threw = e; }
            if (threw === null) throw new Error(what + ': did not throw');
            if (!/pool exhausted/.test(String(threw.message))) throw new Error(what + ': threw ' + threw.message);
            if (vaSnap(rs) !== before) throw new Error(what + ': state changed after the pool throw');
            chk(what + ' (after throw)');
        };
        let d;
        try { build({ rs, md, add, del, kind, chk, probe, failClosed }); d = checkSet(rs, md, rng(1), VA_U); } catch (e) { d = 'threw ' + e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + name.padEnd(26) + (d ? ' ' + d : ''));
    }
    // 32 runs [10r, 10r + 2], r = 0..31, as a small-run container (kind 5) in chunk c
    function vaBuild32(t, c) {
        const b = c * 65536;
        for (let r = 0; r < 32; r++) for (let i = 0; i < 3; i++) t.add(b + r * 10 + i);
        t.rs.runOptimize();
        t.kind(c, 5, '32 runs after runOptimize');
        if (t.rs._runs[rw(t.rs, c)] !== 31) throw new Error('runs ' + (t.rs._runs[rw(t.rs, c)] + 1) + ' (want 32)');
    }
    function vaFill(t, c) { const b = c * 65536; for (let x = 0; x < 65536; x++) t.add(b + x); }

    vaCase('va 32 <-> 33 runs by add', 4, 4, (t) => {
        vaBuild32(t, 0);
        t.add(500);                                           // isolated: the 33rd run -> kind 4
        t.kind(0, 4, '33 runs'); t.chk('33 runs');
        t.del(500);                                           // a 1-key run removed: 32 runs -> kind 5
        t.kind(0, 5, 'back to 32'); t.chk('back to 32');
        t.add(500);                                           // 33 again
        for (let x = 3; x <= 8; x++) t.add(x);                // [0, 8] (run count unchanged)
        t.kind(0, 4, '33 runs, extended');
        t.add(9);                                             // bridges [0, 8] and [10, 12]: 32 runs -> kind 5
        t.kind(0, 5, 'bridge to 32'); t.chk('bridge to 32');
        t.probe([0, 8, 9, 12, 13, 19, 20, 312, 313, 499, 500, 501, 65535, 65536], 'probes');
    });
    vaCase('va 32 <-> 33 runs by delete', 4, 4, (t) => {
        vaBuild32(t, 0);
        t.del(11);                                            // splits [10, 12]: 33 runs -> kind 4
        t.kind(0, 4, 'split to 33'); t.chk('split to 33');
        t.probe([9, 10, 11, 12, 13], 'split probes');
        t.add(11);                                            // bridges [10, 10] and [12, 12]: 32 -> kind 5
        t.kind(0, 5, 'rejoin to 32'); t.chk('rejoin to 32');
        t.del(10); t.del(11); t.del(12);                      // run removed: 31 runs, still kind 5
        t.kind(0, 5, '31 runs'); t.chk('31 runs');
        for (let r = 0; r < 32; r++) for (let i = 0; i < 3; i++) t.del(r * 10 + i);
        t.kind(0, 0, 'emptied'); t.chk('emptied');
    });
    vaCase('va 34 -> 33 runs stays 4', 4, 4, (t) => {
        vaBuild32(t, 0);                                        // runs end at 312; keys >= 1000 are clear of them
        t.add(1000); t.add(2000);                             // two 1-key runs: 34 runs, kind 4
        t.kind(0, 4, '34 runs');
        t.del(2000);                                          // a 1-key run removed: 33 runs -> must stay kind 4
        t.kind(0, 4, 'delete to 33'); t.chk('delete to 33');
        t.add(1002);                                          // 34 runs: ..., [1000], [1002]
        t.add(1001);                                          // bridges them: 33 runs -> must stay kind 4
        t.kind(0, 4, 'bridge to 33'); t.chk('bridge to 33');
        t.del(1000); t.del(1001);                             // shrink to [1002]: still 33 runs
        t.kind(0, 4, 'shrink at 33');
        t.del(1002);                                          // 32 -> kind 5
        t.kind(0, 5, 'delete to 32'); t.chk('delete to 32');
    });
    vaCase('va 33rd run, no large slot', 4, 1, (t) => {
        vaBuild32(t, 0);                                        // the only slab came back on the kind 2 -> 5 move
        t.add(65536);                                         // chunk 1: small array
        for (let x = 1; x < 100; x++) t.add(65536 + x);       // promotes to kind 2: takes the only slab
        t.kind(1, 2, 'chunk 1');
        t.failClosed(() => t.rs.add(500), 'add 33rd run');
        t.failClosed(() => t.rs.delete(11), 'delete split to 33');
        t.del(65536 + 50);                                    // chunk 1 still kind 2; deletes inside a run are fine
        t.del(10); t.chk('kind 5 delete with an empty large pool');
    });
    vaCase('va FULL by adds (bitmap)', 4, 4, (t) => {
        vaFill(t, 1);                                      // small -> array -> bitmap -> FULL
        t.kind(1, 6, 'filled'); t.chk('filled');
        if (t.rs._lTop !== 4 || t.rs._sTop !== 4) throw new Error('pools not returned: s ' + t.rs._sTop + ' l ' + t.rs._lTop);
        t.add(65536 + 77); t.kind(1, 6, 're-add');            // add into FULL: no-op
        t.probe([65535, 65536, 65537, 131071, 131072, 131073], 'full probes');
        if (t.rs.min() !== 65536 || t.rs.max() !== 131071) throw new Error('min / max ' + t.rs.min() + ' / ' + t.rs.max());
    });
    vaCase('va FULL by adds (runs)', 4, 4, (t) => {
        for (let x = 0; x < 100; x++) t.add(x);
        for (let x = 101; x < 201; x++) t.add(x);
        t.rs.runOptimize(); t.kind(0, 5, '2 runs');
        for (let x = 201; x < 65536; x++) t.add(x);           // extends the 2nd run
        t.kind(0, 5, 'two runs, one key short'); t.chk('one short');
        t.add(100);                                           // bridges: 65,536 keys -> FULL
        t.kind(0, 6, 'bridged full'); t.chk('bridged full');
        if (t.rs._sTop !== 4) throw new Error('small slot not returned');
    });
    for (const [lo, runs] of [[0, 1], [65535, 1], [1, 2], [30000, 2], [65534, 2]]) {
        vaCase('va FULL delete ' + lo, 4, 4, (t) => {
            vaFill(t, 2);
            const b = 2 * 65536;
            t.del(b + lo);
            t.kind(2, 5, 'after delete');
            if (t.rs._runs[rw(t.rs, 2)] + 1 !== runs) throw new Error('runs ' + (t.rs._runs[rw(t.rs, 2)] + 1) + ' (want ' + runs + ')');
            t.chk('after delete');
            t.probe([b - 1, b, b + 1, b + lo - 1, b + lo, b + lo + 1, b + 65534, b + 65535, b + 65536], 'gap probes');
            if (t.rs.delete(b + lo) !== false) throw new Error('second delete returned true');
            t.add(b + lo);
            t.kind(2, 6, 're-filled'); t.chk('re-filled');
        });
    }
    vaCase('va FULL delete, small pool used', 1, 1, (t) => {
        vaFill(t, 0);                                      // FULL; both pools free again
        t.kind(0, 6, 'full');
        t.add(65536 + 5); t.add(65536 + 6);                   // chunk 1 takes the only small slot (best: a SINGLE takes none)
        t.del(1234);                                          // FULL -> runs in the only slab (kind 4 fallback)
        t.kind(0, 4, 'fallback'); t.chk('fallback');
        t.add(1234); t.kind(0, 6, 're-filled');               // slab returned
        t.add(2 * 65536 + 9); t.add(2 * 65536 + 10);          // chunk 2: no small slot -> takes the only slab (best: 2 keys)
        t.kind(2, 2, 'chunk 2');
        t.failClosed(() => t.rs.delete(1234), 'FULL delete, both pools empty');
        t.failClosed(() => t.rs.delete(0), 'FULL delete key 0, both pools empty');
    });
    vaCase('va FULL delete, maxS 0', 0, 2, (t) => {
        vaFill(t, 3);
        t.kind(3, 6, 'full');
        t.del(3 * 65536 + 65535);
        t.kind(3, 4, 'fallback'); t.chk('fallback');
        t.add(3 * 65536 + 65535); t.kind(3, 6, 're-filled');
        t.add(0); t.add(1); t.add(65536); t.add(65537);       // both slabs used (best: 2 keys per chunk)
        t.failClosed(() => t.rs.delete(3 * 65536 + 7), 'FULL delete, maxS 0, slabs used');
    });
    vaCase('va runOptimize -> 5 / 4 / 6', 1, 4, (t) => {
        for (let r = 0; r < 10; r++) for (let i = 0; i < 500; i++) t.add(r * 3000 + i);       // chunk 0: bitmap, 10 runs
        t.kind(0, 3, 'bitmap');
        for (let r = 0; r < 40; r++) for (let i = 0; i < 120; i++) t.add(65536 + r * 1500 + i); // chunk 1: bitmap, 40 runs
        t.kind(1, 3, 'bitmap 40');
        t.add(5 * 65536); t.add(5 * 65536 + 1);               // chunk 5 takes the only small slot (best: 2 keys)
        t.rs.runOptimize();
        t.kind(0, 4, 'no small slot'); t.kind(1, 4, '40 runs'); t.chk('optimize 1');
        t.del(5 * 65536);                                     // frees the small slot (best: 2 -> 1 key, SINGLE)
        t.rs.runOptimize();
        t.kind(0, 5, 'kind 4 with 10 runs -> 5'); t.kind(1, 4, '40 runs stays'); t.chk('optimize 2');
        for (let x = 0; x < 65535; x++) t.add(2 * 65536 + x); // chunk 2: one run of 65,535 keys
        t.rs.runOptimize(); t.kind(2, 4, 'one short, small pool used');
        // white-box: make chunk 2 hold 65,536 keys without add() (the only door is runOptimize's detection)
        const rs = t.rs, s = rs._slot[rw(rs, 2)];
        rs._lU16[(s << 12) + 1] = 65535; rs._card[rw(rs, 2)] = 65535; rs._cMax[rw(rs, 2)] = 65535; rs._size++; t.md.add(2 * 65536 + 65535);
        rs.runOptimize();
        t.kind(2, 6, 'runOptimize detects 65,536'); t.chk('optimize 3');
        rs.runOptimize(); t.kind(2, 6, 'idempotent'); t.chk('optimize 4');
    });
    vaCase('va FULL churn 32/33 edge', 2, 2, (t) => {
        // holes oscillate around the 32 / 33-run edge and back to 0 (FULL); every kind transition must occur
        vaFill(t, 1);
        const r = rng(12345), b = 65536, holes = [], seen = new Set();
        let target = 0;
        for (let op = 0; op < 8000; op++) {
            if (op % 150 === 0) target = r() < 0.2 ? 0 : 20 + Math.floor(r() * 26);
            if (r() < 0.01) t.rs.runOptimize();
            else if (holes.length < target) {
                const x = b + Math.floor(r() * 65536);
                if (t.md.s.has(x)) { t.del(x); holes.push(x); }
            } else if (holes.length > 0) {
                const i = Math.floor(r() * holes.length);
                t.add(holes[i]); holes[i] = holes[holes.length - 1]; holes.pop();
            }
            seen.add(t.rs._kind[rw(t.rs, 1)]);
            if (op % 25 === 0) t.chk('churn op ' + op);
        }
        for (const k of [4, 5, 6]) if (!seen.has(k)) throw new Error('churn never saw kind ' + k + ' (saw ' + [...seen].join() + ')');
        t.chk('churn end');
    });
    {
        // intersections over every kind pair: A has kind c in chunk c + 1 (c = 1..6), B_r has kind ((c + r) % 6) + 1 (G3, SPEC C-21)
        const KB = [null,
            (add, b, r) => { for (let i = 0; i < 40; i++) add(b + Math.floor(r() * 65536)); },                  // 1 small
            (add, b, r) => { for (let i = 0; i < 1000; i++) add(b + Math.floor(r() * 65536)); },                // 2 array
            (add, b, r) => { for (let i = 0; i < 10000; i++) add(b + Math.floor(r() * 65536)); },               // 3 bitmap
            (add, b, r) => { for (let q = 0; q < 50; q++) { const s0 = q * 1300 + Math.floor(r() * 600); const n = 3 + Math.floor(r() * 400); for (let i = 0; i < n; i++) add(b + s0 + i); } }, // 4 runs
            (add, b, r) => { for (let q = 0; q < 12; q++) { const s0 = q * 5400 + Math.floor(r() * 2000); const n = 3 + Math.floor(r() * 2000); for (let i = 0; i < n; i++) add(b + s0 + i); } }, // 5 small runs
            (add, b) => { for (let i = 0; i < 65536; i++) add(b + i); },                                       // 6 FULL
        ];
        const mk = (rot, seed, extra) => {
            const rs = new RoaringSet(VA_U, 8, 8, ...extra), md = new Model(), r = rng(seed);
            const add = (x) => { rs.add(x); md.add(x); };
            for (let c = 1; c <= 6; c++) KB[((c - 1 + rot) % 6) + 1](add, c * 65536, r);
            rs.runOptimize();
            for (let c = 1; c <= 6; c++) {
                const want = ((c - 1 + rot) % 6) + 1;
                if (kindOf(rs, c) !== want) throw new Error('rot ' + rot + ' chunk ' + c + ' kind ' + kindOf(rs, c) + ' (want ' + want + ')');
            }
            return [rs, md];
        };
        let d = null;
        try {
            const [A, mA] = mk(0, 101, []);
            for (const extra of [[], [2, 3]]) {                                        // B ctor args (2, 3): direct on the real build (C-5); paged pb3 vs the lane's pbP only under RoaringPagedFuzz forced lanes
                for (let rot = 0; rot < 6 && !d; rot++) {
                    const [B, mB] = mk(rot, 202 + rot, extra);
                    d = checkPair(A, mA, B, mB) || checkPair(B, mB, A, mA) || checkSet(B, mB, rng(5), VA_U);
                    if (d) d = 'rot ' + rot + ' B[' + extra.join() + ']: ' + d;
                }
            }
            // disjoint pairs inside one chunk: small runs vs small runs / runs / arrays / bitmap -> intersects false
            const S = (fill) => { const rs = new RoaringSet(VA_U, 8, 8), md = new Model(); fill((x) => { rs.add(x); md.add(x); }); rs.runOptimize(); return [rs, md]; };
            const evens = S((add) => { for (let x = 0; x < 65536; x += 2) add(x); });                                  // bitmap
            const sr = S((add) => { for (let q = 0; q < 10; q++) for (let i = 0; i < 9; i++) add(q * 100 + i); });       // kind 5
            const sr2 = S((add) => { for (let q = 0; q < 10; q++) for (let i = 0; i < 9; i++) add(q * 100 + 50 + i); }); // kind 5, disjoint
            const lr = S((add) => { for (let q = 0; q < 40; q++) for (let i = 0; i < 9; i++) add(q * 100 + 50 + i); }); // kind 4, disjoint from sr
            const ar = S((add) => { for (let q = 0; q < 60; q++) add(q * 100 + 30); });                                // small array, disjoint
            const pairs = [[sr, sr2], [sr, lr], [sr, ar], [sr2, ar], [lr, ar]];
            if (kindOf(sr[0], 0) !== 5 || kindOf(sr2[0], 0) !== 5 || kindOf(lr[0], 0) !== 4 || kindOf(evens[0], 0) !== 3) throw new Error('disjoint kinds ' + kindOf(sr[0], 0) + kindOf(sr2[0], 0) + kindOf(lr[0], 0) + kindOf(evens[0], 0));
            for (const [[a, ma], [b, mb]] of pairs) { if (!d) d = checkPair(a, ma, b, mb); if (!d && a.intersects(b)) d = 'disjoint intersects true'; }
            if (!d) d = checkPair(sr[0], sr[1], evens[0], evens[1]) || checkPair(lr[0], lr[1], evens[0], evens[1]);
        } catch (e) { d = 'threw ' + e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + 'va kind-pair intersections'.padEnd(26) + (d ? ' ' + d : ''));
    }
    // ===== APPENDED from roaring-fuzz.vb.mjs (vb-fuzz-diff.txt), renamed vb*; edits marked best: ==========

    // ===== APPENDED (R0 U3 b): the SINGLE kind and the small-array size classes ==========================
    // Runs on base / vb1 / vb2 alike: build-specific expectations key on WB_SINGLE / WB_CLASSES (white-box), and
    // the extra ctor args (maxTiny8, maxTiny16) are ignored by builds without them. Every op is followed by
    // checkSet (black-box state == model, plus the white-box accounting above).
    log('-- appended: WB_SINGLE=' + WB_SINGLE + ' WB_CLASSES=' + WB_CLASSES);

    // shape of chunk c: '-' empty, 'S' SINGLE, 'a8' / 'a16' / 'a64' small array by class, 'A' array, 'B' bitmap, 'R' runs
    function vbShape(rs, c) {
        const k = rs._kind[rw(rs, c)];
        if (k === 0) return '-';
        if (WB_SINGLE && k === WB_SK) return 'S';                    // best: SINGLE is kind 7
        if (WB_SMALLRUNS && k === 5) return 'r';                     // best: small runs
        if (WB_SMALLRUNS && k === 6) return 'F';                     // best: FULL
        if (k === 1) return 'a' + (WB_CLASSES ? 1 << rs._runs[rw(rs, c)] : 64);
        return k === 2 ? 'A' : (k === 3 ? 'B' : 'R');
    }
    // expected shape of a chunk grown monotonically to n keys / shrunk monotonically from > 64 to n (pools ample)
    function growShape(n) {
        if (n === 0) return '-';
        if (n === 1 && WB_SINGLE) return 'S';
        if (n > 64) return 'A';
        if (!WB_CLASSES) return 'a64';
        return n <= 8 ? 'a8' : (n <= 16 ? 'a16' : 'a64');
    }
    function shrinkShape(n) {
        if (n === 0) return '-';
        if (n === 1 && WB_SINGLE) return 'S';
        if (!WB_CLASSES) return n > (WB_HYST ? 32 : 64) ? 'A' : 'a64'; // best: ve demotes at <= 32
        if (n > 32) return 'A';
        return n > 8 ? 'a64' : (n > 4 ? 'a16' : 'a8');
    }

    function vbCase(name, U, args, body) {
        const rs = new RoaringSet(U, ...args), md = new Model();
        const r = rng(4242);
        let d = null;
        const chk = (tag) => { if (d === null) { const e = checkSet(rs, md, r, U); if (e) d = tag + ': ' + e; } };
        const add = (x) => { rs.add(x); md.add(x); chk('add(' + x + ')'); };
        const del = (x) => { const got = rs.delete(x), want = md.delete(x); if (got !== want && d === null) d = 'delete(' + x + ') ' + got; chk('delete(' + x + ')'); };
        let throws = 0;
        const tryAdd = (x) => {
            try { rs.add(x); } catch (e) {
                if (!/pool exhausted/.test(String(e.message))) throw e;
                throws++;
                chk('after pool throw add(' + x + ')');                  // fail closed: state == model (unchanged)
                return false;
            }
            md.add(x); chk('add(' + x + ')');
            return true;
        };
        const expect = (cond, msg) => { if (!cond && d === null) d = msg; };
        try { body({ rs, md, add, del, tryAdd, expect, throws: () => throws }); } catch (e) { if (d === null) d = 'threw ' + e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + name.padEnd(26) + (d ? ' ' + d : ''));
    }
    const VB_LO = (i) => (i * 40503 + 7) & 0xFFFF;                      // scrambled low bits, distinct for i < 65536

    vbCase('single 1 -> 2 -> 1', 1 << 20, [4, 4], ({ rs, add, del, expect }) => {
        const b = 3 * 65536;
        add(b + 500); expect(vbShape(rs, 3) === growShape(1), '1 key: ' + vbShape(rs, 3));
        add(b + 500);                                                // duplicate on a SINGLE: no-op
        add(b + 400); expect(vbShape(rs, 3) === growShape(2), '2 keys: ' + vbShape(rs, 3));
        del(b + 400); expect(vbShape(rs, 3) === shrinkShape(1), 'back to 1 (min deleted): ' + vbShape(rs, 3));
        add(b + 600); del(b + 600); expect(vbShape(rs, 3) === shrinkShape(1), 'back to 1 (max deleted): ' + vbShape(rs, 3));
        del(b + 499); del(b + 500); expect(vbShape(rs, 3) === '-', 'empty: ' + vbShape(rs, 3));
        del(b + 500);
    });
    vbCase('single lo 0 / 65535', 4294967296, [8, 4], ({ rs, add, del, expect }) => {
        add(65536); add(2 * 65536 + 65535); add(4294967295); add(65534 * 65536);
        for (const c of [1, 2, 65535, 65534]) expect(vbShape(rs, c) === growShape(1), 'chunk ' + c + ' ' + vbShape(rs, c));
        expect(rs.successor(65535) === 65536 && rs.predecessor(65536) === undefined, 'succ / pred at lo 0');
        expect(rs.successor(2 * 65536 + 65534) === 2 * 65536 + 65535 && rs.predecessor(3 * 65536) === 2 * 65536 + 65535, 'succ / pred at lo 65535');
        expect(rs.min() === 65536 && rs.max() === 4294967295, 'min / max ' + rs.min() + ' ' + rs.max());
        add(3 * 65536); add(3 * 65536 + 65535);                     // one chunk: lo 0 and lo 65535
        del(3 * 65536); expect(vbShape(rs, 3) === shrinkShape(1), 'keep 65535: ' + vbShape(rs, 3));
        add(3 * 65536); del(3 * 65536 + 65535); expect(vbShape(rs, 3) === shrinkShape(1), 'keep 0: ' + vbShape(rs, 3));
        del(4294967295); expect(rs.max() === 65534 * 65536, 'max after delete');
        del(65536); expect(rs.min() === 2 * 65536 + 65535, 'min after delete');
        del(2 * 65536 + 65535); del(65534 * 65536); del(3 * 65536);
        expect(rs.size === 0 && rs.min() === undefined, 'empty');
    });
    vbCase('single via full array / runs', 1 << 20, [0, 3], ({ rs, add, del, expect }) => {
        add(10); add(20); expect(vbShape(rs, 0) === (WB_SINGLE ? 'A' : 'A'), '2 keys, no small pool: ' + vbShape(rs, 0));
        del(10); expect(vbShape(rs, 0) === (WB_SINGLE ? 'S' : 'A'), 'array 2 -> 1: ' + vbShape(rs, 0));
        del(20);
        const b = 65536;
        for (let x = 5; x <= 104; x++) add(b + x);
        rs.runOptimize(); expect(vbShape(rs, 1) === 'R', 'runs: ' + vbShape(rs, 1));
        for (let x = 104; x >= 7; x--) del(b + x);                   // one run [5, 6]
        del(b + 5); expect(vbShape(rs, 1) === (WB_SINGLE ? 'S' : 'R'), '2-key run, keep end: ' + vbShape(rs, 1));
        del(b + 6);
        for (let x = 5; x <= 104; x++) add(b + x);
        rs.runOptimize();
        for (let x = 103; x >= 7; x--) del(b + x);                   // [5, 6] [104]
        del(b + 6);                                                  // [5] [104]: two 1-key runs
        del(b + 104); expect(vbShape(rs, 1) === (WB_SINGLE ? 'S' : 'R'), 'two 1-key runs, keep first: ' + vbShape(rs, 1));
        add(b + 104); expect(vbShape(rs, 1) === (WB_SINGLE ? 'A' : 'R'), 'SINGLE + 1, no small pool: ' + vbShape(rs, 1));
        del(b + 104); del(b + 5);
        for (let x = 5; x <= 104; x++) add(b + x);
        rs.runOptimize();
        for (let x = 103; x >= 7; x--) del(b + x);
        del(b + 6);
        del(b + 5); expect(vbShape(rs, 1) === (WB_SINGLE ? 'S' : 'R'), 'two 1-key runs, keep second: ' + vbShape(rs, 1));
    });
    vbCase('class edges grow / shrink', 1 << 20, [4, 4], ({ rs, add, del, expect }) => {
        const b = 2 * 65536;
        for (let i = 0; i < 70; i++) { add(b + VB_LO(i)); expect(vbShape(rs, 2) === growShape(i + 1), 'grow n=' + (i + 1) + ': ' + vbShape(rs, 2)); }
        for (let i = 0; i < 70; i++) { del(b + VB_LO((i * 29) % 70)); expect(vbShape(rs, 2) === shrinkShape(69 - i), 'shrink n=' + (69 - i) + ': ' + vbShape(rs, 2)); }
        // with lo 0 and 65535 at the class edges
        add(b); add(b + 65535);
        for (let i = 1; i < 66; i++) add(b + i * 991);
        for (let i = 65; i >= 1; i--) del(b + i * 991);
        expect(vbShape(rs, 2) === shrinkShape(2), 'lo 0 + 65535: ' + vbShape(rs, 2));
    });
    vbCase('class edges no thrash', 1 << 20, [4, 4], ({ rs, add, del, expect }) => {
        const b = 65536;
            let n = 0;
        // growth edges 8/9, 16/17, 64/65: after the first promote, 3 add / delete pairs convert nothing
        for (const E of [8, 16, 64]) {
            while (n < E) add(b + VB_LO(n++));
            add(b + VB_LO(n++));
            const s0 = vbShape(rs, 1);
            for (let t = 0; t < 3; t++) { del(b + VB_LO(--n)); add(b + VB_LO(n++)); }
            expect(vbShape(rs, 1) === s0, 'edge ' + E + '/' + (E + 1) + ' shape ' + s0 + ' -> ' + vbShape(rs, 1));
        }
        // demote points 32, 8, 4 (vb2): after the first demote, 3 add / delete pairs convert nothing
        while (n < 70) add(b + VB_LO(n++));
        for (const D of [32, 8, 4]) {
            while (n > D) del(b + VB_LO(--n));
            const s0 = vbShape(rs, 1);
            expect(s0 === shrinkShape(D), 'demote at ' + D + ': ' + s0);
            for (let t = 0; t < 3; t++) { add(b + VB_LO(n++)); del(b + VB_LO(--n)); }
            expect(vbShape(rs, 1) === s0, 'demote ' + D + ' shape ' + s0 + ' -> ' + vbShape(rs, 1));
        }
    });
    vbCase('pools exhausted fail closed', 1 << 20, [1, 1], ({ rs, add, del, tryAdd, expect, throws }) => {
        // 2 keys per chunk: vb2 fills 8, 16, 64 then large; vb1 small then large; base: the first key already uses a slot
        for (let c = 0; c < 6; c++) { tryAdd(c * 65536 + 10); tryAdd(c * 65536 + 20); }
        expect(throws() >= 2, 'expected >= 2 pool throws, got ' + throws());
        const tGrow = throws();
        for (let i = 0; i < 70; i++) tryAdd(i * 7);                  // chunk 0 grows past its class: no slot anywhere
        const t0 = throws();
        expect(t0 > tGrow, 'growth past a class must throw: ' + (t0 - tGrow));
        if (WB_SINGLE) {
            tryAdd(9 * 65536 + 1);                                   // a new chunk -> SINGLE never fails
            expect(throws() === t0 && vbShape(rs, 9) === 'S', 'SINGLE add failed with pools exhausted');
            const fc = WB_CLASSES ? 3 : 1;                           // the chunk holding the large slot
            del(fc * 65536 + 10);                                    // -> SINGLE: frees its large slot
            expect(tryAdd(4 * 65536 + 20), 'freed slot not reused');
        }
    });
    vbCase('promote, large pool empty', 1 << 20, [2, 1], ({ rs, add, expect }) => {
        for (let i = 0; i < 70; i++) add(VB_LO(i));                     // chunk 0 -> full array: the only large slot
        expect(rs._lTop === 0, 'large pool not used');
        for (let i = 0; i < 17; i++) add(65536 + VB_LO(i));             // vb2: S -> 8 -> 16 -> 64 with lTop 0: no throw
        for (let i = 0; i < 9; i++) add(2 * 65536 + VB_LO(i));          // vb2: S -> 8 -> 16
    });
    vbCase('demote waits for pool', 1 << 20, [2, 4], ({ rs, add, del, expect }) => {
        for (let i = 0; i < 20; i++) add(VB_LO(i));                     // chunk 0: S -> 8 -> 16 -> 64
        for (let i = 0; i < 10; i++) add(65536 + VB_LO(i));             // chunk 1: S -> 8 -> 16 (takes the only 16 slot)
        for (let i = 19; i >= 7; i--) del(VB_LO(i));                    // chunk 0 at 7 keys: no 16 slot free -> stays 64
        for (let i = 9; i >= 4; i--) del(65536 + VB_LO(i));             // chunk 1 at 4 -> class 8, frees the 16 slot
        del(VB_LO(6));                                                  // chunk 0 at 6 -> now class 16
        for (let i = 5; i >= 0; i--) del(VB_LO(i));
        for (let i = 3; i >= 0; i--) del(65536 + VB_LO(i));
    });
    for (const extra of [[], [2, 3]]) {
        // intersections: a SINGLE in A against every kind in B (hit and miss); B ctor args (2, 3): direct on the real build (C-5); paged pb3 vs the lane's pbP only under RoaringPagedFuzz forced lanes (G3, SPEC C-21)
        const U = 1 << 20;
        const A = new RoaringSet(U, 16, 4), B = new RoaringSet(U, 6, 16, ...extra);
        const mA = new Model(), mB = new Model();
        const addA = (x) => { A.add(x); mA.add(x); }, addB = (x) => { B.add(x); mB.add(x); };
        const V = 100;
        for (let h = 0; h < 2; h++) {                                // h = 0: B holds V; h = 1: it does not
            const c0 = h * 7;
            const has = (c) => { if (h === 0) addB(c * 65536 + V); };
            has(c0); if (h === 1) addB(c0 * 65536 + 200);           // SINGLE
            has(c0 + 1); for (let i = 0; i < 5; i++) addB((c0 + 1) * 65536 + 300 + i * 3);       // small array
            has(c0 + 2); for (let i = 0; i < 12; i++) addB((c0 + 2) * 65536 + 300 + i * 3);      // small array
            has(c0 + 3); for (let i = 0; i < 40; i++) addB((c0 + 3) * 65536 + 300 + i * 3);      // small array
            has(c0 + 4); for (let i = 0; i < 500; i++) addB((c0 + 4) * 65536 + 301 + i * 3);     // full array
            has(c0 + 5); for (let i = 0; i < 5000; i++) addB((c0 + 5) * 65536 + 1 + i * 13);     // bitmap
            for (let i = 0; i < 1000; i++) if (h === 0 || i !== V) addB((c0 + 6) * 65536 + i);  // runs
        }
        B.runOptimize();
        for (let c = 0; c < 14; c++) addA(c * 65536 + V);
        const shapesB = []; for (let c = 0; c < 14; c++) shapesB.push(vbShape(B, c));
        let d = checkSet(A, mA, rng(7), U) || checkSet(B, mB, rng(8), U) || checkPair(A, mA, B, mB) || checkPair(B, mB, A, mA);
        // a second A whose SINGLEs (key V + 1) miss everywhere but the two run chunks 6 and 13
        const A2 = new RoaringSet(U, 16, 1), mA2 = new Model();
        for (let c = 0; c < 14; c++) { A2.add(c * 65536 + V + 1); mA2.add(c * 65536 + V + 1); }
        d = d || checkPair(A2, mA2, B, mB) || checkPair(B, mB, A2, mA2);
        if (!d) {
            const want = 'S a64 a64 a64 A B R S a64 a64 a64 A B R';
            if (shapesB.join(' ') !== want) d = 'B shapes ' + shapesB.join(' ') + ' (want ' + want + ')';
            else if (vbShape(A, 0) !== 'S') d = 'A not SINGLE';
        }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + ('SINGLE x every kind B[' + extra.join() + ']').padEnd(26) + (d ? ' ' + d : ' (B: ' + shapesB.join(' ') + ')'));
    }
    {
        // kind x kind in the same chunks, two sets with different pool sizes (so different slot orders), B ctor args (2, 3): direct on the real build (C-5); paged pb3 vs the lane's pbP only under RoaringPagedFuzz forced lanes
        const U = 1 << 20;
        let d = null;
        for (const extra of [[], [2, 3]]) {
            const A = new RoaringSet(U, 5, 8), B = new RoaringSet(U, 2, 8, ...extra);
            const mA = new Model(), mB = new Model();
            const sizes = [2, 6, 8, 9, 12, 16, 17, 30, 64];
            for (let c = 0; c < sizes.length; c++) for (let i = 0; i < sizes[c]; i++) { const x = c * 65536 + VB_LO(i); A.add(x); mA.add(x); }
            for (let c = sizes.length - 1; c >= 0; c--) for (let i = 0; i < sizes[sizes.length - 1 - c]; i++) { const x = c * 65536 + VB_LO(i + 1); B.add(x); mB.add(x); }
            d = d || checkSet(A, mA, rng(9), U) || checkSet(B, mB, rng(10), U) || checkPair(A, mA, B, mB) || checkPair(B, mB, A, mA);
        }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + 'kind x kind, other pools'.padEnd(26) + (d ? ' ' + d : ''));
    }
    {
        // clear() == fresh layout, every pool (vb2: the two tiny free lists too)
        const rs = new RoaringSet(1 << 20, 4, 4), fresh = new RoaringSet(1 << 20, 4, 4);
        for (let c = 0; c < 6; c++) for (let i = 0; i <= c * 4; i++) rs.add(c * 65536 + VB_LO(i));
        for (let i = 0; i < 9; i++) rs.delete(VB_LO(i));
        rs.clear();
        let same = rs._conv === fresh._conv && rs._sTop === fresh._sTop && rs._lTop === fresh._lTop &&
            rs._sFree.join() === fresh._sFree.join() && rs._lFree.join() === fresh._lFree.join();
        for (let c = 0; c < rs._chunks; c++) if (rs._kind[rw(rs, c)] !== 0 || rs._card[rw(rs, c)] !== 0 || rs._runs[rw(rs, c)] !== 0) same = false;
        if (!same) failures++;
        log((same ? 'ok   ' : 'FAIL ') + 'clear() == fresh, all pools'.padEnd(26));
    }

    // Appended random scenarios: few keys per chunk with alternating add-heavy / delete-heavy phases, so chunk counts
    // swing across every class edge (1/2, 4, 8/9, 16/17, 32, 64/65) in both directions; extra ctor args set the tiny pools.
    function makeGenVb(r, U, mode) {
        if (mode !== 'few') return makeGen(r, U, mode);
        const chunks = Math.ceil(U / 65536);
        const hot = [0, Math.min(chunks - 1, 1), Math.floor(chunks / 2), chunks - 1];
        const KS = [10, 24, 90, 300];
        const LOS = new Float64Array(300);
        for (let i = 0; i < 300; i++) LOS[i] = VB_LO(i);
        LOS[0] = 0; LOS[1] = 65535; LOS[2] = 32768; LOS[3] = 1;
        return () => {
            const h = Math.floor(r() * 4);
            const x = hot[h] * 65536 + LOS[Math.floor(r() * KS[h])];
            return x >= U ? U - 1 : x;
        };
    }
    const SCEN_VB = [
        { name: 'vb U=2^32 few', U: 4294967296, mode: 'few', maxS: 8, maxL: 8, t8: 4, t16: 4 },
        { name: 'vb U=2^20 few tight', U: 1 << 20, mode: 'few', maxS: 1, maxL: 3, t8: 1, t16: 1 },
        { name: 'vb U=2^20 few tiny 0', U: 1 << 20, mode: 'few', maxS: 4, maxL: 6, t8: 0, t16: 0 },
        { name: 'vb U=200001 few', U: 200001, mode: 'few', maxS: 2, maxL: 4, t8: 3, t16: 1 },
        { name: 'vb U=2^32 sparse', U: 4294967296, mode: 'sparse', maxS: 4, maxL: 4, t8: 4, t16: 4 },
        { name: 'vb U=2^20 mix', U: 1 << 20, mode: 'mix', maxS: 8, maxL: 16, t8: 8, t16: 8 },
    ];
    for (const sc of SCEN_VB) {
        let first = null, throwsSeen = 0;
        const trans = new Set(), prevShape = new Map();          // white-box coverage: shape transitions seen
        for (let seed = 1; seed <= SEEDS && first === null; seed++) {
            const r = rng(sd(seed, 104729, sc.U));
            const ro = rng(sd(seed, 104729, sc.U) ^ 0x9e3779b9);
            const A = new RoaringSet(sc.U, sc.maxS, sc.maxL), B = new RoaringSet(sc.U, sc.maxS, sc.maxL);
            const mA = new Model(), mB = new Model();
            const gA = makeGenVb(r, sc.U, sc.mode), gB = makeGenVb(r, sc.U, sc.mode);
            prevShape.clear();
            for (let op = 0; op < OPS && first === null; op++) {
                const which = ro() < 0.5;
                const [S, M, G] = which ? [A, mA, gA] : [B, mB, gB];
                const x = G();
                const roll = ro();
                const addP = ((op >> 10) & 1) === 0 ? 0.80 : 0.15;
                try {
                    if (roll < addP) { S.add(x); M.add(x); }
                    else if (roll < 0.995) { const got = S.delete(x), want = M.delete(x); if (got !== want) first = { op, d: 'delete(' + x + ') ' + got }; }
                    else if (roll < 0.998) { S.runOptimize(); }
                    else { S.clear(); M.s.clear(); M.sorted = null; }
                } catch (e) {
                    if (/pool exhausted/.test(String(e.message))) {
                        throwsSeen++;
                        prevShape.clear();
                        const d = checkSet(S, M, r, sc.U);
                        if (d) first = { op, d: 'after pool throw: ' + d };
                        S.clear(); M.s.clear(); M.sorted = null;
                        continue;
                    }
                    first = { op, d: 'threw ' + e.message };
                    break;
                }
                if (first) break;
                if (roll >= 0.998) prevShape.clear();
                else {
                    const c = Math.floor(x / 65536), now = vbShape(S, c), pk = (which ? 1 : 0) + c * 2, was = prevShape.get(pk);
                    if (was !== undefined && was !== now) trans.add(was + '>' + now);
                    prevShape.set(pk, now);
                }
                if (op % 25 === 0 || op === OPS - 1) {
                    const d = checkSet(S, M, r, sc.U) || checkPair(A, mA, B, mB);
                    if (d) first = { op, d };
                }
            }
            if (first) first.seed = seed;
        }
        if (first) failures++;
        log((first ? 'FAIL ' : 'ok   ') + sc.name.padEnd(26) + (first ? ' seed ' + first.seed + ' op ' + first.op + ': ' + first.d : ' (' + SEEDS + ' seeds x ' + OPS + ' ops, ' + throwsSeen + ' pool throws)'));
        log('     transitions: ' + [...trans].sort().join(' '));
    }
    }

    function sec_D() {
    // ===== APPENDED from roaring-fuzz.vd.mjs (vd-fuzz-diff.txt), renamed vd* / VD_*; edits marked best: ====
    // ---- vd appended targeted cases (variant d: per-chunk [min, max] headers) ----------------------------
    // Black-box checks run on every module; the header white-box checks (in checkSet and below) need `_cMin`
    // and are skipped for a module without it. Key sets define the shapes; `_kind` asserts only confirm that a
    // case reached the container kind it was written for (the same kind numbering in base and variant).
    const VHDR = true;
    log('vd header white-box check: ' + (VHDR ? 'on' : 'SKIPPED (module has no _cMin)'));
    const VD_U = 1 << 20;
    const VD_C = 3;                                         // the chunk under test
    const VD_B = VD_C * 65536;
    const VD_LOS = 65536 + 5, VD_HIS = 6 * 65536 + 7;         // sentinels in chunks 1 and 6

    // has / successor / predecessor at every non-empty chunk's min - 1, min, max, max + 1, then checkSet.
    function vdChk(rs, md, U) {
        const mn = new Map(), mx = new Map();
        for (const k of md.s) {
            const c = Math.floor(k / 65536);
            if (!mn.has(c) || k < mn.get(c)) mn.set(c, k);
            if (!mx.has(c) || k > mx.get(c)) mx.set(c, k);
        }
        for (const [c, lo] of mn) {
            const hi = mx.get(c);
            for (const q of [lo - 1, lo, lo + 1, hi - 1, hi, hi + 1]) {
                if (q < 0 || q >= U) continue;
                if (rs.has(q) !== md.s.has(q)) return 'edge has(' + q + ') ' + rs.has(q);
                const s1 = rs.successor(q), s2 = md.succ(q);
                if (s1 !== s2) return 'edge successor(' + q + ') ' + s1 + ' vs ' + s2;
                const p1 = rs.predecessor(q), p2 = md.pred(q);
                if (p1 !== p2) return 'edge predecessor(' + q + ') ' + p1 + ' vs ' + p2;
            }
        }
        return checkSet(rs, md, rng(1), U);
    }
    function vdCase(name, maxS, maxL, build) {
        const rs = new RoaringSet(VD_U, maxS, maxL), md = new Model();
        const add = (x) => { rs.add(x); md.add(x); };
        const del = (x) => { const a = rs.delete(x), b = md.delete(x); if (a !== b) throw new Error('delete(' + x + ') ' + a + ' vs ' + b); };
        const chk = (label) => { const e = vdChk(rs, md, VD_U); if (e) throw new Error(label + ': ' + e); };
        let d = null;
        try { build(rs, add, del, chk, md); chk('end'); } catch (e) { d = e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + name.padEnd(26) + (d ? ' ' + d : ''));
    }
    function vdKindIs(rs, c, k, label) {
        if (rs._kind[rw(rs, c)] !== k) throw new Error(label + ': chunk ' + c + ' kind ' + rs._kind[rw(rs, c)] + ' (want ' + k + ')');
    }
    // Delete alternately the min and the max of chunk VD_C down to (and past) its last key; cheap checks per op
    // against the sorted key list, checkSet every 128 ops, then re-add one key to the emptied chunk.
    function vdrain(rs, add, del, chk, keys, sentinels) {
        let i = 0, h = keys.length - 1, t = 0;
        while (i <= h) {
            const x = (t & 1) === 0 ? keys[i++] : keys[h--];
            t++;
            del(x);
            const at = 'op ' + t + ' delete(' + x + ')';
            if (rs.has(x)) throw new Error(at + ': has after delete');
            if (i <= h) {
                const mn = keys[i], mx = keys[h];
                if (sentinels) {
                    if (rs.successor(VD_LOS) !== mn) throw new Error(at + ': successor(loS) ' + rs.successor(VD_LOS) + ' vs ' + mn);
                    if (rs.predecessor(VD_HIS) !== mx) throw new Error(at + ': predecessor(hiS) ' + rs.predecessor(VD_HIS) + ' vs ' + mx);
                    if (rs.successor(mx) !== VD_HIS) throw new Error(at + ': successor(max) ' + rs.successor(mx));
                    if (rs.predecessor(mn) !== VD_LOS) throw new Error(at + ': predecessor(min) ' + rs.predecessor(mn));
                } else {
                    if (rs.min() !== mn) throw new Error(at + ': min ' + rs.min() + ' vs ' + mn);
                    if (rs.max() !== mx) throw new Error(at + ': max ' + rs.max() + ' vs ' + mx);
                    if (rs.successor(mx) !== undefined) throw new Error(at + ': successor(max) ' + rs.successor(mx));
                    if (rs.predecessor(mn) !== undefined) throw new Error(at + ': predecessor(min) ' + rs.predecessor(mn));
                }
                if (rs.successor(mn - 1) !== mn) throw new Error(at + ': successor(min-1) ' + rs.successor(mn - 1));
                if (rs.predecessor(mx + 1) !== mx) throw new Error(at + ': predecessor(max+1) ' + rs.predecessor(mx + 1));
                if (!rs.has(mn) || !rs.has(mx)) throw new Error(at + ': has(min/max) false');
                if (VHDR && (rs._cMin[rw(rs, VD_C)] !== (mn & 0xFFFF) || rs._cMax[rw(rs, VD_C)] !== (mx & 0xFFFF))) {
                    throw new Error(at + ': header [' + rs._cMin[rw(rs, VD_C)] + ', ' + rs._cMax[rw(rs, VD_C)] + '] vs [' + (mn & 0xFFFF) + ', ' + (mx & 0xFFFF) + ']');
                }
            } else {
                vdKindIs(rs, VD_C, 0, at + ' (last key)');
                if (sentinels && (rs.successor(VD_LOS) !== VD_HIS || rs.predecessor(VD_HIS) !== VD_LOS)) throw new Error(at + ': jump over the emptied chunk');
                if (!sentinels && rs.size !== 0) throw new Error(at + ': size ' + rs.size);
            }
            if ((t & 127) === 0) chk(at);
        }
        chk('drained');
        add(VD_B + 777);
        chk('re-add after last key');
    }
    function vkeys(start, stride, n) { const a = []; for (let i = 0; i < n; i++) a.push(VD_B + start + stride * i); return a; }
    function vruns(start, gap, len, n) { const a = []; for (let r = 0; r < n; r++) for (let j = 0; j < len; j++) a.push(VD_B + start + r * gap + j); return a; }
    const VKINDS = [
        { name: 'small', kind: 1, keys: vkeys(100, 3, 40), opt: false },
        { name: 'array', kind: 2, keys: vkeys(50, 7, 1000), opt: false },
        { name: 'bitmap', kind: 3, keys: vkeys(10, 5, 6000), opt: false },
        { name: 'runs', kind: WB_SMALLRUNS ? 5 : 4, keys: vruns(200, 100, 50, 30), opt: true }, // best: 30 runs -> small runs
        { name: 'full chunk bitmap', kind: WB_SMALLRUNS ? 6 : 3, keys: vkeys(0, 1, 65536), opt: false }, // best: FULL
        { name: 'full chunk runs', kind: WB_SMALLRUNS ? 6 : 4, keys: vkeys(0, 1, 65536), opt: true }, // best: FULL
        { name: 'runs singletons', kind: WB_SMALLRUNS ? 5 : 4, keys: vruns(0, 3, 1, 1).concat(vruns(10, 40, 30, 20), vruns(65535, 1, 1, 1)), opt: true }, // best: 22 runs -> small runs
    ];
    for (const K of VKINDS) {
        for (const sentinels of [false, true]) {
            vdCase('drain ' + K.name + (sentinels ? ' +nb' : ''), 4, 4, (rs, add, del, chk) => {
                if (sentinels) { add(VD_LOS); add(VD_HIS); }
                for (const x of K.keys) add(x);
                if (K.opt) rs.runOptimize();
                vdKindIs(rs, VD_C, K.kind, 'built');
                chk('built');
                vdrain(rs, add, del, chk, K.keys, sentinels);
            });
        }
    }
    // 64 / 65 and 4096 / 4097: add a new min / max / interior key across the promotion, then delete the min / max /
    // an interior key back across the demotion (all 9 pairs), with neighbours in chunks 1 and 6.
    function vedge(name, n, stride, start, kUnder, kOver, extra) {
        for (const a of ['min', 'max', 'mid']) {
            for (const b of ['min', 'max', 'mid']) {
                vdCase(name + ' +' + a + ' -' + b, 4, 4, (rs, add, del, chk) => {
                    add(VD_LOS); add(VD_HIS);
                    const keys = vkeys(start, stride, n);
                    for (const x of keys) add(x);
                    vdKindIs(rs, VD_C, kUnder, 'built');
                    chk('built');
                    add(a === 'min' ? VD_B + start - extra : a === 'max' ? VD_B + start + stride * n + extra : VD_B + start + 1);
                    vdKindIs(rs, VD_C, kOver, 'after add');
                    chk('after add ' + a);
                    const sorted = keys.concat([a === 'min' ? VD_B + start - extra : a === 'max' ? VD_B + start + stride * n + extra : VD_B + start + 1]).sort((p, q) => p - q);
                    del(b === 'min' ? sorted[0] : b === 'max' ? sorted[sorted.length - 1] : sorted[n >> 1]);
                    vdKindIs(rs, VD_C, WB_HYST ? kOver : kUnder, 'after delete'); // best: ve keeps the bigger form
                    chk('after delete ' + b);
                });
            }
        }
    }
    vedge('64/65', 64, 4, 1000, 1, 2, 500);
    vedge('4096/4097', 4096, 8, 100, 2, 3, 96);
    // Run spill on add (2049th run): the new key is the min, the max or interior; result array or bitmap.
    for (const big of [false, true]) {
        for (const a of ['min', 'max', 'mid']) {
            vdCase('spill add +' + a + (big ? ' ->bitmap' : ' ->array'), 4, 4, (rs, add, del, chk) => {
                add(VD_LOS); add(VD_HIS);
                const runLo = big ? 40000 : 60000, runN = big ? 5000 : 100;
                for (let x = 0; x < runN; x++) add(VD_B + runLo + x);
                rs.runOptimize();
                vdKindIs(rs, VD_C, WB_SMALLRUNS ? 5 : 4, 'one run'); // best: 1 run -> small runs
                for (let i = 0; i < 2047; i++) add(VD_B + 4 + 2 * i);       // 4 .. 4096: 2048 runs
                vdKindIs(rs, VD_C, 4, '2048 runs');
                chk('2048 runs');
                add(VD_B + (a === 'min' ? 0 : a === 'max' ? 65535 : 30000));
                vdKindIs(rs, VD_C, big ? 3 : 2, 'after spill');
                chk('after spill');
                del(VD_B + (a === 'max' ? 65535 : runLo + runN - 1));          // then the max
                del(VD_B + (a === 'min' ? 0 : 4));                              // and the min
                chk('after spill + delete min / max');
            });
        }
    }
    // Run spill on delete (a split of the 2049th run is always interior); then delete the min and the max.
    for (const big of [false, true]) {
        vdCase('spill delete' + (big ? ' ->bitmap' : ' ->array'), 4, 4, (rs, add, del, chk) => {
            add(VD_LOS); add(VD_HIS);
            const runLo = big ? 40000 : 60000, runN = big ? 5000 : 100;
            for (let x = 0; x < runN; x++) add(VD_B + runLo + x);
            rs.runOptimize();
            for (let i = 0; i < 2047; i++) add(VD_B + 2 * i);               // 0 .. 4092: 2048 runs
            vdKindIs(rs, VD_C, 4, '2048 runs');
            del(VD_B + runLo + 50);
            vdKindIs(rs, VD_C, big ? 3 : 2, 'after spill');
            chk('after spill');
            del(VD_B); del(VD_B + runLo + runN - 1);
            chk('after spill + delete min / max');
        });
    }
    // runOptimize both ways (array -> runs, runs -> array, bitmap -> runs, bitmap kept), headers across each.
    vdCase('runOptimize both ways', 4, 4, (rs, add, del, chk) => {
        add(VD_LOS); add(VD_HIS);
        for (let x = 60000; x < 60100; x++) add(VD_B + x);
        rs.runOptimize(); vdKindIs(rs, VD_C, WB_SMALLRUNS ? 5 : 4, 'array -> runs'); // best: small runs chk('array -> runs');
        for (let x = 0; x < 600; x += 2) add(VD_B + x);
        chk('runs + isolated');
        rs.runOptimize(); vdKindIs(rs, VD_C, 2, 'runs -> array'); chk('runs -> array');
        del(VD_B); del(VD_B + 60099); chk('array: delete min / max');
        for (let x = 0; x < 10000; x++) add(VD_B + 20000 + x);
        vdKindIs(rs, VD_C, 3, 'bitmap'); chk('bitmap');
        rs.runOptimize(); vdKindIs(rs, VD_C, 4, 'bitmap -> runs'); chk('bitmap -> runs');
        add(VD_B + 65535); add(VD_B + 0); chk('runs: new min / max');
        del(VD_B + 0); del(VD_B + 65535); del(VD_B + 2); del(VD_B + 60098); chk('runs: delete min / max');
        rs.runOptimize(); chk('runOptimize again');
        for (let x = 0; x < 65536; x += 2) add(VD_B + x);
        vdKindIs(rs, VD_C, 3, 'striped bitmap');
        rs.runOptimize(); vdKindIs(rs, VD_C, 3, 'bitmap kept (too many runs)'); chk('bitmap kept');
    });
    // successor / predecessor at min - 1, min, max, max + 1 for every kind side by side (vdChk probes every chunk),
    // including chunks whose min is 0 and max is 65535 (the probe crosses the chunk edge).
    vdCase('edges every kind', 4, 8, (rs, add, del, chk) => {
        for (const x of vkeys(100, 3, 40)) add(x - VD_B + 1 * 65536);        // chunk 1 small
        for (const x of vkeys(50, 7, 1000)) add(x - VD_B + 2 * 65536);       // chunk 2 array
        for (const x of vkeys(10, 5, 6000)) add(x);                         // chunk 3 bitmap
        for (const x of vruns(200, 100, 50, 30)) add(x - VD_B + 4 * 65536);  // chunk 4 -> runs
        add(5 * 65536); add(5 * 65536 + 65535);                             // chunk 5 small, min 0, max 65535
        for (let x = 0; x < 65536; x++) add(6 * 65536 + x);                 // chunk 6 full -> runs
        for (let x = 0; x < 65536; x += 9) add(7 * 65536 + x);              // chunk 7 bitmap from 0
        add(VD_U - 1);
        rs.runOptimize();
        vdKindIs(rs, 1, 1, 'c1'); vdKindIs(rs, 2, 2, 'c2'); vdKindIs(rs, 3, 3, 'c3'); vdKindIs(rs, 4, WB_SMALLRUNS ? 5 : 4, 'c4');
        vdKindIs(rs, 5, 1, 'c5'); vdKindIs(rs, 6, WB_SMALLRUNS ? 6 : 4, 'c6'); // best: c4 small runs, c6 FULL vdKindIs(rs, 7, 3, 'c7');
        chk('built');
        for (let c = 1; c <= 7; c++) { del(rs.successor(c * 65536 - 1)); del(rs.predecessor(c * 65536 + 65536)); }
        chk('after deleting each chunk min / max');
    });
    // Fail closed: a pool throw on a promotion that would set a new min leaves the headers untouched.
    vdCase('pool throw keeps headers', 1, 1, (rs, add, del, chk) => {
        for (let i = 0; i < 64; i++) add(VD_B + 1000 + i);
        add(65536 * 9 + 1); add(65536 * 9 + 2);                             // takes the only large slot (best: 2 keys)
        let threw = false;
        try { rs.add(VD_B + 5); } catch (e) { threw = /pool exhausted/.test(e.message); }
        if (!threw) throw new Error('no pool throw');
        chk('after pool throw');
    });
    // clear() resets the headers too (a fresh instance has all-zero headers).
    vdCase('clear() zeroes headers', 4, 4, (rs, add, del, chk, md) => {
        for (const x of vkeys(10, 5, 6000)) add(x);
        add(VD_LOS); add(VD_HIS);
        rs.clear(); md.s.clear(); md.sorted = null;
        if (VHDR) for (let c = 0; c < rs._chunks; c++) if (rs._cMin[rw(rs, c)] !== 0 || rs._cMax[rw(rs, c)] !== 0) throw new Error('chunk ' + c + ' header [' + rs._cMin[rw(rs, c)] + ', ' + rs._cMax[rw(rs, c)] + ']');
        add(VD_B + 9); chk('re-add after clear');
    });
    }

    function sec_E() {
    // ===== APPENDED from roaring-fuzz.vef.mjs (ve-fuzz-diff.txt), renamed ef* / EF_*; edits marked best: ===

    // ---- vef: appended targeted cases (U3 e / f): hysteresis edges both ways, small pool free and empty,
    // and the bitmap summary after every promotion path. checkSet (white-box: summary == rescan) after every op
    // whose chunk-0 count lands within 2 of an edge (31..34, 63..66, 2047..2050, 4095..4098), after every
    // runOptimize / spill step the case marks, and at the end.
    const EF_EDGES = [31, 32, 33, 34, 63, 64, 65, 66, 2047, 2048, 2049, 2050, 4095, 4096, 4097, 4098];
    function efEdge(name, maxS, maxL, build) {
        const U = 1 << 20;
        const rs = new RoaringSet(U, maxS, maxL), md = new Model();
        const pr = rng(7);
        let n = 0, checked = 0;
        let c0 = 0;
        const chk = (what) => { checked++; const d = checkSet(rs, md, pr, U); if (d) throw new Error('step ' + n + ' ' + what + ': ' + d); };
        const near = () => EF_EDGES.includes(c0);
        const add = (x, force) => { rs.add(x); if (!md.s.has(x) && x < 65536) c0++; md.add(x); n++; if (force || near()) chk('add(' + x + ')'); };
        const del = (x, force) => { const g = rs.delete(x), w = md.delete(x); if (w && x < 65536) c0--; n++; if (g !== w) throw new Error('delete(' + x + ') ' + g); if (force || near()) chk('delete(' + x + ')'); };
        let d = null;
        try { build(rs, add, del, md); d = checkSet(rs, md, pr, U); } catch (e) { d = e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + name.padEnd(26) + (d ? ' ' + d : ' (' + n + ' ops, ' + checked + ' checked)'));
    }
    const EF_K3 = (i) => 3 * i;                                  // chunk 0 keys, rank order == i
    function efWalk(add, del, lo, hi) { for (let t = 0; t < 6; t++) { add(EF_K3(hi)); del(EF_K3(hi)); } for (let t = 0; t < 6; t++) { del(EF_K3(lo)); add(EF_K3(lo)); } }
    for (const [tag, maxS] of [['free', 4], ['empty', 1], ['none', 0]]) {
        // 'empty': the only small slot is held by chunk 9; 'none': maxSmall = 0. Mid-way the chunk-9 key goes,
        // freeing a slot (for 'empty'), so a later delete may demote.
        efEdge('edge 64/65 pool ' + tag, maxS, 6, (rs, add, del) => {
            if (tag === 'empty') { add(9 * 65536 + 5); add(9 * 65536 + 6); } // best: 2 keys hold the slot
            for (let i = 0; i < 64; i++) add(EF_K3(i));          // 64 keys
            efWalk(add, del, 63, 64);                            // 64 <-> 65 from below; 63 <-> 64 from above
            add(EF_K3(64)); add(EF_K3(65));                          // 66 keys
            for (let t = 0; t < 6; t++) { del(EF_K3(65)); add(EF_K3(65)); } // 65 <-> 66 from above
            if (tag === 'empty') del(9 * 65536 + 5);
            for (let t = 0; t < 6; t++) { del(EF_K3(65)); del(EF_K3(64)); add(EF_K3(64)); add(EF_K3(65)); } // 66 -> 64 -> 66
            for (let i = 65; i >= 0; i--) del(EF_K3(i));          // down to empty
        });
        efEdge('edge 32/33 pool ' + tag, maxS, 6, (rs, add, del) => {
            if (tag === 'empty') { add(9 * 65536 + 5); add(9 * 65536 + 6); } // best: 2 keys hold the slot
            for (let i = 0; i <= 64; i++) add(EF_K3(i));         // 65 keys: promoted
            for (let i = 64; i >= 33; i--) del(EF_K3(i));        // 33 keys
            for (let t = 0; t < 6; t++) { del(EF_K3(32)); add(EF_K3(32)); } // 33 <-> 32
            if (tag === 'empty') del(9 * 65536 + 5);
            for (let t = 0; t < 6; t++) { del(EF_K3(32)); add(EF_K3(32)); } // again, slot free now
            efWalk(add, del, 31, 32);                            // 32 <-> 33 from below, 31 <-> 32
            for (let i = 33; i <= 64; i++) add(EF_K3(i));        // back up to 65
            for (let i = 64; i >= 0; i--) del(EF_K3(i));
        });
    }
    efEdge('edge 4096/4097', 4, 6, (rs, add, del) => {
        const K = (i) => 13 * i;                               // spread over words 0..1664
        for (let i = 0; i < 4096; i++) add(K(i));
        for (let t = 0; t < 6; t++) { add(K(4096)); del(K(4096)); add(K(2000) + 1); del(K(2000) + 1); }
        add(K(4096)); add(K(4097));
        for (let t = 0; t < 6; t++) { del(K(4097)); del(K(4096)); add(K(4096)); add(K(4097)); }
    });
    efEdge('edge 2048/2049 + walk down', 4, 6, (rs, add, del) => {
        const K = (i) => 13 * i;
        for (let i = 0; i <= 4096; i++) add(K(i));             // bitmap, 4097 keys
        for (let i = 4096; i >= 2049; i--) del(K(i));          // 2049 keys
        for (let t = 0; t < 6; t++) { del(K(2048)); add(K(2048)); }   // 2049 <-> 2048
        for (let t = 0; t < 6; t++) { add(K(2049)); del(K(2049)); }   // 2049 <-> 2050
        for (let i = 2048; i >= 0; i--) del(K(i));             // through 2048, 64, 32 to empty
        for (let i = 0; i <= 4100; i++) add(K(i));             // and back up through every edge
    });
    // every promotion path that builds a bitmap: the summary must equal a rescan (checked in checkSet)
    efEdge('summary: array dense', 4, 6, (rs, add) => { for (let x = 0; x <= 4096; x++) add(x); });  // lo in a new word, new L1
    efEdge('summary: array top half', 4, 6, (rs, add) => { for (let x = 65535; x >= 65535 - 4096; x--) add(x); }); // L2 word 1
    efEdge('summary: array lo old word', 4, 6, (rs, add) => { for (let i = 0; i < 4096; i++) add(16 * i); add(1); }); // all 64 L1
    efEdge('summary: array lo new word', 4, 6, (rs, add) => { for (let w = 0; w < 128; w++) for (let b = 0; b < 32; b++) add(64 * w + b); add(32); }); // zero word, L1 set
    efEdge('summary: run spill add big', 4, 6, (rs, add) => {
        for (let x = 0; x <= 40000; x++) add(x);               // bitmap
        for (let i = 0; i < 2046; i++) add(40002 + 2 * i);     // + 2046 isolated keys: 2047 runs
        rs.runOptimize();                                      // bitmap -> run container
        add(65535, true); add(65533, true);                    // 2048 runs, then the 2049th spills (stays bitmap)
    });
    efEdge('summary: run spill del big', 4, 6, (rs, add, del) => {
        for (let x = 25535; x <= 65535; x++) add(x);           // a run ending at 65535
        for (let i = 0; i < 2046; i++) add(1 + 12 * i);        // 2047 runs
        rs.runOptimize();
        add(24600, true);                                      // 2048 runs
        del(40000, true);                                      // split -> 2049 runs -> spill (stays bitmap)
    });
    efEdge('summary: run spill stride', 4, 6, (rs, add) => {
        for (let k = 0; k < 2047; k++) { add(32 * k); add(32 * k + 1); add(32 * k + 2); } // 2047 runs, 6141 keys
        rs.runOptimize();
        add(10, true); add(42, true);                          // 2048 runs, then the 2049th spills
    });
    }

    function sec_B() {
    // ===== APPENDED (best only): the seams between the merged variants ====================================
    // Kinds by number are best's (5 small runs, 6 FULL, 7 SINGLE); every case also runs checkSet (black-box model +
    // the white-box block: per-chunk count, headers, pools, summary) after the steps it marks. Key sets define the
    // shapes; kind asserts confirm the case reached the seam it was written for.
    const BU = 1 << 20;
    function bCase(name, maxS, maxL, build) {
        const rs = new RoaringSet(BU, maxS, maxL), md = new Model();
        const add = (x) => { rs.add(x); md.add(x); };
        const del = (x) => { const g = rs.delete(x), w = md.delete(x); if (g !== w) throw new Error('delete(' + x + ') ' + g + ' vs ' + w); };
        const kind = (c, want, what) => { if (kindOf(rs, c) !== want) throw new Error((what ? what + ': ' : '') + 'chunk ' + c + ' kind ' + kindOf(rs, c) + ' (want ' + want + ')'); };
        const chk = (what) => { const e = checkSet(rs, md, rng(11), BU) || bEdges(rs, md, BU); if (e) throw new Error(what + ': ' + e); };
        const failClosed = (fn, what) => {
            const before = vaSnap(rs);
            let threw = null;
            try { fn(); } catch (e) { threw = e; }
            if (threw === null) throw new Error(what + ': did not throw');
            if (!/pool exhausted/.test(String(threw.message))) throw new Error(what + ': threw ' + threw.message);
            if (vaSnap(rs) !== before) throw new Error(what + ': state changed after the pool throw');
            chk(what + ' (after throw)');
        };
        let d = null, info = '';
        try { info = build({ rs, md, add, del, kind, chk, failClosed }) || ''; chk('end'); } catch (e) { d = e.message; }
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + name.padEnd(26) + (d ? ' ' + d : (info ? ' ' + info : '')));
    }
    // has / successor / predecessor / min / max at every non-empty chunk's min - 1, min, min + 1, max - 1, max, max + 1
    function bEdges(rs, md, U) {
        const mn = new Map(), mx = new Map();
        for (const k of md.s) {
            const c = Math.floor(k / 65536);
            if (!mn.has(c) || k < mn.get(c)) mn.set(c, k);
            if (!mx.has(c) || k > mx.get(c)) mx.set(c, k);
        }
        for (const [c, lo] of mn) {
            const hi = mx.get(c);
            for (const q of [lo - 1, lo, lo + 1, hi - 1, hi, hi + 1]) { const e = probeQ(rs, md, q, U, 'edge '); if (e) return e; }
        }
        if (rs.min() !== md.min() || rs.max() !== md.max()) return 'min / max ' + rs.min() + ' / ' + rs.max();
        return null;
    }

    bCase('best SINGLE -> 2 -> small', 2, 2, (t) => {
        const b = 3 * 65536;
        t.add(b + 700); t.kind(3, 7, '1 key'); t.chk('single');
        if (t.rs._sTop !== 2 || t.rs._lTop !== 2) throw new Error('a SINGLE took a slot');
        t.add(b + 700); t.kind(3, 7, 'duplicate');
        t.add(b + 9); t.kind(3, 1, '2 keys, new min'); t.chk('2 keys');
        t.del(b + 9); t.kind(3, 7, 'back to 1 (min gone)'); t.chk('back to 1');
        if (t.rs._sTop !== 2) throw new Error('small slot not returned');
        t.add(b + 65535); t.kind(3, 1, '2 keys, new max'); t.chk('2 keys max');
        t.del(b + 700); t.kind(3, 7, 'keep the max'); t.chk('keep max');
        for (let i = 0; i < 64; i++) t.add(b + 100 + i);               // 65 keys: small -> array
        t.kind(3, 2, '65 keys'); t.chk('65');
        for (let i = 0; i < 64; i++) t.del(b + 100 + i);               // back to the one key: array 2 -> SINGLE
        t.kind(3, 7, 'array down to 1'); t.chk('array down');
        // small pool used -> the 2nd key takes a slab; both pools used -> fail closed
        t.add(0); t.add(1); t.add(65536); t.add(65537);                // chunks 0 / 1 hold both small slots
        t.add(b + 1); t.kind(3, 2, '2 keys, small pool empty'); t.chk('to array');
        t.add(2 * 65536); t.add(2 * 65536 + 1); t.kind(2, 2, 'chunk 2');  // the last slab
        t.add(4 * 65536 + 4); t.kind(4, 7, 'a SINGLE never fails');
        t.failClosed(() => t.rs.add(4 * 65536 + 5), 'SINGLE + 1, both pools empty');
        t.del(4 * 65536 + 4); t.kind(4, 0, 'emptied');
        return 'ok';
    });
    bCase('best FULL down to SINGLE', 4, 4, (t) => {
        const orders = [
            (b, keep) => { const a = []; for (let x = 0; x < 65536; x++) if (x !== keep) a.push(b + x); return a; },             // ascending
            (b, keep) => { const a = []; for (let x = 65535; x >= 0; x--) if (x !== keep) a.push(b + x); return a; },            // descending
            (b, keep) => { const a = []; for (let x = 1; x < 65536; x += 2) if (x !== keep) a.push(b + x); for (let x = 0; x < 65536; x += 2) if (x !== keep) a.push(b + x); return a; }, // odd then even: many runs
        ];
        const seen = new Set();
        for (const [oi, keep] of [[0, 65535], [1, 0], [2, 31337], [2, 0], [0, 40000]]) {
            const c = 1 + (oi % 3), b = c * 65536;
            for (let x = 0; x < 65536; x++) t.add(b + x);
            t.kind(c, 6, 'filled');
            const seq = orders[oi](b, keep);
            for (let i = 0; i < seq.length; i++) {
                t.del(seq[i]);
                seen.add(kindOf(t.rs, c));
                if ((i & 4095) === 0 || seq.length - i < 4) t.chk('order ' + oi + ' step ' + i);
            }
            t.kind(c, 7, 'one key left');
            if (t.rs._slot[rw(t.rs, c)] !== keep) throw new Error('SINGLE keeps ' + t.rs._slot[rw(t.rs, c)] + ' (want ' + keep + ')');
            t.chk('single after FULL');
            t.del(b + keep); t.kind(c, 0, 'emptied');
        }
        if (t.rs._sTop !== 4 || t.rs._lTop !== 4) throw new Error('pools ' + t.rs._sTop + ' / ' + t.rs._lTop);
        for (const k of [1, 2, 3, 4, 5, 7]) if (!seen.has(k)) throw new Error('never passed kind ' + k + ' (saw ' + [...seen].sort().join() + ')');
        return 'kinds seen ' + [...seen].sort().join(',');
    });
    bCase('best small runs <-> SINGLE', 2, 2, (t) => {
        const b = 65536;
        for (let x = 0; x < 100; x++) t.add(b + x);
        t.rs.runOptimize(); t.kind(1, 5, '1 run');
        for (let x = 99; x >= 2; x--) t.del(b + x);                     // [0, 1]: one 2-key run
        t.kind(1, 5, '2-key run'); t.chk('2-key run');
        t.del(b + 0); t.kind(1, 7, 'keep the run end');
        if (t.rs._slot[rw(t.rs, 1)] !== 1 || t.rs._sTop !== 2) throw new Error('slot ' + t.rs._slot[rw(t.rs, 1)] + ' sTop ' + t.rs._sTop);
        t.chk('single from 2-key run');
        t.add(b + 5); t.kind(1, 1, 'SINGLE + 1 -> small array, not small runs'); t.chk('to small');
        t.del(b + 5); t.del(b + 1);
        for (let x = 0; x < 100; x++) t.add(b + x);
        t.rs.runOptimize();
        for (let x = 1; x <= 98; x++) t.del(b + x);                     // [0] [99]: two 1-key runs
        t.kind(1, 5, 'two 1-key runs'); t.chk('two 1-key runs');
        t.del(b + 99); t.kind(1, 7, 'keep the first');
        if (t.rs._slot[rw(t.rs, 1)] !== 0) throw new Error('kept ' + t.rs._slot[rw(t.rs, 1)]);
        t.add(b + 99); t.del(b + 0); t.kind(1, 7, 'via small array');
        t.del(b + 99);
        for (let x = 0; x < 100; x++) t.add(b + x);
        t.rs.runOptimize();
        for (let x = 1; x <= 98; x++) t.del(b + x);
        t.del(b + 0); t.kind(1, 7, 'keep the second');
        if (t.rs._slot[rw(t.rs, 1)] !== 99) throw new Error('kept ' + t.rs._slot[rw(t.rs, 1)]);
        // small runs with 32 runs shrink to SINGLE through kind 5 only (the small slot comes back)
        t.del(b + 99);
        for (let r = 0; r < 32; r++) for (let i = 0; i < 3; i++) t.add(b + r * 10 + i);
        t.rs.runOptimize(); t.kind(1, 5, '32 runs');
        for (let r = 31; r >= 1; r--) for (let i = 0; i < 3; i++) t.del(b + r * 10 + i);
        t.del(b + 2); t.kind(1, 5, 'one 2-key run'); t.del(b + 1); t.kind(1, 7, 'single'); t.chk('32 runs to single');
        if (t.rs._sTop !== 2 || t.rs._lTop !== 2) throw new Error('pools ' + t.rs._sTop + ' / ' + t.rs._lTop);
    });
    bCase('best headers min/max every kind', 8, 8, (t) => {
        const B = (c) => c * 65536;
        for (let i = 0; i < 40; i++) t.add(B(1) + 100 + 3 * i);                      // 1 small
        for (let i = 0; i < 1000; i++) t.add(B(2) + 50 + 7 * i);                     // 2 array
        for (let i = 0; i < 6000; i++) t.add(B(3) + 10 + 5 * i);                     // 3 bitmap
        for (let r = 0; r < 40; r++) for (let j = 0; j < 20; j++) t.add(B(4) + 200 + 1000 * r + j); // 4 runs (40)
        for (let r = 0; r < 10; r++) for (let j = 0; j < 20; j++) t.add(B(5) + 300 + 3000 * r + j); // 5 small runs
        for (let x = 0; x < 65536; x++) t.add(B(6) + x);                             // 6 FULL
        t.add(B(7) + 4242);                                                          // 7 SINGLE
        for (let i = 0; i < 6000; i++) t.add(B(8) + 4 * i);                          // 3 bitmap from 0
        for (let x = 0; x < 300; x++) t.add(B(9) + 65236 + x);                       // 5 one run ending at 65535
        t.rs.runOptimize();
        const want = [0, 1, 2, 3, 4, 5, 6, 7, 3, 5];
        for (let c = 1; c <= 9; c++) t.kind(c, want[c], 'built');
        t.chk('built');
        // delete the min, then the max, of every chunk, 60 times (or until 1 key), checking after every round
        for (let round = 0; round < 60; round++) {
            for (let c = 1; c <= 9; c++) {
                if (kindOf(t.rs, c) === 0 || kindOf(t.rs, c) === 7) continue;
                const lo = t.rs.successor(B(c) - 1), hi = t.rs.predecessor(B(c + 1));
                t.del(lo);
                if (t.rs._cMin[rw(t.rs, c)] !== t.rs.successor(B(c) - 1) - B(c)) throw new Error('chunk ' + c + ' _cMin after delete-of-min ' + t.rs._cMin[rw(t.rs, c)]);
                if (hi !== lo) t.del(hi);
            }
            if (round < 3 || (round & 15) === 0) t.chk('round ' + round);
        }
        t.chk('rounds done');
        t.del(B(7) + 4242); t.kind(7, 0, 'SINGLE deleted');
        t.add(B(7) + 9); t.chk('re-add after the stale header');
        return 'kinds after ' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => kindOf(t.rs, c)).join('');
    });
    bCase('best FULL edge deletes', 1, 2, (t) => {
        const b = 2 * 65536;
        for (let x = 0; x < 65536; x++) t.add(b + x);
        t.del(b + 0); t.kind(2, 5, 'FULL - 0'); t.chk('min gone');
        if (t.rs._cMin[rw(t.rs, 2)] !== 1 || t.rs._cMax[rw(t.rs, 2)] !== 65535) throw new Error('header ' + t.rs._cMin[rw(t.rs, 2)] + ',' + t.rs._cMax[rw(t.rs, 2)]);
        t.add(b + 0); t.kind(2, 6, 'refilled');
        t.del(b + 65535); t.chk('max gone');
        if (t.rs._cMax[rw(t.rs, 2)] !== 65534) throw new Error('_cMax ' + t.rs._cMax[rw(t.rs, 2)]);
        t.add(b + 65535);
        t.add(0); t.add(1);                                                          // chunk 0 holds the only small slot
        t.del(b + 65535); t.kind(2, 4, 'fallback slab'); t.chk('fallback slab max gone');
        t.del(b + 65534); t.del(b + 0); t.chk('fallback slab edges');
        t.add(b + 0); t.add(b + 65534); t.add(b + 65535); t.kind(2, 6, 'refilled from kind 4');
        t.add(3 * 65536); t.add(3 * 65536 + 1); t.kind(3, 2, 'chunk 3 takes a slab');
        t.add(4 * 65536); t.add(4 * 65536 + 1); t.kind(4, 2, 'chunk 4 takes the last slab');
        t.failClosed(() => t.rs.delete(b + 0), 'FULL delete-of-min, pools empty');
        t.failClosed(() => t.rs.delete(b + 65535), 'FULL delete-of-max, pools empty');
    });
    bCase('best 33rd-run spill keeps hdr', 4, 1, (t) => {
        for (let r = 0; r < 32; r++) for (let i = 0; i < 3; i++) t.add(r * 10 + 100 + i);    // runs 100 .. 412
        t.rs.runOptimize(); t.kind(0, 5, '32 runs');
        for (let x = 0; x < 100; x++) t.add(65536 + x);                              // chunk 1 takes the only slab
        t.kind(1, 2, 'chunk 1');
        t.failClosed(() => t.rs.add(5), 'new min as the 33rd run');
        t.failClosed(() => t.rs.add(60000), 'new max as the 33rd run');
        t.failClosed(() => t.rs.delete(111), 'split to 33 runs');
        for (let x = 0; x < 100; x++) t.del(65536 + x);                              // slab back (SINGLE at 1, then 0)
        t.add(5); t.kind(0, 4, '33 runs'); t.chk('new min spill');
        t.add(60000); t.chk('new max');
        t.del(5); t.del(60000); t.kind(0, 5, 'back to 32'); t.chk('back');
    });
    bCase('best hysteresis + vf edges', 4, 6, (t) => {
        const K = (i) => 11 * i + 3;                                                  // spread keys, chunk 0
        for (let i = 0; i < 4096; i++) t.add(K(i));
        t.kind(0, 2, '4096');
        t.add(1); t.kind(0, 3, '4097th is the new min'); t.chk('promote, new min');
        t.del(1); t.kind(0, 3, 'stays bitmap at 4096');
        t.add(65535); t.kind(0, 3, 'new max'); t.chk('new max');
        for (let i = 4095; i >= 2048; i--) t.del(K(i));                               // 2049 keys left (with 65535)
        t.kind(0, 3, '2049'); t.chk('2049');
        t.del(65535); t.kind(0, 2, '2048 -> array (delete of the max)'); t.chk('demote by max');
        for (let i = 2048; i < 4096; i++) t.add(K(i));
        t.add(0); t.kind(0, 3, 'promote again, new min 0'); t.chk('promote again');
        for (let i = 4095; i >= 2048; i--) t.del(K(i));                               // 2049 keys left (with 0)
        t.del(0); t.kind(0, 2, '2048 -> array (delete of the min)'); t.chk('demote by min');
        for (let i = 2047; i >= 33; i--) t.del(K(i));
        t.kind(0, 2, '33 keys'); t.del(K(32)); t.kind(0, 1, '32 -> small'); t.chk('to small');
        for (let i = 32; i < 64; i++) t.add(K(i));
        t.kind(0, 1, '64'); t.add(K(64)); t.kind(0, 2, '65'); t.del(K(64)); t.kind(0, 2, '64 keeps the slab');
        // vf: a run container spills into a bitmap through _promoteRunToBitmap (> 4,096 keys), then ve demotes it
        const b = 65536;
        for (let x = 30000; x <= 65535; x++) t.add(b + x);
        for (let i = 0; i < 2046; i++) t.add(b + 1 + 12 * i);                       // + 2046 isolated: 2047 runs
        t.rs.runOptimize(); t.kind(1, 4, '2047 runs');
        t.add(b + 24600); t.kind(1, 4, '2048 runs');
        t.add(b + 24700); t.kind(1, 3, 'spill to bitmap'); t.chk('spill');
        t.del(b + 65535); t.del(b + 1); t.chk('spill + delete min / max');
        for (let x = 30000; x <= 65534; x++) if (x % 7 !== 0) t.del(b + x);
        t.chk('bitmap thinned');
        let n = 0; for (const k of t.md.s) if (k >= b && k < 2 * b) n++;
        while (n > 2048) { t.del(t.rs.predecessor(2 * b)); n--; }
        t.kind(1, 2, 'demoted at 2048'); t.chk('demoted');
    });
    {
        // SINGLE and FULL against every kind (hit and miss), both argument orders (G3, SPEC C-21; restored from the draft case 'best SINGLE/FULL x kinds', XK dropped)
        const U = BU, mkB = () => new RoaringSet(U, 8, 12);
        const B = mkB(), mB = new Model();
        const addB = (x) => { B.add(x); mB.add(x); };
        const V = 4000;
        const fills = [
            (b, on) => { addB(b + (on ? V : 2)); addB(b + 1); },                                       // 1 small (2 keys)
            (b, on) => { if (on) addB(b + V); for (let i = 0; i < 300; i++) addB(b + 1 + 7 * i); },    // 2 array
            (b, on) => { if (on) addB(b + V); for (let i = 0; i < 5000; i++) addB(b + 2 + 13 * i); },  // 3 bitmap
            (b, on) => { for (let r = 0; r < 41; r++) for (let j = 0; j < 9; j++) if (on || r * 100 + j !== V) addB(b + r * 100 + j); }, // 4 runs (41)
            (b, on) => { for (let r = 0; r < 8; r++) for (let j = 0; j < 9; j++) if (on || r * 1000 + j !== V) addB(b + r * 1000 + j); }, // 5 small runs
            (b, on) => { for (let x = 0; x < 65536; x++) if (on || x !== V) addB(b + x); },             // 6 FULL (or FULL minus V)
            (b, on) => { addB(b + (on ? V : V + 1)); },                                                // 7 SINGLE
        ];
        for (let h = 0; h < 2; h++) for (let k = 0; k < 7; k++) fills[k]((h * 7 + k) * 65536, h === 0);
        B.runOptimize();
        const A = new RoaringSet(U, 2, 2), mA = new Model();                                    // SINGLE V everywhere
        for (let c = 0; c < 14; c++) { A.add(c * 65536 + V); mA.add(c * 65536 + V); }
        const F = new RoaringSet(U, 2, 2), mF = new Model();                                    // FULL in 0..13
        for (let c = 0; c < 14; c++) for (let x = 0; x < 65536; x++) { F.add(c * 65536 + x); mF.add(c * 65536 + x); }
        const kB = []; for (let c = 0; c < 14; c++) kB.push(kindOf(B, c));
        let d = checkSet(B, mB, rng(21), U) || checkSet(A, mA, rng(22), U) || checkSet(F, mF, rng(23), U) ||
            checkPair(A, mA, B, mB) || checkPair(B, mB, A, mA) || checkPair(F, mF, B, mB) || checkPair(B, mB, F, mF) ||
            checkPair(A, mA, F, mF) || checkPair(F, mF, A, mA);
        const wantK = '1 2 3 4 5 6 7 1 2 3 4 5 5 7';                                                   // FULL minus V -> 2 small runs
        if (!d && kB.join(' ') !== wantK) d = 'B kinds ' + kB.join(' ') + ' (want ' + wantK + ')';
        if (!d && (kindOf(A, 0) !== 7 || kindOf(F, 0) !== 6)) d = 'A / F kinds ' + kindOf(A, 0) + ' / ' + kindOf(F, 0);
        if (d) failures++;
        log((d ? 'FAIL ' : 'ok   ') + 'best SINGLE/FULL x kinds'.padEnd(26) + (d ? ' ' + d : ' (B: ' + kB.join(' ') + ')'));
    }
    }

    const secs = { SCEN: sec_SCEN, R: sec_R, C: sec_C, T: sec_T, V: sec_V, D: sec_D, E: sec_E, B: sec_B };
    for (const name of only) secs[name]();
    return { failures, rows, cov, trace, lines, seeds: SEEDS, ops: OPS, base: BASE, only: [...only] };
}

/**
 * Independent re-check of the A-2 floors over the `cov` rows runRoaringFuzz returns. Floor 100 (a literal, not
 * the one the harness used). R scenarios: kinds 1..7 (kinds 1 and 5 exempt when maxSmall is 0); C scenarios:
 * kinds 1..4; both: bitmapsWithZeroWord. Returns the misses ([] = floors met).
 */
export function floorMisses(cov) {
    const miss = [];
    for (const row of cov) {
        const need = row.isR ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4];
        for (const k of need) {
            if (row.isR && row.maxS === 0 && (k === 1 || k === 5)) continue;
            const n = row.kinds[k] || 0;
            if (n < 100) miss.push(row.scenario + ': kind ' + k + ' ' + n + ' < 100');
        }
        if (!(row.bmpZeroWord >= 100)) miss.push(row.scenario + ': bitmapsWithZeroWord ' + row.bmpZeroWord + ' < 100');
    }
    return miss;
}

// === A-3 / A-4 contract oracle (PLAN-roaringset-G1 A-3, A-4; SPEC C-4, C-10a) ============================
// Black-box and reusable. Everything below takes the CLASS under test, so the same code runs on the live
// build (test/RoaringSet.test.js) and on a data: URL mutant (G1-B5 through the worker's kind 'a3' / 'a4' /
// 'universe', see test/_roaring-fuzz-worker.mjs). Each check returns an array of failure strings ([] = pass).
// Expected values come from the SPEC / PROPOSAL section 1, never from running the engine.

function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
}

const POOL_RE = /pool exhausted \(capacity \d+\)/;

function plain(v) {
    if (ArrayBuffer.isView(v)) {
        return 'sha256:' + createHash('sha256').update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)).digest('hex');
    }
    return v;
}

/**
 * The A-3 snapshot: sha256 of the bytes of EVERY own property of `set` that is a typed array, plus EVERY other own
 * property (the scalars: `_size`, `_sTop`, `_lTop`, `_pTop`, ... enumerated, never named by hand, so a field added
 * later is covered), plus `size`. Equal snapshots (deepEqual) = unchanged.
 */
export function ownedSnapshot(set) {
    const typed = {};
    const scalars = {};
    for (const key of Object.keys(set).sort()) {
        if (ArrayBuffer.isView(set[key])) typed[key] = plain(set[key]);
        else scalars[key] = set[key] !== null && typeof set[key] === 'object' ? canon(set[key]) : set[key];
    }
    return { typed, scalars, size: set.size };
}

function snapshotText(s) {
    return canon(s);
}

function addRange(set, lo, n) { for (let x = lo; x < lo + n; x++) set.add(x); }

// 32 runs [10r, 10r + 2] in chunk 0 as a small-runs container, then chunk 1 takes the only large slot
function smallRunsNoSlab(RS) {
    const s = new RS(1 << 20, 4, 1);
    for (let r = 0; r < 32; r++) for (let i = 0; i < 3; i++) s.add(r * 10 + i);
    s.runOptimize();
    addRange(s, 65536, 100);
    return s;
}

/** The five A-3 throw sites; build() returns a set whose pools are exhausted for call(set). */
export const A3_CASES = [
    {
        name: '_promoteSingle (SINGLE + 1 key, both pools empty)',
        build(RS) {
            const s = new RS(1 << 20, 1, 1);
            s.add(0); s.add(1);                    // chunk 0: 2 keys -> the only small slot
            s.add(65536); s.add(65537);            // chunk 1: small pool empty -> the only large slot
            s.add(2 * 65536 + 4);                  // chunk 2: SINGLE, no slot
            return s;
        },
        want: [{ chunk: 0, kind: 'small' }, { chunk: 1, kind: 'array' }, { chunk: 2, kind: 'single' }],
        call: (s) => s.add(2 * 65536 + 5),
    },
    {
        name: '_promoteSmallToArray (65th key, large pool empty)',
        build(RS) {
            const s = new RS(1 << 20, 1, 1);
            addRange(s, 0, 64);                    // chunk 0: 64 keys -> the only small slot
            s.add(65536); s.add(65537);            // chunk 1: the only large slot
            return s;
        },
        want: [{ chunk: 0, kind: 'small' }, { chunk: 1, kind: 'array' }],
        call: (s) => s.add(64),
    },
    {
        name: '_deleteFull (FULL delete, both pools empty)',
        build(RS) {
            const s = new RS(1 << 20, 1, 1);
            addRange(s, 0, 65536);                 // chunk 0: FULL
            s.add(65536 + 5); s.add(65536 + 6);    // chunk 1: the only small slot
            s.add(2 * 65536 + 9); s.add(2 * 65536 + 10); // chunk 2: the only large slot
            return s;
        },
        want: [{ chunk: 0, kind: 'full' }, { chunk: 1, kind: 'small' }, { chunk: 2, kind: 'array' }],
        call: (s) => s.delete(1234),
    },
    {
        name: '_promoteSmallRunToRun via _addRun (33rd run, large pool empty)',
        build: smallRunsNoSlab,
        want: [{ chunk: 0, kind: 'smallRuns' }, { chunk: 1, kind: 'array' }],
        call: (s) => s.add(500),
    },
    {
        name: '_promoteSmallRunToRun via _deleteRun (split to a 33rd run, large pool empty)',
        build: smallRunsNoSlab,
        want: [{ chunk: 0, kind: 'smallRuns' }, { chunk: 1, kind: 'array' }],
        call: (s) => s.delete(11),
    },
];

/** Runs one A-3 case on RS: precondition kinds, the throw, the unchanged snapshot, the set still answers. */
export function runA3Case(RS, c) {
    const f = [];
    let s;
    try { s = c.build(RS); } catch (e) { return [c.name + ': build threw ' + String(e && e.message)]; }
    const kinds = s.dump().chunks.map((x) => ({ chunk: x.chunk, kind: x.kind }));
    if (canon(kinds) !== canon(c.want)) {
        return [c.name + ': precondition kinds ' + canon(kinds) + ' (want ' + canon(c.want) + ')'];
    }
    const before = ownedSnapshot(s);
    const dumpBefore = canon(s.dump());
    let threw = null;
    try { c.call(s); } catch (e) { threw = e; }
    if (threw === null) f.push(c.name + ': did not throw');
    else {
        if (!(threw instanceof RangeError)) f.push(c.name + ': threw ' + String(threw && threw.name) + ', want RangeError');
        if (!POOL_RE.test(String(threw && threw.message))) f.push(c.name + ': message ' + String(threw && threw.message) + ' does not match ' + POOL_RE);
    }
    const after = ownedSnapshot(s);
    if (snapshotText(before) !== snapshotText(after)) f.push(c.name + ': state changed by the throwing call: ' + snapshotText(before) + ' -> ' + snapshotText(after));
    if (canon(s.dump()) !== dumpBefore) f.push(c.name + ': dump changed by the throwing call');
    return f;
}

/** A FULL delete with maxSmall 0 and a free large slot becomes a 'runs' container (PROPOSAL: P-2 fallback). */
export function checkFullDeleteFallback(RS) {
    const f = [];
    try {
        const s = new RS(1 << 20, 0, 2);
        addRange(s, 3 * 65536, 65536);
        const d0 = s.dump().chunks;
        if (canon(d0) !== canon([{ chunk: 3, kind: 'full', count: 65536, runs: 0 }])) f.push('FULL fill dump ' + canon(d0));
        if (s.delete(3 * 65536 + 65535) !== true) f.push('FULL delete returned false');
        const d1 = s.dump().chunks;
        // 65,535 keys [0, 65534] = one run
        if (canon(d1) !== canon([{ chunk: 3, kind: 'runs', count: 65535, runs: 1 }])) f.push("FULL delete (maxSmall 0) dump " + canon(d1) + " (want kind 'runs')");
        if (s.size !== 65535 || s.has(3 * 65536 + 65535) || !s.has(3 * 65536 + 65534)) f.push('FULL delete: wrong contents');
    } catch (e) {
        f.push('FULL delete maxSmall 0 threw ' + String(e && e.message));
    }
    return f;
}

/** Every A-3 case plus the FULL fallback. */
export function checkA3(RS) {
    const f = [];
    for (const c of A3_CASES) for (const m of runA3Case(RS, c)) f.push(m);
    for (const m of checkFullDeleteFallback(RS)) f.push(m);
    return f;
}

function throwsText(fn) {
    try { fn(); } catch (e) { return { name: e && e.name, ctor: e && e.constructor, message: String(e && e.message) }; }
    return null;
}

/** A-4 universe check: universe is REQUIRED and bounded. (PROPOSAL section 1, SPEC C-4.) */
export function checkUniverse(RS) {
    const f = [];
    const t = throwsText(() => new RS());
    const want = '[lite-loglogn] RoaringSet universe must be an integer in [1, 2^32]; got undefined';
    if (t === null) f.push('new RoaringSet() did not throw');
    else {
        if (t.ctor !== RangeError) f.push('new RoaringSet() threw ' + t.name + ', want RangeError');
        if (t.message !== want) f.push('new RoaringSet() message ' + canon(t.message) + ' (want ' + canon(want) + ')');
    }
    for (const [u, got] of [[0, '0'], [-1, '-1'], [1.5, '1.5'], [4294967297, '4294967297'], [NaN, 'NaN']]) {
        const e = throwsText(() => new RS(u));
        const w = '[lite-loglogn] RoaringSet universe must be an integer in [1, 2^32]; got ' + got;
        if (e === null) f.push('new RoaringSet(' + String(u) + ') did not throw');
        else if (e.ctor !== RangeError || e.message !== w) f.push('new RoaringSet(' + String(u) + ') ' + e.name + ' ' + canon(e.message));
    }
    for (const u of [1, 4294967296]) {
        if (throwsText(() => new RS(u, 0, 1)) !== null) f.push('new RoaringSet(' + u + ', 0, 1) threw');
    }
    return f;
}

const A4_BYTES = [
    // [universe, maxSmall, maxLarge, byteLength]  (assertions A-4; formula C-3 with 8,460 + 11 C + 130 s + 8,456 (l + 1) + 2 l)
    [4294967296, 1024, 256, 3036180],
    [4294967296, 0, 1, 746270],
    [65536, 1024, 256, 2315295],
    [1, 0, 1, 25385],
];

/** A-4 knobs, byteLength values and dump(). */
export function checkA4(RS) {
    const f = [];
    const knob = (args, text) => {
        const e = throwsText(() => new RS(...args));
        if (e === null) f.push('new RoaringSet(' + args.join(', ') + ') did not throw');
        else if (e.ctor !== RangeError || e.message !== text) f.push('new RoaringSet(' + args.join(', ') + ') ' + e.name + ' ' + canon(e.message) + ' (want ' + canon(text) + ')');
    };
    const P = '[lite-loglogn] RoaringSet ';
    knob([1 << 20, 65536], P + 'maxSmall must be an integer in [0, 65535]; got 65536');
    knob([1 << 20, -1], P + 'maxSmall must be an integer in [0, 65535]; got -1');
    knob([1 << 20, 1.5], P + 'maxSmall must be an integer in [0, 65535]; got 1.5');
    knob([1 << 20, 0, 0], P + 'maxLarge must be an integer in [1, 65534]; got 0');
    knob([1 << 20, 0, 65535], P + 'maxLarge must be an integer in [1, 65534]; got 65535');
    for (const [u, ms, ml, bytes] of A4_BYTES) {
        try {
            const s = new RS(u, ms, ml);
            if (s.byteLength !== bytes) f.push('byteLength(' + u + ', ' + ms + ', ' + ml + ') ' + s.byteLength + ' (want ' + bytes + ')');
            if (s.universe !== u) f.push('universe ' + s.universe + ' (want ' + u + ')');
            if (s.paged !== false) f.push('paged ' + s.paged + ' (want false)');
        } catch (e) {
            f.push('new RoaringSet(' + u + ', ' + ms + ', ' + ml + ') threw ' + String(e && e.message));
        }
    }
    try {
        // dump(): one chunk per kind name, in chunk order; counts and run counts by construction
        const s = new RS(1 << 20, 8, 8);
        s.add(0 * 65536 + 77);                                           // single
        s.add(1 * 65536 + 5); s.add(1 * 65536 + 900);                    // small (2 keys, not adjacent)
        for (let i = 0; i < 100; i++) s.add(2 * 65536 + 7 * i);          // array (100 keys, 100 runs)
        for (let i = 0; i < 5000; i++) s.add(3 * 65536 + 13 * i);        // bitmap (5000 keys)
        for (let r = 0; r < 40; r++) for (let j = 0; j < 20; j++) s.add(4 * 65536 + 1000 * r + j); // 40 runs of 20
        for (let r = 0; r < 3; r++) for (let j = 0; j < 40; j++) s.add(5 * 65536 + 1000 * r + j);  // 3 runs of 40 (120 keys: an array, so runOptimize applies)
        addRange(s, 6 * 65536, 65536);                                   // full
        s.runOptimize();
        const d = s.dump();
        const wantChunks = [
            { chunk: 0, kind: 'single', count: 1, runs: 0 },
            { chunk: 1, kind: 'small', count: 2, runs: 0 },
            { chunk: 2, kind: 'array', count: 100, runs: 0 },
            { chunk: 3, kind: 'bitmap', count: 5000, runs: 0 },
            { chunk: 4, kind: 'runs', count: 800, runs: 40 },
            { chunk: 5, kind: 'smallRuns', count: 120, runs: 3 },
            { chunk: 6, kind: 'full', count: 65536, runs: 0 },
        ];
        const wantSize = 1 + 2 + 100 + 5000 + 800 + 120 + 65536;
        if (canon(d.chunks) !== canon(wantChunks)) f.push('dump chunks ' + canon(d.chunks) + ' (want ' + canon(wantChunks) + ')');
        if (d.universe !== 1 << 20 || d.size !== wantSize || d.paged !== false) f.push('dump header ' + canon({ universe: d.universe, size: d.size, paged: d.paged }) + ' (want universe ' + (1 << 20) + ' size ' + wantSize + ' paged false)');
        // snapshot independence: later mutation changes neither the held dump nor its chunk objects
        const held = canon(d);
        s.add(7 * 65536 + 1); s.delete(0 * 65536 + 77); s.clear();
        if (canon(d) !== held) f.push('dump() snapshot changed after later mutation');
        const d2 = s.dump();
        if (d2.size !== 0 || d2.chunks.length !== 0) f.push('dump after clear ' + canon(d2));
        if (d2.chunks === d.chunks) f.push('dump() returned a shared chunks array');
    } catch (e) {
        f.push('dump check threw ' + String(e && e.message));
    }
    return f;
}

/** Named cases for the unit test (one node:test each); checkA3 / checkA4 / checkUniverse run them all. */
export const A4_CASES = [
    { name: 'universe is required and bounded', run: checkUniverse },
    { name: 'knobs, byteLength, dump', run: checkA4 },
];
