/**
 * @zakkster/lite-loglogn -- demo engine (repo-only; never shipped: demo/ is not in package.json files[]).
 *
 *     node demo/Visualize.mjs        prints a REPORTED smoke table (ns/op, log2(w) fit, bytes, crossover)
 *
 * The engine behind demo/visuals.html (PLAN-demo CONTRACT). It runs ONE seeded op stream over the five
 * members (StratifiedBitset sb, XFastTrie xft, YFastTrie yft, vEBTree veb, RoaringSet roar) plus an O(log n)
 * foil whose CLASS the caller passes in (the page and Node main both pass lite-logn's Treap; this module never
 * imports it statically -- its only static import is '../LogLogN.js').
 *
 * OPSTREAM (fixed; the drift test rebuilds it independently): rng = mulberry32(seed) (byte-for-byte the copy in
 * test/helpers/tierStream.mjs), d(m) = floor(rng() * m), KU = min(U, KEY_CAP). FIRST the pool:
 * pool[i] = d(KU) for i = 0 .. n-1; THEN the ring, for i = 0 .. RING-1:
 *   mixed  op = d(4); op 0 add / 1 delete take key = pool[d(n)], op 2 successor / 3 predecessor take key = d(KU)
 *   query  op = 2 + d(2); key = d(KU)
 *   churn  op = d(2); key = pool[d(n)]
 * hash = FNV-1a 32-bit: h = FNV_OFFSET, then per i h = fnvWord(h, op[i]), h = fnvWord(h, key[i]).
 * Build (createEngine / reset) adds pool[0 .. n >> 1) to every present member (sb is null above SB_U_MAX, veb
 * above VEB_U_MAX: snapshot / sizeOf / bytesOf null, runBatch -1, step skips them). Op codes: OP_ADD 0, OP_DELETE 1,
 * OP_SUCC 2, OP_PRED 3. The foil's add is set(key, 1).
 *
 * HOT (0 B/op, gated by demo/Demo.test.mjs): step(e) and runBatch(e, m, count). Each member reads the shared
 * ring at its own cursor e.pos[i] (i = member index, 5 = foil); step() advances every present member by one op,
 * runBatch() one member by count ops, so a caller that gives every member the same count per frame keeps them
 * in lockstep (one shared cursor). Results land in Int32Array slots: e.out[i] = the last op's result (add 1;
 * delete 1 / 0; successor / predecessor the key, or -1 for none), e.acc[i] = (acc + result) | 0. Keys stay
 * < KEY_CAP = 2^30, so every key crosses a call boundary as a Smi. runBatch's count is capped at 0x3FFFFFFF
 * (2^30 - 1, a Smi on a pointer-compressed engine too).
 *
 * QUERY (0 B, any rate): sizeOf(e, m) = the member's key count (=== snapshot(e, m).size), null when the
 * member is absent.
 *
 * COLD (allocating, ~10 Hz, never inside step / runBatch): snapshot() (the members' documented "Cold,
 * allocating" dump(), the vEB adapter, the foil's forEach), bytesOf, crossover, fitLog2w, createEngine, reset.
 *
 * vEB adapter (PLAN-demo D-1): vEBTree has no dump(), so vebSnapshot() decodes its live private arrays
 * read-only (_u, _w, _size, _g, _p, _t; the layout is decisions/0009 L1, see vEBTree's class comment). Every
 * field is pinned first; a missing, renamed or mistyped field throws an Error starting `[lite-loglogn-demo]`.
 * Content is never "repaired": keys are what the node storage holds (root min + every root cluster scanned
 * directly, every word read; the summaries and the max slots are not used for keys, only checked). Decode
 * invariants, checked at EVERY internal node (the root; the root summary when hi >= 9; each lo = 16 root
 * cluster); a violation throws `[lite-loglogn-demo] vEBTree decode V<k>: ...`:
 *   V1 decoded count === _size (root).
 *   V2 header exactly EMPTY [0xFFFFFFFF, 0] with nothing decoded below it, or min <= max < node range (root
 *      _u, summary 2^hi, cluster 2^16); a root leaf (w <= 8, no header): every set bit < _u.
 *   V3 a node's decode strictly ascending: its min < every cluster key, no duplicate.
 *   V4 node max === its largest decoded key (its min when every cluster is empty).
 *   V5 summary key set === {j : cluster j decodes non-empty}.
 * A changed header min (the root's, or a lo = 16 root cluster's when w > 24) that stays below every other key of
 * its node satisfies V1-V5: the min is stored only in that header, so it is undetectable by design; the decoder
 * reports the stored value (has() agrees).
 *
 * Every number this module produces at runtime is REPORTED / live (D-4, A5): none of it enters README,
 * llms.txt or CHANGELOG. ASCII only. MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>.
 */

import { StratifiedBitset, XFastTrie, YFastTrie, vEBTree, RoaringSet } from '../LogLogN.js';

// --- constants -----------------------------------------------------------------

/** Member ids, in panel order; the index is the member index (the foil is index 5, id FOIL). */
export const MEMBERS = Object.freeze(['sb', 'xft', 'yft', 'veb', 'roar']);
/** The foil's id (index 5). */
export const FOIL = 'foil';
/** Workload kinds. */
export const KINDS = Object.freeze(['mixed', 'query', 'churn']);
/** Keys are drawn below 2^30 (Smi cap, as the witness lanes), whatever U is (A1). */
export const KEY_CAP = 1073741824;
/** Largest universe that gets a StratifiedBitset (2^28 = ~34 MB); above it sb is null -- O(U/w) space (D-8). */
export const SB_U_MAX = 268435456;
/** Largest universe that gets a vEBTree (2^28 = a 33.7 MB tree); above it veb is null -- O(U) space (D-7). */
export const VEB_U_MAX = 268435456;
/** Largest n (pool size, xft / yft / foil capacity). */
export const N_MAX = 65536;
/** Op-ring length (power of two). */
export const RING = 65536;
/** Ops per member per frame. */
export const BATCH = 400;

export const OP_ADD = 0;
export const OP_DELETE = 1;
export const OP_SUCC = 2;
export const OP_PRED = 3;

const RING_MASK = RING - 1;
const COUNT_MAX = 0x3FFFFFFF;
const FOIL_IX = 5;
const U_MAX = 4294967296;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const PFX = '[lite-loglogn-demo] ';
const OPT_KEYS = Object.freeze(['kind', 'seed', 'U', 'n']);

// --- seeded stream ---------------------------------------------------------------

/** Seeded PRNG in [0, 1). The same function as test/helpers/tierStream.mjs (mulberry32). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** FNV-1a 32-bit fold of a 32-bit word as 4 bytes, little-endian (tierStream's fnvWord). */
function fnvWord(h, w) {
    h = Math.imul(h ^ (w & 255), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((w >>> 8) & 255), FNV_PRIME) >>> 0;
    h = Math.imul(h ^ ((w >>> 16) & 255), FNV_PRIME) >>> 0;
    return Math.imul(h ^ ((w >>> 24) & 255), FNV_PRIME) >>> 0;
}

function describe(v) {
    return typeof v === 'number' ? String(v) : typeof v;
}

function checkStreamArgs(kind, seed, U, n) {
    if (KINDS.indexOf(kind) < 0) {
        throw new RangeError(PFX + 'kind must be one of ' + KINDS.join(' / ') + '; got ' +
            (typeof kind === 'string' ? JSON.stringify(kind) + hint(kind, KINDS) : typeof kind));
    }
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
        throw new RangeError(PFX + 'seed must be a uint32 integer; got ' + describe(seed));
    }
    if (typeof U !== 'number' || !Number.isInteger(U) || U < 2 || U > U_MAX) {
        throw new RangeError(PFX + 'U must be an integer in [2, 2^32]; got ' + describe(U));
    }
    const nLim = U < N_MAX ? U : N_MAX;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > nLim) {
        throw new RangeError(PFX + 'n must be an integer in [1, ' + nLim + '] (min(U, N_MAX)); got ' + describe(n));
    }
}

/**
 * Cold, allocating. The seeded op stream (OPSTREAM in the header).
 * @returns {{op: Uint8Array, key: Uint32Array, pool: Uint32Array, hash: number}}
 */
export function buildOpStream(kind, seed, U, n) {
    checkStreamArgs(kind, seed, U, n);
    const rng = mulberry32(seed);
    const KU = U < KEY_CAP ? U : KEY_CAP;
    const pool = new Uint32Array(n);
    for (let i = 0; i < n; i++) pool[i] = Math.floor(rng() * KU);
    const op = new Uint8Array(RING);
    const key = new Uint32Array(RING);
    const K = KINDS.indexOf(kind);
    for (let i = 0; i < RING; i++) {
        let o;
        let k;
        if (K === 0) {
            o = Math.floor(rng() * 4);
            k = o < 2 ? pool[Math.floor(rng() * n)] : Math.floor(rng() * KU);
        } else if (K === 1) {
            o = 2 + Math.floor(rng() * 2);
            k = Math.floor(rng() * KU);
        } else {
            o = Math.floor(rng() * 2);
            k = pool[Math.floor(rng() * n)];
        }
        op[i] = o;
        key[i] = k;
    }
    let hash = FNV_OFFSET;
    for (let i = 0; i < RING; i++) {
        hash = fnvWord(hash, op[i]);
        hash = fnvWord(hash, key[i]);
    }
    return { op, key, pool, hash };
}

// --- options door ------------------------------------------------------------------

function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        }
        const t = prev;
        prev = cur;
        cur = t;
    }
    return prev[n];
}

function hint(s, list) {
    let best = null;
    let bd = 3;
    for (let i = 0; i < list.length; i++) {
        const d = editDistance(String(s).toLowerCase(), list[i].toLowerCase());
        if (d < bd) {
            bd = d;
            best = list[i];
        }
    }
    return best === null ? '' : ' (did you mean ' + JSON.stringify(best) + '?)';
}

function checkOptions(opts) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
        throw new TypeError(PFX + 'createEngine options must be a plain object {kind, seed, U, n}');
    }
    const proto = Object.getPrototypeOf(opts);
    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(PFX + 'createEngine options must be a plain object (no custom prototype)');
    }
    if (Object.getOwnPropertySymbols(opts).length !== 0) {
        throw new TypeError(PFX + 'createEngine options must not carry Symbol keys');
    }
    const keys = Object.keys(opts);
    for (let i = 0; i < keys.length; i++) {
        if (OPT_KEYS.indexOf(keys[i]) < 0) {
            throw new RangeError(PFX + 'unknown createEngine option ' + JSON.stringify(keys[i]) +
                hint(keys[i], OPT_KEYS));
        }
    }
    for (let i = 0; i < OPT_KEYS.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(opts, OPT_KEYS[i])) {
            throw new RangeError(PFX + 'createEngine option ' + OPT_KEYS[i] + ' is required');
        }
    }
}

function checkFoil(Foil) {
    if (Foil !== null && typeof Foil !== 'function') {
        throw new TypeError(PFX + 'foil must be a class (constructor(capacity)) or null; got ' + typeof Foil);
    }
}

function checkFoilInstance(f) {
    const need = ['set', 'delete', 'successor', 'predecessor', 'clear', 'forEach'];
    for (let i = 0; i < need.length; i++) {
        if (typeof f[need[i]] !== 'function') {
            throw new TypeError(PFX + 'foil instance has no ' + need[i] + '() method');
        }
    }
}

// --- engine ----------------------------------------------------------------------------

/**
 * Cold. RoaringSet pool sizes from a census of the pool (PLAN-demo A6): {small, large}. Every key any member
 * ever holds is a pool key (adds draw from the pool only), so chunk c never holds more than cnt[c] = the
 * number of DISTINCT pool keys in c. Without addRange / runOptimize (never called here) a chunk with >= 2 keys
 * owns exactly ONE pool slot (small array: small; array / bitmap: large; array <-> bitmap swaps with the
 * spare _conv slab, no pool slot), a SINGLE or empty chunk none. A chunk enters a large slot only at its 65th
 * key (_promoteSmallToArray) or when _promoteSingle finds no free small slot. So:
 *   small = S2 = #chunks with cnt >= 2. A chunk going 1 -> 2 keys sees at most S2 - 1 small slots in use
 *     (every other >= 2-key chunk), so _promoteSingle always gets a small slot, never the large fallback.
 *   large = max(1, L), L = #chunks with cnt >= 65 (maxLarge >= 1 by the RoaringSet contract). Only those
 *     chunks can ever own a large slot; at a promotion the promoting chunk is one of them, so at most L - 1
 *     are in use and a slot is free. A demotion only frees.
 * FULL (65,536 keys in a chunk; delete from FULL takes a small-runs slot) needs cnt[c] = 65,536; such a chunk
 * is counted in both S2 and L, and the one-slot-per-chunk invariant still holds.
 */
function roarPools(pool, n) {
    const cnt = new Map();
    const seen = new Set();
    for (let i = 0; i < n; i++) {
        const k = pool[i];
        if (seen.has(k)) continue;
        seen.add(k);
        const c = k >>> 16;
        cnt.set(c, (cnt.get(c) || 0) + 1);
    }
    let s2 = 0;
    let l = 0;
    for (const v of cnt.values()) {
        if (v >= 2) s2++;
        if (v >= 65) l++;
    }
    return { small: s2, large: l > 1 ? l : 1 };
}

function buildPrefix(e) {
    const pool = e.pool;
    const half = e.n >> 1;
    const sb = e.sb;
    const xft = e.xft;
    const yft = e.yft;
    const veb = e.veb;
    const roar = e.roar;
    const foil = e.foil;
    for (let i = 0; i < half; i++) {
        const k = pool[i];
        if (sb !== null) sb.add(k);
        xft.add(k);
        yft.add(k);
        if (veb !== null) veb.add(k);
        roar.add(k);
        if (foil !== null) foil.set(k, 1);
    }
}

/**
 * Cold, allocating. Builds the stream and every member, then adds pool[0 .. n >> 1).
 * xft / yft / foil capacity = n; roar maxSmall / maxLarge = roarPools (census); sb = null when U > SB_U_MAX,
 * veb = null when U > VEB_U_MAX;
 * foil = null when Foil is null (undefined is read as null: no foil lane).
 * @param {{kind: string, seed: number, U: number, n: number}} opts
 * @param {Function|null} Foil a class with new Foil(capacity), set / delete / successor / predecessor / clear / forEach
 */
export function createEngine(opts, Foil) {
    checkOptions(opts);
    if (Foil === undefined) Foil = null;
    checkFoil(Foil);
    const kind = opts.kind;
    const seed = opts.seed;
    const U = opts.U;
    const n = opts.n;
    const s = buildOpStream(kind, seed, U, n);
    const KU = U < KEY_CAP ? U : KEY_CAP;
    const rp = roarPools(s.pool, n);
    const foil = Foil === null ? null : new Foil(n);
    if (foil !== null) checkFoilInstance(foil);
    const e = {
        kind,
        seed,
        U,
        n,
        KU,
        roarSmall: rp.small,
        roarLarge: rp.large,
        op: s.op,
        key: s.key,
        pool: s.pool,
        hash: s.hash,
        sb: U <= SB_U_MAX ? new StratifiedBitset(U) : null,
        xft: new XFastTrie(U, n),
        yft: new YFastTrie(U, n),
        veb: U <= VEB_U_MAX ? new vEBTree(U) : null,
        roar: new RoaringSet(U, rp.small, rp.large),
        foil,
        pos: new Int32Array(6),
        out: new Int32Array(6),
        acc: new Int32Array(6)
    };
    buildPrefix(e);
    return e;
}

/** Cold. Empties every member, re-adds the build prefix, zeroes the cursors and result slots. */
export function reset(e) {
    if (e.sb !== null) e.sb.clear();
    e.xft.clear();
    e.yft.clear();
    if (e.veb !== null) e.veb.clear();
    e.roar.clear();
    if (e.foil !== null) e.foil.clear();
    e.pos.fill(0);
    e.out.fill(0);
    e.acc.fill(0);
    buildPrefix(e);
}

// --- hot path: one monomorphic loop per member ---------------------------------------------

function batchSb(e, count) {
    const s = e.sb;
    const op = e.op;
    const key = e.key;
    const pos = e.pos;
    const acc = e.acc;
    let i = pos[0];
    let a = acc[0];
    let r = 0;
    let v = 0;
    for (let c = 0; c < count; c++) {
        const k = key[i];
        const o = op[i];
        if (o === 0) {
            s.add(k);
            r = 1;
        } else if (o === 1) {
            r = s.delete(k) ? 1 : 0;
        } else {
            v = o === 2 ? s.successor(k) : s.predecessor(k);
            r = v === undefined ? -1 : v;
        }
        a = (a + r) | 0;
        i = (i + 1) & RING_MASK;
    }
    pos[0] = i;
    acc[0] = a;
    e.out[0] = r;
    return count;
}

function batchXft(e, count) {
    const s = e.xft;
    const op = e.op;
    const key = e.key;
    const pos = e.pos;
    const acc = e.acc;
    let i = pos[1];
    let a = acc[1];
    let r = 0;
    let v = 0;
    for (let c = 0; c < count; c++) {
        const k = key[i];
        const o = op[i];
        if (o === 0) {
            s.add(k);
            r = 1;
        } else if (o === 1) {
            r = s.delete(k) ? 1 : 0;
        } else {
            v = o === 2 ? s.successor(k) : s.predecessor(k);
            r = v === undefined ? -1 : v;
        }
        a = (a + r) | 0;
        i = (i + 1) & RING_MASK;
    }
    pos[1] = i;
    acc[1] = a;
    e.out[1] = r;
    return count;
}

function batchYft(e, count) {
    const s = e.yft;
    const op = e.op;
    const key = e.key;
    const pos = e.pos;
    const acc = e.acc;
    let i = pos[2];
    let a = acc[2];
    let r = 0;
    let v = 0;
    for (let c = 0; c < count; c++) {
        const k = key[i];
        const o = op[i];
        if (o === 0) {
            s.add(k);
            r = 1;
        } else if (o === 1) {
            r = s.delete(k) ? 1 : 0;
        } else {
            v = o === 2 ? s.successor(k) : s.predecessor(k);
            r = v === undefined ? -1 : v;
        }
        a = (a + r) | 0;
        i = (i + 1) & RING_MASK;
    }
    pos[2] = i;
    acc[2] = a;
    e.out[2] = r;
    return count;
}

function batchVeb(e, count) {
    const s = e.veb;
    const op = e.op;
    const key = e.key;
    const pos = e.pos;
    const acc = e.acc;
    let i = pos[3];
    let a = acc[3];
    let r = 0;
    let v = 0;
    for (let c = 0; c < count; c++) {
        const k = key[i];
        const o = op[i];
        if (o === 0) {
            s.add(k);
            r = 1;
        } else if (o === 1) {
            r = s.delete(k) ? 1 : 0;
        } else {
            v = o === 2 ? s.successor(k) : s.predecessor(k);
            r = v === undefined ? -1 : v;
        }
        a = (a + r) | 0;
        i = (i + 1) & RING_MASK;
    }
    pos[3] = i;
    acc[3] = a;
    e.out[3] = r;
    return count;
}

function batchRoar(e, count) {
    const s = e.roar;
    const op = e.op;
    const key = e.key;
    const pos = e.pos;
    const acc = e.acc;
    let i = pos[4];
    let a = acc[4];
    let r = 0;
    let v = 0;
    for (let c = 0; c < count; c++) {
        const k = key[i];
        const o = op[i];
        if (o === 0) {
            s.add(k);
            r = 1;
        } else if (o === 1) {
            r = s.delete(k) ? 1 : 0;
        } else {
            v = o === 2 ? s.successor(k) : s.predecessor(k);
            r = v === undefined ? -1 : v;
        }
        a = (a + r) | 0;
        i = (i + 1) & RING_MASK;
    }
    pos[4] = i;
    acc[4] = a;
    e.out[4] = r;
    return count;
}

function batchFoil(e, count) {
    const s = e.foil;
    const op = e.op;
    const key = e.key;
    const pos = e.pos;
    const acc = e.acc;
    let i = pos[5];
    let a = acc[5];
    let r = 0;
    let v = 0;
    for (let c = 0; c < count; c++) {
        const k = key[i];
        const o = op[i];
        if (o === 0) {
            s.set(k, 1);
            r = 1;
        } else if (o === 1) {
            r = s.delete(k) ? 1 : 0;
        } else {
            v = o === 2 ? s.successor(k) : s.predecessor(k);
            r = v === undefined ? -1 : v;
        }
        a = (a + r) | 0;
        i = (i + 1) & RING_MASK;
    }
    pos[5] = i;
    acc[5] = a;
    e.out[5] = r;
    return count;
}

/** Member index of m: 0..4 = MEMBERS, 5 = FOIL; a number 0..5 passes through; anything else -1. 0 B. */
function memberIndex(m) {
    if (typeof m === 'number') return (m >>> 0) === m && m <= FOIL_IX ? m : -1;
    for (let i = 0; i < 5; i++) if (MEMBERS[i] === m) return i;
    return m === FOIL ? FOIL_IX : -1;
}

function throwMember(m) {
    throw new TypeError(PFX + 'member must be one of ' + MEMBERS.join(' / ') + ' / ' + FOIL +
        ' (or index 0..5); got ' + (typeof m === 'string' ? JSON.stringify(m) + hint(m, MEMBERS) : describe(m)));
}

function throwCount(count) {
    throw new RangeError(PFX + 'runBatch count must be an integer in [0, 2^30 - 1]; got ' + describe(count));
}

/**
 * HOT, 0 B. Applies one op from the ring to every present member (sb / veb / foil skipped when null), each at
 * its own cursor. @returns {void}
 */
export function step(e) {
    if (e.sb !== null) batchSb(e, 1);
    batchXft(e, 1);
    batchYft(e, 1);
    if (e.veb !== null) batchVeb(e, 1);
    batchRoar(e, 1);
    if (e.foil !== null) batchFoil(e, 1);
}

/**
 * HOT, 0 B. Runs count ops of the ring on ONE member (a monomorphic loop), from its cursor.
 * @param {object} e engine
 * @param {string|number} m 'sb' / 'xft' / 'yft' / 'veb' / 'roar' / 'foil', or index 0..5
 * @param {number} count integer in [0, 2^30 - 1] (0x3FFFFFFF; checked before the member's presence)
 * @returns {number} count, or -1 when the member is absent (sb above SB_U_MAX, veb above VEB_U_MAX, no foil):
 *   a no-op, never a throw
 */
export function runBatch(e, m, count) {
    const ix = memberIndex(m);
    if (ix < 0) throwMember(m);
    if (typeof count !== 'number' || (count | 0) !== count || count < 0 || count > COUNT_MAX) throwCount(count);
    if (ix === 0) return e.sb === null ? -1 : batchSb(e, count);
    if (ix === 1) return batchXft(e, count);
    if (ix === 2) return batchYft(e, count);
    if (ix === 3) return e.veb === null ? -1 : batchVeb(e, count);
    if (ix === 4) return batchRoar(e, count);
    return e.foil === null ? -1 : batchFoil(e, count);
}

// --- vEB adapter (cold, read-only) ---------------------------------------------------------

/** S(w): Uint32 words of an untrimmed vEBTree node of width w (the engine's vebWords, demo-local copy). */
function vebWords(w) {
    if (w <= 8) return w <= 5 ? 1 : 1 << (w - 5);
    const lo = w > 24 ? 16 : 8;
    return 2 + vebWords(w - lo) + 2 ** (w - lo) * vebWords(lo);
}

function pinFail(what) {
    throw new Error(PFX + 'vEBTree adapter: ' + what + ' (the private layout changed; update demo/Visualize.mjs)');
}

/** Pins every private field the decode reads; throws `[lite-loglogn-demo] ...` on any mismatch. */
function vebPin(tree) {
    if (tree === null || typeof tree !== 'object') pinFail('not an object');
    const u = tree._u;
    if (typeof u !== 'number' || !Number.isInteger(u) || u < 2 || u > U_MAX) pinFail('field _u missing or not an integer in [2, 2^32]');
    const w = tree._w;
    if (typeof w !== 'number' || w !== 32 - Math.clz32(u - 1)) pinFail('field _w missing or not ceil(log2 _u)');
    const size = tree._size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > u) pinFail('field _size missing or not an integer in [0, _u]');
    const g = tree._g;
    if (!(g instanceof Int32Array) || g.length !== 33) pinFail('field _g missing or not an Int32Array(33)');
    for (let k = 9; k <= 32; k++) {
        if (g[k] !== 2 + vebWords(k - (k > 24 ? 16 : 8))) pinFail('field _g[' + k + '] is not the cluster offset 2 + S(hi)');
    }
    if (!(tree._p instanceof Int32Array) || tree._p.length !== 8) pinFail('field _p missing or not an Int32Array(8)');
    const t = tree._t;
    let words = vebWords(w);
    if (w > 8) {
        const lo = w > 24 ? 16 : 8;
        words = g[w] + Math.ceil(u / 2 ** lo) * vebWords(lo);
    }
    if (!(t instanceof Uint32Array) || t.length !== words) pinFail('field _t missing or not a Uint32Array of ' + words + ' words');
}

/** Pushes base + every set bit of t[from .. from + nw) (bit b of word i = key i * 32 + b). @returns {number} count */
function scanLeaf(t, from, nw, base, out) {
    let c = 0;
    for (let i = 0; i < nw; i++) {
        let v = t[from + i];
        while (v !== 0) {
            const b = 31 - Math.clz32(v & -v);
            out.push(base + i * 32 + b);
            v = (v & (v - 1)) >>> 0;
            c++;
        }
    }
    return c;
}

function decodeFail(k, detail) {
    throw new Error(PFX + 'vEBTree decode V' + k + ': ' + detail);
}

/**
 * Decodes ONE internal node (width w >= 9) at t[base]: pushes off + every key it holds into out (its header
 * min first, then clusters 0 .. nc - 1, each in storage order) and checks V2-V5 there. Every word of the node
 * is read: the summary is decoded too (a leaf scan when hi <= 8, else this function again), and every cluster
 * (a leaf scan when lo = 8, else this function again), EMPTY or not. cl, when not null, gets one
 * {j, min, max, count} per non-empty cluster (absolute keys). @returns {number} keys pushed
 */
function vebNode(t, g, base, w, nc, range, off, out, cl, where) {
    const lo = w > 24 ? 16 : 8;
    const hi = w - lo;
    const mn = t[base];
    const mx = t[base + 1];
    const empty = mn === 0xFFFFFFFF && mx === 0;
    if (!empty && !(mn <= mx && mx < range)) {
        decodeFail(2, where + ' header [' + mn + ', ' + mx + '] is neither EMPTY [0xFFFFFFFF, 0] nor min <= max < ' + range);
    }
    const sum = [];
    if (hi <= 8) scanLeaf(t, base + 2, vebWords(hi), 0, sum);
    else vebNode(t, g, base + 2, hi, 2 ** (hi - 8), 2 ** hi, 0, sum, null, where + ' summary');
    const start = out.length;
    if (!empty) out.push(off + mn);
    const cb = base + g[w];
    const S = vebWords(lo);
    const span = 2 ** lo;
    const live = [];
    for (let j = 0; j < nc; j++) {
        const before = out.length;
        const kb = off + j * span;
        if (lo === 8) scanLeaf(t, cb + j * S, 8, kb, out);
        else vebNode(t, g, cb + j * S, lo, 256, span, kb, out, null, where + ' cluster ' + j);
        const after = out.length;
        if (after === before) continue;
        live.push(j);
        if (cl !== null) cl.push({ j, min: out[before], max: out[after - 1], count: after - before });
    }
    const end = out.length;
    if (empty) {
        if (end !== start || sum.length !== 0) {
            decodeFail(2, where + ' header is EMPTY but ' + (end - start) + ' cluster key(s) and ' + sum.length +
                ' summary key(s) decode below it');
        }
        return 0;
    }
    for (let i = start + 1; i < end; i++) {
        if (!(out[i - 1] < out[i])) {
            decodeFail(3, where + ' decode not strictly ascending at ' + (out[i - 1] - off) + ', ' + (out[i] - off) +
                (i === start + 1 ? ' (header min vs its first cluster key)' : ''));
        }
    }
    if (out[end - 1] - off !== mx) {
        decodeFail(4, where + ' header max ' + mx + ' !== largest decoded key ' + (out[end - 1] - off));
    }
    let bad = sum.length === live.length ? -1 : 0;
    for (let i = 0; bad < 0 && i < live.length; i++) if (sum[i] !== live[i]) bad = i;
    if (bad >= 0) {
        decodeFail(5, where + ' summary holds ' + sum.length + ' cluster id(s), ' + live.length +
            ' cluster(s) decode non-empty; first difference at position ' + bad + ' (summary ' +
            (bad < sum.length ? sum[bad] : 'none') + ', clusters ' + (bad < live.length ? live[bad] : 'none') + ')');
    }
    return end - start;
}

/**
 * Cold, allocating, read-only. Decodes a vEBTree from its private storage (D-1) and checks V1-V5 (header).
 * universe / bits / size = _u / _w / _size; lo = the root's cluster width (16 when w > 24, 8 when w >= 9,
 * 0 for a root leaf, w <= 8, which has no clusters); min / max = the root header's keys (null when empty;
 * a root leaf: the lowest / highest set bit); keys = every stored key, ascending as decoded (root min + each
 * root cluster's storage; V3 proves the order, nothing is sorted); clusters = the NON-EMPTY root clusters
 * ascending by j, with ABSOLUTE min / max keys and count = keys stored in that cluster (the root min lives in
 * no cluster: sum(count) = size - 1 when size > 0). A violated invariant throws
 * `[lite-loglogn-demo] vEBTree decode V<k>: <detail>`; a pin mismatch throws `[lite-loglogn-demo] vEBTree adapter: ...`.
 * @returns {{universe: number, bits: number, size: number, lo: number, min: number|null, max: number|null,
 *   keys: Uint32Array, clusters: {j: number, min: number, max: number, count: number}[]}}
 */
export function vebSnapshot(tree) {
    vebPin(tree);
    const u = tree._u;
    const w = tree._w;
    const t = tree._t;
    const out = [];
    const clusters = [];
    let lo = 0;
    let min = null;
    let max = null;
    if (w <= 8) {
        scanLeaf(t, 0, w <= 5 ? 1 : 1 << (w - 5), 0, out);
        if (out.length !== 0) {
            min = out[0];
            max = out[out.length - 1];
            if (!(max < u)) decodeFail(2, 'root leaf holds key ' + max + ' >= _u ' + u);
        }
    } else {
        lo = w > 24 ? 16 : 8;
        vebNode(t, tree._g, 0, w, Math.ceil(u / 2 ** lo), u, 0, out, clusters, 'root');
        if (out.length !== 0) {
            min = t[0];
            max = t[1];
        }
    }
    if (out.length !== tree._size) decodeFail(1, 'decoded ' + out.length + ' key(s), _size is ' + tree._size);
    const keys = new Uint32Array(out);
    return { universe: u, bits: w, size: tree._size, lo, min, max, keys, clusters };
}

// --- cold queries -----------------------------------------------------------------------------

function foilSnapshot(f) {
    const ks = [];
    f.forEach((k) => { ks.push(k); });
    return { size: f.size, keys: new Uint32Array(ks) };
}

/**
 * Cold, allocating. sb / xft / yft / roar: the member's own dump() object (the model reads only dump fields;
 * sb null above SB_U_MAX); veb: vebSnapshot(e.veb), or null above VEB_U_MAX; foil: {size, keys: Uint32Array ascending}, or null when
 * the engine has no foil.
 */
export function snapshot(e, m) {
    const ix = memberIndex(m);
    if (ix < 0) throwMember(m);
    if (ix === 0) return e.sb === null ? null : e.sb.dump();
    if (ix === 1) return e.xft.dump();
    if (ix === 2) return e.yft.dump();
    if (ix === 3) return e.veb === null ? null : vebSnapshot(e.veb);
    if (ix === 4) return e.roar.dump();
    return e.foil === null ? null : foilSnapshot(e.foil);
}

/**
 * 0 B, any rate (no dump, no decode). The member's key count: sb / xft / yft / veb / roar .size, the foil's
 * size; === snapshot(e, m).size for every member. null when the member is absent (sb above SB_U_MAX, veb
 * above VEB_U_MAX, no foil). A bad member id throws as snapshot does.
 * @returns {number|null}
 */
export function sizeOf(e, m) {
    const ix = memberIndex(m);
    if (ix < 0) throwMember(m);
    if (ix === 0) return e.sb === null ? null : e.sb.size;
    if (ix === 1) return e.xft.size;
    if (ix === 2) return e.yft.size;
    if (ix === 3) return e.veb === null ? null : e.veb.size;
    if (ix === 4) return e.roar.size;
    return e.foil === null ? null : e.foil.size;
}

function viewBytes(o) {
    let b = 0;
    const ks = Object.keys(o);
    for (let i = 0; i < ks.length; i++) {
        const v = o[ks[i]];
        if (ArrayBuffer.isView(v)) b += v.byteLength;
    }
    return b;
}

/**
 * Cold. Bytes held: a member's public byteLength; an absent sb / veb -> null. The foil has no byteLength API: the sum of
 * its own typed-array fields plus those of its object fields one level down (a demo-local estimate); null
 * when the engine has no foil, and null when nothing is measurable (no typed-array field found: 0 would be
 * an unmeasured value reported as a measurement).
 * @returns {number|null}
 */
export function bytesOf(e, m) {
    const ix = memberIndex(m);
    if (ix < 0) throwMember(m);
    if (ix === 0) return e.sb === null ? null : e.sb.byteLength;
    if (ix === 1) return e.xft.byteLength;
    if (ix === 2) return e.yft.byteLength;
    if (ix === 3) return e.veb === null ? null : e.veb.byteLength;
    if (ix === 4) return e.roar.byteLength;
    const f = e.foil;
    if (f === null) return null;
    let b = viewBytes(f);
    const ks = Object.keys(f);
    for (let i = 0; i < ks.length; i++) {
        const v = f[ks[i]];
        if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) b += viewBytes(v);
    }
    return b > 0 ? b : null;
}

function checkSeries(a, len, name) {
    if (!(Array.isArray(a) || ArrayBuffer.isView(a))) throw new TypeError(PFX + name + ' must be an array or typed array');
    if (a.length < len) throw new RangeError(PFX + name + ' is shorter than len ' + len);
}

function checkLen(len, fn) {
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0) {
        throw new RangeError(PFX + fn + ' len must be an integer >= 0; got ' + describe(len));
    }
}

/**
 * Cold. The smallest tested n from which the member is faster than the foil at EVERY larger tested n
 * (memA[j] < foilA[j] for all j >= i, both finite). nA ascending. null when the member does not win at the
 * last point (or len is 0): "no crossover observed"; nA[0] when it wins everywhere: "at or below nA[0]".
 * @returns {number|null}
 */
export function crossover(nA, memA, foilA, len) {
    checkLen(len, 'crossover');
    checkSeries(nA, len, 'crossover nA');
    checkSeries(memA, len, 'crossover memA');
    checkSeries(foilA, len, 'crossover foilA');
    let at = null;
    for (let i = len - 1; i >= 0; i--) {
        const m = memA[i];
        const f = foilA[i];
        if (typeof m === 'number' && typeof f === 'number' && Number.isFinite(m) && Number.isFinite(f) && m < f) {
            at = nA[i];
        } else {
            break;
        }
    }
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * Cold. Least-squares ns = slope * log2(w) + intercept over i < len (w > 0, both finite); r2 = 1 - SSres /
 * SStot (1 when every ns is equal: an exact fit). null when len < 2, any point is invalid, or every w is equal.
 * @returns {{slope: number, intercept: number, r2: number}|null}
 */
export function fitLog2w(wA, nsA, len) {
    checkLen(len, 'fitLog2w');
    checkSeries(wA, len, 'fitLog2w wA');
    checkSeries(nsA, len, 'fitLog2w nsA');
    if (len < 2) return null;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < len; i++) {
        const w = wA[i];
        const y = nsA[i];
        if (typeof w !== 'number' || typeof y !== 'number' || !(w > 0) || !Number.isFinite(w) || !Number.isFinite(y)) return null;
        sx += Math.log2(w);
        sy += y;
    }
    const mx = sx / len;
    const my = sy / len;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < len; i++) {
        const dx = Math.log2(wA[i]) - mx;
        const dy = nsA[i] - my;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    if (!(sxx > 0)) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    let ssr = 0;
    for (let i = 0; i < len; i++) {
        const d = nsA[i] - (slope * Math.log2(wA[i]) + intercept);
        ssr += d * d;
    }
    return { slope, intercept, r2: syy === 0 ? 1 : 1 - ssr / syy };
}

// --- Node main: a REPORTED smoke table (never provenance) --------------------------------------

const ALL = Object.freeze(['sb', 'xft', 'yft', 'veb', 'roar', 'foil']);

function nsPerOp(e, m, ops) {
    if (runBatch(e, m, RING) < 0) return null;
    const t0 = performance.now();
    runBatch(e, m, ops);
    return (performance.now() - t0) * 1e6 / ops;
}

function cell(v, d) {
    const s = v === null ? 'n/a' : v.toFixed(d);
    return s.length >= 10 ? s : ' '.repeat(10 - s.length) + s;
}

async function main() {
    const os = await import('node:os');
    const { Treap } = await import('@zakkster/lite-logn');
    const OPS = 1 << 18;
    const SEED = 0xC0FFEE;
    const say = (s) => process.stdout.write(s + '\n');
    say('lite-loglogn demo engine -- REPORTED smoke (live, approximate; discarded, not provenance)');
    say('node ' + process.version + ' | load1 ' + os.loadavg()[0].toFixed(2) + ' | ' + os.cpus().length +
        ' cpus | ops per cell ' + OPS + ' after ' + RING + ' warm | keys drawn below 2^30');
    say('');
    say('ns/op by kind at U = 2^24, n = 2^16 (foil = lite-logn Treap)');
    say('kind     ' + ALL.map((m) => cell(null, 0).replace('n/a', m.padStart(3))).join(''));
    for (let k = 0; k < KINDS.length; k++) {
        const e = createEngine({ kind: KINDS[k], seed: SEED, U: 2 ** 24, n: N_MAX }, Treap);
        say(KINDS[k].padEnd(9) + ALL.map((m) => cell(nsPerOp(e, m, OPS), 1)).join(''));
    }
    say('');
    const WS = [16, 20, 24, 28, 32];
    const n = 4096;
    const ns = ALL.map(() => new Float64Array(WS.length));
    const ok = ALL.map(() => true);
    say('U-sweep, query kind, n = ' + n + ': ns/op and bytes');
    for (let i = 0; i < WS.length; i++) {
        const e = createEngine({ kind: 'query', seed: SEED, U: 2 ** WS[i], n }, Treap);
        const row = [];
        const by = [];
        for (let m = 0; m < ALL.length; m++) {
            const v = nsPerOp(e, ALL[m], OPS);
            if (v === null) ok[m] = false;
            else ns[m][i] = v;
            row.push(cell(v, 1));
            by.push(cell(bytesOf(e, ALL[m]), 0));
        }
        say('w ' + String(WS[i]).padEnd(7) + row.join('') + '   bytes' + by.join(''));
    }
    say('fit ns = a log2(w) + b (w 16..32; n/a when a member is absent at some w):');
    for (let m = 0; m < ALL.length; m++) {
        const f = ok[m] ? fitLog2w(WS, ns[m], WS.length) : null;
        say('  ' + ALL[m].padEnd(5) + (f === null ? ' n/a' : ' slope ' + f.slope.toFixed(2) + ' ns/log2(w), r2 ' + f.r2.toFixed(3)));
    }
    say('');
    const NS = [256, 1024, 4096, 16384, 65536];
    const foilNs = new Float64Array(NS.length);
    const memNs = MEMBERS.map(() => new Float64Array(NS.length));
    for (let i = 0; i < NS.length; i++) {
        const e = createEngine({ kind: 'mixed', seed: SEED, U: 2 ** 24, n: NS[i] }, Treap);
        foilNs[i] = nsPerOp(e, FOIL, OPS);
        for (let m = 0; m < MEMBERS.length; m++) memNs[m][i] = nsPerOp(e, MEMBERS[m], OPS);
    }
    say('crossover vs the foil, mixed kind, U = 2^24, n 2^8..2^16:');
    for (let m = 0; m < MEMBERS.length; m++) {
        const c = crossover(NS, memNs[m], foilNs, NS.length);
        say('  ' + MEMBERS[m].padEnd(5) + (c === null ? ' no crossover observed in n 2^8..2^16'
            : c === NS[0] ? ' at or below 2^8 (smallest tested)' : ' from n = ' + c));
    }
}

if (typeof process === 'object' && process !== null && Array.isArray(process.argv) && typeof process.argv[1] === 'string') {
    const url = await import('node:url');
    const fs = await import('node:fs');
    let entry = '';
    try {
        entry = url.pathToFileURL(fs.realpathSync(process.argv[1])).href;
    } catch {
        entry = '';
    }
    if (import.meta.url === entry) await main();
}
