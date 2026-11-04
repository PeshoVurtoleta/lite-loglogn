/**
 * @zakkster/lite-loglogn -- RoaringSet PAGED fuzz worker (0.6.0 G2-B3, PLAN-roaringset-G2 tasks 5 / 6).
 * Not a test file: the npm glob `test/*.test.js` never matches it. Inert when merely imported (the parent
 * side is exported); a job runs only inside a node:worker_threads Worker (workerData.roaringPagedJob === true).
 *
 * PARENT API (RoaringPagedFuzz.test.js and RoaringPagedMutants.test.js):
 *
 *   startPagedJob(job, label, ms = KILL_MS) -> Promise<{ result, error }>   (NEVER rejects)
 *     job = {
 *       src?:  string  the module TEXT (a mutant); absent = the live ../LogLogN.js read from disk
 *       lanes: string[] a subset of LANES (helpers/roaringPagedFuzz.mjs), run in order
 *       opts:  the runPagedLane options ({ g, vc, streamOps, base, K, floors })
 *     }
 *     Two modules are imported as base64 data: URLs: the text itself (lanes B / M / X) and its FORCED-paged
 *     build (forcePagedSource: the C-5 decision line -> `const paged = true;`, count 1; lanes F).
 *     error  = null, or a string: TIMEOUT (a hang), worker error, nonzero exit, missing result.
 *     result = { ok: true, failing, failures: string[], rows, stats: { lane: {...} }, cov, lines, wallMs }
 *            | { ok: false, stage: 'force' | 'import' | 'run', message }
 *
 *   isKilled(r) -> boolean   true when error !== null, result.ok !== true, or result.failing > 0.
 *   describeKill(r) -> string
 *
 * Deterministic per (text, lanes, opts): no timing assertion lives here (wallMs is REPORTED only).
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runPagedLane, forcePagedSource } from './helpers/roaringPagedFuzz.mjs';

export const KILL_MS = 300000;
export const MODULE_FILE = new URL('../LogLogN.js', import.meta.url);

const SELF_URL = new URL(import.meta.url);

export function startPagedJob(job, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(SELF_URL, { workerData: { roaringPagedJob: true, ...job } });
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
        w.on('message', (m) => { result = m; });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.message ? e.message : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

export function isKilled(r) {
    if (r.error !== null) return true;
    if (r.result === null || typeof r.result !== 'object' || r.result.ok !== true) return true;
    return r.result.failing > 0;
}

export function describeKill(r) {
    if (r.error !== null) return 'error: ' + r.error;
    if (r.result === null) return 'no result';
    if (r.result.ok !== true) return 'threw (' + r.result.stage + '): ' + String(r.result.message).split('\n')[0];
    if (r.result.failing > 0) return r.result.failures[0];
    return 'survived';
}

const dataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64');

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData.roaringPagedJob === true) {
    let msg;
    let stage = 'force';
    try {
        const job = workerData;
        const src = job.src !== undefined ? String(job.src) : readFileSync(MODULE_FILE, 'utf8');
        const forcedSrc = forcePagedSource(src);
        stage = 'import';
        const real = (await import(dataUrl(src))).RoaringSet;
        const forced = (await import(dataUrl(forcedSrc))).RoaringSet;
        if (typeof real !== 'function' || typeof forced !== 'function') throw new TypeError('module exports no RoaringSet');
        stage = 'run';
        const t0 = performance.now();
        const rows = [], lines = [], cov = [], stats = {};
        let failing = 0;
        for (const lane of job.lanes) {
            const r = runPagedLane({ real, forced }, lane, job.opts);
            for (const x of r.rows) rows.push(x);
            for (const x of r.lines) lines.push(x);
            for (const c of r.cov) cov.push({ lane, ...c });
            stats[lane] = r.stats;
            failing += r.failing;
        }
        const failures = rows.filter((x) => !x.ok).map((x) => x.text);
        if (failures.length !== failing) failures.push('internal: failing ' + failing + ' vs ' + failures.length + ' FAIL rows');
        msg = { ok: true, failing: Math.max(failing, failures.length), failures, rows, stats, cov, lines, wallMs: performance.now() - t0 };
    } catch (e) {
        msg = { ok: false, stage, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
