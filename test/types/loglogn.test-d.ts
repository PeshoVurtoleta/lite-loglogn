/**
 * @zakkster/lite-loglogn -- ambient type tests (tsc -p test/types/tsconfig.json).
 *
 * Exports: `VERSION` and the class `StratifiedBitset` (with the dump snapshot
 * interface). Each member session appends a type-level assertion block for its
 * class here. ASCII-only.
 */

import { VERSION, StratifiedBitset } from '../../LogLogN.js';
import type { StratifiedBitsetDump } from '../../LogLogN.js';

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
