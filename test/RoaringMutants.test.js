/**
 * @zakkster/lite-loglogn -- RoaringSet MUTANT suite (0.6.0 G1-B5, PLAN-roaringset-G1 task 5, A-2 / A-3 / A-4;
 * SPEC C-10a, C-20, C-21; DETERMINISTIC tier, no timing assertion).
 *
 * Every row is ONE single-anchor substitution on the TEXT of this package's own ../LogLogN.js (read at load, so
 * the shipped test mutates the live file), imported as a base64 data: URL inside a node:worker_threads Worker
 * (test/_roaring-fuzz-worker.mjs) with a kill timer: a hang is a kill, never a wedged run. The anchor must occur
 * EXACTLY once in the text; a count of 0 or >= 2 FAILS that row (never a skip) and its job never starts.
 *
 * Rows (ported from R0's best-mutants.mjs, anchors re-cut to the shipped text: per-chunk row `m` for `c`, `_q`
 * dropped, so vd-M6 / vf-m3 lose their q-lines; the 4 set-op mutants va-m1 / va-m10b / S7 / S8 came back in G3-B4
 * (SPEC C-21), re-cut to _chunkIntersectionSize's per-set rows mA0 / mB0 (C-6) and killed by checkPair inside job
 * 'fuzz'; va-m10b's two R0 edits are ONE anchor because the shipped pA / pB lines are adjacent):
 *   51 FUZZ rows    job 'fuzz' at BUDGET (S11: 'fuzz:V' at BUDGET_V): 47 must be KILLED, 4 are reasoned EQUIVALENTS (B1, B2c, B2d, S9) that
 *                   must SURVIVE; a killed "equivalent" FAILS too (its reason is then wrong).
 *    6 CONTRACT rows the 4 NEW throw-site hoists of A-3 (va-m7, the 5th site, is a fuzz row) via job 'a3'; the
 *                   universe-default mutant (A-4) via job 'universe'; the maxSmall-default mutant via the in-file
 *                   'defaults' oracle (byteLength of a default-constructed set vs the C-3 closed form).
 *   TOTAL 57 rows: 53 killed, 4 equivalents, 0 unexplained / ABORT (SPEC C-10a).
 *
 * Controls: one UNMUTATED run per job kind (fuzz, fuzz:V, a3, universe, defaults) on the same text through the same path
 * (data: URL); each must come back clean, else the file FAILS (a harness bug would otherwise read as a kill).
 *
 * ABORT: a mutant that does not parse (the import throws a SyntaxError) is NOT a kill: its row FAILS as ABORT. A
 * worker `internal: failures counter` mismatch FAILS the row too (a harness defect, never a kill).
 * Fuzz verdict: killed = worker error / TIMEOUT, or result.ok !== true (the mutant threw at load or in the run),
 * or >= 1 FAIL row that is NOT a coverage-floor row. Floor rows (`seed all op -: coverage floor < 100`)
 * are budget artifacts at BUDGET (A-2's floors are gated by RoaringFuzz.test.js at its own budget); the harness
 * emits a floor row only for a scenario with NO mismatch, so excluding it never hides a real FAIL. The fuzz runs
 * at base seed 0 always (LOGLOGN_SEED does not apply: the kill table must be reproducible).
 *
 * Census mode: LOGLOGN_MUT_CENSUS=1 prints `# census <id> <count>` for every row and runs only the anchor test
 * (no Worker starts). Later edits of LogLogN.js keep every anchor at count 1 or re-cut it in the same batch
 * (SPEC C-9: G4-B2 drops B2c / B2d and re-cuts B2a / va-m9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { startRoaringJob, isKilled, describeKill } from './_roaring-fuzz-worker.mjs';

const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const CENSUS = process.env.LOGLOGN_MUT_CENSUS === '1';
const BUDGET = { seeds: 4, ops: 1500 }; // R0's best-mutants.mjs budget (4 seeds x 1500 ops, every section)
// 'fuzz:V' = section V only at 8 x 4000: the vb 'few' scenarios reach a 2-key ARRAY with a free small slot only in
// their delete-heavy phases (op bit 10), which 1500 ops barely enters (S11 survives 4 / 8 / 16 x 1500; killed at
// 4 x 4000 by 'vb U=200001 few' and at 8 x 4000 also by 'vb U=2^20 few tight'). Section V alone costs ~4 s.
const BUDGET_V = { seeds: 8, ops: 4000, only: ['V'] };
const ROW_MS = 300000;                  // per-row kill timer (a hang = killed)
const POOL = Math.max(2, Math.min(6, availableParallelism() >> 1));
const EXPECT_KILLED = 53;
const EXPECT_EQUIV = 4;

const EQ_B2 = 'EQUIVALENT: the in-chunk bitmap search runs only for lo in (min, max] (successor) / [min, max) ' +
    '(predecessor), and the delete-of-min / max re-derive runs with >= 2,048 keys on the far side, so a hit always ' +
    'exists and every -1 exit of _bmpNextGEQ / _bmpPrevLEQ is unreachable (dead bytes: G4-B2 drops them, C-9)';

// [id, what, from, to, job, equivalence reason (equivalents only)]
const ROWS = [
    // ---- va (13) ----
    ['va-m1', 'FULL x other count -1 (_chunkIntersectionSize kA FULL)',
        'if (kA === 6) return stopAtOne ? 1 : other._card[mB0] + 1;',
        'if (kA === 6) return stopAtOne ? 1 : other._card[mB0];', 'fuzz'],
    ['va-m2', 'has kind 5 base << 12',
        'const base = k === 5 ? slot << 6 : slot << 12;\n        const r = this._lbRun(u16, base, nRuns, lo);\n        return r < nRuns && u16[base + (r << 1)] <= lo;\n',
        'const base = slot << 12;\n        const r = this._lbRun(u16, base, nRuns, lo);\n        return r < nRuns && u16[base + (r << 1)] <= lo;\n', 'fuzz'],
    ['va-m3', 'FULL-delete 2nd run len +1', 'u16[base + 3] = 65534 - lo;', 'u16[base + 3] = 65535 - lo;', 'fuzz'],
    ['va-m4', 'small run cap 33',
        '} else if (nRuns < (small ? 32 : 2048)) {\n            const ins',
        '} else if (nRuns < (small ? 33 : 2048)) {\n            const ins', 'fuzz'],
    ['va-m5', '_toFull keeps the slot',
        '        if (k === 5) this._sFree[this._sTop++] = slot;\n        else this._lFree[this._lTop++] = slot;\n        this._kind[m] = 6;',
        '        this._kind[m] = 6;', 'fuzz'],
    ['va-m6', 'delete demote at <= 34 runs',
        'if (!small && nRuns <= 33 && this._sTop > 0) this._demoteRunToSmall(m, slot, nRuns - 1);\n        } else if (lo === start)',
        'if (!small && nRuns <= 34 && this._sTop > 0) this._demoteRunToSmall(m, slot, nRuns - 1);\n        } else if (lo === start)', 'fuzz'],
    ['va-m7', '_deleteFull _card before pool check',
        '    _deleteFull(m, lo) {\n        let u16;',
        '    _deleteFull(m, lo) {\n        this._card[m] = 65534;\n        let u16;', 'fuzz'],
    ['va-m8', 'small-run max header reads the slab',
        '                this._cMax[m] = u16[pIdx] + u16[pIdx + 1];',
        '                this._cMax[m] = this._lU16[pIdx] + this._lU16[pIdx + 1];', 'fuzz'],
    ['va-m9', 'successor on FULL +1',
        'if (k === 6) return ((c << 16) | lo) >>> 0;\n            const slot = this._slot[m];\n            if (k === 1) {\n                const len = this._card[m] + 1;\n                const base = slot << 6;\n                const j = this._lb16(this._sData, base, len, lo);\n                if (j < len) return',
        'if (k === 6) return ((c << 16) | (lo === 65535 ? lo : lo + 1)) >>> 0;\n            const slot = this._slot[m];\n            if (k === 1) {\n                const len = this._card[m] + 1;\n                const base = slot << 6;\n                const j = this._lb16(this._sData, base, len, lo);\n                if (j < len) return', 'fuzz'],
    ['va-m10b', 'intersect priority as base (small runs ranked with bitmap)',
        '        const pA = kA <= 2 ? 0 : (kA === 3 ? 2 : 1);\n        const pB = kB <= 2 ? 0 : (kB === 3 ? 2 : 1);',
        '        const pA = kA <= 2 ? 0 : (kA === 4 ? 1 : 2);\n        const pB = kB <= 2 ? 0 : (kB === 4 ? 1 : 2);', 'fuzz'],
    ['va-m11', 'runOptimize skips FULL detection',
        'if (card === 65536) {\n                if (k !== 6) this._toFull(m, k, slot);',
        'if (card === 65536) {\n                if (k === 99) this._toFull(m, k, slot);', 'fuzz'],
    ['va-m12', 'bitmap add never goes FULL',
        'if (++this._card[m] === 65535) this._toFull(m, 3, slot);', 'this._card[m]++;', 'fuzz'],
    ['va-m13', 'add-bridge demote at <= 34 runs',
        'else if (!small && nRuns <= 33 && this._sTop > 0) this._demoteRunToSmall(m, slot, nRuns - 1);',
        'else if (!small && nRuns <= 34 && this._sTop > 0) this._demoteRunToSmall(m, slot, nRuns - 1);', 'fuzz'],
    // ---- vd (13) ----
    ['vd-M1', 'bitmap delete-of-min not re-derived',
        'if (lo === this._cMin[m]) this._cMin[m] = this._bmpNextGEQ(slot, lo);', 'if (lo === this._cMin[m]) {}', 'fuzz'],
    ['vd-M2', 'bitmap delete-of-max not re-derived',
        'else if (lo === this._cMax[m]) this._cMax[m] = this._bmpPrevLEQ(slot, lo);', '', 'fuzz'],
    ['vd-M3', 'small add new max dropped',
        '                if (j === 0) this._cMin[m] = lo;\n                else if (j === len) this._cMax[m] = lo;\n                this._size++;\n                return this;\n            }\n            this._promoteSmallToArray',
        '                if (j === 0) this._cMin[m] = lo;\n                this._size++;\n                return this;\n            }\n            this._promoteSmallToArray', 'fuzz'],
    ['vd-M4', 'promoteSmallToArray headers dropped',
        '        if (j === 0) this._cMin[m] = lo;\n        else if (j === 64) this._cMax[m] = lo;\n', '', 'fuzz'],
    ['vd-M5', 'demoteArrayToSmall headers dropped',
        '        if (j === 0) this._cMin[m] = sData[sBase];\n        else if (j === len - 1) this._cMax[m] = sData[sBase + len - 2];\n', '', 'fuzz'],
    ['vd-M6', 'promoteArrayToBitmap headers dropped (q-line gone: anchored on the card write)',
        '        this._card[m] = 4096;\n        if (lo < this._cMin[m]) this._cMin[m] = lo;\n        else if (lo > this._cMax[m]) this._cMax[m] = lo;\n',
        '        this._card[m] = 4096;\n', 'fuzz'],
    ['vd-M7', 'run add new max dropped', '        else if (r === nRuns) this._cMax[m] = lo;\n', '\n', 'fuzz'],
    ['vd-M8', 'run delete-of-max (len 0 run) dropped',
        '            else if (r === nRuns - 1) {\n                const pIdx = base + ((nRuns - 2) << 1);\n                this._cMax[m] = u16[pIdx] + u16[pIdx + 1];\n            }\n', '', 'fuzz'],
    ['vd-M9', 'run delete start of first run dropped', '            if (r === 0) this._cMin[m] = start + 1;\n', '', 'fuzz'],
    ['vd-M10', 'clear does not zero headers',
        '            this._cMin[m] = 0;\n            this._cMax[m] = 0;\n        }\n        this._top.fill(0);',
        '        }\n        this._top.fill(0);', 'fuzz'],
    ['vd-M11', 'predecessor header off by one',
        'if (lo >= mx) return ((c << 16) | mx) >>> 0;', 'if (lo >= mx) return ((c << 16) | (mx - 1)) >>> 0;', 'fuzz'],
    ['vd-M12', 'successor header off by one',
        'if (lo <= mn) return ((c << 16) | mn) >>> 0;', 'if (lo <= mn) return ((c << 16) | (mn + 1)) >>> 0;', 'fuzz'],
    ['vd-M13', 'array delete-of-max dropped (kind 2)',
        '                if (j === 0) this._cMin[m] = lU16[base];\n                else if (j === len - 1) this._cMax[m] = lU16[base + len - 2];\n',
        '                if (j === 0) this._cMin[m] = lU16[base];\n', 'fuzz'],
    // ---- vf (4) / ve (2) ----
    ['vf-m1', 'no l2b', '        sum[sBase + 65] = l2b;\n        // the new key', '        sum[sBase + 65] = 0;\n        // the new key', 'fuzz'],
    ['vf-m2', 'lo no l1', '            sum[sBase + ls1] = s1Old | (1 << (lw & 31));', '            sum[sBase + ls1] = s1Old;', 'fuzz'],
    ['vf-m3', 'run last flush (q-line gone)',
        '        sum[sBase + s1] = m1;\n        if (s1 < 32) l2a |= 1 << s1;\n        else l2b |= 1 << (s1 - 32);\n        sum[sBase + 64] = l2a;\n        sum[sBase + 65] = l2b;\n        this._slot[m] = dst;',
        '        sum[sBase + 64] = l2a;\n        sum[sBase + 65] = l2b;\n        this._slot[m] = dst;', 'fuzz'],
    ['vf-m4', 'run mask 1 word',
        '                m1 |= (-1 << (a & 31)) & (-1 >>> (31 - (b & 31)));', '                m1 |= 1 << (a & 31);', 'fuzz'],
    ['ve-m5', 'bitmap never demotes', 'if (newCard < DEMOTE_BITMAP) {', 'if (newCard < 0) {', 'fuzz'],
    ['ve-m6', 'small demote ignores the pool', 'len - 1 <= DEMOTE_SMALL && this._sTop > 0', 'len - 1 <= DEMOTE_SMALL', 'fuzz'],
    // ---- base-defect fixes (B1a, B1b, B1, B2a..B2d) ----
    ['B1a', '_lastChunk word load drops bit 31',
        '        v = t[i] | 0;\n        return (i << 5) | (31 - Math.clz32(v));\n    }\n\n    _lb16',
        '        v = t[i] & 0x7FFFFFFF;\n        return (i << 5) | (31 - Math.clz32(v));\n    }\n\n    _lb16', 'fuzz'],
    ['B1b', '_bmpPrevLEQ word load drops bit 31',
        '        v = u32[wBase + wIdx] | 0;', '        v = u32[wBase + wIdx] & 0x7FFFFFFF;', 'fuzz'],
    ['B1', 'fix-1 site value (_prevChunk L1 load | 1)',
        'v = t[2048 + i] | 0;\n        i = (i << 5) | (31 - Math.clz32(v));\n        v = t[i] | 0;\n        return (i << 5) | (31 - Math.clz32(v));\n    }\n\n    /** Hot helper. Smallest',
        'v = t[2048 + i] | 1;\n        i = (i << 5) | (31 - Math.clz32(v));\n        v = t[i] | 0;\n        return (i << 5) | (31 - Math.clz32(v));\n    }\n\n    /** Hot helper. Smallest', 'fuzz',
        'EQUIVALENT: the L1 word is non-zero on this path (its L2 bit is set), and OR-ing bit 0 into a non-zero word never moves its highest set bit'],
    ['B2a', '_bmpNextGEQ hoist reads word 64',
        '                l2v = sum[sBase + 65];\n                if (l2v === 0) return -1;',
        '                l2v = sum[sBase + 64];\n                if (l2v === 0) return -1;', 'fuzz'],
    ['B2b', '_bmpPrevLEQ hoist reads word 65', '                l2v = sum[sBase + 64] | 0;', '                l2v = sum[sBase + 65] | 0;', 'fuzz'],
    ['B2c', '_bmpNextGEQ l2p guard dropped', '                if (l2p !== 0) return -1;\n', '', 'fuzz', EQ_B2],
    ['B2d', '_bmpPrevLEQ empty-L2 guard dropped',
        '                l2v = sum[sBase + 64] | 0;\n                if (l2v === 0) return -1;\n',
        '                l2v = sum[sBase + 64] | 0;\n', 'fuzz', EQ_B2],
    // ---- merge seams (S1..S12) ----
    ['S1', 'add-empty SINGLE without headers (_addChunk)',
        '        this._slot[m] = lo;\n        this._card[m] = 0;\n        this._cMin[m] = lo;\n        this._cMax[m] = lo;\n',
        '        this._slot[m] = lo;\n        this._card[m] = 0;\n', 'fuzz'],
    ['S2', '_toSingle frees small runs to the large pool',
        '        if (k === 1 || k === 5) this._sFree[this._sTop++] = slot;\n        else this._lFree[this._lTop++] = slot;\n        this._kind[m] = 7;',
        '        if (k === 1) this._sFree[this._sTop++] = slot;\n        else this._lFree[this._lTop++] = slot;\n        this._kind[m] = 7;', 'fuzz'],
    ['S3', '_promoteSingle headers swapped',
        '        this._cMin[m] = a;\n        this._cMax[m] = b;', '        this._cMin[m] = b;\n        this._cMax[m] = a;', 'fuzz'],
    ['S4', 'successor min test strict (SINGLE reaches the search)',
        'if (lo <= mn) return ((c << 16) | mn) >>> 0;', 'if (lo < mn) return ((c << 16) | mn) >>> 0;', 'fuzz'],
    ['S5', '_addRun header write before the spill (vd order)',
        '        const prevAdj = r > 0 && (u16[base + ((r - 1) << 1)] + u16[base + ((r - 1) << 1) + 1] + 1 === lo);',
        '        if (r === 0) this._cMin[m] = lo;\n        else if (r === nRuns) this._cMax[m] = lo;\n        const prevAdj = r > 0 && (u16[base + ((r - 1) << 1)] + u16[base + ((r - 1) << 1) + 1] + 1 === lo);', 'fuzz'],
    ['S6', '_deleteFull min header dropped', '        if (lo === 0) this._cMin[m] = 1;\n', '        if (lo === -1) this._cMin[m] = 1;\n', 'fuzz'],
    ['S7', 'SINGLE intersection asks its own set (own row mA0, other\'s kind)',
        'if (kA === 7) return other._chunkHasLo(mB0, kB, this._slot[mA0]);',
        'if (kA === 7) return this._chunkHasLo(mA0, kB, this._slot[mA0]);', 'fuzz'],
    ['S8', '_chunkHasLo small runs base << 12',
        '        const base = k === 5 ? slot << 6 : slot << 12;\n        const r = this._lbRun(u16, base, nRuns, lo);\n        return r < nRuns && u16[base + (r << 1)] <= lo ? 1 : 0;',
        '        const base = slot << 12;\n        const r = this._lbRun(u16, base, nRuns, lo);\n        return r < nRuns && u16[base + (r << 1)] <= lo ? 1 : 0;', 'fuzz'],
    ['S9', 'bitmap delete demotes before the header re-derive',
        '            if (lo === this._cMin[m]) this._cMin[m] = this._bmpNextGEQ(slot, lo);\n            else if (lo === this._cMax[m]) this._cMax[m] = this._bmpPrevLEQ(slot, lo);\n            const newCard = this._card[m] - 1;\n            if (newCard < DEMOTE_BITMAP) {\n                this._demoteBitmapToArray(m, slot);\n            } else {\n                this._card[m] = newCard;\n            }',
        '            const newCard = this._card[m] - 1;\n            if (newCard < DEMOTE_BITMAP) {\n                this._demoteBitmapToArray(m, slot);\n            } else {\n                this._card[m] = newCard;\n            }\n            if (lo === this._cMin[m]) this._cMin[m] = this._bmpNextGEQ(slot, lo);\n            else if (lo === this._cMax[m]) this._cMax[m] = this._bmpPrevLEQ(slot, lo);', 'fuzz',
        'EQUIVALENT: _demoteBitmapToArray never writes its source slab (it becomes the spare _conv untouched), so the late re-derive reads the same 2,048 words and summary'],
    ['S11', 've demote tested before vb1 2 -> 1',
        '            if (len === 2) {\n                this._toSingle(m, 2, slot, lU16[base + 1 - j]);\n            } else if (len - 1 <= DEMOTE_SMALL && this._sTop > 0) {\n                this._demoteArrayToSmall(m, slot, j, len);\n            }',
        '            if (len - 1 <= DEMOTE_SMALL && this._sTop > 0) {\n                this._demoteArrayToSmall(m, slot, j, len);\n            } else if (len === 2) {\n                this._toSingle(m, 2, slot, lU16[base + 1 - j]);\n            }', 'fuzz:V'],
    ['S12', 'SINGLE delete keeps the topClear out',
        '            this._kind[m] = 0;\n            this._topClear(c);\n            this._pageRelease(c);\n            this._size--;',
        '            this._kind[m] = 0;\n            this._pageRelease(c);\n            this._size--;', 'fuzz'],
    ['S10', '_deleteRun 2 -> 1 keeps the deleted end', '(lo === start ? end : start)', '(lo === start ? start : end)', 'fuzz'],
    // ---- CONTRACT rows (outside the 47): A-3 throw-site hoists, A-4 defaults ----
    ['A3-h1', '_promoteSingle _card before the pool check',
        '    _promoteSingle(m, old, lo) {\n        const a',
        '    _promoteSingle(m, old, lo) {\n        this._card[m] = 1;\n        const a', 'a3'],
    ['A3-h2', '_promoteSmallToArray _card before the pool check',
        '    _promoteSmallToArray(m, slot, j, lo) {\n        if (this._lTop === 0)',
        '    _promoteSmallToArray(m, slot, j, lo) {\n        this._card[m] = 64;\n        if (this._lTop === 0)', 'a3'],
    ['A3-h3', '_addRun spill: _kind 4 before _promoteSmallRunToRun\'s pool check',
        '        } else if (small) {\n            this._promoteSmallRunToRun(m, slot, nRuns);\n            this._addRun(',
        '        } else if (small) {\n            this._kind[m] = 4;\n            this._promoteSmallRunToRun(m, slot, nRuns);\n            this._addRun(', 'a3'],
    ['A3-h4', '_deleteRun spill: _kind 4 before _promoteSmallRunToRun\'s pool check',
        '        } else if (small) {\n            this._promoteSmallRunToRun(m, slot, nRuns);\n            return this._deleteRun(',
        '        } else if (small) {\n            this._kind[m] = 4;\n            this._promoteSmallRunToRun(m, slot, nRuns);\n            return this._deleteRun(', 'a3'],
    ['A4-u', 'universe default 2^32 (new RoaringSet() would construct)',
        'constructor(universe, maxSmall = 1024', 'constructor(universe = 4294967296, maxSmall = 1024', 'universe'],
    ['A4-s', 'maxSmall default 1024 -> 1023',
        'maxSmall = 1024, maxLarge = 256', 'maxSmall = 1023, maxLarge = 256', 'defaults'],
].map(([id, what, from, to, job, reason]) => ({ id, what, from, to, job, reason: reason === undefined ? null : reason }));

const count = (s) => (s.length === 0 ? -1 : SRC.split(s).length - 1);
const COUNTS = ROWS.map((r) => count(r.from));

// --- 'defaults' oracle (no worker kind carries it): a default-constructed set is the C-3 closed form at
// maxSmall 1024, maxLarge 256 (A-4: (2^16, 1024, 256) 2,315,295; (2^32, 1024, 256) 3,036,180).
function checkDefaults(RS) {
    const f = [];
    const form = (U, s, l) => 8460 + 11 * Math.ceil(U / 65536) + 130 * s + 8456 * (l + 1) + 2 * l;
    for (const [U, want] of [[65536, 2315295], [4294967296, 3036180], [200001, form(200001, 1024, 256)]]) {
        try {
            const got = new RS(U).byteLength;
            if (got !== want || want !== form(U, 1024, 256)) f.push('new RoaringSet(' + U + ').byteLength ' + got + ' (want ' + want + ')');
        } catch (e) {
            f.push('new RoaringSet(' + U + ') threw ' + String(e && e.message));
        }
    }
    return f;
}

async function runDefaults(src) {
    try {
        const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
        if (typeof mod.RoaringSet !== 'function') return { result: { ok: false, message: 'module exports no RoaringSet' }, error: null };
        const failures = checkDefaults(mod.RoaringSet);
        return { result: { ok: true, kind: 'defaults', failures, failing: failures.length }, error: null };
    } catch (e) {
        return { result: { ok: false, message: e && e.stack ? String(e.stack) : String(e) }, error: null };
    }
}

// --- verdicts ---------------------------------------------------------------------------------
const FLOOR_ROW = /^FAIL .* seed all op -: coverage floor < 100: /;

/** The mutant text does not parse: the import threw a SyntaxError (worker and runDefaults post e.stack). */
function isAbort(r) {
    return r.error === null && r.result !== null && typeof r.result === 'object' && r.result.ok === false &&
        /(^|\n)SyntaxError: /.test(String(r.result.message));
}

/** The worker flagged its own FAIL-row counter as inconsistent: a harness defect. */
function isInternal(r) {
    return r.result !== null && typeof r.result === 'object' && Array.isArray(r.result.failures) &&
        r.result.failures.some((x) => String(x).startsWith('internal:'));
}

function realFails(r) {
    return r.result.rows.filter((x) => !x.ok && !FLOOR_ROW.test(x.text)).map((x) => x.text);
}

/** killed? for any job kind; fuzz excludes the coverage-floor rows (see the header). */
function killedOf(job, r) {
    if (job !== 'fuzz' && job !== 'fuzz:V') return isKilled(r);
    if (r.error !== null || r.result === null || typeof r.result !== 'object' || r.result.ok !== true) return true;
    if (!Array.isArray(r.result.rows)) return true;
    return realFails(r).length > 0;
}

function whyOf(job, r) {
    if ((job !== 'fuzz' && job !== 'fuzz:V') || r.error !== null || r.result === null || r.result.ok !== true) return describeKill(r);
    const f = realFails(r);
    return f.length ? f[0] : 'survived (' + r.result.rows.length + ' rows, ' + (r.result.failing - f.length) + ' floor rows only)';
}

function jobFor(job, src, label) {
    if (job === 'defaults') return runDefaults(src);
    if (job === 'fuzz') return startRoaringJob({ kind: 'fuzz', src, seeds: BUDGET.seeds, ops: BUDGET.ops, base: 0 }, label, ROW_MS);
    if (job === 'fuzz:V') return startRoaringJob({ kind: 'fuzz', src, seeds: BUDGET_V.seeds, ops: BUDGET_V.ops, only: BUDGET_V.only, base: 0 }, label, ROW_MS);
    return startRoaringJob({ kind: job, src }, label, ROW_MS);
}

// --- schedule: controls first, then every row whose anchor count is 1, through a pool of POOL Workers ---
const CONTROL_KINDS = ['fuzz', 'fuzz:V', 'a3', 'universe', 'defaults'];
const queue = [];
const controlP = {};
const rowP = new Array(ROWS.length).fill(null);
if (!CENSUS) {
    for (const k of CONTROL_KINDS) controlP[k] = new Promise((res) => queue.push(() => jobFor(k, SRC, 'control ' + k).then(res)));
    ROWS.forEach((row, i) => {
        if (COUNTS[i] !== 1) return;
        const mutant = SRC.replace(row.from, () => row.to);
        rowP[i] = new Promise((res) => queue.push(() => jobFor(row.job, mutant, 'mutant ' + row.id).then(res)));
    });
    let next = 0;
    const lane = async () => { while (next < queue.length) await queue[next++](); };
    for (let i = 0; i < POOL; i++) lane();
}
const T0 = Date.now();

test('RoaringMutants: every anchor occurs exactly once in ../LogLogN.js (census)', () => {
    const bad = [];
    ROWS.forEach((r, i) => {
        if (CENSUS) console.log('# census ' + r.id + ' ' + COUNTS[i]);
        if (COUNTS[i] !== 1) bad.push(r.id + ' count ' + COUNTS[i]);
    });
    assert.equal(ROWS.length, 57, '51 fuzz + 6 contract rows');
    assert.equal(ROWS.filter((r) => r.job === 'fuzz' || r.job === 'fuzz:V').length, 51);
    assert.equal(ROWS.filter((r) => r.reason !== null).length, EXPECT_EQUIV);
    assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length, 'unique ids');
    assert.ok(ROWS.every((r) => r.from !== r.to), 'every row changes the text');
    assert.deepEqual(bad, [], 'anchor count != 1');
});

if (!CENSUS) {
    for (const k of CONTROL_KINDS) {
        test('RoaringMutants control (' + k + '): the UNMUTATED text through the same path comes back clean', async () => {
            const r = await controlP[k];
            assert.equal(r.error, null, String(r.error));
            assert.ok(r.result !== null && r.result.ok === true, 'control ' + k + ' did not run: ' + describeKill(r));
            assert.ok(!isInternal(r), 'control ' + k + ' harness defect (internal: failures counter)');
            assert.equal(killedOf(k, r), false, 'control ' + k + ' reads as killed: ' + whyOf(k, r));
            if (k === 'fuzz' || k === 'fuzz:V') {
                // one row per scenario / section (a floor miss REPLACES its scenario's row): the count is the harness
                // structure, independent of seeds / ops / base (G3-B4 evidence g3/b4-rowcount.log); re-pin when a section changes
                const want = k === 'fuzz' ? 125 : 34;
                assert.equal(r.result.rows.length, want, 'control ' + k + ' ran ' + r.result.rows.length + ' rows' +
                    ', pinned ' + want + ' = one row per roaringFuzz.mjs scenario / section: re-pin (SPEC C-10a) when one is added or removed');
                console.log('# control ' + k + ': ' + r.result.rows.length + ' rows, ' + realFails(r).length + ' FAIL, ' + r.result.failing + ' floor rows (budget artifacts), in-worker ' + (r.result.wallMs / 1000).toFixed(1) + ' s');
            } else {
                assert.deepEqual(r.result.failures, []);
            }
        });
    }

    const verdicts = new Array(ROWS.length).fill(null);
    ROWS.forEach((row, i) => {
        const tag = row.reason === null ? 'killed' : 'EQUIVALENT (must survive)';
        test('RoaringMutants ' + row.id + ' [' + row.job + '] ' + row.what + ': ' + tag, async () => {
            assert.equal(COUNTS[i], 1, row.id + ': anchor count ' + COUNTS[i] + ' (must be exactly 1)');
            const r = await rowP[i];
            assert.ok(!isAbort(r), row.id + ' ABORT: the mutant does not parse: ' + (isAbort(r) ? String(r.result.message).split('\n')[0] : ''));
            assert.ok(!isInternal(r), row.id + ' harness defect: ' + (isInternal(r) ? r.result.failures.find((x) => String(x).startsWith('internal:')) : ''));
            const killed = killedOf(row.job, r);
            const why = whyOf(row.job, r);
            verdicts[i] = killed ? 'killed' : 'survived';
            console.log('# ' + (killed ? 'killed   ' : (row.reason === null ? 'SURVIVED ' : 'equiv    ')) + row.id.padEnd(7) + ' ' + why.slice(0, 160));
            if (row.reason === null) assert.ok(killed, row.id + ' SURVIVED: ' + why);
            else assert.ok(!killed, row.id + ' listed EQUIVALENT but KILLED (reason wrong: ' + row.reason + '): ' + why);
        });
    });

    test('RoaringMutants totals: ' + EXPECT_KILLED + ' / ' + (EXPECT_KILLED + EXPECT_EQUIV) + ' killed, ' + EXPECT_EQUIV + ' equivalents, 0 unexplained', async () => {
        await Promise.all([...Object.values(controlP), ...rowP.filter((p) => p !== null)]);
        const killed = verdicts.filter((v, i) => v === 'killed' && ROWS[i].reason === null).length;
        const equiv = verdicts.filter((v, i) => v === 'survived' && ROWS[i].reason !== null).length;
        const bad = ROWS.length - killed - equiv;
        console.log('# RoaringMutants: killed ' + killed + ' / ' + ROWS.length + ', equivalent ' + equiv + ', unexplained ' + bad +
            ' | budget ' + BUDGET.seeds + ' x ' + BUDGET.ops + ' (S11: V ' + BUDGET_V.seeds + ' x ' + BUDGET_V.ops + '), pool ' + POOL + ', wall ' + ((Date.now() - T0) / 1000).toFixed(1) + ' s (REPORTED)');
        assert.equal(killed, EXPECT_KILLED);
        assert.equal(equiv, EXPECT_EQUIV);
        assert.equal(bad, 0);
    });
}
