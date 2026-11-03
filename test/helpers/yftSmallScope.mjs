// yftSmallScope.mjs -- DB-2 exhaustive small-scope search for YFastTrie (test helper).
//
// Design. States are YFastTrie instances at a tiny universe (w = 4, K = 8, h = 2).
// BFS over op sequences; alphabet per step = add(k), delete(k) for every k in [0, U).
// Every state is reached by replaying its op path on a FRESH instance (no engine
// clone is trusted). Every transition checks the op's return value (add -> the
// instance, or RangeError iff a NEW key at size === capacity; delete -> was-present),
// size and (for no-op transitions) that the signature is byte-identical. Every NEW
// state (first visit of a signature) runs the full oracle (Set) check plus an
// independent invariant walker on dump(): reps ascending, reps[0] === 0, bucket keys
// ascending and in [rep_i, rep_{i+1}), head size 0..K, others h..K, union == oracle,
// inner XFastTrie key set == reps (has over the whole universe, size, min/max).
// A transition into an already-seen signature skips the full oracle + invariant check (the state is
// byte-identical, deterministic engine, so its behaviour is the same) but still runs the per-op
// return-value / size checks and the stored-oracle comparison below.
//
// Dedup signature (exact string of raw bytes, no lossy hash): the inner trie's typed
// arrays _lv _occ _tk _tmin _tmax _key _next _prev (raw, all bytes) and its scalars
// _size _free _sd; the outer _hd, _size, _bn (raw) and, per leaf, only the LIVE prefix
// _bk[f*K .. f*K+_bn[f]) (the bytes past _bn[f] are stale and are never read, so
// they cannot steer behaviour; including them would only split equal states). The
// counters _n and the scratch _q are EXCLUDED: _n is write-only telemetry, _q is
// overwritten at the start of every op. The universe/capacity/seed are per-run constants.
// A dedup hit also compares the ORACLE set stored with the signature, so an engine
// state reached with two different key sets (a lost or wrong update) is a violation.

export function makeOps(U, alphabet) {
    const ops = [];
    for (let k = 0; k < U; k++) {
        if (alphabet && !alphabet.includes(k)) continue;
        ops.push(k * 2); ops.push(k * 2 + 1); // even add, odd delete
    }
    return ops;
}

const BYTES = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('latin1');

export function signature(y) {
    const x = y._x;
    const K = y._k;
    const cr = y._bn.length;
    const live = new Uint32Array(cr * K);
    for (let f = 0; f < cr; f++) {
        for (let j = 0; j < y._bn[f]; j++) live[f * K + j] = y._bk[f * K + j];
    }
    return BYTES(x._lv) + '|' + BYTES(x._occ) + '|' + BYTES(x._tk) + '|' + BYTES(x._tmin) +
        '|' + BYTES(x._tmax) + '|' + BYTES(x._key) + '|' + BYTES(x._next) + '|' + BYTES(x._prev) +
        '|' + x._size + ',' + x._free + ',' + x._sd + '|' + y._hd + ',' + y._size + '|' +
        BYTES(y._bn) + '|' + BYTES(live);
}

function apply(y, set, op, U) {
    // returns a string describing a violation of the op contract, or null
    const k = op >> 1;
    if ((op & 1) === 0) {
        const isNew = !set.has(k);
        const full = isNew && set.size === y.capacity;
        let r;
        try { r = y.add(k); } catch (e) {
            if (full && e instanceof RangeError) return null;
            return 'add(' + k + ') threw ' + e;
        }
        if (full) return 'add(' + k + ') at full capacity did not throw';
        if (r !== y) return 'add(' + k + ') did not return this';
        set.add(k);
        if (y.size !== set.size) return 'add(' + k + ') size ' + y.size + ' != ' + set.size;
        return null;
    }
    const was = set.has(k);
    let r;
    try { r = y.delete(k); } catch (e) { return 'delete(' + k + ') threw ' + e; }
    if (r !== was) return 'delete(' + k + ') returned ' + r + ', expected ' + was;
    set.delete(k);
    if (y.size !== set.size) return 'delete(' + k + ') size ' + y.size + ' != ' + set.size;
    return null;
}

/** Full oracle + independent invariant walker. Returns a violation string or null. */
export function checkState(y, set, U) {
    const w = 32 - Math.clz32(U - 1), K = 2 * w, h = (w + 1) >> 1;
    if (y.bits !== w) return 'bits ' + y.bits + ' != ' + w;
    if (y.size !== set.size) return 'size ' + y.size + ' != ' + set.size;
    const sorted = [...set].sort((a, b) => a - b);
    for (let x = 0; x < U; x++) {
        if (y.has(x) !== set.has(x)) return 'has(' + x + ')';
        let s, p;
        for (let i = 0; i < sorted.length; i++) if (sorted[i] > x) { s = sorted[i]; break; }
        for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] < x) { p = sorted[i]; break; }
        if (y.successor(x) !== s) return 'successor(' + x + ') = ' + y.successor(x) + ', expected ' + s;
        if (y.predecessor(x) !== p) return 'predecessor(' + x + ') = ' + y.predecessor(x) + ', expected ' + p;
    }
    if (y.min() !== sorted[0]) return 'min ' + y.min() + ' != ' + sorted[0];
    if (y.max() !== sorted[sorted.length - 1]) return 'max ' + y.max() + ' != ' + sorted[sorted.length - 1];
    const d = y.dump();
    const reps = d.reps, sizes = d.sizes, keys = d.keys;
    if (reps.length === 0 || reps[0] !== 0) return 'reps[0] !== 0';
    for (let i = 1; i < reps.length; i++) if (!(reps[i] > reps[i - 1])) return 'reps not ascending';
    let q = 0, total = 0;
    for (let i = 0; i < reps.length; i++) {
        const lo = reps[i], hi = i + 1 < reps.length ? reps[i + 1] : U;
        const s = sizes[i];
        if (i === 0) { if (s > K) return 'head size ' + s; }
        else if (s < h || s > K) return 'bucket ' + i + ' size ' + s + ' outside [' + h + ',' + K + ']';
        for (let j = 0; j < s; j++, q++) {
            const key = keys[q];
            if (key < lo || key >= hi) return 'key ' + key + ' outside [' + lo + ',' + hi + ') of bucket ' + i;
            if (j > 0 && !(key > keys[q - 1])) return 'bucket ' + i + ' keys not ascending';
            if (!set.has(key)) return 'key ' + key + ' not in oracle';
        }
        total += s;
    }
    if (total !== set.size || q !== keys.length) return 'bucket union size ' + total + ' != ' + set.size;
    // inner XFastTrie key set == reps
    const x = y._x;
    if (x.size !== reps.length) return 'inner size ' + x.size + ' != reps ' + reps.length;
    const rs = new Set(reps);
    for (let v = 0; v < U; v++) if (x.has(v) !== rs.has(v)) return 'inner has(' + v + ')';
    if (x.max() !== reps[reps.length - 1] || x.min() !== 0) return 'inner min/max';
    return null;
}

/**
 * BFS. opts: { Cls, universe, capacity, seed, maxStates, maxDepth }.
 * Returns { violation, depth (levels fully expanded), closed, states, ops, split, merge,
 * borrow, fullHit, trace }.
 */
export function search(opts) {
    const { Cls, universe: U, capacity: C, seed } = opts;
    const maxStates = opts.maxStates ?? 1e9, maxDepth = opts.maxDepth ?? 1e9;
    const OPS = makeOps(U, opts.alphabet);
    const mk = () => new Cls(U, C, seed);
    const res = { violation: null, depth: 0, closed: false, states: 0, ops: 0, split: 0, merge: 0, borrow: 0, fullHit: 0, trace: null };
    const fail = (path, op, msg) => {
        res.violation = msg; res.trace = path.concat(op).map((o) => ((o & 1) ? 'del' : 'add') + (o >> 1)).join(' ');
        return res;
    };
    const seen = new Map(); const sk = (st) => [...st].sort((a, b) => a - b).join(',');
    const prefix = opts.prefix ?? [];
    const root = mk(); const rootSet = new Set();
    for (const op of prefix) {
        const m = apply(root, rootSet, op, U);
        if (m) return fail([], op, 'prefix: ' + m);
        const v = checkState(root, rootSet, U); // the oracle runs after every prefix op too
        if (v) return fail([], op, 'prefix: ' + v);
    }
    res.split = root._n[0]; res.merge = root._n[1]; res.borrow = root._n[2]; // events fired by the prefix
    seen.set(signature(root), sk(rootSet));
    res.states = 1;
    let frontier = [prefix.slice()];
    let depth = 0;
    const replay = (path) => {
        const y = mk(); const set = new Set();
        for (let i = 0; i < path.length; i++) { apply(y, set, path[i], U); res.ops++; }
        return [y, set];
    };
    let pBaseN = null;
    const tally = (y) => {
        // events fired by this transition = counters of the instance minus the parent's (same prefix)
        res.split += y._n[0] - pBaseN[0]; res.merge += y._n[1] - pBaseN[1]; res.borrow += y._n[2] - pBaseN[2];
    };
    while (frontier.length && depth < maxDepth && res.states < maxStates) {
        const next = [];
        for (const path of frontier) {
            const [pBase, pSet] = replay(path);
            const baseSig = signature(pBase);
            pBaseN = Int32Array.from(pBase._n);
            for (const op of OPS) {
                const k = op >> 1, isAdd = (op & 1) === 0;
                const noop = isAdd ? pSet.has(k) : !pSet.has(k);
                let y, set;
                if (noop) { y = pBase; set = new Set(pSet); } else { [y, set] = replay(path); }
                const full = isAdd && !pSet.has(k) && pSet.size === C;
                if (full) res.fullHit++;
                const sigBefore = noop || full ? baseSig : null;
                let msg;
                try { msg = apply(y, set, op, U); } catch (e) { msg = 'op threw ' + e; }
                res.ops++;
                if (msg) return fail(path, op, msg);
                if (noop || full) {
                    if (signature(y) !== sigBefore) return fail(path, op, 'no-op / full op changed the state');
                    continue;
                }
                tally(y);
                const sig = signature(y);
                if (seen.has(sig)) { if (seen.get(sig) !== sk(set)) return fail(path, op, 'engine state seen with oracle {' + seen.get(sig) + '}, now {' + sk(set) + '}'); continue; }
                let v;
                try { v = checkState(y, set, U); } catch (e) { v = 'checker threw ' + e; }
                if (v) return fail(path, op, v);
                seen.set(sig, sk(set));
                res.states++;
                next.push(path.concat(op));
            }
            if (res.states >= maxStates) break;
        }
        if (res.states >= maxStates && next.length) { res.depth = depth; return res; }
        depth++;
        res.depth = depth;
        frontier = next;
    }
    res.closed = frontier.length === 0;
    return res;
}
