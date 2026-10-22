/**
 * @zakkster/lite-loglogn -- COUNT gate worker (not a test file: the npm glob
 * `test/*.test.js` never matches it).
 *
 * test/Count.test.js runs every per-universe body that calls a shipped hot
 * method in a node:worker_threads Worker built from this file, so a mutant that
 * loops forever (a synchronous `for (;;)` that never reaches the timeout
 * machinery of node:test) is terminated by the parent's hang timer and FAILS
 * instead of hanging the run. The worker posts one plain message per phase
 * (`exact`, `bad`, `random`): `{ phase, fails: string[], rows, opCounts }`.
 *
 * Imported on the main thread it only exports the shared helpers
 * (countingHarness, makeWrapped, checkBound, checkExact, mulberry32).
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { StratifiedBitset } from '../LogLogN.js';

const NUMERIC = /^(0|[1-9][0-9]*)$/;

// --- countingHarness (D7) ---------------------------------------------------

export function countingHarness(inst) {
    const target = inst._bits;
    const c = { R: 0, Wr: 0 };
    const proxy = new Proxy(target, {
        get(t, k) {
            if (typeof k === 'string' && NUMERIC.test(k)) c.R++;
            return Reflect.get(t, k);
        },
        set(t, k, v) {
            if (typeof k === 'string' && NUMERIC.test(k)) {
                c.Wr++;
                t[k] = v;
                return true;
            }
            return Reflect.set(t, k, v);
        },
    });
    inst._bits = proxy;
    return {
        measure(fn) {
            c.R = 0;
            c.Wr = 0;
            let ret;
            let threw = null;
            try {
                ret = fn();
            } catch (e) {
                threw = e;
            }
            return { R: c.R, Wr: c.Wr, ret, threw };
        },
        unwrap() {
            inst._bits = target;
        },
    };
}

export function makeWrapped(Cls, u, keys) {
    const s = new Cls(u);
    for (const k of keys) s.add(k);
    return { s, h: countingHarness(s) };
}

export function checkBound(got, bound) {
    return got <= bound ? 'PASS' : 'FAIL';
}

export function checkExact(got, want) {
    return got.R === want.R && got.Wr === want.Wr ? 'PASS' : 'FAIL';
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// --- phase bodies (each collects failures; an uncaught throw = worker error) --

function exactPhase(U, Lc) {
    const fails = [];
    let rows = 0;
    const tag = 'U=' + U + ' ';
    const exact = (label, got, R, Wr) => {
        rows++;
        if (checkExact(got, { R, Wr }) !== 'PASS') {
            fails.push(tag + label + ': want R=' + R + ' Wr=' + Wr + ', got R=' + got.R + ' Wr=' + got.Wr);
        }
    };
    const eq = (label, got, want) => {
        if (got !== want) fails.push(tag + label + ': want ' + String(want) + ', got ' + String(got));
    };
    const levels = new StratifiedBitset(U).levels;
    eq('levels pin', levels, Lc);
    let w;
    let m;

    // add into the empty set: every level goes 0 -> nonzero
    w = makeWrapped(StratifiedBitset, U, []);
    exact('empty add(U-1)', w.h.measure(() => w.s.add(U - 1)), Lc, Lc);
    // existing key: one read, no write
    exact('existing add(U-1)', w.h.measure(() => w.s.add(U - 1)), 1, 0);
    // delete the only key: every level goes nonzero -> 0
    exact('delete only key', w.h.measure(() => w.s.delete(U - 1)), Lc, Lc);
    // absent delete on the (now) empty set
    m = w.h.measure(() => w.s.delete(U - 1));
    exact('absent delete (empty)', m, 1, 0);
    eq('absent delete (empty) ret', m.ret, false);
    // empty min / max: the top word only
    m = w.h.measure(() => w.s.min());
    exact('empty min', m, 1, 0);
    eq('empty min ret', m.ret, undefined);
    m = w.h.measure(() => w.s.max());
    exact('empty max', m, 1, 0);
    eq('empty max ret', m.ret, undefined);
    w.h.unwrap();

    if (U >= 2) {
        // second key in the same level-0 word: c = 0
        w = makeWrapped(StratifiedBitset, U, [0]);
        exact('second key same word add(1)', w.h.measure(() => w.s.add(1)), 1, 1);
        if (U > 2) {
            m = w.h.measure(() => w.s.delete(U - 1));
            exact('absent delete (nonempty)', m, 1, 0);
            eq('absent delete (nonempty) ret', m.ret, false);
        }
        // delete leaving its level-0 word nonzero: c = 0
        m = w.h.measure(() => w.s.delete(1));
        exact('delete(1) on {0,1}', m, 1, 1);
        eq('delete(1) on {0,1} ret', m.ret, true);
        w.h.unwrap();
    }

    if (Lc >= 2) {
        // partial climbs, c = 1: level-0 word 1 goes 0 <-> nonzero, the level-1
        // word already holds bit 0 (key 0), so the climb stops at level 1
        w = makeWrapped(StratifiedBitset, U, [0]);
        exact('add(32) on {0}', w.h.measure(() => w.s.add(32)), 2, 2);
        m = w.h.measure(() => w.s.delete(32));
        exact('delete(32) on {0,32}', m, 2, 2);
        eq('delete(32) on {0,32} ret', m.ret, true);
        w.h.unwrap();
    }

    // min / max nonempty = Lc
    w = makeWrapped(StratifiedBitset, U, [U - 1]);
    m = w.h.measure(() => w.s.min());
    exact('min {U-1}', m, Lc, 0);
    eq('min {U-1} ret', m.ret, U - 1);
    m = w.h.measure(() => w.s.max());
    exact('max {U-1}', m, Lc, 0);
    eq('max {U-1} ret', m.ret, U - 1);
    m = w.h.measure(() => w.s.has(U - 1));
    exact('has present', m, 1, 0);
    eq('has present ret', m.ret, true);
    w.h.unwrap();

    // successor(0) on {0, U-1}: keys 1 and U-1 first share a word at the top,
    // so R = 2F+1 with F = Lc-1, i.e. 2Lc-1. U=1: {0, U-1} = {0} and
    // x+1 >= U short-circuits -> 0 reads.
    const span = U === 1 ? 0 : 2 * Lc - 1;
    // predecessor(U-1) on {0, U-1}: R = 2F+1 with F = the lowest level whose
    // word holds both U-2 and 0. That is the top EXCEPT where U-2 < 32^(Lc-1):
    // U=33 (31 shares level-0 word 0 -> F=0, R=1) and U=1025 (1023 shares
    // level-1 word 0 -> F=1, R=3). Hand-derived from the cost model; the
    // 2Lc-1 case for those two is unreachable by any in-universe query.
    const PRED_SPAN = { 1: 0, 32: 1, 33: 1, 1025: 3, 32768: 5, 65536: 7, 1048576: 7, 16777216: 9 };
    const predSpan = PRED_SPAN[U];
    if (typeof predSpan !== 'number') fails.push(tag + 'PRED_SPAN row missing');
    w = makeWrapped(StratifiedBitset, U, [0, U - 1]);
    m = w.h.measure(() => w.s.successor(0));
    exact('successor(0) on {0,U-1}', m, span, 0);
    eq('successor(0) on {0,U-1} ret', m.ret, U === 1 ? undefined : U - 1);
    m = w.h.measure(() => w.s.predecessor(U - 1));
    exact('predecessor(U-1) on {0,U-1}', m, predSpan, 0);
    eq('predecessor(U-1) on {0,U-1} ret', m.ret, U === 1 ? undefined : 0);
    // out-of-range neighbours: zero reads
    m = w.h.measure(() => w.s.successor(U - 1));
    exact('successor(U-1)', m, 0, 0);
    eq('successor(U-1) ret', m.ret, undefined);
    m = w.h.measure(() => w.s.predecessor(0));
    exact('predecessor(0)', m, 0, 0);
    eq('predecessor(0) ret', m.ret, undefined);
    m = w.h.measure(() => w.s.has(0));
    exact('has(0)', m, 1, 0);
    w.h.unwrap();

    // predecessor found at the top = 2Lc-1: on {0, y}, query y with
    // y - 1 = 32 + 32^2 + ... + 32^(Lc-1), so the climbed index i-1 lands in
    // a nonzero word index at every level below the top (never word 0).
    // Needs y < U: true for U >= 32768 here; U=33 / 1025 cannot reach it.
    let y = 1;
    for (let k = 1; k < Lc; k++) y += 32 ** k;
    if (U >= 32768 && !(y < U)) fails.push(tag + 'worst-case predecessor row must run');
    if (Lc >= 2 && y < U) {
        w = makeWrapped(StratifiedBitset, U, [0, y]);
        m = w.h.measure(() => w.s.predecessor(y));
        exact('predecessor(y) on {0,y} (worst case)', m, 2 * Lc - 1, 0);
        eq('predecessor(y) on {0,y} ret', m.ret, 0);
        w.h.unwrap();
    }

    // successor(0) on {0}: not found, every level read (U=1 short-circuits)
    w = makeWrapped(StratifiedBitset, U, [0]);
    m = w.h.measure(() => w.s.successor(0));
    exact('successor(0) on {0}', m, U === 1 ? 0 : Lc, 0);
    eq('successor(0) on {0} ret', m.ret, undefined);
    w.h.unwrap();

    return { fails, rows };
}

function badPhase(U) {
    const fails = [];
    let rows = 0;
    const BAD = [Symbol('k'), 1n, { valueOf() { return 1; } }, new Number(1), NaN, null,
        undefined, '1', -1, 1.5, U, 2 ** 32, { toString() { throw new Error('x'); } }];
    const w = makeWrapped(StratifiedBitset, U, [0, U - 1]);
    const zero = (name, m) => {
        rows++;
        if (checkExact(m, { R: 0, Wr: 0 }) !== 'PASS') {
            fails.push(name + ': want R=0 Wr=0, got R=' + m.R + ' Wr=' + m.Wr);
        }
    };
    for (let j = 0; j < BAD.length; j++) {
        const k = BAD[j];
        const name = 'U=' + U + ' bad[' + j + '] (' + typeof k + ')';
        let m = w.h.measure(() => w.s.has(k));
        zero(name + ' has', m);
        if (m.ret !== false || m.threw !== null) fails.push(name + ' has must return false');
        m = w.h.measure(() => w.s.delete(k));
        zero(name + ' delete', m);
        if (m.ret !== false || m.threw !== null) fails.push(name + ' delete must return false');
        m = w.h.measure(() => w.s.successor(k));
        zero(name + ' successor', m);
        if (m.ret !== undefined || m.threw !== null) fails.push(name + ' successor must return undefined');
        m = w.h.measure(() => w.s.predecessor(k));
        zero(name + ' predecessor', m);
        if (m.ret !== undefined || m.threw !== null) fails.push(name + ' predecessor must return undefined');
        m = w.h.measure(() => w.s.add(k));
        zero(name + ' add', m);
        if (!(m.threw instanceof RangeError) || !/^\[lite-loglogn\] /.test(m.threw.message)) {
            fails.push(name + ' add must throw RangeError /^[lite-loglogn] /');
        }
    }
    if (w.s.size !== (U === 1 ? 1 : 2)) fails.push('U=' + U + ' bad keys changed size to ' + w.s.size);
    w.h.unwrap();
    return { fails, rows };
}

function randomPhase(U, Lc, seed) {
    const keyRnd = mulberry32(seed);
    const opRnd = mulberry32(seed ^ 0x85ebca6b);
    const { s, h } = makeWrapped(StratifiedBitset, U, []);
    const live = [];
    const opCounts = [0, 0, 0, 0, 0, 0, 0];
    const pick = () => {
        const r = keyRnd();
        // half uniform, half a dense window at a random base (multi-key words)
        if (r < 0.5 || U < 64) return Math.floor(keyRnd() * U);
        const base = Math.floor(keyRnd() * (U - 64));
        return base + Math.floor(keyRnd() * 64);
    };
    const fails = [];
    for (let n = 0; n < 10000; n++) {
        const op = Math.floor(opRnd() * 7);
        opCounts[op]++;
        let x = pick();
        let m;
        let rb;
        let wb;
        if (op === 0) {
            m = h.measure(() => s.add(x));
            if (m.threw === null) live.push(x);
            rb = Lc; wb = Lc;
            if (m.R < 1) fails.push('add R<1');
        } else if (op === 1) {
            if (live.length > 0 && keyRnd() < 0.7) {
                const j = Math.floor(keyRnd() * live.length);
                x = live[j];
                live[j] = live[live.length - 1];
                live.pop();
            }
            m = h.measure(() => s.delete(x));
            rb = Lc; wb = Lc;
            if (m.R < 1) fails.push('delete R<1');
        } else if (op === 2) {
            m = h.measure(() => s.has(x));
            rb = 1; wb = 0;
            if (m.R !== 1) fails.push('has R!==1 got ' + m.R);
        } else if (op === 3) {
            m = h.measure(() => s.successor(x));
            rb = 2 * Lc - 1; wb = 0;
        } else if (op === 4) {
            m = h.measure(() => s.predecessor(x));
            rb = 2 * Lc - 1; wb = 0;
        } else if (op === 5) {
            m = h.measure(() => s.min());
            rb = Lc; wb = 0;
        } else {
            m = h.measure(() => s.max());
            rb = Lc; wb = 0;
        }
        if (m.threw !== null) fails.push('op ' + op + ' threw ' + m.threw.message);
        if (checkBound(m.R, rb) === 'FAIL' || checkBound(m.Wr, wb) === 'FAIL') {
            fails.push('U=' + U + ' op=' + op + ' x=' + x + ' R=' + m.R + '/' + rb +
                ' Wr=' + m.Wr + '/' + wb);
        }
        if (fails.length > 5) break;
    }
    h.unwrap();
    return { fails, opCounts };
}

// --- worker entry -------------------------------------------------------------

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.countJob === true) {
    const { U, Lc, seed } = workerData;
    parentPort.postMessage({ phase: 'exact', ...exactPhase(U, Lc) });
    parentPort.postMessage({ phase: 'bad', ...badPhase(U) });
    parentPort.postMessage({ phase: 'random', ...randomPhase(U, Lc, seed) });
}
