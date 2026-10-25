// @zakkster/lite-loglogn -- opt-in launcher for the >= 2^31 universe test (D11).
// `node test/big/run.mjs` runs `node --test test/big/BigUniverse.test.js` with
// LOGLOGN_BIG=1 (cross-platform: no shell, no env syntax) and exits with the
// child's code; a child killed by a signal exits 1. Extra argv is passed to
// node --test (e.g. --test-reporter=spec).
//
// Fail closed (F10): a child that exits 0 but ran no test of its own passes
// vacuously (node counts the bare file as one passing test). A second reporter
// (tap, to a temp file) records the top-level results; exit 0 additionally needs
// at least one non-skipped, non-todo `ok` line that is not the file itself, else
// the launcher exits 1. A user `--test-reporter=X` keeps stdout; with none given
// the spec reporter is used on stdout.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = fileURLToPath(new URL('./BigUniverse.test.js', import.meta.url));
const user = process.argv.slice(2);
const nUser = user.filter((a) => a.startsWith('--test-reporter=')).length;
const dir = mkdtempSync(join(tmpdir(), 'loglogn-big-'));
const tap = join(dir, 'result.tap');
const out = [];
if (nUser === 0) out.push('--test-reporter=spec', '--test-reporter-destination=stdout');
else for (let i = 0; i < nUser; i++) out.push('--test-reporter-destination=stdout');
out.push('--test-reporter=tap', '--test-reporter-destination=' + tap);

function ranOwnTests() {
    let text = '';
    try {
        text = readFileSync(tap, 'utf8');
    } catch (e) {
        return false;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = /^ok \d+ - (.*)$/.exec(lines[i]);
        if (m === null) continue;
        if (/# (SKIP|TODO)/i.test(m[1]) || m[1].endsWith('BigUniverse.test.js')) continue;
        return true;
    }
    return false;
}

function finish(code) {
    let c = code;
    if (c === 0 && !ranOwnTests()) {
        console.error('[test:big] child exited 0 but ran no test of its own');
        c = 1;
    }
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = c;
}

const child = spawn(process.execPath, ['--test', ...user, ...out, file], {
    stdio: 'inherit',
    env: { ...process.env, LOGLOGN_BIG: '1' },
});
child.on('error', (e) => {
    console.error('[test:big] spawn failed: ' + (e && e.message ? e.message : String(e)));
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    if (signal !== null) console.error('[test:big] child killed by ' + signal);
    finish(code === null ? 1 : code);
});
