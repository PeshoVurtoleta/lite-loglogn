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
 *       retained array (size > 0), a gc kick (forced globalThis.gc() inside
 *       T0's gc window: the T0 gc verdict not-ok, gcMajor > 0). Any control
 *       passing is exit 1.
 *   X0-X4 (XFastTrie) and Y0 / Y1 / Y1b / Y1c / Y2 / Y3 / Y4 (YFastTrie;
 *       Y1b = the borrow cycle) follow, each documented at its section.
 *   V1 / V2a / V2b / V3 / V4 / V5 (vEBTree, PLAN-vebtree G2) follow the
 *       Y-tiers, each documented at its section: V1 2,000,000 mixed ops at
 *       U = 2^16 (alloc / transient / gc, every op kind), V2 the U = 2^28
 *       depth-2 ring (V2a in-process alloc, V2b arrayBuffers growth in a
 *       Worker with a kill timer), V3 the U = 2^25 + 3 delete-heavy max
 *       refresh in a Worker with a kill timer (alloc / transient, refreshes
 *       == deletes exactly, `_t` byte-equal to a fresh tree after; a hang is
 *       a timeout FAIL), V4 keys >= 2^31 in the tree at
 *       U = 2^31 + 1 (transient only, every arg / return < 2^30), V5
 *       4,096-cycle retention. A build without the vEBTree export fails closed
 *       (exit 1, veb=null on the GATE line).
 *   R (RoaringSet, PLAN-roaringset-G5 tasks 5-7) follows V5: one Worker per
 *       (layout, family) job (test/_roaring-torture-worker.mjs, kill timer
 *       KILL_MS), 18 jobs: families ops 28 + gap 3 + conv 6 + clear 1 +
 *       setops 5 + range 1 = 44 gated lanes per layout, direct and paged = 88,
 *       + the 5 pair.* lanes of the 'mixed' pair job (A direct, B / C paged)
 *       = 93 (each: retained round 0 settled, transient excess < 1,024 B per
 *       65,536 ops, gc major 0, arrayBuffers growth 0 settled, size / kinds
 *       restored, paged === the job; setops / pair / range work-checked, range
 *       edges-checked; range.addRange excess per layout on rangeExcess=d/p),
 *       the hi job per layout (U = 2^32, CV7 shape), ONE paged page-churn
 *       lane churn.page OUTSIDE the 93 (C-10 A10: gc maxMajor 0 only, its gc
 *       maxMs REPORTED; poolOk true) and 4,096-cycle retention per layout
 *       (3 tracked per cycle, rangeBad 0; CR-retain flips in each). Paged
 *       knobs { maxPages, pageBits } (R_PAGED, JSON-checked against the
 *       worker's PAGED_KNOBS): ops / conv / clear { 4, 1 } at U 2^20, gap
 *       { 4, 8 } at 2^31, hi / setops / pair / range { 4, 8 } at 2^32, churn
 *       { 254, 8 }, retention { 2, 8 } at (2^32, 4, 2). ni.* lanes and the
 *       TurboFan check stay REPORTED (C-11): tf=UNCHECKED. A build without the
 *       RoaringSet export fails closed (exit 1, roaring=null on the GATE line).
 *   Must-fail controls: 5 (T3) + 6 (X4) + 9 (Y4) + 9 (CV1-CV9) + 19 (R:
 *       CR-dupSrc, CR-box, CR-has, CR-conv, CR-abConv, CR-gcKick, CR-retain,
 *       CR-pageMap, CR-setops, CR-addRange, CR-rangeArr, hi.successor /
 *       predecessor / min / max per layout) = 48.
 * KNOWN GAP (narrowed): a real >4 ms pause is host timing and cannot be forced, so the
 * gc kick (a forced major) pins maxMajor only. The maxPauseMs THRESHOLD AND WIRING are
 * pinned deterministically by the separate `T3w` line: the exact gcVerdict() gcLane
 * uses is fed a synthetic summary (gc.maxMs 4 -> pass; 4.01 -> not ok, with exactly
 * one violation, metric gc.maxMs). It is not one of T3's five controls.
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
    // Parent-only ceiling on the V3 Worker's posted empty-fn baseline (baseMin,
    // B per NS_K-op window): a baseline that boxes (or a readout that drifts up)
    // would calibrate a real box away, so V3 FAILS above it. Never posted to or
    // read by the Worker. CV9 must exceed it raw (boxExcess + baseMin). By
    // formula from a measured warm max: NS_BASE_MAX = NS_MAX_EXCESS x
    // 2^ceil(log2(2 x warmMax / NS_MAX_EXCESS)) = 1024 x 2^ceil(log2(3632 /
    // 1024)) = 4,096, warmMax 1,816 (warm Worker baselines 1,784-1,816 over 40
    // fresh V3 Workers; veb-nsbase-probe-2026-11-03.log, PRELIMINARY host). It
    // is >= 2 x warmMax and 256x under a 16 B/op box in the baseline (1,050,368).
    const NS_BASE_MAX = 4 * NS_MAX_EXCESS;
    // The one baseline predicate: V3's ceiling and CV9's raw window both use it.
    function nsBaseOk(b) { return Number.isInteger(b) && b >= 0 && b <= NS_BASE_MAX; }

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
    // The empty-fn baseline, named so laneParity can pin its text (the V3 Worker
    // calls the same function twice at runV3's start, keeping the second; this
    // process takes it once, cold).
    function takeNsBase() { return nsLane(emptyFn); }
    const nsBase = takeNsBase();

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

    // The T0 / X0 gc-budget lane: gc() + settle, then `ops` calls of fn inside
    // one GcProfiler window (heap sampled every 8,192 ops), settle, verdict
    // checkNoGc { maxMajor: 0, maxPauseMs: 4 }. errs = the violation strings,
    // [] = pass. The real lanes and their must-fail gc controls (T3 gcKick, X4
    // xGcKick) run through this ONE code path, so a control that flips proves
    // this window and verdict can fail. Cold wrapper.
    function gcVerdict(summary) {
        return checkNoGc(summary, { maxMajor: 0, maxPauseMs: 4 });
    }

    async function gcLane(tag, fn, ops) {
        globalThis.gc();
        await settle(50);
        const g = new GcProfiler().start();
        for (let i = 0; i < ops; i++) {
            fn(i);
            if ((i & 8191) === 0) {
                g.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
            }
        }
        await settle(50);
        const s = g.summary();
        const rep = gcVerdict(s);
        g.stop();
        const errs = [];
        let majorHit = false;
        if (!rep.ok) {
            for (const v of rep.violations) {
                if (v.metric === 'gc.major') majorHit = true;
                errs.push(tag + ' gc ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
            }
            if (rep.violations.length === 0) errs.push(tag + ' gc verdict=' + rep.verdict);
        }
        return { s, ok: rep.ok === true && errs.length === 0, errs, majorHit };
    }

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
    const g0 = await gcLane('T0', step0, HOT);
    const s0 = g0.s;
    for (const e of g0.errs) fails.push(e);
    if (!g0.ok && g0.errs.length === 0) fails.push('T0 gc not ok (no violation listed)');
    const t0Ok = allocOk && tOk && g0.ok;
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

    // C5 gc kick: the T0 step plus a forced globalThis.gc() (a full, major GC)
    // every 65,536 ops, through gcLane -- T0c's window and verdict. The verdict
    // MUST be not-ok with gcMajor > 0. Coverage floor: the kick count, bumped in
    // the gc() branch, must equal GC_KICK_OPS / 65,536 = 4.
    const GC_KICK_OPS = 1 << 18;
    const GC_KICKS = 4;
    const kick0 = new Int32Array(1);
    const gcKickFn = function gcKick(i) {
        step0(i);
        if ((i & 65535) === 0) {
            globalThis.gc();
            kick0[0]++;
        }
    };
    const c5 = await gcLane('T0 control gcKick', gcKickFn, GC_KICK_OPS);
    const c5Flip = !c5.ok && c5.majorHit && c5.s.gc.major > 0 && kick0[0] === GC_KICKS;

    console.log('T3 controls' +
        ' retain.alloc=' + (c1Bpc === null ? 'null' : Math.round(c1Bpc)) + ' B/op ' +
        (c1Flip ? 'flipped' : 'PASSED') +
        ' box.transient=' + fmt(c2Bpo, 3) + ' B/op ' + (c2Flip ? 'flipped' : 'PASSED') +
        ' growing.abGrowth=' + ab3.growthBytes + ' ' + (c3Flip ? 'flipped' : 'PASSED') +
        ' retained.size=' + live4 + ' ' + (c4Flip ? 'flipped' : 'PASSED') +
        ' gcKick.gcMajor=' + c5.s.gc.major + ' maxPauseMs=' + c5.s.gc.maxMs.toFixed(2) +
        ' kicks=' + kick0[0] + '/' + GC_KICKS + ' violations=' + c5.errs.length + ' ' +
        (c5Flip ? 'flipped' : 'PASSED') +
        ' | ' + (c1Flip && c2Flip && c3Flip && c4Flip && c5Flip ? 'ok' : 'FAIL'));
    if (!c1Flip) fails.push('control retain PASSED its check (alloc ' + c1Bpc + ' B/op): T0 alloc lane is blind');
    if (!c2Flip) fails.push('control box PASSED its check: T0 transient lane is blind');
    if (!c3Flip) fails.push('control growing PASSED its check (abGrowth ' + ab3.growthBytes + '): T1 is blind');
    if (!c4Flip) fails.push('control retained PASSED its check (size ' + live4 + '): T2 is blind');
    if (!c5Flip) {
        fails.push('control gcKick PASSED its check (gcMajor ' + c5.s.gc.major + ', kicks ' +
            kick0[0] + '/' + GC_KICKS + ', violations ' + c5.errs.length + '): T0 gc lane is blind');
    }

    // T3w pause-threshold wiring (deterministic; NOT a T3 control, so "T3's
    // five" stays five). gcVerdict is the exact call gcLane makes. Synthetic
    // summaries are copies of T0's real one with only gc.major / gc.maxMs set:
    // maxMs 4 must pass (limit is inclusive), 4.01 must fail with ONE violation
    // on gc.maxMs, and a major-only summary (maxMs 0) must fail on gc.major
    // alone -- the pause rule flips on the pause lane only.
    const synth = (major, maxMs) => ({ ...s0, gc: { ...s0.gc, major, maxMs } });
    const w4 = gcVerdict(synth(0, 4));
    const w401 = gcVerdict(synth(0, 4.01));
    const wMaj = gcVerdict(synth(1, 0));
    const laneSrc = String(gcLane);
    const wired = laneSrc.split('gcVerdict(s)').length === 2 && !laneSrc.includes('checkNoGc');
    const wOk = wired && w4.ok === true && w4.violations.length === 0 &&
        w401.ok === false && w401.violations.length === 1 && w401.violations[0].metric === 'gc.maxMs' &&
        w401.violations[0].limit === 4 && w401.violations[0].actual === 4.01 &&
        wMaj.ok === false && wMaj.violations.length === 1 && wMaj.violations[0].metric === 'gc.major';
    console.log('T3w pause wiring gcLane->gcVerdict ' + (wired ? 'wired' : 'UNWIRED') + ' maxMs=4 ' + (w4.ok ? 'pass' : 'FAIL') +
        ' maxMs=4.01 ' + (w401.ok ? 'PASSED' : 'flipped') + ' (' + w401.violations.length + ' violation)' +
        ' major=1 ' + (wMaj.ok ? 'PASSED' : 'flipped') + ' (' + wMaj.violations.length + ' violation)' +
        ' | ' + (wOk ? 'ok' : 'FAIL'));
    if (!wOk) fails.push('T3w pause wiring: gcLane must call gcVerdict(s) once and not checkNoGc; maxMs 4 / 4.01 / major verdicts wrong (T0 pause threshold unpinned)');

    // ==== X-tiers: XFastTrie (PLAN-xfasttrie G4 / G5, tasks G0b + G7) ========
    // Run after T0-T3 so the StratifiedBitset tiers keep their own feedback; the
    // X-tiers drive XFastTrie through their OWN step closures (makeStepX,
    // makeReseedStep) -- makeStep's call sites never see an XFastTrie.
    //   X0  2,000,000 mixed ops (add / delete / has / successor x2 / predecessor /
    //       min / max) at U = 2^20 AND at U = 2^30, capacity XC: retained 0 B/op
    //       (null = FAIL), transient excess < NS_MAX_EXCESS per NS_K-op window,
    //       gc major 0, maxPauseMs <= 4. Coverage floor: every op kind ran, and
    //       has / delete / successor / predecessor each saw hits AND misses.
    //   X1  U = 2^32 (keys up to 2^32 - 1 in the ring and in the set), stabilize
    //       'deep': arrayBuffers growth 0, settled.
    //   X2  reseed lane, the G0b stream below: retained 0 B/op and abGrowth 0 over
    //       (a) natural collide() cycles, the abGrowth window holding EXACTLY
    //       10,000 kicks, and (b) a `_fill`-stubbed instance (3 forced failed
    //       tries per stall), the abGrowth window holding EXACTLY 100 rebuilds
    //       (reseed tries, `_q[3]`). Every `_q` delta must equal the census model
    //       x calls; a reseedOps delta of 0 is a FAIL (vacuous lane).
    //       (c) a transient lane on both steps: XNS_K cycles per new-space window
    //       (~10 ops each, so a window holds >= NS_K ops), excess over an
    //       empty-fn baseline of the SAME window size < NS_MAX_EXCESS bytes;
    //       null (too few unscavenged windows) is a FAIL; every window must run
    //       exactly XNS_K cycles and advance reseedOps by exactly XNS_K.
    //   X3  4,096 construct / fill (the collide stream: one reseed each) / clear /
    //       drop cycles: tracker.size() 0 after the drain and one gc later.
    //   X4  controls that MUST flip: retaining loop (X0 alloc > 0), transient box
    //       (X0 window excess >= limit), ReallocReseed (X2 abGrowth > 0),
    //       DropReseed (M-reseedAlloc: a Uint32Array per reseed, dropped -- X2's
    //       transient excess >= limit, on a measured window, not on null),
    //       retained array (X3 size > 0), gc kick (forced globalThis.gc() inside
    //       X0's gc window: the X0 gc verdict not-ok, gcMajor > 0).
    //
    // G0b CENSUS (2026-10-22, B1 engine): collide(2^16, 16, 9) = keys
    // 0,2,16,17,19,24,47,61,73 (level-16 prefixes share h1 AND h2 under the
    // default seeds). One cycle = add the 9 keys in order, then clear(). The 9th
    // add stalls the level-16 kick chain (B = 4: 8 x bitlen(floor(0.9 x 32)) =
    // 8 x 5 = 40 evictions) and reseeds once; the first try places every group.
    // Per cycle: kicks +40, reseedOps +1, tries +1; clear() adds +0 / +0 / +0.
    // Identical over 10,000 consecutive cycles (clear() restores the default
    // seeds, so every cycle replays the same stall; 2.07 us / cycle, Node 26,
    // PRELIMINARY host). With `_fill` stubbed to fail the first n tries of each
    // stall: kicks +40, reseedOps +1, tries +(n + 1) (n = 1, 2, 5, 31 over 200
    // cycles each; n = 3 over 10,000 cycles).
    const { XFastTrie } = await import('../LogLogN.js');
    const { collide } = await import('./helpers/xftStream.mjs');

    const XU0 = 1 << 20;        // X0 universe, w = 20
    const XU1 = 1 << 30;        // X0 universe, w = 30
    const XU2 = 4294967296;     // X1 universe, w = 32
    // Capacity: an add only ever uses ring positions = 0 mod 8, so at most
    // KEYS / 8 = 8,192 distinct keys are present at once -- no full-add throw.
    const XC = KEYS >>> 3;
    const XRU = 1 << 16;        // X2 / X3 reseed geometry (U, C)
    const XRC = 16;
    const X_KICKS = 40;         // census: per collide cycle
    const X_RESEEDS = 1;
    const X_TRIES = 1;
    const X_FORCED = 3;         // forced failed tries per stall (stub lane)
    const X_KICK_CYCLES = 250;  // 250 x 40 = 10,000 forced kicks
    const X_REBUILD_CYCLES = 25; // 25 x (3 + 1) = 100 forced rebuilds
    const X_ITERS = 10000;      // X2 measureAllocs iterations per batch

    // Op-kind / hit-miss tally slots of makeStepX (one Int32Array per closure).
    const XN_SH = 8;            // successor hit
    const XN_SM = 9;            // successor miss
    const XN_PH = 10;           // predecessor hit
    const XN_PM = 11;           // predecessor miss
    const XN_HH = 12;           // has hit
    const XN_HM = 13;           // has miss
    const XN_DH = 14;           // delete hit
    const XN_DM = 15;           // delete miss

    // The X0 / X1 mixed step: makeStep's op mix on an XFastTrie (has also
    // probes a present key every other group), plus a tally
    // in a caller-owned Int32Array (the coverage floor). Built cold; const
    // bindings only, integer sink in a typed-array slot.
    function makeStepX(set, k, cnt) {
        return function stepX(i) {
            const x = k[i & KMASK];
            const op = i & 7;
            let r = 0;
            switch (op) {
                case 0: set.add(x); break;
                case 1:
                    r = set.delete(k[(i - 1 + HALF) & KMASK]) ? 1 : 0;
                    cnt[r === 1 ? XN_DH : XN_DM]++;
                    break;
                case 2:
                    // every other group probes the key op 0 of this group added
                    // (a hit), else a ring key (mostly a miss): both are floored
                    r = set.has(k[(i - ((i & 8) >>> 2)) & KMASK]) ? 1 : 0;
                    cnt[r === 1 ? XN_HH : XN_HM]++;
                    break;
                case 3:
                case 4:
                    r = set.successor(x);
                    cnt[r === undefined ? XN_SM : XN_SH]++;
                    break;
                case 5:
                    r = set.predecessor(x);
                    cnt[r === undefined ? XN_PM : XN_PH]++;
                    break;
                case 6: r = set.min(); break;
                default: r = set.max();
            }
            cnt[op]++;
            SINK[0] = (SINK[0] + (r === undefined ? 7 : r)) | 0;
        };
    }

    // populate()'s keys, through an XFastTrie-only call site. Cold.
    function populateX(set, k) {
        for (let j = 0; j < HALF; j += 8) set.add(k[j]);
        return set;
    }

    // Coverage floor: the first slot of cnt[0..15] that is 0, or -1. Cold.
    function zeroSlot(cnt) {
        for (let j = 0; j < 16; j++) if (!(cnt[j] > 0)) return j;
        return -1;
    }

    // X0 for one universe. Returns the step (the X4 controls wrap the 2^20 one).
    async function xTier0(tag, u, seed) {
        const k = keyRing(u, seed);
        const cnt = new Int32Array(16);
        const set = populateX(new XFastTrie(u, XC), k);
        const step = makeStepX(set, k, cnt);
        const al = measureAllocs(step, { iterations: 250000, batches: 8 });
        const b = al.bytesPerCall;
        const aOk = b !== null && al.settled === true && Math.round(b) === 0;
        if (!aOk) {
            fails.push(tag + ' alloc bytesPerCall=' + b + ' settled=' + al.settled +
                ' (null or unsettled is a FAIL, not 0)');
        }
        const ns = nsExcess(step);
        const nOk = ns !== null && ns.excess < NS_MAX_EXCESS;
        const t = ns === null ? null : Math.max(0, ns.excess) / NS_K;
        if (!nOk) {
            fails.push(tag + ' transient ' + (ns === null ? 'not measured (null)' :
                fmt(t, 3) + ' B/op, excess ' + ns.excess + ' B per ' + NS_K +
                ' ops >= ' + NS_MAX_EXCESS));
        }
        const gl = await gcLane(tag, step, HOT);
        const s = gl.s;
        for (const e of gl.errs) fails.push(e);
        if (!gl.ok && gl.errs.length === 0) fails.push(tag + ' gc not ok (no violation listed)');
        const z = zeroSlot(cnt);
        if (z >= 0) fails.push(tag + ' coverage: tally slot ' + z + ' is 0 (an op kind or hit/miss never ran)');
        const ok = aOk && nOk && gl.ok && z < 0;
        console.log(tag + ' ops=' + HOT + ' U=' + u + ' C=' + XC +
            ' alloc=' + (b === null ? 'null' : Math.round(b)) + ' B/op' +
            ' allocRaw=' + fmt(b, 4) +
            ' transient=' + fmt(t, 3) + ' B/op' +
            ' (limit ' + NS_MAX_EXCESS + ' B / ' + NS_K + ' ops)' +
            ' nsExcess=' + (ns === null ? 'null' : ns.excess) +
            ' nsWin0=' + (ns === null ? 'null' : ns.first) +
            ' gcMajor=' + s.gc.major + ' gcMinor=' + s.gc.minor +
            ' maxPauseMs=' + s.gc.maxMs.toFixed(2) +
            ' succ=' + cnt[XN_SH] + '/' + cnt[XN_SM] +
            ' pred=' + cnt[XN_PH] + '/' + cnt[XN_PM] +
            ' has=' + cnt[XN_HH] + '/' + cnt[XN_HM] +
            ' del=' + cnt[XN_DH] + '/' + cnt[XN_DM] + ' (hit/miss)' +
            ' size=' + set.size +
            ' | ' + (ok ? 'ok' : 'FAIL'));
        return { step, b, t, major: s.gc.major, minor: s.gc.minor, maxMs: s.gc.maxMs };
    }

    // ---- X0: 2,000,000 mixed ops at U = 2^20 and U = 2^30 --------------------
    const x0a = await xTier0('X0a', XU0, 0x9e3779b9);
    const x0b = await xTier0('X0b', XU1, 0x85ebca6b);

    // ---- X1: arrayBuffers growth at U = 2^32 ---------------------------------
    // 64 ring slots carry 2^32 - 1 - (j >>> 3), at ring index j * 1024 + (j & 7)
    // (index mod 8 = j & 7, eight per residue). Only residues 0 (add, and the
    // delete half a ring later), 2 (has), 3 / 4 (successor) and 5 (predecessor)
    // read their slot; residues 1, 6 and 7 are written but never read (delete
    // reads a residue-0 key, min / max take none). populate adds 2^32 - 1
    // (slot 0), so max() must read 2^32 - 1, and slot 3 asks successor(2^32 - 1)
    // -- always a miss.
    const kx1 = keyRing(XU2, 0x1b873593);
    for (let j = 0; j < 64; j++) kx1[j * 1024 + (j & 7)] = 4294967295 - (j >>> 3);
    const cnt1 = new Int32Array(16);
    const setX1 = populateX(new XFastTrie(XU2, XC), kx1);
    const top1 = setX1.max();
    const stepX1 = makeStepX(setX1, kx1, cnt1);
    const rx1 = measureOps(stepX1, { ops: 200000, warmup: 50000, stabilize: 'deep' });
    const abx1 = rx1.summary.arrayBuffers;
    const repx1 = checkNoGc(rx1.summary, { maxArrayBuffersGrowth: 0 });
    const z1 = zeroSlot(cnt1);
    const x1Ok = repx1.verdict === 'pass' && abx1.settled === true && abx1.growthBytes === 0 &&
        top1 === 4294967295 && z1 < 0;
    if (!x1Ok) {
        fails.push('X1 abGrowth=' + abx1.growthBytes + ' settled=' + abx1.settled +
            ' verdict=' + repx1.verdict + ' max=' + top1 + ' (want 4294967295)' +
            ' zeroSlot=' + z1);
    }
    console.log('X1 ops=200000 U=' + XU2 + ' C=' + XC + ' byteLength=' + setX1.byteLength +
        ' max=' + top1 + ' abGrowth=' + abx1.growthBytes + ' settled=' + abx1.settled +
        ' succ=' + cnt1[XN_SH] + '/' + cnt1[XN_SM] + ' pred=' + cnt1[XN_PH] + '/' + cnt1[XN_PM] +
        ' | ' + (x1Ok ? 'ok' : 'FAIL'));

    // ---- X2: reseed lane (the G0b stream) ------------------------------------
    const xcol = collide(XRU, XRC, 9);
    if (xcol === null || xcol.length !== 9) throw new Error('X2: collide(2^16, 16, 9) found no stall group');
    const xKeys = Uint32Array.from(xcol);
    const NXK = xKeys.length;

    // One reseed cycle: arm the stub's failure budget (a dummy slot on an
    // unstubbed instance), add the collide keys (the last one stalls), clear().
    function makeReseedStep(set, calls, budget, nFail) {
        return function reseedStep(i) {
            budget[0] = nFail;
            for (let j = 0; j < NXK; j++) set.add(xKeys[j]);
            SINK[0] = (SINK[0] + set.size + (i & 1)) | 0;
            set.clear();
            calls[0]++;
        };
    }
    // `_q[j]`, or -1 once poisoned (`_q === null`). Cold.
    function qx(set, j) {
        return set._q === null ? -1 : set._q[j];
    }

    // Retained lane over X_ITERS x 5 calls, then the exact abGrowth window of
    // `cycles` calls. Every `_q` delta must equal the model x calls.
    function xReseedLane(tag, set, step, calls, kicks, tries, cycles) {
        const errs = [];
        const c0 = calls[0];
        const a1 = qx(set, 1), a2 = qx(set, 2), a3 = qx(set, 3);
        const al = measureAllocs(step, { iterations: X_ITERS, batches: 4 });
        const n = calls[0] - c0;
        const b = al.bytesPerCall;
        const d1 = qx(set, 1) - a1, d2 = qx(set, 2) - a2, d3 = qx(set, 3) - a3;
        if (!(b !== null && al.settled === true && Math.round(b) === 0)) {
            errs.push(tag + ' alloc bytesPerCall=' + b + ' settled=' + al.settled);
        }
        if (n !== X_ITERS * 5 || d1 !== kicks * n || d2 !== X_RESEEDS * n || d3 !== tries * n) {
            errs.push(tag + ' alloc-lane counters calls=' + n + ' kicks+' + d1 + ' reseedOps+' + d2 +
                ' tries+' + d3 + ' (model per call ' + kicks + '/' + X_RESEEDS + '/' + tries + ')');
        }
        const c1 = calls[0];
        const e1 = qx(set, 1), e2 = qx(set, 2), e3 = qx(set, 3);
        const r = measureOps(step, { ops: cycles, warmup: 0, stabilize: 'deep' });
        const m = calls[0] - c1;
        const f1 = qx(set, 1) - e1, f2 = qx(set, 2) - e2, f3 = qx(set, 3) - e3;
        const ab = r.summary.arrayBuffers;
        const rep = checkNoGc(r.summary, { maxArrayBuffersGrowth: 0 });
        if (!(rep.verdict === 'pass' && ab.settled === true && ab.growthBytes === 0)) {
            errs.push(tag + ' abGrowth=' + ab.growthBytes + ' settled=' + ab.settled + ' verdict=' + rep.verdict);
        }
        if (!(f2 >= 1)) errs.push(tag + ' reseedOps delta ' + f2 + ' < 1: the reseed lane is vacuous');
        if (m !== cycles || f1 !== kicks * m || f2 !== X_RESEEDS * m || f3 !== tries * m) {
            errs.push(tag + ' window counters calls=' + m + ' kicks+' + f1 + ' reseedOps+' + f2 +
                ' tries+' + f3 + ' (want ' + kicks * cycles + '/' + X_RESEEDS * cycles + '/' +
                tries * cycles + ')');
        }
        for (const e of errs) fails.push(e);
        return { b, n, d1, d2, d3, ab: ab.growthBytes, m, f1, f2, f3, ok: errs.length === 0 };
    }

    const xr = new XFastTrie(XRU, XRC);
    const xrCalls = new Int32Array(1);
    const xrDummy = new Int32Array(1);
    const stepR = makeReseedStep(xr, xrCalls, xrDummy, 0);
    const x2a = xReseedLane('X2a', xr, stepR, xrCalls, X_KICKS, X_TRIES, X_KICK_CYCLES);

    // Forced rebuilds: an instance-own `_fill` that fails the first X_FORCED
    // tries of every stall, then delegates (each failed try = one rebuild).
    const xf = new XFastTrie(XRU, XRC);
    const xfFails = new Int32Array(1);
    const realFill = XFastTrie.prototype._fill;
    xf._fill = function forcedFill(L) {
        if (xfFails[0] > 0) {
            xfFails[0]--;
            return false;
        }
        return realFill.call(this, L);
    };
    const xfCalls = new Int32Array(1);
    const stepF = makeReseedStep(xf, xfCalls, xfFails, X_FORCED);
    const x2b = xReseedLane('X2b', xf, stepF, xfCalls, X_KICKS, X_FORCED + 1, X_REBUILD_CYCLES);

    // X2c transient lane. nsLane's shape (gc before each window, scavenged
    // window discarded, min over windows 1..NS_W-1, window 0 printed only) at
    // XNS_K reseed cycles per window: a dropped per-reseed typed array (measured
    // 200.0 B / cycle, the CX5 census) then fills ~3.3 MB of new space per
    // window (measured 3,277,104 B; torture 2026-10-22, Node v26.8.2,
    // deterministic), flipping on excess instead of scavenging
    // every window into a null. The limit stays NS_MAX_EXCESS bytes
    // per window (a window holds 2.5 x NS_K ops, so per op it is stricter).
    // `set` null = baseline (no counter checks). bad = windows whose cycle
    // count or reseedOps delta missed the model.
    const XNS_K = 16384;
    function nsLaneX(fn, set, calls) {
        for (let i = 0; i < XNS_K * 2; i++) fn(i);
        let min = -1;
        let first = -1;
        let valid = 0;
        let bad = 0;
        for (let w = 0; w < NS_W; w++) {
            const c0 = calls === null ? 0 : calls[0];
            const r0 = set === null ? 0 : qx(set, 2);
            globalThis.gc();
            const a = newSpaceUsed();
            for (let i = 0; i < XNS_K; i++) fn(i);
            const z = newSpaceUsed();
            if (set !== null && (calls[0] - c0 !== XNS_K || qx(set, 2) - r0 !== X_RESEEDS * XNS_K)) bad++;
            if (a < 0 || z < 0 || z < a) continue;
            const d = z - a;
            if (w === 0) { first = d; continue; }
            valid++;
            if (min < 0 || d < min) min = d;
        }
        return { min: valid >= (NS_W >>> 1) ? min : null, first, valid, bad };
    }
    const nsBaseX = nsLaneX(emptyFn, null, null);
    // Excess bytes per XNS_K-cycle window over the baseline; excess null = not
    // measured.
    function nsExcessX(fn, set, calls) {
        const r = nsLaneX(fn, set, calls);
        const ex = r.min === null || nsBaseX.min === null ? null : r.min - nsBaseX.min;
        return { excess: ex, first: r.first - nsBaseX.min, valid: r.valid, bad: r.bad };
    }
    function x2Transient(tag, fn, set, calls) {
        const r = nsExcessX(fn, set, calls);
        const ok = r.excess !== null && r.excess < NS_MAX_EXCESS && r.bad === 0;
        if (!ok) {
            fails.push(tag + ' transient ' + (r.excess === null ? 'not measured (null)' :
                'excess ' + r.excess + ' B per ' + XNS_K + ' cycles (limit ' + NS_MAX_EXCESS + ')') +
                ' valid=' + r.valid + ' badWindows=' + r.bad);
        }
        r.ok = ok;
        return r;
    }
    const x2c = x2Transient('X2c natural', stepR, xr, xrCalls);
    const x2d = x2Transient('X2c forced', stepF, xf, xfCalls);
    console.log('X2 U=' + XRU + ' C=' + XRC + ' keys=' + NXK +
        ' natural: alloc=' + (x2a.b === null ? 'null' : Math.round(x2a.b)) + ' B/op over ' + x2a.n +
        ' cycles (kicks+' + x2a.d1 + ' reseedOps+' + x2a.d2 + ' tries+' + x2a.d3 + ')' +
        ' window ' + x2a.m + ' cycles kicks+' + x2a.f1 + ' reseedOps+' + x2a.f2 + ' tries+' + x2a.f3 +
        ' abGrowth=' + x2a.ab +
        ' | forced: alloc=' + (x2b.b === null ? 'null' : Math.round(x2b.b)) + ' B/op over ' + x2b.n +
        ' cycles (kicks+' + x2b.d1 + ' reseedOps+' + x2b.d2 + ' rebuilds+' + x2b.d3 + ')' +
        ' window ' + x2b.m + ' cycles kicks+' + x2b.f1 + ' reseedOps+' + x2b.f2 + ' rebuilds+' + x2b.f3 +
        ' abGrowth=' + x2b.ab +
        ' | transient (limit ' + NS_MAX_EXCESS + ' B / ' + XNS_K + ' cycles):' +
        ' natural nsExcess=' + x2c.excess + ' nsWin0=' + x2c.first + ' valid=' + x2c.valid +
        ' badWindows=' + x2c.bad +
        ' forced nsExcess=' + x2d.excess + ' nsWin0=' + x2d.first + ' valid=' + x2d.valid +
        ' badWindows=' + x2d.bad +
        ' (each window ' + XNS_K + ' cycles, reseedOps+' + X_RESEEDS * XNS_K + ')' +
        ' | ' + (x2a.ok && x2b.ok && x2c.ok && x2d.ok ? 'ok' : 'FAIL'));

    // ---- X3: retention churn (construct / fill / clear / drop) ---------------
    // Same contract as T2 (noop cleanup, string tag, own frame). Every cycle's
    // fill is the collide stream, so each instance reseeds once (counted).
    function churnX(tracker, held, reseeds) {
        let tracked = 0;
        for (let i = 0; i < CYCLES; i++) {
            const s = new XFastTrie(XRU, XRC);
            for (let j = 0; j < NXK; j++) s.add(xKeys[j]);
            s.has(xKeys[0]);
            s.successor(xKeys[0]);
            s.predecessor(xKeys[NXK - 1]);
            s.min();
            s.max();
            s.delete(xKeys[4]);
            reseeds[0] += s._q[2];
            s.clear();
            s.add(i & (XRU - 1));
            tracker.track(s, noop, 'xfasttrie', { audit: true });
            tracked++;
            if (held !== null) held.push(s);
        }
        return tracked;
    }
    const boxX3 = { collected: 0, leaks: [], warns: [] };
    const trackerX3 = makeTracker('lite-loglogn-xft', boxX3);
    const reseedX3 = new Int32Array(1);
    const trackedX3 = churnX(trackerX3, null, reseedX3);
    const liveX3 = await drain(trackerX3);
    const findingsX3 = trackerX3.audit();
    globalThis.gc();
    await settle(25);
    const afterX3 = trackerX3.size();
    const x3Ok = trackedX3 === CYCLES && liveX3 === 0 && afterX3 === 0 &&
        boxX3.collected === CYCLES && findingsX3.length === 0 && boxX3.leaks.length === 0 &&
        reseedX3[0] === CYCLES * X_RESEEDS;
    if (!x3Ok) {
        fails.push('X3 tracked=' + trackedX3 + ' size=' + liveX3 + ' after=' + afterX3 +
            ' collected=' + boxX3.collected + ' findings=' + findingsX3.length +
            ' leaks=' + boxX3.leaks.length + ' reseeds=' + reseedX3[0] + ' (want ' + CYCLES + ')');
        for (const f of findingsX3) fails.push('X3 finding ' + f.kind + ':' + f.reason);
        for (const l of boxX3.leaks) fails.push('X3 leak ' + l);
    }
    console.log('X3 cycles=' + CYCLES + ' U=' + XRU + ' C=' + XRC + ' size=' + liveX3 + '/0' +
        ' after=' + afterX3 + ' collected=' + boxX3.collected + '/' + trackedX3 +
        ' reseeds=' + reseedX3[0] +
        ' findings=' + findingsX3.length + ' warnings=' + boxX3.warns.length +
        ' leaks=' + boxX3.leaks.length +
        ' | ' + (x3Ok ? 'ok' : 'FAIL'));

    // ---- X4: controls (each MUST flip its X-tier's check) --------------------
    // CX1 retaining loop on the X0 (2^20) step: measureAllocs MUST read > 0.
    const xHold = [];
    const xStepA = x0a.step;
    const xRetainFn = function xRetain(i) { xStepA(i); xHold.push([i]); };
    const cx1 = measureAllocs(xRetainFn, { iterations: 20000, batches: 4 });
    const cx1Bpc = cx1.bytesPerCall;
    const cx1Flip = cx1Bpc !== null && Math.round(cx1Bpc) > 0;
    xHold.length = 0;

    // CX2 transient box on the X0 (2^20) step: one array per op into a 64-slot
    // ring (as C2). The new-space lane MUST read over its threshold.
    const xRing = new Array(64).fill(null);
    const xBoxFn = function xBoxed(i) { xStepA(i); xRing[i & 63] = [i]; };
    const cx2 = nsExcess(xBoxFn);
    const cx2Flip = cx2 !== null && cx2.excess >= NS_MAX_EXCESS;
    const cx2Bpo = cx2 === null ? null : Math.max(0, cx2.excess) / NS_K;

    // CX3 ReallocReseed (M-reseedAlloc): every reseed snapshots the leaf thread
    // into a NEW Uint32Array appended to a log the instance keeps (the C3
    // GrowingBitset shape), driven by X2's step and window. abGrowth MUST be
    // > 0, and the window must actually have reseeded.
    class ReallocReseed extends XFastTrie {
        _rebuild(L, f) {
            const old = this._snap;
            const next = new Uint32Array(old.length + this._c + 1);
            next.set(old);
            let o = old.length;
            for (let i = this._next[0]; i !== 0; i = this._next[i]) next[o++] = this._key[i];
            this._snap = next;
            super._rebuild(L, f);
        }
    }
    const xg = new ReallocReseed(XRU, XRC);
    xg._snap = new Uint32Array(XRC + 1);
    const xgCalls = new Int32Array(1);
    const stepXG = makeReseedStep(xg, xgCalls, xrDummy, 0);
    const g2 = qx(xg, 2);
    const rx3 = measureOps(stepXG, { ops: X_KICK_CYCLES, warmup: 0, stabilize: 'deep' });
    const gRes = qx(xg, 2) - g2;
    const abx3 = rx3.summary.arrayBuffers;
    const repx3 = checkNoGc(rx3.summary, { maxArrayBuffersGrowth: 0 });
    const cx3Flip = repx3.verdict !== 'pass' && abx3.growthBytes > 0 && gRes >= 1;

    // CX5 DropReseed (M-reseedAlloc, the E6 control): ReallocReseed with
    // `this._snap = next` removed -- every reseed allocates a Uint32Array
    // snapshot of the leaf thread and drops it. abGrowth and the retained lane
    // cannot see it; X2's transient lane MUST read excess >= limit on a MEASURED
    // window (null is not a flip) whose cycles and reseeds matched the model.
    class DropReseed extends XFastTrie {
        _rebuild(L, f) {
            const old = this._snap;
            const next = new Uint32Array(old.length + this._c + 1);
            next.set(old);
            let o = old.length;
            for (let i = this._next[0]; i !== 0; i = this._next[i]) next[o++] = this._key[i];
            super._rebuild(L, f);
        }
    }
    const xd = new DropReseed(XRU, XRC);
    xd._snap = new Uint32Array(XRC + 1);
    const xdCalls = new Int32Array(1);
    const stepXD = makeReseedStep(xd, xdCalls, xrDummy, 0);
    const cx5 = nsExcessX(stepXD, xd, xdCalls);
    const cx5Flip = cx5.excess !== null && cx5.excess >= NS_MAX_EXCESS && cx5.bad === 0;

    // CX4 retained array: the X3 churn, every instance also held past the
    // drain. tracker.size() MUST stay > 0.
    const boxX4 = { collected: 0, leaks: [], warns: [] };
    const trackerX4 = makeTracker('lite-loglogn-xft-control', boxX4);
    const xHeld = [];
    churnX(trackerX4, xHeld, new Int32Array(1));
    const liveX4 = await drain(trackerX4);
    const cx4Flip = liveX4 > 0;
    xHeld.length = 0;

    // CX6 gc kick: the X0 (2^20) step plus a forced globalThis.gc() every
    // 65,536 ops, through gcLane -- X0's window and verdict (as C5). The verdict
    // MUST be not-ok with gcMajor > 0; the kick count must equal GC_KICKS.
    const kickX = new Int32Array(1);
    const xGcKickFn = function xGcKick(i) {
        xStepA(i);
        if ((i & 65535) === 0) {
            globalThis.gc();
            kickX[0]++;
        }
    };
    const cx6 = await gcLane('X0 control xGcKick', xGcKickFn, GC_KICK_OPS);
    const cx6Flip = !cx6.ok && cx6.majorHit && cx6.s.gc.major > 0 && kickX[0] === GC_KICKS;

    console.log('X4 controls' +
        ' retain.alloc=' + (cx1Bpc === null ? 'null' : Math.round(cx1Bpc)) + ' B/op ' +
        (cx1Flip ? 'flipped' : 'PASSED') +
        ' box.transient=' + fmt(cx2Bpo, 3) + ' B/op ' + (cx2Flip ? 'flipped' : 'PASSED') +
        ' reallocReseed.abGrowth=' + abx3.growthBytes + ' (reseedOps+' + gRes + ') ' +
        (cx3Flip ? 'flipped' : 'PASSED') +
        ' dropReseed.nsExcess=' + cx5.excess + ' B / ' + XNS_K + ' cycles (' +
        (cx5.excess === null ? 'null' : fmt(cx5.excess / XNS_K, 1)) + ' B/cycle, valid=' + cx5.valid +
        ' badWindows=' + cx5.bad + ') ' + (cx5Flip ? 'flipped' : 'PASSED') +
        ' retained.size=' + liveX4 + ' ' + (cx4Flip ? 'flipped' : 'PASSED') +
        ' xGcKick.gcMajor=' + cx6.s.gc.major + ' maxPauseMs=' + cx6.s.gc.maxMs.toFixed(2) +
        ' kicks=' + kickX[0] + '/' + GC_KICKS + ' violations=' + cx6.errs.length + ' ' +
        (cx6Flip ? 'flipped' : 'PASSED') +
        ' | ' + (cx1Flip && cx2Flip && cx3Flip && cx4Flip && cx5Flip && cx6Flip ? 'ok' : 'FAIL'));
    if (!cx1Flip) fails.push('control xRetain PASSED its check (alloc ' + cx1Bpc + ' B/op): X0 alloc lane is blind');
    if (!cx2Flip) fails.push('control xBox PASSED its check: X0 transient lane is blind');
    if (!cx3Flip) {
        fails.push('control ReallocReseed PASSED its check (abGrowth ' + abx3.growthBytes +
            ', reseedOps+' + gRes + '): X2 is blind');
    }
    if (!cx4Flip) fails.push('control xRetained PASSED its check (size ' + liveX4 + '): X3 is blind');
    if (!cx5Flip) {
        fails.push('control DropReseed PASSED its check (nsExcess ' + cx5.excess + ', valid ' +
            cx5.valid + ', badWindows ' + cx5.bad + '): X2 transient lane is blind');
    }
    if (!cx6Flip) {
        fails.push('control xGcKick PASSED its check (gcMajor ' + cx6.s.gc.major + ', kicks ' +
            kickX[0] + '/' + GC_KICKS + ', violations ' + cx6.errs.length + '): X0 gc lane is blind');
    }

    // ==== Y-tiers: YFastTrie (PLAN-yfasttrie G2, task G2-4) ==================
    // Run after X0-X4 so the T / X tiers keep their own feedback; the Y-tiers
    // drive YFastTrie through their OWN step closures (makeStepY,
    // makeStormStep, makeBorrowStep, makeStraddleStep) -- makeStep's and
    // makeStepX's call sites never see a YFastTrie. Every Y lane uses the
    // default seed (C-16), so the census is exact; hot paths are gated at
    // 0 B/op on keys < 2^30 (C-14).
    //   Y0  2,000,000 mixed ops (makeStepX's op mix) at U = 2^20 AND at
    //       U = 2^30, capacity XC, keys < 2^30 from Uint32Array rings, integer
    //       sinks in Int32Array slots: retained 0 B/op (null = FAIL),
    //       transient excess < NS_MAX_EXCESS per NS_K-op window, gc major 0,
    //       maxPauseMs <= 4. Coverage floor: every op kind ran, with hits AND
    //       misses, and splits >= 1 AND merges >= 1 inside EVERY measured
    //       window: each of the 8 measureAllocs batches (warmup hoisted out;
    //       the op stream is fixed-seed, so every batch restructures; cold
    //       replay 2026-11-01, splits / merges per batch: 2^20 = 14 / 12 then
    //       12 / 12 x 7, 2^30 = 3 / 3 x 8), each of the NS_W new-space windows,
    //       the gc window -- the cold split / merge path runs inside the
    //       0 B/op windows, not beside them.
    //   Y1  split / merge storm, the census stream below: retained 0 B/op
    //       measured over 4 batches of Y_ITERS cycles (the 5th Y_ITERS is the
    //       warmup) while the exact `_n` check spans all 5,000 calls, then a
    //       stabilize 'deep' window of EXACTLY 10,000 splits (250 cycles x 40):
    //       arrayBuffers growth 0, settled; every `_n` delta must equal the
    //       census x cycles (a splits delta of 0 is a FAIL).
    //   Y1b borrow cycle (part 2, below Y1c): the same yStormLane gate on a
    //       stream that borrows once per cycle; a borrows delta of 0 is a FAIL.
    //   Y2  U = 2^32. (a) X1's ring shape (keys up to 2^32 - 1 in the ring and
    //       in the set), stabilize 'deep': arrayBuffers growth 0, settled,
    //       max() = 2^32 - 1, splits >= 1 AND merges >= 1 in the steady window
    //       (warmup hoisted out). (b) the straddle step, TRANSIENT lane only
    //       (C-14): every arg and return < 2^30 while the searched head bucket
    //       holds 32 keys >= 2^31; no split / merge / borrow in any window (so
    //       the cold-path inline caveat cannot apply).
    // Teeth (the formal controls are Y4, each one mutation): CY1 retain flips
    // Y0 alloc; CY2 box flips Y0 transient (and the Y2b lane, same nsLaneY
    // path); CY3 ReallocSplit flips Y1 abGrowth; CY6 gcKick flips Y0 gc; CY7
    // flatKeys flips Y1's split floor (deltas != census); CY8 AllocBorrow
    // flips Y1b alloc; CY9 noRefill flips Y1b's borrows floor.
    //
    // Y CENSUS (2026-10-25, LogLogN.js 7ecfe459, default seed; .handoff/evidence/
    // yft-census-g2-2026-10-25.log): U = 2^16 (w = 16, K = 32, h = 8), C = 664,
    // keys j x 97 for j < 664. One Y1 storm cycle on ONE instance = add the 664
    // keys ascending (the top bucket fills to K and splits at index w: 40 splits,
    // ending at 40 x 16 + 24 keys), delete them ascending (each non-head bucket
    // underflows at s = h into its emptied left neighbour: 40 merges), clear().
    // Per cycle: splits +40, merges +40, borrows +0, identical over 10,000
    // consecutive cycles (clear() restores the constructed state, C-6; a fresh
    // instance gives the same 40 / 40 / 0). Y3 fill cycle (G2-B3) on a FRESH
    // instance = add the 664 ascending, has / successor / predecessor / min / max,
    // delete keys[0..331] ascending, clear(), add(i & 65535): splits +40, merges
    // +20, borrows +0, identical over 10,000 cycles (clear / add move no counter).
    const { YFastTrie } = await import('../LogLogN.js');

    const YU0 = 1 << 20;        // Y0 universe, w = 20 (K = 40, h = 10)
    const YU1 = 1 << 30;        // Y0 universe, w = 30 (K = 60, h = 15)
    const YU2 = 4294967296;     // Y2 universe, w = 32 (K = 64, h = 16)
    const YSU = 1 << 16;        // Y1 storm universe, w = 16 (K = 32, h = 8)
    const YSM = 664;            // storm keys per cycle = the storm capacity
    const YS_STRIDE = 97;       // storm key j = j x 97 (max 64,311 < 2^16)
    const Y_SPLITS = 40;        // census: per storm cycle
    const Y_MERGES = 40;
    const Y_BORROWS = 0;
    const Y_CEN = Int32Array.of(Y_SPLITS, Y_MERGES, Y_BORROWS);  // yStormLane census
    const Y_SPLIT_WINDOW = 10000;                       // Y1 abGrowth window, splits
    const Y_STORM_CYCLES = Y_SPLIT_WINDOW / Y_SPLITS;   // 250 cycles
    const Y_ITERS = 1000;       // Y1 measureAllocs iterations per batch

    // `_n[j]` of a YFastTrie: 0 splits, 1 merges, 2 borrows. Cold.
    function yn(set, j) {
        return set._n[j];
    }

    // The Y0 / Y2a mixed step: makeStepX's op mix and tally on a YFastTrie, in
    // its OWN closure (X keeps its feedback). Built cold; const bindings only,
    // integer sink in a typed-array slot.
    function makeStepY(set, k, cnt) {
        return function stepY(i) {
            const x = k[i & KMASK];
            const op = i & 7;
            let r = 0;
            switch (op) {
                case 0: set.add(x); break;
                case 1:
                    r = set.delete(k[(i - 1 + HALF) & KMASK]) ? 1 : 0;
                    cnt[r === 1 ? XN_DH : XN_DM]++;
                    break;
                case 2:
                    r = set.has(k[(i - ((i & 8) >>> 2)) & KMASK]) ? 1 : 0;
                    cnt[r === 1 ? XN_HH : XN_HM]++;
                    break;
                case 3:
                case 4:
                    r = set.successor(x);
                    cnt[r === undefined ? XN_SM : XN_SH]++;
                    break;
                case 5:
                    r = set.predecessor(x);
                    cnt[r === undefined ? XN_PM : XN_PH]++;
                    break;
                case 6: r = set.min(); break;
                default: r = set.max();
            }
            cnt[op]++;
            SINK[0] = (SINK[0] + (r === undefined ? 7 : r)) | 0;
        };
    }

    // populate()'s keys, through a YFastTrie-only call site. Cold.
    function populateY(set, k) {
        for (let j = 0; j < HALF; j += 8) set.add(k[j]);
        return set;
    }

    // nsLane's shape (NS_K ops per window, NS_W windows, gc before each, a
    // scavenged window discarded, min over windows 1..NS_W-1, window 0 printed
    // only), plus a per-window restructure floor read OUTSIDE the measured span:
    // moved true -> every window (window 0 included) needs splits >= 1 AND
    // merges >= 1; moved false -> every window needs splits = merges = borrows
    // = 0. bad = windows that missed it. null = not measured.
    function nsLaneY(fn, set, moved) {
        for (let i = 0; i < NS_K * 2; i++) fn(i);
        let min = -1;
        let first = -1;
        let valid = 0;
        let bad = 0;
        let sp = 0;
        let mg = 0;
        for (let w = 0; w < NS_W; w++) {
            const s0 = yn(set, 0), m0 = yn(set, 1), b0 = yn(set, 2);
            globalThis.gc();
            const a = newSpaceUsed();
            for (let i = 0; i < NS_K; i++) fn(i);
            const z = newSpaceUsed();
            const ds = yn(set, 0) - s0, dm = yn(set, 1) - m0, db = yn(set, 2) - b0;
            sp += ds;
            mg += dm;
            if (moved ? !(ds >= 1 && dm >= 1) : (ds !== 0 || dm !== 0 || db !== 0)) bad++;
            if (a < 0 || z < 0 || z < a) continue;
            const d = z - a;
            if (w === 0) { first = d; continue; }
            valid++;
            if (min < 0 || d < min) min = d;
        }
        return valid >= (NS_W >>> 1) ? { min, first, valid, bad, sp, mg } : null;
    }
    // Excess bytes per NS_K-op window over the empty baseline (nsBase: the same
    // window size), or null.
    function nsExcessY(fn, set, moved) {
        const r = nsLaneY(fn, set, moved);
        if (r === null || nsBase === null) return null;
        return { excess: r.min - nsBase.min, first: r.first - nsBase.min, valid: r.valid,
            bad: r.bad, sp: r.sp, mg: r.mg };
    }

    // Y0 for one universe. Returns the step (G2-B3's Y4 controls wrap the 2^20 one).
    async function yTier0(tag, u, seed) {
        const k = keyRing(u, seed);
        const cnt = new Int32Array(16);
        const set = populateY(new YFastTrie(u, XC), k);
        const step = makeStepY(set, k, cnt);
        for (let i = 0; i < 250000; i++) step(i);
        // Per-batch floor: measureAllocs restarts i at 0 in every batch (warmup
        // 0), so the wrapper snapshots `_n` at each batch's first call into
        // slots 2b / 2b + 1 (b < 8; slot 18 counts the snapshots), and slots
        // 16 / 17 take the end. Integer writes into a typed array only.
        const bat = new Int32Array(19);
        const allocStep = function yAllocStep(i) {
            if (i === 0) {
                const c = bat[18];
                if (c < 8) {
                    bat[2 * c] = yn(set, 0);
                    bat[2 * c + 1] = yn(set, 1);
                }
                bat[18] = c + 1;
            }
            step(i);
        };
        const a0 = yn(set, 0), a1 = yn(set, 1);
        const al = measureAllocs(allocStep, { iterations: 250000, batches: 8, warmup: 0 });
        const as = yn(set, 0) - a0, am = yn(set, 1) - a1;
        bat[16] = yn(set, 0);
        bat[17] = yn(set, 1);
        let bs = -1;
        let bm = -1;
        for (let j = 0; j < 8; j++) {
            const ds = bat[2 * j + 2] - bat[2 * j], dm = bat[2 * j + 3] - bat[2 * j + 1];
            if (bs < 0 || ds < bs) bs = ds;
            if (bm < 0 || dm < bm) bm = dm;
        }
        const b = al.bytesPerCall;
        const aOk = b !== null && al.settled === true && Math.round(b) === 0 && as >= 1 && am >= 1 &&
            bat[18] === 8 && bat[0] === a0 && bat[1] === a1 && bs >= 1 && bm >= 1;
        if (!aOk) {
            fails.push(tag + ' alloc bytesPerCall=' + b + ' settled=' + al.settled +
                ' splits+' + as + ' merges+' + am + ' batches=' + bat[18] +
                ' per-batch min splits+' + bs + ' merges+' + bm +
                ' (null or unsettled is a FAIL, not 0; splits and merges must be >= 1 in' +
                ' EVERY one of the 8 batches)');
        }
        const ns = nsExcessY(step, set, true);
        const nOk = ns !== null && ns.excess < NS_MAX_EXCESS && ns.bad === 0;
        const t = ns === null ? null : Math.max(0, ns.excess) / NS_K;
        if (!nOk) {
            fails.push(tag + ' transient ' + (ns === null ? 'not measured (null)' :
                fmt(t, 3) + ' B/op, excess ' + ns.excess + ' B per ' + NS_K +
                ' ops (limit ' + NS_MAX_EXCESS + '), windows without a split AND a merge: ' + ns.bad));
        }
        const g0 = yn(set, 0), g1 = yn(set, 1);
        const gl = await gcLane(tag, step, HOT);
        const gs = yn(set, 0) - g0, gm = yn(set, 1) - g1;
        const s = gl.s;
        for (const e of gl.errs) fails.push(e);
        if (!gl.ok && gl.errs.length === 0) fails.push(tag + ' gc not ok (no violation listed)');
        if (!(gs >= 1 && gm >= 1)) fails.push(tag + ' gc window splits+' + gs + ' merges+' + gm + ' (want >= 1 each)');
        const z = zeroSlot(cnt);
        if (z >= 0) fails.push(tag + ' coverage: tally slot ' + z + ' is 0 (an op kind or hit/miss never ran)');
        const ok = aOk && nOk && gl.ok && gs >= 1 && gm >= 1 && z < 0;
        console.log(tag + ' ops=' + HOT + ' U=' + u + ' C=' + XC +
            ' alloc=' + (b === null ? 'null' : Math.round(b)) + ' B/op' +
            ' allocRaw=' + fmt(b, 4) +
            ' transient=' + fmt(t, 3) + ' B/op' +
            ' (limit ' + NS_MAX_EXCESS + ' B / ' + NS_K + ' ops)' +
            ' nsExcess=' + (ns === null ? 'null' : ns.excess) +
            ' nsWin0=' + (ns === null ? 'null' : ns.first) +
            ' gcMajor=' + s.gc.major + ' gcMinor=' + s.gc.minor +
            ' maxPauseMs=' + s.gc.maxMs.toFixed(2) +
            ' succ=' + cnt[XN_SH] + '/' + cnt[XN_SM] +
            ' pred=' + cnt[XN_PH] + '/' + cnt[XN_PM] +
            ' has=' + cnt[XN_HH] + '/' + cnt[XN_HM] +
            ' del=' + cnt[XN_DH] + '/' + cnt[XN_DM] + ' (hit/miss)' +
            ' splits/merges alloc=+' + as + '/+' + am + ' (per-batch min +' + bs + '/+' + bm + ')' +
            ' ns=+' + (ns === null ? 'null' : ns.sp + '/+' + ns.mg + ' badWindows=' + ns.bad) +
            ' gc=+' + gs + '/+' + gm +
            ' size=' + set.size +
            ' | ' + (ok ? 'ok' : 'FAIL'));
        return { step, set, b, t, major: s.gc.major, minor: s.gc.minor, maxMs: s.gc.maxMs };
    }

    // ---- Y0: 2,000,000 mixed ops at U = 2^20 and U = 2^30 --------------------
    const y0a = await yTier0('Y0a', YU0, 0x9e3779b9);
    const y0b = await yTier0('Y0b', YU1, 0x85ebca6b);

    // ---- Y1: split / merge storm (the census stream) -------------------------
    const ySKeys = new Uint32Array(YSM);
    for (let j = 0; j < YSM; j++) ySKeys[j] = j * YS_STRIDE;

    // One storm cycle: the 664 keys added ascending (40 splits), deleted
    // ascending (40 merges), clear().
    function makeStormStep(set, calls) {
        return function stormStep(i) {
            for (let j = 0; j < YSM; j++) set.add(ySKeys[j]);
            SINK[0] = (SINK[0] + set.size + (i & 1)) | 0;
            for (let j = 0; j < YSM; j++) set.delete(ySKeys[j]);
            set.clear();
            calls[0]++;
        };
    }

    // Retained lane over Y_ITERS x 5 calls, then the exact abGrowth window of
    // `cycles` calls. Every `_n` delta must equal the census `cen` (Int32Array
    // splits / merges / borrows per call) x calls; splits >= 1 in the window,
    // and when cen[2] >= 1 borrows >= 1 in BOTH windows (floor = false when
    // that borrows floor missed; Y1b / CY9).
    function yStormLane(tag, set, step, calls, cycles, cen) {
        const errs = [];
        const c0 = calls[0];
        const a0 = yn(set, 0), a1 = yn(set, 1), a2 = yn(set, 2);
        const al = measureAllocs(step, { iterations: Y_ITERS, batches: 4 });
        const n = calls[0] - c0;
        const b = al.bytesPerCall;
        const d0 = yn(set, 0) - a0, d1 = yn(set, 1) - a1, d2 = yn(set, 2) - a2;
        if (!(b !== null && al.settled === true && Math.round(b) === 0)) {
            errs.push(tag + ' alloc bytesPerCall=' + b + ' settled=' + al.settled);
        }
        if (n !== Y_ITERS * 5 || d0 !== cen[0] * n || d1 !== cen[1] * n || d2 !== cen[2] * n) {
            errs.push(tag + ' alloc-lane counters calls=' + n + ' splits+' + d0 + ' merges+' + d1 +
                ' borrows+' + d2 + ' (model per call ' + cen[0] + '/' + cen[1] + '/' + cen[2] + ')');
        }
        const c1 = calls[0];
        const e0 = yn(set, 0), e1 = yn(set, 1), e2 = yn(set, 2);
        const r = measureOps(step, { ops: cycles, warmup: 0, stabilize: 'deep' });
        const m = calls[0] - c1;
        const f0 = yn(set, 0) - e0, f1 = yn(set, 1) - e1, f2 = yn(set, 2) - e2;
        const ab = r.summary.arrayBuffers;
        const rep = checkNoGc(r.summary, { maxArrayBuffersGrowth: 0 });
        if (!(rep.verdict === 'pass' && ab.settled === true && ab.growthBytes === 0)) {
            errs.push(tag + ' abGrowth=' + ab.growthBytes + ' settled=' + ab.settled + ' verdict=' + rep.verdict);
        }
        if (!(f0 >= 1)) errs.push(tag + ' splits delta ' + f0 + ' < 1: the storm lane is vacuous');
        const floor = cen[2] < 1 || (d2 >= 1 && f2 >= 1);
        if (!floor) {
            errs.push(tag + ' borrows delta alloc+' + d2 + ' window+' + f2 +
                ' (want >= 1 each): the borrow lane is vacuous');
        }
        if (m !== cycles || f0 !== cen[0] * cycles || f0 !== cen[0] * m || f1 !== cen[1] * m ||
            f2 !== cen[2] * m) {
            errs.push(tag + ' window counters calls=' + m + ' splits+' + f0 + ' merges+' + f1 +
                ' borrows+' + f2 + ' (want ' + cen[0] * cycles + '/' + cen[1] * cycles + '/' +
                cen[2] * cycles + ')');
        }
        for (const e of errs) fails.push(e);
        return { b, n, d0, d1, d2, ab: ab.growthBytes, settled: ab.settled, m, f0, f1, f2, floor,
            ok: errs.length === 0 };
    }

    const yst = new YFastTrie(YSU, YSM);
    const ystCalls = new Int32Array(1);
    const stepYS = makeStormStep(yst, ystCalls);
    const y1 = yStormLane('Y1', yst, stepYS, ystCalls, Y_STORM_CYCLES, Y_CEN);
    console.log('Y1 U=' + YSU + ' C=' + YSM + ' keys=' + YSM + ' (j x ' + YS_STRIDE + ')' +
        ' storm: alloc=' + (y1.b === null ? 'null' : Math.round(y1.b)) + ' B/op over ' + y1.n +
        ' cycles (splits+' + y1.d0 + ' merges+' + y1.d1 + ' borrows+' + y1.d2 + ')' +
        ' window ' + y1.m + ' cycles splits+' + y1.f0 + ' merges+' + y1.f1 + ' borrows+' + y1.f2 +
        ' (census ' + Y_SPLITS + '/' + Y_MERGES + '/' + Y_BORROWS + ' per cycle)' +
        ' abGrowth=' + y1.ab + ' settled=' + y1.settled +
        ' | ' + (y1.ok ? 'ok' : 'FAIL'));

    // ---- Y2: U = 2^32 -- deep arrayBuffers growth + the straddle step --------
    // (a) X1's ring: the same seed and the same 64 top-key slots (keys up to
    // 2^32 - 1 in the ring and in the set), through makeStepY.
    const ky2 = keyRing(YU2, 0x1b873593);
    for (let j = 0; j < 64; j++) ky2[j * 1024 + (j & 7)] = 4294967295 - (j >>> 3);
    const cntY2 = new Int32Array(16);
    const setY2 = populateY(new YFastTrie(YU2, XC), ky2);
    const topY2 = setY2.max();
    const stepY2 = makeStepY(setY2, ky2, cntY2);
    for (let i = 0; i < 50000; i++) stepY2(i);
    const y2s0 = yn(setY2, 0), y2m0 = yn(setY2, 1);
    const ry2 = measureOps(stepY2, { ops: 200000, warmup: 0, stabilize: 'deep' });
    const y2s = yn(setY2, 0) - y2s0, y2m = yn(setY2, 1) - y2m0;
    const aby2 = ry2.summary.arrayBuffers;
    const repy2 = checkNoGc(ry2.summary, { maxArrayBuffersGrowth: 0 });
    const zy2 = zeroSlot(cntY2);
    const y2aOk = repy2.verdict === 'pass' && aby2.settled === true && aby2.growthBytes === 0 &&
        topY2 === 4294967295 && zy2 < 0 && y2s >= 1 && y2m >= 1;
    if (!y2aOk) {
        fails.push('Y2a abGrowth=' + aby2.growthBytes + ' settled=' + aby2.settled +
            ' verdict=' + repy2.verdict + ' max=' + topY2 + ' (want 4294967295)' +
            ' zeroSlot=' + zy2 + ' splits+' + y2s + ' merges+' + y2m + ' (want >= 1 each)');
    }

    // (b) Straddle (C-14), built cold at U = 2^32: 96 keys 2^31 + j x 65536
    // ascending (the head fills to K = 64 and splits once at index w = 32: the
    // head keeps the 32 lowest, the one other rep is 2^31 + 32 x 65536), then the
    // 21 even keys 0..40 into the head -- one bucket of 53 keys, 32 of them >=
    // 2^31. The step's keys are odd, in [1, 31], from a Uint32Array ring: op 0
    // adds one, op 1 deletes it (the head stays at 53 / 54 < K and never merges),
    // has alternates a miss (x) and a hit (x + 1), successor / predecessor /
    // min return keys <= 32. Every search is a binary search over the 53-key
    // head whose first probe (index 26) reads a key >= 2^31; max() (a return
    // >= 2^31) is never called. The floor: no split / merge / borrow in any window.
    const setS = new YFastTrie(YU2, XC);
    for (let j = 0; j < 96; j++) setS.add(2147483648 + j * 65536);
    for (let j = 0; j <= 40; j += 2) setS.add(j);
    const dS = setS.dump();
    const sOk0 = dS.reps.length === 2 && dS.reps[0] === 0 && dS.reps[1] === 2147483648 + 32 * 65536 &&
        dS.sizes[0] === 53 && dS.keys[20] === 40 && dS.keys[21] === 2147483648;
    const kS = keyRing(16, 0x27d4eb2f);
    for (let i = 0; i < KEYS; i++) kS[i] = 2 * kS[i] + 1;
    function makeStraddleStep(set, k) {
        return function straddleStep(i) {
            const x = k[i & KMASK];
            let r = 0;
            switch (i & 7) {
                case 0: set.add(x); break;
                case 1: r = set.delete(k[(i - 1) & KMASK]) ? 1 : 0; break;
                case 2: r = set.has(x + ((i >>> 3) & 1)) ? 1 : 0; break;
                case 3:
                case 4: r = set.successor(x); break;
                case 5: r = set.predecessor(x); break;
                case 6: r = set.min(); break;
                default: r = set.predecessor(x + 1);
            }
            SINK[0] = (SINK[0] + (r === undefined ? 7 : r)) | 0;
        };
    }
    const stepS = makeStraddleStep(setS, kS);
    const sQ = setS.successor(1) === 2 && setS.predecessor(1) === 0 &&
        setS.successor(40) === 2147483648 && setS.has(2) && !setS.has(1);
    const nsS = nsExcessY(stepS, setS, false);
    const y2bOk = sOk0 && sQ && nsS !== null && nsS.excess < NS_MAX_EXCESS && nsS.bad === 0 &&
        setS.size === 96 + 21;
    const tS = nsS === null ? null : Math.max(0, nsS.excess) / NS_K;
    if (!y2bOk) {
        fails.push('Y2b straddle layout=' + sOk0 + ' answers=' + sQ + ' transient ' +
            (nsS === null ? 'not measured (null)' : fmt(tS, 3) + ' B/op, excess ' + nsS.excess +
                ' B per ' + NS_K + ' ops (limit ' + NS_MAX_EXCESS + '), windows that restructured: ' + nsS.bad) +
            ' size=' + setS.size + ' (want ' + (96 + 21) + ')');
    }
    console.log('Y2 U=' + YU2 + ' C=' + XC +
        ' deep: ops=200000 byteLength=' + setY2.byteLength + ' max=' + topY2 +
        ' abGrowth=' + aby2.growthBytes + ' settled=' + aby2.settled +
        ' succ=' + cntY2[XN_SH] + '/' + cntY2[XN_SM] + ' pred=' + cntY2[XN_PH] + '/' + cntY2[XN_PM] +
        ' splits+' + y2s + ' merges+' + y2m +
        ' | straddle: head=' + dS.sizes[0] + ' keys (' + (dS.sizes[0] - 21) + ' >= 2^31) layout=' +
        (sOk0 ? 'ok' : 'BAD') + ' answers=' + (sQ ? 'ok' : 'BAD') +
        ' transient=' + fmt(tS, 3) + ' B/op (limit ' + NS_MAX_EXCESS + ' B / ' + NS_K + ' ops)' +
        ' nsExcess=' + (nsS === null ? 'null' : nsS.excess) +
        ' nsWin0=' + (nsS === null ? 'null' : nsS.first) +
        ' valid=' + (nsS === null ? 'null' : nsS.valid) +
        ' restructured=' + (nsS === null ? 'null' : nsS.bad) + ' windows' +
        ' size=' + setS.size +
        ' | ' + (y2aOk && y2bOk ? 'ok' : 'FAIL'));

    // ==== Y-tiers, part 2 (PLAN-yfasttrie G2, task G2-5) =====================
    //   Y1c storm transient lane (nsLaneX's shape): YNS_K storm cycles per
    //       new-space window (1,328 ops + 40 splits + 40 merges each), excess
    //       over an empty-fn baseline of the SAME window size < NS_MAX_EXCESS
    //       bytes; null (too few unscavenged windows) is a FAIL; every window must
    //       run exactly YNS_K cycles and advance splits / merges by exactly the
    //       census x YNS_K. Y0's windows hold 1 - 4 splits each, so a dropped
    //       per-split allocation stays under the limit there (B2 finding F-B2-1:
    //       832 / 232 B per window); this lane holds 2,560 splits per window.
    //   Y3  4,096 construct / fill (the Y3 census cycle) / clear / drop cycles:
    //       tracker.size() 0 after the drain and one gc later, collected 4,096,
    //       findings 0, leaks 0; the summed `_n` of every instance must equal the
    //       census literals x 4,096 (splits 163,840, merges 81,920, borrows 0).
    //   Y1b borrow cycle (the Y1B CENSUS below): Y1's gate on a stream that
    //       splits, borrows and merges once per cycle, plus a transient lane.
    //   Y4  9 controls that MUST flip, one mutation each: CY1 retaining loop
    //       (Y0 alloc > 0), CY2 transient box (Y0 window excess >= limit), CY3
    //       ReallocSplit (Y1 abGrowth > 0), CY4 DropSplit (Y1c excess >= limit
    //       on a measured window, abGrowth still 0), CY5 retained array (Y3
    //       size > 0), CY6 gc kick (Y0 gc verdict not-ok, gcMajor > 0), CY7
    //       flatKeys (Y1's census / split floor FAILS), CY8 AllocBorrow (Y1b
    //       alloc > 0, census intact), CY9 noRefill (Y1b's borrows floor
    //       FAILS). y0a.step is wrapped ONLY here, inside must-fail controls;
    //       it is never re-measured as a passing lane.
    const Y3_SPLITS = 40;       // census: per Y3 fill cycle (B2 census log)
    const Y3_MERGES = 20;
    const Y3_BORROWS = 0;
    const YNS_K = 64;           // Y1c: storm cycles per new-space window

    // ---- Y1c: storm transient lane --------------------------------------------
    // kc cycles per window; `set` null = baseline (no counter checks). bad =
    // windows whose cycle count or splits / merges / borrows delta missed the
    // census `cen` (Int32Array, per cycle) x kc.
    function nsLaneS(fn, set, calls, cen, kc) {
        for (let i = 0; i < kc * 2; i++) fn(i);
        let lo = -1;
        let w0 = -1;
        let good = 0;
        let bad = 0;
        for (let w = 0; w < NS_W; w++) {
            const c0 = calls === null ? 0 : calls[0];
            const s0 = set === null ? 0 : yn(set, 0);
            const m0 = set === null ? 0 : yn(set, 1);
            const b0 = set === null ? 0 : yn(set, 2);
            globalThis.gc();
            const a = newSpaceUsed();
            for (let i = 0; i < kc; i++) fn(i);
            const z = newSpaceUsed();
            if (set !== null && (calls[0] - c0 !== kc || yn(set, 0) - s0 !== cen[0] * kc ||
                yn(set, 1) - m0 !== cen[1] * kc || yn(set, 2) - b0 !== cen[2] * kc)) bad++;
            if (a < 0 || z < 0 || z < a) continue;
            const d = z - a;
            if (w === 0) { w0 = d; continue; }
            good++;
            if (lo < 0 || d < lo) lo = d;
        }
        return { min: good >= (NS_W >>> 1) ? lo : null, first: w0, valid: good, bad };
    }
    const nsBaseS = nsLaneS(emptyFn, null, null, null, YNS_K);
    // Excess bytes per kc-cycle window over `base` (an nsLaneS(emptyFn) run of
    // the SAME kc); excess null = not measured.
    function nsExcessS(fn, set, calls, cen, kc, base) {
        const r = nsLaneS(fn, set, calls, cen, kc);
        const ex = r.min === null || base.min === null ? null : r.min - base.min;
        return { excess: ex, first: r.first - base.min, valid: r.valid, bad: r.bad };
    }
    const y1c = nsExcessS(stepYS, yst, ystCalls, Y_CEN, YNS_K, nsBaseS);
    const y1cOk = y1c.excess !== null && y1c.excess < NS_MAX_EXCESS && y1c.bad === 0;
    if (!y1cOk) {
        fails.push('Y1c storm transient ' + (y1c.excess === null ? 'not measured (null)' :
            'excess ' + y1c.excess + ' B per ' + YNS_K + ' cycles (limit ' + NS_MAX_EXCESS + ')') +
            ' valid=' + y1c.valid + ' badWindows=' + y1c.bad);
    }
    console.log('Y1c storm transient (limit ' + NS_MAX_EXCESS + ' B / ' + YNS_K + ' cycles):' +
        ' nsExcess=' + y1c.excess + ' nsWin0=' + y1c.first + ' valid=' + y1c.valid +
        ' badWindows=' + y1c.bad +
        ' (each window ' + YNS_K + ' cycles, splits+' + Y_SPLITS * YNS_K + ' merges+' + Y_MERGES * YNS_K + ')' +
        ' | ' + (y1cOk ? 'ok' : 'FAIL'));

    // ---- Y1b: borrow cycle (borrows allocation-gated) -----------------------
    // Y1B CENSUS (hand count; a cold untimed replay, 2026-11-01, LogLogN.js
    // 1f47a2bd, matched it over 5 consecutive cycles): U = 2^16 (w = 16,
    // K = 32, h = 8), C = 43 (the peak size), b_j = j x 1000 (j <= 32),
    // r_i = i x 1000 + 500 (i < 10), all < 2^30, from Uint32Array rings. One
    // cycle on ONE instance:
    //   add b_0..b_31 (head at K), b_32 -> split at index w (rep b_16 = 16000;
    //   head 16 keys, right 17); add r_0..r_9 (all < 16000: head 26);
    //   delete b_32..b_24 (right 17 -> 8), then b_23: underflow at s = h with
    //   s_p + s - 1 = 26 + 7 = 33 > K -> BORROW (c = (26 + 8) >>> 1 = 17, new
    //   rep = head[17] = r_8 = 8500; head 17, new bucket 9 + 7 = 16; rep
    //   16000 dropped); delete the 33 left ascending: the head's 17 (the head
    //   never merges), 8 of the new bucket (16 -> 8), then at s = h:
    //   0 + 7 <= K -> merge into the head; the merged 7 go plainly; clear().
    // Per cycle: splits +1, merges +1, borrows +1, 86 ops (43 adds, 43
    // deletes) + clear(); identical every cycle (clear() restores the
    // constructed state, C-6). Gate = Y1's yStormLane: retained 0 B/op over 4
    // batches of Y_ITERS cycles (the 5th Y_ITERS is the warmup), exact `_n`
    // over all 5,000 calls, then a stabilize 'deep' window of EXACTLY
    // YB_CYCLES cycles (1,000 borrows): arrayBuffers growth 0, settled; every
    // delta = census x cycles, and a borrows delta of 0 in either window is a
    // FAIL. Plus Y1c's transient kit (nsLaneS): YB_NS_K cycles per new-space
    // window, excess over an empty-fn baseline of the SAME window size <
    // NS_MAX_EXCESS (one 16 B box per borrow reads 4,096 B), every window
    // exactly YB_NS_K cycles with deltas = census x YB_NS_K. Controls: CY8
    // AllocBorrow flips the alloc check, CY9 noRefill the borrows floor; the
    // nsLaneS path itself is CY4's (DropSplit).
    const YBU = 1 << 16;        // Y1b universe, w = 16 (K = 32, h = 8)
    const YBC = 43;             // Y1b capacity = the cycle's peak size
    const YB_CEN = Int32Array.of(1, 1, 1);  // census: splits / merges / borrows per cycle
    const YB_CYCLES = 1000;     // Y1b abGrowth window, cycles (= borrows)
    const YB_NS_K = 256;        // Y1b transient: cycles per new-space window
    const ybAdd = new Uint32Array(43);
    for (let j = 0; j <= 32; j++) ybAdd[j] = j * 1000;
    for (let j = 0; j < 10; j++) ybAdd[33 + j] = j * 1000 + 500;
    const ybDel = new Uint32Array(43);
    for (let j = 0; j < 10; j++) ybDel[j] = (32 - j) * 1000;
    const ybLeft = Array.from(ybAdd).filter((x) => x < 23000).sort((p, q) => p - q);
    if (ybLeft.length !== 33) fails.push('Y1b stream: ' + ybLeft.length + ' keys left after the borrow (want 33)');
    ybDel.set(ybLeft.slice(0, 33), 10);

    // One borrow cycle: add[] in order, delete del[] in order, clear().
    function makeBorrowStep(set, calls, add, del) {
        const na = add.length;
        const nd = del.length;
        return function borrowStep(i) {
            for (let j = 0; j < na; j++) set.add(add[j]);
            SINK[0] = (SINK[0] + set.size + (i & 1)) | 0;
            for (let j = 0; j < nd; j++) set.delete(del[j]);
            set.clear();
            calls[0]++;
        };
    }

    const ybs = new YFastTrie(YBU, YBC);
    const ybCalls = new Int32Array(1);
    const stepYB = makeBorrowStep(ybs, ybCalls, ybAdd, ybDel);
    const y1b = yStormLane('Y1b', ybs, stepYB, ybCalls, YB_CYCLES, YB_CEN);
    const nsBaseB = nsLaneS(emptyFn, null, null, null, YB_NS_K);
    const y1bt = nsExcessS(stepYB, ybs, ybCalls, YB_CEN, YB_NS_K, nsBaseB);
    const y1btOk = y1bt.excess !== null && y1bt.excess < NS_MAX_EXCESS && y1bt.bad === 0;
    if (!y1btOk) {
        fails.push('Y1b borrow transient ' + (y1bt.excess === null ? 'not measured (null)' :
            'excess ' + y1bt.excess + ' B per ' + YB_NS_K + ' cycles (limit ' + NS_MAX_EXCESS + ')') +
            ' valid=' + y1bt.valid + ' badWindows=' + y1bt.bad);
    }
    console.log('Y1b U=' + YBU + ' C=' + YBC + ' cycle=' + ybAdd.length + ' adds + ' + ybDel.length +
        ' deletes + clear()' +
        ' borrow: alloc=' + (y1b.b === null ? 'null' : Math.round(y1b.b)) + ' B/op over ' + y1b.n +
        ' cycles (splits+' + y1b.d0 + ' merges+' + y1b.d1 + ' borrows+' + y1b.d2 + ')' +
        ' window ' + y1b.m + ' cycles splits+' + y1b.f0 + ' merges+' + y1b.f1 + ' borrows+' + y1b.f2 +
        ' (census ' + YB_CEN[0] + '/' + YB_CEN[1] + '/' + YB_CEN[2] + ' per cycle)' +
        ' abGrowth=' + y1b.ab + ' settled=' + y1b.settled +
        ' transient nsExcess=' + y1bt.excess + ' B / ' + YB_NS_K + ' cycles (limit ' + NS_MAX_EXCESS +
        ') nsWin0=' + y1bt.first + ' valid=' + y1bt.valid + ' badWindows=' + y1bt.bad +
        ' | ' + (y1b.ok && y1btOk ? 'ok' : 'FAIL'));

    // ---- Y3: retention churn (construct / fill / clear / drop) ---------------
    // Same contract as T2 / X3 (noop cleanup, string tag, own frame). Every
    // cycle is the Y3 census cycle on a FRESH instance; ctr sums each instance's
    // `_n` (clear() keeps them, so the read after the final add is the cycle's).
    function churnY(tracker, held, ctr) {
        let tracked = 0;
        for (let i = 0; i < CYCLES; i++) {
            const s = new YFastTrie(YSU, YSM);
            for (let j = 0; j < YSM; j++) s.add(ySKeys[j]);
            s.has(ySKeys[0]);
            s.successor(ySKeys[0]);
            s.predecessor(ySKeys[YSM - 1]);
            s.min();
            s.max();
            for (let j = 0; j < (YSM >>> 1); j++) s.delete(ySKeys[j]);
            s.clear();
            s.add(i & (YSU - 1));
            ctr[0] += s._n[0];
            ctr[1] += s._n[1];
            ctr[2] += s._n[2];
            tracker.track(s, noop, 'yfasttrie', { audit: true });
            tracked++;
            if (held !== null) held.push(s);
        }
        return tracked;
    }
    const boxY3 = { collected: 0, leaks: [], warns: [] };
    const trackerY3 = makeTracker('lite-loglogn-yft', boxY3);
    const ctrY3 = new Int32Array(3);
    const trackedY3 = churnY(trackerY3, null, ctrY3);
    const liveY3 = await drain(trackerY3);
    const findingsY3 = trackerY3.audit();
    globalThis.gc();
    await settle(25);
    const afterY3 = trackerY3.size();
    const y3Ok = trackedY3 === CYCLES && liveY3 === 0 && afterY3 === 0 &&
        boxY3.collected === CYCLES && findingsY3.length === 0 && boxY3.leaks.length === 0 &&
        ctrY3[0] === CYCLES * Y3_SPLITS && ctrY3[1] === CYCLES * Y3_MERGES && ctrY3[2] === CYCLES * Y3_BORROWS;
    if (!y3Ok) {
        fails.push('Y3 tracked=' + trackedY3 + ' size=' + liveY3 + ' after=' + afterY3 +
            ' collected=' + boxY3.collected + ' findings=' + findingsY3.length +
            ' leaks=' + boxY3.leaks.length + ' splits=' + ctrY3[0] + ' merges=' + ctrY3[1] +
            ' borrows=' + ctrY3[2] + ' (want ' + CYCLES * Y3_SPLITS + '/' + CYCLES * Y3_MERGES + '/' +
            CYCLES * Y3_BORROWS + ')');
        for (const f of findingsY3) fails.push('Y3 finding ' + f.kind + ':' + f.reason);
        for (const l of boxY3.leaks) fails.push('Y3 leak ' + l);
    }
    console.log('Y3 cycles=' + CYCLES + ' U=' + YSU + ' C=' + YSM + ' size=' + liveY3 + '/0' +
        ' after=' + afterY3 + ' collected=' + boxY3.collected + '/' + trackedY3 +
        ' splits=' + ctrY3[0] + ' merges=' + ctrY3[1] + ' borrows=' + ctrY3[2] +
        ' (census ' + Y3_SPLITS + '/' + Y3_MERGES + '/' + Y3_BORROWS + ' per cycle)' +
        ' findings=' + findingsY3.length + ' warnings=' + boxY3.warns.length +
        ' leaks=' + boxY3.leaks.length +
        ' | ' + (y3Ok ? 'ok' : 'FAIL'));

    // ---- Y4: controls (each MUST flip its Y-tier's check) --------------------
    // CY1 retaining loop on the Y0 (2^20) step: measureAllocs MUST read > 0.
    const yHold = [];
    const yStepA = y0a.step;
    const yRetainFn = function yRetain(i) { yStepA(i); yHold.push([i]); };
    const cy1 = measureAllocs(yRetainFn, { iterations: 20000, batches: 4 });
    const cy1Bpc = cy1.bytesPerCall;
    const cy1Flip = cy1Bpc !== null && Math.round(cy1Bpc) > 0;
    yHold.length = 0;

    // CY2 transient box on the Y0 (2^20) step: one array per op into a 64-slot
    // ring (as C2 / CX2), through nsExcessY on y0a's own set (Y0's lane
    // function, moved = true); the lane MUST read over its threshold.
    const yRing = new Array(64).fill(null);
    const yBoxFn = function yBoxed(i) { yStepA(i); yRing[i & 63] = [i]; };
    const cy2 = nsExcessY(yBoxFn, y0a.set, true);
    const cy2Flip = cy2 !== null && cy2.excess >= NS_MAX_EXCESS && cy2.bad === 0;
    const cy2Bpo = cy2 === null ? null : Math.max(0, cy2.excess) / NS_K;

    // CY3 ReallocSplit: every split appends its new rep to a Uint32Array log the
    // instance keeps, reallocated +1 word per split (the C3 GrowingBitset shape),
    // driven by Y1's step and window. abGrowth MUST be > 0, and the window must
    // actually have split.
    class ReallocSplit extends YFastTrie {
        _split(f) {
            const old = this._log;
            const next = new Uint32Array(old.length + 1);
            next.set(old);
            next[old.length] = this._bk[f * this._k + this._w];
            this._log = next;
            return super._split(f);
        }
    }
    const yg = new ReallocSplit(YSU, YSM);
    yg._log = new Uint32Array(1);
    const ygCalls = new Int32Array(1);
    const stepYG = makeStormStep(yg, ygCalls);
    const g3 = yn(yg, 0);
    const ry3 = measureOps(stepYG, { ops: Y_STORM_CYCLES, warmup: 0, stabilize: 'deep' });
    const gSplits = yn(yg, 0) - g3;
    const aby3 = ry3.summary.arrayBuffers;
    const repy3 = checkNoGc(ry3.summary, { maxArrayBuffersGrowth: 0 });
    const cy3Flip = repy3.verdict !== 'pass' && aby3.growthBytes > 0 && gSplits >= 1;

    // CY4 DropSplit: every split allocates a Uint32Array(K) and drops it (the
    // previous one; only the last is held, and one is held from construction on,
    // so the held count never changes). abGrowth MUST stay 0 (the deep
    // window settles them away) while Y1c's transient lane MUST read excess >=
    // limit on a MEASURED window (null is not a flip) whose cycles and splits
    // matched the census.
    class DropSplit extends YFastTrie {
        _split(f) {
            this._tmp = new Uint32Array(this._k);
            return super._split(f);
        }
    }
    const yd = new DropSplit(YSU, YSM);
    yd._tmp = new Uint32Array(yd._k);
    const ydCalls = new Int32Array(1);
    const stepYD = makeStormStep(yd, ydCalls);
    const ry4 = measureOps(stepYD, { ops: Y_STORM_CYCLES, warmup: 0, stabilize: 'deep' });
    const aby4 = ry4.summary.arrayBuffers;
    const cy4 = nsExcessS(stepYD, yd, ydCalls, Y_CEN, YNS_K, nsBaseS);
    const cy4Flip = cy4.excess !== null && cy4.excess >= NS_MAX_EXCESS && cy4.bad === 0 &&
        aby4.growthBytes === 0 && aby4.settled === true;

    // CY5 retained array: the Y3 churn, every instance also held past the
    // drain. tracker.size() MUST stay > 0.
    const boxY5 = { collected: 0, leaks: [], warns: [] };
    const trackerY5 = makeTracker('lite-loglogn-yft-control', boxY5);
    const yHeld = [];
    churnY(trackerY5, yHeld, new Int32Array(3));
    const liveY5 = await drain(trackerY5);
    const cy5Flip = liveY5 > 0;
    yHeld.length = 0;

    // CY6 gc kick: the Y0 (2^20) step plus a forced globalThis.gc() every
    // 65,536 ops, through gcLane -- Y0's window and verdict (as C5 / CX6). The
    // verdict MUST be not-ok with gcMajor > 0; the kick count must equal GC_KICKS.
    const kickY = new Int32Array(1);
    const yGcKickFn = function yGcKick(i) {
        yStepA(i);
        if ((i & 65535) === 0) {
            globalThis.gc();
            kickY[0]++;
        }
    };
    const cy6 = await gcLane('Y0 control yGcKick', yGcKickFn, GC_KICK_OPS);
    const cy6Flip = !cy6.ok && cy6.majorHit && cy6.s.gc.major > 0 && kickY[0] === GC_KICKS;

    // CY7 flatKeys: the storm with its keys cut to 32 distinct ((j & 31) x 97:
    // the head bucket never reaches K + 1 keys, so nothing splits), through
    // yStormLane -- Y1's exact census check. It MUST fail; its errors are the
    // flip, so they are taken back off `fails` (a PASS is pushed below instead).
    const yFlatKeys = new Uint32Array(YSM);
    for (let j = 0; j < YSM; j++) yFlatKeys[j] = (j & 31) * YS_STRIDE;
    function makeKeyStormStep(set, calls, keys) {
        return function keyStormStep(i) {
            for (let j = 0; j < YSM; j++) set.add(keys[j]);
            SINK[0] = (SINK[0] + set.size + (i & 1)) | 0;
            for (let j = 0; j < YSM; j++) set.delete(keys[j]);
            set.clear();
            calls[0]++;
        };
    }
    const yf = new YFastTrie(YSU, YSM);
    const yfCalls = new Int32Array(1);
    const nFails7 = fails.length;
    const cy7 = yStormLane('CY7', yf, makeKeyStormStep(yf, yfCalls, yFlatKeys), yfCalls, Y_STORM_CYCLES,
        Y_CEN);
    const cy7Errs = fails.length - nFails7;
    fails.length = nFails7;
    const cy7Flip = !cy7.ok && cy7Errs > 0 && cy7.f0 !== Y_SPLIT_WINDOW;

    // CY8 AllocBorrow: _shrink retains one small array per BORROW (it
    // allocates only when the borrow branch is taken: s_p + s - 1 > K), driven
    // by Y1b's stream through yStormLane -- Y1b's gate. Its alloc MUST read
    // > 0 B/op while the census and the borrows floor still hold (the flip is
    // the allocation, not a missed borrow); the lane's errors are the flip, so
    // they are taken back off `fails` (as CY7).
    class AllocBorrow extends YFastTrie {
        _shrink(f, j) {
            if (this._bn[this._x._prev[f]] + this._bn[f] - 1 > this._k) this._hold.push([f]);
            super._shrink(f, j);
        }
    }
    const ya = new AllocBorrow(YBU, YBC);
    ya._hold = [];
    const yaCalls = new Int32Array(1);
    const nFails8 = fails.length;
    const cy8 = yStormLane('CY8', ya, makeBorrowStep(ya, yaCalls, ybAdd, ybDel), yaCalls, YB_CYCLES, YB_CEN);
    const cy8Msgs = fails.slice(nFails8);
    fails.length = nFails8;
    const cy8Held = ya._hold.length;
    ya._hold.length = 0;
    const cy8Flip = !cy8.ok && cy8Msgs.length > 0 && cy8.b !== null && Math.round(cy8.b) > 0 &&
        cy8.floor && cy8.d2 === YB_CEN[2] * cy8.n && cy8.f2 === YB_CEN[2] * cy8.m &&
        cy8Held === cy8.d2 + cy8.f2;

    // CY9 noRefill: Y1b's cycle without the 10 refill keys r_i (adds b_0..b_32,
    // deletes b_32..b_23 then b_0..b_22): the underflow delete of b_23 meets a
    // head of 16 keys, 16 + 7 <= K -> it MERGES, so the cycle is 1 / 1 / 0 and
    // never borrows. Through yStormLane with Y1b's census: its borrows floor
    // MUST fail (floor false, borrows +0 in both windows); errors taken back.
    const y9Add = ybAdd.slice(0, 33);
    const y9Del = new Uint32Array(33);
    for (let j = 0; j < 10; j++) y9Del[j] = (32 - j) * 1000;
    for (let j = 0; j < 23; j++) y9Del[10 + j] = j * 1000;
    const y9 = new YFastTrie(YBU, YBC);
    const y9Calls = new Int32Array(1);
    const nFails9 = fails.length;
    const cy9 = yStormLane('CY9', y9, makeBorrowStep(y9, y9Calls, y9Add, y9Del), y9Calls, YB_CYCLES, YB_CEN);
    const cy9Msgs = fails.slice(nFails9);
    fails.length = nFails9;
    const cy9Flip = !cy9.ok && cy9Msgs.length > 0 && !cy9.floor && cy9.d2 === 0 && cy9.f2 === 0 &&
        cy9Msgs.some((s) => s.includes('the borrow lane is vacuous'));
    const yFlips = (cy1Flip ? 1 : 0) + (cy2Flip ? 1 : 0) + (cy3Flip ? 1 : 0) + (cy4Flip ? 1 : 0) +
        (cy5Flip ? 1 : 0) + (cy6Flip ? 1 : 0) + (cy7Flip ? 1 : 0) + (cy8Flip ? 1 : 0) + (cy9Flip ? 1 : 0);

    console.log('Y4 controls' +
        ' retain.alloc=' + (cy1Bpc === null ? 'null' : Math.round(cy1Bpc)) + ' B/op ' +
        (cy1Flip ? 'flipped' : 'PASSED') +
        ' box.transient=' + fmt(cy2Bpo, 3) + ' B/op ' + (cy2Flip ? 'flipped' : 'PASSED') +
        ' reallocSplit.abGrowth=' + aby3.growthBytes + ' (splits+' + gSplits + ') ' +
        (cy3Flip ? 'flipped' : 'PASSED') +
        ' dropSplit.nsExcess=' + cy4.excess + ' B / ' + YNS_K + ' cycles (' +
        (cy4.excess === null ? 'null' : fmt(cy4.excess / (YNS_K * Y_SPLITS), 1)) + ' B/split, valid=' +
        cy4.valid + ' badWindows=' + cy4.bad + ' abGrowth=' + aby4.growthBytes + ') ' +
        (cy4Flip ? 'flipped' : 'PASSED') +
        ' retained.size=' + liveY5 + ' ' + (cy5Flip ? 'flipped' : 'PASSED') +
        ' yGcKick.gcMajor=' + cy6.s.gc.major + ' maxPauseMs=' + cy6.s.gc.maxMs.toFixed(2) +
        ' kicks=' + kickY[0] + '/' + GC_KICKS + ' violations=' + cy6.errs.length + ' ' +
        (cy6Flip ? 'flipped' : 'PASSED') +
        ' flatKeys.splits=+' + cy7.f0 + '/' + Y_SPLIT_WINDOW + ' errors=' + cy7Errs + ' ' +
        (cy7Flip ? 'flipped' : 'PASSED') +
        ' allocBorrow.alloc=' + (cy8.b === null ? 'null' : Math.round(cy8.b)) + ' B/op (borrows+' +
        cy8.d2 + '/+' + cy8.f2 + ' held=' + cy8Held + ' errors=' + cy8Msgs.length + ') ' +
        (cy8Flip ? 'flipped' : 'PASSED') +
        ' noRefill.borrows=+' + cy9.d2 + '/+' + cy9.f2 + ' (merges+' + cy9.d1 + '/+' + cy9.f1 +
        ' errors=' + cy9Msgs.length + ') ' + (cy9Flip ? 'flipped' : 'PASSED') +
        ' flipped ' + yFlips + '/9' +
        ' | ' + (yFlips === 9 ? 'ok' : 'FAIL'));
    console.log('Y4 CY8 / CY9 lane errors (expected: the flip): ' + cy8Msgs.concat(cy9Msgs).join(' ; '));
    if (!cy1Flip) fails.push('control yRetain PASSED its check (alloc ' + cy1Bpc + ' B/op): Y0 alloc lane is blind');
    if (!cy2Flip) fails.push('control yBox PASSED its check: Y0 transient lane is blind');
    if (!cy3Flip) {
        fails.push('control ReallocSplit PASSED its check (abGrowth ' + aby3.growthBytes +
            ', splits+' + gSplits + '): Y1 is blind');
    }
    if (!cy4Flip) {
        fails.push('control DropSplit PASSED its check (nsExcess ' + cy4.excess + ', valid ' +
            cy4.valid + ', badWindows ' + cy4.bad + ', abGrowth ' + aby4.growthBytes +
            '): Y1c storm transient lane is blind');
    }
    if (!cy5Flip) fails.push('control yRetained PASSED its check (size ' + liveY5 + '): Y3 is blind');
    if (!cy6Flip) {
        fails.push('control yGcKick PASSED its check (gcMajor ' + cy6.s.gc.major + ', kicks ' +
            kickY[0] + '/' + GC_KICKS + ', violations ' + cy6.errs.length + '): Y0 gc lane is blind');
    }
    if (!cy7Flip) {
        fails.push('control flatKeys PASSED its check (splits+' + cy7.f0 + ', errors ' + cy7Errs +
            '): Y1 census / split floor is blind');
    }
    if (!cy8Flip) {
        fails.push('control AllocBorrow PASSED its check (alloc ' + cy8.b + ' B/op, borrows+' + cy8.d2 +
            '/+' + cy8.f2 + ', held ' + cy8Held + ', errors ' + cy8Msgs.length + '): Y1b alloc lane is blind');
    }
    if (!cy9Flip) {
        fails.push('control noRefill PASSED its check (borrows+' + cy9.d2 + '/+' + cy9.f2 + ', floor ' +
            cy9.floor + ', errors ' + cy9Msgs.length + '): Y1b borrows floor is blind');
    }

    const yAlloc = Math.max(y0a.b === null ? Infinity : Math.round(y0a.b),
        y0b.b === null ? Infinity : Math.round(y0b.b),
        y1.b === null ? Infinity : Math.round(y1.b),
        y1b.b === null ? Infinity : Math.round(y1b.b));
    const yTrans = y0a.t === null || y0b.t === null || tS === null ? null : Math.max(y0a.t, y0b.t, tS);
    const yAb = Math.max(y1.ab, y1b.ab, aby2.growthBytes);
    if (yAlloc === Infinity || yTrans === null || y1c.excess === null || y1bt.excess === null) {
        fails.push('yft GATE: a null aggregate (alloc ' + (yAlloc === Infinity ? 'null' : yAlloc) +
            ', transient ' + yTrans + ', stormExcess ' + y1c.excess + ', borrowExcess ' + y1bt.excess +
            ') is a FAIL, never a 0');
    }

    const xAlloc = Math.max(x0a.b === null ? Infinity : Math.round(x0a.b),
        x0b.b === null ? Infinity : Math.round(x0b.b),
        x2a.b === null ? Infinity : Math.round(x2a.b),
        x2b.b === null ? Infinity : Math.round(x2b.b));
    const xTrans = x0a.t === null || x0b.t === null ? null : Math.max(x0a.t, x0b.t);
    const xAb = Math.max(abx1.growthBytes, x2a.ab, x2b.ab);

    // ==== V-tiers: vEBTree (PLAN-vebtree G2, C-21) ===========================
    // Run after the Y-tiers so T / X / Y keep their own feedback; the V-tiers
    // drive vEBTree through their OWN step closures (makeStepV here, makeStepV2
    // and makeStepV3 in test/_veb-torture-worker.mjs) -- no older call site
    // sees a vEBTree.
    // Keys < 2^30 everywhere except V4's two permanent keys (C-11 boxing
    // caveat: V4 keeps every arg / return < 2^30; CV7 returns 2^31 on purpose).
    //   V1  2,000,000 mixed ops (makeStepY's op mix and tally) at U = 2^16 on
    //       ONE instance built outside the loop: retained 0 B/op (null /
    //       unsettled = FAIL), transient excess < NS_MAX_EXCESS per NS_K-op
    //       window, gc major 0, maxPauseMs <= 4 (gcLane -> gcVerdict). Coverage
    //       floor: no zero tally slot (every op kind, hits AND misses).
    //   V2  U = 2^28 depth-2 ring (64 root clusters c = 64j + 7, keys
    //       (c << 16) | odd r16, 4 permanent keys per cluster; see the worker
    //       header): byteLength 33,718,804 and every cluster >= 3 keys before /
    //       after each lane. V2a in-process retained 0 B/op; V2b a Worker with a
    //       kill timer (C-19; timeout = FAIL): 50,000 warmup ops, then 200,000
    //       ops under stabilize 'deep' -- arrayBuffers growth 0, settled.
    //   V3  U = 2^25 + 3 (w = 26, lo = 16: every root cluster is an INTERNAL
    //       w = 16 node over w = 8 leaves; the root summary is an internal
    //       w = 10 node), 1,024 keys ((8j + 1) << 16) | (s << 8) | l, j 0..63,
    //       s in {3, 50, 140, 255}, l in {1, 9, 77, 200}: 64 root clusters x 4
    //       leaf clusters x 4 keys. One cycle = 2,048 ops: add all ascending,
    //       then delete descending with max() === x checked before each delete
    //       (a hit = a refresh: every delete removes the max). Lanes: retained
    //       0 B/op (measureAllocs, whole cycles per batch) and transient excess
    //       < NS_MAX_EXCESS; refreshes == deletes == adds == ops / 2 EXACTLY,
    //       bad 0 (a missed delete, or size != 0 at a cycle end); after the
    //       lanes `_t` byte-equal to a fresh vEBTree(2^25 + 3)'s. A cold census
    //       (one cycle, `_p` cleared before each delete) proves the key set
    //       drives mode-1 and mode-2 max refreshes at the root AND inside an
    //       internal w = 16 cluster (C-12, C-18 (3) / (4)). V3 runs in a Worker
    //       (startVebTorture, kill timer KILL_MS; FILLER 1): a refresh-breaking
    //       engine mutant that loops forever on a leaf scan is a V3 timeout FAIL
    //       (exit 1), not a hung torture. Same lane TEXT as in-process:
    //       measureAllocs with V3's options, and the Worker's transient lane is
    //       this file's nsLane family by source text (laneParity: 5 functions
    //       incl. takeNsBase + 3 constants; drift = V3 FAIL). Not the same
    //       state: the Worker warms the lane once (its first takeNsBase() is
    //       discarded; a fresh Worker's first lane reads 1,784 or 2,760-2,872
    //       B per window, later ones 1,784-1,816) and its new-space capacity
    //       differs (2,883,584 B vs 1,835,008-2,097,152 B on the main thread;
    //       veb-nsbase-probe-2026-11-03.log). Text cannot see the Worker's call
    //       site, SINK or node:v8 import: the posted baseline must pass
    //       nsBaseOk (0..NS_BASE_MAX = 4,096 B per window), and CV9 (one box
    //       every 8th op) judges the lane itself.
    //   V4  U = 2^31 + 1 (w = 32, root trimmed to 32,769 clusters): permanent
    //       keys 2^31 (the root max) and 2^30 - 1 (a barrier above the ring),
    //       4,096 even permanent keys < 2^29, an odd ring < 2^29 added and
    //       deleted at once. The step never calls max(); every arg / return is
    //       < 2^30, but successor / has / delete read the root max slot (2^31)
    //       raw on every op. TRANSIENT lane only (Y2b's shape): excess
    //       < NS_MAX_EXCESS with >= 8 valid windows. Cold, outside the lane:
    //       max() === 2147483648, byteLength === 269,762,648, answers, size
    //       before == after. The instance
    //       (~270 MB) is dropped + gc() before anything else runs.
    //   V5  4,096 x (new vEBTree(2^10), 64 adds, 64 deletes, clear()):
    //       tracker.size() 0 after the drain and one gc later, collected
    //       4096/4096, findings 0, leaks 0.
    // Controls (each MUST flip; printed on the CV line): CV1 retain (V1 alloc
    // > 0), CV2 box (V1-shaped window excess >= NS_MAX_EXCESS), CV3 gcKick
    // (forced gc inside V1's gc window: major > 0, kicks 4/4), CV4 per-level
    // `new` (a data: URL mutant of LogLogN.js whose add() descent retains a
    // Uint32Array(32) per internal level, through V2b's SAME Worker function:
    // abGrowth > 0 and >= 128 B per add -- it also proves the Worker measures
    // its OWN arrayBuffers), CV5 delete ascending (V3's step factory and count
    // check: refreshes != deletes), CV6 RetainOnRefresh (a subclass whose
    // delete retains [x] when x is the max, through V3's alloc lane: alloc > 0)
    // -- CV5 and CV6 each run in their own Worker through V3's Worker path,
    // CV7 bigSucc (V4's step + successor(2^30 - 1), which returns 2^31 from a
    // never-inlined 850 B method, on V4's own instance: excess >= NS_MAX_EXCESS),
    // CV8 retained array (V5 size > 0), CV9 v3WorkerBox (one [i] every 8th op on
    // V3's step inside the V3 Worker, after V3's lanes, same isolate + baseline:
    // excess >= NS_MAX_EXCESS, baseMin in range (nsBaseOk) AND excess + baseMin >
    // NS_BASE_MAX).
    // GATE segment `| veb leak=size .. alloc .. transient .. abGrowth ..
    // refreshes=+N bigKeyExcess=e B/65536`: alloc = max(V1, V2a, V3), transient
    // = max(V1, V3, V4), gc = V1's window, abGrowth = V2b, refreshes = V3,
    // bigKeyExcess = V4's excess. A null / unsettled aggregate is a FAIL.
    // A build without the vEBTree export (pre-vEB) fails closed: 'veb: vEBTree
    // export missing', veb = null (GATE `| veb=null`), exit 1.
    const { vEBTree } = await import('../LogLogN.js');
    const vw = await import('./_veb-torture-worker.mjs');
    const { readFileSync } = await import('node:fs');

    const VU1 = 1 << 16;        // V1 universe, w = 16 (internal root, lo = 8)
    const VU5 = 1 << 10;        // V5 universe, w = 10
    const V2_SEED = 0x3c6ef372;
    const V2_OPS = 200000;      // V2b / CV4 measured window, ops
    const V2_WARM = 50000;      // V2b / CV4 warmup, ops
    const CV4_BYTES = 128;      // Uint32Array(32) per internal level
    const V2A_ITERS = 250000;   // V2a measureAllocs iterations per batch
    const V2A_BATCHES = 4;      // V2a measured batches
    const V4_U = 2147483649;    // 2^31 + 1, w = 32 (lo = hi = 16)
    const V4_TOP = 2147483648;  // 2^31: permanent, the root max
    const V4_BAR = 1073741823;  // 2^30 - 1: permanent, above every ring key
    const V4_RU = 1 << 29;      // ring keys < 2^29
    const V4_POP = 4096;        // permanent even keys < 2^29
    const V4_BYTES = 269762648; // byteLength at U = 2^31 + 1 (G2 TASK 0: formula x 4 == engine)
    // CV4 anchor: add()'s per-level descent -- the parent pointer is set and b
    // moves into cluster pj. Count-checked to occur EXACTLY once in LogLogN.js,
    // and located between the vEB section's `add(x) {` and `delete(x) {`.
    const CV4_ANCHOR = '                    ps = b + 2;\n' +
        '                    pw = w - lo;\n' +
        '                    pj = x >>> lo;\n';
    const CV4_INJECT = '                    (globalThis.__cv4Hold || (globalThis.__cv4Hold = []))' +
        '.push(new Uint32Array(32));\n';

    // The V1 mixed step: makeStepY's op mix and 16-slot tally on a vEBTree, in
    // its OWN closure. Built cold; const bindings only, integer sink in a
    // typed-array slot.
    function makeStepV(set, k, cnt) {
        return function stepV(i) {
            const x = k[i & KMASK];
            const op = i & 7;
            let r = 0;
            switch (op) {
                case 0: set.add(x); break;
                case 1:
                    r = set.delete(k[(i - 1 + HALF) & KMASK]) ? 1 : 0;
                    cnt[r === 1 ? XN_DH : XN_DM]++;
                    break;
                case 2:
                    r = set.has(k[(i - ((i & 8) >>> 2)) & KMASK]) ? 1 : 0;
                    cnt[r === 1 ? XN_HH : XN_HM]++;
                    break;
                case 3:
                case 4:
                    r = set.successor(x);
                    cnt[r === undefined ? XN_SM : XN_SH]++;
                    break;
                case 5:
                    r = set.predecessor(x);
                    cnt[r === undefined ? XN_PM : XN_PH]++;
                    break;
                case 6: r = set.min(); break;
                default: r = set.max();
            }
            cnt[op]++;
            SINK[0] = (SINK[0] + (r === undefined ? 7 : r)) | 0;
        };
    }

    // populate()'s keys, through a vEBTree-only call site. Cold.
    function populateV(set, k) {
        for (let j = 0; j < HALF; j += 8) set.add(k[j]);
        return set;
    }

    // V5 churn (T2's shape, own frame): 64 distinct keys (a + 16 j) & 1023 added,
    // deleted (each must return true), clear(). bad counts a delete that missed
    // or a size that is not 0 after the deletes. Cold.
    function churnV(tracker, held, Veb, bad) {
        let tracked = 0;
        for (let i = 0; i < CYCLES; i++) {
            const s = new Veb(VU5);
            const a = i & 15;
            for (let j = 0; j < 64; j++) s.add((a + 16 * j) & (VU5 - 1));
            for (let j = 0; j < 64; j++) if (!s.delete((a + 16 * j) & (VU5 - 1))) bad[0]++;
            if (s.size !== 0) bad[0]++;
            s.clear();
            tracker.track(s, noop, 'vebtree', { audit: true });
            tracked++;
            if (held !== null) held.push(s);
        }
        return tracked;
    }

    // A Worker outcome as one error string, or null.
    function vErr(job) {
        if (job.error !== null) return job.error;
        const r = job.result;
        if (r === null || typeof r !== 'object') return 'worker posted no result';
        return typeof r.error === 'string' ? r.error : null;
    }

    // The first line of an error string (a Worker stack), for a one-line tier print.
    function line1(e) {
        return String(e).split('\n')[0];
    }

    // The CV4 mutant source, or a string starting 'BAD ' (never flips). Cold.
    function cv4Source() {
        const src = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
        const n = src.split(CV4_ANCHOR).length - 1;
        const vAt = src.indexOf('\n// --- vEBTree (0.5.0)');
        const addAt = vAt < 0 ? -1 : src.indexOf('\n    add(x) {', vAt);
        const delAt = addAt < 0 ? -1 : src.indexOf('\n    delete(x) {', addAt);
        const at = src.indexOf(CV4_ANCHOR);
        if (n !== 1) return { n, src: 'BAD anchor count ' + n + ' (want exactly 1)' };
        if (!(vAt >= 0 && addAt > vAt && at > addAt && delAt > at)) {
            return { n, src: 'BAD anchor at ' + at + ' not inside vEBTree add() (' + addAt + '..' + delAt + ')' };
        }
        return { n, src: src.replace(CV4_ANCHOR, CV4_INJECT + CV4_ANCHOR) };
    }

    // ---- V4 helpers -----------------------------------------------------------
    // The V4 step, its OWN closure (vEBTree only), Y2b's straddle shape: op 0
    // adds an odd ring key x < 2^29, op 1 deletes it (always present: the ring
    // is odd, the permanent keys even), has alternates that miss and a permanent
    // hit, successor / predecessor / min return keys <= 2^30 - 1. max() is
    // never called; nothing passed or returned reaches 2^30.
    function makeStepV4(set, k, pk) {
        return function stepV4(i) {
            const x = k[i & KMASK];
            let r = 0;
            switch (i & 7) {
                case 0: set.add(x); break;
                case 1: r = set.delete(k[(i - 1) & KMASK]) ? 1 : 0; break;
                case 2: r = set.has((i & 8) === 0 ? x : pk[(i >>> 4) & (V4_POP - 1)]) ? 1 : 0; break;
                case 3:
                case 4: r = set.successor(x); break;
                case 5: r = set.predecessor(x); break;
                case 6: r = set.min(); break;
                default: r = set.predecessor(x + 1);
            }
            SINK[0] = (SINK[0] + (r === undefined ? 7 : r)) | 0;
        };
    }
    // V4 + CV7 in their own frame, so the ~270 MB instance dies when this
    // returns (the caller then gc()s). Returns numbers and strings only. Cold.
    function vTier4(Veb) {
        const k = keyRing(V4_RU, 0x68e31da4);
        for (let i = 0; i < KEYS; i++) k[i] = (k[i] | 1) >>> 0;
        const pkr = keyRing(V4_RU, 0x1b56c4e9);
        const pk = new Uint32Array(V4_POP);
        let pkMax = 0;
        for (let j = 0; j < V4_POP; j++) {
            pk[j] = (pkr[j] & 0x1FFFFFFE) >>> 0;
            if (pk[j] > pkMax) pkMax = pk[j];
        }
        const set = new Veb(V4_U);
        set.add(V4_TOP).add(V4_BAR);
        for (let j = 0; j < V4_POP; j++) set.add(pk[j]);
        const distinct = new Set(pk).size + 2;
        const top = set.max();
        const size0 = set.size;
        const pre = top === V4_TOP && size0 === distinct && set.has(V4_TOP) &&
            set.successor(V4_RU) === V4_BAR && set.predecessor(V4_BAR) === pkMax &&
            set.successor(V4_BAR) === V4_TOP && set.bits === 32 && set.byteLength === V4_BYTES;
        const step = makeStepV4(set, k, pk);
        const ns = nsExcess(step);
        const size1 = set.size;
        const post = size1 === size0 && set.successor(V4_RU) === V4_BAR && set.predecessor(V4_BAR) === pkMax;
        // CV7: V4's step + one successor(2^30 - 1) -> 2^31 per op, same instance.
        const bigFn = function vBigSucc(i) {
            step(i);
            SINK[0] = (SINK[0] + set.successor(V4_BAR)) | 0;
        };
        const c7 = nsExcess(bigFn);
        return {
            byteLength: set.byteLength, top, size0, size1, pre, post,
            excess: ns === null ? null : ns.excess, first: ns === null ? null : ns.first,
            valid: ns === null ? null : ns.valid,
            c7: c7 === null ? null : c7.excess, c7valid: c7 === null ? null : c7.valid,
        };
    }

    async function vebTiers(Veb) {
        // ---- V1: 2,000,000 mixed ops at U = 2^16 -------------------------------
        const k1v = keyRing(VU1, 0x5bd1e995);
        // Miss floor, planted (X1's idiom): ring slots = 3 mod 8 feed only
        // successor and slots = 5 mod 8 only predecessor, so 64 of each become
        // U - 1 (successor misses) and 0 (predecessor misses); add / delete /
        // has never read them.
        for (let j = 0; j < 64; j++) {
            k1v[j * 1024 + 3] = VU1 - 1;
            k1v[j * 1024 + 5] = 0;
        }
        const cntV1 = new Int32Array(16);
        const setV1 = populateV(new Veb(VU1), k1v);
        const stepV1 = makeStepV(setV1, k1v, cntV1);
        const al1 = measureAllocs(stepV1, { iterations: 250000, batches: 8 });
        const b1 = al1.bytesPerCall;
        const a1Ok = b1 !== null && al1.settled === true && Math.round(b1) === 0;
        if (!a1Ok) {
            fails.push('V1 alloc bytesPerCall=' + b1 + ' settled=' + al1.settled +
                ' (null or unsettled is a FAIL, not 0)');
        }
        const ns1 = nsExcess(stepV1);
        const n1Ok = ns1 !== null && ns1.excess < NS_MAX_EXCESS;
        const t1 = ns1 === null ? null : Math.max(0, ns1.excess) / NS_K;
        if (!n1Ok) {
            fails.push('V1 transient ' + (ns1 === null ? 'not measured (null)' :
                fmt(t1, 3) + ' B/op, excess ' + ns1.excess + ' B per ' + NS_K +
                ' ops >= ' + NS_MAX_EXCESS));
        }
        const gl1 = await gcLane('V1', stepV1, HOT);
        const sV1 = gl1.s;
        for (const e of gl1.errs) fails.push(e);
        if (!gl1.ok && gl1.errs.length === 0) fails.push('V1 gc not ok (no violation listed)');
        const z1 = zeroSlot(cntV1);
        if (z1 >= 0) fails.push('V1 coverage: tally slot ' + z1 + ' is 0 (an op kind or hit/miss never ran)');
        const v1Ok = a1Ok && n1Ok && gl1.ok && z1 < 0;
        console.log('V1 ops=' + HOT + ' U=' + VU1 +
            ' alloc=' + (b1 === null ? 'null' : Math.round(b1)) + ' B/op' +
            ' allocRaw=' + fmt(b1, 4) +
            ' transient=' + fmt(t1, 3) + ' B/op' +
            ' (limit ' + NS_MAX_EXCESS + ' B / ' + NS_K + ' ops)' +
            ' nsExcess=' + (ns1 === null ? 'null' : ns1.excess) +
            ' nsWin0=' + (ns1 === null ? 'null' : ns1.first) +
            ' gcMajor=' + sV1.gc.major + ' gcMinor=' + sV1.gc.minor +
            ' maxPauseMs=' + sV1.gc.maxMs.toFixed(2) +
            ' add=' + cntV1[0] + ' min=' + cntV1[6] + ' max=' + cntV1[7] +
            ' succ=' + cntV1[XN_SH] + '/' + cntV1[XN_SM] +
            ' pred=' + cntV1[XN_PH] + '/' + cntV1[XN_PM] +
            ' has=' + cntV1[XN_HH] + '/' + cntV1[XN_HM] +
            ' del=' + cntV1[XN_DH] + '/' + cntV1[XN_DM] + ' (hit/miss)' +
            ' size=' + setV1.size +
            ' | ' + (v1Ok ? 'ok' : 'FAIL'));

        // ---- V2a: U = 2^28 depth-2 ring, in-process retained lane --------------
        const k2v = vw.v2Ring(V2_SEED);
        const cntV2 = new Int32Array(12);
        const setV2 = vw.v2Populate(new Veb(vw.V2_U), k2v);
        const bl0 = setV2.byteLength;
        const fl0 = vw.v2Floor(setV2);
        const stepV2 = vw.makeStepV2(setV2, k2v, cntV2, SINK);
        const al2 = measureAllocs(stepV2, { iterations: V2A_ITERS, batches: V2A_BATCHES });
        const b2 = al2.bytesPerCall;
        const bl1 = setV2.byteLength;
        const fl1 = vw.v2Floor(setV2);
        const z2 = vw.v2ZeroSlot(cntV2);
        const v2aOk = b2 !== null && al2.settled === true && Math.round(b2) === 0 &&
            bl0 === vw.V2_BYTES && bl1 === vw.V2_BYTES && fl0 >= vw.V2_FLOOR && fl1 >= vw.V2_FLOOR && z2 < 0;
        if (!v2aOk) {
            fails.push('V2a alloc bytesPerCall=' + b2 + ' settled=' + al2.settled +
                ' byteLength=' + bl0 + '/' + bl1 + ' (want ' + vw.V2_BYTES + ')' +
                ' clusterFloor=' + fl0 + '/' + fl1 + ' (want >= ' + vw.V2_FLOOR + ')' +
                ' zeroSlot=' + z2 + ' (null or unsettled is a FAIL, not 0)');
        }
        console.log('V2a ops=' + V2A_ITERS * V2A_BATCHES + ' U=' + vw.V2_U +
            ' alloc=' + (b2 === null ? 'null' : Math.round(b2)) + ' B/op' +
            ' allocRaw=' + fmt(b2, 4) +
            ' byteLength=' + bl0 + '/' + bl1 +
            ' clusters=' + vw.V2_CLUSTERS + ' minKeys=' + fl0 + '/' + fl1 + ' (before/after)' +
            ' add=' + cntV2[0] + ' has=' + cntV2[8] + '/' + cntV2[9] +
            ' del=' + cntV2[10] + '/' + cntV2[11] + ' (hit/miss)' +
            ' succ=' + (cntV2[4] + cntV2[5]) + ' pred=' + (cntV2[6] + cntV2[7]) +
            ' size=' + setV2.size +
            ' | ' + (v2aOk ? 'ok' : 'FAIL'));

        // ---- V2b: deep arrayBuffers lane in a Worker ---------------------------
        const jb = await vw.startVebTorture({ src: null, seed: V2_SEED, ops: V2_OPS, warmup: V2_WARM }, 'V2b');
        const eb = vErr(jb);
        const rb = eb === null ? jb.result : null;
        const v2bOk = rb !== null && rb.abGrowth === 0 && rb.settled === true && rb.verdict === 'pass' &&
            rb.byteLength0 === vw.V2_BYTES && rb.byteLength1 === vw.V2_BYTES &&
            rb.floor0 >= vw.V2_FLOOR && rb.floor1 >= vw.V2_FLOOR && rb.zero < 0 && rb.adds === V2_OPS / 8 && rb.held === 0;
        if (!v2bOk) {
            fails.push('V2b ' + (rb === null ? 'worker FAIL: ' + eb :
                'abGrowth=' + rb.abGrowth + ' settled=' + rb.settled + ' verdict=' + rb.verdict +
                ' byteLength=' + rb.byteLength0 + '/' + rb.byteLength1 +
                ' clusterFloor=' + rb.floor0 + '/' + rb.floor1 + ' zeroSlot=' + rb.zero +
                ' adds=' + rb.adds + ' (want ' + V2_OPS / 8 + ') held=' + rb.held));
        }
        console.log('V2b worker ops=' + V2_OPS + ' warmup=' + V2_WARM + ' U=' + vw.V2_U +
            (rb === null ? ' error=' + eb :
                ' abGrowth=' + rb.abGrowth + ' settled=' + rb.settled +
                ' byteLength=' + rb.byteLength0 + '/' + rb.byteLength1 +
                ' minKeys=' + rb.floor0 + '/' + rb.floor1 + ' adds=' + rb.adds) +
            ' killMs=' + vw.KILL_MS +
            ' | ' + (v2bOk ? 'ok' : 'FAIL'));

        // ---- CV4: per-level `new` mutant through V2b's Worker function ----------
        const m4 = cv4Source();
        let j4 = { result: null, error: m4.src.slice(0, 4) === 'BAD ' ? m4.src : null };
        if (j4.error === null) {
            j4 = await vw.startVebTorture({ src: m4.src, seed: V2_SEED, ops: V2_OPS, warmup: V2_WARM }, 'CV4');
        }
        const e4 = vErr(j4);
        const r4 = e4 === null ? j4.result : null;
        const per4 = r4 === null || !(r4.adds > 0) ? null : r4.abGrowth / r4.adds;
        const cv4Flip = r4 !== null && r4.abGrowth > 0 && per4 !== null && per4 >= CV4_BYTES;

        // ---- V5: retention churn at U = 2^10 -----------------------------------
        const box5 = { collected: 0, leaks: [], warns: [] };
        const bad5 = new Int32Array(1);
        const tracker5 = makeTracker('lite-loglogn-veb', box5);
        const tracked5 = churnV(tracker5, null, Veb, bad5);
        const live5 = await drain(tracker5);
        const findings5 = tracker5.audit();
        globalThis.gc();
        await settle(25);
        const after5 = tracker5.size();
        const v5Ok = tracked5 === CYCLES && live5 === 0 && after5 === 0 && bad5[0] === 0 &&
            box5.collected === CYCLES && findings5.length === 0 && box5.leaks.length === 0;
        if (!v5Ok) {
            fails.push('V5 tracked=' + tracked5 + ' size=' + live5 + ' after=' + after5 +
                ' collected=' + box5.collected + ' findings=' + findings5.length +
                ' leaks=' + box5.leaks.length + ' badCycles=' + bad5[0]);
            for (const f of findings5) fails.push('V5 finding ' + f.kind + ':' + f.reason);
            for (const l of box5.leaks) fails.push('V5 leak ' + l);
        }
        console.log('V5 cycles=' + CYCLES + ' U=' + VU5 + ' size=' + live5 + '/0' +
            ' after=' + after5 + ' collected=' + box5.collected + '/' + tracked5 +
            ' findings=' + findings5.length + ' warnings=' + box5.warns.length +
            ' leaks=' + box5.leaks.length + ' badCycles=' + bad5[0] +
            ' | ' + (v5Ok ? 'ok' : 'FAIL'));

        // ---- V3: delete-heavy max refresh at U = 2^25 + 3, in a Worker -----------
        // FILLER 1 (C-19): a refresh-breaking engine mutant can loop forever on a
        // leaf scan; in a Worker the kill timer turns that hang into a V3 FAIL.
        // laneOk3 (laneParity): the Worker's transient lane is THIS file's nsLane
        // family by TEXT -- 5 functions (newSpaceUsed, nsLane, emptyFn, takeNsBase,
        // nsExcess; nsNorm strips per-line indent, collapses [ \t]+ and KEEPS
        // newlines, so an edit that joins two lines (an ASI change) is drift) and
        // 3 constants (NS_K, NS_W, NS_MAX_EXCESS); drift = V3 FAIL. Text cannot see
        // the Worker's takeNsBase() call site, SINK or node:v8 import: the posted
        // baseMin <= NS_BASE_MAX ceiling (here) and CV9 v3WorkerBox (the CV block)
        // judge those.
        const nsNorm = (x) => x.replace(/^[ \t]+/gm, '').replace(/[ \t]+/g, ' ');
        const laneOk3 = nsNorm(vw.NS_TEXT) ===
            nsNorm([newSpaceUsed, nsLane, emptyFn, takeNsBase, nsExcess].map(String).join('\n')) &&
            vw.NS_K === NS_K && vw.NS_W === NS_W && vw.NS_MAX_EXCESS === NS_MAX_EXCESS;
        const j3 = await vw.startVebTorture({ src: null, kind: 'v3' }, 'V3');
        const e3 = vErr(j3);
        const r3 = e3 === null ? j3.result : null;
        const ops3 = vw.V3_ITERS * (vw.V3_BATCHES + 1) + NS_K * (2 + NS_W);
        const alignOk3 = vw.V3_ITERS % vw.V3_CYCLE === 0 && NS_K % vw.V3_CYCLE === 0;
        const kErr3 = r3 === null ? null : r3.kErr;
        const cen3 = r3 === null ? null : r3.census;
        const cnt3 = r3 === null ? null : r3.cnt;
        const b3 = r3 === null ? null : r3.bytesPerCall;
        const cErr3 = cnt3 === null ? 'no tally' : vw.v3CountErr(cnt3, ops3);
        const t3 = r3 === null || r3.excess === null ? null : Math.max(0, r3.excess) / NS_K;
        const cenOk3 = cen3 !== null && cen3[0] > 0 && cen3[1] > 0 && cen3[2] > 0 && cen3[3] > 0 && cen3[6] === 0;
        const a3Ok = b3 !== null && r3.settled === true && Math.round(b3) === 0;
        const n3Ok = r3 !== null && r3.excess !== null && r3.excess < NS_MAX_EXCESS;
        const base3 = r3 === null ? null : r3.baseMin;
        const baseOk3 = nsBaseOk(base3);
        const v3Ok = r3 !== null && laneOk3 && kErr3 === null && cenOk3 && alignOk3 && a3Ok && n3Ok &&
            baseOk3 && cErr3 === null && r3.tEqual === true && r3.bits === 26;
        if (!v3Ok) {
            fails.push('V3 ' + (r3 === null ? 'worker FAIL: ' + e3 :
                'keys=' + (kErr3 === null ? 'ok' : kErr3) +
                ' census=' + (cen3 === null ? 'null' : cen3.join('/')) + ' (want >0 x4, bad 0)' +
                ' aligned=' + alignOk3 + ' bits=' + r3.bits +
                ' alloc bytesPerCall=' + b3 + ' settled=' + r3.settled +
                ' transient ' + (r3.excess === null ? 'not measured (null)' : 'excess ' + r3.excess + ' B per ' + NS_K +
                    ' ops (limit ' + NS_MAX_EXCESS + ')') +
                ' baseMin=' + base3 + (baseOk3 ? '' : ' (want 0..' + NS_BASE_MAX + ': the Worker empty-fn baseline' +
                    ' is out of range, a box could be calibrated away)') +
                ' counts ' + (cErr3 === null ? 'ok' : cErr3) + ' tEqualFresh=' + r3.tEqual) +
                (laneOk3 ? '' : ' laneParity=BAD (the Worker transient lane drifted from this file\'s nsLane)'));
        }
        console.log('V3 cycles=' + (ops3 / vw.V3_CYCLE) + ' ops=' + ops3 + ' U=' + vw.V3_U + ' keys=' + vw.V3_M +
            (r3 === null ? ' worker error=' + line1(e3) :
                ' (' + (kErr3 === null ? 'distinct, < U, 64 x 4 x 4' : 'BAD ' + kErr3) + ')' +
                ' byteLength=' + r3.byteLength +
                ' alloc=' + (b3 === null ? 'null' : Math.round(b3)) + ' B/op allocRaw=' + fmt(b3, 4) +
                ' transient=' + fmt(t3, 3) + ' B/op (limit ' + NS_MAX_EXCESS + ' B / ' + NS_K + ' ops)' +
                ' nsExcess=' + (r3.excess === null ? 'null' : r3.excess) +
                ' nsWin0=' + (r3.first === null ? 'null' : r3.first) +
                ' baseMin=' + base3 + ' (limit ' + NS_BASE_MAX + ')' +
                ' adds=' + cnt3[0] + ' deletes=' + cnt3[1] + ' refreshes=' + cnt3[2] + ' bad=' + cnt3[3] +
                ' census root m1/m2=' + (cen3 === null ? 'null' : cen3[0] + '/' + cen3[1] +
                    ' w16 m1/m2=' + cen3[2] + '/' + cen3[3] + ' w10 m1/m2=' + cen3[4] + '/' + cen3[5] +
                    ' bad=' + cen3[6]) +
                ' tEqualFresh=' + r3.tEqual) +
            ' laneParity=' + (laneOk3 ? 'ok' : 'BAD') + ' worker killMs=' + vw.KILL_MS +
            ' | ' + (v3Ok ? 'ok' : 'FAIL'));

        // ---- V4: keys >= 2^31 in the tree, U = 2^31 + 1 (transient only) ----------
        const v4 = vTier4(Veb);
        globalThis.gc();
        await settle(25);
        const t4 = v4.excess === null ? null : Math.max(0, v4.excess) / NS_K;
        const v4Ok = v4.pre && v4.post && v4.excess !== null && v4.valid >= 8 && v4.excess < NS_MAX_EXCESS;
        if (!v4Ok) {
            fails.push('V4 max=' + v4.top + ' (want ' + V4_TOP + ') byteLength=' + v4.byteLength +
                ' (want ' + V4_BYTES + ') answers=' + v4.pre + '/' + v4.post +
                ' size=' + v4.size0 + '/' + v4.size1 +
                ' transient ' + (v4.excess === null ? 'not measured (null)' : 'excess ' + v4.excess + ' B per ' +
                    NS_K + ' ops (limit ' + NS_MAX_EXCESS + ') valid=' + v4.valid + ' (want >= 8)'));
        }
        console.log('V4 U=' + V4_U + ' byteLength=' + v4.byteLength + ' max=' + v4.top + ' (cold, once)' +
            ' answers=' + (v4.pre && v4.post ? 'ok' : 'BAD') + ' size=' + v4.size0 + '/' + v4.size1 +
            ' transient=' + fmt(t4, 3) + ' B/op (limit ' + NS_MAX_EXCESS + ' B / ' + NS_K + ' ops)' +
            ' nsExcess=' + (v4.excess === null ? 'null' : v4.excess) +
            ' nsWin0=' + (v4.first === null ? 'null' : v4.first) +
            ' valid=' + (v4.valid === null ? 'null' : v4.valid) +
            ' | ' + (v4Ok ? 'ok' : 'FAIL'));

        // ---- CV controls (in-process ones last: their closures must not pollute
        // the feedback V1 / V2a were measured on) -------------------------------
        const vHold = [];
        const vRetainFn = function vRetain(i) { stepV1(i); vHold.push([i]); };
        const cv1 = measureAllocs(vRetainFn, { iterations: 20000, batches: 4 });
        const cv1Bpc = cv1.bytesPerCall;
        const cv1Flip = cv1Bpc !== null && Math.round(cv1Bpc) > 0;
        vHold.length = 0;

        const vRing = new Array(64).fill(null);
        const vBoxFn = function vBoxed(i) { stepV1(i); vRing[i & 63] = [i]; };
        const cv2 = nsExcess(vBoxFn);
        const cv2Flip = cv2 !== null && cv2.excess >= NS_MAX_EXCESS;

        const kickV = new Int32Array(1);
        const vGcKickFn = function vGcKick(i) {
            stepV1(i);
            if ((i & 65535) === 0) {
                globalThis.gc();
                kickV[0]++;
            }
        };
        const cv3 = await gcLane('V1 control gcKick', vGcKickFn, GC_KICK_OPS);
        const cv3Flip = !cv3.ok && cv3.majorHit && cv3.s.gc.major > 0 && kickV[0] === GC_KICKS;

        const box8 = { collected: 0, leaks: [], warns: [] };
        const bad8 = new Int32Array(1);
        const tracker8 = makeTracker('lite-loglogn-veb-control', box8);
        const held8 = [];
        churnV(tracker8, held8, Veb, bad8);
        const live8 = await drain(tracker8);
        const cv8Flip = live8 > 0;
        held8.length = 0;

        // CV5: V3's step factory + count check, deletes ascending (V3's Worker path).
        const j5c = await vw.startVebTorture({ src: null, kind: 'cv5' }, 'CV5');
        const e5c = vErr(j5c);
        const r5c = e5c === null ? j5c.result : null;
        const cnt5c = r5c === null ? null : r5c.cnt;
        const ops5c = vw.CV5_OPS;
        const cErr5c = cnt5c === null ? null : vw.v3CountErr(cnt5c, ops5c);
        const cv5Flip = cnt5c !== null && r5c.ops === ops5c && cErr5c !== null && cnt5c[2] !== cnt5c[1] &&
            cnt5c[1] === ops5c / 2 && cnt5c[3] === 0;

        // CV6: RetainOnRefresh (defined in the Worker) through V3's alloc lane, V3's Worker path.
        const j6c = await vw.startVebTorture({ src: null, kind: 'cv6' }, 'CV6');
        const e6c = vErr(j6c);
        const r6c = e6c === null ? j6c.result : null;
        const cv6Bpc = r6c === null ? null : r6c.bytesPerCall;
        const cv6Held = r6c === null ? null : r6c.held;
        const cv6Flip = cv6Bpc !== null && Math.round(cv6Bpc) > 0;

        // CV7 (measured inside vTier4 on V4's own instance).
        const cv7Flip = v4.c7 !== null && v4.c7 >= NS_MAX_EXCESS;

        // CV9 v3WorkerBox (measured inside the V3 Worker after V3's own lanes, on
        // V3's instance, same isolate and nsBase): one [i] every 8th op on V3's
        // step. Flips only if the excess over the Worker's baseline reaches
        // NS_MAX_EXCESS, baseMin is in range (nsBaseOk) AND the raw window
        // (excess + baseMin) clears the baseline ceiling (!nsBaseOk), so a blind
        // readout (node:v8 stub: 0 / 0) leaves it PASSED, and so does a baseline
        // outside nsBaseOk (a box hidden in the baseline), which also FAILS the V3
        // line's baseMin <= NS_BASE_MAX ceiling.
        const box9 = r3 === null ? null : r3.boxExcess;
        const boxValid9 = r3 === null ? null : r3.boxValid;
        const cv9Flip = Number.isInteger(box9) && box9 >= NS_MAX_EXCESS && baseOk3 && !nsBaseOk(box9 + base3);

        console.log('CV controls' +
            ' CV1 retain.alloc=' + (cv1Bpc === null ? 'null' : Math.round(cv1Bpc)) + ' B/op ' +
            (cv1Flip ? 'flipped' : 'PASSED') +
            ' CV2 box.nsExcess=' + (cv2 === null ? 'null' : cv2.excess) + ' B/' + NS_K + ' ' +
            (cv2Flip ? 'flipped' : 'PASSED') +
            ' CV3 gcKick.gcMajor=' + cv3.s.gc.major + ' kicks=' + kickV[0] + '/' + GC_KICKS +
            ' violations=' + cv3.errs.length + ' ' + (cv3Flip ? 'flipped' : 'PASSED') +
            ' CV4 perLevelNew.anchor=' + m4.n +
            (r4 === null ? ' error=' + e4 : ' abGrowth=' + r4.abGrowth + ' adds=' + r4.adds +
                ' perAdd=' + fmt(per4, 1) + ' B held=' + r4.held) + ' ' +
            (cv4Flip ? 'flipped' : 'PASSED') +
            ' CV5 ascDelete.refreshes=' + (cnt5c === null ? 'null error=' + line1(e5c) : cnt5c[2] + '/' + cnt5c[1]) +
            ' deletes ' +
            (cv5Flip ? 'flipped' : 'PASSED') +
            ' CV6 retainOnRefresh.alloc=' + (cv6Bpc === null ? 'null' : Math.round(cv6Bpc)) + ' B/op held=' +
            cv6Held + (e6c === null ? '' : ' error=' + line1(e6c)) + ' ' + (cv6Flip ? 'flipped' : 'PASSED') +
            ' CV7 bigSucc.nsExcess=' + (v4.c7 === null ? 'null' : v4.c7) + ' B/' + NS_K +
            ' valid=' + v4.c7valid + ' ' + (cv7Flip ? 'flipped' : 'PASSED') +
            ' CV8 retained.size=' + live8 + ' ' + (cv8Flip ? 'flipped' : 'PASSED') +
            ' CV9 v3WorkerBox.nsExcess=' + box9 + ' B/' + NS_K + ' raw=' +
            (Number.isInteger(box9) && Number.isInteger(base3) ? box9 + base3 : 'null') +
            ' (limit ' + NS_BASE_MAX + ') valid=' + boxValid9 + (r3 === null ? ' error=' + line1(e3) : '') + ' ' +
            (cv9Flip ? 'flipped' : 'PASSED') +
            ' | ' + (cv1Flip && cv2Flip && cv3Flip && cv4Flip && cv5Flip && cv6Flip && cv7Flip && cv8Flip &&
                cv9Flip ? 'ok' : 'FAIL'));
        if (!cv1Flip) fails.push('control CV1 retain PASSED its check (alloc ' + cv1Bpc + ' B/op): V1 alloc lane is blind');
        if (!cv2Flip) fails.push('control CV2 box PASSED its check: V1 transient lane is blind');
        if (!cv3Flip) {
            fails.push('control CV3 gcKick PASSED its check (gcMajor ' + cv3.s.gc.major + ', kicks ' +
                kickV[0] + '/' + GC_KICKS + ', violations ' + cv3.errs.length + '): V1 gc lane is blind');
        }
        if (!cv4Flip) {
            fails.push('control CV4 perLevelNew PASSED its check (' + (r4 === null ? e4 :
                'abGrowth ' + r4.abGrowth + ', adds ' + r4.adds + ', ' + fmt(per4, 1) + ' B per add, want >= ' +
                CV4_BYTES) + '): V2b worker abGrowth lane is blind');
        }
        if (!cv5Flip) {
            fails.push('control CV5 ascDelete PASSED its check (' + (cErr5c === null ?
                (e5c === null ? 'counts matched' : 'worker FAIL: ' + e5c) : cErr5c) +
                '): V3 refresh count is blind');
        }
        if (!cv6Flip) {
            fails.push('control CV6 RetainOnRefresh PASSED its check (alloc ' + cv6Bpc + ' B/op, held ' + cv6Held +
                (e6c === null ? '' : ', worker FAIL: ' + e6c) +
                '): V3 alloc lane is blind');
        }
        if (!cv7Flip) {
            fails.push('control CV7 bigSucc PASSED its check (nsExcess ' + v4.c7 + ', valid ' + v4.c7valid +
                '): V4 transient lane is blind');
        }
        if (!cv8Flip) fails.push('control CV8 retained PASSED its check (size ' + live8 + '): V5 is blind');
        if (!cv9Flip) {
            fails.push('control CV9 v3WorkerBox PASSED its check (nsExcess ' + box9 + ', baseMin ' + base3 +
                ', valid ' + boxValid9 + ', want excess >= ' + NS_MAX_EXCESS + ', baseMin in range 0..' +
                NS_BASE_MAX + ' and excess + baseMin > ' + NS_BASE_MAX + (r3 === null ? ', worker FAIL: ' + e3 : '') +
                '): V3 Worker transient lane is blind');
        }

        return {
            alloc: b1 === null || b2 === null || b3 === null ? null :
                Math.max(Math.round(b1), Math.round(b2), Math.round(b3)),
            allocSettled: al1.settled === true && al2.settled === true && r3 !== null && r3.settled === true,
            transient: t1 === null || t3 === null || t4 === null ? null : Math.max(t1, t3, t4),
            major: sV1.gc.major, minor: sV1.gc.minor, maxMs: sV1.gc.maxMs,
            abGrowth: rb === null ? null : rb.abGrowth,
            abSettled: rb !== null && rb.settled === true,
            refreshes: cnt3 === null ? null : cnt3[2],
            bigKeyExcess: v4.excess,
            live: live5, findings: findings5.length, warnings: box5.warns.length,
        };
    }

    let veb = null;
    if (typeof vEBTree !== 'function') {
        fails.push('veb: vEBTree export missing');
        console.log('V vEBTree export missing (pre-vEB build): V1-V5 / CV1-CV9 not run, veb=null | FAIL');
    } else {
        veb = await vebTiers(vEBTree);
    }
    if (veb !== null && (veb.alloc === null || veb.allocSettled !== true || veb.transient === null ||
        veb.abGrowth === null || veb.abSettled !== true || veb.bigKeyExcess === null || veb.refreshes === null)) {
        fails.push('veb GATE: a null / unsettled aggregate (alloc ' + veb.alloc + ' settled ' + veb.allocSettled +
            ', transient ' + veb.transient + ', abGrowth ' + veb.abGrowth + ' settled ' + veb.abSettled +
            ', bigKeyExcess ' + veb.bigKeyExcess + ', refreshes ' + veb.refreshes + ') is a FAIL, never a 0');
    }

    // ---- R: RoaringSet (PLAN-roaringset-G5 tasks 5-7, SPEC C-10 / C-11) ------
    // One Worker per (layout, family) job through test/_roaring-torture-worker.mjs
    // (startRoaringTorture: kill timer KILL_MS, never rejects, resolves
    // { result, error }). 18 jobs: direct and paged for each of ops 28 + gap 3 +
    // conv 6 + clear 1 + setops 5 + range 1 = 44 gated lanes (88) and for hi
    // (CV7-shape controls), ONE 'mixed' pair job (5 pair.* lanes, A direct,
    // B / C paged R_PAGED.pair: 93 gated lanes in all), ONE paged churn job
    // (lane churn.page, outside the 93, C-10 A10: gc maxMajor 0 only, its gc
    // maxMs REPORTED on its line; poolOk true), and retention direct + paged.
    // setops / pair lane names are exactly R_SETOPS_OPS under the family prefix;
    // the range lane is range.addRange (its excess per layout -> rangeExcess).
    // Paged knobs are torture's own R_PAGED copy,
    // JSON-checked against the worker's PAGED_KNOBS (a mismatch is a FAIL).
    // Every lane verdict is RE-DERIVED here from its raw fields (A-1), never
    // taken from the worker's own ok alone; a missing / null / non-array field
    // is a FAIL, never a pass. Lane names are keyed `layout:name` (direct and
    // paged post the same names). Controls: every name in R_CONTROLS must appear
    // in some job's controls[] and EVERY instance must have flipped === true; the
    // 4 boxing hi lanes per layout (A-3) are controls too; CR-dupSrc must be in
    // every job, CR-pageMap in the churn job, CR-setops.<fam> in the setops / pair
    // jobs, CR-addRange + CR-rangeArr in the range jobs. Retention (A-4): two retention-only
    // jobs (direct, paged R_PAGED.retention) each post a non-null retention
    // { layout, paged, universe, cycles, tracked, collected, size, after,
    // sizeAfterGc, findings, leaks, pagedMismatch, dumpBad, clearBad, rangeBad, ok }; every
    // other job posts null. CR-limit / CR-paged are extras (must flip). Torture
    // passes no --allow-natives-syntax: tf=UNCHECKED (C-11). A build without
    // the RoaringSet export fails closed: roaring=null on the GATE line, exit 1.
    const { RoaringSet } = await import('../LogLogN.js');
    // === worker FAMILY_LANES, key order included (JSON.stringify compare)
    const R_FAMILIES = { ops: 28, gap: 3, conv: 6, clear: 1, churn: 1, setops: 5, pair: 5, range: 1 };
    const R_G1 = ['ops', 'gap', 'conv', 'clear'];
    const R_BOTH = R_G1.concat(['setops', 'range']);                       // lane families run direct AND paged
    const R_LANES = 2 * R_BOTH.reduce((a, f) => a + R_FAMILIES[f], 0) + R_FAMILIES.pair;   // 93: 2 x 44 + 5 mixed
    const R_CHURN = R_FAMILIES.churn;                                       // 1: churn.page, outside the 93
    const R_SETOPS_OPS = ['intersects.hit', 'intersects.miss', 'intersectionSize', 'unionSize', 'differenceSize'];
    const R_CONTROLS = ['CR-dupSrc', 'CR-box', 'CR-has', 'CR-conv', 'CR-abConv', 'CR-gcKick', 'CR-retain', 'CR-pageMap',
        'CR-setops', 'CR-addRange', 'CR-rangeArr'];
    const R_HI_BOX = ['successor', 'predecessor', 'min', 'max'];
    const R_HI_OPS = ['has', 'successor', 'predecessor', 'min', 'max'];
    const R_RET_CYCLES = 4096;
    const R_RET_TRACKED = 3 * R_RET_CYCLES;     // instance + its dump() + the addRange twin B per cycle (S-10)
    // === worker PAGED_KNOBS (SPEC S-4): every paged job strictly paged under C-5
    const R_PAGED = {
        ops: { maxPages: 4, pageBits: 1 }, gap: { maxPages: 4, pageBits: 8 }, conv: { maxPages: 4, pageBits: 1 },
        clear: { maxPages: 4, pageBits: 1 }, hi: { maxPages: 4, pageBits: 8 }, churn: { maxPages: 254, pageBits: 8 },
        retention: { maxPages: 2, pageBits: 8 }, setops: { maxPages: 4, pageBits: 8 }, pair: { maxPages: 4, pageBits: 8 },
        range: { maxPages: 4, pageBits: 8 },
    };
    const R_RET_UNIVERSE = { direct: 1048576, paged: 4294967296 };

    // Key-order-free JSON (object keys sorted at every depth). Cold.
    function rCanon(v) {
        return JSON.stringify(v, (k, x) => (x !== null && typeof x === 'object' && !Array.isArray(x)
            ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));
    }

    // A name matches a required control when equal, or when it extends it
    // with a separator ('CR-box.ops', 'CR-box ops', 'CR-box:ops'). Cold.
    function rCtlMatch(name, want) {
        return name === want || (name.length > want.length && name.startsWith(want) &&
            '.:/ ('.includes(name.charAt(want.length)));
    }

    // null when the lane passes every A-1 channel, else the first reason. Cold.
    function rLaneWhy(l, fam, tf) {
        if (l === null || typeof l !== 'object') return 'lane record missing';
        if (l.error) return 'error ' + line1(l.error);
        if (l.pagedOk !== true) return 'paged ' + l.pagedOk;
        if (!(typeof l.retainedBpc === 'number' && Math.round(l.retainedBpc) === 0) || l.retainedSettled !== true) {
            return 'retained ' + l.retainedBpc + ' B/call settled ' + l.retainedSettled;
        }
        if (!(typeof l.nsExcess === 'number' && l.nsExcess < NS_MAX_EXCESS)) {
            return 'transient excess ' + l.nsExcess + ' B/' + NS_K + ' (limit < ' + NS_MAX_EXCESS + ')';
        }
        if (l.gcMajor !== 0 || l.gcOk !== true) return 'gc major ' + l.gcMajor + ' ok ' + l.gcOk;
        if (l.abGrowth !== 0 || l.abSettled !== true || l.abOk !== true) {
            return 'abGrowth ' + l.abGrowth + ' settled ' + l.abSettled;
        }
        if (l.restoreOk !== true) return 'restore ' + l.restoreOk;
        if (l.kindsOk !== true) return 'kinds ' + l.kindsOk;
        const wantWork = fam === 'ops' || fam === 'gap' || fam === 'setops' || fam === 'pair' || fam === 'range';
        const wantEdges = fam === 'conv' || fam === 'clear' || fam === 'churn' || fam === 'range';
        if (wantWork ? l.workOk !== true : l.workOk !== null) return 'work ' + l.workOk;
        if (wantEdges ? l.edgesOk !== true : l.edgesOk !== null) return 'edges ' + l.edgesOk;
        if (fam === 'churn' ? l.poolOk !== true : l.poolOk !== null) return 'poolOk ' + l.poolOk;
        if (tf === 'UNCHECKED' ? l.optOk !== null : l.optOk !== true) return 'opt ' + l.optOk + ' (tf ' + tf + ')';
        if (l.ok !== true) return 'worker verdict ' + l.ok;
        return null;
    }

    async function roaringTiers(rw) {
        const agg = { lanesOk: 0, churnOk: 0, churnMaxMs: null, ctlOk: 0, ctlWant: R_CONTROLS.length + 2 * R_HI_BOX.length,
            hiEx: { direct: [null, null, null, null], paged: [null, null, null, null] }, rangeEx: { direct: null, paged: null },
            leak: null, tf: 'null' };
        const f0 = fails.length;
        const consts = [['NS_K', rw.NS_K, NS_K], ['NS_W', rw.NS_W, NS_W], ['NS_MAX_EXCESS', rw.NS_MAX_EXCESS, NS_MAX_EXCESS]];
        for (const c of consts) {
            if (c[1] !== c[2]) fails.push('R constant ' + c[0] + ': worker ' + c[1] + ' !== torture ' + c[2]);
        }
        if (rw.RET_CYCLES !== R_RET_CYCLES) fails.push('R constant RET_CYCLES: worker ' + rw.RET_CYCLES + ' !== torture ' + R_RET_CYCLES);
        const fl = rw.FAMILY_LANES;
        if (fl === null || typeof fl !== 'object' || JSON.stringify(fl) !== JSON.stringify(R_FAMILIES)) {
            fails.push('R FAMILY_LANES ' + JSON.stringify(fl) + ' !== torture ' + JSON.stringify(R_FAMILIES));
        }
        const pk = rw.PAGED_KNOBS;
        if (pk === null || typeof pk !== 'object' || rCanon(pk) !== rCanon(R_PAGED)) {
            fails.push('R PAGED_KNOBS ' + rCanon(pk) + ' !== torture R_PAGED ' + rCanon(R_PAGED));
        }
        if (typeof rw.startRoaringTorture !== 'function' || !Number.isInteger(rw.KILL_MS) || !(rw.KILL_MS > 0)) {
            fails.push('R worker contract: startRoaringTorture / KILL_MS missing');
            console.log('R RoaringSet worker contract missing: no job run | FAIL');
            return agg;
        }
        const seen = [];            // { name, flipped, label }
        const laneNames = new Set();
        const rets = [];
        const tfs = new Set();
        const tR = Date.now();
        const rJobs = [];
        for (const lay of ['direct', 'paged']) {
            for (const f of R_G1.concat(['hi', 'setops', 'range'])) {
                rJobs.push({ fam: f, layout: lay, paged: lay === 'direct' ? null : R_PAGED[f], label: 'R ' + lay + '-' + f });
            }
        }
        rJobs.push({ fam: 'pair', layout: 'mixed', paged: R_PAGED.pair, label: 'R mixed-pair' });
        rJobs.push({ fam: 'churn', layout: 'paged', paged: R_PAGED.churn, label: 'R paged-churn' });
        rJobs.push({ fam: 'retention', layout: 'direct', paged: null, label: 'R direct-retention' });
        rJobs.push({ fam: 'retention', layout: 'paged', paged: R_PAGED.retention, label: 'R paged-retention' });
        for (const rj of rJobs) {
            const fam = rj.fam;
            const label = rj.label;
            const tJ = Date.now();
            const job = await rw.startRoaringTorture({ src: null, families: [fam], paged: rj.paged }, label, rw.KILL_MS);
            const wall = ((Date.now() - tJ) / 1000).toFixed(1) + ' s';
            const r = job === null || typeof job !== 'object' ? null : job.result;
            if (job === null || typeof job !== 'object' || job.error !== null || r === null || typeof r !== 'object') {
                const why = job === null || typeof job !== 'object' ? 'no job record' :
                    job.error !== null ? line1(job.error) : 'worker posted no result';
                fails.push(label + ': ' + why);
                console.log(label + ' ' + why + ' ' + wall + ' | FAIL');
                if (fam === 'hi') for (const op of R_HI_BOX) fails.push('control ' + rj.layout + ' hi.' + op + ' absent: hi job FAILED');
                continue;
            }
            const fj = fails.length;
            if (Array.isArray(r.lines)) for (const s of r.lines) console.log(label + ' ' + s);
            else fails.push(label + ': lines field absent');
            if (r.NS_K !== NS_K || r.NS_W !== NS_W || r.NS_MAX_EXCESS !== NS_MAX_EXCESS) {
                fails.push(label + ': posted constants ' + r.NS_K + ' / ' + r.NS_W + ' / ' + r.NS_MAX_EXCESS +
                    ' !== torture ' + NS_K + ' / ' + NS_W + ' / ' + NS_MAX_EXCESS);
            }
            if (!Array.isArray(r.families) || r.families.length !== 1 || r.families[0] !== fam) {
                fails.push(label + ': families ' + JSON.stringify(r.families) + ' !== [' + fam + ']');
            }
            if (r.wantPaged !== (rj.paged !== null)) fails.push(label + ': wantPaged ' + r.wantPaged + ' (job paged ' + JSON.stringify(rj.paged) + ')');
            if (r.dupSrc !== 0) fails.push(label + ': selfcheck dupSrc ' + r.dupSrc + ' (want 0)');
            if (r.tf !== 'UNCHECKED' && r.tf !== 'CHECKED') fails.push(label + ': tf ' + r.tf);
            tfs.add(r.tf);
            if (fam === 'hi') {
                if (!Array.isArray(r.lanes) || r.lanes.length !== 0) fails.push(label + ': gated lanes in the hi job');
                const h = r.hi;
                const hl = h !== null && typeof h === 'object' && Array.isArray(h.lanes) ? h.lanes : null;
                if (hl === null || hl.length !== R_HI_OPS.length || h.shareOk !== true) {
                    fails.push(label + ': hi field ' + (hl === null ? 'absent' : hl.length + ' lanes, shareOk ' + h.shareOk));
                }
                for (let i = 0; i < R_HI_OPS.length; i++) {
                    const op = R_HI_OPS[i];
                    const l = hl === null ? undefined : hl.find((x) => x !== null && typeof x === 'object' && x.op === op);
                    const ex = l !== undefined && typeof l.nsExcess === 'number' ? l.nsExcess : null;
                    const sound = l !== undefined && !l.error && l.pagedOk === true && l.restoreOk === true && l.workOk === true &&
                        (r.tf === 'UNCHECKED' ? l.optOk === null : l.optOk === true);
                    if (op === 'has') {
                        if (!(sound && ex !== null && ex < NS_MAX_EXCESS)) {
                            fails.push(label + ': hi.has transient excess ' + ex + ' B/' + NS_K + ' (want < ' + NS_MAX_EXCESS + ')');
                        }
                        continue;
                    }
                    agg.hiEx[rj.layout][i - 1] = ex;
                    if (sound && hl !== null && h.shareOk === true && ex !== null && ex >= NS_MAX_EXCESS) agg.ctlOk++;
                    else {
                        fails.push('control ' + rj.layout + ' hi.' + op + ' PASSED its check (excess ' + ex + ' B/' + NS_K + ', want >= ' +
                            NS_MAX_EXCESS + ', shareOk ' + (hl === null ? 'null' : h.shareOk) + '): R hi lane is blind');
                    }
                }
            } else if (fam === 'retention') {
                if (!Array.isArray(r.lanes) || r.lanes.length !== 0) fails.push(label + ': gated lanes in a retention job');
                if (r.hi !== null) fails.push(label + ': hi field in a retention job');
            } else {
                if (r.hi !== null) fails.push(label + ': hi field in a ' + fam + ' job');
                const ls = Array.isArray(r.lanes) ? r.lanes : null;
                if (ls === null || ls.length !== R_FAMILIES[fam]) {
                    fails.push(label + ': lanes ' + (ls === null ? 'absent' : ls.length) + ' (want ' + R_FAMILIES[fam] + ')');
                }
                if (ls !== null) {
                    for (const l of ls) {
                        const nm = l !== null && typeof l === 'object' && typeof l.name === 'string' ? l.name : '?';
                        const key = rj.layout + ':' + nm;
                        if (nm === '?' || laneNames.has(key)) {
                            fails.push(label + ': lane name ' + key + ' missing or duplicate');
                            continue;
                        }
                        laneNames.add(key);
                        const why = fam === 'churn' && nm !== 'churn.page' ? 'churn lane name ' + nm + ' (want churn.page)' :
                            fam === 'range' && nm !== 'range.addRange' ? 'range lane name ' + nm + ' (want range.addRange)' :
                                (fam === 'setops' || fam === 'pair') && !R_SETOPS_OPS.some((o) => nm === fam + '.' + o) ?
                                    fam + ' lane name ' + nm + ' (want ' + fam + '.{' + R_SETOPS_OPS.join(', ') + '})' : rLaneWhy(l, fam, r.tf);
                        if (fam === 'churn') agg.churnMaxMs = typeof l.gcMaxMs === 'number' ? l.gcMaxMs : null;
                        if (fam === 'range' && nm === 'range.addRange') agg.rangeEx[rj.layout] = typeof l.nsExcess === 'number' ? l.nsExcess : null;
                        if (why === null) {
                            if (fam === 'churn') agg.churnOk++;
                            else agg.lanesOk++;
                        } else fails.push(label + ' lane ' + nm + ': ' + why);
                    }
                }
            }
            if (!Array.isArray(r.controls)) fails.push(label + ': controls field absent -> FAIL');
            else {
                let dup = 0;
                for (const c of r.controls) {
                    const nm = c !== null && typeof c === 'object' && typeof c.name === 'string' ? c.name : '?';
                    const flipped = nm !== '?' && c.flipped === true;
                    seen.push({ name: nm, flipped, label });
                    if (nm === 'CR-dupSrc') dup++;
                    if (!flipped) {
                        fails.push('control ' + nm + ' PASSED its check (' + label + ', value ' +
                            (nm === '?' ? 'n/a' : c.value) + ', want ' + (nm === '?' ? 'n/a' : c.want) + ')');
                    }
                }
                if (dup !== 1) fails.push(label + ': CR-dupSrc instances ' + dup + ' (want 1 per job)');
                // per-job must-fail set: a control missing from ITS job is a FAIL even when another job posts the name
                const rWant = ['CR-dupSrc', 'CR-limit'].concat(fam === 'retention' ? ['CR-retain'] :
                    ['CR-paged', 'CR-box.' + fam, 'CR-gcKick'].concat(fam === 'ops' || fam === 'gap' || fam === 'hi' ? ['CR-has.' + fam] : [],
                        fam === 'conv' ? ['CR-conv', 'CR-abConv'] : [], fam === 'churn' ? ['CR-pageMap'] : [],
                        fam === 'setops' || fam === 'pair' ? ['CR-setops.' + fam] : [], fam === 'range' ? ['CR-addRange', 'CR-rangeArr'] : []));
                for (const w of rWant) {
                    const n = r.controls.filter((c) => c !== null && typeof c === 'object' && c.name === w).length;
                    if (n !== 1) fails.push(label + ': control ' + w + ' instances ' + n + ' (want 1 in this job)');
                }
            }
            if (r.retention === undefined) fails.push(label + ': retention field absent -> FAIL');
            else if (fam !== 'retention') {
                if (r.retention !== null) fails.push(label + ': retention posted by a ' + fam + ' job');
            } else if (r.retention === null) fails.push(label + ': retention null in a retention job -> FAIL');
            else rets.push({ label, ret: r.retention, layout: rj.layout });
            if (r.ok !== true) {
                fails.push(label + ': worker verdict ' + r.ok + ' (fail: ' +
                    (Array.isArray(r.fail) ? r.fail.join(', ') : 'list absent') + ')');
            }
            console.log(label + ' job ' + wall + ' | ' + (fails.length === fj ? 'ok' : 'FAIL'));
        }
        for (const want of R_CONTROLS) {
            const hit = seen.filter((c) => rCtlMatch(c.name, want));
            if (hit.length === 0) fails.push('control ' + want + ' absent: no job posted it -> FAIL');
            else if (hit.every((c) => c.flipped)) agg.ctlOk++;
        }
        if (agg.lanesOk !== R_LANES || agg.churnOk !== R_CHURN || agg.ctlOk !== agg.ctlWant) {
            fails.push('R counts: lanes ' + agg.lanesOk + '/' + R_LANES + ' churn ' + agg.churnOk + '/' + R_CHURN +
                ' ctl ' + agg.ctlOk + '/' + agg.ctlWant + ' -> FAIL');
        }
        const extra = seen.filter((c) => !R_CONTROLS.some((w) => rCtlMatch(c.name, w)));
        if (rets.length !== 2) {
            fails.push('R retention: ' + rets.length + ' of 2 layouts posted (' + rets.map((x) => x.layout).join(', ') + ') -> FAIL');
        }
        let leak = rets.length === 0 ? null : 0;
        for (const x of rets) {
            const t = x.ret;
            const knob = x.layout === 'direct' ? null : R_PAGED.retention;
            const good = typeof t === 'object' && t.layout === x.layout && t.universe === R_RET_UNIVERSE[x.layout] &&
                rCanon(t.paged) === rCanon(knob) && t.cycles === R_RET_CYCLES &&
                t.tracked === R_RET_TRACKED && t.collected === R_RET_TRACKED && t.size === 0 && t.after === 0 &&
                t.sizeAfterGc === 0 && t.findings === 0 && t.leaks === 0 && Number.isInteger(t.warnings) &&
                t.pagedMismatch === 0 && t.dumpBad === 0 && t.clearBad === 0 && t.rangeBad === 0 && t.ok === true;
            if (leak !== null) leak = Number.isInteger(t.size) ? leak + t.size : null;
            if (!good) {
                fails.push(x.label + ': retention ' + JSON.stringify(t) + ' (want layout ' + x.layout + ', universe ' +
                    R_RET_UNIVERSE[x.layout] + ', paged ' + rCanon(knob) + ', cycles ' + R_RET_CYCLES + ', tracked = collected = ' +
                    R_RET_TRACKED + ', size / after / sizeAfterGc / findings / leaks / pagedMismatch / dumpBad / clearBad / rangeBad 0, ok true)');
            }
        }
        agg.leak = leak;
        agg.tf = tfs.size === 1 && (tfs.has('UNCHECKED') || tfs.has('CHECKED')) ? [...tfs][0] : 'null';
        if (agg.tf === 'null') fails.push('R tf: jobs disagree or none ran (' + [...tfs].join(', ') + ')');
        const hiFmt = (a) => a.map((v) => (v === null ? 'null' : v)).join('/');
        const rangeFmt = hiFmt([agg.rangeEx.direct, agg.rangeEx.paged]);
        console.log('R RoaringSet lanes=' + agg.lanesOk + '/' + R_LANES + ' churn=' + agg.churnOk + '/' + R_CHURN +
            ' (churn.page gc maxMs=' + (agg.churnMaxMs === null ? 'null' : agg.churnMaxMs.toFixed(2)) + ' REPORTED)' +
            ' ctl=' + agg.ctlOk + '/' + agg.ctlWant +
            ' (extra ' + extra.filter((c) => c.flipped).length + '/' + extra.length + ')' +
            ' hiExcess=' + hiFmt(agg.hiEx.direct) + ' hiPaged=' + hiFmt(agg.hiEx.paged) + ' B/' + NS_K +
            ' rangeExcess=' + rangeFmt + ' B/' + NS_K +
            ' retention=' + rets.length + '/2 (' + rets.map((x) => x.layout + ' size ' + x.ret.size + ' warnings ' + x.ret.warnings).join(', ') + ')' +
            ' leak=size ' + leak + '/0 tf=' + agg.tf + ' wall=' + ((Date.now() - tR) / 1000).toFixed(1) + ' s' +
            ' | ' + (fails.length === f0 ? 'ok' : 'FAIL'));
        return agg;
    }

    let roar = null;
    if (typeof RoaringSet !== 'function') {
        fails.push('roaring: RoaringSet export missing');
        console.log('R RoaringSet export missing (pre-0.6.0 build): R lanes / controls / retention not run, roaring=null | FAIL');
    } else {
        roar = await roaringTiers(await import('./_roaring-torture-worker.mjs'));
    }

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
        ' | xft leak=size ' + liveX3 + '/0 findings=' + findingsX3.length +
        ' warnings=' + boxX3.warns.length +
        ' gc major=' + Math.max(x0a.major, x0b.major) + ' minor=' + (x0a.minor + x0b.minor) +
        ' maxMs=' + Math.max(x0a.maxMs, x0b.maxMs).toFixed(2) +
        ' alloc=' + (xAlloc === Infinity ? 'null' : xAlloc) + ' B/op' +
        ' transient=' + fmt(xTrans, 3) + ' B/op' +
        ' abGrowth=' + xAb +
        ' reseedExcess=' + (x2c.excess === null || x2d.excess === null ? 'null' :
            Math.max(x2c.excess, x2d.excess)) + ' B/' + XNS_K +
        ' kicks=+' + x2a.f1 + ' rebuilds=+' + x2b.f3 + ' reseedOps=+' + (x2a.f2 + x2b.f2) +
        ' | yft leak=size ' + liveY3 + '/0 findings=' + findingsY3.length +
        ' warnings=' + boxY3.warns.length +
        ' gc major=' + Math.max(y0a.major, y0b.major) + ' minor=' + (y0a.minor + y0b.minor) +
        ' maxMs=' + Math.max(y0a.maxMs, y0b.maxMs).toFixed(2) +
        ' alloc=' + (yAlloc === Infinity ? 'null' : yAlloc) + ' B/op' +
        ' transient=' + fmt(yTrans, 3) + ' B/op' +
        ' abGrowth=' + yAb +
        ' stormExcess=' + (y1c.excess === null ? 'null' : y1c.excess) + ' B/' + YNS_K +
        ' splits=+' + y1.f0 + ' merges=+' + y1.f1 + ' borrows=+' + y1.f2 +
        ' Y1b borrowExcess=' + (y1bt.excess === null ? 'null' : y1bt.excess) + ' B/' + YB_NS_K +
        ' splits=+' + y1b.f0 + ' merges=+' + y1b.f1 + ' borrows=+' + y1b.f2 +
        (veb === null ? ' | veb=null' :
            ' | veb leak=size ' + veb.live + '/0 findings=' + veb.findings +
            ' warnings=' + veb.warnings +
            ' gc major=' + veb.major + ' minor=' + veb.minor +
            ' maxMs=' + veb.maxMs.toFixed(2) +
            ' alloc=' + (veb.alloc === null ? 'null' : veb.alloc) + ' B/op' +
            ' transient=' + fmt(veb.transient, 3) + ' B/op' +
            ' abGrowth=' + (veb.abGrowth === null ? 'null' : veb.abGrowth) +
            ' refreshes=+' + veb.refreshes +
            ' bigKeyExcess=' + (veb.bigKeyExcess === null ? 'null' : veb.bigKeyExcess) + ' B/' + NS_K) +
        (roar === null ? ' | roaring=null' :
            ' | roaring lanes=' + roar.lanesOk + '/' + R_LANES + ' churn=' + roar.churnOk + '/' + R_CHURN +
            ' ctl=' + roar.ctlOk + '/' + roar.ctlWant +
            ' hiExcess=' + roar.hiEx.direct.map((v) => (v === null ? 'null' : v)).join('/') +
            ' hiPaged=' + roar.hiEx.paged.map((v) => (v === null ? 'null' : v)).join('/') +
            ' rangeExcess=' + (roar.rangeEx.direct === null ? 'null' : roar.rangeEx.direct) + '/' +
            (roar.rangeEx.paged === null ? 'null' : roar.rangeEx.paged) +
            ' leak=size ' + (roar.leak === null ? 'null' : roar.leak) + '/0 tf=' + roar.tf) +
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
