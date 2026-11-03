/**
 * @zakkster/lite-loglogn -- vEBTree torture V2 helpers + the V2b / CV4 Worker
 * (0.5.0 G2-B1, PLAN-vebtree G2 task 2, C-19, C-21). Not a test file: the npm
 * glob `test/*.test.js` never matches it. Inert when merely imported (torture.mjs
 * imports the V2 builders and startVebTorture); the job runs only as a
 * node:worker_threads Worker (workerData.vebTorture === true).
 *
 * V2 shape (shared by the in-process V2a lane and the Worker): U = 2^28 (w = 28:
 * root lo = 16 / hi = 12; each root cluster is an INTERNAL w = 16 node, lo = 8,
 * whose clusters are w = 8 leaves). The ring covers the 64 root clusters
 * c = 64j + 7 (j = 0..63), one cluster per 8-op group, with keys (c << 16) | r16, r16 odd in [1, 0xFFFD].
 * Every cluster also holds 4 PERMANENT keys, low halves 0x0000 / 0x0100 /
 * 0x8000 / 0xFFFE (even: the ring never adds or deletes them), so the root
 * min / max are permanent, every ring key sits strictly inside its cluster's
 * [min, max], and add / delete / has / successor / predecessor on a ring key
 * descend root -> internal cluster -> leaf (depth 2) on every op. The step has
 * no min / max op (both are O(1) root reads; V1 covers them).
 *
 * Parent side: startVebTorture(job, label, ms) spawns ONE Worker with a kill
 * timer and NEVER rejects: it resolves { result, error }; error is a string on a
 * spawn failure (a synchronous `new Worker` throw), a hang (timeout), a worker
 * error, a nonzero exit or a missing result. The caller
 * treats every error as a FAIL (fail closed, C-19: a corrupted tree can loop
 * forever on a leaf scan).
 *
 * Worker side, ONE function (runAbGrowth) for the real build (job.src === null
 * imports ../LogLogN.js) and the CV4 mutant (job.src = source text imported
 * through a data: URL): build the V2 tree, job.warmup ops, then measureOps
 * (job.ops, warmup 0, stabilize 'deep') -- the Worker's OWN arrayBuffers.
 * Posts { abGrowth, settled, verdict, adds, byteLength0 / 1, floor0 / 1,
 * zero, held } or { error }.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const KILL_MS = 60000;
export const V2_U = 1 << 28;
export const V2_BYTES = 33718804;       // C-16: byteLength at U = 2^28
export const V2_CLUSTERS = 64;
export const V2_FLOOR = 3;              // every ring cluster holds >= 3 keys
const V2_KEYS = 65536;                  // ring entries, power of two
const V2_MASK = V2_KEYS - 1;
const V2_HALF = V2_KEYS >>> 1;
const V2_PERM = [0x0000, 0x0100, 0x8000, 0xFFFE];

const SELF_URL = new URL(import.meta.url);

/** Root cluster index of ring cluster j (0..63). */
export function v2Cluster(j) {
    return 64 * j + 7;
}

/**
 * The V2 ring: entry i -> cluster v2Cluster((i >>> 3) & 63), odd low half. An
 * 8-op group of the step reads one cluster's entries and consecutive groups
 * rotate through all 64 (the add at i and the delete of i - 1 + HALF land in
 * the same cluster: HALF / 8 = 4096 = 0 mod 64). Cold.
 */
export function v2Ring(seed) {
    const k = new Uint32Array(V2_KEYS);
    let s = seed | 0;
    for (let i = 0; i < V2_KEYS; i++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        k[i] = ((v2Cluster((i >>> 3) & 63) << 16) | (((s >>> 0) & 0xFFFC) | 1)) >>> 0;
    }
    return k;
}

/** Permanent keys + populate()'s ring keys (indices = 0 mod 8, first half). Cold. */
export function v2Populate(set, k) {
    for (let j = 0; j < V2_CLUSTERS; j++) {
        for (let p = 0; p < V2_PERM.length; p++) set.add(((v2Cluster(j) << 16) | V2_PERM[p]) >>> 0);
    }
    for (let j = 0; j < V2_HALF; j += 8) set.add(k[j]);
    return set;
}

/**
 * The V2 step, its OWN closure (vEBTree only). Tally cnt (Int32Array(12)):
 * 0 add, 1 delete, 2 / 3 has, 4 / 5 successor, 6 / 7 predecessor; 8 / 9 has
 * hit / miss, 10 / 11 delete hit / miss. successor / predecessor of a ring key
 * always hit (the root min / max are permanent, outside the ring). Integer sink
 * in a typed-array slot; const bindings only.
 */
export function makeStepV2(set, k, cnt, sink) {
    return function stepV2(i) {
        const x = k[i & V2_MASK];
        const op = i & 7;
        let r = 0;
        switch (op) {
            case 0: set.add(x); break;
            case 1:
                r = set.delete(k[(i - 1 + V2_HALF) & V2_MASK]) ? 1 : 0;
                cnt[r === 1 ? 10 : 11]++;
                break;
            case 2:
            case 3:
                r = set.has(k[(i - ((i & 8) >>> 2)) & V2_MASK]) ? 1 : 0;
                cnt[r === 1 ? 8 : 9]++;
                break;
            case 4:
            case 5: r = set.successor(x); break;
            default: r = set.predecessor(x);
        }
        cnt[op]++;
        sink[0] = (sink[0] + (r === undefined ? 7 : r)) | 0;
    };
}

/**
 * Minimum key count over the 64 ring clusters (each counted in the KEY range
 * [c << 16, (c + 1) << 16) by has + successor). Cold.
 */
export function v2Floor(set) {
    let min = -1;
    for (let j = 0; j < V2_CLUSTERS; j++) {
        const lo = v2Cluster(j) << 16;
        const hi = lo + 65536;
        let n = set.has(lo) ? 1 : 0;
        let x = set.successor(lo);
        while (x !== undefined && x < hi) {
            n++;
            x = set.successor(x);
        }
        if (min < 0 || n < min) min = n;
    }
    return min;
}

/** First zero slot of the 12-slot V2 tally, or -1. Cold. */
export function v2ZeroSlot(cnt) {
    for (let j = 0; j < 12; j++) if (!(cnt[j] > 0)) return j;
    return -1;
}

/** Starts job in a fresh Worker (see the header). */
export function startVebTorture(job, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        let w;
        try {
            w = new Worker(SELF_URL, { workerData: { vebTorture: true, ...job } });
        } catch (e) {
            resolve({ result: null, error: label + ' worker spawn error: ' + (e && e.message ? e.message : String(e)) });
            return;
        }
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result, error: error === null && result === null ? label + ' worker posted no result' : error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('TIMEOUT > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            result = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.message ? e.message : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

// --- worker side ------------------------------------------------------------------

/** V2b / CV4: one function for the real build and the mutant. */
function runAbGrowth(Veb, measureOps, checkNoGc, job) {
    const k = v2Ring(job.seed);
    const cnt = new Int32Array(12);
    const sink = new Int32Array(1);
    const set = v2Populate(new Veb(V2_U), k);
    const byteLength0 = set.byteLength;
    const floor0 = v2Floor(set);
    const step = makeStepV2(set, k, cnt, sink);
    for (let i = 0; i < job.warmup; i++) step(i);
    const a0 = cnt[0];
    const r = measureOps(step, { ops: job.ops, warmup: 0, stabilize: 'deep' });
    const adds = cnt[0] - a0;
    const ab = r.summary.arrayBuffers;
    const rep = checkNoGc(r.summary, { maxArrayBuffersGrowth: 0 });
    const hold = globalThis.__cv4Hold;
    return {
        abGrowth: ab.growthBytes,
        settled: ab.settled,
        verdict: rep.verdict,
        adds,
        byteLength0,
        byteLength1: set.byteLength,
        floor0,
        floor1: v2Floor(set),
        zero: v2ZeroSlot(cnt),
        held: Array.isArray(hold) ? hold.length : 0,
        sink: sink[0],
    };
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.vebTorture === true) {
    let msg;
    try {
        const src = workerData.src;
        const mod = src === null
            ? await import('../LogLogN.js')
            : await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
        if (typeof mod.vEBTree !== 'function') throw new TypeError('vEBTree export missing');
        const { measureOps, checkNoGc } = await import('@zakkster/lite-gc-profiler');
        msg = runAbGrowth(mod.vEBTree, measureOps, checkNoGc, workerData);
    } catch (e) {
        msg = { error: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
