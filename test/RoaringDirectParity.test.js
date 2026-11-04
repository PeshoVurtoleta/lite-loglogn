/**
 * @zakkster/lite-loglogn -- RoaringSet direct-layout parity with the G1 build (0.6.0 G2-B2, PLAN-roaringset-G2
 * task 4, assertion A-4; SPEC C-5, C-6, C-20). DETERMINISTIC tier, no timing.
 *
 * 1. Replays test/vectors/roaring-direct-g1.json (cut from the frozen G1 build 4d9c29a / e0f18ff8 by G2-B1's
 *    cut-direct.mjs) on the live engine. The stream generator below is a verbatim port of the cutter's genOps:
 *    its source text must equal the vectors' `generatorSource`, and every stream's opsSha must match before its
 *    results are compared. Direct (U, 64, 32): every field JSON-equal, byteLength included, plus the `space`
 *    table. Paged (the 2^32 stream at (maxPages, pageBits) (254, 8) / (1014, 6) / (62, 10)): every field but
 *    byteLength equal and `paged === true`. Must-fail controls: the 2^32 stream at (1, 8) (page pool exhausted)
 *    and a one-token perturbation of the stored results must both DIFF.
 * 2. One hidden class (C-5): `%HaveSameMap(direct, paged)` at 2^32 is true in an `--allow-natives-syntax` child;
 *    control: the "direct leaves `_dir` unassigned" mutant (base64 data: URL build of the live text, anchor count
 *    1) -> false, while two of its direct sets still share a map (so the false is the mutant, not the child).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { RoaringSet } from '../LogLogN.js';

const VEC = JSON.parse(readFileSync(new URL('./vectors/roaring-direct-g1.json', import.meta.url), 'utf8'));
const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
const U32 = 4294967296;

// --- the stream (verbatim port of cut-direct.mjs genOps; must equal VEC.generatorSource) ------------------
function genOps(U, seed, nOps) {
    let s = seed >>> 0;
    const r = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const C = Math.ceil(U / 65536);
    const H = [];
    const HN = C < 96 ? C : 96;
    for (let j = 0; j < HN; j++) H.push(Math.floor(r() * C));
    const W = [65536, 8192, 1024, 128];
    const key = () => {
        if (r() < 0.03) return Math.floor(r() * U);
        const j = Math.floor(r() * HN);
        return (H[j] * 65536 + Math.floor(r() * W[j & 3])) % U;
    };
    const op = new Uint8Array(nOps);
    const x = new Float64Array(nOps).fill(-1);
    let burstLeft = 0;
    let burstKey = 0;
    let burstStep = 1;
    for (let n = 1; n <= nOps; n++) {
        const i = n - 1;
        if (n === 10000) { op[i] = 8; continue; }
        if (n % 2500 === 0) { op[i] = 7; continue; }
        if (burstLeft > 0) {
            op[i] = 0; x[i] = burstKey; burstKey = (burstKey + burstStep) % U; burstLeft--;
            continue;
        }
        const t = r();
        if (t < 0.0015) {
            const b = HN > 1 && r() < 0.5 ? 1 : 0;
            burstStep = 2 - b;
            burstKey = (H[b] * 65536 + Math.floor(r() * 65536)) % U;
            op[i] = 0; x[i] = burstKey; burstKey = (burstKey + burstStep) % U; burstLeft = 1023;
        } else if (t < 0.45) { op[i] = 0; x[i] = key(); }
        else if (t < 0.60) { op[i] = 1; x[i] = key(); }
        else if (t < 0.72) { op[i] = 2; x[i] = key(); }
        else if (t < 0.84) { op[i] = 3; x[i] = key(); }
        else if (t < 0.96) { op[i] = 4; x[i] = key(); }
        else if (t < 0.98) op[i] = 5;
        else op[i] = 6;
    }
    return { op, x };
}

const sha8 = (t) => createHash('sha256').update(t).digest('hex').slice(0, 8);

function opsText(g) {
    const parts = [];
    for (let i = 0; i < g.op.length; i++) parts.push(g.op[i] + ':' + g.x[i]);
    return parts.join(',');
}

function dumpRow(s) {
    const d = s.dump();
    return { size: d.size, chunks: d.chunks.map((e) => [e.chunk, e.kind, e.count, e.runs]) };
}

/** Replays stream `st` (a VEC.streams row) on new RS(U, maxS, maxL, ...extra); the row in the vectors' format. */
function replay(RS, st, extra) {
    const n0 = VEC.ops;
    const g = genOps(st.U, st.seed, n0);
    const s = new RS(st.U, st.maxS, st.maxL, ...extra);
    const tok = [];
    const throws = [];
    const sizes = [];
    const dumps = [];
    for (let i = 0; i < n0; i++) {
        const n = i + 1;
        if (n % 5000 === 0) dumps.push({ before: n, ...dumpRow(s) });
        const o = g.op[i];
        const x = g.x[i];
        const before = s.size;
        let ret;
        let err = null;
        try {
            if (o === 0) ret = s.add(x);
            else if (o === 1) ret = s.delete(x);
            else if (o === 2) ret = s.has(x);
            else if (o === 3) ret = s.successor(x);
            else if (o === 4) ret = s.predecessor(x);
            else if (o === 5) ret = s.min();
            else if (o === 6) ret = s.max();
            else if (o === 7) ret = s.runOptimize();
            else ret = s.clear();
        } catch (e) { err = e; }
        let t;
        if (err !== null) {
            const msg = err.name + ': ' + err.message;
            let k = throws.indexOf(msg);
            if (k < 0) { k = throws.length; throws.push(msg); }
            t = 'E' + k + (s.size !== before ? '!size' : '');
        } else if (o === 0) {
            t = ret !== s ? '!ret' : s.size === before + 1 ? '+' : s.size === before ? '=' : '!size';
        } else if (o === 1 || o === 2) {
            t = ret === true ? 't' : ret === false ? 'f' : '!bool';
        } else if (o <= 6) {
            t = ret === undefined ? 'u' : String(ret);
        } else if (o === 7) {
            t = ret === s ? 'o' : '!ret';
        } else {
            t = ret === undefined && s.size === 0 ? 'c' : '!clear';
        }
        tok.push(t);
        if (n % 500 === 0) sizes.push(s.size);
    }
    dumps.push({ before: 'end', ...dumpRow(s) });
    const res = tok.join(',');
    return {
        row: {
            name: st.name, U: st.U, seed: st.seed, maxS: st.maxS, maxL: st.maxL, byteLength: s.byteLength,
            opsSha: sha8(opsText(g)), resSha: sha8(res), throws, sizes, dumps, res,
        },
        paged: s.paged,
    };
}

/** Keys of `want` whose JSON differs in `got` (byteLength skipped when skipBytes). */
function diffRow(want, got, skipBytes) {
    const d = [];
    for (const k of Object.keys(want)) {
        if (k === 'byteLength' && skipBytes) continue;
        if (JSON.stringify(want[k]) !== JSON.stringify(got[k])) d.push(k);
    }
    if (Object.keys(got).length !== Object.keys(want).length) d.push('keys');
    return d;
}

const S32 = VEC.streams.find((s) => s.U === U32);

test('A-4 vectors header: G1 cut, generator source is this port, 4 streams with their opsSha', () => {
    assert.match(VEC.cutFrom, /4d9c29a .*e0f18ff8/);
    assert.equal(VEC.streamVersion, 1);
    assert.equal(VEC.ops, 20000);
    assert.equal(VEC.generatorSource, genOps.toString());
    assert.deepEqual(VEC.streams.map((s) => s.U), [65536, 200001, 1048576, U32]);
    for (const st of VEC.streams) assert.equal(sha8(opsText(genOps(st.U, st.seed, VEC.ops))), st.opsSha, st.name + ' opsSha');
    assert.equal(S32.throws.length, 1, 'the 2^32 stream exercises the large-pool throw');
});

test('A-4 space: the 7 direct byteLength rows of the G1 build', () => {
    const got = VEC.space.map(({ U }) => ({ U, defaultPools: new RoaringSet(U).byteLength, minimalPools: new RoaringSet(U, 0, 1).byteLength }));
    assert.deepEqual(got, VEC.space);
});

for (const st of VEC.streams) {
    test('A-4 direct replay ' + st.name + ': JSON-equal to the G1 build (byteLength included)', () => {
        const out = replay(RoaringSet, st, []);
        assert.equal(out.paged, false);
        assert.deepEqual(diffRow(st, out.row, false), []);
    });
}

for (const [mp, pb] of [[254, 8], [1014, 6], [62, 10]]) {
    test('A-4 paged replay U=2^32 (maxPages ' + mp + ', pageBits ' + pb + '): every field but byteLength equal', () => {
        const out = replay(RoaringSet, S32, [mp, pb]);
        assert.equal(out.paged, true);
        assert.deepEqual(diffRow(S32, out.row, true), []);
    });
}

test('A-4 must-fail controls: page-pool exhaustion (2^32, maxPages 1, pb8) and a perturbed result token DIFF', () => {
    const out = replay(RoaringSet, S32, [1, 8]);
    assert.equal(out.paged, true);
    const d = diffRow(S32, out.row, true);
    assert.ok(d.includes('res') && d.includes('throws'), 'maxPages 1 diverges: ' + d.join(' '));
    assert.ok(out.row.throws.some((m) => m.includes('metadata page pool exhausted (maxPages 1)')));
    // one token flipped in the stored results (first has/delete answer)
    const direct = replay(RoaringSet, VEC.streams[0], []).row;
    const toks = VEC.streams[0].res.split(',');
    const j = toks.findIndex((t) => t === 't' || t === 'f');
    assert.ok(j >= 0);
    toks[j] = toks[j] === 't' ? 'f' : 't';
    const bent = { ...VEC.streams[0], res: toks.join(',') };
    assert.deepEqual(diffRow(bent, direct, false), ['res']);
});

// --- one hidden class (C-5) ----------------------------------------------------------------------
const MAP_FROM = '        this._dir = new Uint16Array(paged ? dirLen : 0);\n';
const MAP_TO = '        if (paged) this._dir = new Uint16Array(dirLen);\n';

const CHILD = `
import { readFileSync } from 'node:fs';
const inp = JSON.parse(readFileSync(0, 'utf8'));
const out = {};
for (const name of Object.keys(inp)) {
    const { RoaringSet: RS } = await import(inp[name]);
    const d = new RS(4294967296);
    const d2 = new RS(4294967296, 0, 1);
    const p = new RS(4294967296, 0, 1, 1);
    const p6 = new RS(4294967296, 0, 1, 1014, 6);
    out[name] = { paged: [d.paged, d2.paged, p.paged, p6.paged], dd: %HaveSameMap(d, d2), dp: %HaveSameMap(d, p),
        pp: %HaveSameMap(p, p6), dp6: %HaveSameMap(d2, p6) };
}
process.stdout.write(JSON.stringify(out));
`;

test('A-4 %HaveSameMap(direct, paged) at 2^32 is true; the unassigned-_dir mutant -> false', () => {
    const anchors = SRC.split(MAP_FROM).length - 1;
    const jobs = { live: new URL('../LogLogN.js', import.meta.url).href };
    // the mutant job only when its anchor is unique; the live arm is asserted first either way
    if (anchors === 1) jobs.mut = 'data:text/javascript;base64,' + Buffer.from(SRC.replace(MAP_FROM, MAP_TO), 'utf8').toString('base64');
    const input = JSON.stringify(jobs);
    const r = spawnSync(process.execPath, ['--allow-natives-syntax', '--input-type=module', '-e', CHILD],
        { input, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, 'child exit ' + r.status + ' ' + r.signal + ': ' + r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.live, { paged: [false, false, true, true], dd: true, dp: true, pp: true, dp6: true });
    assert.equal(anchors, 1, 'mutant anchor count');
    assert.deepEqual(o.mut.paged, [false, false, true, true]);
    assert.equal(o.mut.dd, true, 'mutant control: two direct sets still share a map');
    assert.equal(o.mut.dp, false, 'mutant: direct without _dir has its own map');
});
