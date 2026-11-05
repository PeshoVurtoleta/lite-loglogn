/**
 * @zakkster/lite-loglogn -- RoaringSet COUNT ledger (0.6.0 G4-B1, PLAN-roaringset-G4 tasks 1-3, ASSERTIONS
 * A-1 / A-2; DETERMINISTIC hard gate: typed-array reads / writes / moves, not timing, prove the cost model).
 *
 * test/_roaring-count-worker.mjs (header) swaps a counting Proxy into every own typed-array field ONLY around
 * the measured call, undoes every row exactly (sha1-checked) and checks every answer against a sorted model.
 * Both layouts at U = 2^32, pools (256, 16): DIRECT `new RoaringSet(2^32, 256, 16)` and PAGED
 * `new RoaringSet(2^32, 256, 16, 16, 8)` (maxPages 16: paged under SPEC C-5; the G4 <-> G2 seam).
 *
 * Two independent literal sets, neither read back from the engine (SPEC C-9: cut from the R0 DRAFTS):
 *   LEDGER -- the exact per-field reads / writes / moves of every row, cut by the worker's CUT mode from
 *             R/RoaringDraft.best.mjs (fd261191) and R/RoaringDraft.best-paged.mjs (8a1b4667), `_q` excluded
 *             (.handoff/evidence/roaring-g4-ledger-cut.md; every row's reads == the R0 worst in
 *             R/logs/u1-best.json / u1-bestp.json, or the sweep value for a hill-climb row).
 *   HAND   -- the planner's read totals (PROPOSAL 2.3 / PLAN A-1 / A-2), typed by hand; checked against
 *             LEDGER (the two sets agree) and against the engine.
 * Rows: has / successor / predecessor / min / max on singleton, small-64, full-4096, bmp-4097,
 * bmp-poles-4098, full-65536, runs-2048 (at the R0 worst argument); min / max on empty; the conversion rows
 * (65th add, 4,097th add, bitmap delete of `_cMax` / `_cMin`, FULL delete, singleton delete (paged: page
 * free), runs-2048 add spill, run-split delete spill). No addRange / runOptimize rows (SPEC C-12).
 * Paged cost: every non-empty row reads +1..+4 over direct (u1-bestp); empty rows 0 / 0.
 *
 * Must-fail mutants (anchor replaced exactly once in the live LogLogN.js text, loaded by data: URL in a
 * Worker under a kill timer; a mutant that PASSES fails the test): M-w (an extra `_card` write in add),
 * M-mv (an extra 1-element copyWithin in delete), M-cache (successor reads through a local cached at its top:
 * +1 read), M-hasReject (the dropped V-d has early reject: +2 header reads), M-view (has reads a bitmap word
 * through `.subarray`, an uncounted view: a Meter FAIL). A clean-engine control through the same data: URL
 * path PASSES.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { ROWS, readsOf, Meter, fmtCounts, measureRow } from './_roaring-count-worker.mjs';

const T = { timeout: 120000 };
const HANG_MS = 100000;
const MUTANT_MS = 60000;

const WORKER_URL = new URL('./_roaring-count-worker.mjs', import.meta.url);
const SRC_TEXT = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');

const U32 = 4294967296;
const LAYOUTS = ['direct', 'paged'];
const JOBS = [
    { layout: 'direct', args: [U32, 256, 16] },
    { layout: 'paged', args: [U32, 256, 16, 16, 8] },
];

// LEDGER: id -> [direct, paged]; 'r<reads> field:n .. | w<writes> .. | m<moves> ..' (cut from the drafts)
const LEDGER = {
    'singleton has c7:0': [
        'r2 _kind:1 _slot:1 | w0 | m0',
        'r3 _dir:1 _kind:1 _slot:1 | w0 | m0'],
    'singleton successor c7:12345': [
        'r6 _top:4 _kind:1 _cMax:1 | w0 | m0',
        'r7 _top:4 _dir:1 _kind:1 _cMax:1 | w0 | m0'],
    'singleton predecessor c65534:0': [
        'r9 _top:7 _kind:1 _cMax:1 | w0 | m0',
        'r11 _top:7 _dir:2 _kind:1 _cMax:1 | w0 | m0'],
    'singleton min': [
        'r5 _top:4 _cMin:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMin:1 | w0 | m0'],
    'singleton max': [
        'r5 _top:4 _cMax:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMax:1 | w0 | m0'],
    'singleton delete c7:12345': [
        'r6 _top:4 _kind:1 _slot:1 | w5 _top:4 _kind:1 | m0',
        'r9 _top:4 _dir:2 _pLive:1 _kind:1 _slot:1 | w8 _top:4 _dir:1 _pLive:1 _pFree:1 _kind:1 | m768 _slot:256 _cMin:256 _cMax:256'],
    'small-64 has c7:0': [
        'r11 _kind:1 _slot:1 _card:1 _sData:8 | w0 | m0',
        'r12 _dir:1 _kind:1 _slot:1 _card:1 _sData:8 | w0 | m0'],
    'small-64 successor c7:31': [
        'r13 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _sData:8 | w0 | m0',
        'r14 _dir:1 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _sData:8 | w0 | m0'],
    'small-64 predecessor c7:31': [
        'r14 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _sData:9 | w0 | m0',
        'r15 _dir:1 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _sData:9 | w0 | m0'],
    'small-64 min': [
        'r5 _top:4 _cMin:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMin:1 | w0 | m0'],
    'small-64 max': [
        'r5 _top:4 _cMax:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMax:1 | w0 | m0'],
    'small-64 add c7:0': [
        'r76 _kind:1 _slot:1 _card:1 _sData:72 _lFree:1 | w70 _kind:1 _slot:1 _card:1 _cMin:1 _sFree:1 _lU16:65 | m0',
        'r77 _dir:1 _kind:1 _slot:1 _card:1 _sData:72 _lFree:1 | w70 _kind:1 _slot:1 _card:1 _cMin:1 _sFree:1 _lU16:65 | m0'],
    'full-4096 has c7:0': [
        'r17 _kind:1 _slot:1 _card:1 _lU16:14 | w0 | m0',
        'r18 _dir:1 _kind:1 _slot:1 _card:1 _lU16:14 | w0 | m0'],
    'full-4096 successor c7:3': [
        'r19 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU16:14 | w0 | m0',
        'r20 _dir:1 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU16:14 | w0 | m0'],
    'full-4096 predecessor c7:18': [
        'r20 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU16:15 | w0 | m0',
        'r21 _dir:1 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU16:15 | w0 | m0'],
    'full-4096 min': [
        'r5 _top:4 _cMin:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMin:1 | w0 | m0'],
    'full-4096 max': [
        'r5 _top:4 _cMax:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMax:1 | w0 | m0'],
    'full-4096 add c7:4': [
        'r4117 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU16:4111 _lU32:1 | w2118 _kind:1 _slot:1 _card:1 _lU32:2049 _bSum:66 | m2114 _lU32:2048 _bSum:66',
        'r4118 _dir:1 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU16:4111 _lU32:1 | w2118 _kind:1 _slot:1 _card:1 _lU32:2049 _bSum:66 | m2114 _lU32:2048 _bSum:66'],
    'bmp-4097 has c7:0': [
        'r3 _kind:1 _slot:1 _lU32:1 | w0 | m0',
        'r4 _dir:1 _kind:1 _slot:1 _lU32:1 | w0 | m0'],
    'bmp-4097 successor c7:4126': [
        'r7 _kind:1 _slot:1 _cMin:1 _cMax:1 _lU32:2 _bSum:1 | w0 | m0',
        'r8 _dir:1 _kind:1 _slot:1 _cMin:1 _cMax:1 _lU32:2 _bSum:1 | w0 | m0'],
    'bmp-4097 predecessor c65534:0': [
        'r9 _top:7 _kind:1 _cMax:1 | w0 | m0',
        'r11 _top:7 _dir:2 _kind:1 _cMax:1 | w0 | m0'],
    'bmp-4097 min': [
        'r5 _top:4 _cMin:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMin:1 | w0 | m0'],
    'bmp-4097 max': [
        'r5 _top:4 _cMax:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMax:1 | w0 | m0'],
    'bmp-4097 delete c7:65520': [
        'r7 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU32:2 | w3 _card:1 _cMax:1 _lU32:1 | m0',
        'r8 _dir:1 _kind:1 _slot:1 _card:1 _cMin:1 _cMax:1 _lU32:2 | w3 _card:1 _cMax:1 _lU32:1 | m0'],
    'bmp-4097 delete c7:0': [
        'r6 _kind:1 _slot:1 _card:1 _cMin:1 _lU32:2 | w3 _card:1 _cMin:1 _lU32:1 | m0',
        'r7 _dir:1 _kind:1 _slot:1 _card:1 _cMin:1 _lU32:2 | w3 _card:1 _cMin:1 _lU32:1 | m0'],
    'bmp-poles-4098 has c7:0': [
        'r3 _kind:1 _slot:1 _lU32:1 | w0 | m0',
        'r4 _dir:1 _kind:1 _slot:1 _lU32:1 | w0 | m0'],
    'bmp-poles-4098 successor c7:4095': [
        'r10 _kind:1 _slot:1 _cMin:1 _cMax:1 _lU32:2 _bSum:4 | w0 | m0',
        'r11 _dir:1 _kind:1 _slot:1 _cMin:1 _cMax:1 _lU32:2 _bSum:4 | w0 | m0'],
    'bmp-poles-4098 predecessor c7:63486': [
        'r10 _kind:1 _slot:1 _cMin:1 _cMax:1 _lU32:2 _bSum:4 | w0 | m0',
        'r11 _dir:1 _kind:1 _slot:1 _cMin:1 _cMax:1 _lU32:2 _bSum:4 | w0 | m0'],
    'bmp-poles-4098 predecessor c65534:0': [
        'r9 _top:7 _kind:1 _cMax:1 | w0 | m0',
        'r11 _top:7 _dir:2 _kind:1 _cMax:1 | w0 | m0'],
    'bmp-poles-4098 min': [
        'r5 _top:4 _cMin:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMin:1 | w0 | m0'],
    'bmp-poles-4098 max': [
        'r5 _top:4 _cMax:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMax:1 | w0 | m0'],
    'full-65536 has c7:0': [
        'r1 _kind:1 | w0 | m0',
        'r2 _dir:1 _kind:1 | w0 | m0'],
    'full-65536 successor c7:65535': [
        'r5 _top:4 _kind:1 | w0 | m0',
        'r6 _top:4 _dir:1 _kind:1 | w0 | m0'],
    'full-65536 predecessor c65534:0': [
        'r9 _top:7 _kind:1 _cMax:1 | w0 | m0',
        'r11 _top:7 _dir:2 _kind:1 _cMax:1 | w0 | m0'],
    'full-65536 min': [
        'r5 _top:4 _cMin:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMin:1 | w0 | m0'],
    'full-65536 max': [
        'r5 _top:4 _cMax:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMax:1 | w0 | m0'],
    'full-65536 delete c7:0': [
        'r3 _kind:1 _slot:1 _sFree:1 | w7 _kind:1 _slot:1 _card:1 _runs:1 _cMin:1 _sData:2 | m0',
        'r4 _dir:1 _kind:1 _slot:1 _sFree:1 | w7 _kind:1 _slot:1 _card:1 _runs:1 _cMin:1 _sData:2 | m0'],
    'runs-2048 has c7:0': [
        'r28 _kind:1 _slot:1 _runs:1 _lU16:25 | w0 | m0',
        'r29 _dir:1 _kind:1 _slot:1 _runs:1 _lU16:25 | w0 | m0'],
    'runs-2048 successor c7:0': [
        'r30 _kind:1 _slot:1 _runs:1 _cMin:1 _cMax:1 _lU16:25 | w0 | m0',
        'r31 _dir:1 _kind:1 _slot:1 _runs:1 _cMin:1 _cMax:1 _lU16:25 | w0 | m0'],
    'runs-2048 predecessor c7:31': [
        'r32 _kind:1 _slot:1 _runs:1 _cMin:1 _cMax:1 _lU16:27 | w0 | m0',
        'r33 _dir:1 _kind:1 _slot:1 _runs:1 _cMin:1 _cMax:1 _lU16:27 | w0 | m0'],
    'runs-2048 min': [
        'r5 _top:4 _cMin:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMin:1 | w0 | m0'],
    'runs-2048 max': [
        'r5 _top:4 _cMax:1 | w0 | m0',
        'r6 _top:4 _dir:1 _cMax:1 | w0 | m0'],
    'runs-2048 add c7:60204': [
        'r6177 _kind:1 _slot:2 _card:1 _runs:2 _lU16:4122 _lU32:2049 | w2119 _kind:1 _slot:1 _card:1 _runs:1 _lU32:2049 _bSum:66 | m2114 _lU32:2048 _bSum:66',
        'r6178 _dir:1 _kind:1 _slot:2 _card:1 _runs:2 _lU16:4122 _lU32:2049 | w2119 _kind:1 _slot:1 _card:1 _runs:1 _lU32:2049 _bSum:66 | m2114 _lU32:2048 _bSum:66'],
    'runs-2048 delete c7:1': [
        'r6178 _kind:1 _slot:2 _card:2 _runs:2 _lU16:4122 _lU32:2049 | w2119 _kind:1 _slot:1 _card:1 _runs:1 _lU32:2049 _bSum:66 | m2114 _lU32:2048 _bSum:66',
        'r6179 _dir:1 _kind:1 _slot:2 _card:2 _runs:2 _lU16:4122 _lU32:2049 | w2119 _kind:1 _slot:1 _card:1 _runs:1 _lU32:2049 _bSum:66 | m2114 _lU32:2048 _bSum:66'],
    'empty min': [
        'r0 | w0 | m0',
        'r0 | w0 | m0'],
    'empty max': [
        'r0 | w0 | m0',
        'r0 | w0 | m0'],
};

// HAND: the planner's read totals [direct, paged] (PROPOSAL 2.3, PLAN A-1 / A-2); null = not stated there
const HAND = {
    'singleton has c7:0': [2, 3],
    'small-64 has c7:0': [11, 12],
    'full-4096 has c7:0': [17, 18],
    'bmp-4097 has c7:0': [3, 4],
    'full-65536 has c7:0': [1, 2],
    'runs-2048 has c7:0': [28, 29],
    'small-64 successor c7:31': [13, 14],
    'full-4096 successor c7:3': [19, 20],
    'runs-2048 successor c7:0': [30, 31],
    'small-64 predecessor c7:31': [14, 15],
    'full-4096 predecessor c7:18': [20, 21],
    'runs-2048 predecessor c7:31': [32, 33],
    'bmp-poles-4098 successor c7:4095': [10, null],
    'bmp-poles-4098 predecessor c7:63486': [10, null],
    'full-4096 add c7:4': [4117, 4118],
    'empty min': [0, 0],
    'empty max': [0, 0],
};
for (const s of ['singleton', 'small-64', 'full-4096', 'bmp-4097', 'bmp-poles-4098', 'full-65536', 'runs-2048']) {
    HAND[s + ' min'] = [5, 6];
    HAND[s + ' max'] = [5, 6];
}

/**
 * Runs a worker; NEVER rejects. Resolves { parts, error, early }: error on a hang (terminated after ms), a
 * worker error or a nonzero exit; with stopOnFail the first phase that posts fails terminates the worker.
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

function countJob(src, ms, label) {
    return runWorker(WORKER_URL, { workerData: { roaringCountJob: true, src, jobs: JOBS } }, ms, label, false);
}

/** Every row of a posted layout part vs LEDGER: mismatch lines '<layout> <id>: got '..' want '..''. */
function ledgerDiff(part, layout) {
    const li = LAYOUTS.indexOf(layout);
    const got = new Map(part.rows.map((r) => [r.id, r.s]));
    const out = [];
    for (const r of ROWS) {
        const g = got.get(r.id);
        const want = LEDGER[r.id][li];
        if (g !== want) out.push(layout + ' ' + r.id + ": got '" + g + "' want '" + want + "'");
    }
    if (part.rows.length !== ROWS.length) out.push(layout + ' rows ' + part.rows.length + ' != ' + ROWS.length);
    return out;
}

const LIVE = countJob(null, HANG_MS, 'live engine');

async function livePart(layout) {
    const r = await LIVE;
    const part = r.parts[layout];
    assert.ok(part !== undefined, 'layout ' + layout + ' posted no result' + (r.error !== null ? ' (' + r.error + ')' : ''));
    assert.equal(r.error, null, String(r.error));
    return part;
}

// --- mutants (each must FAIL) ----------------------------------------------------------------------------------

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
    '        const c = x >>> 16;\n        const m = this._mi(c);\n        const lo = x & 0xFFFF;\n        const k = this._kind[m];\n';
const DEL_HEAD = '    delete(x) {\n        if (typeof x !== \'number\' || (x >>> 0) !== x || x >= this._u) return false;\n' +
    '        const c = x >>> 16;\n        const m = this._mi(c);\n';
const SUCC_HEAD = '        if (this._size === 0 || x + 1 >= this._u) return undefined;\n        const q = x + 1;\n';
const HAS_MID = '        if (k === 6) return true;\n        const lo = x & 0xFFFF;\n        const slot = this._slot[m];\n' +
    '        if (k === 7) return slot === lo;\n';
const HAS_BMP = '            return (this._lU32[(slot << 11) + (lo >>> 5)] & (1 << (lo & 31))) !== 0;\n';

const MUTANTS = {
    // add: an extra `_card` self-write after the `_kind` read (every add row: +1 read, +1 write; u1-teeth `w`)
    w: {
        edits: [[ADD_HEAD, ADD_HEAD + '        this._card[m] = this._card[m];\n']],
        want: /^direct full-4096 add c7:4: got 'r4118 .*_card:2 .*\| w2119 /,
    },
    // delete: an extra 1-element copyWithin on `_lU16` after the key check (every delete row: +1 move; `mv`)
    mv: {
        edits: [[DEL_HEAD, DEL_HEAD.replace('return false;\n', 'return false;\n        this._lU16.copyWithin(0, 0, 1);\n')]],
        want: /^direct singleton delete c7:12345: got '.* \| m1 _lU16:1'/,
    },
    // successor: a typed array cached in a local at the top + one extra read through it (+1 read; `cache`)
    cache: {
        edits: [[SUCC_HEAD, SUCC_HEAD.replace('return undefined;\n', 'return undefined;\n        const t0 = this._lU16;\n' +
            '        if (t0[0] === 65536) return undefined;\n')]],
        want: /^direct small-64 successor c7:31: got 'r14 /,
    },
    // has: the V-d early reject outside [_cMin, _cMax] that R0 dropped (+2 header reads on an in-range search)
    hasReject: {
        edits: [[HAS_MID, HAS_MID.replace('        const slot', '        if (k !== 3 && (lo < this._cMin[m] || lo > this._cMax[m])) return false;\n        const slot')]],
        want: /^direct runs-2048 has c7:0: got 'r30 _kind:1 _slot:1 _runs:1 _cMin:1 _cMax:1 _lU16:25 \|/,
    },
    // has: a bitmap word read through `.subarray` (an uncounted view): the Meter fails the row
    view: {
        edits: [[HAS_BMP, '            return (this._lU32.subarray(slot << 11)[lo >>> 5] & (1 << (lo & 31))) !== 0;\n']],
        want: /FAIL method _lU32\.subarray read through a counted field/,
    },
};

/** PASS / FAIL / TIMEOUT / ERROR of a mutant-path run + its fail / mismatch lines. */
function verdict(r) {
    const fails = [];
    for (const k of Object.keys(r.parts)) fails.push(...r.parts[k].fails);
    for (const l of LAYOUTS) if (r.parts[l] !== undefined) fails.push(...ledgerDiff(r.parts[l], l));
    if (r.error !== null && /^hang > /.test(r.error)) return { v: 'TIMEOUT', fails };
    if (r.error !== null) return { v: 'ERROR', fails, error: r.error };
    if (fails.length > 0) return { v: 'FAIL', fails };
    for (const l of LAYOUTS) if (r.parts[l] === undefined) return { v: 'ERROR', fails, error: 'missing layout ' + l };
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
    MJOBS[name] = countJob(src, MUTANT_MS, 'mutant ' + name);
}
const CLEAN = countJob('data:text/javascript;base64,' + Buffer.from(SRC_TEXT).toString('base64'), MUTANT_MS, 'clean data: control');

// --- static: the two literal sets -----------------------------------------------------------------------------

test('LEDGER holds exactly one [direct, paged] literal per ROW; no addRange / runOptimize row (SPEC C-12)', () => {
    const ids = ROWS.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'ROW ids unique');
    assert.deepEqual(Object.keys(LEDGER).slice().sort(), ids.slice().sort());
    for (const id of ids) {
        assert.equal(LEDGER[id].length, 2, id);
        for (const s of LEDGER[id]) assert.match(s, /^r\d+( _\w+:\d+)* \| w\d+( _\w+:\d+)* \| m\d+( _\w+:\d+)*$/, id);
    }
    for (const r of ROWS) assert.ok(['has', 'add', 'delete', 'successor', 'predecessor', 'min', 'max'].includes(r.op), r.id);
    assert.equal(ids.length, 46);
});

test('HAND (PROPOSAL 2.3 / A-1 / A-2 read totals) == LEDGER read totals; A-2 field and move cells', () => {
    let n = 0;
    for (const [id, pair] of Object.entries(HAND)) {
        assert.ok(LEDGER[id] !== undefined, 'HAND row ' + id + ' is a ROW');
        for (let i = 0; i < 2; i++) {
            if (pair[i] === null) continue;
            assert.equal(readsOf(LEDGER[id][i]), pair[i], LAYOUTS[i] + ' ' + id);
            n++;
        }
    }
    assert.equal(n, 60, 'HAND cells checked');
    // A-2: the bmp-poles-4098 in-chunk bitmap searches read `_lU32` 2 + `_bSum` 4; singleton delete moves 0 / 768
    for (const id of ['bmp-poles-4098 successor c7:4095', 'bmp-poles-4098 predecessor c7:63486']) {
        for (const s of LEDGER[id]) assert.match(s, / _lU32:2 _bSum:4 \|/, id);
    }
    assert.match(LEDGER['singleton delete c7:12345'][0], / \| m0$/);
    assert.match(LEDGER['singleton delete c7:12345'][1], / \| m768 _slot:256 _cMin:256 _cMax:256$/);
});

test('LEDGER paged read cost: +1..+4 over direct on every non-empty row; empty rows 0 / 0 (u1-bestp, G4 <-> G2 seam)', () => {
    for (const r of ROWS) {
        const d = readsOf(LEDGER[r.id][0]);
        const p = readsOf(LEDGER[r.id][1]);
        if (r.shape === 'empty') assert.deepEqual([d, p], [0, 0], r.id);
        else assert.ok(p - d >= 1 && p - d <= 4, r.id + ': paged ' + p + ' - direct ' + d);
    }
});

// --- the live engine --------------------------------------------------------------------------------------------

for (const layout of LAYOUTS) {
    test('live engine, ' + layout + ': every row == LEDGER (reads / writes / moves per field), answers == model, undo exact', T, async (t) => {
        const part = await livePart(layout);
        assert.deepEqual(part.fails, [], 'worker fails (answers, undo sha1, Meter, paged flag)');
        assert.equal(part.paged, layout === 'paged', 'inst.paged');
        assert.ok(!part.fields.includes('_q'), 'the shipped engine owns no `_q` (SPEC C-3)');
        const diff = ledgerDiff(part, layout);
        assert.deepEqual(diff, [], diff.slice(0, 5).join('\n'));
        const li = LAYOUTS.indexOf(layout);
        for (const [id, pair] of Object.entries(HAND)) {
            if (pair[li] === null) continue;
            const row = part.rows.find((r) => r.id === id);
            assert.equal(readsOf(row.s), pair[li], layout + ' ' + id + ' vs HAND');
        }
        t.diagnostic(layout + ' ' + part.rows.filter((r) => /^(small-64|full-4096|runs-2048) (has|successor|predecessor) /.test(r.id))
            .map((r) => r.id + ' ' + readsOf(r.s)).join(' | '));
    });
}

test('live engine: paged reads +1..+4 over direct on the same row (STOP gate of the G4 <-> G2 seam)', T, async () => {
    const d = await livePart('direct');
    const p = await livePart('paged');
    assert.equal(d.rows.length, ROWS.length, 'direct rows');
    assert.equal(p.rows.length, ROWS.length, 'paged rows');
    const pm = new Map(p.rows.map((r) => [r.id, readsOf(r.s)]));
    for (const r of d.rows) {
        const dr = readsOf(r.s);
        const delta = pm.get(r.id) - dr;
        if (dr === 0) assert.equal(delta, 0, r.id);
        else assert.ok(delta >= 1 && delta <= 4, r.id + ': paged - direct = ' + delta);
    }
});

// --- mutant controls ---------------------------------------------------------------------------------------------

test('control: the clean engine through the data: URL mutant path PASSES', T, async () => {
    const r = await CLEAN;
    const v = verdict(r);
    assert.ok(r.parts.loaded !== undefined && r.parts.loaded.hasRoaring === true, 'clean module loaded');
    assert.equal(v.v, 'PASS', v.fails.slice(0, 3).join('\n') + (v.error ? ' ' + v.error : ''));
});

for (const name of Object.keys(MUTANTS)) {
    test('control M-' + name + ': the mutant FAILS the count ledger for its own reason', T, async (t) => {
        const r = await MJOBS[name];
        assert.equal(r.anchorError, undefined, 'mutant anchor: ' + r.anchorError);
        assert.ok(r.parts.loaded !== undefined && r.parts.loaded.hasRoaring === true, 'mutant module loaded');
        const v = verdict(r);
        t.diagnostic('M-' + name + ' ' + v.v + ' (' + v.fails.length + ' lines): ' + (v.fails[0] || ''));
        assert.notEqual(v.v, 'PASS', 'a mutant that PASSES fails the gate');
        assert.notEqual(v.v, 'ERROR', 'mutant run errored: ' + v.error);
        if (v.v === 'FAIL') assert.ok(v.fails.some((m) => MUTANTS[name].want.test(m)), v.fails.slice(0, 4).join('\n'));
    });
}

test('control: mutate() rejects a missing and a duplicated anchor', () => {
    assert.throws(() => mutate([['this text is not in LogLogN.js', 'x']]), /anchor count 0 != 1/);
    assert.throws(() => mutate([['const m = this._mi(c);', 'x']]), /anchor count \d+ != 1/);
});

test('control: a worker that hangs / exits 1 / posts nothing is never a PASS', T, async () => {
    const hang = await runWorker('for (;;) {}', { eval: true }, 300, 'spin', false);
    assert.ok(hang.error !== null && /^hang > 300 ms/.test(hang.error), String(hang.error));
    assert.equal(verdict(hang).v, 'TIMEOUT');
    const exit1 = await runWorker('process.exit(1)', { eval: true }, 5000, 'exit1', false);
    assert.equal(verdict(exit1).v, 'ERROR');
    const empty = await runWorker('0', { eval: true }, 5000, 'empty', false);
    assert.equal(verdict(empty).v, 'ERROR', 'no layout posted is never a PASS');
    const early = await runWorker("const { parentPort } = require('node:worker_threads'); " +
        "parentPort.postMessage({ phase: 'x', fails: ['boom'] }); setTimeout(() => {}, 60000);", { eval: true }, 30000, 'early', true);
    assert.equal(early.early, 'x');
    assert.equal(verdict(early).v, 'FAIL');
});

test('control: the Meter fails closed (own object field throws; any other method / buffer is a FAIL; _q excluded; undo exact)', () => {
    assert.throws(() => new Meter({ _a: new Uint16Array(4), _o: { x: 1 } }), /FAIL own field _o is a non-typed-array object/);
    assert.throws(() => new Meter({ _a: new Uint16Array(4), _f: () => 0 }), /FAIL own field _f/);
    const inst = { _a: new Uint16Array(8), _q: new Int32Array(2), _n: 3 };
    const meter = new Meter(inst);
    const h0 = meter.hash();
    meter.run(() => {
        const a = inst._a;
        a[1] = a[0] + 1;
        a.copyWithin(2, 0, 3);
        a.fill(7, 6);
        inst._q[0] = inst._q[1];
        inst._n = 9;
    });
    assert.equal(fmtCounts(meter.snapshot()), 'r1 _a:1 | w1 _a:1 | m5 _a:5');
    assert.deepEqual(meter.snapshot().q, { r: 1, w: 1, m: 0 });
    assert.ok(inst._a instanceof Uint16Array && !(inst._a === meter.prox[0]), 'real array back in place');
    meter.undo();
    assert.equal(meter.hash(), h0, 'undo restores arrays and scalars');
    assert.equal(inst._n, 3);
    for (const k of ['subarray', 'slice', 'indexOf', 'buffer']) {
        meter.run(() => { const v = inst._a[k]; return typeof v === 'function' ? v.call(inst._a, 0) : v; });
        assert.deepEqual(meter.bad, ['_a.' + k], k);
        meter.undo();
    }
    meter.run(() => inst._a.length);
    assert.deepEqual(meter.bad, [], 'length is not a method');
});

test('control r2: a non-enumerable or symbol own field throws (review A4: a hidden alias of a counted array)', () => {
    const hid = { _a: new Uint16Array(4) };
    Object.defineProperty(hid, '_hid', { value: hid._a });
    assert.throws(() => new Meter(hid), /FAIL own field _hid is a symbol \/ non-enumerable key/);
    const sym = { _a: new Uint16Array(4), [Symbol('s')]: 1 };
    assert.throws(() => new Meter(sym), /FAIL own field Symbol\(s\) is a symbol \/ non-enumerable key/);
});

test('control r2: getOwnPropertyDescriptor / defineProperty through a counted field is a FAIL (review A2)', () => {
    const inst = { _a: new Uint16Array(4) };
    const meter = new Meter(inst);
    meter.run(() => Reflect.getOwnPropertyDescriptor(inst._a, 1).value);
    assert.deepEqual(meter.bad, ['_a.getOwnPropertyDescriptor']);
    assert.equal(fmtCounts(meter.snapshot()), 'r0 | w0 | m0', 'the descriptor read is uncounted: only the FAIL sees it');
    meter.undo();
    meter.run(() => Object.defineProperty(inst._a, '1', { value: 5 }));
    assert.deepEqual(meter.bad, ['_a.defineProperty']);
    meter.undo();
});

test('control r2: a query row that writes a scalar fails before the undo hides it (review C1)', () => {
    class Fake {
        constructor() {
            this._a = new Uint16Array(4);
            this._n = 3;
        }
        get size() { return 0; }
        min() { this._n = this._n + 1; return undefined; }
        max() { return undefined; }
    }
    const inst = new Fake();
    const meter = new Meter(inst);
    const model = new Float64Array(0);
    const bad = measureRow(inst, meter, model, 65536, { id: 'fake min', op: 'min', x: undefined }, 'direct');
    assert.ok(bad.fails.some((f) => /^direct fake min: a query row changed state/.test(f)), JSON.stringify(bad.fails));
    assert.equal(inst._n, 3, 'undo still restores the scalar');
    const ok = measureRow(inst, meter, model, 65536, { id: 'fake max', op: 'max', x: undefined }, 'direct');
    assert.deepEqual(ok.fails, [], 'a clean query row passes');
    // r3: a query row that ADDS an own key (outside the scalar list the hash covers) is still a FAIL line
    class Fake2 extends Fake { min() { this._extra = 1; return undefined; } }
    const inst2 = new Fake2();
    const meter2 = new Meter(inst2);
    const nk = measureRow(inst2, meter2, model, 65536, { id: 'fake min', op: 'min', x: undefined }, 'direct');
    assert.ok(nk.fails.some((f) => /^direct fake min: .*own key set changed in the measured call/.test(f)), JSON.stringify(nk.fails));
});

test('control r3: an own key added to the instance BETWEEN two run() calls is a FAIL (review r2 X1 / X2)', () => {
    const inst = { _a: new Uint16Array(4), _n: 3 };
    const meter = new Meter(inst);
    meter.run(() => inst._a[0]);
    assert.deepEqual(meter.bad, [], 'unchanged key set: clean');
    meter.undo();
    inst._late = inst._a;
    meter.run(() => inst._late[1]);
    assert.deepEqual(meter.bad, ['own key set changed since the Meter was built', 'own key set changed in the measured call'], 'enumerable late alias: the later key set differs from the ctor key set before AND after the call');
    meter.undo();
    const hid = { _a: new Uint16Array(4), _n: 3 };
    const m2 = new Meter(hid);
    Object.defineProperty(hid, '_hid', { value: hid._a });
    m2.run(() => hid._hid[1]);
    assert.deepEqual(m2.bad, ['own key set changed since the Meter was built', 'own key set changed in the measured call'], 'non-enumerable late alias: the later key set differs from the ctor key set before AND after the call');
    m2.undo();
    const swp = { _a: new Uint16Array(4), _n: 3 };
    const m3 = new Meter(swp);
    delete swp._n;
    swp._m = 3;
    m3.run(() => swp._a[0]);
    assert.ok(m3.bad.includes('own key set changed since the Meter was built'), 'same length, other key: ' + JSON.stringify(m3.bad));
    m3.undo();
    class Fake {
        constructor() { this._a = new Uint16Array(4); }
        get size() { return 0; }
        max() { return undefined; }
    }
    const f = new Fake();
    const m4 = new Meter(f);
    f._late = f._a;
    const row = measureRow(f, m4, new Float64Array(0), 65536, { id: 'fake max', op: 'max', x: undefined }, 'direct');
    assert.ok(row.fails.some((s) => /^direct fake max: .*own key set changed since the Meter was built/.test(s)), 'the row FAILs: ' + JSON.stringify(row.fails));
});

test('control r3: an own key added INSIDE the measured call is a FAIL (review r2 X3)', () => {
    const inst = { _a: new Uint16Array(4), _n: 3 };
    const meter = new Meter(inst);
    meter.run(() => { inst._extra = 1; });
    assert.deepEqual(meter.bad, ['own key set changed in the measured call'], 'enumerable scalar key');
    delete inst._extra;
    meter.undo();
    meter.run(() => { Object.defineProperty(inst, '_hid', { value: inst._a, configurable: true }); });
    assert.deepEqual(meter.bad, ['own key set changed in the measured call'], 'non-enumerable alias key');
    delete inst._hid;
    meter.undo();
    meter.run(() => inst._a[0]);
    assert.deepEqual(meter.bad, [], 'key set restored: clean again');
});

test('control r4: a counted field REPLACED (since built / in the call) is a FAIL, not undone by the restore (review r3 I1 / I3)', () => {
    const inst = { _a: new Uint16Array(4), _n: 3 };
    const meter = new Meter(inst);
    inst._a = new Uint16Array(4);
    meter.run(() => inst._a[0]);
    assert.deepEqual(meter.bad, ['field _a replaced since the Meter was built'], 'replaced between calls (I3)');
    meter.undo();
    const in2 = { _a: new Uint16Array(4), _n: 3 };
    const m2 = new Meter(in2);
    m2.run(() => { in2._a = new Uint16Array(16); });
    assert.deepEqual(m2.bad, ['field _a replaced in the measured call'], 'replaced inside the call (I1)');
    m2.undo();
    m2.run(() => in2._a[0]);
    assert.deepEqual(m2.bad, [], 'the restore put the built array back: clean again');
});

test('control r4: a non-index key set / read / deleted through a counted field is a FAIL (review r3 E1 / E2)', () => {
    const inst = { _a: new Uint16Array(4), _n: 3 };
    const meter = new Meter(inst);
    meter.run(() => { inst._a.hits = 1; });
    assert.deepEqual(meter.bad, ['_a.set hits'], 'expando set (E1)');
    meter.undo();
    meter.run(() => inst._a.hits);
    assert.deepEqual(meter.bad, ['_a.hits (own non-index key)'], 'expando read (E2)');
    meter.undo();
    meter.run(() => { delete inst._a.hits; });
    assert.deepEqual(meter.bad, ['_a.delete hits'], 'expando delete (E2)');
    meter.undo();
    meter.run(() => inst._a.length + inst._a[0]);
    assert.deepEqual(meter.bad, [], 'length (a prototype getter) and an index read stay clean');
});

test('control r4: a prototype or descriptor change with the same key names is a FAIL (review r3 P1 / D1)', () => {
    const p1 = { _a: new Uint16Array(4), _n: 3 };
    const mp = new Meter(p1);
    mp.run(() => { Object.setPrototypeOf(p1, { x: 1 }); });
    assert.deepEqual(mp.bad, ['own key set changed in the measured call'], 'setPrototypeOf (P1)');
    mp.undo();
    const d1 = { _a: new Uint16Array(4), _n: 3 };
    const md = new Meter(d1);
    md.run(() => { const v = d1._n; delete d1._n; Object.defineProperty(d1, '_n', { value: v, writable: true, configurable: true }); });
    assert.deepEqual(Reflect.ownKeys(d1), ['_a', '_n'], 'same key names, same order');
    assert.deepEqual(md.bad, ['own key set changed in the measured call'], 'non-enumerable re-add (D1)');
    md.undo();
    const x1 = { _a: new Uint16Array(4), _n: 3 };
    const mx = new Meter(x1);
    Object.preventExtensions(x1);
    mx.run(() => x1._a[0]);
    assert.deepEqual(mx.bad, ['own key set changed since the Meter was built', 'own key set changed in the measured call'], 'extensibility change between calls');
});

test('control r4: a query row that turns a scalar 0 into -0 fails (review r3 nit Z1: the scalar hash is exact)', () => {
    class Fake {
        constructor() {
            this._a = new Uint16Array(4);
            this._n = 0;
        }
        get size() { return 0; }
        min() { this._n = -0; return undefined; }
    }
    const inst = new Fake();
    const meter = new Meter(inst);
    const bad = measureRow(inst, meter, new Float64Array(0), 65536, { id: 'fake min', op: 'min', x: undefined }, 'direct');
    assert.ok(bad.fails.some((f) => /^direct fake min: a query row changed state/.test(f)), JSON.stringify(bad.fails));
    assert.ok(Object.is(inst._n, 0), 'undo restores +0');
});

test('control: a LEDGER mismatch on one cell is a FAIL line (ledgerDiff has teeth)', T, async () => {
    const part = await livePart('direct');
    const bent = { rows: part.rows.map((r) => (r.id === 'small-64 has c7:0' ? { id: r.id, s: r.s.replace('_sData:8', '_sData:9') } : r)) };
    const diff = ledgerDiff(bent, 'direct');
    assert.equal(diff.length, 1);
    assert.match(diff[0], /^direct small-64 has c7:0: got 'r11 .*_sData:9/);
});
