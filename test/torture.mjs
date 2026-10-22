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
 * KNOWN GAP: maxPauseMs has no must-fail control (a pause is host timing); the gc kick pins maxMajor only.
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

    // The T0 / X0 gc-budget lane: gc() + settle, then `ops` calls of fn inside
    // one GcProfiler window (heap sampled every 8,192 ops), settle, verdict
    // checkNoGc { maxMajor: 0, maxPauseMs: 4 }. errs = the violation strings,
    // [] = pass. The real lanes and their must-fail gc controls (T3 gcKick, X4
    // xGcKick) run through this ONE code path, so a control that flips proves
    // this window and verdict can fail. Cold wrapper.
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
        const rep = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
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

    const xAlloc = Math.max(x0a.b === null ? Infinity : Math.round(x0a.b),
        x0b.b === null ? Infinity : Math.round(x0b.b),
        x2a.b === null ? Infinity : Math.round(x2a.b),
        x2b.b === null ? Infinity : Math.round(x2b.b));
    const xTrans = x0a.t === null || x0b.t === null ? null : Math.max(x0a.t, x0b.t);
    const xAb = Math.max(abx1.growthBytes, x2a.ab, x2b.ab);

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
