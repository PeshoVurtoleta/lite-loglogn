/**
 * @zakkster/lite-loglogn -- RoaringSet._lb16 branchless lower bound (PLAN-roaring-search task A6, assertions
 * A-1, A-2, A-3). DETERMINISTIC tier, no timing. Written from the ASSERTIONS and the spec of a lower bound;
 * expected values come from the embedded branchy oracle and from the closed form 32 - clz32(len - 1) + 1,
 * never from the _lb16 body.
 *
 * A-1 parity: every len 1..64 and 19 lens 65..4096, EVERY lo 0..65536 (the full lo set), three key layouts per
 *     len (seeded random, run at 0.., run ending at 65535), base > 0, poison on both sides of the window.
 * A-2 reads: Proxy read count == 32 - clz32(len - 1) + 1, every index within [base, base + len).
 * A-3 census over the LogLogN.js text.
 * Every checker fails closed: zero cases or a NaN result fails (LEDGER Law 1). Controls run the same checkers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RoaringSet } from '../LogLogN.js';

const lb16 = RoaringSet.prototype._lb16;
assert.equal(typeof lb16, 'function');

// ---- PRNG: mulberry32, 32-bit exact; independent streams (keys / base / lo choices) -------------------------
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- oracle: the classic branchy lower bound (first index in [0,len) with arr[base+i] >= lo, else len) ------
function branchy(arr, base, len, lo) {
    let l = 0;
    let h = len;
    while (l < h) {
        const m = (l + h) >>> 1;
        if (arr[base + m] < lo) l = m + 1;
        else h = m;
    }
    return l;
}
function bentOracle(arr, base, len, lo) { // `<=` : a lower bound that is really an upper bound
    let l = 0;
    let h = len;
    while (l < h) {
        const m = (l + h) >>> 1;
        if (arr[base + m] <= lo) l = m + 1;
        else h = m;
    }
    return l;
}

// ---- 4 bent bodies of the shipped sign-shift branchless shape (91 B body) --------------------------------------------------------------------
const bent = {
    leqTail(arr, base, len, lo) { // `<=` in the tail compare (a `<=` loop alone is an equivalent mutant)
        let b = 0, w = len;
        while (w > 1) { const h = w >>> 1; b += ((arr[base + b + h] - lo) >> 31) & h; w -= h; }
        return b + ((arr[base + b] - lo - 1) >>> 31);
    },
    noTail(arr, base, len, lo) { // final compare dropped
        let b = 0, w = len;
        while (w > 1) { const h = w >>> 1; b += ((arr[base + b + h] - lo) >> 31) & h; w -= h; }
        return b;
    },
    wShrink(arr, base, len, lo) { // w = h instead of w -= h (loses the odd element)
        let b = 0, w = len;
        while (w > 1) { const h = w >>> 1; b += ((arr[base + b + h] - lo) >> 31) & h; w = h; }
        return b + ((arr[base + b] - lo) >>> 31);
    },
    noBase(arr, base, len, lo) { // base ignored in the tail read
        let b = 0, w = len;
        while (w > 1) { const h = w >>> 1; b += ((arr[base + b + h] - lo) >> 31) & h; w -= h; }
        return b + ((arr[b] - lo) >>> 31);
    },
};

const LENS_LONG = [65, 100, 127, 128, 129, 255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 2047, 2048, 2049, 3000, 4096];
const LENS = [];
for (let n = 1; n <= 64; n++) LENS.push(n);
for (const n of LENS_LONG) LENS.push(n);

// strictly sorted keys in [0,65535]: selection sampling (Knuth S) from the keys stream
function randKeys(rk, len) {
    const out = new Uint16Array(len);
    let need = len;
    for (let v = 0; v < 65536 && need > 0; v++) {
        if (rk() * (65536 - v) < need) out[len - need--] = v;
    }
    return out;
}
function makeCase(len, layout, rk, rb) {
    let keys;
    if (layout === 0) keys = randKeys(rk, len);
    else if (layout === 1) { keys = new Uint16Array(len); for (let i = 0; i < len; i++) keys[i] = i; }
    else { keys = new Uint16Array(len); for (let i = 0; i < len; i++) keys[i] = 65536 - len + i; }
    const base = 1 + Math.floor(rb() * 40);
    const tail = 1 + Math.floor(rb() * 8);
    const arr = new Uint16Array(base + len + tail);
    arr.fill(65535, 0, base);          // poison below the window: large (would read as "not less")
    arr.fill(0, base + len);           // poison above the window: small (would read as "less")
    arr.set(keys, base);
    return { arr, base, len, keys };
}

// A-1 checker: returns { cases, mismatches }; throws on zero cases / NaN.
function parity(impl, oracle, lens, layouts) {
    const rk = prng(0x1badc0de), rb = prng(0x5eed0042); // independent key / base streams
    let cases = 0, mism = 0;
    for (const len of lens) {
        for (const layout of layouts) {
            const c = makeCase(len, layout, rk, rb);
            for (let lo = 0; lo <= 65536; lo++) {
                const got = impl.call(null, c.arr, c.base, c.len, lo);
                const want = oracle(c.arr, c.base, c.len, lo);
                cases++;
                if (!(got === want)) mism++; // NaN / undefined count as mismatches
            }
        }
    }
    if (cases === 0) throw new Error('parity: zero cases');
    return { cases, mism };
}

test('A-1 parity: _lb16 == branchy, len 1..64 + 19 long lens, EVERY lo 0..65536, 3 layouts, base>0, poison', () => {
    assert.equal(LENS.length, 64 + 19);
    const r = parity(lb16, branchy, LENS, [0, 1, 2]);
    assert.equal(r.cases, LENS.length * 3 * 65537);
    assert.equal(r.mism, 0);
});

test('A-1 controls: 4 bent bodies and a bent oracle each give >= 1 mismatch through the same checker', () => {
    const sub = [1, 2, 3, 5, 7, 8, 13, 31, 32, 33, 64, 65, 129, 1025];
    for (const [name, fn] of Object.entries(bent)) {
        const r = parity(fn, branchy, sub, [0, 1, 2]);
        assert.ok(r.mism >= 1, 'bent body ' + name + ' reported 0 mismatches');
    }
    const r = parity(lb16, bentOracle, sub, [0, 1, 2]);
    assert.ok(r.mism >= 1, 'bent oracle reported 0 mismatches');
    assert.ok(parity(() => NaN, branchy, [1], [1]).mism >= 1, 'NaN result not counted');
    assert.ok(parity(() => undefined, branchy, [1], [1]).mism >= 1, 'undefined result not counted');
});

test('A-1 checker fails closed: zero cases throws', () => {
    assert.throws(() => parity(lb16, branchy, [], [0]), /zero cases/);
    assert.throws(() => parity(lb16, branchy, [4], []), /zero cases/);
});

// ---- A-2 reads --------------------------------------------------------------------------------------------
// returns { cases, bad: [descr...] }
function reads(impl, lens) {
    const rk = prng(0xa2a2a2a2), rb = prng(0x0b5e55ed);
    let cases = 0;
    const bad = [];
    for (const len of lens) {
        const c = makeCase(len, 0, rk, rb);
        const expect = 32 - Math.clz32(len - 1) + 1;
        let count = 0, lowest = Infinity, highest = -Infinity;
        const px = new Proxy(c.arr, {
            get(t, p) {
                if (typeof p === 'string') {
                    const i = Number(p);
                    if (Number.isInteger(i)) { count++; if (i < lowest) lowest = i; if (i > highest) highest = i; }
                }
                return t[p];
            },
        });
        const los = new Set([0, 65536]);
        for (let i = 0; i < len; i++) {
            const k = c.keys[i];
            los.add(k); los.add(k - 1); los.add(k + 1);
        }
        for (const lo of los) {
            if (lo < 0 || lo > 65536) continue;
            count = 0; lowest = Infinity; highest = -Infinity;
            const got = impl.call(null, px, c.base, c.len, lo);
            cases++;
            const ansOk = got === branchy(c.arr, c.base, c.len, lo);
            if (!(count === expect) || !(lowest >= c.base) || !(highest < c.base + c.len) || !ansOk) {
                bad.push({ len, lo, count, expect, lowest, highest, base: c.base, end: c.base + c.len, ansOk });
            }
        }
    }
    if (cases === 0) throw new Error('reads: zero cases');
    return { cases, bad };
}

test('A-2 reads: count == 32 - clz32(len-1) + 1 and every index in [base, base+len)', () => {
    const r = reads(lb16, LENS);
    assert.ok(r.cases > 1000);
    assert.deepEqual(r.bad.slice(0, 3), []);
});

test('A-2 row-alone controls: lowest, highest and answer rows each fail alone (len 8)', () => {
    const lbl = (px, b, l, lo) => lb16.call(null, px, b, l, lo);
    const offLow = (px, base, len, lo) => { const j = branchy(new Uint16Array(px.buffer), base, len, lo); for (let i = 0; i < 32 - Math.clz32(len - 1) + 1; i++) px[base - 1]; return j; };
    const offHigh = (px, base, len, lo) => { const j = branchy(new Uint16Array(px.buffer), base, len, lo); for (let i = 0; i < 32 - Math.clz32(len - 1) + 1; i++) px[base + len]; return j; };
    const wrong = (px, b, l, lo) => lbl(px, b, l, lo) + 1;
    assert.deepEqual(reads(lbl, [8]).bad, []); // the unbent body is clean on the same input
    const lo = reads(offLow, [8]).bad, hi = reads(offHigh, [8]).bad, an = reads(wrong, [8]).bad;
    for (const bad of [lo, hi, an]) assert.ok(bad.length >= 1);
    // only the named row is wrong on the bad entry (count always right)
    for (const e of lo) { assert.equal(e.count, e.expect); assert.ok(e.lowest < e.base); assert.ok(e.highest < e.end); assert.ok(e.ansOk); }
    for (const e of hi) { assert.equal(e.count, e.expect); assert.ok(e.lowest >= e.base); assert.ok(e.highest >= e.end); assert.ok(e.ansOk); }
    for (const e of an) { assert.equal(e.count, e.expect); assert.ok(e.lowest >= e.base); assert.ok(e.highest < e.end); assert.ok(!e.ansOk); }
});

test('A-2 control: the branchy body through the same checker flips (len 64, lo 65536: 6 != 7)', () => {
    const r = reads(branchy, [64]);
    assert.ok(r.bad.length >= 1);
    const hit = r.bad.find((b) => b.len === 64 && b.lo === 65536);
    assert.ok(hit, 'no flip at len 64 lo 65536');
    assert.equal(hit.count, 6);
    assert.equal(hit.expect, 7);
    assert.throws(() => reads(lb16, []), /zero cases/);
});

// ---- A-3 census over the source text -----------------------------------------------------------------------
const SRC = readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');

function census(text) {
    const needle = 'this._lb16(';
    const sites = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) sites.push(at);
    if (sites.length !== 16) throw new Error('census: expected 16 this._lb16( calls, found ' + sites.length);
    for (const at of sites) {
        // split args at depth-0 commas up to the matching paren
        let depth = 0, i = at + needle.length - 1, start = i + 1;
        const args = [];
        for (; i < text.length; i++) {
            const ch = text[i];
            if (ch === '(' || ch === '[') depth++;
            else if (ch === ')' || ch === ']') { depth--; if (depth === 0) { args.push(text.slice(start, i).trim()); break; } }
            else if (ch === ',' && depth === 1) { args.push(text.slice(start, i).trim()); start = i + 1; }
        }
        if (args.length !== 4) throw new Error('census: call at ' + at + ' has ' + args.length + ' args');
        const name = args[2];
        if (name !== 'len' && name !== 'n0') throw new Error('census: third arg is ' + name);
        const re = new RegExp('\\b(?:const|let)\\s+' + name + '\\s*=[^;\\n]*;', 'g');
        let last = null, lastAt = -1, m;
        const before = text.slice(0, at);
        while ((m = re.exec(before)) !== null) { last = m[0]; lastAt = m.index; }
        if (last === null) throw new Error('census: no declaration of ' + name);
        if (!last.startsWith('const ') || !last.endsWith('= this._card[m] + 1;') || /\n    \}\n/.test(before.slice(lastAt))) {
            throw new Error('census: nearest declaration of ' + name + ' is not a same-block const = this._card[m] + 1; (' + last + ')');
        }
    }
    if (!/this\._card\s*=\s*new Uint16Array\(/.test(text)) throw new Error('census: _card is not new Uint16Array');
    return sites.length;
}

test('A-3 census: 16 this._lb16( calls, third arg len/n0, nearest decl = this._card[m] + 1;, _card Uint16Array', () => {
    assert.equal(census(SRC), 16);
});

test('A-3 controls: a 17th call, a dropped + 1, a bent third arg, a non-Uint16 _card each throw', () => {
    const k = SRC.indexOf('this._lb16(');
    assert.ok(k > 0);
    assert.throws(() => census(SRC + '\nthis._lb16(a, b, len, lo);'), /found 17/);
    const decl = SRC.indexOf('const len = this._card[m] + 1;');
    assert.ok(decl > 0 && decl < k);
    assert.throws(() => census(SRC.slice(0, decl) + 'const len = this._card[m];' + SRC.slice(decl + 'const len = this._card[m] + 1;'.length)), /nearest declaration/);
    assert.throws(() => census(SRC.slice(0, k) + 'this._lb16(this._sData, base, len + 1, lo)' + SRC.slice(SRC.indexOf(')', k) + 1)), /third arg/);
    assert.throws(() => census(SRC.replace('this._card = new Uint16Array(', 'this._card = new Uint32Array(')), /Uint16Array/);
    // args.length row: a 3-arg call
    assert.throws(() => census(SRC.slice(0, k) + 'this._lb16(this._sData, base, len)' + SRC.slice(SRC.indexOf(')', k) + 1)), / args/);
    // "nearest": bend the LAST declaration (n0 at the final call), not the first one
    const d2 = SRC.lastIndexOf('const n0 = this._card[m] + 1;', SRC.lastIndexOf('this._lb16('));
    assert.ok(d2 > 0);
    assert.throws(() => census(SRC.slice(0, d2) + 'const n0 = this._card[m];' + SRC.slice(d2 + 29)), /nearest declaration/);
});

test('A-3 binding controls: a let + reassign at has k=2, and a helper fed this._card[m] each throw', () => {
    // shape one: len may be reduced after the declaration (has's k = 2 site, the second decl in has)
    const hasAt = SRC.indexOf('has(x) {', SRC.indexOf('class RoaringSet'));
    assert.ok(hasAt > 0);
    const d = SRC.indexOf('const len = this._card[m] + 1;', SRC.indexOf('const len = this._card[m] + 1;', hasAt) + 1);
    assert.ok(d > hasAt);
    const one = SRC.slice(0, d) + 'let len = this._card[m] + 1; if (len > 2) len = len - 2;' + SRC.slice(d + 'const len = this._card[m] + 1;'.length);
    assert.throws(() => census(one), /nearest declaration/);
    // shape two: a helper before successor; _chunkHasLo hands it this._card[m] with no + 1 (len can be 0)
    const chl = SRC.indexOf('_chunkHasLo(m, k, lo) {');
    const callAt = SRC.indexOf('this._lb16(this._lU16, base, len, lo)', chl);
    assert.ok(chl > 0 && callAt > chl);
    const callTxt = 'this._lb16(this._lU16, base, len, lo)';
    let two = SRC.slice(0, callAt) + 'this._lbHelper(this._lU16, base, this._card[m], lo)' + SRC.slice(callAt + callTxt.length);
    const succ = two.indexOf('    successor(x) {', two.indexOf('class RoaringSet'));
    assert.ok(succ > 0 && succ < chl);
    two = two.slice(0, succ) + '    _lbHelper(arr, base, len, lo) {\n        return this._lb16(arr, base, len, lo);\n    }\n\n' + two.slice(succ);
    assert.throws(() => census(two), /nearest declaration/);
});
