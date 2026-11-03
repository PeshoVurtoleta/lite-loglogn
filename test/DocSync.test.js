/**
 * @zakkster/lite-loglogn -- doc sync gate (cold; reads text, builds one small
 * vEBTree per row).
 *
 *  (a) STALE: no shipped doc may call vEBTree "planned" (README.md, llms.txt,
 *      GUIDE.md, LogLogN.d.ts).
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
    for (const U of rows) {
        const v = commas(expectedBytes(U));
        // not part of a longer number (a leading digit / comma-group, or a trailing ",ddd")
        const re = new RegExp('(?<![\\d,])' + v + ' B\\b');
        if (!re.test(sec)) bad.push('U=' + U + ': ' + v + ' B missing');
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

// --- (b) space sync on the live files ------------------------------------------

for (const f of ['README.md', 'llms.txt']) {
    test('DocSync (b): ' + f + ' vEBTree section carries the 8 byteLength rows', () => {
        const bad = spaceProblems(read(f));
        assert.deepEqual(bad, [], f + ': ' + bad.join('; '));
    });
}

// --- must-fail fixtures (strings, same functions) -------------------------------

const GOOD = '## API reference\n\n### YFastTrie\n\nx\n\n### vEBTree\n\n| U | B |\n' +
    ROWS.map((U) => '| ' + U + ' | ' + commas(expectedBytes(U)) + ' B |').join('\n') +
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

test('DocSync fixtures (b): one changed digit flips the space sync', () => {
    const bad = GOOD.replace('131,604', '131,605');
    const p = spaceProblems(bad);
    assert.equal(p.length, 1);
    assert.match(p[0], /U=1048576/);
    // a value only inside a longer number does not count
    assert.equal(spaceProblems(GOOD.replace('| 4 B |', '| 14 B |')).length, 1);
});

test('DocSync fixtures (b): a missing section (or a renamed heading) flips the space sync', () => {
    assert.deepEqual(spaceProblems('## API reference\n\n### YFastTrie\n\nx\n'), ['no "### vEBTree" section']);
    assert.equal(spaceProblems(GOOD.replace('### vEBTree', '### vEBTree (0.5.0)')).length, 1);
    // rows placed after the next heading are outside the section
    assert.equal(spaceProblems(GOOD.replace('| 4294967296 | 539,500,592 B |', '').replace('### Next', '### Next\n539,500,592 B')).length, 1);
});
