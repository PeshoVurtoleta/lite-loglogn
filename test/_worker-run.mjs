/**
 * @zakkster/lite-loglogn -- shared hang-safe worker runner for tests (not a test
 * file: the npm glob `test/*.test.js` never matches it).
 *
 * node:test's timeout cannot interrupt a synchronous infinite loop, so a test
 * body that can enter a successor / predecessor / min / max loop on a valid key
 * runs in a node:worker_threads Worker built from this file. The parent arms a
 * kill timer (KILL_MS = 100000, below the 120000 test timeout) that terminates
 * the worker; a hang, a worker error, a nonzero exit or a missing result is a
 * FAIL, never a stuck run.
 *
 * Body contract: `startFn(fn, label)` ships `fn.toString()` to the worker, which
 * evaluates it and calls it as `fn({ StratifiedBitset, XFastTrie, assert })` (assert =
 * node:assert/strict). The body must be SELF-CONTAINED: a `function` expression
 * that uses only its parameter and globals. A reference to anything outside it
 * is a ReferenceError in the worker, i.e. a FAIL (fail closed, never skipped).
 * Start every job at module load (parallel); each test awaits its own job.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import assert from 'node:assert/strict';

export const KILL_MS = 100000;

const SELF_URL = new URL(import.meta.url);

/**
 * Starts fn in a fresh Worker. NEVER rejects: resolves { result, error }, where
 * error is a string on a hang / worker error / nonzero exit, else null.
 */
export function startFn(fn, label, ms = KILL_MS) {
    const src = fn.toString();
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const w = new Worker(SELF_URL, { workerData: { workerRunBody: true, src } });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result, error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            result = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

/** Asserts a startFn job finished cleanly and its body passed. */
export async function expectFn(job) {
    const r = await job;
    if (r.error !== null) assert.fail(r.error);
    if (r.result === null || typeof r.result !== 'object') assert.fail('worker posted no result');
    if (r.result.ok !== true) assert.fail(String(r.result.message));
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.workerRunBody === true) {
    const { StratifiedBitset, XFastTrie } = await import('../LogLogN.js');
    let msg;
    try {
        const fn = (0, eval)('"use strict"; (' + workerData.src + ')');
        if (typeof fn !== 'function') throw new TypeError('worker body is not a function');
        const ret = fn({ StratifiedBitset, XFastTrie, assert });
        if (ret !== undefined) throw new TypeError('worker body must return undefined (no async / generator body)');
        msg = { ok: true };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
