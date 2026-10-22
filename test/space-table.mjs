/**
 * @zakkster/lite-loglogn -- REPORTED space table (PLAN-xfasttrie G11). Not a gate,
 * not in `npm test`, no npm script.
 *
 * Run:  node test/space-table.mjs
 *
 * Prints XFastTrie bytes (from the SPEC formula, O(n w)) against
 * StratifiedBitset bytes (O(U / 32), independent of n) at
 * U in {2^16, 2^20, 2^24, 2^32} x n in {1e3, 1e4, 1e5, 1e6}, with the
 * XFastTrie capacity n capped at min(U, 2^24) (A2). StratifiedBitset is
 * CONSTRUCTED where it can be built here (U <= 2^24) and checked against its
 * formula; at U = 2^32 its cell is formula-only and marked `(not built)`.
 * The XFastTrie formula is the one test/XFastTrieSpace.test.js gates.
 */

import { StratifiedBitset, XFastTrie } from '../LogLogN.js';

const US = [[16, 65536], [20, 1048576], [24, 16777216], [32, 4294967296]];
const NS = [1000, 10000, 100000, 1000000];
const CAP = 16777216;
const SB_BUILD_MAX = 16777216;

function bitsOf(U) {
    let w = 0;
    let p = 1;
    while (p < U) { p *= 2; w++; }
    return w;
}

// XFastTrie: 13 TS + 12 (C + 1) + 16 (w + 1) + 16, TS = sum of 8 * B_L,
// B_L = smallest power of two >= ceil(min(C, 2^L) * 10 / 72).
function xftBytes(U, C) {
    const w = bitsOf(U);
    let ts = 0;
    for (let L = 1; L <= w; L++) {
        const need = Math.ceil(Math.min(C, 2 ** L) * 10 / 72);
        let b = 1;
        while (b < need) b *= 2;
        ts += 8 * b;
    }
    return 13 * ts + 12 * (C + 1) + 16 * (w + 1) + 16;
}

// StratifiedBitset: 4 bytes per word over every level, ceil(U / 32) words at
// the bottom, ceil(prev / 32) above, up to one root word.
function sbBytes(U) {
    let w = Math.ceil(U / 32);
    let sum = w;
    while (w > 1) { w = Math.ceil(w / 32); sum += w; }
    return 4 * sum;
}

function mb(b) {
    return (b / 1048576).toFixed(b < 1048576 ? 3 : 1) + ' MB';
}

function pad(s, n) {
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const XFT_BUILD_MAX = 64 * 1048576;
const sbCell = [];
for (const [k, U] of US) {
    const f = sbBytes(U);
    if (U <= SB_BUILD_MAX) {
        const b = new StratifiedBitset(U).byteLength;
        if (b !== f) throw new Error('StratifiedBitset formula ' + f + ' != constructed ' + b + ' at U=2^' + k);
        sbCell.push(b + ' B (' + mb(b) + ')');
    } else {
        sbCell.push(f + ' B (' + mb(f) + ') (not built)');
    }
}

console.log('space-table (REPORTED): XFastTrie (formula) vs StratifiedBitset bytes; node ' +
    process.version + ', ' + new Date().toISOString());
console.log(pad('U', 6) + pad('n', 9) + pad('C (cap)', 18) + pad('XFastTrie', 30) + pad('StratifiedBitset', 42) + 'XFT / SB');
let rows = 0;
let checked = 0;
for (let i = 0; i < US.length; i++) {
    const [k, U] = US[i];
    const sb = sbBytes(U);
    for (const n of NS) {
        const lim = U < CAP ? U : CAP;
        const C = n < lim ? n : lim;
        const x = xftBytes(U, C);
        if (x <= XFT_BUILD_MAX) {
            const real = new XFastTrie(U, C).byteLength;
            if (real !== x) {
                console.log('FAIL xftBytes(' + U + ', ' + C + ') = ' + x + ' != constructed byteLength ' + real);
                process.exitCode = 1;
            }
            checked++;
        }
        const cTxt = C === n ? String(C) : C + ' (capped)';
        console.log(pad('2^' + k, 6) + pad(String(n), 9) + pad(cTxt, 18) +
            pad(x + ' B (' + mb(x) + ')', 30) + pad(sbCell[i], 42) + (x / sb).toFixed(3));
        rows++;
    }
}
if (rows !== US.length * NS.length) throw new Error('space-table printed ' + rows + ' rows, expected ' + US.length * NS.length);
console.log('xftBytes self-check: ' + checked + ' cells constructed (<= 64 MB) and compared to byteLength');
if (checked !== 14) {
    console.log('FAIL xftBytes self-check covered ' + checked + ' cells, expected exactly 14 (coverage floor)');
    process.exitCode = 1;
}
