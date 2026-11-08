// @zakkster/lite-loglogn -- demo assertions (repo-only; PLAN-demo ASSERTIONS 1-6).
//
//   node --expose-gc --test demo/Demo.test.mjs      (npm run test:demo)
//
// Dev-only: NOT part of `npm test` / `npm run verify`; demo/ never ships. Written from the
// ASSERTIONS and the CONTRACT only (independent oracle): the OPSTREAM reference, the key-set
// reference, the successor oracle and the static scan below are this file's own code, never
// copied from the demo. Every row carries its must-fail control in the same test. Fail closed:
// a missing global gc, a missing child gc marker or a missing export is a FAIL, never a skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { vEBTree } from '../LogLogN.js';
import { mulberry32 as refTierMulberry, FNV_OFFSET, fnvWord, hex32 } from '../test/helpers/tierStream.mjs';
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { Treap } from '@zakkster/lite-logn';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(DEMO_DIR);
const P = '[lite-loglogn-demo-test] ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- lazy loaders (a missing demo file fails the test that needs it, not the whole file) -------

let _V = null;
let _R = null;
let _S = null;
let _W = null;
async function loadV() { return _V || (_V = await import('./Visualize.mjs')); }
async function loadR() { return _R || (_R = await import('./renderers.mjs')); }
async function loadS() { return _S || (_S = await import('./serve.mjs')); }
async function loadW() { return _W || (_W = await import('./witness-data.mjs')); }

// --- member lookup (exact names: MEMBERS = sb/xft/yft/veb/roar, FOIL = 'foil' at index 5; A7) ----

const SHORT = ['sb', 'xft', 'yft', 'veb', 'roar'];
function idxMap(V) {
    assert.deepStrictEqual([...V.MEMBERS], SHORT, 'MEMBERS must be exactly sb, xft, yft, veb, roar (A7)');
    assert.equal(V.FOIL, 'foil');
    return { sb: 0, xft: 1, yft: 2, veb: 3, roar: 4, foil: 5 };
}
function memberObj(V, e, short) {
    idxMap(V);
    assert.ok(Object.prototype.hasOwnProperty.call(e, short), P + 'engine has no field ' + short);
    return e[short];
}
async function rendererFor(short) {
    const Rm = await loadR();
    assert.ok(Rm.RENDERERS && typeof Rm.RENDERERS === 'object', P + 'renderers.mjs must export RENDERERS');
    assert.deepStrictEqual(Object.keys(Rm.RENDERERS), SHORT, 'RENDERERS keys');
    const r = Rm.RENDERERS[short];
    assert.ok(r && typeof r.model === 'function' && typeof r.draw === 'function' && typeof r.path === 'function' &&
        Array.isArray(r.fields), P + 'renderer ' + short + ' must be {fields, model, draw, path}');
    return r;
}
function sameHash(demoHash, ref32) {
    return typeof demoHash === 'string' ? demoHash === hex32(ref32) : demoHash === ref32;
}

// --- independent OPSTREAM reference (CONTRACT text) ---------------------------------------------

function refOpStream(V, kind, seed, U, n) {
    const rng = refTierMulberry(seed);
    const d = (m) => Math.floor(rng() * m);
    const KU = Math.min(U, 2 ** 30);
    const pool = new Uint32Array(n);
    for (let i = 0; i < n; i++) pool[i] = d(KU);
    const op = new Uint8Array(V.RING);
    const key = new Uint32Array(V.RING);
    let h = FNV_OFFSET;
    for (let i = 0; i < V.RING; i++) {
        let o;
        let k;
        if (kind === 'mixed') { o = d(4); k = o < 2 ? pool[d(n)] : d(KU); }
        else if (kind === 'query') { o = 2 + d(2); k = d(KU); }
        else { o = d(2); k = pool[d(n)]; }
        op[i] = o; key[i] = k;
        h = fnvWord(fnvWord(h, o), k);
    }
    return { op, key, pool, hash: h };
}
function refHashOf(op, key) {
    let h = FNV_OFFSET;
    for (let i = 0; i < op.length; i++) h = fnvWord(fnvWord(h, op[i]), key[i]);
    return h;
}
// reference live set after build (pre-add pool[0 .. n>>1)) and `steps` ring ops (0 = add, 1 = delete)
function refKeySet(ref, n, steps) {
    const s = new Set();
    for (let i = 0; i < (n >> 1); i++) s.add(ref.pool[i]);
    for (let i = 0; i < steps; i++) {
        if (ref.op[i % ref.op.length] === 0) s.add(ref.key[i % ref.op.length]);
        else if (ref.op[i % ref.op.length] === 1) s.delete(ref.key[i % ref.op.length]);
    }
    return Uint32Array.from([...s].sort((a, b) => a - b));
}
function refSucc(sorted, x) {                      // strict successor, undefined when none
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] > x) hi = mid; else lo = mid + 1; }
    return lo < sorted.length ? sorted[lo] : undefined;
}
function sbKeysFromWords(words0) {                 // key k = word k>>>5, bit k&31
    const out = [];
    for (let i = 0; i < words0.length; i++) {
        let w = words0[i] >>> 0;
        while (w !== 0) { const b = 31 - Math.clz32(w & -w); out.push(i * 32 + b); w &= w - 1; w >>>= 0; }
    }
    return Uint32Array.from(out);
}
function eqArr(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// --- generic model helpers ----------------------------------------------------------------------

function leafSlots(root, cap) {
    const out = [];
    const seen = new Set();
    (function walk(o) {
        if (o === null || typeof o !== 'object' || seen.has(o) || out.length >= cap) return;
        seen.add(o);
        if (ArrayBuffer.isView(o)) { for (let i = 0; i < o.length && out.length < cap; i++) out.push([o, i]); return; }
        for (const k of Object.keys(o)) {
            const v = o[k];
            if (typeof v === 'number') out.push([o, k]); else walk(v);
        }
    })(root);
    return out;
}
function bump(slot) { slot[0][slot[1]] = slot[0][slot[1]] + 1; }

// ================================================================================================
// A1 -- zero-alloc, scavenge-counted, child process, 1 MB semi-space (DETERMINISTIC)
// ================================================================================================

function runAllocChild(U, n) {
    const res = spawnSync(process.execPath,
        ['--expose-gc', '--max-semi-space-size=1', '--min-semi-space-size=1',
            join(DEMO_DIR, '_demo-alloc-child.mjs'), String(U), String(n)],
        { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 240000, cwd: REPO });
    const out = String(res.stdout || '');
    assert.ok(out.includes('GCMARK start') && out.includes('GCMARK done'),
        P + 'child gc marker missing (FAIL, never a skip); status ' + res.status + ' stderr ' +
        String(res.stderr || res.error || '').slice(0, 600));
    assert.equal(res.status, 0, P + 'child failed: ' + String(res.stderr).slice(0, 600));
    const by = {};
    const skipped = [];
    for (const line of out.split('\n')) {
        const p = line.split(' ');
        if (p[0] === 'RESULT') by[p[1]] = { ops: +p[2], scav: +p[3], majors: +p[4] };
        else if (p[0] === 'SKIP') skipped.push(p[1]);
    }
    return { by, skipped };
}

const AMBIENT = 1;
function assertAllocRows(V, U, n, expectAbsent) {
    const { by, skipped } = runAllocChild(U, n);
    const idx = idxMap(V);
    for (const id of ['step1', 'step8']) {
        assert.ok(by[id], P + 'missing window ' + id);
        assert.ok(by[id].scav <= AMBIENT, P + 'U=' + U + ' ' + id + ' scavenges ' + by[id].scav + ' > ' + AMBIENT);
        assert.equal(by[id].majors, 0, P + 'U=' + U + ' ' + id + ' MAJOR+INCREMENTAL GCs (retained per-op allocation)');
    }
    assert.equal(by.step1.ops, 1 << 20);
    assert.equal(by.step8.ops, 8 * (1 << 20));
    let ran = 0;
    for (let m = 0; m <= idx.foil; m++) {
        const id = 'batch' + m;
        const absent = expectAbsent && (m === idx.sb || m === idx.veb);
        if (absent) {
            assert.ok(skipped.includes(id) && !by[id], P + 'member ' + m + ' must be absent (null) at U=2^32');
            continue;
        }
        assert.ok(by[id], P + 'missing runBatch window for member ' + m + (m === idx.foil ? ' (the foil, A4)' : ''));
        assert.ok(by[id].ops >= (1 << 20), P + id + ' ran fewer than 2^20 ops');
        assert.ok(by[id].scav <= AMBIENT, P + 'runBatch member ' + m + ' scavenges ' + by[id].scav + ' > ' + AMBIENT);
        assert.equal(by[id].majors, 0, P + 'runBatch member ' + m + ' MAJOR+INCREMENTAL GCs');
        ran++;
    }
    assert.equal(ran, expectAbsent ? 4 : 6, P + 'members that ran');
    // sizeOf allocates 0 B (A9): 2^20 calls per member, same 1 MB semi-space method; absent members answer null (SKIP).
    let sized = 0;
    for (let m = 0; m <= idx.foil; m++) {
        const id = 'size' + m;
        const absent = expectAbsent && (m === idx.sb || m === idx.veb);
        if (absent) { assert.ok(skipped.includes(id) && !by[id], P + 'sizeOf member ' + m + ' must be null at U=2^32'); continue; }
        assert.ok(by[id], P + 'missing sizeOf window for member ' + m);
        assert.equal(by[id].ops, 1 << 20);
        assert.ok(by[id].scav <= AMBIENT, P + 'sizeOf member ' + m + ' scavenges ' + by[id].scav + ' > ' + AMBIENT);
        assert.equal(by[id].majors, 0, P + 'sizeOf member ' + m + ' MAJOR+INCREMENTAL GCs');
        sized++;
    }
    assert.equal(sized, expectAbsent ? 4 : 6, P + 'sizeOf members that ran');
    assert.ok(by.sizectl && by.sizectl.scav > 9, P + 'sizeOf control ({} per call) must exceed 9 scavenges, got ' + (by.sizectl && by.sizectl.scav));
    // CONTROL (must-fail): one {} per step -> > 9 scavenges, or the machinery is blind.
    assert.ok(by.control && by.control.scav > 9, P + 'control (one {} per step) must exceed 9 scavenges, got ' +
        (by.control && by.control.scav));
    // CONTROL (must-fail) for the majors field: one RETAINED {} per step -> >= 1 MAJOR+INCREMENTAL GC, or the field is blind.
    assert.ok(by.majctl && by.majctl.majors >= 1,
        P + 'majors control (one retained {} per step) must show >= 1 MAJOR+INCREMENTAL GC, got ' + (by.majctl && by.majctl.majors));
}

test('A1 zero-alloc: step() 2^20 and 8x, runBatch per member (foil included) <= 1 scavenge at U=2^24 n=2^16; control > 9',
    { timeout: 300000 }, async () => {
        const V = await loadV();
        assertAllocRows(V, 2 ** 24, 2 ** 16, false);
    });

test('A1 zero-alloc: same rows at U=2^32 (sb and vEB null, absent from the batch lane); control > 9',
    { timeout: 300000 }, async () => {
        const V = await loadV();
        const e = V.createEngine({ kind: 'mixed', seed: 1, U: 2 ** 32, n: 256 }, null);
        assert.equal(V.bytesOf(e, 'veb'), null, 'veb bytesOf must be null above VEB_U_MAX');
        assert.equal(V.bytesOf(e, 'sb'), null, 'sb bytesOf must be null above SB_U_MAX (D-8)');
        assertAllocRows(V, 2 ** 32, 2 ** 16, true);
    });

test('A1 child marker teeth: a child without --expose-gc prints no GCMARK start and exits non-zero', () => {
    const res = spawnSync(process.execPath, [join(DEMO_DIR, '_demo-alloc-child.mjs'), '65536', '256'],
        { encoding: 'utf8', timeout: 60000, cwd: REPO });
    assert.ok(!String(res.stdout).includes('GCMARK start'));
    assert.notEqual(res.status, 0);
});

// ================================================================================================
// A2 -- GC budget + retention
// ================================================================================================

test('A2 GC budget: 2^20 steps -> 0 major GCs, max pause <= 4 ms; control: a forced gc() IS seen as a major',
    { timeout: 120000 }, async () => {
        assert.equal(typeof gc, 'function', P + 'run with --expose-gc (npm run test:demo); never skipped');
        const V = await loadV();
        const e = V.createEngine({ kind: 'mixed', seed: 7, U: 2 ** 24, n: 2 ** 16 }, null);
        for (let i = 0; i < (1 << 16); i++) V.step(e);
        gc();
        await sleep(60);
        const prof = new GcProfiler().start();
        for (let i = 0; i < (1 << 20); i++) V.step(e);
        await sleep(100);
        const s = prof.summary();
        prof.stop();
        assert.equal(s.gc.major, 0, P + 'majors over 2^20 steps: ' + s.gc.major);
        assert.ok(s.gc.maxMs <= 4, P + 'max GC pause ' + s.gc.maxMs + ' ms > 4');
        assert.ok(checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 }).ok, P + 'checkNoGc not ok');
        // CONTROL: the same profiler machinery must flag a major.
        const p2 = new GcProfiler().start();
        gc();
        await sleep(100);
        const s2 = p2.summary();
        p2.stop();
        assert.ok(s2.gc.major >= 1, P + 'control: forced gc() produced no major in the profiler (blind gate)');
        assert.equal(checkNoGc(s2, { maxMajor: 0 }).ok, false, P + 'control: checkNoGc must reject a major');
    });

async function leakRun(V, retain, cycles) {
    assert.equal(typeof gc, 'function', P + 'run with --expose-gc; never skipped');
    const leaks = [];
    const tracker = createLeakTracker({ name: 'demo-a2', onLeak: (r) => leaks.push(r) });
    const keep = [];
    const noop = () => {};
    const idx = idxMap(V);
    const members = [];
    for (let m = 0; m < 5; m++) members.push(m);
    for (let c = 0; c < cycles; c++) {
        const eng = V.createEngine({ kind: 'mixed', seed: c + 1, U: 2 ** 16, n: 256 }, null);
        for (const m of members) V.runBatch(eng, m, 256);
        V.reset(eng);
        tracker.track(eng, noop, 'engine');
        if (retain) keep.push(eng);
    }
    for (let r = 0; r < 12; r++) {
        gc();
        await sleep(25);
        if (!retain && tracker.size() === 0) break;
    }
    const size = tracker.size();
    return { size, kept: keep.length, leaks: leaks.length };
}

test('A2 retention: 4096 build -> runBatch(256) -> reset cycles at U=2^16 return the leak tracker to 0; control retains 4096',
    { timeout: 200000 }, async () => {
        const V = await loadV();
        const real = await leakRun(V, false, 4096);
        assert.equal(real.size, 0, P + 'tracker live count after gc: ' + real.size);
        const ctl = await leakRun(V, true, 4096);
        assert.equal(ctl.kept, 4096);
        assert.equal(ctl.size, 4096, P + 'control: retaining every engine must leave the count at 4096, got ' + ctl.size);
    });

// ================================================================================================
// A3 -- no shadow state
// ================================================================================================

test('A3 key sets: after 2^16 mixed steps sb words = xft = yft = vEB keys, roar counts = key histogram, all = own reference',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        const seed = 0xC0FFEE;
        const U = 2 ** 20;
        const n = 2 ** 11;
        const e = V.createEngine({ kind: 'mixed', seed, U, n }, null);
        for (let i = 0; i < (1 << 16); i++) V.step(e);
        const ref = refKeySet(refOpStream(V, 'mixed', seed, U, n), n, 1 << 16);
        assert.ok(ref.length > 50, 'reference set too small to be meaningful: ' + ref.length);
        const sbKeys = sbKeysFromWords(memberObj(V, e, 'sb').dump().words[0]);
        const xftKeys = memberObj(V, e, 'xft').dump().keys;
        const yftKeys = memberObj(V, e, 'yft').dump().keys;
        const vebKeys = V.vebSnapshot(memberObj(V, e, 'veb')).keys;
        assert.ok(eqArr(sbKeys, xftKeys), 'sb vs xft');
        assert.ok(eqArr(xftKeys, yftKeys), 'xft vs yft');
        assert.ok(eqArr(yftKeys, vebKeys), 'yft vs veb');
        assert.ok(eqArr(sbKeys, ref), 'structures vs the independent reference set (assumes step() consumes the ring from index 0)');
        const hist = new Map();
        for (const k of ref) hist.set(k >>> 16, (hist.get(k >>> 16) || 0) + 1);
        const chunks = memberObj(V, e, 'roar').dump().chunks;
        assert.equal(chunks.length, hist.size, 'roar chunk count');
        for (const c of chunks) assert.equal(c.count, hist.get(c.chunk), 'roar chunk ' + c.chunk + ' count');
        // CONTROL: a one-key perturbation of the reference must be detected by the same comparison.
        const mut = Uint32Array.from(ref);
        mut[0] = mut[0] + 1;
        assert.ok(!eqArr(sbKeys, mut), 'control: perturbed reference must differ');
    });

function lcg(seed) { return refTierMulberry(seed); }
function buildVeb(U, count, seed) {
    const t = new vEBTree(U);
    const r = lcg(seed);
    const live = new Set();
    for (let i = 0; i < count; i++) { const k = Math.floor(r() * U); t.add(k); live.add(k); }
    for (let i = 0; i < count / 4; i++) { const k = [...live][Math.floor(r() * live.size)]; t.delete(k); live.delete(k); }
    return { t, live: Uint32Array.from([...live].sort((a, b) => a - b)) };
}

test('A3 vEB adapter: keys = successor chain from min() = has() scan at U=2^16 and U=2^28 (lo=16); size/universe/bits agree',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        // U=2^16: full has() scan
        const a = buildVeb(2 ** 16, 3000, 11);
        const sa = V.vebSnapshot(a.t);
        const scan = [];
        for (let x = 0; x < 2 ** 16; x++) if (a.t.has(x)) scan.push(x);
        assert.ok(eqArr(sa.keys, Uint32Array.from(scan)), 'U=2^16 keys vs has() scan');
        const chain = [];
        for (let x = a.t.min(); x !== undefined; x = a.t.successor(x)) chain.push(x);
        assert.ok(eqArr(sa.keys, Uint32Array.from(chain)), 'U=2^16 keys vs successor chain');
        assert.ok(eqArr(sa.keys, a.live), 'U=2^16 keys vs independent set');
        assert.equal(sa.size, a.t.size);
        assert.equal(sa.universe, 2 ** 16);
        assert.equal(sa.bits, 16);
        // U=2^28: successor chain + has() on every key and its neighbours (a full scan of 2^28 is not feasible)
        const b = buildVeb(2 ** 28, 4000, 12);
        const sb = V.vebSnapshot(b.t);
        const chain2 = [];
        for (let x = b.t.min(); x !== undefined; x = b.t.successor(x)) chain2.push(x);
        assert.ok(eqArr(sb.keys, Uint32Array.from(chain2)), 'U=2^28 keys vs successor chain');
        assert.ok(eqArr(sb.keys, b.live), 'U=2^28 keys vs independent set');
        const inSet = new Set(b.live);
        for (const k of sb.keys) {
            assert.ok(b.t.has(k));
            for (const nb of [k - 1, k + 1]) if (nb >= 0 && nb < 2 ** 28) assert.equal(b.t.has(nb), inSet.has(nb));
        }
        assert.equal(sb.bits, 28);
        assert.equal(sb.min, b.live[0]);
        assert.equal(sb.max, b.live[b.live.length - 1]);
    });

function cloneVeb(t) {
    const c = Object.assign(Object.create(Object.getPrototypeOf(t)), t);
    c._t = t._t.slice();
    return c;
}

test('A3 vEB field-pin teeth: _g deleted, _t renamed, _w wrong throw [lite-loglogn-demo]; vEBTree(1024) with _w=11 (same _t length) throws',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        const { t, live } = buildVeb(2 ** 16, 400, 21);
        assert.ok(eqArr(V.vebSnapshot(t).keys, live), 'sanity: the unmutated tree decodes to the reference');
        const noG = cloneVeb(t); delete noG._g;
        assert.throws(() => V.vebSnapshot(noG), /\[lite-loglogn-demo\]/, '_g deleted');
        const renT = cloneVeb(t); renT._tt = renT._t; delete renT._t;
        assert.throws(() => V.vebSnapshot(renT), /\[lite-loglogn-demo\]/, '_t renamed');
        const badW = cloneVeb(t); badW._w = t._w + 3;
        assert.throws(() => V.vebSnapshot(badW), /\[lite-loglogn-demo\]/, '_w wrong');
        // vEBTree(1024): w = 10, and a tree with w = 11 and U = 1024 has the SAME _t length (35 words, by the
        // layout g[w] + ceil(U / 2^8) * 8 with g[10] = g[11] = 3), so only the _w pin can reject _w = 11 (kills m2).
        const small = new vEBTree(1024);
        small.add(5); small.add(900);
        assert.deepStrictEqual([...V.vebSnapshot(small).keys], [5, 900]);
        const w11 = cloneVeb(small);
        w11._w = 11;
        assert.throws(() => V.vebSnapshot(w11), /\[lite-loglogn-demo\]/, 'vEBTree(1024) with _w = 11');
    });

// A9 section 2 targeted fixtures: U=2^16 tree {10, 20, 30, 300}. Layout (LogLogN.js vEBTree, w = 16, lo = 8): t[0], t[1] =
// root min / max; t[2..9] = the root summary leaf (bit j = cluster j non-empty); cluster j = 8 words at 10 + 8 j (key bit
// 256 j + 32 i + b = word 10 + 8 j + i, bit b). The max (300) is also stored in its cluster; the min (10) is not.
test('A3 vEB decode invariants V1-V5: each targeted fixture throws its own tag; U=2^28 F6 / F7 throw; control: the unmutated tree decodes',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        const base = new vEBTree(2 ** 16);
        for (const k of [10, 20, 30, 300]) base.add(k);
        assert.deepStrictEqual([...V.vebSnapshot(base).keys], [10, 20, 30, 300], 'sanity');
        assert.equal(base._t[0], 10);
        assert.equal(base._t[1], 300);
        assert.equal(base._t[10] >>> 0, ((1 << 20) | (1 << 30)) >>> 0, 'cluster 0 word 0 holds keys 20 and 30');
        assert.equal(base._t[2] >>> 0, 3, 'summary: clusters 0 and 1');
        const fx = (fn) => { const c = cloneVeb(base); fn(c, c._t); return c; };
        const F = {
            'F1 _size=5': [fx((c) => { c._size = 5; }), /vEBTree decode V1/],
            'F3 t[10] bit 10 + _size=5': [fx((c, t) => { t[10] |= 1 << 10; c._size = 5; }), /vEBTree decode V3/],
            'F4 t[1]=299': [fx((c, t) => { t[1] = 299; }), /vEBTree decode V4/],
            'F5 t[2] bit 5': [fx((c, t) => { t[2] |= 1 << 5; }), /vEBTree decode V5/]
        };
        const empty = new vEBTree(2 ** 16);
        const f2 = cloneVeb(empty); f2._t[1] = 7;
        F['F2 empty t[1]=7'] = [f2, /vEBTree decode V2/];
        const one = new vEBTree(2 ** 16);
        one.add(5);
        const f2b = cloneVeb(one); f2b._t[0] = 65536; f2b._t[1] = 65536;
        F['F2b size-1 t[0]=t[1]=65536'] = [f2b, /vEBTree decode V2/];
        const lf = new vEBTree(100); lf.add(3); const f2c = cloneVeb(lf); f2c._t[3] |= 1 << 4; f2c._size = 2;
        F['F2c root leaf key 100 = _u'] = [f2c, /vEBTree decode V2/];
        assert.deepStrictEqual([...V.vebSnapshot(empty).keys], [], 'empty sanity');
        assert.deepStrictEqual([...V.vebSnapshot(one).keys], [5], 'size-1 sanity');
        for (const name of Object.keys(F)) assert.throws(() => V.vebSnapshot(F[name][0]), F[name][1], name);
        // U = 2^28 (lo = 16): cluster 3 holds keys 3*65536 + {7, 300, 9000}; it is not the last cluster.
        const big = new vEBTree(2 ** 28);
        const c3 = 3 * 65536;
        for (const k of [5, c3 + 7, c3 + 300, c3 + 9000, 10 * 65536 + 1]) big.add(k);
        assert.deepStrictEqual([...V.vebSnapshot(big).keys], [5, c3 + 7, c3 + 300, c3 + 9000, 10 * 65536 + 1], 'U=2^28 sanity');
        const cb = big._g[28] + 3 * 2058;                  // cluster 3: header [min, max], summary leaf at +2, leaves at +10 + 8 s
        assert.equal(big._t[cb], 7);
        assert.equal(big._t[cb + 1], 9000);
        const f6 = cloneVeb(big); f6._t[cb + 1] += 1;
        assert.throws(() => V.vebSnapshot(f6), /vEBTree decode V4/, 'F6 cluster max slot + 1');
        const f7 = cloneVeb(big);
        assert.equal(f7._t[cb + 2 + (200 >>> 5)] & (1 << (200 & 31)), 0, 'F7 precondition: summary bit 200 clear');
        for (let q = 0; q < 8; q++) assert.equal(f7._t[cb + 10 + 200 * 8 + q], 0, 'F7 precondition: leaf 200 empty');
        f7._t[cb + 2 + (200 >>> 5)] |= 1 << (200 & 31);
        assert.throws(() => V.vebSnapshot(f7), /vEBTree decode V5/, 'F7 summary bit for an empty leaf');
        const c5 = big._g[28] + 5 * 2058; assert.equal(big._t[c5] >>> 0, 0xFFFFFFFF, 'F8 precondition: cluster 5 EMPTY'); const f8 = cloneVeb(big); f8._t[c5 + 10] |= 1; assert.throws(() => V.vebSnapshot(f8), /vEBTree decode V2/, 'F8 leaf bit under an EMPTY lo=16 header');
    });

test('A3 vEB exhaustive word flip (U=2^16, 400 keys): 0 silent-same; the silent-different set is exactly {word 0, bit b : (min ^ 1<<b) < keys[1]}',
    { timeout: 200000 }, async () => {
        const V = await loadV();
        const { t, live } = buildVeb(2 ** 16, 400, 21);
        assert.ok(live.length >= 2, 'precondition size >= 2');
        assert.ok(live[0] > 0, 'precondition min > 0');
        assert.equal(t._t[0], live[0], 'layout: the root min lives in word 0');
        const c = cloneVeb(t);
        let silentSame = 0;
        let throws = 0;
        const diff = [];
        for (let wi = 0; wi < c._t.length; wi++) {
            for (let b = 0; b < 32; b++) {
                c._t[wi] ^= (1 << b);
                try {
                    const k = V.vebSnapshot(c).keys;
                    if (eqArr(k, live)) silentSame++; else diff.push(wi + ':' + b);
                } catch (err) {
                    if (!/^\[lite-loglogn-demo\]/.test(String(err && err.message))) throw err;
                    throws++;
                } finally {
                    c._t[wi] ^= (1 << b);
                }
            }
        }
        assert.ok(eqArr(c._t, t._t), 'every flip was restored');
        assert.equal(silentSame, 0, 'a flip decoded silently to the SAME keys');
        // A lowered / altered root min is stored only in the header: undetectable while it stays below the smallest cluster key.
        const expected = [];
        for (let b = 0; b < 32; b++) if (((live[0] ^ (1 << b)) >>> 0) < live[1]) expected.push('0:' + b);
        assert.ok(expected.length >= 1, 'vacuous expectation');
        assert.deepStrictEqual(diff, expected, 'silent-different set');
        assert.equal(throws + diff.length, c._t.length * 32, 'every flip is a throw or a silent-different decode');
    });

// --- shared A3 path / proxy case: U=2^20, n=2^10, 4096 mixed steps (live set from the OWN reference) ----

let _pathCase = null;
async function pathCase() {
    if (_pathCase !== null) return _pathCase;
    const V = await loadV();
    const seed = 0xC0FFEE;
    const U = 2 ** 20;
    const n = 2 ** 10;
    const e = V.createEngine({ kind: 'mixed', seed, U, n }, null);
    for (let i = 0; i < 4096; i++) V.step(e);
    const live = refKeySet(refOpStream(V, 'mixed', seed, U, n), n, 4096);
    _pathCase = { V, e, live, U, xs: buildPathXs(live, U) };
    return _pathCase;
}
// A9 x set: 256 live keys (min and max among them); 256 x = key-1 (x not a key); min, min-1, max, max-1, max+1, 0,
// U-1, U, U+1, 2^32-1; 500 uniform in [0, U).
function buildPathXs(live, U) {
    const L = live.length;
    assert.ok(L >= 300, 'live set too small for the x set: ' + L);
    const set = new Set(live);
    const xs = [];
    const picked = new Set();
    for (let i = 0; i < 255; i++) picked.add(Math.floor((i * L) / 255));
    picked.add(0);
    picked.add(L - 1);
    for (const i of picked) xs.push(live[i]);
    let got = 0;
    for (let i = 0; got < 256 && i < 4 * L; i++) {
        const k = live[(i * 3 + 1) % L];
        if (k >= 1 && !set.has(k - 1)) { xs.push(k - 1); got++; }
    }
    const mn = live[0];
    const mx = live[L - 1];
    for (const x of [mn, mn - 1, mx, mx - 1, mx + 1, 0, U - 1, U, U + 1, 2 ** 32 - 1]) if (x >= 0) xs.push(x);
    const r = refTierMulberry(0x5EED);
    for (let i = 0; i < 500; i++) xs.push(Math.floor(r() * U));
    return xs;
}
// Oracle-side coverage floor, asserted BEFORE any verdict (A9): a degenerate x set is a hard failure.
function pathCoverage(xs, live, U) {
    const set = new Set(live);
    let isKey = 0;
    let keyM1 = 0;
    let none = 0;
    let geU = 0;
    for (const x of xs) {
        if (set.has(x)) isKey++;
        else if (set.has(x + 1)) keyM1++;
        if (refSucc(live, x) === undefined) none++;
        if (x >= U) geU++;
    }
    return { isKey, keyM1, none, geU, hasMin: xs.includes(live[0]), hasMax: xs.includes(live[live.length - 1]) };
}
function assertCoverage(xs, live, U) {
    const c = pathCoverage(xs, live, U);
    assert.ok(c.isKey >= 256 && c.hasMin && c.hasMax, 'coverage: x-is-key ' + c.isKey + ' (>= 256, incl min and max)');
    assert.ok(c.keyM1 >= 200, 'coverage: key-1 ' + c.keyM1 + ' (>= 200)');
    assert.ok(c.none >= 4, 'coverage: no-successor ' + c.none + ' (>= 4)');
    assert.ok(c.geU >= 3, 'coverage: x >= U ' + c.geU + ' (>= 3)');
}

// path verdict. exact / non-roar: last.key === successor(x). roar not-exact (dump has counts, not keys): key undefined,
// lo >= x+1, successor in [lo, hi) when there is one, hi <= end of the first live chunk after chunk(x), else
// hi <= end of chunk(x). `chunks` = ascending live chunk numbers from the oracle's own key set.
function pathVerdict(isRoar, p, x, want, chunks, U) {
    if (!Array.isArray(p) || p.length === 0) return false;
    const last = p[p.length - 1];
    if (last.last !== true) return false;
    if (!isRoar || last.exact === true) return last.key === want;
    if (last.key !== undefined || last.exact !== false) return false;
    if (!(last.lo >= x + 1) || !(last.hi >= last.lo)) return false;
    const c = Math.floor(x / 65536);
    let nxt = -1;
    for (let i = 0; i < chunks.length; i++) if (chunks[i] > c) { nxt = chunks[i]; break; }
    const bound = Math.min(U, ((nxt >= 0 ? nxt : c) + 1) * 65536);
    if (!(last.hi <= bound)) return false;
    if (want !== undefined && !(want >= last.lo && want < last.hi)) return false;
    return true;
}
function liveChunksOf(live) {
    const out = [];
    for (const k of live) { const c = k >>> 16; if (out.length === 0 || out[out.length - 1] !== c) out.push(c); }
    return out;
}

// --- A10 (c): the NON-LAST steps of a path, per member, from the OWN live key set (plus the snapshot's structure
// data where the keys do not determine it: yft reps / sizes, veb lo, sb word counts). Step semantics are the
// renderers.mjs header contract: sb step = word wi of level L covers [wi 32^(L+1), (wi+1) 32^(L+1)); xft step =
// prefix p of length `level` covers [p 2^(w-level), (p+1) 2^(w-level)); yft level 0 = rep probe [r, r+1), level 1 =
// bucket [reps[i], reps[i+1] or U); veb level 0 = root [0, U) then cluster j covers [j 2^lo, (j+1) 2^lo); roar
// level 0 = live chunk c covers [c 2^16, (c+1) 2^16). This oracle never calls renderers code.
function lowerIdx(arr, v) { let a = 0; let b = arr.length; while (a < b) { const m = (a + b) >>> 1; if (arr[m] < v) a = m + 1; else b = m; } return a; }
function distinctFloors(live, unit) {
    const out = [];
    for (const k of live) { const p = Math.floor(k / unit); if (out.length === 0 || out[out.length - 1] !== p) out.push(p); }
    return out;
}
function stepOracle(s, model, live, U) {
    const st = (level, index, lo, hi) => ({ level, index, lo, hi });
    const nL = live.length;
    if (s === 'sb') {
        const top = model.words.length - 1;
        const P = model.words.map((_w, L) => distinctFloors(live, 32 ** L));
        return (x) => {
            const out = [];
            const y = x + 1;
            if (nL === 0 || y >= U) return out;
            let L = 0;
            let i = y;
            let found = false;
            for (;;) {
                const wi = Math.floor(i / 32);
                if (wi >= model.words[L].length) break;
                const span = 32 ** (L + 1);
                out.push(st(L, wi, wi * span, Math.min(U, (wi + 1) * span)));
                const q = lowerIdx(P[L], i);
                const nx = q < P[L].length ? P[L][q] : -1;
                if (nx >= 0 && Math.floor(nx / 32) === wi) { i = nx; found = true; break; }
                if (L === top) {
                    if (nx < 0) break;
                    const k = Math.floor(nx / 32);
                    out.push(st(L, k, k * span, Math.min(U, (k + 1) * span)));
                    i = nx; found = true; break;
                }
                L++;
                i = wi + 1;
            }
            if (!found) return out;
            while (L > 0) {
                L--;
                const span = 32 ** (L + 1);
                out.push(st(L, i, i * span, Math.min(U, (i + 1) * span)));
                i = P[L][lowerIdx(P[L], i * 32)];
            }
            return out;
        };
    }
    if (s === 'xft') {
        const w = model.bits;
        const P = [null];
        for (let l = 1; l <= w; l++) P.push(distinctFloors(live, 2 ** (w - l)));
        return (x) => {
            const out = [];
            if (x >= U || nL === 0) return out;
            let a = 0;
            let b = w;
            while (a < b) {
                const mid = (a + b + 1) >>> 1;
                const unit = 2 ** (w - mid);
                const p = Math.floor(x / unit);
                const q = lowerIdx(P[mid], p);
                const idx = q < P[mid].length && P[mid][q] === p ? q : -1;
                out.push(st(mid, idx, p * unit, Math.min(U, (p + 1) * unit)));
                if (idx >= 0) a = mid; else b = mid - 1;
            }
            if (a === w || a === 0) return out;
            if (Math.floor(x / 2 ** (w - a - 1)) % 2 === 0) return out;
            const pre = Math.floor(x / 2 ** (w - a));
            const kEnd = lowerIdx(live, (pre + 1) * 2 ** (w - a)) - 1;
            out.push(st(w, kEnd, live[kEnd], live[kEnd] + 1));
            return out;
        };
    }
    if (s === 'yft') {
        const reps = model.reps;
        const sizes = model.sizes;
        const R = reps.length;
        return (x) => {
            const out = [];
            if (nL === 0 || R === 0) return out;
            let a = 0;
            let b = R - 1;
            while (a < b) {
                const mid = (a + b + 1) >>> 1;
                out.push(st(0, mid, reps[mid], reps[mid] + 1));
                if (reps[mid] <= x) a = mid; else b = mid - 1;
            }
            let off = 0;
            for (let i = 0; i < a; i++) off += sizes[i];
            out.push(st(1, a, reps[a], a + 1 < R ? reps[a + 1] : U));
            for (let bi = a; bi < R; bi++) {
                const sz = sizes[bi];
                if (bi > a && sz > 0) out.push(st(1, bi, reps[bi], bi + 1 < R ? reps[bi + 1] : U));
                for (let k = off; k < off + sz && k < nL; k++) if (live[k] > x) return out;
                off += sz;
            }
            return out;
        };
    }
    if (s === 'veb') {
        const unit = 2 ** model.lo;
        const cj = distinctFloors(live.slice(1), unit);   // the vEB min lives only in the root header, in no cluster
        const leaf = !(model.lo > 0 && model.lo < model.bits) || cj.length === 0;
        return (x) => {
            if (nL === 0) return [];
            const out = [st(0, -1, 0, U)];
            if (x < live[0] || leaf) return out;
            const jx = Math.floor(x / unit);
            let ci = lowerIdx(cj, jx);
            if (ci < cj.length && cj[ci] === jx) {
                out.push(st(0, ci, jx * unit, Math.min(U, (jx + 1) * unit)));
                const k = lowerIdx(live, x + 1);
                if (k < nL && live[k] < (jx + 1) * unit) return out;
                ci++;
            }
            if (ci < cj.length) out.push(st(0, ci, cj[ci] * unit, Math.min(U, (cj[ci] + 1) * unit)));
            return out;
        };
    }
    // roar
    const CH = 65536;
    const chs = distinctFloors(live, CH);
    const cnt = new Map();
    for (const k of live) cnt.set(k >>> 16, (cnt.get(k >>> 16) || 0) + 1);
    const full = (c) => cnt.get(c) === Math.min(CH, U - c * CH);
    return (x) => {
        const out = [];
        if (nL === 0) return out;
        const c = Math.floor(x / CH);
        let a = 0;
        let b = chs.length;
        while (a < b) {
            const mid = (a + b) >>> 1;
            out.push(st(0, mid, chs[mid] * CH, Math.min(U, (chs[mid] + 1) * CH)));
            if (chs[mid] < c) a = mid + 1; else b = mid;
        }
        let ci = a;
        if (ci < chs.length && chs[ci] === c) {
            if (!full(c)) return out;
            if (x + 1 < Math.min(U, (c + 1) * CH)) return out;
            ci++;
        }
        if (ci >= chs.length) return out;
        out.push(st(0, ci, chs[ci] * CH, Math.min(U, (chs[ci] + 1) * CH)));
        return out;
    };
}
/** '' when every non-last step of p matches the oracle's steps (level, index, lo, hi) and carries plain-step flags. */
function stepsVerdict(p, expected) {
    if (!Array.isArray(p) || p.length === 0) return 'empty path';
    const mid = p.slice(0, -1);
    if (mid.length !== expected.length) return 'step count ' + mid.length + ' != ' + expected.length;
    for (let i = 0; i < mid.length; i++) {
        const s = mid[i];
        const e = expected[i];
        if (s.last !== false || s.exact !== true || s.key !== undefined) return 'step ' + i + ' flags';
        if (s.level !== e.level || s.index !== e.index || s.lo !== e.lo || s.hi !== e.hi) {
            return 'step ' + i + ' ' + JSON.stringify([s.level, s.index, s.lo, s.hi]) + ' != ' + JSON.stringify([e.level, e.index, e.lo, e.hi]);
        }
    }
    return '';
}

test('A3 path ends at successor(x): 256 keys + 256 key-1 + edges + 500 uniform per member, coverage floor first; roar not-exact bracket rule; control: a mutated model mismatches',
    { timeout: 120000 }, async () => {
        const { V, e, live, U, xs } = await pathCase();
        const idx = idxMap(V);
        assertCoverage(xs, live, U);
        // the floor itself has teeth: a uniform-only x set must fail it.
        assert.throws(() => assertCoverage(xs.slice(xs.length - 500), live, U), /coverage/, 'control: the coverage floor must reject a uniform-only set');
        const chunks = liveChunksOf(live);
        for (const s of SHORT) {
            const R = await rendererFor(s);
            const model = R.model(V.snapshot(e, idx[s]));
            let ok = 0;
            const oracle = stepOracle(s, model, live, U);
            let stepsChecked = 0;
            for (const x of xs) {
                const p = R.path(model, x);
                if (pathVerdict(s === 'roar', p, x, refSucc(live, x), chunks, U)) ok++;
                // every INTERMEDIATE step (A10 c): level / index / lo / hi from the oracle, not just the path end
                const sv = stepsVerdict(p, oracle(x));
                assert.equal(sv, '', s + ': x=' + x + ' intermediate steps: ' + sv);
                stepsChecked += p.length - 1;
            }
            assert.ok(stepsChecked >= xs.length, s + ': intermediate-step coverage ' + stepsChecked + ' steps (vacuous check)');
            assert.equal(ok, xs.length, s + ': path end == successor(x) (roar: bracket rule) for ' + ok + '/' + xs.length);
            // CONTROL: the same model with every number bumped must mismatch somewhere (or throw).
            const bad = structuredClone(model);
            for (const slot of leafSlots(bad, 300000)) bump(slot);
            let mism = 0;
            for (const x of xs) {
                let good;
                try { good = pathVerdict(s === 'roar', R.path(bad, x), x, refSucc(live, x), chunks, U); } catch (_e) { mism++; continue; }
                if (!good) mism++;
            }
            assert.ok(mism > 0, s + ' control: a mutated model must mismatch the successor oracle');
        }
    });

test('A3 path roar, hand-built model U=2^20 with a full chunk: exact branch >= 3 hits, bracket rule everywhere; control: a wrong successor is rejected',
    { timeout: 60000 }, async () => {
        const R = await rendererFor('roar');
        const U = 2 ** 20;
        const model = {
            universe: U, size: 2 + 65536 + 1, paged: false,
            chunks: [
                { chunk: 0, kind: 'array', count: 2, runs: 0 },
                { chunk: 1, kind: 'full', count: 65536, runs: 0 },
                { chunk: 3, kind: 'array', count: 1, runs: 0 }
            ]
        };
        // keys {5, 9} U [65536, 131072) U {200000}; successor from the interval list (strict).
        const iv = [[5, 5], [9, 9], [65536, 131071], [200000, 200000]];
        const succ = (x) => { for (const [lo, hi] of iv) if (hi > x) return Math.max(lo, x + 1); return undefined; };
        const xs = [0, 4, 5, 8, 9, 10, 65535, 65536, 65537, 100000, 131070, 131071, 131072, 150000, 196607, 199999, 200000, 200001, U - 1];
        const r = refTierMulberry(0xFACE);
        for (let i = 0; i < 256; i++) xs.push(Math.floor(r() * U));
        const chunks = [0, 1, 3];
        let exactHits = 0;
        for (const x of xs) {
            const p = R.path(model, x);
            assert.ok(pathVerdict(true, p, x, succ(x), chunks, U), 'hand roar x=' + x + ' -> ' + JSON.stringify(p[p.length - 1]));
            const last = p[p.length - 1];
            if (last.exact === true && last.key !== undefined) exactHits++;
        }
        assert.ok(exactHits >= 3, 'exact branch hit ' + exactHits + ' times (>= 3)');
        for (const x of [65536, 100000, 131070]) assert.equal(R.path(model, x).at(-1).key, x + 1, 'full chunk: exact x+1 at ' + x);
        // CONTROL: the verdict rejects a wrong exact key and an over-wide bracket (hi = U).
        assert.equal(pathVerdict(true, [{ last: true, exact: true, key: 65538, lo: 0, hi: 0 }], 65536, 65537, chunks, U), false);
        assert.equal(pathVerdict(true, [{ last: true, exact: false, key: undefined, lo: 65536, hi: U }], 65535, 65536, chunks, U), false);
    });

// --- A3-proxy: the draw + path read ONLY the fields the renderer declares -------------------------------

function strictProxy(target, allowed, reads) {
    const chk = (k) => {
        if (typeof k === 'string' && !allowed.includes(k)) throw new Error(P + 'read of non-field "' + k + '"');
    };
    return new Proxy(target, {
        get(t, k, rcv) { chk(k); if (typeof k === 'string') reads.add(k); return Reflect.get(t, k, rcv); },
        has(t, k) { chk(k); return Reflect.has(t, k); },
        getOwnPropertyDescriptor(t, k) { chk(k); return Reflect.getOwnPropertyDescriptor(t, k); }
    });
}

test('A3 no shadow state (proxy): model/draw/path read exactly R.fields of the snapshot / model; an inherited field makes model() throw',
    { timeout: 120000 }, async () => {
        const { V, e, xs } = await pathCase();
        const idx = idxMap(V);
        for (const s of SHORT) {
            const R = await rendererFor(s);
            const snap = V.snapshot(e, idx[s]);
            assert.ok(snap !== null && typeof snap === 'object', s + ' snapshot');
            const want = [...R.fields].sort();
            // model(P(snap)): reads exactly the declared fields (a field outside the list would throw in the trap)
            const snapReads = new Set();
            const model = R.model(strictProxy(snap, R.fields, snapReads));
            assert.deepStrictEqual([...snapReads].sort(), want, s + ': model() reads of the snapshot');
            assert.deepStrictEqual(Object.keys(model), [...R.fields], s + ': model keys are exactly fields, in order');
            // draw + path on P(model): throws on a read outside fields; every field must be read by draw or path.
            const modelReads = new Set();
            const pm = strictProxy(model, R.fields, modelReads);
            const rec = recorder();
            R.draw(rec.g, pm, GEOM);
            for (const x of xs) R.path(pm, x);
            R.draw(rec.g, pm, { ...GEOM, path: R.path(pm, xs[0]) });
            assert.deepStrictEqual([...modelReads].sort(), want, s + ': draw + path reads of the model');
            // CONTROL: a model that omits one declared field makes draw or path throw (the proxy is not vacuous).
            for (const f of R.fields) {
                const slim = { ...model };
                delete slim[f];
                const allowed = R.fields.filter((q) => q !== f);
                const bad = strictProxy(slim, allowed, new Set());
                let threw = false;
                try { R.draw(recorder().g, bad, GEOM); for (const x of xs) R.path(bad, x); } catch (_e) { threw = true; }
                assert.ok(threw, s + ' control: draw/path never read field "' + f + '" (it would be invisible to the shadow check)');
            }
            // inherited (non-own) snapshot field -> model() throws [lite-loglogn-demo], one field at a time
            for (const f of R.fields) {
                const own = { ...snap };
                delete own[f];
                const inh = Object.assign(Object.create({ [f]: snap[f] }), own);
                assert.throws(() => R.model(inh), /\[lite-loglogn-demo\]/, s + ': inherited field "' + f + '" must throw');
            }
            const allInh = Object.create(snap);
            assert.throws(() => R.model(allInh), /\[lite-loglogn-demo\]/, s + ': all-inherited snapshot must throw');
        }
    });

test('A3 dial-grid corners: U in {2^16,2^24,2^28,2^32} x n in {2^8,2^16} x 3 kinds -> build + 2^16 steps, no member throws (A2)',
    { timeout: 280000 }, async () => {
        const V = await loadV();
        for (const U of [2 ** 16, 2 ** 24, 2 ** 28, 2 ** 32]) {
            for (const n of [2 ** 8, 2 ** 16]) {
                for (const kind of ['mixed', 'query', 'churn']) {
                    const tag = 'U=' + U + ' n=' + n + ' ' + kind;
                    let e;
                    try {
                        e = V.createEngine({ kind, seed: 3, U, n }, Treap);
                        for (let i = 0; i < (1 << 16); i++) V.step(e);
                        for (let m = 0; m <= 5; m++) {
                            const absent = (m === 0 && U > V.SB_U_MAX) || (m === 3 && U > V.VEB_U_MAX);
                            const rb = V.runBatch(e, m, 256);
                            assert.ok(absent ? rb === -1 : rb !== -1, tag + ' runBatch(' + m + ') = ' + rb);
                            assert.ok(absent ? V.bytesOf(e, m) === null : V.bytesOf(e, m) > 0, tag + ' bytesOf(' + m + ')');
                            assert.ok(absent ? V.snapshot(e, m) === null : V.snapshot(e, m) !== null, tag + ' snapshot(' + m + ')');
                        }
                    } catch (err) {
                        assert.fail(P + tag + ' threw: ' + (err && err.message));
                    }
                }
            }
        }
        // CONTROL: the harness is not vacuous -- an invalid config must throw through the same call.
        assert.throws(() => V.createEngine({ kind: 'nonsense', seed: 3, U: 2 ** 16, n: 256 }, null));
    });

test('A3 absent members (D-8): above SB_U_MAX / VEB_U_MAX e.sb / e.veb are null; snapshot/bytesOf null, runBatch -1 (never 0); the rest agree',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        assert.equal(V.SB_U_MAX, 2 ** 28);
        assert.equal(V.VEB_U_MAX, 2 ** 28);
        const e = V.createEngine({ kind: 'mixed', seed: 5, U: 2 ** 32, n: 2 ** 10 }, Treap);
        for (let i = 0; i < (1 << 14); i++) V.step(e);
        assert.equal(e.sb, null);
        assert.equal(e.veb, null);
        for (const m of ['sb', 'veb', 0, 3]) {
            assert.equal(V.snapshot(e, m), null, 'snapshot ' + m);
            assert.equal(V.bytesOf(e, m), null, 'bytesOf ' + m);
            assert.equal(V.runBatch(e, m, 100), -1, 'runBatch ' + m);
        }
        // present members agree on the key set (xft = yft = roar histogram)
        const ref = refKeySet(refOpStream(V, 'mixed', 5, 2 ** 32, 2 ** 10), 2 ** 10, 1 << 14);
        assert.ok(eqArr(e.xft.dump().keys, ref), 'xft vs reference');
        assert.ok(eqArr(e.yft.dump().keys, ref), 'yft vs reference');
        const hist = new Map();
        for (const k of ref) hist.set(k >>> 16, (hist.get(k >>> 16) || 0) + 1);
        const chunks = e.roar.dump().chunks;
        assert.equal(chunks.length, hist.size);
        for (const c of chunks) assert.equal(c.count, hist.get(c.chunk));
        // CONTROL: a present member must NOT report null / -1 through the same calls.
        assert.ok(V.bytesOf(e, 'xft') > 0);
        assert.notEqual(V.runBatch(e, 'xft', 100), -1);
        assert.notEqual(V.runBatch(e, 'foil', 100), -1);
        const e2 = V.createEngine({ kind: 'mixed', seed: 5, U: 2 ** 28, n: 2 ** 10 }, null);
        assert.notEqual(e2.sb, null, 'sb present at exactly SB_U_MAX');
        assert.notEqual(e2.veb, null, 'veb present at exactly VEB_U_MAX');
        assert.equal(V.runBatch(e2, 'foil', 100), -1, 'no foil -> -1');
    });

test('B1-2 crossover / fitLog2w / createEngine options door: exact cases; Seed typo has a hint; missing n, Symbol key, prototype bags throw',
    () => {
        return loadV().then((V) => {
            assert.equal(V.crossover([256, 1024], [5, 5], [4, 4], 2), null);
            assert.equal(V.crossover([256, 1024], [5, 3], [4, 4], 2), 1024);
            assert.equal(V.crossover([256, 1024], [3, 3], [4, 4], 2), 256);
            assert.equal(V.crossover([256, 1024], [3, NaN], [4, 4], 2), null);
            assert.equal(V.crossover([], [], [], 0), null);
            const fit = V.fitLog2w([16, 32], [1, 2], 2);
            assert.ok(fit !== null && Math.abs(fit.slope - 1) < 1e-12 && Math.abs(fit.intercept + 3) < 1e-12 && Math.abs(fit.r2 - 1) < 1e-12,
                'fit of ns = log2(w) - 3: ' + JSON.stringify(fit));
            assert.equal(V.fitLog2w([16, 16], [1, 2], 2), null);
            assert.equal(V.fitLog2w([16], [1], 1), null);
            assert.equal(V.fitLog2w([16, 32], [1, NaN], 2), null);
            assert.equal(V.fitLog2w([0, 32], [1, 2], 2), null);
            const base = { kind: 'mixed', seed: 1, U: 2 ** 16, n: 256 };
            assert.equal(typeof V.createEngine(base, null), 'object', 'sanity: the base options build');
            assert.throws(() => V.createEngine({ ...base, Seed: 1 }, null), /did you mean "seed"/);
            const noN = { ...base }; delete noN.n;
            assert.throws(() => V.createEngine(noN, null), /\[lite-loglogn-demo\]/);
            assert.throws(() => V.createEngine({ ...base, [Symbol('k')]: 1 }, null), /\[lite-loglogn-demo\]/);
            assert.throws(() => V.createEngine(Object.create(base), null), /\[lite-loglogn-demo\]/);
            assert.throws(() => V.createEngine(Object.assign(Object.create({ extra: 1 }), base), null), /\[lite-loglogn-demo\]/);
            assert.throws(() => V.createEngine([base], null), /\[lite-loglogn-demo\]/);
        });
    });

test('B1-1 / sizeOf: bytesOf of a foil with no typed-array fields is null (not 0); sizeOf === snapshot(e, m).size per member, null when absent',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        // a Map-backed foil: correct behaviour, nothing measurable (no typed array anywhere)
        class MapFoil {
            constructor() { this.m = new Map(); }
            get size() { return this.m.size; }
            set(k, v) { this.m.set(k, v); }
            delete(k) { return this.m.delete(k); }
            clear() { this.m.clear(); }
            forEach(fn) { for (const k of [...this.m.keys()].sort((a, b) => a - b)) fn(k, this.m.get(k)); }
            successor(x) { let r; for (const k of this.m.keys()) if (k > x && (r === undefined || k < r)) r = k; return r; }
            predecessor(x) { let r; for (const k of this.m.keys()) if (k < x && (r === undefined || k > r)) r = k; return r; }
        }
        const e = V.createEngine({ kind: 'mixed', seed: 7, U: 2 ** 20, n: 2 ** 9 }, MapFoil);
        for (let i = 0; i < 2048; i++) V.step(e);
        assert.equal(V.bytesOf(e, 'foil'), null, 'bytesOf(foil) with nothing measurable must be null, not 0');
        const t = V.createEngine({ kind: 'mixed', seed: 7, U: 2 ** 20, n: 2 ** 9 }, Treap);
        for (let i = 0; i < 2048; i++) V.step(t);
        assert.ok(V.bytesOf(t, 'foil') > 0, 'Treap foil is measurable');
        for (const eng of [e, t]) {
            for (let m = 0; m <= 5; m++) {
                const s = V.sizeOf(eng, m);
                assert.equal(typeof s, 'number', 'sizeOf(' + m + ')');
                assert.equal(s, V.snapshot(eng, m).size, 'sizeOf(' + m + ') === snapshot size');
                assert.equal(V.sizeOf(eng, V.MEMBERS[m] || V.FOIL), s, 'sizeOf by name');
            }
        }
        // absent: sb / veb above 2^28, no foil
        const big = V.createEngine({ kind: 'mixed', seed: 5, U: 2 ** 32, n: 2 ** 10 }, null);
        for (const m of ['sb', 'veb', 'foil', 0, 3, 5]) assert.equal(V.sizeOf(big, m), null, 'sizeOf absent ' + m);
        for (const m of ['xft', 'yft', 'roar']) assert.equal(V.sizeOf(big, m), V.snapshot(big, m).size, 'sizeOf present ' + m);
    });

test('runBatch count cap 0x3FFFFFFF: 2^30 throws even for an absent member; the cap itself is accepted; message names [0, 2^30 - 1]',
    { timeout: 60000 }, async () => {
        const V = await loadV();
        const e = V.createEngine({ kind: 'mixed', seed: 5, U: 2 ** 32, n: 2 ** 10 }, null);
        assert.equal(e.veb, null);
        assert.throws(() => V.runBatch(e, 'veb', 2 ** 30), (err) => /\[lite-loglogn-demo\]/.test(err.message) && err.message.includes('[0, 2^30 - 1]'));
        assert.throws(() => V.runBatch(e, 'veb', 2 ** 30 + 1), /\[0, 2\^30 - 1\]/);
        assert.throws(() => V.runBatch(e, 'veb', -1), /\[lite-loglogn-demo\]/);
        assert.throws(() => V.runBatch(e, 'veb', 1.5), /\[lite-loglogn-demo\]/);
        // the largest legal count on an ABSENT member is accepted and is a no-op (-1), never a throw
        assert.equal(V.runBatch(e, 'veb', 0x3FFFFFFF), -1);
        assert.equal(V.runBatch(e, 'sb', 0x3FFFFFFF), -1);
    });

// A9 section 3 / A6: pool-slot sizing. churn, U=2^22, n=2^12 (64 chunks). Precondition (own census of the pool): at least
// one chunk with >= 65 distinct pool keys (L >= 1) and some chunk with 2 <= cnt < 65. Seed 0xC0FFEE satisfies it at this
// corner (own census: 64 chunks, S2 = 64, L = 29, 35 chunks with 2 <= cnt < 65), so no seed search was needed.
test('A6 round-robin pool keys: e.roar.clear() then every distinct pool key added rank-major (cnt < 65 chunks last in each rank) never throws; pools >= own census',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        const e = V.createEngine({ kind: 'churn', seed: 0xC0FFEE, U: 2 ** 22, n: 2 ** 12 }, null);
        const ref = refOpStream(V, 'churn', 0xC0FFEE, 2 ** 22, 2 ** 12);
        const seen = new Set();
        const byChunk = new Map();
        for (let i = 0; i < ref.pool.length; i++) {
            const k = ref.pool[i];
            if (seen.has(k)) continue;
            seen.add(k);
            const c = k >>> 16;
            if (!byChunk.has(c)) byChunk.set(c, []);
            byChunk.get(c).push(k);
        }
        let S2 = 0;
        let L = 0;
        let mid = 0;
        let maxCnt = 0;
        for (const ks of byChunk.values()) {
            if (ks.length >= 2) S2++;
            if (ks.length >= 65) L++;
            if (ks.length >= 2 && ks.length < 65) mid++;
            if (ks.length > maxCnt) maxCnt = ks.length;
        }
        assert.ok(L >= 1 && mid >= 1, 'precondition: L ' + L + ' >= 1 and a chunk with 2 <= cnt < 65 (' + mid + '); search another seed');
        // the engine must size its pools from the whole distinct pool: small >= S2 (one slot per >= 2-key chunk), large >= max(1, L)
        assert.ok(e.roarSmall >= S2, 'roarSmall ' + e.roarSmall + ' < own census S2 ' + S2);
        assert.ok(e.roarLarge >= Math.max(1, L), 'roarLarge ' + e.roarLarge + ' < own census max(1, L) ' + Math.max(1, L));
        e.roar.clear();
        const order = [...byChunk.keys()].sort((a, b) => a - b);
        const big = order.filter((c) => byChunk.get(c).length >= 65);
        const small = order.filter((c) => byChunk.get(c).length < 65);
        let added = 0;
        for (let r = 0; r < maxCnt; r++) {
            for (const c of big) { const ks = byChunk.get(c); if (r < ks.length) { e.roar.add(ks[r]); added++; } }
            for (const c of small) { const ks = byChunk.get(c); if (r < ks.length) { e.roar.add(ks[r]); added++; } }
        }
        assert.equal(added, seen.size, 'every distinct pool key was added');
        assert.equal(e.roar.size, seen.size, 'roar holds every distinct pool key');
    });

// ================================================================================================
// A4 -- renderer teeth + determinism
// ================================================================================================

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
function foldVal(h, v) {
    if (typeof v === 'number') { F64[0] = v; return fnvWord(fnvWord(fnvWord(h, 1), U32[0]), U32[1]); }
    if (typeof v === 'string') { h = fnvWord(h, 2); for (let i = 0; i < v.length; i++) h = fnvWord(h, v.charCodeAt(i)); return h; }
    if (typeof v === 'boolean') return fnvWord(fnvWord(h, 3), v ? 1 : 0);
    return fnvWord(h, 4);
}
// recorder(true): fillText's TEXT argument is not hashed (its x / y are) -- labels are not geometry (A9 A4).
function recorder(dropText) {
    const st = { h: FNV_OFFSET, calls: 0 };
    const self = new Proxy(function () {}, {
        get(_t, k) {
            if (typeof k === 'symbol') return undefined;
            if (k === 'measureText') return () => ({ width: 8 });
            return (...args) => {
                st.calls++;
                st.h = foldVal(st.h, String(k));
                for (let i = dropText === true && k === 'fillText' ? 1 : 0; i < args.length; i++) st.h = foldVal(st.h, args[i]);
                return self;
            };
        },
        set(_t, k, v) { st.calls++; st.h = foldVal(foldVal(st.h, String(k)), v); return true; },
    });
    return { g: self, st };
}
const GEOM = { x: 0, y: 0, w: 640, h: 240, width: 640, height: 240, pad: 8, cx: 320, cy: 120 };
function drawHash(R, model) {
    const rec = recorder(true);
    R.draw(rec.g, model, GEOM);
    assert.ok(rec.st.calls > 0, 'draw recorded nothing (vacuous)');
    return rec.st.h;
}

// A9 A4 slot map (from the PLAN, not from the renderers): POSITION slots move a drawn element, AUX slots only
// re-style / re-size it. Top-level and per-level scalars (universe, size, bits, capacity, ...) are never sampled.
const A4_SLOTS = {
    sb: { pos: [(m) => m.words.map((a, L) => [a, 'words[' + L + ']'])], aux: [] },
    xft: { pos: [(m) => [[m.keys, 'keys']], (m) => m.levels.map((l, L) => [l.prefix, 'levels[' + L + '].prefix'])], aux: [] },
    yft: { pos: [(m) => [[m.keys, 'keys'], [m.reps, 'reps']]], aux: [(m) => [[m.sizes, 'sizes']]] },
    veb: {
        pos: [(m) => [[m.keys, 'keys'], [m.clusters, 'clusters.j', 'j']]],
        aux: [(m) => [[m.clusters, 'clusters.count', 'count'], [m.clusters, 'clusters.min', 'min'], [m.clusters, 'clusters.max', 'max']]],
    },
    roar: {
        pos: [(m) => [[m.chunks, 'chunks.chunk', 'chunk']]],
        aux: [(m) => [[m.chunks, 'chunks.count', 'count'], [m.chunks, 'chunks.runs', 'runs']]],
    },
};
/** first, last and 32 strided interior indices of an array of length len (deduplicated). */
function a4Indices(len) {
    const out = new Set();
    if (len > 0) { out.add(0); out.add(len - 1); }
    for (let j = 0; j < 32 && len > 2; j++) out.add(1 + Math.floor(((j + 0.5) * (len - 2)) / 32));
    return [...out].sort((x, y) => x - y);
}
/** Mutates one slot (+1) of a clone, draws, reports whether the hash moved. */
function a4Changed(draw, model, h0, getArrays, ai, idx) {
    const m2 = structuredClone(model);
    const [arr, , field] = getArrays(m2)[ai];
    if (field === undefined) arr[idx] = arr[idx] + 1; else arr[idx][field] = arr[idx][field] + 1;
    let h2;
    try { h2 = draw(m2); } catch (_e) { h2 = -1; }
    return h2 !== h0;
}
/** Runs every sampled slot of one class; returns {changed, total, missed: [names]}. */
function a4Sample(draw, model, getters) {
    const h0 = draw(model);
    let changed = 0;
    let total = 0;
    const missed = [];
    for (const getArrays of getters) {
        const arrays = getArrays(model);
        for (let ai = 0; ai < arrays.length; ai++) {
            for (const idx of a4Indices(arrays[ai][0].length)) {
                total++;
                if (a4Changed(draw, model, h0, getArrays, ai, idx)) changed++;
                else missed.push(arrays[ai][1] + '[' + idx + ']');
            }
        }
    }
    return { changed, total, missed };
}

test('A4 renderer teeth: equal models draw equal; every sampled POSITION slot and every sampled AUX slot (100% each, +1) change the draw hash; blind-draw controls',
    { timeout: 180000 }, async () => {
        const V = await loadV();
        // U=2^20, n=2^10, 4096 mixed steps (A9 A4).
        const e = V.createEngine({ kind: 'mixed', seed: 0xC0FFEE, U: 2 ** 20, n: 2 ** 10 }, null);
        for (let i = 0; i < 4096; i++) V.step(e);
        const idx = idxMap(V);
        const report = [];
        for (const s of SHORT) {
            const R = await rendererFor(s);
            const model = R.model(V.snapshot(e, idx[s]));
            const draw = (m) => drawHash(R, m);
            const h0 = draw(model);
            assert.equal(draw(structuredClone(model)), h0, s + ': equal models must draw equal');
            // the recorder really drops the label text and nothing else (control for the hash definition)
            const r1 = recorder(true); r1.g.fillText('aaa', 1, 2);
            const r2 = recorder(true); r2.g.fillText('bbb', 1, 2);
            const r3 = recorder(true); r3.g.fillText('aaa', 1, 3);
            assert.equal(r1.st.h, r2.st.h, 'fillText text is not hashed');
            assert.notEqual(r1.st.h, r3.st.h, 'fillText position is hashed');
            const pos = a4Sample(draw, model, A4_SLOTS[s].pos);
            assert.ok(pos.total >= 4, s + ': POSITION sample too small to mean anything: ' + pos.total);
            assert.deepStrictEqual(pos.missed, [], s + ': POSITION slots that did not change the draw hash (floor 100%) ' +
                pos.changed + '/' + pos.total);
            const aux = a4Sample(draw, model, A4_SLOTS[s].aux);
            if (A4_SLOTS[s].aux.length > 0) {
                assert.ok(aux.total >= 4, s + ': AUX sample too small: ' + aux.total);
                // A10 R2-P1: 100% like POSITION -- a renderer that skips the first / last element of an AUX-only row is caught.
                assert.deepStrictEqual(aux.missed, [], s + ': AUX slots that did not change the draw hash (floor 100%) ' +
                    aux.changed + '/' + aux.total);
            }
            report.push(s + ' pos ' + pos.changed + '/' + pos.total + ' aux ' + aux.changed + '/' + aux.total);
        }
        // CONTROLS (must-fail): a draw that is blind to one array drops below the floor.
        const Rsb = await rendererFor('sb');
        const msb = Rsb.model(V.snapshot(e, idx.sb));
        const blindSb = (m) => drawHash(Rsb, { ...m, words: m.words.map((a, L) => (L === 0 ? new Uint32Array(a.length) : a)) });
        assert.ok(a4Sample(blindSb, msb, A4_SLOTS.sb.pos).missed.length > 0, 'control: an sb draw blind to the key words must be flagged');
        const Rx = await rendererFor('xft');
        const mx = Rx.model(V.snapshot(e, idx.xft));
        const blindX = (m) => drawHash(Rx, { ...m, levels: m.levels.map((l) => ({ ...l, prefix: l.prefix.subarray(1) })) });
        assert.ok(a4Sample(blindX, mx, A4_SLOTS.xft.pos).missed.length > 0, 'control: an xft draw that drops one element per row must be flagged');
        assert.ok(report.length === 5);
        // CONTROL SKIP-yft-lastbucket (R2-P1): the yft bucket-size row skips its last bucket (loop `i < R - 1`); the same
        // measurement on that string-injected renderers.mjs (one match asserted by injectOnce) must miss AUX slots.
        const skipSrc = injectOnce(readFileSync(join(DEMO_DIR, 'renderers.mjs'), 'utf8'),
            'for (let i = 0; i < R; i++) binAdd(reps[i], U, bins, sizes[i], 0);',
            'for (let i = 0; i < R - 1; i++) binAdd(reps[i], U, bins, sizes[i], 0);');
        const Rskip = (await import('data:text/javascript;base64,' + Buffer.from(skipSrc + '\n// skip-yft-lastbucket\n').toString('base64'))).RENDERERS.yft;
        const mY = Rskip.model(V.snapshot(e, idx.yft));
        const skipAux = a4Sample((m) => drawHash(Rskip, m), mY, A4_SLOTS.yft.aux);
        assert.ok(skipAux.total >= 4 && skipAux.missed.length > 0 && skipAux.changed < skipAux.total,
            'control: the 100% AUX floor must FAIL for yft with its last bucket skipped; ' + skipAux.changed + '/' + skipAux.total);
        assert.ok(skipAux.missed.some((q) => q.startsWith('sizes[')), 'control: the missed slot is a yft sizes slot: ' + skipAux.missed);
    });

test('A4 OPSTREAM: own reference hash/arrays equal the demo for 3 kinds at seed 0xC0FFEE; seed+1 differs; reset+replay unchanged; mulberry32 equal',
    { timeout: 120000 }, async () => {
        const V = await loadV();
        const U = 2 ** 24;
        const n = 2 ** 12;
        for (const kind of ['mixed', 'query', 'churn']) {
            const ref = refOpStream(V, kind, 0xC0FFEE, U, n);
            const dm = V.buildOpStream(kind, 0xC0FFEE, U, n);
            assert.ok(eqArr(dm.pool, ref.pool), kind + ' pool');
            assert.ok(eqArr(dm.op, ref.op), kind + ' op');
            assert.ok(eqArr(dm.key, ref.key), kind + ' key');
            assert.ok(sameHash(dm.hash, ref.hash), kind + ' hash: demo ' + dm.hash + ' vs ref ' + hex32(ref.hash));
            const other = V.buildOpStream(kind, 0xC0FFEE + 1, U, n);
            assert.ok(!sameHash(other.hash, ref.hash), kind + ': seed+1 must differ');
            // CONTROL: the hash is key-sensitive -- one perturbed key changes my reference hash.
            const k2 = Uint32Array.from(ref.key);
            k2[100] = k2[100] ^ 1;
            assert.notEqual(refHashOf(ref.op, k2), ref.hash, kind + ' control: hash blind to a key change');
        }
        // reset + replay
        const mk = () => V.createEngine({ kind: 'mixed', seed: 0xC0FFEE, U: 2 ** 20, n: 2 ** 10 }, null);
        const snapKeys = (e) => Array.from(memberObj(V, e, 'xft').dump().keys).join(',');
        const e = mk();
        for (let i = 0; i < 3000; i++) V.step(e);
        const first = snapKeys(e);
        V.reset(e);
        for (let i = 0; i < 3000; i++) V.step(e);
        assert.equal(snapKeys(e), first, 'reset + replay must be unchanged');
        const e2 = mk();
        for (let i = 0; i < 3000; i++) V.step(e2);
        assert.equal(snapKeys(e2), first, 'a fresh engine with the same spec must match');
        const e3 = V.createEngine({ kind: 'mixed', seed: 0xC0FFEF, U: 2 ** 20, n: 2 ** 10 }, null);
        for (let i = 0; i < 3000; i++) V.step(e3);
        assert.notEqual(snapKeys(e3), first, 'control: seed+1 must give a different state');
        // mulberry32
        for (const seed of [0xC0FFEE, 1, 0xFFFFFFFF]) {
            const a = V.mulberry32(seed);
            const b = refTierMulberry(seed);
            for (let i = 0; i < 1024; i++) assert.equal(a(), b(), 'mulberry32 seed ' + seed + ' output ' + i);
        }
    });

// ================================================================================================
// A5 -- static scan + band drift
// ================================================================================================

const BEGIN = '// FRAME-LOOP-BEGIN';
const END = '// FRAME-LOOP-END';
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}
function blankStrings(s) {
    return s.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
const WRITES = [/\.textContent\s*=/, /\.innerHTML\s*=/, /\.className\s*=/, /\.style\.[A-Za-z-]+\s*=/, /\.style\s*\[/,
    /\.setAttribute\s*\(/, /\.classList\.(add|remove|toggle)\s*\(/, /\.value\s*=/, /\.hidden\s*=/, /\.append(Child)?\s*\(/];
const LAYOUT_READS = [/getBoundingClientRect/, /\.offset(Width|Height|Top|Left)\b/, /\.client(Width|Height|Top|Left)\b/,
    /\.scroll(Width|Height|Top|Left)\b/, /getComputedStyle/, /\.getClientRects/, /\.innerText\b/];
/** Returns a list of violation names for one frame-loop body (empty = clean). */
function scanFrameLoop(body) {
    const v = [];
    const raw = stripComments(body);
    const s = blankStrings(raw);
    if (/=>/.test(s)) v.push('arrow');
    if (/\bfunction\b/.test(s)) v.push('function');
    if (/\.(map|forEach|filter)\s*\(/.test(s)) v.push('map/forEach/filter');
    if (/`/.test(raw)) v.push('backtick');
    if (/toFixed/.test(s)) v.push('toFixed');
    if (/\bnew\s/.test(s)) v.push('new');
    if (/getElementById|querySelector/.test(s)) v.push('dom-lookup');
    if (/(^|[=(,:?\[;{}]|\breturn)\s*\{/.test(s.replace(/\)\s*\{/g, ') BLOCK ').replace(/\b(else|do|try|finally)\s*\{/g, '$1 BLOCK '))) v.push('object-literal');
    if (/(^|[=(,:?\[;{}]|\breturn)\s*\[/.test(s)) v.push('array-literal');
    let firstWrite = -1;
    for (const re of WRITES) { const m = re.exec(s); if (m && (firstWrite < 0 || m.index < firstWrite)) firstWrite = m.index; }
    if (firstWrite >= 0) {
        for (const re of LAYOUT_READS) { const m = re.exec(s); if (m && m.index > firstWrite) { v.push('layout-read-after-write'); break; } }
    }
    return v;
}
function frameLoopOf(html) {
    const bi = html.split(BEGIN).length - 1;
    const ei = html.split(END).length - 1;
    assert.equal(bi, 1, 'FRAME-LOOP-BEGIN must appear exactly once, got ' + bi);
    assert.equal(ei, 1, 'FRAME-LOOP-END must appear exactly once, got ' + ei);
    const a = html.indexOf(BEGIN) + BEGIN.length;
    const b = html.indexOf(END);
    assert.ok(b > a, 'END must follow BEGIN');
    return html.slice(a, b);
}
/** CSS rule: every :hover selector sits inside an @media (hover: hover) block. */
function hoverViolations(css) {
    const out = [];
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const stack = [];
    let prelude = '';
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '{') {
            const pre = prelude.trim();
            stack.push(pre);
            if (pre.indexOf(':hover') >= 0 && !pre.startsWith('@') &&
                !stack.slice(0, -1).some((p) => /^@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(p))) out.push(pre);
            prelude = '';
        } else if (c === '}') { stack.pop(); prelude = ''; }
        else if (c === ';') prelude = '';
        else prelude += c;
    }
    return out;
}
function styleAttrViolations(html) {
    const out = [];
    const re = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const val = m[2] !== undefined ? m[2] : m[3];
        for (const decl of val.split(';').map((d) => d.trim()).filter(Boolean)) {
            if (!/^--[\w-]+\s*:/.test(decl)) out.push(decl);
        }
    }
    return out;
}

test('A5 static scan: frame-loop markers once each, loop body clean of allocation/DOM-lookup/layout-thrash, CSS hover + style rules; must-fail fixtures',
    () => {
        const html = readFileSync(join(DEMO_DIR, 'visuals.html'), 'utf8');
        const body = frameLoopOf(html);
        assert.ok(body.trim().length > 0, 'frame loop is empty');
        assert.deepStrictEqual(scanFrameLoop(body), [], 'frame loop violations');
        // MUST-FAIL fixtures: the scanner must flag each.
        const allocating = '\nfor (let i = 0; i < n; i++) {\n  const a = [i, i + 1];\n  rows.map((r) => r.x);\n  el.textContent = `v ${i}`;\n}\n';
        const thrash = '\nel.textContent = "a";\nconst w = el.offsetWidth;\n';
        const fa = scanFrameLoop(allocating);
        assert.ok(fa.length >= 3 && fa.includes('arrow') && fa.includes('backtick'), 'allocating fixture must be flagged: ' + fa);
        assert.ok(scanFrameLoop(thrash).includes('layout-read-after-write'), 'read-after-write fixture must be flagged');
        assert.ok(scanFrameLoop('\nconst w = el.offsetWidth;\nel.textContent = "a";\n').every((x) => x !== 'layout-read-after-write'),
            'read-before-write is legal');
        assert.deepStrictEqual(scanFrameLoop('\nfor (let i = 0; i < n; i++) {\n  if (a[i] > b) { x = a[i]; } else { y = 1; }\n}\n'), [],
            'clean fixture must not be flagged (index access and blocks are not literals)');
        assert.ok(scanFrameLoop('\nconst o = { a: 1 };\n').includes('object-literal'));
        assert.ok(scanFrameLoop('\nconst o = [1, 2];\n').includes('array-literal'));
        // marker teeth
        assert.throws(() => frameLoopOf('x'), /exactly once/);
        assert.throws(() => frameLoopOf(BEGIN + '\n' + BEGIN + '\n' + END), /exactly once/);
        // CSS
        const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
        assert.deepStrictEqual(hoverViolations(styles), [], ':hover outside @media (hover: hover)');
        assert.deepStrictEqual(styleAttrViolations(html), [], 'style="" with a non-custom-property declaration');
        assert.deepStrictEqual(hoverViolations('@media (hover: hover) { a:hover { color: red } }'), []);
        assert.deepStrictEqual(hoverViolations('a:hover { color: red }'), ['a:hover']);
        assert.deepStrictEqual(styleAttrViolations('<p style="--k: 1; color: red">'), ['color: red']);
        assert.deepStrictEqual(styleAttrViolations('<p style="--k: 1">'), []);
    });

// --- A5 callee rule (A9 A4/A5): the marker block calls ONLY these, coldTick once behind the mask guard ------
const FRAME_CALLEES = ['performance.now', 'requestAnimationFrame', 'runBatch'];
const COLD_GUARD = 'if ((frameNo & COLD_MASK) === 0) coldTick();';
/** Violation names for the callee rule on one marker block (empty = clean). */
function calleeViolations(body) {
    const v = [];
    const s = blankStrings(stripComments(body));
    const seen = new Set();
    for (const m of s.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
        const name = m[1].replace(/\s+/g, '');
        if (name === 'if' || name === 'for' || name === 'while') continue;
        seen.add(name);
    }
    for (const name of seen) if (name !== 'coldTick' && !FRAME_CALLEES.includes(name)) v.push('callee ' + name);
    for (const need of FRAME_CALLEES) if (!seen.has(need)) v.push('missing callee ' + need);
    const cold = s.split(/\bcoldTick\s*\(/).length - 1;
    if (cold !== 1) v.push('coldTick called ' + cold + ' times');
    const guard = s.split(COLD_GUARD).length - 1;
    if (guard !== 1) v.push('cold guard text found ' + guard + ' times');
    return v;
}

test('A5 callee rule: the frame-loop block calls only performance.now, runBatch, requestAnimationFrame and one masked coldTick(); must-fail fixtures',
    () => {
        const html = readFileSync(join(DEMO_DIR, 'visuals.html'), 'utf8');
        const body = frameLoopOf(html);
        assert.deepStrictEqual(calleeViolations(body), [], 'frame-loop callees');
        const clean = '\nconst t = performance.now();\nrunBatch(e, m, 1);\nif ((frameNo & COLD_MASK) === 0) coldTick();\nrafId = requestAnimationFrame(frame);\n';
        assert.deepStrictEqual(calleeViolations(clean), [], 'clean fixture');
        assert.ok(calleeViolations(clean + 'fmtNs(x);\n').includes('callee fmtNs'), 'an extra helper call must be flagged');
        assert.ok(calleeViolations(clean + 'Math.max(1, 2);\n').includes('callee Math.max'), 'a Math.* call must be flagged');
        assert.ok(calleeViolations(clean + 'updateSpeed(0);\n').includes('callee updateSpeed'), 'a cold helper called directly must be flagged');
        assert.ok(calleeViolations(clean.replace(COLD_GUARD, 'coldTick();')).includes('cold guard text found 0 times'), 'unguarded coldTick must be flagged');
        assert.ok(calleeViolations(clean + 'coldTick();\n').includes('coldTick called 2 times'), 'a second coldTick must be flagged');
        assert.ok(calleeViolations(clean.replace('runBatch(e, m, 1);', '')).includes('missing callee runBatch'), 'a missing callee is flagged (vacuity)');
    });

// --- A5 DOM-stub row: run the page's real inline module against a strict stub document ----------------
// The stub provides EXACTLY the PAGE-HOST list of A9 s1 and throws on any other host access, so a new unlisted
// API fails the row. Layout read = getBoundingClientRect. Dirty flag = any DOM write (textContent / value / min /
// max / step / disabled / width / height / style.setProperty / classList.toggle / appendChild / remove); it is
// reset after each rAF batch (layout runs after the rAF callbacks); an event-handler write before a batch stays
// dirty into it. style.getPropertyValue is an inline-style read, not a layout read.
const FIRE = Symbol('fire');
const TPL_EVENTS = new Set(['pointermove', 'pointerleave', 'change', 'input', 'click']);
const EL_WRITE_PROPS = new Set(['textContent', 'value', 'min', 'max', 'step', 'disabled', 'width', 'height']);
const CTX_METHODS = new Set(['clearRect', 'fillRect', 'fillText', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke']);
const CTX_PROPS = new Set(['fillStyle', 'font', 'globalAlpha', 'lineWidth', 'strokeStyle']);

function makeHost(pageHtml) {
    const st = { dirty: false, writes: 0, layoutReads: 0, readsAfterWrite: 0, raf: [], rafId: 0, canvases: [], byId: new Map(), ctxCalls: 0 };
    const hostFail = (what) => { throw new Error(P + 'unlisted host access: ' + what); };
    const wr = () => { st.dirty = true; st.writes++; };
    const tplHtml = /<template id="panelTpl">([\s\S]*?)<\/template>/.exec(pageHtml)[1];
    const tplClasses = new Set();
    for (const m of tplHtml.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) tplClasses.add('.' + c);
    const bodyIds = pageHtml.slice(0, pageHtml.indexOf('<script')).replace(/<template[\s\S]*?<\/template>/, '');
    const ids = new Set([...bodyIds.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    ids.add('panelTpl');

    function mkCtx() {
        const store = Object.create(null);
        return new Proxy({}, {
            get(_t, k) {
                if (typeof k === 'symbol') return undefined;
                if (CTX_METHODS.has(k)) return () => { st.ctxCalls++; };
                if (CTX_PROPS.has(k)) return store[k];
                return hostFail('ctx.' + k);
            },
            set(_t, k, v) { if (!CTX_PROPS.has(k)) hostFail('set ctx.' + k); store[k] = v; return true; },
        });
    }
    function mkEl(tag) {
        const raw = { tag, store: Object.create(null), listeners: Object.create(null), sel: new Map(), styleStore: Object.create(null) };
        const style = new Proxy({}, {
            get(_t, k) {
                if (typeof k === 'symbol') return undefined;
                if (k === 'setProperty') return (n, v) => { wr(); raw.styleStore[n] = String(v); };
                if (k === 'getPropertyValue') return (n) => (n in raw.styleStore ? raw.styleStore[n] : '');
                return hostFail(tag + '.style.' + k);
            },
            set(_t, k) { return hostFail('set style.' + k); },
        });
        const classList = new Proxy({}, {
            get(_t, k) {
                if (typeof k === 'symbol') return undefined;
                if (k === 'toggle') return () => { wr(); return true; };
                return hostFail(tag + '.classList.' + k);
            },
        });
        const proxy = new Proxy(raw, {
            get(t, k) {
                if (k === FIRE) return (type, ev) => { const a = t.listeners[type] || []; for (let i = 0; i < a.length; i++) a[i](ev); };
                if (typeof k === 'symbol') return undefined;
                if (k === 'style') return style;
                if (k === 'classList') return classList;
                if (k === 'querySelector') return (sel) => {
                    if (sel !== 'canvas' && !tplClasses.has(sel)) hostFail('querySelector(' + sel + ')');
                    if (!t.sel.has(sel)) {
                        const c = mkEl(sel === 'canvas' ? 'canvas' : 'div');
                        if (sel === 'canvas') st.canvases.push(c);
                        t.sel.set(sel, c);
                    }
                    return t.sel.get(sel);
                };
                if (k === 'remove') return () => { wr(); };
                if (k === 'appendChild') return (c) => { wr(); return c; };
                if (k === 'addEventListener') return (type, fn) => {
                    if (!TPL_EVENTS.has(type)) hostFail('addEventListener(' + type + ')');
                    (t.listeners[type] || (t.listeners[type] = [])).push(fn);
                };
                if (k === 'getContext') return (kind) => { if (tag !== 'canvas' || kind !== '2d') hostFail('getContext(' + kind + ') on ' + tag); return mkCtx(); };
                if (k === 'getBoundingClientRect') return () => {
                    st.layoutReads++;
                    if (st.dirty) st.readsAfterWrite++;
                    return { left: 10, top: 20, width: 450, height: 140, right: 460, bottom: 160, x: 10, y: 20 };
                };
                if (k === 'content' && tag === 'template') {
                    return { cloneNode() { return mkEl('fragment'); } };
                }
                if (EL_WRITE_PROPS.has(k)) return k in t.store ? t.store[k] : (k === 'disabled' ? false : '');
                return hostFail(tag + '.' + k);
            },
            set(t, k, v) {
                if (!EL_WRITE_PROPS.has(k)) hostFail('set ' + tag + '.' + k);
                wr();
                t.store[k] = v;
                return true;
            },
        });
        raw.proxy = proxy;
        return proxy;
    }
    const doc = new Proxy({}, {
        get(_t, k) {
            if (typeof k === 'symbol') return undefined;
            if (k === 'getElementById') return (id) => {
                if (!ids.has(id)) hostFail('getElementById(' + id + ')');
                if (!st.byId.has(id)) st.byId.set(id, mkEl(id === 'panelTpl' ? 'template' : 'el-' + id));
                return st.byId.get(id);
            };
            if (k === 'createElement') return (tag) => mkEl(String(tag));
            return hostFail('document.' + k);
        },
        set(_t, k) { return hostFail('set document.' + k); },
    });
    return { st, doc };
}

function injectOnce(src, find, repl) {
    const i = src.indexOf(find);
    assert.ok(i >= 0, P + 'injection target missing (abort): ' + find.slice(0, 60));
    assert.equal(src.indexOf(find, i + 1), -1, P + 'injection target matches more than once (abort): ' + find.slice(0, 60));
    return src.slice(0, i) + repl + src.slice(i + find.length);
}
const PAGE_IMPORTS = [
    ["'./Visualize.mjs'", pathToFileURL(join(DEMO_DIR, 'Visualize.mjs')).href],
    ["'./renderers.mjs'", pathToFileURL(join(DEMO_DIR, 'renderers.mjs')).href],
    ["'./witness-data.mjs'", pathToFileURL(join(DEMO_DIR, 'witness-data.mjs')).href],
    ["'/node_modules/@zakkster/lite-logn/LogN.js'", pathToFileURL(join(REPO, 'node_modules', '@zakkster', 'lite-logn', 'LogN.js')).href],
];
let pageRunNo = 0;

/** Clicks a sweep button and pumps the stub's rAF queue until the page re-enables it; returns the text it wrote. */
async function driveSweep(st, id, clock) {
    const btn = st.byId.get(id);
    assert.ok(btn !== undefined, P + 'the page has no #' + id);
    btn[FIRE]('click', {});
    assert.equal(btn.disabled, true, '#' + id + ' click must start a sweep (button disabled while it runs)');
    for (let it = 0; it < 4000 && btn.disabled === true; it++) {
        const q = st.raf;
        st.raf = [];
        for (let i = 0; i < q.length; i++) q[i](clock());
        await new Promise((r) => setImmediate(r));
    }
    assert.equal(btn.disabled, false, '#' + id + ' sweep never finished');
    const t = (n) => String(st.byId.get(n).textContent);
    return { status: t('status'), fit: t('fit'), cross: t('cross'), res: t('res') };
}

/** Runs the page's inline module in the stub; returns the metrics. Throws on any unlisted host access. */
async function runPage(pageHtml, mutate, opts) {
    assert.equal(pageHtml.split('<script').length - 1, 1, 'visuals.html must hold exactly one <script>');
    let src = /<script type="module">([\s\S]*?)<\/script>/.exec(pageHtml)[1];
    for (const [spec, url] of PAGE_IMPORTS) src = injectOnce(src, spec, JSON.stringify(url));
    assert.equal((src.match(/\bfrom\s+(?:'|"(?!file:))/g) || []).length, 0, 'the page has an import this row does not map');
    if (mutate) src = mutate(src);
    src += '\n// run ' + (++pageRunNo) + '\n';
    const { st, doc } = makeHost(pageHtml);
    const savedPerf = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    const origClock = performance.now.bind(performance);
    const hostFailPerf = (k) => { if (typeof k === 'symbol') return undefined; throw new Error(P + 'unlisted host access: performance.' + String(k)); };
    globalThis.document = doc;
    globalThis.requestAnimationFrame = (fn) => { st.raf.push(fn); return ++st.rafId; };
    Object.defineProperty(globalThis, 'performance', {
        configurable: true, writable: true,
        value: new Proxy({ now: opts && opts.coarseClock === true ? () => Math.floor(origClock() * 10) / 10 : origClock }, { get(t, k) { return Object.prototype.hasOwnProperty.call(t, k) ? t[k] : hostFailPerf(k); } }),
    });
    try {
        await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
        const play = st.byId.get('play');
        assert.ok(play !== undefined && st.canvases.length >= 5, 'the page did not build its controls / panels');
        if (opts && opts.sweepId) return await driveSweep(st, opts.sweepId, origClock);
        // measure only the interaction, not the init
        st.dirty = false; st.writes = 0; st.layoutReads = 0; st.readsAfterWrite = 0;
        play[FIRE]('click', {});
        assert.equal(st.raf.length, 1, 'click #play must queue exactly one frame');
        let framesWithWrites = 0;
        let frames = 0;
        const writeFrameNos = [];
        for (let f = 0; f < 256; f++) {
            const q = st.raf;
            st.raf = [];
            if (q.length === 0) break;
            // One pointermove, delivered in the gap before batch 7 -- the batch that runs the first cold tick
            // (page: frameNo starts at 0, +1 per frame callback; coldTick when (frameNo & 7) === 0, i.e. batch f
            // runs the page's frameNo = f + 1). Its write (if any) stays dirty into that batch; dirty is reset
            // only AFTER each batch.
            if (f === 7) st.canvases[2][FIRE]('pointermove', { clientX: 200 });
            const w0 = st.writes;
            for (let i = 0; i < q.length; i++) q[i](origClock());
            frames++;
            if (st.writes !== w0) { framesWithWrites++; writeFrameNos.push(f + 1); }
            st.dirty = false;
        }
        return { readsAfterWrite: st.readsAfterWrite, layoutReads: st.layoutReads, frames, framesWithWrites, writeFrameNos };
    } finally {
        Object.defineProperty(globalThis, 'performance', savedPerf);
        delete globalThis.document;
        delete globalThis.requestAnimationFrame;
    }
}
function pageViolations(m) {
    const v = [];
    if (m.readsAfterWrite !== 0) v.push('readsAfterWrite ' + m.readsAfterWrite);
    if (!(m.layoutReads >= 1)) v.push('layoutReads ' + m.layoutReads + ' (vacuous: the probe read never ran)');
    if (m.frames !== 256) v.push('frames ' + m.frames);
    // A10 (d): the page writes only from a cold tick (frameNo % 8 === 0), and at least once (not vacuous).
    if (!(m.framesWithWrites >= 1)) v.push('no frame wrote the DOM (vacuous: the cold tick never ran)');
    for (const no of m.writeFrameNos) if (no % 8 !== 0) v.push('DOM write in frameNo ' + no + ' (not a cold tick)');
    return v;
}

test('A5 DOM-stub: real page module, 256 frames after play + one pointermove: 0 layout reads after a write, >= 1 layout read, every DOM-writing frame is a cold tick (frameNo % 8 === 0), >= 1; M9 / M12 / M15 injections fail',
    { timeout: 240000 }, async () => {
        const html = readFileSync(join(DEMO_DIR, 'visuals.html'), 'utf8');
        const base = await runPage(html);
        assert.deepStrictEqual(pageViolations(base), [], 'page metrics ' + JSON.stringify(base));
        // CONTROL M9: a layout read after a style.setProperty inside updateSpeed (the cold path of the frame).
        const m9 = await runPage(html, (s) => injectOnce(s, "$SBAR[i].style.setProperty('--fill', fillPct(f));",
            "$SBAR[i].style.setProperty('--fill', fillPct(f)); $SBAR[i].getBoundingClientRect();"));
        assert.ok(m9.readsAfterWrite >= 1 && pageViolations(m9).length > 0, 'M9 must be caught: ' + JSON.stringify(m9));
        // CONTROL M12: a per-frame textContent write through a helper called from the frame loop.
        const m12 = await runPage(html, (s) => injectOnce(injectOnce(s, 'function frame(now) {',
            "function frameStatus() { $status.textContent = 'f'; }\nfunction frame(now) {"),
            'ringHead = (ringHead + 1) & RING_MASK;', 'ringHead = (ringHead + 1) & RING_MASK; frameStatus();'));
        assert.ok(m12.framesWithWrites === 256 && pageViolations(m12).length > 0, 'M12 must be caught: ' + JSON.stringify(m12));
        // CONTROL M15 (R2-P2): a status write inside the pointermove handler leaves the dirty flag set into the cold-tick
        // batch that probe-reads the layout, so the row must see a read after a write.
        const m15 = await runPage(html, (s) => injectOnce(s, 'probeLane = i; probePending = 1; });',
            "probeLane = i; probePending = 1; $status.textContent = 'p'; });"));
        assert.ok(m15.readsAfterWrite >= 1, 'M15 (write in the pointermove handler) must be caught: ' + JSON.stringify(m15));
        // CONTROL: an API outside the PAGE-HOST list fails the row (strict stub).
        await assert.rejects(runPage(html, (s) => injectOnce(s, "$SBAR[i].style.setProperty('--fill', fillPct(f));",
            "$SBAR[i].style.setProperty('--fill', fillPct(f)); void $SBAR[i].offsetWidth;")), /unlisted host access: .*offsetWidth/);
    });

// A10 (c) sweep guard (B2-1): performance.now on a 0.1 ms grid -> the page measures RES_NS ~ 100,000 ns, every lane
// median is far below 2x that, so the page must report "below timer resolution" and write no numeric ns result.
test('A5 DOM-stub sweep guard: on a 0.1 ms clock sweep-U and sweep-n report "below timer resolution" in #status and write no numeric lane value',
    { timeout: 240000 }, async () => {
        const html = readFileSync(join(DEMO_DIR, 'visuals.html'), 'utf8');
        for (const id of ['sweepU', 'sweepN']) {
            const r = await runPage(html, null, { coarseClock: true, sweepId: id });
            assert.match(r.status, /^sweep-[Un]: below timer resolution at /, id + ': status ' + JSON.stringify(r));
            // 0.1 ms = 100 us: the resolution the page quotes in its status (RES_TXT), within float noise of the 0.1 grid
            assert.match(r.status, /\((?:99\.9\d|100\.0\d) us\)$/, id + ': quoted resolution ' + JSON.stringify(r));
            assert.equal(id === 'sweepU' ? r.fit : r.cross, 'n/a', id + ': the sweep result text must be n/a for an unmeasured lane');
            assert.ok(!/\d\s*(ns|us|ms)\b/.test(r.fit + r.cross), id + ': a numeric ns value was written: ' + JSON.stringify(r));
        }
    });

// --- witness-data drift (regex-parsed sources; never imported, they may run a main) --------------

function parseConst(src, name) {
    const arr = new RegExp('(?:export\\s+)?const\\s+' + name + '\\s*=\\s*(?:Object\\.freeze\\()?\\[([^\\]]*)\\]').exec(src);
    if (arr) return arr[1].split(',').map((t) => t.trim()).filter(Boolean).map(Number);
    const num = new RegExp('(?:export\\s+)?const\\s+' + name + '\\s*=\\s*([0-9.e]+)\\s*;').exec(src);
    if (num) return Number(num[1]);
    throw new Error(P + 'regex found no const ' + name + ' (the witness source moved or was renamed)');
}
function expectedLanes(wsrc, rsrc) {
    const K = parseConst(wsrc, 'WITNESS_K');
    const NEED = parseConst(wsrc, 'WITNESS_NEED');
    const W = parseConst(wsrc, 'WITNESS_W');
    const NS = parseConst(wsrc, 'WITNESS_NS');
    return {
        sb: { K, need: NEED, widths: W, ns: NS, wN: parseConst(wsrc, 'W_N'), nU: parseConst(wsrc, 'N_U') },
        w32: { K, need: NEED, widths: [...W, 32], ns: NS, wN: parseConst(wsrc, 'W_N'), nU: parseConst(wsrc, 'N_U') },
        tier: { K, need: NEED, ns: [parseConst(wsrc, 'TIER_N_DENSE'), parseConst(wsrc, 'TIER_N_SPARSE')] },
        xft: { K, need: NEED, widths: W, ns: parseConst(wsrc, 'XFT_NS'), wN: parseConst(wsrc, 'XFT_W_N'), nU: parseConst(wsrc, 'XFT_N_U') },
        yft: { K, need: NEED, widths: W, ns: parseConst(wsrc, 'YFT_NS'), wN: parseConst(wsrc, 'YFT_W_N'), nU: parseConst(wsrc, 'YFT_N_U') },
        veb: { K, need: NEED, widths: parseConst(wsrc, 'VEB_WS'), ns: [parseConst(wsrc, 'VEB_N_S'), parseConst(wsrc, 'VEB_N_L')] },
        roar: {
            K: parseConst(rsrc, 'K_FULL'), need: null, widths: parseConst(rsrc, 'W_D'), ns: parseConst(rsrc, 'N_ALL'),
            ctrl: [parseConst(rsrc, 'CTRL_LO'), parseConst(rsrc, 'CTRL_HI')], x2: [parseConst(rsrc, 'X2_LO'), parseConst(rsrc, 'X2_HI')]
        },
    };
}
function lanesOfTable(WD) {
    assert.ok(Array.isArray(WD.LANES), P + 'witness-data.mjs must export LANES (array)');
    assert.deepStrictEqual([...WD.LANE_IDS], ['sb', 'w32', 'tier', 'xft', 'yft', 'veb', 'roar']);
    const out = {};
    for (const x of WD.LANES) out[x.id] = x;
    return out;
}
const eqNums = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => Number(x) === b[i]);
function assertBandsMatch(lanes, exp) {
    for (const name of Object.keys(exp)) {
        const L = lanes[name];
        if (!L) throw new Error(P + 'lane ' + name + ' missing from witness-data');
        const E = exp[name];
        if (L.K !== E.K) throw new Error(P + name + ' K drifted: ' + L.K + ' vs ' + E.K);
        if (E.need !== undefined && L.need !== E.need) throw new Error(P + name + ' need drifted: ' + L.need + ' vs ' + E.need);
        if (L.need !== null && (!(L.need * 2 > L.K) || !(L.need <= L.K))) throw new Error(P + name + ' need/K not a majority rule');
        if (L.axis !== 'log2(w)') throw new Error(P + name + ' axis must be log2(w), got ' + L.axis);
        if (typeof L.tier !== 'string' || L.tier.length === 0) throw new Error(P + name + ' has no tier label');
        if (E.widths && !eqNums(L.widths, E.widths)) throw new Error(P + name + ' widths drifted');
        if (E.ns && !eqNums(L.ns, E.ns)) throw new Error(P + name + ' ns drifted');
        if (E.wN !== undefined && L.wN !== E.wN) throw new Error(P + name + ' wN drifted: ' + L.wN + ' vs ' + E.wN);
        if (E.nU !== undefined && L.nU !== E.nU) throw new Error(P + name + ' nU drifted: ' + L.nU + ' vs ' + E.nU);
        if (E.ctrl && !eqNums(L.ctrl, E.ctrl)) throw new Error(P + name + ' ctrl drifted');
        if (E.x2 && !eqNums(L.x2, E.x2)) throw new Error(P + name + ' x2 drifted');
    }
}

test('A5 band drift: witness-data equals the test/witness.mjs + witness-roar.mjs constants (regex-parsed); teeth: K 15->14 and a missed regex throw',
    async () => {
        const WD = await loadW();
        const wsrc = readFileSync(join(REPO, 'test', 'witness.mjs'), 'utf8');
        const rsrc = readFileSync(join(REPO, 'test', 'witness-roar.mjs'), 'utf8');
        const lanes = lanesOfTable(WD);
        const exp = expectedLanes(wsrc, rsrc);
        assert.equal(exp.sb.K, 15, 'sanity: gated K is 15');
        assertBandsMatch(lanes, exp);
        // TEETH 1: a demo copy with K 15 -> 14 must throw.
        const mutated = {};
        for (const k of Object.keys(lanes)) mutated[k] = { ...lanes[k] };
        mutated.sb.K = 14;
        assert.throws(() => assertBandsMatch(mutated, exp), /K drifted/);
        // TEETH 2: a witness source whose K moved to 14 makes the real table throw.
        const exp14 = expectedLanes(wsrc.replace('export const WITNESS_K = 15;', 'export const WITNESS_K = 14;'), rsrc);
        assert.equal(exp14.sb.K, 14);
        assert.throws(() => assertBandsMatch(lanes, exp14), /K drifted/);
        // TEETH 3: a missed regex match throws instead of yielding undefined.
        assert.throws(() => parseConst(wsrc, 'NO_SUCH_CONSTANT'), /regex found no const/);
        assert.throws(() => expectedLanes(wsrc.replaceAll('XFT_NS', 'XFT_NSX'), rsrc), /XFT_NS/);
        // a drifted width list
        const mw = {};
        for (const k of Object.keys(lanes)) mw[k] = { ...lanes[k] };
        mw.veb.widths = mw.veb.widths.slice(1);
        assert.throws(() => assertBandsMatch(mw, exp), /widths drifted/);
        // B1-4 teeth: a drifted wN / nU / ctrl / x2 in the demo table, or in a harness source, must throw.
        const cp = () => { const o = {}; for (const k of Object.keys(lanes)) o[k] = { ...lanes[k] }; return o; };
        const d1 = cp(); d1.sb.wN = 27;
        assert.throws(() => assertBandsMatch(d1, exp), /wN drifted/);
        const d2 = cp(); d2.yft.nU = 2048;
        assert.throws(() => assertBandsMatch(d2, exp), /nU drifted/);
        const d3 = cp(); d3.roar.ctrl = [0.8, 1.1];
        assert.throws(() => assertBandsMatch(d3, exp), /ctrl drifted/);
        const d4 = cp(); d4.roar.x2 = [1.6, 2.5];
        assert.throws(() => assertBandsMatch(d4, exp), /x2 drifted/);
        assert.throws(() => assertBandsMatch(lanes, expectedLanes(wsrc.replace('const W_N = 28;', 'const W_N = 27;'), rsrc)), /wN drifted/);
        assert.throws(() => assertBandsMatch(lanes, expectedLanes(wsrc, rsrc.replace('const CTRL_LO = 0.9;', 'const CTRL_LO = 0.8;'))), /ctrl drifted/);
        assert.throws(() => assertBandsMatch(lanes, expectedLanes(wsrc.replace('const YFT_N_U = 4096;', 'const YFT_N_U = 2048;'), rsrc)), /nU drifted/);
    });

// ================================================================================================
// A6 -- serve + pins
// ================================================================================================

function mockRes() {
    const res = {
        statusCode: 0, headers: {}, chunks: [], ended: false, headersSent: false,
        writeHead(code, hdrs) {
            res.statusCode = code;
            res.headersSent = true;
            if (hdrs) for (const k of Object.keys(hdrs)) res.headers[k.toLowerCase()] = hdrs[k];
        },
        end(body) { if (body !== undefined) res.chunks.push(body); res.ended = true; },
    };
    return res;
}
// Every response, whatever its status, must carry COOP + COEP (checked on every driven row).
async function drive(url, load, method = 'GET') {
    const S = await loadS();
    const res = mockRes();
    if (load === undefined) await S.handle({ url, method }, res);
    else await S.handle({ url, method }, res, load);
    assert.ok(res.ended, url + ' response was never ended');
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', url + ' COOP');
    assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp', url + ' COEP');
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url + ' nosniff');
    assert.equal(res.headers['cache-control'], 'no-store', url + ' no-store');
    return res;
}
const bodyText = (res) => res.chunks.map((c) => (typeof c === 'string' ? c : Buffer.from(c).toString('utf8'))).join('');

test('A6 serve: binds 127.0.0.1; "/" 302; allowlisted paths 200 + MIME; traversal/non-allowlisted 404; malformed escape 400',
    { timeout: 60000 }, async () => {
        const S = await loadS();
        assert.equal(S.HOST, '127.0.0.1');
        const srv = S.start(0);
        try {
            await new Promise((resolve, reject) => { srv.once('listening', resolve); srv.once('error', reject); });
            assert.equal(srv.address().address, '127.0.0.1', 'must bind loopback only');
            // a real request through the real server carries the headers too
            const r = await fetch('http://127.0.0.1:' + srv.address().port + '/LogLogN.js');
            assert.equal(r.status, 200);
            assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
        } finally {
            srv.close();
        }
        assert.ok(Array.isArray(S.ALLOWED_PATHS) || Object.isFrozen(S.ALLOWED_PATHS));
        assert.equal(typeof S.DEFAULT_PORT, 'number');
        const root = await drive('/');
        assert.equal(root.statusCode, 302);
        assert.ok(root.headers.location, 'redirect needs a location');
        const target = await drive(root.headers.location);
        assert.equal(target.statusCode, 200, 'the redirect target must be served');
        assert.match(String(target.headers['content-type']), /text\/html/);
        assert.ok('cross-origin-opener-policy' in target.headers && 'cross-origin-embedder-policy' in target.headers,
            'COOP / COEP headers expected');
        const allow = S.ALLOWED_PATHS.map((p) => [p, p.endsWith('.html') ? /text\/html/ : /javascript/]);
        for (const need of ['/demo/visuals.html', '/demo/Visualize.mjs', '/demo/renderers.mjs', '/LogLogN.js',
            '/node_modules/@zakkster/lite-logn/LogN.js']) assert.ok(S.ALLOWED_PATHS.includes(need), need + ' must be allowlisted');
        // plus every module the page itself imports (derived from the page, not from serve.mjs): relative AND absolute
        const page = readFileSync(join(DEMO_DIR, 'visuals.html'), 'utf8');
        const expectedAllowed = new Set(['/demo/visuals.html']);
        const IMP_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]((?:\.{1,2})?\/[^'"]+)['"]/g;
        const queue = [['/demo/visuals.html', page]];
        while (queue.length !== 0) {
            const [base, src] = queue.pop();
            for (const m of stripComments(src).matchAll(IMP_RE)) {
                const u = new URL(m[1], 'http://x' + base).pathname;
                if (expectedAllowed.has(u)) continue;
                expectedAllowed.add(u);
                if (!allow.some((p) => p[0] === u)) allow.push([u, /javascript/]);
                queue.push([u, readFileSync(join(REPO, u), 'utf8')]);
            }
        }
        assert.ok(expectedAllowed.size >= 6, 'the page import scan found too few modules: ' + [...expectedAllowed]);
        // deny by default, EXACT: the allowlist is the page + its imports + /LogLogN.js, nothing more, nothing less
        assert.deepStrictEqual([...S.ALLOWED_PATHS].sort(), [...expectedAllowed].sort(), 'ALLOWED_PATHS must equal the page + its transitive imports');
        for (const [p, mime] of allow) {
            const r = await drive(p);
            assert.equal(r.statusCode, 200, p + ' must be allowlisted');
            assert.match(String(r.headers['content-type']), mime, p + ' MIME');
        }
        for (const p of ['/package.json', '/../', '/../package.json', '/%2e%2e', '/%2e%2e/package.json', '/..%2fpackage.json',
            '/demo/Demo.test.mjs', '/demo/%2e%2e/package.json', '/CHANGELOG.md', '/test/witness.mjs']) {
            const r = await drive(p);
            assert.equal(r.statusCode, 404, p + ' must be 404 (deny by default)');
        }
        // a method other than GET / HEAD -> 405 with allow: 'GET, HEAD'; HEAD -> 200 with no body
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
            for (const p of ['/LogLogN.js', '/workload.json?kind=mixed&seed=1&U=65536&n=256', '/nope']) {
                const r = await drive(p, undefined, method);
                assert.equal(r.statusCode, 405, method + ' ' + p + ' must be 405');
                assert.equal(r.headers.allow, 'GET, HEAD', method + ' allow header');
            }
        }
        const head = await drive('/demo/visuals.html', undefined, 'HEAD');
        assert.equal(head.statusCode, 200);
        assert.equal(head.chunks.length, 0, 'HEAD carries no body');
        const bad = await drive('/demo/%E0%A4%A');
        assert.equal(bad.statusCode, 400, 'malformed percent escape -> 400');
        // CONTROL: the matrix is not vacuous -- a clearly allowlisted path is not 404/400.
        assert.notEqual((await drive('/LogLogN.js')).statusCode, 404);
    });

test('A6 serve: /workload.json validates kind/seed/U/n (400), good query 200 with hash == buildOpStream, handler throw -> 500',
    { timeout: 60000 }, async () => {
        const V = await loadV();
        const q = (o) => '/workload.json?' + Object.entries(o).map(([k, v]) => k + '=' + v).join('&');
        const good = { kind: 'mixed', seed: 12648430, U: 16777216, n: 4096 };
        const ok = await drive(q(good));
        assert.equal(ok.statusCode, 200);
        const body = JSON.parse(bodyText(ok));
        assert.deepStrictEqual(Object.keys(body).sort(), ['U', 'hash', 'kind', 'n', 'seed'], 'payload keys (no timing)');
        assert.equal(body.kind, 'mixed');
        assert.equal(body.seed, 12648430);
        assert.equal(body.U, 16777216);
        assert.equal(body.n, 4096);
        const ref = refOpStream(V, 'mixed', good.seed, good.U, good.n);
        assert.equal(body.hash, V.buildOpStream('mixed', good.seed, good.U, good.n).hash, 'hash == demo buildOpStream');
        assert.ok(sameHash(body.hash, ref.hash), 'hash == independent reference');
        // CONTROL: a different seed gives a different hash through the same endpoint.
        const ok2 = JSON.parse(bodyText(await drive(q({ ...good, seed: good.seed + 1 }))));
        assert.notEqual(ok2.hash, body.hash);
        const bads = [
            { ...good, kind: 'nonsense' }, { ...good, kind: '' }, { ...good, kind: 'MIXED' },
            { ...good, seed: 'abc' }, { ...good, seed: '12x' }, { ...good, seed: 'NaN' }, { ...good, seed: 'Infinity' },
            { ...good, U: 0 }, { ...good, U: 1 }, { ...good, U: 'x' }, { ...good, U: -4 }, { ...good, U: 4294967297 }, { ...good, U: 1.5 },
            { ...good, n: 0 }, { ...good, n: -1 }, { ...good, n: 'NaN' }, { ...good, n: 1.5 }, { ...good, n: 1e9 },
            // bounds (R-B3): seed uint32 only; U in [2^16, 2^32]; n in [2^8, 2^16]
            { ...good, seed: 1.5 }, { ...good, seed: -1 }, { ...good, seed: 4294967296 },
            { ...good, U: 65535 }, { ...good, n: 255 }, { ...good, n: 65537 },
        ];
        for (const b of bads) assert.equal((await drive(q(b))).statusCode, 400, JSON.stringify(b) + ' must 400');
        for (const missing of ['kind', 'seed', 'U', 'n']) {
            const o = { ...good };
            delete o[missing];
            assert.equal((await drive(q(o))).statusCode, 400, 'missing ' + missing + ' must 400 (no silent default)');
        }
        // raw rows: duplicate key, unknown key, wrong-case key (with a did-you-mean hint) -> 400
        for (const extra of ['&seed=1', '&x=1', '&u=1']) {
            const r = await drive(q(good) + extra);
            assert.equal(r.statusCode, 400, extra + ' must 400');
            if (extra === '&u=1') assert.match(JSON.parse(bodyText(r)).error, /did you mean "U"/);
        }
        // hex seed is accepted and equals the decimal query's answer
        const hexRes = await drive(q({ ...good, seed: '0xC0FFEE' }));
        assert.equal(hexRes.statusCode, 200);
        const hexBody = JSON.parse(bodyText(hexRes));
        assert.equal(hexBody.seed, 12648430);
        assert.equal(hexBody.hash, body.hash, 'hex seed hashes like the decimal seed');
        // corners of the dial grid: independent reference hashes (refOpStream), not the demo's
        for (const c of [{ kind: 'query', seed: 0, U: 65536, n: 256 }, { kind: 'churn', seed: 4294967295, U: 4294967296, n: 65536 }]) {
            const r = await drive(q(c));
            assert.equal(r.statusCode, 200, JSON.stringify(c) + ' must be 200');
            const b = JSON.parse(bodyText(r));
            assert.deepStrictEqual([b.kind, b.seed, b.U, b.n], [c.kind, c.seed, c.U, c.n]);
            assert.ok(sameHash(b.hash, refOpStream(V, c.kind, c.seed, c.U, c.n).hash), 'corner hash == independent reference ' + JSON.stringify(c));
        }
        // the `load` seam: a loader that rejects / throws / returns a bad module -> 500 (never a hang or a reject)
        for (const load of [() => Promise.reject(new Error('boom')), () => { throw new Error('boom'); }, () => Promise.resolve({})]) {
            const thrown = await drive(q(good), load);
            assert.equal(thrown.statusCode, 500, 'a loader failure must end as a 500');
        }
        // CONTROL: the same query with the real loader is still 200.
        assert.equal((await drive(q(good))).statusCode, 200);
        // createServer(handler): a throwing handler is turned into a real 500 over HTTP
        const S = await loadS();
        const srv = S.createServer(() => { throw new Error('boom'); });
        srv.listen(0, '127.0.0.1');
        try {
            await new Promise((resolve) => srv.once('listening', resolve));
            const r = await fetch('http://127.0.0.1:' + srv.address().port + '/');
            assert.equal(r.status, 500);
            await r.text();
        } finally {
            srv.close();
        }
    });

test('A6 pins: LogLogN.js sha256; Visualize static imports exactly ["../LogLogN.js"]; package.json test/verify do not mention demo',
    () => {
        const sha = createHash('sha256').update(readFileSync(join(REPO, 'LogLogN.js'))).digest('hex');
        assert.equal(sha, 'baa2818d60b5845b4d3dd65a5a345824ba821c0a81df5fd2028f271271d85564', 'LogLogN.js must stay byte-identical');
        const staticImports = (src) => {
            const out = [];
            const s = stripComments(src);
            for (const m of s.matchAll(/(?:^|\n)\s*import\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g)) out.push(m[1]);
            for (const m of s.matchAll(/(?:^|\n)\s*export\s+[^'"();]*?\s+from\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
            return out;
        };
        const imps = staticImports(readFileSync(join(DEMO_DIR, 'Visualize.mjs'), 'utf8'));
        assert.deepStrictEqual(imps, ['../LogLogN.js']);
        // CONTROL: the parser sees an added import and ignores dynamic import().
        assert.deepStrictEqual(staticImports("import { A } from '../LogLogN.js';\nimport x from 'node:fs';\nconst y = await import('z');\n"),
            ['../LogLogN.js', 'node:fs']);
        assert.deepStrictEqual(staticImports("import '../LogLogN.js';\n"), ['../LogLogN.js']);
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
        assert.ok(!/demo/i.test(pkg.scripts.test), 'npm test must not mention demo');
        assert.ok(!/demo/i.test(pkg.scripts.verify), 'npm run verify must not mention demo');
        assert.ok(!pkg.files.some((f) => /demo/i.test(f)), 'demo/ must never appear in files[]');
        // CONTROL: the regex used for the check does see a demo mention.
        assert.ok(/demo/i.test('npm test && npm run test:demo'));
    });
