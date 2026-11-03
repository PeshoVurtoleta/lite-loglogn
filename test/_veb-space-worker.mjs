/**
 * @zakkster/lite-loglogn -- vEBTree no-growth worker (0.5.0 G2-B3, PLAN-vebtree
 * task 6, C-14, C-19). Not a test file: the npm glob `test/*.test.js` never
 * matches it. Inert when merely imported (the parent side, startJob, is
 * exported); the job runs only as a node:worker_threads Worker
 * (workerData.vebSpaceJob === true).
 *
 * Parent side: startJob(job, label, ms) spawns ONE Worker with a kill timer and
 * NEVER rejects: it resolves { result, error }; error is a string on a hang
 * (timeout), a worker error, a nonzero exit or a missing result. The caller
 * treats every error as a FAIL (fail closed).
 *
 * Job { kind: 'real' | 'growing' | 'extra', U, nOps, seed }: nOps mixed ops on
 * ONE instance with two independent mulberry32 streams (op kind, key). Posts
 * { byteBefore, byteAfter, ident: { _t, _g, _p }, fields, counts }, where
 * ident[x] is true when this[x] is the SAME object after the ops and fields is
 * the sorted list of typed-array field names before / after.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { vEBTree } from '../LogLogN.js';

export const KILL_MS = 100000;

const SELF_URL = new URL(import.meta.url);

/** Starts job in a fresh Worker (see the header). */
export function startJob(job, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(SELF_URL, { workerData: { vebSpaceJob: true, job } });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error === null && result === null) error = label + ': worker posted no result';
            resolve({ result: error === null ? result : null, error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => { result = m; });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

// mulberry32: 32-bit-exact seeded PRNG.
function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Control: replaces `_t` / `_g` / `_p` by same-length copies on every 1024th add (identity only).
class GrowingVeb extends vEBTree {
    add(x) {
        this._cnt = (this._cnt | 0) + 1;
        if ((this._cnt & 1023) === 0) {
            const n = new Uint32Array(this._t.length);
            n.set(this._t);
            this._t = n;
            this._g = this._g.slice();
            this._p = new Int32Array(this._p.length);
        }
        return super.add(x);
    }
}

// Control: grows an extra typed-array column on the first add (column set).
class ExtraColVeb extends vEBTree {
    add(x) {
        if (this._aux === undefined) this._aux = new Int32Array(1);
        return super.add(x);
    }
}

function typedFields(o) {
    const out = [];
    for (const k of Object.keys(o)) {
        if (ArrayBuffer.isView(o[k])) out.push(k);
    }
    return out.sort().join(',');
}

function run(job) {
    const Cls = job.kind === 'growing' ? GrowingVeb : job.kind === 'extra' ? ExtraColVeb : vEBTree;
    const U = job.U;
    const v = new Cls(U);
    const t0 = v._t, g0 = v._g, p0 = v._p;
    const byteBefore = v.byteLength;
    const fieldsBefore = typedFields(v);
    // Key pool of 4096 keys spread over [0, U) so deletes hit present keys.
    const rk = mulberry32(job.seed ^ 0x9E3779B9);
    const ro = mulberry32(job.seed);
    const pool = new Uint32Array(4096);
    for (let i = 0; i < pool.length; i++) pool[i] = Math.floor(rk() * U);
    const counts = { add: 0, del: 0, query: 0, hits: 0 };
    for (let i = 0; i < job.nOps; i++) {
        const o = ro();
        const k = pool[Math.floor(rk() * 4096)];
        if (o < 0.4) { v.add(k); counts.add++; }
        else if (o < 0.8) { v.delete(k); counts.del++; }
        else {
            counts.query++;
            const q = i % 5;
            const r = q === 0 ? v.has(k) : q === 1 ? v.successor(k) : q === 2 ? v.predecessor(k) : q === 3 ? v.min() : v.max();
            if (r !== undefined && r !== false) counts.hits++;
        }
    }
    counts.size = v.size;
    return {
        byteBefore,
        byteAfter: v.byteLength,
        ident: { _t: v._t === t0, _g: v._g === g0, _p: v._p === p0 },
        fieldsBefore,
        fieldsAfter: typedFields(v),
        counts,
    };
}

if (!isMainThread && workerData && workerData.vebSpaceJob === true) {
    let msg;
    try { msg = run(workerData.job); } catch (e) { msg = { failure: e && e.stack ? String(e.stack) : String(e) }; }
    parentPort.postMessage(msg);
}
