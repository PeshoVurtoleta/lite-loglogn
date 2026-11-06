/**
 * @zakkster/lite-loglogn -- doc sync gate (cold; reads text, builds one small
 * vEBTree per row).
 *
 *  (a) STALE: no shipped doc may call vEBTree "planned" (README.md, llms.txt,
 *      GUIDE.md, LogLogN.d.ts, the package.json description).
 *  (b) SPACE: the vEBTree section of README.md and of llms.txt (the lines from
 *      `### vEBTree` to the next `## ` / `### ` heading) carries the exact
 *      byteLength of eight universes, comma-formatted. The expected numbers come
 *      from a TEST-OWNED S(w) written from PLAN C-1 / C-2 / C-13 (never imported
 *      from test/helpers); for U <= 2^24 + 1 they must also equal the engine's
 *      `new vEBTree(U).byteLength`, above that the formula alone is used (a
 *      539.5 MB array is the U = 2^32 Worker's job, not this cold test).
 *
 * The checks are pure functions over strings, so the must-fail fixtures run
 * the very code the live files run through.
 *
 * LOGLOGN_DOCSYNC_ROOT (optional) points the DOC reads at another directory
 * (used to prove the gate fails on an old copy of the docs); the engine is
 * always the repo's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vEBTree } from '../LogLogN.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.LOGLOGN_DOCSYNC_ROOT || REPO;

// --- pure checks (also exercised by the fixtures below) ----------------------

export const STALE_RE = /vEBTree[^\n]*\bplanned\b|\bplanned\b[^\n]*vEBTree/i;

/** 1-based line numbers whose text matches STALE_RE (the regex is per line: no \n crosses). */
export function staleHits(text) {
    const hits = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) if (STALE_RE.test(lines[i])) hits.push(i + 1);
    return hits;
}

// C-1: a node of width w <= 8 is a bitmap, w <= 5 one word, else 2^(w-5) words.
// C-2: an internal node (w >= 9) is 2 header words + the summary (width hi) + 2^hi clusters (width lo),
//      lo = (w > 24 ? 16 : 8), hi = w - lo.
function S(w) {
    if (w <= 8) return w <= 5 ? 1 : 2 ** (w - 5);
    const lo = w > 24 ? 16 : 8;
    return 2 + S(w - lo) + 2 ** (w - lo) * S(lo);
}

/** C-13: the root keeps only ceil(U / 2^lo) clusters. Bytes = 4 per word. */
export function expectedBytes(U) {
    const w = 32 - Math.clz32(U - 1);
    if (w <= 8) return 4 * S(w);
    const lo = w > 24 ? 16 : 8;
    return 4 * (2 + S(w - lo) + Math.ceil(U / 2 ** lo) * S(lo));
}

export const ROWS = [2, 257, 2 ** 16, 2 ** 20, 2 ** 24, 2 ** 24 + 1, 2 ** 28, 2 ** 32];

export function commas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Exact token match: `frag` not embedded in a longer word and not digit-extended on either side
 * (`(?<!\w|\d[.,])` ... `(?!\w|[.,]\d)`). Every doc formula / number check goes through tokCount.
 */
export const tokRe = (frag) => new RegExp('(?<!\\w|\\d[.,])' + reEsc(frag) + '(?!\\w|[.,]\\d)', 'g');
export const tokCount = (text, frag) => (text.match(tokRe(frag)) || []).length;
/** Clause-anchored match (blocker 1): `frag` starts after `= `/`: `/`; `/`( `/`iff ` and ends at `;` `,` `.` `)` or ` (strict)`; no term may extend it. */
export const clauseRe = (frag) => new RegExp('(?<=[=:;(] |iff )' + reEsc(frag) + '(?![.,]\\d)(?=[;,.)]|\\s\\(strict\\))', 'g');
export const clauseCount = (text, frag) => (text.match(clauseRe(frag)) || []).length;
/** Every "N B" figure with a comma / dot group (digit-extended ones included) in `text`, as strings. */
export const bFigures = (text) => (text.match(/(?<![\w,.])\d{1,3}(?:[,.]\d+)+ B(?!\w)/g) || []).map((x) => x.slice(0, -2));
/** Problems for one keyed line: exactly one line with the key, and that line must match `exact` whole. */
function lineOnce(lines, key, exact, tag, bad) {
    const k = lines.filter((l) => key.test(l));
    if (k.length !== 1) bad.push(tag + ': ' + k.length + ' line(s) for the key');
    else if (!exact.test(k[0])) bad.push(tag + ': line is not exactly the expected one');
}

/** The lines from `### vEBTree` (exact line) up to the next `## ` / `### ` line; null if absent. */
export function vebSection(text) {
    const lines = text.split('\n');
    let from = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i] === '### vEBTree') { from = i; break; }
    if (from < 0) return null;
    let to = lines.length;
    for (let i = from + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ') || lines[i].startsWith('### ')) { to = i; break; }
    }
    return lines.slice(from, to).join('\n');
}

/** Returns the list of problems (empty = in sync). */
export function spaceProblems(text, rows = ROWS) {
    const sec = vebSection(text);
    if (sec === null) return ['no "### vEBTree" section'];
    const bad = [];
    const lines = sec.split('\n');
    const allowed = new Set(rows.map((U) => commas(expectedBytes(U))));
    for (const U of rows) {
        const v = commas(expectedBytes(U));
        const label = VEB_LABELS[ROWS.indexOf(U)] || String(U);
        const w = 32 - Math.clz32(U - 1);
        // whole row: `| label | w | N B[ (note)] |`; exactly one line may start with the key (no stale copy beside it)
        const key = '| ' + label + ' | ';
        lineOnce(lines, { test: (l) => l.startsWith(key) },
            new RegExp('^\\| ' + reEsc(label) + ' \\| ' + w + ' \\| ' + reEsc(v) + ' B' + (VEB_NOTES[label] ? '(?: \\(' + reEsc(VEB_NOTES[label]) + '\\))?' : '') + ' \\|$'),
            'U=' + U + ' (' + v + ' B)', bad);
    }
    const tbl = lines.filter((l) => /^\|.*\| [\d,.]+ B(?: \([^|]*\))? \|\s*$/.test(l)).length;
    if (tbl !== rows.length) bad.push(tbl + ' byteLength table rows, want ' + rows.length);
    // any other comma-grouped "N B" figure in the section must be one of the eight
    for (const f of bFigures(sec)) if (!allowed.has(f)) bad.push('stray figure ' + f + ' B in the section');
    return bad;
}

export const VEB_NOTES = { '2^24 + 1': 'trimmed root', '2^32': 'about 540 MB' };
export const VEB_LABELS = ['2', '257', '2^16', '2^20', '2^24', '2^24 + 1', '2^28', '2^32'];

/**
 * The 2^16 byteLength example: llms.txt `v.byteLength;  // N` inside the vEBTree section (kind 'llms'), README
 * `console.log(v.size, v.bits, v.byteLength);  // -> 3 16 N` anywhere (kind 'readme'). One keyed line, whole-line match.
 */
export function vebSnippetProblems(text, kind) {
    const N = String(expectedBytes(2 ** 16));
    const bad = [];
    if (kind === 'llms') {
        const sec = vebSection(text);
        if (sec === null) return ['no "### vEBTree" section'];
        lineOnce(sec.split('\n'), /^\s+v\.byteLength;/, new RegExp('^\\s+v\\.byteLength;\\s+// ' + N + '$'), 'llms v.byteLength example', bad);
    } else {
        lineOnce(text.split('\n'), /^console\.log\(v\.size, v\.bits, v\.byteLength\);/,
            new RegExp('^console\\.log\\(v\\.size, v\\.bits, v\\.byteLength\\);\\s+// -> 3 16 ' + N + '$'), 'README byteLength example', bad);
    }
    return bad;
}

const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// --- the expected numbers themselves ------------------------------------------

test('DocSync: the test-owned S(w) gives the planner table (C-16)', () => {
    const want = [4, 76, 8232, 131604, 2105392, 2115708, 33718804, 539500592];
    assert.deepEqual(ROWS.map(expectedBytes), want);
});

test('DocSync: the formula equals the engine byteLength for U <= 2^24 + 1', () => {
    for (const U of ROWS) {
        if (U > 2 ** 24 + 1) continue;
        assert.equal(new vEBTree(U).byteLength, expectedBytes(U), 'U=' + U);
    }
});

// --- (a) stale gate on the live files ------------------------------------------

for (const f of ['README.md', 'llms.txt', 'GUIDE.md', 'LogLogN.d.ts']) {
    test('DocSync (a): ' + f + ' never calls vEBTree planned', () => {
        const hits = staleHits(read(f));
        assert.deepEqual(hits, [], f + ' stale line(s): ' + hits.join(', '));
    });
}

test('DocSync (a): package.json description never calls vEBTree planned, and names vEBTree', () => {
    const desc = JSON.parse(read('package.json')).description;
    assert.equal(typeof desc, 'string');
    const hits = staleHits(desc);
    assert.deepEqual(hits, [], 'package.json description is stale: ' + desc);
    assert.ok(tokCount(desc, 'vEBTree') >= 1, 'description names vEBTree');
});

// --- (b) space sync on the live files ------------------------------------------

for (const f of ['README.md', 'llms.txt']) {
    test('DocSync (b): ' + f + ' vEBTree section carries the 8 byteLength rows', () => {
        const bad = spaceProblems(read(f));
        assert.deepEqual(bad, [], f + ': ' + bad.join('; '));
    });
}

for (const [f, kind] of [['README.md', 'readme'], ['llms.txt', 'llms']]) {
    test('DocSync (b): ' + f + ' carries the one 2^16 byteLength example, 8232', () => {
        const bad = vebSnippetProblems(read(f), kind);
        assert.deepEqual(bad, [], f + ': ' + bad.join('; '));
    });
}

// --- must-fail fixtures (strings, same functions) -------------------------------

const GOOD = '## API reference\n\n### YFastTrie\n\nx\n\n### vEBTree\n\n| U | B |\n' +
    ROWS.map((U, i) => '| ' + VEB_LABELS[i] + ' | ' + (32 - Math.clz32(U - 1)) + ' | ' + commas(expectedBytes(U)) + ' B' + (i === 5 ? ' (trimmed root)' : '') + ' |').join('\n') +
    '\n\n### Next\n\nunrelated 999\n';

test('DocSync fixtures: the good section passes both checks', () => {
    assert.deepEqual(spaceProblems(GOOD), []);
    assert.deepEqual(staleHits(GOOD), []);
});

test('DocSync fixtures (a): a "vEBTree is planned" line flips the stale gate', () => {
    assert.deepEqual(staleHits(GOOD + '\nvEBTree is planned.\n').length, 1);
    assert.equal(staleHits('| vEBTree | 0.5.0 (planned) | x |').length, 1);
    assert.equal(staleHits('planned: vEBTree').length, 1);
    assert.equal(staleHits('| Classic | vEBTree | O(log log U) worst-case | O(U) | planned 0.5.0 |').length, 1);
    assert.equal(staleHits('vEBTree ships in 0.5.0').length, 0);
});

test('DocSync fixtures (a): the pre-0.5.0 package.json description flips the stale gate', () => {
    // inline copy of the pre-0.5.0 (identical since 9f87693) description tail; .handoff is gitignored, so it is never read here
    const OLD = 'Zero-dependency, zero-GC sub-logarithmic bounded-integer predecessor/successor structures. ' +
        '0 B/op, bounds gated by exact counts. vEBTree (worst-case O(log log U)) is planned. ' +
        'Tree-shakeable named exports.';
    assert.equal(staleHits(OLD).length, 1);
    const NEW = OLD.replace('vEBTree (worst-case O(log log U)) is planned.',
        'vEBTree: worst-case O(log log U) successor/predecessor, O(1) min/max, O(U) space.');
    assert.notEqual(NEW, OLD);
    assert.deepEqual(staleHits(NEW), []);
});

test('DocSync fixtures (b): one changed digit flips the space sync', () => {
    const bad = GOOD.replace('131,604', '131,605');
    const p = spaceProblems(bad);
    assert.ok(p.length >= 1); // the row is wrong, and 131,605 B is also a stray figure
    assert.match(p[0], /U=1048576/);
    // a value only inside a longer number does not count
    assert.equal(spaceProblems(GOOD.replace('| 1 | 4 B |', '| 1 | 14 B |')).length, 1);
});

test('DocSync fixtures (b): a missing section (or a renamed heading) flips the space sync', () => {
    assert.deepEqual(spaceProblems('## API reference\n\n### YFastTrie\n\nx\n'), ['no "### vEBTree" section']);
    assert.equal(spaceProblems(GOOD.replace('### vEBTree', '### vEBTree (0.5.0)')).length, 1);
    // rows placed after the next heading are outside the section
    assert.equal(spaceProblems(GOOD.replace('| 2^32 | 32 | 539,500,592 B |', '').replace('### Next', '### Next\n539,500,592 B')).length, 2); // the row is gone + the table has 7 rows, want 8
});

const VEB_SNIP_LLMS = '### vEBTree\n\n    const v = new vEBTree(2 ** 16);\n    v.byteLength;                             // 8232\n\n### Next\n';
const VEB_SNIP_README = 'x\nconsole.log(v.size, v.bits, v.byteLength);   // -> 3 16 8232\ny\n';

// [class, name, from, to] over GOOD: a = substring / prefix, b = digit-extended, c = duplicated / stale copy beside the right one
const VEB_HOLES = [
    ['a', 'label embedded in a longer label', '| 2^20 | 20 |', '| 2^200 | 20 |'],
    ['a', 'value followed by a longer unit word', '131,604 B |', '131,604 Bytes |'],
    ['a', 'value with trailing text outside a note', '131,604 B |', '131,604 B extra |'],
    ['b', 'value digit-extended', '131,604 B', '131,6041 B'],
    ['b', 'value decimal-extended', '131,604 B', '131,604.5 B'],
    ['b', 'value digit-prefixed', '| 76 B |', '| 176 B |'],
    ['c', 'row duplicated', '| 2^20 | 20 | 131,604 B |', '| 2^20 | 20 | 131,604 B |\n| 2^20 | 20 | 131,604 B |'],
    ['c', 'stale row beside the right one', '| 2^20 | 20 | 131,604 B |', '| 2^20 | 20 | 131,605 B |\n| 2^20 | 20 | 131,604 B |'],
    ['c', 'stale figure in prose beside the table', '### Next', 'Memory: 539,500,593 B at 2^32.\n### Next'],
    // r5 blocker 2: an extra table row whose key is not one of the eight (any figure, even an allowed one)
    ['f', 'extra row: unknown key, allowed figure', '| 2^20 | 20 | 131,604 B |', '| 2^20 | 20 | 131,604 B |\n| 2^12 | 12 | 8,232 B |'],
    ['f', 'extra row: unknown key, ungrouped figure', '| 2^20 | 20 | 131,604 B |', '| 2^20 | 20 | 131,604 B |\n| 2^12 | 12 | 8232 B |'],
    // r5 blocker 8: the note is the row's own note, closed by the pipe (M5)
    ['n', 'note changed', '(trimmed root)', '(trimmed root, 2 MB)'],
    ['n', 'note of another row', '(trimmed root)', '(about 540 MB)'],
    ['n', 'text after the closing pipe', '| 2^20 | 20 | 131,604 B |', '| 2^20 | 20 | 131,604 B | x'],
];
test('DocSync fixtures (b, r5 blocker 8): the 2^32 note is exactly "about 540 MB", and a changed note flips the row check', () => {
    const G2 = GOOD.replace('| 2^32 | 32 | 539,500,592 B |', '| 2^32 | 32 | 539,500,592 B (about 540 MB) |');
    assert.deepEqual(spaceProblems(G2), []);
    assert.ok(spaceProblems(G2.replace('about 540 MB', 'about 54 MB')).length >= 1);
    assert.ok(spaceProblems(G2.replace('about 540 MB', 'trimmed root')).length >= 1);
    assert.ok(spaceProblems(GOOD.replace('(trimmed root)', '(about 540 MB)')).length >= 1);
});
const VEB_SNIP_HOLES = [
    ['a', 'prefix', '// 8232', '// x8232'],
    ['a', 'longer word', '// 8232', '// 8232x'],
    ['b', 'digit-extended', '// 8232', '// 82325'],
    ['b', 'digit-prefixed', '// 8232', '// 18232'],
    ['b', 'decimal-extended', '// 8232', '// 8232.5'],
    ['c', 'duplicated line', 'v.byteLength; ', 'v.byteLength;                             // 8232\n    v.byteLength; '],
    ['c', 'stale line beside', 'v.byteLength; ', 'v.byteLength;                             // 8233\n    v.byteLength; '],
];
const hole = (base, [, name, from, to]) => {
    assert.equal(base.split(from).length - 1 >= 1, true, 'fixture anchor present: ' + name);
    const out = base.replace(from, () => to);
    assert.notEqual(out, base, name);
    return out;
};

test('DocSync fixtures (b): every hole class (substring / digit-extended / duplicated) flips the vEBTree row check', () => {
    assert.deepEqual(spaceProblems(GOOD), []);
    const seen = { a: 0, b: 0, c: 0, f: 0, n: 0 };
    for (const h of VEB_HOLES) { seen[h[0]]++; assert.ok(spaceProblems(hole(GOOD, h)).length >= 1, 'survives: ' + h[1]); }
    assert.ok(seen.a >= 2 && seen.b >= 2 && seen.c >= 2 && seen.f >= 2 && seen.n >= 3);
});

test('DocSync fixtures (b): every hole class flips the 2^16 byteLength example (llms and README)', () => {
    assert.deepEqual(vebSnippetProblems(VEB_SNIP_LLMS, 'llms'), []);
    assert.deepEqual(vebSnippetProblems(VEB_SNIP_README, 'readme'), []);
    const RL = 'console.log(v.size, v.bits, v.byteLength);   // -> 3 16 8232';
    for (const h of VEB_SNIP_HOLES) {
        assert.ok(vebSnippetProblems(hole(VEB_SNIP_LLMS, h), 'llms').length >= 1, 'llms survives: ' + h[1]);
    }
    // README: the same classes on its own line
    const readmeHoles = [
        ['a', 'prefix', '-> 3 16 8232', '-> 3 16 x8232'],
        ['a', 'longer word', '8232\n', '8232x\n'],
        ['b', 'digit-extended', '3 16 8232', '3 16 82325'],
        ['b', 'digit-prefixed', '3 16 8232', '3 16 18232'],
        ['b', 'decimal-extended', '3 16 8232', '3 16 8232.5'],
        ['c', 'duplicated line', RL, RL + '\n' + RL],
        ['c', 'stale line beside', RL, RL.replace('8232', '8233') + '\n' + RL],
    ];
    for (const h of readmeHoles) assert.ok(vebSnippetProblems(hole(VEB_SNIP_README, h), 'readme').length >= 1, 'readme survives: ' + h[1]);
    assert.equal(vebSnippetProblems('### Next\n', 'llms')[0], 'no "### vEBTree" section');
    assert.equal(vebSnippetProblems('', 'readme').length, 1);
});

// =============================================================================
// RoaringSet rows (0.6.0 G6-B6c; SPEC C-3 / C-5 / C-19, PLAN-G6 tasks 4-5, A-1 / A-3).
// Append-only: everything above is the vEBTree gate and is unchanged.
//
//  (c) SPACE: the `### RoaringSet` section of README.md and llms.txt carries the exact
//      byteLength of ROWS_R (10 configs), comma-formatted, "N B". The expected numbers come
//      from a TEST-OWNED roaringBytes() written from SPEC C-3 / C-5 (K = 8,460, `_q` dropped).
//      Formula == engine byteLength, and engine `paged` == the C-5 rule.
//  (d) STALE_R: no doc line pairs `RoaringSet` with `queued` or `v?0.7.0` (either order;
//      "planned" is excluded: R2 items are legitimately planned).
//  (e) package.json description names RoaringSet, keywords include "roaring-bitmap"; the
//      d.ts RoaringSet block carries K and the three 2^32 examples.
// =============================================================================

import { RoaringSet } from '../LogLogN.js';

export const K_R = 8460;

/** C-5: paged iff 11 (mP + 1) 2^pb + 2 dirLen + 4 mP + 2 < 11 C (strict), dirLen = ceil(C / 2^pb). */
export function roaringLayout(U, mP, pb) {
    const C = Math.ceil(U / 65536);
    const dirLen = Math.ceil(C / 2 ** pb);
    const mp = mP === undefined ? dirLen : mP;
    const pagedMeta = 11 * (mp + 1) * 2 ** pb + 2 * dirLen + 4 * mp + 2;
    return { C, pagedMeta, paged: pagedMeta < 11 * C, meta: pagedMeta < 11 * C ? pagedMeta : 11 * C };
}

/** C-3: byteLength = K + metadata + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge. */
export function roaringBytes(U, mS, mL, mP, pb) {
    return K_R + roaringLayout(U, mP, pb).meta + 130 * mS + 8456 * (mL + 1) + 2 * mL;
}

// [U, maxSmall, maxLarge, maxPages, pageBits, bytes, paged]; bytes and paged are hand-computed
// from C-3 / C-5 (the six PLAN-G6 A-1 values are quoted; the other four by hand, see the notes):
//  2^32 (0,1,255): paged metadata 11*256*256+2*256+4*255+2 = 722,430 >= 720,896 = 11 C -> direct.
//  tie U 184,942,592 (C 2,822, dirLen 12) (0,1,10): paged 11*11*256+24+40+2 = 31,042 == 11 C -> direct (strict <).
//  2^16 default: C 1, direct 11 + 8,460 + 133,120 + 8,456*257 + 512 = 2,315,295.
//  2^32 (0,1,1000,pb6): dirLen 1,024, paged 11*1001*64+2,048+4,000+2 = 710,754 < 720,896.
export const ROWS_R = [
    [2 ** 32, 1024, 256, undefined, 8, 3036180, false, '2^32', 'defaults (1024, 256, all, 8)'],
    [2 ** 32, 0, 1, undefined, 8, 746270, false, '2^32', '(0, 1, all, 8)'],
    [2 ** 32, 0, 1, 1, 8, 31524, true, '2^32', '(0, 1, 1, 8)'],
    [2 ** 32, 0, 1, 254, 8, 744984, true, '2^32', '(0, 1, 254, 8)'],
    [2 ** 32, 0, 1, 255, 8, 746270, false, '2^32', '(0, 1, 255, 8)'],
    [2 ** 25, 0, 1, 1, 8, 31006, false, '2^25', '(0, 1, 1, 8)'],
    [2 ** 26, 0, 1, 1, 8, 31020, true, '2^26', '(0, 1, 1, 8)'],
    [184942592, 0, 1, 10, 8, 56416, false, '184,942,592', '(0, 1, 10, 8)'],
    [2 ** 16, 1024, 256, undefined, 8, 2315295, false, '2^16', 'defaults (1024, 256, all, 8)'],
    [2 ** 32, 0, 1, 1000, 6, 736128, true, '2^32', '(0, 1, 1000, 6)'],
];

/** The lines from `### RoaringSet` (exact line) to the next `## ` / `### ` heading; null if absent. */
export function roaringSection(text) {
    const lines = text.split('\n');
    let from = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i] === '### RoaringSet') { from = i; break; }
    if (from < 0) return null;
    let to = lines.length;
    for (let i = from + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ') || lines[i].startsWith('### ')) { to = i; break; }
    }
    return lines.slice(from, to).join('\n');
}

/** The README / llms layout formulas, after whitespace collapse (SPEC C-3 / C-5). */
export const FORMULA_R = ['8,460 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge', '11 (maxPages + 1) 2^pageBits + 2 ceil(C / 2^pageBits) + 4 maxPages + 2 < 11 C',
    'paged replaces 11 C by 11 (maxPages + 1) 2^pageBits + 2 ceil(C / 2^pageBits) + 4 maxPages + 2'];

/** Layout-cell notes the docs may carry, per row tag (derived from the rule: paged meta P vs direct table D = 11 C). */
function layoutNotes(r) {
    const L = roaringLayout(r[0], r[3], r[4]);
    const P = commas(L.pagedMeta), D = commas(11 * L.C);
    if (r[7] === '184,942,592') return ['tie: ' + P + ' is not < ' + D, 'tie, strict <'];
    if (r[7] === '2^32' && r[3] === 255) return [P + ' is not < ' + D];
    return [];
}

/** Stems: counts of the formula's operators over the flattened section (a stale copy beside the right one adds to a count). */
export const STEMS_R = [['+ 11 C', 1], ['+ 130 maxSmall', 1], ['4 maxPages +', 2], ['11 (maxPages +', 2]];

/**
 * Problems (empty = in sync). Per ROWS_R row exactly one line starts with `| U | cfg | ` and that WHOLE line is
 * `| U | cfg | (direct|paged)[ (note)] | N B |` with the rule's layout word; each formula fragment occurs exactly once as a
 * token and the operator stems occur their expected number of times; the default-pools figure and the 11 C = 720,896
 * phrase occur once; every other comma-grouped "N B" figure in the section is a known one. opts.snippet: the llms
 * `s.byteLength;  // N` example line.
 */
export function roaringSpaceProblems(text, rows = ROWS_R, opts = {}) {
    const sec = roaringSection(text);
    if (sec === null) return ['no "### RoaringSet" section'];
    const bad = [];
    const lines = sec.split('\n');
    const pools = commas(ROWS_R[0][5] - K_R - 11 * 65536);
    const allowed = new Set(rows.map((r) => commas(r[5])));
    allowed.add(pools);
    for (const r of rows) {
        const key = '| ' + r[7] + ' | ' + r[8] + ' | ';
        const notes = layoutNotes(r).map(reEsc).join('|');
        const re = new RegExp('^\\| ' + reEsc(r[7]) + ' \\| ' + reEsc(r[8]) + ' \\| (direct|paged)' +
            (notes ? '(?: \\((?:' + notes + ')\\))?' : '') + ' \\| ' + reEsc(commas(r[5])) + ' B \\|$');
        const tag = r[7] + ' ' + r[8];
        const k = lines.filter((l) => l.startsWith(key));
        if (k.length !== 1) { bad.push(tag + ': ' + k.length + ' line(s) for the row key'); continue; }
        const m = re.exec(k[0]);
        if (!m) bad.push(tag + ': row is not exactly the expected one for ' + commas(r[5]) + ' B');
        else if ((m[1] === 'paged') !== r[6]) bad.push(tag + ': layout word ' + m[1] + ' != ' + (r[6] ? 'paged' : 'direct'));
    }
    allowed.add('0'); allowed.add('11'); // SINGLE / FULL cost 0 B; the 11 B chunk-table row
    for (const f of (sec.match(/(?<![\w,.])\d+(?:[,.]\d+)* B(?!\w)/g) || []).map((x) => x.slice(0, -2))) if (!allowed.has(f)) bad.push('stray figure ' + f + ' B in the section');
    const tbl = lines.filter((l) => /^\|.*\| [\d,.]+ B(?: \([^|]*\))? \|\s*$/.test(l)).length;
    if (tbl !== rows.length) bad.push(tbl + ' byteLength table rows, want ' + rows.length);
    const flat = sec.replace(/\s+/g, ' ');
    for (const f of FORMULA_R) { const c = clauseCount(flat, f); if (c !== 1) bad.push(c + ' copies of formula fragment: ' + f); }
    for (const [f, n] of STEMS_R) { const c = tokCount(flat, f); if (c !== n) bad.push(c + ' (want ' + n + ') of formula stem: ' + f); }
    // the default pools' share of the 2^32 default row (no layout part): 130*1024 + 8,456*257 + 2*256
    const pf = 'default pools alone are ' + pools + ' B';
    if (tokCount(flat, pf) !== 1) bad.push('want exactly one "' + pf + '"');
    const df = 'the 2^32 default row minus ' + commas(K_R) + ' minus the direct table 11 C = ' + commas(11 * 65536);
    if (clauseCount(flat, df) !== 1) bad.push('want exactly one "' + df + '"');
    if (tokCount(flat, 'C = ceil(U / 65536)') !== 1) bad.push('want exactly one C = ceil(U / 65536)');
    if (opts.snippet) {
        lineOnce(lines, /^\s+s\.paged;/, new RegExp('^\\s+s\\.paged;\\s+// ' + ROWS_R[0][6] + '$'), 'llms s.paged example', bad);
        lineOnce(lines, /^\s+s\.byteLength;/, new RegExp('^\\s+s\\.byteLength;\\s+// ' + ROWS_R[0][5] + '$'), 'llms s.byteLength example', bad);
    }
    return bad;
}

export const STALE_R_RE = /RoaringSet[^\n]*(?:\bqueued\b|\bv?0\.7\.0\b)|(?:\bqueued\b|\bv?0\.7\.0\b)[^\n]*RoaringSet/i;

export function staleRHits(text) {
    const hits = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) if (STALE_R_RE.test(lines[i])) hits.push(i + 1);
    return hits;
}

/**
 * staleRHits minus ONE line: the first line that EQUALS `exempt` exactly (README's one known B6d line). A prefix
 * match, an extended line, or a second identical line is still a hit; the rest must be [].
 */
export function staleRHitsExcept(text, exempt) {
    const lines = text.split('\n');
    let used = false;
    return staleRHits(text).filter((n) => {
        if (!used && exempt && lines[n - 1] === exempt) { used = true; return false; }
        return true;
    });
}

export const README_B6D_LINE = 'Later tiers (SegmentedU for wider keys, EliasFano, RoaringSet) are queued in [`ROADMAP.md`](./ROADMAP.md).';

/** The d.ts `export class RoaringSet` block (to the end of the text); null if absent. */
export function roaringDtsBlock(text) {
    const lines = text.split('\n');
    for (let i = 0; i + 1 < lines.length; i++) {
        if (lines[i] === '/**' && lines[i + 1] === ' * RoaringSet -- a compressed ordered set over a FIXED universe [0, U), 1 <= U <= 2^32,') return lines.slice(i).join('\n');
    }
    return null;
}

// --- the expected numbers themselves ------------------------------------------------

test('DocSync (R): the test-owned roaringBytes() / layout rule give the hand-computed table', () => {
    for (const [U, s, l, p, pb, bytes, paged] of ROWS_R) {
        const tag = 'U=' + U + ' (' + [s, l, p, pb].join(',') + ')';
        assert.equal(roaringBytes(U, s, l, p, pb), bytes, tag);
        assert.equal(roaringLayout(U, p, pb).paged, paged, tag);
    }
});

test('DocSync (R): formula == engine byteLength and engine paged == the C-5 rule (10 configs)',
    () => {
        for (const [U, s, l, p, pb, bytes, paged] of ROWS_R) {
            const tag = 'U=' + U + ' (' + [s, l, p, pb].join(',') + ')';
            const e = new RoaringSet(U, s, l, p, pb);
            assert.equal(e.byteLength, bytes, tag + ' byteLength');
            assert.equal(e.paged, paged, tag + ' paged');
        }
    });

// --- (c) space sync on the live files -------------------------------------------------

for (const f of ['README.md', 'llms.txt']) {
    test('DocSync (R c): ' + f + ' RoaringSet section carries the 10 byteLength rows', () => {
        const bad = roaringSpaceProblems(read(f), ROWS_R, { snippet: f === 'llms.txt' });
        assert.deepEqual(bad, [], f + ': ' + bad.join('; '));
    });
}

// --- (d) stale gate on the live files ---------------------------------------------------

for (const f of ['README.md', 'llms.txt', 'GUIDE.md', 'LogLogN.d.ts']) {
    // No exemption for any file: the old README "Later tiers (...RoaringSet) are queued" line is gone (see the must-fail control below).
    test('DocSync (R d): ' + f + ' never calls RoaringSet queued / 0.7.0', () => {
        const hits = staleRHitsExcept(read(f), '');
        assert.deepEqual(hits, [], f + ' stale line(s): ' + hits.join(', '));
    });
}

// --- (e) package.json + d.ts ----------------------------------------------------------------

test('DocSync (R e): package.json description names RoaringSet, keywords include roaring-bitmap', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(tokCount(pkg.description, 'RoaringSet') >= 1, 'description names RoaringSet');
    assert.equal(tokCount(pkg.description, 'RoaringSet: a compressed ordered set over a fixed universe up to 2^' + Math.log2(ORACLE.universe[1])), 1, 'description names the engine universe bound');
    assert.deepEqual(staleRHits(pkg.description), []);
    assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('roaring-bitmap'), 'keywords: roaring-bitmap');
});

/** d.ts RoaringSet block: K formula, the two layout formulas and the three 2^32 examples, each exactly once; no +24 value. */
export function dtsProblems(text) {
    const blk = roaringDtsBlock(text);
    if (blk === null) return ['no RoaringSet class comment'];
    const flat = blk.replace(/\n\s*\* ?/g, ' ').replace(/\s+/g, ' ');
    const bad = [];
    for (const f of [FORMULA_R[0], FORMULA_R[2]]) { const c = clauseCount(flat, f); if (c !== 1) bad.push(c + ' clause copies of: ' + f); }
    for (const f of ['C = ceil(U / 65536)', 'Examples (U = 2^32): default pools, direct 3,036,180; maxSmall 0 / maxLarge 1, direct 746,270, paged maxPages 1 31,524', 'DIRECT (11 B per chunk)', '11 B per row']) {
        const c = tokCount(flat, f);
        if (c !== 1) bad.push(c + ' copies of: ' + f);
    }
    for (const [f, n] of [['+ 11 C', 1], ['4 maxPages +', 1], ['8,460', 1]]) {
        const c = tokCount(flat, f);
        if (c !== n) bad.push(c + ' (want ' + n + ') of: ' + f);
    }
    for (const f of ['3,036,204', '746,294', '3036204']) if (tokCount(flat, f) !== 0) bad.push('pre-C-3 (+24) value ' + f);
    return bad;
}

test('DocSync (R e): the d.ts RoaringSet block carries K and the three 2^32 examples', () => {
    const bad = dtsProblems(read('LogLogN.d.ts'));
    assert.deepEqual(bad, [], 'LogLogN.d.ts: ' + bad.join('; '));
});

// --- must-fail fixtures (strings, same functions) ---------------------------------------------

const NOTE_R = { '184,942,592': ' (tie: 31,042 is not < 31,042)', '2^32|255': ' (722,430 is not < 720,896)' };
const rowLine = (r) => '| ' + r[7] + ' | ' + r[8] + ' | ' + (r[6] ? 'paged' : 'direct') +
    (NOTE_R[r[7]] || (r[3] === 255 ? NOTE_R['2^32|255'] : '')) + ' | ' + commas(r[5]) + ' B |';
const GOOD_R = '## API reference\n\n### vEBTree\n\nx\n\n### RoaringSet\n\n' +
    '    s.paged;                                      // false\n    s.byteLength;                                 // 3036180\n\n' +
    'direct = 8,460 + 11 C + 130 maxSmall + 8,456\n(maxLarge + 1) + 2 maxLarge; paged replaces 11 C by 11 (maxPages + 1) 2^pageBits\n+ 2 ceil(C / 2^pageBits) + 4 maxPages + 2; paged: 11 (maxPages + 1) 2^pageBits\n+ 2 ceil(C / 2^pageBits) + 4 maxPages + 2 < 11 C. C = ceil(U / 65536).\n\n' +
    '| U | cfg | layout | byteLength |\n| --- | --- | --- | --- |\n' + ROWS_R.map(rowLine).join('\n') +
    '\n\nThe default pools alone are ' + commas(ROWS_R[0][5] - K_R - 11 * 65536) + ' B (DETERMINISTIC: the 2^32 default row minus 8,460 minus the direct table 11 C = 720,896).\n\n### Next\n\nunrelated 999\n';
const rsp = (t) => roaringSpaceProblems(t, ROWS_R, { snippet: true });

test('DocSync fixtures (R): the good section passes', () => {
    assert.deepEqual(rsp(GOOD_R), []);
    assert.deepEqual(staleRHits(GOOD_R), []);
    assert.equal(ROWS_R[0][5] - K_R - 11 * 65536, 2306824); // 130*1024 + 8,456*257 + 2*256, by hand
    // llms-style tie note is accepted too
    assert.deepEqual(rsp(GOOD_R.replace('(tie: 31,042 is not < 31,042)', '(tie, strict <)')), []);
    // the snippet is only required when asked for (README has none)
    assert.deepEqual(roaringSpaceProblems(GOOD_R.replace(/ {4}s\.byteLength;[^\n]*\n/, '')), []);
    assert.equal(rsp(GOOD_R.replace(/ {4}s\.byteLength;[^\n]*\n/, '')).length, 1);
});

// [class, name, from, to] over GOOD_R: a = substring / prefix / longer formula, b = digit-extended, c = duplicated / stale copy beside
const ROW26 = '| 2^26 | (0, 1, 1, 8) | paged | 31,020 B |';
const FORM1 = 'direct = 8,460 + 11 C + 130 maxSmall + 8,456\n(maxLarge + 1) + 2 maxLarge;';
const FORM2 = '+ 2 ceil(C / 2^pageBits) + 4 maxPages + 2 < 11 C.';
const R_HOLES = [
    ['a', 'formula: prefixed word', 'direct = 8,460', 'direct = a8,460'],
    ['a', 'formula: longer word after', '2 maxLarge; paged replaces', '2 maxLargeX; paged replaces'],
    ['a', 'formula 2: longer formula', '< 11 C.', '< 11 Cx.'],
    ['a', 'formula 3: longer front', 'paged replaces 11 C by', 'xpaged replaces 11 C by'],
    ['a', 'row: trailing text', ROW26, ROW26 + ' extra'],
    ['a', 'row: unit word', '31,020 B |', '31,020 Bytes |'],
    ['a', 'row: label embedded', '| 2^26 | (0, 1, 1, 8) |', '| 2^265 | (0, 1, 1, 8) |'],
    ['a', 'snippet: prefix', '// 3036180', '// x3036180'],
    ['a', 'pools phrase: longer word', 'default pools alone are', 'default pools alone areX'],
    ['b', 'formula: K digit-extended', 'direct = 8,460', 'direct = 18,460'],
    ['b', 'formula: K comma-extended', 'direct = 8,460', 'direct = 8,4601'],
    ['b', 'formula 3: tail digit-extended', '+ 4 maxPages + 2;', '+ 4 maxPages + 20;'],
    ['b', 'formula 3: tail decimal', '+ 4 maxPages + 2;', '+ 4 maxPages + 2.5;'],
    ['b', 'formula 2: paged iff 111', '; paged: 11 (maxPages + 1)', '; paged: 111 (maxPages + 1)'],
    ['b', 'row: value digit-extended', '31,020 B |', '31,0201 B |'],
    ['b', 'row: value decimal', '31,020 B |', '31,020.5 B |'],
    ['b', 'row: value digit-prefixed', '| 31,524 B |', '| 131,524 B |'],
    ['b', 'row: tie note digit-extended', '31,042 is not < 31,042', '31,042 is not < 31,0421'],
    ['b', 'row: 722,430 note extended', '722,430 is not', '7722,430 is not'],
    ['b', 'snippet: 3036180 -> 30361805', '// 3036180', '// 30361805'],
    ['b', 'snippet: 3036180 -> 13036180', '// 3036180', '// 13036180'],
    ['b', 'pools figure digit-extended', '2,306,824 B (DETERMINISTIC', '2,306,8241 B (DETERMINISTIC'],
    ['b', '720,896 digit-extended', '= 720,896)', '= 720,8961)'],
    ['b', '720,896 comma-extended', '= 720,896)', '= 7,20,896)'],
    ['c', 'formula 1 duplicated', FORM1, FORM1 + '\n' + FORM1],
    ['c', 'stale formula 1 beside the right one', FORM1, 'direct = 8,484 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge;\n' + FORM1],
    ['c', 'formula 2 duplicated', FORM2, FORM2 + '\n' + FORM2],
    ['c', 'stale formula 3 beside the right one', FORM2, FORM2 + '\nOld: paged replaces 11 C by 11 (maxPages + 2) 2^pageBits + 2 ceil(C / 2^pageBits) + 4 maxPages + 3;'],
    ['c', 'row duplicated', ROW26, ROW26 + '\n' + ROW26],
    ['c', 'stale row beside the right one', ROW26, '| 2^26 | (0, 1, 1, 8) | paged | 31,021 B |\n' + ROW26],
    ['c', 'snippet duplicated', '    s.byteLength;                                 // 3036180', '    s.byteLength;                                 // 3036180\n    s.byteLength;                                 // 3036180'],
    ['c', 'snippet stale beside', '    s.byteLength;                                 // 3036180', '    s.byteLength;                                 // 3036181\n    s.byteLength;                                 // 3036180'],
    ['c', 'pools sentence duplicated', 'The default pools alone', 'The default pools alone are 2,306,824 B (DETERMINISTIC: the 2^32 default row minus 8,460 minus the direct table 11 C = 720,896). The default pools alone'],
    ['c', 'stale figure in prose', '### Next', 'Old: 3,036,204 B.\n\n### Next'],
    // r5 blocker 1: a term appended / prepended to a formula clause (anchored at clause edges)
    ['d', 'K clause: leading term', 'direct = 8,460', 'direct = 24 + 8,460'],
    ['d', 'K clause: trailing term', '2 maxLarge; paged replaces', '2 maxLarge + 24; paged replaces'],
    ['d', 'K clause: trailing maxSmall term', '2 maxLarge; paged replaces', '2 maxLarge + 24 maxSmall; paged replaces'],
    ['d', 'paged clause: tail term', '+ 4 maxPages + 2;', '+ 4 maxPages + 2 + 24;'],
    ['d', 'paged clause: front term', 'by 11 (maxPages + 1)', 'by 24 + 11 (maxPages + 1)'],
    ['d', 'rule: leading term', '; paged: 11 (maxPages + 1)', '; paged: 24 + 11 (maxPages + 1)'],
    ['d', 'rule: trailing term', '< 11 C.', '< 11 C + 1.'],
    ['d', 'pools phrase: trailing term', '= 720,896)', '= 720,896 + 24)'],
    ['d', 'pools phrase: leading term', '(DETERMINISTIC: the 2^32', '(DETERMINISTIC: 24 + the 2^32'],
    // r5 blockers 2-5: ungrouped / long-first-group figures, the byte unit per row, C = ceil(U / 65536), s.paged
    ['e', 'ungrouped stale figure', '### Next', 'Old default: 3036204 B.\n\n### Next'],
    ['e', 'long first group', '### Next', 'Old: 1131,604 B.\n\n### Next'],
    ['e', 'DIRECT 12 B per chunk', '### Next', 'DIRECT (12 B per chunk)\n\n### Next'],
    ['e', 'at 12 B per row', '### Next', 'at 12 B per row\n\n### Next'],
    ['f', 'extra table row (paged)', ROW26, ROW26 + '\n| 2^26 | (0, 1, 2, 8) | paged | 31,020 B |'],
    ['f', 'extra table row (direct)', ROW26, ROW26 + '\n| 2^26 | (0,1,1,8) | direct | 31,020 B |'],
    ['f', 'extra table row, key not in ROWS_R', ROW26, ROW26 + '\n| 2^32 | (0, 1, 2, 8) | direct | 746,270 B |'],
    ['g', 'C = ceil(U / 65535)', 'ceil(U / 65536)', 'ceil(U / 65535)'],
    ['g', 'C clause duplicated', 'C = ceil(U / 65536).', 'C = ceil(U / 65536). C = ceil(U / 65536).'],
    ['g', 's.paged -> true', '// false', '// true'],
    ['g', 's.paged line duplicated', '    s.paged; ', '    s.paged;                                      // false\n    s.paged; '],
];

test('DocSync fixtures (R): every hole class (substring / digit-extended / duplicated) flips the RoaringSet checks', () => {
    const seen = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 };
    for (const h of R_HOLES) {
        seen[h[0]]++;
        assert.ok(rsp(hole(GOOD_R, h)).length >= 1, 'survives [' + h[0] + ']: ' + h[1]);
    }
    seen.d = seen.d || 0;
    assert.ok(seen.a >= 6 && seen.b >= 6 && seen.c >= 6 && seen.d >= 8 && seen.e >= 4 && seen.f >= 3 && seen.g >= 3, JSON.stringify(seen));
});

test('DocSync fixtures (R e): every hole class flips the d.ts block check', () => {
    const D = '/**\n * RoaringSet -- a compressed ordered set over a FIXED universe [0, U), 1 <= U <= 2^32,\n * DIRECT (11 B per chunk) or PAGED (x, 11 B per row). byteLength (direct) =\n * 8,460 + 11 C + 130 maxSmall + 8,456 (maxLarge + 1) + 2 maxLarge, C =\n * ceil(U / 65536); paged replaces 11 C by 11 (maxPages + 1) 2^pageBits +\n * 2 ceil(C / 2^pageBits) + 4 maxPages + 2. Examples (U = 2^32): default pools,\n * direct 3,036,180; maxSmall 0 / maxLarge 1, direct 746,270, paged maxPages 1\n * 31,524.\n */\n';
    assert.deepEqual(dtsProblems(D), []);
    const holes = [
        ['a', 'prefixed', 'direct 746,270', 'direct x746,270'],
        ['a', 'longer word', '31,524.', '31,524x.'],
        ['b', 'digit-extended', 'direct 3,036,180;', 'direct 3,036,1805;'],
        ['b', 'K digit-extended', ' 8,460 + 11 C', ' 18,460 + 11 C'],
        ['b', 'decimal', '31,524.', '31,524.5.'],
        ['c', 'example duplicated', 'direct 746,270,', 'direct 746,270, direct 746,270,'],
        ['c', 'stale formula beside', 'ceil(U / 65536);', 'ceil(U / 65536); old 8,484 + 11 C + 130 maxSmall;'],
        ['c', 'stale +24 value beside', ' 31,524.', ' 31,524. Old: 3,036,204.'],
        ['d', 'K clause: leading term', '(direct) =\n * 8,460', '(direct) = 24 +\n * 8,460'],
        ['d', 'K clause: trailing term', '+ 2 maxLarge, C =', '+ 2 maxLarge + 24, C ='],
        ['d', 'paged clause: tail term', '+ 4 maxPages + 2. Examples', '+ 4 maxPages + 2 + 24. Examples'],
        ['e', 'C 65535', 'ceil(U / 65536)', 'ceil(U / 65535)'],
        ['e', 'example config label', 'Examples (U = 2^32)', 'Examples (U = 2^31)'],
        ['e', 'maxLarge label', 'maxLarge 1,', 'maxLarge 2,'],
        ['e', 'DIRECT 12 B per chunk', 'DIRECT (11 B', 'DIRECT (12 B'],
        ['e', '12 B per row', '11 B per row', '12 B per row'],
    ];
    for (const h of holes) assert.ok(dtsProblems(hole(D, h)).length >= 1, 'survives: ' + h[1]);
    assert.deepEqual(dtsProblems('/** nothing */'), ['no RoaringSet class comment']);
});

test('DocSync fixtures (R c, M7): a figure glued to a word is not a figure, a bare one is; the scan is anchored', () => {
    assert.deepEqual(rsp(GOOD_R.replace('### Next', 'k3036204 B\n\n### Next')), []); // glued: lookbehind (?<![\w,.]) leaves it alone
    assert.ok(rsp(GOOD_R.replace('### Next', 'k 3036204 B\n\n### Next')).length >= 1);
    assert.ok(rsp(GOOD_R.replace('### Next', '.3036204 B\n\n### Next')).length === 0); // dot-glued likewise
});

test('DocSync fixtures (R c): 2^25 (0,1,1) documented as 31,016 fails', () => {
    const p = rsp(GOOD_R.replace('31,006 B', '31,016 B'));
    assert.ok(p.length >= 1);
    assert.match(p[0], /2\^25/);
});

test('DocSync fixtures (R c): one changed digit, or a +24 (`_q` kept) value, fails', () => {
    assert.ok(rsp(GOOD_R.replace('3,036,180', '3,036,181')).length >= 1);
    assert.ok(rsp(GOOD_R.replace('3,036,180', '3,036,204')).length >= 1);
    assert.ok(rsp(GOOD_R.replace('| 31,524 B', '| 131,524 B')).length >= 1);
});

test('DocSync fixtures (R c): a missing section, a renamed heading, or rows after the next heading fail', () => {
    assert.deepEqual(roaringSpaceProblems('## API reference\n\n### vEBTree\n\nx\n'), ['no "### RoaringSet" section']);
    assert.ok(rsp(GOOD_R.replace('### RoaringSet', '### RoaringSet (0.6.0)')).length >= 1);
    const last = rowLine(ROWS_R[9]);
    assert.ok(GOOD_R.includes(last));
    assert.equal(rsp(GOOD_R.replace(last, '').replace('### Next', '### Next\n' + last)).length, 2); // missing row + 9 table rows, want 10
});

test('DocSync fixtures (R c): a row swap (2^25 <-> 2^26 values) fails', () => {
    const sw = GOOD_R.replace('| 2^25 | (0, 1, 1, 8) | direct | 31,006 B |', '| 2^25 | (0, 1, 1, 8) | direct | 31,020 B |')
        .replace('| 2^26 | (0, 1, 1, 8) | paged | 31,020 B |', '| 2^26 | (0, 1, 1, 8) | paged | 31,006 B |');
    assert.notEqual(sw, GOOD_R);
    assert.equal(rsp(sw).length, 2);
});

test('DocSync fixtures (R c): a layout-word swap fails', () => {
    const sw = GOOD_R.replace('| 2^26 | (0, 1, 1, 8) | paged |', '| 2^26 | (0, 1, 1, 8) | direct |');
    assert.notEqual(sw, GOOD_R);
    const p = rsp(sw);
    assert.equal(p.length, 1);
    assert.match(p[0], /layout word direct/);
});

test('DocSync fixtures (R c): a dropped duplicate-valued row fails (746,270 still appears elsewhere)', () => {
    const dropped = GOOD_R.replace(rowLine(ROWS_R[4]) + '\n', '');
    assert.notEqual(dropped, GOOD_R);
    assert.ok(dropped.includes('746,270 B'));
    const p = rsp(dropped);
    assert.equal(p.length, 2); // the missing row + 9 table rows, want 10
    assert.match(p[0], /\(0, 1, 255, 8\)/);
});

test('DocSync fixtures (R c): a changed formula (8,484, <=, maxPages + 2, 20; digit-extended) or lost pools figure fails', () => {
    assert.ok(rsp(GOOD_R.replace('8,460 + 11 C', '8,484 + 11 C')).length >= 1);
    assert.ok(rsp(GOOD_R.replace('< 11 C', '<= 11 C')).length >= 1);
    assert.ok(rsp(GOOD_R.replace('2,306,824 B', '2,306,848 B')).length >= 1);
    assert.ok(rsp(GOOD_R.replace('by 11 (maxPages + 1)', 'by 11 (maxPages + 2)')).length >= 1);
});

test('DocSync fixtures (R d): stale-line fixtures (no README exemption remains)', () => {
    const known = README_B6D_LINE;
    assert.deepEqual(staleRHitsExcept(known, README_B6D_LINE), []);
    assert.equal(staleRHitsExcept(known + '\nRoaringSet ships in 0.7.0', README_B6D_LINE).length, 1);
    assert.equal(staleRHitsExcept('Note: ' + known, README_B6D_LINE).length, 1);
    assert.equal(staleRHitsExcept(known + '\n' + known, README_B6D_LINE).length, 1);
    assert.equal(staleRHitsExcept(known + ' RoaringSet ships in 0.7.0', README_B6D_LINE).length, 1);
});

test('DocSync fixtures (R d): must-fail control -- the live README with the old "Later tiers ... RoaringSet ... queued" line put back gives >= 1 hit', () => {
    const readme = read('README.md');
    const NOW = 'Later tiers (SegmentedU for wider keys, EliasFano) are queued in [`ROADMAP.md`](./ROADMAP.md).';
    assert.equal(readme.split(NOW).length, 2, 'README anchor line present exactly once');
    assert.deepEqual(staleRHitsExcept(readme, ''), [], 'the live README is clean');
    assert.ok(staleRHitsExcept(readme.replace(NOW, README_B6D_LINE), '').length >= 1, 'the stale line would FAIL the unexempted gate');
});

test('DocSync fixtures (R d): STALE_R flags RoaringSet with queued / 0.7.0 in either order, not planned', () => {
    assert.equal(staleRHits('Later tiers (SegmentedU, EliasFano, RoaringSet) are queued in ROADMAP.md.').length, 1);
    assert.equal(staleRHits('queued: RoaringSet').length, 1);
    assert.equal(staleRHits('| RoaringSet | 0.7.0 |').length, 1);
    assert.equal(staleRHits('v0.7.0 adds RoaringSet').length, 1);
    assert.equal(staleRHits('rank / select are planned for RoaringSet R2').length, 0);
    assert.equal(staleRHits('RoaringSet ships in 0.6.0').length, 0);
    assert.equal(staleRHits('0.7.05 RoaringSet').length, 0);
});

test('DocSync fixtures (R e): the d.ts block finder rejects an old (+24) block', () => {
    const OLD = '/**\n * RoaringSet -- a compressed ordered set over a FIXED universe [0, U), 1 <= U <= 2^32,\n * 8,484 + 11 C ... direct 3,036,204\n */\n';
    const blk = roaringDtsBlock(OLD);
    assert.notEqual(blk, null);
    assert.equal(tokCount(blk, '8,460'), 0);
    assert.equal(tokCount(blk, '3,036,204'), 1);
    assert.ok(dtsProblems(OLD).length >= 1);
    assert.equal(roaringDtsBlock('/** nothing */'), null);
});

// =============================================================================
// C-26 (ruled 2026-11-05, maintainer, D-1; 0.6.0 G6-B6c r6): every number in the README / llms RoaringSet
// sections is ENGINE-derived or in the explicit ALLOW_R list below, each with a reason.
//  - knob bounds: parsed from the constructor's RangeError texts, then probed at limit -1 / limit / limit + 1;
//  - container thresholds: DEMOTE_SMALL / DEMOTE_BITMAP from the module text (data: URL import of a COPY of
//    LogLogN.js with an export line appended -- the file itself is never edited), the others (64, 4,096, 32 runs,
//    65,536 keys, 65th / 4,097th key) from dump() kinds while adding / deleting keys;
//  - byteLength figures and the 11 / 130 / 8,456 / 8,460 coefficients: from real byteLength differences;
//  - the llms snippet: replayed on the engine.
// LOGLOGN_DOCSYNC_ENGINE_TEXT (optional) points ONLY the data: URL text at another file (the oracle-mutant proof).
// =============================================================================

const ENGINE_TEXT_PATH = process.env.LOGLOGN_DOCSYNC_ENGINE_TEXT || join(REPO, 'LogLogN.js');

/** The private DEMOTE_* constants, via a data: URL import of the module TEXT plus one appended export line. */
export async function loadModuleConsts(path = ENGINE_TEXT_PATH) {
    const text = readFileSync(path, 'utf8');
    const url = 'data:text/javascript;base64,' + Buffer.from(text + '\nexport const __consts = { DEMOTE_SMALL, DEMOTE_BITMAP };\n').toString('base64');
    return (await import(url)).__consts;
}
const MODCONSTS = await loadModuleConsts();

const rmsg = (fn) => { try { fn(); } catch (e) { return e instanceof RangeError ? e.message : 'NOT-RANGE:' + e.message; } return null; };
const rbounds = (m) => { const x = /in \[(\d+), (2\^32|\d+)\]/.exec(m); return [Number(x[1]), x[2] === '2^32' ? 2 ** 32 : Number(x[2])]; };

/** Builds the engine oracle: values plus `facts` (description, boolean) proving each limit +- 1 on the live engine. */
export function buildOracle() {
    const O = { facts: [] };
    const fact = (d, b) => O.facts.push([d, b]);
    const B = (U, s, l, p, pb) => new RoaringSet(U, s, l, p, pb).byteLength;
    const knob = (name, bad, okAt) => {
        const m = rmsg(bad);
        const [lo, hi] = rbounds(m);
        O[name] = [lo, hi];
        if (lo > 0 || name === 'maxSmall') fact(name + ' rejects lo-1', rmsg(() => okAt(lo - 1)) !== null);
        fact(name + ' accepts lo', rmsg(() => okAt(lo)) === null);
        fact(name + ' rejects hi+1', rmsg(() => okAt(hi + 1)) !== null);
        return [lo, hi];
    };
    O.uniMsg = rmsg(() => new RoaringSet(0)).replace(/got .*$/, 'got ...');
    const [uLo, uHi] = knob('universe', () => new RoaringSet(0), (u) => new RoaringSet(u));
    fact('universe accepts hi (2^32)', rmsg(() => new RoaringSet(uHi)) === null);
    fact('no-arg constructor is a RangeError', rmsg(() => new RoaringSet()) !== null);
    const [, sHi] = knob('maxSmall', () => new RoaringSet(1, -1), (v) => new RoaringSet(1, v));
    fact('maxSmall accepts hi', rmsg(() => new RoaringSet(1, sHi)) === null);
    knob('maxLarge', () => new RoaringSet(1, 0, 0), (v) => new RoaringSet(1, 0, v)); // hi itself is 554 MB: only hi+1 (rejected pre-allocation) is probed
    const [, lHi0] = O.maxLarge;
    fact('maxLarge accepts hi (validation reaches the pageBits check; nothing allocated)', /RoaringSet pageBits /.test(rmsg(() => new RoaringSet(1, 0, lHi0, 1, 0)) || ''));
    const [, bHi] = knob('pageBits', () => new RoaringSet(1, 0, 1, 1, 0), (v) => new RoaringSet(1, 0, 1, 1, v));
    fact('pageBits accepts hi', rmsg(() => new RoaringSet(1, 0, 1, 1, bHi)) === null);
    const mp = rmsg(() => new RoaringSet(2 ** 32, 0, 1, 0));
    const mpm = /in \[(\d+), (\d+)\] for this universe/.exec(mp);
    O.maxPages = [Number(mpm[1]), Number(mpm[2])];
    O.mpMsg = mp.slice(mp.indexOf('maxPages must')).replace(/\[(\d+), \d+\]/, '[$1, N]').replace(/got .*$/, 'got ...');
    O.keyMsg = rmsg(() => new RoaringSet(7).add(-1)).replace(/, 7\)/, ', U)').replace(/got .*$/, 'got ...');
    O.arPageMsg = rmsg(() => new RoaringSet(2 ** 32, 0, 1, 1, 8).addRange(0, 2 ** 25)).replace(/needs \d+ new pages?, \d+ free of maxPages \d+/, 'needs N new page(s), F free of maxPages M');
    const z0 = new RoaringSet(7); z0.add(-0); fact('-0 aliases key 0', z0.has(0) && z0.size === 1 && Object.is(z0.min(), 0));
    fact('maxPages N == ceil(ceil(U / 65536) / 2^pageBits) for U = 2^32, pb 8', O.maxPages[1] === Math.ceil(Math.ceil(2 ** 32 / 65536) / 2 ** 8));
    fact('maxPages rejects 0', rmsg(() => new RoaringSet(2 ** 32, 0, 1, 0)) !== null);
    fact('maxPages accepts N', rmsg(() => new RoaringSet(2 ** 32, 0, 1, O.maxPages[1])) === null);
    fact('maxPages rejects N+1', rmsg(() => new RoaringSet(2 ** 32, 0, 1, O.maxPages[1] + 1)) !== null);
    // coefficients from byteLength differences
    O.perChunk = B(2 * 65536, 0, 1) - B(65536, 0, 1);
    O.chunkKeys = 65536;
    fact('chunk is 65536 keys: U 65536 and 1 cost the same, 65537 adds one chunk', B(65536, 0, 1) === B(1, 0, 1) && B(65537, 0, 1) - B(65536, 0, 1) === O.perChunk);
    O.perSmall = B(1, 1, 1) - B(1, 0, 1);
    O.perLarge = B(1, 0, 2) - B(1, 0, 1);
    O.K = B(1, 0, 1) - O.perChunk - O.perLarge - (O.perLarge - 2); // fixed part: 8,460 + 11 C + (8,456 (L + 1) + 2 L) at L = 1
    // defaults
    const d = B(65536);
    O.defSmall = (d - B(65536, 0)) / O.perSmall;
    O.defLarge = 1 + (d - O.defSmall * O.perSmall - B(65536, 0, 1)) / O.perLarge;
    O.defPageBits = [];
    for (let pb = 1; pb <= 15; pb++) if (B(2 ** 32, 0, 1, 1) === roaringBytes(2 ** 32, 0, 1, 1, pb)) O.defPageBits.push(pb);
    // container thresholds from dump() kinds (U = 65536, default pools)
    const s = new RoaringSet(65536);
    const kinds = [];
    for (let n = 1; n <= 4100; n++) { s.add(3 * (n - 1)); kinds[n] = s.dump().chunks[0].kind; }
    const run = (k) => { const ns = []; for (let n = 1; n <= 4100; n++) if (kinds[n] === k) ns.push(n); return [ns[0], ns[ns.length - 1], ns.length]; };
    O.single = run('single'); O.small = run('small'); O.array = run('array'); O.bitmap = run('bitmap');
    fact('kinds are contiguous ranges', O.single[2] === O.single[1] - O.single[0] + 1 && O.small[2] === O.small[1] - O.small[0] + 1 &&
        O.array[2] === O.array[1] - O.array[0] + 1 && O.bitmap[2] === O.bitmap[1] - O.bitmap[0] + 1);
    let k = 3 * 4099, kind0 = 'bitmap';
    O.demoteBitmap = O.demoteSmall = -1;
    for (let n = 4100; n > 0; n--, k -= 3) {
        s.delete(k);
        const c = s.dump().chunks[0];
        if (O.demoteBitmap < 0 && c.kind !== 'bitmap') O.demoteBitmap = c.count;
        if (O.demoteSmall < 0 && c.kind === 'small') { O.demoteSmall = c.count; break; }
    }
    O.smallRunsMax = 0;
    O.runsAfter = 0;
    for (let r = 8; r <= 40; r++) {
        const t = new RoaringSet(65536);
        for (let i = 0; i < r; i++) for (let j = 0; j < 10; j++) t.add(i * 100 + j);
        t.runOptimize();
        const c = t.dump().chunks[0];
        if (c.kind === 'smallRuns') O.smallRunsMax = r; else if (c.kind === 'runs' && !O.runsAfter) O.runsAfter = r;
    }
    const f = new RoaringSet(65536).addRange(0, 65536);
    const fc = f.dump().chunks[0];
    fact('keys 0..65535 are one FULL chunk of 65536 keys', fc.kind === 'full' && fc.count === 65536);
    // llms snippet replay (constants are the snippet's own arguments)
    const q = new RoaringSet(2 ** 32);
    O.snip = { paged: q.paged, bytes: q.byteLength };
    q.add(5).add(70); q.addRange(1000000, 2000000);
    O.snip.succ = q.successor(5); O.snip.pred = q.predecessor(70); O.snip.min = q.min(); O.snip.max = q.max();
    O.snip.bytesAfter = q.byteLength;
    return O;
}
const ORACLE = buildOracle();

// numbers that are not engine facts: token -> reason (the explicit allow-list of C-26)
export const ALLOW_R = {
    '2^31': 'V8 Smi / HeapNumber boxing threshold on Node (zero-box law), not an engine constant of RoaringSet',
    '2^30': 'V8 Smi threshold on a pointer-compressed engine (zero-box law) and the addRange no-box bound; REPORTED by the Zero-GC section',
    '2^pageBits': 'symbolic: the page row count of the knob',
    '0': 'literal zero: an inclusive lower index / bound ("0 <= lo"), "[0, U)"',
};

const pct = (n) => commas(n);
/** Phrases (exactly once each, flat text) a doc kind must carry, every number engine-derived. */
export function roaringPhrases(O, kind) {
    const [uLo] = O.universe, [sLo, sHi] = O.maxSmall, [lLo, lHi] = O.maxLarge, [bLo, bHi] = O.pageBits, [pLo] = O.maxPages;
    const dB = O.defPageBits[0], ck = pct(O.chunkKeys), cs = pct(O.chunkKeys).replace(',', ',');
    const tail = 'C = ceil(U / ' + O.chunkKeys + ')';
    const sm = O.small[0] + '..' + O.small[1], ar = pct(O.array[1]), sr = O.smallRunsMax;
    const common = [
        O.uniMsg, O.keyMsg, O.mpMsg, O.arPageMsg, '`-0` aliases key 0',
        'A returned key >= 2^31 (>= 2^30 on a pointer-compressed engine) may box a HeapNumber when the call is not inlined', // V8 boxing thresholds: gated as one phrase so a swap fails
        'DIRECT (' + O.perChunk + ' B per chunk)',
    ];
    if (kind === 'readme') return common.concat([
        '`universe` REQUIRED, an integer in [' + uLo + ', 2^32]. `maxSmall` [' + sLo + ', ' + sHi + '] (default ' + O.defSmall + '), `maxLarge` [' + lLo + ', ' + lHi +
            '] (default ' + O.defLarge + '), `pageBits` [' + bLo + ', ' + bHi + '] (default ' + dB + '), `maxPages` [' + pLo + ', ceil(C / 2^pageBits)] (default = all pages), ' + tail + '.',
        'integer, ' + uLo + ' .. 2^32, REQUIRED',
        'a SINGLE key (0 B), a small array (' + sm + ' keys), an array (up to ' + ar + ' keys), a bitmap, runs, small runs (<= ' + sr + ' runs) or FULL (all ' + ck + ' keys, 0 B)',
        'Each ' + ck + '-key chunk',
        'small runs when <= ' + sr + ' runs and a small slot is free', // the runOptimize rule's one numeric clause (README API row)
        'an array when it holds <= ' + ar + ' keys',
        'at ' + O.perChunk + ' B per row',
        'splitting a small-runs run past ' + sr + ' runs needs a large one',
        'Allocates nothing for bounds < 2^30; a bound >= 2^31 boxes at a non-inlined call site (as `has`)', // C-17 ruled text
    ]);
    return common.concat([
        'universe REQUIRED, an integer in [' + uLo + ', 2^32], else RangeError',
        'maxSmall = ' + O.defSmall + ', maxLarge = ' + O.defLarge + ', maxPages = all, pageBits = ' + dB + ')',
        'maxSmall [' + sLo + ', ' + sHi + '], maxLarge [' + lLo + ', ' + lHi + '], pageBits [' + bLo + ', ' + bHi + '], maxPages [' + pLo + ', ceil(C / 2^pageBits)] (' + tail + ')',
        'each ' + ck + '-key chunk is held in the container kind that fits its keys (SINGLE and FULL cost 0 B; small array ' + sm + ' keys; array up to ' + ar + '; bitmap; runs; small runs <= ' + sr + ' runs)',
        'a delete splitting a small-runs run past ' + sr + ' runs needs a large slot',
    ]);
}

/** llms snippet lines (regexes), values from the engine replay. */
export function snippetRes(O) {
    const S = O.snip, w = (paged) => (paged ? 'paged' : 'direct');
    const e = (x) => reEsc(String(x));
    return [
        /^ {4}import \{ RoaringSet \} from '@zakkster\/lite-loglogn';$/,
        new RegExp('^ {4}const s = new RoaringSet\\(2 \\*\\* 32\\);\\s+// universe \\[0, 2\\^32\\); default pools, ' + w(S.paged) + ' table$'),
        new RegExp('^ {4}s\\.paged;\\s+// ' + e(S.paged) + '$'),
        /^ {4}s\.add\(5\)\.add\(70\);\s+\/\/ chainable, idempotent$/,
        new RegExp('^ {4}s\\.addRange\\(1000000, 2000000\\);\\s+// keys 1000000 \\.\\. ' + e(S.max) + '$'),
        new RegExp('^ {4}s\\.successor\\(5\\);\\s+// ' + e(S.succ) + ' {3}\\(STRICT, > 5\\)$'),
        new RegExp('^ {4}s\\.predecessor\\(70\\);\\s+// ' + e(S.pred) + ' {4}\\(STRICT, < 70\\)$'),
        new RegExp('^ {4}s\\.min\\(\\); s\\.max\\(\\);\\s+// ' + e(S.min) + ' ' + e(S.max) + '$'),
        new RegExp('^ {4}s\\.byteLength;\\s+// ' + e(S.bytesAfter) + '$'),
    ];
}

const NUM_RE = /(?<!\w)\d+(?:[.,]\d+)*(?:\^\w+)?\w*/g;
/**
 * C-26 sweep over one doc's RoaringSet section: (1) every engine-derived phrase exactly once, (2) the llms snippet lines
 * (exact, in order) replayed from the engine, (3) after masking those, the byteLength table rows, the formulas and the pools
 * sentence, EVERY remaining number token must be in ALLOW_R.
 */
export function roaringNumberProblems(text, kind, O = ORACLE) {
    const sec = roaringSection(text);
    if (sec === null) return ['no "### RoaringSet" section'];
    const bad = [];
    let lines = sec.split('\n');
    const tblRe = /^\|.*\| [\d,.]+ B(?: \([^|]*\))? \|\s*$/;
    lines = lines.filter((l) => !tblRe.test(l));
    if (kind === 'llms') {
        const at = lines.findIndex((l) => l === '    import { RoaringSet } from \'@zakkster/lite-loglogn\';');
        const want = snippetRes(O);
        if (at < 0) bad.push('no llms snippet');
        else {
            want.forEach((re, i) => { if (!re.test(lines[at + i] || '')) bad.push('snippet line ' + (i + 1) + ' is not the engine-replayed one'); });
            lines.splice(at, want.length);
        }
    }
    let flat = lines.join('\n').replace(/\s+/g, ' ');
    const mask = (re) => { flat = flat.replace(re, ' '); };
    for (const p of roaringPhrases(O, kind)) {
        const c = tokCount(flat, p);
        if (c !== 1) bad.push(c + ' copies of: ' + p);
        mask(tokRe(p));
    }
    for (const f of FORMULA_R) mask(clauseRe(f));
    const pools = commas(ROWS_R[0][5] - K_R - 11 * 65536);
    const poolsE = commas(O.snip.bytes - O.K - O.perChunk * Math.ceil(2 ** 32 / O.chunkKeys)); // engine bytes at U = 2^32 minus K minus 11 C
    if (poolsE !== pools) bad.push('pools figure ' + pools + ' != engine-derived ' + poolsE);
    mask(tokRe('at U = 2^32 the default pools alone are ' + poolsE + ' B'));
    mask(clauseRe('the 2^32 default row minus ' + commas(K_R) + ' minus the direct table 11 C = ' + commas(11 * 65536)));
    mask(tokRe('C = ceil(U / 65536)'));
    mask(tokRe('RESEARCH.md 12.13')); // section reference, not a figure: masked here so a timing number cannot hide behind an allow-list entry
    for (const m of flat.match(NUM_RE) || []) if (!(m in ALLOW_R)) bad.push('unexplained number ' + m + ' (... ' + flat.slice(Math.max(0, flat.indexOf(m) - 30), flat.indexOf(m) + 20) + ')');
    return bad;
}

/** d.ts block: the demote / promote thresholds in the prose, from the module constants and the dump() probes. */
export function dtsThresholdProblems(text, O = ORACLE, C = MODCONSTS) {
    const blk = roaringDtsBlock(text);
    if (blk === null) return ['no RoaringSet class comment'];
    const flat = blk.replace(/\n\s*\* ?/g, ' ').replace(/\s+/g, ' ');
    const bad = [];
    for (const p of [
        'a small array moves to a large slot at its ' + (O.small[1] + 1) + 'th key',
        'when a delete leaves <= ' + C.DEMOTE_SMALL + ' keys and a small slot is free',
        'array promotes to a bitmap at its ' + commas(O.array[1] + 1) + 'th key',
        'a bitmap demotes when a delete leaves ' + commas(C.DEMOTE_BITMAP),
        'small array (' + O.small[0] + '..' + O.small[1] + ' keys', 'array (up to ' + commas(O.array[1]) + ' keys',
        'small runs (<= ' + O.smallRunsMax + ' runs', 'FULL (all ' + commas(O.chunkKeys) + ' keys, 0 B)',
    ]) if (tokCount(flat, p) !== 1) bad.push(tokCount(flat, p) + ' copies of: ' + p);
    return bad;
}

test('DocSync (C-26): every knob limit probes at -1 / 0 / +1 on the engine', () => {
    for (const [d, ok] of ORACLE.facts) assert.ok(ok, d);
    assert.deepEqual(ORACLE.universe, [1, 2 ** 32]);
    assert.deepEqual([ORACLE.maxSmall, ORACLE.maxLarge, ORACLE.pageBits], [[0, 65535], [1, 65534], [1, 15]]); // hand-written from SPEC C-4
    assert.deepEqual(ORACLE.maxPages, [1, 256]);
});

test('DocSync (C-26): coefficients, defaults and container thresholds are engine facts equal to the SPEC / module constants', () => {
    assert.deepEqual([ORACLE.perChunk, ORACLE.perSmall, ORACLE.perLarge, ORACLE.K], [11, 130, 8458, 8460]); // SPEC C-3
    assert.equal(ORACLE.perLarge, 8456 + 2);
    assert.deepEqual([ORACLE.defSmall, ORACLE.defLarge, ORACLE.defPageBits], [1024, 256, [8]]); // SPEC C-4
    assert.deepEqual([ORACLE.single.slice(0, 2), ORACLE.small.slice(0, 2), ORACLE.array.slice(0, 2), ORACLE.bitmap[0]], [[1, 1], [2, 64], [65, 4096], 4097]);
    assert.equal(ORACLE.smallRunsMax, 32);
    assert.equal(ORACLE.runsAfter, 33);
    assert.equal(ORACLE.demoteBitmap, MODCONSTS.DEMOTE_BITMAP);
    assert.equal(ORACLE.demoteSmall, MODCONSTS.DEMOTE_SMALL);
    assert.deepEqual([MODCONSTS.DEMOTE_SMALL, MODCONSTS.DEMOTE_BITMAP], [32, 2048]);
    assert.deepEqual(ORACLE.snip, { paged: false, bytes: 3036180, succ: 70, pred: 5, min: 5, max: 1999999, bytesAfter: 3036180 });
    assert.equal(ORACLE.snip.bytesAfter, ORACLE.snip.bytes); // pools are preallocated: addRange does not change byteLength
    assert.equal(ORACLE.snip.bytes, ROWS_R[0][5]);
    assert.equal(ORACLE.snip.paged, ROWS_R[0][6]);
    assert.equal(new RoaringSet(2 ** 16).byteLength, ROWS_R[8][5]);
});

for (const [f, kind] of [['README.md', 'readme'], ['llms.txt', 'llms']]) {
    test('DocSync (C-26): ' + f + ' RoaringSet section: engine-derived phrases, snippet, and no unexplained number', () => {
        const bad = roaringNumberProblems(read(f), kind);
        assert.deepEqual(bad, [], f + ': ' + bad.join('; '));
    });
}

test('DocSync (C-26): the d.ts block thresholds equal the module constants and the dump() probes', () => {
    const bad = dtsThresholdProblems(read('LogLogN.d.ts'));
    assert.deepEqual(bad, [], 'LogLogN.d.ts: ' + bad.join('; '));
});

test('DocSync (C-26 r7): the number sweep, the d.ts thresholds and the snippet replay each FAIL on a mutated doc (must-fail fixtures)', () => {
    // exactly one match inside the RoaringSet section (other sections repeat some phrases)
    const one = (t, a, b) => { const sec = roaringSection(t) || t; assert.equal(sec.split(a).length, 2, a); return t.replace(sec, sec.replace(a, b)); };
    const R = read('README.md'), L = read('llms.txt'), D = read('LogLogN.d.ts');
    // controls: the unmutated docs pass
    assert.deepEqual(roaringNumberProblems(R, 'readme'), []);
    assert.deepEqual(roaringNumberProblems(L, 'llms'), []);
    assert.deepEqual(dtsThresholdProblems(D), []);
    assert.ok(roaringNumberProblems(one(R, 'Promote / demote use hysteresis', '7 keys. Promote / demote use hysteresis'), 'readme').some((p) => /unexplained number 7 /.test(p)));
    assert.ok(roaringNumberProblems(one(R, '(default 1024)', '(default 1025)'), 'readme').length > 0);
    assert.ok(roaringNumberProblems(one(L, '// keys 1000000 .. 1999999', '// keys 1000000 .. 1999998'), 'llms').length > 0);
    assert.equal(roaringNumberProblems(one(L, "    import { RoaringSet } from '@zakkster/lite-loglogn';\n    const s = new RoaringSet", '    const s = new RoaringSet'), 'llms')[0], 'no llms snippet');
    assert.ok(dtsThresholdProblems(one(D, 'leaves 2,048', 'leaves 2,049')).length > 0);
    // glued numbers (NUM_RE must not skip a number that touches a word character)
    for (const g of ['66th key', '0x100 rows', 'about 4MB', '3e6 B']) {
        assert.ok(roaringNumberProblems(one(R, 'Promote / demote use hysteresis', g + '. Promote / demote use hysteresis'), 'readme').some((p) => /unexplained number /.test(p)), g);
    }
    // engine facts that used to hide behind ALLOW_R['1']: 0 <-> 1 swaps now fail
    assert.ok(roaringNumberProblems(one(R, 'an integer in [0, U)', 'an integer in [1, U)'), 'readme').length > 0);
    assert.ok(roaringNumberProblems(one(L, '-0` aliases key 0', '-0` aliases key 1'), 'llms').length > 0);
    // the deleted ALLOW_R['1']'s own role (no phrase covers a bare 1), and each 0 <-> 1 message phrase alone
    assert.ok(roaringNumberProblems(one(R, 'page 0 a shared zero page', 'page 1 a shared zero page'), 'readme').some((p) => /unexplained number 1 /.test(p)));
    assert.ok(roaringNumberProblems(one(L, '0 <= lo <= hi <= U; prechecks', '1 <= lo <= hi <= U; prechecks'), 'llms').some((p) => /unexplained number 1 /.test(p)));
    assert.ok(roaringNumberProblems(one(R, 'maxPages must be an integer in [1, N]', 'maxPages must be an integer in [0, N]'), 'readme').length > 0);
    assert.ok(roaringNumberProblems(one(R, 'key must be an integer in [0, U);', 'key must be an integer in [0, U];'), 'readme').length > 0);
    // C-17 ruled addRange text: a 2^30 <-> 2^31 swap fails
    assert.ok(roaringNumberProblems(one(R, 'Allocates nothing for bounds < 2^30;', 'Allocates nothing for bounds < 2^31;'), 'readme').length > 0);
    // boxing thresholds swapped
    assert.ok(roaringNumberProblems(one(R, 'key >= 2^31 (>= 2^30 on a pointer-compressed engine)', 'key >= 2^30 (>= 2^31 on a pointer-compressed engine)'), 'readme').length > 0);
});

test('DocSync (C-26): every ALLOW_R entry has a reason', () => {
    for (const [k, v] of Object.entries(ALLOW_R)) assert.ok(typeof v === 'string' && v.length > 10, k);
});

// vEBTree figures outside the API section (r5 nits): the deep-dive table rows and the "N B at U = L" prose
test('DocSync (C-26 nits): vEBTree figures in the README deep dive, headline prose and llms table are the S(w) ones', () => {
    for (const [f, text] of [['README.md', read('README.md')], ['llms.txt', read('llms.txt')]]) {
        let rows = 0;
        for (const line of text.split('\n')) {
            const m = /^\| (2|257|2\^16|2\^20|2\^24|2\^24 \+ 1|2\^28|2\^32) \| (\d+) \| ([\d,]+) B(?: \(([^)]*)\))?(?: \||$)/.exec(line);
            if (!m || /\(0, 1|defaults/.test(line)) continue;
            const i = VEB_LABELS.indexOf(m[1]), U = ROWS[i];
            assert.equal(m[2], String(32 - Math.clz32(U - 1)), f + ': w for ' + m[1]);
            assert.equal(m[3], commas(expectedBytes(U)), f + ': bytes for ' + m[1]);
            if (m[4] !== undefined) assert.equal(m[4], VEB_NOTES[m[1]], f + ': note for ' + m[1]);
            rows++;
        }
        assert.equal(rows, f === 'README.md' ? 16 : 8, f + ': vEBTree byteLength rows');
    }
    const r = read('README.md');
    const b16 = commas(expectedBytes(2 ** 16)), b32 = commas(expectedBytes(2 ** 32));
    assert.equal(tokCount(r, '(' + b16 + ' B at U = 2^16, ' + b32 + ' B at U = 2^32; table in its deep dive)'), 1);
    assert.equal(tokCount(r, '(' + b32 + ' B at U = 2^32)'), 1);
});
