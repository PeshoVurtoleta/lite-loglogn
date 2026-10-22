/**
 * @zakkster/lite-loglogn -- XFastTrie COUNT gate worker (B4, E11). Not a test
 * file: the npm glob `test/*.test.js` never matches it.
 *
 * Runs only as a node:worker_threads Worker (workerData.xftCountJob === true);
 * inert when merely imported (it then only exports rSquared). test/XftCount.test.js
 * starts one worker per universe U = 2^w, w in {1, 2, 4, 8, 16, 32}, under a hang
 * timer. workerData: { src (null = the shipped ../LogLogN.js, else a data: URL of
 * a mutated copy), U, seed, nOps, phases }. Posts ONE message per phase:
 *   { phase, fails: string[], rows, table: string[], ...extra }
 * (a throw inside a phase becomes a fails entry, so a mutant never kills the run).
 *
 * Counting: a Proxy is swapped into each of the 8 columns _lv _occ _tk _tmin
 * _tmax _key _next _prev AFTER construction and counts numeric-key gets / sets.
 * 1 touch = 1 `_slot` / `_put` = exactly 4 `_lv` reads (touches = _lv reads / 4,
 * divisibility asserted); <= 8 `_occ` reads per touch, = 8 on a miss; table
 * writes = _occ + _tk + _tmin + _tmax sets; thread writes = _key + _next + _prev
 * sets. clear() / dump() are never called while wrapped.
 *
 * Expected values come from PLAN-xfasttrie SPEC (3), written out in this file
 * (expAddNew / expDelete use an independent BigInt common-prefix, not the
 * engine's clz32); the random phase uses test/helpers/xftStream.mjs countModel
 * as the oracle. Exact rows need delta kicks = delta reseeds = 0 (checked per
 * row; a row that kicks FAILS, it is never loosened).
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
    SortedOracle, classify, countModel, badKeys, applyOp, mulberry32,
    ROW_NAMES,
} from './helpers/xftStream.mjs';

export const COLS = ['_lv', '_occ', '_tk', '_tmin', '_tmax', '_key', '_next', '_prev'];
const NUM = /^(0|[1-9][0-9]*)$/;

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

// --- the counting harness (8 columns) ------------------------------------------

function wrap(inst) {
    const R = [0, 0, 0, 0, 0, 0, 0, 0];
    const W = [0, 0, 0, 0, 0, 0, 0, 0];
    const real = COLS.map((c) => inst[c]);
    COLS.forEach((c, i) => {
        inst[c] = new Proxy(real[i], {
            get(t, k) {
                if (typeof k === 'string' && NUM.test(k)) R[i]++;
                return Reflect.get(t, k);
            },
            set(t, k, v) {
                if (typeof k === 'string' && NUM.test(k)) {
                    W[i]++;
                    t[k] = v;
                    return true;
                }
                return Reflect.set(t, k, v);
            },
        });
    });
    return {
        measure(fn) {
            for (let i = 0; i < 8; i++) { R[i] = 0; W[i] = 0; }
            const q = inst._q;
            const k0 = q[1];
            const r0 = q[2];
            let ret;
            let threw = null;
            try { ret = fn(); } catch (e) { threw = e; }
            return { R: R.slice(), W: W.slice(), ret, threw, dk: q[1] - k0, dr: q[2] - r0 };
        },
        unwrap() { COLS.forEach((c, i) => { inst[c] = real[i]; }); },
    };
}

function derive(m) {
    return {
        touches: m.R[0] / 4,
        tab: m.W[1] + m.W[2] + m.W[3] + m.W[4],
        thr: m.W[5] + m.W[6] + m.W[7],
        thrR: m.R[5] + m.R[6] + m.R[7],
        allW: m.W.reduce((a, b) => a + b, 0),
        allR: m.R.reduce((a, b) => a + b, 0),
    };
}

/** Independent common-prefix length of two distinct w-bit keys (0 for a missing neighbour). */
function lcp(w, a, b) {
    if (b === undefined) return 0;
    const sa = BigInt(a).toString(2).padStart(w, '0');
    const sb = BigInt(b).toString(2).padStart(w, '0');
    let i = 0;
    while (i < w && sa[i] === sb[i]) i++;
    return i;
}

function neighbours(keys, x) {
    let pred;
    let succ;
    for (const k of keys) {
        if (k < x && (pred === undefined || k > pred)) pred = k;
        if (k > x && (succ === undefined || k < succ)) succ = k;
    }
    return [pred, succ];
}

// SPEC (3): add new = 1+T+w-m touches, 4(w-l)+(l-m) table writes, 5 thread writes
function expAddNew(w, T, keys, x) {
    const [p, s] = neighbours(keys, x);
    const cp = lcp(w, x, p);
    const cs = lcp(w, x, s);
    const l = Math.max(cp, cs);
    const m = Math.min(cp, cs);
    return { t: 1 + T + w - m, tab: 4 * (w - l) + (l - m), thr: 5, m };
}

// SPEC (3): delete present = w-m touches, w-m table writes, 3 thread writes
function expDelete(w, keys, x) {
    const [p, s] = neighbours(keys, x);
    const m = Math.min(lcp(w, x, p), lcp(w, x, s));
    return { t: w - m, tab: w - m, thr: 3, m };
}

function capFor(U) {
    return Math.min(U / 2, U <= 16 ? 4 : 16);
}

function jList(w) {
    const out = [];
    for (const j of [1, w >> 1, w - 2]) {
        if (j >= 1 && j <= w - 2 && out.indexOf(j) < 0) out.push(j);
    }
    return out;
}

function snap(inst) {
    const d = inst.dump();
    return JSON.stringify({
        size: d.size, bytes: inst.byteLength, keys: Array.from(d.keys),
        levels: d.levels.map((l) => [l.capacity, Array.from(l.prefix), Array.from(l.min), Array.from(l.max)]),
    });
}

// --- exact rows ------------------------------------------------------------------

function makeCtx(Cls, U) {
    const ctx = { Cls, U, w: 32 - Math.clz32(U - 1), C: capFor(U), fails: [], rows: 0, table: [], mPos: 0 };
    ctx.T = ctx.w === 1 ? 0 : 31 - Math.clz32(ctx.w);
    return ctx;
}

function build(ctx, keys) {
    const inst = new ctx.Cls(ctx.U, ctx.C);
    for (const k of keys) inst.add(k);
    inst.has(0); // warm every hot path BEFORE the Proxies go in (a cached bypass would stay raw)
    return inst;
}

/** One exact row on a fresh instance holding `keys`. */
function row(ctx, label, keys, fn, want) {
    const inst = build(ctx, keys);
    const h = wrap(inst);
    const m = h.measure(() => fn(inst));
    h.unwrap();
    ctx.rows++;
    const d = derive(m);
    const bad = [];
    if (m.R[0] % 4 !== 0) bad.push('_lv reads ' + m.R[0] + ' not divisible by 4');
    if (d.touches !== want.t) bad.push('touches ' + d.touches + ' != ' + want.t);
    if (d.tab !== want.tab) bad.push('table writes ' + d.tab + ' != ' + want.tab);
    if (d.thr !== want.thr) bad.push('thread writes ' + d.thr + ' != ' + want.thr);
    if (m.W[0] !== 0) bad.push('_lv written ' + m.W[0]);
    if (m.R[1] > 8 * d.touches) bad.push('occ reads ' + m.R[1] + ' > 8 * ' + d.touches);
    if (m.dk !== 0 || m.dr !== 0) bad.push('kicked ' + m.dk + ' / reseeded ' + m.dr + ' (state is not exact-row clean)');
    if (want.occ !== undefined && m.R[1] !== want.occ) bad.push('occ reads ' + m.R[1] + ' != ' + want.occ);
    if (want.noThreadRead === true && d.thrR !== 0) bad.push('thread columns read ' + d.thrR + ' words');
    if (want.noWrite === true && d.allW !== 0) bad.push('writes ' + d.allW + ' != 0');
    if (want.throws === true) {
        if (!(m.threw instanceof RangeError) || !/^\[lite-loglogn\] /.test(m.threw.message)) {
            bad.push('expected RangeError [lite-loglogn], got ' + String(m.threw));
        }
    } else if (m.threw !== null) {
        bad.push('threw ' + String(m.threw));
    } else if ('ret' in want && !Object.is(m.ret, want.ret)) {
        bad.push('ret ' + String(m.ret) + ' != ' + String(want.ret));
    }
    ctx.table.push(label + ' ' + d.touches + '/' + d.tab + '/' + d.thr);
    if (bad.length > 0) ctx.fails.push('U=' + ctx.U + ' ' + label + ': ' + bad.join('; '));
    return m;
}

function exactPhase(Cls, U) {
    const ctx = makeCtx(Cls, U);
    const { w, T } = ctx;
    const Q = { t: 1 + T, tab: 0, thr: 0 };
    const ONE = { t: 1, tab: 0, thr: 0 };
    const ZERO = { t: 0, tab: 0, thr: 0 };
    const extra = {};

    // empty trie
    for (const x of w === 1 ? [0, 1] : [0, U - 1]) {
        const e = expAddNew(w, T, [], x);
        row(ctx, 'add empty ' + x, [], (t) => t.add(x), { t: e.t, tab: e.tab, thr: 5 });
    }
    {
        const m = row(ctx, 'add empty (touches)', [], (t) => t.add(U - 1), { t: 1 + T + w, tab: 4 * w, thr: 5 });
        extra.addEmpty = m.R[0] / 4;
    }
    row(ctx, 'succ absent (empty)', [], (t) => t.successor(1), { ...Q, ret: undefined });
    row(ctx, 'pred absent (empty)', [], (t) => t.predecessor(1), { ...Q, ret: undefined });
    row(ctx, 'min (empty)', [], (t) => t.min(), { ...ZERO, ret: undefined, noWrite: true });
    row(ctx, 'max (empty)', [], (t) => t.max(), { ...ZERO, ret: undefined, noWrite: true });

    // one key {0}
    row(ctx, 'has present', [0], (t) => t.has(0), { ...ONE, ret: true, noThreadRead: true });
    row(ctx, 'has absent', [0], (t) => t.has(1), { ...ONE, ret: false, occ: 8, noWrite: true, noThreadRead: true });
    row(ctx, 'succ present', [0], (t) => t.successor(0), { ...ONE, ret: undefined });
    row(ctx, 'pred present', [0], (t) => t.predecessor(0), { ...ONE, ret: undefined });
    {
        const m = row(ctx, 'succ absent', [0], (t) => t.successor(1), { ...Q, ret: undefined });
        extra.absSucc = m.R[0] / 4;
    }
    row(ctx, 'pred absent', [0], (t) => t.predecessor(1), { ...Q, ret: 0 });
    if (U - 1 > 1) {
        row(ctx, 'succ absent top', [0], (t) => t.successor(U - 1), { ...Q, ret: undefined });
        row(ctx, 'pred absent top', [0], (t) => t.predecessor(U - 1), { ...Q, ret: 0 });
    }
    row(ctx, 'min', [0], (t) => t.min(), { ...ZERO, ret: 0, noWrite: true });
    row(ctx, 'max', [0], (t) => t.max(), { ...ZERO, ret: 0, noWrite: true });
    row(ctx, 'add present', [0], (t) => t.add(0), { ...ONE, noWrite: true, noThreadRead: true });
    row(ctx, 'delete absent', [0], (t) => t.delete(1), { ...ONE, ret: false, noWrite: true, noThreadRead: true });
    row(ctx, 'delete absent (empty)', [], (t) => t.delete(1), { ...ONE, ret: false, noWrite: true });
    {
        if (ctx.C > 1) { // C = 1 (w = 1): {0} is full, add(1) is a reject (E4)
            const e = expAddNew(w, T, [0], 1);
            row(ctx, 'add new 1 | {0}', [0], (t) => t.add(1), { t: e.t, tab: e.tab, thr: 5 });
        }
        const d = expDelete(w, [0], 0);
        row(ctx, 'delete 0 | {0}', [0], (t) => t.delete(0), { t: d.t, tab: d.tab, thr: 3, ret: true });
    }
    if (w >= 2) {
        const e = expAddNew(w, T, [0], U - 1);
        row(ctx, 'add new top | {0}', [0], (t) => t.add(U - 1), { t: e.t, tab: e.tab, thr: 5 });
        const d1 = expDelete(w, [0, 1], 1);
        row(ctx, 'delete 1 | {0,1}', [0, 1], (t) => t.delete(1), { t: d1.t, tab: d1.tab, thr: 3, ret: true });
        const d0 = expDelete(w, [0, 1], 0);
        row(ctx, 'delete 0 | {0,1}', [0, 1], (t) => t.delete(0), { t: d0.t, tab: d0.tab, thr: 3, ret: true });
    }
    // m > 0: A = 0 and B = 2^(w-j)-1 share j leading zeros
    for (const j of jList(w)) {
        const B = 2 ** (w - j) - 1;
        const lo = [0, B];
        const e1 = expAddNew(w, T, lo, 1);
        row(ctx, 'add new 1 j=' + j, lo, (t) => t.add(1), { t: e1.t, tab: e1.tab, thr: 5 });
        const e2 = expAddNew(w, T, lo, B - 1);
        row(ctx, 'add new B-1 j=' + j, lo, (t) => t.add(B - 1), { t: e2.t, tab: e2.tab, thr: 5 });
        const k1 = [0, 1, B];
        const d1 = expDelete(w, k1, 1);
        row(ctx, 'delete 1 j=' + j, k1, (t) => t.delete(1), { t: d1.t, tab: d1.tab, thr: 3, ret: true });
        const k2 = [0, B - 1, B];
        const d2 = expDelete(w, k2, B - 1);
        row(ctx, 'delete B-1 j=' + j, k2, (t) => t.delete(B - 1), { t: d2.t, tab: d2.tab, thr: 3, ret: true });
        for (const e of [e1, e2, d1, d2]) if (e.m > 0) ctx.mPos++;
    }
    return { fails: ctx.fails, rows: ctx.rows, table: ctx.table, mPos: ctx.mPos,
        jCount: jList(w).length, ...extra };
}

// --- bad keys + full rejects (E4) -----------------------------------------------

function badPhase(Cls, U) {
    const ctx = makeCtx(Cls, U);
    const inst = build(ctx, [0]);
    const h = wrap(inst);
    for (const k of badKeys(U)) {
        const name = 'bad ' + (typeof k === 'bigint' ? k + 'n' : typeof k === 'string' ? '"' + k + '"' : String(k));
        const ops = [['has', false], ['delete', false], ['successor', undefined], ['predecessor', undefined], ['add', null]];
        for (const [op, want] of ops) {
            const m = h.measure(() => inst[op](k));
            const d = derive(m);
            ctx.rows++;
            if (d.allR !== 0 || d.allW !== 0) {
                ctx.fails.push('U=' + U + ' ' + name + ' ' + op + ': reads ' + d.allR + ' writes ' + d.allW + ' (want 0 / 0)');
            }
            if (op === 'add') {
                if (!(m.threw instanceof RangeError) || !/^\[lite-loglogn\] /.test(m.threw.message)) {
                    ctx.fails.push('U=' + U + ' ' + name + ' add must throw RangeError [lite-loglogn]');
                }
            } else if (m.threw !== null || !Object.is(m.ret, want)) {
                ctx.fails.push('U=' + U + ' ' + name + ' ' + op + ': ret ' + String(m.ret) + ' threw ' + String(m.threw));
            }
        }
    }
    h.unwrap();
    if (inst.size !== 1) ctx.fails.push('U=' + U + ' bad keys changed size to ' + inst.size);
    return { fails: ctx.fails, rows: ctx.rows, table: [] };
}

function e4Phase(Cls, U) {
    const ctx = makeCtx(Cls, U);
    const { C } = ctx;
    const full = [];
    for (let i = 0; i < C; i++) full.push(i);
    // full reject: add of an absent key at size === capacity
    {
        const inst = build(ctx, full);
        const before = snap(inst);
        const h = wrap(inst);
        const m = h.measure(() => inst.add(U - 1));
        h.unwrap();
        const d = derive(m);
        ctx.rows++;
        const bad = [];
        if (inst.size !== C) bad.push('not full');
        if (!(m.threw instanceof RangeError) || !/^\[lite-loglogn\] /.test(m.threw.message)) bad.push('no RangeError [lite-loglogn]');
        if (d.touches !== 1) bad.push('touches ' + d.touches + ' != 1');
        if (m.R[1] !== 8) bad.push('occ reads ' + m.R[1] + ' != 8');
        if (d.allW !== 0) bad.push('writes ' + d.allW + ' != 0 (W=' + m.W.join(',') + ')');
        if (d.thrR !== 0) bad.push('_key/_next/_prev read ' + d.thrR + ' words (want 0)');
        if (snap(inst) !== before) bad.push('dump / byteLength changed');
        ctx.table.push('full reject ' + d.touches + '/' + d.tab + '/' + d.thr);
        if (bad.length > 0) ctx.fails.push('U=' + U + ' e4 full reject: ' + bad.join('; '));
    }
    // full-but-present add returns the instance, 1 touch, no write
    row(ctx, 'e4 add present at full', full, (t) => t.add(0), { t: 1, tab: 0, thr: 0, noWrite: true });
    // bad-key add on a full instance: 0 reads, 0 writes
    {
        const inst = build(ctx, full);
        const before = snap(inst);
        const h = wrap(inst);
        const m = h.measure(() => inst.add(U));
        h.unwrap();
        const d = derive(m);
        ctx.rows++;
        const bad = [];
        if (!(m.threw instanceof RangeError)) bad.push('no RangeError');
        if (d.allR !== 0 || d.allW !== 0) bad.push('reads ' + d.allR + ' writes ' + d.allW);
        if (snap(inst) !== before) bad.push('dump / byteLength changed');
        if (bad.length > 0) ctx.fails.push('U=' + U + ' e4 bad-key reject: ' + bad.join('; '));
    }
    return { fails: ctx.fails, rows: ctx.rows, table: ctx.table };
}

// --- seeded random stream ---------------------------------------------------------

function randomPhase(Cls, U, seed, nOps) {
    const ctx = makeCtx(Cls, U);
    const { w, T, C } = ctx;
    const opRnd = mulberry32((seed ^ 0x85ebca6b) >>> 0);
    const keyRnd = mulberry32((seed + Math.imul(w, 0x9e3779b1)) >>> 0);
    const inst = new Cls(U, C);
    const oracle = new SortedOracle(U, C);
    const h = wrap(inst);
    const BAD = badKeys(U);
    const opCounts = [0, 0, 0, 0, 0, 0, 0];
    const rowCounts = new Array(ROW_NAMES.length).fill(0);
    let free = 0;
    let kicked = 0;
    let mismatches = 0;
    let kicks = 0;
    for (let n = 0; n < nOps; n++) {
        const o = Math.floor(opRnd() * 7);
        const r1 = keyRnd();
        const r2 = keyRnd();
        const r3 = keyRnd();
        const a = oracle._a;
        let x;
        if (r1 < 0.03 && o <= 4) x = BAD[Math.floor(r2 * BAD.length)];
        else if (r1 < 0.40 && a.length > 0) x = a[Math.floor(r2 * a.length)];
        else if (r1 < 0.70 && a.length > 0) {
            const base = a[Math.floor(r2 * a.length)];
            const y = (base ^ Math.floor(r3 * 256)) >>> 0;
            x = y < U ? y : base;
        } else x = Math.floor(r2 * U);
        opCounts[o]++;
        const [rw, cp, cs] = classify(oracle, w, o, x);
        rowCounts[rw]++;
        const m = h.measure(() => applyOp(inst, o, x));
        const d = derive(m);
        if (m.dk !== 0 || m.dr !== 0) {
            kicked++;
            kicks += m.dk;
        } else {
            free++;
            const [t, tw, hw] = countModel(rw, w, cp, cs, T);
            if (m.R[0] % 4 !== 0 || d.touches !== t || d.tab !== tw || d.thr !== hw ||
                m.R[1] > 8 * d.touches || m.W[0] !== 0) {
                mismatches++;
                if (ctx.fails.length < 5) {
                    ctx.fails.push('U=' + U + ' op#' + n + ' kind=' + o + ' x=' + String(x) + ' row=' + ROW_NAMES[rw] +
                        ': touches ' + d.touches + '/' + t + ' tab ' + d.tab + '/' + tw + ' thr ' + d.thr + '/' + hw);
                }
            }
        }
        try { applyOp(oracle, o, x); } catch (e) { /* the oracle's own reject */ }
    }
    h.unwrap();
    if (inst.size !== oracle.size) ctx.fails.push('U=' + U + ' size ' + inst.size + ' != oracle ' + oracle.size);
    return { fails: ctx.fails, rows: nOps, table: [], opCounts, rowCounts, free, kicked, kicks, mismatches };
}

// --- worker entry -------------------------------------------------------------------

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.xftCountJob === true) {
    const { src, U, seed, nOps, phases } = workerData;
    const mod = await import(src === null ? '../LogLogN.js' : src);
    const Cls = mod.XFastTrie;
    const bodies = {
        exact: () => exactPhase(Cls, U),
        bad: () => badPhase(Cls, U),
        e4: () => e4Phase(Cls, U),
        random: () => randomPhase(Cls, U, seed, nOps),
    };
    for (const name of phases) {
        let res;
        try {
            res = bodies[name]();
        } catch (e) {
            res = { fails: ['U=' + U + ' phase ' + name + ' threw ' + (e && e.stack ? e.stack : String(e))], rows: 0, table: [] };
        }
        parentPort.postMessage({ phase: name, ...res });
    }
}

