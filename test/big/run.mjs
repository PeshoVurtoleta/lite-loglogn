// @zakkster/lite-loglogn -- opt-in launcher for the >= 2^31 universe test (D11).
// `node test/big/run.mjs` runs `node --test test/big/BigUniverse.test.js` with
// LOGLOGN_BIG=1 (cross-platform: no shell, no env syntax) and exits with the
// child's code; a child killed by a signal exits 1. Extra argv is passed to
// node --test (e.g. --test-reporter=spec).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('./BigUniverse.test.js', import.meta.url));
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), file], {
    stdio: 'inherit',
    env: { ...process.env, LOGLOGN_BIG: '1' },
});
child.on('error', (e) => {
    console.error('[test:big] spawn failed: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    if (signal !== null) console.error('[test:big] child killed by ' + signal);
    process.exitCode = code === null ? 1 : code;
});
