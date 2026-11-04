/**
 * @zakkster/lite-loglogn -- RoaringSet torture lanes in a Worker (0.6.0 G5-B1a / B1b,
 * PLAN-roaringset-G5 tasks 1-4, SPEC C-10 / C-11 / C-20 / C-21). Not a test
 * file: the npm glob `test/*.test.js` never matches it. Inert when merely
 * imported (torture.mjs imports the constants and startRoaringTorture); a job
 * runs only as a node:worker_threads Worker (workerData.roaringTorture === true).
 *
 * Port of R/alloc-harness.mjs r2 (R = .handoff/research/roaring): lanes
 * 176-402 + the hi-key lanes 444-463, measurement 482-581, with the F46 fixes:
 *   - every transient lane re-measures its own empty-fn baseline right before it
 *     (a null baseline FAILS the lane);
 *   - a window is discarded when node:v8 GCProfiler saw ANY GC in it AND when
 *     its end reads below its start (`z < a`, kept from torture's nsLane);
 *   - the TurboFan status sentinel is 0, never -1 (-1 & TF_BIT is non-zero:
 *     a never-measured status would read as TurboFanned). Torture passes no
 *     --allow-natives-syntax, so every lane prints opt=UNCHECKED and the result
 *     carries tf 'UNCHECKED' (C-11: ni.* lanes and the TF check stay REPORTED
 *     from R0 logs r3-u4-best.log / r3-u4-bestp.log).
 *
 * Per gated lane (one public op per call, a cyclic script over Uint32Array
 * keys that restores the key set every cycle, so B/call = B/op):
 *   retained   measureAllocs MA_ITER/w x MA_BATCHES: round(B/call) === 0, settled
 *              (null = FAIL);
 *   transient  NS_W windows of NS_K calls, gc() before each, min over windows
 *              1..NS_W-1 minus the lane's own empty-fn baseline: excess <
 *              NS_MAX_EXCESS (null = FAIL);
 *              The baseline itself must satisfy nsBaseOk (0 <= base <= NS_BASE_MAX,
 *              torture's ceiling): a boxing / drifting baseline would subtract a real
 *              box away, so the lane's transient reads null (FAIL, BASE-REJECTED);
 *   gc         GcProfiler over max(25,000, GC_OPS / w) calls: major 0;
 *   ab         measureOps 'deep': arrayBuffers growth 0 and settled;
 *   restore    the script advanced to position 0, size === the built size, and
 *              every lane chunk's dump() kind === its kind at build (a lane that
 *              drifted off its labelled shape measured something else: FAIL);
 *   paged      set.paged === the job's wantPaged, checked at build (a mismatch
 *              FAILS the lane, even when every other channel passes);
 *   work       ops.* and gap.* only: a cold replay of ONE script cycle (after
 *              measurement) must move SINK by exactly what the labelled method,
 *              called directly in a separate oracle loop, yields on the same keys,
 *              and the cycle must be informative: has lanes hit count in (0, L);
 *              successor / predecessor hit count > 0 and >= 2 distinct results
 *              (runs.predecessor hits on every key: (0, L) would fail a clean lane);
 *              min / max (L = 1) a defined result;
 *              add lanes the size rises above the built size, delete lanes it falls
 *              below (else the step never ran the labelled op: FAIL, reason named);
 *   edges      conv.* and clear only: a cold pass of ONE whole script cycle on
 *              the measured instance AFTER measurement, dump() (public surface)
 *              after every step, must show each required kind transition of the
 *              lane (else the lane measured no conversion and FAILS).
 * The step of every lane (gated and hi) is compiled from its own source with
 * the lane marker INSIDE the step body, so each step has its own
 * SharedFunctionInfo / FeedbackVector AND a unique toString(). Self-check: the
 * count of steps whose source equals an earlier step's must be 0; its control
 * CR-dupSrc plants two closures of ONE literal (makeStep) and must count 1.
 *
 * Families (job.families, a non-empty subset, one Worker per job): ops 28 +
 * gap 3 + conv 6 + clear 1 = 38 gated lanes (FAMILY_LANES); hi = the 5 hi-key
 * lanes at U = 2^32 (keys and results >= 2^31), CONTROLS as torture's CV7:
 * hi.successor / predecessor / min / max must read transient excess >=
 * NS_MAX_EXCESS with every result >= 2^31 (share 1.0), hi.has must stay <
 * NS_MAX_EXCESS (has() inlines; the CR-has mutant flips it); every hi lane also
 * carries the work check. hi runs in its OWN job (families ['hi'], optionally
 * + 'retention'): after conv / clear in the same Worker every hi window read a
 * scavenge (G5-B1a r2: all 4 hi box controls null, fail closed). Observed
 * (G5-B1b MIXED-probe, fe4984e1; mechanism unproven): in the mixed job new_space
 * is committed at 2,097,152 B (hi-only jobs: 16,777,216-27,525,120 B), and one
 * hi.successor window allocates 2,097,152 B (32 B x NS_K), min / max 1 MB: every
 * window scavenges and is discarded. A mixed job is therefore an error. 'retention' = PLAN-G5 task 4 (below), no gated lanes.
 *
 * Controls (result.controls[], each { name, family, lanes, value, want,
 * flipped, detail }; a control that does not flip FAILS the job):
 *   CR-dupSrc  two closures of one literal: dupSources === 1 (every job);
 *   CR-limit   the pass / box predicates at the limit: nsPass(1023) && !nsPass
 *              (1024) && nsBox(1024) && !nsBox(1023), null / NaN fail both
 *              (a '<=' for '<' mutant flips it; every job);
 *   CR-paged   the job's first lane family rebuilt through buildLanes with the
 *              INVERTED wantPaged: every lane must read pagedOk false (a build
 *              that stops checking the layout flips it; lane jobs);
 *   CR-gcKick  the first lane's step + one globalThis.gc() at op 8,192 through
 *              gcLane: major >= 1, not ok, kicks === 1 (GC visibility inside a
 *              Worker; lane jobs);
 *   CR-box.<f> per lane family, on the family's first lane at the lane gate's
 *              settings: + one retained [i] per call -> round(retained) >= 1
 *              B/call, AND + a fresh [i] every 8th call into a heap slot (dies
 *              young) -> excess >= NS_MAX_EXCESS;
 *   engine mutants, data: URLs of the engine under test (job.src, else
 *   ../LogLogN.js read by the Worker), each anchor count-checked (count !== 1,
 *   a misplaced anchor or a '__cr' name already in the source = BAD: the control
 *   FAILS, fail closed), the targeted lanes rebuilt from the mutant module and
 *   measured on the named channel only:
 *   CR-has.<f> (ops / gap / hi) has() stores [c, lo] in a module binding: every
 *              has lane of the family (small / array / bitmap / runs, gap.has,
 *              hi.has) reads excess >= NS_MAX_EXCESS;
 *   CR-conv    add() allocates a scratch Uint32Array(64) per array -> bitmap
 *              promote (into a module binding): conv.4096<->4097 excess >=
 *              NS_MAX_EXCESS (16 promotes per NS_K window by construction);
 *   CR-abConv  the same scratch retained in a module-level hold: the
 *              conv.4096<->4097 'deep' arrayBuffers growth > 0;
 *   CR-retain  (retention jobs) the churn with every instance + dump also held:
 *              tracker.size() >= 1 after the drain.
 *
 * Retention (job family 'retention', layout = job.paged): RET_CYCLES 4,096
 * cycles, each builds RoaringSet(2^20, 2, 1[, maxPages, pageBits]), runs every
 * public op, takes dump(), and tracks BOTH (8,192 tracked) with a module-level
 * no-op cleanup and a string tag (neither captures the target); the churn has
 * its own frame. Gate: tracked 8,192, every instance's paged === wantPaged,
 * tracker.size() 0 after the drain and after one more gc, collected 8,192,
 * findings 0, leaks 0 (result.retention: layout, paged, cycles, tracked, size, after ===
 * sizeAfterGc, collected, findings, findingKinds, warnings, leaks, pagedMismatch, dumpBad, ok,
 * ms). result.retention is null in a job without the family;
 * a retention job with a null or failing retention FAILS.
 *
 * Layout knob: job.paged === null builds every set with the 3-argument
 * constructor (direct, wantPaged false); job.paged = { maxPages, pageBits }
 * passes them as arguments 4 / 5 (wantPaged true). On the G1 build every set is
 * direct, so a paged job FAILS every lane (the mismatch control).
 *
 * Parent side: startRoaringTorture(job, label, ms) spawns ONE Worker with a
 * kill timer and NEVER rejects: it resolves { result, error }; error is a
 * string on a spawn failure, a timeout, a worker error, a nonzero exit, a
 * posted { error } or a missing result. The Worker inherits the parent's
 * execArgv (--expose-gc); no globalThis.gc or a semi-space flag = { error }.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

// Method constants: NS_K / NS_W / NS_MAX_EXCESS are torture.mjs's (the caller
// checks ===); the rest are alloc-harness r2's per-lane budgets.
export const NS_K = 65536;
export const NS_W = 17;
export const NS_MAX_EXCESS = (16 * NS_K) / 1024;
// Ceiling on a lane's empty-fn baseline (B per NS_K-op window), torture's own constant and predicate
// (test/torture.mjs, frozen .handoff/frozen/g5/torture.4d9c29a.e9dd09e7.mjs :126-137): a baseline that
// boxes or drifts up would calibrate a real box away. Measured G1 Worker bases 1,784-1,832 (e0f18ff8,
// .handoff/evidence/g5-b1a/driver-r2-run3.log, 38 lanes, PRELIMINARY host load1 39.7).
export const NS_BASE_MAX = 4 * NS_MAX_EXCESS;
function nsBaseOk(b) { return Number.isInteger(b) && b >= 0 && b <= NS_BASE_MAX; }
/** The transient pass / box predicates, the ONLY comparisons with NS_MAX_EXCESS (CR-limit pins both). */
export function nsPass(x) { return typeof x === 'number' && x < NS_MAX_EXCESS; }
export function nsBox(x) { return typeof x === 'number' && x >= NS_MAX_EXCESS; }
export const MA_ITER = 65536;
export const MA_BATCHES = 4;
export const GC_OPS = 400000;
export const MO_OPS = 100000;
export const MO_WARM = 25000;
export const WARM_CALLS = 131072;
// Per-job kill timer: 4.5x the slowest G1 job measured (direct-ops 6.4-13.4 s over 3 runs, load1 9.5-16.7,
// PRELIMINARY host; .handoff/evidence/roaring-g5-b1a.md). A hang or a stuck job is a FAIL, never a wait.
export const KILL_MS = 60000;
/** Retention churn cycles per job (each tracks the instance AND its dump(): 2 x RET_CYCLES tracked). */
export const RET_CYCLES = 4096;
/** Gated lane count per family (fail closed: a family that builds fewer is an error). */
export const FAMILY_LANES = Object.freeze({ ops: 28, gap: 3, conv: 6, clear: 1 });
/** hi-key control lanes (family 'hi'). */
export const HI_OPS = Object.freeze(['has', 'successor', 'predecessor', 'min', 'max']);
const FAMILY_ORDER = ['ops', 'gap', 'conv', 'clear', 'hi', 'retention'];
const JOB_KEYS = ['src', 'families', 'paged'];
const TF_BIT = 32;
const HI_MIN = 2147483648;

const SELF_URL = new URL(import.meta.url);

// ---- parent side -------------------------------------------------------------------

/** Starts job in a fresh Worker (see the header). Never rejects. */
export function startRoaringTorture(job, label, ms = KILL_MS) {
    return new Promise((resolve) => {
        let result = null;
        let done = false;
        let w;
        try {
            w = new Worker(SELF_URL, { workerData: { roaringTorture: true, job } });
        } catch (e) {
            resolve({ result: null, error: label + ' worker spawn error: ' + (e && e.message ? e.message : String(e)) });
            return;
        }
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ result: error === null ? result : null, error: error === null && result === null ? label + ' worker posted no result' : error });
        };
        const timer = setTimeout(() => {
            w.terminate();
            finish('TIMEOUT > ' + ms + ' ms: ' + label + ' worker terminated');
        }, ms);
        w.on('message', (m) => {
            if (m !== null && typeof m === 'object' && typeof m.error === 'string') finish(label + ' worker FAIL: ' + m.error);
            else result = m;
        });
        w.on('error', (e) => finish(label + ' worker error: ' + (e && e.message ? e.message : String(e))));
        w.on('exit', (code) => finish(code === 0 ? null : label + ' worker exit code ' + code));
    });
}

/**
 * Counts the steps whose toString() equals an earlier step's (0 = every lane has
 * its own source). Cold.
 */
export function dupSources(fns) {
    const seen = new Set();
    let dup = 0;
    for (const f of fns) {
        const s = Function.prototype.toString.call(f);
        if (seen.has(s)) dup++;
        else seen.add(s);
    }
    return dup;
}

// ---- the step (one literal; every lane compiles its body text with its marker) ------

const OP_ADD = 0, OP_DEL = 1, OP_HAS = 2, OP_SUCC = 3, OP_PRED = 4, OP_MIN = 5, OP_MAX = 6;
const OP_RUNOPT = 7, OP_CLEAR = 12;
const OP_LAST = 12;

// A cyclic script (ops[p], keys[p]) on `set` (and `other` for the set ops of
// G5-B4). Const bindings only; position and sink live in Int32Array slots (no
// mutable number in a context, no box from the harness itself).
function makeStep(set, other, ops, keys, SINK) {
    const L = ops.length;
    const st = new Int32Array(1);
    const step = function step() {
        const p = st[0];
        const x = keys[p];
        let r = 0;
        switch (ops[p]) {
            case 0: set.add(x); break;
            case 1: r = set.delete(x) ? 1 : 0; break;
            case 2: r = set.has(x) ? 1 : 0; break;
            case 3: { const v = set.successor(x); r = v === undefined ? 7 : v; break; }
            case 4: { const v = set.predecessor(x); r = v === undefined ? 7 : v; break; }
            case 5: { const v = set.min(); r = v === undefined ? 7 : v; break; }
            case 6: { const v = set.max(); r = v === undefined ? 7 : v; break; }
            case 7: set.runOptimize(); break;
            case 8: r = set.intersects(other) ? 1 : 0; break;
            case 9: r = set.intersectionSize(other); break;
            case 10: r = set.unionSize(other); break;
            case 11: r = set.differenceSize(other); break;
            case 12: set.clear(); break;
        }
        SINK[0] = (SINK[0] + r) | 0;
        const q = p + 1;
        st[0] = q === L ? 0 : q;
    };
    step.st = st;
    return step;
}
const STEP_HEAD = 'const step = function step() {';

function stepSource() {
    const s = Function.prototype.toString.call(makeStep);
    const body = s.slice(s.indexOf('{') + 1, s.lastIndexOf('}'));
    if (body.split(STEP_HEAD).length !== 2) throw new Error('step source: anchor count != 1');
    return body;
}

// ---- worker side -------------------------------------------------------------------

const SEMI_FLAG = /semi[-_]space|young[-_]generation/;

function checkJob(job) {
    if (job === null || typeof job !== 'object' || Array.isArray(job)) throw new TypeError('job must be a plain object');
    for (const k of Object.keys(job)) {
        if (!JOB_KEYS.includes(k)) throw new TypeError('unknown job key ' + k + ' (known: ' + JOB_KEYS.join(', ') + ')');
    }
    if (job.src !== null && typeof job.src !== 'string') throw new TypeError('job.src must be null or a source string');
    if (!Array.isArray(job.families) || job.families.length === 0) throw new TypeError('job.families must be a non-empty array');
    for (const f of job.families) {
        if (!FAMILY_ORDER.includes(f)) throw new TypeError('unknown family ' + String(f) + ' (known: ' + FAMILY_ORDER.join(', ') + ')');
    }
    if (new Set(job.families).size !== job.families.length) throw new TypeError('job.families has a duplicate');
    if (job.families.includes('hi') && job.families.some((f) => f !== 'hi' && f !== 'retention')) {
        throw new TypeError('family hi runs in its own job (families [hi] or [hi, retention]; see the header)');
    }
    const pg = job.paged;
    if (pg !== null && (typeof pg !== 'object' || !Number.isInteger(pg.maxPages) || !Number.isInteger(pg.pageBits) ||
        Object.keys(pg).length !== 2)) {
        throw new TypeError('job.paged must be null or { maxPages, pageBits } (integers)');
    }
}

function settle(ms) { return new Promise((r) => setTimeout(r, ms)); }
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0); }
function range(n, f) { const a = []; for (let j = 0; j < n; j++) a.push(f(j)); return a; }

function script(pairs) {
    const ops = new Int32Array(pairs.length);
    const keys = new Uint32Array(pairs.length);
    for (let i = 0; i < pairs.length; i++) {
        const op = pairs[i][0];
        if (!Number.isInteger(op) || op < 0 || op > OP_LAST) throw new Error('script: bad op ' + op);
        ops[i] = op;
        keys[i] = pairs[i][1];
    }
    return { ops, keys };
}

// Shapes (key sets inside one chunk, lo = the low 16 bits), alloc-harness r2.
const SHAPES = {
    small: { lo: range(40, (j) => 1000 + 1500 * j), opt: false },
    array: { lo: range(2000, (j) => 32 * j + (j % 7)), opt: false },
    // 8 clusters x 704 odd keys: bit 31 set in every data word; 5,632 runs keep it a bitmap
    bitmap: { lo: range(5632, (j) => 8192 * ((j / 704) | 0) + 1 + 2 * (j % 704)), opt: false },
    runs: { lo: range(20000, (j) => 600 * ((j / 200) | 0) + (j % 200)), opt: true },
};

function kindsOf(set, chunks) {
    const by = new Map();
    for (const e of set.dump().chunks) by.set(e.chunk, e.kind);
    return chunks.map((c) => (by.has(c) ? by.get(c) : 'empty'));
}

/** The layout check of every build site (lanes, hi, retention): CR-paged pins it. */
function pagedMatch(set, want) { return set.paged === want; }

/** Builds the lanes of the job's families. invert (CR-paged only) flips wantPaged. Cold. */
function buildLanes(RoaringSet, job, SINK, BODY, invert = false) {
    const pg = job.paged;
    const wantPaged = (pg !== null) !== invert;
    const mkSet = pg === null ? (U, s, l) => new RoaringSet(U, s, l) : (U, s, l) => new RoaringSet(U, s, l, pg.maxPages, pg.pageBits);
    const build = (U, maxS, maxL, parts) => {
        const s = mkSet(U, maxS, maxL);
        for (const [chunk, shape] of parts) for (const lo of shape.lo) s.add(chunk * 65536 + lo);
        if (parts.some((p) => p[1].opt)) s.runOptimize();
        return s;
    };
    const lanes = [];
    const hi = [];
    const stepFor = (name, set, other, sc) => {
        if (!/^[\x20-\x7e]+$/.test(name)) throw new Error('lane name not printable ASCII: ' + name);
        const tag = STEP_HEAD + '\n        // lane ' + (lanes.length + hi.length) + ' ' + name;
        const marked = BODY.replace(STEP_HEAD, () => tag);                 // function replacer: '$' in a name is literal
        return new Function('set', 'other', 'ops', 'keys', 'SINK', marked)(set, other, sc.ops, sc.keys, SINK);
    };
    const lane = (name, group, w, set, sc, chunks, edges) => {
        // ops.* / gap.*: the labelled method is the name's last segment (the work check's oracle)
        const work = group.startsWith('ops-') || group === 'gap' ? name.slice(name.lastIndexOf('.') + 1) : null;
        if (work !== null && !WORK_OPS.includes(work)) throw new Error('lane ' + name + ': no work oracle for ' + work);
        lanes.push({ name, group, w, set, other: null, sc, chunks, edges, work, step: stepFor(name, set, null, sc),
            size0: set.size, kinds0: kindsOf(set, chunks).join(','), pagedOk: pagedMatch(set, wantPaged) });
    };
    const fam = new Set(job.families);

    if (fam.has('ops')) {
        // ops-<shape>: has / add / delete / successor / predecessor / min / max, one chunk C per instance
        const C = 5;
        for (const name of Object.keys(SHAPES)) {
            const sh = SHAPES[name];
            const base = C * 65536;
            const present = new Set(sh.lo);
            const r = lcg(0x9e3779b9 ^ name.length * 7919);
            const pick = () => sh.lo[r() % sh.lo.length];
            const rlo = () => r() >>> 16;
            const absent = [];
            for (let j = 0; absent.length < 2048; j++) {
                let lo;
                if (name === 'runs' && j % 3 === 1) lo = 600 * (1 + (r() % 99)) + 200;          // end + 1
                else if (name === 'runs' && j % 3 === 2) lo = 600 * (1 + (r() % 99)) - 1;       // start - 1
                else lo = rlo();
                if (present.has(lo)) continue;
                if (name === 'runs' && j % 3 === 0 && (present.has(lo - 1) || present.has(lo + 1))) continue;
                absent.push(lo);
            }
            const q = []; for (let i = 0; i < 65536; i++) q.push(base + ((i & 1) === 0 ? rlo() : pick()));
            const mk = () => build(1 << 20, 8, 8, [[C, sh]]);
            const P = (op) => script(q.map((x) => [op, x]));
            const sAdd = []; for (let j = 0; j < 2048; j++) { const a = base + absent[j]; sAdd.push([OP_ADD, a], [OP_ADD, base + pick()], [OP_DEL, a]); }
            const sDel = []; for (let j = 0; j < 2048; j++) { const p = base + pick(); sDel.push([OP_DEL, p], [OP_DEL, p], [OP_ADD, p]); }
            const g = 'ops-' + name;
            lane(name + '.has', g, 1, mk(), P(OP_HAS), [C], null);
            lane(name + '.add', g, 1, mk(), script(sAdd), [C], null);
            lane(name + '.delete', g, 1, mk(), script(sDel), [C], null);
            lane(name + '.successor', g, 1, mk(), P(OP_SUCC), [C], null);
            lane(name + '.predecessor', g, 1, mk(), P(OP_PRED), [C], null);
            lane(name + '.min', g, 1, mk(), script([[OP_MIN, 0]]), [C], null);
            lane(name + '.max', g, 1, mk(), script([[OP_MAX, 0]]), [C], null);
        }
    }

    if (fam.has('gap')) {
        // U = 2^31 (keys < 2^31), chunks far apart: successor / predecessor cross every top-pyramid level
        const GAPC = [[3, SHAPES.small], [31, SHAPES.small], [1000, SHAPES.array], [1023, SHAPES.small],
            [20000, SHAPES.bitmap], [32767, SHAPES.runs]];
        const mk = () => build(2147483648, 8, 8, GAPC);
        const r = lcg(0x2545f491);
        const qS = [], qP = [], qH = [];
        for (let i = 0; i < 65536; i++) {
            const g = GAPC[r() % GAPC.length];
            const sh = g[1];
            if ((i & 7) === 0) {
                qS.push(g[0] * 65536 + sh.lo[sh.lo.length - 1]);
                qP.push(g[0] * 65536 + sh.lo[0]);
                qH.push(g[0] * 65536 + sh.lo[r() % sh.lo.length]);
            } else {
                const x = (r() % 32768) * 65536 + (r() >>> 16);
                qS.push(x); qP.push(x); qH.push(x);
            }
        }
        const chunks = GAPC.map((g) => g[0]);
        lane('gap.has', 'gap', 1, mk(), script(qH.map((x) => [OP_HAS, x])), chunks, null);
        lane('gap.successor', 'gap', 1, mk(), script(qS.map((x) => [OP_SUCC, x])), chunks, null);
        lane('gap.predecessor', 'gap', 1, mk(), script(qP.map((x) => [OP_PRED, x])), chunks, null);
    }

    if (fam.has('conv')) {
        // Every cycle crosses its edges BOTH ways and restores the key set. The
        // shipped hysteresis (DEMOTE_SMALL 32, DEMOTE_BITMAP 2048) means a
        // promote edge is re-crossed only after the delete side reaches the
        // demote point, so 64<->65 and 4096<->4097 cycle down to 32 / 2048.
        const B = 3 * 65536;
        // 0<->1: empty <-> SINGLE, and SINGLE <-> 2 keys (small slot; large slot when maxSmall = 0)
        const s01 = [];
        {
            const r = lcg(11);
            for (let j = 0; j < 128; j++) {
                const x = B + (r() >>> 16);
                let y = B + (r() >>> 16);
                if (y === x) y = x === B ? B + 1 : x - 1;
                s01.push([OP_ADD, x], [OP_DEL, x], [OP_ADD, x], [OP_ADD, y], [OP_DEL, x], [OP_DEL, y]);
            }
        }
        lane('conv.0<->1', 'conversion', 1, mkSet(1 << 20, 4, 4), script(s01), [3],
            ['empty>single', 'single>empty', 'single>small', 'small>single']);
        lane('conv.0<->1.noSmall', 'conversion', 1, mkSet(1 << 20, 0, 4), script(s01), [3],
            ['empty>single', 'single>empty', 'single>array', 'array>single']);
        // 64<->65: small (64) -> array (65) -> delete 33 -> small (32) -> re-add 32 -> small (64), 16 ranks
        {
            const lo = range(64, (j) => 100 + 512 * j);
            const set = build(1 << 20, 4, 4, [[3, { lo, opt: false }]]);
            const s = []; const r = lcg(13);
            for (let j = 0; j < 16; j++) {
                const n = B + 100 + 512 * (r() % 64) + 1 + (r() % 500);
                const perm = lo.slice();
                for (let i = perm.length - 1; i > 0; i--) { const t = r() % (i + 1); const v = perm[i]; perm[i] = perm[t]; perm[t] = v; }
                const del = perm.slice(0, 32).map((v) => B + v);
                s.push([OP_ADD, n], [OP_DEL, n]);
                for (const p of del) s.push([OP_DEL, p]);
                for (const p of del) s.push([OP_ADD, p]);
            }
            lane('conv.64<->65', 'conversion', 1, set, script(s), [3], ['small>array', 'array>small']);
        }
        // 4096<->4097: array (4096) -> bitmap (4097) -> delete 2049 -> array (2048) -> re-add -> array (4096)
        {
            const lo = range(4096, (j) => 16 * j);
            const set = build(1 << 20, 4, 4, [[3, { lo, opt: false }]]);
            const s = []; const r = lcg(17);
            for (let j = 0; j < 4; j++) {
                const n = B + 16 * (r() % 4096) + 8;
                const perm = lo.slice();
                for (let i = perm.length - 1; i > 0; i--) { const t = r() % (i + 1); const v = perm[i]; perm[i] = perm[t]; perm[t] = v; }
                const del = perm.slice(0, 2048).map((v) => B + v);
                s.push([OP_ADD, n], [OP_DEL, n]);
                for (const p of del) s.push([OP_DEL, p]);
                for (const p of del) s.push([OP_ADD, p]);
            }
            lane('conv.4096<->4097', 'conversion', 2, set, script(s), [3], ['array>bitmap', 'bitmap>array']);
        }
        // run spill 2048 <-> 2049 and bitmap -> runs: 2,047 isolated keys {0, 2, .., 4092} + run [8192, 65535]
        {
            const lo = range(2046, (j) => 2 * j);
            for (let v = 8192; v < 65536; v++) lo.push(v);
            const set = build(1 << 20, 4, 4, [[3, { lo, opt: true }]]);
            set.add(B + 4092);
            const s = [
                [OP_ADD, B + 5000], [OP_DEL, B + 5000], [OP_ADD, B + 1], [OP_RUNOPT, 0], [OP_DEL, B + 1],
                [OP_DEL, B + 9000], [OP_ADD, B + 9000], [OP_ADD, B + 1], [OP_RUNOPT, 0], [OP_DEL, B + 1],
            ];
            lane('conv.runSpill+bmp->runs', 'conversion', 8, set, script(s), [3], ['runs>bitmap', 'bitmap>runs']);
        }
        // array -> runs -> array: [0..99]; runOptimize; delete odd 1..97; runOptimize; re-add
        {
            const set = build(1 << 20, 4, 4, [[3, { lo: range(100, (j) => j), opt: false }]]);
            const s = [[OP_RUNOPT, 0]];
            for (let v = 1; v <= 97; v += 2) s.push([OP_DEL, B + v]);
            s.push([OP_RUNOPT, 0]);
            for (let v = 1; v <= 97; v += 2) s.push([OP_ADD, B + v]);
            lane('conv.array->runs->array', 'conversion', 2, set, script(s), [3], CONV_ARR_EDGES);
        }
    }

    if (fam.has('clear')) {
        // clear() on a populated set (5 kinds), then re-add the key set and runOptimize: the build again.
        // A 363-op cycle puts ~180 clear() calls in every NS_K window, so one 16 B box per clear reads
        // ~2,900 B excess (>= NS_MAX_EXCESS); a bitmap (>= 4,097 adds per cycle) would dilute that 12x,
        // and clear() frees a bitmap through the same branch as an array / runs container.
        const CL = [[0, { lo: [7], opt: false }], [1, SHAPES.small],
            [2, { lo: range(100, (j) => 600 * j + (j % 7)), opt: false }],
            [4, { lo: range(100, (j) => 1000 * ((j / 10) | 0) + (j % 10)), opt: true }],
            [6, { lo: range(120, (j) => 100 * ((j / 3) | 0) + (j % 3)), opt: true }]];
        const set = build(1 << 20, 8, 8, CL);
        const s = [[OP_CLEAR, 0]];
        for (const [chunk, shape] of CL) for (const v of shape.lo) s.push([OP_ADD, chunk * 65536 + v]);
        s.push([OP_RUNOPT, 0]);
        lane('clear', 'clear', 1, set, script(s), CL.map((p) => p[0]),
            ['single>empty', 'small>empty', 'array>empty', 'smallRuns>empty', 'runs>empty']);
    }

    let share = null;
    if (fam.has('hi')) {
        // U = 2^32, set and queries in [2^31, 2^32): every returned key is >= 2^31 (a HeapNumber across a
        // call V8 does not inline). Controls as torture's CV7 (see the header).
        const HI = [[32768, SHAPES.small], [40000, SHAPES.array], [50000, SHAPES.bitmap], [65535, SHAPES.runs]];
        const mk = () => build(4294967296, 4, 4, HI);
        const r = lcg(0xabcdef);
        const q = [];
        for (let i = 0; i < 65536; i++) {
            const g = HI[r() & 3];
            q.push((i & 1) === 0 ? g[0] * 65536 + g[1].lo[r() % g[1].lo.length] : (32768 + (r() % 32768)) * 65536 + (r() >>> 16));
        }
        {
            const t = mk();
            let ds = 0, dp = 0;
            for (const x of q) {
                const a = t.successor(x), b = t.predecessor(x);
                if (a !== undefined && a >= HI_MIN) ds++;
                if (b !== undefined && b >= HI_MIN) dp++;
            }
            share = { successor: ds / q.length, predecessor: dp / q.length, min: t.min() >= HI_MIN, max: t.max() >= HI_MIN };
        }
        const chunks = HI.map((g) => g[0]);
        const sc = { has: script(q.map((x) => [OP_HAS, x])), successor: script(q.map((x) => [OP_SUCC, x])),
            predecessor: script(q.map((x) => [OP_PRED, x])), min: script([[OP_MIN, 0]]), max: script([[OP_MAX, 0]]) };
        for (const op of HI_OPS) {
            const set = mk();
            const name = 'hi.' + op;
            hi.push({ name, op, work: op, set, sc: sc[op], chunks, step: stepFor(name, set, null, sc[op]), size0: set.size,
                pagedOk: pagedMatch(set, wantPaged) });
        }
    }
    for (const f of Object.keys(FAMILY_LANES)) {
        if (!fam.has(f)) continue;
        const n = lanes.filter((l) => familyOf(l) === f).length;
        if (n !== FAMILY_LANES[f]) throw new Error('family ' + f + ' built ' + n + ' lanes, want ' + FAMILY_LANES[f]);
    }
    return { lanes, hi, share, wantPaged };
}

// array -> runs -> array: the required transitions (the 100-key array is a small-pool
// container at build only if it fits; runs past 32 move to a large slot).
const CONV_ARR_EDGES = ['array>smallRuns', 'smallRuns>runs', 'runs>array'];
// The labelled methods the work check has an oracle for.
const WORK_OPS = ['has', 'successor', 'predecessor', 'min', 'max', 'add', 'delete'];

function familyOf(l) {
    if (l.group.startsWith('ops-')) return 'ops';
    if (l.group === 'conversion') return 'conv';
    return l.group;
}

// ---- measurement (alloc-harness r2 482-581 + F46) ------------------------------------

function makeMeasure(lib) {
    const { measureAllocs, measureOps, GcProfiler, checkNoGc, getHeapSpaceStatistics, GCProfiler, optStatus, SINK } = lib;
    function newSpaceUsed() {
        const a = getHeapSpaceStatistics();
        for (let j = 0; j < a.length; j++) if (a[j].space_name === 'new_space') return a[j].space_used_size;
        return -1;
    }
    // cold diagnostic: the new space's committed size (hi windows box ~2 MB each)
    function newSpaceSize() {
        const a = getHeapSpaceStatistics();
        for (let j = 0; j < a.length; j++) if (a[j].space_name === 'new_space') return a[j].space_size;
        return -1;
    }
    function nsLane(fn, opt) {
        for (let i = 0; i < NS_K * 2; i++) fn(i);
        let min = -1, first = -1, valid = 0;
        for (let w = 0; w < NS_W; w++) {
            if (w === 1 && opt) opt.before = optStatus(fn);
            globalThis.gc();
            const gp = new GCProfiler();
            gp.start();
            const a = newSpaceUsed();
            for (let i = 0; i < NS_K; i++) fn(i);
            const z = newSpaceUsed();
            const gcs = gp.stop().statistics.length;               // stop first: a profiler is never left running
            if (a < 0 || z < 0 || z < a || gcs !== 0) continue;
            const d = z - a;
            if (w === 0) { first = d; continue; }
            valid++;
            if (min < 0 || d < min) min = d;
        }
        if (opt) opt.after = optStatus(fn);
        return valid >= (NS_W >>> 1) ? { min, first, valid } : null;
    }
    const emptyFn = function empty(i) { SINK[0] = (SINK[0] + (i & 1)) | 0; };
    const baseSeen = new Float64Array(1);                     // cold diagnostic: the last baseline read (-1 = none)
    function nsExcess(fn, opt) {
        const b = nsLane(emptyFn, null);
        baseSeen[0] = b === null ? -1 : b.min;
        if (b === null || !nsBaseOk(b.min)) return null;
        const r = nsLane(fn, opt);
        if (r === null) return null;
        return { excess: r.min - b.min, first: r.first - b.min, valid: r.valid, base: b.min };
    }
    async function gcLane(fn, ops) {
        globalThis.gc();
        await settle(50);
        const g = new GcProfiler().start();
        for (let i = 0; i < ops; i++) {
            fn(i);
            if ((i & 8191) === 0) g.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
        await settle(50);
        const s = g.summary();
        const rep = checkNoGc(s, { maxMajor: 0 });
        g.stop();
        return { major: s.gc.major, minor: s.gc.minor, maxMs: s.gc.maxMs, ok: rep.ok === true };
    }
    function abLane(fn, w) {
        const ops = Math.max(10000, (MO_OPS / w) | 0);
        const mo = measureOps(fn, { ops, warmup: Math.max(2500, (MO_WARM / w) | 0), stabilize: 'deep' });
        const ab = mo.summary.arrayBuffers;
        const rep = checkNoGc(mo.summary, { maxArrayBuffersGrowth: 0 });
        return { ops, growth: ab.growthBytes, settled: ab.settled === true,
            ok: rep.verdict === 'pass' && ab.settled === true && ab.growthBytes === 0 };
    }
    // CR-box, two shapes (G5-B1b r2), at the lane gate's settings. Retained channel: the lane's step + one
    // retained [i] per call (torture C1 / harness ctl-box shape). Transient channel: the step + a fresh [i]
    // every 8th call into a heap slot (never a local), overwritten so it dies young: an all-surviving box can
    // be pretenured out of new space and read clean (r1 flake: excess -32), and an every-call box (2 MB per
    // window) scavenges a 2 MB new space every window (null). Cold.
    function boxControl(step, w) {
        const hold = [];
        const fn = function box(i) { step(i); hold.push([i]); };
        const ma = measureAllocs(fn, { iterations: Math.max(4096, (MA_ITER / w) | 0), batches: MA_BATCHES });
        hold.length = 0;
        const slot = [null];
        const fnT = function boxT(i) { step(i); if ((i & 7) === 0) slot[0] = [i]; };
        const ns = nsExcess(fnT, null);
        slot[0] = null;
        const retained = ma.bytesPerCall;
        const excess = ns === null ? null : ns.excess;
        return { retained, excess, flipped: retained !== null && Math.round(retained) >= 1 && nsBox(excess) };
    }
    // CR-gcKick: the step + ONE globalThis.gc() (a full GC) at op 8,192 inside gcLane's window. Cold.
    async function gcKickControl(step) {
        const kick = new Int32Array(1);
        const fn = function gcKick(i) { step(i); if (i === 8192) { kick[0]++; globalThis.gc(); } };
        const g = await gcLane(fn, 25000);
        return { major: g.major, minor: g.minor, ok: g.ok, kicks: kick[0], flipped: !g.ok && g.major >= 1 && kick[0] === 1 };
    }
    function finishCycle(l) {
        let guard = 0;
        while (l.step.st[0] !== 0 && guard++ < 1e7) l.step(0);
        return l.step.st[0] === 0 && l.set.size === l.size0;
    }
    // Cold, allocating (dump per step): one whole script cycle from position 0 on the measured instance.
    function edgeCheck(l) {
        const seen = new Set();
        let prev = kindsOf(l.set, l.chunks);
        const L = l.sc.ops.length;
        for (let i = 0; i < L; i++) {
            l.step(0);
            const cur = kindsOf(l.set, l.chunks);
            for (let j = 0; j < cur.length; j++) if (cur[j] !== prev[j]) seen.add(prev[j] + '>' + cur[j]);
            prev = cur;
        }
        const missing = l.edges.filter((e) => !seen.has(e));
        return { seen: [...seen].sort(), missing, back: l.step.st[0] === 0 && l.set.size === l.size0 };
    }
    // Cold, allocating: the work check (see the header). Step replay of one cycle from position 0, then a
    // separate oracle loop that calls the LABELLED method (l.work) directly. Query lanes: the oracle never
    // reads ops[] (a wrong op code in the script reads as a SINK mismatch). add / delete lanes: the oracle
    // replays the script with its own dispatch, admits only add / delete codes, and must reproduce the
    // step's SINK and size trace; informative = the step's trace rose (add) / fell (delete) past size0.
    function workCheck(l) {
        const set = l.set, ops = l.sc.ops, keys = l.sc.keys, L = ops.length, s0 = l.size0;
        if (l.step.st[0] !== 0 || set.size !== s0) return { ok: false, reason: 'not at cycle start' };
        const trace = new Float64Array(L);
        const before = SINK[0];
        for (let p = 0; p < L; p++) { l.step(0); trace[p] = set.size; }
        const got = (SINK[0] - before) | 0;
        if (l.step.st[0] !== 0 || set.size !== s0) return { ok: false, reason: 'step replay did not restore the cycle' };
        let want = 0, hits = 0, lo = s0, hi = s0, r0 = 0, varied = false;
        if (l.work === 'add' || l.work === 'delete') {
            for (let p = 0; p < L; p++) {
                const x = keys[p];
                let r = 0;
                if (ops[p] === OP_ADD) set.add(x);
                else if (ops[p] === OP_DEL) r = set.delete(x) ? 1 : 0;
                else return { ok: false, reason: 'op ' + ops[p] + ' at ' + p + ' in the ' + l.work + ' lane (add / delete only)' };
                want = (want + r) | 0;
                if (set.size !== trace[p]) return { ok: false, reason: 'size trace differs from the oracle at ' + p };
                if (trace[p] < lo) lo = trace[p];
                if (trace[p] > hi) hi = trace[p];
            }
            if (set.size !== s0) return { ok: false, reason: 'oracle replay did not restore the cycle' };
        } else {
            for (let p = 0; p < L; p++) {
                const x = keys[p];
                let r;
                if (l.work === 'has') { r = set.has(x) ? 1 : 0; hits += r; } else {
                    const v = l.work === 'successor' ? set.successor(x) : l.work === 'predecessor' ? set.predecessor(x)
                        : l.work === 'min' ? set.min() : set.max();
                    if (v !== undefined) hits++;
                    r = v === undefined ? 7 : v;
                }
                if (p === 0) r0 = r;
                else if (r !== r0) varied = true;
                want = (want + r) | 0;
            }
        }
        const info = l.work === 'add' ? 'size max ' + hi + ' vs built ' + s0 : l.work === 'delete' ? 'size min ' + lo + ' vs built ' + s0
            : 'hits ' + hits + '/' + L + (l.work === 'successor' || l.work === 'predecessor' ? (varied ? ', varied' : ', CONSTANT') : '');
        if (got !== want) return { ok: false, reason: 'SINK delta ' + got + ' != oracle ' + l.work + ' ' + want + ' (' + info + ')' };
        const informative = l.work === 'add' ? hi > s0 : l.work === 'delete' ? lo < s0
            : L === 1 ? hits === 1 : l.work === 'has' ? hits > 0 && hits < L
                : hits > 0 && varied && want !== 0 && want !== ((7 * L) | 0);
        if (!informative) return { ok: false, reason: 'uninformative cycle (' + info + ')' };
        return { ok: true, reason: info };
    }
    async function measure(l) {
        const t0 = performance.now();
        const res = { name: l.name, group: l.group, family: familyOf(l), weight: l.w, opsPerCall: 1,
            pagedOk: l.pagedOk, kindsBuilt: l.kinds0 };
        try {
            const maIter = Math.max(4096, (MA_ITER / l.w) | 0);
            const ma = measureAllocs(l.step, { iterations: maIter, batches: MA_BATCHES });
            res.retainedBpc = ma.bytesPerCall;
            res.retainedSettled = ma.settled === true;
            res.retainedIter = maIter;
            res.retainedOk = ma.bytesPerCall !== null && ma.settled === true && Math.round(ma.bytesPerCall) === 0;
            const opt = optStatus === null ? null : { before: 0, after: 0 };
            const ns = nsExcess(l.step, opt);
            res.nsBase = ns === null ? null : ns.base;
            res.nsBaseSeen = baseSeen[0];
            res.optBefore = opt === null ? null : opt.before;
            res.optAfter = opt === null ? null : opt.after;
            res.optOk = opt === null ? null : (opt.before & TF_BIT) !== 0 && (opt.after & TF_BIT) !== 0;
            res.nsExcess = ns === null ? null : ns.excess;
            res.nsWin0 = ns === null ? null : ns.first;
            res.nsValid = ns === null ? null : ns.valid;
            res.transientBpo = ns === null ? null : Math.max(0, ns.excess) / NS_K;
            res.transientOk = ns !== null && nsPass(ns.excess);
            const gcOps = Math.max(25000, (GC_OPS / l.w) | 0);
            const g = await gcLane(l.step, gcOps);
            res.gcOps = gcOps; res.gcMajor = g.major; res.gcMinor = g.minor; res.gcMaxMs = g.maxMs; res.gcOk = g.ok;
            const ab = abLane(l.step, l.w);
            res.abOps = ab.ops; res.abGrowth = ab.growth; res.abSettled = ab.settled; res.abOk = ab.ok;
            res.restoreOk = finishCycle(l);
            if (l.work === null) {
                res.workOk = null;
            } else {
                const wk = workCheck(l);
                res.workOk = wk.ok;
                res.workInfo = wk.reason;
            }
            res.kindsAfter = kindsOf(l.set, l.chunks).join(',');
            res.kindsOk = res.kindsAfter === l.kinds0;
            if (l.edges === null) {
                res.edgesOk = null;
            } else {
                const e = edgeCheck(l);
                res.edgesSeen = e.seen;
                res.edgesMissing = e.missing;
                res.edgesOk = e.missing.length === 0 && e.back;
            }
            res.ok = res.pagedOk && res.retainedOk && res.transientOk && res.gcOk && res.abOk && res.restoreOk && res.kindsOk &&
                res.edgesOk !== false && (l.work === null ? res.workOk === null : res.workOk === true) && res.optOk !== false;
        } catch (e) {
            res.error = String(e && e.message || e);
            res.ok = false;
        }
        res.ms = Math.round(performance.now() - t0);
        return res;
    }
    // hi controls: transient channel only (CV7's shape), same per-lane baseline.
    function measureHi(l) {
        const t0 = performance.now();
        const res = { name: l.name, op: l.op, pagedOk: l.pagedOk, newSpaceSize: newSpaceSize() };
        try {
            const opt = optStatus === null ? null : { before: 0, after: 0 };
            const ns = nsExcess(l.step, opt);
            res.nsBase = ns === null ? null : ns.base;
            res.nsBaseSeen = baseSeen[0];
            res.nsExcess = ns === null ? null : ns.excess;
            res.nsWin0 = ns === null ? null : ns.first;
            res.nsValid = ns === null ? null : ns.valid;
            res.transientBpo = ns === null ? null : Math.max(0, ns.excess) / NS_K;
            res.optOk = opt === null ? null : (opt.before & TF_BIT) !== 0 && (opt.after & TF_BIT) !== 0;
            res.restoreOk = finishCycle(l);
            const wk = workCheck(l);
            res.workOk = wk.ok;
            res.workInfo = wk.reason;
        } catch (e) {
            res.error = String(e && e.message || e);
            res.nsExcess = null;
            res.workOk = false;
        }
        res.ms = Math.round(performance.now() - t0);
        return res;
    }
    return { nsLane, emptyFn, nsExcess, abLane, boxControl, gcKickControl, measure, measureHi };
}

// A rejected baseline (null transient) prints the base it read: ' BASE-REJECTED <B> > NS_BASE_MAX'. Cold.
function baseNote(r) {
    return r.nsBase === null && typeof r.nsBaseSeen === 'number' && r.nsBaseSeen >= 0 && !nsBaseOk(r.nsBaseSeen)
        ? ' BASE-REJECTED ' + r.nsBaseSeen + ' > ' + NS_BASE_MAX : '';
}
function fmtN(v, d) { return v === null || v === undefined ? 'null' : (typeof v === 'number' ? v.toFixed(d) : String(v)); }

/** One printable line per gated lane. Cold. */
export function laneLine(r) {
    if (r.error) return 'lane ' + r.name.padEnd(26) + ' ERROR ' + r.error + ' | FAIL';
    return 'lane ' + r.name.padEnd(26) +
        ' retained=' + (r.retainedBpc === null ? 'null' : Math.round(r.retainedBpc)) + ' B/op (raw ' + fmtN(r.retainedBpc, 4) +
        (r.retainedSettled ? '' : ' UNSETTLED') + ')' +
        ' transient=' + fmtN(r.transientBpo, 3) + ' B/op (excess ' + fmtN(r.nsExcess, 0) + ' B/' + NS_K + ', win0 ' +
        fmtN(r.nsWin0, 0) + ', valid ' + fmtN(r.nsValid, 0) + ', base ' + fmtN(r.nsBase, 0) + ')' + baseNote(r) +
        ' ab=' + r.abGrowth + (r.abSettled ? '' : ' UNSETTLED') +
        ' gc major=' + r.gcMajor + ' minor=' + r.gcMinor + ' maxMs=' + fmtN(r.gcMaxMs, 2) + ' (' + r.gcOps + ' ops)' +
        ' opt=' + (r.optOk === null ? 'UNCHECKED' : r.optBefore + '/' + r.optAfter + (r.optOk ? ' TF' : ' NOT-TURBOFAN')) +
        ' paged=' + (r.pagedOk ? 'ok' : 'MISMATCH') +
        ' kinds=' + r.kindsBuilt + (r.kindsOk ? '' : '->' + r.kindsAfter + ' KIND-DRIFT') +
        (r.edgesOk === null ? '' : ' edges=' + (r.edgesOk ? 'ok' : 'MISSING ' + r.edgesMissing.join(' ')) +
            ' [' + r.edgesSeen.join(' ') + ']') +
        (r.workOk === null ? '' : ' work=' + (r.workOk ? 'ok' : 'FAIL') + ' (' + r.workInfo + ')') +
        (r.restoreOk ? '' : ' RESTORE-MISMATCH') +
        ' ' + r.ms + ' ms | ' + (r.ok ? 'ok' : 'FAIL');
}

/** The hi-key attribution line; a missing or unmeasured lane prints n/a. Cold. */
export function attributionLine(hi) {
    if (hi === null) return 'attribution hi. n/a (no hi family)';
    const by = {};
    for (const r of hi.lanes) by[r.op] = r.error || r.nsExcess === null ? null : r.transientBpo;
    const f = (v) => (typeof v === 'number' ? v.toFixed(3) : 'n/a');
    const arg = by.has, mn = by.min, mx = by.max;
    const ret = typeof mn === 'number' && typeof mx === 'number' ? (mn + mx) / 2 : null;
    const sh = hi.share;
    const pred = (s) => (typeof arg === 'number' && typeof ret === 'number' && sh !== null ? f(arg + s * ret) : 'n/a');
    return 'attribution hi. arg box (caller, has) ' + f(arg) + ' B/op; result box (method, min/max) ' + f(ret) +
        ' B/op; successor ' + f(by.successor) + ' (arg + ' + (sh === null ? 'n/a' : sh.successor.toFixed(3)) +
        ' x result = ' + pred(sh === null ? 0 : sh.successor) + '); predecessor ' + f(by.predecessor) + ' (arg + ' +
        (sh === null ? 'n/a' : sh.predecessor.toFixed(3)) + ' x result = ' + pred(sh === null ? 0 : sh.predecessor) + ')';
}

// ---- engine mutants (data: URLs; anchors count-checked, fail closed) -------------------

const CR_CLASS = 'export class RoaringSet {\n';
// has(): its header and the first 8 body lines (RoaringSet-only text: _mi / _kind; a second has(x) in the
// class cannot be a pure insertion). Inject AFTER: the lo line is the last anchor line.
const CR_HAS_ANCHOR = "    has(x) {\n        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;\n" +
    '        const c = x >>> 16;\n        const m = this._mi(c);\n        const k = this._kind[m];\n' +
    '        if (k === 0) return false;\n        if (k === 6) return true;\n        const lo = x & 0xFFFF;\n';
// add()'s array -> bitmap promote call site (hot body; must sit inside RoaringSet's add()). Inject BEFORE.
const CR_CONV_ANCHOR = '            this._promoteArrayToBitmap(m, slot, lo);\n            this._size++;\n';
const CR_ADD_HEAD = '\n    add(x) {\n';
const CR_DEL_HEAD = '\n    delete(x) {\n';
const CR_TAIL = '\nlet __crHas = null;\nlet __crConv = null;\nconst __crHold = [];\n';
export const CR_MUTANTS = Object.freeze({
    'CR-has': { anchor: CR_HAS_ANCHOR, at: 'has', inject: '        __crHas = [c, lo];\n' },
    'CR-conv': { anchor: CR_CONV_ANCHOR, at: 'add', inject: '            __crConv = new Uint32Array(64);\n' },
    'CR-abConv': { anchor: CR_CONV_ANCHOR, at: 'add', inject: '            __crHold.push(new Uint32Array(64));\n' },
});

/** The mutant source { n, src } or { n, src: null, bad } (bad = why the control cannot run). Cold. */
export function crSource(base, name) {
    const m = CR_MUTANTS[name];
    const cnt = (a) => base.split(a).length - 1;
    const n = cnt(m.anchor);
    if (n !== 1) return { n, src: null, bad: 'BAD anchor count ' + n + ' (want exactly 1)' };
    if (cnt(CR_CLASS) !== 1) return { n, src: null, bad: 'BAD class anchor count ' + cnt(CR_CLASS) };
    if (cnt('__cr') !== 0) return { n, src: null, bad: 'BAD the source already names __cr' };
    const cls = base.indexOf(CR_CLASS);
    const at = base.indexOf(m.anchor);
    if (m.at === 'has' && !(at > cls)) return { n, src: null, bad: 'BAD has anchor at ' + at + ' before the class (' + cls + ')' };
    if (m.at === 'add') {
        const addAt = base.indexOf(CR_ADD_HEAD, cls);
        const delAt = addAt < 0 ? -1 : base.indexOf(CR_DEL_HEAD, addAt);
        if (!(addAt > cls && at > addAt && delAt > at)) {
            return { n, src: null, bad: 'BAD anchor at ' + at + ' not inside RoaringSet add() (' + addAt + '..' + delAt + ')' };
        }
    }
    const cut = m.at === 'has' ? at + m.anchor.length : at;
    return { n, src: base.slice(0, cut) + m.inject + base.slice(cut) + CR_TAIL, bad: null };
}

// ---- retention (PLAN-G5 task 4; torture T2 shape) ----------------------------------------

// Module-level no-op cleanup + string tags: neither closes over a tracked target (held-value contract).
const retNoop = () => {};
function retTracker(createLeakTracker, name, box) {
    return createLeakTracker({
        name,
        onLeak: () => { box.collected++; },
        onError: (e) => { box.leaks.push(String(e)); },
        onWarning: (w) => { box.warns.push(w.kind + ':' + w.reason); },
    });
}
// Own frame (torn down before the drain): conservative stack scanning would pin the last instance.
function retChurn(RoaringSet, pg, wantPaged, tracker, held) {
    let tracked = 0, mismatch = 0, dumpBad = 0;
    for (let i = 0; i < RET_CYCLES; i++) {
        const s = pg === null ? new RoaringSet(1 << 20, 2, 1) : new RoaringSet(1 << 20, 2, 1, pg.maxPages, pg.pageBits);
        if (!pagedMatch(s, wantPaged)) mismatch++;
        const a = i & 0xFFFF;
        for (let k = 0; k < 70; k++) s.add((a + k * 7) & 0xFFFF);      // small -> array (65th key, large slot)
        s.add(65536 + a);                                               // a SINGLE in chunk 1
        s.has(a); s.successor(a); s.predecessor(0xFFFF - a); s.min(); s.max(); s.runOptimize(); s.delete(a);
        const d = s.dump();
        if (d.size !== 70 || d.chunks.length !== 2) dumpBad++;
        tracker.track(s, retNoop, 'roaringset', { audit: true });
        tracker.track(d, retNoop, 'roaringset.dump', { audit: true });
        tracked += 2;
        if (held !== null) held.push(s, d);
    }
    return { tracked, mismatch, dumpBad };
}
async function retDrain(tracker) {
    let live = tracker.size();
    for (let g = 0; g < 20 && live > 0; g++) { globalThis.gc(); await settle(25); live = tracker.size(); }
    return live;
}
/** Retention + its CR-retain control. Cold. */
async function runRetention(RoaringSet, job, wantPaged) {
    const t0 = performance.now();
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const box = { collected: 0, leaks: [], warns: [] };
    const tracker = retTracker(createLeakTracker, 'roaring-retention', box);
    const ch = retChurn(RoaringSet, job.paged, wantPaged, tracker, null);
    const live = await retDrain(tracker);
    const findings = tracker.audit();
    globalThis.gc();
    await settle(25);
    const after = tracker.size();
    const want = 2 * RET_CYCLES;
    const r = { layout: wantPaged ? 'paged' : 'direct', paged: job.paged === null ? null : { maxPages: job.paged.maxPages, pageBits: job.paged.pageBits },
        cycles: RET_CYCLES, tracked: ch.tracked, size: live, after, sizeAfterGc: after, collected: box.collected, findings: findings.length,
        findingKinds: findings.map((x) => x.kind + ':' + x.reason), warnings: box.warns.length, leaks: box.leaks.length,
        pagedMismatch: ch.mismatch, dumpBad: ch.dumpBad };
    r.ok = r.tracked === want && live === 0 && after === 0 && box.collected === want && findings.length === 0 &&
        box.leaks.length === 0 && ch.mismatch === 0 && ch.dumpBad === 0;
    // CR-retain: the same churn, every instance + dump also held past the drain
    const boxC = { collected: 0, leaks: [], warns: [] };
    const trackerC = retTracker(createLeakTracker, 'roaring-retention-control', boxC);
    const held = [];
    retChurn(RoaringSet, job.paged, wantPaged, trackerC, held);
    const liveC = await retDrain(trackerC);
    held.length = 0;
    const ctl = { name: 'CR-retain', family: 'retention', lanes: [], value: liveC, want: 'size >= 1 after the drain (all held)',
        flipped: Number.isInteger(liveC) && liveC >= 1, detail: 'size ' + liveC + '/' + want + ' held' };
    r.ms = Math.round(performance.now() - t0);
    return { retention: r, control: ctl };
}

function ctlLine(c) {
    return 'control ' + c.name.padEnd(23) + ' value=' + (typeof c.value === 'object' && c.value !== null ? JSON.stringify(c.value) : String(c.value)) +
        ' want ' + c.want + (c.detail ? ' (' + c.detail + ')' : '') + ' | ' + (c.flipped ? 'flipped' : 'DID NOT FLIP: FAIL');
}

async function runJob(job) {
    checkJob(job);
    if (typeof globalThis.gc !== 'function') throw new TypeError('worker has no globalThis.gc (--expose-gc not inherited)');
    for (const a of process.execArgv.concat(typeof process.env.NODE_OPTIONS === 'string' ? process.env.NODE_OPTIONS.split(/\s+/) : [])) {
        if (SEMI_FLAG.test(a)) throw new TypeError('semi-space flag ' + a + ': the transient lane is calibrated under the default new space');
    }
    const mod = job.src === null
        ? await import('../LogLogN.js')
        : await import('data:text/javascript;base64,' + Buffer.from(job.src, 'utf8').toString('base64'));
    if (typeof mod.RoaringSet !== 'function') throw new TypeError('RoaringSet export missing');
    const { GcProfiler, checkNoGc, measureAllocs, measureOps } = await import('@zakkster/lite-gc-profiler');
    const { getHeapSpaceStatistics, GCProfiler } = await import('node:v8');

    // TurboFan status: only under --allow-natives-syntax (torture never passes it: UNCHECKED, C-11)
    let optStatus = null;
    if (process.execArgv.includes('--allow-natives-syntax')) {
        optStatus = new Function('f', 'return %GetOptimizationStatus(f);');
        const forceTf = new Function('f', '%PrepareFunctionForOptimization(f); f(1); f(2); %OptimizeFunctionOnNextCall(f); f(3);');
        const forceMg = new Function('f', '%PrepareFunctionForOptimization(f); f(1); f(2); %OptimizeMaglevOnNextCall(f); f(3);');
        const pTf = new Function('x', 'return (x * 3 + 1) | 0;');
        const pMg = new Function('x', 'return (x * 5 + 1) | 0;');
        const pIn = new Function('x', 'return (x * 7 + 1) | 0;');
        forceTf(pTf); forceMg(pMg); pIn(1);
        const sTf = optStatus(pTf), sMg = optStatus(pMg), sIn = optStatus(pIn);
        if ((sTf & TF_BIT) === 0 || (sMg & TF_BIT) !== 0 || (sIn & TF_BIT) !== 0) {
            throw new Error('TF_BIT ' + TF_BIT + ' self-check failed: TurboFan ' + sTf + ', Maglev ' + sMg + ', interpreted ' + sIn);
        }
    }

    const SINK = new Int32Array(1);
    const BODY = stepSource();
    const t0 = performance.now();
    const { lanes, hi, share, wantPaged } = buildLanes(mod.RoaringSet, job, SINK, BODY);
    const buildMs = Math.round(performance.now() - t0);

    // self-check: every step has its own source; control: two closures of one literal count 1
    const dupSrc = dupSources(lanes.map((l) => l.step).concat(hi.map((l) => l.step)));
    const probeSc = script([[OP_HAS, 0]]);
    const probe = new mod.RoaringSet(1 << 16, 1, 1);
    const plantDup = dupSources([makeStep(probe, null, probeSc.ops, probeSc.keys, SINK), makeStep(probe, null, probeSc.ops, probeSc.keys, SINK)]);
    const controls = [{ name: 'CR-dupSrc', family: null, lanes: [], value: plantDup, want: 'exactly 1', flipped: plantDup === 1, detail: '' }];

    const lib = { measureAllocs, measureOps, GcProfiler, checkNoGc, getHeapSpaceStatistics, GCProfiler, optStatus, SINK };
    const M = makeMeasure(lib);
    // a fresh Worker's first empty-fn lane is bimodal (V3, veb-nsbase-probe-2026-11-03.log): one discarded
    M.nsLane(M.emptyFn, null);

    for (const l of lanes) { const n = Math.max(8192, (WARM_CALLS / l.w) | 0); for (let i = 0; i < n; i++) l.step(i); }
    const results = [];
    for (const l of lanes) results.push(await M.measure(l));

    let hiRes = null;
    if (hi.length > 0) {
        for (const l of hi) for (let i = 0; i < WARM_CALLS; i++) l.step(i);
        const hl = hi.map((l) => M.measureHi(l));
        const shareOk = share !== null && share.successor === 1 && share.predecessor === 1 && share.min === true && share.max === true;
        for (const r of hl) {
            const boxes = r.op !== 'has';
            r.want = boxes ? 'excess >= ' + NS_MAX_EXCESS : 'excess < ' + NS_MAX_EXCESS;
            r.ok = !r.error && r.pagedOk && r.restoreOk === true && r.workOk === true && r.optOk !== false &&
                (boxes ? nsBox(r.nsExcess) && shareOk : nsPass(r.nsExcess));
        }
        hiRes = { lanes: hl, share, shareOk, ok: hl.every((r) => r.ok) };
    }

    // ---- controls (run last: their closures must not pollute the measured lanes' feedback) ----
    const fam = new Set(job.families);
    const laneFams = job.families.filter((f) => f !== 'retention');
    // CR-limit: the predicates at the limit (W2: a '<=' / '>' mutant of either flips it)
    const lim = nsPass(NS_MAX_EXCESS - 1) && !nsPass(NS_MAX_EXCESS) && nsBox(NS_MAX_EXCESS) && !nsBox(NS_MAX_EXCESS - 1) &&
        !nsPass(null) && !nsPass(NaN) && !nsBox(null) && !nsBox(NaN);
    controls.push({ name: 'CR-limit', family: null, lanes: [], value: lim, want: 'true (nsPass 1023, !nsPass 1024, nsBox 1024, !nsBox 1023, null / NaN neither)',
        flipped: lim === true, detail: '' });
    if (laneFams.length > 0) {
        // CR-paged: the first lane family rebuilt with the INVERTED wantPaged (W3: a build that stops checking flips it)
        const inv = buildLanes(mod.RoaringSet, { src: job.src, families: [laneFams[0]], paged: job.paged }, SINK, BODY, true);
        const invAll = inv.lanes.concat(inv.hi);
        const nOk = invAll.filter((l) => l.pagedOk !== false).length;
        controls.push({ name: 'CR-paged', family: laneFams[0], lanes: invAll.map((l) => l.name), value: nOk,
            want: '0 of ' + invAll.length + ' lanes pagedOk under the inverted layout', flipped: invAll.length > 0 && nOk === 0,
            detail: 'wantPaged ' + inv.wantPaged + ', built paged ' + (invAll.length > 0 ? invAll[0].set.paged : 'n/a') });
        // CR-box per lane family
        for (const f of laneFams) {
            const l = f === 'hi' ? hi[0] : lanes.find((x) => familyOf(x) === f);
            const b = M.boxControl(l.step, l.w === undefined ? 1 : l.w);
            controls.push({ name: 'CR-box.' + f, family: f, lanes: [l.name], value: { retained: b.retained, excess: b.excess },
                want: 'round(retained) >= 1 B/call and excess >= ' + NS_MAX_EXCESS, flipped: b.flipped,
                detail: 'retained ' + fmtN(b.retained, 1) + ' B/call, excess ' + fmtN(b.excess, 0) + ' B/' + NS_K });
        }
        // CR-gcKick on the job's first lane
        const kl = lanes.length > 0 ? lanes[0] : hi[0];
        const k = await M.gcKickControl(kl.step);
        controls.push({ name: 'CR-gcKick', family: familyOf(kl.group === undefined ? { group: 'hi' } : kl), lanes: [kl.name],
            value: k.major, want: 'major >= 1, gc not ok, kicks 1', flipped: k.flipped,
            detail: 'major ' + k.major + ' minor ' + k.minor + ' kicks ' + k.kicks + ' ok ' + k.ok });
    }
    // engine mutants of the engine under test, each rebuilt and measured on its channel only
    const MUT = [];
    if (fam.has('ops')) MUT.push({ name: 'CR-has', fam: 'ops', targets: ['small.has', 'array.has', 'bitmap.has', 'runs.has'], ch: 'transient' });
    if (fam.has('gap')) MUT.push({ name: 'CR-has', fam: 'gap', targets: ['gap.has'], ch: 'transient' });
    if (fam.has('hi')) MUT.push({ name: 'CR-has', fam: 'hi', targets: ['hi.has'], ch: 'transient' });
    if (fam.has('conv')) {
        MUT.push({ name: 'CR-conv', fam: 'conv', targets: ['conv.4096<->4097'], ch: 'transient' });
        MUT.push({ name: 'CR-abConv', fam: 'conv', targets: ['conv.4096<->4097'], ch: 'ab' });
    }
    if (MUT.length > 0) {
        const base = job.src !== null ? job.src : readFileSync(new URL('../LogLogN.js', import.meta.url), 'utf8');
        for (const m of MUT) {
            const c = { name: m.name + (m.name === 'CR-has' ? '.' + m.fam : ''), family: m.fam, lanes: m.targets.slice(), value: null,
                want: m.ch === 'ab' ? 'arrayBuffers growth > 0 on every target' : 'excess >= ' + NS_MAX_EXCESS + ' on every target',
                flipped: false, detail: '', anchorCount: null };
            const ms = crSource(base, m.name);
            c.anchorCount = ms.n;
            if (ms.src === null) { c.detail = ms.bad; controls.push(c); continue; }
            let mm = null;
            try {
                mm = await import('data:text/javascript;base64,' + Buffer.from(ms.src, 'utf8').toString('base64'));
            } catch (e) {
                c.detail = 'BAD mutant import: ' + String(e && e.message || e);
            }
            if (mm !== null && typeof mm.RoaringSet !== 'function') { c.detail = 'BAD mutant has no RoaringSet export'; mm = null; }
            if (mm === null) { controls.push(c); continue; }
            const b = buildLanes(mm.RoaringSet, { src: null, families: [m.fam], paged: job.paged }, SINK, BODY);
            const all = b.lanes.concat(b.hi);
            const vals = [];
            for (const name of m.targets) {
                const l = all.find((x) => x.name === name);
                if (l === undefined) { vals.push(null); continue; }
                const w = l.w === undefined ? 1 : l.w;
                const n = Math.max(8192, (WARM_CALLS / w) | 0);
                for (let i = 0; i < n; i++) l.step(i);
                if (m.ch === 'transient') { const ns = M.nsExcess(l.step, null); vals.push(ns === null ? null : ns.excess); }
                else vals.push(M.abLane(l.step, w).growth);
            }
            c.value = vals.length === 1 ? vals[0] : vals;
            c.flipped = vals.length === m.targets.length &&
                (m.ch === 'ab' ? vals.every((v) => Number.isInteger(v) && v > 0) : vals.every(nsBox));
            c.detail = 'anchor count ' + ms.n + '; ' + m.ch + ' ' + vals.map((v) => fmtN(v, 0)).join(' / ');
            controls.push(c);
        }
    }
    let retention = null;
    if (fam.has('retention')) {
        const rr = await runRetention(mod.RoaringSet, job, wantPaged);
        retention = rr.retention;
        controls.push(rr.control);
    }

    const lines = results.map(laneLine);
    if (hiRes !== null) {
        for (const r of hiRes.lanes) {
            lines.push('control ' + r.name.padEnd(23) + ' transient excess=' + fmtN(r.nsExcess, 0) + ' B/' + NS_K +
                ' (' + fmtN(r.transientBpo, 3) + ' B/op, win0 ' + fmtN(r.nsWin0, 0) + ', valid ' + fmtN(r.nsValid, 0) +
                ', base ' + fmtN(r.nsBase, 0) + ', newSpace ' + r.newSpaceSize + ')' + baseNote(r) + ' want ' + r.want +
                ' paged=' + (r.pagedOk ? 'ok' : 'MISMATCH') + ' work=' + (r.workOk ? 'ok' : 'FAIL') + ' (' + r.workInfo + ')' +
                ' opt=' + (r.optOk === null ? 'UNCHECKED' : r.optOk ? 'TF' : 'NOT-TURBOFAN') + ' ' + r.ms + ' ms' +
                (r.error ? ' ERROR ' + r.error : '') + ' | ' + (r.ok ? 'ok' : 'FAIL'));
        }
        lines.push('hi share of results >= 2^31: successor ' + share.successor + ' predecessor ' + share.predecessor +
            ' min ' + share.min + ' max ' + share.max + ' | ' + (hiRes.shareOk ? 'ok' : 'FAIL (blind lane)'));
        lines.push(attributionLine(hiRes));
    }
    lines.push('selfcheck dupSrc=' + dupSrc + '/0 control CR-dupSrc=' + plantDup + ' (want 1) | ' +
        (dupSrc === 0 && plantDup === 1 ? 'ok' : 'FAIL'));
    for (const c of controls) if (c.name !== 'CR-dupSrc') lines.push(ctlLine(c));
    if (retention !== null) {
        const r = retention;
        lines.push('retention ' + r.layout + ' cycles=' + r.cycles + ' tracked=' + r.tracked + ' size=' + r.size + '/0 after=' + r.after +
            ' collected=' + r.collected + '/' + r.tracked + ' findings=' + r.findings + ' warnings=' + r.warnings + ' leaks=' + r.leaks +
            ' pagedMismatch=' + r.pagedMismatch + ' dumpBad=' + r.dumpBad + ' ' + r.ms + ' ms | ' + (r.ok ? 'ok' : 'FAIL'));
    }

    const fail = results.filter((r) => !r.ok).map((r) => r.name);
    if (hiRes !== null) for (const r of hiRes.lanes) if (!r.ok) fail.push(r.name);
    if (dupSrc !== 0) fail.push('selfcheck dupSrc');
    for (const c of controls) if (!c.flipped) fail.push('control ' + c.name);
    if (fam.has('retention') && (retention === null || retention.ok !== true)) fail.push('retention');
    return {
        NS_K, NS_W, NS_MAX_EXCESS,
        families: job.families.slice(), wantPaged, tf: optStatus === null ? 'UNCHECKED' : 'CHECKED',
        lanes: results, controls, hi: hiRes, retention, dupSrc, lines, fail,
        ok: fail.length === 0, buildMs, ms: Math.round(performance.now() - t0), sink: SINK[0],
    };
}

if (!isMainThread && workerData !== null && typeof workerData === 'object' && workerData.roaringTorture === true) {
    let msg;
    try {
        msg = await runJob(workerData.job);
    } catch (e) {
        msg = { error: e && e.stack ? String(e.stack) : String(e) };
    }
    parentPort.postMessage(msg);
}
