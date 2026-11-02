/**
 * @zakkster/lite-loglogn -- vEBTree INDEPENDENT REFERENCE (0.5.0 G1-B1, PLAN-vebtree
 * task 1, C-1 / C-2 / C-3 / C-8 / C-10 / C-13 / C-16). Test helper, not a test file
 * (the npm glob `test/*.test.js` never matches it). Zero deps; imports nothing from
 * LogLogN.js, so it never shares a bug with the engine.
 *
 * VebRef(U) -- a textbook RECURSIVE van Emde Boas tree over [0, U), U an integer in
 * [2, 2^32] (C-8; RangeError otherwise):
 *   - leaf node (w <= 8, C-1): { leaf: true, w, f, n } -- f = Uint8Array(2^w) of 0 / 1
 *     flags (one byte per key, NOT the engine's packed words), n = flag count.
 *   - internal node (w >= 9, C-2): { leaf: false, w, lo, hi, min, max, summary,
 *     clusters } with lo = (w > 24 ? 16 : 8), hi = w - lo; min / max node-relative
 *     (-1 = empty); min is NOT stored in its cluster (C-3); summary (width hi) and
 *     clusters (width lo) are created lazily and dropped (set to null) when they
 *     empty, so the object graph is a function of the key set. The ROOT's cluster
 *     array is trimmed to ceil(U / 2^lo) (C-13); every other node holds 2^hi.
 *   - API mirrors YFastTrie's .d.ts (LogLogN.d.ts): has(x): boolean; add(x): this
 *     (idempotent, RangeError on a bad key, state untouched); delete(x): boolean
 *     (true if x was present, bad key -> false); successor / predecessor STRICT
 *     (> x / < x); min / max; absent = undefined; -0 aliases key 0; a bad key (not a
 *     number, not an integer in [0, U)) touches nothing: has / delete false,
 *     successor / predecessor undefined. size / universe / bits getters; clear().
 *   - One-mutation hooks (a must-fail control subclasses exactly one):
 *       _insEmpty(n, x)    -- add into an EMPTY internal node (min = max = x).
 *       _fixMax(n, x, j)   -- delete's max refresh at a node whose max was x.
 *       _rootClusterCount() -- the serializer's root cluster count (trimmed).
 *
 * checkRef(ref) -- invariant checker: null, or 'clause: detail' for the first broken
 *   clause: leafCount, shape, empty, range, minInCluster, minIsMin, max, emptyCluster,
 *   summary, summaryBit, size.
 *
 * Flat layout (cold, C-10 / C-13 / C-16), computed by this file's OWN offset
 * recursion -- serialize() returns a Uint32Array of exactly vebWordsU(U) words:
 *   leaf (w <= 8): ceil(2^w / 32) words (w <= 5 one word, 6 / 7 / 8 -> 2 / 4 / 8);
 *     key k = bit (k & 31) of word (k >>> 5); no header, no summary.
 *   internal (w >= 9) at base: [min, max] node-relative (EMPTY = [0xFFFFFFFF, 0]);
 *     the summary subtree (width hi) at base + 2; cluster j at
 *     base + 2 + S(hi) + j * S(lo). S(w) = 2 + S(hi) + 2^hi * S(lo) for w >= 9.
 *     Only the ROOT's cluster count is trimmed to ceil(U / 2^lo).
 * vebWords(w) -- S(w) (untrimmed); vebWordsU(U) -- the trimmed whole-tree words
 *   (pure arithmetic, never allocates: answers 2^28 / 2^32).
 * decodeFlat(words, U) -- reads a flat layout back (its own walk of the words):
 *   { keys } on success, { error: 'clause: detail' } on the first malformed node.
 */

export const EMPTY_MIN = 0xFFFFFFFF;
export const LEAF_MAX_W = 8;

/** w = ceil(log2 U) = 32 - clz32(U - 1), U in [2, 2^32]. */
export function bitsOf(U) {
    return 32 - Math.clz32(U - 1);
}

/** C-2: the low (cluster) width of an internal node of width w >= 9. */
export function splitLo(w) {
    return w > 24 ? 16 : 8;
}

/** Words of a leaf bitmap of width w <= 8. */
export function leafWords(w) {
    return Math.ceil(2 ** w / 32);
}

/** S(w): words of an UNTRIMMED node of width w (C-16). */
export function vebWords(w) {
    if (w <= LEAF_MAX_W) return leafWords(w);
    const lo = splitLo(w);
    const hi = w - lo;
    return 2 + vebWords(hi) + 2 ** hi * vebWords(lo);
}

/** Root cluster count of a universe U at width w >= 9 (C-13, trimmed). */
export function rootClusters(U, w) {
    return Math.ceil(U / 2 ** splitLo(w));
}

/** Whole-tree words for universe U, root trimmed (C-13). Arithmetic only. */
export function vebWordsU(U) {
    const w = bitsOf(U);
    if (w <= LEAF_MAX_W) return leafWords(w);
    const lo = splitLo(w);
    const hi = w - lo;
    return 2 + vebWords(hi) + rootClusters(U, w) * vebWords(lo);
}

function newNode(w, nc) {
    if (w <= LEAF_MAX_W) return { leaf: true, w, f: new Uint8Array(2 ** w), n: 0 };
    const lo = splitLo(w);
    const hi = w - lo;
    return {
        leaf: false, w, lo, hi, min: -1, max: -1, summary: null,
        clusters: new Array(nc === undefined ? 2 ** hi : nc).fill(null),
    };
}

function isEmpty(n) {
    return n === null || (n.leaf ? n.n === 0 : n.min === -1);
}

function nodeMin(n) {
    if (n === null) return -1;
    if (!n.leaf) return n.min;
    const f = n.f;
    for (let k = 0; k < f.length; k++) if (f[k] !== 0) return k;
    return -1;
}

function nodeMax(n) {
    if (n === null) return -1;
    if (!n.leaf) return n.max;
    const f = n.f;
    for (let k = f.length - 1; k >= 0; k--) if (f[k] !== 0) return k;
    return -1;
}

export class VebRef {
    constructor(universe) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 2 || universe > 4294967296) {
            throw new RangeError('[lite-loglogn] vEBTree universe must be an integer in [2, 2^32]; got ' +
                (typeof universe === 'number' ? String(universe) : typeof universe));
        }
        this._u = universe;
        this._w = bitsOf(universe);
        this._size = 0;
        this._root = this._newRoot();
    }
    get size() { return this._size; }
    get universe() { return this._u; }
    get bits() { return this._w; }

    _newRoot() {
        const w = this._w;
        return newNode(w, w <= LEAF_MAX_W ? undefined : rootClusters(this._u, w));
    }
    _ok(x) {
        return typeof x === 'number' && (x >>> 0) === x && x < this._u;
    }

    // --- recursion (node-relative keys) -------------------------------------------------

    _has(n, x) {
        if (n === null) return false;
        if (n.leaf) return n.f[x] !== 0;
        if (n.min === -1) return false;
        if (x === n.min || x === n.max) return true;
        return this._has(n.clusters[x >>> n.lo], x & (2 ** n.lo - 1));
    }

    /** Hook: add into an EMPTY internal node. */
    _insEmpty(n, x) {
        n.min = x;
        n.max = x;
    }

    /** x not present in n. */
    _ins(n, x) {
        if (n.leaf) {
            n.f[x] = 1;
            n.n++;
            return;
        }
        if (n.min === -1) {
            this._insEmpty(n, x);
            return;
        }
        if (x < n.min) {
            const t = n.min;
            n.min = x;
            x = t;
        }
        if (x > n.max) n.max = x;
        this._insCluster(n, x);
    }

    /** Puts x (not n.min) into its cluster; enters the summary only if the cluster was empty. */
    _insCluster(n, x) {
        const j = x >>> n.lo;
        const xl = x & (2 ** n.lo - 1);
        let c = n.clusters[j];
        if (c === null) {
            c = newNode(n.lo);
            n.clusters[j] = c;
        }
        if (isEmpty(c)) {
            if (n.summary === null) n.summary = newNode(n.hi);
            this._ins(n.summary, j);
        }
        this._ins(c, xl);
    }

    /** Hook: refresh n.max after x (which was n.max) left cluster j. */
    _fixMax(n, x, j) {
        const c = n.clusters[j];
        if (c !== null) {
            n.max = j * 2 ** n.lo + nodeMax(c);
            return;
        }
        const sm = nodeMax(n.summary);
        n.max = sm === -1 ? n.min : sm * 2 ** n.lo + nodeMax(n.clusters[sm]);
    }

    /** x present in n. */
    _del(n, x) {
        if (n.leaf) {
            n.f[x] = 0;
            n.n--;
            return;
        }
        if (n.min === n.max) {
            n.min = -1;
            n.max = -1;
            return;
        }
        if (x === n.min) {
            const j0 = nodeMin(n.summary);
            x = j0 * 2 ** n.lo + nodeMin(n.clusters[j0]);
            n.min = x;
        }
        const j = x >>> n.lo;
        const xl = x & (2 ** n.lo - 1);
        const c = n.clusters[j];
        this._del(c, xl);
        if (isEmpty(c)) {
            n.clusters[j] = null;
            this._del(n.summary, j);
            if (isEmpty(n.summary)) n.summary = null;
        }
        if (x === n.max) this._fixMax(n, x, j);
    }

    _succ(n, x) {
        if (n === null) return -1;
        if (n.leaf) {
            const f = n.f;
            for (let k = x + 1; k < f.length; k++) if (f[k] !== 0) return k;
            return -1;
        }
        if (n.min === -1) return -1;
        if (x < n.min) return n.min;
        const P = 2 ** n.lo;
        const j = x >>> n.lo;
        const xl = x & (P - 1);
        const c = j < n.clusters.length ? n.clusters[j] : null;
        const cmax = nodeMax(c);
        if (cmax !== -1 && xl < cmax) return j * P + this._succ(c, xl);
        const sj = this._succ(n.summary, j);
        if (sj === -1) return -1;
        return sj * P + nodeMin(n.clusters[sj]);
    }

    _pred(n, x) {
        if (n === null) return -1;
        if (n.leaf) {
            const f = n.f;
            for (let k = x - 1; k >= 0; k--) if (f[k] !== 0) return k;
            return -1;
        }
        if (n.min === -1) return -1;
        if (x > n.max) return n.max;
        const P = 2 ** n.lo;
        const j = x >>> n.lo;
        const xl = x & (P - 1);
        const c = j < n.clusters.length ? n.clusters[j] : null;
        const cmin = nodeMin(c);
        if (cmin !== -1 && xl > cmin) return j * P + this._pred(c, xl);
        const pj = this._pred(n.summary, j);
        if (pj === -1) return x > n.min ? n.min : -1;
        return pj * P + nodeMax(n.clusters[pj]);
    }

    // --- public API -----------------------------------------------------------------

    has(x) {
        if (!this._ok(x)) return false;
        return this._has(this._root, x >>> 0);
    }
    add(x) {
        if (!this._ok(x)) {
            throw new RangeError('[lite-loglogn] key must be an integer in [0, ' + this._u + '); got ' +
                (typeof x === 'number' ? String(x) : typeof x));
        }
        const v = x >>> 0;
        if (this._has(this._root, v)) return this;
        this._ins(this._root, v);
        this._size++;
        return this;
    }
    delete(x) {
        if (!this._ok(x)) return false;
        const v = x >>> 0;
        if (!this._has(this._root, v)) return false;
        this._del(this._root, v);
        this._size--;
        return true;
    }
    successor(x) {
        if (!this._ok(x)) return undefined;
        const r = this._succ(this._root, x >>> 0);
        return r === -1 ? undefined : r;
    }
    predecessor(x) {
        if (!this._ok(x)) return undefined;
        const r = this._pred(this._root, x >>> 0);
        return r === -1 ? undefined : r;
    }
    min() {
        const r = nodeMin(this._root);
        return r === -1 ? undefined : r;
    }
    max() {
        const r = nodeMax(this._root);
        return r === -1 ? undefined : r;
    }
    clear() {
        this._root = this._newRoot();
        this._size = 0;
    }

    // --- cold: flat layout --------------------------------------------------------------

    /** Hook: the serializer's root cluster count (C-13: trimmed). */
    _rootClusterCount() {
        return rootClusters(this._u, this._w);
    }

    /** Words of serialize() (root trimmed through the hook). */
    words() {
        const w = this._w;
        if (w <= LEAF_MAX_W) return leafWords(w);
        const lo = splitLo(w);
        return 2 + vebWords(w - lo) + this._rootClusterCount() * vebWords(lo);
    }

    /** The flat C-10 / C-13 layout as a fresh Uint32Array (cold; allocates). */
    serialize() {
        const out = new Uint32Array(this.words());
        this._ser(this._root, this._w, out, 0, true);
        return out;
    }

    _ser(n, w, out, base, isRoot) {
        if (w <= LEAF_MAX_W) {
            if (n === null) return;
            const f = n.f;
            for (let k = 0; k < f.length; k++) {
                if (f[k] !== 0) out[base + (k >>> 5)] |= 1 << (k & 31);
            }
            return;
        }
        const lo = splitLo(w);
        const hi = w - lo;
        if (n === null || n.min === -1) {
            out[base] = EMPTY_MIN;
            out[base + 1] = 0;
        } else {
            out[base] = n.min;
            out[base + 1] = n.max;
        }
        this._ser(n === null ? null : n.summary, hi, out, base + 2, false);
        const cBase = base + 2 + vebWords(hi);
        const stride = vebWords(lo);
        const nc = isRoot ? this._rootClusterCount() : 2 ** hi;
        for (let j = 0; j < nc; j++) {
            const c = n === null ? null : (j < n.clusters.length ? n.clusters[j] : null);
            this._ser(c, lo, out, cBase + j * stride, false);
        }
    }

    /** Sorted keys by recursion (min, then cluster keys) -- used by checkers. */
    keys() {
        const out = [];
        collectKeys(this._root, 0, out);
        return out.sort((a, b) => a - b);
    }
}

function collectKeys(n, prefix, out) {
    if (n === null) return;
    if (n.leaf) {
        for (let k = 0; k < n.f.length; k++) if (n.f[k] !== 0) out.push(prefix + k);
        return;
    }
    if (n.min === -1) return;
    out.push(prefix + n.min);
    const P = 2 ** n.lo;
    for (let j = 0; j < n.clusters.length; j++) collectKeys(n.clusters[j], prefix + j * P, out);
}

// --- invariant checker -------------------------------------------------------------------

/** null, or 'clause: detail' for the first broken invariant of ref. */
export function checkRef(ref) {
    const w = ref._w;
    const nc = w <= LEAF_MAX_W ? undefined : rootClusters(ref._u, w);
    const r = checkNode(ref, ref._root, w, nc, 'root');
    if (typeof r === 'string') return r;
    if (r !== ref._size) return 'size: counted ' + r + ', size ' + ref._size;
    const mx = ref.max();
    if (mx !== undefined && !(mx < ref._u)) return 'range: max ' + mx + ' >= U ' + ref._u;
    return null;
}

/** Key count of n, or a 'clause: detail' string. */
function checkNode(ref, n, w, nc, path) {
    if (n === null) return 0;
    if (n.w !== w) return 'shape: ' + path + ' w ' + n.w + ' != ' + w;
    if (n.leaf) {
        if (!(w <= LEAF_MAX_W) || n.f.length !== 2 ** w) return 'shape: ' + path + ' leaf';
        let cnt = 0;
        for (let k = 0; k < n.f.length; k++) {
            if (n.f[k] !== 0 && n.f[k] !== 1) return 'leafCount: ' + path + ' flag ' + k + ' = ' + n.f[k];
            cnt += n.f[k];
        }
        if (cnt !== n.n) return 'leafCount: ' + path + ' n ' + n.n + ' != ' + cnt;
        return cnt;
    }
    const lo = splitLo(w);
    const hi = w - lo;
    const want = nc === undefined ? 2 ** hi : nc;
    if (n.lo !== lo || n.hi !== hi || n.clusters.length !== want) {
        return 'shape: ' + path + ' lo/hi/clusters ' + n.lo + '/' + n.hi + '/' + n.clusters.length;
    }
    if (n.min === -1) {
        if (n.max !== -1) return 'empty: ' + path + ' min -1, max ' + n.max;
        if (n.summary !== null) return 'empty: ' + path + ' empty node holds a summary';
        for (let j = 0; j < want; j++) {
            if (n.clusters[j] !== null) return 'empty: ' + path + ' empty node holds cluster ' + j;
        }
        return 0;
    }
    const P = 2 ** lo;
    if (!(Number.isInteger(n.min) && Number.isInteger(n.max) && n.min >= 0 && n.min <= n.max &&
        n.max < 2 ** w)) {
        return 'range: ' + path + ' [' + n.min + ', ' + n.max + ']';
    }
    let total = 1;
    let lastKey = -1;
    for (let j = 0; j < want; j++) {
        const c = n.clusters[j];
        if (c === null) continue;
        if (isEmpty(c)) return 'emptyCluster: ' + path + ' cluster ' + j + ' is empty but kept';
        const cp = path + '.c' + j;
        const r = checkNode(ref, c, lo, undefined, cp);
        if (typeof r === 'string') return r;
        total += r;
        const cmin = j * P + nodeMin(c);
        if (j === (n.min >>> lo) && ref._has(c, n.min & (P - 1))) {
            return 'minInCluster: ' + path + ' min ' + n.min + ' found in cluster ' + j;
        }
        if (!(cmin > n.min)) return 'minIsMin: ' + path + ' cluster ' + j + ' key ' + cmin + ' <= min ' + n.min;
        lastKey = j * P + nodeMax(c);
    }
    const wantMax = lastKey === -1 ? n.min : lastKey;
    if (n.max !== wantMax) return 'max: ' + path + ' max ' + n.max + ', largest key ' + wantMax;
    const anyCluster = lastKey !== -1;
    if (anyCluster !== (n.summary !== null)) {
        return 'summary: ' + path + (anyCluster ? ' clusters but no summary' : ' summary but no cluster');
    }
    if (n.summary !== null) {
        if (isEmpty(n.summary)) return 'summary: ' + path + ' empty summary kept';
        const r = checkNode(ref, n.summary, hi, undefined, path + '.s');
        if (typeof r === 'string') return r;
        if (!(nodeMax(n.summary) < want)) return 'summaryBit: ' + path + ' summary max ' + nodeMax(n.summary);
        for (let j = 0; j < want; j++) {
            if ((n.clusters[j] !== null) !== ref._has(n.summary, j)) {
                return 'summaryBit: ' + path + ' bit ' + j + ' vs cluster ' + (n.clusters[j] !== null);
            }
        }
    }
    return total;
}

// --- flat decoder ---------------------------------------------------------------------------

/** Reads a flat layout of universe U back: { keys } or { error }. */
export function decodeFlat(words, U) {
    const w = bitsOf(U);
    if (words.length !== vebWordsU(U)) return { error: 'length: ' + words.length + ' != ' + vebWordsU(U) };
    const keys = [];
    const err = decNode(words, 0, w, w <= LEAF_MAX_W ? 0 : rootClusters(U, w), 0, keys, 'root');
    if (err !== null) return { error: err };
    keys.sort((a, b) => a - b);
    if (keys.length > 0 && !(keys[keys.length - 1] < U)) return { error: 'range: key >= U' };
    return { keys };
}

/** Appends the keys of the node at base (prefix added); null or an error. */
function decNode(t, base, w, nc, prefix, out, path) {
    if (w <= LEAF_MAX_W) {
        const nw = leafWords(w);
        const nk = 2 ** w;
        for (let i = 0; i < nw; i++) {
            const v = t[base + i];
            if (v === 0) continue;
            for (let b = 0; b < 32; b++) {
                if ((v >>> b) & 1) {
                    const k = i * 32 + b;
                    if (!(k < nk)) return 'leafBits: ' + path + ' bit ' + k + ' >= 2^' + w;
                    out.push(prefix + k);
                }
            }
        }
        return null;
    }
    const lo = splitLo(w);
    const hi = w - lo;
    const cnt = nc === 0 ? 2 ** hi : nc;
    const mn = t[base];
    const mx = t[base + 1];
    const sKeys = [];
    const err0 = decNode(t, base + 2, hi, 0, 0, sKeys, path + '.s');
    if (err0 !== null) return err0;
    const cBase = base + 2 + vebWords(hi);
    const stride = vebWords(lo);
    const P = 2 ** lo;
    const nonEmpty = [];
    const sub = [];
    for (let j = 0; j < cnt; j++) {
        const ck = [];
        const e = decNode(t, cBase + j * stride, lo, 0, 0, ck, path + '.c' + j);
        if (e !== null) return e;
        if (ck.length > 0) {
            nonEmpty.push(j);
            for (const k of ck) sub.push(j * P + k);
        }
    }
    if (mn > mx) {
        if (mn !== EMPTY_MIN || mx !== 0) return 'emptyEncoding: ' + path + ' [' + mn + ', ' + mx + ']';
        if (sKeys.length !== 0 || sub.length !== 0) return 'empty: ' + path + ' empty header over keys';
        return null;
    }
    if (!(mx < 2 ** w)) return 'range: ' + path + ' max ' + mx;
    sKeys.sort((a, b) => a - b);
    if (sKeys.join(',') !== nonEmpty.join(',')) return 'summaryBit: ' + path;
    sub.sort((a, b) => a - b);
    if (sub.length > 0 && !(sub[0] > mn)) return 'minInCluster: ' + path + ' min ' + mn;
    const wantMax = sub.length > 0 ? sub[sub.length - 1] : mn;
    if (mx !== wantMax) return 'max: ' + path + ' ' + mx + ' != ' + wantMax;
    out.push(prefix + mn);
    for (const k of sub) out.push(prefix + k);
    return null;
}
