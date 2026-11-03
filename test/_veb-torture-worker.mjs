/**
 * @zakkster/lite-loglogn -- vEBTree torture V2 helpers + the V2b / CV4 Worker
 * (0.5.0 G2-B1, PLAN-vebtree G2 task 2, C-19, C-21), and the V3 (+ CV9) / CV5 /
 * CV6 Worker jobs (FILLER 1: a delete-refresh mutant that loops forever on a leaf
 * scan now times out as a FAIL instead of hanging torture). Not a test file: the
 * npm glob `test/*.test.js` never matches it. Inert when merely imported
 * (torture.mjs imports the V2 builders, the V3 constants / v3CountErr, NS_TEXT
 * and startVebTorture); a job runs only as a node:worker_threads Worker
 * (workerData.vebTorture === true).
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
 * zero, held } or { error }. That is job.kind undefined; job.kind 'v3' / 'cv5'
 * / 'cv6' runs runV3 / runCv5 / runCv6 on ../LogLogN.js (see the V3 section);
 * any other kind posts { error } (fail closed).
 *
 * V3 lanes in the Worker are the in-process lanes, not look-alikes: the
 * retained lane is lite-gc-profiler's measureAllocs with V3's options (the
 * Worker's OWN isolate heap: process.memoryUsage().heapUsed in a Worker reads
 * that Worker's isolate); the transient lane is a TEXT copy of torture.mjs's
 * newSpaceUsed / nsLane / emptyFn / takeNsBase / nsExcess
 * (getHeapSpaceStatistics is per isolate), its empty-fn baseline taken by
 * runV3's first two statements: one takeNsBase() discarded (warm-up), then
 * nsBase = takeNsBase(). A fresh Worker's FIRST empty-fn lane is bimodal:
 * min 1,784 (24/40) or 2,760-2,872 (16/40) B per 65,536-op window; the warm
 * calls read 1,784-1,816 (veb-nsbase-probe-2026-11-03.log, 40 fresh V3
 * Workers, PRELIMINARY host). torture.mjs takes its own nsBase cold, first in
 * its process. laneParity (torture.mjs) compares the TEXT of those 5
 * functions (per-line indent stripped, [ \t]+ collapsed, newlines kept) and
 * the 3 constants NS_K / NS_W / NS_MAX_EXCESS against its own; drift = V3
 * FAIL. Text cannot see the rest: the takeNsBase() call site, SINK, the
 * node:v8 import. Those are judged by two posted numbers instead: CV9
 * v3WorkerBox (runV3 boxes one [i] every 8th op on V3's step, same isolate
 * and baseline: the parent requires boxExcess >= NS_MAX_EXCESS,
 * nsBaseOk(baseMin) and !nsBaseOk(boxExcess + baseMin)) and the parent's
 * baseline ceiling (nsBaseOk(baseMin): 0 <= baseMin <= NS_BASE_MAX = 4,096).
 * The Worker inherits torture.mjs's execArgv (--expose-gc; the semi-space pin
 * was checked there); a Worker without globalThis.gc posts { error }.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { getHeapSpaceStatistics } from 'node:v8';

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

// --- V3 / CV5 / CV6 (moved from torture.mjs; run only inside a Worker) -------------
export const V3_U = 33554435;      // 2^25 + 3, w = 26 (root trimmed to 513 clusters)
const V3_S = [3, 50, 140, 255];    // leaf cluster (bits 8..15) per root cluster
const V3_L = [1, 9, 77, 200];      // key inside its leaf (bits 0..7)
export const V3_M = 1024;          // keys: 64 root clusters x 4 x 4
export const V3_CYCLE = 2 * V3_M;  // ops per cycle: V3_M adds, then V3_M deletes
export const V3_ITERS = V3_CYCLE * 122;    // measureAllocs iterations (= its warmup): whole cycles
export const V3_BATCHES = 8;
export const CV5_OPS = V3_CYCLE * 4;       // CV5: 4 ascending-delete cycles
export const CV6_ITERS = V3_CYCLE * 10;    // CV6: measureAllocs iterations
export const CV6_BATCHES = 4;

// Transient lane: a TEXT copy of torture.mjs's (see the header; NS_TEXT pins it).
export const NS_K = 65536;
export const NS_W = 17;
export const NS_MAX_EXCESS = (16 * NS_K) / 1024;
const SINK = new Int32Array(1);
let nsBase = null;  // the Worker's empty-fn baseline: runV3's second takeNsBase() (the first warms)

// new_space used bytes, or -1 when the space is not found (fails closed).
function newSpaceUsed() {
    const a = getHeapSpaceStatistics();
    for (let j = 0; j < a.length; j++) {
        if (a[j].space_name === 'new_space') return a[j].space_used_size;
    }
    return -1;
}

function nsLane(fn) {
    for (let i = 0; i < NS_K * 2; i++) fn(i);
    let min = -1;
    let first = -1;
    let valid = 0;
    for (let w = 0; w < NS_W; w++) {
        globalThis.gc();
        const a = newSpaceUsed();
        for (let i = 0; i < NS_K; i++) fn(i);
        const z = newSpaceUsed();
        if (a < 0 || z < 0 || z < a) continue;
        const d = z - a;
        if (w === 0) { first = d; continue; }
        valid++;
        if (min < 0 || d < min) min = d;
    }
    return valid >= (NS_W >>> 1) ? { min, first, valid } : null;
}

const emptyFn = function empty(i) { SINK[0] = (SINK[0] + (i & 1)) | 0; };

function takeNsBase() { return nsLane(emptyFn); }

function nsExcess(fn) {
    const r = nsLane(fn);
    if (r === null || nsBase === null) return null;
    return { excess: r.min - nsBase.min, first: r.first - nsBase.min, valid: r.valid };
}

/** Source text of the transient lane, compared by torture.mjs against its own. */
export const NS_TEXT = [newSpaceUsed, nsLane, emptyFn, takeNsBase, nsExcess].map(String).join('\n');

// The 1,024 V3 keys, ascending by construction (j, then s, then l). Cold.
function v3Keys() {
    const k = new Uint32Array(V3_M);
    let n = 0;
    for (let j = 0; j < 64; j++) {
        for (let a = 0; a < V3_S.length; a++) {
            for (let b = 0; b < V3_L.length; b++) {
                k[n++] = (((8 * j + 1) << 16) | (V3_S[a] << 8) | V3_L[b]) >>> 0;
            }
        }
    }
    return k;
}
// null when k is V3_M strictly ascending (so distinct) keys < V3_U in 64
// distinct root clusters (key >>> 16) x 256 distinct leaf clusters (key >>> 8:
// the root cluster AND the leaf cluster bits 8..15, i.e. 64 x 4), else the
// reason. Cold.
function v3KeyErr(k) {
    if (k.length !== V3_M) return 'length ' + k.length;
    const rc = new Set();
    const lc = new Set();
    for (let i = 0; i < V3_M; i++) {
        if (!(k[i] < V3_U)) return 'key ' + k[i] + ' >= U';
        if (i > 0 && !(k[i] > k[i - 1])) return 'not strictly ascending at ' + i;
        rc.add(k[i] >>> 16);
        lc.add(k[i] >>> 8);
    }
    return rc.size === 64 && lc.size === 256 ? null : 'root clusters ' + rc.size + ' leaf clusters ' + lc.size;
}
const V3_DESC = new Uint16Array(V3_M);
const V3_ASC = new Uint16Array(V3_M);
for (let d = 0; d < V3_M; d++) {
    V3_DESC[d] = V3_M - 1 - d;
    V3_ASC[d] = d;
}
// The V3 cycle step, its OWN closure (vEBTree only). Op p = i mod 2,048:
// p < 1,024 adds keys[p]; else deletes keys[order[p - 1,024]] after
// checking max() === x (a hit counts a refresh). Tally cnt (Int32Array(4)):
// 0 adds, 1 deletes, 2 refreshes, 3 bad (a delete that returned false, or
// size != 0 after a cycle's last delete). V3 passes V3_DESC; CV5 V3_ASC.
function makeStepV3(set, keys, order, cnt) {
    return function stepV3(i) {
        const p = i & (V3_CYCLE - 1);
        if (p < V3_M) {
            set.add(keys[p]);
            cnt[0]++;
            return;
        }
        const x = keys[order[p - V3_M]];
        if (set.max() === x) cnt[2]++;
        if (!set.delete(x)) cnt[3]++;
        cnt[1]++;
        if (p === V3_CYCLE - 1 && set.size !== 0) cnt[3]++;
    };
}
/**
 * null when cnt holds exactly `ops` ops of V3's model (adds == deletes ==
 * refreshes == ops / 2, bad 0), else the reason. V3 and CV5 share it (the
 * parent calls it on the posted tally). Cold.
 */
export function v3CountErr(cnt, ops) {
    const want = ops / 2;
    if (cnt[0] === want && cnt[1] === want && cnt[2] === want && cnt[3] === 0) return null;
    return 'adds=' + cnt[0] + ' deletes=' + cnt[1] + ' refreshes=' + cnt[2] + ' bad=' + cnt[3] +
        ' (want ' + want + ' / ' + want + ' / ' + want + ' / 0)';
}
// V3's retained lane; CV6 runs through it too. Cold wrapper.
function v3Alloc(measureAllocs, set, keys, cnt, iterations, batches) {
    return measureAllocs(makeStepV3(set, keys, V3_DESC, cnt), { iterations, batches });
}
// One descending cycle with `_p` (the delete frame stack, Int32Array(8),
// frames [base, w, acc, mode]) cleared to -1 before each delete, so only that
// delete's frames are read. c: 0 / 1 root (w 26) mode 1 / 2, 2 / 3 internal
// cluster (w 16), 4 / 5 root summary (w 10), 6 bad. null when `_p` is not
// an Int32Array(8). Leaves the tree empty. Cold.
function v3Census(set, keys) {
    const q = set._p;
    if (!(q instanceof Int32Array) || q.length !== 8) return null;
    const c = new Int32Array(7);
    for (let p = 0; p < V3_M; p++) set.add(keys[p]);
    for (let d = V3_M - 1; d >= 0; d--) {
        q.fill(-1);
        if (!set.delete(keys[d])) c[6]++;
        for (let f = 0; f < 8; f += 4) {
            const fw = q[f + 1];
            const md = q[f + 3];
            if (md === -1) continue;
            const row = fw === 26 ? 0 : fw === 16 ? 2 : fw === 10 ? 4 : -1;
            if (row < 0 || (md !== 1 && md !== 2)) c[6]++;
            else c[row + md - 1]++;
        }
    }
    if (set.size !== 0) c[6]++;
    return c;
}
// `_t` of a and b byte-equal (same length). Cold.
function vTEqual(a, b) {
    const x = a._t;
    const y = b._t;
    return x.length === y.length &&
        Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.byteLength),
            Buffer.from(y.buffer, y.byteOffset, y.byteLength)) === 0;
}

/**
 * V3 (in the in-process order: the empty-fn baseline first, census, retained
 * lane, transient lane on the SAME instance, then `_t` vs a fresh tree), then
 * the CV9 box lane on that instance. The baseline is the SECOND takeNsBase():
 * a fresh Worker's first lane reads 1,784 or 2,760-2,872 B per window (cold,
 * bimodal), later ones 1,784-1,816 (the 0b probe log). Posts baseMin and
 * boxExcess / boxValid raw for the parent's ceiling and CV9. Numbers /
 * strings / arrays only.
 */
function runV3(Veb, measureAllocs) {
    takeNsBase();
    nsBase = takeNsBase();
    const keys = v3Keys();
    const kErr = v3KeyErr(keys);
    const set = new Veb(V3_U);
    const cen = v3Census(set, keys);
    const cnt = new Int32Array(4);
    const al = v3Alloc(measureAllocs, set, keys, cnt, V3_ITERS, V3_BATCHES);
    const ns = nsExcess(makeStepV3(set, keys, V3_DESC, cnt));
    const fresh = new Veb(V3_U);
    const tEqual = set.size === 0 && vTEqual(set, fresh);
    const bits = set.bits;
    const byteLength = set.byteLength;
    const sink = SINK[0];
    // CV9 v3WorkerBox (must flip): a box on V3's step, same set, same isolate,
    // same nsBase, AFTER V3's own lanes and the snapshot above. Its own tally
    // and step closure; the ring takes one fresh [i] every 8th op (8,192 x 56 B
    // = 458,752 B per 65,536-op window, inside the Worker's young generation).
    // Posted raw: the parent requires boxExcess >= NS_MAX_EXCESS,
    // nsBaseOk(baseMin) AND boxExcess + baseMin > NS_BASE_MAX (a blind readout
    // leaves CV9 PASSED; a calibrated-away baseline fails the parent's baseMin
    // ceiling and leaves CV9 PASSED).
    const cntB = new Int32Array(4);
    const stepB = makeStepV3(set, keys, V3_DESC, cntB);
    const ring = new Array(64);
    const bx = nsExcess(function v3Boxed(i) { stepB(i); if ((i & 7) === 0) ring[i & 63] = [i]; });
    return {
        kErr,
        census: cen === null ? null : Array.from(cen),
        bytesPerCall: al.bytesPerCall,
        settled: al.settled,
        excess: ns === null ? null : ns.excess,
        first: ns === null ? null : ns.first,
        valid: ns === null ? null : ns.valid,
        baseMin: nsBase === null ? null : nsBase.min,
        cnt: Array.from(cnt),
        tEqual,
        bits,
        byteLength,
        sink,
        boxExcess: bx === null ? null : bx.excess,
        boxValid: bx === null ? null : bx.valid,
    };
}

/** CV5: V3's step factory, deletes ascending (the parent runs v3CountErr). */
function runCv5(Veb) {
    const set = new Veb(V3_U);
    const cnt = new Int32Array(4);
    const step = makeStepV3(set, v3Keys(), V3_ASC, cnt);
    for (let i = 0; i < CV5_OPS; i++) step(i);
    return { cnt: Array.from(cnt), ops: CV5_OPS };
}

/** CV6: a subclass whose delete retains [x] when x is the max, through v3Alloc. */
function runCv6(Veb, measureAllocs) {
    const hold = [];
    class RetainOnRefresh extends Veb {
        delete(x) {
            if (this.max() === x) hold.push([x]);
            return super.delete(x);
        }
    }
    const cnt = new Int32Array(4);
    const al = v3Alloc(measureAllocs, new RetainOnRefresh(V3_U), v3Keys(), cnt, CV6_ITERS, CV6_BATCHES);
    return { bytesPerCall: al.bytesPerCall, settled: al.settled, held: hold.length };
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
        const { measureOps, checkNoGc, measureAllocs } = await import('@zakkster/lite-gc-profiler');
        const kind = workerData.kind;
        if (kind === undefined) {
            msg = runAbGrowth(mod.vEBTree, measureOps, checkNoGc, workerData);
        } else if (kind !== 'v3' && kind !== 'cv5' && kind !== 'cv6') {
            throw new TypeError('unknown job kind ' + String(kind));
        } else if (src !== null) {
            throw new TypeError(kind + ' job runs ../LogLogN.js only (src must be null)');
        } else if (typeof globalThis.gc !== 'function') {
            throw new TypeError(kind + ' worker has no globalThis.gc (--expose-gc not inherited)');
        } else {
            msg = kind === 'v3' ? runV3(mod.vEBTree, measureAllocs) :
                kind === 'cv5' ? runCv5(mod.vEBTree) : runCv6(mod.vEBTree, measureAllocs);
        }
    } catch (e) {
        msg = { error: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
