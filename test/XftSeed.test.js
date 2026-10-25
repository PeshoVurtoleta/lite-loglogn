/**
 * @zakkster/lite-loglogn -- the optional level seed (0.4.0 G1-6, ASSERTION A4;
 * PLAN-yfasttrie C-4 / C-5 / C-6 / C-13). DETERMINISTIC.
 *
 *   C-5 / C-13  new XFastTrie(U, C), (U, C, undefined) and (U, C, 0) reproduce
 *               test/vectors/xft-seed.json exactly (cut from the frozen 0.3.0
 *               build fd8fcec / 375caeab): `_lv` after the ctor and at the end,
 *               the final kicks / reseedOps / tries, the dump sha -- all 15
 *               xft-b0 streams + the collide() reseed row (the only reseeding
 *               row: the reseed half of C-13 rests on it);
 *   C-4         seed 1 changes `_lv` on EVERY row (16 / 16) -- the teeth: this
 *               row FAILS on the frozen build (no seed parameter); the
 *               constructed `_lv` equals the C-4 schedule s1 = fmix32(imul(L,
 *               0x9e3779b1) ^ S_L ^ (seed | 0)), s2 = fmix32(s1 ^ 0x85ebca6b),
 *               computed here from test/helpers/xftStream.mjs levelGeometry
 *               (never read back from the engine), for 7 seeds incl. 2^31 and
 *               2^32-1 (seed | 0 < 0); the 7 seeds give 7 distinct `_lv`;
 *   C-6         clear() restores the CONSTRUCTED `_lv` -- a caller seed included
 *               -- after a FORCED reseed (`_rebuild`, the cold path a hash flood
 *               takes) and after a natural one (keys colliding under that seed),
 *               and the cleared instance replays a stream exactly like a fresh
 *               one with the same seed;
 *   C-4 / C-6   YFastTrie forwards the seed: its inner `_x._lv` equals new
 *               XFastTrie(U, Cr, seed)._lv, Cr = min(2 + floor(C / ceil(w/2)), U)
 *               computed here; clear() restores it after a forced inner reseed.
 *
 * HANG SAFETY: the stream replays (the only part that walks threads on valid
 * keys) run in a Worker started from this file under the A6 kill timer
 * (KILL_MS from test/_worker-run.mjs); a hang, an error, a nonzero exit or a
 * missing result is a FAIL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
    STREAMS, N_OPS, genStream, streamSeed, replay, levelGeometry, fmix32,
} from './helpers/xftStream.mjs';
import { lvSha, sha256, FROZEN_SHA256, FROZEN_COMMIT } from './helpers/yftStream.mjs';
import { KILL_MS } from './_worker-run.mjs';

const BUILD = new URL('../LogLogN.js', import.meta.url);
const VARIANTS = ['omitted', 'undefined', '0'];

/** new Cls(U, C) with the seed argument shaped by variant (omitted / undefined / a value). */
function make(Cls, U, C, v) {
    if (v === 'omitted') return new Cls(U, C);
    if (v === 'undefined') return new Cls(U, C, undefined);
    return new Cls(U, C, Number(v));
}

function seedFields(t, lvCtor) {
    return { lvCtor, lvEnd: lvSha(t._lv), q: [t._q[1], t._q[2], t._q[3]], dump: sha256(JSON.stringify(t.dump())) };
}

// --- worker body: every replay of the vectors ---------------------------------------

async function replayJob(buildHref, vec) {
    const { XFastTrie } = await import(buildHref);
    const rows = [];
    for (let i = 0; i < STREAMS.length; i++) {
        const [U, C] = STREAMS[i];
        const st = genStream(U, C, N_OPS, streamSeed(i));
        for (const v of VARIANTS) {
            const t = make(XFastTrie, U, C, v);
            const lvCtor = lvSha(t._lv);
            const r = replay(t, U, st);
            rows.push({ i, v, size: r.finalSize, ...seedFields(t, lvCtor) });
        }
    }
    const { U, C, keys } = vec.collide;
    for (const v of VARIANTS) {
        const t = make(XFastTrie, U, C, v);
        const lvCtor = lvSha(t._lv);
        for (const k of keys) t.add(k);
        rows.push({ i: 'collide', v, size: t.size, ...seedFields(t, lvCtor) });
    }
    return rows;
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData.xftSeedJob === true) {
    let msg;
    try {
        msg = { ok: true, rows: await replayJob(workerData.build, workerData.vec) };
    } catch (e) {
        msg = { ok: false, message: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}

// --- main thread: the tests -----------------------------------------------------------

if (isMainThread) {
    const VEC = JSON.parse(readFileSync(new URL('./vectors/xft-seed.json', import.meta.url), 'utf8'));
    const { XFastTrie, YFastTrie } = await import(BUILD.href);
    const T = { timeout: 120000 };

    /** Runs the replay job in a Worker of this file (or a control spec); NEVER rejects: { rows, error }. */
    function startReplay(ms, spec = new URL(import.meta.url),
        opts = { workerData: { xftSeedJob: true, build: BUILD.href, vec: VEC } }) {
        return new Promise((resolve) => {
            let rows = null;
            let done = false;
            const w = new Worker(spec, opts);
            const finish = (error) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ rows, error });
            };
            const timer = setTimeout(() => {
                w.terminate();
                finish('hang > ' + ms + ' ms: xft-seed replay worker terminated');
            }, ms);
            w.on('message', (m) => {
                if (m !== null && typeof m === 'object' && m.ok === true && Array.isArray(m.rows)) rows = m.rows;
                else finish('xft-seed replay worker failed: ' + String(m && m.message));
            });
            w.on('error', (e) => finish('xft-seed replay worker error: ' + (e && e.stack ? e.stack : String(e))));
            w.on('exit', (code) => finish(code === 0 ? (rows === null ? 'xft-seed replay worker posted no result' : null)
                : 'xft-seed replay worker exit code ' + code));
        });
    }
    const REPLAY = startReplay(KILL_MS);

    /** The 16 (U, C) rows of the vectors: the 15 xft-b0 streams + the collide row. */
    const ROWS = [...VEC.streams.map((s) => ({ name: 'stream ' + s.i, U: s.U, C: s.C, lvCtor: s.lvCtor })),
        { name: 'collide', U: VEC.collide.U, C: VEC.collide.C, lvCtor: VEC.collide.lvCtor }];

    /** The C-4 `_lv` of (U, C, seed), from the test-owned geometry. */
    function lvModel(U, C, seed) {
        const g = levelGeometry(U, C);
        const out = new Int32Array(4 * (g.w + 1));
        for (let L = 1; L <= g.w; L++) {
            const d = g.levels[L];
            const s1 = fmix32(Math.imul(L, 0x9e3779b1) ^ d.S ^ (seed | 0));
            out[4 * L] = d.base;
            out[4 * L + 1] = d.mask;
            out[4 * L + 2] = s1;
            out[4 * L + 3] = fmix32(s1 ^ 0x85ebca6b);
        }
        return out;
    }

    /** The first n keys whose level-w prefixes share h1 AND h2 under the seeded schedule (a forced stall). */
    function collideSeeded(U, C, seed, n) {
        const lv = lvModel(U, C, seed);
        const w = levelGeometry(U, C).w;
        const mask = lv[4 * w + 1];
        const groups = new Map();
        for (let x = 0; x < Math.min(U, 16777216); x++) {
            const k = (fmix32(x ^ lv[4 * w + 2]) & mask) * (mask + 1) + (fmix32(x ^ lv[4 * w + 3]) & mask);
            let a = groups.get(k);
            if (a === undefined) groups.set(k, a = []);
            a.push(x);
            if (a.length === n) return a;
        }
        return null;
    }

    const SEEDS7 = [0, 1, 2, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff];
    const SEEDS5 = [undefined, 0, 1, 0xdeadbeef, 0xffffffff];
    const sd = (s) => (s === undefined ? 'undefined' : '0x' + s.toString(16));

    test('xft-seed.json is the frozen-build cut it claims (15 streams + 1 reseeding collide row)', () => {
        assert.equal(VEC.build.commit, FROZEN_COMMIT);
        assert.equal(VEC.build.sha256, FROZEN_SHA256);
        assert.equal(VEC.nOps, N_OPS);
        assert.equal(VEC.streams.length, STREAMS.length);
        assert.equal(STREAMS.length, 15);
        VEC.streams.forEach((s, i) => {
            assert.deepEqual([s.U, s.C, s.streamSeed], [STREAMS[i][0], STREAMS[i][1], streamSeed(i)]);
        });
        assert.ok(VEC.collide.q[1] >= 1, 'the collide row reseeds (q = ' + VEC.collide.q.join(',') + ')');
        assert.notEqual(VEC.collide.lvEnd, VEC.collide.lvCtor);
        // no xft-b0 row reseeds: the reseed half of C-13 rests on the collide row alone
        assert.equal(VEC.streams.filter((s) => s.q[1] !== 0).length, 0);
    });

    test('A4 / C-5 / C-13: seed omitted / undefined / 0 reproduce xft-seed.json on all 16 rows (48 replays)', T, async (t) => {
        const r = await REPLAY;
        assert.equal(r.error, null, String(r.error));
        assert.equal(r.rows.length, 16 * VARIANTS.length);
        const bad = [];
        for (const row of r.rows) {
            const want = row.i === 'collide' ? VEC.collide : VEC.streams[row.i];
            for (const f of ['lvCtor', 'lvEnd', 'dump']) {
                if (row[f] !== want[f]) bad.push(row.i + '/' + row.v + ' ' + f);
            }
            if (row.q.join() !== want.q.join()) bad.push(row.i + '/' + row.v + ' q ' + row.q.join() + ' != ' + want.q.join());
        }
        const coll = r.rows.filter((x) => x.i === 'collide');
        t.diagnostic('collide row q (kicks, reseedOps, tries) per variant: ' + coll.map((x) => x.v + '=' + x.q.join(',')).join(' '));
        assert.deepEqual(bad, []);
        for (const x of coll) assert.ok(x.q[1] >= 1 && x.lvEnd !== x.lvCtor, 'the collide row reseeded under ' + x.v);
    });

    test('A4 / C-4: seed 1 changes `_lv` on every row (16 / 16) -- FAILS on the frozen 0.3.0 build', () => {
        const same = [];
        for (const r of ROWS) {
            assert.equal(lvSha(new XFastTrie(r.U, r.C)._lv), r.lvCtor, r.name + ' default');
            if (lvSha(new XFastTrie(r.U, r.C, 1)._lv) === r.lvCtor) same.push(r.name);
        }
        assert.deepEqual(same, [], 'seed 1 left `_lv` unchanged on: ' + same.join(', '));
    });

    test('C-4: the constructed `_lv` == the C-4 schedule from the test-owned geometry (7 seeds x 16 rows); 7 distinct', () => {
        let n = 0;
        for (const r of ROWS) {
            const seen = new Set();
            for (const s of SEEDS7) {
                const got = new XFastTrie(r.U, r.C, s)._lv;
                assert.deepEqual(Array.from(got), Array.from(lvModel(r.U, r.C, s)), r.name + ' seed ' + sd(s));
                seen.add(lvSha(got));
                n++;
            }
            assert.equal(seen.size, SEEDS7.length, r.name + ': the 7 seeds give 7 distinct `_lv`');
            assert.equal(lvSha(lvModel(r.U, r.C, 0)), r.lvCtor, r.name + ': the model at seed 0 is the vector');
        }
        assert.equal(n, 16 * 7);
    });

    test('C-6: XFastTrie clear() restores the constructed `_lv` after a FORCED reseed, caller seeds included', () => {
        const U = 65536;
        const C = 64;
        const st = genStream(U, C, 4000, streamSeed(7));
        for (const s of SEEDS5) {
            const x = new XFastTrie(U, C, s);
            const lv0 = Array.from(x._lv);
            for (let k = 0; k < 40; k++) x.add(k * 1601);
            const r0 = x._q[2];
            x._rebuild(x.bits, x._next[0]);
            assert.equal(x._q[2], r0 + 1, sd(s) + ': one reseedOp');
            assert.notDeepEqual(Array.from(x._lv), lv0, sd(s) + ': the forced reseed moved `_lv`');
            x.clear();
            assert.deepEqual(Array.from(x._lv), lv0, sd(s) + ': clear() restored the constructed `_lv`');
            assert.deepEqual(Array.from(x._lv), Array.from(lvModel(U, C, s)), sd(s) + ': == the C-4 schedule');
            assert.equal(x.size, 0);
            // behaviour: the cleared instance replays exactly like a fresh one with the same seed
            const fresh = new XFastTrie(U, C, s);
            const a = replay(x, U, st);
            const b = replay(fresh, U, st);
            assert.equal(a.resultsHash, b.resultsHash, sd(s) + ' resultsHash');
            assert.equal(sha256(JSON.stringify(x.dump())), sha256(JSON.stringify(fresh.dump())), sd(s) + ' dump');
            assert.equal(lvSha(x._lv), lvSha(fresh._lv), sd(s) + ' `_lv` at the end');
        }
    });

    test('C-6: XFastTrie clear() restores the constructed `_lv` after a NATURAL reseed (keys colliding under that seed)', (t) => {
        const U = 65536;
        const C = 16;
        const out = [];
        for (const s of SEEDS5) {
            const keys = collideSeeded(U, C, s, 9);
            assert.ok(keys !== null, sd(s) + ': a colliding group exists');
            const x = new XFastTrie(U, C, s);
            const lv0 = Array.from(x._lv);
            for (const k of keys) x.add(k);
            assert.ok(x._q[2] >= 1, sd(s) + ': the 9 colliding keys reseeded (q = ' + x._q[1] + ',' + x._q[2] + ',' + x._q[3] + ')');
            assert.notDeepEqual(Array.from(x._lv), lv0);
            assert.deepEqual(Array.from(x.dump().keys), keys.slice().sort((a, b) => a - b));
            out.push(sd(s) + ' keys ' + keys.join(',') + ' q ' + x._q[1] + '/' + x._q[2] + '/' + x._q[3]);
            x.clear();
            assert.deepEqual(Array.from(x._lv), lv0, sd(s) + ': clear() restored the constructed `_lv`');
        }
        t.diagnostic(out.join(' | '));
        assert.deepEqual(collideSeeded(U, C, undefined, 9), VEC.collide.keys, 'the test-owned search reproduces the vector keys at seed 0');
    });

    test('C-4: YFastTrie forwards the seed -- inner `_x._lv` == XFastTrie(U, Cr, seed)._lv (15 (U, C) x 5 seeds)', () => {
        let n = 0;
        for (const [U, C] of STREAMS) {
            const w = 32 - Math.clz32(U - 1);
            const cr = Math.min(2 + Math.floor(C / Math.ceil(w / 2)), U);
            const dflt = Array.from(new XFastTrie(U, cr)._lv);
            for (const s of SEEDS5) {
                const y = new YFastTrie(U, C, s);
                assert.equal(y._x.capacity, cr, U + '/' + C + ' inner capacity Cr');
                assert.deepEqual(Array.from(y._x._lv), Array.from(new XFastTrie(U, cr, s)._lv), U + '/' + C + ' seed ' + sd(s));
                if (s === undefined || s === 0) assert.deepEqual(Array.from(y._x._lv), dflt, 'seed ' + sd(s) + ' is the default');
                else assert.notDeepEqual(Array.from(y._x._lv), dflt, 'seed ' + sd(s) + ' moved the inner seeds');
                n++;
            }
        }
        assert.equal(n, 15 * 5);
    });

    test('C-6: YFastTrie clear() restores the inner constructed `_lv` after a forced inner reseed, caller seeds included', () => {
        const U = 65536;
        const C = 512;
        const st = genStream(U, C, 4000, streamSeed(7));
        for (const s of SEEDS5) {
            const y = new YFastTrie(U, C, s);
            const lv0 = Array.from(y._x._lv);
            for (let k = 0; k < 400; k++) y.add(k * 151);
            assert.ok(y._x.size >= 10, 'the inner trie holds reps (' + y._x.size + ')');
            const r0 = y._x._q[2];
            y._x._rebuild(y.bits, y._x._next[0]);
            assert.equal(y._x._q[2], r0 + 1);
            assert.notDeepEqual(Array.from(y._x._lv), lv0, sd(s) + ': the forced reseed moved the inner `_lv`');
            y.clear();
            assert.deepEqual(Array.from(y._x._lv), lv0, sd(s) + ': clear() restored the inner constructed `_lv`');
            assert.equal(y.size, 0);
            assert.equal(y._x.size, 1, 'rep 0 re-added');
            assert.equal(y.min(), undefined);
            const fresh = new YFastTrie(U, C, s);
            const a = replay(y, U, st);
            const b = replay(fresh, U, st);
            assert.equal(a.resultsHash, b.resultsHash, sd(s) + ' resultsHash');
            assert.deepEqual(y.dump(), fresh.dump(), sd(s) + ' dump');
            assert.equal(lvSha(y._x._lv), lvSha(fresh._x._lv), sd(s) + ' inner `_lv` at the end');
        }
    });

    test('control: a replay worker that hangs / exits 1 / posts nothing / posts garbage is a FAIL', T, async () => {
        const ev = { eval: true };
        const hang = await startReplay(300, 'for (;;) {}', ev);
        assert.ok(hang.error !== null && /^hang > 300 ms/.test(hang.error), String(hang.error));
        const exit1 = await startReplay(5000, 'process.exit(1)', ev);
        assert.ok(exit1.error !== null && /exit code 1/.test(exit1.error), String(exit1.error));
        const empty = await startReplay(5000, '0', ev);
        assert.ok(empty.error !== null && /posted no result/.test(empty.error), String(empty.error));
        const garbage = await startReplay(5000, "require('node:worker_threads').parentPort.postMessage({ ok: true, rows: 'x' })", ev);
        assert.ok(garbage.error !== null && /failed/.test(garbage.error), String(garbage.error));
        for (const r of [hang, exit1, empty, garbage]) assert.equal(r.rows, null);
    });
}
