/**
 * @zakkster/lite-loglogn -- vEBTree big-universe / mutant / fuzz worker (0.5.0 G1-B4,
 * PLAN-vebtree tasks 6 + 8, C-9, C-19). Not a test file: the npm glob
 * `test/*.test.js` never matches it. Inert when merely imported (the parent side,
 * startJob, is exported); the job runs only as a node:worker_threads Worker
 * (workerData.vebJob === true).
 *
 * Parent side: startJob(job, label, ms) spawns ONE Worker with a kill timer and
 * NEVER rejects: it resolves { result, error }; error is a string on a hang
 * (timeout), a worker error, a nonzero exit or a missing result. The caller treats
 * every error as a FAIL (fail closed), or, for a must-fail mutant, as the expected
 * kill (a corrupted tree can loop forever on a leaf scan, C-19).
 *
 * Jobs (job.kind), every expected value taken from the SPEC (PLAN A1 / A2 / C-16 /
 * C-19) or computed by VebRef / SetOracle / the sketch, never from the engine:
 *   'u32'   -- the C-9 / A2 U = 2^32 empty-encoding list. Posts { failures: [...] }.
 *   'high'  -- U = 2^31 + 12345 (C-19): a hand-valued prefix of keys >= 2^31, then a
 *              seeded stream engine vs VebRef (every answer as a comparable tag, keys
 *              as uint32 numbers, never negative), coverage floors on results >= 2^31,
 *              layout `_t` vs VebRef.serialize() word for word. Posts { failures }.
 *   'fuzz'  -- job.configs = [{ U, nOps, seed }]: engine vs VebRef vs SetOracle vs the
 *              sketch (U <= 2^24) per op, `clear` on a seeded schedule, layout vs
 *              serialize() every 1000 ops, coverage floors per universe.
 *              Posts { failures, rows }.
 * job.src === null imports ../LogLogN.js; a string is a MUTANT source text imported
 * through a data: URL.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { VebRef, checkRef } from './helpers/vebRef.mjs';
import { SetOracle, SKETCH_MAX_U, genStream, outcome, mulberry32 } from './helpers/vebStream.mjs';
import { vEBTree as Sketch } from './helpers/vebSketch.mjs';

export const KILL_MS = 100000;

const SELF_URL = new URL(import.meta.url);

/** Starts job in a fresh Worker (see the header). */
export function startJob(job, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(SELF_URL, { workerData: { vebJob: true, ...job } });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result, error });
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

// --- worker side -----------------------------------------------------------------------

const TWO31 = 2147483648;

function same(a, b) {
    return Object.is(a, b);
}

function eqWords(a, b) {
    if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return 'word ' + i + ': ' + a[i] + ' vs ' + b[i];
    }
    return null;
}

/** C-9 / A2: the U = 2^32 empty-encoding list. */
function runU32(mod) {
    const f = [];
    const chk = (name, got, want) => {
        if (!same(got, want)) f.push(name + ': got ' + String(got) + ', want ' + String(want));
    };
    try {
        const MAXK = 4294967295;
        const t = new mod.vEBTree(4294967296);
        chk('byteLength', t.byteLength, 539500592);
        chk('universe', t.universe, 4294967296);
        chk('bits', t.bits, 32);
        chk('empty size', t.size, 0);
        chk('empty min', t.min(), undefined);
        chk('empty max', t.max(), undefined);
        chk('empty has(max key)', t.has(MAXK), false);
        chk('empty has(0)', t.has(0), false);
        t.add(MAXK);
        chk('size 1', t.size, 1);
        chk('has(4294967295)', t.has(MAXK), true);
        chk('has(0)', t.has(0), false);
        chk('min', t.min(), MAXK);
        chk('max', t.max(), MAXK);
        chk('successor(4294967294)', t.successor(MAXK - 1), MAXK);
        chk('predecessor(4294967295)', t.predecessor(MAXK), undefined);
        chk('successor(4294967295)', t.successor(MAXK), undefined);
        chk('predecessor(1)', t.predecessor(1), undefined);
        t.add(0);
        chk('size 2', t.size, 2);
        chk('min after add(0)', t.min(), 0);
        chk('max after add(0)', t.max(), MAXK);
        chk('delete(4294967295)', t.delete(MAXK), true);
        chk('delete(0)', t.delete(0), true);
        chk('size 0', t.size, 0);
        chk('min undefined', t.min(), undefined);
        chk('max undefined', t.max(), undefined);
        chk('has(4294967295) after', t.has(MAXK), false);
        chk('delete(4294967295) again', t.delete(MAXK), false);
        t.add(MAXK);
        chk('re-add has', t.has(MAXK), true);
        chk('byteLength unchanged', t.byteLength, 539500592);
    } catch (e) {
        f.push('threw ' + String(e && e.name) + ': ' + String(e && e.message));
    }
    return { failures: f };
}

/** Hand-valued prefix at U = 2^31 + 12345 (keys >= 2^31); expected values by hand. */
function highPrefix(t, f, check) {
    const U = TWO31 + 12345; // 2147495993
    const TOP = U - 1; // 2147495992
    const chk = check
        ? (name, got, want) => {
            if (!same(got, want)) f.push('prefix ' + name + ': got ' + String(got) + ', want ' + String(want));
        }
        : () => {};
    t.add(TOP);
    chk('min {TOP}', t.min(), TOP);
    chk('max {TOP}', t.max(), TOP);
    chk('has TOP', t.has(TOP), true);
    chk('successor(TOP-1)', t.successor(TOP - 1), TOP);
    chk('successor(0)', t.successor(0), TOP);
    chk('predecessor(TOP)', t.predecessor(TOP), undefined);
    t.add(TWO31);
    chk('min {2^31, TOP}', t.min(), TWO31);
    chk('max {2^31, TOP}', t.max(), TOP);
    chk('successor(2^31)', t.successor(TWO31), TOP);
    chk('successor(2^31 - 1)', t.successor(TWO31 - 1), TWO31);
    chk('predecessor(TOP)', t.predecessor(TOP), TWO31);
    chk('predecessor(2^31)', t.predecessor(TWO31), undefined);
    t.add(TWO31 - 1);
    chk('min {2^31-1,..}', t.min(), TWO31 - 1);
    chk('predecessor(2^31)', t.predecessor(TWO31), TWO31 - 1);
    chk('successor(2^31-1)', t.successor(TWO31 - 1), TWO31);
    chk('predecessor(TOP)', t.predecessor(TOP), TWO31);
    chk('delete(2^31-1)', t.delete(TWO31 - 1), true);
    chk('min after delete', t.min(), TWO31);
    chk('delete(2^31)', t.delete(TWO31), true);
    chk('min is TOP', t.min(), TOP);
    chk('max is TOP', t.max(), TOP);
    t.add(TWO31 + 7);
    chk('min 2^31+7', t.min(), TWO31 + 7);
    chk('successor(2^31+7)', t.successor(TWO31 + 7), TOP);
    chk('predecessor(TOP)', t.predecessor(TOP), TWO31 + 7);
    chk('size', t.size, 2);
}

/** U = 2^31 + 12345 (C-19). */
function runHigh(mod, seed) {
    const f = [];
    const U = TWO31 + 12345;
    try {
        const eng = new mod.vEBTree(U);
        const ref = new VebRef(U);
        highPrefix(eng, f, true);
        highPrefix(ref, f, false);
        if (f.length > 0) return { failures: f };
        const nOps = 12000;
        const st = genStream(U, nOps, seed);
        const hi = [0, 0, 0, 0, 0, 0, 0]; // results >= 2^31 per op kind
        for (let i = 0; i < nOps; i++) {
            const o = st.op[i];
            const x = st.key[i];
            const te = outcome(eng, o, x);
            const tr = outcome(ref, o, x);
            if (te !== tr) {
                f.push('op ' + i + ' kind ' + o + ' key ' + String(x) + ': engine ' + te + ' vs ref ' + tr);
                return { failures: f };
            }
            if (eng.size !== ref.size) {
                f.push('op ' + i + ': size ' + eng.size + ' vs ' + ref.size);
                return { failures: f };
            }
            if (tr.startsWith('n:') && Number(tr.slice(2)) >= TWO31) hi[o]++;
        }
        const names = ['add', 'delete', 'has', 'successor', 'predecessor', 'min', 'max'];
        for (const o of [3, 4, 6]) {
            if (hi[o] < 20) f.push('coverage: only ' + hi[o] + ' ' + names[o] + ' results >= 2^31 (floor 20)');
        }
        const bad = eqWords(eng._t, ref.serialize());
        if (bad !== null) f.push('layout: ' + bad);
        return { failures: f, hi };
    } catch (e) {
        f.push('threw ' + String(e && e.name) + ': ' + String(e && e.message));
        return { failures: f };
    }
}

/** One fuzz universe. */
function runFuzz(mod, cfg) {
    const { U, nOps, seed } = cfg;
    const f = [];
    const tag = 'U=' + U + ' seed=0x' + (seed >>> 0).toString(16);
    const st = genStream(U, nOps, seed);
    const eng = new mod.vEBTree(U);
    const ref = new VebRef(U);
    const set = new SetOracle(U);
    const sk = U <= SKETCH_MAX_U ? new Sketch(U) : null;
    // independent stream for the clear schedule: one clear per 2500-op window
    const rClear = mulberry32((seed ^ 0xc1ea4b17) >>> 0);
    const clearAt = new Set();
    for (let k = 0; k * 2500 < nOps; k++) {
        const at = k * 2500 + 1 + Math.floor(rClear() * 2000);
        if (at < nOps) clearAt.add(at);
    }
    const row = { U, nOps, clears: 0, clearsNonEmpty: 0, layoutChecks: 0, answers: 0, maxSize: 0, perKind: [0, 0, 0, 0, 0, 0, 0] };
    const layout = (i) => {
        const bad = eqWords(eng._t, ref.serialize());
        if (bad !== null) return tag + ' op ' + i + ': layout ' + bad;
        const inv = checkRef(ref);
        if (inv !== null) return tag + ' op ' + i + ': VebRef invariant ' + inv;
        row.layoutChecks++;
        return null;
    };
    try {
        for (let i = 0; i < nOps; i++) {
            if (clearAt.has(i)) {
                if (ref.size > 0) row.clearsNonEmpty++;
                row.clears++;
                eng.clear();
                ref.clear();
                set._s.clear();
                if (sk !== null) sk.clear();
                if (eng.size !== 0) return { failures: [tag + ' op ' + i + ': size ' + eng.size + ' after clear'], row };
                const bad = layout(i);
                if (bad !== null) return { failures: [bad], row };
            }
            const o = st.op[i];
            const x = st.key[i];
            const te = outcome(eng, o, x);
            const tr = outcome(ref, o, x);
            const ts = outcome(set, o, x);
            if (te !== tr || te !== ts) {
                return { failures: [tag + ' op ' + i + ' kind ' + o + ' key ' + String(x) + ': engine ' + te + ' ref ' + tr + ' set ' + ts], row };
            }
            if (sk !== null) {
                const tk = outcome(sk, o, x);
                if (te !== tk) return { failures: [tag + ' op ' + i + ' kind ' + o + ' key ' + String(x) + ': engine ' + te + ' sketch ' + tk], row };
            }
            if (eng.size !== ref.size || eng.size !== set.size) {
                return { failures: [tag + ' op ' + i + ': size ' + eng.size + ' ref ' + ref.size + ' set ' + set.size], row };
            }
            row.perKind[o]++;
            if (te.startsWith('n:') || te === 'b:true') row.answers++;
            if (eng.size > row.maxSize) row.maxSize = eng.size;
            if ((i + 1) % 1000 === 0 || i === nOps - 1) {
                const bad = layout(i);
                if (bad !== null) return { failures: [bad], row };
            }
        }
    } catch (e) {
        return { failures: [tag + ' threw ' + String(e && e.name) + ': ' + String(e && e.message)], row };
    }
    // coverage floors (seeded streams, so these are deterministic per seed but wide)
    if (nOps >= 1500) {
        for (let k = 0; k < 7; k++) {
            if (row.perKind[k] < 20) f.push(tag + ' coverage: op kind ' + k + ' ran ' + row.perKind[k] + ' times (floor 20)');
        }
    }
    if (row.maxSize < Math.min(U, 16)) f.push(tag + ' coverage: maxSize ' + row.maxSize + ' < ' + Math.min(U, 16));
    if (nOps >= 5000 && U >= 1000 && row.clearsNonEmpty < 1) f.push(tag + ' coverage: no clear() on a non-empty tree');
    if (row.clears < 1 && nOps >= 2000) f.push(tag + ' coverage: no clear() ran');
    if (row.layoutChecks < Math.floor(nOps / 1000)) f.push(tag + ' coverage: only ' + row.layoutChecks + ' layout checks');
    return { failures: f, row };
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData.vebJob === true) {
    let msg;
    try {
        const { kind, src } = workerData;
        const mod = src === null
            ? await import('../LogLogN.js')
            : await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
        if (typeof mod.vEBTree !== 'function') throw new TypeError('build exports no vEBTree');
        let r;
        if (kind === 'u32') {
            r = runU32(mod);
        } else if (kind === 'high') {
            r = runHigh(mod, workerData.seed);
        } else if (kind === 'fuzz') {
            const failures = [];
            const rows = [];
            for (const c of workerData.configs) {
                const one = runFuzz(mod, c);
                rows.push(one.row);
                for (const m of one.failures) failures.push(m);
            }
            r = { failures, rows };
        } else {
            throw new TypeError('unknown job kind ' + String(kind));
        }
        msg = { ok: true, ...r };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
