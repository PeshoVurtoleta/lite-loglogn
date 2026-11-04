/**
 * @zakkster/lite-loglogn -- RoaringSet randomized differential fuzz (0.6.0 G1-B2, PLAN-roaringset-G1
 * task 2, assertion A-2, SPEC C-10). Deterministic tier (seeded; no timing assertion).
 *
 * The harness (test/helpers/roaringFuzz.mjs, ported from the R0 research fuzz) drives two RoaringSets per
 * scenario against a JS Set + sorted-array model, with white-box accounting after every check point
 * (per-chunk cardinality, headers, pool free + used == capacity, the bitmap summary equals a rescan),
 * interleaved runOptimize / range adds / range deletes / bitmap churn, and ~100 targeted cases. Ops and
 * keys come from independent seeded PRNG streams.
 *
 * The run happens in node:worker_threads Workers with a kill timer: a hang is a FAIL, never a wedged
 * `npm test` (test/_roaring-fuzz-worker.mjs; the same worker runs G1-B5's data: URL mutants).
 *
 * Asserted: 0 FAIL rows; coverage floors >= 100 (R scenarios: kinds 1..7, pool0 exempt for kinds 1 and 5;
 * C scenarios: kinds 1..4; both: bitmapsWithZeroWord), re-checked here independently of the harness.
 *
 * G3-B2a: the harness now also checks the four set ops (checkPair) at every check point and in the restored targeted
 * cases (bitmap x bitmap, va kind-pair, SINGLE x every kind, kind x kind).
 *
 * Seed: printed; override with LOGLOGN_SEED (fail-closed parse, test/helpers/seed.mjs). The budget:
 * SEEDS_BY (per R / C scenario, ops 4000) below; 16 x 4000 for the scenarios without floors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeed } from './helpers/seed.mjs';
import { startRoaringJob, DEFAULT_MODULE_URL } from './_roaring-fuzz-worker.mjs';
import { floorMisses, SECTIONS, RSCEN, CSCEN } from './helpers/roaringFuzz.mjs';

const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0);
const BUDGET = { seeds: 16, ops: 4000 }; // SCEN / T / V / D / E / B (no floors); R / C use SEEDS_BY
const KILL = 600000;

// PER-SCENARIO SEED COUNTS (maintainer ruling 2026-11-04, AskUserQuestion; PLAN-roaringset-G1 A-2).
// Each R / C scenario runs ops = 4000 and the smallest seed count at which EVERY floor of that scenario is met
// with a >= 20% margin (every floored count >= 120 against the floor 100; bitmapsWithZeroWord >= 120), found on
// the shipped engine at the default base seed 0 (evidence: .handoff/evidence/roaring-g1-b2.md). A different
// LOGLOGN_SEED changes only the base seed; a floor then missed is a FAIL (fail closed), never skipped.
const SEEDS_BY = {
    'R U=2^20 range+opt mix': 23,
    'R U=2^18 range+opt runs': 7,
    'R U=2^32 range+opt mix': 30,
    'R U=2^20 range+opt pool0': 5,
    'R U=200001 range+opt': 14,
    'C U=2^18 bitmap churn': 37,
    'C U=2^32 bitmap churn hi': 36,
};

// one Worker each, balanced by measured cost (about 120 s of seed work per worker, see the evidence file)
const GROUPS = [
    ['SCEN V D B + R 2^32', ['SCEN', 'R', 'V', 'D', 'B'], ['R U=2^32 range+opt mix']],
    ['R pool0 runs + C hi + T E', ['R', 'C', 'T', 'E'], ['C U=2^32 bitmap churn hi', 'R U=2^20 range+opt pool0', 'R U=2^18 range+opt runs']],
    ['C 2^18 + R mix + R 200001', ['R', 'C'], ['C U=2^18 bitmap churn', 'R U=2^20 range+opt mix', 'R U=200001 range+opt']],
];

const jobs = GROUPS.map(([name, only, names]) => startRoaringJob(
    { kind: 'fuzz', url: DEFAULT_MODULE_URL, seeds: BUDGET.seeds, ops: BUDGET.ops, base: BASE_SEED, only, names, seedsBy: SEEDS_BY },
    'fuzz ' + name, KILL));

test('RoaringFuzz: seed printed, budget, sections partition the harness', () => {
    console.log('# RoaringFuzz seed 0x' + BASE_SEED.toString(16) + ' budget ' + BUDGET.seeds + ' seeds x ' + BUDGET.ops + ' ops, R / C seeds ' + JSON.stringify(SEEDS_BY));
    assert.ok(Number.isInteger(BASE_SEED) && BASE_SEED >= 0 && BASE_SEED <= 0xFFFFFFFF);
    assert.deepEqual([...new Set(GROUPS.flatMap((g) => g[1]))].sort(), [...SECTIONS].sort());
    const REG = [...RSCEN, ...CSCEN].map((s) => s.name).sort();
    assert.deepEqual(Object.keys(SEEDS_BY).sort(), REG, 'SEEDS_BY covers exactly the harness registry');
    assert.deepEqual(GROUPS.flatMap((g) => g[2]).sort(), REG, 'every registry scenario in exactly one group');
});

test('RoaringFuzz floor check has teeth: a synthetic miss is reported', () => {
    const ok = { scenario: 's', isR: true, maxS: 4, bmpZeroWord: 100, kinds: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, 7: 100 } };
    assert.deepEqual(floorMisses([ok]), []);
    assert.equal(floorMisses([{ ...ok, kinds: { ...ok.kinds, 3: 99 } }]).length, 1);
    assert.equal(floorMisses([{ ...ok, bmpZeroWord: 99 }]).length, 1);
    assert.equal(floorMisses([{ ...ok, kinds: { ...ok.kinds, 7: 0 } }]).length, 1);
    assert.deepEqual(floorMisses([{ ...ok, maxS: 0, kinds: { 2: 100, 3: 100, 4: 100, 6: 100, 7: 100 } }]), [], 'pool0 exempts kinds 1 and 5');
    assert.equal(floorMisses([{ ...ok, isR: false, kinds: { 1: 100, 2: 100, 3: 100, 4: 99 } }]).length, 1);
    assert.deepEqual(floorMisses([{ ...ok, isR: false, kinds: { 1: 100, 2: 100, 3: 100, 4: 100 } }]), [], 'C scenarios need kinds 1..4 only');
});

const done = [];
GROUPS.forEach(([name], gi) => {
    test('RoaringFuzz ' + name + ': engine vs model, white-box accounting, 0 FAIL rows', async () => {
        const why = ' [LOGLOGN_SEED base 0x' + BASE_SEED.toString(16) + ']';
        const r = await jobs[gi];
        if (r.error !== null) assert.fail(r.error + why);
        if (r.result === null || r.result.ok !== true) assert.fail(String(r.result && r.result.message) + why);
        assert.deepEqual(r.result.failures, [], 'seed 0x' + BASE_SEED.toString(16));
        assert.equal(r.result.failing, 0);
        assert.ok(r.result.rows.length > 0 && r.result.rows.every((x) => x.ok));
        done[gi] = r.result;
        console.log('# RoaringFuzz ' + name + ': ' + r.result.rows.length + ' ok rows, in-worker ' + (r.result.wallMs / 1000).toFixed(1) + ' s (REPORTED)');
    });
});

test('RoaringFuzz: coverage floors >= 100 on kinds 1-7 (R) / 1-4 (C) and bitmapsWithZeroWord', async () => {
    await Promise.all(jobs);
    const cov = [];
    for (const r of done) if (r) for (const c of r.cov) cov.push(c);
    const R = cov.filter((c) => c.isR);
    const C = cov.filter((c) => !c.isR);
    assert.equal(R.length, RSCEN.length, 'every R scenario ran');
    assert.equal(C.length, CSCEN.length, 'every C scenario ran');
    assert.deepEqual(floorMisses(cov), []);
    for (const c of cov) console.log('# RoaringFuzz floors ' + c.scenario + ' kinds ' + JSON.stringify(c.kinds) + ' bitmapsWithZeroWord ' + c.bmpZeroWord);
});
