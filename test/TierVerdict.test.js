// TierVerdict.test.js -- tier: DETERMINISTIC (runs in npm test; no timing; spawns only `git show`).
// This is the injected-vector half of A12: the pure tierVerdict / tierASource contracts of
// test/witness.mjs on hand-built inputs. The timed half is the `--tier` FULL run under quiet-lock.
// Expected values come from .handoff/BSTAT-SPEC.md (ASSERTIONS Base T, T1-T13), never from
// running the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// T13 first: a fresh evaluation via a cache-busting query, before any other use of the module.
test('T13 import has no side effects (no output, exitCode unchanged)', async () => {
    const before = process.exitCode;
    const origWrite = process.stdout.write;
    const origErrWrite = process.stderr.write;
    let written = 0;
    process.stdout.write = function (chunk) { written += String(chunk).length; return true; };
    process.stderr.write = function (chunk) { written += String(chunk).length; return true; };
    try {
        await import('./witness.mjs?t13');
    } finally {
        process.stdout.write = origWrite;
        process.stderr.write = origErrWrite;
    }
    assert.equal(written, 0, 'importing witness.mjs must print nothing');
    assert.equal(process.exitCode, before, 'importing witness.mjs must not set exitCode');
});

const W = await import('./witness.mjs');
const { tierVerdict, tierASource, TIER_SCENARIOS, TIER_B1A_REV, TIER_B1A_BLOB, TIER_A_SHA256 } = W;

const PKG = new URL('..', import.meta.url);
const PFX = '[lite-loglogn] tierVerdict';
const isBad = (e) => (e instanceof TypeError || e instanceof RangeError) && e.message.startsWith(PFX);
const NAMES = ['dense-succ', 'sparse-succ', 'dense-pred', 'sparse-pred'];

function base() {
    return {
        K: 15, need: 13,
        scenarios: NAMES.map((name) => ({ name, wins: 15, losses: 0 })),
        aa: { wins: 7, losses: 8 },
        aaSparse: { wins: 7, losses: 8 },
        control: { wins: 0, losses: 15 },
        drift: false, load1: 1, cores: 12,
    };
}
const setSc = (i, name, wins, losses) => { i.scenarios[NAMES.indexOf(name)] = { name, wins, losses }; };
const hasReason = (r, p) => r.reasons.some((s) => s.startsWith(p));

test('Base T: all win -> exit 0 KEEP, 4 x win', () => {
    const r = tierVerdict(base());
    assert.equal(r.exit, 0);
    assert.equal(r.decision, 'KEEP');
    assert.deepEqual(r.verdicts, ['win', 'win', 'win', 'win']);
});

test('T1 dense-succ 12/0 (none), rest win -> 0 DROP', () => {
    const i = base(); setSc(i, 'dense-succ', 12, 0);
    const r = tierVerdict(i);
    assert.equal(r.exit, 0);
    assert.equal(r.decision, 'DROP');
    assert.equal(r.verdicts[0], 'none');
    assert.ok(hasReason(r, 'keep:'));
});

test('T2 a lose in sparse-pred or dense-pred -> 0 DROP', () => {
    for (const name of ['sparse-pred', 'dense-pred']) {
        const i = base(); setSc(i, name, 0, 13);
        const r = tierVerdict(i);
        assert.equal(r.exit, 0, name);
        assert.equal(r.decision, 'DROP', name);
        assert.equal(r.verdicts[NAMES.indexOf(name)], 'lose', name);
    }
});

test('T3 dense-succ win, other three none -> 0 KEEP', () => {
    const i = base();
    for (const n of NAMES.slice(1)) setSc(i, n, 6, 6);
    const r = tierVerdict(i);
    assert.equal(r.exit, 0);
    assert.equal(r.decision, 'KEEP');
    assert.deepEqual(r.verdicts, ['win', 'none', 'none', 'none']);
});

test('T4 dense-succ boundary: 13/2 KEEP, 12/3 DROP', () => {
    const a = base(); setSc(a, 'dense-succ', 13, 2);
    assert.equal(tierVerdict(a).decision, 'KEEP');
    const b = base(); setSc(b, 'dense-succ', 12, 3);
    assert.equal(tierVerdict(b).decision, 'DROP');
});

test('T5 A/A winner -> 2 PENDING; drift -> 2; load boundary', () => {
    for (const aa of [{ wins: 13, losses: 2 }, { wins: 2, losses: 13 }]) {
        const i = base(); i.aa = aa;
        const r = tierVerdict(i);
        assert.equal(r.exit, 2);
        assert.equal(r.decision, 'PENDING');
        assert.ok(hasReason(r, 'aa:'));
    }
    const d = base(); d.drift = true;
    const rd = tierVerdict(d);
    assert.equal(rd.exit, 2); assert.equal(rd.decision, 'PENDING'); assert.ok(hasReason(rd, 'drift:'));
    const l = base(); l.load1 = 6.01;
    const rl = tierVerdict(l);
    assert.equal(rl.exit, 2); assert.ok(hasReason(rl, 'load:'));
    const e = base(); e.load1 = 6;
    assert.equal(tierVerdict(e).exit, 0);
});

test('T5b sparse A/A winner -> 2 PENDING; 12/3 -> 0 KEEP', () => {
    for (const aaSparse of [{ wins: 13, losses: 2 }, { wins: 2, losses: 13 }]) {
        const i = base(); i.aaSparse = aaSparse;
        const r = tierVerdict(i);
        assert.equal(r.exit, 2);
        assert.equal(r.decision, 'PENDING');
        assert.ok(hasReason(r, 'aa:'));
    }
    const q = base(); q.aaSparse = { wins: 12, losses: 3 };
    const rq = tierVerdict(q);
    assert.equal(rq.exit, 0);
    assert.equal(rq.decision, 'KEEP');
});

test('T6 control not losing -> 1 FAIL; PENDING outranks FAIL', () => {
    for (const control of [{ wins: 0, losses: 12 }, { wins: 15, losses: 0 }]) {
        const i = base(); i.control = control;
        const r = tierVerdict(i);
        assert.equal(r.exit, 1);
        assert.equal(r.decision, 'FAIL');
        assert.ok(hasReason(r, 'control:'));
    }
    const i = base(); i.drift = true; i.control = { wins: 15, losses: 0 };
    const r = tierVerdict(i);
    assert.equal(r.exit, 2);
    assert.equal(r.decision, 'PENDING');
    assert.ok(hasReason(r, 'drift:') && hasReason(r, 'control:'), 'reasons list ALL');
});

test('T7 a losing scenario with dense-succ win -> DROP, never KEEP', () => {
    for (const name of NAMES.slice(1)) {
        const i = base(); setSc(i, name, 1, 14);
        const r = tierVerdict(i);
        assert.equal(r.decision, 'DROP', name);
        assert.equal(r.exit, 0, name);
    }
});

test('T8 malformed input throws with the tierVerdict prefix', () => {
    const cases = {
        '3 scenarios': (i) => { i.scenarios.pop(); },
        '5 scenarios': (i) => { i.scenarios.push({ name: 'dense-succ', wins: 15, losses: 0 }); },
        'names swapped': (i) => { [i.scenarios[0], i.scenarios[1]] = [i.scenarios[1], i.scenarios[0]]; },
        'unknown name': (i) => { i.scenarios[2].name = 'bogus'; },
        'wins+losses 16': (i) => { i.scenarios[1] = { name: 'sparse-succ', wins: 8, losses: 8 }; },
        'wins 1.5': (i) => { i.scenarios[1] = { name: 'sparse-succ', wins: 1.5, losses: 0 }; },
        'need 7 with K 15': (i) => { i.need = 7; },
        'K 14 need 7': (i) => { i.K = 14; i.need = 7; },
        "drift 'false'": (i) => { i.drift = 'false'; },
        'load1 NaN': (i) => { i.load1 = NaN; },
        'cores 0': (i) => { i.cores = 0; },
        'missing control': (i) => { delete i.control; },
        'missing aa': (i) => { delete i.aa; },
        'missing aaSparse': (i) => { delete i.aaSparse; },
        'aaSparse wins+losses 16': (i) => { i.aaSparse = { wins: 8, losses: 8 }; },
    };
    for (const [label, mutate] of Object.entries(cases)) {
        const i = base(); mutate(i);
        assert.throws(() => tierVerdict(i), isBad, label);
    }
});

test('T8b witnessVerdict keeps its own prefix after the shared-validator refactor', () => {
    const pv = (e) => e instanceof TypeError && e.message.startsWith('[lite-loglogn] witnessVerdict: ');
    assert.throws(() => W.witnessVerdict(null), pv);
    assert.throws(() => W.witnessVerdict({ K: 15, need: 13, nSweep: [null] }), pv);
});

test('T9 purity: deterministic and input unchanged', () => {
    const i = base(); setSc(i, 'sparse-succ', 3, 12);
    const snap = structuredClone(i);
    const a = tierVerdict(i);
    const b = tierVerdict(i);
    assert.deepEqual(a, b);
    assert.deepEqual(i, snap);
});

test('T10 TIER_SCENARIOS order and names', () => {
    assert.deepEqual([...TIER_SCENARIOS], NAMES);
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
function b1aText() {
    return execFileSync('git', ['show', TIER_B1A_REV + ':LogLogN.js'], { cwd: PKG, encoding: 'utf8' });
}
function gitBlobId(bytes) {
    return createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
}

test('T11 tierASource: exactly 3 lines change, pins hold', () => {
    const src = b1aText();
    assert.equal(gitBlobId(Buffer.from(src, 'utf8')), TIER_B1A_BLOB);
    const out = tierASource(src);
    const a = src.split('\n'), b = out.split('\n');
    assert.equal(b.length, a.length);
    const live = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8').split('\n');
    let changed = 0;
    for (let k = 0; k < a.length; k++) {
        if (a[k] === b[k]) continue;
        changed++;
        assert.equal(b[k], a[k].replace(';', ' | 0;'), 'line ' + (k + 1));
        assert.ok(live.includes(b[k]), 'live source has verbatim: ' + b[k]);
    }
    assert.equal(changed, 3);
    assert.equal(sha256(out), TIER_A_SHA256);
});

test('T12 tierASource fails closed', () => {
    const src = b1aText();
    const lines = src.split('\n');
    const find = (p, from = 0) => { for (let k = from; k < lines.length; k++) if (lines[k].startsWith(p)) return k; return -1; };
    const isTA = (e) => e instanceof Error && e.message.startsWith('[lite-loglogn] tierASource');

    // remove the max-top line inside max()
    const m0 = find('    max() {'), m1 = find('    clear() {', m0);
    assert.ok(m0 >= 0 && m1 > m0);
    let top = -1;
    for (let k = m0; k < m1; k++) if (lines[k] === '        let v = b[o[L]];') { top = k; break; }
    assert.ok(top > 0, 'max-top line located');
    const noTop = lines.slice(0, top).concat(lines.slice(top + 1)).join('\n');
    assert.throws(() => tierASource(noTop), isTA);

    // duplicate the predecessor descend line inside predecessor()
    const p0 = find('    predecessor(x) {'), p1 = find('    min() {', p0);
    assert.ok(p0 >= 0 && p1 > p0);
    let dn = -1;
    for (let k = p0; k < p1; k++) if (lines[k] === '            v = b[o[L] + i];') { dn = k; break; }
    assert.ok(dn > 0, 'predecessor descend line located');
    const dup = lines.slice(0, dn + 1).concat([lines[dn]], lines.slice(dn + 1)).join('\n');
    assert.throws(() => tierASource(dup), isTA);

    assert.throws(() => tierASource(''), isTA);
});

test('T12b tierASource fails closed on a duplicated method signature', () => { const lines = b1aText().split('\n'); const mm = lines.indexOf('    max() {'); assert.ok(mm > 0); const sigDup = lines.slice(0, mm).concat(['    max() {', '    }'], lines.slice(mm)).join('\n'); assert.throws(() => tierASource(sigDup), (e) => e instanceof Error && e.message.startsWith('[lite-loglogn] tierASource')); });
