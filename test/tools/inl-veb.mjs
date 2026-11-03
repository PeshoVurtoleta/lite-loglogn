// inl-veb.mjs -- inlining-budget-diff.sh driver: warm vEBTree rounds (add / has / successor /
// predecessor / delete / min / max) over the leaf, depth-1 and depth-2 paths.
//
//   node test/tools/inl-veb.mjs [LogLogN.js]       (else $LLN_LIB, else ../../LogLogN.js)
//   $LLN_U = 16 | 24 | 28 | all (default all): U = 2^16 (leaf + depth-1), 2^24 + 1 (depth-1,
//   lo = 8), 2^28 (depth-2, lo = 16). $LLN_ROUNDS = rounds per instance (default 600, nominal).
// inlining-budget-diff.sh: `--fn add` always yields the guard's NO-VERDICT (add, 450 B, is dropped at
// vebRound's cumulative budget and makes no inlining decisions of its own). The --fn set that yields a
// verdict is `--fn has,delete,successor,predecessor,min,max` (reviewer observed VERDICT SAME, exit 0).
// Deterministic: a fixed LCG, a fixed key pool, per-round delete orders from a fixed odd stride.
// Keys live in a Uint32Array and the harness keeps only Smi locals (acc), so the driver itself is
// not the thing that boxes. Prints one line at the end.
import { pathToFileURL } from 'node:url';

const LIB = process.argv[2] || process.env.LLN_LIB || '';
const url = LIB !== '' ? pathToFileURL(LIB).href : new URL('../../LogLogN.js', import.meta.url).href;
const { vEBTree } = await import(url);

const N = 4096;
const MASK = N - 1;
const ROUNDS = Number(process.env.LLN_ROUNDS || 600);
const MODE = process.env.LLN_U || 'all';
if (!(ROUNDS >= 1 && ROUNDS <= 100000 && Number.isInteger(ROUNDS))) throw new RangeError('LLN_ROUNDS must be an integer in [1, 100000]');
if (MODE !== '16' && MODE !== '24' && MODE !== '28' && MODE !== 'all') throw new RangeError('LLN_U must be 16, 24, 28 or all');

function fillKeys(keys, universe, seed) {
    let s = seed >>> 0;
    for (let i = 0; i < keys.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        keys[i] = (s >>> 4) % universe;
    }
}

function vebRound(t, keys, stride, universe) {
    let acc = 0;
    for (let i = 0; i < N; i++) t.add(keys[i]);
    for (let i = 0; i < N; i++) {
        const x = (keys[i] + (i & 1)) % universe;
        if (t.has(x)) acc = (acc + 1) | 0;
        const s = t.successor(x);
        if (s !== undefined) acc = (acc + (s & 7)) | 0;
        const p = t.predecessor(x);
        if (p !== undefined) acc = (acc + (p & 7)) | 0;
        const lo = t.min();
        if (lo !== undefined) acc = (acc + (lo & 7)) | 0;
        const hi = t.max();
        if (hi !== undefined) acc = (acc + (hi & 7)) | 0;
    }
    for (let i = 0; i < N; i += 2) t.delete(keys[(i * stride) & MASK]);
    for (let i = 0; i < N; i += 4) t.add(keys[(i * stride) & MASK]);
    for (let i = 0; i < N; i++) t.delete(keys[(i * stride) & MASK]);
    return acc;
}

const insts = [];
const pools = [];
const unis = [];
const specs = [[16, 65536, 0x2545f491], [24, 16777217, 0x9e3779b9], [28, 268435456, 0x85ebca6b]];
for (const [tag, universe, seed] of specs) {
    if (MODE !== 'all' && MODE !== String(tag)) continue;
    insts.push(new vEBTree(universe));
    const k = new Uint32Array(N); fillKeys(k, universe, seed); pools.push(k);
    unis.push(universe);
}
let acc = 0;
for (let r = 0; r < ROUNDS; r++) {
    const stride = (Math.imul(r, 0x9e3779b1) | 1) & MASK;
    for (let j = 0; j < insts.length; j++) acc = (acc + vebRound(insts[j], pools[j], stride, unis[j])) | 0;
}
let line = 'inl-veb done mode=' + MODE + ' rounds=' + ROUNDS + ' acc=' + acc;
for (const t of insts) line += ' | U=' + t.universe + ' size=' + t.size;
console.log(line);
