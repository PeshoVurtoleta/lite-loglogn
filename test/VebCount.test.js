/**
 * @zakkster/lite-loglogn -- vEBTree COUNT gate (0.5.0 G1-B5, PLAN-vebtree task 7,
 * ASSERTION A3; DETERMINISTIC hard gate: counts, not timing, prove the cost model --
 * decisions/0004 Amendment 1, decisions/0009 L4).
 *
 * Proxies on `_t`, `_g` and `_p` of a constructed instance count numeric-index
 * gets / sets (test/_veb-count-worker.mjs header). ALL THREE columns are exact per
 * op. Expected values = test/helpers/vebCost.mjs walking the independent recursive
 * reference VebRef with the read orders of PLAN CURRENT C-12 + C-18 -- never read
 * back from the engine. The planner's A3 literals below are a second, hand-written
 * oracle: each is checked against the engine AND against vebCost.
 *
 * Gate:
 *   A3 rows at w = 16 / 20 / 24 / 28 (U = 2^w): min / max = 1 `_t` read (empty 0);
 *     successor(0) on {U-1} = 1; predecessor(U-1) on {0} = 1; successor(0) on
 *     {0, 65535} at 2^16 = 26; has(5) on {0,5,6,U-1} = 3 at w 16 / 20 / 24; has(6)
 *     on {0,5,6,7,U-1} at w 28 = 5; successor(5) on {0,5,6,65535} at 2^16 = 3; plus
 *     the StratifiedBitset side through test/_count-worker.mjs's harness (min / max
 *     4 / 4 / 5 / 6, successor(0) on {0,65535} = 7, has = 1, successor(5) = 1);
 *   bad keys: 0 reads / 0 writes on all 3 columns, every keyed op, empty and 2-key;
 *   a seeded stream at U = 2, 3, 256, 257, 4097, 2^16, 2^17+3, 2^20, 2^24, 2^24+1,
 *     2^25+3, 2^28: every op's 3 columns == vebCost and its answer == VebRef;
 *     coverage floors (delete frames mode 1 / 2, two frames, the C-18 (4) 0-read
 *     refresh, internal-cluster successor / predecessor visits, the add
 *     empty-cluster paths, min swaps, singletons).
 *   C-18 (6) (A4, ruling F-B5-1): an absent delete whose node header proves absence
 *     stops after those 2 reads; has does not stop early. One model, exact; a floor
 *     proves the stream reaches that class.
 * Must-fail mutants (anchor replaced exactly once in the live LogLogN.js text,
 * loaded by data: URL in a Worker under a kill timer, C-19: a hang = TIMEOUT = an
 * expected fail; a mutant that PASSES fails the test): add with a has pre-pass; a
 * reversed successor leaf scan; min() without its `_size === 0` guard; has() through
 * a `_t` reference cached in the ctor; delete without the C-18 (6) header stop
 * (descends like has); has WITH an early stop on x < min. A clean-engine control through the same
 * data: URL path PASSES.
 * Seed: env LOGLOGN_VEB_COUNT_SEED (decimal only, fail closed), else the default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

process.stdout.setMaxListeners(64);
process.stderr.setMaxListeners(64);

const T = { timeout: 120000 };
const HANG_MS = 100000;
const MUTANT_MS = 60000;

/** Decimal digits only; anything else is an error (never a silent fallback). */
function parseSeed(v) {
    if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) {
        throw new RangeError('LOGLOGN_VEB_COUNT_SEED must match /^[0-9]+$/, got ' + JSON.stringify(v));
    }
    if (v.length > 10 || Number(v) > 0xFFFFFFFF) {
        throw new RangeError('LOGLOGN_VEB_COUNT_SEED must be <= 4294967295, got ' + JSON.stringify(v));
    }
    return Number(v);
}
const SEED = process.env.LOGLOGN_VEB_COUNT_SEED !== undefined
    ? parseSeed(process.env.LOGLOGN_VEB_COUNT_SEED)
    : 0x0eb5eed5;
console.log('# VebCount.test.js seed=' + SEED);

const WORKER_URL = new URL('./_veb-count-worker.mjs', import.meta.url);
const SRC_TEXT = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');

const A3_WS = [16, 20, 24, 28];
// U -> [phases, stream ops] (42,000 stream ops in all); grouped into workers below
const UNITS = {
    2: [['bad', 'stream'], 2000],
    3: [['bad', 'stream'], 2000],
    256: [['bad', 'stream'], 2000],
    257: [['bad', 'stream'], 3000],
    4097: [['bad', 'stream'], 3000],
    65536: [['a3', 'sb', 'bad', 'stream'], 4000],
    131075: [['bad', 'stream'], 4000],
    1048576: [['a3', 'sb', 'bad', 'stream'], 4000],
    16777216: [['a3', 'sb', 'bad', 'stream'], 2000],
    16777217: [['bad', 'stream'], 4000],
    33554435: [['bad', 'stream'], 8000],
    268435456: [['a3', 'sb', 'bad', 'stream'], 4000],
};
const GROUPS = [[2, 3, 256, 257, 4097], [65536], [131075, 1048576], [16777216, 16777217], [33554435], [268435456]];
const INTERNAL_US = [16777217, 33554435, 268435456];

// The planner's A3 literals (`_t` reads; writes 0 on every column for these query rows).
const A3_LIT = {
    'min empty': [0, 0, 0, 0],
    'max empty': [0, 0, 0, 0],
    'min {5,U-1}': [1, 1, 1, 1],
    'max {5,U-1}': [1, 1, 1, 1],
    'successor(0) on {U-1}': [1, 1, 1, 1],
    'predecessor(U-1) on {0}': [1, 1, 1, 1],
    'successor(0) on {0,65535}': [26, null, null, null],
    'successor(5) on {0,5,6,65535}': [3, null, null, null],
    'has(5) on {0,5,6,U-1}': [3, 3, 3, null],
    'has(6) on {0,5,6,7,U-1}': [null, null, null, 5],
};
const SB_LIT = {
    'min {5,U-1}': [4, 4, 5, 6],
    'max {5,U-1}': [4, 4, 5, 6],
    'successor(0) on {0,65535}': [7, null, null, null],
    'successor(5) on {0,5,6,65535}': [1, null, null, null],
    'has(5) on {0,5,6,U-1}': [1, 1, 1, 1],
    'has(6) on {0,5,6,7,U-1}': [1, 1, 1, 1],
};

/**
 * Runs a worker; NEVER rejects. Resolves { parts, error, early }: error on a hang
 * (terminated after ms), a worker error or a nonzero exit; with stopOnFail the first
 * phase that posts fails terminates the worker (early = that phase).
 */
function runWorker(spec, options, ms, label, stopOnFail) {
    return new Promise((resolve) => {
        const parts = Object.create(null);
        let done = false;
        let early = null;
        const w = new Worker(spec, options);
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ parts, error, early });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('hang > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            if (m === null || typeof m !== 'object' || typeof m.phase !== 'string' || !Array.isArray(m.fails)) return;
            parts[m.phase] = m;
            if (stopOnFail && m.fails.length > 0 && !done) {
                early = m.phase;
                w.terminate();
                finish(null);
            }
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.stack ? e.stack : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

function unitsOf(us, opsScale) {
    return us.map((U) => ({ U, phases: UNITS[U][0], nOps: Math.floor(UNITS[U][1] * opsScale) }));
}

const JOBS = GROUPS.map((us) => runWorker(WORKER_URL, {
    workerData: { vebCountJob: true, src: null, seed: SEED, units: unitsOf(us, 1) },
}, HANG_MS, 'U=' + us.join(','), false));
const JOB_OF = new Map();
GROUPS.forEach((us, i) => { for (const U of us) JOB_OF.set(U, JOBS[i]); });

async function phase(U, name) {
    const r = await JOB_OF.get(U);
    const part = r.parts[U + ':' + name];
    assert.ok(part !== undefined, 'U=' + U + ' phase ' + name + ' posted no result' +
        (r.error !== null ? ' (' + r.error + ')' : ''));
    assert.equal(r.error, null, 'U=' + U + ': ' + r.error);
    return part;
}

// --- mutants (each must FAIL) ----------------------------------------------------------

function mutate(edits) {
    let text = SRC_TEXT;
    for (const [anchor, repl] of edits) {
        const n = text.split(anchor).length - 1;
        assert.equal(n, 1, 'mutant anchor count ' + n + ' != 1: ' + JSON.stringify(anchor.slice(0, 80)));
        const i = text.indexOf(anchor);
        text = text.slice(0, i) + repl + text.slice(i + anchor.length);
    }
    return 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
}

const ADD_HEAD = '        if (typeof x !== \'number\' || (x >>> 0) !== x || x >= this._u) throwKey(x, this._u);\n' +
    '        const t = this._t;\n        const g = this._g;\n        let b = 0;\n        let w = this._w;\n        let ps = -1;';
const HAS_HEAD = '        if (typeof x !== \'number\' || (x >>> 0) !== x || x >= this._u) return false;\n' +
    '        const t = this._t;\n        const g = this._g;\n        let b = 0;\n        let w = this._w;\n        while (w > 8) {';
const SUCC_SCAN = '                let p = c + (s >>> 5);\n' +
    '                let v = (t[p] | 0) & (-1 << (s & 31));\n' +
    '                while (v === 0 && ++p < c + 8) v = t[p] | 0;\n';
const DEL_STOP = '                if (mn > mx || x < mn || x > mx) return false;\n                if (mn === mx) {\n';
const HAS_STOP = HAS_HEAD + '\n            const mn = t[b];\n            const mx = t[b + 1];\n            if (mn > mx) return false;\n';
const MIN_HEAD = '    min() {\n        if (this._size === 0) return undefined;\n';

const MUTANTS = {
    // add runs a has() walk before its own walk (C-12: no has pre-pass)
    hasPrePass: {
        edits: [[ADD_HEAD, ADD_HEAD.replace('throwKey(x, this._u);\n', 'throwKey(x, this._u);\n        if (this.has(x)) return this;\n')]],
        want: /add\(.*counts t \d+\/\d+ g \d+\/0 p 0\/0 != vebCost/,
    },
    // successor's leaf-cluster scan runs from the cluster's last word DOWN to the start
    // word, keeping the lowest nonzero word: same answers, reads every word above
    revSuccScan: {
        edits: [[SUCC_SCAN, '                const p0 = c + (s >>> 5);\n                let p = p0;\n                let v = 0;\n' +
            '                for (let q = c + 7; q >= p0; q--) {\n' +
            '                    let u = t[q] | 0;\n' +
            '                    if (q === p0) u &= -1 << (s & 31);\n' +
            '                    if (u !== 0) {\n                        v = u;\n                        p = q;\n                    }\n' +
            '                }\n']],
        want: /successor\(5\) on \{0,5,6,65535\} successor\(5\) size 4: counts t 10\/0/,
    },
    // min() without the `_size === 0` guard (an empty root reads its EMPTY header)
    minNoGuard: {
        edits: [[MIN_HEAD, '    min() {\n']],
        want: /min empty min\(undefined\) size 0: counts t 1\/0 g 0\/0 p 0\/0 != vebCost t 0\/0/,
    },
    // has() reads a `_t` reference cached in the ctor: the Proxy is bypassed
    cachedT: {
        edits: [
            ['        this._t = new Uint32Array(words);\n', '        this._t = new Uint32Array(words);\n        this._tc = this._t;\n'],
            [HAS_HEAD, HAS_HEAD.replace('const t = this._t;', 'const t = this._tc;')],
        ],
        want: /has\(5\) on \{0,5,6,U-1\} has\(5\) size 4: counts t 0\/0 g 1\/0 p 0\/0 != vebCost t 3\/0/,
    },
    // delete without the C-18 (6) header stop: an absent key descends like has (only a
    // one-key node holding x is emptied) -- same answers, more reads past the header
    delNoStop: {
        edits: [[DEL_STOP, '                if (mn > mx) return false;\n                if (mn === mx && x === mn) {\n']],
        want: /delete\(.*counts t \d+\/0 g [1-9]\d*\/0 p 0\/0 != vebCost t \d+\/0 g \d+\/0 p 0\/0/,
    },
    // has WITH an early stop on x < min (C-18 (6) stops delete only): same answers
    hasStop: {
        edits: [[HAS_STOP, HAS_STOP.replace('if (mn > mx) return false;', 'if (mn > mx || x < mn) return false;')]],
        want: /has\(.*counts t \d+\/0 g \d+\/0 p 0\/0 != vebCost/,
    },
};
const MUTANT_UNITS = [
    { U: 65536, phases: ['a3', 'bad', 'stream'], nOps: 3000 },
    { U: 33554435, phases: ['stream'], nOps: 3000 },
    { U: 257, phases: ['stream'], nOps: 2000 },
    { U: 256, phases: ['stream'], nOps: 1000 },
];

function mutantJob(src, label) {
    return runWorker(WORKER_URL, {
        workerData: { vebCountJob: true, src, seed: SEED, units: MUTANT_UNITS },
    }, MUTANT_MS, label, true);
}

/** PASS / FAIL / TIMEOUT / ERROR of a mutant-path run + the fails seen. */
function verdict(r) {
    const fails = [];
    for (const k of Object.keys(r.parts)) fails.push(...r.parts[k].fails);
    if (r.error !== null && /^hang > /.test(r.error)) return { v: 'TIMEOUT', fails };
    if (r.error !== null) return { v: 'ERROR', fails, error: r.error };
    if (fails.length > 0) return { v: 'FAIL', fails };
    for (const u of MUTANT_UNITS) {
        for (const p of u.phases) if (r.parts[u.U + ':' + p] === undefined) return { v: 'ERROR', fails, error: 'missing ' + u.U + ':' + p };
    }
    return { v: 'PASS', fails };
}

const MJOBS = {};
for (const [name, m] of Object.entries(MUTANTS)) {
    let src = null;
    try {
        src = mutate(m.edits);
    } catch (e) {
        MJOBS[name] = Promise.resolve({ anchorError: String(e && e.message) });
        continue;
    }
    MJOBS[name] = mutantJob(src, 'mutant ' + name);
}
const CLEAN = mutantJob('data:text/javascript;base64,' + Buffer.from(SRC_TEXT).toString('base64'), 'clean data: control');

// --- A3 -------------------------------------------------------------------------------------

for (let i = 0; i < A3_WS.length; i++) {
    const w = A3_WS[i];
    const U = 2 ** w;
    test('A3 exact rows, all 3 columns == vebCost, `_t` reads == the planner literals, w=' + w, T, async (t) => {
        const p = await phase(U, 'a3');
        const sb = await phase(U, 'sb');
        const sbBy = new Map(sb.table.map((r) => [r.label, r]));
        const line = [];
        for (const r of p.table) {
            const lit = A3_LIT[r.label] !== undefined ? A3_LIT[r.label][i] : null;
            const s = sbBy.get(r.label);
            line.push(r.label + ' veb ' + r.got.t.reads + (s !== undefined ? ' / SB ' + s.R : ''));
            assert.deepEqual(r.got, r.want, 'w=' + w + ' ' + r.label + ': engine == vebCost on all 3 columns');
            for (const c of ['t', 'g', 'p']) assert.equal(r.got[c].writes, 0, 'w=' + w + ' ' + r.label + ' ' + c + ' writes');
            assert.equal(r.got.p.reads, 0, 'w=' + w + ' ' + r.label + ' `_p` reads');
            if (lit !== null) {
                assert.equal(r.got.t.reads, lit, 'w=' + w + ' ' + r.label + ': engine `_t` reads vs the A3 literal');
                assert.equal(r.want.t.reads, lit, 'w=' + w + ' ' + r.label + ': vebCost `_t` reads vs the A3 literal');
            }
        }
        t.diagnostic('w=' + w + ' loss row: ' + line.join(' | '));
        assert.deepEqual(p.fails, []);
        assert.equal(p.rows, p.table.length);
        assert.equal(p.rows, 10, 'rows ran');
        const nLit = Object.values(A3_LIT).filter((a) => a[i] !== null).length;
        assert.ok(nLit >= 7, 'literal rows at w=' + w + ': ' + nLit);
    });

    test('A3 StratifiedBitset side via the Count.test.js harness, w=' + w, T, async () => {
        const sb = await phase(U, 'sb');
        assert.deepEqual(sb.fails, []);
        assert.equal(sb.levels, [4, 4, 5, 6][i], 'SB levels');
        let n = 0;
        for (const r of sb.table) {
            const lit = SB_LIT[r.label][i];
            assert.equal(r.Wr, 0, r.label + ' SB writes');
            if (lit !== null) {
                assert.equal(r.R, lit, 'w=' + w + ' SB ' + r.label);
                n++;
            }
        }
        assert.equal(n, w === 16 ? 6 : 4, 'SB literal rows checked');
    });
}

test('A3 vEB vs SB loss row, U=2^16 (successor(0) on {0,65535}: 26 vs 7; successor(5): 3 vs 1; has: 3 vs 1)', T, async (t) => {
    const p = await phase(65536, 'a3');
    const sb = await phase(65536, 'sb');
    const v = new Map(p.table.map((r) => [r.label, r.got.t.reads]));
    const s = new Map(sb.table.map((r) => [r.label, r.R]));
    t.diagnostic([...s.keys()].map((k) => k + ': ' + v.get(k) + ' vs ' + s.get(k)).join(' | '));
    assert.deepEqual([v.get('successor(0) on {0,65535}'), s.get('successor(0) on {0,65535}')], [26, 7]);
    assert.deepEqual([v.get('successor(5) on {0,5,6,65535}'), s.get('successor(5) on {0,5,6,65535}')], [3, 1]);
    assert.deepEqual([v.get('has(5) on {0,5,6,U-1}'), s.get('has(5) on {0,5,6,U-1}')], [3, 1]);
    assert.deepEqual([v.get('min {5,U-1}'), s.get('min {5,U-1}')], [1, 4]);
});

// --- bad keys + stream ------------------------------------------------------------------------

const ALL_US = Object.keys(UNITS).map(Number);
for (const U of ALL_US) {
    test('bad keys: 0 reads / 0 writes on `_t` / `_g` / `_p`, every keyed op, U=' + U, T, async () => {
        const p = await phase(U, 'bad');
        assert.deepEqual(p.fails, []);
        assert.equal(p.rows, 2 * 18 * 5);
    });

    test('seeded stream: every op == vebCost on all 3 columns, answer == VebRef, U=' + U, T, async (t) => {
        const p = await phase(U, 'stream');
        t.diagnostic('seed=' + SEED + ' w=' + p.w + ' kinds=' + JSON.stringify(p.kinds) + ' cov=' + JSON.stringify(p.cov));
        assert.deepEqual(p.fails, [], 'seed=' + SEED + ' U=' + U);
        assert.equal(p.rows, UNITS[U][1]);
        let sum = 0;
        for (const k in p.kinds) sum += p.kinds[k];
        assert.equal(sum, UNITS[U][1], 'every op ran');
        for (const k of ['has', 'add', 'delete', 'successor', 'predecessor', 'min', 'max']) {
            assert.ok(p.kinds[k] >= 100, 'U=' + U + ' ' + k + ' ran ' + p.kinds[k]);
        }
    });
}

test('seeded stream coverage floors (the walk really visits every C-12 / C-18 path)', T, async (t) => {
    const tot = {};
    const per = {};
    for (const U of ALL_US) {
        const p = await phase(U, 'stream');
        per[U] = p.cov;
        for (const k in p.cov) tot[k] = (tot[k] || 0) + p.cov[k];
    }
    t.diagnostic('total cov ' + JSON.stringify(tot));
    // floors ~1/3..1/2 of the minimum over seeds 1..8, 99, 12345 and the default
    // (.handoff/evidence/veb-b5-floors-r2.log; delAbsentAtHeader = the C-18 (6) stop)
    const FLOOR = {
        delAbsentAtHeader: 45,
        delFrame1: 500, delFrame2: 400, delTwoFrames: 300, refresh0: 10, delMinSwap: 100, delSingleton: 300,
        addEmptyLeafCluster: 650, addEmptyIntCluster: 320, succIntVisit: 360, predIntVisit: 330,
        succIntSkip: 230, predIntSkip: 260, succSummary: 600, predSummary: 750, predMinFallback: 105,
    };
    for (const [k, f] of Object.entries(FLOOR)) assert.ok((tot[k] || 0) >= f, k + ' ' + (tot[k] || 0) + ' < ' + f);
    for (const U of INTERNAL_US) {
        for (const k of ['succIntVisit', 'predIntVisit', 'addEmptyIntCluster', 'delFrame1', 'delFrame2']) {
            assert.ok((per[U][k] || 0) >= 50, 'U=' + U + ' ' + k + ' ' + (per[U][k] || 0) + ' < 50');
        }
    }
    // the 0-read refresh needs an internal summary: hi >= 9 (w 17..24 at lo 8, w >= 25 at lo 16)
    const r8 = (per[131075].refresh0 || 0) + (per[1048576].refresh0 || 0) + (per[16777216].refresh0 || 0);
    const r16 = (per[16777217].refresh0 || 0) + (per[33554435].refresh0 || 0) + (per[268435456].refresh0 || 0);
    assert.ok(r8 >= 6 && r16 >= 3, 'refresh0 at lo 8 roots ' + r8 + ', at lo 16 roots ' + r16);
});

// --- mutant controls ---------------------------------------------------------------------------

test('control: the clean engine through the data: URL mutant path PASSES', T, async () => {
    const r = await CLEAN;
    const v = verdict(r);
    assert.ok(r.parts.loaded !== undefined && r.parts.loaded.hasVeb === true, 'clean module loaded');
    assert.equal(v.v, 'PASS', v.fails.slice(0, 3).join('\n') + (v.error ? ' ' + v.error : ''));
});

for (const name of Object.keys(MUTANTS)) {
    test('control M-' + name + ': the mutant FAILS the count gate for its own reason', T, async (t) => {
        const r = await MJOBS[name];
        assert.equal(r.anchorError, undefined, 'mutant anchor: ' + r.anchorError);
        assert.ok(r.parts.loaded !== undefined && r.parts.loaded.hasVeb === true, 'mutant module loaded');
        const v = verdict(r);
        t.diagnostic('M-' + name + ' ' + v.v + (r.early !== null ? ' at ' + r.early : '') + ': ' + (v.fails[0] || ''));
        assert.notEqual(v.v, 'PASS', 'a mutant that PASSES fails the gate');
        assert.notEqual(v.v, 'ERROR', 'mutant run errored: ' + v.error);
        if (v.v === 'FAIL') assert.ok(v.fails.some((m) => MUTANTS[name].want.test(m)), v.fails.slice(0, 3).join('\n'));
    });
}

test('control: mutate() rejects a missing and a duplicated anchor', () => {
    assert.throws(() => mutate([['this text is not in LogLogN.js', 'x']]), /anchor count 0 != 1/);
    assert.throws(() => mutate([['const t = this._t;', 'x']]), /anchor count \d+ != 1/);
});

test('control: a worker that hangs / exits 1 / posts nothing is a FAIL; stopOnFail ends early', T, async () => {
    const hang = await runWorker('for (;;) {}', { eval: true }, 300, 'spin', false);
    assert.ok(hang.error !== null && /^hang > 300 ms/.test(hang.error), String(hang.error));
    assert.equal(verdict(hang).v, 'TIMEOUT');
    const exit1 = await runWorker('process.exit(1)', { eval: true }, 5000, 'exit1', false);
    assert.equal(verdict(exit1).v, 'ERROR');
    const empty = await runWorker('0', { eval: true }, 5000, 'empty', false);
    assert.equal(verdict(empty).v, 'ERROR', 'no phase posted is never a PASS');
    const early = await runWorker("const { parentPort } = require('node:worker_threads'); " +
        "parentPort.postMessage({ phase: 'x', fails: ['boom'] }); setTimeout(() => {}, 60000);", { eval: true }, 30000, 'early', true);
    assert.equal(early.early, 'x');
    assert.equal(verdict(early).v, 'FAIL');
    JOB_OF.set(-1, Promise.resolve(empty));
    await assert.rejects(phase(-1, 'stream'), /posted no result/);
    JOB_OF.delete(-1);
});

test('LOGLOGN_VEB_COUNT_SEED: only /^[0-9]+$/ is accepted; anything else is rejected loudly', () => {
    assert.equal(parseSeed('0'), 0);
    assert.equal(parseSeed('4294967295'), 4294967295);
    for (const bad of ['', 'abc', '-1', '1.5', '0x10', ' 1', '1e3', '+1', undefined, 5, '4294967296']) {
        assert.throws(() => parseSeed(bad), RangeError, JSON.stringify(bad));
    }
});
