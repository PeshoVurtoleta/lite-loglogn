/**
 * @zakkster/lite-loglogn -- RoaringSet fuzz / contract worker (0.6.0 G1-B2, PLAN-roaringset-G1 task 2).
 * Not a test file: the npm glob `test/*.test.js` never matches it. Inert when merely imported (the parent
 * side is exported); a job runs only inside a node:worker_threads Worker (workerData.roaringJob === true).
 *
 * PARENT API (also the API G1-B5's RoaringMutants uses for single-edit data: URL mutants of LogLogN.js):
 *
 *   startRoaringJob(job, label, ms = KILL_MS) -> Promise<{ result, error }>   (NEVER rejects)
 *     job = {
 *       kind?:  'fuzz' (default) | 'a3' | 'a4' | 'universe'
 *       url?:   string  a module URL, file: or data:   -- the module under test
 *       src?:   string  a MUTANT source text; imported through a base64 data: URL
 *               (exactly one of url / src; neither = DEFAULT_MODULE_URL, the live ../LogLogN.js)
 *       // kind 'fuzz':
 *       seeds, ops: positive integers (the budget); base?: uint32 (LOGLOGN_SEED); seedsBy?: { scenarioName: seeds } (R/C scenarios); names?: run only those R/C scenarios; draft?: true ONLY for a
 *       research draft without `_mi` (R/RoaringDraft.best.mjs); only?: subset of SECTIONS
 *     }
 *     The module must export `RoaringSet`.
 *     error  = null, or a string: TIMEOUT (a hang), worker error, nonzero exit, missing result.
 *     result = the posted message:
 *       { ok: true,  kind, failures: string[], failing: number, rows, cov, lines, wallMs, ... }  ran to the end
 *       { ok: false, message }                                                                     threw
 *       kind 'fuzz': failing = number of FAIL rows (floor misses are FAIL rows too); rows = [{ ok, text }];
 *                    cov = coverage rows for the R / C scenarios; wallMs = in-worker wall time (REPORTED only).
 *       kind 'a3' | 'a4' | 'universe': failures = the oracle's failure strings (helpers/roaringFuzz.mjs).
 *
 *   isKilled(r) -> boolean   the mutant verdict: true when error !== null, or result.ok !== true, or
 *                            result.failing > 0 (a corrupted set can loop forever; the kill timer makes a
 *                            hang a kill, never a wedged run). A non-zero / FAIL result = killed.
 *   describeKill(r) -> string   one line saying why (first failure text, error, or 'survived').
 *   DEFAULT_MODULE_URL, KILL_MS.
 *
 * The fuzz job is deterministic per (module, seeds, ops, base, only): no timing assertion lives here.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { runRoaringFuzz, checkA3, checkA4, checkUniverse } from './helpers/roaringFuzz.mjs';

export const KILL_MS = 240000;
export const DEFAULT_MODULE_URL = new URL('../LogLogN.js', import.meta.url).href;

const SELF_URL = new URL(import.meta.url);

/** Starts job in a fresh Worker (see the header). */
export function startRoaringJob(job, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(SELF_URL, { workerData: { roaringJob: true, ...job } });
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

/** The mutant verdict of a startRoaringJob result: true = killed (see the header). */
export function isKilled(r) {
    if (r.error !== null) return true;
    if (r.result === null || typeof r.result !== 'object' || r.result.ok !== true) return true;
    return r.result.failing > 0;
}

/** One line: why a result is a kill, or 'survived'. */
export function describeKill(r) {
    if (r.error !== null) return 'error: ' + r.error;
    if (r.result === null) return 'no result';
    if (r.result.ok !== true) return 'threw: ' + String(r.result.message).split('\n')[0];
    if (r.result.failing > 0) return r.result.failures[0];
    return 'survived';
}

// --- worker side -----------------------------------------------------------------------------

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData.roaringJob === true) {
    let msg;
    try {
        const job = workerData;
        const kind = job.kind === undefined ? 'fuzz' : job.kind;
        if (job.url !== undefined && job.src !== undefined) throw new TypeError('job has both url and src');
        let url = DEFAULT_MODULE_URL;
        if (job.url !== undefined) url = String(job.url);
        else if (job.src !== undefined) url = 'data:text/javascript;base64,' + Buffer.from(String(job.src), 'utf8').toString('base64');
        const mod = await import(url);
        if (typeof mod.RoaringSet !== 'function') throw new TypeError('module exports no RoaringSet');
        const t0 = performance.now();
        if (kind === 'fuzz') {
            const o = { seeds: job.seeds, ops: job.ops };
            if (job.base !== undefined) o.base = job.base;
            if (job.draft !== undefined) o.draft = job.draft;
            if (job.only !== undefined) o.only = job.only;
            if (job.seedsBy !== undefined) o.seedsBy = job.seedsBy;
            if (job.names !== undefined) o.names = job.names;
            const r = runRoaringFuzz(mod.RoaringSet, o);
            const failures = r.rows.filter((x) => !x.ok).map((x) => x.text);
            msg = {
                ok: true, kind, failures, failing: r.failures, rows: r.rows, cov: r.cov, trace: r.trace, lines: r.lines,
                seeds: r.seeds, ops: r.ops, base: r.base, only: r.only, wallMs: performance.now() - t0,
            };
            if (r.failures !== failures.length) msg.failures.push('internal: failures counter ' + r.failures + ' vs ' + failures.length + ' FAIL rows');
            if (r.failures !== failures.length) msg.failing = Math.max(r.failures, failures.length);
        } else if (kind === 'a3' || kind === 'a4' || kind === 'universe') {
            const failures = (kind === 'a3' ? checkA3 : kind === 'a4' ? checkA4 : checkUniverse)(mod.RoaringSet);
            msg = { ok: true, kind, failures, failing: failures.length, wallMs: performance.now() - t0 };
        } else {
            throw new TypeError('unknown job kind ' + String(kind));
        }
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
