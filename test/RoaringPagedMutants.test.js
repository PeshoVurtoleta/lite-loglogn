/**
 * @zakkster/lite-loglogn -- RoaringSet PAGED mutant suite (0.6.0 G2-B3, PLAN-roaringset-G2 task 6, A-3 must-fail;
 * SPEC C-13, C-20; DETERMINISTIC tier, no timing assertion).
 *
 * Every row is ONE single-anchor substitution on the TEXT of ../LogLogN.js (read at load), run through the paged
 * fuzz worker (test/_roaring-paged-worker.mjs: the mutant text AND its forced-paged build, each a base64 data:
 * URL, in a node:worker_threads Worker with a kill timer; a hang is a kill). An anchor whose count is not 1 FAILS
 * its row and its job never starts. A mutant that does not parse, or whose forced build cannot be cut (stage
 * 'force' / 'import'), is ABORT = row FAIL, never a kill. Every row must be KILLED by the paged fuzz (a FAIL row
 * of runPagedLane), never by an assert in this file.
 *
 * Rows: the 16 R0 rows of best-paged-mutants.mjs (its 17 minus `intersection uses this row` -> G3), anchors re-cut
 * on the live engine text (`throwRPages` is inline here; the zero-page row is `_addChunk`'s `m =`); + "no
 * exhaustion check" + "direct leaves `_dir` unassigned"; + the G2-B1 reviewer's M1..M12 that are not one of those
 * (M4 = no exhaustion check, M5 = page reset one row short, M6 = clear skips page reset, M8 = clear free order:
 * not repeated). TOTAL 26 rows, all must be killed (0 equivalents).
 *
 * Control: the UNMUTATED text through the same job, one per Worker lane (2 lanes), must come back with 0 FAIL rows.
 * Budget: the paged fuzz without G1's harness part (g: null): vc + bestp cases on the forced build at pb 6 / 8 /
 * 10 (+ 1 / 15, vc scenarios, kind rows), the real-module 2^32 page streams (B6 / B8 / B10), the mixed rows (M,
 * incl. the C-13 tie) and the full page pool (X). Census: LOGLOGN_MUT_CENSUS=1 prints `# census <id> <count>`
 * and starts no Worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startPagedJob, isKilled, describeKill } from './_roaring-paged-worker.mjs';
import { LANES } from './helpers/roaringPagedFuzz.mjs';

const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const CENSUS = process.env.LOGLOGN_MUT_CENSUS === '1';
const JOB = { lanes: LANES, opts: { g: null, vc: { seeds: 1, ops: 2000 }, streamOps: 20000, base: 0, floors: 'reduced' } };
const ROW_MS = 600000;
const POOL = 2;
const EXPECT_KILLED = 26;

const PAGE_THROW =
    "            if (this._pTop === 0) {\n" +
    "                throw new RangeError('[lite-loglogn] RoaringSet metadata page pool exhausted (maxPages ' + this._maxP +\n" +
    "                    '); increase maxPages at construction');\n" +
    "            }\n";
const PAGE_POP = '            pg = this._pFree[--this._pTop];\n';

// [id, what, from, to]
const ROWS = [
    // ---- R0 best-paged-mutants.mjs (16 of 17; `intersection uses this row` -> G3) ----
    ['vc-nofree', 'vc no page free', '        this._dir[d] = 0;\n        this._pageZero(pg);\n        this._pFree[this._pTop++] = pg;',
        '        this._dir[d] = d === -1 ? 0 : this._dir[d];'],
    ['vc-popfirst', 'vc page pop before exhaustion check', PAGE_THROW + PAGE_POP,
        PAGE_POP + PAGE_THROW.replace('if (this._pTop === 0) {', 'if (this._pTop < 0) {')],
    ['vc-cleardir', 'vc clear keeps dir', '            dir.fill(0);\n', ''],
    ['vc-clearorder', 'vc clear free order (= reviewer M8)', '            for (let i = 0; i < mP; i++) this._pFree[i] = mP - i;',
        '            for (let i = 0; i < mP; i++) this._pFree[i] = i + 1;'],
    ['vc-mask', 'vc mask off by one (pageBits <= 6)', '        this._pMask = paged ? (1 << pageBits) - 1 : 0;',
        '        this._pMask = paged ? (1 << pageBits) - 1 - (pageBits > 6 ? 0 : 1) : 0;'],
    ['vc-norelease', 'vc no page release on last-key delete', '            this._topClear(c);\n            this._pageRelease(c);\n',
        '            this._topClear(c);\n'],
    ['vc-fifo', 'vc FIFO free list (push)', '        this._pFree[this._pTop++] = pg;',
        '        this._pFree.copyWithin(1, 0, this._pTop); this._pFree[0] = pg; this._pTop++;'],
    ['vc-defshort', 'vc default maxPages short', '        if (maxPages === undefined) maxPages = dirLen;',
        '        if (maxPages === undefined) maxPages = dirLen > 4 ? dirLen - 1 : dirLen;'],
    ['bp-cmin', 'bestp page free keeps _cMin', '        this._cMin.fill(0, b, e);\n', ''],
    ['bp-cmax', 'bestp page free keeps _cMax', '        this._cMax.fill(0, b, e);\n', ''],
    ['bp-slot', 'bestp page free keeps _slot (SINGLE key)', '        this._slot.fill(0, b, e);\n', ''],
    ['bp-clearzero', 'bestp clear skips page reset (= reviewer M6)', '            for (let d = 0; d < dir.length; d++) if (dir[d] !== 0) this._pageZero(dir[d]);\n', ''],
    ['bp-zerorow', 'bestp new chunk written to the zero page', '        if (this._pSh !== 0) m = this._pageAcquire(c);\n',
        '        if (this._pSh !== 0) this._pageAcquire(c);\n'],
    ['bp-short', 'bestp page reset spans one row short (= reviewer M5)', '        const e = b + (1 << this._pSh);',
        '        const e = b + (1 << this._pSh) - 1;'],
    ['bp-succhdr', 'bestp successor cross-chunk header by chunk id',
        '        return ((c << 16) | this._chunkMin(this._mi(c))) >>> 0;\n    }\n\n    predecessor(x) {',
        '        return ((c << 16) | this._chunkMin(c)) >>> 0;\n    }\n\n    predecessor(x) {'],
    ['bp-nolive', 'bestp pLive not counted on a new chunk', '        this._pLive[pg]++;\n', ''],
    // ---- A-3 additions ----
    ['a3-noexh', 'no exhaustion check (= reviewer M4)', '            if (this._pTop === 0) {\n                throw', '            if (false) {\n                throw'],
    ['a3-nodir', 'direct leaves _dir unassigned', '        this._dir = new Uint16Array(paged ? dirLen : 0);',
        '        if (paged) this._dir = new Uint16Array(dirLen);'],
    // ---- G2-B1 reviewer M1..M12 not equivalent to a row above ----
    ['M1', 'reviewer M1 release skips _pageZero', '        this._pageZero(pg);\n        this._pFree[this._pTop++] = pg;',
        '        this._pFree[this._pTop++] = pg;'],
    ['M2', 'reviewer M2 FIFO pop', PAGE_POP, '            pg = this._pFree[0]; this._pFree.copyWithin(0, 1, this._pTop--);\n'],
    ['M3', 'reviewer M3 decision < -> <= (C-13 tie)', '4 * maxPages + 2 < 11 * chunks;', '4 * maxPages + 2 <= 11 * chunks;'],
    ['M7', 'reviewer M7 _pLive set to 1', '        this._pLive[pg]++;', '        this._pLive[pg] = 1;'],
    ['M9', 'reviewer M9 release keeps the dir entry', '        this._dir[d] = 0;\n        this._pageZero(pg);', '        this._pageZero(pg);'],
    ['M10', 'reviewer M10 _mi mask >> 1', '(this._dir[c >>> sh] << sh) | (c & this._pMask);', '(this._dir[c >>> sh] << sh) | (c & (this._pMask >> 1));'],
    ['M11', 'reviewer M11 constructor free order', 'for (let i = 0; i < this._pTop; i++) this._pFree[i] = maxPages - i;',
        'for (let i = 0; i < this._pTop; i++) this._pFree[i] = i + 1;'],
    ['M12', 'reviewer M12 SINGLE kind written before the page is mapped', '        if (this._pSh !== 0) m = this._pageAcquire(c);\n        this._kind[m] = 7;',
        '        this._kind[m] = 7;\n        if (this._pSh !== 0) m = this._pageAcquire(c);\n        this._kind[m] = 7;'],
];

const count = (s, a) => s.split(a).length - 1;
const COUNTS = ROWS.map((r) => count(SRC, r[2]));

function isAbort(r) {
    return r.error === null && r.result !== null && r.result.ok === false && (r.result.stage === 'force' || r.result.stage === 'import');
}
function isInternal(r) {
    return r.result !== null && r.result.ok === true && r.result.failures.some((f) => /^internal: /.test(f));
}

const controlP = [];
const rowP = ROWS.map(() => null);
if (!CENSUS) {
    const queue = [];
    for (let i = 0; i < POOL; i++) controlP.push(new Promise((res) => queue.push(() => startPagedJob(JOB, 'control ' + i, ROW_MS).then(res))));
    ROWS.forEach((row, i) => {
        if (COUNTS[i] !== 1) return;
        const src = SRC.replace(row[2], row[3]);
        rowP[i] = new Promise((res) => queue.push(() => startPagedJob({ ...JOB, src }, row[0], ROW_MS).then(res)));
    });
    let next = 0;
    const lane = async () => { while (next < queue.length) await queue[next++](); };
    for (let i = 0; i < POOL; i++) lane();
}

test('RoaringPagedMutants: every anchor occurs exactly once in ../LogLogN.js (census); ids unique', () => {
    const bad = [];
    ROWS.forEach((r, i) => {
        if (CENSUS) console.log('# census ' + r[0] + ' ' + COUNTS[i]);
        if (COUNTS[i] !== 1) bad.push(r[0] + ' anchor count ' + COUNTS[i]);
        if (r[2] === r[3]) bad.push(r[0] + ' is not a mutation');
    });
    assert.deepEqual(bad, []);
    assert.equal(new Set(ROWS.map((r) => r[0])).size, ROWS.length);
    assert.equal(ROWS.length, EXPECT_KILLED);
});

if (!CENSUS) {
    for (let i = 0; i < POOL; i++) {
        test('RoaringPagedMutants control (lane ' + i + '): the UNMUTATED text through the same job comes back clean', async () => {
            const r = await controlP[i];
            assert.equal(r.error, null, 'control error: ' + r.error);
            assert.ok(r.result !== null && r.result.ok === true, 'control did not run: ' + describeKill(r));
            assert.ok(!isInternal(r), 'control harness defect');
            assert.deepEqual(r.result.failures, []);
            assert.equal(isKilled(r), false);
            assert.ok(r.result.rows.length >= 60, 'control ran ' + r.result.rows.length + ' rows');
            console.log('# control ' + i + ': ' + r.result.rows.length + ' rows, in-worker ' + (r.result.wallMs / 1000).toFixed(1) + ' s');
        });
    }
    ROWS.forEach((row, i) => {
        test('RoaringPagedMutants ' + row[0] + ' ' + row[1] + ': KILLED by the paged fuzz', async () => {
            assert.equal(COUNTS[i], 1, row[0] + ' anchor count ' + COUNTS[i] + ' (want 1)');
            const r = await rowP[i];
            assert.ok(!isAbort(r), row[0] + ' ABORT: ' + describeKill(r));
            assert.ok(!isInternal(r), row[0] + ' harness defect (internal)');
            assert.ok(isKilled(r), row[0] + ' SURVIVED');
            console.log('# ' + row[0] + ' KILLED: ' + describeKill(r).slice(0, 220));
        });
    });
    test('RoaringPagedMutants totals: ' + EXPECT_KILLED + ' / ' + EXPECT_KILLED + ' killed, 0 equivalents', async () => {
        const rs = await Promise.all(rowP.map((p) => (p === null ? Promise.resolve(null) : p)));
        let killed = 0;
        rs.forEach((r) => { if (r !== null && !isAbort(r) && !isInternal(r) && isKilled(r)) killed++; });
        console.log('# RoaringPagedMutants killed ' + killed + ' / ' + ROWS.length);
        assert.equal(killed, EXPECT_KILLED);
    });
}
