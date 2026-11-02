/**
 * @zakkster/lite-loglogn -- vEBTree randomized differential fuzz (0.5.0 G1-B4,
 * PLAN-vebtree task 8, C-19). Deterministic tier (seeded; no timing assertion).
 *
 * 22 universes, odd ones included. Per universe a seeded op stream
 * (test/helpers/vebStream.mjs genStream: two independent mulberry32 PRNG streams, one
 * for ops, one for keys; bad keys, -0, boundary keys, drains) drives, in lockstep:
 *   the engine (vEBTree) -- VebRef (the recursive reference) -- SetOracle (a JS Set,
 *   the true definition) -- the research sketch (U <= 2^24).
 * Every op's outcome is a comparable tag (returned keys as numbers: a negative key
 * is a mismatch); sizes compare per op; the engine's `_t` equals VebRef.serialize()
 * word for word every 1000 ops and at the end (checkRef also runs on the reference).
 * clear() runs on its own seeded schedule (one per 2500-op window). Coverage floors
 * are asserted per universe (op kinds, maxSize, a clear on a non-empty tree).
 *
 * The run happens in node:worker_threads Workers with a kill timer (C-19): a hang
 * is a FAIL, never a wedged `npm test`. Three Workers (small / mid / big universes)
 * start at module load; each test awaits its own job.
 *
 * Seed: printed; override with LOGLOGN_SEED (fail-closed parse, test/helpers/seed.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeed } from './helpers/seed.mjs';
import { startJob } from './_veb-big-worker.mjs';

const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0x5eb0f022);

function seedFor(U, idx) {
    return (BASE_SEED ^ Math.imul(U, 0x9E3779B1) ^ Math.imul(idx + 1, 0x85EBCA6B)) >>> 0;
}

/** Op count by universe: bounded so the file stays fast. */
function opsFor(U) {
    if (U <= 1024) return 20000;
    if (U <= 2 ** 20 + 7) return 15000;
    if (U <= 2 ** 25 + 3) return 10000;
    if (U < 2 ** 30) return 6000; // 2^28 + 5: 33.7 MB per instance
    return 8000; // 2^31 + 12345
}

const UNIVERSES = [
    2, 3, 5, 31, 33, 255, 256, 257, 512, 1000, 4097, 65535, 65536, 65537, 100003, 131075,
    2 ** 20 + 7, 2 ** 24 - 1, 2 ** 24 + 1, 2 ** 25 + 3, 2 ** 28 + 5, 2 ** 31 + 12345,
];

const cfgs = UNIVERSES.map((U, i) => ({ U, nOps: opsFor(U), seed: seedFor(U, i) }));
const GROUPS = [
    ['small (U < 2^20)', cfgs.filter((c) => c.U < 2 ** 20)],
    ['mid (2^20 <= U <= 2^25+3)', cfgs.filter((c) => c.U >= 2 ** 20 && c.U <= 2 ** 25 + 3)],
    ['big (2^28+5, 2^31+12345)', cfgs.filter((c) => c.U > 2 ** 25 + 3)],
];

const KILL = 100000;
const jobs = GROUPS.map(([name, configs]) => startJob({ kind: 'fuzz', src: null, configs }, 'fuzz ' + name, KILL));

test('VebFuzz: >= 20 universes, odd ones included, seed printed', () => {
    console.log('# VebFuzz seed 0x' + BASE_SEED.toString(16));
    assert.ok(Number.isInteger(BASE_SEED) && BASE_SEED >= 0 && BASE_SEED <= 0xFFFFFFFF);
    assert.ok(new Set(UNIVERSES).size >= 20);
    assert.equal(GROUPS.reduce((a, g) => a + g[1].length, 0), UNIVERSES.length);
    for (const odd of [3, 5, 31, 33, 255, 1000, 4097, 65535, 65537, 100003, 131075, 2 ** 20 + 7, 2 ** 24 + 1, 2 ** 25 + 3, 2 ** 28 + 5]) {
        assert.ok(UNIVERSES.includes(odd), String(odd));
    }
});

GROUPS.forEach(([name, configs], gi) => {
    test('VebFuzz ' + name + ': engine vs VebRef vs Set vs sketch, layout every 1000 ops, clear', async () => {
        const why = ' [LOGLOGN_SEED base 0x' + BASE_SEED.toString(16) + ']';
        const r = await jobs[gi];
        if (r.error !== null) assert.fail(r.error + why);
        if (r.result === null || r.result.ok !== true) assert.fail(String(r.result && r.result.message) + why);
        assert.deepEqual(r.result.failures, [], 'seed 0x' + BASE_SEED.toString(16));
        assert.equal(r.result.rows.length, configs.length);
        let ops = 0;
        let clears = 0;
        let layouts = 0;
        for (const row of r.result.rows) {
            ops += row.nOps;
            clears += row.clears;
            layouts += row.layoutChecks;
        }
        console.log('# VebFuzz ' + name + ': ' + configs.length + ' universes, ' + ops + ' ops, ' + clears + ' clears, ' + layouts + ' layout checks');
        assert.ok(clears >= configs.length, 'at least one clear per universe');
    });
});
