/**
 * @zakkster/lite-loglogn -- RoaringSet COUNT ledger worker (0.6.0 G4-B1, PLAN-roaringset-G4 tasks 0-1).
 * Not a test file: the npm glob `test/*.test.js` never matches it. Inert when merely imported (ROWS, Meter,
 * runJob and fmtCounts are exported for RoaringCount.test.js); a job runs only inside a node:worker_threads
 * Worker (workerData.roaringCountJob === true) or from the command line in CUT mode.
 *
 * Counting (the R0 count-harness Meter, .handoff/research/roaring/count-harness.mjs, made fail-closed):
 * every own typed-array field of the instance is swapped for a counting Proxy ONLY around the measured call
 * and restored after (finally). Numeric-key gets = reads, numeric-key sets = writes, per field. copyWithin /
 * fill / set called through a proxy run on the real target and count as MOVES (elements moved / filled), not
 * reads or writes. ANY other method (or `buffer`, an uncounted alias) read through a proxy is a FAIL (e.g.
 * subarray would hand out an uncounted view). An own object field that is not a typed array is a FAIL at
 * construction of the Meter (it can be neither counted nor undone). A `_q` field (the R0 drafts' scratch
 * array; the shipped engine has none, SPEC C-3) is proxied (so its writes are undone) but EXCLUDED from every
 * reported count. A symbol or non-enumerable own key is a FAIL (it can be neither counted nor undone);
 * getOwnPropertyDescriptor / defineProperty through a proxy are FAILs (an uncounted element read / write), and
 * so is any non-index key set / deleted through a proxy or an own non-index key (an expando) read through it.
 * The instance SHAPE is pinned at construction (prototype, extensibility, every own key with its descriptor
 * flags, in order) and re-checked before and after every measured call; each counted field's IDENTITY is
 * checked before the call (still the array the Meter was built on) and at the restore (still the proxy): a
 * changed shape or a replaced field is a FAIL, never silently undone by the restore (the FAIL names the part of the
 * shape that changed: prototype, extensibility, the own key set, or a key's descriptor flags).
 * LIMIT: a Proxy Meter sees only reads through the instance's own fields at call time. A typed-array alias
 * captured OUTSIDE the measured call (a module-scope or closure variable set in the constructor) bypasses
 * the proxies and is invisible to this Meter; the shipped engine keeps every typed array an own field read
 * via `this._x` (R0-CONTRACT; PLAN-G4 RISK), and code review, not this worker, guards that.
 *
 * Every row is undone exactly: the proxies log (field, index, old value) per write and the old contents of
 * every copyWithin / fill / set range; the log is replayed in reverse and the scalar own fields restored. A
 * sha1 over every field + the scalars is taken before the row and after the undo: any difference = FAIL. So
 * add / delete rows are measured on a FIXED shape. A query row is also hashed right after the call, BEFORE the
 * undo: any changed field or scalar (an uncounted or scalar write) = FAIL.
 *
 * Shapes are KEY SETS built through the public API only (clear(), add the sorted `pre` keys, runOptimize()
 * when `opt`, add the `post` keys); the key sets are the R0 count-harness shapes (same names). Every answer is
 * checked against a sorted-array model (has / successor / predecessor / min / max; add returns this, size,
 * has, the neighbours; delete's boolean, size, has, the neighbours). `inst.paged` must equal the job layout.
 *
 * workerData: { roaringCountJob: true, src (null = the shipped ../LogLogN.js, else a module URL: file: or a
 * data: URL of a mutated copy), jobs: [{ layout: 'direct' | 'paged', args: ctor args }] }.
 * Posts { phase: 'loaded', fails: [], hasRoaring } once the module is imported, then ONE message per job:
 * { phase: <layout>, fails: string[], rows: [{ id, s, q }], paged, fields } -- s = fmtCounts() of the row
 * (the string RoaringCount.test.js compares with its literals), q = the excluded `_q` reads / writes / moves.
 *
 * CUT mode (task 0: the ledger literals are cut from the R0 DRAFTS, never from the engine):
 *   node test/_roaring-count-worker.mjs --cut <module> --layout direct|paged --args 4294967296,256,16
 *        [--ref R/logs/u1-best.json] [--out file.json] [--draft]
 * prints every row's counts; --ref adds the R0 JSON's worst rdX for the row (the sweep value for a row whose
 * worst came from the hill-climb, `*`); --draft allows a module without a `paged` getter (layout then read
 * from `_pSh`). Exit 1 on any fail or any --ref disagreement.
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';

const NUM = /^(0|[1-9][0-9]*)$/;
const relIdx = (v, len, dflt) => {
    if (v === undefined) return dflt;
    let r = Math.trunc(Number(v));
    if (r !== r) r = 0;
    return r < 0 ? Math.max(len + r, 0) : Math.min(r, len);
};

/** Canonical field order of the formatted counts (unknown fields follow, sorted). */
export const FIELD_ORDER = ['_top', '_dir', '_pLive', '_pFree', '_kind', '_slot', '_card', '_runs', '_cMin', '_cMax',
    '_sData', '_sFree', '_lU16', '_lU32', '_bSum', '_lFree'];
export const EXCLUDED = '_q';

export class Meter {
    constructor(inst) {
        this.inst = inst;
        const keys = Object.keys(inst);
        for (const k of Reflect.ownKeys(inst)) if (typeof k !== 'string' || !keys.includes(k)) throw new Error('FAIL own field ' + String(k) + ' is a symbol / non-enumerable key; the Meter can neither count nor undo it');
        this.keys = this._sig();
        this.fields = keys.filter((k) => ArrayBuffer.isView(inst[k]) && !(inst[k] instanceof DataView));
        this.scalars = keys.filter((k) => !this.fields.includes(k));
        for (const k of this.scalars) {
            const v = inst[k];
            if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
                throw new Error('FAIL own field ' + k + ' is a non-typed-array object; the Meter can neither count nor undo it');
            }
        }
        this.real = this.fields.map((f) => inst[f]);
        const F = this.fields.length;
        this.r = new Float64Array(F);
        this.w = new Float64Array(F);
        this.m = new Float64Array(F);
        this.log = [];
        this.bad = [];
        this.sc = null;
        this.prox = this.real.map((t, fi) => this._mk(t, fi));
    }

    _mk(t, fi) {
        const self = this;
        const save = (a, b) => { if (b > a) self.log.push(fi, a, t.slice(a, b)); };
        let p = null;
        const cw = function (target, start, end) {
            const len = t.length;
            const to = relIdx(target, len, 0);
            const from = relIdx(start, len, 0);
            const fin = relIdx(end, len, len);
            const n = Math.min(fin - from, len - to);
            if (n > 0) {
                self.m[fi] += n;
                save(to, to + n);
            }
            t.copyWithin(target, start, end);
            return p;
        };
        const fl = function (v, start, end) {
            const len = t.length;
            const a = relIdx(start, len, 0);
            const b = relIdx(end, len, len);
            if (b > a) {
                self.m[fi] += b - a;
                save(a, b);
            }
            t.fill(v, start, end);
            return p;
        };
        const st = function (src, off) {
            const o = off === undefined ? 0 : Number(off);
            const n = src.length;
            self.m[fi] += n;
            save(o, Math.min(o + n, t.length));
            t.set(src, off);
        };
        p = new Proxy(t, {
            get(tt, k) {
                if (typeof k === 'string') {
                    if (NUM.test(k)) {
                        self.r[fi]++;
                        return tt[k];
                    }
                    if (k === 'copyWithin') return cw;
                    if (k === 'fill') return fl;
                    if (k === 'set') return st;
                    if (k === 'buffer') self.bad.push(self.fields[fi] + '.buffer');
                }
                if (Object.hasOwn(tt, k)) self.bad.push(self.fields[fi] + '.' + String(k) + ' (own non-index key)');
                const v = Reflect.get(tt, k);
                if (typeof v === 'function') {
                    self.bad.push(self.fields[fi] + '.' + String(k));
                    return v.bind(tt);
                }
                return v;
            },
            getOwnPropertyDescriptor(tt, k) { self.bad.push(self.fields[fi] + '.getOwnPropertyDescriptor'); return Reflect.getOwnPropertyDescriptor(tt, k); },
            deleteProperty(tt, k) { self.bad.push(self.fields[fi] + '.delete ' + String(k)); return Reflect.deleteProperty(tt, k); },
            defineProperty(tt, k, d) { self.bad.push(self.fields[fi] + '.defineProperty'); return Reflect.defineProperty(tt, k, d); },
            set(tt, k, v) {
                if (typeof k === 'string' && NUM.test(k)) {
                    self.w[fi]++;
                    self.log.push(fi, +k, tt[k]);
                    tt[k] = v;
                    return true;
                }
                self.bad.push(self.fields[fi] + '.set ' + String(k));
                return Reflect.set(tt, k, v);
            },
        });
        return p;
    }

    /** Runs fn with every typed-array field proxied; the real arrays are back in place before it returns. */
    run(fn) {
        this.r.fill(0);
        this.w.fill(0);
        this.m.fill(0);
        this.log.length = 0;
        this.bad.length = 0;
        const s0 = this._sigDiff();
        if (s0 !== null) this.bad.push(s0 + ' since the Meter was built');
        const inst = this.inst;
        for (let i = 0; i < this.fields.length; i++) if (inst[this.fields[i]] !== this.real[i]) this.bad.push('field ' + this.fields[i] + ' replaced since the Meter was built');
        this.sc = this.scalars.map((k) => inst[k]);
        for (let i = 0; i < this.fields.length; i++) inst[this.fields[i]] = this.prox[i];
        let ret;
        let err = null;
        try {
            ret = fn();
        } catch (e) {
            err = e;
        } finally {
            for (let i = 0; i < this.fields.length; i++) {
                if (inst[this.fields[i]] !== this.prox[i]) this.bad.push('field ' + this.fields[i] + ' replaced in the measured call');
                inst[this.fields[i]] = this.real[i];
            }
        }
        const s1 = this._sigDiff();
        if (s1 !== null) this.bad.push(s1 + ' in the measured call');
        return { ret, err };
    }

    /** Replays the write log in reverse and restores the scalar own fields. */
    undo() {
        const L = this.log;
        for (let j = L.length - 3; j >= 0; j -= 3) {
            const t = this.real[L[j]];
            const v = L[j + 2];
            if (ArrayBuffer.isView(v)) t.set(v, L[j + 1]);
            else t[L[j + 1]] = v;
        }
        L.length = 0;
        for (let i = 0; i < this.scalars.length; i++) this.inst[this.scalars[i]] = this.sc[i];
    }

    _sig() {
        const o = this.inst;
        const s = [Object.getPrototypeOf(o), Object.isExtensible(o)];
        for (const k of Reflect.ownKeys(o)) {
            const d = Reflect.getOwnPropertyDescriptor(o, k);
            s.push(k, ('value' in d ? 1 : 0) | (d.writable ? 2 : 0) | (d.enumerable ? 4 : 0) | (d.configurable ? 8 : 0));
        }
        return s;
    }

    /**
     * null when the shape equals the one pinned at construction, else the part(s) that changed, named: 'prototype
     * changed', 'extensibility changed (..)', 'own key set changed' (a key added / removed / reordered) or, with the
     * same keys, 'own key descriptor changed (<keys>)' (writable / enumerable / configurable / accessor flags).
     */
    _sigDiff() {
        const a = this.keys;
        const b = this._sig();
        const parts = [];
        if (a[0] !== b[0]) parts.push('prototype changed');
        if (a[1] !== b[1]) parts.push('extensibility changed (now ' + (b[1] ? 'extensible' : 'not extensible') + ')');
        let sameKeys = a.length === b.length;
        for (let i = 2; sameKeys && i < a.length; i += 2) if (a[i] !== b[i]) sameKeys = false;
        if (!sameKeys) parts.push('own key set changed');
        else {
            const d = [];
            for (let i = 3; i < a.length; i += 2) if (a[i] !== b[i]) d.push(String(a[i - 1]));
            if (d.length > 0) parts.push('own key descriptor changed (' + d.join(', ') + ')');
        }
        return parts.length > 0 ? parts.join(', ') : null;
    }

    hash() {
        const h = createHash('sha1');
        for (const t of this.real) h.update(new Uint8Array(t.buffer, t.byteOffset, t.byteLength));
        h.update(this.scalars.map((k) => { const v = this.inst[k]; return typeof v + ':' + (Object.is(v, -0) ? '-0' : String(v)); }).join('\n'));
        return h.digest('hex');
    }

    /** Field-indexed counts -> { r, w, m } maps (EXCLUDED dropped) + q (the EXCLUDED field's counts). */
    snapshot() {
        const out = { r: {}, w: {}, m: {}, q: { r: 0, w: 0, m: 0 } };
        for (let i = 0; i < this.fields.length; i++) {
            const f = this.fields[i];
            if (f === EXCLUDED) {
                out.q = { r: this.r[i], w: this.w[i], m: this.m[i] };
                continue;
            }
            if (this.r[i] > 0) out.r[f] = this.r[i];
            if (this.w[i] > 0) out.w[f] = this.w[i];
            if (this.m[i] > 0) out.m[f] = this.m[i];
        }
        return out;
    }
}

const ordered = (map) => Object.keys(map).sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a);
    const ib = FIELD_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
});
const total = (map) => { let s = 0; for (const k in map) s += map[k]; return s; };
const part = (tag, map) => tag + total(map) + ordered(map).map((k) => ' ' + k + ':' + map[k]).join('');

/** 'r<reads> f:n .. | w<writes> f:n .. | m<moves> f:n ..' -- the exact string the ledger literals hold. */
export function fmtCounts(c) {
    return part('r', c.r) + ' | ' + part('w', c.w) + ' | ' + part('m', c.m);
}

/**
 * One Meter `bad` entry as a ledger FAIL line. Only a method read through a proxy ('<field>.<method>') is worded as
 * one; `buffer` (an uncounted alias) and the descriptor traps name what they are; every other entry (a non-index
 * key set / delete, an expando read, a replaced field, a changed shape) already says what happened and prints as is.
 */
export function badLine(b) {
    const m = /^(\w+)\.(\S+)$/.exec(b);
    if (m === null) return 'FAIL ' + b;
    if (m[2] === 'buffer') return 'FAIL ' + b + ' (an uncounted alias) read through a counted field';
    if (m[2] === 'getOwnPropertyDescriptor') return 'FAIL ' + b + ' through a counted field (an uncounted element read)';
    if (m[2] === 'defineProperty') return 'FAIL ' + b + ' through a counted field (an uncounted element write)';
    return 'FAIL method ' + b + ' read through a counted field';
}

/** Total reads of a formatted counts string. */
export function readsOf(s) {
    const m = /^r(\d+)/.exec(s);
    return m === null ? NaN : Number(m[1]);
}

// --- shapes (R0 count-harness key sets, same names) ---------------------------------------------------------

const K = (c, lo) => c * 65536 + lo;
const C0 = 7;
const evenly = (c, n, off) => { const o = []; for (let i = 0; i < n; i++) o.push(K(c, Math.floor((i * 65536) / n) + off)); return o; };
const range = (c, a, b) => { const o = []; for (let lo = a; lo <= b; lo++) o.push(K(c, lo)); return o; };
const runsKeys = (c, runs) => { const o = []; for (const [s, n] of runs) for (let i = 0; i < n; i++) o.push(K(c, s + i)); return o; };
const stride = (R, step, cnt, off) => { const o = []; for (let i = 0; i < R; i++) o.push([off + i * step, cnt]); return o; };

export const SHAPES = {
    'empty': () => ({ pre: [], opt: false, post: [] }),
    'singleton': () => ({ pre: [K(C0, 12345)], opt: false, post: [] }),
    'small-64': () => ({ pre: evenly(C0, 64, 3), opt: false, post: [] }),
    'full-4096': () => ({ pre: evenly(C0, 4096, 3), opt: false, post: [] }),
    'bmp-4097': () => ({ pre: evenly(C0, 4097, 0), opt: false, post: [] }),
    'bmp-poles-4098': () => ({ pre: range(C0, 0, 2048).concat(range(C0, 63487, 65535)), opt: false, post: [] }),
    'full-65536': () => ({ pre: range(C0, 0, 65535), opt: false, post: [] }),
    // 2,047 runs of 3 keys every 32 (runOptimize) + an isolated key: 2,048 runs (a runs container)
    'runs-2048': () => ({ pre: runsKeys(C0, stride(2047, 32, 3, 0)), opt: true, post: [K(C0, 65500)] }),
};

// --- rows ------------------------------------------------------------------------------------------------------

/**
 * ref = the R0 JSON row id (u1-best.json / u1-bestp.json) whose worst rdX the row's reads equal; default
 * '<shape> / <op>'. A conversion row names its R0 conv row. note = why the argument is the one it is.
 * le = true: the argument is NOT the R0 worst argument, so the reads are only <= that worst (CUT mode checks <=).
 */
function row(shape, op, c, lo, ref, note, le) {
    const x = c === undefined ? undefined : K(c, lo);
    return {
        id: shape + ' ' + op + (c === undefined ? '' : ' c' + c + ':' + lo),
        shape, op, x,
        ref: ref || shape + ' / ' + op,
        note: note || null,
        le: le === true,
    };
}
const QSHAPES = ['singleton', 'small-64', 'full-4096', 'bmp-4097', 'bmp-poles-4098', 'full-65536', 'runs-2048'];
const HAS_AT = { 'singleton': [7, 0], 'small-64': [7, 0], 'full-4096': [7, 0], 'bmp-4097': [7, 0], 'bmp-poles-4098': [7, 0], 'full-65536': [7, 0], 'runs-2048': [7, 0] };
const SUCC_AT = { 'singleton': [7, 12345], 'small-64': [7, 31], 'full-4096': [7, 3], 'bmp-4097': [7, 4126], 'bmp-poles-4098': [7, 4095], 'full-65536': [7, 65535], 'runs-2048': [7, 0] };
const PRED_AT = { 'singleton': [65534, 0], 'small-64': [7, 31], 'full-4096': [7, 18], 'bmp-4097': [65534, 0], 'bmp-poles-4098': [7, 63486], 'full-65536': [65534, 0], 'runs-2048': [7, 31] };

export const ROWS = [];
for (const s of QSHAPES) {
    ROWS.push(row(s, 'has', HAS_AT[s][0], HAS_AT[s][1]));
    ROWS.push(row(s, 'successor', SUCC_AT[s][0], SUCC_AT[s][1]));
    ROWS.push(row(s, 'predecessor', PRED_AT[s][0], PRED_AT[s][1]));
    if (s === 'bmp-poles-4098') ROWS.push(row(s, 'predecessor', 65534, 0, null, 'the paged worst argument (top walk); direct worst is c7:63486', true));
    ROWS.push(row(s, 'min'));
    ROWS.push(row(s, 'max'));
}
ROWS.push(row('empty', 'min'));
ROWS.push(row('empty', 'max'));
// conversions (canonical sweep arguments from u1-best.json / u1-bestp.json)
ROWS.push(row('small-64', 'add', 7, 0, 'small-64 / add / conv add 65th key (small -> full array)', '65th add: small slot -> large-slot array'));
ROWS.push(row('full-4096', 'add', 7, 4, 'full-4096 / add / conv add 4097th key (array -> bitmap)', '4,097th add: array -> bitmap'));
ROWS.push(row('bmp-4097', 'delete', 7, 65520, 'bmp-4097 / delete / conv delete to 4096 keys (bitmap -> array)', 'bitmap delete of `_cMax` (stays a bitmap: DEMOTE_BITMAP 2048)'));
ROWS.push(row('bmp-4097', 'delete', 7, 0, 'bmp-4097 / delete', 'bitmap delete of `_cMin` (R0 worst is the `_cMax` delete, +1 `_cMax` read)', true));
ROWS.push(row('full-65536', 'delete', 7, 0, 'full-65536 / delete / conv delete from a full 65536-key chunk', 'FULL -> runs in a small slot'));
ROWS.push(row('singleton', 'delete', 7, 12345, 'singleton / delete', 'last key of a chunk (paged: the page is freed)'));
ROWS.push(row('runs-2048', 'add', 7, 60204, 'runs-2048 / add / conv add run spill at 2049 runs (card > 4096)', 'run spill at 2,049 runs -> bitmap'));
ROWS.push(row('runs-2048', 'delete', 7, 1, 'runs-2048 / delete / conv delete run split spill at 2049 runs (card > 4096)', 'run split spill at 2,049 runs -> bitmap'));

// --- model (sorted Float64Array; independent of every RoaringSet internal) -----------------------------------

const lb = (a, x) => { let l = 0; let h = a.length; while (l < h) { const m = (l + h) >>> 1; if (a[m] < x) l = m + 1; else h = m; } return l; };
const mHas = (a, x) => { const j = lb(a, x); return j < a.length && a[j] === x; };
const mSucc = (a, x) => { const j = lb(a, x + 1); return j < a.length ? a[j] : undefined; };
const mPred = (a, x) => { const j = lb(a, x); return j > 0 ? a[j - 1] : undefined; };

function build(inst, name) {
    const mem = SHAPES[name]();
    inst.clear();
    for (const k of mem.pre) inst.add(k);
    if (mem.opt) inst.runOptimize();
    for (const k of mem.post) inst.add(k);
    const model = Float64Array.from(mem.pre.concat(mem.post)).sort();
    if (inst.size !== model.length) throw new Error('shape ' + name + ' built size ' + inst.size + ' != ' + model.length);
    return model;
}

/** One counted row on the built shape: counts + every answer check + exact undo (sha1). */
export function measureRow(inst, meter, model, U, r, layout) {
    const fails = [];
    const tag = layout + ' ' + r.id;
    const x = r.x;
    const n0 = model.length;
    const h0 = meter.hash();
    const res = (r.op === 'min' || r.op === 'max') ? meter.run(() => inst[r.op]()) : meter.run(() => inst[r.op](x));
    const c = meter.snapshot();
    if (r.op !== 'add' && r.op !== 'delete' && meter.hash() !== h0) fails.push(tag + ': a query row changed state (scalar or uncounted write)');
    for (const b of meter.bad) fails.push(tag + ': ' + badLine(b));
    if (res.err !== null) fails.push(tag + ' threw ' + (res.err && res.err.message));
    else if (r.op === 'has') { if (res.ret !== mHas(model, x)) fails.push(tag + ' = ' + res.ret + ' model ' + mHas(model, x)); }
    else if (r.op === 'successor') { const m = mSucc(model, x); if (res.ret !== m) fails.push(tag + ' = ' + res.ret + ' model ' + m); }
    else if (r.op === 'predecessor') { const m = mPred(model, x); if (res.ret !== m) fails.push(tag + ' = ' + res.ret + ' model ' + m); }
    else if (r.op === 'min') { const m = n0 ? model[0] : undefined; if (res.ret !== m) fails.push(tag + ' = ' + res.ret + ' model ' + m); }
    else if (r.op === 'max') { const m = n0 ? model[n0 - 1] : undefined; if (res.ret !== m) fails.push(tag + ' = ' + res.ret + ' model ' + m); }
    else {
        const had = mHas(model, x);
        if (r.op === 'add') {
            if (res.ret !== inst) fails.push(tag + ' did not return this');
            if (inst.size !== n0 + (had ? 0 : 1)) fails.push(tag + ' size ' + inst.size + ' model ' + (n0 + (had ? 0 : 1)));
            if (!inst.has(x)) fails.push(tag + ' then has() false');
            if (x > 0 && inst.successor(x - 1) !== x) fails.push(tag + ' then successor(x-1) ' + inst.successor(x - 1));
            if (x + 1 < U && inst.predecessor(x + 1) !== x) fails.push(tag + ' then predecessor(x+1) ' + inst.predecessor(x + 1));
        } else {
            if (res.ret !== had) fails.push(tag + ' = ' + res.ret + ' model ' + had);
            if (inst.size !== n0 - (had ? 1 : 0)) fails.push(tag + ' size ' + inst.size + ' model ' + (n0 - (had ? 1 : 0)));
            if (inst.has(x)) fails.push(tag + ' then has() true');
            if (x > 0 && inst.successor(x - 1) !== mSucc(model, x)) fails.push(tag + ' then successor(x-1) ' + inst.successor(x - 1) + ' model ' + mSucc(model, x));
            if (x + 1 < U && inst.predecessor(x + 1) !== mPred(model, x)) fails.push(tag + ' then predecessor(x+1) ' + inst.predecessor(x + 1) + ' model ' + mPred(model, x));
        }
        if (r.op === 'add' && had) fails.push(tag + ': the row key is already present (not a write row)');
        if (r.op === 'delete' && !had) fails.push(tag + ': the row key is absent (not a write row)');
    }
    meter.undo();
    if (inst.size !== n0) fails.push(tag + ' undo: size ' + inst.size + ' expected ' + n0);
    if (meter.hash() !== h0) fails.push(tag + ' UNDO NOT EXACT (sha1 differs; harness integrity)');
    return { id: r.id, s: fmtCounts(c), q: c.q, fails };
}

/**
 * Runs every ROW on one instance of the layout. RS = the RoaringSet class; args = ctor args.
 * draft = true allows a module without a `paged` getter (R0 drafts; layout from `_pSh`).
 */
export function runJob(RS, layout, args, draft) {
    const fails = [];
    const out = [];
    let inst;
    let meter;
    try {
        inst = new RS(...args);
        meter = new Meter(inst);
    } catch (e) {
        return { fails: [layout + ' construct / Meter: ' + (e && e.message)], rows: out, paged: null, fields: [] };
    }
    let paged = inst.paged;
    if (typeof paged !== 'boolean') {
        if (draft !== true) fails.push(layout + ': inst.paged is not a boolean (' + typeof paged + ')');
        paged = typeof inst._pSh === 'number' && inst._pSh !== 0;
    }
    if (paged !== (layout === 'paged')) fails.push(layout + ': inst.paged ' + paged + ' != layout ' + layout);
    const U = inst.universe !== undefined ? inst.universe : inst._u;
    const order = [];
    for (const r of ROWS) if (!order.includes(r.shape)) order.push(r.shape);
    for (const s of order) {
        let model;
        try {
            model = build(inst, s);
        } catch (e) {
            fails.push(layout + ' build ' + s + ': ' + (e && e.message));
            continue;
        }
        for (const r of ROWS) {
            if (r.shape !== s) continue;
            let res;
            try {
                res = measureRow(inst, meter, model, U, r, layout);
            } catch (e) {
                res = { id: r.id, s: 'threw', q: null, fails: [layout + ' ' + r.id + ' harness threw ' + (e && e.message)] };
            }
            out.push({ id: res.id, s: res.s, q: res.q });
            fails.push(...res.fails);
        }
    }
    return { fails, rows: out, paged, fields: meter.fields.slice() };
}

// --- worker entry -------------------------------------------------------------------------------------------

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData.roaringCountJob === true) {
    const { src, jobs } = workerData;
    const mod = await import(src === null ? '../LogLogN.js' : src);
    parentPort.postMessage({ phase: 'loaded', fails: [], hasRoaring: typeof mod.RoaringSet === 'function' });
    for (const j of jobs) {
        let res;
        try {
            if (typeof mod.RoaringSet !== 'function') throw new Error('RoaringSet is not exported');
            res = runJob(mod.RoaringSet, j.layout, j.args, false);
        } catch (e) {
            res = { fails: [j.layout + ' job threw ' + (e && e.stack ? e.stack : String(e))], rows: [] };
        }
        parentPort.postMessage({ phase: j.layout, ...res });
    }
}

// --- CUT mode (command line) ----------------------------------------------------------------------------------

if (isMainThread && process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
    const { resolve } = await import('node:path');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const argv = process.argv.slice(2);
    let modPath = null;
    let layout = null;
    let args = null;
    let ref = null;
    let outPath = null;
    let draft = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--cut') modPath = argv[++i];
        else if (a === '--layout') layout = argv[++i];
        else if (a === '--args') args = argv[++i].split(',').map(Number);
        else if (a === '--ref') ref = argv[++i];
        else if (a === '--out') outPath = argv[++i];
        else if (a === '--draft') draft = true;
        else { console.error('unknown argument ' + a); process.exit(2); }
    }
    if (modPath === null || (layout !== 'direct' && layout !== 'paged') || args === null || args.some((v) => !Number.isInteger(v))) {
        console.error('usage: node test/_roaring-count-worker.mjs --cut <module> --layout direct|paged --args U,maxSmall,maxLarge[,maxPages,pageBits] [--ref json] [--out json] [--draft]');
        process.exit(2);
    }
    const abs = resolve(modPath);
    const sha8 = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 8);
    const mod = await import(pathToFileURL(abs).href);
    const res = runJob(mod.RoaringSet, layout, args, draft);
    let refRows = null;
    if (ref !== null) {
        const j = JSON.parse(readFileSync(resolve(ref), 'utf8'));
        refRows = new Map(j.rows.map((r) => [r.id, r]));
    }
    let bad = res.fails.length;
    const lines = [];
    const rowsOut = [];
    for (const r of res.rows) {
        const def = ROWS.find((d) => d.id === r.id);
        let refTxt = '';
        let refV = null;
        if (refRows !== null) {
            const jr = refRows.get(def.ref);
            if (jr === undefined) {
                refTxt = ' | ref MISSING ' + def.ref;
                bad++;
            } else {
                const climb = jr.worst.from === 'climb';
                refV = climb ? jr.sweep.rdX : jr.worst.rdX;
                const at = climb ? jr.sweep.at : jr.worst.at;
                const atSame = def.x === undefined || (at && at.x === def.x);
                const got = readsOf(r.s);
                const ok = def.le ? got <= refV : got === refV;
                if (!ok) bad++;
                refTxt = ' | ref ' + (climb ? 'sweep ' : 'worst ') + refV + (atSame ? ' at this arg' : ' at another arg') + (def.le ? ' (le)' : '') +
                    ' w' + (climb ? jr.sweep.w : jr.worst.w) + ' mv' + (climb ? jr.sweep.mv : jr.worst.mv) + (ok ? ' ok' : ' DIFF');
            }
        }
        const q = r.q === null ? '' : (r.q.r + r.q.w + r.q.m > 0 ? ' | _q r' + r.q.r + ' w' + r.q.w + ' m' + r.q.m : '');
        lines.push(r.id + ' | ' + r.s + q + refTxt);
        rowsOut.push({ id: r.id, s: r.s, q: r.q, ref: refV });
    }
    console.log('# cut ' + abs + ' sha256/8 ' + sha8 + ' layout ' + layout + ' args ' + args.join(',') + ' paged ' + res.paged +
        ' node ' + process.version + ' v8 ' + process.versions.v8);
    console.log('# fields ' + res.fields.join(' '));
    for (const l of lines) console.log(l);
    for (const f of res.fails) console.log('FAIL ' + f);
    console.log('# rows ' + res.rows.length + ' fails ' + res.fails.length + ' ref-disagreements ' + (bad - res.fails.length) + ' | ' + (bad ? 'FAIL' : 'ok'));
    if (outPath !== null) writeFileSync(outPath, JSON.stringify({ module: abs, sha8, layout, args, paged: res.paged, fields: res.fields, rows: rowsOut, fails: res.fails }, null, 1));
    process.exitCode = bad ? 1 : 0;
}
