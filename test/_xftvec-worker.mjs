/**
 * @zakkster/lite-loglogn -- XFastTrie xft-b0 REPLAY worker (B1 E9). Not a test
 * file: the npm glob `test/*.test.js` never matches it.
 *
 * Runs only as a node:worker_threads Worker (workerData.xftVecJob === true);
 * inert when merely imported. test/XftVectors.test.js runs every replay here
 * under a kill timer (HANG RULE: a hang, a worker error, a nonzero exit or a
 * missing result is a FAIL), because a broken successor / predecessor thread can
 * loop forever on a valid key.
 *
 * workerData:
 *   src      -- null = the shipped ../LogLogN.js, else a data: URL of a mutated
 *               copy (a must-fail control build; LogLogN.js has no imports, so a
 *               data: URL module loads stand-alone);
 *   streams  -- stream indices into STREAMS (test/helpers/xftStream.mjs) to
 *               replay on new XFastTrie(U, C) with genStream(U, C, N_OPS,
 *               streamSeed(i)) and the helper's replay() folds;
 *   boundary -- the VEC.boundary rows to answer (or null): for each state, a fresh
 *               XFastTrie(U, C) holding its keys answers min / max / has / succ /
 *               pred at every xs; each disagreement is reported as a string.
 * Posts ONE message: `{ ok: true, result: { streams: [{ i, U, C, resultsHash,
 * checkpoints, finalSize, sortedHash }], boundary: string[], states: number } }`
 * or `{ ok: false, message }`.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { STREAMS, N_OPS, genStream, streamSeed, replay } from './helpers/xftStream.mjs';

const nz = (v) => (v === undefined ? null : v);

function answerBoundary(XFastTrie, rows) {
    const bad = [];
    let states = 0;
    for (const row of rows) {
        for (const s of row.states) {
            const tag = 'U=' + row.U + ' C=' + row.C + ' ' + s.name;
            let t;
            try {
                t = new XFastTrie(row.U, row.C);
                for (const x of s.keys) t.add(x);
                const got = {
                    min: nz(t.min()),
                    max: nz(t.max()),
                    has: row.xs.map((x) => t.has(x)),
                    succ: row.xs.map((x) => nz(t.successor(x))),
                    pred: row.xs.map((x) => nz(t.predecessor(x))),
                };
                for (const k of ['min', 'max', 'has', 'succ', 'pred']) {
                    if (JSON.stringify(got[k]) !== JSON.stringify(s[k])) {
                        bad.push(tag + ' ' + k + ': ' + JSON.stringify(got[k]) + ' != ' + JSON.stringify(s[k]));
                    }
                }
            } catch (e) {
                bad.push(tag + ' threw ' + (e && e.name) + ': ' + (e && e.message));
            }
            states++;
        }
    }
    return { bad, states };
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.xftVecJob === true) {
    let msg;
    try {
        const { src, streams, boundary } = workerData;
        const mod = await import(src === null ? '../LogLogN.js' : src);
        const XFastTrie = mod.XFastTrie;
        if (typeof XFastTrie !== 'function') throw new TypeError('build under test exports no XFastTrie');
        const out = [];
        for (const i of streams) {
            const [U, C] = STREAMS[i];
            const r = replay(new XFastTrie(U, C), U, genStream(U, C, N_OPS, streamSeed(i)));
            out.push({ i, U, C, ...r });
        }
        const b = boundary === null ? { bad: [], states: 0 } : answerBoundary(XFastTrie, boundary);
        msg = { ok: true, result: { streams: out, boundary: b.bad, states: b.states } };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
