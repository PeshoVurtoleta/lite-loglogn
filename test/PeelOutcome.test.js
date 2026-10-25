/**
 * @zakkster/lite-loglogn -- level-0 PEEL OUTCOME coverage gate (F5b,
 * DETERMINISTIC).
 *
 * StratifiedBitset.successor / predecessor open with a level-0 peel that ends in
 * one of three ways:
 *   FOUND -- the answer lies in x's own level-0 word (the peel returns it);
 *   PAST  -- no answer in that word and no level-0 word lies beyond it in the
 *            search direction (or x sits on the universe edge): returns undefined;
 *   FALL  -- no answer in that word but more words remain: falls to the climb.
 * This file replays the seeded tier stream (test/helpers/tierStream.mjs, imported,
 * not copied) at several universes and CLASSIFIES every valid successor /
 * predecessor query from a sorted-array model of the stream's own key set plus
 * word arithmetic (word = key >>> 5; nWords = ceil(U / 32)); it never reads the
 * engine's internals. For every classified query the engine's answer must equal
 * the model's. Coverage floor: each outcome's count > 0 per U, for successor and
 * predecessor separately. U >= 65 (three words) is the smallest universe where a
 * predecessor peel can FALL (U = 33: x <= 32 puts x - 1 in word 0, so never).
 *
 * Must-fail controls: six hand-built streams, each lacking exactly ONE
 * (direction, outcome) cell; the floor check must report that cell and no other.
 * The in-process replay is safe from a hang: the climb loops are bounded by the
 * level sizes (no worker needed; a wrong answer is an assert, not a loop).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StratifiedBitset } from '../LogLogN.js';
import { genStream, OP_ADD, OP_DELETE, OP_SUCC, OP_PRED } from './helpers/tierStream.mjs';

const T = { timeout: 120000 };
const UNIVERSES = [65, 1024, 1025, 32768, 32769, 2 ** 20 + 1];
const NOPS = 40000;
const SEED = 0xa11ce5;
const FOUND = 0;
const PAST = 1;
const FALL = 2;
const NAMES = ['found', 'past', 'fall'];

// --- sorted-array model (independent of the engine) ---------------------------

function lowerBound(a, x) { // first index with a[i] >= x
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (a[m] < x) lo = m + 1; else hi = m;
    }
    return lo;
}
function mAdd(a, x) {
    const i = lowerBound(a, x);
    if (a[i] !== x) a.splice(i, 0, x);
}
function mDel(a, x) {
    const i = lowerBound(a, x);
    if (a[i] === x) a.splice(i, 1);
}
function mSucc(a, x) { // smallest > x
    const i = lowerBound(a, x + 1);
    return i < a.length ? a[i] : undefined;
}
function mPred(a, x) { // largest < x
    const i = lowerBound(a, x) - 1;
    return i >= 0 ? a[i] : undefined;
}

/** Outcome of the successor peel for query x, from the model alone. */
function classSucc(a, U, x) {
    const i = x + 1;
    if (i >= U) return PAST;
    const p = i >>> 5;
    const ans = mSucc(a, x);
    if (ans !== undefined && (ans >>> 5) === p) return FOUND;
    return p >= Math.ceil(U / 32) - 1 ? PAST : FALL;
}
/** Outcome of the predecessor peel for query x, from the model alone. */
function classPred(a, U, x) {
    if (x === 0) return PAST;
    const p = (x - 1) >>> 5;
    const ans = mPred(a, x);
    if (ans !== undefined && (ans >>> 5) === p) return FOUND;
    return p === 0 ? PAST : FALL;
}

/**
 * Replays events [{ o, x }] (o in OP_ADD / OP_DELETE / OP_SUCC / OP_PRED, x a valid
 * key) on a fresh engine and the model. Returns the outcome counts per direction
 * and the number of engine/model disagreements.
 */
function replay(U, events, Cls = StratifiedBitset) {
    const eng = new Cls(U);
    const model = [];
    const succ = [0, 0, 0];
    const pred = [0, 0, 0];
    let bad = 0;
    for (const e of events) {
        if (e.o === OP_ADD) { eng.add(e.x); mAdd(model, e.x); }
        else if (e.o === OP_DELETE) { eng.delete(e.x); mDel(model, e.x); }
        else if (e.o === OP_SUCC) {
            succ[classSucc(model, U, e.x)]++;
            if (eng.successor(e.x) !== mSucc(model, e.x)) bad++;
        } else {
            pred[classPred(model, U, e.x)]++;
            if (eng.predecessor(e.x) !== mPred(model, e.x)) bad++;
        }
    }
    return { succ, pred, bad };
}

/** The cells ('succ:found' ...) of one direction whose count is 0. */
function missing(t, dir) {
    const out = [];
    for (let k = 0; k < 3; k++) if (!(t[dir][k] > 0)) out.push(dir + ':' + NAMES[k]);
    return out;
}

function streamEvents(U) {
    const st = genStream(U, NOPS, SEED + U);
    const ev = [];
    for (let i = 0; i < NOPS; i++) {
        const o = st.op[i];
        if (st.bad[i] >= 0 || o > OP_PRED) continue; // bad keys / has / min / max: not peel queries
        if (o === OP_DELETE || o === OP_ADD || o === OP_SUCC || o === OP_PRED) ev.push({ o, x: st.key[i] });
    }
    return ev;
}

// --- the gate -------------------------------------------------------------------

for (const U of UNIVERSES) {
    test('peel outcomes: U=' + U + ' engine == model, every outcome covered (succ + pred)', T, () => {
        const t = replay(U, streamEvents(U));
        assert.equal(t.bad, 0, 'engine answer differs from the sorted-array model');
        assert.deepEqual(missing(t, 'succ'), [], 'successor counts ' + t.succ);
        assert.deepEqual(missing(t, 'pred'), [], 'predecessor counts ' + t.pred);
    });
}

// --- must-fail controls: each stream lacks exactly one cell ----------------------

const U_C = 1025; // 33 level-0 words
const adds = (...ks) => ks.map((x) => ({ o: OP_ADD, x }));
const q = (o, ...xs) => xs.map((x) => ({ o, x }));
const dense = [];
for (let k = 0; k < U_C; k++) dense.push({ o: OP_ADD, x: k });

const CONTROLS = [
    // successor
    ['succ:found', 'succ', [...q(OP_SUCC, 0, 100, 1024)]], // empty set: FALL (x=0, 100), PAST (1024)
    ['succ:past', 'succ', [...adds(1, 600), ...q(OP_SUCC, 0, 5)]], // 0 -> FOUND 1; 5 -> FALL (600 in word 18)
    ['succ:fall', 'succ', [...dense, ...q(OP_SUCC, 0, 1024)]], // 0 -> FOUND; 1024 -> PAST
    // predecessor
    ['pred:found', 'pred', [...q(OP_PRED, 0, 500)]], // empty: 0 -> PAST; 500 -> FALL
    ['pred:past', 'pred', [...adds(10, 999), ...q(OP_PRED, 500, 1000)]], // 500 -> FALL (10 in word 0); 1000 -> FOUND 999
    ['pred:fall', 'pred', [...dense, ...q(OP_PRED, 0, 5)]], // 0 -> PAST; 5 -> FOUND
];

for (const [cell, dir, events] of CONTROLS) {
    test('control: stream without ' + cell + ' makes the floor fail on that cell alone', T, () => {
        const t = replay(U_C, events);
        assert.equal(t.bad, 0);
        assert.deepEqual(missing(t, dir), [cell]);
    });
}

test('control sanity: the real stream at the control U passes all six floors', T, () => {
    const t = replay(U_C, streamEvents(U_C));
    assert.equal(t.bad, 0);
    assert.deepEqual(missing(t, 'succ').concat(missing(t, 'pred')), []);
});

// Must-fail control for the engine == model row: the level-0 peel step `i = p - 1`
// mutated to `i = p` in a data: copy of the engine must make replay() disagree.
test('control: engine == model row fails on a mutated peel step', T, async () => {
    const old = 'if (p === 0) return undefined;\n        i = p - 1;\n        let L = 1;';
    const src = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
    assert.equal(src.split(old).length - 1, 1, 'mutation site must match exactly once');
    const mut = src.replace(old, old.replace('i = p - 1;', 'i = p;'));
    const M = await import('data:text/javascript,' + encodeURIComponent(mut));
    const t = replay(32768, streamEvents(32768), M.StratifiedBitset);
    assert.ok(t.bad > 0, 'mutated engine agreed with the model: the row is blind');
});
