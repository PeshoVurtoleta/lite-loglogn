/**
 * @zakkster/lite-loglogn -- ambient type tests (tsc -p test/types/tsconfig.json).
 *
 * Exports: `VERSION` and the classes `StratifiedBitset`, `XFastTrie` and
 * `YFastTrie` (each with its dump snapshot interface). Each member session appends a type-level assertion block for its
 * class here. ASCII-only.
 */

import { VERSION, StratifiedBitset, XFastTrie, YFastTrie } from '../../LogLogN.js';
import type { StratifiedBitsetDump, XFastTrieDump, YFastTrieDump } from '../../LogLogN.js';

// VERSION is a string.
const v: string = VERSION;
void v;

// @ts-expect-error -- VERSION is not a number.
const n: number = VERSION;
void n;

// --- StratifiedBitset ---------------------------------------------------------

const s = new StratifiedBitset(1 << 20);
const sc: StratifiedBitset = s;
void sc;

// @ts-expect-error -- the constructor needs a universe.
new StratifiedBitset();
// @ts-expect-error -- the universe is a number, not a string.
new StratifiedBitset('1024');

// Getters are numbers and readonly.
const size: number = s.size;
const universe: number = s.universe;
const levels: number = s.levels;
const byteLength: number = s.byteLength;
void size; void universe; void levels; void byteLength;
// @ts-expect-error -- size is readonly.
s.size = 1;
// @ts-expect-error -- universe is readonly.
s.universe = 1;
// @ts-expect-error -- levels is readonly.
s.levels = 1;
// @ts-expect-error -- byteLength is readonly.
s.byteLength = 1;

// has / delete return boolean.
const h: boolean = s.has(1);
const d: boolean = s.delete(1);
void h; void d;
// @ts-expect-error -- has returns boolean, not number.
const hn: number = s.has(1);
void hn;
// @ts-expect-error -- has takes a number key.
s.has('1');

// add returns the instance (chainable), not void.
const a: StratifiedBitset = s.add(1).add(2).add(3);
void a;
// @ts-expect-error -- add returns the instance, not boolean.
const ab: boolean = s.add(1);
void ab;

// successor / predecessor / min / max return number | undefined.
const su: number | undefined = s.successor(1);
const pr: number | undefined = s.predecessor(1);
const mi: number | undefined = s.min();
const ma: number | undefined = s.max();
void su; void pr; void mi; void ma;
// @ts-expect-error -- successor may be undefined, so it is not assignable to number.
const sun: number = s.successor(1);
void sun;
// @ts-expect-error -- predecessor may be undefined.
const prn: number = s.predecessor(1);
void prn;
// @ts-expect-error -- min may be undefined.
const min: number = s.min();
void min;
// @ts-expect-error -- max may be undefined.
const max: number = s.max();
void max;
// @ts-expect-error -- absent is undefined, never -1.
const bad: -1 = s.successor(1);
void bad;
// @ts-expect-error -- successor never returns null.
const nul: number | null = s.successor(1);
void nul;

// Narrowing: after an undefined check the result is a number.
const nx = s.successor(0);
if (nx !== undefined) {
    const nn: number = nx;
    void nn;
}

// clear returns void.
const cl: void = s.clear();
void cl;

// dump returns the snapshot; words is Uint32Array[].
const snap: StratifiedBitsetDump = s.dump();
const words: Uint32Array[] = snap.words;
const snapU: number = snap.universe;
const snapN: number = snap.size;
void words; void snapU; void snapN;
const w0: Uint32Array = s.dump().words[0];
void w0;
// @ts-expect-error -- words is an array of Uint32Array, not a number[].
const wn: number[] = s.dump().words;
void wn;
// @ts-expect-error -- words is not a Uint32Array itself.
const wu: Uint32Array = s.dump().words;
void wu;

// The class has no iterator or forEach (iteration is a successor walk only).
// @ts-expect-error -- no forEach.
s.forEach(() => {});
// @ts-expect-error -- not iterable.
for (const k of s) void k;

// --- XFastTrie ----------------------------------------------------------------

const x = new XFastTrie(1 << 20, 4096);
const xc: XFastTrie = x;
void xc;

// @ts-expect-error -- the constructor needs a capacity as well as a universe.
new XFastTrie(16);
// @ts-expect-error -- the constructor needs a universe and a capacity.
new XFastTrie();
// @ts-expect-error -- the capacity is a number, not a string.
new XFastTrie(16, '16');
// The optional third argument is a number seed (0.4.0, C-4).
const xSeeded: XFastTrie = new XFastTrie(16, 16, 1);
const xSeedU: XFastTrie = new XFastTrie(16, 16, undefined);
void xSeeded; void xSeedU;
// @ts-expect-error -- the seed is a number, not a string.
new XFastTrie(16, 16, '1');
// @ts-expect-error -- the seed is a number, not a bigint.
new XFastTrie(16, 16, 1n);
// @ts-expect-error -- the seed is not nullable.
new XFastTrie(16, 16, null);
// @ts-expect-error -- there is no fourth constructor argument.
new XFastTrie(16, 16, 1, 1);
// @ts-expect-error -- an XFastTrie is not a StratifiedBitset (no levels getter; dump() returns XFastTrieDump).
const xs: StratifiedBitset = x;
void xs;
// XFastTrie has no levels member: adding one to the .d.ts makes this line fail.
const xNoLevels: 'levels' extends keyof XFastTrie ? never : true = true;
void xNoLevels;

// Getters are numbers and readonly.
const xSize: number = x.size;
const xUniverse: number = x.universe;
const xCapacity: number = x.capacity;
const xBits: number = x.bits;
const xByteLength: number = x.byteLength;
void xSize; void xUniverse; void xCapacity; void xBits; void xByteLength;
// @ts-expect-error -- size is readonly.
x.size = 1;
// @ts-expect-error -- universe is readonly.
x.universe = 1;
// @ts-expect-error -- capacity is readonly.
x.capacity = 1;
// @ts-expect-error -- bits is readonly.
x.bits = 1;
// @ts-expect-error -- byteLength is readonly.
x.byteLength = 1;

// has / delete return boolean; add is chainable and returns the instance.
const xh: boolean = x.has(1);
const xd: boolean = x.delete(1);
void xh; void xd;
// @ts-expect-error -- has takes a number key.
x.has('1');
const xa: XFastTrie = x.add(1).add(2).add(3);
void xa;
// @ts-expect-error -- add returns the instance, not boolean.
const xab: boolean = x.add(1);
void xab;

// successor / predecessor / min / max return number | undefined.
const xsu: number | undefined = x.successor(1);
const xpr: number | undefined = x.predecessor(1);
const xmi: number | undefined = x.min();
const xma: number | undefined = x.max();
void xsu; void xpr; void xmi; void xma;
// @ts-expect-error -- successor may be undefined.
const xsun: number = x.successor(1);
void xsun;
// @ts-expect-error -- predecessor may be undefined.
const xprn: number = x.predecessor(1);
void xprn;
// @ts-expect-error -- min may be undefined.
const xmin: number = x.min();
void xmin;
// @ts-expect-error -- max may be undefined.
const xmax: number = x.max();
void xmax;
// @ts-expect-error -- successor never returns null.
const xnul: number | null = x.successor(1);
void xnul;

// clear returns void.
const xcl: void = x.clear();
void xcl;

// dump returns the snapshot: keys Uint32Array, levels {capacity, prefix, min, max}[].
const xsnap: XFastTrieDump = x.dump();
const xsU: number = xsnap.universe;
const xsC: number = xsnap.capacity;
const xsN: number = xsnap.size;
const xsB: number = xsnap.bits;
const xsK: Uint32Array = xsnap.keys;
void xsU; void xsC; void xsN; void xsB; void xsK;
const lv0 = xsnap.levels[0];
const lvCap: number = lv0.capacity;
const lvP: Uint32Array = lv0.prefix;
const lvMin: Uint32Array = lv0.min;
const lvMax: Uint32Array = lv0.max;
void lvCap; void lvP; void lvMin; void lvMax;
// @ts-expect-error -- keys is a Uint32Array, not a number[].
const xkn: number[] = xsnap.keys;
void xkn;
// @ts-expect-error -- a level's prefix is a Uint32Array, not a number.
const lvPn: number = lv0.prefix;
void lvPn;
// @ts-expect-error -- the dump has no words (that is StratifiedBitset's).
void xsnap.words;

// The class has no iterator or forEach (iteration is a successor walk only).
// @ts-expect-error -- no forEach.
x.forEach(() => {});
// @ts-expect-error -- not iterable.
for (const k of x) void k;

// --- YFastTrie ----------------------------------------------------------------

const y = new YFastTrie(1 << 20, 4096);
const yc: YFastTrie = y;
void yc;
const ySeeded: YFastTrie = new YFastTrie(1 << 20, 4096, 0xffffffff);
const ySeedU: YFastTrie = new YFastTrie(16, 16, undefined);
void ySeeded; void ySeedU;

// @ts-expect-error -- the constructor needs a capacity as well as a universe.
new YFastTrie(16);
// @ts-expect-error -- the constructor needs a universe and a capacity.
new YFastTrie();
// @ts-expect-error -- the capacity is a number, not a string.
new YFastTrie(16, '16');
// @ts-expect-error -- the seed is a number, not a string.
new YFastTrie(16, 16, '1');
// @ts-expect-error -- the seed is a number, not a bigint.
new YFastTrie(16, 16, 1n);
// @ts-expect-error -- the seed is not nullable.
new YFastTrie(16, 16, null);
// @ts-expect-error -- there is no fourth constructor argument.
new YFastTrie(16, 16, 1, 1);
// @ts-expect-error -- a YFastTrie is not an XFastTrie (its dump() has no levels).
const yx: XFastTrie = y;
void yx;
// @ts-expect-error -- an XFastTrie is not a YFastTrie (its dump() has no reps / sizes).
const xy: YFastTrie = x;
void xy;
// YFastTrie has no levels member: adding one to the .d.ts makes this line fail.
const yNoLevels: 'levels' extends keyof YFastTrie ? never : true = true;
void yNoLevels;

// Getters are numbers and readonly.
const ySize: number = y.size;
const yUniverse: number = y.universe;
const yCapacity: number = y.capacity;
const yBits: number = y.bits;
const yByteLength: number = y.byteLength;
void ySize; void yUniverse; void yCapacity; void yBits; void yByteLength;
// @ts-expect-error -- size is readonly.
y.size = 1;
// @ts-expect-error -- universe is readonly.
y.universe = 1;
// @ts-expect-error -- capacity is readonly.
y.capacity = 1;
// @ts-expect-error -- bits is readonly.
y.bits = 1;
// @ts-expect-error -- byteLength is readonly.
y.byteLength = 1;

// has / delete return boolean; add is chainable and returns the instance.
const yh: boolean = y.has(1);
const yd: boolean = y.delete(1);
void yh; void yd;
// @ts-expect-error -- has takes a number key.
y.has('1');
// @ts-expect-error -- delete returns boolean, not the instance.
const ydi: YFastTrie = y.delete(1);
void ydi;
const ya: YFastTrie = y.add(1).add(2).add(3);
void ya;
// @ts-expect-error -- add returns the instance, not boolean.
const yab: boolean = y.add(1);
void yab;

// successor / predecessor / min / max return number | undefined.
const ysu: number | undefined = y.successor(1);
const ypr: number | undefined = y.predecessor(1);
const ymi: number | undefined = y.min();
const yma: number | undefined = y.max();
void ysu; void ypr; void ymi; void yma;
// @ts-expect-error -- successor may be undefined.
const ysun: number = y.successor(1);
void ysun;
// @ts-expect-error -- predecessor may be undefined.
const yprn: number = y.predecessor(1);
void yprn;
// @ts-expect-error -- min may be undefined.
const ymin: number = y.min();
void ymin;
// @ts-expect-error -- max may be undefined.
const ymax: number = y.max();
void ymax;
// @ts-expect-error -- successor never returns null.
const ynul: number | null = y.successor(1);
void ynul;

// clear returns void.
const ycl: void = y.clear();
void ycl;

// dump returns the snapshot: keys / reps Uint32Array, sizes Uint8Array.
const ysnap: YFastTrieDump = y.dump();
const ysU: number = ysnap.universe;
const ysC: number = ysnap.capacity;
const ysN: number = ysnap.size;
const ysB: number = ysnap.bits;
const ysK: Uint32Array = ysnap.keys;
const ysR: Uint32Array = ysnap.reps;
const ysS: Uint8Array = ysnap.sizes;
void ysU; void ysC; void ysN; void ysB; void ysK; void ysR; void ysS;
// @ts-expect-error -- keys is a Uint32Array, not a number[].
const ykn: number[] = ysnap.keys;
void ykn;
// @ts-expect-error -- reps is a Uint32Array, not a number[].
const yrn: number[] = ysnap.reps;
void yrn;
// @ts-expect-error -- sizes is a Uint8Array, not a Uint32Array.
const ysz: Uint32Array = ysnap.sizes;
void ysz;
// @ts-expect-error -- the dump has no levels (that is XFastTrie's).
void ysnap.levels;
// @ts-expect-error -- a YFastTrieDump is not an XFastTrieDump.
const yxd: XFastTrieDump = ysnap;
void yxd;

// The class has no iterator or forEach (iteration is a successor walk only).
// @ts-expect-error -- no forEach.
y.forEach(() => {});
// @ts-expect-error -- not iterable.
for (const k of y) void k;
