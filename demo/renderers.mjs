// @zakkster/lite-loglogn -- per-member renderers (repo-only demo, snapshot-driven).
//
// One renderer per member, keyed sb / xft / yft / veb / roar. Each is
//   { fields, model(snap), draw(g, m, geom), path(m, x) }
// and reads ONLY its model, which is a pick of `fields` from the member's snapshot:
// dump() for StratifiedBitset / XFastTrie / YFastTrie / RoaringSet, and the demo's
// vebSnapshot(tree) for vEBTree ({universe, bits, size, lo, min, max, keys, clusters}).
// No shadow state: nothing here holds a copy of a member between calls.
//
// model(snap): null for an absent member (veb above VEB_U_MAX); otherwise a fresh
//   object with exactly `fields`, in order, values taken from `snap`. A snapshot that
//   lacks a field as an OWN property (absent, or only inherited) throws
//   `[lite-loglogn-demo]` (fail closed, never a silent undefined).
//
// path(m, x) -> step[]: the route a successor(x) query takes through the STRUCTURE the
//   model shows, derived from the model alone (no public probe counters exist, so the
//   path is re-derived, not recorded). Every step is
//     { level, index, lo, hi, key, last, exact }
//   level / index: the row and the element of that row the step touches (index -1 =
//   none); [lo, hi): the key range that element covers (the panel highlights it);
//   last: true only on the final step. The FINAL step carries the answer:
//     key = successor(x) (STRICT: the smallest key > x), or undefined when none;
//     exact = true when `key` is decided by the model.
//   RoaringSet's dump carries chunk counts and kinds, NOT keys, so its model cannot
//   name every successor: when it cannot, the final step has exact = false,
//   key = undefined and [lo, hi) brackets the successor (it lies in [lo, hi); when no
//   live chunk follows x's chunk it may also be absent). A 'full' chunk is decided
//   exactly. path(null, x) and a bad x (not an integer in [0, 2^32)) return [].
//
// draw(g, m, geom): CanvasRenderingContext2D, browser only. geom = {x, y, w, h} plus
//   optional `path` (a step[] to light up) and `note` (the text drawn when m is null).
//   Every row is drawn in KEY space ([0, U) across the width), binned to at most
//   MAX_BINS cells; each cell encodes its element count (alpha), the exact centroid of
//   its elements (a 1 px tick) and a member-specific auxiliary value (a bar), so a
//   single moved / flipped / resized element changes the drawing.
//
// Cold, allocating (snapshots, steps, strings): called at ~10 Hz off the measured path.
// This module imports NOTHING. Repo-only dev artifact; never shipped. ASCII-only.

const TAG = '[lite-loglogn-demo] ';

/* ------------------------------- palette --------------------------------- */
// Hex (canvas fillStyle takes hex everywhere).
const COL = Object.freeze({
    bg: '#04120c',
    empty: '#0b1f16',
    edge: '#1d2b25',
    set: '#37e08a',
    rep: '#46b0ff',
    aux: '#9fe3bf',
    tick: '#eafff2',
    text: '#cfe8d8',
    dim: '#7fa591',
    hot: '#ffcf5a',
    miss: '#ff6a6a',
    warn: '#ff8a6a',
});

/** RoaringSet container kinds (dump names) and one colour each. */
const ROAR_KINDS = Object.freeze(['single', 'small', 'array', 'bitmap', 'runs', 'smallRuns', 'full']);
const ROAR_COL = Object.freeze(['#7fa591', '#46b0ff', '#37e08a', '#ffcf5a', '#ff8a6a', '#c58aff', '#eafff2']);
const ROAR_NK = ROAR_KINDS.length;
const CHUNK = 65536;

/* ------------------------------ scratch bins ----------------------------- */
// Reused by every draw (cold, but there is no reason to allocate per row).
const MAX_BINS = 256;
const BIN_CNT = new Float64Array(MAX_BINS);
const BIN_SUM = new Float64Array(MAX_BINS);
const BIN_AUX = new Float64Array(MAX_BINS);
const BIN_AUX2 = new Float64Array(MAX_BINS);
const BIN_KIND = new Float64Array(MAX_BINS * ROAR_NK);

const HEAD_H = 16;
const ROW_GAP = 3;
const FONT = '11px ui-monospace, Menlo, Consolas, monospace';

/* -------------------------------- helpers -------------------------------- */

function fail(msg) { throw new Error(TAG + msg); }

/** A fresh object holding exactly the own `fields` of `snap`, in order; null for an absent member. */
function pick(name, snap, fields) {
    if (snap === null || snap === undefined) return null;
    if (typeof snap !== 'object') fail(name + ' snapshot is not an object');
    const o = {};
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (!Object.hasOwn(snap, f)) fail(name + ' snapshot lacks own field "' + f + '"');
        o[f] = snap[f];
    }
    return o;
}

function ctz32(v) { return 31 - Math.clz32(v & -v); }

function popcount32(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

function validKey(x) { return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 4294967296; }

/** Index of v in ascending arr[0..len), or -1. */
function findExact(arr, len, v) {
    let a = 0, b = len - 1;
    while (a <= b) {
        const mid = (a + b) >>> 1;
        const y = arr[mid];
        if (y === v) return mid;
        if (y < v) a = mid + 1; else b = mid - 1;
    }
    return -1;
}

/** First index i in ascending arr[0..len) with arr[i] > v (len when none). */
function upperBound(arr, len, v) {
    let a = 0, b = len;
    while (a < b) {
        const mid = (a + b) >>> 1;
        if (arr[mid] <= v) a = mid + 1; else b = mid;
    }
    return a;
}

function mkStep(level, index, lo, hi) {
    return { level, index, lo, hi, key: undefined, last: false, exact: true };
}

function mkLast(level, index, key, U) {
    const k = key === undefined ? U : key;
    return { level, index, lo: k, hi: key === undefined ? U : k + 1, key, last: true, exact: true };
}

function mkBracket(level, index, lo, hi) {
    return { level, index, lo, hi, key: undefined, last: true, exact: false };
}

/* --------------------------- key-space row drawing ------------------------ */

function binCount(U, unit) {
    const cells = Math.ceil(U / unit);
    return cells < MAX_BINS ? (cells < 1 ? 1 : cells) : MAX_BINS;
}

function binsClear(bins) {
    BIN_CNT.fill(0, 0, bins);
    BIN_SUM.fill(0, 0, bins);
    BIN_AUX.fill(0, 0, bins);
    BIN_AUX2.fill(0, 0, bins);
}

/** Add one element at key position pos (in [0, U)) with two auxiliary values. */
function binAdd(pos, U, bins, aux, aux2) {
    let b = Math.floor(pos * bins / U);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    BIN_CNT[b] += 1;
    BIN_SUM[b] += pos;
    BIN_AUX[b] += aux;
    BIN_AUX2[b] += aux2;
    return b;
}

/**
 * Draw one binned row in key space. cap = most elements one bin can hold (alpha =
 * count / cap); unit = the key span of one element (the centroid sits mid-element);
 * auxCap > 0 draws the mean BIN_AUX / auxCap as a bottom bar; aux2Cap > 0 sets the
 * centroid tick alpha from the mean BIN_AUX2 / aux2Cap.
 */
function drawRow(g, gx, gy, gw, gh, bins, U, unit, cap, color, auxCap, aux2Cap) {
    const cw = gw / bins;
    g.globalAlpha = 1;
    g.fillStyle = COL.empty;
    g.fillRect(gx, gy, gw, gh);
    g.fillStyle = color;
    for (let b = 0; b < bins; b++) {
        const c = BIN_CNT[b];
        if (c > 0) {
            const f = c / cap;
            g.globalAlpha = 0.25 + 0.75 * (f < 1 ? f : 1);
            g.fillRect(gx + b * cw, gy, cw, gh);
        }
    }
    if (auxCap > 0) {
        g.fillStyle = COL.aux;
        for (let b = 0; b < bins; b++) {
            const c = BIN_CNT[b];
            if (c > 0) {
                const f = BIN_AUX[b] / (c * auxCap);
                const bh = gh * 0.45 * (f < 1 ? f : 1);
                g.globalAlpha = 0.7;
                g.fillRect(gx + b * cw, gy + gh - bh, cw, bh);
            }
        }
    }
    g.fillStyle = COL.tick;
    for (let b = 0; b < bins; b++) {
        const c = BIN_CNT[b];
        if (c > 0) {
            let a = 0.9;
            if (aux2Cap > 0) {
                const f = BIN_AUX2[b] / (c * aux2Cap);
                a = 0.3 + 0.7 * (f < 1 ? f : 1);
            }
            g.globalAlpha = a;
            g.fillRect(gx + (BIN_SUM[b] / c + unit * 0.5) / U * gw - 0.5, gy, 1, gh);
        }
    }
    g.globalAlpha = 1;
    g.strokeStyle = COL.edge;
    g.lineWidth = 1;
    g.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
}

function header(g, geom, text) {
    g.globalAlpha = 1;
    g.fillStyle = COL.bg;
    g.fillRect(geom.x, geom.y, geom.w, geom.h);
    g.font = FONT;
    g.fillStyle = COL.text;
    g.fillText(text, geom.x, geom.y + 11);
}

function drawNull(g, geom, why) {
    g.globalAlpha = 1;
    g.fillStyle = COL.bg;
    g.fillRect(geom.x, geom.y, geom.w, geom.h);
    g.font = FONT;
    g.fillStyle = COL.dim;
    g.fillText(why, geom.x, geom.y + geom.h * 0.5);
}

function drawEmpty(g, geom) {
    g.font = FONT;
    g.fillStyle = COL.dim;
    g.globalAlpha = 1;
    g.fillText('empty', geom.x + geom.w * 0.5 - 14, geom.y + geom.h * 0.5);
}

/** Row geometry: rows stacked under the header. */
function rowH(geom, rows) {
    return (geom.h - HEAD_H - ROW_GAP * rows) / rows;
}

function rowY(geom, r, rh) {
    return geom.y + HEAD_H + r * (rh + ROW_GAP);
}

/**
 * Light up a path. rowOfLevel(level) -> row number. Each step highlights [lo, hi)
 * on its row (hot when it hit, miss colour when index is -1); the final step ticks
 * its key (or outlines its bracket when inexact). gw = the width the member's rows are
 * drawn across (geom.w, or geom.w - XFT_GUTTER for xft's load gutter), so the highlight lands on them.
 */
function drawPath(g, geom, gw, steps, U, rh, rowOfLevel, keyRow) {
    if (!steps || steps.length === 0) return;
    g.globalAlpha = 1;
    g.lineWidth = 1.5;
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const r = s.last ? keyRow : rowOfLevel(s.level);
        const y = rowY(geom, r, rh);
        if (s.last) {
            if (s.exact && s.key !== undefined) {
                g.fillStyle = COL.hot;
                g.fillRect(geom.x + (s.key + 0.5) / U * gw - 1.5, y - 2, 3, rh + 4);
            } else if (!s.exact) {
                const x0 = geom.x + s.lo / U * gw;
                const x1 = geom.x + s.hi / U * gw;
                g.strokeStyle = COL.warn;
                g.strokeRect(x0, y - 1, (x1 - x0 > 2 ? x1 - x0 : 2), rh + 2);
            }
            continue;
        }
        const x0 = geom.x + s.lo / U * gw;
        const x1 = geom.x + s.hi / U * gw;
        g.strokeStyle = s.index >= 0 ? COL.hot : COL.miss;
        g.strokeRect(x0, y - 1, (x1 - x0 > 2 ? x1 - x0 : 2), rh + 2);
    }
}

/* ================================ sb ===================================== */
// StratifiedBitset: rows = the summary pyramid, top level first, level 0 (the key
// bits) last. Bit i of level L covers keys [i 32^L, (i+1) 32^L).

const SB_FIELDS = Object.freeze(['universe', 'size', 'words']);

function sbPath(m, x) {
    const out = [];
    if (m === null || !validKey(x)) return out;
    const U = m.universe;
    const words = m.words;
    const top = words.length - 1;
    const y = x + 1;
    if (m.size === 0 || y >= U) { out.push(mkLast(0, -1, undefined, U)); return out; }
    let L = 0;
    let i = y;
    let found = false;
    for (;;) {
        const arr = words[L];
        const wi = Math.floor(i / 32);
        if (wi >= arr.length) break;
        const span = 32 * Math.pow(32, L);
        out.push(mkStep(L, wi, wi * span, Math.min(U, (wi + 1) * span)));
        const word = (arr[wi] & (0xFFFFFFFF << (i & 31))) >>> 0;
        if (word !== 0) { i = wi * 32 + ctz32(word); found = true; break; }
        if (L === top) {
            let k = wi + 1;
            while (k < arr.length && arr[k] === 0) k++;
            if (k >= arr.length) break;
            out.push(mkStep(L, k, k * span, Math.min(U, (k + 1) * span)));
            i = k * 32 + ctz32(arr[k]);
            found = true;
            break;
        }
        L++;
        i = wi + 1;
    }
    if (!found) { out.push(mkLast(0, -1, undefined, U)); return out; }
    while (L > 0) {
        L--;
        const span = 32 * Math.pow(32, L);
        const word = words[L][i];
        out.push(mkStep(L, i, i * span, Math.min(U, (i + 1) * span)));
        if (word === undefined || word === 0) {
            // The summary claims a word the level below does not hold: inconsistent model.
            out.push(mkBracket(L, i, i * span, Math.min(U, (i + 1) * span)));
            return out;
        }
        i = i * 32 + ctz32(word);
    }
    out.push(mkLast(0, i, i, U));
    return out;
}

function sbDraw(g, m, geom) {
    if (m === null) { drawNull(g, geom, geom.note || 'n/a'); return; }
    const U = m.universe;
    const words = m.words;
    const levels = words.length;
    header(g, geom, 'StratifiedBitset  U ' + U + '  size ' + m.size + '  levels ' + levels +
        '  (rows: summary top -> key bits)');
    const rh = rowH(geom, levels);
    for (let r = 0; r < levels; r++) {
        const L = levels - 1 - r;
        const arr = words[L];
        const unit = Math.pow(32, L);
        const bins = binCount(U, unit);
        binsClear(bins);
        for (let wi = 0; wi < arr.length; wi++) {
            let v = arr[wi];
            if (v === 0) continue;
            const pc = popcount32(v);
            while (v !== 0) {
                const b = ctz32(v);
                binAdd((wi * 32 + b) * unit, U, bins, pc, 0);
                v = (v & (v - 1)) >>> 0;
            }
        }
        const cap = Math.max(1, Math.ceil(U / unit / bins));
        drawRow(g, geom.x, rowY(geom, r, rh), geom.w, rh, bins, U, unit, cap, COL.set, 32, 0);
    }
    drawPath(g, geom, geom.w, geom.path, U, rh, (lvl) => levels - 1 - lvl, levels - 1);
    if (m.size === 0) drawEmpty(g, geom);
}

/* ================================ xft ==================================== */
// XFastTrie: one row per prefix length L = 1..w (level w = the keys, with the leaf
// thread drawn through it). Prefix p of length L covers keys [p 2^(w-L), (p+1) 2^(w-L)).

const XFT_FIELDS = Object.freeze(['universe', 'capacity', 'size', 'bits', 'keys', 'levels']);

function xftPath(m, x) {
    const out = [];
    if (m === null || !validKey(x)) return out;
    const U = m.universe;
    const w = m.bits;
    // x in [U, 2^32): no key is > x (the prefix search would match a truncated prefix).
    if (x >= U) { out.push(mkLast(w, -1, undefined, U)); return out; }
    const keys = m.keys;
    const n = keys.length;
    const levels = m.levels;
    if (n === 0 || m.size === 0) { out.push(mkLast(w, -1, undefined, U)); return out; }
    // Binary search over levels for the longest prefix of x present (L = 0 always is).
    let a = 0, b = w, aIdx = -1;
    while (a < b) {
        const mid = (a + b + 1) >>> 1;
        const unit = Math.pow(2, w - mid);
        const p = Math.floor(x / unit);
        const lv = levels[mid - 1];
        const idx = findExact(lv.prefix, lv.prefix.length, p);
        out.push(mkStep(mid, idx, p * unit, Math.min(U, (p + 1) * unit)));
        if (idx >= 0) { a = mid; aIdx = idx; } else b = mid - 1;
    }
    const L = a;
    if (L === w) {
        // x is present: the leaf thread's next key.
        const k = findExact(keys, n, x);
        if (k < 0) { out.push(mkBracket(w, -1, x, U)); return out; }
        out.push(k + 1 < n ? mkLast(w, k + 1, keys[k + 1], U) : mkLast(w, -1, undefined, U));
        return out;
    }
    const bit = Math.floor(x / Math.pow(2, w - L - 1)) & 1;
    if (L === 0) {
        // No level-1 prefix of x: every key differs from x in its top bit.
        out.push(bit === 0 ? mkLast(w, 0, keys[0], U) : mkLast(w, -1, undefined, U));
        return out;
    }
    const lv = levels[L - 1];
    if (bit === 0) {
        // Every key under the matched node is > x: the node's min.
        const mn = lv.min[aIdx];
        out.push(mkLast(w, findExact(keys, n, mn), mn, U));
        return out;
    }
    // Every key under the matched node is < x: thread step after the node's max.
    const mx = lv.max[aIdx];
    const k = findExact(keys, n, mx);
    if (k < 0) { out.push(mkBracket(w, -1, x + 1, U)); return out; }
    out.push(mkStep(w, k, mx, mx + 1));
    out.push(k + 1 < n ? mkLast(w, k + 1, keys[k + 1], U) : mkLast(w, -1, undefined, U));
    return out;
}

/** Width xftDraw reserves right of its rows for the per-level load bar (the page's probe maps across geom.w - this). */
export const XFT_GUTTER = 6;

function xftDraw(g, m, geom) {
    if (m === null) { drawNull(g, geom, geom.note || 'n/a'); return; }
    const U = m.universe;
    const w = m.bits;
    const levels = m.levels;
    const rows = levels.length;
    header(g, geom, 'XFastTrie  U ' + U + '  w ' + w + '  size ' + m.size + '  C ' + m.capacity +
        '  (rows: prefix length 1 -> w; tick = centroid, bar = subtree span)');
    const rh = rowH(geom, rows);
    const gw = geom.w - XFT_GUTTER;
    for (let r = 0; r < rows; r++) {
        const L = r + 1;
        const lv = levels[r];
        const unit = Math.pow(2, w - L);
        const bins = binCount(U, unit);
        binsClear(bins);
        const np = lv.prefix.length;
        for (let i = 0; i < np; i++) {
            binAdd(lv.prefix[i] * unit, U, bins, lv.max[i] - lv.min[i] + 1, 0);
        }
        const cap = Math.max(1, Math.ceil(U / unit / bins));
        const y = rowY(geom, r, rh);
        drawRow(g, geom.x, y, gw, rh, bins, U, unit, cap, COL.set, unit, 0);
        // Right gutter: this level table's load (prefixes / usable slots).
        const load = lv.capacity > 0 ? np / lv.capacity : 1;
        g.fillStyle = load > 1 ? COL.miss : COL.dim;
        g.fillRect(geom.x + gw + 2, y + rh * (1 - (load < 1 ? load : 1)), 4, rh * (load < 1 ? load : 1));
    }
    // The threaded leaf list through the key row (centroid polyline).
    const keys = m.keys;
    const n = keys.length;
    if (n > 0 && rows > 0) {
        const bins = binCount(U, 1);
        binsClear(bins);
        for (let i = 0; i < n; i++) binAdd(keys[i], U, bins, 0, 0);
        const y = rowY(geom, rows - 1, rh) + rh * 0.5;
        g.strokeStyle = COL.hot;
        g.globalAlpha = 0.6;
        g.lineWidth = 1;
        g.beginPath();
        let first = true;
        for (let b = 0; b < bins; b++) {
            const c = BIN_CNT[b];
            if (c === 0) continue;
            const px = geom.x + (BIN_SUM[b] / c + 0.5) / U * gw;
            if (first) { g.moveTo(px, y); first = false; } else g.lineTo(px, y);
        }
        g.stroke();
        g.globalAlpha = 1;
    }
    drawPath(g, geom, gw, geom.path, U, rh, (lvl) => (lvl > 0 ? lvl - 1 : 0), rows - 1);
    if (m.size === 0) drawEmpty(g, geom);
}

/* ================================ yft ==================================== */
// YFastTrie: row 0 = the representatives (the inner x-fast trie's keys), row 1 =
// the buckets (bar = bucket fill vs K = 2w), row 2 = the keys.

const YFT_FIELDS = Object.freeze(['universe', 'capacity', 'size', 'bits', 'keys', 'reps', 'sizes']);

function yftPath(m, x) {
    const out = [];
    if (m === null || !validKey(x)) return out;
    const U = m.universe;
    const keys = m.keys;
    const reps = m.reps;
    const sizes = m.sizes;
    const R = reps.length;
    const n = keys.length;
    if (n === 0 || R === 0) { out.push(mkLast(2, -1, undefined, U)); return out; }
    // The x-fast predecessor search over reps (reps[0] = 0 <= x).
    let a = 0, b = R - 1;
    while (a < b) {
        const mid = (a + b + 1) >>> 1;
        const r = reps[mid];
        out.push(mkStep(0, mid, r, r + 1));
        if (r <= x) a = mid; else b = mid - 1;
    }
    let off = 0;
    for (let i = 0; i < a; i++) off += sizes[i];
    out.push(mkStep(1, a, reps[a], a + 1 < R ? reps[a + 1] : U));
    for (let bi = a; bi < R; bi++) {
        const s = sizes[bi];
        if (bi > a && s > 0) out.push(mkStep(1, bi, reps[bi], bi + 1 < R ? reps[bi + 1] : U));
        for (let k = off; k < off + s && k < n; k++) {
            if (keys[k] > x) { out.push(mkLast(2, k, keys[k], U)); return out; }
        }
        off += s;
    }
    out.push(mkLast(2, -1, undefined, U));
    return out;
}

function yftDraw(g, m, geom) {
    if (m === null) { drawNull(g, geom, geom.note || 'n/a'); return; }
    const U = m.universe;
    const w = m.bits;
    const K = 2 * w;
    const keys = m.keys;
    const reps = m.reps;
    const sizes = m.sizes;
    const R = reps.length;
    header(g, geom, 'YFastTrie  U ' + U + '  w ' + w + '  size ' + m.size + '  C ' + m.capacity +
        '  reps ' + R + '  (rows: reps, buckets vs K=2w, keys)');
    const rh = rowH(geom, 3);
    const bins = binCount(U, 1);
    const cap = Math.max(1, Math.ceil(U / bins));
    binsClear(bins);
    for (let i = 0; i < R; i++) binAdd(reps[i], U, bins, 0, 0);
    drawRow(g, geom.x, rowY(geom, 0, rh), geom.w, rh, bins, U, 1, cap, COL.rep, 0, 0);
    binsClear(bins);
    for (let i = 0; i < R; i++) binAdd(reps[i], U, bins, sizes[i], 0);
    drawRow(g, geom.x, rowY(geom, 1, rh), geom.w, rh, bins, U, 1, cap, COL.edge, K, 0);
    binsClear(bins);
    for (let i = 0; i < keys.length; i++) binAdd(keys[i], U, bins, 0, 0);
    drawRow(g, geom.x, rowY(geom, 2, rh), geom.w, rh, bins, U, 1, cap, COL.set, 0, 0);
    drawPath(g, geom, geom.w, geom.path, U, rh, (lvl) => lvl, 2);
    if (m.size === 0) drawEmpty(g, geom);
}

/* ================================ veb ==================================== */
// vEBTree (decoded by the demo's vebSnapshot): row 0 = the summary (one element per
// non-empty cluster j, covering [j 2^lo, (j+1) 2^lo); bar = cluster count / 2^lo,
// tick alpha = cluster span), row 1 = the keys with the root min / max marked.
// A cluster's min / max may be stored full or as the low part; full() reads both.

const VEB_FIELDS = Object.freeze(['universe', 'bits', 'size', 'lo', 'min', 'max', 'keys', 'clusters']);

function vebFull(j, v, unit) {
    const base = j * unit;
    return v < base ? base + v : v;
}

function vebLeaf(m) { return !(m.lo > 0 && m.lo < m.bits) || m.clusters.length === 0; }

function vebPath(m, x) {
    const out = [];
    if (m === null || !validKey(x)) return out;
    const U = m.universe;
    const keys = m.keys;
    const n = keys.length;
    if (n === 0 || m.size === 0) { out.push(mkLast(1, -1, undefined, U)); return out; }
    out.push(mkStep(0, -1, 0, U));
    if (typeof m.min === 'number' && x < m.min) {
        out.push(mkLast(1, findExact(keys, n, m.min), m.min, U));
        return out;
    }
    if (vebLeaf(m)) {
        const k = upperBound(keys, n, x);
        out.push(k < n ? mkLast(1, k, keys[k], U) : mkLast(1, -1, undefined, U));
        return out;
    }
    const unit = Math.pow(2, m.lo);
    const cl = m.clusters;
    const j = Math.floor(x / unit);
    let ci = 0;
    while (ci < cl.length && cl[ci].j < j) ci++;
    if (ci < cl.length && cl[ci].j === j) {
        const c = cl[ci];
        out.push(mkStep(0, ci, j * unit, Math.min(U, (j + 1) * unit)));
        if (x < vebFull(j, c.max, unit)) {
            const k = upperBound(keys, n, x);
            if (k < n && keys[k] < (j + 1) * unit) { out.push(mkLast(1, k, keys[k], U)); return out; }
        }
        ci++;
    }
    // The summary's successor of j: the next non-empty cluster, then its min.
    if (ci < cl.length) {
        const c = cl[ci];
        out.push(mkStep(0, ci, c.j * unit, Math.min(U, (c.j + 1) * unit)));
        const mn = vebFull(c.j, c.min, unit);
        out.push(mkLast(1, findExact(keys, n, mn), mn, U));
        return out;
    }
    out.push(mkLast(1, -1, undefined, U));
    return out;
}

function vebDraw(g, m, geom) {
    if (m === null) { drawNull(g, geom, geom.note || 'n/a'); return; }
    const U = m.universe;
    const keys = m.keys;
    const cl = m.clusters;
    const leaf = vebLeaf(m);
    header(g, geom, 'vEBTree  U ' + U + '  w ' + m.bits + '  lo ' + m.lo + '  size ' + m.size +
        '  clusters ' + cl.length + '  min ' + (m.min === undefined ? '-' : m.min) +
        '  max ' + (m.max === undefined ? '-' : m.max) + '  (rows: summary, keys)');
    const rh = rowH(geom, 2);
    const unit = leaf ? 1 : Math.pow(2, m.lo);
    let bins = binCount(U, unit);
    binsClear(bins);
    if (!leaf) {
        for (let i = 0; i < cl.length; i++) {
            const c = cl[i];
            const span = vebFull(c.j, c.max, unit) - vebFull(c.j, c.min, unit) + 1;
            binAdd(c.j * unit, U, bins, c.count, span);
        }
    }
    drawRow(g, geom.x, rowY(geom, 0, rh), geom.w, rh, bins, U, unit,
        Math.max(1, Math.ceil(U / unit / bins)), COL.rep, unit, unit);
    bins = binCount(U, 1);
    binsClear(bins);
    for (let i = 0; i < keys.length; i++) binAdd(keys[i], U, bins, 0, 0);
    const ky = rowY(geom, 1, rh);
    drawRow(g, geom.x, ky, geom.w, rh, bins, U, 1, Math.max(1, Math.ceil(U / bins)), COL.set, 0, 0);
    g.fillStyle = COL.warn;
    if (typeof m.min === 'number') g.fillRect(geom.x + (m.min + 0.5) / U * geom.w - 1, ky, 2, rh * 0.4);
    if (typeof m.max === 'number') g.fillRect(geom.x + (m.max + 0.5) / U * geom.w - 1, ky + rh * 0.6, 2, rh * 0.4);
    drawPath(g, geom, geom.w, geom.path, U, rh, (lvl) => (lvl > 0 ? 1 : 0), 1);
    if (m.size === 0) drawEmpty(g, geom);
}

/* ================================ roar =================================== */
// RoaringSet: row 0 = the live chunks (2^16 keys each; alpha = live chunks per bin,
// bar = keys / 2^16, tick alpha = runs), row 1 = the container kinds, stacked.

const ROAR_FIELDS = Object.freeze(['universe', 'size', 'paged', 'chunks']);

function roarSpan(c, U) { const s = U - c * CHUNK; return s < CHUNK ? s : CHUNK; }

function roarFull(ch, U) { return ch.kind === 'full' || ch.count === roarSpan(ch.chunk, U); }

function roarPath(m, x) {
    const out = [];
    if (m === null || !validKey(x)) return out;
    const U = m.universe;
    const cs = m.chunks;
    const nc = cs.length;
    if (nc === 0 || m.size === 0) { out.push(mkLast(1, -1, undefined, U)); return out; }
    const c = Math.floor(x / CHUNK);
    // Binary search the live-chunk list for the first chunk >= c.
    let a = 0, b = nc;
    while (a < b) {
        const mid = (a + b) >>> 1;
        const cm = cs[mid].chunk;
        out.push(mkStep(0, mid, cm * CHUNK, Math.min(U, (cm + 1) * CHUNK)));
        if (cm < c) a = mid + 1; else b = mid;
    }
    let ci = a;
    if (ci < nc && cs[ci].chunk === c) {
        const ch = cs[ci];
        const endC = Math.min(U, (c + 1) * CHUNK);
        if (roarFull(ch, U)) {
            if (x + 1 < endC) { out.push(mkLast(1, ci, x + 1, U)); return out; }
        } else {
            // x's chunk is live but its keys are not in the dump: bracket to the end of
            // the next live chunk (which holds at least one key), or of this chunk.
            const nx = ci + 1 < nc ? cs[ci + 1] : null;
            const hi = nx === null ? endC : Math.min(U, (nx.chunk + 1) * CHUNK);
            out.push(mkBracket(1, ci, x + 1, hi));
            return out;
        }
        ci++;
    }
    if (ci >= nc) { out.push(mkLast(1, -1, undefined, U)); return out; }
    const nx = cs[ci];
    const lo = nx.chunk * CHUNK;
    out.push(mkStep(0, ci, lo, Math.min(U, lo + CHUNK)));
    if (roarFull(nx, U)) { out.push(mkLast(1, ci, lo, U)); return out; }
    out.push(mkBracket(1, ci, lo, Math.min(U, lo + CHUNK)));
    return out;
}

function roarDraw(g, m, geom) {
    if (m === null) { drawNull(g, geom, geom.note || 'n/a'); return; }
    const U = m.universe;
    const cs = m.chunks;
    let legend = '';
    const tally = new Int32Array(ROAR_NK);
    for (let i = 0; i < cs.length; i++) {
        const k = ROAR_KINDS.indexOf(cs[i].kind);
        if (k >= 0) tally[k]++;
    }
    for (let k = 0; k < ROAR_NK; k++) if (tally[k] > 0) legend += '  ' + ROAR_KINDS[k] + ' ' + tally[k];
    header(g, geom, 'RoaringSet  U ' + U + '  size ' + m.size + '  chunks ' + cs.length +
        (m.paged ? '  paged' : '  direct') + legend);
    const rh = rowH(geom, 2);
    const bins = binCount(U, CHUNK);
    binsClear(bins);
    BIN_KIND.fill(0, 0, bins * ROAR_NK);
    for (let i = 0; i < cs.length; i++) {
        const ch = cs[i];
        const b = binAdd(ch.chunk * CHUNK, U, bins, ch.count, ch.runs);
        const k = ROAR_KINDS.indexOf(ch.kind);
        BIN_KIND[b * ROAR_NK + (k >= 0 ? k : 0)] += 1;
    }
    const cap = Math.max(1, Math.ceil(U / CHUNK / bins));
    drawRow(g, geom.x, rowY(geom, 0, rh), geom.w, rh, bins, U, CHUNK, cap, COL.set, CHUNK, CHUNK >>> 1);
    const y1 = rowY(geom, 1, rh);
    const cw = geom.w / bins;
    g.fillStyle = COL.empty;
    g.fillRect(geom.x, y1, geom.w, rh);
    for (let b = 0; b < bins; b++) {
        const tot = BIN_CNT[b];
        if (tot === 0) continue;
        let yy = y1 + rh;
        for (let k = 0; k < ROAR_NK; k++) {
            const v = BIN_KIND[b * ROAR_NK + k];
            if (v === 0) continue;
            const hh = rh * v / tot;
            yy -= hh;
            g.fillStyle = ROAR_COL[k];
            g.fillRect(geom.x + b * cw, yy, cw, hh);
        }
    }
    drawPath(g, geom, geom.w, geom.path, U, rh, () => 0, 1);
    if (m.size === 0) drawEmpty(g, geom);
}

/* ============================== the table ================================ */

export const RENDERERS = Object.freeze({
    sb: Object.freeze({
        fields: SB_FIELDS,
        model: (snap) => pick('sb', snap, SB_FIELDS),
        draw: sbDraw,
        path: sbPath,
    }),
    xft: Object.freeze({
        fields: XFT_FIELDS,
        model: (snap) => pick('xft', snap, XFT_FIELDS),
        draw: xftDraw,
        path: xftPath,
    }),
    yft: Object.freeze({
        fields: YFT_FIELDS,
        model: (snap) => pick('yft', snap, YFT_FIELDS),
        draw: yftDraw,
        path: yftPath,
    }),
    veb: Object.freeze({
        fields: VEB_FIELDS,
        model: (snap) => pick('veb', snap, VEB_FIELDS),
        draw: vebDraw,
        path: vebPath,
    }),
    roar: Object.freeze({
        fields: ROAR_FIELDS,
        model: (snap) => pick('roar', snap, ROAR_FIELDS),
        draw: roarDraw,
        path: roarPath,
    }),
});
