// test/helpers/vebSketch.mjs -- VERBATIM copy of the research sketch, used ONLY as a second
// ANSWER oracle (U <= 2^24) by test/VebRef.test.js. It is a DIFFERENT layout (one Int32Array,
// balanced split, leaf w <= 6, empty = -1), never a layout oracle. Nothing below the marker
// line is edited: the tail is the source byte for byte (VebRef.test.js re-hashes it).
// source: .handoff/research/veb-sketch.mjs (gitignored; nothing imports from .handoff/)
// source sha256: 17a337d4b517f9b9bcb049e571b2b651e7653084deedcd9a7acc0220cadef907 (17301 bytes), copied 2026-11-02 (G1-B1).
// ---- verbatim source below ----
export function throwKey(x, u) {
    throw new RangeError('[lite-loglogn] key must be an integer in [0, ' + u + '); got ' +
        (typeof x === 'number' ? String(x) : typeof x));
}

// Precomputed node sizes in Int32 words for bit-widths w = 1..24 (or up to 32):
// - w <= 5: 1 Int32 word (inlined FastBit32 leaf, 0 header words)
// - w === 6: 2 Int32 words (inlined 64-bit dual-word leaf, 0 header words)
// - w >= 7: 2 (min, max) + VEB_SIZE[ceil(w/2)] + (1 << ceil(w/2)) * VEB_SIZE[floor(w/2)]
const VEB_SIZE = new Int32Array(25);
for (let w = 1; w <= 24; w++) {
    if (w <= 5) VEB_SIZE[w] = 1;
    else if (w === 6) VEB_SIZE[w] = 2;
    else {
        const hi = (w + 1) >> 1;
        const lo = w >> 1;
        VEB_SIZE[w] = 2 + VEB_SIZE[hi] + (1 << hi) * VEB_SIZE[lo];
    }
}

/**
 * vEBTree -- flattened, non-recursive van Emde Boas tree in ONE flat Int32Array,
 * keeping worst-case O(log log U) and 0 B/op over a FIXED universe [0, U),
 * 2 <= U <= 2^24.
 *
 * Design-parity integration with @zakkster/lite-fastbit32 (zero runtime deps):
 * - Internal nodes (w >= 7) store [min, max] at (base, base + 1) with the
 *   classic "min not stored in its cluster" invariant (empty = -1), followed
 *   contiguously by the summary (width ceil(w/2)) and 2^ceil(w/2) clusters
 *   (each of width floor(w/2)).
 * - Leaf nodes (w <= 5) are a SINGLE Int32 bitmask word (FastBit32 parity);
 *   w === 6 leaves are TWO Int32 bitmask words (64-bit bitmap). Because leaf
 *   words answer min, max, emptiness, and singleton tests in O(1) via
 *   `31 - Math.clz32(...)`, leaves store NO min/max header and NO summary,
 *   shrinking U = 2^16 to 19.08 KiB, U = 2^20 to 140.14 KiB, and U = 2^24 to
 *   2.06 MiB while empty.
 */
export class vEBTree {
    /** @param {number} universe integer in [2, 2^24] */
    constructor(universe) {
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 2 || universe > 16777216) {
            throw new RangeError('[lite-loglogn] vEBTree universe must be an integer in [2, 2^24]; got ' +
                (typeof universe === 'number' ? String(universe) : typeof universe));
        }
        const w = 32 - Math.clz32(universe - 1);
        const totalWords = VEB_SIZE[w];
        const tree = new Int32Array(totalWords);
        this._u = universe;
        this._w = w;
        this._size = 0;
        this._tree = tree;
        // Preallocated 4-level upward fixup stack for iterative delete (4 frames x 4 ints = 16 ints)
        this._path = new Int32Array(16);
        this._initNode(0, w);
    }

    /** Number of keys present. */
    get size() { return this._size; }

    /** The fixed universe U (keys are integers in [0, U)). */
    get universe() { return this._u; }

    /** Key bit-width w = ceil(log2 U). */
    get bits() { return this._w; }

    /** Bytes held by the backing store (`_path` included). */
    get byteLength() { return this._tree.byteLength + this._path.byteLength; }

    /** Cold. Initializes internal node headers [min, max] = -1 and leaf words = 0. */
    _initNode(base, w) {
        const t = this._tree;
        if (w <= 5) { t[base] = 0; return; }
        if (w === 6) { t[base] = 0; t[base + 1] = 0; return; }
        t[base] = -1;
        t[base + 1] = -1;
        const hi = (w + 1) >> 1;
        const lo = w >> 1;
        const sBase = base + 2;
        this._initNode(sBase, hi);
        const cBase = sBase + VEB_SIZE[hi];
        const stride = VEB_SIZE[lo];
        const nClusters = 1 << hi;
        for (let i = 0; i < nClusters; i++) {
            this._initNode(cBase + i * stride, lo);
        }
    }

    // ---- Inlined FastBit32 (w <= 5) & Dual-Word (w === 6) Leaf Primitives ----

    _leafHas(base, w, x) {
        const t = this._tree;
        if (w <= 5) return (t[base] & (1 << x)) !== 0;
        return (t[base + (x >>> 5)] & (1 << (x & 31))) !== 0;
    }

    _leafMin(base, w) {
        const t = this._tree;
        const v0 = t[base];
        if (w <= 5) return 31 - Math.clz32(v0 & -v0);
        if (v0 !== 0) return 31 - Math.clz32(v0 & -v0);
        const v1 = t[base + 1];
        return v1 !== 0 ? 32 + (31 - Math.clz32(v1 & -v1)) : -1;
    }

    _leafMax(base, w) {
        const t = this._tree;
        if (w <= 5) return 31 - Math.clz32(t[base]);
        const v1 = t[base + 1];
        if (v1 !== 0) return 32 + (31 - Math.clz32(v1));
        const v0 = t[base];
        return 31 - Math.clz32(v0);
    }

    _leafSucc(base, w, x) {
        const i = x + 1;
        if (i >= (1 << w)) return -1;
        const t = this._tree;
        if (w <= 5) {
            const v = t[base] & (-1 << i);
            return 31 - Math.clz32(v & -v);
        }
        if (i < 32) {
            const v0 = t[base] & (-1 << i);
            if (v0 !== 0) return 31 - Math.clz32(v0 & -v0);
            const v1 = t[base + 1];
            return v1 !== 0 ? 32 + (31 - Math.clz32(v1 & -v1)) : -1;
        }
        const v1 = t[base + 1] & (-1 << (i - 32));
        return v1 !== 0 ? 32 + (31 - Math.clz32(v1 & -v1)) : -1;
    }

    _leafPred(base, w, x) {
        if (x <= 0) return -1;
        const i = x - 1;
        const t = this._tree;
        if (w <= 5) {
            const v = t[base] & ~(-2 << i);
            return 31 - Math.clz32(v);
        }
        if (i >= 32) {
            const v1 = t[base + 1] & ~(-2 << (i - 32));
            if (v1 !== 0) return 32 + (31 - Math.clz32(v1));
            const v0 = t[base];
            return 31 - Math.clz32(v0);
        }
        const v0 = t[base] & ~(-2 << i);
        return 31 - Math.clz32(v0);
    }

    /** Read min of any node (internal or leaf) in O(1). Returns -1 if empty. */
    _nodeMin(base, w) {
        return w <= 6 ? this._leafMin(base, w) : this._tree[base];
    }

    /** Read max of any node (internal or leaf) in O(1). Returns -1 if empty. */
    _nodeMax(base, w) {
        return w <= 6 ? this._leafMax(base, w) : this._tree[base + 1];
    }

    // ---- Public Hot API (0 B/op, Iterative Worst-Case O(log log U)) ----------

    /** @param {number} x @returns {boolean} */
    has(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return false;
        const t = this._tree;
        let base = 0;
        let w = this._w;
        while (w > 6) {
            const mn = t[base];
            if (mn === -1) return false;
            if (x === mn || x === t[base + 1]) return true;
            const hi = (w + 1) >> 1;
            const lo = w >> 1;
            const i = x >>> lo;
            x &= (1 << lo) - 1;
            base = base + 2 + VEB_SIZE[hi] + Math.imul(i, VEB_SIZE[lo]);
            w = lo;
        }
        return this._leafHas(base, w, x);
    }

    /** Smallest key, or undefined if empty. @returns {number|undefined} */
    min() {
        const mn = this._nodeMin(0, this._w);
        return mn === -1 ? undefined : mn;
    }

    /** Largest key, or undefined if empty. @returns {number|undefined} */
    max() {
        const mx = this._nodeMax(0, this._w);
        return mx === -1 ? undefined : mx;
    }

    /** @param {number} x @returns {this} */
    add(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) throwKey(x, this._u);
        if (this.has(x)) return this;
        this._size++;
        const t = this._tree;
        let base = 0;
        let w = this._w;
        while (w > 6) {
            let mn = t[base];
            if (mn === -1) {
                t[base] = x;
                t[base + 1] = x;
                return this;
            }
            if (x < mn) {
                t[base] = x;
                x = mn;
            }
            if (x > t[base + 1]) t[base + 1] = x;

            const hi = (w + 1) >> 1;
            const lo = w >> 1;
            const i = x >>> lo;
            const xl = x & ((1 << lo) - 1);
            const sBase = base + 2;
            const cBase = sBase + VEB_SIZE[hi] + Math.imul(i, VEB_SIZE[lo]);

            if (lo <= 6) {
                // Target cluster is a leaf bitmap: O(1) bit set; recurse into summary iff leaf was empty
                const wasEmpty = lo <= 5 ? (t[cBase] === 0) : ((t[cBase] | t[cBase + 1]) === 0);
                if (lo <= 5) t[cBase] |= (1 << xl);
                else t[cBase + (xl >>> 5)] |= (1 << (xl & 31));
                if (!wasEmpty) return this;
                base = sBase;
                w = hi;
                x = i;
            } else if (t[cBase] === -1) {
                // Target internal cluster is empty: O(1) singleton init, recurse into summary ONLY
                t[cBase] = xl;
                t[cBase + 1] = xl;
                base = sBase;
                w = hi;
                x = i;
            } else {
                // Target internal cluster already non-empty: descend into cluster ONLY
                base = cBase;
                w = lo;
                x = xl;
            }
        }
        if (w <= 5) t[base] |= (1 << x);
        else t[base + (x >>> 5)] |= (1 << (x & 31));
        return this;
    }

    /** @param {number} x @returns {boolean} true if x was present */
    delete(x) {
        if (!this.has(x)) return false;
        this._size--;
        const t = this._tree;
        const path = this._path;
        let top = 0;
        let base = 0;
        let w = this._w;

        while (w > 6) {
            let mn = t[base];
            let mx = t[base + 1];
            if (mn === mx) {
                t[base] = -1;
                t[base + 1] = -1;
                break;
            }
            const hi = (w + 1) >> 1;
            const lo = w >> 1;
            const sBase = base + 2;
            const cStart = sBase + VEB_SIZE[hi];
            const stride = VEB_SIZE[lo];

            if (x === mn) {
                const firstCluster = this._nodeMin(sBase, hi);
                const cFirstBase = cStart + Math.imul(firstCluster, stride);
                x = (firstCluster << lo) | this._nodeMin(cFirstBase, lo);
                t[base] = x;
            }
            const i = x >>> lo;
            const xl = x & ((1 << lo) - 1);
            const cBase = cStart + Math.imul(i, stride);

            // Check if cluster C is a singleton BEFORE descending
            let isSingleton = false;
            if (lo <= 5) {
                const v = t[cBase];
                isSingleton = (v & (v - 1)) === 0;
            } else if (lo === 6) {
                const v0 = t[cBase], v1 = t[cBase + 1];
                isSingleton = v0 === 0 ? ((v1 & (v1 - 1)) === 0) : (v1 === 0 && (v0 & (v0 - 1)) === 0);
            } else {
                isSingleton = t[cBase] === t[cBase + 1];
            }

            // Record frame for O(1) upward max restoration
            path[top] = base;
            path[top + 1] = w;
            path[top + 2] = i;
            path[top + 3] = isSingleton ? 1 : (x === mx ? 2 : 0);
            top += 4;

            if (isSingleton) {
                // Clear singleton cluster in O(1) and pivot to summary (1 path!)
                if (lo <= 5) t[cBase] = 0;
                else if (lo === 6) { t[cBase] = 0; t[cBase + 1] = 0; }
                else { t[cBase] = -1; t[cBase + 1] = -1; }
                base = sBase;
                w = hi;
                x = i;
            } else {
                // Cluster stays non-empty; summary untouched, descend into cluster (1 path!)
                base = cBase;
                w = lo;
                x = xl;
            }
        }

        if (w <= 5) t[base] &= ~(1 << x);
        else if (w === 6) t[base + (x >>> 5)] &= ~(1 << (x & 31));

        // Walk the <= 3 recorded frames upward to refresh .max in O(1) per frame
        while (top > 0) {
            top -= 4;
            const pBase = path[top];
            const pw = path[top + 1];
            const pi = path[top + 2];
            const mode = path[top + 3];
            if (mode === 0) continue;
            const hi = (pw + 1) >> 1;
            const lo = pw >> 1;
            const sBase = pBase + 2;
            const cStart = sBase + VEB_SIZE[hi];
            const stride = VEB_SIZE[lo];
            if (mode === 1) {
                const summaryMax = this._nodeMax(sBase, hi);
                if (summaryMax === -1) {
                    t[pBase + 1] = t[pBase];
                } else {
                    const cMaxBase = cStart + Math.imul(summaryMax, stride);
                    t[pBase + 1] = (summaryMax << lo) | this._nodeMax(cMaxBase, lo);
                }
            } else {
                const cBase = cStart + Math.imul(pi, stride);
                t[pBase + 1] = (pi << lo) | this._nodeMax(cBase, lo);
            }
        }
        return true;
    }

    /** Smallest key > x, or undefined. @param {number} x @returns {number|undefined} */
    successor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        const t = this._tree;
        let base = 0;
        let w = this._w;
        let prefix = 0;
        let shift = 0;

        while (w > 6) {
            const mn = t[base];
            if (mn === -1 || x >= t[base + 1]) return undefined;
            if (x < mn) return (prefix | mn) >>> 0;

            const hi = (w + 1) >> 1;
            const lo = w >> 1;
            const i = x >>> lo;
            const xl = x & ((1 << lo) - 1);
            const sBase = base + 2;
            const cStart = sBase + VEB_SIZE[hi];
            const stride = VEB_SIZE[lo];
            const cBase = cStart + Math.imul(i, stride);
            const cMax = this._nodeMax(cBase, lo);

            if (cMax !== -1 && xl < cMax) {
                // Case A: Successor is inside cluster i; descend into cluster i
                prefix |= (i << (shift + lo));
                base = cBase;
                w = lo;
                x = xl;
            } else {
                // Case B: Successor is in the next non-empty cluster; query summary
                const nextCluster = this._succFrom(sBase, hi, i);
                if (nextCluster === -1) return undefined;
                const nextCBase = cStart + Math.imul(nextCluster, stride);
                const nextMin = this._nodeMin(nextCBase, lo);
                return (prefix | ((nextCluster << lo) | nextMin) << shift) >>> 0;
            }
        }
        const s = this._leafSucc(base, w, x);
        return s === -1 ? undefined : (prefix | (s << shift)) >>> 0;
    }

    /** Internal helper: successor of x within subtree (base, w), returning -1 on miss. */
    _succFrom(base, w, x) {
        const t = this._tree;
        let prefix = 0;
        while (w > 6) {
            const mn = t[base];
            if (mn === -1 || x >= t[base + 1]) return -1;
            if (x < mn) return prefix | mn;

            const hi = (w + 1) >> 1;
            const lo = w >> 1;
            const i = x >>> lo;
            const xl = x & ((1 << lo) - 1);
            const sBase = base + 2;
            const cStart = sBase + VEB_SIZE[hi];
            const stride = VEB_SIZE[lo];
            const cBase = cStart + Math.imul(i, stride);
            const cMax = this._nodeMax(cBase, lo);

            if (cMax !== -1 && xl < cMax) {
                prefix |= (i << lo);
                base = cBase;
                w = lo;
                x = xl;
            } else {
                const nextCluster = this._succFrom(sBase, hi, i);
                if (nextCluster === -1) return -1;
                const nextCBase = cStart + Math.imul(nextCluster, stride);
                return prefix | (nextCluster << lo) | this._nodeMin(nextCBase, lo);
            }
        }
        const s = this._leafSucc(base, w, x);
        return s === -1 ? -1 : (prefix | s);
    }

    /** Largest key < x, or undefined. @param {number} x @returns {number|undefined} */
    predecessor(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._u) return undefined;
        const r = this._predFrom(0, this._w, x);
        return r === -1 ? undefined : r >>> 0;
    }

    /** Internal helper: predecessor of x within subtree (base, w), returning -1 on miss. */
    _predFrom(base, w, x) {
        const t = this._tree;
        if (w > 6) {
            const mn = t[base];
            if (mn === -1 || x <= mn) return -1;
            const mx = t[base + 1];
            if (x > mx) return mx;

            const hi = (w + 1) >> 1;
            const lo = w >> 1;
            const i = x >>> lo;
            const xl = x & ((1 << lo) - 1);
            const sBase = base + 2;
            const cStart = sBase + VEB_SIZE[hi];
            const stride = VEB_SIZE[lo];
            const cBase = cStart + Math.imul(i, stride);
            const cMin = this._nodeMin(cBase, lo);

            if (cMin !== -1 && xl > cMin) {
                return (i << lo) | this._predFrom(cBase, lo, xl);
            }
            const prevCluster = this._predFrom(sBase, hi, i);
            if (prevCluster === -1) return mn; // Remember: node.min is NOT in any cluster!
            const prevCBase = cStart + Math.imul(prevCluster, stride);
            return (prevCluster << lo) | this._nodeMax(prevCBase, lo);
        }
        return this._leafPred(base, w, x);
    }

    /** Cold. Removes every key. */
    clear() {
        this._initNode(0, this._w);
        this._size = 0;
    }
}
