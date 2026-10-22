/**
 * @zakkster/lite-loglogn -- the STATISTICAL witness harness (release time only).
 *
 *     node test/witness.mjs            FULL run (B-stat burst, under quiet-lock)
 *     node test/witness.mjs --smoke    wiring smoke, < ~5 s, never gates timing
 *     node test/witness.mjs --w32      also sweep w = 32 in the U-sweep lane
 *                                      (or env LOGLOGN_W32=1)
 *     node test/witness.mjs --tier     the A12 lane ONLY (BSTAT-SPEC.md): live
 *                                      LogLogN.js (B) vs B1a + 3 ` | 0` reads (A),
 *                                      4 walk scenarios; combinable with --smoke;
 *                                      --tier --w32 is exit 1 (not applicable)
 *
 * Every timed run goes through the shared-host lock:
 *     node ~/.claude/hooks/quiet-lock.mjs run "lite-loglogn witness" -- node test/witness.mjs
 *
 * Exit codes: 0 pass, 1 fail, 2 inconclusive (noisy host). Any uncaught error is
 * exit 1 (fail closed). An unknown flag is exit 1.
 *
 * What it witnesses (PLAN-stratifiedbitset A8, ADDENDUM 29-31; B2B-SPEC.md):
 *
 *   GATED n-sweep   n = 1e3 .. 1e7 at w = 28: member StratifiedBitset.successor
 *                   vs u32Successor (Uint32Array binary search, D4's strongest
 *                   baseline). K = 15 ABBA rounds of 2^16 seeded queries; a point
 *                   declares a winner only at >= 13 / 15 rounds (p = 0.0037
 *                   one-sided per point). Published K = the smallest n from which
 *                   the member wins at every n, or "none in range".
 *   U-sweep         n = 4096, w over witnessWidths(): member vs NaiveFlatBitset,
 *                   same rule. Fits vs log2(w) AND vs w are REPORTED only.
 *   control         NaiveFlatBitset as the candidate vs u32Successor at n = 1e3,
 *                   w = 28: it MUST lose, else the gate has no teeth (exit 1).
 *   A/A             member vs an independently built identical member, n = 4096,
 *                   w = 20: a declared winner means the host is noisy (exit 2).
 *   host drift      one A/A probe block per round of every point, in time order,
 *                   -> hostDrift (lite-adaptive Page-Hinkley); drift -> exit 2.
 *   load            max(start, end) os.loadavg()[0] > 0.5 x availableParallelism
 *                   -> exit 2.
 *   REPORTED foils  lite-logn SortedArray / Treap / SkipList, lite-o1 BitSet
 *                   (U <= 2^25 only) and EliasFano (static): median ns/op over K
 *                   rounds on the same query streams. Printed, never gated.
 *   LATENCY         per-op member successor latency into a preallocated
 *                   Float64Array, then lite-sketch DDSketch.addFrom (the unboxed
 *                   path): p50 / p99 / exact max. REPORTED.
 *
 * Startup controls (always, also in smoke): the drift detector must catch the
 * injected STEP vector and stay quiet on FLAT; the correctness pre-pass must flag
 * a deliberately wrong (non-strict) foil. Every foil at every built configuration
 * must answer the member's strict-successor query stream exactly (exit 1 names the
 * foil and the first x).
 *
 * The fit axis stays log2(w) (the universe BIT-WIDTH), never a copied log2(n):
 * conflating log log U with log log n is the dishonesty this family refuses.
 *
 * Importing this module has NO side effects: main() runs only when this file is
 * the entry script. The pure exports (witnessVerdict, hostDrift, witnessWidths,
 * fitLogLinear, NaiveFlatBitset, u32Successor) are gated DETERMINISTICALLY by
 * test/WitnessVerdict.test.js in npm test. This is an OFFLINE proof tool, never a
 * hot-path dependency.
 */

import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BitSet, EliasFano } from '@zakkster/lite-o1';
import { SortedArray, Treap, SkipList } from '@zakkster/lite-logn';
import { DDSketch } from '@zakkster/lite-sketch';
import { DriftDetector, DRIFT_PH } from '@zakkster/lite-adaptive';
import { StratifiedBitset } from '../LogLogN.js';
import { mulberry32, FNV_OFFSET, fnvWord, hex32 } from './helpers/tierStream.mjs';

// --- run constants ------------------------------------------------------------

/** Rounds per point (A8). */
export const WITNESS_K = 15;
/** Rounds needed to declare a winner at one point: 13 / 15, p = 0.0037 one-sided. */
export const WITNESS_NEED = 13;

/** U-sweep universe bit-widths (32 is opt-in via witnessWidths). */
export const WITNESS_W = Object.freeze([16, 20, 24, 28]);

/** GATED n-sweep element counts (w = 28). */
export const WITNESS_NS = Object.freeze([1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7]);

/**
 * Page-Hinkley magnitude allowance and decision level for hostDrift, on series
 * normalised by their median (so 1.0 = the median round). NOMINAL, calibrated
 * 2026-10-22 against the B2B-SPEC vectors (mulberry32(0xC0FFEE), 135 values,
 * step at i = 60), latch false. Largest threshold at which each vector still
 * fires, at delta 0.01 (the chosen threshold 2.0 must sit between the groups):
 *   no drift (must stay quiet): FLAT 3% 0.066, 5% noise 0.167, 10% noise 0.457,
 *     one 2x spike 0.960, one 3x spike 1.936;
 *   drift (must fire): STEP 1.25x 9.18 (fires at i = 71), STEP-DOWN 0.8x 11.02
 *     (i = 69), 1.15x 5.74 (i = 79), 1/1.15x 6.30, 1.10x 3.78 (i = 88).
 * Margin: 30x over FLAT, 12x over 5% noise, 4.6x under STEP, 2.9x under a 1.15x
 * step, 1.9x under a 1.10x step; a single 3x outlier round does not fire.
 */
export const DRIFT_DELTA = 0.01;
export const DRIFT_THRESHOLD = 2.0;

/**
 * hostDrift clamps each median-normalised value to [DRIFT_CLAMP_LO, DRIFT_CLAMP_HI]
 * before the detector (maintainer ruling R3b), so one outlier round moves the
 * Page-Hinkley statistic by at most 0.5. NOMINAL. Calibration vector SPIKES =
 * FLAT with v[30] = v[90] = 400 (ruling R5): unclamped it FIRES at i = 30 (largest
 * firing threshold 2.933), clamped it stays quiet (0.476), so SPIKES gates the
 * clamp. The clamp leaves FLAT / noise / STEP / STEP-DOWN margins above unchanged.
 */
export const DRIFT_CLAMP_LO = 2 / 3;
export const DRIFT_CLAMP_HI = 1.5;

const PFX = '[lite-loglogn] ';
const PV = PFX + 'witnessVerdict';
const PD = PFX + 'hostDrift';
const PT = PFX + 'tierVerdict';
const PA = PFX + 'tierASource';

// --- least-squares fit: y = intercept + slope * x -----------------------------
// x is the chosen axis (log2(w), or w for the impostor axis); y is nsPerOp.
// Returns { slope, intercept, r2 }. Pure; called once per sweep, cold.
export function fitLogLinear(xs, ys) {
    const n = xs.length;
    if (n < 2 || ys.length !== n) {
        throw new Error('[lite-loglogn] fitLogLinear needs >= 2 paired points');
    }
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = my - slope * mx;
    // R^2 = (explained variance) / (total variance); 1.0 = a perfect line.
    const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
    return { slope, intercept, r2 };
}

/**
 * The U-sweep widths for this run: a NEW array, WITNESS_W plus 32 appended iff
 * argv includes '--w32' or env.LOGLOGN_W32 is exactly the string '1'.
 * @param {string[]} argv @param {object} [env]
 */
export function witnessWidths(argv, env) {
    if (!Array.isArray(argv)) throw new TypeError(PFX + 'witnessWidths: argv must be an array');
    const out = WITNESS_W.slice();
    const e = env !== null && typeof env === 'object' ? env.LOGLOGN_W32 : undefined;
    if (argv.includes('--w32') || e === '1') out.push(32);
    return out;
}

// --- the reference O(log n) foils -----------------------------------------------

/** Kept from v0.1.0 (nothing depends on it): lower-bound index - 1. */
export function sortedArrayPredecessor(arr, len, key) {
    let lo = 0, hi = len;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < key) { lo = mid + 1; } else { hi = mid; }
    }
    // lo is the first index >= key; predecessor is lo - 1 (or absent).
    return lo - 1;
}

/**
 * The GATED n-sweep foil (D4): strict successor over the sorted prefix
 * arr[0..len) by upper-bound binary search. Returns the smallest arr[i] > x, or
 * -1 if none (-1 = absent).
 * @param {Uint32Array} arr @param {number} len @param {number} x
 */
export function u32Successor(arr, len, x) {
    let lo = 0, hi = len;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= x) { lo = mid + 1; } else { hi = mid; }
    }
    return lo < len ? arr[lo] : -1;
}

/**
 * The U-sweep foil and the must-fail candidate: a flat Uint32Array of
 * ceil(U/32) words, strict successor by a LINEAR word scan (O(U / 32) worst).
 */
export class NaiveFlatBitset {
    /** @param {number} universe integer in [1, 2^32] */
    constructor(universe) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 1 || universe > 4294967296) {
            throw new RangeError(PFX + 'NaiveFlatBitset universe must be an integer in [1, 2^32]');
        }
        this._u = universe;
        this._nw = Math.ceil(universe / 32);
        this._w = new Uint32Array(this._nw);
    }

    /** @param {number} x key in [0, U); throws RangeError otherwise */
    add(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) {
            throw new RangeError(PFX + 'NaiveFlatBitset key out of range');
        }
        this._w[x >>> 5] |= 1 << (x & 31);
        return this;
    }

    /** Smallest key > x, or undefined. @param {number} x */
    successor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        const i = x + 1;
        if (i >= this._u) return undefined;
        const w = this._w;
        const nw = this._nw;
        let p = i >>> 5;
        let v = w[p] & (-1 << (i & 31));
        while (v === 0) {
            p++;
            if (p >= nw) return undefined;
            v = w[p];
        }
        return ((p << 5) | (31 - Math.clz32(v & -v))) >>> 0;
    }
}

// --- witnessVerdict (pure) --------------------------------------------------------

// pv = the message prefix (PV for witnessVerdict, PT for tierVerdict)
function vObj(v, name, pv = PV) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw new TypeError(pv + ': ' + name + ' must be an object');
    }
}

function vInt(v, name, lo, hi, pv = PV) {
    if (typeof v !== 'number') throw new TypeError(pv + ': ' + name + ' must be a number');
    if (!Number.isInteger(v) || v < lo || v > hi) {
        throw new RangeError(pv + ': ' + name + ' must be an integer in [' + lo + ', ' + hi + ']');
    }
    return v;
}

function vTally(t, name, K, pv = PV) {
    vObj(t, name, pv);
    const wins = vInt(t.wins, name + '.wins', 0, K, pv);
    const losses = vInt(t.losses, name + '.losses', 0, K, pv);
    if (wins + losses > K) throw new RangeError(pv + ': ' + name + ' wins + losses > K');
    return { wins, losses };
}

function vSweep(arr, name, K, allowEmpty) {
    if (!Array.isArray(arr)) throw new TypeError(PV + ': ' + name + ' must be an array');
    if (!allowEmpty && arr.length === 0) throw new RangeError(PV + ': ' + name + ' must not be empty');
    const out = [];
    let prev = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        vObj(p, name + '[' + i + ']');
        const x = p.x;
        if (typeof x !== 'number') throw new TypeError(PV + ': ' + name + '[' + i + '].x must be a number');
        if (!Number.isFinite(x)) throw new RangeError(PV + ': ' + name + '[' + i + '].x must be finite');
        if (!(x > prev)) throw new RangeError(PV + ': ' + name + ' x must be strictly ascending');
        prev = x;
        const t = vTally(p, name + '[' + i + ']', K);
        out.push({ x, wins: t.wins, losses: t.losses });
    }
    return out;
}

function pointVerdict(t, need) {
    if (t.wins >= need) return 'win';
    if (t.losses >= need) return 'lose';
    return 'none';
}

// crossover: the x of the smallest i such that every point j >= i is 'win';
// null when the last point is not 'win'.
function crossoverOf(pts, verdicts) {
    let i = verdicts.length;
    while (i > 0 && verdicts[i - 1] === 'win') i--;
    return i === verdicts.length ? null : pts[i].x;
}

// the first 'lose' at an index after a 'win', or null
function nonMonotone(pts, verdicts) {
    let winX = null;
    for (let i = 0; i < verdicts.length; i++) {
        if (verdicts[i] === 'win') { if (winX === null) winX = pts[i].x; }
        else if (verdicts[i] === 'lose' && winX !== null) return { winX, loseX: pts[i].x };
    }
    return null;
}

/**
 * The pure verdict. Throws (TypeError / RangeError, '[lite-loglogn] witnessVerdict')
 * on any malformed input; never returns exit 0 on bad input.
 * @returns {{ exit: 0|1|2, reasons: string[],
 *   n: { verdicts: string[], crossover: number|null },
 *   u: { verdicts: string[], crossover: number|null } }}
 */
export function witnessVerdict(input) {
    vObj(input, 'input');
    const K = vInt(input.K, 'K', 1, Number.MAX_SAFE_INTEGER);
    const need = vInt(input.need, 'need', 1, Number.MAX_SAFE_INTEGER);
    if (!(need * 2 > K) || need > K) throw new RangeError(PV + ': need must satisfy K/2 < need <= K');
    const nPts = vSweep(input.nSweep, 'nSweep', K, false);
    const uPts = vSweep(input.uSweep, 'uSweep', K, true);
    const aa = vTally(input.aa, 'aa', K);
    const control = vTally(input.control, 'control', K);
    const drift = input.drift;
    if (typeof drift !== 'boolean') throw new TypeError(PV + ': drift must be a boolean');
    const load1 = input.load1;
    if (typeof load1 !== 'number') throw new TypeError(PV + ': load1 must be a number');
    if (!Number.isFinite(load1) || load1 < 0) throw new RangeError(PV + ': load1 must be finite and >= 0');
    const cores = vInt(input.cores, 'cores', 1, Number.MAX_SAFE_INTEGER);

    const nV = nPts.map((p) => pointVerdict(p, need));
    const uV = uPts.map((p) => pointVerdict(p, need));
    const reasons = [];
    let exit = 0;
    const hit = (code, why) => { reasons.push(why); if (exit === 0) exit = code; };

    if (load1 > 0.5 * cores) {
        hit(2, 'load: load1 ' + load1 + ' > 0.5 x ' + cores + ' cores (host busy; inconclusive)');
    }
    if (drift) hit(2, 'drift: host drift detected in the A/A probe series (inconclusive)');
    if (aa.wins >= need || aa.losses >= need) {
        hit(2, 'aa: the A/A control declared a winner (wins ' + aa.wins + ', losses ' +
            aa.losses + ' of K ' + K + ', need ' + need + '; inconclusive)');
    }
    if (control.losses < need) {
        hit(1, 'control: the naive candidate did not lose (losses ' + control.losses +
            ' < need ' + need + ' of K ' + K + ') -- the gate has no teeth');
    }
    const nm = nonMonotone(nPts, nV);
    if (nm !== null) {
        hit(2, 'monotone: n-sweep lose at x=' + nm.loseX + ' after win at x=' + nm.winX + ' (inconclusive)');
    }
    const um = nonMonotone(uPts, uV);
    if (um !== null) {
        hit(2, 'monotone: U-sweep lose at x=' + um.loseX + ' after win at x=' + um.winX + ' (inconclusive)');
    }
    return {
        exit,
        reasons,
        n: { verdicts: nV, crossover: crossoverOf(nPts, nV) },
        u: { verdicts: uV, crossover: uPts.length === 0 ? null : crossoverOf(uPts, uV) },
    };
}

// --- hostDrift (pure) ---------------------------------------------------------------

/**
 * Page-Hinkley drift over per-round A/A probe timings (ns/op), each normalised by
 * the series median and clamped to [DRIFT_CLAMP_LO, DRIFT_CLAMP_HI], fed in order
 * to a fresh DriftDetector(DRIFT_PH) with latch false. Throws '[lite-loglogn]
 * hostDrift' on a non-array, length < 8, or any value that is not a finite
 * number > 0.
 * @param {ArrayLike<number>} series
 * @returns {{ drift: boolean, index: number }}
 */
export function hostDrift(series) {
    const isArr = Array.isArray(series) ||
        (ArrayBuffer.isView(series) && !(series instanceof DataView));
    if (!isArr) throw new TypeError(PD + ': series must be an array or a typed array');
    const len = series.length;
    if (!(len >= 8)) throw new RangeError(PD + ': series needs >= 8 values, got ' + len);
    const buf = new Float64Array(len);
    for (let i = 0; i < len; i++) {
        const v = series[i];
        if (typeof v !== 'number') throw new TypeError(PD + ': series[' + i + '] must be a number');
        if (!(v > 0) || !Number.isFinite(v)) {
            throw new RangeError(PD + ': series[' + i + '] must be finite and > 0');
        }
        buf[i] = v;
    }
    const sorted = buf.slice().sort();
    const med = (len & 1) === 1 ? sorted[len >>> 1] : (sorted[len / 2 - 1] + sorted[len / 2]) / 2;
    for (let i = 0; i < len; i++) {
        const y = buf[i] / med;
        buf[i] = y < DRIFT_CLAMP_LO ? DRIFT_CLAMP_LO : y > DRIFT_CLAMP_HI ? DRIFT_CLAMP_HI : y;
    }
    const det = new DriftDetector(DRIFT_PH, { delta: DRIFT_DELTA, threshold: DRIFT_THRESHOLD, latch: false });
    for (let i = 0; i < len; i++) {
        if (det.addFrom(buf, i)) return { drift: true, index: i };
    }
    return { drift: false, index: -1 };
}

// --- the A12 tier lane: pure parts (BSTAT-SPEC.md) -------------------------------------

/** The four A12 scenarios, in verdict order (maintainer ruling: dense + sparse). */
export const TIER_SCENARIOS = Object.freeze(['dense-succ', 'sparse-succ', 'dense-pred', 'sparse-pred']);

/** The B1a commit the A side (foil) is built from, and its LogLogN.js git blob id. */
export const TIER_B1A_REV = '00ba7e1';
export const TIER_B1A_BLOB = 'ca75e5e579e650e20322b856988acae1b6295f4b';

/** sha256 of tierASource(B1a LogLogN.js): B1a + the three ` | 0` reads, nothing else. */
export const TIER_A_SHA256 = '34687989cba6d99a3975bbfe951a2e4347d04fd85fde5e590165784d0bee4a53';

// the three edits: [method signature line, target line], each target exactly once
// inside its own method body (the line ending `;` becomes ` | 0;`)
const TIER_EDITS = Object.freeze([
    Object.freeze(['    predecessor(x) {', '            v = b[o[L] + i];']),   // predecessor descend
    Object.freeze(['    max() {', '        let v = b[o[L]];']),                 // max top
    Object.freeze(['    max() {', '            v = b[o[L] + i];']),            // max descend
]);

/**
 * The A side's source: B1a LogLogN.js with EXACTLY the three ` | 0` reads of the
 * live file (predecessor descend, max top, max descend), each located inside its
 * own method body (from the 4-space signature line to the first 4-space `}`).
 * Pure. Throws '[lite-loglogn] tierASource' unless every method occurs once and
 * every target occurs exactly once in its method slice.
 * @param {string} b1aSrc @returns {string}
 */
export function tierASource(b1aSrc) {
    if (typeof b1aSrc !== 'string') throw new TypeError(PA + ': source must be a string');
    const lines = b1aSrc.split('\n');
    const at = [];
    for (let e = 0; e < TIER_EDITS.length; e++) {
        const sig = TIER_EDITS[e][0];
        const target = TIER_EDITS[e][1];
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i] !== sig) continue;
            if (start !== -1) throw new RangeError(PA + ': method ' + JSON.stringify(sig.trim()) + ' occurs more than once');
            start = i;
        }
        if (start === -1) throw new RangeError(PA + ': method ' + JSON.stringify(sig.trim()) + ' not found');
        let end = -1;
        for (let i = start + 1; i < lines.length; i++) {
            if (lines[i] === '    }') { end = i; break; }
        }
        if (end === -1) throw new RangeError(PA + ': method ' + JSON.stringify(sig.trim()) + ' has no closing line');
        let hit = -1;
        let count = 0;
        for (let i = start + 1; i < end; i++) {
            if (lines[i] === target) { hit = i; count++; }
        }
        if (count !== 1) {
            throw new RangeError(PA + ': target ' + JSON.stringify(target.trim()) + ' occurs ' + count +
                ' times in ' + sig.trim() + ' (need exactly 1)');
        }
        at.push(hit);
    }
    for (let e = 0; e < at.length; e++) {
        const t = TIER_EDITS[e][1];
        lines[at[e]] = t.slice(0, t.length - 1) + ' | 0;';
    }
    return lines.join('\n');
}

/**
 * The pure A12 decision. Validation as witnessVerdict (prefix '[lite-loglogn]
 * tierVerdict'); scenarios must be exactly TIER_SCENARIOS, in order.
 * Precedence (first match sets exit; reasons list ALL): 2 PENDING load / drift /
 * aa (dense-succ) / aaSparse (sparse-succ); 1 FAIL control did not lose; 0 KEEP dense-succ 'win' and no 'lose'; 0 DROP.
 * @returns {{ exit: 0|1|2, decision: string, verdicts: string[], reasons: string[] }}
 */
export function tierVerdict(input) {
    vObj(input, 'input', PT);
    const K = vInt(input.K, 'K', 1, Number.MAX_SAFE_INTEGER, PT);
    const need = vInt(input.need, 'need', 1, Number.MAX_SAFE_INTEGER, PT);
    if (!(need * 2 > K) || need > K) throw new RangeError(PT + ': need must satisfy K/2 < need <= K');
    const sc = input.scenarios;
    if (!Array.isArray(sc)) throw new TypeError(PT + ': scenarios must be an array');
    if (sc.length !== TIER_SCENARIOS.length) {
        throw new RangeError(PT + ': scenarios must have exactly ' + TIER_SCENARIOS.length + ' entries, got ' + sc.length);
    }
    const pts = [];
    for (let i = 0; i < sc.length; i++) {
        const p = sc[i];
        vObj(p, 'scenarios[' + i + ']', PT);
        const name = p.name;
        if (typeof name !== 'string') throw new TypeError(PT + ': scenarios[' + i + '].name must be a string');
        if (name !== TIER_SCENARIOS[i]) {
            throw new RangeError(PT + ': scenarios[' + i + '].name ' + JSON.stringify(name) +
                (TIER_SCENARIOS.includes(name) ? ' is out of order' : ' is unknown') +
                ' (want ' + JSON.stringify(TIER_SCENARIOS[i]) + ')');
        }
        const t = vTally(p, 'scenarios[' + i + ']', K, PT);
        pts.push({ name, wins: t.wins, losses: t.losses });
    }
    const aa = vTally(input.aa, 'aa', K, PT);
    const aaSparse = vTally(input.aaSparse, 'aaSparse', K, PT);
    const control = vTally(input.control, 'control', K, PT);
    const drift = input.drift;
    if (typeof drift !== 'boolean') throw new TypeError(PT + ': drift must be a boolean');
    const load1 = input.load1;
    if (typeof load1 !== 'number') throw new TypeError(PT + ': load1 must be a number');
    if (!Number.isFinite(load1) || load1 < 0) throw new RangeError(PT + ': load1 must be finite and >= 0');
    const cores = vInt(input.cores, 'cores', 1, Number.MAX_SAFE_INTEGER, PT);

    const verdicts = pts.map((p) => pointVerdict(p, need));
    const reasons = [];
    let exit = -1;
    const hit = (code, why) => { reasons.push(why); if (exit === -1) exit = code; };
    if (load1 > 0.5 * cores) {
        hit(2, 'load: load1 ' + load1 + ' > 0.5 x ' + cores + ' cores (host busy; inconclusive)');
    }
    if (drift) hit(2, 'drift: host drift detected in the probe series (inconclusive)');
    if (aa.wins >= need || aa.losses >= need) {
        hit(2, 'aa: the ' + TIER_SCENARIOS[0] + ' A/A control (B vs its twin) declared a winner (wins ' + aa.wins +
            ', losses ' + aa.losses + ' of K ' + K + ', need ' + need + '; inconclusive)');
    }
    if (aaSparse.wins >= need || aaSparse.losses >= need) {
        hit(2, 'aa: the ' + TIER_SCENARIOS[1] + ' A/A control (B vs its twin) declared a winner (wins ' +
            aaSparse.wins + ', losses ' + aaSparse.losses + ' of K ' + K + ', need ' + need + '; inconclusive)');
    }
    if (control.losses < need) {
        hit(1, 'control: the double-work candidate did not lose (losses ' + control.losses +
            ' < need ' + need + ' of K ' + K + ') -- the gate has no teeth');
    }
    const lost = [];
    for (let i = 0; i < verdicts.length; i++) if (verdicts[i] === 'lose') lost.push(pts[i].name);
    const keep = verdicts[0] === 'win' && lost.length === 0;
    if (!keep) {
        reasons.push('keep: ' + (verdicts[0] !== 'win'
            ? TIER_SCENARIOS[0] + ' is ' + verdicts[0] + ', not a win (wins ' + pts[0].wins + ' < need ' + need + ')'
            : '') + (verdicts[0] !== 'win' && lost.length > 0 ? '; ' : '') +
            (lost.length > 0 ? 'lost: ' + lost.join(', ') : '') + ' -> DROP');
    }
    if (exit === -1) exit = 0;
    const decision = exit === 2 ? 'PENDING' : exit === 1 ? 'FAIL' : keep ? 'KEEP' : 'DROP';
    return { exit, decision, verdicts, reasons };
}

// --- calibration vectors (the ADDENDUM 31 must-fail control) -------------------------

function driftVector(step) {
    const r = mulberry32(0xC0FFEE);
    const v = new Float64Array(135);
    for (let i = 0; i < 135; i++) {
        let x = 100 * (1 + 0.03 * (2 * r() - 1));
        if (i >= 60) x *= step;
        v[i] = x;
    }
    return v;
}

// --- the timed lanes (main only) --------------------------------------------------------

const R_MEMBER = 0;
const R_U32 = 1;
const R_NAIVE = 2;
const R_SA = 3;
const R_TREAP = 4;
const R_SKIP = 5;
const R_BITSET = 6;
const R_EF = 7;
const R_WRONG = 8;   // non-strict (>= x) foil: the pre-pass must-fail control only
// the --tier lane (A12): r.obj = a StratifiedBitset of one build, r.n = walks per block
const R_TS_B = 9;    // B (candidate, live text) successor walk
const R_TS_A = 10;   // A (foil, B1a + 3 reads) successor walk
const R_TS_T = 11;   // B's A/A twin successor walk
const R_TP_B = 12;   // B predecessor walk
const R_TP_A = 13;   // A predecessor walk
const R_TS_A2 = 14;  // control: the A successor walk block done TWICE, counted as one block
const R_TP_T = 15;   // B's A/A twin predecessor walk

// One block function per structure, so every successor call site stays
// monomorphic. Each returns an int32 fold of its answers (the sink), so nothing
// is dead code; undefined folds as 0 without boxing.
function blkMember(s, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) {
        const r = s.successor(qs[i]);
        acc ^= r === undefined ? 0 : r;
    }
    return acc;
}
function blkU32(arr, n, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) acc ^= u32Successor(arr, n, qs[i]);
    return acc;
}
function blkNaive(s, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) {
        const r = s.successor(qs[i]);
        acc ^= r === undefined ? 0 : r;
    }
    return acc;
}
function blkSorted(s, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) {
        const r = s.successor(qs[i]);
        acc ^= r === undefined ? 0 : r;
    }
    return acc;
}
function blkTreap(s, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) {
        const r = s.successor(qs[i]);
        acc ^= r === undefined ? 0 : r;
    }
    return acc;
}
function blkSkip(s, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) {
        const r = s.successor(qs[i]);
        acc ^= r === undefined ? 0 : r;
    }
    return acc;
}
function blkBitSet(s, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) acc ^= s.nextSet(qs[i] + 1);
    return acc;
}
function blkEF(s, qs, len) {
    let acc = 0;
    for (let i = 0; i < len; i++) acc ^= s.nextGEQ(qs[i] + 1);
    return acc;
}

// --tier walk blocks: one function per build (A, B, twin are distinct classes), so
// every min / max / successor / predecessor call site stays monomorphic. A walk is
// min() then successor() until undefined (or max() then predecessor()); every
// returned key is folded into an int32 sum (the sink); keys < 2^20 stay Smi.
function walkSuccB(s, walks) {
    let acc = 0;
    for (let w = 0; w < walks; w++) {
        let r = s.min();
        while (r !== undefined) { acc = (acc + r) | 0; r = s.successor(r); }
    }
    return acc;
}
function walkSuccA(s, walks) {
    let acc = 0;
    for (let w = 0; w < walks; w++) {
        let r = s.min();
        while (r !== undefined) { acc = (acc + r) | 0; r = s.successor(r); }
    }
    return acc;
}
function walkSuccT(s, walks) {
    let acc = 0;
    for (let w = 0; w < walks; w++) {
        let r = s.min();
        while (r !== undefined) { acc = (acc + r) | 0; r = s.successor(r); }
    }
    return acc;
}
function walkPredB(s, walks) {
    let acc = 0;
    for (let w = 0; w < walks; w++) {
        let r = s.max();
        while (r !== undefined) { acc = (acc + r) | 0; r = s.predecessor(r); }
    }
    return acc;
}
function walkPredA(s, walks) {
    let acc = 0;
    for (let w = 0; w < walks; w++) {
        let r = s.max();
        while (r !== undefined) { acc = (acc + r) | 0; r = s.predecessor(r); }
    }
    return acc;
}
function walkPredT(s, walks) {
    let acc = 0;
    for (let w = 0; w < walks; w++) {
        let r = s.max();
        while (r !== undefined) { acc = (acc + r) | 0; r = s.predecessor(r); }
    }
    return acc;
}

function runBlock(r, qs, len) {
    switch (r.kind) {
        case R_MEMBER: return blkMember(r.obj, qs, len);
        case R_U32: return blkU32(r.obj, r.n, qs, len);
        case R_NAIVE: return blkNaive(r.obj, qs, len);
        case R_SA: return blkSorted(r.obj, qs, len);
        case R_TREAP: return blkTreap(r.obj, qs, len);
        case R_SKIP: return blkSkip(r.obj, qs, len);
        case R_BITSET: return blkBitSet(r.obj, qs, len);
        case R_EF: return blkEF(r.obj, qs, len);
        case R_TS_B: return walkSuccB(r.obj, r.n);
        case R_TS_A: return walkSuccA(r.obj, r.n);
        case R_TS_T: return walkSuccT(r.obj, r.n);
        case R_TP_B: return walkPredB(r.obj, r.n);
        case R_TP_A: return walkPredA(r.obj, r.n);
        case R_TS_A2: return (walkSuccA(r.obj, r.n) + walkSuccA(r.obj, r.n)) | 0;
        case R_TP_T: return walkPredT(r.obj, r.n);
        default: throw new Error(PFX + 'witness: runner ' + r.name + ' is not timed');
    }
}

// one strict-successor answer, normalised (-1 -> undefined); pre-pass only (cold)
function answer(r, q) {
    let v;
    switch (r.kind) {
        case R_MEMBER: case R_NAIVE: case R_SA: case R_TREAP: case R_SKIP:
            return r.obj.successor(q);
        case R_U32: v = u32Successor(r.obj, r.n, q); break;
        case R_BITSET: v = r.obj.nextSet(q + 1); break;
        case R_EF: v = r.obj.nextGEQ(q + 1); break;
        case R_WRONG: v = r.n > 0 ? lowerBound(r.obj, r.n, q) : -1; break;
        default: throw new Error(PFX + 'witness: unknown runner ' + r.name);
    }
    return v === -1 ? undefined : v;
}

// the WRONG answer on purpose: smallest arr[i] >= x (non-strict), or -1
function lowerBound(arr, len, x) {
    let lo = 0, hi = len;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < x) { lo = mid + 1; } else { hi = mid; }
    }
    return lo < len ? arr[lo] : -1;
}

function runner(kind, name, obj, n) {
    return { kind, name, obj, n };
}

// n distinct seeded keys in [0, U), sorted ascending
function genKeys(n, U, seed) {
    if (!(n <= U)) throw new RangeError(PFX + 'witness: n > U');
    const rnd = mulberry32(seed);
    const out = new Uint32Array(n);
    let have = 0;
    while (have < n) {
        for (let i = have; i < n; i++) out[i] = Math.floor(rnd() * U);
        out.sort();
        let w = 1;
        for (let i = 1; i < n; i++) if (out[i] !== out[w - 1]) out[w++] = out[i];
        have = w;
    }
    return out;
}

function genQueries(len, U, seed) {
    const rnd = mulberry32(seed);
    const q = new Uint32Array(len);
    for (let i = 0; i < len; i++) q[i] = Math.floor(rnd() * U);
    return q;
}

// key-hitting pre-pass queries: sampled keys k and k - 1, plus the edges
function genExtras(keys, U) {
    const n = keys.length;
    const m = n < 2048 ? n : 2048;
    const out = [0, 1, U - 1, U - 2];
    for (let j = 0; j < m; j++) {
        const k = keys[Math.floor(j * n / m)];
        out.push(k);
        if (k > 0) out.push(k - 1);
    }
    return Uint32Array.from(out.filter((x) => x >= 0 && x < U));
}

function buildMember(keys, U) {
    const s = new StratifiedBitset(U);
    for (let i = 0; i < keys.length; i++) s.add(keys[i]);
    return s;
}

function buildNaive(keys, U) {
    const s = new NaiveFlatBitset(U);
    for (let i = 0; i < keys.length; i++) s.add(keys[i]);
    return s;
}

// the REPORTED foils for one configuration (ADDENDUM 29)
function buildReported(keys, U) {
    const n = keys.length;
    const out = [];
    out.push(runner(R_SA, 'SortedArray', SortedArray.build(keys, new Float64Array(n)), n));
    const tr = new Treap(n);
    for (let i = 0; i < n; i++) tr.set(keys[i], 0);
    out.push(runner(R_TREAP, 'Treap', tr, n));
    const sk = new SkipList(n);
    for (let i = 0; i < n; i++) sk.set(keys[i], 0);
    out.push(runner(R_SKIP, 'SkipList', sk, n));
    if (U <= 2 ** 25) {
        const bs = new BitSet(U);
        for (let i = 0; i < n; i++) bs.set(keys[i]);
        out.push(runner(R_BITSET, 'BitSet', bs, n));
    } else {
        out.push(runner(-1, 'BitSet', null, n));   // printed "n/a (U > 2^25)"
    }
    out.push(runner(R_EF, 'EliasFano', new EliasFano(keys), n));
    return out;
}

// first disagreement of foil r with the member over the streams, or null
function prepassFirst(member, r, streams) {
    for (let s = 0; s < streams.length; s++) {
        const qs = streams[s];
        for (let i = 0; i < qs.length; i++) {
            const q = qs[i];
            const want = member.obj.successor(q);
            const got = answer(r, q);
            if (got !== want) return { x: q, got, want };
        }
    }
    return null;
}

function median(f64, len) {
    const s = f64.slice(0, len).sort();
    return (len & 1) === 1 ? s[len >>> 1] : (s[len / 2 - 1] + s[len / 2]) / 2;
}

function fmt(v) {
    return Number.isFinite(v) ? v.toFixed(2) : String(v);
}

class WitnessFail extends Error {}

// tier = undefined (the B2b lanes) or the prepared --tier builds from tierPrepare()
function main(argv, env, tier) {
    const TIER = tier !== undefined;
    const KNOWN = TIER ? ['--tier', '--smoke'] : ['--smoke', '--w32'];
    for (const a of argv) {
        if (!KNOWN.includes(a)) {
            process.stdout.write(PFX + 'witness: unknown flag ' + JSON.stringify(a) +
                ' (known: ' + KNOWN.join(', ') + ')\n');
            return 1;
        }
    }
    const SMOKE = argv.includes('--smoke');
    const widthsAll = witnessWidths(argv, env);
    const K = SMOKE ? 3 : WITNESS_K;
    const NEED = SMOKE ? 2 : WITNESS_NEED;
    const Q = SMOKE && !TIER ? 1 << 10 : 1 << 16;   // --tier: a block is always 2^16 walk ops
    const NS = SMOKE ? [1e3, 1e4] : WITNESS_NS.slice();
    const WS = SMOKE ? [widthsAll[0], widthsAll[widthsAll.length - 1]] : widthsAll;
    const W_N = 28;
    const U_N = 2 ** W_N;
    const N_U = 4096;
    const N_CTRL = 1e3;
    const N_AA = 4096;
    const W_AA = 20;
    const say = (s) => { process.stdout.write(s + '\n'); };
    const fails = [];
    const t0wall = performance.now();

    // 1. provenance
    const cores = os.availableParallelism();
    const loadStart = os.loadavg();
    const cpus = os.cpus();
    say('lite-loglogn STATISTICAL witness -- mode ' + (TIER ? 'TIER ' : '') + (SMOKE ? 'SMOKE' : 'FULL'));
    say('provenance: date ' + new Date().toISOString() + ' host ' + os.hostname());
    say('provenance: cpu ' + (cpus.length > 0 ? cpus[0].model : 'unknown') +
        ' availableParallelism ' + cores);
    say('provenance: loadavg start ' + loadStart.map((x) => x.toFixed(2)).join(' '));
    say('provenance: node ' + process.version + ' v8 ' + process.versions.v8 + ' ' +
        process.platform + '/' + process.arch);
    if (TIER) {
        say('provenance: K ' + K + ' need ' + NEED + ' walk ops/block ' + Q + ' scenarios [' +
            TIER_SCENARIOS.join(', ') + '] (dense U 2^16 n ' + TIER_N_DENSE + ', sparse U 2^20 n ' +
            TIER_N_SPARSE + ') | A/A B vs twin on ' + TIER_SCENARIOS[0] + ' and ' + TIER_SCENARIOS[1] + ' | control A x2 vs A on ' +
            TIER_SCENARIOS[0] + ' | drift probe member n ' + N_AA + ' w ' + W_AA + ' queries/block ' + Q);
        say('provenance: B (candidate) live LogLogN.js ' + tier.bBytes + ' B sha256 ' + tier.bSha);
        say('provenance: A (foil) B1a rev ' + TIER_B1A_REV + ' blob ' + tier.aBlob + ' + 3 x " | 0" reads, ' +
            tier.aBytes + ' B sha256 ' + tier.aSha + ' (TIER_A_SHA256 match)');
        say('provenance: builds loaded as data: URLs (A, B, B twin + "// aa-twin")');
    } else {
        say('provenance: K ' + K + ' need ' + NEED + ' queries/block ' + Q +
            ' n-sweep ' + NS.length + ' points [' + NS.join(', ') + '] at w ' + W_N +
            ' | U-sweep ' + WS.length + ' widths [' + WS.join(', ') + '] at n ' + N_U +
            ' | control n ' + N_CTRL + ' w ' + W_N + ' | A/A n ' + N_AA + ' w ' + W_AA);
    }
    say('provenance: flags [' + argv.join(' ') + '] LOGLOGN_W32=' +
        (env !== null && typeof env === 'object' && env.LOGLOGN_W32 !== undefined ? env.LOGLOGN_W32 : '(unset)'));

    // 2a. startup control: the drift detector has teeth
    const dFlat = hostDrift(driftVector(1));
    const dStep = hostDrift(driftVector(1.25));
    const dDown = hostDrift(driftVector(0.8));
    const vSpikes = driftVector(1);
    vSpikes[30] = 400;
    vSpikes[90] = 400;
    const dSpikes = hostDrift(vSpikes);
    say('CONTROL drift: FLAT ' + JSON.stringify(dFlat) + ' STEP ' + JSON.stringify(dStep) +
        ' STEP-DOWN ' + JSON.stringify(dDown) + ' SPIKES ' + JSON.stringify(dSpikes) +
        ' (DRIFT_DELTA ' + DRIFT_DELTA + ' DRIFT_THRESHOLD ' + DRIFT_THRESHOLD +
        ' clamp [' + DRIFT_CLAMP_LO.toFixed(4) + ', ' + DRIFT_CLAMP_HI + '], nominal)');
    if (dFlat.drift || !dStep.drift || !(dStep.index >= 60 && dStep.index < 135) || !dDown.drift ||
        dSpikes.drift) {
        say('FAIL control drift: the injected step was missed, or FLAT / SPIKES fired');
        return 1;
    }

    // verdict self-check (deterministic): the pure verdict reads exit 0 / 1 as specified
    const vb = {
        K: 15, need: 13, aa: { wins: 7, losses: 8 }, control: { wins: 0, losses: 15 },
        nSweep: [{ x: 1e3, wins: 0, losses: 15 }, { x: 1e4, wins: 13, losses: 0 }, { x: 1e5, wins: 15, losses: 0 }],
        uSweep: [], drift: false, load1: 1, cores: 12,
    };
    const v0 = witnessVerdict(vb);
    const v1 = witnessVerdict({ ...vb, control: { wins: 15, losses: 0 } });
    if (v0.exit !== 0 || v0.n.crossover !== 1e4 || v1.exit !== 1) {
        say('FAIL control verdict: self-check read exit ' + v0.exit + ' / ' + v1.exit);
        return 1;
    }
    say('CONTROL verdict self-check: base exit 0 crossover 1e4; control-not-failing exit 1 -- ok');
    if (TIER) {
        const tb = {
            K: 15, need: 13, aa: { wins: 7, losses: 8 }, aaSparse: { wins: 7, losses: 8 },
            control: { wins: 0, losses: 15 },
            scenarios: TIER_SCENARIOS.map((name) => ({ name, wins: 15, losses: 0 })),
            drift: false, load1: 1, cores: 12,
        };
        const t0 = tierVerdict(tb);
        const t1 = tierVerdict({ ...tb, control: { wins: 15, losses: 0 } });
        const t2 = tierVerdict({ ...tb, scenarios: tb.scenarios.map((p, i) => (i === 0 ? { ...p, wins: 12 } : p)) });
        const t3 = tierVerdict({ ...tb, aaSparse: { wins: 13, losses: 2 } });
        if (t0.exit !== 0 || t0.decision !== 'KEEP' || t1.exit !== 1 || t1.decision !== 'FAIL' ||
            t2.exit !== 0 || t2.decision !== 'DROP' || t3.exit !== 2 || t3.decision !== 'PENDING') {
            say('FAIL control tierVerdict: self-check read ' + t0.decision + ' / ' + t1.decision + ' / ' +
                t2.decision + ' / ' + t3.decision);
            return 1;
        }
        say('CONTROL tierVerdict self-check: base KEEP exit 0; control-not-losing FAIL exit 1; dense-succ 12/15 DROP;' +
            ' sparse A/A winner PENDING exit 2 -- ok');
    }

    // per-run state, allocated ONCE before any round
    const totalPoints = TIER ? TIER_SCENARIOS.length + 3 : NS.length + WS.length + 2;   // tier: + 2 A/A + control
    const series = new Float64Array(K * totalPoints);
    const ST = { pos: 0 };
    const TM = new Float64Array(4);
    const RC = new Float64Array(K);
    const RF = new Float64Array(K);
    const RR = new Float64Array(K);
    const SINK = new Int32Array(1);
    const LAT = new Float64Array(Q);
    const QQ = Float64Array.of(0.5, 0.99);
    const QO = new Float64Array(2);
    const sketch = new DDSketch(0.01);

    // the A/A config doubles as the drift probe (member, fixed config, 1 block)
    const U_AA = 2 ** W_AA;
    const keysAA = genKeys(N_AA, U_AA, 0xA11A0001);
    const qAA = genQueries(Q, U_AA, 0xA11A0002);
    const xAA = genExtras(keysAA, U_AA);
    const memA = runner(R_MEMBER, 'member', buildMember(keysAA, U_AA), N_AA);
    const memB = runner(R_MEMBER, 'member(B)', buildMember(keysAA, U_AA), N_AA);
    const probe = memA;
    for (let i = 0; i < 16; i++) SINK[0] ^= runBlock(probe, qAA, Q);   // tier the probe up before round 1

    // 2b. pre-pass must-fail control: a non-strict foil MUST disagree (B2b lanes only)
    if (!TIER) {
        const wrong = runner(R_WRONG, 'wrong(>=x)', keysAA, N_AA);
        const wrongHit = prepassFirst(memA, wrong, [qAA, xAA]);
        if (wrongHit === null) {
            say('FAIL control pre-pass: the non-strict foil was not flagged -- the pre-pass has no teeth');
            return 1;
        }
        say('CONTROL pre-pass: non-strict foil flagged at x=' + wrongHit.x + ' (got ' + wrongHit.got +
            ', want ' + wrongHit.want + ') -- ok');
    }

    const prepass = (cfg, member, foils, streams) => {
        for (const f of foils) {
            if (f.obj === null) continue;
            const hit = prepassFirst(member, f, streams);
            if (hit !== null) {
                throw new WitnessFail('pre-pass ' + cfg + ': foil ' + f.name + ' disagrees at first x=' +
                    hit.x + ' (got ' + hit.got + ', member ' + hit.want + ')');
            }
        }
    };

    // time one block of runner r: ns/op, written into TM[slot]
    const timeInto = (r, qs, slot) => {
        const t = performance.now();
        SINK[0] ^= runBlock(r, qs, Q);
        TM[slot] = (performance.now() - t) * 1e6 / Q;
    };

    // K ABBA rounds of candidate a vs foil b, one probe block per round
    const abba = (a, qa, b, qb) => {
        runBlock(a, qa, Q); runBlock(b, qb, Q); runBlock(probe, qAA, Q);   // warm-up, untimed
        let wins = 0, losses = 0;
        for (let r = 0; r < K; r++) {
            SINK[0] ^= runBlock(a, qa, Q);   // untimed re-warm (R3a)
            timeInto(a, qa, 0);
            timeInto(b, qb, 1);
            timeInto(b, qb, 2);
            timeInto(a, qa, 3);
            const ca = TM[0] + TM[3];
            const cb = TM[1] + TM[2];
            if (ca < cb) wins++;
            else if (cb < ca) losses++;
            RC[r] = ca / 2;
            RF[r] = cb / 2;
            SINK[0] ^= runBlock(probe, qAA, Q);   // untimed probe re-warm (R3a)
            timeInto(probe, qAA, 0);
            series[ST.pos++] = TM[0];
        }
        return { wins, losses, candMed: median(RC, K), foilMed: median(RF, K) };
    };

    // REPORTED foils: median ns/op over K rounds, one block each
    const reported = (foils, qs) => {
        const parts = [];
        for (const f of foils) {
            if (f.obj === null) { parts.push(f.name + ' n/a (U > 2^25)'); continue; }
            runBlock(f, qs, Q);
            for (let r = 0; r < K; r++) { timeInto(f, qs, 0); RR[r] = TM[0]; }
            parts.push(f.name + ' ' + fmt(median(RR, K)));
        }
        return parts.join(' | ');
    };

    // LATENCY lane: per-op member successor latency, then DDSketch.addFrom. The
    // clock floor (the same two performance.now() reads around nothing) is printed
    // beside it: a per-op sample of a ~10 ns op is mostly clock.
    const latency = (m, qs) => {
        const s = m.obj;
        for (let i = 0; i < Q; i++) {
            const t = performance.now();
            LAT[i] = (performance.now() - t) * 1e6;
        }
        sketch.clear();
        for (let i = 0; i < Q; i++) sketch.addFrom(LAT, i);
        sketch.quantilesInto(QQ, QO);
        const floor50 = QO[0];
        let acc = 0;
        for (let i = 0; i < Q; i++) {
            const t = performance.now();
            const r = s.successor(qs[i]);
            LAT[i] = (performance.now() - t) * 1e6;
            acc ^= r === undefined ? 0 : r;
        }
        SINK[0] ^= acc;
        sketch.clear();
        for (let i = 0; i < Q; i++) sketch.addFrom(LAT, i);
        sketch.quantilesInto(QQ, QO);
        return { count: sketch.count, p50: QO[0], p99: QO[1], max: sketch.max, floor50 };
    };

    const tally = (name, t) => {
        if (!(t.wins + t.losses <= K)) fails.push(name + ': wins + losses > K');
        return t.wins + ' / ' + t.losses + ' / ' + (K - t.wins - t.losses);
    };

    if (TIER) {
        return tierLane(tier, { K, NEED, SMOKE, Q, say, fails, abba, tally, series, ST, SINK, loadStart, cores, t0wall });
    }

    // 3. GATED n-sweep (+ REPORTED foils + LATENCY at each point)
    const nSweep = [];
    say('GATED n-sweep: member StratifiedBitset vs u32Successor at w ' + W_N +
        ' (ns/op medians; wins / losses / ties of K ' + K + ')');
    for (let j = 0; j < NS.length; j++) {
        const n = NS[j];
        const keys = genKeys(n, U_N, 0x5EED0000 + j);
        const qs = genQueries(Q, U_N, 0x0E570000 + j);
        const xs = genExtras(keys, U_N);
        const mem = runner(R_MEMBER, 'member', buildMember(keys, U_N), n);
        const u32 = runner(R_U32, 'u32Successor', keys, n);
        const rep = buildReported(keys, U_N);
        prepass('n=' + n + ' w=' + W_N, mem, [u32, ...rep], [qs, xs]);
        const t = abba(mem, qs, u32, qs);
        const tl = tally('n=' + n, t);
        nSweep.push({ x: n, wins: t.wins, losses: t.losses });
        say('  n=' + n + ' member ' + fmt(t.candMed) + ' | u32 ' + fmt(t.foilMed) + ' | ' + tl +
            ' -> ' + pointVerdict(t, NEED));
        say('  REPORTED foils n=' + n + ' (median ns/op): ' + reported(rep, qs));
        const L = latency(mem, qs);
        say('  REPORTED latency n=' + n + ' member per-op (ns, DDSketch alpha 0.01, ' + L.count +
            ' samples): p50 ' + fmt(L.p50) + ' p99 ' + fmt(L.p99) + ' max ' + fmt(L.max) +
            ' | clock floor p50 ' + fmt(L.floor50));
        if (L.count !== Q || !Number.isFinite(L.p50) || !Number.isFinite(L.p99) || !Number.isFinite(L.max)) {
            fails.push('latency n=' + n + ': count ' + L.count + ' p50 ' + L.p50 + ' p99 ' + L.p99 + ' max ' + L.max);
        }
    }

    // 4. U-sweep: member vs NaiveFlatBitset at n = 4096 (+ REPORTED foils)
    const uSweep = [];
    const fx = [], fl = [], fy = [];
    say('GATED U-sweep (monotone rule; fits + crossover REPORTED): member vs NaiveFlatBitset at n ' + N_U + ' (ns/op medians; wins / losses / ties of K ' + K + ')');
    for (let j = 0; j < WS.length; j++) {
        const w = WS[j];
        const U = 2 ** w;
        const keys = genKeys(N_U, U, 0x5EED1000 + w);
        const qs = genQueries(Q, U, 0x0E571000 + w);
        const xs = genExtras(keys, U);
        const mem = runner(R_MEMBER, 'member', buildMember(keys, U), N_U);
        const nai = runner(R_NAIVE, 'NaiveFlatBitset', buildNaive(keys, U), N_U);
        const rep = buildReported(keys, U);
        prepass('U-sweep w=' + w, mem, [nai, runner(R_U32, 'u32Successor', keys, N_U), ...rep], [qs, xs]);
        const t = abba(mem, qs, nai, qs);
        const tl = tally('w=' + w, t);
        uSweep.push({ x: w, wins: t.wins, losses: t.losses });
        fx.push(w); fl.push(Math.log2(w)); fy.push(t.candMed);
        say('  w=' + w + ' member ' + fmt(t.candMed) + ' | naive ' + fmt(t.foilMed) + ' | ' + tl +
            ' -> ' + pointVerdict(t, NEED));
        say('  REPORTED foils w=' + w + ' (median ns/op): ' + reported(rep, qs));
    }
    const fitL = fitLogLinear(fl, fy);
    const fitW = fitLogLinear(fx, fy);
    say('REPORTED fit member vs log2(w): slope ' + fmt(fitL.slope) + ' ns/doubling intercept ' +
        fmt(fitL.intercept) + ' R^2 ' + fitL.r2.toFixed(4));
    say('REPORTED fit member vs w (impostor axis): slope ' + fitW.slope.toFixed(4) + ' ns/bit intercept ' +
        fmt(fitW.intercept) + ' R^2 ' + fitW.r2.toFixed(4));

    // 5. control: NaiveFlatBitset (candidate) vs u32Successor at n = 1e3, w = 28
    const keysC = genKeys(N_CTRL, U_N, 0x5EED2000);
    const qC = genQueries(Q, U_N, 0x0E572000);
    const memC = runner(R_MEMBER, 'member', buildMember(keysC, U_N), N_CTRL);
    const naiC = runner(R_NAIVE, 'NaiveFlatBitset', buildNaive(keysC, U_N), N_CTRL);
    const u32C = runner(R_U32, 'u32Successor', keysC, N_CTRL);
    prepass('control', memC, [naiC, u32C], [qC, genExtras(keysC, U_N)]);
    const tc = abba(naiC, qC, u32C, qC);
    const control = { wins: tc.wins, losses: tc.losses };
    say('GATED control: NaiveFlatBitset (candidate) ' + fmt(tc.candMed) + ' vs u32 ' + fmt(tc.foilMed) +
        ' at n ' + N_CTRL + ' w ' + W_N + ' | ' + tally('control', tc) + ' (must lose)');

    // 6. A/A: member vs an independently built identical member
    prepass('A/A', memA, [memB], [qAA, xAA]);
    const ta = abba(memA, qAA, memB, qAA);
    const aa = { wins: ta.wins, losses: ta.losses };
    say('GATED A/A: member ' + fmt(ta.candMed) + ' vs member(B) ' + fmt(ta.foilMed) + ' at n ' + N_AA +
        ' w ' + W_AA + ' | ' + tally('aa', ta) + ' (must not declare a winner)');

    // drift + load
    if (ST.pos !== series.length) fails.push('drift series ' + ST.pos + ' != ' + series.length);
    const hd = hostDrift(series.subarray(0, ST.pos));
    const loadEnd = os.loadavg();
    const load1 = Math.max(loadStart[0], loadEnd[0]);
    say('GATED host: drift ' + JSON.stringify(hd) + ' over ' + ST.pos + ' probe rounds (median ' +
        fmt(median(series, ST.pos)) + ' ns/op) | loadavg end ' + loadEnd.map((x) => x.toFixed(2)).join(' ') +
        ' load1 ' + load1.toFixed(2) + ' vs 0.5 x ' + cores);

    // 9. verdict
    const v = witnessVerdict({ K, need: NEED, nSweep, uSweep, aa, control, drift: hd.drift, load1, cores });
    for (const r of v.reasons) say('  reason ' + r);
    say('GATED n-sweep verdicts [' + v.n.verdicts.join(', ') + '] crossover ' +
        (v.n.crossover === null ? 'none in range' : 'K = ' + v.n.crossover));
    say('REPORTED U-sweep verdicts [' + v.u.verdicts.join(', ') + '] crossover ' +
        (v.u.crossover === null ? 'none in range' : 'w = ' + v.u.crossover));
    say('sink ' + SINK[0] + ' | wall ' + ((performance.now() - t0wall) / 1000).toFixed(2) + ' s');

    const shapeOk = (v.exit === 0 || v.exit === 1 || v.exit === 2) && Array.isArray(v.reasons) &&
        v.reasons.every((r) => typeof r === 'string') &&
        v.n.verdicts.length === nSweep.length && v.u.verdicts.length === uSweep.length &&
        (v.n.crossover === null || typeof v.n.crossover === 'number') &&
        (v.u.crossover === null || typeof v.u.crossover === 'number');
    if (!shapeOk) fails.push('witnessVerdict returned a malformed result');

    if (SMOKE) {
        say('verdict exit (printed, not used in smoke): ' + v.exit);
        if (fails.length > 0) {
            for (const f of fails) say('FAIL ' + f);
            return 1;
        }
        say('WITNESS SMOKE ok (untimed: verdict not gated)');
        return 0;
    }
    if (fails.length > 0) {
        for (const f of fails) say('FAIL ' + f);
        return 1;
    }
    say('WITNESS exit ' + v.exit + (v.exit === 0 ? ' (pass)' : v.exit === 1 ? ' (FAIL)' : ' (inconclusive)'));
    return v.exit;
}

// --- the A12 --tier lane (BSTAT-SPEC.md; main only) ---------------------------------------

const TIER_N_DENSE = 32768;    // dense scenarios: U 2^16
const TIER_N_SPARSE = 4096;    // sparse scenarios: U 2^20
const TIER_OPS = 1 << 16;      // walk ops (returned keys) per timed block
const TIER_WARM = 16;          // untimed tier-up blocks per runner before round 1

function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function dataUrl(src) {
    return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}

// The two builds (+ B's A/A twin), all loaded the same way: a data: URL import of
// the source text. Fails closed (WitnessFail) on a wrong B1a blob or A sha256.
async function tierPrepare() {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const raw = execFileSync('git', ['show', TIER_B1A_REV + ':LogLogN.js'],
        { cwd: root, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
    const aBlob = createHash('sha1').update('blob ' + raw.length + '\0').update(raw).digest('hex');
    if (aBlob !== TIER_B1A_BLOB) {
        throw new WitnessFail('tier: git show ' + TIER_B1A_REV + ':LogLogN.js blob ' + aBlob + ' != ' + TIER_B1A_BLOB);
    }
    const aSrc = tierASource(raw.toString('utf8'));
    const aBuf = Buffer.from(aSrc, 'utf8');
    const aSha = sha256Hex(aBuf);
    if (aSha !== TIER_A_SHA256) {
        throw new WitnessFail('tier: A side sha256 ' + aSha + ' != TIER_A_SHA256 ' + TIER_A_SHA256);
    }
    const bBuf = readFileSync(fileURLToPath(new URL('../LogLogN.js', import.meta.url)));
    const bSrc = bBuf.toString('utf8');
    const mA = await import(dataUrl(aSrc));
    const mB = await import(dataUrl(bSrc));
    const mT = await import(dataUrl(bSrc + '\n// aa-twin\n'));
    const A = mA.StratifiedBitset, B = mB.StratifiedBitset, T = mT.StratifiedBitset;
    if (typeof A !== 'function' || typeof B !== 'function' || typeof T !== 'function' ||
        A === B || B === T || A === T) {
        throw new WitnessFail('tier: the A / B / twin builds must export three distinct StratifiedBitset classes');
    }
    return { A, B, T, aBlob, aSha, aBytes: aBuf.length, bSha: sha256Hex(bBuf), bBytes: bBuf.length };
}

function buildWith(Cls, keys, U) {
    const s = new Cls(U);
    for (let i = 0; i < keys.length; i++) s.add(keys[i]);
    return s;
}

// pre-pass (cold, generic): one walk -> { ops, hash } (FNV-1a of the key sequence);
// a walk longer than cap fails closed (a non-advancing successor never ends)
function tierWalk(s, pred, cap) {
    let h = FNV_OFFSET;
    let ops = 0;
    let r = pred ? s.max() : s.min();
    while (r !== undefined) {
        if (ops >= cap) return { ops: -1, hash: h };
        h = fnvWord(h, r);
        ops++;
        r = pred ? s.predecessor(r) : s.successor(r);
    }
    return { ops, hash: h };
}

function tierSame(x, y) { return x.ops === y.ops && x.hash === y.hash; }

// the true walk: the sorted key set itself, ascending (succ) or descending (pred)
function keysWalk(keys, pred) {
    let h = FNV_OFFSET;
    const n = keys.length;
    for (let i = 0; i < n; i++) h = fnvWord(h, keys[pred ? n - 1 - i : i]);
    return { ops: n, hash: h };
}

function tierLane(tier, h) {
    const { K, NEED, SMOKE, Q, say, fails, abba, tally, series, ST, SINK, loadStart, cores, t0wall } = h;
    if (Q !== TIER_OPS) throw new WitnessFail('tier: block size ' + Q + ' != ' + TIER_OPS);
    const cfg = [
        { name: TIER_SCENARIOS[0], U: 1 << 16, n: TIER_N_DENSE, pred: false },
        { name: TIER_SCENARIOS[1], U: 1 << 20, n: TIER_N_SPARSE, pred: false },
        { name: TIER_SCENARIOS[2], U: 1 << 16, n: TIER_N_DENSE, pred: true },
        { name: TIER_SCENARIOS[3], U: 1 << 20, n: TIER_N_SPARSE, pred: true },
    ];

    // pre-pass must-fail control: the checker MUST flag a build missing one key and the
    // reversed key walk, else it has no teeth (BSTAT ADDENDUM S1)
    const k0 = genKeys(cfg[0].n, cfg[0].U, 0x7E1E0000);
    const wTrue = keysWalk(k0, false);
    const wShort = tierWalk(buildWith(tier.A, k0.subarray(1), cfg[0].U), false, cfg[0].U);
    if (tierSame(wShort, wTrue) || tierSame(keysWalk(k0, true), wTrue)) {
        say('FAIL control pre-pass: a build missing one key or the reversed walk was not flagged -- the pre-pass has no teeth');
        return 1;
    }
    say('CONTROL pre-pass: a build missing one key and the reversed walk are both flagged -- ok');

    // build + correctness pre-pass, every scenario before any timing
    const runs = [];
    for (let j = 0; j < cfg.length; j++) {
        const c = cfg[j];
        const walks = Math.ceil(TIER_OPS / c.n);
        if (walks * c.n !== TIER_OPS) throw new WitnessFail('tier ' + c.name + ': ' + walks + ' walks x ' + c.n + ' != ' + TIER_OPS);
        const keys = genKeys(c.n, c.U, 0x7E1E0000 + j);   // ONE key set, same order into every build
        const a = buildWith(tier.A, keys, c.U);
        const b = buildWith(tier.B, keys, c.U);
        const t = buildWith(tier.T, keys, c.U);           // B's history-matched A/A twin (S2)
        const wa = tierWalk(a, c.pred, c.U);
        const wb = tierWalk(b, c.pred, c.U);
        const wt = tierWalk(t, c.pred, c.U);
        const wk = keysWalk(keys, c.pred);
        if (!tierSame(wa, wb)) {
            throw new WitnessFail('pre-pass ' + c.name + ': A walk (ops ' + wa.ops + ' fnv1a ' + hex32(wa.hash) +
                ') != B walk (ops ' + wb.ops + ' fnv1a ' + hex32(wb.hash) + ')');
        }
        if (!tierSame(wb, wk)) {
            throw new WitnessFail('pre-pass ' + c.name + ': A and B walks (ops ' + wb.ops + ' fnv1a ' + hex32(wb.hash) +
                ') != the key set (ops ' + wk.ops + ' fnv1a ' + hex32(wk.hash) + ')');
        }
        if (!tierSame(wt, wb)) {
            throw new WitnessFail('pre-pass ' + c.name + ': twin walk (ops ' + wt.ops + ' fnv1a ' + hex32(wt.hash) +
                ') != B walk (ops ' + wb.ops + ' fnv1a ' + hex32(wb.hash) + ')');
        }
        say('PRE-PASS ' + c.name + ': A, B and twin walks agree with each other and the key set (ops ' + wb.ops +
            ' fnv1a ' + hex32(wb.hash) + ') -- ok');
        runs.push({
            c, walks,
            b: runner(c.pred ? R_TP_B : R_TS_B, 'B ' + c.name, b, walks),
            a: runner(c.pred ? R_TP_A : R_TS_A, 'A ' + c.name, a, walks),
            t: runner(c.pred ? R_TP_T : R_TS_T, 'T ' + c.name, t, walks),
        });
    }
    const d0 = runs[0];
    const s1 = runs[1];

    // tier-up (untimed, interleaved): every walk function is a separate function per
    // build, so each starts cold; without this the first timed rounds compare a
    // tiered-up B against a cold A / twin (the B2b probe tier-up, for every runner).
    // Every twin shares its B's history: same scenarios, same tier-up blocks (S2).
    for (let i = 0; i < TIER_WARM; i++) {
        for (let j = 0; j < runs.length; j++) {
            SINK[0] ^= runBlock(runs[j].b, null, TIER_OPS);
            SINK[0] ^= runBlock(runs[j].a, null, TIER_OPS);
            SINK[0] ^= runBlock(runs[j].t, null, TIER_OPS);
        }
    }
    say('TIER tier-up: ' + TIER_WARM + ' untimed interleaved blocks of every B / A / twin runner -- done');

    // A/A (S2 / S3): B vs its twin on dense-succ, then on sparse-succ, before the scenarios
    const ta = abba(d0.b, null, d0.t, null);
    const aa = { wins: ta.wins, losses: ta.losses };
    say('GATED A/A: B ' + fmt(ta.candMed) + ' vs B twin ' + fmt(ta.foilMed) + ' on ' + d0.c.name + ' | ' +
        tally('aa', ta) + ' (must not declare a winner)');
    const ts = abba(s1.b, null, s1.t, null);
    const aaSparse = { wins: ts.wins, losses: ts.losses };
    say('GATED A/A: B ' + fmt(ts.candMed) + ' vs B twin ' + fmt(ts.foilMed) + ' on ' + s1.c.name + ' | ' +
        tally('aaSparse', ts) + ' (must not declare a winner)');

    // GATED: K ABBA rounds of B (candidate) vs A (foil), the B2b protocol (R3a re-warm)
    const scenarios = [];
    say('GATED tier: B (candidate, live LogLogN.js) vs A (foil, B1a + 3 reads), ' + TIER_OPS +
        ' walk ops/block (ns/op medians; wins / losses / ties of K ' + K + ')');
    for (let j = 0; j < runs.length; j++) {
        const R = runs[j];
        const t = abba(R.b, null, R.a, null);
        const tl = tally(R.c.name, t);
        scenarios.push({ name: R.c.name, wins: t.wins, losses: t.losses });
        say('  ' + R.c.name + ' (U 2^' + Math.log2(R.c.U) + ' n ' + R.c.n + ', ' + R.walks + ' walks/block) B ' +
            fmt(t.candMed) + ' | A ' + fmt(t.foilMed) + ' | ' + tl + ' -> ' + pointVerdict(t, NEED));
    }

    // control: A doing exactly 2 full blocks per timed block vs A, on dense-succ
    const tc = abba(runner(R_TS_A2, 'A x2 ' + d0.c.name, d0.a.obj, d0.walks), null, d0.a, null);
    const control = { wins: tc.wins, losses: tc.losses };
    say('GATED control: A x2 (candidate, double work) ' + fmt(tc.candMed) + ' vs A ' + fmt(tc.foilMed) +
        ' on ' + d0.c.name + ' | ' + tally('control', tc) + ' (must lose)');

    // drift + load
    if (ST.pos !== series.length) fails.push('drift series ' + ST.pos + ' != ' + series.length);
    const hd = hostDrift(series.subarray(0, ST.pos));
    const loadEnd = os.loadavg();
    const load1 = Math.max(loadStart[0], loadEnd[0]);
    say('GATED host: drift ' + JSON.stringify(hd) + ' over ' + ST.pos + ' probe rounds (median ' +
        fmt(median(series, ST.pos)) + ' ns/op) | loadavg end ' + loadEnd.map((x) => x.toFixed(2)).join(' ') +
        ' load1 ' + load1.toFixed(2) + ' vs 0.5 x ' + cores);

    const v = tierVerdict({ K, need: NEED, scenarios, aa, aaSparse, control, drift: hd.drift, load1, cores });
    for (const r of v.reasons) say('  reason ' + r);
    say('GATED tier verdicts [' + TIER_SCENARIOS.map((nm, i) => nm + ' ' + v.verdicts[i]).join(', ') +
        '] decision ' + v.decision);
    if (v.decision === 'PENDING') {
        say('  PENDING: the B1a body ships unless the maintainer waives A12 (ADDENDUM 27)');
    }
    say('sink ' + SINK[0] + ' | wall ' + ((performance.now() - t0wall) / 1000).toFixed(2) + ' s');

    const shapeOk = (v.exit === 0 || v.exit === 1 || v.exit === 2) && Array.isArray(v.reasons) &&
        v.reasons.every((r) => typeof r === 'string') && Array.isArray(v.verdicts) &&
        v.verdicts.length === TIER_SCENARIOS.length &&
        ['KEEP', 'DROP', 'FAIL', 'PENDING'].includes(v.decision);
    if (!shapeOk) fails.push('tierVerdict returned a malformed result');

    if (SMOKE) {
        say('decision exit (printed, not used in smoke): ' + v.exit + ' ' + v.decision);
        if (fails.length > 0) {
            for (const f of fails) say('FAIL ' + f);
            return 1;
        }
        say('TIER SMOKE ok (untimed: decision not gated)');
        return 0;
    }
    if (fails.length > 0) {
        for (const f of fails) say('FAIL ' + f);
        return 1;
    }
    say('TIER exit ' + v.exit + ' ' + v.decision + ' -- reported to the maintainer, who rules keep / drop' +
        ' (this harness never edits LogLogN.js)');
    return v.exit;
}

// --tier entry: flag check, then the async build prep, then main()
async function tierMain(argv, env) {
    const KNOWN = ['--tier', '--smoke', '--w32'];
    for (const a of argv) {
        if (!KNOWN.includes(a)) {
            process.stdout.write(PFX + 'witness: unknown flag ' + JSON.stringify(a) +
                ' (known with --tier: --smoke)\n');
            return 1;
        }
    }
    if (argv.includes('--w32') || (env !== null && typeof env === 'object' && env.LOGLOGN_W32 === '1')) {
        process.stdout.write(PFX + 'witness: --w32 / LOGLOGN_W32=1 is not applicable to --tier\n');
        return 1;
    }
    return main(argv, env, await tierPrepare());
}

// realpath the entry: a symlinked path (macOS /tmp -> /private/tmp) must still run main()
function isEntry() {
    if (typeof process.argv[1] !== 'string') return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
        return false;
    }
}
const IS_MAIN = isEntry();

function failOut(e) {
    process.stdout.write((e instanceof WitnessFail ? 'FAIL ' + e.message : PFX + 'witness: uncaught ' +
        (e && e.stack ? e.stack : String(e))) + '\n');
    return 1;
}

if (IS_MAIN) {
    if (process.argv.slice(2).includes('--tier')) {
        tierMain(process.argv.slice(2), process.env).then(
            (c) => { process.exitCode = c; },
            (e) => { process.exitCode = failOut(e); });
    } else {
        let code;
        try {
            code = main(process.argv.slice(2), process.env);
        } catch (e) {
            code = failOut(e);
        }
        process.exitCode = code;
    }
}
