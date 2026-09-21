/**
 * @zakkster/lite-loglogn -- the O(log log U) Witness harness.
 *
 *     node test/witness.mjs
 *
 * The family anchor. lite-o1 proves a FLAT ops/ms line on a log-x axis (the
 * constant); lite-logn proves a STRAIGHT line vs log2(n) (one added level per
 * doubling of n); lite-loglogn proves a straight, nearly-flat line vs
 *
 *     nsPerOp = intercept + slope * log2(w)     (w = universe BIT-WIDTH)
 *
 * -- one constant additive step per doubling of the universe bit-width, the
 * double-logarithm made visible. This is the #1 thing that makes this harness
 * NOT its lite-logn sibling: the fit axis is log2(w) (the universe bit-width),
 * NEVER a copied log2(n). Conflating log log U with log log n is the dishonesty
 * this family refuses.
 *
 * Two sweeps, per RESEARCH.md section 2 / ROADMAP section 5.2:
 *
 *   - U-SWEEP double-log FIT, BOTH axes. Hold n fixed, sweep U = 2^16 .. 2^32;
 *     fit vs log2(w) AND vs w (the O(log U) impostor axis). Assert the log2(w)
 *     fit WINS (higher R^2) -- this catches a mislabeled bound (an x-fast UPDATE
 *     path that is really O(log U)). R^2 >= floor + slope in band on the winner.
 *   - n-SWEEP CROSSOVER vs the O(log n) foil. Hold U at 32 bits, sweep
 *     n = 1e3 .. 1e7; the member stays flat while a lite-logn O(log n) member
 *     (the foil) climbs and is overtaken. Report the crossover n as a fact.
 *
 * v0.1.0 is the SCAFFOLD release: the fit machinery (least-squares log-linear
 * R^2 + slope, on EITHER axis) and a reference O(log n) foil are in place, but
 * there is NO member to fit, so the harness runs GREEN and EMPTY and gates
 * NOTHING. The R^2 floor + slope band are DELIBERATELY not set here: they are
 * calibrated empirically in the StratifiedBitset session (decision D-04 /
 * decisions/0004-witness.md) and become the shared FAMILY gate every later
 * member inherits -- and that session also settles which sweep is the HARD gate
 * (lean: the n-sweep crossover) vs reported (the U-sweep double-log fit). This is
 * an OFFLINE proof tool, never a hot-path dependency.
 */

// --- least-squares fit: y = intercept + slope * x --------------------------
// x is the chosen axis (log2(w) for the winning fit, or w for the impostor
// axis, or log2(n) for the foil); y is nsPerOp. Returns { slope, intercept, r2 }.
// Pure, alloc-light (StratifiedBitset calls this once per sweep, off the hot path).
export function fitLogLinear(xs, ys) {
    const n = xs.length;
    if (n < 2 || ys.length !== n) {
        throw new Error('[lite-loglogn] fitLogLinear needs >= 2 paired points');
    }
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    const mx = sx / n, my = sy / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = my - slope * mx;
    // R^2 = (explained variance) / (total variance); 1.0 = a perfect line.
    const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
    return { slope, intercept, r2 };
}

// --- the U-sweep: universe bit-widths the double-log fit gates over ----------
// Hold n fixed; sweep the universe bit-width w. The PRIMARY axis is log2(w)
// (this list, mapped through Math.log2), NOT log2(n). The impostor axis is w
// itself; the log2(w) fit must WIN. StratifiedBitset records the exact policy in
// D-04 (decisions/0004-witness.md).
export const WITNESS_W = [16, 18, 20, 22, 24, 26, 28, 30, 32];

// --- the n-sweep: element counts for the crossover vs the O(log n) foil ------
// Hold U at 32 bits; sweep n. The member stays flat (its bound is in w, not n)
// while the O(log n) foil climbs; the crossover n is reported as a fact.
export const WITNESS_NS = [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7];

// --- the reference O(log n) foil --------------------------------------------
// A sorted-array binary search (the O(log n) default a predecessor/successor
// structure replaces): find the insertion point in log2(n) compares. Fit against
// the log2(n) axis it is a straight climbing line; against the SAME workload the
// member stays flat as n grows past the crossover. StratifiedBitset wires this as
// its predecessor foil; later members reuse it or swap in a lite-logn member.
export function sortedArrayPredecessor(arr, len, key) {
    let lo = 0, hi = len;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < key) { lo = mid + 1; } else { hi = mid; }
    }
    // lo is the first index >= key; predecessor is lo - 1 (or absent).
    return lo - 1;
}

// --- the member registry ----------------------------------------------------
// Each member session appends { name, band, runU(w) -> { nsPerOp, maxNs },
// runN(n) -> { nsPerOp, maxNs }, foil(n) -> nsPerOp } here. Empty at v0.1.0 --
// nothing to fit on either axis.
const MEMBERS = [];

function main() {
    process.stdout.write('lite-loglogn O(log log U) Witness -- v0.1.0 (scaffold)\n');
    process.stdout.write('fit (PRIMARY axis): nsPerOp = intercept + slope * log2(w)  [w = universe bit-width, NOT n]\n');
    if (MEMBERS.length === 0) {
        process.stdout.write(
            'WITNESS members=0 -- no member to fit yet (scaffold); ' +
            'R^2 floor + slope band (and which sweep is the HARD gate) are ' +
            'calibrated in StratifiedBitset (D-04). ok\n');
        return;
    }
    // StratifiedBitset fills this loop: U-sweep fit on BOTH axes (assert the
    // log2(w) fit wins over the impostor w axis), gate R^2 >= floor && slope in
    // band on the winning axis, run the n-sweep and report the crossover vs the
    // O(log n) foil, print MAX single-op for amortized/expected members.
    let ok = true;
    for (const m of MEMBERS) {
        const xw = [], yw = [];
        for (const w of WITNESS_W) { xw.push(Math.log2(w)); yw.push(m.runU(w).nsPerOp); }
        const fitW = fitLogLinear(xw, yw);
        process.stdout.write(
            m.name + ' log2(w)-fit R^2=' + fitW.r2.toFixed(4) +
            ' slope=' + fitW.slope.toFixed(3) + ' ns/level\n');
        // gate wiring (log2(w)-fit-wins assertion + crossover) lands with D-04;
        // scaffold does not gate.
        void fitW; void ok;
    }
    process.stdout.write('WITNESS ok\n');
}

main();
