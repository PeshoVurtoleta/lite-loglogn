/**
 * @zakkster/lite-loglogn -- RoaringSet paged layout: space + crossover + validation (0.6.0 G2-B2,
 * PLAN-roaringset-G2 task 4, assertions A-1 / A-2; SPEC C-3, C-4, C-5, C-13, C-19, C-20). DETERMINISTIC tier.
 *
 * The oracle is the TRUE closed form, written from the typed-array sizes (never from the engine's decision line):
 *   fixed      = 8,460 (_top) + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge
 *   direct     = fixed + 11 C                                  (6 row arrays: 1 + 5 x 2 B per chunk)
 *   paged      = fixed + 11 (maxPages + 1) 2^pageBits + 2 D + 2 (maxPages + 1) + 2 maxPages   (_dir, _pLive, _pFree)
 *   C = ceil(U / 65536), D = ceil(C / 2^pageBits); the set is PAGED iff its paged metadata is STRICTLY below
 *   11 C (C-5), and the default maxPages (= D) is direct at every universe.
 * Values are SPEC C-3's (PLAN-G2 A-1 minus 24: `_q` dropped).
 *
 * Must-fail mutants (C-13, C-20): single-anchor substitutions on the TEXT of ../LogLogN.js, imported as base64
 * data: URLs in this process. Anchor count != 1 FAILS; a mutant that does not parse is ABORT = FAIL, never a kill;
 * each mutant must flip its NAMED row. One unmutated control build (same text, same data: path) must pass every row.
 * Finding (G2-B2): PLAN-G2 A-1 names the default 2^32 row as the killer of the default-maxPages `dirLen - 1`
 * mutant. It cannot kill it: at D >= 2 a default of D - 1 pages is still direct (11 D 2^pb >= 11 C), and a direct
 * set's bytes do not depend on maxPages. The mutant is observable only at D = 1, where the default becomes 0 and
 * the constructor throws; row `def-2^16` (new RoaringSet(65536), D = 1) carries it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RoaringSet } from '../LogLogN.js';

const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const U32 = 4294967296;
const PFX = '[lite-loglogn] RoaringSet ';

// --- the TRUE closed form ---------------------------------------------------------------------
function form(U, maxS, maxL, maxPages, pageBits) {
    const C = Math.ceil(U / 65536);
    const P = Math.pow(2, pageBits);
    const D = Math.ceil(C / P);
    const mp = maxPages === undefined ? D : maxPages;
    const fixed = 8460 + 130 * maxS + 8456 * (maxL + 1) + 2 * maxL;
    const directMeta = 11 * C;
    const pagedMeta = 11 * (mp + 1) * P + 2 * D + 2 * (mp + 1) + 2 * mp;
    const paged = pagedMeta < directMeta;
    return { C, D, paged, directMeta, pagedMeta, bytes: fixed + (paged ? pagedMeta : directMeta) };
}

// --- A-1 rows: [id, ctor args, paged, byteLength] -----------------------------------------------
// pb1 rows: U 2^32 (C 65,536, D 32,768), pools (0, 1): paged iff 26 maxPages + 65,560 < 720,896, i.e. maxPages <= 25,205.
const A1 = [
    ['def-2^32', [U32], false, 3036180],
    ['mp256', [U32, 1024, 256, 256], false, 3036180],
    ['mp255', [U32, 1024, 256, 255], false, 3036180],
    ['mp254', [U32, 1024, 256, 254], true, 3034894],
    ['p01-mp254', [U32, 0, 1, 254], true, 744984],
    ['p01-mp255', [U32, 0, 1, 255], false, 746270],
    ['p01-mp1', [U32, 0, 1, 1], true, 31524],
    ['tie', [184942592, 0, 1, 10, 8], false, 56416],
    ['tie-mp9', [184942592, 0, 1, 9, 8], true, 53596],
    ['pb1-mp25205', [U32, 0, 1, 25205, 1], true, form(U32, 0, 1, 25205, 1).bytes],
    ['pb1-mp25206', [U32, 0, 1, 25206, 1], false, form(U32, 0, 1, 25206, 1).bytes],
    ['pb15-mp1', [U32, 0, 1, 1, 15], false, 746270],
    ['2^16-mp1', [65536, 0, 1, 1], false, 25385],
    ['2^25-mp1', [33554432, 0, 1, 1], false, 31006],
    ['2^26-mp1', [67108864, 0, 1, 1], true, 31020],
    ['def-2^16', [65536], false, 2315295],
];

function formOf(args) {
    const [U, s = 1024, l = 256, mp, pb = 8] = args;
    return form(U, s, l, mp, pb);
}

/** Map row id -> null (ok) or the reason it failed, on the RoaringSet class RS. */
function checkRows(RS) {
    const out = new Map();
    for (const [id, args, paged, bytes] of A1) {
        const f = formOf(args);
        let why = null;
        if (f.paged !== paged || f.bytes !== bytes) why = 'closed form ' + f.paged + ' / ' + f.bytes;
        else {
            try {
                const s = new RS(...args);
                if (s.paged !== paged) why = 'paged ' + s.paged;
                else if (s.byteLength !== bytes) why = 'byteLength ' + s.byteLength;
            } catch (e) {
                why = 'threw ' + String(e && e.message);
            }
        }
        out.set(id, why);
    }
    return out;
}

test('A-1 rows: paged and byteLength equal the C-3 / C-5 closed form and the stated literal', () => {
    // literal pins of the derived rows (the closed form is the oracle; these catch a drifting oracle)
    assert.equal(form(U32, 0, 1, 25205, 1).bytes, 746264);
    assert.equal(form(U32, 0, 1, 25206, 1).bytes, 746270);
    const tie = form(184942592, 0, 1, 10, 8);
    assert.equal(tie.C, 2822);
    assert.equal(tie.pagedMeta, 31042);
    assert.equal(tie.directMeta, 31042, 'the tie row IS a tie: equal metadata bytes -> direct (strict <)');
    const bad = [...checkRows(RoaringSet)].filter(([, w]) => w !== null).map(([id, w]) => id + ': ' + w);
    assert.deepEqual(bad, []);
});

// --- grid --------------------------------------------------------------------------------------
const GRID_U = [1, 65536, 200001, 1048576, 33554432, 67108864, 268435456, U32 - 1, U32];
const GRID_PB = [1, 6, 8, 10, 15];
const GRID_POOLS = [[0, 1], [64, 32]];
// pinned so a shrinking grid fails: 9 U x 5 pb x 5 maxPages x 2 pools = 450
const GRID_CHECKED = 358;
const GRID_SKIPPED = 92;
const GRID_PAGED = 72;

test('A-1 grid: closed form == byteLength and == paged on every valid config; invalid maxPages throw exactly', () => {
    let checked = 0, skipped = 0, paged = 0;
    const miss = [];
    for (const U of GRID_U) {
        for (const pb of GRID_PB) {
            const D = Math.ceil(Math.ceil(U / 65536) / Math.pow(2, pb));
            for (const mp of [1, 2, D - 1, D, undefined]) {
                for (const [s, l] of GRID_POOLS) {
                    const tag = '(' + U + ', ' + s + ', ' + l + ', ' + mp + ', ' + pb + ')';
                    if (mp !== undefined && (mp < 1 || mp > D)) {
                        skipped++;
                        const want = PFX + 'maxPages must be an integer in [1, ' + D + '] for this universe and pageBits; got ' + mp;
                        try {
                            new RoaringSet(U, s, l, mp, pb);
                            miss.push(tag + ' constructed (invalid maxPages)');
                        } catch (e) {
                            if (!(e instanceof RangeError) || e.message !== want) miss.push(tag + ' threw ' + String(e && e.message));
                        }
                        continue;
                    }
                    checked++;
                    const f = form(U, s, l, mp, pb);
                    const set = new RoaringSet(U, s, l, mp, pb);
                    if (set.byteLength !== f.bytes) miss.push(tag + ' byteLength ' + set.byteLength + ' form ' + f.bytes);
                    if (set.paged !== f.paged) miss.push(tag + ' paged ' + set.paged + ' form ' + f.paged);
                    if (mp === undefined && set.paged) miss.push(tag + ' default maxPages is paged');
                    if (f.paged) paged++;
                }
            }
        }
    }
    assert.deepEqual(miss, []);
    assert.equal(checked + skipped, 450);
    assert.equal(checked, GRID_CHECKED);
    assert.equal(skipped, GRID_SKIPPED);
    assert.equal(paged, GRID_PAGED);
});

// --- A-2 validation ----------------------------------------------------------------------------
function throwsExactly(fn, text) {
    assert.throws(fn, (e) => {
        assert.ok(e instanceof RangeError, 'RangeError, got ' + (e && e.name));
        assert.equal(e.message, text);
        return true;
    });
}

test('A-2 pageBits: 0 / 16 / 1.5 / NaN / "8" / null -> exact RangeError', () => {
    const cases = [[0, '0'], [16, '16'], [1.5, '1.5'], [NaN, 'NaN'], ['8', 'string'], [null, 'object']];
    for (const [pb, got] of cases) {
        throwsExactly(() => new RoaringSet(U32, 0, 1, undefined, pb), PFX + 'pageBits must be an integer in [1, 15]; got ' + got);
    }
});

test('A-2 maxPages: 257 / 0 / 1.5 / null at (2^32, pb8) and 2 at 2^16 -> exact RangeError', () => {
    const at32 = PFX + 'maxPages must be an integer in [1, 256] for this universe and pageBits; got ';
    for (const [mp, got] of [[257, '257'], [0, '0'], [1.5, '1.5'], [null, 'object'], [NaN, 'NaN'], ['8', 'string']]) {
        throwsExactly(() => new RoaringSet(U32, 0, 1, mp, 8), at32 + got);
    }
    throwsExactly(() => new RoaringSet(65536, 0, 1, 2), PFX + 'maxPages must be an integer in [1, 1] for this universe and pageBits; got 2');
});

test('A-2 order: pageBits is checked before maxPages', () => {
    throwsExactly(() => new RoaringSet(U32, 0, 1, 257, 0), PFX + 'pageBits must be an integer in [1, 15]; got 0');
    throwsExactly(() => new RoaringSet(U32, 0, 1, null, 16), PFX + 'pageBits must be an integer in [1, 15]; got 16');
});

// --- must-fail mutants (C-13, C-20) --------------------------------------------------------------
const MUTANTS = [
    ['M-tie', 'decision `<` -> `<=`', '4 * maxPages + 2 < 11 * chunks;', '4 * maxPages + 2 <= 11 * chunks;', 'tie'],
    ['M-zero', 'zero page dropped from the decision (`maxPages + 1` -> `maxPages`)',
        'const paged = 11 * (maxPages + 1) * (1 << pageBits)', 'const paged = 11 * (maxPages) * (1 << pageBits)', 'p01-mp255'],
    ['M-dir', '`2 * dirLen` term dropped', '(1 << pageBits) + 2 * dirLen + 4 * maxPages', '(1 << pageBits) + 4 * maxPages', 'pb1-mp25206'],
    ['M-def', 'default maxPages `dirLen` -> `dirLen - 1`', 'if (maxPages === undefined) maxPages = dirLen;',
        'if (maxPages === undefined) maxPages = dirLen - 1;', 'def-2^16'],
];
// rows each mutant must flip besides its named row (pins the C-13 row split)
const ALSO = { 'M-zero': ['mp255'] };

const count = (s) => SRC.split(s).length - 1;

async function load(src) {
    return import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
}

test('mutants: control passes every row; each anchor count 1; each mutant parses and flips its named row', async () => {
    const control = await load(SRC + '\n// control\n');
    assert.equal(typeof control.RoaringSet, 'function');
    const cBad = [...checkRows(control.RoaringSet)].filter(([, w]) => w !== null);
    assert.deepEqual(cBad, [], 'unmutated control build passes every A-1 row');
    const verdicts = [];
    for (const [id, what, from, to, row] of MUTANTS) {
        assert.equal(count(from), 1, id + ' anchor count');
        let mod;
        try {
            mod = await load(SRC.replace(from, to));
        } catch (e) {
            assert.fail(id + ' ABORT (mutant does not load): ' + String(e && e.message));
        }
        const res = checkRows(mod.RoaringSet);
        const flipped = [...res].filter(([, w]) => w !== null).map(([k]) => k);
        verdicts.push(id + ' (' + what + ') flips ' + flipped.join(' '));
        assert.ok(flipped.includes(row), id + ' must flip ' + row + '; flipped: ' + flipped.join(' '));
        for (const r of ALSO[id] || []) assert.ok(flipped.includes(r), id + ' must flip ' + r);
        if (id === 'M-def') assert.ok(!flipped.includes('def-2^32'), 'M-def is equivalent at D >= 2 (see header)');
    }
    for (const v of verdicts) console.log('# ' + v);
});

// --- paged A-3-style snapshot around the page-pool throw (G2-B1 review nit) ------------------------
function snapshot(s) {
    const o = {};
    for (const k of Object.keys(s)) {
        const v = s[k];
        o[k] = ArrayBuffer.isView(v) ? Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : v;
    }
    return o;
}

test('paged page-pool exhaustion at (2^32, 8, 8, 2): exact RangeError, every array + _pTop + _size unchanged', () => {
    const P24 = 16777216; // one pb8 page = 256 chunks = 2^24 keys
    const s = new RoaringSet(U32, 8, 8, 2);
    assert.equal(s.paged, true);
    s.add(5).add(3).add(P24 + 7).add(P24 + 70000);
    assert.equal(s._pTop, 0, 'both pages mapped');
    const before = snapshot(s);
    for (const k of ['_pTop', '_dir', '_pLive', '_pFree', '_size', '_kind', '_slot', '_cMin', '_cMax', '_top']) {
        assert.ok(k in before, 'snapshot covers ' + k);
    }
    const text = PFX + 'metadata page pool exhausted (maxPages 2); increase maxPages at construction';
    throwsExactly(() => s.add(2 * P24 + 1), text);
    assert.deepEqual(snapshot(s), before);
    throwsExactly(() => s.add(U32 - 1), text);
    assert.deepEqual(snapshot(s), before);
    assert.equal(s.has(2 * P24 + 1), false);
    // teeth: the snapshot sees a successful in-page add
    s.add(4);
    assert.notDeepEqual(snapshot(s), before);
    // a released page is reused (LIFO): emptying page 1 frees it, the next new page maps
    s.delete(P24 + 7);
    s.delete(P24 + 70000);
    assert.equal(s._pTop, 1);
    s.add(2 * P24 + 1);
    assert.equal(s.has(2 * P24 + 1), true);
    assert.equal(s.size, 4);
});
