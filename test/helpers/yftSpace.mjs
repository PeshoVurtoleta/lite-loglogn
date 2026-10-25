/**
 * @zakkster/lite-loglogn -- test-owned YFastTrie space model (PLAN-yfasttrie
 * G2-1; C-3 / C-12). Written from the SPEC, never read back from an instance:
 *
 *   w  = smallest integer with 2^w >= U (exact integer loop, no clz32);
 *   K  = 2w;  h = ceil(w / 2);  Cr = min(2 + floor(C / h), U);
 *   yftBytes(U, C) = 4 (Cr + 1) K + (Cr + 1) + 16 + xftBytes(U, Cr).
 *
 * xftBytes is the XFastTrie formula test/XFastTrieSpace.test.js gates (copied
 * from test/space-table.mjs): 13 TS + 12 (C + 1) + 16 (w + 1) + 16,
 * TS = sum over L = 1..w of 8 * B_L, B_L = smallest power of two >=
 * ceil(min(C, 2^L) * 10 / 72).
 *
 * Must-fail fakes (controls only, never a model of the engine):
 *   repAtC   -- the inner trie sized at C instead of Cr (A1 control);
 *   xftSized -- bytes of a plain XFastTrie(U, C) (O(n w), grows with w: A2 A);
 *   sbSized  -- bytes independent of C, StratifiedBitset-like O(U / 32) (A2 B).
 */

export function bitsOf(U) {
    let w = 0;
    let p = 1;
    while (p < U) { p *= 2; w++; }
    return w;
}

export function xftBytes(U, C) {
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

// StratifiedBitset: 4 bytes per word over every level (copied from test/space-table.mjs).
export function sbBytes(U) {
    let w = Math.ceil(U / 32);
    let sum = w;
    while (w > 1) { w = Math.ceil(w / 32); sum += w; }
    return 4 * sum;
}

// { w, K, h, Cr } of a YFastTrie(U, C), from C-3.
export function yftParams(U, C) {
    const w = bitsOf(U);
    const K = 2 * w;
    const h = Math.ceil(w / 2);
    const q = 2 + Math.floor(C / h);
    return { w, K, h, Cr: q < U ? q : U };
}

export function yftBytes(U, C) {
    const p = yftParams(U, C);
    return 4 * (p.Cr + 1) * p.K + (p.Cr + 1) + 16 + xftBytes(U, p.Cr);
}

// Control: the inner trie sized at C instead of Cr (the bucket pool still at Cr).
export function repAtC(U, C) {
    const p = yftParams(U, C);
    return 4 * (p.Cr + 1) * p.K + (p.Cr + 1) + 16 + xftBytes(U, C);
}

// Control: a plain XFastTrie(U, C) -- O(n w), the bytes grow with U at fixed C.
export function xftSized(U, C) {
    return xftBytes(U, C);
}

// Control: bytes independent of C (StratifiedBitset-like), the ratio over C is 1.0.
export function sbSized(U, C) {
    return sbBytes(U);
}
