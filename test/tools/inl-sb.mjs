// inl-sb.mjs -- inlining-budget-diff.sh driver: warm StratifiedBitset rounds (add / has / successor /
// predecessor / delete), the same round shape as inl-yft.mjs / inl-xft.mjs.
//
//   node test/tools/inl-sb.mjs [LogLogN.js]        (else $LLN_LIB, else ../../LogLogN.js)
//   $LLN_U = 20 | 26 | both (default both): U = 2^20 and / or U = 2^26 (a U = 2^32 bitset is a 512 MiB
//   pyramid, so keys >= 2^31 are not driven here). $LLN_ROUNDS = rounds per instance (default 120).
// Deterministic: a fixed LCG, a fixed key pool, per-round delete orders from a fixed odd stride.
// The harness keeps keys in a Uint32Array and only Smi locals (acc). Prints one line at the end.
import { pathToFileURL } from 'node:url';

const LIB = process.argv[2] || process.env.LLN_LIB || '';
const url = LIB !== '' ? pathToFileURL(LIB).href : new URL('../../LogLogN.js', import.meta.url).href;
const { StratifiedBitset } = await import(url);

const N = 4096;
const MASK = N - 1;
const ROUNDS = Number(process.env.LLN_ROUNDS || 120);
const MODE = process.env.LLN_U || 'both';
if (!(ROUNDS >= 1 && ROUNDS <= 100000 && Number.isInteger(ROUNDS))) throw new RangeError('LLN_ROUNDS must be an integer in [1, 100000]');
if (MODE !== '20' && MODE !== '26' && MODE !== 'both') throw new RangeError('LLN_U must be 20, 26 or both');

function fillKeys(keys, shift, seed) {
    let s = seed >>> 0;
    for (let i = 0; i < keys.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        keys[i] = s >>> shift;
    }
}

function sbRound(t, keys, stride) {
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
if (MODE !== '26') {
    insts.push(new StratifiedBitset(1048576));
    const k = new Uint32Array(N); fillKeys(k, 12, 0x2545f491); pools.push(k);
}
if (MODE !== '20') {
    insts.push(new StratifiedBitset(67108864));
    const k = new Uint32Array(N); fillKeys(k, 6, 0x9e3779b9); pools.push(k);
}
let acc = 0;
for (let r = 0; r < ROUNDS; r++) {
    const stride = (Math.imul(r, 0x9e3779b1) | 1) & MASK;
    for (let j = 0; j < insts.length; j++) acc = (acc + sbRound(insts[j], pools[j], stride)) | 0;
}
let line = 'inl-sb done mode=' + MODE + ' rounds=' + ROUNDS + ' acc=' + acc;
for (const t of insts) line += ' | U=' + t.universe + ' size=' + t.size;
console.log(line);
