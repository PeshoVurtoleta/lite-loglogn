/**
 * @zakkster/lite-loglogn -- XFastTrie FUZZ ORACLES + CuckooMap level cross-check
 * (G-B1, G4 / G5; DETERMINISTIC). Independent of the engine: every expectation
 * comes from the SPEC (strict successor / predecessor, capacity rule, bad-key
 * rule), a plain sorted array and sibling packages (devDependencies, tests only).
 *
 * The seeded stream of test/helpers/xftStream.mjs genStream(U, C, nOps, seed)
 * (fill to C, 50 full-throws, MIX / REFILL / DRAIN / CLUSTER churn, ~3% bad keys,
 * -0) is replayed in a worker (test/_xft-worker.mjs) on new XFastTrie(U, C) and
 * every return value and the size is compared per op with FIVE oracles:
 * StratifiedBitset (U <= 2^25), lite-logn Scapegoat / SkipList / Treap and
 * SortedArray (min / max too). Every 1,024 ops the min -> successor and
 * max -> predecessor walks equal the sorted truth exactly, and one lite-o1
 * CuckooMap per level k (prefix -> refcount) must equal dump().levels[k - 1]:
 * prefix set, per-prefix min / max key, entry count, and
 * levels[k - 1].capacity === new CuckooMap(min(C, 2^k)).capacity.
 *
 * U set {2, 3, 31, 32, 33, 1025, 2^16, 65537, 999983, 2^20, 2^25, 2^30, 2^32};
 * caps {1, 64, min(U, 4096)} (those <= U, deduplicated). Ops per (U, C) stream:
 * 300,000 for U <= 2^20, 200,000 above (OPS_SMALL / OPS_BIG). No vacuous pass:
 * every op kind, checkpoint, level, full-throw and oracle comparison is counted
 * and asserted > 0.
 *
 * MUST-FAIL CONTROLS (mutants of the REAL LogLogN.js text; each anchor is replaced
 * exactly once, asserted found-once, loaded via a data: URL):
 *   MX1  _near binary search goes the wrong way (hit/miss branches swapped);
 *   MX2  the upper-half thread hop reads _prev instead of _next;
 *   MX3  at w = 32 the root-level bit uses x >>> 32 (== x >>> 0 in JS);
 *   MX4  delete skips the removal at level w - 4 (a stale prefix: the CuckooMap
 *        cross-check must catch it);
 *   MX5  add increments size before the full check.
 * MX1 / MX2 must diverge from EACH oracle at U = 2^16 and U = 2^32 (StratifiedBitset
 * only at 2^16: above 2^25 it is not compared); MX3 from each oracle at 2^32.
 *
 * HANG RULE: every replay runs under the KILL_MS kill timer of test/_worker-run.mjs;
 * a hang, a worker error, a nonzero exit or a missing result is a FAIL. All jobs
 * start at module load, in parallel. Seed: printed; override with LOGLOGN_SEED.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync, readdirSync } from 'node:fs';
import { KILL_MS } from './_worker-run.mjs';
import { ORACLES, runXft } from './_xft-worker.mjs';
import { XFastTrie } from '../LogLogN.js';
import { genStream, badKeys, keyAt } from './helpers/xftStream.mjs';
import { parseSeed } from './helpers/seed.mjs';

const T = { timeout: 120000 };
const WORKER_URL = new URL('./_xft-worker.mjs', import.meta.url);
const BASE_SEED = parseSeed(process.env.LOGLOGN_SEED, 0x7c15a3d9);
// 2^31 is w = 31 (the widest universe whose keys all fit in 31 bits); 2^31 + 1 is w = 32
// with the single key 2^31 above the int32 range (the 31 -> 32 bit boundary, F12 nit i)
const US = [2, 3, 31, 32, 33, 1025, 65536, 65537, 999983, 1048576, 33554432, 1073741824,
    2147483648, 2147483649, 4294967296];
const OPS_SMALL = 300000;
const OPS_BIG = 200000;
const MUT_OPS = 40000;
const OP_NAMES = ['add', 'delete', 'has', 'successor', 'predecessor', 'min', 'max'];

function seedFor(U, C) {
    return (BASE_SEED ^ Math.imul(U, 0x9E3779B1) ^ Math.imul(C, 0x85EBCA6B)) >>> 0;
}

function capsFor(U) {
    const set = new Set();
    for (const c of [1, 64, Math.min(U, 4096)]) if (c <= U) set.add(c);
    return [...set];
}

function configsFor(U, nOps) {
    return capsFor(U).map((C) => ({ U, C, nOps, seed: seedFor(U, C) }));
}

function countOf(text, sub) {
    let n = 0;
    let at = text.indexOf(sub);
    while (at !== -1) {
        n++;
        at = text.indexOf(sub, at + sub.length);
    }
    return n;
}

// --- mutants of the real source text ---------------------------------------------

const SHIPPED = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const MUTANTS = {
    MX1: ['if (s >= 0) {\n                lo = mid;\n                hs = s;', 'if (s < 0) {\n                lo = mid;\n                hs = s;'],
    MX2: ['return this._next[lo === 0 ? this._prev[0] : this._tmax[hs]];', 'return this._prev[lo === 0 ? this._prev[0] : this._tmax[hs]];'],
    MX3: ['if (((q0 >>> (w - 1 - lo)) & 1) !== 0) {', 'if (((q0 >>> (w - 1 - lo)) - 2 * (q0 >>> (w - lo))) !== 0) {'],
    MX4: ['if (L > l) occ[s] = 0;', 'if (L > l && L !== w - 4) occ[s] = 0;'],
    MX5: ['if (this._size === this._c) throwFull(this._c);', 'this._size++;\n        if (this._size > this._c) throwFull(this._c);'],
};
const MATCHES = {};
const MSRC = {};
for (const [name, [from, to]] of Object.entries(MUTANTS)) {
    MATCHES[name] = countOf(SHIPPED, from);
    MSRC[name] = MATCHES[name] === 1 ? SHIPPED.replace(from, to) : null;
}

// --- runner (never rejects) --------------------------------------------------------

function runWorker(options, ms, label) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        const t0 = Date.now();
        const w = new Worker(WORKER_URL, { ...options, stdout: true, stderr: true });
        let errText = '';
        w.stdout.resume();
        w.stderr.setEncoding('utf8');
        w.stderr.on('data', (d) => {
            if (errText.length < 4096) errText += d;
        });
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result, ms: Date.now() - t0, error: error === null ? null : error + (errText ? ' | stderr: ' + errText : '') });
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

function fuzzJob(configs, src, label) {
    return runWorker({ workerData: { xftJob: true, job: 'fuzz', src, configs } }, KILL_MS, label);
}

async function expectResult(job) {
    const r = await job;
    assert.equal(r.error, null, String(r.error));
    assert.ok(r.result !== null && typeof r.result === 'object', 'worker posted no result');
    assert.equal(r.result.ok, true, String(r.result.message));
    return { runs: r.result.result, ms: r.ms };
}

function fmt(first) {
    return first === null ? 'none' : JSON.stringify(first);
}

// --- all jobs start now, in parallel ----------------------------------------------

const MAIN = new Map();
for (const U of US) {
    MAIN.set(U, fuzzJob(configsFor(U, U <= 1048576 ? OPS_SMALL : OPS_BIG), null, 'U=' + U));
}
// [mutant, U list, caps]; MX3 only matters at w = 32
const MUT_PLAN = [
    ['MX1', [65536, 4294967296]], ['MX2', [65536, 4294967296]], ['MX3', [4294967296]],
    ['MX4', [65536]], ['MX5', [65536]],
];
const MUT = new Map();
for (const [name, us] of MUT_PLAN) {
    for (const U of us) {
        const configs = [64, 4096].map((C) => ({ U, C, nOps: MUT_OPS, seed: seedFor(U, C) }));
        MUT.set(name + '@' + U, MSRC[name] === null ? null : fuzzJob(configs, MSRC[name], name + '@' + U));
    }
}

function sum(runs, pick) {
    let n = 0;
    for (const r of runs) n += pick(r);
    return n;
}

test('XFastTrieOracle: the universe set covers w = 31 and w = 32 below 2^32 (nit i)', () => {
    const bits = (U) => 32 - Math.clz32(U - 1);
    assert.ok(US.includes(2147483648) && bits(2147483648) === 31);
    assert.ok(US.includes(2147483649) && bits(2147483649) === 32);
    assert.equal(new XFastTrie(2147483649, 1).bits, 32);
    assert.equal(new XFastTrie(2147483648, 1).bits, 31);
    assert.ok(US.filter((U) => bits(U) === 32).length >= 2, 'w = 32 appears at two different U');
});

test('XFastTrieOracle: key 2^31 is exercised by the U = 2^31 + 1 streams (add / has / query)', () => {
    // the same streams the fuzz job replays (configsFor, same seeds); count ops whose key is 2^31
    let hits = 0;
    for (const c of configsFor(2147483649, OPS_BIG)) {
        const st = genStream(c.U, c.C, c.nOps, c.seed);
        const BAD = badKeys(c.U);
        for (let i = 0; i < c.nOps; i++) if (keyAt(st, BAD, i) === 2147483648 && st.op[i] < 5) hits++;
    }
    assert.ok(hits > 0, 'no op used key 2^31 at U = 2^31 + 1: ' + hits);
    console.log('# key 2^31 ops at U=2^31+1: ' + hits);
});

test('XFastTrieOracle: seed', () => {
    console.log('# XFastTrieOracle seed 0x' + BASE_SEED.toString(16));
    assert.ok(Number.isInteger(BASE_SEED));
});

for (const [name, [from]] of Object.entries(MUTANTS)) {
    test('XFastTrieOracle: anchor of ' + name + ' occurs exactly once in LogLogN.js', T, () => {
        assert.equal(MATCHES[name], 1, name + ' anchor ' + JSON.stringify(from) + ' matched ' + MATCHES[name] + ' times');
        assert.notEqual(MSRC[name], SHIPPED);
    });
}

for (const U of US) {
    test('XFastTrieOracle: U=' + U + ' 0 divergences vs 5 oracles, walks and CuckooMap levels', T, async () => {
        const { runs, ms } = await expectResult(MAIN.get(U));
        const caps = capsFor(U);
        assert.deepEqual(runs.map((r) => r.C), caps);
        const nOps = U <= 1048576 ? OPS_SMALL : OPS_BIG;
        let line = '# U=' + U + ' ops/stream=' + nOps + ' caps=' + caps.join(',') + ' wall=' + ms + 'ms';
        // coverage floors (no vacuous pass)
        assert.ok(sum(runs, (r) => r.nOps) === nOps * caps.length);
        for (let o = 0; o < 7; o++) {
            assert.ok(sum(runs, (r) => r.opCounts[o]) > 0, 'no ' + OP_NAMES[o] + ' op at U=' + U);
        }
        assert.ok(sum(runs, (r) => r.absQ) >= 10000, 'absent-key successor / predecessor (_near) < 10000 at U=' + U);
        assert.ok(sum(runs, (r) => r.presQ) >= 10000, 'present-key successor / predecessor < 10000 at U=' + U);
        assert.ok(sum(runs, (r) => r.checkpoints) >= caps.length * Math.floor(nOps / 1024), 'checkpoints');
        assert.ok(sum(runs, (r) => r.levelsChecked) > 0);
        assert.ok(sum(runs, (r) => r.walks.cmp) > 0 && sum(runs, (r) => r.cuckoo.cmp) > 0);
        if (caps.some((c) => c < U)) assert.ok(sum(runs, (r) => r.fullThrows) > 0, 'no full-throw exercised');
        assert.ok(sum(runs, (r) => r.contract.cmp) > 0);
        for (const r of runs) {
            const where = ' (U=' + U + ' C=' + r.C + ')';
            assert.equal(r.contract.div, 0, 'contract' + where + ' ' + fmt(r.contract.first));
            assert.equal(r.walks.div, 0, 'walks' + where + ' ' + fmt(r.walks.first));
            assert.equal(r.cuckoo.div, 0, 'CuckooMap levels' + where + ' ' + fmt(r.cuckoo.first));
            for (const name of ORACLES) {
                const b = r.oracles[name];
                if (name === 'StratifiedBitset' && U > 2 ** 25) {
                    assert.equal(b, null);
                    continue;
                }
                assert.ok(b !== null && b.cmp > 0, name + ' compared 0 times' + where);
                assert.equal(b.div, 0, name + where + ' ' + fmt(b.first));
            }
        }
        for (const name of ORACLES) {
            if (name === 'StratifiedBitset' && U > 2 ** 25) continue;
            line += ' ' + name + '=' + sum(runs, (r) => r.oracles[name].cmp);
        }
        line += ' walks=' + sum(runs, (r) => r.walks.cmp) + ' cuckooCmp=' + sum(runs, (r) => r.cuckoo.cmp) +
            ' cps=' + sum(runs, (r) => r.checkpoints) + ' fullThrows=' + sum(runs, (r) => r.fullThrows);
        console.log(line);
    });
}

test('XFastTrieOracle: CuckooMap level capacity equals min(C, 2^k) sizing (every level, every U)', T, async () => {
    // the cuckoo bucket's 'level<k>.capacity' compares are inside the per-U runs; here
    // only the coverage: at least one checked level per (U, C), w levels each
    let total = 0;
    for (const U of US) {
        const { runs } = await expectResult(MAIN.get(U));
        for (const r of runs) {
            assert.equal(r.w, 32 - Math.clz32(U - 1));
            assert.ok(r.levelsChecked >= r.w * r.checkpoints, 'levels checked per checkpoint');
            total += r.levelsChecked;
        }
    }
    assert.ok(total > 0);
    console.log('# CuckooMap level checks (level-checkpoints): ' + total);
});

// --- must-fail controls --------------------------------------------------------------

async function mutantRuns(name, U) {
    const job = MUT.get(name + '@' + U);
    assert.ok(job !== null && job !== undefined, name + ' mutant not built (anchor mismatch)');
    return (await expectResult(job)).runs;
}

function divOf(runs, name) {
    return sum(runs, (r) => r.oracles[name] === null ? 0 : r.oracles[name].div);
}

for (const name of ['MX1', 'MX2']) {
    for (const U of [65536, 4294967296]) {
        test('XFastTrieOracle: control ' + name + ' diverges from every oracle at U=' + U, T, async () => {
            const runs = await mutantRuns(name, U);
            const parts = [];
            for (const o of ORACLES) {
                if (o === 'StratifiedBitset' && U > 2 ** 25) continue;
                const d = divOf(runs, o);
                parts.push(o + '=' + d);
                assert.ok(d > 0, name + ' did not diverge from ' + o + ' at U=' + U);
            }
            console.log('# ' + name + ' U=' + U + ' divergences: ' + parts.join(' ') + ' walks=' +
                sum(runs, (r) => r.walks.div) + ' cuckoo=' + sum(runs, (r) => r.cuckoo.div));
        });
    }
}

test('XFastTrieOracle: control MX3 (shift by 32 at w = 32) diverges from every oracle at U=2^32', T, async () => {
    const runs = await mutantRuns('MX3', 4294967296);
    const parts = [];
    for (const o of ORACLES) {
        if (o === 'StratifiedBitset') continue;
        const d = divOf(runs, o);
        parts.push(o + '=' + d);
        assert.ok(d > 0, 'MX3 did not diverge from ' + o);
    }
    console.log('# MX3 U=2^32 divergences: ' + parts.join(' '));
});

test('XFastTrieOracle: control MX3 is silent below w = 32 (U=2^16 and U=33 stay clean)', T, async () => {
    // the mutant is the identity for w < 32: a fresh job on small universes
    const r = await expectResult(fuzzJob([
        { U: 65536, C: 64, nOps: 20000, seed: seedFor(65536, 64) },
        { U: 33, C: 33, nOps: 20000, seed: seedFor(33, 33) },
    ], MSRC.MX3, 'MX3-small'));
    for (const run of r.runs) {
        assert.equal(run.contract.div + run.walks.div + run.cuckoo.div, 0, 'MX3 changed behaviour at w=' + run.w);
        for (const o of ORACLES) assert.equal(run.oracles[o].div, 0, o);
    }
});

test('XFastTrieOracle: control MX4 (delete skips a level) is caught by the CuckooMap level cross-check', T, async () => {
    const runs = await mutantRuns('MX4', 65536);
    const ck = sum(runs, (r) => r.cuckoo.div);
    assert.ok(ck > 0, 'MX4 not caught by the per-level CuckooMap check');
    console.log('# MX4 U=2^16 cuckoo divergences=' + ck + ' first=' + fmt(runs[0].cuckoo.first) +
        ' oracle divergences: ' + ORACLES.map((o) => o + '=' + divOf(runs, o)).join(' '));
});

test('XFastTrieOracle: control walk-throw (successor throws during a walk) is counted under walks, not CuckooMap', T, () => {
    // F12: the walk has its own try. In-process subclass whose successor() throws.
    class ThrowingWalk extends XFastTrie {
        successor() { throw new Error('walk boom'); }
    }
    const ok = runXft(XFastTrie, 33, 33, 3000, 0x1234567);
    assert.equal(ok.walks.div + ok.cuckoo.div, 0, 'the shipped class is clean on the same stream');
    const r = runXft(ThrowingWalk, 33, 33, 3000, 0x1234567);
    assert.ok(r.checkpoints > 0 && r.walks.cmp > 0 && r.cuckoo.cmp > 0, 'checkpoints ran');
    assert.ok(r.walks.div > 0, 'a walk throw must be a walks divergence');
    assert.equal(r.walks.first.op, 'walk-threw');
    assert.equal(r.cuckoo.div, 0, 'the walk throw must not leak into the CuckooMap bucket');
});

test('XFastTrieOracle: control MX5 (size bumped before the full check) is caught', T, async () => {
    const runs = await mutantRuns('MX5', 65536);
    assert.ok(sum(runs, (r) => r.fullThrows) > 0, 'stream never hit a full add');
    const c = sum(runs, (r) => r.contract.div);
    assert.ok(c > 0, 'MX5 not caught by the size check');
    for (const o of ORACLES) assert.ok(divOf(runs, o) > 0, 'MX5 did not diverge from ' + o + ' (size)');
    console.log('# MX5 U=2^16 contract divergences=' + c + ' first=' + fmt(runs[0].contract.first));
});

// F8: hand-written rows (spec: set-but-bad seed throws; unset = default; 0x hex allowed).
const BAD_SEEDS = ['abc', '', '1.5', '-1', '4294967296', ' 7', '1e3', 'NaN', '0x', '0x100000000'];
const GOOD_SEEDS = [['0', 0], ['123', 123], ['0x10', 16], ['4294967295', 4294967295], ['0xFFFFFFFF', 4294967295]];
test('XFastTrieOracle: LOGLOGN_SEED parse fails closed (F8)', () => {
    assert.equal(parseSeed(undefined, 0x7c15a3d9), 0x7c15a3d9);
    let threw = 0;
    for (const raw of BAD_SEEDS) {
        assert.throws(() => parseSeed(raw, 0x7c15a3d9), RangeError, 'seed ' + JSON.stringify(raw) + ' must throw');
        threw++;
    }
    let good = 0;
    for (const [raw, want] of GOOD_SEEDS) {
        assert.equal(parseSeed(raw, 0x7c15a3d9), want, 'seed ' + raw);
        good++;
    }
    assert.ok(threw === BAD_SEEDS.length && threw > 0 && good === GOOD_SEEDS.length && good > 0);
    console.log('[seed] bad rows thrown ' + threw + ', good rows accepted ' + good);
    // must-fail control: the old fail-open parse swallows every bad row (these are the
    // rows it silently turned into a seed; "" and "-1" and "1.5" included).
    const old = (raw) => Number(raw) >>> 0;
    let swallowed = 0;
    for (const raw of BAD_SEEDS) {
        assert.doesNotThrow(() => old(raw));
        swallowed++;
    }
    assert.equal(swallowed, BAD_SEEDS.length);
    assert.equal(old('abc'), 0, 'old parse mapped abc to seed 0');
    // wiring: every env read in test/ goes through parseSeed (fail-open reverts are caught)
    const ENV = 'process.env.' + 'LOGLOGN_SEED';
    const dir = new URL('.', import.meta.url);
    let wired = 0;
    for (const f of readdirSync(dir)) {
        if (!/\.m?js$/.test(f)) continue;
        const s = readFileSync(new URL(f, dir), 'utf8');
        const n = s.split(ENV).length - 1, ok = s.split('parseSeed(' + ENV + ', ').length - 1;
        assert.equal(n, ok, f);
        wired += ok;
    }
    assert.equal(wired, 5, 'five parseSeed consumers');
});
