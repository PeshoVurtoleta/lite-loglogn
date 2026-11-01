// inl-yft.mjs -- inlining-budget-diff.sh driver: warm YFastTrie rounds (add / has / successor /
// predecessor / delete) that drive splits, merges and borrows.
//
//   node test/tools/inl-yft.mjs [LogLogN.js]       (else $LLN_LIB, else ../../LogLogN.js)
//   $LLN_U = 20 | 32 | both (default both): U = 2^20 and / or U = 2^32 (every key, so every rep but
//   the permanent rep 0, is >= 2^31 at U = 2^32). $LLN_ROUNDS = rounds per instance (default 600:
//   nominal (observed 2026-11-01, run 1 log scratchpad u3/, node v26.8.2): the cold _split / _shrink
//   reached TurboFan only past ~300 rounds at U = 2^32 alone; at 120 _shrink stayed in Maglev).
// Deterministic: a fixed LCG, a fixed key pool, per-round delete orders from a fixed odd stride.
// The harness keeps keys in a Uint32Array and only Smi locals (acc), so the driver itself is not the
// thing that boxes. Prints one line at the end (counters prove the cold paths ran).
import { pathToFileURL } from 'node:url';

const LIB = process.argv[2] || process.env.LLN_LIB || '';
const url = LIB !== '' ? pathToFileURL(LIB).href : new URL('../../LogLogN.js', import.meta.url).href;
const { YFastTrie } = await import(url);

const N = 4096;
const MASK = N - 1;
const ROUNDS = Number(process.env.LLN_ROUNDS || 600);
const MODE = process.env.LLN_U || 'both';
if (!(ROUNDS >= 1 && ROUNDS <= 100000 && Number.isInteger(ROUNDS))) throw new RangeError('LLN_ROUNDS must be an integer in [1, 100000]');
if (MODE !== '20' && MODE !== '32' && MODE !== 'both') throw new RangeError('LLN_U must be 20, 32 or both');

function fillKeys(keys, big, seed) {
    let s = seed >>> 0;
    for (let i = 0; i < keys.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        keys[i] = big ? (s | 0x80000000) >>> 0 : s >>> 12;
    }
}

function yftRound(t, keys, stride) {
    let acc = 0;
    for (let i = 0; i < N; i++) t.add(keys[i]);
    for (let i = 0; i < N; i++) {
        const x = (keys[i] ^ (i & 1)) >>> 0; // >>> 0: ^ alone makes a key >= 2^31 negative
        if (t.has(x)) acc = (acc + 1) | 0;
        const s = t.successor(x);
        if (s !== undefined) acc = (acc + (s & 7)) | 0;
        const p = t.predecessor(x);
        if (p !== undefined) acc = (acc + (p & 7)) | 0;
    }
    for (let i = 0; i < N; i += 2) t.delete(keys[(i * stride) & MASK]);
    for (let i = 0; i < N; i += 4) t.add(keys[(i * stride) & MASK]);
    for (let i = 0; i < N; i++) t.delete(keys[(i * stride) & MASK]);
    return acc;
}

const insts = [];
const pools = [];
if (MODE !== '32') {
    insts.push(new YFastTrie(1048576, N));
    const k = new Uint32Array(N); fillKeys(k, false, 0x2545f491); pools.push(k);
}
if (MODE !== '20') {
    insts.push(new YFastTrie(4294967296, N));
    const k = new Uint32Array(N); fillKeys(k, true, 0x9e3779b9); pools.push(k);
}
let acc = 0;
for (let r = 0; r < ROUNDS; r++) {
    const stride = (Math.imul(r, 0x9e3779b1) | 1) & MASK;
    for (let j = 0; j < insts.length; j++) acc = (acc + yftRound(insts[j], pools[j], stride)) | 0;
}
let line = 'inl-yft done mode=' + MODE + ' rounds=' + ROUNDS + ' acc=' + acc;
for (const t of insts) line += ' | U=' + t.universe + ' size=' + t.size + ' splits=' + t._n[0] + ' merges=' + t._n[1] + ' borrows=' + t._n[2];
console.log(line);
