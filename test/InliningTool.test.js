/**
 * @zakkster/lite-loglogn -- test/tools/inlining-budget-diff.sh, DETERMINISTIC part only.
 *
 * The tool (a copy of LiteUtils/inlining-budget-diff.sh, driver mode only) compares V8 inlining
 * decisions; a REAL comparison follows tier-up timing, so it is STATISTICAL / REPORTED and never runs
 * here (run it under the host quiet lock, see the tool header). What runs here:
 * - --self-test: canned trace text through the normalizer / multiset / guard / budget awk programs,
 *   plus fake-node driver-mode runs (no real node is traced): must exit 0.
 * - fail closed: driver mode with a missing driver, a missing --fn and a removed lite-signal mode
 *   each exit 2 with VERDICT NO-VERDICT and never spawn the drivers.
 * - teeth (mirrors LiteSignal test/94): the self-test's `ok` count is pinned (CHECKS), an unmodified
 *   copy outside the repo passes, and every MUTANTS row (one exact edit of the script) must turn the
 *   self-test red on its named check.
 * Skips (never passes) when bash is not on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('./tools/inlining-budget-diff.sh', import.meta.url));
const CHECKS = 41;   // every `check` call in self_test(); a new check moves this literal
const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const skip = HAS_BASH ? false : 'bash not on PATH';

function run(args) {
    const r = spawnSync('bash', [TOOL, ...args], { encoding: 'utf8', timeout: 120000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function okCount(out) { return (out.match(/^ok {3}/gm) || []).length; }

// --self-test of a script path, async so the mutant rows can run side by side.
function selfTest(path) {
    return new Promise((resolve) => {
        const c = spawn('bash', [path, '--self-test'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        const t = setTimeout(() => c.kill('SIGKILL'), 120000);
        c.stdout.on('data', (b) => { out += b; });
        c.stderr.on('data', (b) => { err += b; });
        c.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, out, err }); });
    });
}

// A copy of the script in DIR with ONE exact edit (the anchor must match exactly once, else the row
// is invalid). A RegExp anchor is resolved to its single match first.
function variant(dir, name, from, to) {
    const src = readFileSync(TOOL, 'utf8');
    let anchor = from;
    if (from instanceof RegExp) {
        const m = src.match(new RegExp(from.source, 'gm'));
        assert.equal(m && m.length, 1, `mutant ${name}: regex anchor must match exactly once`);
        anchor = m[0];
    }
    const n = src.split(anchor).length - 1;
    assert.equal(n, 1, `mutant ${name}: anchor must match exactly once, matched ${n}`);
    const p = join(dir, `${name}.sh`);
    writeFileSync(p, src.replace(anchor, () => to));
    chmodSync(p, 0o755);
    return p;
}

test('inlining-budget-diff --self-test passes (canned text, exit 0)', { skip }, () => {
    const r = run(['--self-test']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^self-test: all checks passed$/m);
    assert.doesNotMatch(r.out, /^FAIL /m);
    assert.equal(okCount(r.out), CHECKS);
    // the checks that carry the verdict contract are present (a self-test that silently lost them
    // would still print "all checks passed")
    for (const name of [
        'driver mode (fake node): a real DIFF exits 1',
        'driver mode (fake node): addresses / frequencies only -> SAME, exit 0',
        'driver mode: an unexpected failure (--out is a file, mkdir fails) exits 2 NO-VERDICT, never 1',
        'a removed lite-signal mode (--before-ref) is a usage error',
        'multiset keeps call-site multiplicity',
        'guard: read does not match read.set',
        'driver mode (fake node): a tier with no decisions at all is NO-VERDICT, exit 2',
        'driver mode (fake node): a driver that exits non-zero is NO-VERDICT, exit 2',
        'driver mode (fake node): after run 1 vs run 2 differ -> null control NO-VERDICT, exit 2',
        'driver mode (fake node): no trace of --fn -> guard NO-VERDICT, exit 2',
    ]) {
        assert.ok(r.out.includes('ok   ' + name), 'self-test check missing or failing: ' + name);
    }
});

test('driver mode: a missing driver exits 2 NO-VERDICT', { skip }, () => {
    const d = mkdtempSync(join(tmpdir(), 'lln-inl-'));
    try {
        const r = run(['--fn', 'add', '--runs', '2', '--out', join(d, 'out'),
            join(d, 'missing-before.mjs'), join(d, 'missing-after.mjs')]);
        assert.equal(r.status, 2, r.out);
        assert.match(r.out, /driver not found: .*missing-before\.mjs/);
        assert.match(r.out, /^VERDICT NO-VERDICT$/m);
        assert.ok(!existsSync(join(d, 'out', 'raw', 'turbo.before.1.txt')), 'no trace run may start');
    } finally {
        rmSync(d, { recursive: true, force: true });
    }
});

test('driver mode: no --fn, or a removed ref / file mode, exits 2 NO-VERDICT', { skip }, () => {
    const d = mkdtempSync(join(tmpdir(), 'lln-inl-'));
    try {
        const a = run(['--out', join(d, 'o1'), TOOL, TOOL]);
        assert.equal(a.status, 2, a.out);
        assert.match(a.out, /--fn LIST is required/);
        assert.match(a.out, /^VERDICT NO-VERDICT$/m);
        for (const opt of ['--before-ref', '--after-ref', '--before', '--after', '--driver', '--repo']) {
            const r = run(['--fn', 'add', opt, 'x', '--out', join(d, 'o2')]);
            assert.equal(r.status, 2, opt + ': ' + r.out);
            assert.match(r.out, /removed in this copy \(driver mode only/, opt);
            assert.match(r.out, /^VERDICT NO-VERDICT$/m, opt);
        }
        assert.ok(!existsSync(join(d, 'o2')), 'a removed mode must exit before creating --out');
    } finally {
        rmSync(d, { recursive: true, force: true });
    }
});

test('inlining-budget-diff --self-test: an unmodified copy outside the repo passes (baseline for the mutants)', { skip, timeout: 180000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lln-ibd-base-'));
    try {
        const r = await selfTest(variant(dir, 'baseline', '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\n'));
        assert.equal(r.status, 0, r.out + r.err);
        assert.equal(okCount(r.out), CHECKS);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// [name, anchor, replacement, a FAIL line must name this check]. The first eight are LiteSignal
// test/94's rows that apply to this driver-mode copy; its four refusal rows (live / tracked --before,
// Watch.js, --after repo, symlink) target the git-ref and file modes, which this copy removed. The last
// five cover this copy's own NO-VERDICT paths. Known verdict-equivalent: dropping the "no inlining
// decisions at all" branch stays green, because the guard then reports the same tier NO-VERDICT,
// exit 2 (fail closed; only the hint text is lost), so it has no row.
const MUTANTS = [
    ['multiset-sort-u', 'multiset() { sort | uniq -c; }', 'multiset() { sort -u; }',
        'multiset keeps call-site multiplicity'],
    ['budget-double-compare', 'used + int((z + e) * scale) > L', 'used + (z + e) * scale > L',
        'reserve compare truncates like V8'],
    ['no-turbo-address-normalize', 'gsub(/0x[0-9a-fA-F]+/, "0x", l); gsub(/#[0-9]+/, "#N", l)', 'gsub(/#[0-9]+/, "#N", l)',
        'turbo: addresses / ids / frequencies'],
    ['no-exit-trap', /^trap 'rc=\$\?;.*' EXIT\n/m, '',
        'an unexpected failure (--out is a file, mkdir fails) exits 2 NO-VERDICT, never 1'],
    ['trap-ignores-final', '[[ -z $FINAL && $rc -ne 0', '[[ $rc -ne 0',
        'a real DIFF exits 1'],
    ['no-final-before-verdict', 'FINAL=1\ncase "$VERDICT"', 'case "$VERDICT"',
        'a real DIFF exits 1'],
    ['ok-label', 'if (used + 0 == peak[sd, u] + 0) chk = "ok"', 'if (used + 0 == peak[sd, u] + 0) chk = "okX"',
        'budget model: equal -> ok'],
    ['no-mismatch-note', 'if grep -q \'MISMATCH\' "$OUT/budget.$tier.tsv"; then', 'if false; then',
        'a budget-model MISMATCH prints a NOTE'],
    ['no-guard', 'if [[ $g == ok ]] && ! awk -v fn="$fn" "$GUARD_AWK"', 'if false && ! awk -v fn="$fn" "$GUARD_AWK"',
        'no trace of --fn -> guard NO-VERDICT, exit 2'],
    ['no-null-control', 'if [[ -z "$v" ]] && ! cmp -s', 'if false && ! cmp -s',
        'null control NO-VERDICT, exit 2'],
    ['no-driver-exit', '    die "driver exited non-zero:', '    : "driver exited non-zero:',
        'a driver that exits non-zero is NO-VERDICT, exit 2'],
    ['no-removed-mode', 'usage >&2; die "$a: the lite-signal ref / file modes', 'usage >&2; : "$a: the lite-signal ref / file modes',
        'a removed lite-signal mode (--before-ref) is a usage error'],
    ['worst-ignores-no-verdict', 'if [[ $1 == NO-VERDICT || $2 == NO-VERDICT ]]; then echo NO-VERDICT\n  elif',
        'if false; then echo NO-VERDICT\n  elif',
        'null control NO-VERDICT, exit 2'],
];

test('inlining-budget-diff --self-test MUST FAIL on every mutant', { skip, concurrency: 4, timeout: 600000 }, async (t) => {
    const subs = [];
    for (const [name, from, to, failing] of MUTANTS) {
        subs.push(t.test(`mutant ${name}`, async () => {
            const dir = mkdtempSync(join(tmpdir(), `lln-ibd-${name}-`));
            try {
                const r = await selfTest(variant(dir, name, from, to));
                // red = exit 1, or 2 when the mutant breaks the planned-exit path itself (trap-ignores-final)
                assert.ok(r.status === 1 || r.status === 2,
                    `mutant ${name} survived (status ${r.status}, signal ${r.signal}): ${r.out}${r.err}`);
                assert.match(r.out, /^self-test: \d+ check\(s\) FAILED$/m);
                assert.ok(r.out.split('\n').some((l) => l.startsWith('FAIL ') && l.includes(failing)),
                    `mutant ${name}: expected a FAIL line naming "${failing}"\n${r.out}`);
            } finally { rmSync(dir, { recursive: true, force: true }); }
        }));
    }
    await Promise.all(subs);
});
