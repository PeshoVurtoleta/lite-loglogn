// AbVerdict.test.js -- tier: DETERMINISTIC (no timing, no processes).
// PLAN-xfasttrie G2 / G8, ADDENDUM A4 / A5. Expected values come from the spec text, never from
// running the implementation. The A12 dense A/A vector: wins 1, losses 14, medians ratio 3.64 / 3.60.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abVerdict, AB_EFFECT_FLOOR } from './helpers/abVerdict.mjs';
import { tierVerdict, TIER_SCENARIOS } from './witness.mjs';

const PFX = '[lite-loglogn] abVerdict';
const isBad = (e) => (e instanceof TypeError || e instanceof RangeError) && e.message.startsWith(PFX);
const sc = (name, wins, losses, ratio) => ({ name, wins, losses, ratio });

function base() {
    return {
        K: 15, need: 13, floor: 0.02,
        scenarios: [sc('s', 15, 0, 0.9)],
        aa: [sc('aa', 7, 8, 1.0)],
        control: { wins: 0, losses: 15, ratio: 1.5 },
        drift: false, load1: 1, cores: 12,
    };
}
const A12_RATIO = 3.64 / 3.60;

test('AB_EFFECT_FLOOR is 0.02', () => { assert.equal(AB_EFFECT_FLOOR, 0.02); });

test('base: win, PASS, exit 0', () => {
    const r = abVerdict(base());
    assert.equal(r.exit, 0);
    assert.equal(r.decision, 'PASS');
    assert.deepEqual(r.verdicts, [{ name: 's', verdict: 'win' }]);
    assert.deepEqual(r.reasons, []);
});

test('G8 A12 dense A/A (1/14, ratio 3.64/3.60) is NOT flagged at floor 0.02', () => {
    const i = base(); i.aa = [sc('dense-succ', 1, 14, A12_RATIO)];
    assert.ok(Math.abs(A12_RATIO - 1) < 0.02);   // 0.0111, by hand
    const r = abVerdict(i);
    assert.equal(r.exit, 0);
    assert.equal(r.decision, 'PASS');
});

test('G8 must-fail: the same vector at floor 0 IS flagged (exit 2)', () => {
    const i = base(); i.floor = 0; i.aa = [sc('dense-succ', 1, 14, A12_RATIO)];
    const r = abVerdict(i);
    assert.equal(r.exit, 2);
    assert.equal(r.decision, 'PENDING');
    assert.ok(r.reasons.some((s) => s.startsWith('aa:')));
});

test('G8 A5: tierVerdict on the equivalent tallies still exits 2', () => {
    const t = {
        K: 15, need: 13,
        scenarios: TIER_SCENARIOS.map((name) => ({ name, wins: 15, losses: 0 })),
        aa: { wins: 1, losses: 14 },
        aaSparse: { wins: 7, losses: 8 },
        control: { wins: 0, losses: 15 },
        drift: false, load1: 1, cores: 12,
    };
    assert.equal(tierVerdict(t).exit, 2);
});

test('G8 15/0: ratio 0.985 -> none, 0.97 -> win', () => {
    const a = base(); a.scenarios = [sc('s', 15, 0, 0.985)];
    assert.equal(abVerdict(a).verdicts[0].verdict, 'none');
    const b = base(); b.scenarios = [sc('s', 15, 0, 0.97)];
    assert.equal(abVerdict(b).verdicts[0].verdict, 'win');
});

test('G8 mirrored: 0/15 at ratio 1.015 -> none, 1.03 -> lose', () => {
    const a = base(); a.scenarios = [sc('s', 0, 15, 1.015)];
    assert.equal(abVerdict(a).verdicts[0].verdict, 'none');
    const b = base(); b.scenarios = [sc('s', 0, 15, 1.03)];
    assert.equal(abVerdict(b).verdicts[0].verdict, 'lose');
});

test('wins below need is none even with a big effect', () => {
    const i = base(); i.scenarios = [sc('s', 12, 0, 0.5)];
    assert.equal(abVerdict(i).verdicts[0].verdict, 'none');
});

test('G8 ratio 1.02 / 0.98 flag at floor 0.02 (binary doubles: 1.02 - 1 and 1 - 0.98 exceed 0.02)', () => {
    for (const rt of [1.02, 0.98]) {
        const i = base(); i.aa = [sc('aa', 13, 2, rt)];
        assert.equal(abVerdict(i).exit, 2, 'ratio ' + rt);
    }
    const w = base(); w.scenarios = [sc('s', 15, 0, 0.98)];
    assert.equal(abVerdict(w).verdicts[0].verdict, 'win');
    const l = base(); l.scenarios = [sc('s', 0, 15, 1.02)];
    assert.equal(abVerdict(l).verdicts[0].verdict, 'lose');
});

test('A/A with need reached by losses (mirrored) and big effect flags; below need does not', () => {
    const a = base(); a.aa = [sc('aa', 0, 13, 1.5)];
    assert.equal(abVerdict(a).exit, 2);
    const b = base(); b.aa = [sc('aa', 0, 12, 1.5)];
    assert.equal(abVerdict(b).exit, 0);
});

test('any one of several A/A entries flags', () => {
    const i = base(); i.aa = [sc('a1', 7, 8, 1.0), sc('a2', 14, 1, 0.5)];
    assert.equal(abVerdict(i).exit, 2);
});

test('control not losing -> exit 1 FAIL', () => {
    const i = base(); i.control = { wins: 8, losses: 7, ratio: 1.5 };
    const r = abVerdict(i);
    assert.equal(r.exit, 1);
    assert.equal(r.decision, 'FAIL');
});

test('control losing but below the floor -> exit 1', () => {
    const i = base(); i.control = { wins: 0, losses: 15, ratio: 1.01 };
    assert.equal(abVerdict(i).exit, 1);
});

test('load / drift -> exit 2; load at exactly 0.5 x cores is fine', () => {
    const a = base(); a.load1 = 6.5;
    assert.equal(abVerdict(a).exit, 2);
    const b = base(); b.drift = true;
    assert.equal(abVerdict(b).exit, 2);
    const c = base(); c.load1 = 6;
    assert.equal(abVerdict(c).exit, 0);
});

test('precedence: exit 2 wins over exit 1; reasons list all', () => {
    const i = base(); i.drift = true; i.control = { wins: 8, losses: 7, ratio: 1.5 };
    const r = abVerdict(i);
    assert.equal(r.exit, 2);
    assert.ok(r.reasons.some((s) => s.startsWith('drift:')));
    assert.ok(r.reasons.some((s) => s.startsWith('control:')));
});

test('validation errors throw with the prefix', () => {
    const bad = (mut, label) => {
        const i = base(); mut(i);
        assert.throws(() => abVerdict(i), isBad, label);
    };
    bad((i) => { i.scenarios[0].ratio = NaN; }, 'NaN ratio');
    bad((i) => { i.scenarios[0].ratio = Infinity; }, 'Infinity ratio');
    bad((i) => { i.scenarios[0].ratio = 0; }, 'zero ratio');
    bad((i) => { i.scenarios[0].ratio = -1; }, 'negative ratio');
    bad((i) => { i.aa[0].ratio = 0; }, 'aa zero ratio');
    bad((i) => { i.control.ratio = NaN; }, 'control NaN ratio');
    bad((i) => { i.floor = 0.5; }, 'floor 0.5');
    bad((i) => { i.floor = -0.01; }, 'negative floor');
    bad((i) => { i.floor = NaN; }, 'NaN floor');
    bad((i) => { i.need = 7; }, 'need = floor(K/2)');
    bad((i) => { i.need = 16; }, 'need > K');
    bad((i) => { i.scenarios[0].wins = 10; i.scenarios[0].losses = 6; }, 'wins + losses > K');
    bad((i) => { i.control.wins = 10; i.control.losses = 6; }, 'control wins + losses > K');
    bad((i) => { i.extra = 1; }, 'unknown top key');
    bad((i) => { i.scenarios[0].extra = 1; }, 'unknown scenario key');
    bad((i) => { i.control.name = 'c'; }, 'unknown control key');
    bad((i) => { delete i.floor; }, 'missing key');
    bad((i) => { i.scenarios = []; }, 'empty scenarios');
    bad((i) => { i.drift = 0; }, 'non-boolean drift');
    bad((i) => { i.load1 = -1; }, 'negative load');
    bad((i) => { i.cores = 0; }, 'zero cores');
    assert.throws(() => abVerdict(null), isBad);
    assert.throws(() => abVerdict([]), isBad);
});

test('inherited keys are rejected (Object.create)', () => {
    const i = base();
    const proto = { ...i };
    assert.throws(() => abVerdict(Object.create(proto)), isBad);
    const j = base();
    const inheritedFloor = Object.create({ floor: 0.02 });
    for (const k of Object.keys(j)) if (k !== 'floor') inheritedFloor[k] = j[k];
    assert.throws(() => abVerdict(inheritedFloor), isBad);
    const k2 = base();
    k2.scenarios[0] = Object.create({ ...sc('s', 15, 0, 0.9) });
    assert.throws(() => abVerdict(k2), isBad);
});

const bx = () => { const i = base(); i.floor = 0.25; i.control = { wins: 0, losses: 15, ratio: 1.25 }; return i; };
test('>= at an exact binary boundary (floor 0.25; 1.25 - 1 and 1 - 0.75 are exact)', () => {
    const a = bx(); a.aa = [sc('aa', 13, 2, 1.25)];
    assert.equal(abVerdict(a).exit, 2);
    const b = bx(); b.scenarios = [sc('s', 15, 0, 0.75)];
    const rb = abVerdict(b);
    assert.equal(rb.verdicts[0].verdict, 'win');
    assert.equal(rb.exit, 0, 'control at exactly the floor still loses');
    const c = bx(); c.scenarios = [sc('s', 0, 15, 1.25)];
    assert.equal(abVerdict(c).verdicts[0].verdict, 'lose');
});

test('precedence: an A/A flag (exit 2) wins over a toothless control (exit 1)', () => {
    const i = base(); i.aa = [sc('aa', 0, 13, 1.5)]; i.control = { wins: 8, losses: 7, ratio: 1.5 };
    const r = abVerdict(i);
    assert.equal(r.exit, 2);
    assert.ok(r.reasons.some((s) => s.startsWith('aa:')));
    assert.ok(r.reasons.some((s) => s.startsWith('control:')));
});
