/**
 * @zakkster/lite-loglogn -- vEBTree COUNT gate worker (0.5.0 G1-B5, PLAN-vebtree
 * task 7, ASSERTION A3). Not a test file: the npm glob `test/*.test.js` never
 * matches it. Runs only as a node:worker_threads Worker (workerData.vebCountJob ===
 * true); inert when merely imported.
 *
 * workerData: { vebCountJob: true, src (null = the shipped ../LogLogN.js, else a
 * data: URL of a mutated copy), seed, units: [{ U, phases: string[], nOps }] }.
 * Posts { phase: 'loaded' } once the engine module is imported, then ONE message
 * per unit phase: { phase: '<U>:<name>', fails: string[], rows, ...extra } (a throw
 * inside a phase becomes a fails entry). C-19: a mutant can corrupt state so that
 * a leaf scan runs off `_t` forever -- the parent's kill timer is the only exit.
 *
 * Counting (wrap): Proxies are swapped into `_t`, `_g` and `_p` of a constructed
 * instance (after the ctor and `_init`) and count numeric-index gets (reads) and
 * sets (writes) per column; any other function-valued property read through a
 * wrapped column is counted as `meth` and is a FAIL (a typed-array method cannot
 * run on a Proxy receiver). clear() is never called while wrapped.
 *
 * Expected values: test/helpers/vebCost.mjs walking the INDEPENDENT reference
 * VebRef (test/helpers/vebRef.mjs) with the C-12 / C-18 read orders -- never read
 * back from the engine. The A3 literal table (the planner's numbers) is held by
 * VebCount.test.js and checked against BOTH the engine and vebCost.
 * The StratifiedBitset side of the A3 loss row reuses test/_count-worker.mjs's
 * counting harness (makeWrapped) unchanged.
 *
 * Phases per unit:
 *   a3     -- the A3 rows at U = 2^w (min / max empty + nonempty, successor(0) on
 *             {U-1}, predecessor(U-1) on {0}, successor(0) on {0, 65535}, has(5)
 *             on {0,5,6,U-1}, has(6) on {0,5,6,7,U-1}, successor(5) on
 *             {0,5,6,65535}): posts rows [label, measured, expected] for the parent.
 *   sb     -- the same rows on StratifiedBitset (R only, its harness).
 *   bad    -- every bad key x every keyed op on an empty and a 2-key state: 0 / 0
 *             on all three columns, the contract answer, size unchanged.
 *   stream -- nOps seeded ops; EVERY op's three columns == vebCost on the VebRef
 *             state before the op, its answer == VebRef's; coverage tallies.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { VebRef } from './helpers/vebRef.mjs';
import { vebCost, fmtCost, sameCost, KEYED_OPS } from './helpers/vebCost.mjs';
import { makeWrapped, mulberry32 } from './_count-worker.mjs';

const NUM = /^(0|[1-9][0-9]*)$/;
export const COLS = ['_t', '_g', '_p'];

/** Bad keys: never an integer in [0, U). */
export function vebBadKeys(U) {
    return [-1, U, U + 0.5, NaN, '3', 4294967296, 1.5, Infinity, -Infinity, null, undefined, 3n,
        2 ** 53, Symbol('k'), { valueOf() { return 1; } }, new Number(1), true, [1]];
}

// --- the counting harness ---------------------------------------------------------------

function counter(real, cell) {
    return new Proxy(real, {
        get(t, k) {
            if (typeof k === 'string' && NUM.test(k)) {
                cell.r++;
                return t[k];
            }
            const v = Reflect.get(t, k);
            if (typeof v === 'function') cell.m++;
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

/** Swaps Proxies into `_t` / `_g` / `_p`; measure(fn) -> { t, g, p, meth, ret, threw }. */
export function wrap(inst) {
    const real = COLS.map((c) => inst[c]);
    const cells = COLS.map(() => ({ r: 0, w: 0, m: 0 }));
    COLS.forEach((c, i) => { inst[c] = counter(real[i], cells[i]); });
    return {
        real,
        measure(fn) {
            for (const c of cells) { c.r = 0; c.w = 0; c.m = 0; }
            let ret;
            let threw = null;
            try { ret = fn(); } catch (e) { threw = e; }
            return {
                t: { reads: cells[0].r, writes: cells[0].w },
                g: { reads: cells[1].r, writes: cells[1].w },
                p: { reads: cells[2].r, writes: cells[2].w },
                meth: cells[0].m + cells[1].m + cells[2].m,
                ret, threw,
            };
        },
        unwrap() {
            COLS.forEach((c, i) => { inst[c] = real[i]; });
        },
    };
}

/** Engine + reference built with the same keys, then the engine wrapped. */
function build(Veb, U, keys) {
    const e = new Veb(U);
    const r = new VebRef(U);
    for (const k of keys) {
        e.add(k);
        r.add(k);
    }
    return { e, r, h: wrap(e) };
}

/** The contract answer of an engine call, comparable with vebCost's ret. */
function norm(op, m, inst) {
    if (op === 'add') {
        if (m.threw !== null) return m.threw instanceof RangeError && /^\[lite-loglogn\] /.test(m.threw.message) ? 'throws' : 'threw ' + String(m.threw);
        return m.ret === inst ? 'this' : 'returned ' + String(m.ret);
    }
    if (m.threw !== null) return 'threw ' + String(m.threw);
    return m.ret;
}

function call(inst, op, x) {
    if (op === 'min') return inst.min();
    if (op === 'max') return inst.max();
    return inst[op](x);
}

function refApply(r, op, x) {
    if (op === 'min') return r.min();
    if (op === 'max') return r.max();
    if (op === 'add') {
        try {
            r.add(x);
            return 'this';
        } catch (e) {
            return 'throws';
        }
    }
    return r[op](x);
}

function show(x) {
    return typeof x === 'symbol' ? 'Symbol' : typeof x === 'bigint' ? x + 'n' : typeof x === 'object' && x !== null ? 'object' : String(x);
}

/** Runs op(x) on both sides; pushes a fail on any column / answer / meth mismatch. */
function check(ctx, label, op, x) {
    const size0 = ctx.r.size;
    const want = vebCost(ctx.r, op, x);
    const got = ctx.h.measure(() => call(ctx.e, op, x));
    const ans = norm(op, got, ctx.e);
    const truth = refApply(ctx.r, op, x);
    const bad = [];
    if (!sameCost(got, want)) bad.push('counts ' + fmtCost(got) + ' != vebCost ' + fmtCost(want));
    if (got.meth !== 0) bad.push('typed-array method read through a wrapped column x' + got.meth);
    if (!Object.is(ans, truth) && !(ans === truth)) bad.push('answer ' + String(ans) + ' != VebRef ' + String(truth));
    if (!(want.ret === truth)) bad.push('vebCost answer ' + String(want.ret) + ' != VebRef ' + String(truth));
    if (ctx.e.size !== ctx.r.size) bad.push('size ' + ctx.e.size + ' != VebRef ' + ctx.r.size);
    if (bad.length > 0) ctx.fails.push('U=' + ctx.U + ' ' + label + ' ' + op + '(' + show(x) + ') size ' + size0 + ': ' + bad.join('; '));
    return { got, want };
}

// --- phases ---------------------------------------------------------------------------------

/** A3 rows on vEBTree: [label, measured cost, vebCost, answer]. */
function a3Phase(Veb, U) {
    const fails = [];
    const rows = [];
    const run = (label, keys, op, x) => {
        const ctx = { ...build(Veb, U, keys), U, fails };
        const { got, want } = check(ctx, label, op, x);
        rows.push({ label, got: { t: got.t, g: got.g, p: got.p }, want: { t: want.t, g: want.g, p: want.p }, ret: norm(op, got, ctx.e) });
        ctx.h.unwrap();
    };
    run('min empty', [], 'min');
    run('max empty', [], 'max');
    run('min {5,U-1}', [5, U - 1], 'min');
    run('max {5,U-1}', [5, U - 1], 'max');
    run('successor(0) on {U-1}', [U - 1], 'successor', 0);
    run('predecessor(U-1) on {0}', [0], 'predecessor', U - 1);
    if (U >= 65536) {
        run('successor(0) on {0,65535}', [0, 65535], 'successor', 0);
        run('successor(5) on {0,5,6,65535}', [0, 5, 6, 65535], 'successor', 5);
    }
    run('has(5) on {0,5,6,U-1}', [0, 5, 6, U - 1], 'has', 5);
    run('has(6) on {0,5,6,7,U-1}', [0, 5, 6, 7, U - 1], 'has', 6);
    return { fails, rows: rows.length, table: rows };
}

/** The StratifiedBitset side of the loss row, through the Count.test.js harness. */
function sbPhase(SB, U) {
    const fails = [];
    const table = [];
    const run = (label, keys, op, x) => {
        const { s, h } = makeWrapped(SB, U, keys);
        const m = h.measure(() => (op === 'min' ? s.min() : op === 'max' ? s.max() : s[op](x)));
        h.unwrap();
        if (m.threw !== null) fails.push('SB U=' + U + ' ' + label + ' threw ' + String(m.threw));
        table.push({ label, R: m.R, Wr: m.Wr, ret: m.ret });
    };
    run('min {5,U-1}', [5, U - 1], 'min');
    run('max {5,U-1}', [5, U - 1], 'max');
    if (U >= 65536) {
        run('successor(0) on {0,65535}', [0, 65535], 'successor', 0);
        run('successor(5) on {0,5,6,65535}', [0, 5, 6, 65535], 'successor', 5);
    }
    run('has(5) on {0,5,6,U-1}', [0, 5, 6, U - 1], 'has', 5);
    run('has(6) on {0,5,6,7,U-1}', [0, 5, 6, 7, U - 1], 'has', 6);
    return { fails, rows: table.length, table, levels: new SB(U).levels };
}

function badPhase(Veb, U) {
    const fails = [];
    let rows = 0;
    for (const keys of [[], [0, U - 1]]) {
        const ctx = { ...build(Veb, U, keys), U, fails };
        const size0 = ctx.e.size;
        for (const x of vebBadKeys(U)) {
            for (const op of KEYED_OPS) {
                rows++;
                const { got } = check(ctx, 'bad', op, x);
                const all = got.t.reads + got.t.writes + got.g.reads + got.g.writes + got.p.reads + got.p.writes;
                if (all !== 0) fails.push('U=' + U + ' bad ' + op + '(' + show(x) + ') touched a column: ' + fmtCost(got));
            }
        }
        if (ctx.e.size !== size0) fails.push('U=' + U + ' bad keys changed size ' + size0 + ' -> ' + ctx.e.size);
        ctx.h.unwrap();
    }
    return { fails, rows };
}

/** Seeded stream: grow / shrink cycles, keys from hot regions, live neighbours, edges, uniform. */
function streamPhase(Veb, U, seed, nOps) {
    const fails = [];
    // two independent streams: rOp drives caps / op kind / the op-side gates (6 draws
    // per op, unconditionally, so its sequence never depends on a key branch); rKey
    // drives regions / js / pick() / bad[...] / live[...]
    const s0 = (seed ^ Math.imul(U >>> 0, 0x9e3779b1)) >>> 0;
    const rOp = mulberry32(s0);
    const rKey = mulberry32((s0 ^ 0x85ebca6b) >>> 0);
    const ctx = { ...build(Veb, U, []), U, fails };
    const w = ctx.r.bits;
    const lo = w > 24 ? 16 : 8;
    const P = 2 ** lo;
    const nc = Math.ceil(U / P);
    const live = [];
    const where = new Map();
    const kinds = {};
    const cov = {};
    const bad = vebBadKeys(U);
    const pickInt = (n) => Math.floor(rKey() * n);
    // hot regions: a few clusters; at lo = 16 a few 256-key leaf sub-clusters inside them
    const regions = [];
    const js = [0, 1, nc - 1, pickInt(nc)];
    for (const j of js) {
        if (lo === 16) {
            for (const k of [0, 1, 255, pickInt(256)]) regions.push(j * P + k * 256);
        } else {
            regions.push(j * P);
        }
    }
    const span = w <= 8 ? 2 ** w : 256;
    const pick = () => {
        const r = rKey();
        let x;
        if (r < 0.4) x = regions[pickInt(regions.length)] + pickInt(span);
        else if (r < 0.6 && live.length > 0) x = live[pickInt(live.length)] + pickInt(7) - 3;
        else if (r < 0.75) {
            const j = js[pickInt(js.length)];
            const e = [0, 1, U - 1, U - 2, j * P, j * P - 1, j * P + P - 1, j * P + 255, j * P + 256];
            x = e[pickInt(e.length)];
        } else x = pickInt(U);
        if (x < 0) x = 0;
        if (x >= U) x = U - 1;
        return x;
    };
    const caps = [1, 2, 2, 2, 3, 3, 5, 12, 60, 400];
    const QUERY = ['has', 'successor', 'predecessor', 'successor', 'predecessor', 'min', 'max', 'has'];
    let cap = caps[Math.floor(rOp() * caps.length)];
    let grow = true;
    for (let n = 0; n < nOps; n++) {
        const dCap = rOp();
        const r = rOp();
        const dQ = rOp();
        const dBad = rOp();
        const dMax = rOp();
        const dLive = rOp();
        if (grow && live.length >= cap) grow = false;
        if (!grow && live.length === 0) {
            grow = true;
            cap = caps[Math.floor(dCap * caps.length)];
        }
        let op;
        if (r < 0.3) op = grow ? 'add' : 'delete';
        else if (r < 0.38) op = grow ? 'delete' : 'add';
        else op = QUERY[Math.floor(dQ * QUERY.length)];
        let x;
        if (op === 'min' || op === 'max') x = undefined;
        else if (dBad < 0.02) x = bad[pickInt(bad.length)];
        else if (op === 'delete' && live.length > 0 && dMax < 0.3) x = ctx.r.max();
        else if (op === 'delete' && live.length > 0 && dLive < 0.85) x = live[pickInt(live.length)];
        else x = pick();
        kinds[op] = (kinds[op] || 0) + 1;
        const before = ctx.fails.length;
        const { want } = check(ctx, '#' + n, op, x);
        for (const k in want.cov) cov[k] = (cov[k] || 0) + want.cov[k];
        if (ctx.fails.length !== before) {
            ctx.fails[ctx.fails.length - 1] += ' [seed ' + seed + ']';
            if (ctx.fails.length > 8) break;
        }
        // live set mirrors the reference
        if (op === 'add' && typeof x === 'number' && (x >>> 0) === x && ctx.r.has(x) && !where.has(x >>> 0)) {
            where.set(x >>> 0, live.length);
            live.push(x >>> 0);
        } else if (op === 'delete' && typeof x === 'number' && (x >>> 0) === x && where.has(x >>> 0) && !ctx.r.has(x)) {
            const i = where.get(x >>> 0);
            const last = live.pop();
            if (i < live.length) {
                live[i] = last;
                where.set(last, i);
            }
            where.delete(x >>> 0);
        }
    }
    ctx.h.unwrap();
    if (ctx.e.size !== live.length) fails.push('U=' + U + ' final size ' + ctx.e.size + ' != live ' + live.length);
    return { fails, rows: nOps, kinds, cov, w };
}

// --- worker entry -----------------------------------------------------------------------------

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData.vebCountJob === true) {
    const { src, seed, units } = workerData;
    const mod = await import(src === null ? '../LogLogN.js' : src);
    parentPort.postMessage({ phase: 'loaded', fails: [], hasVeb: typeof mod.vEBTree === 'function' });
    const Veb = mod.vEBTree;
    for (const u of units) {
        for (const name of u.phases) {
            let res;
            try {
                if (typeof Veb !== 'function' && name !== 'sb') throw new Error('vEBTree is not exported');
                if (name === 'a3') res = a3Phase(Veb, u.U);
                else if (name === 'sb') res = sbPhase(mod.StratifiedBitset, u.U);
                else if (name === 'bad') res = badPhase(Veb, u.U);
                else if (name === 'stream') res = streamPhase(Veb, u.U, seed, u.nOps);
                else throw new Error('unknown phase ' + name);
            } catch (e) {
                res = { fails: ['U=' + u.U + ' phase ' + name + ' threw ' + (e && e.stack ? e.stack : String(e))], rows: 0 };
            }
            parentPort.postMessage({ phase: u.U + ':' + name, ...res });
        }
    }
}
