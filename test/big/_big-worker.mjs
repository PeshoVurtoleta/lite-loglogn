/**
 * @zakkster/lite-loglogn -- >= 2^31 universe worker (D11). Not a test file.
 *
 * Worker mode only (workerData.bigJob === true): builds a StratifiedBitset at
 * U = 2^31 + 64 (7 levels, ~277 MB of `_bits`) from the shipped ../../LogLogN.js
 * (src === null) or from a mutant source string (a data: URL), runs the probe
 * and posts ONE message `{ ok: true, obs }` (every observed value; the parent
 * asserts) or `{ ok: false, message }` (any throw, e.g. a RangeError from a
 * failed allocation). A worker OOM exit or a hang is caught by the parent's
 * exit-code check and kill timer. Inert when imported.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';

export const BIG_U = 2 ** 31 + 64;
export const BIG_KEY = 2 ** 31 + 5;

/** The probe: plain values only (structured-clone safe). */
export function probe(StratifiedBitset) {
    const U = BIG_U;
    const k = BIG_KEY;
    const s = new StratifiedBitset(U);
    const obs = {
        universe: s.universe,
        levels: s.levels,
        byteLength: s.byteLength,
        sizeEmpty: s.size,
        minEmpty: s.min(),
    };
    s.add(k);
    obs.size1 = s.size;
    obs.has = s.has(k);
    obs.succPeel = s.successor(2 ** 31);          // level-0 peel return
    obs.predPeel = s.predecessor(2 ** 31 + 10);   // level-0 peel return
    obs.min = s.min();
    obs.max = s.max();
    obs.succClimb = s.successor(0);               // climb + descend return
    obs.predClimb = s.predecessor(U - 1);         // climb + descend return
    obs.succNone = s.successor(k);
    obs.predNone = s.predecessor(k);
    s.add(U - 1);
    obs.succTop = s.successor(k);
    obs.predTop = s.predecessor(U - 1);
    obs.maxTop = s.max();
    obs.size2 = s.size;
    return obs;
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.bigJob === true) {
    let msg;
    try {
        const src = workerData.src;
        const mod = src === null
            ? await import('../../LogLogN.js')
            : await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
        if (typeof mod.StratifiedBitset !== 'function') throw new TypeError('build exports no StratifiedBitset');
        msg = { ok: true, obs: probe(mod.StratifiedBitset) };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
