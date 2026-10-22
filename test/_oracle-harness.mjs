// _oracle-harness.mjs -- shared harness for Oracle.test.js (not a test file:
// the npm glob test/*.test.js does not match it). Holds the independent
// reference (Oracle), the seeded PRNG and the phased fuzz (runHarness). When
// loaded as a worker_threads Worker it runs one job and posts back
// {ops, div, first, cov}, so the parent can terminate a hung implementation
// (a synchronous infinite loop that no in-process timeout can stop).
// Written from the SPEC without reading LogLogN.js.
import { StratifiedBitset } from '../LogLogN.js';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

const LINEAR_MAX = 65536;

// mulberry32: 32-bit exact (Math.imul, >>> 0 throughout).
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0);
    };
}
function below(rng, n) { return rng() % n; } // n <= 2^32; slight bias is irrelevant here

export class Oracle {
    constructor(U) {
        this.U = U;
        this.m = new Uint8Array(U);
        this.n = 0;
        this.sorted = U > LINEAR_MAX ? [] : null;
    }
    // first index in sorted with value >= v
    lb(v) {
        const a = this.sorted;
        let lo = 0, hi = a.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] < v) lo = mid + 1; else hi = mid; }
        return lo;
    }
    add(x) {
        if (this.m[x]) return;
        this.m[x] = 1; this.n++;
        if (this.sorted) this.sorted.splice(this.lb(x), 0, x);
    }
    del(x) {
        if (!this.m[x]) return false;
        this.m[x] = 0; this.n--;
        if (this.sorted) this.sorted.splice(this.lb(x), 1);
        return true;
    }
    has(x) { return x >= 0 && x < this.U && this.m[x] === 1; }
    succ(x) { // smallest member > x
        if (this.sorted) {
            const a = this.sorted;
            let lo = 0, hi = a.length;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] <= x) lo = mid + 1; else hi = mid; }
            return lo < a.length ? a[lo] : undefined;
        }
        for (let i = x + 1; i < this.U; i++) if (this.m[i]) return i;
        return undefined;
    }
    pred(x) { // largest member < x; undefined for x >= U
        if (x >= this.U) return undefined;
        if (this.sorted) {
            const i = this.lb(x) - 1;
            return i >= 0 ? this.sorted[i] : undefined;
        }
        for (let i = x - 1; i >= 0; i--) if (this.m[i]) return i;
        return undefined;
    }
    min() { return this.sorted ? this.sorted[0] : this.succ(-1); }
    max() {
        if (this.sorted) return this.sorted[this.sorted.length - 1];
        for (let i = this.U - 1; i >= 0; i--) if (this.m[i]) return i;
        return undefined;
    }
    clear() { this.m.fill(0); this.n = 0; if (this.sorted) this.sorted.length = 0; }
}

// Harness: runs ops against Cls(U) and the oracle, comparing everything.
export function runHarness(Cls, U, totalOps, seed, cov) {
    const keyRng = mulberry32(seed ^ 0x9E3779B1);
    const opRng = mulberry32(seed ^ 0x85EBCA6B);
    const s = new Cls(U);
    const o = new Oracle(U);
    const st = { ops: 0, div: 0, first: null };

    function diverge(op, arg, got, want) {
        st.div++;
        if (!st.first) st.first = { U, op, arg, got, want, at: st.ops };
    }
    function cmp(op, arg, got, want) { if (!Object.is(got, want)) diverge(op, arg, got, want); }
    function chkState() {
        cmp('size', undefined, s.size, o.n);
        cmp('min', undefined, s.min(), o.min());
        cmp('max', undefined, s.max(), o.max());
    }
    function doAdd(x) {
        const key = (x === 0 && (opRng() & 7) === 0) ? -0 : x; // -0 aliases key 0
        const r = s.add(key);
        if (r !== s) diverge('add.return', key, r, s);
        o.add(x); st.ops++; chkState();
    }
    function doDel(x) {
        const key = (x === 0 && (opRng() & 7) === 0) ? -0 : x;
        cmp('delete', key, s.delete(key), o.del(x)); st.ops++; chkState();
    }
    function doHas(x) { cmp('has', x, s.has(x), o.has(x)); st.ops++; }
    function doSucc(x) {
        const want = o.succ(x);
        const got = s.successor(x);
        cmp('successor', x, got, want); st.ops++;
        if (cov && U >= 8192) {
            if (want === undefined && o.n > 0) cov.undefNonEmptySucc++;
            else if (want !== undefined && ((want >>> 10) - (x >>> 10)) >= 3) cov.crossSucc++;
            if (want === undefined && o.n > 0 && x >= U - 32) cov.lastWordSucc++;
        }
    }
    function doPred(x) {
        const want = o.pred(x);
        const got = s.predecessor(x);
        cmp('predecessor', x, got, want); st.ops++;
        if (cov && U >= 8192) {
            if (want !== undefined && x < U && ((x >>> 10) - (want >>> 10)) >= 3) cov.crossPred++;
        }
    }
    function doClear() { s.clear(); o.clear(); st.ops++; chkState(); }
    const bound = [0, 1, 31, 32, U - 2, U - 1].filter(v => v >= 0 && v < U);
    function rndKey() {
        const r = keyRng() & 7;
        if (r === 0) return bound[keyRng() % bound.length];
        return below(keyRng, U);
    }
    function qKey() { // query positions, may be U-1 or just beyond
        const r = keyRng() % 10;
        if (r === 0) return U - 1;
        if (r === 1) return bound[keyRng() % bound.length];
        return below(keyRng, U);
    }
    function predBeyond() { doPred(U + below(keyRng, 5)); }

    // Phase R: random mix, ~55% of budget. Add-heavy then delete-heavy waves.
    function phaseRandom(n) {
        for (let i = 0; i < n; i++) {
            if (U > 32 && (i % 20011) === 20010) { doClear(); continue; }
            const wave = ((i / 3000) | 0) & 1; // 0 add-heavy, 1 delete-heavy
            const r = opRng() % 100;
            if (r < (wave ? 15 : 35)) doAdd(rndKey());
            else if (r < (wave ? 45 : 50)) doDel(opRng() % 3 === 0 ? rndKey() : (o.n ? o.sorted ? o.sorted[below(keyRng, o.sorted.length)] : rndKey() : rndKey()));
            else if (r < 58) doHas(qKey());
            else if (r < 72) doSucc(qKey());
            else if (r < 86) doPred(qKey());
            else if (r < 90) { cmp('min', 0, s.min(), o.min()); st.ops++; }
            else if (r < 94) { cmp('max', 0, s.max(), o.max()); st.ops++; }
            else if (r < 97) predBeyond();
            else doDel(rndKey());
        }
    }
    // Phase S: sparse -- a handful of far-apart anchors, queries everywhere.
    function phaseSparse(n) {
        doClear();
        const K = Math.min(6, U);
        const anchors = [];
        for (let i = 0; i < K; i++) {
            const lo = Math.floor(i * U / K), hi = Math.floor((i + 1) * U / K);
            anchors.push(lo + below(keyRng, Math.max(1, hi - lo)));
        }
        for (let i = 0; i < n; i++) {
            const r = opRng() % 100;
            const a = anchors[below(keyRng, K)];
            if (r < 12) doAdd(a);
            else if (r < 22) doDel(a);
            else if (r < 30) doHas(a);
            else if (r < 62) doSucc(qKey());
            else if (r < 94) doPred(qKey());
            else if (r < 97) doSucc(a);
            else doPred(a);
        }
        // Targeted: members only at the two ends of the universe, queries between.
        doClear();
        doAdd(0); if (U > 1) doAdd(U - 1);
        for (let i = 0; i < n / 8; i++) { const x = qKey(); doSucc(x); doPred(x); }
        doClear();
    }
    // Phase D: dense -- fill then drain a whole 1,024 block with queries.
    function phaseDense(reps) {
        for (let rep = 0; rep < reps; rep++) {
            doClear();
            const blocks = Math.max(1, Math.ceil(U / 1024));
            const base = below(keyRng, blocks) * 1024;
            const end = Math.min(U, base + 1024);
            for (let k = base; k < end; k++) { doAdd(k); if ((k & 15) === 0) { doSucc(k); doPred(k); } }
            doSucc(end - 1); doPred(base); doSucc(base - 1 >= 0 ? base - 1 : 0);
            // drain in a shuffled-ish order (stride coprime with 1024)
            const len = end - base;
            for (let j = 0, k = 0; j < len; j++, k = (k + 37) % len) {
                if (o.has(base + k)) { doDel(base + k); if ((j & 7) === 0) { doSucc(base + k); doPred(base + k); } }
            }
            doSucc(base); doPred(end - 1);
        }
        doClear();
    }
    // Phase T: tail -- nonempty set, queries in last word / last block / near last member.
    function phaseTail(reps) {
        const lastWord = Math.max(0, (Math.ceil(U / 32) - 1) * 32);
        const lastBlock = Math.max(0, (Math.ceil(U / 1024) - 1) * 1024);
        for (let rep = 0; rep < reps; rep++) {
            doClear();
            // largest member early in the universe
            const early = Math.min(U - 1, below(keyRng, Math.max(1, Math.min(U, 4096))));
            doAdd(early);
            if ((rep & 1) && U > 1) doAdd(below(keyRng, Math.max(1, (U >>> 2))));
            for (let x = lastWord; x < U; x++) { doSucc(x); doPred(x); }
            for (let k = 0; k < 48; k++) {
                const x = lastBlock + below(keyRng, U - lastBlock);
                doSucc(x); doPred(x);
            }
            doSucc(U - 1); doSucc(Math.max(0, U - 2)); predBeyond();
            // a far-late member, then successor queries from just below it
            const late = Math.max(0, U - 1 - below(keyRng, Math.min(U, 3000)));
            doAdd(late);
            for (let d = 0; d <= 70 && late - d >= 0; d++) doSucc(late - d);
            for (let d = 0; d <= 3 && late + d < U; d++) { doSucc(late + d); doPred(late + d); }
            doSucc(U - 1);
            doDel(late);
            for (let x = lastWord; x < U; x++) doSucc(x);
            doSucc(Math.max(0, early - 1)); doSucc(early);
            // a member in the last word itself
            doAdd(U - 1);
            doSucc(Math.max(0, U - 2)); doPred(U - 1); doSucc(U - 1);
            doDel(U - 1);
        }
        doClear();
    }

    // Budget split: dense/tail/sparse have fixed-size footprints; random fills the rest.
    const isBig = U >= 8192;
    phaseTail(isBig ? 40 : 6);
    phaseDense(isBig ? 6 : 2);
    phaseSparse(isBig ? Math.min(20000, totalOps >> 3) : 500);
    const remaining = Math.max(0, totalOps - st.ops);
    phaseRandom(remaining);
    phaseTail(isBig ? 10 : 2);
    return st;
}


// Worker entry. mode: 'fuzz' | 'control' | 'selfcheck'.
if (!isMainThread && workerData && workerData.oracleJob) {
    const { mode, U, n, seed } = workerData;
    let out;
    if (mode === 'selfcheck') {
        const V = 70000, o = new Oracle(V), r = mulberry32(seed);
        for (let i = 0; i < 300; i++) o.add(r() % V);
        for (let i = 0; i < 100; i++) o.del(r() % V);
        let bad = 0;
        for (let i = 0; i < 400; i++) {
            const x = r() % V;
            let s = undefined; for (let k = x + 1; k < V; k++) if (o.m[k]) { s = k; break; }
            let p = undefined; for (let k = x - 1; k >= 0; k--) if (o.m[k]) { p = k; break; }
            if (o.succ(x) !== s || o.pred(x) !== p) bad++;
        }
        out = { ops: 400, div: bad, first: null, cov: null };
    } else {
        let Cls = StratifiedBitset;
        if (mode === 'control') {
            Cls = class Broken extends StratifiedBitset {
                successor(x) { return super.successor(x + 1); }
            };
        }
        const cov = { undefNonEmptySucc: 0, crossSucc: 0, crossPred: 0, lastWordSucc: 0 };
        const st = runHarness(Cls, U, n, seed, mode === 'control' ? null : cov);
        out = { ops: st.ops, div: st.div, first: st.first, cov };
    }
    parentPort.postMessage(out);
}
