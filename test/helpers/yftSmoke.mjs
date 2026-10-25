// yftSmoke.mjs -- pure verdict over a `node test/witness.mjs --yft --smoke` run (Y-B2, G3-5).
// Counts / strings only: no timing value is judged (C-10 / C-11). No I/O, no side effects.

export const YFT_COVERAGE_LITERAL = 'COVERAGE: n-sweep 2 points (A/B 2), U-sweep 2 widths, ABBA runs 9 / 9 (K 3 rounds each), probe rounds 27, latency runs 8 / 8, foil medians 17 / 17, tail runs 2 / 2, A/B scenarios 4, pre-pass queries 179119, gc window blocks 16 / 16, gc tail windows 2 / 2';

export const RE_MAX = /^REPORTED MAX single-op tail w=(\d+) M=4096: max (\S+) ns at op #(\d+) phase (fill|drain) kind (plain|split|merge|reseed) deltas splits \+(\d+) merges \+(\d+) borrows \+(\d+) kicks \+(\d+) reseeds \+(\d+) \| p50 (\S+) p99 (\S+) \| per-kind max plain (\S+), split (\S+), merge (\S+), reseed (\S+) \| max\/p50 (\S+) \[(#*)\] \(4 # per doubling, cap 64\)$/gm;
export const RE_COUNTS = /^COUNTS tail w=(\d+) M=4096: splits (\S+) merges (\S+) inner kicks (\S+) inner reseeds (\S+) \| per-kind ops plain (\S+) split (\S+) merge (\S+) reseed (\S+) \| borrows (\S+) \(tagged merge\)$/gm;
export const RE_GCTAIL = /^GC window tail w=(\d+): instance A fill 4096 \+ drain 4096 \(untimed\): gc\.major 0 minor \d+ arrayBuffers growth (0|-\d+) B splits (\d+) merges (\d+) \(tolerance: major 0, growth 0 B; splits >= 1, merges >= 1\) -- ok$/gm;
export const RE_RETENTION = /^RETENTION: tail cycles 2 \/ 2, instances tracked 4, collected 4, errors 0, worst tracker\.size\(\) 0 after a cycle's drop \+ gc \+ settle; tracker\.size\(\) 0 -- ok$/gm;
export const RE_CTRL = [/^CONTROL drift: /gm, /^CONTROL abVerdict self-check: .* -- ok$/gm, /^CONTROL gc-window: .* -- ok$/gm, /^CONTROL pre-pass: .* -- ok$/gm];

const NONFIN = /(^|[\s=:+(\[,])(NaN|-?Infinity)([\s,;)\]]|$)/;
const nrows = (re, s) => [...s.matchAll(new RegExp(re.source, re.flags.includes('m') ? 'gm' : 'g'))];
const KINDS = ['plain', 'split', 'merge', 'reseed'];

export function yftSmokeVerdict({ status, signal, error, stdout }) {
    const fails = [];
    let counts = null;
    const out = typeof stdout === 'string' ? stdout : '';
    if (error) fails.push('spawn error');
    if (out.length === 0) { fails.push('empty stdout'); return { fails, counts }; }
    if (signal) fails.push('signal ' + signal);
    else if (status !== 0) fails.push('status ' + status);
    if (!/mode YFT/.test(out)) { fails.push('mode banner'); return { fails, counts }; }
    const lines = out.split('\n');
    const rowLines = lines.filter((l) => /^(REPORTED MAX single-op tail|COUNTS tail|GC window tail) /.test(l));
    const nonFinite = rowLines.some((l) => NONFIN.test(l));
    if (nonFinite) fails.push('non-finite');
    // coverage rows (6 checks)
    if (!lines.includes(YFT_COVERAGE_LITERAL)) fails.push('coverage row');
    for (let i = 0; i < RE_CTRL.length; i++) {
        if (nrows(RE_CTRL[i], out).length !== 1) fails.push('control row ' + i);
    }
    if (lines.filter((l) => l.startsWith('CONTROL ')).length !== 4) fails.push('control count');
    if (lines.some((l) => l.startsWith('FAIL '))) fails.push('FAIL line');
    const cs = nrows(RE_COUNTS, out);
    if (cs.length !== 2) fails.push('counts rows');
    counts = {};
    for (const m of cs) {
        counts[m[1]] = { splits: +m[2], merges: +m[3], kicks: +m[4], reseeds: +m[5],
            plain: +m[6], split: +m[7], merge: +m[8], reseed: +m[9], borrows: +m[10] };
    }
    if (nrows(RE_GCTAIL, out).length !== 2 || rowLines.filter((l) => l.startsWith('GC window tail ')).length !== 2) fails.push('gc tail rows');
    if (nrows(RE_RETENTION, out).length !== 1) fails.push('retention row');
    const ms = nrows(RE_MAX, out);
    if (ms.length !== 2) fails.push('max rows');
    for (const m of ms) {
        const c = counts[m[1]];
        if (!c) { fails.push('max row without counts w=' + m[1]); continue; }
        if (!(+m[3] >= 0 && +m[3] < 8192)) fails.push('op # range w=' + m[1]);
        const ns = [m[2], m[11], m[12], m[17]];
        for (let k = 0; k < 4; k++) ns.push(m[13 + k]);
        for (let k = 0; k < 4; k++) {
            const v = m[13 + k];
            const na = v === 'n/a';
            if (na !== (c[KINDS[k]] === 0)) { if (!NONFIN.test(' ' + v + ' ')) fails.push('n/a rule ' + KINDS[k] + ' w=' + m[1]); }
        }
        for (const v of ns) {
            if (v === 'n/a') continue;
            const x = Number(v);
            if (!Number.isFinite(x)) { if (!nonFinite) fails.push('non-finite max field w=' + m[1]); }
            else if (x < 0) fails.push('negative ns w=' + m[1]);
        }
    }
    return { fails, counts };
}
