/**
 * @zakkster/lite-loglogn -- torture gate.
 *
 *     node --expose-gc test/torture.mjs
 *
 * Two jobs, kept separate (torture-harness skill):
 *   - @zakkster/lite-leak       -- retention: does a member instance outlive its
 *                                  owner? tracker.size() -> 0 is the proof.
 *   - @zakkster/lite-gc-profiler -- budget: does V8 collect where it must not,
 *                                   and does the hot path allocate? 0 B/op,
 *                                   maxMajor 0, maxPauseMs <= 4 is the gate.
 *
 * v0.1.0 is the SCAFFOLD release: there is NO member yet, so this harness runs
 * GREEN and EMPTY. Phase 1 (retention) tracks nothing and tracker.size() stays
 * 0; phase 2 (GC budget) profiles a plain integer accumulator that allocates
 * nothing, so alloc = 0 B/op and gc major = 0. The StratifiedBitset session
 * fills both phases in place: phase 1 tracks a member instance per churn cycle
 * (cleanup MUST NOT close over the tracked instance -- the held-value contract),
 * phase 2 steps a single out-of-loop instance's successor / predecessor / add /
 * delete and gates 0 B/op via measureAllocs, plus the arrayBuffers-no-growth tier
 * (T1) that catches a level-table rehash -- this family lives in typed-array
 * backing stores outside the V8 heap where a heap-growth gate alone is blind.
 * Never widen a budget to make this pass -- a budget that moves is not a gate.
 *
 * ENTRY CONTRACT: --expose-gc is mandatory (the GC gate is meaningless without
 * it); the devDeps are imported AFTER the guard so a fresh clone that skipped
 * `npm install` fails with a remedy, not a stack trace.
 */

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
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

    const { GcProfiler, checkNoGc, measureAllocs } =
        await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    // >>> WIRE: the members under test. None at v0.1.0 (scaffold).
    const { VERSION } = await import('../LogLogN.js');

    const CYCLES = 4096;    // retention churn (StratifiedBitset fills the body)
    const HOT = 2000000;    // steady-state ops

    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-loglogn',
        onLeak: (r) => leaks.push(r.kind + ':' + String(r.tag)),
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });
    // No kernels: an array-embedded member owns only its typed arrays (no timer,
    // listener, observer, or DOM node), so being collected is the DESIRED
    // outcome, not a resource orphan. The retention proof is finalization
    // itself -- tracker.size() returning to 0.

    // ---- phase 1: retention torture ---------------------------------------
    // Scaffold: no member to construct, so the churn body is empty and the
    // tracker holds nothing. StratifiedBitset replaces this with a
    // `new StratifiedBitset` per cycle, tracked with a cleanup that closes over
    // NOTHING.
    function fillTracker() {
        for (let i = 0; i < CYCLES; i++) {
            // no member yet -- nothing constructed, nothing tracked
        }
        return tracker.size();
    }
    fillTracker();

    // Drain: FinalizationRegistry callbacks run on their own task. Loop gc + a
    // macrotask turn until the tracker empties (bounded, so a genuine retention
    // still fails). At v0.1.0 it is already empty.
    let live = tracker.size();
    for (let g = 0; g < 20 && live > 0; g++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 25));
        live = tracker.size();
    }
    const findings = tracker.audit();

    // ---- phase 2a: per-call allocation on the hot path (0 B/op) ------------
    // Scaffold: no member hot op exists, so the measured step is a plain int
    // accumulator (zero allocation). StratifiedBitset replaces `step` with an
    // out-of-loop instance's successor / predecessor and asserts
    // bytesPerCall === 0.
    let acc = VERSION.length | 0;
    const step = () => { acc = (acc + 1) | 0; };
    const allocRes = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = allocRes.bytesPerCall === null ? 0 : allocRes.bytesPerCall;
    const allocBytes = Math.max(0, Math.round(bpc));
    const allocOk = allocBytes === 0;

    // ---- phase 2b: GC budget over a steady-state window --------------------
    const gc = new GcProfiler().start();
    let sink = acc | 0;
    for (let i = 0; i < HOT; i++) {
        sink = (sink + i) | 0;
        if ((i & 8191) === 0) {
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
    }
    await new Promise((r) => setTimeout(r, 50));
    const s2 = gc.summary();
    const report = checkNoGc(s2, { maxMajor: 0, maxPauseMs: 4 });
    gc.stop();

    // ---- phase 2c: arrayBuffers must not grow (T1) -------------------------
    // The family's blind-spot gate: lite-gc-profiler documents a ~152x blind spot
    // on ArrayBuffer backing stores outside the V8 heap -- where every one of this
    // package's structures lives. Scaffold: no backing store to grow.
    // StratifiedBitset fills / clears its bit tree in a loop here and asserts
    // arrayBuffers grows by 0.
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 50));
    globalThis.gc();
    const abBefore = process.memoryUsage().arrayBuffers;
    // no member: nothing allocates a backing store
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0;

    // ---- verdict + GATE line ----------------------------------------------
    const ok = report.ok && live === 0 && leaks.length === 0 &&
        findings.length === 0 && allocOk && abOk;

    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=' + warns.length +
        ' | gc major=' + s2.gc.major + ' minor=' + s2.gc.minor +
        ' maxMs=' + s2.gc.maxMs.toFixed(2) +
        ' | alloc=' + allocBytes + ' B/op' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (scaffold: no member; sink=' + sink + ' abGrowth=' + abDelta + ')');

    if (!ok) {
        for (const v of report.violations) {
            console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        }
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        for (const l of leaks) console.error('  leak ' + l);
        if (!allocOk) console.error('  alloc ' + allocBytes + ' B/op scaffold-step (raw bytesPerCall ' + bpc + ')');
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
