// inl-roar.mjs -- inlining-budget-diff.sh driver: warm RoaringSet rounds over a fixed key pool of
// the array-search container kinds (the callers of _lb16).
//
//   node test/tools/inl-roar.mjs [LogLogN.js]      (else $LLN_LIB, else ../../LogLogN.js)
//   $LLN_KIND = array | small | mix (default array): which containers the hot loop queries.
//     Maglev inlines a call site only at feedback frequency >= --min-maglev-inlining-frequency (0.95), so a
//     single _lb16 site of has can reach it only when the loop stays on that site's kind: `array` warms the
//     kind-2 site, `small` the kind-1 site; `mix` (both kinds plus the other containers) is the TurboFan-only
//     shape (--min-inlining-frequency 0.15).
//   $LLN_OP = has | successor | predecessor | churn (default has): the method the hot loop calls. `churn` calls
//     add(key) and, when that key was absent, delete(key), so add and delete run warm and the set stays unchanged.
//   $LLN_ROUNDS = rounds per instance (default 1200, nominal).
// Deterministic: a fixed LCG draws the keys, one stride order per round. Keys stay below 2^30 in a Uint32Array
// and the harness keeps only Smi locals, so the driver itself does not box. Prints one line at the end.
import { pathToFileURL } from 'node:url';

const LIB = process.argv[2] || process.env.LLN_LIB || '';
const url = LIB !== '' ? pathToFileURL(LIB).href : new URL('../../LogLogN.js', import.meta.url).href;
const { RoaringSet } = await import(url);

const N = 4096;
const MASK = N - 1;
const ROUNDS = Number(process.env.LLN_ROUNDS || 1200);
const KIND = process.env.LLN_KIND || 'array';
if (!(ROUNDS >= 1 && ROUNDS <= 1000000 && Number.isInteger(ROUNDS))) throw new RangeError('LLN_ROUNDS must be an integer in [1, 1000000]');
if (KIND !== 'array' && KIND !== 'small' && KIND !== 'mix') throw new RangeError('LLN_KIND must be array, small or mix');
const OP = process.env.LLN_OP || 'has';
if (OP !== 'has' && OP !== 'successor' && OP !== 'predecessor' && OP !== 'churn') throw new RangeError('LLN_OP must be has, successor, predecessor or churn');

const U = 1 << 20;
const set = new RoaringSet(U, 64, 16);
const keys = new Uint32Array(N);

function addChunk(c, count, stride, start) {
    for (let i = 0; i < count; i++) set.add(c * 65536 + ((start + i * stride) & 65535));
}

// chunk 0 small (kind 1, <= 64 keys), chunk 1 array (kind 2)
addChunk(0, 48, 1371, 17);
addChunk(1, 2000, 29, 11);
// the other kinds only join the `mix` shape
if (KIND === 'mix') {
    addChunk(2, 6000, 7, 3);                                         // bitmap
    set.addRange(3 * 65536 + 100, 3 * 65536 + 900);                  // runs, optimized below
    set.addRange(3 * 65536 + 2000, 3 * 65536 + 2600);
    set.addRange(4 * 65536 + 10, 4 * 65536 + 50);                    // small runs
    set.addRange(5 * 65536, 6 * 65536);                              // full
    set.add(6 * 65536 + 42);                                         // single
    set.runOptimize();
}

// fail closed: the two hot chunks must really be the kinds this driver claims to warm
const shape = set.dump().chunks;
if (shape[0].kind !== 'small' || shape[1].kind !== 'array') {
    throw new Error('inl-roar: chunk 0 is ' + shape[0].kind + ', chunk 1 is ' + shape[1].kind + ' (want small, array)');
}

function kindAt(i) {
    if (KIND === 'array') return 1;
    if (KIND === 'small') return 0;
    return i & 7;
}

function fillKeys(seed) {
    let s = seed >>> 0;
    for (let i = 0; i < N; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const c = kindAt(i);
        keys[i] = c * 65536 + ((s >>> 8) & 65535);
    }
}
fillKeys(0x2545f491);

function hasRound(stride) {
    let acc = 0;
    for (let i = 0; i < N; i++) {
        if (set.has(keys[(i * stride) & MASK])) acc = (acc + 1) | 0;
    }
    return acc;
}

function successorRound(stride) {
    let acc = 0;
    for (let i = 0; i < N; i++) {
        const v = set.successor(keys[(i * stride) & MASK]);
        if (v !== undefined) acc = (acc + v) | 0;
    }
    return acc;
}

function predecessorRound(stride) {
    let acc = 0;
    for (let i = 0; i < N; i++) {
        const v = set.predecessor(keys[(i * stride) & MASK]);
        if (v !== undefined) acc = (acc + v) | 0;
    }
    return acc;
}

function churnRound(stride) {
    let acc = 0;
    for (let i = 0; i < N; i++) {
        const k = keys[(i * stride) & MASK];
        const before = set.size;
        set.add(k);
        if (set.size !== before) {
            acc = (acc + 1) | 0;
            set.delete(k);
        }
    }
    return acc;
}

const round = OP === 'has' ? hasRound : OP === 'successor' ? successorRound : OP === 'predecessor' ? predecessorRound : churnRound;
let acc = 0;
for (let r = 0; r < ROUNDS; r++) {
    const stride = (Math.imul(r, 0x9e3779b1) | 1) & MASK;
    acc = (acc + round(stride)) | 0;
}
console.log('inl-roar done kind=' + KIND + ' op=' + OP + ' rounds=' + ROUNDS + ' size=' + set.size + ' acc=' + acc);
