/**
 * @zakkster/lite-loglogn -- StratifiedBitset PARITY gate (XFastTrie program A7,
 * DETERMINISTIC). The one parity pin of the 0.3.0 program.
 *
 * test/vectors/parity.json pins the bytes + sha256 of the region of LogLogN.js
 * from the `// --- StratifiedBitset (0.2.0)` marker (inclusive) to the next
 * line starting `// --- ` (exclusive: the region ends at the "\n" before that
 * marker), or EOF. Cut from `git show HEAD:LogLogN.js` at 614bd65, where the
 * region runs to EOF. A later member is appended after a blank line, so the
 * region keeps ending with StratifiedBitset's closing "}\n". The region holds
 * the shared prelude StratifiedBitset uses (throwKey).
 *
 * The LIVE file must match. Controls: a one-character in-memory mutation inside
 * the region (same length) mismatches on sha256; a text without the start
 * marker, or with it twice, FAILS (never a vacuous pass).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PIN = JSON.parse(readFileSync(new URL('./vectors/parity.json', import.meta.url), 'utf8'));
const LIVE = readFileSync(new URL('../' + PIN.file, import.meta.url), 'utf8');

/** Region by the markers, or null when the start marker is missing or ambiguous. */
function region(text, from) {
    const s = text.indexOf(from);
    if (s < 0 || text.indexOf(from, s + 1) >= 0) return null;
    const e = text.indexOf('\n// --- ', s + 1);
    return text.slice(s, e < 0 ? text.length : e);
}

/** { ok, reason } of text against the pin. */
function checkParity(text, pin) {
    const r = region(text, pin.from);
    if (r === null) return { ok: false, reason: 'start marker missing or not unique' };
    const buf = Buffer.from(r, 'utf8');
    if (buf.length !== pin.bytes) return { ok: false, reason: 'bytes ' + buf.length + ' != ' + pin.bytes };
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== pin.sha256) return { ok: false, reason: 'sha256 ' + sha + ' != ' + pin.sha256 };
    return { ok: true, reason: '' };
}

test('parity pin shape', () => {
    assert.deepEqual(Object.keys(PIN), ['file', 'from', 'to', 'bytes', 'sha256']);
    assert.equal(PIN.file, 'LogLogN.js');
    assert.equal(PIN.from, '// --- StratifiedBitset (0.2.0)');
    assert.match(PIN.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(PIN.bytes) && PIN.bytes > 4096);
});

test('live LogLogN.js StratifiedBitset region equals parity.json', () => {
    const r = checkParity(LIVE, PIN);
    assert.equal(r.reason, '');
    assert.equal(r.ok, true);
    assert.ok(region(LIVE, PIN.from).endsWith('}\n'), 'region ends at the class close');
});

test('control: a one-character mutation inside the region mismatches', () => {
    const s = LIVE.indexOf(PIN.from);
    const i = s + (PIN.bytes >>> 1);
    const c = LIVE.charCodeAt(i);
    const mut = LIVE.slice(0, i) + String.fromCharCode(c === 0x61 ? 0x62 : 0x61) + LIVE.slice(i + 1);
    assert.equal(mut.length, LIVE.length);
    const r = checkParity(mut, PIN);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^sha256 /, 'same length: only the hash can see it');
});

test('control: a missing or duplicated start marker FAILS', () => {
    const gone = LIVE.replace(PIN.from, '// --- StratifiedBitset (0.2.x)');
    assert.equal(checkParity(gone, PIN).ok, false);
    assert.equal(checkParity('', PIN).ok, false);
    const twice = LIVE + '\n' + PIN.from + '\n';
    assert.equal(checkParity(twice, PIN).ok, false);
});

test('control: an appended member after a blank line keeps parity; a grown region does not', () => {
    const appended = LIVE + '\n// --- XFastTrie (0.3.0) ---\nexport class X {}\n';
    assert.equal(checkParity(appended, PIN).ok, true);
    const end = LIVE.indexOf(PIN.from) + PIN.bytes;
    const grown = LIVE.slice(0, end) + '// tail\n' + LIVE.slice(end);
    const r = checkParity(grown, PIN);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^bytes /);
});
