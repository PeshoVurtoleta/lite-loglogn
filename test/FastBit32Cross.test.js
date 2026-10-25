/**
 * @zakkster/lite-loglogn -- StratifiedBitset x FastBit32 cross-check (B2a T10,
 * A7 / L-07, DETERMINISTIC).
 *
 * For every single bit 0..31 and 10,000 seeded NONZERO words (uniform words,
 * sparse 1-3 bit words, and words with bit 31 forced on), a U=32 StratifiedBitset
 * holding exactly the word's bits answers min() === FastBit32(word).lowest() and
 * max() === FastBit32(word).highest() === 31 - Math.clz32(word). The empty set
 * maps FastBit32's -1 to undefined. lite-fastbit32 is a devDependency only;
 * nothing here enters LogLogN.js. U=32 is one level: min / max never loop.
 *
 * Control (must fail): a `lowest() + 1` reference diverges from the shipped
 * min() on every word (asserted > 0 and equal to the word count).
 * Seed: printed; override with env LOGLOGN_SEED. Every test passes
 * { timeout: 120000 }.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FastBit32 } from '@zakkster/lite-fastbit32';
import { StratifiedBitset } from '../LogLogN.js';
import { mulberry32 } from './helpers/tierStream.mjs';
import { parseSeed } from './helpers/seed.mjs';

const T = { timeout: 120000 };
const N_WORDS = 10000;
const SEED = (parseSeed(process.env.LOGLOGN_SEED, 0x1badf00d) ^ 0x0fb32a07) >>> 0;

/** 32 single-bit words, then N_WORDS seeded nonzero words (uint32). */
function makeWords() {
    const rnd = mulberry32(SEED);
    const u32 = () => Math.floor(rnd() * 4294967296) >>> 0;
    const out = new Uint32Array(32 + N_WORDS);
    for (let b = 0; b < 32; b++) out[b] = (1 << b) >>> 0;
    let n = 32;
    while (n < out.length) {
        const kind = n % 3;
        let w;
        if (kind === 0) {
            w = u32();
        } else if (kind === 1) {
            const bits = 1 + Math.floor(rnd() * 3);
            w = 0;
            for (let k = 0; k < bits; k++) w |= 1 << Math.floor(rnd() * 32);
            w >>>= 0;
        } else {
            w = (u32() | 0x80000000) >>> 0;
        }
        if (w === 0) continue;
        out[n++] = w;
    }
    return out;
}

const WORDS = makeWords();

/** Loads exactly the bits of w into s (cleared first). */
function load(s, w) {
    s.clear();
    for (let b = 0; b < 32; b++) if (((w >>> b) & 1) === 1) s.add(b);
}

function popcount(w) {
    let c = 0;
    for (let b = 0; b < 32; b++) c += (w >>> b) & 1;
    return c;
}

/** Number of words where min() / max() differ from the given references. */
function divergences(lowRef, highRef) {
    const s = new StratifiedBitset(32);
    let minDiv = 0;
    let maxDiv = 0;
    for (let j = 0; j < WORDS.length; j++) {
        const w = WORDS[j];
        load(s, w);
        const fb = new FastBit32(w);
        if (!Object.is(s.min(), lowRef(fb, w))) minDiv++;
        if (!Object.is(s.max(), highRef(fb, w))) maxDiv++;
    }
    return { minDiv, maxDiv };
}

test('A7 word corpus: bits 0..31 + 10,000 seeded nonzero words (seed printed)', T, (t) => {
    t.diagnostic('seed=0x' + SEED.toString(16));
    console.log('[fastbit32] seed=0x' + SEED.toString(16) + ' words=' + WORDS.length);
    assert.equal(WORDS.length, 32 + N_WORDS);
    for (let b = 0; b < 32; b++) assert.equal(WORDS[b], 2 ** b);
    let bit31 = 0;
    let sparse = 0;
    for (let j = 0; j < WORDS.length; j++) {
        assert.notEqual(WORDS[j], 0, 'word ' + j + ' is zero');
        if (WORDS[j] >= 0x80000000) bit31++;
        if (popcount(WORDS[j]) <= 3) sparse++;
    }
    assert.ok(bit31 >= 3000, 'bit-31 words ' + bit31);
    assert.ok(sparse >= 3000, 'sparse words ' + sparse);
});

test('A7 every single bit 0..31: min() === lowest(), max() === highest() === 31 - clz32', T, () => {
    const s = new StratifiedBitset(32);
    for (let b = 0; b < 32; b++) {
        const w = (1 << b) >>> 0;
        load(s, w);
        const fb = new FastBit32(w);
        assert.equal(s.size, 1);
        assert.equal(fb.lowest(), b);
        assert.equal(s.min(), fb.lowest(), 'min bit ' + b);
        assert.equal(s.max(), fb.highest(), 'max bit ' + b);
        assert.equal(s.max(), 31 - Math.clz32(w), 'max bit ' + b + ' vs 31 - clz32');
    }
});

test('A7 10,032 words: shipped min() / max() equal FastBit32 lowest() / highest() and 31 - clz32', T, (t) => {
    const a = divergences((fb) => fb.lowest(), (fb) => fb.highest());
    const b = divergences((fb) => fb.lowest(), (fb, w) => 31 - Math.clz32(w));
    t.diagnostic('words=' + WORDS.length + ' minDiv=' + a.minDiv + ' maxDiv(highest)=' + a.maxDiv +
        ' maxDiv(31-clz32)=' + b.maxDiv);
    assert.equal(a.minDiv, 0, 'min() vs lowest()');
    assert.equal(a.maxDiv, 0, 'max() vs highest()');
    assert.equal(b.maxDiv, 0, 'max() vs 31 - clz32(word)');
});

test('A7 empty set: FastBit32 -1 maps to undefined', T, () => {
    const s = new StratifiedBitset(32);
    const fb = new FastBit32(0);
    assert.equal(fb.lowest(), -1);
    assert.equal(fb.highest(), -1);
    assert.equal(s.min(), undefined);
    assert.equal(s.max(), undefined);
});

test('A7 control: a lowest() + 1 reference diverges from min() on every word', T, (t) => {
    const c = divergences((fb) => fb.lowest() + 1, (fb) => fb.highest());
    t.diagnostic('control minDiv=' + c.minDiv + '/' + WORDS.length);
    console.log('[fastbit32] control lowest()+1 minDiv=' + c.minDiv + '/' + WORDS.length);
    assert.ok(c.minDiv > 0, 'control did not diverge');
    assert.equal(c.minDiv, WORDS.length);
    assert.equal(c.maxDiv, 0);
});
