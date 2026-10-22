// WitnessVerdict.test.js -- tier: DETERMINISTIC (runs in npm test; no timing, no spawn).
// This is the injected-vector half of A8: the pure verdict / drift / width / foil
// contracts of test/witness.mjs, checked on hand-built inputs. The timed half
// (real ABBA rounds on a quiet host) is B-stat. Expected values come from
// .handoff/B2B-SPEC.md (ASSERTIONS V1-V16), never from running the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from './helpers/tierStream.mjs';

// V15 first: a fresh evaluation via a cache-busting query, before the static import below
// is observed by any other test (static imports are hoisted, so the cache-bust is what
// forces a second, fresh evaluation of the module body).
test('V15 import has no side effects (no output, exitCode unchanged)', async () => {
    const before = process.exitCode;
    const origWrite = process.stdout.write;
    const origErrWrite = process.stderr.write;
    let written = 0;
    process.stdout.write = function (chunk) { written += String(chunk).length; return true; };
    process.stderr.write = function (chunk) { written += String(chunk).length; return true; };
    try {
        await import('./witness.mjs?v15');
    } finally {
        process.stdout.write = origWrite;
        process.stderr.write = origErrWrite;
    }
    assert.equal(written, 0, 'importing witness.mjs must print nothing');
    assert.equal(process.exitCode, before, 'importing witness.mjs must not set exitCode');
});

const W = await import('./witness.mjs');
const { witnessVerdict, hostDrift, witnessWidths, WITNESS_W, WITNESS_K, WITNESS_NEED,
    NaiveFlatBitset, u32Successor } = W;

const PFX_V = /^\[lite-loglogn\] witnessVerdict/;
const PFX_D = /^\[lite-loglogn\] hostDrift/;
const badInput = (re) => (e) => (e instanceof TypeError || e instanceof RangeError) && re.test(e.message);

function base() {
    return {
        K: 15, need: 13,
        nSweep: [{ x: 1e3, wins: 0, losses: 15 }, { x: 1e4, wins: 13, losses: 0 }, { x: 1e5, wins: 15, losses: 0 }],
        uSweep: [],
        aa: { wins: 7, losses: 8 },
        control: { wins: 0, losses: 15 },
        drift: false, load1: 1, cores: 12,
    };
}
const pt = (x, wins, losses) => ({ x, wins, losses });
const hasReason = (r, p) => r.reasons.some((s) => s.startsWith(p));

test('constants: K 15, need 13, W [16,20,24,28]', () => {
    assert.equal(WITNESS_K, 15);
    assert.equal(WITNESS_NEED, 13);
    assert.deepEqual([...WITNESS_W], [16, 20, 24, 28]);
});

test('base input -> exit 0, verdicts lose/win/win, crossover 1e4', () => {
    const r = witnessVerdict(base());
    assert.equal(r.exit, 0);
    assert.deepEqual(r.n.verdicts, ['lose', 'win', 'win']);
    assert.equal(r.n.crossover, 1e4);
    assert.deepEqual(r.u.verdicts, []);
    assert.equal(r.u.crossover, null);
});

test('V1 13/15 -> win', () => {
    const i = base(); i.nSweep[1] = pt(1e4, 13, 2);
    assert.equal(witnessVerdict(i).n.verdicts[1], 'win');
});

test('V2 12/15 -> none', () => {
    for (const [w, l] of [[12, 3], [12, 0]]) {
        const i = base(); i.nSweep[1] = pt(1e4, w, l);
        assert.equal(witnessVerdict(i).n.verdicts[1], 'none', `${w}/${l}`);
    }
});

test('V3 losses 13 -> lose; losses 12 -> none', () => {
    const a = base(); a.nSweep[0] = pt(1e3, 2, 13);
    assert.equal(witnessVerdict(a).n.verdicts[0], 'lose');
    const b = base(); b.nSweep[0] = pt(1e3, 3, 12);
    assert.equal(witnessVerdict(b).n.verdicts[0], 'none');
});

test('V4 A/A winner -> exit 2', () => {
    for (const aa of [{ wins: 13, losses: 2 }, { wins: 0, losses: 13 }]) {
        const i = base(); i.aa = aa;
        const r = witnessVerdict(i);
        assert.equal(r.exit, 2, JSON.stringify(aa));
        assert.equal(r.reasons.filter((s) => s.startsWith('aa:')).length, 1);
    }
    const ok = base(); ok.aa = { wins: 12, losses: 3 };
    assert.equal(witnessVerdict(ok).exit, 0);
});

test('V5 control not failing -> exit 1', () => {
    for (const c of [{ wins: 0, losses: 12 }, { wins: 15, losses: 0 }]) {
        const i = base(); i.control = c;
        const r = witnessVerdict(i);
        assert.equal(r.exit, 1, JSON.stringify(c));
        assert.ok(hasReason(r, 'control:'));
    }
    const ok = base(); ok.control = { wins: 0, losses: 13 };
    assert.equal(witnessVerdict(ok).exit, 0);
});

test('V6 drift true -> exit 2 (reason drift:)', () => {
    const i = base(); i.drift = true;
    const r = witnessVerdict(i);
    assert.equal(r.exit, 2);
    assert.ok(hasReason(r, 'drift:'));
});

test('V7 load boundary is strict', () => {
    const a = base(); a.load1 = 6.01; a.cores = 12;
    const ra = witnessVerdict(a);
    assert.equal(ra.exit, 2);
    assert.ok(hasReason(ra, 'load:'));
    const b = base(); b.load1 = 6; b.cores = 12;
    assert.equal(witnessVerdict(b).exit, 0);
});

test('V8 precedence: host-validity outranks control', () => {
    const a = base(); a.drift = true; a.control = { wins: 0, losses: 12 };
    const ra = witnessVerdict(a);
    assert.equal(ra.exit, 2);
    assert.ok(hasReason(ra, 'drift:') && hasReason(ra, 'control:'));
    const b = base(); b.aa = { wins: 13, losses: 2 }; b.control = { wins: 0, losses: 12 };
    const rb = witnessVerdict(b);
    assert.equal(rb.exit, 2);
    assert.ok(hasReason(rb, 'aa:') && hasReason(rb, 'control:'));
});

test('V9 non-monotone sweeps', () => {
    const a = base(); a.nSweep = [pt(1e3, 13, 0), pt(1e4, 0, 13)];
    const ra = witnessVerdict(a);
    assert.equal(ra.exit, 2);
    assert.ok(hasReason(ra, 'monotone:'));
    const b = base(); b.nSweep = [pt(1e3, 13, 0), pt(1e4, 5, 5), pt(1e5, 14, 0)];
    const rb = witnessVerdict(b);
    assert.equal(rb.exit, 0);
    assert.deepEqual(rb.n.verdicts, ['win', 'none', 'win']);
    assert.equal(rb.n.crossover, 1e5);
    const c = base(); c.uSweep = [pt(16, 13, 0), pt(20, 0, 14)];
    const rc = witnessVerdict(c);
    assert.equal(rc.exit, 2);
    assert.ok(hasReason(rc, 'monotone:'));
});

test('V10 crossover null when last point is none or lose', () => {
    const a = base(); a.nSweep = [pt(1e3, 13, 0), pt(1e4, 6, 6)];
    const ra = witnessVerdict(a);
    assert.equal(ra.exit, 0);
    assert.equal(ra.n.crossover, null);
    const b = base(); b.nSweep = [pt(1e3, 0, 13), pt(1e4, 0, 14)];
    const rb = witnessVerdict(b);
    assert.equal(rb.exit, 0);
    assert.equal(rb.n.crossover, null);
});

test('V11 malformed input throws', () => {
    const cases = {
        'wins+losses=16': (i) => { i.nSweep[1] = pt(1e4, 8, 8); },
        'wins 1.5': (i) => { i.nSweep[1] = pt(1e4, 1.5, 0); },
        'wins -1': (i) => { i.nSweep[1] = pt(1e4, -1, 0); },
        'wins NaN': (i) => { i.nSweep[1] = pt(1e4, NaN, 0); },
        'need 7 with K 15': (i) => { i.need = 7; },
        'need 16': (i) => { i.need = 16; },
        'K 0': (i) => { i.K = 0; },
        'nSweep empty': (i) => { i.nSweep = []; },
        'drift "false"': (i) => { i.drift = 'false'; },
        'load1 NaN': (i) => { i.load1 = NaN; },
        'cores 0': (i) => { i.cores = 0; },
        'non-ascending x': (i) => { i.nSweep[1] = pt(1e3, 13, 0); },
        'missing aa': (i) => { delete i.aa; },
    };
    for (const [name, mut] of Object.entries(cases)) {
        const i = base(); mut(i);
        assert.throws(() => witnessVerdict(i), badInput(PFX_V), name);
    }
});

test('V12 purity: deterministic and non-mutating', () => {
    const i = base(); i.uSweep = [pt(16, 13, 0), pt(20, 14, 1)];
    const snap = structuredClone(i);
    const r1 = witnessVerdict(i);
    const r2 = witnessVerdict(i);
    assert.deepEqual(r1, r2);
    assert.deepEqual(i, snap);
});

test('V17 precedence load/monotone vs control, all-win crossover, K-even need, uSweep/control validation', () => {
    const a = base(); a.load1 = 6.01; a.control = { wins: 0, losses: 12 };
    const ra = witnessVerdict(a);
    assert.equal(ra.exit, 2);
    assert.ok(hasReason(ra, 'load:') && hasReason(ra, 'control:'));
    const b = base(); b.nSweep = [pt(1e3, 13, 0), pt(1e4, 0, 13)]; b.control = { wins: 0, losses: 12 };
    const rb = witnessVerdict(b);
    assert.equal(rb.exit, 1);
    assert.ok(hasReason(rb, 'control:') && hasReason(rb, 'monotone:'));
    const c = base(); c.nSweep = [pt(1e3, 13, 0), pt(1e4, 15, 0)]; c.uSweep = [pt(16, 14, 0), pt(20, 13, 1)];
    const rc = witnessVerdict(c);
    assert.equal(rc.n.crossover, 1e3);
    assert.equal(rc.u.crossover, 16);
    const d = base(); d.K = 14; d.need = 7;
    d.nSweep = [pt(1e3, 0, 7)]; d.aa = { wins: 7, losses: 7 }; d.control = { wins: 0, losses: 14 };
    assert.throws(() => witnessVerdict(d), badInput(PFX_V), 'need 7 with K 14');
    const bad = {
        'uSweep wins 1.5': (i) => { i.uSweep = [pt(16, 1.5, 0)]; },
        'uSweep wins+losses=16': (i) => { i.uSweep = [pt(16, 8, 8)]; },
        'uSweep non-ascending x': (i) => { i.uSweep = [pt(20, 0, 0), pt(16, 0, 0)]; },
        'missing uSweep': (i) => { delete i.uSweep; },
        'missing control': (i) => { delete i.control; },
        'control wins+losses=16': (i) => { i.control = { wins: 1, losses: 15 }; },
    };
    for (const [name, mut] of Object.entries(bad)) {
        const i = base(); mut(i);
        assert.throws(() => witnessVerdict(i), badInput(PFX_V), name);
    }
});

// Calibration vectors per spec: r_i = mulberry32(0xC0FFEE) draws, 135 values.
function flat() {
    const rnd = mulberry32(0xC0FFEE);
    const v = new Array(135);
    for (let i = 0; i < 135; i++) v[i] = 100 * (1 + 0.03 * (2 * rnd() - 1));
    return v;
}
function stepped(f) { const v = flat(); for (let i = 60; i < 135; i++) v[i] *= f; return v; }

test('V13 hostDrift calibration vectors and validation', () => {
    assert.deepEqual(hostDrift(flat()), { drift: false, index: -1 });
    const up = hostDrift(stepped(1.25));
    assert.equal(up.drift, true);
    assert.ok(up.index >= 60 && up.index < 135, 'index ' + up.index);
    assert.equal(hostDrift(stepped(0.8)).drift, true);
    const sp = flat(); sp[30] = 400; sp[90] = 400;
    assert.deepEqual(hostDrift(sp), { drift: false, index: -1 }, 'SPIKES');
    assert.throws(() => hostDrift(flat().slice(0, 7)), badInput(PFX_D));
    for (const bad of [0, -5, NaN]) {
        const s = flat(); s[10] = bad;
        assert.throws(() => hostDrift(s), badInput(PFX_D), String(bad));
    }
});

test('V14 witnessWidths', () => {
    assert.deepEqual(witnessWidths([], {}), [16, 20, 24, 28]);
    assert.deepEqual(witnessWidths(['--w32'], {}), [16, 20, 24, 28, 32]);
    assert.deepEqual(witnessWidths([], { LOGLOGN_W32: '1' }), [16, 20, 24, 28, 32]);
    assert.deepEqual(witnessWidths([], { LOGLOGN_W32: 'true' }), [16, 20, 24, 28]);
    const a = witnessWidths([], {});
    assert.notEqual(a, WITNESS_W);
    a.push(99); a[0] = 1;
    assert.deepEqual([...WITNESS_W], [16, 20, 24, 28]);
});

test('V16 foils agree with a brute-force strict successor', () => {
    const keys = [0, 1, 31, 32, 33, 500, 1023];
    const naive = new NaiveFlatBitset(1024);
    for (const k of keys) naive.add(k);
    const arr = Uint32Array.from(keys);
    for (let x = 0; x < 1024; x++) {
        let want = -1;
        for (const k of keys) if (k > x) { want = k; break; }
        assert.equal(u32Successor(arr, keys.length, x), want, 'u32 x=' + x);
        assert.equal(naive.successor(x), want === -1 ? undefined : want, 'naive x=' + x);
    }
});
