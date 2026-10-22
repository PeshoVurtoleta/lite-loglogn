/**
 * @zakkster/lite-loglogn -- torture gate.
 *
 *     node --expose-gc test/torture.mjs
 *
 * Two jobs, kept separate (torture-harness skill):
 *   - @zakkster/lite-leak       -- retention: does a member instance outlive its
 *                                  owner? tracker.size() -> 0 is the proof.
 *   - @zakkster/lite-gc-profiler -- budget: does V8 collect where it must not,
 *                                   and does the hot path allocate?
 *
 * Tiers (PLAN-stratifiedbitset A4 / A11), each printed as ONE parseable line:
 *   T0  2,000,000 mixed ops (add / delete / has / successor x2 / predecessor /
 *       min / max) at U = 2^20 on ONE instance built outside the loop:
 *       retained 0 B/op (measureAllocs; null is a FAIL, never a 0), transient
 *       0 B/op (new-space lane: measureAllocs only sees bytes that SURVIVE a
 *       forced GC, so a box that dies young needs its own lane), gc major 0,
 *       maxPauseMs <= 4.
 *   T1  U = 2^24, stabilize 'deep': arrayBuffers growth 0 -- every member
 *       lives in a typed-array backing store outside the V8 heap, where a heap
 *       gate alone is blind (a `_bits` reallocation shows only here).
 *   T2  4,096 churn cycles at U = 2^16: tracker.size() 0 after the drain and
 *       still 0 one gc later, every tracked instance finalized, findings 0,
 *       leaks 0.
 *   T3  controls that MUST flip their check: a retaining loop (alloc > 0), a
 *       transient-box loop (transient > 0), GrowingBitset (abGrowth > 0), a
 *       retained array (size > 0). Any control passing is exit 1.
 * Exit 0 only if every tier passes and every control flips. Never widen a
 * budget to make this pass -- a budget that moves is not a gate.
 *
 * ENTRY CONTRACT: --expose-gc is mandatory (the GC gate is meaningless without
 * it); the devDeps are imported AFTER the guard so a fresh clone that skipped
 * `npm install` fails with a remedy, not a stack trace.
 *
 * SEMI-SPACE PIN: the transient lane (window size NS_K, the scavenge-discard
 * rule, the C2 control's one-array-per-op window) is calibrated under V8's
 * DEFAULT new space -- `npm run torture` passes no semi-space flag. Any
 * semi-space / young-generation flag in execArgv or NODE_OPTIONS changes when
 * a window scavenges (and is discarded), so it is a FAIL at entry, never a
 * silent re-scale; the check runs its own must-fail control first. The T0
 * line prints `semi=default`.
 */

// Returns null when no semi-space / young-generation flag is present in argv
// or the NODE_OPTIONS string, else a failure string. Cold.
const SEMI_FLAG = /semi[-_]space|young[-_]generation/;
function semiFlagErr(argv, nodeOptions) {
    if (!Array.isArray(argv)) return 'execArgv is not an array';
    const opts = typeof nodeOptions === 'string' ? nodeOptions.split(/\s+/) : [];
    for (const a of argv.concat(opts)) {
        if (typeof a === 'string' && SEMI_FLAG.test(a)) return 'semi-space flag ' + a;
    }
    return null;
}

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }
    // must-fail control of the pin check, then the pin itself
    if (semiFlagErr(['--expose-gc'], '') !== null ||
        semiFlagErr(['--expose-gc', '--max-semi-space-size=4'], '') === null ||
        semiFlagErr(['--expose-gc', '--min-semi-space-size=1'], '') === null ||
        semiFlagErr(['--expose-gc'], '--max-semi-space-size=16') === null ||
        semiFlagErr(['--expose-gc'], '--semi-space-growth-factor=2') === null) {
        process.stderr.write('torture: FAIL -- semi-space pin control: the check is blind\n');
        process.exit(1);
    }
    const semiErr = semiFlagErr(process.execArgv, process.env.NODE_OPTIONS);
    if (semiErr !== null) {
        process.stderr.write('torture: FAIL -- ' + semiErr + ': the transient lane is calibrated ' +
            'under the default new space; run: node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }
    for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
        try {
            await import(pkg);
        } catch {
            process.stderr.write(
                'torture: FAIL -- missing devDependency ' + pkg + ' -- run: npm install\n');
            process.exit(2);
        }
    }

    const { GcProfiler, checkNoGc, measureAllocs, measureOps } =
        await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const { getHeapSpaceStatistics } = await import('node:v8');
    const { StratifiedBitset } = await import('../LogLogN.js');

    const U0 = 1 << 20;     // T0 universe (4 levels)
    const U1 = 1 << 24;     // T1 universe (5 levels, 2,164,804 B)
    const U2 = 1 << 16;     // T2 universe (4 levels, 8,460 B)
    const HOT = 2000000;    // T0 GC-budget window, ops
    const CYCLES = 4096;    // T2 retention churn
    const NS_K = 65536;     // transient lane: ops per new-space window
    const NS_W = 17;        // transient lane: windows (window 0 printed, not floored)
    // Transient lane threshold: less than one 16 B HeapNumber per 1,024 ops
    // (1,024 B per 65,536-op window). The readout itself (getHeapSpaceStatistics)
    // allocates ~2.9 KB per window; the empty-fn baseline subtracts it, and the
    // min over windows strips its +-1 KB jitter. A box every op reads 16 B/op.
    const NS_MAX_EXCESS = (16 * NS_K) / 1024;

    const KEYS = 65536;     // query ring, power of two
    const KMASK = KEYS - 1;
    const HALF = KEYS >>> 1;
    const SINK = new Int32Array(1);

    // Seeded xorshift32 key ring, masked into [0, u). Cold.
    function keyRing(u, seed) {
        const k = new Uint32Array(KEYS);
        let s = seed | 0;
        for (let i = 0; i < KEYS; i++) {
            s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
            k[i] = (s >>> 0) & (u - 1);
        }
        return k;
    }

    // Pre-populate with the keys op 0 adds (ring indices = 0 mod 8 in the first
    // half), so the population is steady (~HALF / 8 keys) from the first op: op 1
    // deletes the key op 0 added half a ring earlier. Cold.
    function populate(set, k) {
        for (let j = 0; j < HALF; j += 8) set.add(k[j]);
        return set;
    }

    // The mixed hot step. One closure per instance, built cold; it holds only
    // const bindings and writes its integer sink into an Int32Array slot (no
    // mutable number in a context, no box from the harness itself).
    function makeStep(set, k) {
        return function step(i) {
            const x = k[i & KMASK];
            let r = 0;
            switch (i & 7) {
                case 0: set.add(x); break;
                case 1: r = set.delete(k[(i - 1 + HALF) & KMASK]) ? 1 : 0; break;
                case 2: r = set.has(x) ? 1 : 0; break;
                case 3:
                case 4: r = set.successor(x); break;
                case 5: r = set.predecessor(x); break;
                case 6: r = set.min(); break;
                default: r = set.max();
            }
            SINK[0] = (SINK[0] + (r === undefined ? 7 : r)) | 0;
        };
    }

    function settle(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // new_space used bytes, or -1 when the space is not found (fails closed).
    function newSpaceUsed() {
        const a = getHeapSpaceStatistics();
        for (let j = 0; j < a.length; j++) {
            if (a[j].space_name === 'new_space') return a[j].space_used_size;
        }
        return -1;
    }

    // Min new-space delta over windows 1..NS_W-1 (window 0 printed only: it can
    // run unoptimized code). gc() before each window empties the young gen, so
    // a window holds K ops of allocation and nothing else. A window whose end
    // reads below its start scavenged mid-window: discarded. null = not measured.
    function nsLane(fn) {
        for (let i = 0; i < NS_K * 2; i++) fn(i);
        let min = -1;
        let first = -1;
        let valid = 0;
        for (let w = 0; w < NS_W; w++) {
            globalThis.gc();
            const a = newSpaceUsed();
            for (let i = 0; i < NS_K; i++) fn(i);
            const z = newSpaceUsed();
            if (a < 0 || z < 0 || z < a) continue;
            const d = z - a;
            if (w === 0) { first = d; continue; }
            valid++;
            if (min < 0 || d < min) min = d;
        }
        return valid >= (NS_W >>> 1) ? { min, first, valid } : null;
    }

    const emptyFn = function empty(i) { SINK[0] = (SINK[0] + (i & 1)) | 0; };
    const nsBase = nsLane(emptyFn);

    // Excess bytes per window over the empty baseline, or null.
    function nsExcess(fn) {
        const r = nsLane(fn);
        if (r === null || nsBase === null) return null;
        return { excess: r.min - nsBase.min, first: r.first - nsBase.min, valid: r.valid };
    }

    function fmt(n, d) {
        return n === null ? 'null' : n.toFixed(d);
    }

    const fails = [];

    // ---- T0: 2,000,000 mixed ops at U = 2^20 --------------------------------
    const k0 = keyRing(U0, 0x9e3779b9);
    const set0 = populate(new StratifiedBitset(U0), k0);
    const step0 = makeStep(set0, k0);

    // T0a retained B/op: 8 batches x 250,000 = 2,000,000 measured ops.
    const allocRes = measureAllocs(step0, { iterations: 250000, batches: 8 });
    const bpc = allocRes.bytesPerCall;
    const allocOk = bpc !== null && allocRes.settled === true && Math.round(bpc) === 0;
    if (!allocOk) {
        fails.push('T0 alloc bytesPerCall=' + bpc + ' settled=' + allocRes.settled +
            ' (null or unsettled is a FAIL, not 0)');
    }

    // T0b transient B/op (new-space lane).
    const ns0 = nsExcess(step0);
    const tOk = ns0 !== null && ns0.excess < NS_MAX_EXCESS;
    const tBpo = ns0 === null ? null : Math.max(0, ns0.excess) / NS_K;
    if (!tOk) {
        fails.push('T0 transient ' + (ns0 === null ? 'not measured (null)' :
            fmt(tBpo, 3) + ' B/op, excess ' + ns0.excess + ' B per ' + NS_K +
            ' ops >= ' + NS_MAX_EXCESS));
    }

    // T0c GC budget over the 2,000,000-op window.
    globalThis.gc();
    await settle(50);
    const gc = new GcProfiler().start();
    for (let i = 0; i < HOT; i++) {
        step0(i);
        if ((i & 8191) === 0) {
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
    }
    await settle(50);
    const s0 = gc.summary();
    const report = checkNoGc(s0, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();
    if (!report.ok) {
        for (const v of report.violations) {
            fails.push('T0 gc ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        }
        if (report.violations.length === 0) fails.push('T0 gc verdict=' + report.verdict);
    }
    const t0Ok = allocOk && tOk && report.ok;
    console.log('T0 ops=' + HOT + ' U=' + U0 +
        ' alloc=' + (bpc === null ? 'null' : Math.round(bpc)) + ' B/op' +
        ' allocRaw=' + fmt(bpc, 4) +
        ' transient=' + fmt(tBpo, 3) + ' B/op' +
        ' (limit ' + NS_MAX_EXCESS + ' B / ' + NS_K + ' ops)' +
        ' nsExcess=' + (ns0 === null ? 'null' : ns0.excess) +
        ' nsWin0=' + (ns0 === null ? 'null' : ns0.first) +
        ' gcMajor=' + s0.gc.major + ' gcMinor=' + s0.gc.minor +
        ' maxPauseMs=' + s0.gc.maxMs.toFixed(2) +
        ' semi=default' +
        ' | ' + (t0Ok ? 'ok' : 'FAIL'));

    // ---- T1: arrayBuffers growth at U = 2^24 --------------------------------
    const k1 = keyRing(U1, 0x2545f491);
    const set1 = populate(new StratifiedBitset(U1), k1);
    const step1 = makeStep(set1, k1);
    const r1 = measureOps(step1, { ops: 200000, warmup: 50000, stabilize: 'deep' });
    const ab1 = r1.summary.arrayBuffers;
    const rep1 = checkNoGc(r1.summary, { maxArrayBuffersGrowth: 0 });
    const t1Ok = rep1.verdict === 'pass' && ab1.settled === true && ab1.growthBytes === 0;
    if (!t1Ok) {
        fails.push('T1 abGrowth=' + ab1.growthBytes + ' settled=' + ab1.settled +
            ' verdict=' + rep1.verdict);
    }
    console.log('T1 ops=200000 U=' + U1 + ' byteLength=' + set1.byteLength +
        ' abGrowth=' + ab1.growthBytes + ' settled=' + ab1.settled +
        ' | ' + (t1Ok ? 'ok' : 'FAIL'));

    // ---- T2: retention churn at U = 2^16 ------------------------------------
    // No kernels: a member owns only its typed arrays (no timer, listener,
    // observer, or DOM node), so being collected is the DESIRED outcome, not a
    // resource orphan. onLeak therefore counts finalizations (`collected`, the
    // positive witness that the tracker saw every instance go); `leaks` counts
    // what lite-leak routes to onError (a throwing cleanup or tag). The
    // retention proof is tracker.size() returning to 0.
    //
    // The cleanup is a module-level no-op and the tag a string: neither closes
    // over the tracked instance (held-value contract). The churn lives in its
    // own function so its frame -- and any register holding the last instance --
    // is torn down before the drain; inline in main()'s long-lived async frame,
    // conservative stack scanning pins the last one.
    const noop = () => {};
    function makeTracker(name, box) {
        return createLeakTracker({
            name,
            onLeak: () => { box.collected++; },
            onError: (e) => { box.leaks.push(String(e)); },
            onWarning: (w) => { box.warns.push(w.kind + ':' + w.reason); },
        });
    }
    function churn(tracker, held) {
        let tracked = 0;
        for (let i = 0; i < CYCLES; i++) {
            const s = new StratifiedBitset(U2);
            const a = i & (U2 - 1);
            s.add(a).add(U2 - 1 - a);
            s.has(a);
            s.successor(a);
            s.predecessor(U2 - 1 - a);
            s.min();
            s.max();
            s.delete(a);
            tracker.track(s, noop, 'stratifiedbitset', { audit: true });
            tracked++;
            if (held !== null) held.push(s);
        }
        return tracked;
    }
    // Loop gc + a macrotask turn until the tracker empties (bounded, so a
    // genuine retention still fails): FinalizationRegistry callbacks run on
    // their own task.
    async function drain(tracker) {
        let live = tracker.size();
        for (let g = 0; g < 20 && live > 0; g++) {
            globalThis.gc();
            await settle(25);
            live = tracker.size();
        }
        return live;
    }

    const box2 = { collected: 0, leaks: [], warns: [] };
    const tracker2 = makeTracker('lite-loglogn', box2);
    const tracked2 = churn(tracker2, null);
    const live2 = await drain(tracker2);
    const findings2 = tracker2.audit();
    globalThis.gc();
    await settle(25);
    const after2 = tracker2.size();
    const t2Ok = tracked2 === CYCLES && live2 === 0 && after2 === 0 &&
        box2.collected === CYCLES && findings2.length === 0 && box2.leaks.length === 0;
    if (!t2Ok) {
        fails.push('T2 tracked=' + tracked2 + ' size=' + live2 + ' after=' + after2 +
            ' collected=' + box2.collected + ' findings=' + findings2.length +
            ' leaks=' + box2.leaks.length);
        for (const f of findings2) fails.push('T2 finding ' + f.kind + ':' + f.reason);
        for (const l of box2.leaks) fails.push('T2 leak ' + l);
    }
    console.log('T2 cycles=' + CYCLES + ' U=' + U2 + ' size=' + live2 + '/0' +
        ' after=' + after2 + ' collected=' + box2.collected + '/' + tracked2 +
        ' findings=' + findings2.length + ' warnings=' + box2.warns.length +
        ' leaks=' + box2.leaks.length +
        ' | ' + (t2Ok ? 'ok' : 'FAIL'));

    // ---- T3: controls (each MUST flip its tier's check) ---------------------
    // Run last: their closures and classes must not pollute the feedback the
    // real tiers were measured on.

    // C1 retaining loop: the T0 step plus one retained array per op. The
    // measureAllocs lane MUST read > 0 B/op.
    const hold = [];
    const retainFn = function retain(i) { step0(i); hold.push([i]); };
    const c1 = measureAllocs(retainFn, { iterations: 20000, batches: 4 });
    const c1Bpc = c1.bytesPerCall;
    const c1Flip = c1Bpc !== null && Math.round(c1Bpc) > 0;
    hold.length = 0;

    // C2 transient-box loop: the T0 step plus one array per op into a 64-slot
    // ring (escapes, so escape analysis cannot drop it; overwritten within 64
    // ops, so allocation-site pretenuring cannot move it to old space). The
    // new-space lane MUST read over its threshold; measureAllocs cannot see it.
    const ring = new Array(64).fill(null);
    const boxFn = function boxed(i) { step0(i); ring[i & 63] = [i]; };
    const c2 = nsExcess(boxFn);
    const c2Flip = c2 !== null && c2.excess >= NS_MAX_EXCESS;
    const c2Bpo = c2 === null ? null : Math.max(0, c2.excess) / NS_K;

    // C3 GrowingBitset: successor reallocates `_bits` +1 word per call (the A3
    // Space control shape), stepped by the T1 step shape at U = 2^24. The
    // arrayBuffers lane MUST read growth > 0 (+4 B per successor call).
    class GrowingBitset extends StratifiedBitset {
        successor(x) {
            const old = this._bits;
            const next = new Uint32Array(old.length + 1);
            next.set(old);
            this._bits = next;
            return super.successor(x);
        }
    }
    const kG = keyRing(U1, 0x2545f491);
    const setG = populate(new GrowingBitset(U1), kG);
    const stepG = makeStep(setG, kG);
    const r3 = measureOps(stepG, { ops: 512, warmup: 0, stabilize: 'deep' });
    const ab3 = r3.summary.arrayBuffers;
    const rep3 = checkNoGc(r3.summary, { maxArrayBuffersGrowth: 0 });
    const c3Flip = rep3.verdict !== 'pass' && ab3.growthBytes > 0;

    // C4 retained array: the T2 churn, but every instance is also pushed into
    // an array that outlives the drain. tracker.size() MUST stay > 0.
    const box4 = { collected: 0, leaks: [], warns: [] };
    const tracker4 = makeTracker('lite-loglogn-control', box4);
    const held = [];
    churn(tracker4, held);
    const live4 = await drain(tracker4);
    const c4Flip = live4 > 0;
    held.length = 0;

    console.log('T3 controls' +
        ' retain.alloc=' + (c1Bpc === null ? 'null' : Math.round(c1Bpc)) + ' B/op ' +
        (c1Flip ? 'flipped' : 'PASSED') +
        ' box.transient=' + fmt(c2Bpo, 3) + ' B/op ' + (c2Flip ? 'flipped' : 'PASSED') +
        ' growing.abGrowth=' + ab3.growthBytes + ' ' + (c3Flip ? 'flipped' : 'PASSED') +
        ' retained.size=' + live4 + ' ' + (c4Flip ? 'flipped' : 'PASSED') +
        ' | ' + (c1Flip && c2Flip && c3Flip && c4Flip ? 'ok' : 'FAIL'));
    if (!c1Flip) fails.push('control retain PASSED its check (alloc ' + c1Bpc + ' B/op): T0 alloc lane is blind');
    if (!c2Flip) fails.push('control box PASSED its check: T0 transient lane is blind');
    if (!c3Flip) fails.push('control growing PASSED its check (abGrowth ' + ab3.growthBytes + '): T1 is blind');
    if (!c4Flip) fails.push('control retained PASSED its check (size ' + live4 + '): T2 is blind');

    // ---- verdict + GATE line ----------------------------------------------
    const ok = fails.length === 0;
    console.log(
        'GATE leak=size ' + live2 + '/0 findings=' + findings2.length +
        ' warnings=' + box2.warns.length +
        ' | gc major=' + s0.gc.major + ' minor=' + s0.gc.minor +
        ' maxMs=' + s0.gc.maxMs.toFixed(2) +
        ' | alloc=' + (bpc === null ? 'null' : Math.round(bpc)) + ' B/op' +
        ' transient=' + fmt(tBpo, 3) + ' B/op' +
        ' abGrowth=' + ab1.growthBytes +
        ' | ' + (ok ? 'ok' : 'FAIL') + ' (sink=' + SINK[0] + ')');
    if (!ok) {
        for (const f of fails) console.error('  ' + f);
        process.exitCode = 1;
    }
}

main().catch((e) => {
    process.stderr.write('torture: FAIL -- ' + (e && e.stack ? e.stack : String(e)) + '\n');
    process.exitCode = 1;
});
