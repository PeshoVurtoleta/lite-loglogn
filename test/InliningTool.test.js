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
 * Skips (never passes) when bash is not on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('./tools/inlining-budget-diff.sh', import.meta.url));
const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const skip = HAS_BASH ? false : 'bash not on PATH';

function run(args) {
    const r = spawnSync('bash', [TOOL, ...args], { encoding: 'utf8', timeout: 120000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('inlining-budget-diff --self-test passes (canned text, exit 0)', { skip }, () => {
    const r = run(['--self-test']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^self-test: all checks passed$/m);
    assert.doesNotMatch(r.out, /^FAIL /m);
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
