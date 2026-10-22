/**
 * @zakkster/lite-loglogn -- XFastTrie fuzz-oracle worker (G-B1, G4). Not a test
 * file: the npm glob `test/*.test.js` never matches it. Inert when merely
 * imported; runs only as a node:worker_threads Worker (workerData.xftJob).
 *
 * runXft(Cls, U, C, nOps, seed) replays the seeded stream of
 * test/helpers/xftStream.mjs genStream(U, C, nOps, seed) (fill to C, 50
 * full-throws, then MIX / REFILL / DRAIN / CLUSTER churn, ~3% bad keys, -0) on
 * `new Cls(U, C)` and compares EVERY return value and the size, per op, with
 * five oracles (each keeps its own cmp / div / first counters):
 *   StratifiedBitset  in-package, only U <= 2^25 (null above);
 *   Scapegoat, Treap  lite-logn, strict successor / predecessor, min / max via
 *                     select(0) / select(size - 1);
 *   SkipList          lite-logn, strict successor / predecessor, has via get,
 *                     min / max via successor(-1) / predecessor(U);
 *   SortedArray       lite-logn, strict successor / predecessor / min / max.
 * All pools are sized to C. The capacity rule (add of a NEW key at size === C
 * throws RangeError, the key is NOT inserted anywhere) and the bad-key rule are
 * taken from the SPEC, held by a plain sorted JS array (`truth`) and checked in
 * the `contract` bucket; a bad key never reaches an oracle.
 *
 * Every CHECK_EVERY ops (and after the last op) a CHECKPOINT runs:
 *   walks   min() -> successor() and max() -> predecessor() equal the truth
 *           array exactly (and neither exceeds C + 1 steps: a broken thread
 *           never hangs the replay);
 *   cuckoo  one lite-o1 CuckooMap per level k = 1..w holds prefix -> refcount
 *           (prefix = floor(key / 2^(w-k)), plain arithmetic, no shifts). The
 *           instance's dump(): size and keys equal the truth; levels[k-1].prefix
 *           equals the map's key set; min / max of each prefix equal the extreme
 *           truth keys in that prefix group; the map's entry count equals the
 *           prefix count; levels[k-1].capacity equals
 *           new CuckooMap(min(C, 2^k)).capacity.
 *
 * Worker mode: src === null imports the shipped ../LogLogN.js, a string src (a
 * mutant built by the test from the real source text) is imported via a data:
 * URL. job 'fuzz' runs the (U, C, nOps, seed) configs of `configs`; job 'clear'
 * runs the clear()-reuse scenario (clearReuse). Posts ONE message
 * `{ ok: true, result }` or `{ ok: false, message }`.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CuckooMap } from '@zakkster/lite-o1';
import { Scapegoat, SkipList, Treap, SortedArray } from '@zakkster/lite-logn';
import { StratifiedBitset } from '../LogLogN.js';
import {
    genStream, badKeys, keyAt,
    OP_ADD, OP_DELETE, OP_HAS, OP_SUCC, OP_PRED, OP_MIN, OP_MAX,
} from './helpers/xftStream.mjs';

export const ORACLES = ['StratifiedBitset', 'Scapegoat', 'SkipList', 'Treap', 'SortedArray'];
export const CHECK_EVERY = 1024;
export const SB_MAX_U = 2 ** 25;

const RANGE_ERR = 'throw:RangeError';
const OTHER_ERR = 'throw:other';
const OP_NAME = ['add', 'delete', 'has', 'successor', 'predecessor', 'min', 'max'];

function isKey(x, U) {
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < U;
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

/** The plain sorted array every expectation about membership and capacity comes from. */
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

/**
 * @returns {{ U: number, C: number, w: number, nOps: number, seed: number, checkpoints: number,
 *   oracles: Object<string, {cmp:number, div:number, first:object|null}|null>,
 *   contract: object, walks: object, cuckoo: object, opCounts: number[],
 *   fullThrows: number, levelsChecked: number, size: number }}
 */
export function runXft(Cls, U, C, nOps, seed) {
    const st = genStream(U, C, nOps, seed);
    const BAD = badKeys(U);
    const w = 32 - Math.clz32(U - 1);

    const s = new Cls(U, C);
    const sb = U <= SB_MAX_U ? new StratifiedBitset(U) : null;
    const sg = new Scapegoat(C);
    const sk = new SkipList(C, (seed ^ 0x13572468) >>> 0);
    const tr = new Treap(C, (seed ^ 0x2468ace0) >>> 0);
    const sa = new SortedArray(C);
    const RS = bucket();
    const RG = bucket();
    const RK = bucket();
    const RT = bucket();
    const RA = bucket();
    const CT = bucket(); // contract: bad keys, capacity, instance size
    const WK = bucket(); // thread walks
    const CK = bucket(); // CuckooMap per-level cross-check
    const truth = new Truth();
    const opCounts = [0, 0, 0, 0, 0, 0, 0];
    let fullThrows = 0;
    let checkpoints = 0;
    let levelsChecked = 0;
    let absQ = 0; // successor / predecessor of a valid ABSENT key (the _near path)
    let presQ = 0; // successor / predecessor of a PRESENT key (level-w hit + thread hop)

    // one CuckooMap per level k = 1..w (index k - 1): prefix -> refcount
    const cms = new Array(w);
    const capK = new Array(w);
    for (let k = 1; k <= w; k++) {
        const levelCap = Math.min(C, 2 ** k);
        cms[k - 1] = new CuckooMap(levelCap);
        capK[k - 1] = cms[k - 1].capacity;
    }
    const pre = (key, k) => Math.floor(key / 2 ** (w - k));

    const cuckooAdd = (key) => {
        for (let k = 1; k <= w; k++) {
            const p = pre(key, k);
            const c = cms[k - 1].get(p);
            cms[k - 1].set(p, c === undefined ? 1 : c + 1);
        }
    };
    const cuckooDel = (key) => {
        for (let k = 1; k <= w; k++) {
            const p = pre(key, k);
            const c = cms[k - 1].get(p);
            if (c === 1) cms[k - 1].delete(p);
            else cms[k - 1].set(p, c - 1);
        }
    };

    const walk = (at, up) => {
        const keys = truth.a;
        const n = keys.length;
        let j = 0;
        let k = up ? s.min() : s.max();
        WK.cmp++;
        for (; k !== undefined; k = up ? s.successor(k) : s.predecessor(k)) {
            const want = up ? keys[j] : keys[n - 1 - j];
            check(WK, up ? 'walk-up' : 'walk-down', k, at, k, want);
            if (++j > C + 1) break;
        }
        check(WK, up ? 'walk-up-len' : 'walk-down-len', null, at, j, n);
    };

    const cuckooCheck = (at) => {
        const d = s.dump();
        const keys = truth.a;
        check(CK, 'dump.size', null, at, d.size, keys.length);
        check(CK, 'dump.bits', null, at, d.bits, w);
        check(CK, 'dump.keys', null, at, Array.from(d.keys).join(','), keys.join(','));
        check(CK, 'dump.levels.length', null, at, d.levels.length, w);
        for (let k = 1; k <= w; k++) {
            const lvl = d.levels[k - 1];
            const cm = cms[k - 1];
            const want = [];
            for (const [p] of cm) want.push(p);
            want.sort((a, b) => a - b);
            check(CK, 'level' + k + '.prefix', null, at, Array.from(lvl.prefix).join(','), want.join(','));
            check(CK, 'level' + k + '.count', null, at, lvl.prefix.length, cm.size);
            check(CK, 'level' + k + '.capacity', null, at, lvl.capacity, capK[k - 1]);
            // min / max KEY of every prefix group, from the truth array
            const mn = [];
            const mx = [];
            let last = -1;
            for (let i = 0; i < keys.length; i++) {
                const p = pre(keys[i], k);
                if (p !== last) {
                    mn.push(keys[i]);
                    mx.push(keys[i]);
                    last = p;
                } else {
                    mx[mx.length - 1] = keys[i];
                }
            }
            check(CK, 'level' + k + '.min', null, at, Array.from(lvl.min).join(','), mn.join(','));
            check(CK, 'level' + k + '.max', null, at, Array.from(lvl.max).join(','), mx.join(','));
            levelsChecked++;
        }
    };

    const checkpoint = (at) => {
        checkpoints++;
        // the walks get their own try: a walk throw is a WALK divergence (WK), never a CK one
        try {
            walk(at, true);
            walk(at, false);
        } catch (e) {
            check(WK, 'walk-threw', null, at, String(e && e.name), 'no throw');
        }
        try {
            cuckooCheck(at);
        } catch (e) {
            check(CK, 'checkpoint-threw', null, at, String(e && e.name), 'no throw');
        }
    };

    for (let i = 0; i < nOps; i++) {
        const o = st.op[i];
        const x = keyAt(st, BAD, i);
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
            const want = o === OP_ADD ? RANGE_ERR : (o === OP_HAS || o === OP_DELETE) ? false : undefined;
            check(CT, name, x, i, got, want);
        } else {
            const k = o < OP_MIN ? x + 0 : 0;
            if (o === OP_SUCC || o === OP_PRED) {
                if (truth.has(k)) presQ++;
                else absQ++;
            }
            if (o === OP_ADD) {
                if (truth.has(k)) {
                    check(CT, name, x, i, got, s);
                } else if (truth.a.length === C) {
                    fullThrows++;
                    check(CT, name + '-full', x, i, got, RANGE_ERR);
                } else {
                    check(CT, name, x, i, got, s);
                    truth.add(k);
                    if (sb !== null) sb.add(k);
                    sg.set(k, 0);
                    sk.set(k, 0);
                    tr.set(k, 0);
                    sa.set(k, 0);
                    cuckooAdd(k);
                }
            } else if (o === OP_DELETE) {
                const was = truth.has(k);
                check(CT, name, x, i, got, was);
                if (sb !== null) check(RS, name, x, i, got, sb.delete(k));
                check(RG, name, x, i, got, sg.delete(k));
                check(RK, name, x, i, got, sk.delete(k));
                check(RT, name, x, i, got, tr.delete(k));
                check(RA, name, x, i, got, sa.delete(k));
                if (was) {
                    truth.del(k);
                    cuckooDel(k);
                }
            } else if (o === OP_HAS) {
                if (sb !== null) check(RS, name, x, i, got, sb.has(k));
                check(RG, name, x, i, got, sg.has(k));
                check(RK, name, x, i, got, sk.get(k) !== undefined);
                check(RT, name, x, i, got, tr.has(k));
                check(RA, name, x, i, got, sa.has(k));
            } else if (o === OP_SUCC) {
                if (sb !== null) check(RS, name, x, i, got, sb.successor(k));
                check(RG, name, x, i, got, sg.successor(k));
                check(RK, name, x, i, got, sk.successor(k));
                check(RT, name, x, i, got, tr.successor(k));
                check(RA, name, x, i, got, sa.successor(k));
            } else if (o === OP_PRED) {
                if (sb !== null) check(RS, name, x, i, got, sb.predecessor(k));
                check(RG, name, x, i, got, sg.predecessor(k));
                check(RK, name, x, i, got, sk.predecessor(k));
                check(RT, name, x, i, got, tr.predecessor(k));
                check(RA, name, x, i, got, sa.predecessor(k));
            } else if (o === OP_MIN) {
                if (sb !== null) check(RS, name, null, i, got, sb.min());
                check(RG, name, null, i, got, sg.select(0));
                check(RK, name, null, i, got, sk.successor(-1));
                check(RT, name, null, i, got, tr.select(0));
                check(RA, name, null, i, got, sa.min());
            } else {
                if (sb !== null) check(RS, name, null, i, got, sb.max());
                check(RG, name, null, i, got, sg.select(sg.size - 1));
                check(RK, name, null, i, got, sk.predecessor(U));
                check(RT, name, null, i, got, tr.select(tr.size - 1));
                check(RA, name, null, i, got, sa.max());
            }
        }
        const sz = s.size;
        check(CT, 'size', null, i, sz, truth.a.length);
        if (sb !== null) check(RS, 'size', null, i, sz, sb.size);
        check(RG, 'size', null, i, sz, sg.size);
        check(RK, 'size', null, i, sz, sk.size);
        check(RT, 'size', null, i, sz, tr.size);
        check(RA, 'size', null, i, sz, sa.size);
        if ((i + 1) % CHECK_EVERY === 0 || i === nOps - 1) checkpoint(i);
    }
    return {
        U, C, w, nOps, seed, checkpoints,
        oracles: { StratifiedBitset: sb !== null ? RS : null, Scapegoat: RG, SkipList: RK, Treap: RT, SortedArray: RA },
        contract: CT, walks: WK, cuckoo: CK, opCounts, fullThrows, levelsChecked, absQ, presQ, size: s.size,
    };
}

// --- clear() then reuse (G6) ------------------------------------------------------

/**
 * After clear() the instance must behave exactly like a fresh one: a full churn
 * stream replayed on (a) a used-then-cleared instance and (b) a fresh one gives
 * the same answer per op, and dump() of the two is equal after the clear and at
 * the end. The used instance first absorbs a DIFFERENT stream (other seed) so
 * its `_occ` / `_tk` / thread hold stale data when clear() runs.
 * @returns {{ ops: number, divergences: number, first: string|null, dumpsCompared: number }}
 */
export function clearReuse(Cls, U, C, nOps, seed) {
    const BAD = badKeys(U);
    const used = new Cls(U, C);
    const fresh = new Cls(U, C);
    const pre = genStream(U, C, nOps, (seed ^ 0x5a5a5a5a) >>> 0);
    for (let i = 0; i < nOps; i++) {
        try {
            const o = pre.op[i];
            const x = keyAt(pre, BAD, i);
            if (o === OP_ADD) used.add(x);
            else if (o === OP_DELETE) used.delete(x);
        } catch (e) {
            // full throws and bad keys are part of the stream
        }
    }
    const sizeBefore = used.size;
    used.clear();
    let div = 0;
    let first = null;
    let dumps = 0;
    const note = (msg) => {
        div++;
        if (first === null) first = msg;
    };
    const dumpText = (t) => {
        const d = t.dump();
        return JSON.stringify(d, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
    };
    const cmpDump = (tag) => {
        dumps++;
        let a;
        let b;
        try {
            a = dumpText(used);
            b = dumpText(fresh);
        } catch (e) {
            return note(tag + ' dump threw ' + (e && e.name));
        }
        if (a !== b) note(tag + ' dump differs');
        if (used.size !== fresh.size) note(tag + ' size ' + used.size + ' != ' + fresh.size);
        if (used.byteLength !== fresh.byteLength) note(tag + ' byteLength differs');
    };
    cmpDump('after-clear');
    const st = genStream(U, C, nOps, seed);
    const run = (t, o, x) => {
        try {
            const r = o === OP_ADD ? t.add(x) : o === OP_DELETE ? t.delete(x) : o === OP_HAS ? t.has(x)
                : o === OP_SUCC ? t.successor(x) : o === OP_PRED ? t.predecessor(x)
                    : o === OP_MIN ? t.min() : t.max();
            return r === t ? 'this' : show(r);
        } catch (e) {
            return e instanceof RangeError ? RANGE_ERR : OTHER_ERR;
        }
    };
    for (let i = 0; i < nOps; i++) {
        const o = st.op[i];
        const x = keyAt(st, BAD, i);
        const a = run(used, o, x);
        const b = run(fresh, o, x);
        if (a !== b) note('op ' + i + ' ' + OP_NAME[o] + '(' + show(x) + ') used ' + a + ' fresh ' + b);
        if ((i + 1) % CHECK_EVERY === 0) cmpDump('op ' + (i + 1));
    }
    cmpDump('end');
    return { ops: nOps, divergences: div, first, dumpsCompared: dumps, sizeBefore };
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.xftJob === true) {
    let msg;
    try {
        const { src, job, configs } = workerData;
        const mod = src === null
            ? await import('../LogLogN.js')
            : await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
        if (typeof mod.XFastTrie !== 'function') throw new TypeError('build exports no XFastTrie');
        const out = [];
        for (const c of configs) {
            out.push(job === 'clear'
                ? { U: c.U, C: c.C, ...clearReuse(mod.XFastTrie, c.U, c.C, c.nOps, c.seed) }
                : runXft(mod.XFastTrie, c.U, c.C, c.nOps, c.seed));
        }
        msg = { ok: true, result: out };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
