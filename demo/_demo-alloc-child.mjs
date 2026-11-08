// @zakkster/lite-loglogn -- demo zero-alloc child (repo-only fixture for demo/Demo.test.mjs, ASSERTION 1).
//
//   node --expose-gc --max-semi-space-size=1 --min-semi-space-size=1 demo/_demo-alloc-child.mjs <U> <n>
//
// Counts MINOR GCs (scavenges) and, as a 5th field, MAJOR + INCREMENTAL GCs (retained per-op garbage is pretenured) per window with a PerformanceObserver, with NO forced gc inside a window.
// Output lines the parent parses (a missing GCMARK line is a FAIL, never a skip):
//   GCMARK start | GCMARK done
//   RESULT <label> <ops> <scavenges> <majors>     (majors = MAJOR + INCREMENTAL GCs; labels: step1 step8 batch<m> size<m> control sizectl majctl)
//   SKIP <label>

import { PerformanceObserver, constants } from 'node:perf_hooks';

const gcFn = globalThis.gc;
if (typeof gcFn !== 'function') {
    process.stdout.write('GCMARK missing\n');
    process.exit(3);
}
process.stdout.write('GCMARK start\n');

const U = Number(process.argv[2]);
const N = Number(process.argv[3]);
const SEED = 0xC0FFEE;

let scav = 0;
let majors = 0;
function count(entries) {
    for (const e of entries) {
        const kind = e.detail !== undefined && e.detail !== null ? e.detail.kind : e.kind;
        if (kind === constants.NODE_PERFORMANCE_GC_MINOR) scav++;
        else if (kind === constants.NODE_PERFORMANCE_GC_MAJOR || kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) majors++;
    }
}
const obs = new PerformanceObserver((list) => count(list.getEntries()));
obs.observe({ entryTypes: ['gc'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const V = await import(new URL('./Visualize.mjs', import.meta.url).href);
const { Treap } = await import('@zakkster/lite-logn');
const e = V.createEngine({ kind: 'mixed', seed: SEED, U, n: N }, Treap);

// warm every path (JIT tier-up allocations are not the steady state)
for (let i = 0; i < (1 << 16); i++) V.step(e);
for (let m = 0; m <= 5; m++) {
    if (V.bytesOf(e, m) === null) continue;
    for (let r = 0; r < 200; r++) V.runBatch(e, m, V.BATCH);
}

async function win(label, ops, fn) {
    gcFn();
    await sleep(60);
    count(obs.takeRecords());
    scav = 0;
    majors = 0;
    fn();
    await sleep(120);
    count(obs.takeRecords());
    process.stdout.write('RESULT ' + label + ' ' + ops + ' ' + scav + ' ' + majors + '\n');
}

const N1 = 1 << 20;
await win('step1', N1, () => { for (let i = 0; i < N1; i++) V.step(e); });
await win('step8', N1 * 8, () => { for (let i = 0; i < N1 * 8; i++) V.step(e); });

const reps = Math.ceil(N1 / V.BATCH);
for (let m = 0; m <= 5; m++) {
    if (V.bytesOf(e, m) === null) {
        process.stdout.write('SKIP batch' + m + '\n');
        continue;
    }
    await win('batch' + m, reps * V.BATCH, () => { for (let r = 0; r < reps; r++) V.runBatch(e, m, V.BATCH); });
}

// sizeOf allocates 0 B (A9): 2^20 calls per member (the sum stays a Smi: no boxing in the harness itself).
let acc = 0;
for (let m = 0; m <= 5; m++) {
    if (V.sizeOf(e, m) === null) {
        process.stdout.write('SKIP size' + m + '\n');
        continue;
    }
    await win('size' + m, N1, () => { for (let i = 0; i < N1; i++) acc = (acc + V.sizeOf(e, m)) & 0xFFFFFF; });
}
// CONTROL for the sizeOf windows: a small object per call must be caught by the same machinery.
const sinkS = new Array(8).fill(null);
await win('sizectl', N1, () => { for (let i = 0; i < N1; i++) { acc = (acc + V.sizeOf(e, 0 + (i & 1))) & 0xFFFFFF; sinkS[i & 7] = {}; } });
if (sinkS[0] === 42 || acc === -1) process.stdout.write('unreachable\n');

// CONTROL: one small object per step must be caught by the same window machinery.
const sink = new Array(8).fill(null);
await win('control', N1, () => { for (let i = 0; i < N1; i++) { V.step(e); sink[i & 7] = {}; } });
if (sink[0] === 42) process.stdout.write('unreachable\n');
// CONTROL for the majors field: one RETAINED object per step must be seen as >= 1 MAJOR / INCREMENTAL GC.
let chain = null;
await win('majctl', N1, () => { for (let i = 0; i < N1; i++) { V.step(e); chain = { a: chain }; } });
chain = null;

obs.disconnect();
process.stdout.write('GCMARK done\n');
