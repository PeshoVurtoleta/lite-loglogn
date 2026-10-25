/**
 * @zakkster/lite-loglogn -- YFastTrie COUNT gate worker (0.4.0 G1-6, A2). Not a
 * test file: the npm glob `test/*.test.js` never matches it.
 *
 * Runs only as a node:worker_threads Worker (workerData.yftCountJob === true);
 * inert when merely imported. test/YftCount.test.js starts one worker per
 * universe U = 2^w, w in {1, 2, 4, 8, 16, 32}, plus one per must-fail mutant,
 * under a hang timer. workerData: { src (null = the shipped ../LogLogN.js, else a
 * data: URL of a mutated copy), w, seed, nOps, phases }. Posts ONE message per
 * phase: { phase, fails: string[], rows, table: string[], findings: string[], ...extra }
 * (a throw inside a phase becomes a fails entry, so a mutant never kills the run).
 *
 * Counting: Proxies are swapped into the 10 columns AFTER construction -- the
 * outer `_bk` / `_bn` and the inner trie's `_lv _occ _tk _tmin _tmax _key _next
 * _prev` -- plus the inner `_q` scratch and the outer `_n` counters. A Proxy
 * counts numeric-key gets / sets; `_bk.copyWithin` is intercepted and counts the
 * words it moves (a typed-array method cannot run on a Proxy receiver; every other
 * method call on a wrapped column is itself a FAIL). 1 inner touch = 1 `_slot` /
 * `_put` = exactly 4 `_lv` reads (divisibility asserted). clear() / dump() are
 * never called while wrapped; the raw arrays are read for the kick / reseed /
 * counter deltas so the instrument never counts itself.
 *
 * Expected values: the G1 cost table of .handoff/PLAN-yfasttrie.md (CURRENT C-3,
 * C-8, C-10), evaluated on the state of the INDEPENDENT policy model YModel
 * (test/helpers/yftStream.mjs) -- never read back from the engine:
 *   lambda = 1 when x is a rep, else 1 + T (T = log2 w, w a power of 2);
 *   beta in [floor(log2(s+1)), ceil(log2(s+1))], exact at s = 2^j - 1;
 *   moves: add new s - lb, delete present s - lb - 1; split w + (s' - lb') on
 *   the half x lands in; merge s - 1; borrow (s_L - c) + (s - 1), c = ceil(t/2);
 *   inner add / delete touches 1 + T + w - m / w - m and table / thread writes
 *   4(w-l) + (l-m) / 5 and w - m / 3 (XFastTrie SPEC (3)), m / l from an
 *   independent BigInt common prefix against the model's reps.
 * Hand-traced (method semantics, not the table): one equality read when lb < s,
 * one answer read, the hop = 1 thread read + <= 1 `_bk` read, 1 `_bk` read of the
 * new rep in a split / borrow, `_bn` writes 1 / 3 / 2 / 3 (plain / split / merge /
 * borrow), `_q` writes 1 + one per inner add / delete.
 * A row whose inner trie kicks or reseeds FAILS (exact rows); the random phase
 * skips kicked ops and the test bounds them at 1%.
 * Table-literal disagreements (the cost table read additively: a split adds +w to
 * the PRE-split s - lb; a merge adds +s-1 to s - lb - 1) are posted as findings,
 * never as a re-tuned expectation; measured > the literal reading is a FAIL.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { badKeys, mulberry32 } from './helpers/xftStream.mjs';
import { YModel } from './helpers/yftStream.mjs';

/** The five keyed public methods run with every bad key. */
export const BAD_OPS = ['has', 'delete', 'successor', 'predecessor', 'add'];
/** The 10 counted columns: 2 outer + 8 inner. */
export const OUTER = ['_bk', '_bn'];
export const INNER = ['_lv', '_occ', '_tk', '_tmin', '_tmax', '_key', '_next', '_prev'];
const NUM = /^(0|[1-9][0-9]*)$/;
const WORKER_FLAG = 'yftCountJob';

// --- the counting harness -----------------------------------------------------------

function rel(n, len, dflt) {
    if (n === undefined) return dflt;
    const v = Math.trunc(Number(n));
    return v < 0 ? Math.max(len + v, 0) : Math.min(v, len);
}

function counter(real, cell, moves) {
    return new Proxy(real, {
        get(t, k) {
            if (typeof k === 'string' && NUM.test(k)) {
                cell.r++;
                return t[k];
            }
            if (k === 'copyWithin' && moves !== null) {
                return function copyWithin(target, start, end) {
                    const len = t.length;
                    const to = rel(target, len, 0);
                    const from = rel(start, len, 0);
                    const fin = rel(end, len, len);
                    const n = Math.max(0, Math.min(fin - from, len - to));
                    moves.n += n;
                    moves.calls++;
                    t.copyWithin(to, from, fin);
                    return this;
                };
            }
            const v = Reflect.get(t, k);
            if (typeof v === 'function') {
                cell.m++;
                return v.bind(t);
            }
            return v;
        },
        set(t, k, v) {
            if (typeof k === 'string' && NUM.test(k)) {
                cell.w++;
                t[k] = v;
                return true;
            }
            return Reflect.set(t, k, v);
        },
    });
}

/** Wraps the 10 columns + inner `_q` + outer `_n`. */
export function wrap(inst) {
    const x = inst._x;
    const names = [...OUTER, ...INNER, '_q', '_n'];
    const owners = names.map((c) => (OUTER.includes(c) || c === '_n' ? inst : x));
    const real = names.map((c, i) => owners[i][c]);
    const cells = names.map(() => ({ r: 0, w: 0, m: 0 }));
    const moves = { n: 0, calls: 0 };
    names.forEach((c, i) => { owners[i][c] = counter(real[i], cells[i], c === '_bk' ? moves : null); });
    const rq = real[names.indexOf('_q')];
    const rn = real[names.indexOf('_n')];
    const C = Object.fromEntries(names.map((c, i) => [c, cells[i]]));
    return {
        real: Object.fromEntries(names.map((c, i) => [c, real[i]])),
        measure(fn) {
            for (const c of cells) { c.r = 0; c.w = 0; c.m = 0; }
            moves.n = 0;
            moves.calls = 0;
            const k0 = rq[1];
            const r0 = rq[2];
            const t0 = rq[3];
            const n0 = [rn[0], rn[1], rn[2]];
            let ret;
            let threw = null;
            try { ret = fn(); } catch (e) { threw = e; }
            const sum = (list, f) => list.reduce((a, c) => a + C[c][f], 0);
            return {
                ret, threw,
                lvR: C._lv.r, lvW: C._lv.w,
                tch: C._lv.r / 4,
                bkR: C._bk.r, bkW: C._bk.w, mv: moves.n, cw: moves.calls,
                bnR: C._bn.r, bnW: C._bn.w,
                tabR: sum(['_occ', '_tk', '_tmin', '_tmax'], 'r'),
                tabW: sum(['_occ', '_tk', '_tmin', '_tmax'], 'w'),
                thrR: sum(['_key', '_next', '_prev'], 'r'),
                thrW: sum(['_key', '_next', '_prev'], 'w'),
                allR: sum([...OUTER, ...INNER], 'r'),
                allW: sum([...OUTER, ...INNER], 'w'),
                meth: sum(names, 'm'),
                qR: C._q.r, qW: C._q.w, nR: C._n.r, nW: C._n.w,
                dk: rq[1] - k0, dr: rq[2] - r0, dt: rq[3] - t0,
                dn: [rn[0] - n0[0], rn[1] - n0[1], rn[2] - n0[2]],
            };
        },
        unwrap() { names.forEach((c, i) => { owners[i][c] = real[i]; }); },
    };
}

// --- expectations (cost table on the YModel state) --------------------------------

/** Pearson r^2 of ys against xs. */
export function rSquared(xs, ys) {
    const n = xs.length;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n;
    my /= n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) * (xs[i] - mx);
        syy += (ys[i] - my) * (ys[i] - my);
    }
    return (sxy * sxy) / (sxx * syy);
}

/** [floor(log2(s+1)), ceil(log2(s+1))] by integer arithmetic (s >= 0). */
export function betaRange(s) {
    if (s === 0) return [0, 0];
    let lo = 0;
    while (2 ** (lo + 1) <= s + 1) lo++;
    let hi = 0;
    while (2 ** hi < s + 1) hi++;
    return [lo, hi];
}

/** Independent common-prefix length of two w-bit keys (0 for a missing neighbour). */
function lcp(w, a, b) {
    if (b === undefined) return 0;
    const sa = BigInt(a).toString(2).padStart(w, '0');
    const sb = BigInt(b).toString(2).padStart(w, '0');
    let i = 0;
    while (i < w && sa[i] === sb[i]) i++;
    return i;
}

function around(keys, x) {
    let p;
    let s;
    for (const k of keys) {
        if (k < x && (p === undefined || k > p)) p = k;
        if (k > x && (s === undefined || k < s)) s = k;
    }
    return [p, s];
}

/** Inner XFastTrie add of a NEW key r into the set reps (SPEC (3)). */
function innerAdd(ctx, reps, r) {
    const [p, s] = around(reps, r);
    const cp = lcp(ctx.w, r, p);
    const cs = lcp(ctx.w, r, s);
    const l = Math.max(cp, cs);
    const m = Math.min(cp, cs);
    return { t: 1 + ctx.T + ctx.w - m, tab: 4 * (ctx.w - l) + (l - m), thr: 5 };
}

/** Inner XFastTrie delete of a present key r from the set reps (SPEC (3)). */
function innerDel(ctx, reps, r) {
    const [p, s] = around(reps, r);
    const m = Math.min(lcp(ctx.w, r, p), lcp(ctx.w, r, s));
    return { t: ctx.w - m, tab: ctx.w - m, thr: 3 };
}

export function makeCtx(w) {
    const U = 2 ** w;
    return { w, U, K: 2 * w, h: Math.ceil(w / 2), T: w === 1 ? 0 : Math.log2(w), fails: [], findings: [], rows: 0, table: [] };
}

/**
 * The expected counts of op(x) on the model's CURRENT state; applies the op to
 * the model (so the model stays in lockstep). kind: query | present | full |
 * absent | plain | split | merge | borrow | bad.
 */
export function expectOp(ctx, m, op, x) {
    const { w, T, K, h } = ctx;
    const e = {
        kind: 'query', tch: 0, bk: [0, 0], mv: 0, bkW: 0, bnW: 0, tabW: 0, thrW: 0,
        hopThr: 0, qW: 1, dn: [0, 0, 0], ret: undefined, retThis: false, full: false, lit: null, s: 0, j: 0,
    };
    if (op === 'min' || op === 'max') {
        e.qW = 0;
        const hb = m.bks[0];
        if (op === 'min') {
            const hit = hb.length > 0 ? 1 : (m.bks.length > 1 ? 1 : 0);
            e.bk = [hit, hit];
            e.hopThr = hb.length > 0 ? 0 : 1;
            e.ret = m.min();
        } else {
            const last = m.bks[m.bks.length - 1];
            const hit = last.length > 0 ? 1 : 0;
            e.bk = [hit, hit];
            e.hopThr = 1;
            e.ret = m.max();
        }
        return e;
    }
    const i = m._find(x);
    const b = m.bks[i];
    const s = b.length;
    const j = YModel.lb(b, x);
    const lam = m.reps[i] === x ? 1 : 1 + T;
    const [blo, bhi] = betaRange(s);
    const eq = j < s ? 1 : 0;
    const present = eq === 1 && b[j] === x;
    const bk = (extra) => [blo + extra, bhi + extra];
    e.tch = lam;
    e.s = s;
    e.j = j;
    if (op === 'has') {
        e.bk = bk(eq);
        e.ret = present;
        return e;
    }
    if (op === 'successor') {
        const jj = j + (present ? 1 : 0);
        let extra = eq;
        if (jj < s) extra++;
        else {
            e.hopThr = 1;
            if (i + 1 < m.bks.length) extra++;
        }
        e.bk = bk(extra);
        e.ret = m.successor(x);
        return e;
    }
    if (op === 'predecessor') {
        let extra = 0;
        if (j > 0) extra++;
        else {
            e.hopThr = 1;
            if (i > 0 && m.bks[i - 1].length > 0) extra++;
        }
        e.bk = bk(extra);
        e.ret = m.predecessor(x);
        return e;
    }
    if (op === 'add') {
        e.retThis = true;
        if (present) {
            e.kind = 'present';
            e.bk = bk(1);
            return e;
        }
        if (m.size === m.capacity) {
            e.kind = 'full';
            e.full = true;
            e.bk = bk(eq);
            return e;
        }
        if (s === K) {
            const rep = b[w];
            const ia = innerAdd(ctx, m.reps, rep);
            const side = x < rep ? b.slice(0, w) : b.slice(w);
            const pos = YModel.lb(side, x);
            e.kind = 'split';
            e.tch = lam + ia.t;
            e.bk = bk(eq + 1);
            e.mv = w + (side.length - pos);
            e.lit = (s - j) + w;
            e.bkW = 1;
            e.bnW = 3;
            e.tabW = ia.tab;
            e.thrW = ia.thr;
            e.qW = 2;
            e.dn = [1, 0, 0];
        } else {
            e.kind = 'plain';
            e.bk = bk(eq);
            e.mv = s - j;
            e.bkW = 1;
            e.bnW = 1;
        }
        const before = [m.splits, m.merges, m.borrows];
        m.add(x);
        crossKind(ctx, e, m, before);
        return e;
    }
    // delete
    if (!present) {
        e.kind = 'absent';
        e.bk = bk(eq);
        e.ret = false;
        return e;
    }
    e.ret = true;
    if (i > 0 && s <= h) {
        const L = m.bks[i - 1];
        const sl = L.length;
        const rep = m.reps[i];
        if (sl + s - 1 <= K) {
            const id = innerDel(ctx, m.reps, rep);
            e.kind = 'merge';
            e.tch = lam + id.t;
            e.bk = bk(1);
            e.mv = s - 1;
            e.lit = (s - j - 1) + (s - 1);
            e.bnW = 2;
            e.tabW = id.tab;
            e.thrW = id.thr;
            e.qW = 2;
            e.dn = [0, 1, 0];
        } else {
            const t = sl + s - 1;
            const c = Math.ceil(t / 2);
            const nr = L[c];
            const ia = innerAdd(ctx, m.reps, nr);
            const id = innerDel(ctx, [...m.reps, nr], rep);
            e.kind = 'borrow';
            e.tch = lam + ia.t + id.t;
            e.bk = bk(2);
            e.mv = (sl - c) + (s - 1);
            e.lit = 2 * w;
            e.bnW = 3;
            e.tabW = ia.tab + id.tab;
            e.thrW = ia.thr + id.thr;
            e.qW = 3;
            e.dn = [0, 0, 1];
            e.fromHead = i - 1 === 0;
        }
    } else {
        e.kind = 'plain';
        e.bk = bk(1);
        e.mv = s - j - 1;
        e.bnW = 1;
    }
    const before = [m.splits, m.merges, m.borrows];
    m.delete(x);
    crossKind(ctx, e, m, before);
    return e;
}

/** The model's own counters must agree with the kind the table evaluation picked. */
function crossKind(ctx, e, m, before) {
    const d = [m.splits - before[0], m.merges - before[1], m.borrows - before[2]];
    if (d.join() !== e.dn.join()) {
        ctx.fails.push('expectation bug: kind ' + e.kind + ' but YModel counters moved ' + d.join(','));
    }
}

const isRo = (e) => e.kind === 'query' || e.kind === 'present' || e.kind === 'full' || e.kind === 'absent';

/**
 * Compares one measured op with its expectation. base = the has(x) measurement
 * on the same state just before (locate thread reads), or null for min / max.
 * Returns the list of mismatch strings (empty = exact).
 */
export function compare(ctx, e, mm, base, inst) {
    const bad = [];
    const { w } = ctx;
    if (mm.lvR % 4 !== 0) bad.push('_lv reads ' + mm.lvR + ' not divisible by 4');
    if (mm.tch !== e.tch) bad.push('touches ' + mm.tch + ' != ' + e.tch);
    if (mm.bkR < e.bk[0] || mm.bkR > e.bk[1]) bad.push('_bk reads ' + mm.bkR + ' not in [' + e.bk[0] + ', ' + e.bk[1] + ']');
    if (mm.mv !== e.mv) bad.push('moves ' + mm.mv + ' != ' + e.mv);
    if (mm.bkW !== e.bkW) bad.push('_bk key writes ' + mm.bkW + ' != ' + e.bkW);
    if (mm.bnW !== e.bnW) bad.push('_bn writes ' + mm.bnW + ' != ' + e.bnW);
    if (mm.tabW !== e.tabW) bad.push('inner table writes ' + mm.tabW + ' != ' + e.tabW);
    if (mm.thrW !== e.thrW) bad.push('inner thread writes ' + mm.thrW + ' != ' + e.thrW);
    if (mm.lvW !== 0) bad.push('_lv written ' + mm.lvW);
    if (mm.qW !== e.qW) bad.push('_q writes ' + mm.qW + ' != ' + e.qW);
    if (mm.meth !== 0) bad.push('a typed-array method other than _bk.copyWithin ran ' + mm.meth + 'x on a column');
    if (mm.dn.join() !== e.dn.join()) bad.push('_n deltas ' + mm.dn.join(',') + ' != ' + e.dn.join(','));
    if (mm.nW !== e.dn[0] + e.dn[1] + e.dn[2]) bad.push('_n writes ' + mm.nW);
    if (isRo(e) && (mm.allW !== 0 || mm.nW !== 0)) bad.push('read-only op wrote ' + mm.allW + ' column words');
    if (isRo(e) && mm.mv !== 0) bad.push('read-only op moved ' + mm.mv);
    if (e.kind !== 'split' && e.kind !== 'merge' && e.kind !== 'borrow') {
        const thr = mm.thrR - (base === null ? 0 : base.thrR);
        if (thr !== e.hopThr) bad.push('hop thread reads ' + thr + ' != ' + e.hopThr);
    }
    // C-8 / C-10 work bounds
    const restr = e.kind === 'split' || e.kind === 'merge' || e.kind === 'borrow';
    if (!restr && mm.mv > 2 * w - 1) bad.push('plain update moved ' + mm.mv + ' > 2w-1 = ' + (2 * w - 1) + ' (C-8)');
    if (restr && mm.mv > 2 * w) bad.push(e.kind + ' moved ' + mm.mv + ' > 2w = ' + 2 * w + ' (C-10)');
    if (e.lit !== null && mm.mv > e.lit) bad.push(e.kind + ' moved ' + mm.mv + ' > the table-literal ' + e.lit);
    if (mm.dk !== 0 || mm.dr !== 0) bad.push('kicked ' + mm.dk + ' / reseeded ' + mm.dr);
    if (e.full) {
        if (!(mm.threw instanceof RangeError) || !/YFastTrie is full/.test(mm.threw.message)) {
            bad.push('expected RangeError /YFastTrie is full/, got ' + String(mm.threw));
        }
    } else if (mm.threw !== null) {
        bad.push('threw ' + String(mm.threw));
    } else if (e.retThis) {
        if (mm.ret !== inst) bad.push('add did not return this');
    } else if (!Object.is(mm.ret, e.ret)) {
        bad.push('ret ' + String(mm.ret) + ' != ' + String(e.ret));
    }
    return bad;
}

/** Literal-table findings for one exact row (never a FAIL unless measured > literal). */
function literalFinding(ctx, label, e, mm) {
    if (e.lit === null || e.kind === 'borrow') return;
    if (mm.mv !== e.lit) {
        ctx.findings.push('w=' + ctx.w + ' ' + label + ': ' + e.kind + ' moves ' + mm.mv + ' (s=' + e.s + ', lb=' + e.j +
            '); the table read additively gives ' + e.lit);
    }
}

// --- states --------------------------------------------------------------------------

/** A model holding the plan (k >= 0 = add k, k < 0 = delete -1 - k). */
function modelOf(ctx, C, keys) {
    const m = new YModel(ctx.U, C);
    for (const k of keys) {
        if (k >= 0) m.add(k);
        else m.delete(-1 - k);
    }
    return m;
}

/** A fresh instance + model replaying the plan; the engine layout must equal the model's. */
function build(Cls, ctx, C, keys) {
    const inst = new Cls(ctx.U, C);
    for (const k of keys) {
        if (k >= 0) inst.add(k);
        else inst.delete(-1 - k);
    }
    const m = modelOf(ctx, C, keys);
    // warm every hot path BEFORE the Proxies go in
    inst.has(0);
    inst.successor(0);
    inst.predecessor(0);
    inst.min();
    inst.max();
    const d = inst.dump();
    const sizes = m.bks.map((b) => b.length);
    if (Array.from(d.reps).join() !== m.reps.join() || Array.from(d.sizes).join() !== sizes.join()) {
        ctx.fails.push('w=' + ctx.w + ' build: engine layout reps ' + Array.from(d.reps) + ' / ' + Array.from(d.sizes) +
            ' != model ' + m.reps + ' / ' + sizes);
    }
    return { inst, m };
}

const range = (a, n, step = 1) => Array.from({ length: n }, (_, i) => a + i * step);

/** One exact row on a fresh instance + model holding keys; want = the kind the row must be. */
function row(Cls, ctx, label, C, keys, op, x, want) {
    const { inst, m } = build(Cls, ctx, C, keys);
    const hw = wrap(inst);
    const keyed = op !== 'min' && op !== 'max';
    const base = keyed ? hw.measure(() => inst.has(x)) : null;
    const e = expectOp(ctx, m, op, x);
    const mm = hw.measure(() => (keyed ? inst[op](x) : inst[op]()));
    hw.unwrap();
    ctx.rows++;
    const bad = compare(ctx, e, mm, base, inst);
    if (want !== undefined && e.kind !== (want === 'borrow-head' ? 'borrow' : want)) bad.push('construction: the row is ' + e.kind + ', not ' + want);
    if (want === 'borrow-head' && e.fromHead !== true) bad.push('construction: not a borrow from the head');
    literalFinding(ctx, label, e, mm);
    ctx.table.push(label + ' ' + e.kind + ' t' + mm.tch + ' r' + mm.bkR + ' mv' + mm.mv);
    if (bad.length > 0) ctx.fails.push('w=' + ctx.w + ' ' + label + ': ' + bad.join('; '));
    return { e, mm };
}

/** keys holding bucket i of the model at exactly K keys, then bucket i+1 shrunk to h (non-head borrow / merge). */
function shrinkPlan(ctx, C, seedKeys, fillLeft) {
    const m = new YModel(ctx.U, C);
    for (const k of seedKeys) m.add(k);
    const i = 2;
    if (m.bks.length <= i + 0) return null;
    const keys = seedKeys.slice();
    if (fillLeft) {
        const lo = m.reps[i - 1];
        const hi = m.reps[i];
        for (let k = lo; k < hi && m.bks[i - 1].length < ctx.K; k++) {
            if (!m.has(k)) {
                m.add(k);
                keys.push(k);
            }
        }
        if (m.bks[i - 1].length !== ctx.K) return null;
    }
    while (m.bks[i].length > ctx.h) {
        const b = m.bks[i];
        const k = b[b.length - 1];
        m.delete(k);
        keys.push(-1 - k); // a negative entry = delete
    }
    return { keys, target: m.bks[i] };
}

// --- phases ---------------------------------------------------------------------------

export function exactPhase(Cls, w) {
    const ctx = makeCtx(w);
    const { U, K, h } = ctx;
    const Cbig = Math.min(U, 16 * K);
    const extra = {};
    const s1 = 2 * w - 1;
    // E0 empty
    row(Cls, ctx, 'has 0 (empty)', Cbig, [], 'has', 0, 'query');
    row(Cls, ctx, 'has top (empty)', Cbig, [], 'has', U - 1, 'query');
    row(Cls, ctx, 'succ 0 (empty)', Cbig, [], 'successor', 0, 'query');
    row(Cls, ctx, 'pred top (empty)', Cbig, [], 'predecessor', U - 1, 'query');
    row(Cls, ctx, 'min (empty)', Cbig, [], 'min', 0, 'query');
    row(Cls, ctx, 'max (empty)', Cbig, [], 'max', 0, 'query');
    row(Cls, ctx, 'delete absent (empty)', Cbig, [], 'delete', U - 1, 'absent');
    row(Cls, ctx, 'add new top (empty)', Cbig, [], 'add', U - 1, 'plain');
    // E1 head {0 .. 2w-2}, s = 2w-1 (2^j - 1: beta exact)
    const E1 = range(0, s1);
    row(Cls, ctx, 'has rep 0', Cbig, E1, 'has', 0, 'query');
    if (s1 >= 2) row(Cls, ctx, 'has present 1', Cbig, E1, 'has', 1, 'query');
    row(Cls, ctx, 'has absent 2w-1', Cbig, E1, 'has', s1, 'query');
    row(Cls, ctx, 'add present 0', Cbig, E1, 'add', 0, 'present');
    row(Cls, ctx, 'delete absent 2w-1', Cbig, E1, 'delete', s1, 'absent');
    {
        const r = row(Cls, ctx, 'succ absent 2w-1 (headline)', Cbig, E1, 'successor', s1, 'query');
        extra.absSucc = { tch: r.mm.tch, probes: r.mm.bkR, sum: r.mm.tch + r.mm.bkR };
    }
    row(Cls, ctx, 'succ rep 0', Cbig, E1, 'successor', 0, 'query');
    row(Cls, ctx, 'pred absent 2w-1', Cbig, E1, 'predecessor', s1, 'query');
    row(Cls, ctx, 'pred rep 0', Cbig, E1, 'predecessor', 0, 'query');
    row(Cls, ctx, 'min', Cbig, E1, 'min', 0, 'query');
    row(Cls, ctx, 'max', Cbig, E1, 'max', 0, 'query');
    if (s1 < U) row(Cls, ctx, 'add new 2w-1 at the end', Cbig, E1, 'add', s1, 'plain');
    // E2 head {1 .. 2w-1}: the plain-add worst case (2w-1 moves)
    const E2 = range(1, s1);
    {
        const r = row(Cls, ctx, 'add new 0 at the front (2w-1 moves)', Cbig, E2, 'add', 0, 'plain');
        extra.plainAddMoves = r.mm.mv;
    }
    row(Cls, ctx, 'delete 1 at the front', Cbig, E2, 'delete', 1, 'plain');
    row(Cls, ctx, 'succ rep 0 (key absent)', Cbig, E2, 'successor', 0, 'query');
    row(Cls, ctx, 'pred 1 (head start)', Cbig, E2, 'predecessor', 1, 'query');
    // E3 head {0 .. K-1} (s = K): the plain-delete worst case (2w-1 moves)
    const E3 = range(0, K);
    {
        const r = row(Cls, ctx, 'delete 0 of a full head (2w-1 moves)', Cbig, E3, 'delete', 0, 'plain');
        extra.plainDelMoves = r.mm.mv;
    }
    row(Cls, ctx, 'has K-1 (full head)', Cbig, E3, 'has', K - 1, 'query');
    // full rejects
    if (K < U) {
        row(Cls, ctx, 'full reject into a K-key bucket', K, E3, 'add', K, 'full');
        row(Cls, ctx, 'add present at full', K, E3, 'add', 0, 'present');
    }
    row(Cls, ctx, 'full reject C=1', 1, [0], 'add', 1, 'full');
    row(Cls, ctx, 'min (C=1 full)', 1, [0], 'min', 0, 'query');
    extra.split = 0;
    extra.merge = 0;
    extra.borrow = 0;
    extra.maxRestrMoves = 0;
    if (w >= 4) {
        const ev = range(0, K, 2);
        const od = range(1, K, 2);
        const rows = [
            ['split, x right at the end', E3, K],
            ['split, x left at index 1', ev, 1],
            ['split, x = rep 0 left at index 0 (2w moves)', od, 0],
            ['split, x right just past the new rep', ev, 2 * w + 1],
        ];
        for (const [label, keys, x] of rows) {
            const r = row(Cls, ctx, label, Cbig, keys, 'add', x, 'split');
            extra.split++;
            extra.maxRestrMoves = Math.max(extra.maxRestrMoves, r.mm.mv);
        }
        // merge into the head: head [0..w-1], R [w..K] shrunk to h
        const mergeKeys = [...E3, K];
        for (let k = K; k > w + h - 1; k--) mergeKeys.push(-1 - k);
        for (const [label, x] of [['merge, delete the rep key', w], ['merge, delete the last key', w + h - 1],
            ['merge, delete index 1', w + 1]]) {
            if (x > w + h - 1) continue;
            const r = row(Cls, ctx, label, Cbig, mergeKeys, 'delete', x, 'merge');
            extra.merge++;
            extra.maxRestrMoves = Math.max(extra.maxRestrMoves, r.mm.mv);
        }
        // borrow from the head: stride-2 keys, split at 2K-1, odd keys fill the head to K
        const bh = [...ev, 2 * K - 1, ...range(1, w, 2)];
        bh.push(-1 - (2 * K - 1));
        for (let k = 2 * K - 2; k > 2 * w + 2 * (h - 1); k -= 2) bh.push(-1 - k);
        for (const [label, x] of [['borrow from the head, delete the rep key', 2 * w],
            ['borrow from the head, delete the last key', 2 * w + 2 * (h - 1)]]) {
            const r = row(Cls, ctx, label, Cbig, bh, 'delete', x, 'borrow-head');
            extra.borrow++;
            extra.maxRestrMoves = Math.max(extra.maxRestrMoves, r.mm.mv);
        }
        // non-head left neighbour (w >= 8: stride-2 keys from 0, 3K of them)
        if (6 * K - 2 < U) {
            const seed = range(0, 3 * K, 2);
            const pb = shrinkPlan(ctx, Cbig, seed, true);
            const pm = shrinkPlan(ctx, Cbig, seed, false);
            if (pb === null || pm === null) ctx.fails.push('w=' + w + ' non-head borrow / merge state could not be built');
            else {
                let r = row(Cls, ctx, 'borrow from a non-head bucket', Cbig, pb.keys, 'delete', pb.target[0], 'borrow');
                if (r.e.fromHead !== false) ctx.fails.push('w=' + w + ' non-head borrow row borrowed from the head');
                extra.borrow++;
                extra.maxRestrMoves = Math.max(extra.maxRestrMoves, r.mm.mv);
                r = row(Cls, ctx, 'merge into a non-head bucket', Cbig, pm.keys, 'delete', pm.target[1], 'merge');
                extra.merge++;
                extra.maxRestrMoves = Math.max(extra.maxRestrMoves, r.mm.mv);
            }
        }
    }
    return { fails: ctx.fails, rows: ctx.rows, table: ctx.table, findings: ctx.findings, ...extra };
}

export function badPhase(Cls, w) {
    const ctx = makeCtx(w);
    const { U, K } = ctx;
    const keys = K < U ? range(0, K + 1) : [0];
    const { inst } = build(Cls, ctx, Math.min(U, 16 * K), keys);
    const size0 = inst.size;
    const hw = wrap(inst);
    for (const k of badKeys(U)) {
        const name = 'bad ' + (typeof k === 'bigint' ? k + 'n' : typeof k === 'string' ? '"' + k + '"' : String(k));
        const WANT = { has: false, delete: false, successor: undefined, predecessor: undefined };
        for (const op of BAD_OPS) {
            const mm = hw.measure(() => inst[op](k));
            ctx.rows++;
            if (mm.allR !== 0 || mm.allW !== 0 || mm.qR !== 0 || mm.qW !== 0 || mm.nR !== 0 || mm.nW !== 0 ||
                mm.mv !== 0 || mm.meth !== 0) {
                ctx.fails.push('w=' + w + ' ' + name + ' ' + op + ': reads ' + mm.allR + ' writes ' + mm.allW +
                    ' _q reads ' + mm.qR + ' _q writes ' + mm.qW + ' _n ' + mm.nR + '/' + mm.nW + ' moves ' + mm.mv +
                    ' (want all 0 on the 10 columns + _q + _n)');
            }
            if (op === 'add') {
                if (!(mm.threw instanceof RangeError) || !/^\[lite-loglogn\] /.test(mm.threw.message)) {
                    ctx.fails.push('w=' + w + ' ' + name + ' add must throw RangeError [lite-loglogn]');
                }
            } else if (mm.threw !== null || !Object.is(mm.ret, WANT[op])) {
                ctx.fails.push('w=' + w + ' ' + name + ' ' + op + ': ret ' + String(mm.ret) + ' threw ' + String(mm.threw));
            }
        }
    }
    hw.unwrap();
    if (inst.size !== size0) ctx.fails.push('w=' + w + ' bad keys changed size');
    return { fails: ctx.fails, rows: ctx.rows, table: [], findings: [] };
}

export function randomPhase(Cls, w, seed, nOps) {
    const ctx = makeCtx(w);
    const { U, K } = ctx;
    const C = Math.min(U, 8 * K);
    const span = Math.min(U, 3 * C);
    const lo = w === 32 ? 2147483648 - Math.floor(span / 2) : U - span;
    const opRnd = mulberry32((seed ^ 0x2545f491) >>> 0);
    const keyRnd = mulberry32((seed + Math.imul(w, 0x9e3779b1)) >>> 0);
    const inst = new Cls(U, C);
    const m = new YModel(U, C);
    inst.has(0);
    const hw = wrap(inst);
    const BAD = badKeys(U);
    const kinds = Object.create(null);
    let free = 0;
    let kicked = 0;
    let mismatches = 0;
    let maxPlain = 0;
    let maxRestr = 0;
    let maxTries = 0;
    let fromHead = 0;
    let center = lo;
    const win = Math.max(1, Math.floor(span / 6));
    for (let n = 0; n < nOps; n++) {
        // 300-op cycles: grow a window, then drain the window half a step to its right
        // (a dense left neighbour next to a drained bucket is what borrows)
        const grow = n % 300 < 150;
        if (n % 300 === 0) center = lo + Math.floor(keyRnd() * span);
        const dc = grow ? center : center + (win >> 1);
        const r = opRnd();
        let op;
        if (r < (grow ? 0.55 : 0.15)) op = 'add';
        else if (r < 0.70) op = 'delete';
        else if (r < 0.78) op = 'has';
        else if (r < 0.86) op = 'successor';
        else if (r < 0.94) op = 'predecessor';
        else if (r < 0.97) op = 'min';
        else op = 'max';
        const r1 = keyRnd();
        const r2 = keyRnd();
        let x;
        const all = [];
        if (op === 'delete' && r1 < 0.85 && m.size > 0) {
            // clustered drain: a present key in [center, center + win) when there is one
            for (const b of m.bks) for (const k of b) if (k >= dc && k < dc + win) all.push(k);
            if (all.length === 0) for (const b of m.bks) for (const k of b) all.push(k);
            x = all[Math.floor(r2 * all.length)];
        } else if (op === 'add' && r1 < 0.7) {
            x = lo + ((center - lo + Math.floor(r2 * win)) % span);
        } else if (r1 < 0.02 && op !== 'min' && op !== 'max') {
            x = BAD[Math.floor(r2 * BAD.length)];
        } else {
            x = lo + Math.floor(r2 * span);
        }
        const keyed = op !== 'min' && op !== 'max';
        const isBad = keyed && !(typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < U);
        if (isBad) {
            const mm = hw.measure(() => inst[op](x));
            kinds.bad = (kinds.bad || 0) + 1;
            if (mm.allR + mm.allW + mm.qR + mm.qW + mm.nW + mm.mv !== 0) {
                mismatches++;
                if (ctx.fails.length < 5) ctx.fails.push('w=' + w + ' op#' + n + ' bad key ' + String(x) + ' touched a column');
            }
            free++;
            continue;
        }
        const base = keyed ? hw.measure(() => inst.has(x)) : null;
        const e = expectOp(ctx, m, op, x);
        const mm = hw.measure(() => (keyed ? inst[op](x) : inst[op]()));
        kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        if (e.kind === 'borrow' && e.fromHead) fromHead++;
        maxTries = Math.max(maxTries, mm.dt);
        if (mm.dr > 1 || mm.dt > 32) {
            mismatches++;
            if (ctx.fails.length < 5) ctx.fails.push('w=' + w + ' op#' + n + ' reseedOps ' + mm.dr + ' tries ' + mm.dt + ' (C-10: <= 1 / <= 32)');
        }
        if (mm.dk !== 0 || mm.dr !== 0) {
            kicked++;
            continue;
        }
        free++;
        const restr = e.kind === 'split' || e.kind === 'merge' || e.kind === 'borrow';
        if (restr) maxRestr = Math.max(maxRestr, mm.mv);
        else maxPlain = Math.max(maxPlain, mm.mv);
        const bad = compare(ctx, e, mm, base, inst);
        if (bad.length > 0) {
            mismatches++;
            if (ctx.fails.length < 5) ctx.fails.push('w=' + w + ' op#' + n + ' ' + op + '(' + x + ') ' + e.kind + ': ' + bad.join('; '));
        }
    }
    hw.unwrap();
    const d = inst.dump();
    if (d.size !== m.size || Array.from(d.reps).join() !== m.reps.join()) {
        ctx.fails.push('w=' + w + ' final layout differs from the model');
    }
    return {
        fails: ctx.fails, rows: nOps, table: [], findings: [], kinds, free, kicked, mismatches,
        maxPlain, maxRestr, maxTries, fromHead, n: [inst._n[0], inst._n[1], inst._n[2]],
    };
}

/**
 * C-7: a split / borrow whose inner add stalls (the REAL _rebuild -> _undo path:
 * the first `_put` of the inner add calls `_rebuild`, `_fill` fails all 32
 * tries) throws the inner RangeError with the set unchanged: 0 writes on `_bk`,
 * `_bn`, `_n`; dump, `_n`, inner keys and `_lv` unchanged; reseedOps +1, tries
 * +32 (C-10); the retried op then matches the model.
 */
/** dump() as comparable text; a throwing dump (a broken invariant) is its own text. */
function dumpText(inst) {
    try {
        return JSON.stringify(inst.dump(), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
    } catch (e) {
        return 'dump threw: ' + String(e && e.message);
    }
}

export function stallPhase(Cls, Xcls, w) {
    const ctx = makeCtx(w);
    const { U, K, h } = ctx;
    const Cbig = Math.min(U, 16 * K);
    const cases = [];
    if (w >= 4) {
        cases.push(['split', range(0, K), 'add', K]);
        const ev = range(0, K, 2);
        const bh = [...ev, 2 * K - 1, ...range(1, w, 2)];
        bh.push(-1 - (2 * K - 1));
        for (let k = 2 * K - 2; k > 2 * w + 2 * (h - 1); k -= 2) bh.push(-1 - k);
        cases.push(['borrow from the head', bh, 'delete', 2 * w]);
        if (6 * K - 2 < U) {
            const pb = shrinkPlan(ctx, Cbig, range(0, 3 * K, 2), true);
            if (pb !== null) cases.push(['borrow from a non-head bucket', pb.keys, 'delete', pb.target[0]]);
            else ctx.fails.push('w=' + w + ' stall: non-head borrow state could not be built');
        }
    }
    const out = [];
    for (const [label, keys, op, x] of cases) {
        const { inst, m } = build(Cls, ctx, Cbig, keys);
        const e = expectOp(ctx, modelOf(ctx, Cbig, keys), op, x);
        const d0 = dumpText(inst);
        const n0 = Array.from(inst._n).join();
        const ik0 = Array.from(inst._x.dump().keys).join();
        const lv0 = Array.from(inst._x._lv).join();
        const x0 = inst._x;
        let puts = 0;
        let fills = 0;
        x0._put = function (L, f) {
            if (puts++ === 0) {
                this._rebuild(L, f);
                return;
            }
            Xcls.prototype._put.call(this, L, f);
        };
        x0._fill = function (L) {
            if (fills++ < 32) return false;
            return Xcls.prototype._fill.call(this, L);
        };
        const hw = wrap(inst);
        const mm = hw.measure(() => inst[op](x));
        hw.unwrap();
        delete x0._put;
        delete x0._fill;
        ctx.rows++;
        const bad = [];
        if (e.kind !== (label === 'split' ? 'split' : 'borrow')) bad.push('construction: the row is ' + e.kind);
        if (!(mm.threw instanceof RangeError) || !/could not place/.test(mm.threw.message) || /YFastTrie/.test(mm.threw.message)) {
            bad.push('expected the inner RangeError /could not place/ passed through, got ' + String(mm.threw));
        }
        if (mm.bkW !== 0 || mm.mv !== 0 || mm.bnW !== 0 || mm.nW !== 0) {
            bad.push('outer writes: _bk ' + mm.bkW + ' moves ' + mm.mv + ' _bn ' + mm.bnW + ' _n ' + mm.nW + ' (want 0)');
        }
        if (mm.dr !== 1 || mm.dt !== 32) bad.push('reseedOps +' + mm.dr + ' tries +' + mm.dt + ' (want +1 / +32)');
        if (dumpText(inst) !== d0) bad.push('dump changed');
        if (Array.from(inst._n).join() !== n0) bad.push('_n changed');
        if (Array.from(inst._x.dump().keys).join() !== ik0) bad.push('inner keys changed');
        if (Array.from(inst._x._lv).join() !== lv0) bad.push('_lv changed');
        if (inst._x._q === null) bad.push('inner poisoned');
        // the retried op runs clean and lands on the model's layout
        if (bad.length === 0) {
            let err = null;
            try { inst[op](x); } catch (er) { err = er; }
            m[op](x);
            const d = err === null ? inst.dump() : null;
            if (err !== null || Array.from(d.reps).join() !== m.reps.join() ||
                Array.from(d.sizes).join() !== m.bks.map((b) => b.length).join()) {
                bad.push('retry after the stall: ' + (err !== null ? String(err) : 'layout != model'));
            }
        }
        out.push(label + ' moves ' + mm.mv + ' _bn ' + mm.bnW + ' tries ' + mm.dt);
        if (bad.length > 0) ctx.fails.push('w=' + w + ' stall in ' + label + ': ' + bad.join('; '));
    }
    return { fails: ctx.fails, rows: ctx.rows, table: out, findings: [], cases: cases.length };
}

// --- worker entry ------------------------------------------------------------------------

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData[WORKER_FLAG] === true) {
    const { src, w, seed, nOps, phases } = workerData;
    const mod = await import(src === null ? '../LogLogN.js' : src);
    const bodies = {
        exact: () => exactPhase(mod.YFastTrie, w),
        bad: () => badPhase(mod.YFastTrie, w),
        random: () => randomPhase(mod.YFastTrie, w, seed, nOps),
        stall: () => stallPhase(mod.YFastTrie, mod.XFastTrie, w),
    };
    for (const name of phases) {
        let res;
        try {
            res = bodies[name]();
        } catch (e) {
            res = { fails: ['w=' + w + ' phase ' + name + ' threw ' + (e && e.stack ? e.stack : String(e))], rows: 0, table: [], findings: [] };
        }
        parentPort.postMessage({ phase: name, ...res });
    }
}
