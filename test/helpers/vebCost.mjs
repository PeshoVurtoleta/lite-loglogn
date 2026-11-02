/**
 * @zakkster/lite-loglogn -- vEBTree COUNT ORACLE (0.5.0 G1-B5, PLAN-vebtree task 7,
 * ASSERTION A3). Test helper, not a test file (the npm glob `test/*.test.js` never
 * matches it). Imports nothing from LogLogN.js.
 *
 * vebCost(ref, op, x) -> { t: { reads, writes }, g: { reads, writes },
 *   p: { reads, writes }, ret, cov } -- the exact column counts the engine must
 * show for `op(x)` on the VebRef state `ref` BEFORE the op (ref is not mutated).
 * Source = .handoff/PLAN-vebtree.md CURRENT C-1 / C-2 (layout widths), C-12 (read
 * order) and C-18 (its five binding readings), never the engine's code or comment:
 *   - widths: a leaf (w <= 8) has ceil(2^w / 32) words, key k = bit (k & 31) of
 *     word (k >>> 5); an internal node (w >= 9) has lo = (w > 24 ? 16 : 8),
 *     hi = w - lo, header [min, max], summary (width hi), clusters (width lo).
 *   - a leaf scan reads one word at a time, the first word masked to the start
 *     bit, and stops at the first nonzero masked word; a start past the leaf
 *     reads nothing. Ascending for min / successor, descending for max /
 *     predecessor (C-12).
 *   - has / add / delete: min then max at every internal node (2 reads), a leaf:
 *     its target word (C-12). The path is the textbook one: an empty node or a key
 *     equal to min / max ends it, otherwise cluster x >>> lo is entered; has takes no
 *     range short-cut (C-18 (6) stops delete only). `_g[w]` once per internal
 *     node left through a cluster (C-18 (2)).
 *   - add (C-3, C-12, C-18 (5)): an EMPTY internal node takes [x, x] (2 writes);
 *     x < min writes min and carries the old min down; x > max writes max; a leaf
 *     cluster reads its target word, writes it when the bit was clear, and only
 *     when the target word was 0 reads the other words ascending (stop at the
 *     first nonzero) -- all 0 = the cluster was empty, so the parent's summary
 *     takes j. A leaf with no pending parent (root leaf, summary leaf) gets no
 *     empty test. No has pre-pass; writes only after absence is proven.
 *   - delete (C-3, C-12, C-18 (2) (3) (4) (6)): an ABSENT key whose internal node header
 *     proves absence (x < min, x > max, or a one-key node with x != min) returns false
 *     after that node's 2 header reads -- no descent, no `_g` read, no `_p` traffic
 *     (C-18 (6), ruling F-B5-1; has does NOT stop early). A singleton internal node holding x is
 *     emptied (2 writes); x === min of a larger node reads the summary's min
 *     (internal: its min slot; leaf: ascending scan) and that cluster's min, then
 *     writes the new min; a leaf cluster reads its target word, writes it, and when
 *     the cleared word is 0 reads the others ascending (all 0 = emptied, the
 *     parent's summary loses j); where x was the node's max a frame is kept
 *     (4 `_p` writes + 4 `_p` reads) and refreshes max after the walk: mode 2
 *     (cluster kept keys) -> `_g` 1 + cluster j's max (internal: its max slot;
 *     leaf: descending scan) + 1 write; mode 1 (cluster emptied) -> an INTERNAL
 *     summary that the walk just emptied: 0 reads, max = min, 1 write; otherwise
 *     the summary's max slot (internal) or a descending scan (leaf summary); when
 *     the summary still holds keys `_g` 1 + that cluster's max; 1 write.
 *   - successor (C-12, C-18 (1)): 0 reads when empty; min; max only if x >= min;
 *     past both header tests `_g` 1; a leaf cluster is scanned ascending from
 *     xl + 1; an internal cluster (w >= 25) first reads its max slot and, when
 *     xl < it, is visited as a node (min, then max again); else the summary is
 *     visited for j and the answer cluster's min ends it (internal: min slot; leaf:
 *     ascending scan). predecessor is the mirror (max, min only if x <= max; leaf
 *     cluster descending from xl - 1; internal cluster: its min slot; no summary
 *     predecessor -> the node's min, no read).
 *   - min / max: 0 reads when empty; else the root's slot (1 read) or a scan of a
 *     root leaf.
 *   - a bad key (not a number, not an integer in [0, U)): 0 on every column.
 * ret = the answer this walk produces (the caller checks it against VebRef too).
 * cov = the paths taken (coverage floors of the seeded stream):
 *   delAbsentAtHeader (C-18 (6) stop), delFrame1 / delFrame2 (frames by mode), delTwoFrames, refresh0 (C-18 (4) 0-read
 *   refresh), delMinSwap, delSingleton, addEmptyLeafCluster, addEmptyIntCluster,
 *   succIntVisit / predIntVisit (internal cluster visited as a node),
 *   succIntSkip / predIntSkip (internal cluster slot read, not visited), succSummary /
 *   predSummary, predMinFallback.
 */

import { LEAF_MAX_W, leafWords, splitLo } from './vebRef.mjs';

export const OPS = ['has', 'add', 'delete', 'successor', 'predecessor', 'min', 'max'];
export const KEYED_OPS = ['has', 'add', 'delete', 'successor', 'predecessor'];

function zero() {
    return { t: { reads: 0, writes: 0 }, g: { reads: 0, writes: 0 }, p: { reads: 0, writes: 0 } };
}

function bump(c, k) {
    c.cov[k] = (c.cov[k] || 0) + 1;
}

function isEmpty(n) {
    return n === null || (n.leaf ? n.n === 0 : n.min === -1);
}

// --- leaf words (VebRef leaf = one flag byte per key; a word = 32 flags) ---------------

/** Lowest key in word p of leaf n (width w) that is >= from and != ex, or -1. */
function wordLow(n, w, p, from, ex) {
    if (n === null) return -1;
    const lo = Math.max(p * 32, from);
    const hi = Math.min(p * 32 + 32, 2 ** w);
    for (let k = lo; k < hi; k++) if (k !== ex && n.f[k] !== 0) return k;
    return -1;
}

/** Highest key in word p of leaf n (width w) that is <= upto and != ex, or -1. */
function wordHigh(n, w, p, upto, ex) {
    if (n === null) return -1;
    const lo = p * 32;
    const hi = Math.min(p * 32 + 31, upto, 2 ** w - 1);
    for (let k = hi; k >= lo; k--) if (k !== ex && n.f[k] !== 0) return k;
    return -1;
}

/** Ascending leaf scan from bit s (ex = a key treated as absent, -1 = none). */
function scanAsc(c, n, w, s, ex) {
    if (s >= 2 ** w) return -1;
    const nw = leafWords(w);
    for (let p = s >>> 5; p < nw; p++) {
        c.t.reads++;
        const k = wordLow(n, w, p, s, ex);
        if (k >= 0) return k;
    }
    return -1;
}

/** Descending leaf scan from bit s. */
function scanDesc(c, n, w, s, ex) {
    if (s < 0) return -1;
    for (let p = s >>> 5; p >= 0; p--) {
        c.t.reads++;
        const k = wordHigh(n, w, p, s, ex);
        if (k >= 0) return k;
    }
    return -1;
}

/** Min of a child node: internal = its min slot (1 read), leaf = ascending scan. */
function minOf(c, n, w) {
    if (w <= LEAF_MAX_W) return scanAsc(c, n, w, 0, -1);
    c.t.reads++;
    return isEmpty(n) ? -1 : n.min;
}

/** Max of a child node: internal = its max slot (1 read), leaf = descending scan. */
function maxOf(c, n, w, ex) {
    if (w <= LEAF_MAX_W) return scanDesc(c, n, w, 2 ** w - 1, ex);
    c.t.reads++;
    return isEmpty(n) ? -1 : n.max;
}

// --- value-only helpers (no counting): post-delete state of an untouched-by-cost node ---

function valMaxExcl(n, w, ex) {
    if (isEmpty(n)) return -1;
    if (n.leaf) {
        for (let k = 2 ** w - 1; k >= 0; k--) if (k !== ex && n.f[k] !== 0) return k;
        return -1;
    }
    if (n.max !== ex) return n.max;
    if (n.min === ex) return -1;
    return valPred(n, w, ex);
}

function valPred(n, w, x) {
    if (isEmpty(n)) return -1;
    if (n.leaf) {
        for (let k = x - 1; k >= 0; k--) if (n.f[k] !== 0) return k;
        return -1;
    }
    if (x > n.max) return n.max;
    if (x <= n.min) return -1;
    const lo = n.lo;
    const P = 2 ** lo;
    const j = Math.floor(x / P);
    const c = n.clusters[j];
    if (!isEmpty(c)) {
        const r = valPred(c, lo, x - j * P);
        if (r >= 0) return j * P + r;
    }
    const pj = valPred(n.summary, n.hi, j);
    if (pj < 0) return n.min;
    return pj * P + valMaxExcl(n.clusters[pj], lo, -1);
}

// --- per-op walks --------------------------------------------------------------------------

function hasWalk(c, n, w, x) {
    for (;;) {
        if (w <= LEAF_MAX_W) {
            c.t.reads++;
            return n !== null && n.f[x] !== 0;
        }
        c.t.reads += 2;
        if (isEmpty(n)) return false;
        if (x === n.min || x === n.max) return true;
        c.g.reads++;
        const lo = splitLo(w);
        const j = Math.floor(x / 2 ** lo);
        x -= j * 2 ** lo;
        n = n.clusters[j];
        w = lo;
    }
}

/** { present, wasEmpty } -- pending = a leaf cluster whose parent awaits the empty test. */
function addWalk(c, n, w, x, pending) {
    if (w <= LEAF_MAX_W) {
        c.t.reads++;
        if (n !== null && n.f[x] !== 0) return { present: true, wasEmpty: false };
        c.t.writes++;
        if (!pending) return { present: false, wasEmpty: false };
        const p = x >>> 5;
        if (wordLow(n, w, p, 0, -1) >= 0) return { present: false, wasEmpty: false };
        const nw = leafWords(w);
        for (let q = 0; q < nw; q++) {
            if (q === p) continue;
            c.t.reads++;
            if (wordLow(n, w, q, 0, -1) >= 0) return { present: false, wasEmpty: false };
        }
        return { present: false, wasEmpty: true };
    }
    c.t.reads += 2;
    if (isEmpty(n)) {
        c.t.writes += 2;
        return { present: false, wasEmpty: true };
    }
    if (x === n.min || x === n.max) return { present: true, wasEmpty: false };
    if (x < n.min) {
        c.t.writes++;
        x = n.min;
    } else if (x > n.max) {
        c.t.writes++;
    }
    c.g.reads++;
    const lo = splitLo(w);
    const hi = w - lo;
    const j = Math.floor(x / 2 ** lo);
    const xl = x - j * 2 ** lo;
    const r = addWalk(c, n.clusters[j], lo, xl, true);
    if (r.present) return r;
    if (r.wasEmpty) {
        bump(c, lo <= LEAF_MAX_W ? 'addEmptyLeafCluster' : 'addEmptyIntCluster');
        addWalk(c, n.summary, hi, j, false);
    }
    return { present: false, wasEmpty: false };
}

/** { present, emptied } -- emptied: true / false, or null when not tested (leaf, no parent). */
function delWalk(c, n, w, x, pending) {
    if (w <= LEAF_MAX_W) {
        c.t.reads++;
        if (n === null || n.f[x] === 0) return { present: false, emptied: null };
        c.t.writes++;
        if (!pending) return { present: true, emptied: null };
        const p = x >>> 5;
        if (wordLow(n, w, p, 0, x) >= 0) return { present: true, emptied: false };
        const nw = leafWords(w);
        for (let q = 0; q < nw; q++) {
            if (q === p) continue;
            c.t.reads++;
            if (wordLow(n, w, q, 0, -1) >= 0) return { present: true, emptied: false };
        }
        return { present: true, emptied: true };
    }
    c.t.reads += 2;
    if (isEmpty(n)) return { present: false, emptied: null };
    if (x < n.min || x > n.max) {
        // C-18 (6): the header proves absence -> false after its 2 reads (no descent, no _g, no _p)
        bump(c, 'delAbsentAtHeader');
        return { present: false, emptied: null };
    }
    if (n.min === n.max && x === n.min) {
        c.t.writes += 2;
        bump(c, 'delSingleton');
        return { present: true, emptied: true };
    }
    const lo = splitLo(w);
    const hi = w - lo;
    const P = 2 ** lo;
    c.g.reads++;
    if (x === n.min) {
        bump(c, 'delMinSwap');
        const sm = minOf(c, n.summary, hi);
        const cm = minOf(c, n.clusters[sm], lo);
        x = sm * P + cm;
        c.t.writes++;
    }
    const j = Math.floor(x / P);
    const xl = x - j * P;
    const cl = n.clusters[j];
    const r = delWalk(c, cl, lo, xl, true);
    if (!r.present) return { present: false, emptied: null };
    let sEmptied = null;
    if (r.emptied) sEmptied = delWalk(c, n.summary, hi, j, false).emptied;
    if (x === n.max) {
        c.frames++;
        c.p.writes += 4;
        c.p.reads += 4;
        if (!r.emptied) {
            bump(c, 'delFrame2');
            c.g.reads++;
            maxOf(c, cl, lo, xl);
        } else {
            bump(c, 'delFrame1');
            let sm;
            if (hi > LEAF_MAX_W && sEmptied === true) {
                bump(c, 'refresh0');
                sm = -1;
            } else {
                sm = maxOf(c, n.summary, hi, j);
                if (hi > LEAF_MAX_W) sm = valMaxExcl(n.summary, hi, j);
            }
            if (sm >= 0) {
                c.g.reads++;
                maxOf(c, n.clusters[sm], lo, -1);
            }
        }
        c.t.writes++;
    }
    return { present: true, emptied: false };
}

function succWalk(c, n, w, x) {
    if (w <= LEAF_MAX_W) return scanAsc(c, n, w, x + 1, -1);
    if (isEmpty(n)) throw new Error('vebCost: successor visited an empty internal node');
    c.t.reads++;
    if (x < n.min) return n.min;
    c.t.reads++;
    if (x >= n.max) return -1;
    c.g.reads++;
    const lo = splitLo(w);
    const hi = w - lo;
    const P = 2 ** lo;
    const j = Math.floor(x / P);
    const xl = x - j * P;
    const cl = n.clusters[j];
    if (lo <= LEAF_MAX_W) {
        const r = scanAsc(c, cl, lo, xl + 1, -1);
        if (r >= 0) return j * P + r;
    } else {
        c.t.reads++;
        if (!isEmpty(cl) && xl < cl.max) {
            bump(c, 'succIntVisit');
            return j * P + succWalk(c, cl, lo, xl);
        }
        bump(c, 'succIntSkip');
    }
    bump(c, 'succSummary');
    const sj = succWalk(c, n.summary, hi, j);
    if (sj < 0) return -1;
    return sj * P + minOf(c, n.clusters[sj], lo);
}

function predWalk(c, n, w, x) {
    if (w <= LEAF_MAX_W) return scanDesc(c, n, w, x - 1, -1);
    if (isEmpty(n)) throw new Error('vebCost: predecessor visited an empty internal node');
    c.t.reads++;
    if (x > n.max) return n.max;
    c.t.reads++;
    if (x <= n.min) return -1;
    c.g.reads++;
    const lo = splitLo(w);
    const hi = w - lo;
    const P = 2 ** lo;
    const j = Math.floor(x / P);
    const xl = x - j * P;
    const cl = n.clusters[j];
    if (lo <= LEAF_MAX_W) {
        const r = scanDesc(c, cl, lo, xl - 1, -1);
        if (r >= 0) return j * P + r;
    } else {
        c.t.reads++;
        if (!isEmpty(cl) && xl > cl.min) {
            bump(c, 'predIntVisit');
            return j * P + predWalk(c, cl, lo, xl);
        }
        bump(c, 'predIntSkip');
    }
    bump(c, 'predSummary');
    const pj = predWalk(c, n.summary, hi, j);
    if (pj < 0) {
        bump(c, 'predMinFallback');
        return n.min;
    }
    return pj * P + maxOf(c, n.clusters[pj], lo, -1);
}

/** A key the engine accepts: a number, an integer in [0, U) (-0 aliases 0). */
export function validKey(ref, x) {
    return typeof x === 'number' && (x >>> 0) === x && x < ref.universe;
}

/**
 * Expected column counts of op(x) on the VebRef state `ref` (not mutated).
 * Returns { t, g, p, ret, cov, frames }; ret uses the public contract (undefined
 * for absent, booleans for has / delete, 'throws' for a rejected add, 'this' for add).
 */
export function vebCost(ref, op, x) {
    const c = zero();
    c.cov = {};
    c.frames = 0;
    const root = ref._root;
    const W = ref.bits;
    let ret;
    if (op === 'min' || op === 'max') {
        if (ref.size === 0) ret = undefined;
        else if (W > LEAF_MAX_W) {
            c.t.reads++;
            ret = op === 'min' ? root.min : root.max;
        } else {
            const r = op === 'min' ? scanAsc(c, root, W, 0, -1) : scanDesc(c, root, W, 2 ** W - 1, -1);
            ret = r < 0 ? undefined : r;
        }
    } else if (!validKey(ref, x)) {
        ret = op === 'add' ? 'throws' : (op === 'has' || op === 'delete' ? false : undefined);
    } else {
        const k = x >>> 0;
        if (op === 'has') {
            ret = hasWalk(c, root, W, k);
        } else if (op === 'add') {
            addWalk(c, root, W, k, false);
            ret = 'this';
        } else if (op === 'delete') {
            ret = delWalk(c, root, W, k, false).present;
        } else if (op === 'successor' || op === 'predecessor') {
            if (ref.size === 0) ret = undefined;
            else {
                const r = op === 'successor' ? succWalk(c, root, W, k) : predWalk(c, root, W, k);
                ret = r < 0 ? undefined : r;
            }
        } else {
            throw new Error('vebCost: unknown op ' + op);
        }
    }
    if (c.frames > 2) throw new Error('vebCost: ' + c.frames + ' delete frames > 2 (C-12)');
    if (c.frames === 2) bump(c, 'delTwoFrames');
    return { t: c.t, g: c.g, p: c.p, ret, cov: c.cov, frames: c.frames };
}

/** 'tR/tW gR/gW pR/pW' -- a compact row for messages. */
export function fmtCost(m) {
    return 't ' + m.t.reads + '/' + m.t.writes + ' g ' + m.g.reads + '/' + m.g.writes +
        ' p ' + m.p.reads + '/' + m.p.writes;
}

/** true when all six numbers agree. */
export function sameCost(a, b) {
    return a.t.reads === b.t.reads && a.t.writes === b.t.writes &&
        a.g.reads === b.g.reads && a.g.writes === b.g.writes &&
        a.p.reads === b.p.reads && a.p.writes === b.p.writes;
}
