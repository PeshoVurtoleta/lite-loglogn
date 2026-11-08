/**
 * @zakkster/lite-loglogn -- demo witness band table (repo-only; never shipped).
 *
 * A HAND COPY of the witness lanes' run constants, for the demo's "gated band" readout beside the live,
 * approximate ns/op (PLAN-demo D-4). The values below are copied from test/witness.mjs and
 * test/witness-roar.mjs; demo/Demo.test.mjs drift-tests them against the harness SOURCES (each constant
 * regex-parsed, exported or not). Compared: K and need of every lane; ns of every lane; widths of every lane
 * but tier; wN / nU of sb, w32, xft, yft (W_N / N_U, XFT_W_N / XFT_N_U, YFT_W_N / YFT_N_U); ctrl / x2 of roar
 * (CTRL_LO / CTRL_HI, X2_LO / X2_HI). An edit to one of THOSE harness constants that is not copied here fails
 * that test. NOT compared (hand-maintained, check them by eye): member, title, tier (only required non-empty),
 * axis (only required 'log2(w)'), src, the tier lane widths, and the null wN / nU / ctrl / x2 of the other lanes.
 *
 * Every lane has: id, member (the panel it belongs to), title, tier ('GATED' / 'GATED (opt-in --w32)' /
 * 'GATED (--tier, A12)' / 'REPORTED'), K (rounds per point), need (rounds needed to declare a winner; null
 * for the roar lane, whose statistic is a median ratio, not a K / need count), axis 'log2(w)' (the fit axis
 * is the universe BIT-WIDTH, never log2(n)), widths (universe bit-widths w of the U-sweep), ns (element
 * counts of the n-sweep, or the lane's n set), wN (n-sweep width, null if none), nU (U-sweep n, null if
 * none), ctrl / x2 (the roar lane's SB-AA and x2 control bands, null elsewhere) and src (the source file and
 * constant name of each copied field; a string that is not a constant name describes a literal in the file).
 *
 * No measured number lives here: these are run CONSTANTS (rounds, widths, n sets, control bands), and every
 * timing the page shows is REPORTED / live (A5). ASCII only. MIT (c) Zahary Shinikchiev.
 */

const W = 'test/witness.mjs';
const R = 'test/witness-roar.mjs';

function lane(o) {
    o.widths = Object.freeze(o.widths);
    o.ns = Object.freeze(o.ns);
    if (o.ctrl !== null) o.ctrl = Object.freeze(o.ctrl);
    if (o.x2 !== null) o.x2 = Object.freeze(o.x2);
    o.src = Object.freeze(o.src);
    return Object.freeze(o);
}

/** The per-lane band table: the GATED sb n-sweep first, then w32 / tier / xft / yft / veb / roar. */
export const LANES = Object.freeze([
    lane({
        id: 'sb',
        member: 'sb',
        title: 'StratifiedBitset successor: n-sweep vs u32Successor at w 28; U-sweep vs NaiveFlatBitset at n 4096',
        tier: 'GATED',
        K: 15,
        need: 13,
        axis: 'log2(w)',
        widths: [16, 20, 24, 28],
        ns: [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7],
        wN: 28,
        nU: 4096,
        ctrl: null,
        x2: null,
        src: { file: W, K: 'WITNESS_K', need: 'WITNESS_NEED', widths: 'WITNESS_W', ns: 'WITNESS_NS',
            wN: 'W_N (main)', nU: 'N_U (main)' }
    }),
    lane({
        id: 'w32',
        member: 'sb',
        title: 'StratifiedBitset U-sweep with w 32 appended (--w32 or LOGLOGN_W32=1)',
        tier: 'GATED (opt-in --w32)',
        K: 15,
        need: 13,
        axis: 'log2(w)',
        widths: [16, 20, 24, 28, 32],
        ns: [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7],
        wN: 28,
        nU: 4096,
        ctrl: null,
        x2: null,
        src: { file: W, K: 'WITNESS_K', need: 'WITNESS_NEED', widths: 'WITNESS_W + 32 (witnessWidths)',
            ns: 'WITNESS_NS', wN: 'W_N (main)', nU: 'N_U (main)' }
    }),
    lane({
        id: 'tier',
        member: 'sb',
        title: 'StratifiedBitset tier walk (A12): live B vs B1a + 3 reads A; dense U 2^16, sparse U 2^20',
        tier: 'GATED (--tier, A12)',
        K: 15,
        need: 13,
        axis: 'log2(w)',
        widths: [16, 20],
        ns: [32768, 4096],
        wN: null,
        nU: null,
        ctrl: null,
        x2: null,
        src: { file: W, K: 'WITNESS_K', need: 'WITNESS_NEED', widths: 'tier scenarios U 1 << 16 / 1 << 20',
            ns: 'TIER_N_DENSE / TIER_N_SPARSE' }
    }),
    lane({
        id: 'xft',
        member: 'xft',
        title: 'XFastTrie vs StratifiedBitset: n-sweep at w 28, U-sweep at n 4096, update fit',
        tier: 'REPORTED',
        K: 15,
        need: 13,
        axis: 'log2(w)',
        widths: [16, 20, 24, 28],
        ns: [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6],
        wN: 28,
        nU: 4096,
        ctrl: null,
        x2: null,
        src: { file: W, K: 'WITNESS_K', need: 'WITNESS_NEED', widths: 'WITNESS_W (witnessWidths)', ns: 'XFT_NS',
            wN: 'XFT_W_N', nU: 'XFT_N_U' }
    }),
    lane({
        id: 'yft',
        member: 'yft',
        title: 'YFastTrie vs XFastTrie (n <= 1e6) or u32Successor: n-sweep at w 28, U-sweep at n 4096',
        tier: 'REPORTED',
        K: 15,
        need: 13,
        axis: 'log2(w)',
        widths: [16, 20, 24, 28],
        ns: [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7],
        wN: 28,
        nU: 4096,
        ctrl: null,
        x2: null,
        src: { file: W, K: 'WITNESS_K', need: 'WITNESS_NEED', widths: 'WITNESS_W (witnessWidths)', ns: 'YFT_NS',
            wN: 'YFT_W_N', nU: 'YFT_N_U' }
    }),
    lane({
        id: 'veb',
        member: 'veb',
        title: 'vEBTree (B) vs StratifiedBitset (A): ABBA per family C7 / PAR / SH1 / PRED, random n 64 / 4096',
        tier: 'REPORTED',
        K: 15,
        need: 13,
        axis: 'log2(w)',
        widths: [16, 20, 24, 28, 32],
        ns: [64, 4096],
        wN: null,
        nU: null,
        ctrl: null,
        x2: null,
        src: { file: W, K: 'WITNESS_K', need: 'WITNESS_NEED', widths: 'VEB_WS', ns: 'VEB_N_S / VEB_N_L' }
    }),
    lane({
        id: 'roar',
        member: 'roar',
        title: 'RoaringSet direct layout: median ratio vs StratifiedBitset over K interleaved rounds, n_eff = min(n, U/4)',
        tier: 'REPORTED',
        K: 15,
        need: null,
        axis: 'log2(w)',
        widths: [16, 20, 24, 28, 32],
        ns: [64, 4096, 65536],
        wN: null,
        nU: null,
        ctrl: [0.9, 1.1],
        x2: [1.6, 2.4],
        src: { file: R, K: 'K_FULL', need: 'none (median-ratio statistic)', widths: 'W_D', ns: 'N_ALL',
            ctrl: 'CTRL_LO / CTRL_HI', x2: 'X2_LO / X2_HI' }
    })
]);

/** Lane ids in table order. */
export const LANE_IDS = Object.freeze(LANES.map((l) => l.id));
