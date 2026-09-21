/**
 * @zakkster/lite-loglogn -- ambient type tests (tsc -p test/types/tsconfig.json).
 *
 * v0.1.0 is the SCAFFOLD release: the only export is `VERSION`. Each member
 * session appends a type-level assertion block for its class here. ASCII-only.
 */

import { VERSION } from '../../LogLogN.js';

// VERSION is a string.
const v: string = VERSION;
void v;

// @ts-expect-error -- VERSION is not a number.
const n: number = VERSION;
void n;
