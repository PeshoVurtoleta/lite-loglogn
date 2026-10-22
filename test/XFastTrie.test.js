/**
 * @zakkster/lite-loglogn -- XFastTrie engine gates (B3, DETERMINISTIC).
 *
 * Oracle = test/helpers/xftStream.mjs (SortedOracle, genStream, reseedSeeds,
 * collide, level geometry); every expected value below comes from the PLAN
 * ASSERTIONS and that model, never from the engine's own output.
 *
 *  E1  per-level invariant over seeded churn: every 1000 ops dump() equals the
 *      oracle (keys; per level the exact sorted prefix set, min / max KEY per
 *      prefix; prefixes via Math.floor(k / 2^(w-L)), never a 32-bit shift).
 *  E4  a full-reject / bad key reads and writes nothing it must not: 8 column
 *      fields behind counting Proxies; add of a NEW key at size === capacity =
 *      the level-w probe only (4 _lv + 8 _occ reads on a miss), 0 writes, 0
 *      reads of _tmin / _tmax / _key / _next / _prev; dump() and byteLength
 *      unchanged. A bad key reads 0 and writes 0 on every column.
 *  E5  reseed: collide() keys force a stall; q[1] >= 1, q[2] === 1, the level-16
 *      seeds equal reseedSeeds(s1_start, q[3]). A try that needs 2 attempts
 *      derives from s1_START (not chained). 32 failures roll back (dump equal on
 *      ALL levels, start seeds restored), at level w and at level 12; a failed
 *      rollback POISONS (TypeError on every hot method) until clear().
 *
 * Must-fail controls (in-memory mutants of the real source, each anchor replaced
 * exactly once, loaded through a data: URL inside a worker under a kill timer):
 *   M-fullLate (E4), M-addStopLong + M-fillMaxFirst (E1), M-reseedRunning (E5),
 *   M-undoSkipLevel + M-noUndo (E5). Each control asserts the mutant is caught.
 * Probes are plain functions returning { bad: string|null, n } so the SAME code
 * runs in-process on the real engine and in a worker on a mutant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { XFastTrie } from '../LogLogN.js';
import * as H from './helpers/xftStream.mjs';

const OPTS = { timeout: 120000 };
const KILL_MS = 90000;
const HELPER_URL = new URL('./helpers/xftStream.mjs', import.meta.url).href;
const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');

// --- probes (self-contained: no module-scope names except each other) ------------

function sameJson(a, b) {
    const r = (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v);
    return JSON.stringify(a, r) === JSON.stringify(b, r);
}

/** First violation of dump d against the sorted key list, or null. */
function dumpViolation(d, keys, U, C, Hh) {
    const w = Hh.bitsOf(U);
    if (d.universe !== U || d.capacity !== C || d.bits !== w || d.size !== keys.length) return 'header';
    const dk = Array.from(d.keys);
    if (dk.length !== keys.length) return 'keys length ' + dk.length + ' vs ' + keys.length;
    for (let i = 0; i < keys.length; i++) if (dk[i] !== keys[i]) return 'keys[' + i + ']';
    if (d.levels.length !== w) return 'levels length';
    const g = Hh.levelGeometry(U, C);
    for (let L = 1; L <= w; L++) {
        const lev = d.levels[L - 1];
        const div = 2 ** (w - L);
        const ep = [];
        const emin = [];
        const emax = [];
        for (const k of keys) {
            const p = Math.floor(k / div);
            if (ep.length === 0 || ep[ep.length - 1] !== p) {
                ep.push(p);
                emin.push(k);
                emax.push(k);
            } else {
                emax[emax.length - 1] = k;
            }
        }
        if (lev.capacity !== Math.floor(g.levels[L].S * 9 / 10)) return 'level ' + L + ' capacity';
        const gp = Array.from(lev.prefix);
        const gmin = Array.from(lev.min);
        const gmax = Array.from(lev.max);
        if (gp.length !== ep.length || gmin.length !== ep.length || gmax.length !== ep.length) {
            return 'level ' + L + ' prefix count ' + gp.length + ' vs ' + ep.length;
        }
        for (let t = 0; t < ep.length; t++) {
            if (gp[t] !== ep[t]) return 'level ' + L + ' prefix[' + t + '] ' + gp[t] + ' vs ' + ep[t];
            if (gmin[t] !== emin[t]) return 'level ' + L + ' min of prefix ' + ep[t] + ': ' + gmin[t] + ' vs ' + emin[t];
            if (gmax[t] !== emax[t]) return 'level ' + L + ' max of prefix ' + ep[t] + ': ' + gmax[t] + ' vs ' + emax[t];
        }
    }
    return null;
}

/** E1: churn streams vs the oracle, per-level invariants every 1000 ops. */
function e1Probe(X, Hh) {
    const IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // all 15 streams (PLAN E1)
    let n = 0;
    let nonEmpty = 0;
    let levels = 0;
    let maxKey = 0;
    let fills = 0;
    try {
        for (const si of IDX) {
            const [U, C] = Hh.STREAMS[si];
            const w = Hh.bitsOf(U);
            const st = Hh.genStream(U, C, Hh.N_OPS, Hh.streamSeed(si));
            const BAD = Hh.badKeys(U);
            const inst = new X(U, C);
            const o = new Hh.SortedOracle(U, C);
            for (let i = 0; i < st.op.length; i++) {
                const x = Hh.keyAt(st, BAD, i);
                let ra;
                let rb;
                let ea = false;
                let eb = false;
                try { ra = Hh.applyOp(inst, st.op[i], x); } catch (e) { ea = true; }
                try { rb = Hh.applyOp(o, st.op[i], x); } catch (e) { eb = true; }
                if (ea !== eb) return { bad: 'stream ' + si + ' op ' + i + ' throw mismatch', n };
                if (!ea && ra !== inst && !Object.is(ra, rb)) {
                    return { bad: 'stream ' + si + ' op ' + i + ' answer ' + String(ra) + ' vs ' + String(rb), n };
                }
                if ((i + 1) % Hh.EVERY === 0) {
                    const keys = o.keys();
                    const v = dumpViolation(inst.dump(), keys, U, C, Hh);
                    if (v !== null) return { bad: 'stream ' + si + ' after op ' + i + ': ' + v, n };
                    n++;
                    levels += w;
                    if (keys.length > 0) nonEmpty++;
                    for (const k of keys) if (k > maxKey) maxKey = k;
                }
            }
            // re-place every level from the leaf thread: min / max groups must survive
            const keys = o.keys();
            for (let L = 1; L <= w; L++) {
                if (!inst._fill(L)) return { bad: 'stream ' + si + ' _fill(' + L + ') failed', n };
                fills++;
            }
            const v = dumpViolation(inst.dump(), keys, U, C, Hh);
            if (v !== null) return { bad: 'stream ' + si + ' after _fill of every level: ' + v, n };
        }
    } catch (e) {
        return { bad: 'threw ' + (e && e.stack), n };
    }
    return { bad: null, n, nonEmpty, levels, maxKey, fills };
}

const COLS = ['_lv', '_occ', '_tk', '_tmin', '_tmax', '_key', '_next', '_prev'];

/** Swaps counting Proxies onto the 8 column fields; returns { cnt, reset, restore }. */
function installCounters(inst) {
    const orig = {};
    const cnt = {};
    const isIdx = (p) => typeof p === 'string' && p.length > 0 && p.charCodeAt(0) >= 48 && p.charCodeAt(0) <= 57;
    for (const nm of COLS) {
        orig[nm] = inst[nm];
        const c = { r: 0, w: 0 };
        cnt[nm] = c;
        inst[nm] = new Proxy(orig[nm], {
            get(t, p) {
                if (isIdx(p)) { c.r++; return t[p]; }
                return Reflect.get(t, p);
            },
            set(t, p, v) {
                if (isIdx(p)) c.w++;
                t[p] = v;
                return true;
            },
        });
    }
    return {
        cnt,
        reset() { for (const nm of COLS) { cnt[nm].r = 0; cnt[nm].w = 0; } },
        restore() { for (const nm of COLS) inst[nm] = orig[nm]; },
    };
}

/** E4: full-reject / present / bad-key touch counts, dump + byteLength unchanged. */
function e4Probe(X, Hh) {
    let n = 0;
    const CFG = [[256, 8], [1000, 5], [2, 2], [65536, 16], [4294967296, 6], [17, 3]];
    let fullRejects = 0;
    try {
        for (const [U, C] of CFG) {
            const tag = 'U=' + U + ' C=' + C + ': ';
            const rnd = Hh.mulberry32(0xe4 + U + C);
            const inst = new X(U, C);
            const present = [];
            if (U === 2) {
                present.push(0, 1);
            } else {
                while (present.length < C) {
                    const k = Math.floor(rnd() * U);
                    if (present.indexOf(k) < 0) present.push(k);
                }
            }
            for (const k of present) inst.add(k);
            if (inst.size !== C) return { bad: tag + 'fill', n };
            let fresh = -1;
            if (C < U) {
                for (let t = 0; t < 1000 && fresh < 0; t++) {
                    const k = Math.floor(rnd() * U);
                    if (present.indexOf(k) < 0) fresh = k;
                }
                if (fresh < 0) return { bad: tag + 'no fresh key', n };
            }
            const d0 = inst.dump();
            const bl0 = inst.byteLength;
            const pc = installCounters(inst);
            const lens = () => COLS.map((nm) => nm + '=' + pc.cnt[nm].r + '/' + pc.cnt[nm].w).join(' ');
            const only = (allowed) => {
                for (const nm of COLS) {
                    if (allowed.indexOf(nm) >= 0) continue;
                    if (pc.cnt[nm].r !== 0 || pc.cnt[nm].w !== 0) return false;
                }
                return true;
            };
            let bad = null;
            if (fresh >= 0) {
                pc.reset();
                let err = null;
                try { inst.add(fresh); } catch (e) { err = e; }
                if (!(err instanceof RangeError) || !/\[lite-loglogn\]/.test(err.message)) {
                    bad = tag + 'full add did not throw the RangeError';
                } else if (pc.cnt._lv.r !== 4 || pc.cnt._occ.r !== 8 || pc.cnt._tk.r > 8) {
                    bad = tag + 'full add probe is not exactly one level-w miss: ' + lens();
                } else if (pc.cnt._lv.w !== 0 || pc.cnt._occ.w !== 0 || pc.cnt._tk.w !== 0 || !only(['_lv', '_occ', '_tk'])) {
                    bad = tag + 'full add wrote or read a forbidden column: ' + lens();
                }
                fullRejects++;
                n++;
            }
            if (bad === null) {
                // add / has of a PRESENT key = 1 touch, 0 writes, no thread / min / max access
                for (const op of ['add', 'has']) {
                    pc.reset();
                    const r = inst[op](present[0]);
                    if (op === 'add' ? r !== inst : r !== true) { bad = tag + op + ' present answer'; break; }
                    if (pc.cnt._lv.r !== 4 || pc.cnt._occ.r < 1 || pc.cnt._occ.r > 8 || !only(['_lv', '_occ', '_tk'])) {
                        bad = tag + op + ' present is not one probe: ' + lens();
                        break;
                    }
                    if (pc.cnt._lv.w + pc.cnt._occ.w + pc.cnt._tk.w !== 0) { bad = tag + op + ' present wrote'; break; }
                    n++;
                }
            }
            if (bad === null) {
                // -0 aliases 0: NOT a bad key (has reads like has(0), answers like has(0))
                pc.reset();
                const a = inst.has(-0);
                const readsNeg0 = pc.cnt._lv.r;
                pc.reset();
                const b = inst.has(0);
                if (a !== b || readsNeg0 !== 4 || pc.cnt._lv.r !== 4) bad = tag + '-0 does not alias 0';
                n++;
            }
            if (bad === null) {
                const BADS = [NaN, 1.5, -1, U, '3', 3n, null, undefined];
                for (const bk of BADS) {
                    for (const op of ['has', 'add', 'delete', 'successor', 'predecessor']) {
                        pc.reset();
                        let err = null;
                        let r;
                        try { r = inst[op](bk); } catch (e) { err = e; }
                        if (op === 'add') {
                            if (!(err instanceof RangeError) || !/\[lite-loglogn\]/.test(err.message)) {
                                bad = tag + 'add(' + String(bk) + ') did not throw the RangeError';
                            }
                        } else if (err !== null) {
                            bad = tag + op + '(' + String(bk) + ') threw';
                        } else if (r !== (op === 'has' || op === 'delete' ? false : undefined)) {
                            bad = tag + op + '(' + String(bk) + ') answered ' + String(r);
                        }
                        for (const nm of COLS) {
                            if (pc.cnt[nm].r !== 0 || pc.cnt[nm].w !== 0) bad = tag + op + '(' + String(bk) + ') touched ' + lens();
                        }
                        if (bad !== null) break;
                        n++;
                    }
                    if (bad !== null) break;
                }
            }
            pc.restore();
            if (bad !== null) return { bad, n };
            if (!sameJson(inst.dump(), d0) || inst.byteLength !== bl0 || inst.size !== C) {
                return { bad: tag + 'dump / byteLength / size changed', n };
            }
        }
    } catch (e) {
        return { bad: 'threw ' + (e && e.stack), n };
    }
    return { bad: null, n, fullRejects };
}

/** E5a: collide() keys force one reseed of level 16; seeds = reseedSeeds(s1_start, q[3]). */
function e5Collide(X, Hh) {
    try {
        const keys = Hh.collide(65536, 16, 9);
        if (keys === null || keys.length !== 9) return { bad: 'collide() found no group', n: 0 };
        const inst = new X(65536, 16);
        const s1Start = inst._lv[4 * 16 + 2];
        for (const k of keys) inst.add(k);
        const q = inst._q;
        if (!(q[1] >= 1)) return { bad: 'no kick: q[1] = ' + q[1], n: 9 };
        if (q[2] !== 1) return { bad: 'reseedOps ' + q[2] + ' !== 1', n: 9 };
        const a = q[3];
        if (!(a >= 1 && a <= 32)) return { bad: 'tries ' + a, n: 9 };
        const [t1, t2] = Hh.reseedSeeds(s1Start, a);
        if (inst._lv[66] !== t1 || inst._lv[67] !== t2) return { bad: 'level-16 seeds are not reseedSeeds(s1_start, ' + a + ')', n: 9 };
        const v = dumpViolation(inst.dump(), keys.slice().sort((x, y) => x - y), 65536, 16, Hh);
        return { bad: v === null ? null : 'after reseed: ' + v, n: 9, tries: a };
    } catch (e) {
        return { bad: 'threw ' + (e && e.stack), n: 0 };
    }
}

/** E5b: the first _fill fails once: the final seeds derive from s1_START, try 2 (not chained). */
function e5Reseed2(X, Hh) {
    try {
        const keys = Hh.collide(65536, 16, 9);
        const inst = new X(65536, 16);
        const s1Start = inst._lv[66];
        const real = X.prototype._fill;
        let first = true;
        inst._fill = function stub(L) {
            if (first) { first = false; return false; }
            return real.call(this, L);
        };
        for (const k of keys) inst.add(k);
        const q = inst._q;
        if (first) return { bad: 'the stub was never reached (no stall)', n: 9 };
        if (q[2] !== 1 || q[3] !== 2) return { bad: 'reseedOps ' + q[2] + ' tries ' + q[3] + ' (want 1 / 2)', n: 9 };
        const [t1, t2] = Hh.reseedSeeds(s1Start, 2);
        if (inst._lv[66] !== t1 || inst._lv[67] !== t2) return { bad: 'seeds are not reseedSeeds(s1_START, 2)', n: 9 };
        const v = dumpViolation(inst.dump(), keys.slice().sort((x, y) => x - y), 65536, 16, Hh);
        return { bad: v === null ? null : 'after 2-try reseed: ' + v, n: 9 };
    } catch (e) {
        return { bad: 'threw ' + (e && e.stack), n: 0 };
    }
}

/** 9 keys (p << 4), distinct level-12 prefixes sharing h1 AND h2 at (U 2^16, C 16). */
function findL12(Hh) {
    const g = Hh.levelGeometry(65536, 16);
    const B = g.levels[12].B;
    const groups = new Map();
    for (let p = 0; p < 4096; p++) {
        const [h1, h2] = Hh.levelHash(g, 12, p << 4);
        const k = h1 * B + h2;
        let arr = groups.get(k);
        if (arr === undefined) groups.set(k, arr = []);
        arr.push(p << 4);
        if (arr.length === 9) return arr;
    }
    return null;
}

/** E5c: 32 failed reseeds at level L (12 or 16) roll back: dump equal on ALL levels. */
function e5Fail32(X, Hh, L) {
    try {
        const keys = L === 16 ? Hh.collide(65536, 16, 9) : findL12(Hh);
        if (keys === null || keys.length !== 9) return { bad: 'no colliding group at level ' + L, n: 0 };
        const inst = new X(65536, 16);
        for (let i = 0; i < 8; i++) inst.add(keys[i]);
        const before = inst.dump();
        const s1 = inst._lv[4 * L + 2];
        const s2 = inst._lv[4 * L + 3];
        const real = X.prototype._fill;
        let calls = 0;
        inst._fill = function stub(l) {
            if (++calls <= 32) return false;
            return real.call(this, l);
        };
        let err = null;
        try { inst.add(keys[8]); } catch (e) { err = e; }
        if (!(err instanceof RangeError) || !/\[lite-loglogn\]/.test(err.message)) {
            return { bad: 'the 9th add did not throw the RangeError (L=' + L + ')', n: 9 };
        }
        if (err.message.indexOf('level ' + L + ' ') < 0) return { bad: 'wrong failing level: ' + err.message, n: 9 };
        if (calls !== 33) return { bad: '_fill calls ' + calls + ' !== 33', n: 9 };
        if (inst._q[3] !== 32 || inst._q[2] !== 1) return { bad: 'counters q2 ' + inst._q[2] + ' q3 ' + inst._q[3], n: 9 };
        if (inst._lv[4 * L + 2] !== s1 || inst._lv[4 * L + 3] !== s2) return { bad: 'start seeds not restored', n: 9 };
        if (inst.size !== 8) return { bad: 'size ' + inst.size, n: 9 };
        if (!sameJson(inst.dump(), before)) return { bad: 'dump() changed across the rollback (L=' + L + ')', n: 9 };
        delete inst._fill;
        inst.add(keys[8]); // usable after: the real reseed succeeds
        const all = keys.slice();
        let fk = 1; // the rolled-back leaf is back on the free list: all C = 16 slots fill
        while (all.length < 16) { if (all.indexOf(fk) < 0) { inst.add(fk); all.push(fk); } fk += 2; }
        while (all.indexOf(fk) >= 0) fk += 2;
        let ef = null;
        try { inst.add(fk); } catch (e) { ef = e; }
        if (!(ef instanceof RangeError) || inst.size !== 16) return { bad: 'capacity lost across the rollback (L=' + L + '): size ' + inst.size, n: 9 };
        all.sort((x, y) => x - y);
        const v = dumpViolation(inst.dump(), all, 65536, 16, Hh);
        return { bad: v === null ? null : 'usable-after: ' + v, n: 9 };
    } catch (e) {
        return { bad: 'threw ' + (e && e.stack), n: 0 };
    }
}

function e5Fail32L16(X, Hh) { return e5Fail32(X, Hh, 16); }
function e5Fail32L12(X, Hh) { return e5Fail32(X, Hh, 12); }

/** E5d: rollback cannot re-place a level -> Error (not RangeError), poisoned until clear(). */
function e5Poison(X, Hh) {
    let n = 0;
    try {
        const keys = Hh.collide(65536, 16, 9);
        const inst = new X(65536, 16);
        inst._fill = () => false;
        for (let i = 0; i < 8; i++) inst.add(keys[i]);
        let err = null;
        try { inst.add(keys[8]); } catch (e) { err = e; }
        if (!(err instanceof Error) || err instanceof RangeError || !/POISONED/.test(err.message)) {
            return { bad: 'double failure did not throw the loud non-Range Error', n };
        }
        for (const op of ['has', 'add', 'delete', 'successor', 'predecessor', 'min', 'max']) {
            let e2 = null;
            try { inst[op](5); } catch (e) { e2 = e; }
            if (!(e2 instanceof TypeError)) return { bad: op + ' on a poisoned instance did not throw TypeError', n };
            n++;
        }
        delete inst._fill;
        inst.clear();
        if (!sameJson(inst.dump(), new X(65536, 16).dump())) return { bad: 'clear() did not restore the fresh dump', n };
        inst.add(5).add(70000 - 5000);
        if (!inst.has(5) || inst.successor(5) !== 65000 || inst.size !== 2) return { bad: 'revived instance unusable', n };
        n++;
    } catch (e) {
        return { bad: 'threw ' + (e && e.stack), n };
    }
    return { bad: null, n };
}

const PROBE_FNS = [sameJson, dumpViolation, e1Probe, installCounters, e4Probe, e5Collide, e5Reseed2,
    findL12, e5Fail32, e5Fail32L16, e5Fail32L12, e5Poison];
const WORKER_CODE =
    "const { parentPort, workerData } = require('node:worker_threads');\n" +
    'const COLS = ' + JSON.stringify(COLS) + ';\n' +
    PROBE_FNS.map((f) => f.toString()).join('\n') + '\n' +
    'const PROBES = { ' + PROBE_FNS.map((f) => f.name).join(', ') + ' };\n' +
    '(async () => {\n' +
    '  let out;\n' +
    '  try {\n' +
    '    const X = (await import(workerData.src)).XFastTrie;\n' +
    '    const Hh = await import(workerData.helper);\n' +
    '    out = PROBES[workerData.probe](X, Hh);\n' +
    "  } catch (e) { out = { bad: 'worker threw ' + (e && e.stack), n: 0 }; }\n" +
    '  parentPort.postMessage(out);\n' +
    '})();\n';

// --- mutants + worker runner --------------------------------------------------------

function count(hay, needle) {
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
    return n;
}

/** data: URL of SRC with every [from, to] applied once; null unless each `from` occurs exactly once. */
function mutant(pairs) {
    let s = SRC;
    for (const [from, to] of pairs) {
        if (count(SRC, from) !== 1) return null;
        s = s.replace(from, to);
    }
    return 'data:text/javascript;base64,' + Buffer.from(s, 'utf8').toString('base64');
}

/** One probe in a worker; NEVER rejects: { result, error }. src null = the shipped file. */
function runProbe(src, probe, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const url = src === null ? new URL('../LogLogN.js', import.meta.url).href : src;
        const w = new Worker(WORKER_CODE, { eval: true, workerData: { src: url, helper: HELPER_URL, probe } });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result, error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + ms + ' ms: ' + label);
        }, ms);
        w.on('message', (m) => { result = m; });
        w.on('error', (e) => finish(label + ' worker error: ' + String(e && e.message)));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit ' + code));
    });
}

/** A mutant is KILLED when its probe reports a violation (or the worker hangs / dies). */
function assertKilled(r, label) {
    assert.equal(r.error, null, label + ': a crash / hang is not a kill: ' + String(r.error));
    assert.ok(r.result !== null && typeof r.result.bad === 'string', label + ' SURVIVED: probe passed on the mutant');
    assert.ok(!r.result.bad.startsWith('worker threw '), label + ' did not load (syntax / import), not a kill: ' + r.result.bad.slice(0, 200));
    if (process.env.XFT_WHY) console.log(label + ' KILLED BY: ' + r.result.bad.slice(0, 220));
    return r.result.bad;
}

const M_FULL_LATE = [
    ['        if (this._size === this._c) throwFull(this._c);\n        const sl = this._near();',
        '        const sl = this._near();'],
    ['        this._free = nx[f];\n        ky[f] = x;',
        '        this._free = nx[f];\n        if (this._size === this._c) throwFull(this._c);\n        ky[f] = x;'],
];
const M_ADD_STOP_LONG = [['for (let L = w; L > m; L--) {', 'for (let L = w; L >= m; L--) {']];
const M_FILL_MAX_FIRST = [['if (!this._place(L, i, i, e)) return false;', 'if (!this._place(L, i, e, i)) return false;']];
const M_RESEED_RUNNING = [['const t = fmix32((s1 + Math.imul(a, 0x9e3779b1)) | 0);',
    'const t = fmix32((lv[j + 2] + Math.imul(a, 0x9e3779b1)) | 0);']];
const M_UNDO_SKIP_LEVEL = [['for (let k = this._w; k > L; k--) {', 'for (let k = this._w; k > L + 1; k--) {']];
const M_NO_UNDO = [['        this._undo(L, f);\n    }', '    }']];

const MUT = {
    fullLate: [M_FULL_LATE, 'e4Probe'],
    addStopLong: [M_ADD_STOP_LONG, 'e1Probe'],
    fillMaxFirst: [M_FILL_MAX_FIRST, 'e1Probe'],
    reseedRunning: [M_RESEED_RUNNING, 'e5Reseed2'],
    undoSkipLevel: [M_UNDO_SKIP_LEVEL, 'e5Fail32L12'],
    noUndo: [M_NO_UNDO, 'e5Fail32L16'],
};
const MJOB = {};
for (const k of Object.keys(MUT)) {
    const url = mutant(MUT[k][0]);
    MJOB[k] = { url, job: url === null ? null : runProbe(url, MUT[k][1], 'M-' + k) };
}

async function control(name) {
    for (const [from] of MUT[name][0]) assert.equal(count(SRC, from), 1, 'M-' + name + ' anchor must occur exactly once');
    assert.notEqual(MJOB[name].job, null);
    return assertKilled(await MJOB[name].job, 'M-' + name);
}

// --- E1 -----------------------------------------------------------------------------

test('E1: dump() equals the oracle every 1000 ops (keys, per-level prefix set, min / max per prefix)', OPTS, () => {
    const r = e1Probe(XFastTrie, H);
    assert.equal(r.bad, null, String(r.bad));
    assert.equal(r.n, 15 * 20, 'checkpoints checked');
    assert.ok(r.nonEmpty >= 250, 'non-empty checkpoints ' + r.nonEmpty);
    assert.ok(r.levels > 400, 'levels compared ' + r.levels);
    assert.ok(r.maxKey >= 2 ** 31, 'keys >= 2^31 were exercised: max ' + r.maxKey);
    assert.equal(r.fills, 234, 'every level re-placed once per stream (sum of w over the 15 streams)');
});

test('control M-addStopLong: the update walk one level too far is caught by the per-level min / max', OPTS, async () => {
    const why = await control('addStopLong');
    assert.ok(why.length > 0);
});

test('control M-fillMaxFirst: _fill passing (max, min) is caught by the per-level min / max', OPTS, async () => {
    const why = await control('fillMaxFirst');
    assert.ok(why.length > 0);
});

// --- E4 -----------------------------------------------------------------------------

test('E4: full-reject = one level-w miss (4 _lv + 8 _occ reads), 0 writes, no thread access; bad keys touch nothing', OPTS, () => {
    const r = e4Probe(XFastTrie, H);
    assert.equal(r.bad, null, String(r.bad));
    assert.equal(r.fullRejects, 5, 'five configs have a fresh key (U=2, C=2 is full of every key)');
    assert.ok(r.n >= 100, 'checks ' + r.n);
});

test('E4: the Proxy probe counts real traffic (the shipped has() absent reads 4 _lv + 8 _occ)', () => {
    // independent sanity of the instrument: has(absent) on an empty trie = 1 miss = 4 + 8 reads
    const t = new XFastTrie(256, 8);
    const pc = installCounters(t);
    assert.equal(t.has(7), false);
    assert.equal(pc.cnt._lv.r, 4);
    assert.equal(pc.cnt._occ.r, 8);
    assert.equal(pc.cnt._tk.r, 0, 'a miss on empty buckets reads no _tk');
    pc.reset();
    pc.restore();
    t.add(7);
    assert.equal(t.has(7), true);
});

test('control M-fullLate: the full check after the leaf pop is caught', OPTS, async () => {
    const why = await control('fullLate');
    assert.ok(why.length > 0);
});

// --- E5 -----------------------------------------------------------------------------

test('E5: collide() keys force a reseed; q[1] >= 1, q[2] === 1, seeds = reseedSeeds(s1_start, q[3]), invariants hold', OPTS, () => {
    const r = e5Collide(XFastTrie, H);
    assert.equal(r.bad, null, String(r.bad));
    assert.equal(r.n, 9);
    assert.ok(r.tries >= 1 && r.tries <= 32);
});

test('E5: a reseed needing 2 tries derives from s1_START (reseedSeeds(s1_START, 2)), not chained', OPTS, () => {
    const r = e5Reseed2(XFastTrie, H);
    assert.equal(r.bad, null, String(r.bad));
    assert.equal(r.n, 9);
});

test('control M-reseedRunning: chained seed derivation is caught', OPTS, async () => {
    const why = await control('reseedRunning');
    assert.ok(why.length > 0);
});

test('E5: 32 failed reseeds at level w = 16 -> RangeError, dump equal, start seeds restored, usable after', OPTS, () => {
    const r = e5Fail32(XFastTrie, H, 16);
    assert.equal(r.bad, null, String(r.bad));
    assert.equal(r.n, 9);
});

test('E5: 32 failed reseeds at level 12 < w -> rollback leaves ALL levels equal', OPTS, () => {
    const keys = findL12(H);
    assert.notEqual(keys, null);
    assert.equal(keys.length, 9);
    const g = H.levelGeometry(65536, 16);
    const B = g.levels[12].B;
    assert.equal(new Set(keys.map((x) => x >> 4)).size, 9, 'distinct level-12 prefixes');
    // independent recomputation of the shared bucket pair
    const h = (p, s) => H.fmix32(p ^ s) & (B - 1);
    for (const x of keys) {
        assert.equal(h(x >> 4, g.levels[12].s1), h(keys[0] >> 4, g.levels[12].s1));
        assert.equal(h(x >> 4, g.levels[12].s2), h(keys[0] >> 4, g.levels[12].s2));
    }
    const r = e5Fail32(XFastTrie, H, 12);
    assert.equal(r.bad, null, String(r.bad));
    assert.equal(r.n, 9);
});

test('control M-undoSkipLevel: a rollback that skips one prefix level is caught (level 12 < w)', OPTS, async () => {
    const why = await control('undoSkipLevel');
    assert.ok(why.length > 0);
});

test('control M-noUndo: a skipped rollback is caught', OPTS, async () => {
    const why = await control('noUndo');
    assert.ok(why.length > 0);
});

test('E5: a failed rollback POISONS (loud Error; TypeError on all 7 hot methods) until clear() restores the fresh dump', OPTS, () => {
    const r = e5Poison(XFastTrie, H);
    assert.equal(r.bad, null, String(r.bad));
    assert.equal(r.n, 8);
});

test('worker runner on the shipped file: every probe passes (instrument control for the mutant jobs)', OPTS, async () => {
    for (const p of ['e1Probe', 'e4Probe', 'e5Reseed2', 'e5Fail32L12', 'e5Fail32L16', 'e5Poison']) {
        const r = await runProbe(null, p, 'real ' + p);
        assert.equal(r.error, null, String(r.error));
        assert.equal(r.result.bad, null, p + ': ' + String(r.result.bad));
    }
});

test('hang rule control: a probe worker that never returns is terminated and reported', OPTS, async () => {
    const spin = 'data:text/javascript;base64,' + Buffer.from('export class XFastTrie { constructor() { for (;;) {} } }\n', 'utf8').toString('base64');
    const r = await runProbe(spin, 'e5Poison', 'spin', 300);
    assert.ok(r.error !== null && /^hang > 300 ms/.test(r.error), String(r.error));
});
