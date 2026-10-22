/**
 * @zakkster/lite-loglogn -- tier parity worker (B1c A9 / A10). Not a test file:
 * the npm glob `test/*.test.js` never matches it.
 *
 * Two modes, both inert when merely imported:
 *
 * 1. Worker (node:worker_threads, workerData.tierJob === true): replays the
 *    tier stream (test/helpers/tierStream.mjs runTier) on the build under test
 *    (../LogLogN.js) for one universe and posts ONE message
 *    `{ ok: true, result }` or `{ ok: false, message }`. test/TierParity.test.js
 *    runs every body that can loop in successor / predecessor / min / max here,
 *    under a kill timer (hang rule: a hang, a worker error, a nonzero exit or a
 *    missing result is a FAIL). workerData.variant picks a CONTROL build:
 *      'none'      -- the class as shipped;
 *      'extraRead' -- has() reads one extra `_bits` word (counts change only);
 *      'succ33'    -- successor() is wrong only at U=33 for x >= 31.
 *
 * 2. Bytecode driver (process main, argv contains --tier-bytecode-driver):
 *    calls has / add / delete / successor / predecessor / min / max so each is
 *    compiled (lazy compile), plus a generated function `tierSyntheticOver`
 *    whose bytecode exceeds the inlining cap (the A10 control). The test runs it
 *    under `--print-bytecode --print-bytecode-filter=<name>`.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { StratifiedBitset } from '../LogLogN.js';
import { runTier } from './helpers/tierStream.mjs';

export const VARIANTS = ['none', 'extraRead', 'succ33'];

function variantClass(variant) {
    if (variant === 'none') return StratifiedBitset;
    if (variant === 'extraRead') {
        return class ExtraRead extends StratifiedBitset {
            has(x) {
                const r = super.has(x);
                void this._bits[0];
                return r;
            }
        };
    }
    if (variant === 'succ33') {
        return class Succ33 extends StratifiedBitset {
            successor(x) {
                const r = super.successor(x);
                if (this._u === 33 && typeof x === 'number' && x >= 31) {
                    return r === undefined ? 32 : undefined;
                }
                return r;
            }
        };
    }
    throw new TypeError('unknown tier variant ' + String(variant));
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' &&
    workerData.tierJob === true) {
    let msg;
    try {
        const { U, nOps, seed, variant } = workerData;
        const result = runTier(variantClass(variant), U, nOps, seed);
        msg = { ok: true, result };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}

if (isMainThread && process.argv.includes('--tier-bytecode-driver')) {
    const s = new StratifiedBitset(1048576);
    let acc = 0;
    for (let i = 0; i < 64; i++) {
        s.add(i * 977);
        acc += s.has(i * 31) ? 1 : 0;
        acc += s.successor(i * 13) ?? 0;
        acc += s.predecessor(i * 4093 + 1) ?? 0;
        acc += s.min() ?? 0;
        acc += s.max() ?? 0;
        s.delete(i * 977 + 1);
    }
    // ~1.5 KB of bytecode: 160 statements of `a = (a * 31 + k) | 0;`
    let body = '';
    for (let k = 0; k < 160; k++) body += 'a = (a * 31 + ' + (k + 1000) + ') | 0;\n';
    const synth = (0, eval)('(function tierSyntheticOver(a) {\n' + body + 'return a;\n})');
    acc += synth(acc);
    process.stdout.write('tier-bytecode-driver acc=' + acc + '\n');
}
