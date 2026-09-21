/**
 * @zakkster/lite-loglogn -- cross-cutting QA audit.
 *
 * The suite-law regression guard, independent of any member. At v0.1.0 (the
 * scaffold) it enforces the invariants that must hold before ANY member ships:
 *   - the VERSION trinity (LogLogN.js const === package.json === llms.txt);
 *   - the frozen export surface (VERSION only, no member yet);
 *   - the six-file pack discipline (files[] exact; repo-only dirs absent);
 *   - no "Karadjov" anywhere in the shipped source / docs;
 *   - ASCII-only source in LogLogN.js (this family needs NO Unicode exception --
 *     even U+00D7 / U+00B5 are spelled out as "x" / "mu").
 * Each member session appends its coercion / boundary block below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as LogLogNModule from '../LogLogN.js';
import { VERSION } from '../LogLogN.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// --- VERSION trinity: LogLogN.js const === package.json === llms.txt ---------

test('VERSION trinity: LogLogN.js const, package.json, and llms.txt agree byte-for-byte', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(VERSION, pkg.version, 'LogLogN.js VERSION const !== package.json version');
    const llms = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
    const m = llms.match(/^Version:\s*(\S+)/m);
    assert.ok(m, 'llms.txt must carry a "Version: <x>" header line');
    assert.equal(m[1], VERSION, 'llms.txt Version header !== LogLogN.js VERSION const');
});

test('VERSION is exactly 0.1.0 at the scaffold release', () => {
    assert.equal(VERSION, '0.1.0');
});

// --- frozen export surface: VERSION only (no member yet) --------------------

test('LogLogN.js exports exactly VERSION at v0.1.0 -- no member has leaked in', () => {
    const exportedNames = Object.keys(LogLogNModule).sort();
    assert.deepEqual(exportedNames, ['VERSION'],
        'LogLogN.js export surface drifted from the frozen scaffold surface (VERSION only)');
    assert.equal(typeof VERSION, 'string');
});

// --- six-file pack discipline (L-08 / decisions/0003) -----------------------

test('package.json files[] ships exactly the six shipped files', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const expected = ['LogLogN.js', 'LogLogN.d.ts', 'llms.txt', 'README.md', 'CHANGELOG.md', 'LICENSE'];
    assert.deepEqual([...pkg.files].sort(), [...expected].sort(),
        'files[] drifted from the six shipped files');
});

test('files[] contains none of the repo-only paths', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const repoOnly = ['test', 'benchmark', 'decisions', 'demo', 'ROADMAP.md', 'RESEARCH.md', 'GUIDE.md'];
    for (const f of pkg.files) {
        for (const banned of repoOnly) {
            assert.ok(!f.startsWith(banned),
                'files[] must not ship the repo-only path ' + f);
        }
    }
});

// --- no "Karadjov" anywhere in the shipped source / docs --------------------

test('no "Karadjov" in the shipped files (the name is always Shinikchiev)', () => {
    const files = ['LogLogN.js', 'LogLogN.d.ts', 'llms.txt', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'];
    for (const f of files) {
        const text = readFileSync(join(ROOT, f), 'utf8');
        assert.ok(!/Karadjov/i.test(text), f + ' must not contain "Karadjov"');
    }
    // the copyright holder is spelled correctly where attribution lives
    const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    assert.ok(/Zahary Shinikchiev/.test(license), 'LICENSE must credit Zahary Shinikchiev');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.ok(/Zahary Shinikchiev/.test(pkg.author), 'package.json author must be Zahary Shinikchiev');
});

// --- ASCII-only source in LogLogN.js (this family needs NO exception) --------

test('LogLogN.js is ASCII-only (this family spells out x / mu; no Unicode exception used)', () => {
    const src = readFileSync(join(ROOT, 'LogLogN.js'), 'utf8');
    let bad = 0;
    for (let i = 0; i < src.length; i++) {
        const c = src.charCodeAt(i);
        // U+00D7 and U+00B5 are the ONLY suite-permitted exceptions, but
        // lite-loglogn needs neither -- so any byte > 0x7f is a defect here.
        if (c > 0x7f) {
            bad++;
        }
    }
    assert.equal(bad, 0, 'LogLogN.js contains ' + bad + ' non-ASCII code unit(s)');
});

// --- member coercion / boundary blocks land below (one per member) ----------
