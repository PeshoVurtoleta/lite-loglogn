// inl-stage.mjs -- stage ONE side of an inlining-budget-diff.sh driver-mode run.
//
//   node test/tools/inl-stage.mjs DRIVER LIB DIR [KEY=VALUE ...]
//
// inlining-budget-diff.sh runs a driver with no argv, so the same inl-*.mjs driver is pointed at a
// before / after LogLogN.js through a thin wrapper: DIR/run.mjs sets $LLN_LIB (and every KEY=VALUE)
// and imports the driver. DRIVER and LIB are COPIED into DIR first (the copy is the freeze: an edit
// to the source files during the run cannot leak in). Prints the absolute path of DIR/run.mjs.
// Fails closed (exit 2, nothing written): a missing DRIVER / LIB, a DIR that exists and is not empty,
// a bad KEY=VALUE. Test tooling only: not shipped, not part of npm test.
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { createHash } from 'node:crypto';

function die(msg) {
    process.stderr.write('inl-stage: ' + msg + '\n' +
        'usage: node test/tools/inl-stage.mjs DRIVER LIB DIR [KEY=VALUE ...]\n');
    process.exit(2);
}
function sha8(p) { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8); }

const args = process.argv.slice(2);
if (args.length < 3) die('need DRIVER LIB DIR');
const drv = resolve(args[0]);
const lib = resolve(args[1]);
const dir = resolve(args[2]);
for (const [what, p] of [['DRIVER', drv], ['LIB', lib]]) {
    if (!existsSync(p) || !statSync(p).isFile()) die(what + ' not found: ' + p);
}
if (!/\.mjs$/.test(drv)) die('DRIVER must be an .mjs file: ' + drv);
if (basename(drv) === 'run.mjs' || basename(drv) === 'LogLogN.js') die('DRIVER name clashes with a staged file: ' + drv);
const env = [];
for (const kv of args.slice(3)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(kv);
    if (m === null) die('bad KEY=VALUE (KEY = [A-Z_][A-Z0-9_]*): ' + JSON.stringify(kv));
    if (m[1] === 'LLN_LIB') die('LLN_LIB is set by inl-stage itself (pass LIB)');
    env.push([m[1], m[2]]);
}
if (existsSync(dir) && readdirSync(dir).length > 0) die('DIR exists and is not empty (use a fresh dir): ' + dir);
mkdirSync(dir, { recursive: true });
const dd = join(dir, basename(drv));
const ld = join(dir, 'LogLogN.js');
copyFileSync(drv, dd);
copyFileSync(lib, ld);
let src = '// inl-stage wrapper (generated). driver ' + drv + ' sha256/8 ' + sha8(dd) + '\n' +
    '// LIB ' + lib + ' sha256/8 ' + sha8(ld) + ' (copied beside this file)\n' +
    'process.env.LLN_LIB = ' + JSON.stringify(ld) + ';\n';
for (const [k, v] of env) src += 'process.env.' + k + ' = ' + JSON.stringify(v) + ';\n';
src += 'await import(' + JSON.stringify('./' + basename(drv)) + ');\n';
writeFileSync(join(dir, 'run.mjs'), src);
process.stdout.write(join(dir, 'run.mjs') + '\n');
