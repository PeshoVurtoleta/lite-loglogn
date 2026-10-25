/**
 * @zakkster/lite-loglogn -- YFastTrie fuzz-oracle worker (0.4.0 G1-B4, A3). Not a
 * test file: the npm glob `test/*.test.js` never matches it. Inert when merely
 * imported; runs only as a node:worker_threads Worker (workerData.yftJob).
 *
 * runYft(mod, U, C, nOps, seed, seedArg) replays a seeded stream on
 * `new mod.YFastTrie(U, C[, seedArg])` and compares EVERY return value and the
 * size, per op, with FOUR oracles taken from the SPEC (strict successor /
 * predecessor, capacity rule, bad-key rule), never from the engine source:
 *   SortedArray, Scapegoat   lite-logn (devDependency, oracle only);
 *   StratifiedBitset         in-package, only U <= 2^25;
 *   XFastTrie                the sibling structure in lockstep (same C);
 * plus a plain sorted JS array (`truth`, the contract bucket: bad keys, capacity)
 * and YModel (test/helpers/yftStream.mjs, the PLAN C-3 policy on plain arrays: the
 * `model` bucket compares reps / sizes / counters at each checkpoint).
 *
 * STREAM. The first ops are adds (fill to C, then ~50 more adds at size C = the full-throws). Two independent mulberry32 u32 streams: OPS (kind, bad-key draw, phase)
 * and KEYS (two draws per op, always). 300-op blocks cycle MIX / GROW / SWEEP /
 * CLUSTER / TB phases. TB (targeted borrow) reads the YModel layout: it fills the
 * left neighbour L of bucket i to K keys, then deletes from bucket i down below h,
 * so a borrow fires; i = 1 half of the time (a borrow FROM THE HEAD). Bad keys on
 * ~3% of key ops, -0 aliasing, boundary keys, full-throws.
 *
 * CHECKPOINT every CHECK_EVERY ops (and after the last op), buckets:
 *   walks      min() -> successor() and max() -> predecessor() equal the truth;
 *   invariants dump(): reps[0] = 0, reps strictly ascending and equal to the INNER
 *              trie's keys, bucket keys inside [rep_i, rep_{i+1}), head size <= K,
 *              every other bucket size in [h, K] (h = ceil(w/2), K = 2w), inner
 *              size <= Cr = min(2 + floor(C/h), U), keys == truth;
 *   model      dump().reps / sizes == YModel, counters `_n[0..2]` == YModel's.
 *
 * Worker mode: src === null imports ../LogLogN.js, a string src (a mutant built
 * by the test from the real source text) is imported via a data: URL. Posts ONE
 * message `{ ok: true, result }` or `{ ok: false, message }`.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SortedArray, Scapegoat } from '@zakkster/lite-logn';
import { StratifiedBitset } from '../LogLogN.js';
import { YModel } from './helpers/yftStream.mjs';

export const CHECK_EVERY = 1024;
export const SB_MAX_U = 2 ** 25;
const BLOCK = 300;
const RANGE_ERR = 'throw:RangeError';
const OTHER_ERR = 'throw:other';
const K_ADD = 0;
const K_DEL = 1;
const K_HAS = 2;
const K_SUCC = 3;
const K_PRED = 4;
const K_MIN = 5;
const K_MAX = 6;
const KIND_NAME = ['add', 'delete', 'has', 'successor', 'predecessor', 'min', 'max'];
const P_MIX = 0;
const P_GROW = 1;
const P_SWEEP = 2;
const P_CLUSTER = 3;
const P_TB = 4;

/** Own 32-bit PRNG (mulberry32 core), returns u32. */
function stream(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    };
}

function show(v) {
    if (v === undefined) return 'undefined';
    if (v !== null && typeof v === 'object') return '[object]';
    return typeof v + ':' + String(v);
}

function bucket() {
    return { cmp: 0, div: 0, first: null };
}

function check(r, op, x, at, got, want) {
    r.cmp++;
    if (!Object.is(got, want)) {
        r.div++;
        if (r.first === null) r.first = { op, x: show(x), got: show(got), want: show(want), at };
    }
}

function isKey(x, U) {
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < U;
}

class Truth {
    constructor() { this.a = []; }
    lb(x) {
        let lo = 0;
        let hi = this.a.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.a[mid] < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
    has(x) { return this.a[this.lb(x)] === x; }
    add(x) { this.a.splice(this.lb(x), 0, x); }
    del(x) { this.a.splice(this.lb(x), 1); }
}

/** One structure's outcome for one op; a throw is recorded per structure, never shared. */
function call(s, kind, x) {
    try {
        if (kind === K_ADD) return s.add(x);
        if (kind === K_DEL) return s.delete(x);
        if (kind === K_HAS) return s.has(x);
        if (kind === K_SUCC) return s.successor(x);
        if (kind === K_PRED) return s.predecessor(x);
        if (kind === K_MIN) return s.min();
        return s.max();
    } catch (e) {
        return e instanceof RangeError ? RANGE_ERR : OTHER_ERR;
    }
}

function fnv(h, s) {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h;
}

/**
 * @returns {object} per-bucket {cmp, div, first} (contract, SortedArray, Scapegoat,
 *   StratifiedBitset|null, XFastTrie, walks, invariants, model) and the coverage
 *   counters (splits, merges, borrows, headBorrows from YModel; eng* from `_n`).
 */
export function runYft(mod, U, C, nOps, seed, seedArg) {
    const Cls = mod.YFastTrie;
    const w = 32 - Math.clz32(U - 1);
    const K = 2 * w;
    const h = (w + 1) >>> 1;
    const Cr = Math.min(2 + Math.floor(C / h), U);
    const nextOp = stream((Math.imul(seed, 0x9E3779B1) ^ 0x5bd1e995) >>> 0);
    const nextKey = stream((Math.imul(seed, 0x85EBCA6B) ^ 0xc2b2ae35) >>> 0);
    const BAD = [-1, U, U + 1, 1.5, NaN, Infinity, -Infinity, '3', null, undefined, 4294967296, 9007199254740992, true];
    const BOUND = [0, 1, U - 1, U - 2, U - 3, 2147483647, 2147483648, 2147483649, 1073741824, 1073741823]
        .filter((v) => v >= 0 && v < U);

    const t = seedArg === 'omit' ? new Cls(U, C) : new Cls(U, C, seedArg === 'undef' ? undefined : seedArg);
    const xt = new mod.XFastTrie(U, C);
    const model = new YModel(U, C);
    const sb = U <= SB_MAX_U ? new StratifiedBitset(U) : null;
    const sg = new Scapegoat(C);
    const sa = new SortedArray(C);
    const RA = bucket();
    const RG = bucket();
    const RS = bucket();
    const RX = bucket();
    const CT = bucket();
    const WK = bucket();
    const IV = bucket();
    const MD = bucket();
    const truth = new Truth();
    const opCounts = [0, 0, 0, 0, 0, 0, 0];
    let fullThrows = 0;
    let checkpoints = 0;
    let absQ = 0;
    let presQ = 0;
    let headBorrows = 0;
    let resHash = 0x811c9dc5;
    let layHash = 0x811c9dc5;

    const centers = [0];
    for (let i = 1; i < 8; i++) centers.push(Math.floor(nextKey() / 4294967296 * U));
    const clamp = (v) => (v < 0 ? 0 : v > U - 1 ? U - 1 : v);
    const uni = (r) => Math.floor(r / 4294967296 * U);

    function pickAny(k1, k2) {
        const m = k1 & 7;
        const n = truth.a.length;
        if (m === 3 && n > 0) return truth.a[k2 % n];
        if (m === 4 && n > 0) return clamp(truth.a[k2 % n] + ((k1 >>> 3) % 5) - 2);
        if (m === 5) return clamp(model.reps[k2 % model.reps.length] + ((k1 >>> 3) % 3) - 1);
        if (m === 6) return BOUND[k2 % BOUND.length];
        if (m === 7) return ((k1 >>> 3) & 1) === 1 ? -0 : 0;
        return uni(k2);
    }

    const checkpoint = (at) => {
        checkpoints++;
        try {
            for (const up of [true, false]) {
                const keys = truth.a;
                const n = keys.length;
                let j = 0;
                let k = up ? t.min() : t.max();
                WK.cmp++;
                for (; k !== undefined; k = up ? t.successor(k) : t.predecessor(k)) {
                    check(WK, up ? 'walk-up' : 'walk-down', k, at, k, up ? keys[j] : keys[n - 1 - j]);
                    if (++j > C + 1) break;
                }
                check(WK, up ? 'walk-up-len' : 'walk-down-len', null, at, j, n);
            }
        } catch (e) {
            check(WK, 'walk-threw', null, at, String(e && e.name), 'no throw');
        }
        try {
            const d = t.dump();
            const keys = truth.a;
            const reps = Array.from(d.reps);
            const sizes = Array.from(d.sizes);
            check(IV, 'dump.size', null, at, d.size, keys.length);
            check(IV, 'dump.keys', null, at, Array.from(d.keys).join(','), keys.join(','));
            check(IV, 'rep0', null, at, reps[0], 0);
            let asc = true;
            for (let i = 1; i < reps.length; i++) if (!(reps[i] > reps[i - 1])) asc = false;
            check(IV, 'repsAscending', null, at, asc, true);
            check(IV, 'repsEqualInnerKeys', null, at, reps.join(','), Array.from(t._x.dump().keys).join(','));
            check(IV, 'innerSize<=Cr', null, at, t._x.size <= Cr, true);
            check(IV, 'innerSize==reps', null, at, t._x.size, reps.length);
            let q = 0;
            let rangeOk = true;
            let sizeOk = true;
            for (let i = 0; i < reps.length; i++) {
                const hi = i + 1 < reps.length ? reps[i + 1] : U;
                for (let j = 0; j < sizes[i]; j++) {
                    const key = d.keys[q + j];
                    if (!(key >= reps[i] && key < hi)) rangeOk = false;
                }
                q += sizes[i];
                if (i === 0 ? sizes[i] > K : (sizes[i] < h || sizes[i] > K)) sizeOk = false;
            }
            check(IV, 'bucketKeysInRange', null, at, rangeOk, true);
            check(IV, 'bucketSizes[h,K],head<=K', null, at, sizeOk, true);
            check(MD, 'reps', null, at, reps.join(','), model.reps.join(','));
            check(MD, 'sizes', null, at, sizes.join(','), model.bks.map((b) => b.length).join(','));
            check(MD, 'splits', null, at, t._n[0], model.splits);
            check(MD, 'merges', null, at, t._n[1], model.merges);
            check(MD, 'borrows', null, at, t._n[2], model.borrows);
            layHash = fnv(layHash, reps.join(',') + '/' + sizes.join(',') + ';');
        } catch (e) {
            check(IV, 'checkpoint-threw', null, at, String(e && e.name), 'no throw');
        }
    };

    let phase = P_GROW;
    let tbI = 1;
    let sweepF = 0;
    let fillLeft = 51;
    for (let i = 0; i < nOps; i++) {
        if (i % BLOCK === 0) {
            if (i > 0) phase = nextOp() % 5;
            const d2 = nextOp();
            tbI = (d2 & 1) === 0 ? 1 : 1 + (d2 >>> 1) % 8;
            sweepF = nextOp();
        }
        const ko = nextOp() % 100;
        const bo = nextOp() % 100;
        const k1 = nextKey();
        const k2 = nextKey();
        const n = truth.a.length;
        let kind;
        let x;
        if (fillLeft > 0 && i < 8 * C + 400) {
            if (n === C && --fillLeft < 0) fillLeft = 0;
            kind = K_ADD; // FILL to C, then ~50 adds at size C (full-throws when C < U)
            x = pickAny(k1, k2);
        } else if (phase === P_TB) {
            const nb = model.bks.length;
            const tb = Math.min(tbI, nb - 1);
            if (ko >= 90) {
                kind = K_HAS + (ko % 5);
                x = pickAny(k1, k2);
            } else if (tb < 1) {
                kind = K_ADD;
                x = uni(k2);
            } else if (model.bks[tb - 1].length < K) {
                kind = K_ADD;
                const lo = model.reps[tb - 1];
                x = lo + Math.floor(k2 / 4294967296 * (model.reps[tb] - lo));
            } else {
                kind = K_DEL;
                x = model.bks[tb][k1 % model.bks[tb].length];
            }
        } else {
            let a = 30;
            let d = 55;
            if (phase === P_GROW || phase === P_CLUSTER) { a = 80; d = 85; }
            else if (phase === P_SWEEP) { a = 0; d = 80; }
            if (phase === P_SWEEP) kind = ko < 80 ? K_DEL : ko < 85 ? K_ADD : K_HAS + (ko % 5);
            else if (ko < a) kind = K_ADD;
            else if (ko < d) kind = K_DEL;
            else kind = K_HAS + (ko % 5);
            if (phase === P_SWEEP && kind === K_DEL && n > 0) {
                x = truth.a[Math.min(Math.floor(sweepF / 4294967296 * n), n - 1)];
            } else if (phase === P_CLUSTER && kind === K_ADD) {
                x = clamp(centers[(k1 >>> 5) & 7] + (k2 % (3 * K)));
            } else if (kind === K_DEL && n > 0 && (k1 >>> 29) < 5) {
                x = truth.a[k2 % n];
            } else {
                x = pickAny(k1, k2);
            }
        }
        if (kind < K_MIN && bo < 3) x = BAD[k1 % BAD.length];
        if (kind === K_MIN || kind === K_MAX) x = null;
        opCounts[kind]++;
        const got = call(t, kind, x);
        const gotX = call(xt, kind, x);
        const name = KIND_NAME[kind];
        const gs = got === t ? 'this' : show(got);
        resHash = fnv(resHash, gs + '|');
        // wantX: what the XFastTrie must return where the YFastTrie returns `want`
        const cmpAll = (want) => {
            if (sb !== null) check(RS, name, x, i, got, want.sb);
            check(RG, name, x, i, got, want.sg);
            check(RA, name, x, i, got, want.sa);
            check(RX, name, x, i, got === t ? 'this' : got, gotX === xt ? 'this' : gotX);
        };
        if (kind < K_MIN && !isKey(x, U)) {
            const want = kind === K_ADD ? RANGE_ERR : (kind === K_HAS || kind === K_DEL) ? false : undefined;
            check(CT, name, x, i, got, want);
        } else {
            const k = kind < K_MIN ? x + 0 : 0;
            if (kind === K_SUCC || kind === K_PRED) {
                if (truth.has(k)) presQ++;
                else absQ++;
            }
            if (kind === K_ADD) {
                if (truth.has(k)) {
                    check(CT, name, x, i, got, t);
                } else if (truth.a.length === C) {
                    fullThrows++;
                    check(CT, name + '-full', x, i, got, RANGE_ERR);
                    check(RX, name + '-full', x, i, gotX, RANGE_ERR);
                } else {
                    check(CT, name, x, i, got, t);
                    check(RX, name, x, i, gotX, xt);
                    truth.add(k);
                    model.add(k);
                    if (sb !== null) sb.add(k);
                    sg.set(k, 0);
                    sa.set(k, 0);
                }
            } else if (kind === K_DEL) {
                const was = truth.has(k);
                const bi = was ? model._find(k) : 0;
                const bb = model.borrows;
                check(CT, name, x, i, got, was);
                if (sb !== null) check(RS, name, x, i, got, sb.delete(k));
                check(RG, name, x, i, got, sg.delete(k));
                check(RA, name, x, i, got, sa.delete(k));
                check(RX, name, x, i, got, gotX);
                if (was) {
                    truth.del(k);
                    model.delete(k);
                    if (model.borrows !== bb && bi === 1) headBorrows++;
                }
            } else if (kind === K_HAS) {
                cmpAll({ sb: sb && sb.has(k), sg: sg.has(k), sa: sa.has(k) });
            } else if (kind === K_SUCC) {
                cmpAll({ sb: sb && sb.successor(k), sg: sg.successor(k), sa: sa.successor(k) });
            } else if (kind === K_PRED) {
                cmpAll({ sb: sb && sb.predecessor(k), sg: sg.predecessor(k), sa: sa.predecessor(k) });
            } else if (kind === K_MIN) {
                cmpAll({ sb: sb && sb.min(), sg: sg.select(0), sa: sa.min() });
            } else {
                cmpAll({ sb: sb && sb.max(), sg: sg.select(sg.size - 1), sa: sa.max() });
            }
        }
        const sz = t.size;
        check(CT, 'size', null, i, sz, truth.a.length);
        if (sb !== null) check(RS, 'size', null, i, sz, sb.size);
        check(RG, 'size', null, i, sz, sg.size);
        check(RA, 'size', null, i, sz, sa.size);
        check(RX, 'size', null, i, sz, xt.size);
        if ((i + 1) % CHECK_EVERY === 0 || i === nOps - 1) checkpoint(i);
    }
    return {
        U, C, w, K, h, nOps, seed, checkpoints, fullThrows, absQ, presQ, opCounts,
        splits: model.splits, merges: model.merges, borrows: model.borrows, headBorrows,
        engine: [t._n[0], t._n[1], t._n[2]],
        resHash, layHash, size: t.size,
        buckets: { contract: CT, SortedArray: RA, Scapegoat: RG, StratifiedBitset: sb !== null ? RS : null, XFastTrie: RX, walks: WK, invariants: IV, model: MD },
    };
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.yftJob === true) {
    let msg;
    try {
        const { src, configs } = workerData;
        const mod = src === null
            ? await import('../LogLogN.js')
            : await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
        if (typeof mod.YFastTrie !== 'function') throw new TypeError('build exports no YFastTrie');
        msg = { ok: true, result: configs.map((c) => runYft(mod, c.U, c.C, c.nOps, c.seed, c.seedArg === undefined ? 'omit' : c.seedArg)) };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
