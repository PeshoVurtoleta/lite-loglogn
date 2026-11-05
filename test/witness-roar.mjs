/**
 * @zakkster/lite-loglogn -- witness:roar, the REPORTED timing harness for RoaringSet (0.6.0 G7).
 *
 *     npm run witness:roar                         FULL run (REPORTED; under quiet-lock, see below)
 *     npm run witness:roar -- --smoke              wiring smoke: prints NO timing number at all
 *     npm run witness:roar -- --json out.json      also write every cell + the digest as JSON
 *
 * Every timed run goes through the shared-host lock (C-14: one REPORTED run, after G4's shrink):
 *     node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-loglogn witness:roar" -- npm run witness:roar
 * Nothing here is in `verify` or `test:perf`; no exit code is ever a release gate (REPORTED tier).
 *
 * METHOD (ports .handoff/research/roaring/timing-harness.mjs, R0 U6): per cell (w, n, op) every column's
 * runner is a fresh `new Function` (own feedback, monomorphic call sites), cold pre-pass vs a sorted-array
 * oracle, W untimed warm-up runs, a doubling search sizes reps to ~10 ms per run, then K = 15 INTERLEAVED
 * rounds rotated by r. Statistic per column: the MEDIAN over rounds of the per-round ratio column / SB
 * (StratifiedBitset, the reference), its IQR. CONTROL: SB-AA (a second identical SB) median ratio in
 * [0.9, 1.1], else the cell is INCONCLUSIVE (never a number in the digest). x2 CONTROL: at (w 16, n 4096,
 * successor) a column doing SB.successor twice per query must read [1.6, 2.4] (the harness can resolve a
 * 2x step), else exit 1; when that cell's SB-AA control drifted the x2 control is unjudged: exit 2. Keys and queries < min(U, 2^30) (Smis: no timed body boxes a returned key).
 * Ops: has / add / delete / successor / predecessor / min / max (add / delete: the toggle schedule).
 *
 * LAYOUTS (S-3, C-15): each layout runs in its OWN child process (paged feedback must not pollute the
 * direct numbers): D = direct RoaringSet (RS-D) at w 16 / 20 / 24 / 28 / 32; P = paged (RS-P) at w 32 only
 * (keys < 2^30 touch 64 of 256 pages at pageBits 8: the only width where the bytes rule picks paged);
 * M = the mixed row at w 32: ONE runner per op fed a direct (mix-D) AND a paged (mix-P) set. n 64 / 4096
 * / 65536 (n_eff = min(n, U / 4)). The PARENT sizes every pool through the public API only (retry search
 * on build + 3 toggle cycles, `RangeError /pool/` = too small; maxPages, then maxLarge, then maxSmall;
 * SPEC A16): maxLarge is pinned <= R0's sized maxLarge + 1 per (w, n_eff) (R0_LARGE), and maxSmall :=
 * max(searched, R0's sized maxSmall) per (w, n_eff) (R0_SMALL; a missing key is a FAIL, never a default),
 * because a small pool searched down to its minimum lets _promoteSingle park a 2..64-key chunk in a large
 * slot. A PARKED-CHUNK CENSUS then builds every sized pool once (read-only `_kind` / `_card`) and FAILs the
 * run before any child starts when a large-slot chunk (array / bitmap / runs) holds <= 64 keys, so the
 * timed container mix is R0's by construction. It asserts `paged` false for D / true for P,
 * writes the plan JSON, and runs the three children in sequence with process.execPath + the same
 * execArgv. The shapes use add / delete only (never addRange).
 *
 * CHILD gates (deterministic, also in smoke; any miss = exit 1): the pre-pass (every column's fold equals
 * the sorted-array oracle; member-hitting successor / predecessor streams too) and its must-fail foil (a
 * NON-STRICT successor over the sorted keys must be flagged); every cell's K rounds run inside ONE GC
 * window (gc.major 0, arrayBuffers growth 0 B; the empty / retain-1 MB / forced-gc() controls first);
 * ISOLATION (D builds no paged set, P no direct set, M's mix-D / mix-P share one runner in every cell,
 * every other column has its own runner); RETENTION (a lite-leak tracker per group: after the group's
 * drop + gc + settle, tracker.size() 0).
 *
 * --smoke: K 1, warm-up 1, Q 256, reps 1, w [16, 32], n [64, 4096]: every structure / op / cell is
 * built, pre-passed and executed once inside its GC window; no timing number is printed.
 *
 * Exit: 0 normal; 2 INCONCLUSIVE (full run only): more than a quarter of the cells are INCONCLUSIVE (host
 * drift) OR the x2 control is unjudged (its cell's SB-AA drifted; maintainer ruling 2026-11-05); 1 on
 * anything else (bad flag with a did-you-mean hint and no banner, RoaringSet not exported, pool sizing or
 * its R0 large-pool pin, a missing R0_SMALL key, a parked chunk / unknown kind / card-sum miss in the census, a
 * malformed child result (x2 control, inconclusive count), pre-pass, foil not flagged, classifier without teeth, x2 control outside [1.6, 2.4]
 * with SB-AA ok, GC window, ISOLATION, RETENTION, a child exit). Importing this module has NO side effects: the CLI runs only when this
 * file is the entry script. The pure exports are gated by test/RoarWitness.test.js (B2). ASCII only.
 */

import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const PFX = '[witness-roar] ';
const OPS = Object.freeze(['has', 'add', 'delete', 'successor', 'predecessor', 'min', 'max']);
const FLAGS = Object.freeze(['--smoke', '--json', '--child', '--plan']);
const LAYOUTS = Object.freeze(['D', 'P', 'M']);
const KEY_CAP = 2 ** 30;
const CTRL_LO = 0.9;
const CTRL_HI = 1.1;
const X2_LO = 1.6;
const X2_HI = 2.4;
const X2_CELL = Object.freeze({ w: 16, n: 4096, op: 'successor' });
const W_D = Object.freeze([16, 20, 24, 28, 32]);
const W_D_SMOKE = Object.freeze([16, 32]);
const W_PM = Object.freeze([32]);
const N_ALL = Object.freeze([64, 4096, 65536]);
const N_SMOKE = Object.freeze([64, 4096]);
const K_FULL = 15;
const Q_FULL = 1 << 14;
const Q_SMOKE = 256;
const WARM_FULL = 3;
const WARM_SMOKE = 1;
const TARGET_MS = 10;
const SIZE_MIN_MS = 2;
const SIM_CYCLES = 3;
const PAGE_BITS = 8;
const GC_SETTLE_MS = 50;
const GC_RETAIN = 1 << 20;
const BUSY_PCPU = 10;
const PLAN_VERSION = 1;
// R0 U6 sized maxLarge per (w, n_eff) (u6-best.log 6c1ffc7f GROUP lines; RoaringDraft.best == best-paged):
// the large-pool pin. A sized maxLarge above R0's + LARGE_SLACK means the container mix moved off R0's
// (e.g. chunks parked in large slots because the small pool was sized first) -> exit 1. The pin bounds
// maxLarge only; it cannot see a chunk parked by a too-small maxSmall (R0_SMALL + the census do).
const R0_LARGE = Object.freeze({
    '16:64': 1, '16:4096': 1, '16:16384': 1, '20:64': 1, '20:4096': 16, '20:65536': 16,
    '24:64': 1, '24:4096': 1, '24:65536': 256, '28:64': 1, '28:4096': 1, '28:65536': 1,
    '32:64': 1, '32:4096': 1, '32:65536': 1,
});
const LARGE_SLACK = 1;
// R0 U6 sized maxSmall per (w, n_eff) (same GROUP lines, RoaringDraft.best == best-paged; SPEC A16): the
// small-pool floor. sizeLayout sets maxSmall := max(searched, R0_SMALL[w:n_eff]); a missing key -> exit 1.
const R0_SMALL = Object.freeze({
    '16:64': 1, '16:4096': 1, '16:16384': 1, '20:64': 16, '20:4096': 16, '20:65536': 16,
    '24:64': 10, '24:4096': 256, '24:65536': 256, '28:64': 1, '28:4096': 1109, '28:65536': 4096,
    '32:64': 1, '32:4096': 462, '32:65536': 14908,
});
// the census: a large-slot chunk (kind 2 array, 3 bitmap, 4 runs) with <= PARK_MAX keys is PARKED
const PARK_MAX = 64;
// instances per group (RETENTION census): SB + SB-AA + the RoaringSet column(s); SB-x2 reuses SB
const PER_GROUP = Object.freeze({ D: 3, P: 3, M: 4 });

class RoarFail extends Error {}

// ---------------------------------------------------------------- CLI (fail closed, did-you-mean)
function lev(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[a.length][b.length];
}
function nearest(x, list) {
    let best = list[0], bd = Infinity;
    for (const c of list) { const v = lev(x, c); if (v < bd) { bd = v; best = c; } }
    return best;
}

/**
 * Parse the CLI. Public flags: --smoke, --json <path>. Internal (parent -> child): --child <D|P|M>
 * --plan <path>, together and alone. Throws an Error (RoarFail) on any unknown / repeated flag (with a
 * did-you-mean hint), a missing value, or a bad combination; never ignores a token.
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{ smoke: boolean, json: string|null, child: 'D'|'P'|'M'|null, plan: string|null }}
 */
export function parseArgs(argv) {
    if (!Array.isArray(argv)) throw new TypeError(PFX + 'parseArgs: argv must be an array');
    const o = { smoke: false, json: null, child: null, plan: null };
    const seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (typeof a !== 'string') throw new RoarFail('argument ' + i + ' is not a string');
        if (!FLAGS.includes(a)) {
            throw new RoarFail('unknown flag ' + JSON.stringify(a) + ' (did you mean ' + nearest(a, FLAGS) + '?)');
        }
        if (seen.has(a)) throw new RoarFail('flag ' + a + ' given twice');
        seen.add(a);
        if (a === '--smoke') { o.smoke = true; continue; }
        const v = argv[++i];
        if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) throw new RoarFail(a + ' needs a value');
        if (a === '--json') o.json = v;
        else if (a === '--plan') o.plan = v;
        else {
            if (!LAYOUTS.includes(v)) throw new RoarFail('--child takes D, P or M; got ' + JSON.stringify(v));
            o.child = v;
        }
    }
    if (o.child !== null) {
        if (o.plan === null) throw new RoarFail('--child needs --plan (internal: the parent passes both)');
        if (o.smoke || o.json !== null) throw new RoarFail('--child takes only --plan (smoke comes from the plan)');
    } else if (o.plan !== null) {
        throw new RoarFail('--plan is internal (parent -> child) and needs --child');
    }
    return o;
}

// ---------------------------------------------------------------- statistics (cold, pure)
/**
 * Linear-interpolation quantile of an ascending-sorted array (R0 timing-harness quant). Empty, or p not a
 * number in [0, 1] -> NaN.
 * @param {ArrayLike<number>} sorted
 * @param {number} p in [0, 1]
 */
export function quant(sorted, p) {
    const n = sorted.length;
    if (!(n > 0) || typeof p !== 'number' || !(p >= 0 && p <= 1)) return NaN;
    if (n === 1) return sorted[0];
    const h = (n - 1) * p, i = Math.floor(h);
    return i + 1 < n ? sorted[i] + (h - i) * (sorted[i + 1] - sorted[i]) : sorted[i];
}

/**
 * Median and IQR of an array-like (copied, sorted ascending; the input is not modified). Any entry that is
 * not a finite number -> all three NaN (fail closed).
 * @param {ArrayLike<number>} arr
 * @returns {{ med: number, q1: number, q3: number }}
 */
export function summarize(arr) {
    const s = Array.from(arr);
    for (let i = 0; i < s.length; i++) if (typeof s[i] !== 'number' || !Number.isFinite(s[i])) return { med: NaN, q1: NaN, q3: NaN };
    s.sort((a, b) => a - b);
    return { med: quant(s, 0.5), q1: quant(s, 0.25), q3: quant(s, 0.75) };
}

// a number is a one-round vector; any non-finite entry or an empty vector fails closed (NaN median)
function ratioMedian(r) {
    if (typeof r === 'number') return Number.isFinite(r) ? r : NaN;
    if (r === null || typeof r !== 'object' || typeof r.length !== 'number' || !(r.length > 0)) return NaN;
    for (let i = 0; i < r.length; i++) if (typeof r[i] !== 'number' || !Number.isFinite(r[i])) return NaN;
    return summarize(r).med;
}

/**
 * A/A control classifier: the median of the SB-AA / SB ratio vector (or one ratio) lies in [0.9, 1.1].
 * NaN / non-finite / empty -> false (fail closed).
 * @param {ArrayLike<number>|number} ratios
 */
export function controlOk(ratios) {
    const m = ratioMedian(ratios);
    return m >= CTRL_LO && m <= CTRL_HI;
}

/**
 * x2 control classifier: the median of the SB-x2 / SB ratio vector (or one ratio) lies in [1.6, 2.4].
 * NaN / non-finite / empty -> false (fail closed).
 * @param {ArrayLike<number>|number} ratios
 */
export function x2Ok(ratios) {
    const m = ratioMedian(ratios);
    return m >= X2_LO && m <= X2_HI;
}

/**
 * Teeth: controlOk passes a flat A/A vector (+-0.02) and flags a 1.25x step, a 0.8x step and NaN;
 * x2Ok passes 2.0 and flags 1.0 and 1.5. Any miss -> false (the CLI exits 1, "no teeth").
 */
export function controlSelfCheck() {
    const flat = new Float64Array(15).map((_, i) => 1 + ((i % 3) - 1) * 0.02);
    const up = new Float64Array(15).map((_, i) => (i < 4 ? 1 : 1.25));
    const down = new Float64Array(15).map((_, i) => (i < 4 ? 1 : 0.8));
    const nan = new Float64Array(15).fill(NaN);
    const two = new Float64Array(15).map((_, i) => 2 + ((i % 3) - 1) * 0.04);
    const one = new Float64Array(15).fill(1);
    const half = new Float64Array(15).fill(1.5);
    return controlOk(flat) && !controlOk(up) && !controlOk(down) && !controlOk(nan) &&
        x2Ok(two) && !x2Ok(one) && !x2Ok(half) && !x2Ok(nan);
}

/**
 * Per-op digest (the u6-digest.mjs rule): over CONCLUSIVE cells only (SB-AA ratioMedian in [0.9, 1.1]),
 * each column's LOWER median (s[(len - 1) >> 1]) of its cell ratioMedian vs SB; SB / SB-AA are not
 * columns of the digest; a column whose ratioMedian is not a finite number > 0 is skipped (ops: null prototype). `cells` per op = the largest
 * per-column count (u6-digest's "(cells)"); `cells` total = their sum.
 * @param {{ cells: Array<{ op: string, columns: Array<{ label: string, ratioMedian: number }> }> }} j
 * @returns {{ labels: string[], order: string[], ops: Object<string, { cells: number,
 *   count: Object<string, number>, med: Object<string, number> }>, cells: number, excluded: number }}
 */
export function digest(j) {
    if (j === null || typeof j !== 'object' || !Array.isArray(j.cells)) {
        throw new TypeError(PFX + 'digest: input must be an object with a cells array');
    }
    const by = new Map();
    const labels = [];
    let excluded = 0;
    for (const c of j.cells) {
        if (c === null || typeof c !== 'object' || typeof c.op !== 'string' || !Array.isArray(c.columns)) {
            throw new TypeError(PFX + 'digest: every cell needs an op string and a columns array');
        }
        const aa = c.columns.find((x) => x.label === 'SB-AA');
        if (!(aa !== undefined && controlOk(aa.ratioMedian))) { excluded++; continue; }
        if (!by.has(c.op)) by.set(c.op, new Map());
        const m = by.get(c.op);
        for (const col of c.columns) {
            if (col.label === 'SB' || col.label === 'SB-AA') continue;
            if (typeof col.ratioMedian !== 'number' || !Number.isFinite(col.ratioMedian) || !(col.ratioMedian > 0)) continue;
            if (!labels.includes(col.label)) labels.push(col.label);
            if (!m.has(col.label)) m.set(col.label, []);
            m.get(col.label).push(col.ratioMedian);
        }
    }
    const ops = Object.create(null);
    const order = [];
    let total = 0;
    for (const [op, m] of by) {
        const rec = { cells: 0, count: {}, med: {} };
        for (const [lab, arr] of m) {
            const s = arr.slice().sort((x, y) => x - y);
            rec.count[lab] = s.length;
            rec.med[lab] = s[(s.length - 1) >> 1];
            if (s.length > rec.cells) rec.cells = s.length;
        }
        ops[op] = rec;
        order.push(op);
        total += rec.cells;
    }
    return { labels, order, ops, cells: total, excluded };
}

// ---------------------------------------------------------------- seeded shapes (cold, pure)
function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function cellSeed(w, n, salt) { return (Math.imul(w * 0x10001 + 0x5230, 0x9E3779B1) ^ Math.imul(n, 0x85EBCA6B) ^ salt) >>> 0; }

// n distinct keys < L in random generation order; `avoid` (a Set) excluded
function genDistinct(n, L, seed, avoid) {
    if (!(n <= L - (avoid === null ? 0 : avoid.size))) throw new RangeError(PFX + 'cannot draw ' + n + ' distinct keys in a span of ' + L);
    const rnd = mulberry32(seed);
    const seen = new Set();
    const out = new Uint32Array(n);
    let have = 0;
    while (have < n) {
        const x = Math.floor(rnd() * L);
        if (seen.has(x) || (avoid !== null && avoid.has(x))) continue;
        seen.add(x);
        out[have++] = x;
    }
    return out;
}
function lowerGt(sk, x) { let lo = 0, hi = sk.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (sk[m] <= x) lo = m + 1; else hi = m; } return lo; }
function lowerGe(sk, x) { let lo = 0, hi = sk.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (sk[m] < x) lo = m + 1; else hi = m; } return lo; }
function foldSucc(sk, q, Q) { let a = 0; for (let i = 0; i < Q; i++) { const j = lowerGt(sk, q[i]); a = (a + (j < sk.length ? sk[j] : 1)) | 0; } return a; }
function foldPred(sk, q, Q) { let a = 0; for (let i = 0; i < Q; i++) { const j = lowerGe(sk, q[i]) - 1; a = (a + (j >= 0 ? sk[j] : 1)) | 0; } return a; }

/**
 * The R0 U6 low-lane shape (byte-identical keys, queries and toggle schedule for the same (w, n, Q)):
 * U = 2^w, L = min(U, 2^30), n_eff = min(n0, U / 4) distinct seeded keys < L in generation order; qHas
 * (even slots a member, odd slots uniform < L), qSucc / qPred uniform < L; the toggle B = clamp(n_eff / 4,
 * 16, 256), M = B floor(min(n_eff, 4096) / B), DEL = V ++ F, ADD = F ++ V (F: M fresh non-members). The
 * oracle folds come from the sorted keys `sk` (the sorted-array oracle); successorHit / predecessorHit
 * fold the strict successor / predecessor over qHas (half of it members: a non-strict foil differs).
 * @param {number} w integer in [4, 32]
 * @param {number} n0 integer in [1, 2^24]
 * @param {number} Q integer in [1, 2^20]
 */
export function makeShape(w, n0, Q) {
    if (!Number.isInteger(w) || w < 4 || w > 32) throw new RangeError(PFX + 'makeShape: w must be an integer in [4, 32]');
    if (!Number.isInteger(n0) || n0 < 1 || n0 > (1 << 24)) throw new RangeError(PFX + 'makeShape: n must be an integer in [1, 2^24]');
    if (!Number.isInteger(Q) || Q < 1 || Q > (1 << 20)) throw new RangeError(PFX + 'makeShape: Q must be an integer in [1, 2^20]');
    const U = 2 ** w;
    const L = U < KEY_CAP ? U : KEY_CAP;
    const n = Math.min(n0, Math.floor(U / 4));
    const seed = cellSeed(w, n, 0x0000A001);
    const keys = genDistinct(n, L, seed, null);
    const sk = keys.slice().sort();
    const kset = new Set(keys);
    const rq = mulberry32(cellSeed(w, n, 0x0000A002));
    const qHas = new Uint32Array(Q);
    for (let i = 0; i < Q; i++) qHas[i] = (i & 1) === 0 ? keys[Math.floor(rq() * n)] : Math.floor(rq() * L);
    const qSucc = new Uint32Array(Q);
    for (let i = 0; i < Q; i++) qSucc[i] = Math.floor(rq() * L);
    const qPred = new Uint32Array(Q);
    for (let i = 0; i < Q; i++) qPred[i] = Math.floor(rq() * L);
    let B = n >>> 2;
    if (B < 16) B = 16;
    if (B > 256) B = 256;
    const mCap = n < 4096 ? n : 4096;
    const M = B * Math.floor(mCap / B);
    if (!(M >= B)) throw new RangeError(PFX + 'makeShape: w=' + w + ' n=' + n + ': the toggle needs n_eff >= ' + B + ' (M ' + M + ')');
    const F = genDistinct(M, L, cellSeed(w, n, 0x0000A003), kset);
    const DEL = new Uint32Array(2 * M);
    const ADD = new Uint32Array(2 * M);
    for (let i = 0; i < M; i++) { DEL[i] = keys[i]; DEL[M + i] = F[i]; ADD[i] = F[i]; ADD[M + i] = keys[i]; }
    let fHas = 0;
    for (let i = 0; i < Q; i++) if (kset.has(qHas[i])) fHas = (fHas + 1) | 0;
    const oracle = {
        has: fHas,
        successor: foldSucc(sk, qSucc, Q),
        predecessor: foldPred(sk, qPred, Q),
        min: Math.imul(sk[0], Q) | 0,
        max: Math.imul(sk[n - 1], Q) | 0,
        successorHit: foldSucc(sk, qHas, Q),
        predecessorHit: foldPred(sk, qHas, Q),
    };
    return { w, U, L, n, seed, keys, sk, qHas, qSucc, qPred, B, M, bpc: (2 * M) / B, DEL, ADD, oracle };
}

// ---------------------------------------------------------------- runners (one fresh Function per cell x column)
const FAM = Object.freeze({
    std: Object.freeze({
        has: 'if (s.has(q[i])) a = (a + 1) | 0;',
        successor: 'const v = s.successor(q[i]); a = (a + (v === undefined ? 1 : v)) | 0;',
        predecessor: 'const v = s.predecessor(q[i]); a = (a + (v === undefined ? 1 : v)) | 0;',
        min: 'const v = s.min(); a = (a + (v === undefined ? 1 : v)) | 0;',
        max: 'const v = s.max(); a = (a + (v === undefined ? 1 : v)) | 0;',
        del: 'if (s.delete(del[b + i])) a = (a + 1) | 0;',
        ins: 's.add(ins[b + i]);',
    }),
    // the x2 control: SB.successor done twice per query (folds to twice the single fold)
    x2: Object.freeze({
        successor: 'const v = s.successor(q[i]); const u = s.successor(q[i]); ' +
            'a = (a + (v === undefined ? 1 : v) + (u === undefined ? 1 : u)) | 0;',
    }),
});

/**
 * A fresh runner (its own SharedFunctionInfo and feedback). Query ops: fn(s, q, len, reps) -> int32 fold
 * (absent -> 1). add / delete: fn(s, del, ins, B, bpc, cycles, tm) runs `cycles` toggle cycles (batch j
 * deletes del[jB, jB + B) then adds ins[jB, jB + B)), accumulates the timed half (add: the add loop,
 * delete: the delete loop) in tm[0] (ms) and returns the count of deletes that hit. Family 'std' has
 * every op; 'x2' only successor (null for the rest). Unknown family / op or a tag with a line break throws.
 * @param {'std'|'x2'} fam
 * @param {string} op
 * @param {string} tag a one-line comment placed in the body (names the cell x column)
 * @returns {Function|null}
 */
export function makeRunner(fam, op, tag) {
    if (typeof fam !== 'string' || !Object.hasOwn(FAM, fam)) {
        throw new RangeError(PFX + 'makeRunner: unknown family ' + JSON.stringify(fam) + ' (std, x2)');
    }
    if (typeof op !== 'string' || !OPS.includes(op)) {
        throw new RangeError(PFX + 'makeRunner: unknown op ' + JSON.stringify(op) + ' (' + OPS.join(', ') + ')');
    }
    if (typeof tag !== 'string' || /[\r\n\u2028\u2029]/.test(tag)) {
        throw new TypeError(PFX + 'makeRunner: tag must be a one-line string');
    }
    const F = FAM[fam];
    const head = '"use strict";\n// ' + tag + '\nlet a = 0;\n';
    if (op === 'add' || op === 'delete') {
        if (F.del === undefined || F.ins === undefined) return null;
        const timedDel = op === 'delete';
        const body = head +
            'for (let c = 0; c < cycles; c++) {\n' +
            '  for (let j = 0; j < bpc; j++) {\n' +
            '    const b = j * B;\n' +
            (timedDel ? '    const t = performance.now();\n' : '') +
            '    for (let i = 0; i < B; i++) { ' + F.del + ' }\n' +
            (timedDel ? '    tm[0] += performance.now() - t;\n' : '    const t = performance.now();\n') +
            '    for (let i = 0; i < B; i++) { ' + F.ins + ' }\n' +
            (timedDel ? '' : '    tm[0] += performance.now() - t;\n') +
            '  }\n}\nreturn a;\n';
        return new Function('s', 'del', 'ins', 'B', 'bpc', 'cycles', 'tm', body);
    }
    const stmt = F[op];
    if (stmt === undefined) return null;
    const body = head + 'for (let r = 0; r < reps; r++) {\n  for (let i = 0; i < len; i++) { ' + stmt + ' }\n}\nreturn a;\n';
    return new Function('s', 'q', 'len', 'reps', body);
}
function makeClockRunner(tag) {
    return new Function('tm', 'n', '"use strict";\n// ' + tag + '\nfor (let i = 0; i < n; i++) { const t = performance.now(); tm[0] += performance.now() - t; }\n');
}

// ---------------------------------------------------------------- shared cold helpers
const LIB_URL = new URL('../LogLogN.js', import.meta.url);
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));

function sha8(path) { return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8); }
function f2(x) { return x.toFixed(2); }
function f3(x) { return x.toFixed(3); }
function say(s) { process.stdout.write(s + '\n'); }
function settle(ms) { return new Promise((r) => { setTimeout(r, ms); }); }
function isPoolErr(e) { return e instanceof RangeError && /pool/i.test(e.message); }

function cellList(smoke) {
    const g = { D: [], P: [], M: [] };
    for (const L of LAYOUTS) {
        const ws = L === 'D' ? (smoke ? W_D_SMOKE : W_D) : W_PM;
        for (const w of ws) {
            const seen = [];
            for (const n0 of (smoke ? N_SMOKE : N_ALL)) {
                const n = Math.min(n0, Math.floor(2 ** w / 4));
                if (seen.includes(n)) continue;
                seen.push(n);
                g[L].push({ w, n0, n });
            }
        }
    }
    return g;
}

// ---------------------------------------------------------------- parent: pool sizing (public API only)
// build + SIM_CYCLES toggle cycles on a fresh instance; null on a pool-exhaustion RangeError (or a
// constructor RangeError); else the instance (the caller reads .paged)
function roarTrial(RS, sh, mS, mL, mP) {
    let s;
    try {
        s = mP === 0 ? new RS(sh.U, mS, mL) : new RS(sh.U, mS, mL, mP);
    } catch (e) {
        if (e instanceof RangeError) return null;
        throw e;
    }
    try {
        for (let i = 0; i < sh.n; i++) s.add(sh.keys[i]);
        for (let c = 0; c < SIM_CYCLES; c++) {
            for (let j = 0; j < sh.bpc; j++) {
                const b = j * sh.B;
                for (let i = 0; i < sh.B; i++) s.delete(sh.DEL[b + i]);
                for (let i = 0; i < sh.B; i++) s.add(sh.ADD[b + i]);
            }
        }
    } catch (e) {
        if (isPoolErr(e)) return null;
        throw e;
    }
    if (s.size !== sh.n) throw new RoarFail('pool sizing w=' + sh.w + ' n=' + sh.n + ': size ' + s.size + ' != ' + sh.n + ' after the toggle cycles');
    return s;
}
function bsearch(lo, hi, ok) {
    while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (ok(m)) hi = m; else lo = m + 1; }
    return lo;
}
// smallest pools (maxPages first, then maxLarge, then maxSmall) that survive build + 3 cycles. maxLarge is
// searched while maxSmall is still generous (the small-first order sizes a container mix R0 never measured,
// review r1). The SEARCHED maxSmall is only the minimum that survives: at it _promoteSingle can still find the
// small pool empty and park a 2..64-key chunk in a large slot (review r2), so maxSmall is raised to R0's
// sized maxSmall for the group (R0_SMALL, SPEC A16; a missing key throws) and parkedCensus() checks the result.
function sizeLayout(RS, sh, paged) {
    const span = Math.ceil(sh.L / 65536);
    let mS = Math.min(65535, span);
    let mL = Math.min(65534, span, Math.floor(sh.n / 65) + 8);
    let mP = paged ? Math.ceil(span / (1 << PAGE_BITS)) : 0;
    for (;;) {
        if (roarTrial(RS, sh, mS, mL, mP) !== null) break;
        if (mL >= Math.min(65534, span)) {
            throw new RoarFail('pool sizing w=' + sh.w + ' n=' + sh.n + (paged ? ' paged' : ' direct') + ': exhausted even at maxSmall ' +
                mS + ' maxLarge ' + mL + (paged ? ' maxPages ' + mP : ''));
        }
        mL = Math.min(65534, span, mL * 2);
    }
    if (paged) mP = bsearch(1, mP, (m) => roarTrial(RS, sh, mS, mL, m) !== null);
    mL = bsearch(1, mL, (m) => roarTrial(RS, sh, mS, m, mP) !== null);
    mS = bsearch(0, mS, (m) => roarTrial(RS, sh, m, mL, mP) !== null);
    const r0s = R0_SMALL[sh.w + ':' + sh.n];
    if (typeof r0s !== 'number') {
        throw new RoarFail('pool sizing w=' + sh.w + ' n=' + sh.n + ': no R0_SMALL entry for ' + sh.w + ':' + sh.n + ' (fail closed, no default)');
    }
    if (r0s > mS) mS = r0s;
    const s = roarTrial(RS, sh, mS, mL, mP);
    if (s === null) throw new RoarFail('pool sizing w=' + sh.w + ' n=' + sh.n + ': re-verify failed at maxSmall ' + mS + ' maxLarge ' + mL + ' maxPages ' + mP);
    if (s.paged !== paged) {
        throw new RoarFail('pool sizing w=' + sh.w + ' n=' + sh.n + ': the sized set has paged ' + s.paged + ', want ' + paged +
            ' (' + (paged ? 'P shapes must be paged' : 'D shapes must be direct') + ')');
    }
    return paged ? { maxSmall: mS, maxLarge: mL, maxPages: mP, paged: true } : { maxSmall: mS, maxLarge: mL, paged: false };
}
// PARKED-CHUNK CENSUS (SPEC A16; cold, parent, before any child): a fresh set at the sized pools, read after
// the build -- the state the has cell times; later cells run after add / delete toggle cycles (review r3 probe:
// 0 park events over 64 cycles in 24/24 pools). Reads the internal `_kind` / `_card` tables read-only (count =
// _card + 1, checked: the counts over live rows sum to size). Unknown kind = FAIL. Returns { parked, small, large }:
// parked = large-slot chunks (kinds 2 / 3 / 4) of <= PARK_MAX keys; kinds 0 / 6 / 7 hold no slot.
function parkedCensus(RS, sh, p) {
    const s = p.paged ? new RS(sh.U, p.maxSmall, p.maxLarge, p.maxPages) : new RS(sh.U, p.maxSmall, p.maxLarge);
    for (let i = 0; i < sh.n; i++) s.add(sh.keys[i]);
    const k = s._kind, c = s._card;
    if (!(k instanceof Uint8Array) || !(c instanceof Uint16Array) || k.length !== c.length) {
        throw new RoarFail('parked-chunk census w=' + sh.w + ' n=' + sh.n + ': RoaringSet has no _kind / _card tables (fail closed)');
    }
    let parked = 0, small = 0, large = 0, sum = 0;
    for (let m = 0; m < k.length; m++) {
        const t = k[m];
        if (t !== 0) sum += c[m] + 1;
        if (t === 1 || t === 5) small++;
        else if (t === 2 || t === 3 || t === 4) { large++; if (c[m] + 1 <= PARK_MAX) parked++; }
        else if (t !== 0 && t !== 6 && t !== 7) throw new RoarFail('parked-chunk census w=' + sh.w + ' n=' + sh.n + ': unknown container kind ' + t + ' at row ' + m + ' (fail closed)');
    }
    if (sum !== s.size) throw new RoarFail('parked-chunk census w=' + sh.w + ' n=' + sh.n + ': sum(_card + 1) ' + sum + ' != size ' + s.size + ' (fail closed)');
    return { parked, small, large };
}
function poolStr(p) {
    return 'maxSmall ' + p.maxSmall + ' maxLarge ' + p.maxLarge + (p.paged ? ' maxPages ' + p.maxPages + ' pb ' + PAGE_BITS : '') +
        ' (paged ' + p.paged + ')';
}

function gitHead() {
    try {
        const h = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PKG_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const d = execFileSync('git', ['status', '--porcelain', '--', 'LogLogN.js'], { cwd: PKG_DIR, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return h + (d.length > 0 ? ' (LogLogN.js modified vs HEAD)' : ' (LogLogN.js clean vs HEAD)');
    } catch {
        return 'unknown (git failed)';
    }
}
function busyNode() {
    try {
        const out = execFileSync('ps', ['-A', '-o', 'pid=,pcpu=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const hits = [];
        for (const line of out.split('\n')) {
            const m = /^\s*(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
            if (m === null) continue;
            const pid = Number(m[1]), pc = Number(m[2]);
            const comm = m[3].trim().split('/').pop();
            if (comm !== 'node' || pid === process.pid || !(pc >= BUSY_PCPU)) continue;
            hits.push('pid ' + pid + ' ' + pc.toFixed(1) + '%');
        }
        return hits.length === 0 ? 'none' : hits.join(', ');
    } catch {
        return 'unknown (ps failed)';
    }
}

// ---------------------------------------------------------------- parent
async function parentMain(o) {
    const t0wall = performance.now();
    const SMOKE = o.smoke;
    const lib = await import(LIB_URL.href);
    if (typeof lib.RoaringSet !== 'function' || typeof lib.StratifiedBitset !== 'function') {
        throw new RoarFail('LogLogN.js must export RoaringSet and StratifiedBitset (RoaringSet ' + typeof lib.RoaringSet + ')');
    }
    if (!controlSelfCheck()) throw new RoarFail('control classifier has no teeth (flat / step / NaN / x2 self-check)');
    const RS = lib.RoaringSet;
    const K = SMOKE ? 1 : K_FULL;
    const W = SMOKE ? WARM_SMOKE : WARM_FULL;
    const Q = SMOKE ? Q_SMOKE : Q_FULL;
    const loadStart = os.loadavg()[0];
    const busyStart = busyNode();
    const qlHost = process.env.QUIET_LOCK_HOST;
    const label = qlHost === 'quiet' ? 'QUIET' : 'PRELIMINARY';
    const cpus = os.cpus();
    const scriptPath = fileURLToPath(import.meta.url);
    const libPath = fileURLToPath(LIB_URL);
    const G = cellList(SMOKE);
    const cellsWant = { D: G.D.length * OPS.length, P: G.P.length * OPS.length, M: G.M.length * OPS.length };
    const cellsAll = cellsWant.D + cellsWant.P + cellsWant.M;
    const prov = {
        date: new Date().toISOString(), host: os.hostname(), node: process.version, v8: process.versions.v8,
        platform: process.platform + '/' + process.arch, cpu: cpus.length > 0 ? cpus[0].model : 'unknown', cpus: cpus.length,
        load1Start: loadStart, load1End: NaN, busyNodeStart: busyStart, busyNodeEnd: '', quietLock: qlHost === undefined ? null : qlHost,
        label, gitHead: gitHead(), libSha8: sha8(libPath), scriptSha8: sha8(scriptPath), execArgv: process.execArgv.slice(),
        command: process.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '),
    };

    say('lite-loglogn witness:roar -- RoaringSet ' + (SMOKE ? 'SMOKE (wiring only: no timing number is printed)' : 'FULL') +
        ' -- REPORTED tier (C-14: no exit code gates a release)');
    say('provenance: date ' + prov.date + ' | host ' + prov.host + ' | node ' + prov.node + ' | v8 ' + prov.v8 + ' | ' + prov.platform +
        ' | cpus ' + prov.cpus + ' (' + prov.cpu + ')');
    say('provenance: load1 start ' + f2(loadStart) + ' | busy node (>= ' + BUSY_PCPU + '% cpu, not this pid) ' + busyStart +
        ' | quiet-lock ' + (qlHost !== undefined ? qlHost + ' (' + (process.env.QUIET_LOCK_WHY || '') + ')' : 'not set (not run under quiet-lock)') +
        ' -> label ' + label);
    say('provenance: git HEAD ' + prov.gitHead + ' | sha256/8 LogLogN.js ' + prov.libSha8 + ' witness-roar.mjs ' + prov.scriptSha8 +
        ' | execArgv [' + prov.execArgv.join(' ') + ']');
    say('provenance: command ' + prov.command);
    say('provenance: K ' + K + ' rounds (interleaved, rotated) | warm-up ' + W + ' | Q ' + Q + ' | ' +
        (SMOKE ? 'reps 1' : 'target ' + TARGET_MS + ' ms per run') + ' | keys and queries < min(U, 2^30) | control SB-AA / SB median in [' +
        CTRL_LO + ', ' + CTRL_HI + '] | x2 control SB-x2 / SB at w=' + X2_CELL.w + ' n=' + X2_CELL.n + ' ' + X2_CELL.op + ' in [' + X2_LO + ', ' + X2_HI + ']');
    say('provenance: children D w [' + (SMOKE ? W_D_SMOKE : W_D).join(', ') + '] / P w [' + W_PM.join(', ') + '] / M w [' + W_PM.join(', ') +
        '] | n [' + (SMOKE ? N_SMOKE : N_ALL).join(', ') + '] (n_eff = min(n, U/4)) | ops [' + OPS.join(', ') + '] | cells D ' +
        cellsWant.D + ' / P ' + cellsWant.P + ' / M ' + cellsWant.M);
    say('CONTROL classifier self-check: flat A/A passes; 1.25x step, 0.8x step and NaN are flagged; x2 passes 2.0, flags 1.0 and 1.5 -- ok');

    // pool sizing (public API only), cold
    const plan = { version: PLAN_VERSION, smoke: SMOKE, K, W, Q, parentPid: process.pid, groups: { D: [], P: [], M: [] }, out: {} };
    const sized = new Map();
    const pinFails = [];
    const parkFails = [];
    let parkedPools = 0;
    const sizeOf = (w, n0, paged) => {
        const key = w + ':' + n0 + ':' + paged;
        if (!sized.has(key)) sized.set(key, sizeLayout(RS, makeShape(w, n0, Q), paged));
        return sized.get(key);
    };
    for (const L of LAYOUTS) {
        for (const g of G[L]) {
            const sh = makeShape(g.w, g.n0, Q);
            const pools = {};
            if (L === 'D') pools['RS-D'] = sizeOf(g.w, g.n0, false);
            if (L === 'P') pools['RS-P'] = sizeOf(g.w, g.n0, true);
            if (L === 'M') { pools['mix-D'] = sizeOf(g.w, g.n0, false); pools['mix-P'] = sizeOf(g.w, g.n0, true); }
            plan.groups[L].push({ w: g.w, n0: g.n0, n: sh.n, seed: sh.seed, pools });
            const r0 = R0_LARGE[g.w + ':' + sh.n];
            let pinOk = typeof r0 === 'number';
            for (const k of Object.keys(pools)) if (!(pools[k].maxLarge <= r0 + LARGE_SLACK)) pinOk = false;
            const cen = {};
            let parkOk = true;
            for (const k of Object.keys(pools)) {
                cen[k] = parkedCensus(RS, sh, pools[k]);
                parkedPools++;
                if (cen[k].parked !== 0) {
                    parkOk = false;
                    parkFails.push(L + ' w=' + g.w + ' n=' + sh.n + ' ' + k + ': ' + cen[k].parked + ' large-slot chunk(s) of <= ' + PARK_MAX + ' keys');
                }
            }
            say('POOLS ' + L + ' w=' + g.w + ' n=' + sh.n + ' | ' + Object.keys(pools).map((k) => k + ' ' + poolStr(pools[k])).join(' | ') +
                ' | retry search over build + ' + SIM_CYCLES + ' toggle cycles | R0 maxLarge ' + (typeof r0 === 'number' ? r0 : 'none') +
                ' (pin <= R0 + ' + LARGE_SLACK + '), R0 maxSmall ' + R0_SMALL[g.w + ':' + sh.n] + ' (floor) | census ' +
                Object.keys(pools).map((k) => k + ' small ' + cen[k].small + ' large ' + cen[k].large + ' parked ' + cen[k].parked).join(', ') +
                ' -- ' + (pinOk && parkOk ? 'ok' : 'FAIL'));
            if (!pinOk) pinFails.push(L + ' w=' + g.w + ' n=' + sh.n + ': maxLarge ' + Object.keys(pools).map((k) => k + ' ' + pools[k].maxLarge).join(', ') +
                ' vs R0 ' + (typeof r0 === 'number' ? r0 : 'none') + ' + ' + LARGE_SLACK + ' (the container mix moved off R0)');
        }
    }

    if (pinFails.length > 0) throw new RoarFail('pool sizing: R0 large-pool pin: ' + pinFails.join('; '));
    say('CENSUS parked chunks: ' + parkFails.length + ' pool(s) of ' + parkedPools + ' with a large-slot chunk of <= ' + PARK_MAX + ' keys -- ' +
        (parkFails.length === 0 ? 'ok' : 'FAIL'));
    if (parkFails.length > 0) throw new RoarFail('parked-chunk census (before any timing): ' + parkFails.join('; '));
    const dir = mkdtempSync(join(os.tmpdir(), 'witness-roar-'));
    const fails = [];
    const res = {};
    try {
        for (const L of LAYOUTS) plan.out[L] = join(dir, 'child-' + L + '.json');
        const planPath = join(dir, 'plan.json');
        writeFileSync(planPath, JSON.stringify(plan) + '\n');
        say('plan: ' + planPath + ' (removed at exit) | children run in sequence: ' + process.execPath + ' [' + process.execArgv.join(' ') + ']');
        for (const L of LAYOUTS) {
            const r = spawnSync(process.execPath, [...process.execArgv, scriptPath, '--child', L, '--plan', planPath],
                { stdio: ['ignore', 'inherit', 'inherit'] });
            let out = null;
            try {
                out = JSON.parse(readFileSync(plan.out[L], 'utf8'));
            } catch {
                out = null;
            }
            if (r.status !== 0 || out === null || out.layout !== L) {
                fails.push('child ' + L + ': exit ' + r.status + (r.signal ? ' signal ' + r.signal : '') + (out === null ? ', no result JSON' : ''));
            }
            res[L] = out;
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    // aggregate (cold)
    const allCells = [];
    let windows = 0, gcMajor = 0, abWorst = 0, inconclusive = 0, ctlOk = 0, foilOk = 0;
    let isoDPaged = -1, isoPDirect = -1, shared = -1, isoWrong = 0, groups = 0, tracked = 0, collected = 0, retErr = 0, worst = 0;
    const trackedBy = { D: 0, P: 0, M: 0 };
    const cellsBy = { D: 0, P: 0, M: 0 };
    let x2 = null;
    for (const L of LAYOUTS) {
        const r = res[L];
        if (r === null || r === undefined) continue;
        for (const f of r.fails) fails.push('child ' + L + ': ' + f);
        for (const c of r.cells) allCells.push(c);
        cellsBy[L] = r.cells.length;
        windows += r.gc.windows;
        if (r.gc.major > gcMajor) gcMajor = r.gc.major;
        if (r.gc.growth > abWorst) abWorst = r.gc.growth;
        if (r.gc.controlsOk === true) ctlOk++;
        if (r.foilFlagged === true) foilOk++;
        if (!Number.isInteger(r.inconclusive) || r.inconclusive < 0) fails.push('child ' + L + ': malformed result (inconclusive ' + String(r.inconclusive) + ')'); else inconclusive += r.inconclusive;
        groups += r.ret.groups;
        tracked += r.ret.tracked;
        trackedBy[L] = r.ret.tracked;
        collected += r.ret.collected;
        retErr += r.ret.errors;
        if (r.ret.worst > worst) worst = r.ret.worst;
        isoWrong += r.iso.wrong.length;
        if (L === 'D') { isoDPaged = r.iso.paged; if (r.x2 !== null) x2 = r.x2; }
        if (L === 'P') isoPDirect = r.iso.direct;
        if (L === 'M') shared = r.iso.shared;
    }
    const groupsWant = G.D.length + G.P.length + G.M.length;
    const trackedWant = { D: G.D.length * PER_GROUP.D, P: G.P.length * PER_GROUP.P, M: G.M.length * PER_GROUP.M };
    const trWant = trackedWant.D + trackedWant.P + trackedWant.M;

    const cellsOk = cellsBy.D === cellsWant.D && cellsBy.P === cellsWant.P && cellsBy.M === cellsWant.M;
    say('SUMMARY cells D ' + cellsBy.D + ' / P ' + cellsBy.P + ' / M ' + cellsBy.M + ' (want ' + cellsWant.D + ' / ' + cellsWant.P + ' / ' +
        cellsWant.M + ')' + (SMOKE ? '' : ' | INCONCLUSIVE ' + inconclusive + ' (exit 2 when > ' + Math.floor(cellsAll / 4) + ')') +
        (cellsOk ? '' : ' -- FAIL'));
    if (!cellsOk) fails.push('cells D ' + cellsBy.D + ' / P ' + cellsBy.P + ' / M ' + cellsBy.M + ' != ' + cellsWant.D + ' / ' + cellsWant.P + ' / ' + cellsWant.M);
    const isoOk = isoDPaged === 0 && isoPDirect === 0 && shared === cellsWant.M && isoWrong === 0;
    say('ISOLATION: D paged instances ' + isoDPaged + ', P direct instances ' + isoPDirect + ', mixed shared runners ' + shared + '/' +
        cellsWant.M + (isoWrong === 0 ? '' : ', child census misses ' + isoWrong) + ' -- ' + (isoOk ? 'ok' : 'FAIL'));
    if (!isoOk) fails.push('isolation: D paged ' + isoDPaged + ' (want 0), P direct ' + isoPDirect + ' (want 0), mixed shared ' + shared + '/' + cellsWant.M + ', child census misses ' + isoWrong);
    const gcOk = windows === cellsAll && gcMajor === 0 && abWorst <= 0 && ctlOk === LAYOUTS.length;
    say('GC windows ' + windows + '/' + cellsAll + ', major ' + gcMajor + ', arrayBuffers +' + abWorst + ' B | controls ' + ctlOk + '/' +
        LAYOUTS.length + ' children -- ' + (gcOk ? 'ok' : 'FAIL'));
    if (!gcOk) fails.push('gc: windows ' + windows + '/' + cellsAll + ', major ' + gcMajor + ', arrayBuffers +' + abWorst + ' B, controls ' + ctlOk + '/' + LAYOUTS.length);
    const retOk = groups === groupsWant && tracked === trWant && trackedBy.D === trackedWant.D && trackedBy.P === trackedWant.P &&
        trackedBy.M === trackedWant.M && collected === tracked && retErr === 0 && worst === 0;
    say('RETENTION: groups ' + groups + '/' + groupsWant + ', instances tracked ' + tracked + ' (D ' + trackedBy.D + ' / P ' + trackedBy.P +
        ' / M ' + trackedBy.M + '), collected ' + collected + ', errors ' + retErr + ', worst tracker.size() ' + worst + ' -- ' + (retOk ? 'ok' : 'FAIL'));
    if (!retOk) fails.push('retention: groups ' + groups + '/' + groupsWant + ', tracked ' + tracked + '/' + trWant + ', collected ' + collected + ', worst ' + worst);
    const foilAll = foilOk === LAYOUTS.length;
    say('CONTROL pre-pass: the non-strict successor foil flagged in ' + foilOk + '/' + LAYOUTS.length + ' children -- ' + (foilAll ? 'ok' : 'FAIL'));
    if (!foilAll) fails.push('pre-pass foil flagged in ' + foilOk + '/' + LAYOUTS.length + ' children (no teeth)');

    let dg = null;
    let x2Unjudged = false;
    if (!SMOKE) {
        if (x2 === null) {
            fails.push('x2 control: no x2 cell result from child D');
        } else if (x2.control === true) {
            say('CONTROL x2 w=' + X2_CELL.w + ' n=' + X2_CELL.n + ' ' + X2_CELL.op + ': SB-x2 / SB median x' + f3(x2.med) + ' [' + f3(x2.q1) + ', ' +
                f3(x2.q3) + '] in [' + X2_LO + ', ' + X2_HI + '] -- ' + (x2.ok ? 'ok' : 'FAIL (the harness cannot resolve a 2x step)'));
            if (!x2.ok) fails.push('x2 control: median ' + x2.med + ' not in [' + X2_LO + ', ' + X2_HI + ']');
        } else if (x2.control === false) {
            say('CONTROL x2 w=' + X2_CELL.w + ' n=' + X2_CELL.n + ' ' + X2_CELL.op + ': the cell is INCONCLUSIVE (SB-AA drift) -- unjudged: the run is INCONCLUSIVE (exit 2)');
            x2Unjudged = true;
        } else {
            fails.push('x2 control: malformed child D result (control ' + String(x2.control) + ', want true / false)');
        }
        dg = digest({ cells: allCells });
        const dg32 = digest({ cells: allCells.filter((c) => c.w === 32) });
        say('DIGEST per op: LOWER median over CONCLUSIVE cells of the cell median ratio vs SB (< 1 = faster than SB); REPORTED, ' + label);
        for (const op of OPS) {
            const r = dg.ops[op];
            const r32 = dg32.ops[op];
            const part = (lab) => lab + ' ' + (r !== undefined && r.med[lab] !== undefined ? 'x' + f2(r.med[lab]) + ' (' + r.count[lab] + ' cells)' : 'n/a');
            const mm = (mix, mono) => (r32 !== undefined && r32.med[mix] !== undefined && r32.med[mono] !== undefined ?
                f3(r32.med[mix] / r32.med[mono]) + ' (w 32: ' + r32.count[mix] + ' / ' + r32.count[mono] + ' cells)' : 'n/a');
            say('DIGEST ' + op + ' | ' + ['RS-D', 'RS-P', 'mix-D', 'mix-P'].map(part).join(' | ') + ' | mixed / mono D ' + mm('mix-D', 'RS-D') +
                ' P ' + mm('mix-P', 'RS-P'));
        }
    }
    const loadEnd = os.loadavg()[0];
    prov.load1End = loadEnd;
    prov.busyNodeEnd = busyNode();
    let exit = fails.length > 0 ? 1 : (!SMOKE && (inconclusive * 4 > cellsAll || x2Unjudged) ? 2 : 0);
    for (const f of fails) say('FAIL ' + f);
    say('provenance: load1 end ' + f2(loadEnd) + ' | busy node end ' + prov.busyNodeEnd);
    if (SMOKE) {
        say('WITNESS-ROAR SMOKE ' + (exit === 0 ? 'ok' : 'not ok') + ': ' + cellsAll + ' cells constructed, pre-passed and executed once | exit ' + exit);
    } else {
        say('FOOTER total wall ' + f2((performance.now() - t0wall) / 1000) + ' s | label ' + label + ' | exit ' + exit);
    }
    if (o.json !== null) {
        try {
            writeFileSync(o.json, JSON.stringify({ tool: 'witness:roar', smoke: SMOKE, K, warmup: W, Q, targetMs: TARGET_MS, provenance: prov,
                plan: { groups: plan.groups }, cells: allCells, digest: dg, x2, x2Unjudged, inconclusive, fails, exit }, null, 1) + '\n');
        } catch (e) {
            say('FAIL --json ' + o.json + ': ' + (e && e.message ? e.message : String(e)));
            exit = 1;
        }
    }
    return exit;
}

// ---------------------------------------------------------------- child: GC-window kit (test/witness.mjs, cold)
// GC window: gcFn() + settle, then fn inside ONE GcProfiler window with process.memoryUsage().arrayBuffers
// read before fn and after the closing settle. Tolerance ZERO: gc.major <= 0, arrayBuffers growth <= 0 B
// (the window body allocates no ArrayBuffer and writes no stdout). NaN / unobserved fails closed.
const GCK = { GcProfiler: null, gcFn: null };
const GKEEP = [];
const GCC = new Int32Array(1);

async function gcWindow(fn) {
    const GcProfiler = GCK.GcProfiler;
    const gcFn = GCK.gcFn;
    if (typeof GcProfiler !== 'function' || typeof gcFn !== 'function') throw new RoarFail('gc window: the kit is not armed');
    gcFn();
    await settle(GC_SETTLE_MS);
    const g = new GcProfiler().start();
    const ab0 = process.memoryUsage().arrayBuffers;
    fn();
    await settle(GC_SETTLE_MS);
    const ab1 = process.memoryUsage().arrayBuffers;
    const s = g.summary();
    g.stop();
    const w = { observed: s.gc.observed === true, major: s.gc.major, minor: s.gc.minor, growth: ab1 - ab0, majorBad: true, abBad: true };
    w.majorBad = !w.observed || !Number.isInteger(w.major) || !(w.major <= 0);
    w.abBad = !Number.isFinite(w.growth) || !(w.growth <= 0);
    return w;
}
function gcs(w) { return 'major ' + w.major + ' growth ' + w.growth + ' B'; }

// must-fail controls: an empty window is clean; retaining a fresh 1 MB ArrayBuffer flips ONLY
// arrayBuffers; a forced full gc() flips ONLY gc.major. Coverage floor: 3 steps ran.
async function gcControls(P) {
    const gcFn = GCK.gcFn;
    GCC[0] = 0;
    GKEEP.length = 0;
    const wE = await gcWindow(() => { GCC[0]++; });
    const wR = await gcWindow(() => { GCC[0]++; GKEEP.push(new ArrayBuffer(GC_RETAIN)); });
    const wK = await gcWindow(() => { GCC[0]++; gcFn(); });
    const keptB = GKEEP.length === 1 ? GKEEP[0].byteLength : -1;
    GKEEP.length = 0;
    const bad = [];
    if (GCC[0] !== 3 || keptB !== GC_RETAIN) bad.push('coverage: steps ' + GCC[0] + ' / 3, kept ' + keptB + ' B');
    if (wE.majorBad || wE.abBad) bad.push('empty window not clean (' + gcs(wE) + ')');
    if (!wR.abBad || !(wR.growth > 0)) bad.push('retain did not flip arrayBuffers (' + gcs(wR) + ')');
    if (wR.majorBad) bad.push('retain flipped gc.major (' + gcs(wR) + ')');
    if (!wK.majorBad || !(wK.observed && wK.major > 0)) bad.push('forced gc() did not flip gc.major (' + gcs(wK) + ')');
    if (wK.abBad) bad.push('forced gc() flipped arrayBuffers (' + gcs(wK) + ')');
    if (bad.length > 0) {
        say(P + 'FAIL control gc-window: ' + bad.join('; '));
        return false;
    }
    say(P + 'CONTROL gc-window: empty ' + gcs(wE) + ' clean; retained ' + keptB + ' B ArrayBuffer ' + gcs(wR) +
        ' flips arrayBuffers only; forced gc() ' + gcs(wK) + ' flips gc.major only -- ok');
    return true;
}

// ---------------------------------------------------------------- child
function noop() {}

// the columns one layout builds per group (SB-x2 is a second runner on SB at the x2 cell only)
function buildGroup(L, lib, sh, pools, census, tracker) {
    const add = (obj) => { for (let i = 0; i < sh.n; i++) obj.add(sh.keys[i]); return obj; };
    const rs = (label, wantPaged) => {
        const p = pools[label];
        if (p === undefined) throw new RoarFail('plan: group w=' + sh.w + ' n=' + sh.n + ' has no pools for ' + label);
        const s = p.paged ? new lib.RoaringSet(sh.U, p.maxSmall, p.maxLarge, p.maxPages) : new lib.RoaringSet(sh.U, p.maxSmall, p.maxLarge);
        if (s.paged) census.paged++; else census.direct++;
        if (s.paged !== wantPaged) census.wrong.push(label + ' w=' + sh.w + ' n=' + sh.n + ' paged ' + s.paged);
        return add(s);
    };
    const cols = [
        { label: 'SB', obj: add(new lib.StratifiedBitset(sh.U)) },
        { label: 'SB-AA', obj: add(new lib.StratifiedBitset(sh.U)) },
    ];
    if (L === 'D') cols.push({ label: 'RS-D', obj: rs('RS-D', false) });
    if (L === 'P') cols.push({ label: 'RS-P', obj: rs('RS-P', true) });
    if (L === 'M') { cols.push({ label: 'mix-D', obj: rs('mix-D', false) }); cols.push({ label: 'mix-P', obj: rs('mix-P', true) }); }
    for (const c of cols) tracker.track(c.obj, noop, 'roar-' + L + '-' + c.label, { audit: true });
    return cols;
}

// cold folds for the member-hitting pre-pass (and the foil): the same function flags the foil
function hitFold(obj, op, q, Q) {
    let a = 0;
    for (let i = 0; i < Q; i++) { const v = op === 'successor' ? obj.successor(q[i]) : obj.predecessor(q[i]); a = (a + (v === undefined ? 1 : v)) | 0; }
    return a;
}
function hitCheck(obj, sh, Q) {
    return hitFold(obj, 'successor', sh.qHas, Q) === sh.oracle.successorHit && hitFold(obj, 'predecessor', sh.qHas, Q) === sh.oracle.predecessorHit;
}
// a NON-STRICT successor (>= x) and a correct predecessor over the sorted keys: hitCheck MUST flag it
function makeFoil(sk) {
    return {
        successor(x) { const j = lowerGe(sk, x); return j < sk.length ? sk[j] : undefined; },
        predecessor(x) { const j = lowerGe(sk, x) - 1; return j >= 0 ? sk[j] : undefined; },
    };
}

// one group: build, pre-pass, every op cell (K rounds in a GC window). Returns plain data only, so
// the group's instances die with this frame (RETENTION).
async function runGroup(L, lib, plan, g, ctx, tracker) {
    const P = ctx.P;
    const SMOKE = plan.smoke;
    const K = plan.K, W = plan.W, Q = plan.Q;
    const sh = makeShape(g.w, g.n0, Q);
    if (sh.seed !== g.seed || sh.n !== g.n) throw new RoarFail('plan: group w=' + g.w + ' n=' + g.n + ' seed / n mismatch vs makeShape');
    const t0 = tracker.size();
    const cols0 = buildGroup(L, lib, sh, g.pools, ctx.census, tracker);
    const tracked = tracker.size() - t0;
    const tagBase = L + ' w' + sh.w + ' n' + sh.n;
    for (const c of cols0) {
        if (c.obj.size !== sh.n || !hitCheck(c.obj, sh, Q)) {
            throw new RoarFail('pre-pass ' + tagBase + ' ' + c.label + ': size ' + c.obj.size + ' or member-hit successor / predecessor fold != sorted-array oracle');
        }
    }
    say(P + 'GROUP w=' + sh.w + ' n=' + sh.n + (sh.n !== g.n0 ? ' (n ' + g.n0 + ' capped at U/4)' : '') + ' | keys < ' +
        (sh.L === sh.U ? 'U' : '2^30') + ' | seed 0x' + sh.seed.toString(16).padStart(8, '0') + ' | toggle B ' + sh.B + ' M ' + sh.M +
        ' batches/cycle ' + sh.bpc + ' | ' + cols0.map((c) => c.label).join(', ') + ' built, member-hit pre-pass ok | tracked ' + tracked);
    const recs = [];
    const TM = ctx.TM, TT = ctx.TT, OUT = ctx.OUT, SINK = ctx.SINK;
    const ovh = ctx.ovh;
    for (const op of OPS) {
        const toggle = op === 'add' || op === 'delete';
        const q = op === 'has' ? sh.qHas : op === 'successor' ? sh.qSucc : sh.qPred;
        const isX2 = L === 'D' && sh.w === X2_CELL.w && sh.n === X2_CELL.n && op === X2_CELL.op;
        const cols = [];
        let mixFn = null;
        for (const c of cols0) {
            let fn;
            if (L === 'M' && (c.label === 'mix-D' || c.label === 'mix-P')) {
                if (mixFn === null) mixFn = makeRunner('std', op, tagBase + ' ' + op + ' mix (shared: mix-D + mix-P)');
                fn = mixFn;
            } else {
                fn = makeRunner('std', op, tagBase + ' ' + op + ' ' + c.label);
            }
            cols.push({ label: c.label, obj: c.obj, fn, reps: 1, x2: false });
        }
        if (isX2) cols.push({ label: 'SB-x2', obj: cols0[0].obj, fn: makeRunner('x2', op, tagBase + ' ' + op + ' SB-x2'), reps: 1, x2: true });
        const C = cols.length;
        // ISOLATION census: M's mix pair shares one runner; every other column owns its runner
        const fset = new Set(cols.map((c) => c.fn));
        if (L === 'M') {
            const cD = cols.find((c) => c.label === 'mix-D'), cP = cols.find((c) => c.label === 'mix-P');
            if (cD !== undefined && cP !== undefined && cD.fn === cP.fn) ctx.census.shared++;
            if (fset.size !== C - 1) ctx.census.wrong.push('runners ' + tagBase + ' ' + op + ': ' + fset.size + ' distinct for ' + C + ' columns (want ' + (C - 1) + ')');
        } else if (fset.size !== C) {
            ctx.census.wrong.push('runners ' + tagBase + ' ' + op + ': ' + fset.size + ' distinct for ' + C + ' columns (want ' + C + ')');
        }
        const run = (c, reps) => {
            if (toggle) {
                TM[0] = 0;
                TT[0] = performance.now();
                SINK[0] = (SINK[0] + c.fn(c.obj, sh.DEL, sh.ADD, sh.B, sh.bpc, reps, TM)) | 0;
                TT[1] = performance.now();
                OUT[0] = (TM[0] - ovh * reps * sh.bpc) * 1e6 / (reps * sh.bpc * sh.B);
            } else {
                TT[0] = performance.now();
                SINK[0] = (SINK[0] + c.fn(c.obj, q, Q, reps)) | 0;
                TT[1] = performance.now();
                OUT[0] = (TT[1] - TT[0]) * 1e6 / (reps * Q);
            }
            OUT[1] = TT[1] - TT[0];
        };
        // cold pre-pass: fold == sorted-array oracle (x2: twice it); toggle: every delete hits, size and membership restored
        for (const c of cols) {
            if (toggle) {
                TM[0] = 0;
                const got = c.fn(c.obj, sh.DEL, sh.ADD, sh.B, sh.bpc, 1, TM);
                let h = 0;
                for (let i = 0; i < Q; i++) if (c.obj.has(sh.qHas[i])) h++;
                if (got !== 2 * sh.M) throw new RoarFail('pre-pass ' + tagBase + ' ' + op + ' ' + c.label + ': ' + got + ' of ' + 2 * sh.M + ' toggle deletes hit');
                if (c.obj.size !== sh.n || h !== sh.oracle.has) throw new RoarFail('pre-pass ' + tagBase + ' ' + op + ' ' + c.label + ': the toggle cycle did not restore the set (size ' + c.obj.size + ')');
            } else {
                const got = c.fn(c.obj, q, Q, 1);
                const want = c.x2 ? (sh.oracle[op] * 2) | 0 : sh.oracle[op];
                if (got !== want) throw new RoarFail('pre-pass ' + tagBase + ' ' + op + ' ' + c.label + ': fold ' + got + ' != oracle ' + want);
            }
        }
        for (let i = 0; i < W; i++) for (let j = 0; j < C; j++) run(cols[(j + i) % C], 1);
        if (!SMOKE) {
            for (const c of cols) {
                let reps = 1;
                run(c, reps);
                while (OUT[1] < SIZE_MIN_MS && reps < (1 << 24)) { reps *= 2; run(c, reps); }
                let r2 = Math.round(reps * TARGET_MS / (OUT[1] > 0 ? OUT[1] : 1e-3));
                if (r2 < 1) r2 = 1;
                c.reps = r2;
            }
        }
        const NS = new Float64Array(K * C);
        const gw = await gcWindow(() => {
            for (let r = 0; r < K; r++) {
                for (let j = 0; j < C; j++) {
                    const ci = (j + r) % C;
                    run(cols[ci], cols[ci].reps);
                    NS[r * C + ci] = OUT[0];
                }
            }
        });
        ctx.gc.windows++;
        if (gw.major > ctx.gc.major || gw.majorBad) ctx.gc.major = Math.max(ctx.gc.major, Number.isInteger(gw.major) ? gw.major : 1);
        if (gw.growth > ctx.gc.growth || gw.abBad) ctx.gc.growth = Math.max(ctx.gc.growth, Number.isFinite(gw.growth) ? gw.growth : 1);
        const cellName = 'w=' + sh.w + ' n=' + sh.n + ' op=' + op;
        if (gw.majorBad || gw.abBad) ctx.fails.push('gc window ' + cellName + ': ' + gcs(gw) + ' (observed ' + gw.observed + ')');
        for (const c of cols) {
            if (c.obj.size !== sh.n) throw new RoarFail('post-check ' + tagBase + ' ' + op + ' ' + c.label + ': size ' + c.obj.size + ' != ' + sh.n);
        }
        const gwTxt = 'gc window major ' + gw.major + ' arrayBuffers ' + (gw.growth > 0 ? '+' : '') + gw.growth + ' B' + (gw.majorBad || gw.abBad ? ' FAIL' : '');
        if (SMOKE) {
            say(P + 'CELL ' + cellName + ' | ' + cols.map((c) => c.label + ' ok').join(' | ') + ' | ' + gwTxt + ' | smoke ok');
            recs.push({ layout: L, w: sh.w, n: sh.n, op, smoke: true, columns: cols.map((c) => ({ label: c.label })) });
            continue;
        }
        const rec = { layout: L, w: sh.w, n: sh.n, op, K, columns: [], control: null, verdict: null };
        const parts = [];
        const ratio = new Float64Array(K);
        const nsArr = new Float64Array(K);
        let ctrl = false;
        for (let ci = 0; ci < C; ci++) {
            const c = cols[ci];
            for (let r = 0; r < K; r++) { nsArr[r] = NS[r * C + ci]; ratio[r] = NS[r * C + ci] / NS[r * C]; }
            const sn = summarize(nsArr);
            const sr = summarize(ratio);
            rec.columns.push({ label: c.label, reps: c.reps, nsMedian: sn.med, ratioMedian: sr.med, ratioQ1: sr.q1, ratioQ3: sr.q3, ns: Array.from(nsArr) });
            if (ci === 0) parts.push(c.label + ' ' + f2(sn.med) + ' ns (ref, reps ' + c.reps + ')');
            else parts.push(c.label + ' ' + f2(sn.med) + ' ns x' + f3(sr.med) + ' [' + f3(sr.q1) + ', ' + f3(sr.q3) + ']');
            if (c.label === 'SB-AA') ctrl = controlOk(ratio);
            if (c.x2) ctx.x2 = { ratios: Array.from(ratio), med: sr.med, q1: sr.q1, q3: sr.q3, ok: x2Ok(ratio), control: false };
        }
        if (isX2 && ctx.x2 !== null) ctx.x2.control = ctrl;
        rec.control = ctrl ? 'ok' : 'DRIFT';
        rec.verdict = ctrl ? 'REPORTED' : 'INCONCLUSIVE';
        if (!ctrl) ctx.inconclusive++;
        recs.push(rec);
        say(P + 'CELL ' + cellName + ' | ' + parts.join(' | ') + ' | CONTROL ' + (ctrl ? 'ok' : 'DRIFT -> INCONCLUSIVE') + ' | ' + gwTxt);
    }
    return { recs, tracked };
}

async function childMain(o) {
    const L = o.child;
    const P = '[' + L + '] ';
    const plan = JSON.parse(readFileSync(o.plan, 'utf8'));
    if (plan === null || typeof plan !== 'object' || plan.version !== PLAN_VERSION || plan.groups === undefined ||
        !Array.isArray(plan.groups[L]) || plan.groups[L].length === 0 || typeof plan.out !== 'object' || typeof plan.out[L] !== 'string' ||
        !Number.isInteger(plan.K) || !Number.isInteger(plan.W) || !Number.isInteger(plan.Q)) {
        throw new RoarFail('child ' + L + ': the plan JSON is malformed or has no groups for this layout');
    }
    const [lib, gp, lk, v8, vm] = await Promise.all([import(LIB_URL.href), import('@zakkster/lite-gc-profiler'),
        import('@zakkster/lite-leak'), import('node:v8'), import('node:vm')]);
    if (typeof lib.RoaringSet !== 'function' || typeof lib.StratifiedBitset !== 'function') {
        throw new RoarFail('child ' + L + ': LogLogN.js must export RoaringSet and StratifiedBitset');
    }
    let gcFn = globalThis.gc;
    if (typeof gcFn !== 'function') {
        v8.setFlagsFromString('--expose-gc');
        gcFn = vm.runInNewContext('gc');
    }
    if (typeof gp.GcProfiler !== 'function' || typeof gcFn !== 'function' || typeof lk.createLeakTracker !== 'function') {
        throw new RoarFail('child ' + L + ': lite-gc-profiler GcProfiler, lite-leak createLeakTracker and a gc() function are required');
    }
    GCK.GcProfiler = gp.GcProfiler;
    GCK.gcFn = gcFn;
    if (!controlSelfCheck()) throw new RoarFail('child ' + L + ': control classifier has no teeth');
    const SMOKE = plan.smoke === true;
    const out = { layout: L, pid: process.pid, cells: [], fails: [], inconclusive: 0, foilFlagged: false, x2: null,
        gc: { windows: 0, major: 0, growth: 0, controlsOk: false },
        iso: { direct: 0, paged: 0, shared: 0, wrong: [] }, ret: { groups: 0, tracked: 0, collected: 0, errors: 0, worst: 0 } };
    const ctx = {
        P, census: { direct: 0, paged: 0, shared: 0, wrong: [] }, gc: out.gc, fails: out.fails, inconclusive: 0, x2: null,
        TM: new Float64Array(1), TT: new Float64Array(2), OUT: new Float64Array(2), SINK: new Int32Array(1), ovh: 0,
    };
    say(P + 'child pid ' + process.pid + ' (parent ' + plan.parentPid + ') | layout ' + L + ' (' +
        (L === 'D' ? 'direct RoaringSet only' : L === 'P' ? 'paged RoaringSet only' : 'mixed: one runner per op on a direct AND a paged set') +
        ') | groups ' + plan.groups[L].length + ' | K ' + plan.K + ' Q ' + plan.Q + (SMOKE ? ' reps 1 (smoke: no timing number printed)' : ''));
    if (plan.parentPid === process.pid) out.fails.push('isolation: the child runs in the parent process');
    out.gc.controlsOk = await gcControls(P);
    if (!out.gc.controlsOk) out.fails.push('gc-window controls');

    // the pre-pass foil: a non-strict successor over the sorted keys MUST be flagged by hitCheck
    const fsh = makeShape(16, 4096, plan.Q);
    out.foilFlagged = !hitCheck(makeFoil(fsh.sk), fsh, plan.Q);
    say(P + 'CONTROL pre-pass: a non-strict successor foil over the sorted keys (w=16 n=4096) is ' +
        (out.foilFlagged ? 'flagged -- ok' : 'NOT flagged -- FAIL (the pre-pass has no teeth)'));
    if (!out.foilFlagged) out.fails.push('pre-pass foil not flagged');

    if (!SMOKE) {
        const fn = makeClockRunner('clock ' + L);
        for (let i = 0; i < 3; i++) { ctx.TM[0] = 0; fn(ctx.TM, 100000); }
        ctx.TM[0] = 0;
        fn(ctx.TM, 200000);
        ctx.ovh = ctx.TM[0] / 200000;
        say(P + 'provenance: empty clock bracket ' + f2(ctx.ovh * 1e6) + ' ns (subtracted per toggle batch)');
    }

    for (const g of plan.groups[L]) {
        const tracker = lk.createLeakTracker({
            name: 'witness-roar-' + L + '-w' + g.w + '-n' + g.n,
            onLeak: () => { out.ret.collected++; },
            onError: () => { out.ret.errors++; },
        });
        const r = await runGroup(L, lib, plan, g, ctx, tracker);
        for (const c of r.recs) out.cells.push(c);
        out.ret.tracked += r.tracked;
        if (r.tracked !== PER_GROUP[L]) out.fails.push('retention: group w=' + g.w + ' n=' + g.n + ' tracked ' + r.tracked + ' (want ' + PER_GROUP[L] + ')');
        let live = tracker.size();
        for (let k = 0; k < 20 && live > 0; k++) {
            gcFn();
            await settle(25);
            live = tracker.size();
        }
        if (live > out.ret.worst) out.ret.worst = live;
        out.ret.groups++;
        say(P + 'RETENTION group w=' + g.w + ' n=' + g.n + ': tracked ' + r.tracked + ', tracker.size() ' + live + ' after drop + gc + settle -- ' + (live === 0 ? 'ok' : 'FAIL'));
    }
    out.inconclusive = ctx.inconclusive;
    out.x2 = ctx.x2;
    out.iso.direct = ctx.census.direct;
    out.iso.paged = ctx.census.paged;
    out.iso.shared = ctx.census.shared;
    out.iso.wrong = ctx.census.wrong;
    for (const w of ctx.census.wrong) out.fails.push('isolation: ' + w);
    const cellsWant = plan.groups[L].length * OPS.length;
    if (L === 'M' && out.iso.shared !== cellsWant) out.fails.push('isolation: mixed shared runners ' + out.iso.shared + '/' + cellsWant);
    if (L === 'D' && out.iso.paged !== 0) out.fails.push('isolation: D built ' + out.iso.paged + ' paged instance(s)');
    if (L === 'P' && out.iso.direct !== 0) out.fails.push('isolation: P built ' + out.iso.direct + ' direct instance(s)');
    if (L === 'D' && !SMOKE && out.x2 === null) out.fails.push('x2 control: the x2 cell did not run');
    say(P + 'ISOLATION ' + L + ': RoaringSet instances direct ' + out.iso.direct + ' paged ' + out.iso.paged +
        (L === 'M' ? ' | mixed shared runners ' + out.iso.shared + '/' + cellsWant : '') + ' | wrong ' + out.iso.wrong.length +
        ' -- ' + (out.iso.wrong.length === 0 ? 'ok' : 'FAIL'));
    say(P + 'child done: cells ' + out.cells.length + '/' + cellsWant + ' | GC windows ' + out.gc.windows + ' | sink ' + (ctx.SINK[0] >>> 0).toString(16) +
        ' | ' + (out.fails.length === 0 ? 'ok' : out.fails.length + ' FAIL'));
    writeFileSync(plan.out[L], JSON.stringify(out) + '\n');
    return out.fails.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- entry (no side effects on import)
// realpath the entry: a symlinked path (macOS /tmp -> /private/tmp) must still run main()
function isEntry() {
    if (typeof process.argv[1] !== 'string') return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
        return false;
    }
}

function failOut(e) {
    say(e instanceof RoarFail ? PFX + 'FAIL ' + e.message : PFX + 'uncaught ' + (e && e.stack ? e.stack : String(e)));
    return 1;
}

if (isEntry()) {
    let o = null;
    try {
        o = parseArgs(process.argv.slice(2));
    } catch (e) {
        process.exitCode = failOut(e);
    }
    if (o !== null) {
        (o.child !== null ? childMain(o) : parentMain(o)).then(
            (c) => { process.exitCode = c; },
            (e) => { process.exitCode = failOut(e); });
    }
}
