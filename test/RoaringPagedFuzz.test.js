/**
 * @zakkster/lite-loglogn -- RoaringSet PAGED differential fuzz (0.6.0 G2-B3, PLAN-roaringset-G2 task 5, A-3;
 * SPEC C-5, C-6, C-10, C-20, C-22). Deterministic tier (seeded; no timing assertion).
 *
 * The harness (test/helpers/roaringPagedFuzz.mjs) runs, in node:worker_threads Workers with a kill timer
 * (test/_roaring-paged-worker.mjs):
 *   F6 / F8 / F10  a FORCED-paged build of ../LogLogN.js (C-5 line -> `const paged = true;`) at pageBits 6 / 8 /
 *                  10: G1's whole fuzz harness (every set paged), the R0 vc + bestp targeted cases, vc scenarios;
 *   B6 / B8 / B10  the REAL module at 2^32 with maxPages 1014 / 254 / 62: G1's 2^32 R / C scenarios + a page
 *                  stream; every 2^32 instance must be paged;
 *   M              mixed rows (direct vs paged, one 20,000-op stream each, only `.paged` differs), incl. the
 *                  C-13 tie row;
 *   X              the full page pool (2^32, 8, 8, 2): exact text, every array + own scalar + `_size` unchanged.
 * Page invariants are checked after every K = 128 mutating ops in the streams (1024 elsewhere) and at every
 * check point (checkSet).
 *
 * Asserted: 0 FAIL rows; per paged lane >= 1 page-pool throw AND >= 1 page release (deterministic, every
 * budget). The G1 harness floors (>= 100, C-22) are a BUDGET property (5..37 seeds x 4000 ops per scenario, ~6
 * CPU minutes per layout): gated by RoaringFuzz.test.js on the direct layout in npm test, and HERE only under
 * LOGLOGN_ROARING_FUZZ=full (R0's own budget, 40 seeds x 4000 ops); at the reduced default budget the G1
 * harness's floor rows are budget artifacts (excluded, counted in the G1 row), every other G1 row must pass.
 *
 * Seed: printed; override with LOGLOGN_SEED (fail-closed parse, test/helpers/seed.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeed } from './helpers/seed.mjs';
import { startPagedJob } from './_roaring-paged-worker.mjs';
import { LANES, floorMisses } from './helpers/roaringPagedFuzz.mjs';

const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0);
const MODE = process.env.LOGLOGN_ROARING_FUZZ === undefined ? 'default' : process.env.LOGLOGN_ROARING_FUZZ;
if (MODE !== 'default' && MODE !== 'full') throw new RangeError('LOGLOGN_ROARING_FUZZ must be unset or "full"; got ' + JSON.stringify(MODE));
const FULL = MODE === 'full';
const OPTS = FULL
    ? { g: { seeds: 40, ops: 4000 }, vc: { seeds: 40, ops: 4000 }, streamOps: 20000, base: BASE_SEED, floors: 'full' }
    : { g: { seeds: 1, ops: 1000 }, vc: { seeds: 1, ops: 2000 }, streamOps: 20000, base: BASE_SEED, floors: 'reduced' };
const KILL = FULL ? 4 * 3600000 : 600000;
const GROUPS = [['F6'], ['F8'], ['F10'], ['B6', 'B8', 'B10', 'M', 'X']];
const PAGED_LANES = LANES.filter((l) => l !== 'X');

const jobs = GROUPS.map((lanes) => startPagedJob({ lanes, opts: OPTS }, 'paged fuzz ' + lanes.join('+'), KILL));

test('RoaringPagedFuzz: seed printed, budget, groups cover every lane once', () => {
    console.log('# RoaringPagedFuzz seed 0x' + BASE_SEED.toString(16) + ' mode ' + MODE + ' opts ' + JSON.stringify(OPTS));
    assert.ok(Number.isInteger(BASE_SEED) && BASE_SEED >= 0 && BASE_SEED <= 0xFFFFFFFF);
    assert.deepEqual(GROUPS.flat().sort(), [...LANES].sort());
});

const done = [];
GROUPS.forEach((lanes, gi) => {
    test('RoaringPagedFuzz ' + lanes.join(' + ') + ': engine vs model, page invariants, 0 FAIL rows', async () => {
        const why = ' [LOGLOGN_SEED base 0x' + BASE_SEED.toString(16) + ', mode ' + MODE + ']';
        const r = await jobs[gi];
        if (r.error !== null) assert.fail(r.error + why);
        if (r.result === null || r.result.ok !== true) assert.fail(String(r.result && r.result.message) + why);
        assert.deepEqual(r.result.failures, [], why);
        assert.equal(r.result.failing, 0);
        assert.ok(r.result.rows.length > 0 && r.result.rows.every((x) => x.ok));
        done[gi] = r.result;
        for (const l of lanes) console.log('# RoaringPagedFuzz ' + l + ' ' + JSON.stringify(r.result.stats[l]));
        console.log('# RoaringPagedFuzz ' + lanes.join('+') + ': ' + r.result.rows.length + ' ok rows, in-worker ' + (r.result.wallMs / 1000).toFixed(1) + ' s (REPORTED)');
    });
});

test('RoaringPagedFuzz floors: every paged lane >= 1 page-pool throw and >= 1 page release' + (FULL ? '; G1 harness floors >= 100' : ''), async () => {
    await Promise.all(jobs);
    const stats = {};
    const cov = [];
    for (const r of done) if (r) { Object.assign(stats, r.stats); for (const c of r.cov) cov.push(c); }
    for (const l of LANES) assert.ok(stats[l] !== undefined, 'lane ' + l + ' ran');
    for (const l of PAGED_LANES) {
        assert.ok(stats[l].paged >= 1, l + ' built no paged set');
        assert.ok(stats[l].pageThrows >= 1, l + ' page-pool throws ' + stats[l].pageThrows);
        assert.ok(stats[l].releases >= 1, l + ' page releases ' + stats[l].releases);
        assert.ok(stats[l].checks >= 1, l + ' page-invariant checks ' + stats[l].checks);
    }
    assert.equal(stats.X.pageThrows, 1, 'X: exactly the one page-pool throw');
    // G1 harness coverage: F lanes run 5 R + 2 C scenarios, B lanes the two 2^32 ones
    for (const l of ['F6', 'F8', 'F10']) assert.equal(cov.filter((c) => c.lane === l).length, 7, l + ' G1 R / C scenarios');
    for (const l of ['B6', 'B8', 'B10']) assert.equal(cov.filter((c) => c.lane === l).length, 2, l + ' G1 2^32 scenarios');
    // R0's own floors (>= 100) at R0's budget; the reduced budget's G1 floor rows are budget artifacts (counted)
    if (FULL) assert.deepEqual(floorMisses(cov), []);
    for (const c of cov) console.log('# RoaringPagedFuzz floors ' + c.lane + ' ' + c.scenario + ' kinds ' + JSON.stringify(c.kinds) + ' bitmapsWithZeroWord ' + c.bmpZeroWord);
});
