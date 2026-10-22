/**
 * @zakkster/lite-loglogn -- sibling oracle worker (B2a, ADDENDUM 28). Not a test
 * file: the npm glob `test/*.test.js` never matches it.
 *
 * runSibling(Cls, U, nOps, seed) replays the seeded A1-style stream
 * (test/helpers/tierStream.mjs genStream: mixed / dense / sparse / edge phases +
 * bad keys) on `new Cls(U)` and compares EVERY return value and the size against
 * four oracles from sibling packages (devDependencies only; nothing here enters
 * LogLogN.js). Each oracle keeps its own divergence count:
 *
 *   BitSet      lite-o1 BitSet(U), U <= 2^25. has -> test(k); delete -> test(k)
 *               before unset(k); successor(x) -> nextSet(x + 1) (nextSet is
 *               INCLUSIVE >= from; -1 -> undefined; nextSet(U) is -1); min ->
 *               firstSet() (-1 -> undefined); size -> popcount at checkpoints.
 *               No predecessor / max in BitSet: not compared.
 *   EliasFano   lite-o1 EliasFano, STATIC: every CHECK_EVERY ops (and after the
 *               last op) a snapshot of the live set (the worker's own model, never
 *               the build under test) is encoded; successor(x) -> nextGEQ(x + 1)
 *               (INCLUSIVE; -1 -> undefined) for every live k at x = k and k - 1,
 *               the edge keys and 64 seeded uniform x; min -> access(0); max ->
 *               access(n - 1); size -> length.
 *   Scapegoat   lite-logn Scapegoat(cap): strict successor / predecessor,
 *               undefined for absent; min -> select(0); max -> select(size - 1).
 *   SortedArray lite-logn SortedArray(cap): strict successor / predecessor, min,
 *               max, has, delete, size.
 * cap = the stream's exact maximum live count (a pre-pass over the truth model),
 * so a pool overflow would throw (a FAIL), never silently drop.
 *
 * Keys: a valid key is a number, an integer, in [0, U) (the SPEC contract,
 * defined here, not read from the build); -0 is valid and aliases 0 (D1), and
 * every oracle receives the normalized k = x + 0 (a Float64Array-backed oracle
 * would otherwise hand back -0). A bad key is checked against the CONTRACT
 * (has / delete false, successor / predecessor undefined, add RangeError) in
 * the `contract` bucket, never fed to an oracle.
 *
 * Worker mode (workerData.siblingJob === true): src === null imports the
 * shipped ../LogLogN.js; a string src (a mutant built by the test from the real
 * source text) is imported via a data: URL. Posts ONE message
 * `{ ok: true, result }` or `{ ok: false, message }`.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BitSet, EliasFano } from '@zakkster/lite-o1';
import { Scapegoat, SortedArray } from '@zakkster/lite-logn';
import {
    genStream, badKeys, mulberry32,
    OP_ADD, OP_DELETE, OP_HAS, OP_SUCC, OP_PRED, OP_MIN,
} from './helpers/tierStream.mjs';

export const ORACLES = ['BitSet', 'EliasFano', 'Scapegoat', 'SortedArray'];
export const CHECK_EVERY = 1024;
export const BITSET_MAX_U = 2 ** 25;

const OP_NAME = ['add', 'delete', 'has', 'successor', 'predecessor', 'min', 'max'];
const RANGE_ERR = 'throw:RangeError';
const OTHER_ERR = 'throw:other';

function isKey(x, U) {
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < U;
}

/** -1 (the lite-o1 absent value) -> undefined; any other number unchanged. */
function neg(v) {
    return v === -1 ? undefined : v;
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

/**
 * @returns {{ U: number, nOps: number, seed: number, cap: number, checkpoints: number,
 *   oracles: Object<string, {cmp:number, div:number, first:object|null}>,
 *   contract: {cmp:number, div:number, first:object|null}, opCounts: number[],
 *   sparseCross: number, cov: {crossSucc:number, crossPred:number, lastBlockUndef:number},
 *   size: number }}
 */
export function runSibling(Cls, U, nOps, seed) {
    const st = genStream(U, nOps, seed);
    const BAD = badKeys(U);

    // pre-pass: the truth model's maximum live count sizes the lite-logn pools
    const mem = new Uint8Array(U);
    let live = 0;
    let maxLive = 0;
    for (let i = 0; i < nOps; i++) {
        const o = st.op[i];
        if (o !== OP_ADD && o !== OP_DELETE) continue;
        const x = st.bad[i] >= 0 ? BAD[st.bad[i]] : st.key[i];
        if (!isKey(x, U)) continue;
        const k = x + 0;
        if (o === OP_ADD) {
            if (mem[k] === 0) {
                mem[k] = 1;
                live++;
                if (live > maxLive) maxLive = live;
            }
        } else if (mem[k] === 1) {
            mem[k] = 0;
            live--;
        }
    }
    const cap = maxLive > 0 ? maxLive : 1;

    const s = new Cls(U);
    const bs = U <= BITSET_MAX_U ? new BitSet(U) : null;
    const sg = new Scapegoat(cap);
    const sa = new SortedArray(cap);
    const RB = bucket();
    const RE = bucket();
    const RG = bucket();
    const RA = bucket();
    const C = bucket();
    const cov = { crossSucc: 0, crossPred: 0, lastBlockUndef: 0 };
    const opCounts = [0, 0, 0, 0, 0, 0, 0];
    const lastBlock = (U - 1) >>> 10;
    const rnd = mulberry32((seed ^ 0x2545f491) >>> 0);
    const edges = [0, 1, 31, 32, 33, 1023, 1024, 1025, 32767, 32768, 32769,
        U - 1, U - 2, U - 31, U - 32, U - 33, U - 1023, U - 1024, U - 1025].filter((e) => e >= 0 && e < U);

    // the truth model for the EliasFano snapshots (own copy, never the build)
    const liveArr = [];
    const pos = new Map();
    let checkpoints = 0;

    const efQuery = (ef, x, at) => {
        check(RE, 'successor', x, at, s.successor(x), neg(ef.nextGEQ(x + 1)));
    };
    const checkpoint = (at) => {
        checkpoints++;
        const snap = Float64Array.from(liveArr).sort();
        const ef = new EliasFano(snap);
        check(RE, 'size', null, at, s.size, ef.length);
        check(RE, 'min', null, at, s.min(), ef.access(0));
        check(RE, 'max', null, at, s.max(), ef.access(ef.length - 1));
        for (let j = 0; j < snap.length; j++) {
            const k = snap[j];
            efQuery(ef, k, at);
            if (k > 0) efQuery(ef, k - 1, at);
        }
        for (let j = 0; j < edges.length; j++) efQuery(ef, edges[j], at);
        for (let j = 0; j < 64; j++) efQuery(ef, Math.floor(rnd() * U), at);
        if (bs !== null) check(RB, 'size', null, at, s.size, bs.size);
    };

    for (let i = 0; i < nOps; i++) {
        const o = st.op[i];
        const x = st.bad[i] >= 0 ? BAD[st.bad[i]] : st.key[i];
        opCounts[o]++;
        let got;
        try {
            if (o === OP_ADD) got = s.add(x);
            else if (o === OP_DELETE) got = s.delete(x);
            else if (o === OP_HAS) got = s.has(x);
            else if (o === OP_SUCC) got = s.successor(x);
            else if (o === OP_PRED) got = s.predecessor(x);
            else if (o === OP_MIN) got = s.min();
            else got = s.max();
        } catch (e) {
            got = e instanceof RangeError ? RANGE_ERR : OTHER_ERR;
        }
        const name = OP_NAME[o];
        if (o < OP_MIN && !isKey(x, U)) {
            // bad key: the SPEC contract, not an oracle
            const want = o === OP_ADD ? RANGE_ERR : (o === OP_HAS || o === OP_DELETE) ? false : undefined;
            check(C, name, x, i, got, want);
        } else {
            const k = o < OP_MIN ? x + 0 : 0;
            if (o === OP_ADD) {
                check(C, name, x, i, got, s);
                if (bs !== null) bs.set(k);
                sg.set(k, 0);
                sa.set(k, 0);
                if (!pos.has(k)) {
                    pos.set(k, liveArr.length);
                    liveArr.push(k);
                }
            } else if (o === OP_DELETE) {
                if (bs !== null) {
                    const was = bs.test(k);
                    bs.unset(k);
                    check(RB, name, x, i, got, was);
                }
                check(RG, name, x, i, got, sg.delete(k));
                check(RA, name, x, i, got, sa.delete(k));
                if (pos.has(k)) {
                    const j = pos.get(k);
                    const last = liveArr.pop();
                    if (last !== k) {
                        liveArr[j] = last;
                        pos.set(last, j);
                    }
                    pos.delete(k);
                }
            } else if (o === OP_HAS) {
                if (bs !== null) check(RB, name, x, i, got, bs.test(k));
                check(RG, name, x, i, got, sg.has(k));
                check(RA, name, x, i, got, sa.has(k));
            } else if (o === OP_SUCC) {
                if (bs !== null) check(RB, name, x, i, got, neg(bs.nextSet(k + 1)));
                check(RG, name, x, i, got, sg.successor(k));
                const w = sa.successor(k);
                check(RA, name, x, i, got, w);
                if (U >= 8192) {
                    if (w !== undefined && (w >>> 10) - (k >>> 10) >= 3) cov.crossSucc++;
                    if (w === undefined && sa.size > 0 && (k >>> 10) === lastBlock && k < U - 1) cov.lastBlockUndef++;
                }
            } else if (o === OP_PRED) {
                check(RG, name, x, i, got, sg.predecessor(k));
                const w = sa.predecessor(k);
                check(RA, name, x, i, got, w);
                if (U >= 8192 && w !== undefined && (k >>> 10) - (w >>> 10) >= 3) cov.crossPred++;
            } else if (o === OP_MIN) {
                if (bs !== null) check(RB, name, null, i, got, neg(bs.firstSet()));
                check(RG, name, null, i, got, sg.select(0));
                check(RA, name, null, i, got, sa.min());
            } else {
                check(RG, name, null, i, got, sg.select(sg.size - 1));
                check(RA, name, null, i, got, sa.max());
            }
        }
        check(RG, 'size', null, i, s.size, sg.size);
        check(RA, 'size', null, i, s.size, sa.size);
        if ((i + 1) % CHECK_EVERY === 0 || i === nOps - 1) checkpoint(i);
    }
    return {
        U,
        nOps,
        seed,
        cap,
        checkpoints,
        oracles: { BitSet: bs !== null ? RB : null, EliasFano: RE, Scapegoat: RG, SortedArray: RA },
        contract: C,
        opCounts,
        sparseCross: st.sparseCross,
        cov,
        size: s.size,
    };
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.siblingJob === true) {
    let msg;
    try {
        const { U, nOps, seed, src } = workerData;
        const mod = src === null
            ? await import('../LogLogN.js')
            : await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
        if (typeof mod.StratifiedBitset !== 'function') throw new TypeError('build exports no StratifiedBitset');
        msg = { ok: true, result: runSibling(mod.StratifiedBitset, U, nOps, seed) };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
