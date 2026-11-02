/**
 * @zakkster/lite-loglogn -- pre-vEB PREFIX parity gate (vEBTree program C-15,
 * DETERMINISTIC). Prior members stay BYTE-IDENTICAL while vEBTree is appended.
 *
 * test/vectors/parity-prefix.json pins bytes + sha256 of three regions of
 * LogLogN.js, cut from `git show 25a7ad1:LogLogN.js` (0.4.1 engine bytes):
 *   - prefix:    from `// --- StratifiedBitset (0.2.0)` (inclusive) to the
 *                "\n" before `// --- vEBTree (0.5.0)` (exclusive), or EOF when
 *                that marker is absent. Holds StratifiedBitset, XFastTrie and
 *                YFastTrie (and the shared prelude they use).
 *   - XFastTrie: from `// --- XFastTrie (0.3.0)` to the next line starting
 *                `// --- ` (exclusive, at its leading "\n"), or EOF.
 *   - YFastTrie: from `// --- YFastTrie (0.4.0)` to the next `// --- ` line, or EOF.
 * The file header above the StratifiedBitset marker (VERSION, member list) is
 * NOT pinned: it changes with every release. test/Parity.test.js keeps its own
 * StratifiedBitset pin (parity.json) untouched.
 *
 * Fail closed: a start marker found 0 or > 1 times, or a named end marker found
 * > 1 times or before the start, yields no region (never a vacuous pass).
 * Controls: same-length mutations in XFastTrie and in YFastTrie, a grown
 * region, a missing marker and a duplicated marker each FAIL the checker; an
 * appended vEBTree section passes every pin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PIN = JSON.parse(readFileSync(new URL('./vectors/parity-prefix.json', import.meta.url), 'utf8'));
const LIVE = readFileSync(new URL('../' + PIN.file, import.meta.url), 'utf8');
const NEXT = '\n// --- ';
const VEB = '\n// --- vEBTree (0.5.0)';

function count(text, s) {
    let n = 0;
    for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) n++;
    return n;
}

/** Region by the markers, or null when a marker is missing or ambiguous. */
function region(text, from, to) {
    if (count(text, from) !== 1) return null;
    const s = text.indexOf(from);
    let e;
    if (to === NEXT) {
        e = text.indexOf(NEXT, s + 1);
    } else {
        const n = count(text, to);
        if (n > 1) return null;
        e = text.indexOf(to);
        if (n === 1 && e < s) return null;
    }
    return text.slice(s, e < 0 ? text.length : e);
}

/** { ok, reason } of text against one region pin. */
function checkRegion(text, pin) {
    const r = region(text, pin.from, pin.to);
    if (r === null) return { ok: false, reason: 'marker missing or not unique' };
    const buf = Buffer.from(r, 'utf8');
    if (buf.length !== pin.bytes) return { ok: false, reason: 'bytes ' + buf.length + ' != ' + pin.bytes };
    const sha = createHash('sha256').update(buf).digest('hex');
    if (sha !== pin.sha256) return { ok: false, reason: 'sha256 ' + sha + ' != ' + pin.sha256 };
    return { ok: true, reason: '' };
}

/** Map name -> { ok, reason } over every pinned region. */
function checkAll(text) {
    const out = {};
    for (const p of PIN.regions) out[p.name] = checkRegion(text, p);
    return out;
}

function allOk(res) {
    for (const k in res) if (!res[k].ok) return false;
    return true;
}

function pinOf(name) {
    for (const p of PIN.regions) if (p.name === name) return p;
    throw new Error('no pin ' + name);
}

/** Same-length one-character mutation at the midpoint of a region. */
function mutateMid(text, p) {
    const i = text.indexOf(p.from) + (p.bytes >>> 1);
    const c = text.charCodeAt(i);
    assert.notEqual(c, 0x0a, 'midpoint is not a newline');
    return text.slice(0, i) + String.fromCharCode(c === 0x61 ? 0x62 : 0x61) + text.slice(i + 1);
}

test('prefix pin shape', () => {
    assert.deepEqual(Object.keys(PIN), ['file', 'cut', 'regions']);
    assert.equal(PIN.file, 'LogLogN.js');
    assert.equal(PIN.cut, '25a7ad1');
    assert.deepEqual(PIN.regions.map((p) => p.name), ['prefix', 'XFastTrie', 'YFastTrie']);
    for (const p of PIN.regions) {
        assert.deepEqual(Object.keys(p), ['name', 'from', 'to', 'bytes', 'sha256']);
        assert.match(p.from, /^\/\/ --- [A-Za-z]+ \(0\.[234]\.0\)$/);
        assert.match(p.sha256, /^[0-9a-f]{64}$/);
        assert.ok(Number.isInteger(p.bytes) && p.bytes > 4096);
    }
    assert.equal(pinOf('prefix').from, '// --- StratifiedBitset (0.2.0)');
    assert.equal(pinOf('prefix').to, VEB);
    assert.equal(pinOf('XFastTrie').to, NEXT);
    assert.equal(pinOf('YFastTrie').to, NEXT);
    assert.ok(pinOf('prefix').bytes > pinOf('XFastTrie').bytes + pinOf('YFastTrie').bytes,
        'the prefix spans both member regions');
});

test('live LogLogN.js matches every prefix pin', () => {
    const res = checkAll(LIVE);
    for (const p of PIN.regions) {
        assert.equal(res[p.name].reason, '', p.name);
        assert.equal(res[p.name].ok, true, p.name);
        assert.ok(region(LIVE, p.from, p.to).endsWith('}\n'), p.name + ' ends at a class close');
    }
    const pre = region(LIVE, pinOf('prefix').from, VEB);
    assert.ok(pre.includes(region(LIVE, pinOf('XFastTrie').from, NEXT)), 'XFastTrie inside the prefix');
    assert.ok(pre.endsWith(region(LIVE, pinOf('YFastTrie').from, NEXT)), 'YFastTrie closes the prefix');
});

test('control: a one-character mutation inside XFastTrie FAILS (prefix + XFastTrie)', () => {
    const mut = mutateMid(LIVE, pinOf('XFastTrie'));
    assert.equal(mut.length, LIVE.length);
    const res = checkAll(mut);
    assert.equal(allOk(res), false);
    assert.match(res.XFastTrie.reason, /^sha256 /, 'same length: only the hash can see it');
    assert.match(res.prefix.reason, /^sha256 /);
    assert.equal(res.YFastTrie.ok, true, 'the pin is local: YFastTrie untouched');
});

test('control: a one-character mutation inside YFastTrie FAILS (prefix + YFastTrie)', () => {
    const mut = mutateMid(LIVE, pinOf('YFastTrie'));
    assert.equal(mut.length, LIVE.length);
    const res = checkAll(mut);
    assert.equal(allOk(res), false);
    assert.match(res.YFastTrie.reason, /^sha256 /, 'same length: only the hash can see it');
    assert.match(res.prefix.reason, /^sha256 /);
    assert.equal(res.XFastTrie.ok, true, 'the pin is local: XFastTrie untouched');
});

test('control: a grown region (an extra line inside the prefix) FAILS', () => {
    // inside XFastTrie, just before the YFastTrie marker
    const y = LIVE.indexOf(pinOf('YFastTrie').from);
    const grownX = LIVE.slice(0, y - 1) + '// tail\n' + LIVE.slice(y - 1);
    const rx = checkAll(grownX);
    assert.match(rx.XFastTrie.reason, /^bytes /);
    assert.match(rx.prefix.reason, /^bytes /);
    assert.equal(rx.YFastTrie.ok, true);
    // at the end of the prefix (end of YFastTrie)
    const end = LIVE.indexOf(pinOf('prefix').from) + pinOf('prefix').bytes;
    const grownY = LIVE.slice(0, end) + '// tail\n' + LIVE.slice(end);
    const ry = checkAll(grownY);
    assert.match(ry.YFastTrie.reason, /^bytes /);
    assert.match(ry.prefix.reason, /^bytes /);
    assert.equal(ry.XFastTrie.ok, true);
});

test('control: a missing marker FAILS closed', () => {
    for (const p of PIN.regions) {
        const gone = LIVE.replace(p.from, p.from.replace('.0)', '.x)'));
        assert.equal(count(gone, p.from), 0);
        const res = checkAll(gone);
        assert.equal(res[p.name].ok, false, p.name);
        assert.equal(res[p.name].reason, 'marker missing or not unique', p.name);
    }
    assert.equal(allOk(checkAll('')), false);
});

test('control: a duplicated marker FAILS closed', () => {
    for (const p of PIN.regions) {
        const twice = LIVE + '\n' + p.from + '\n';
        const res = checkAll(twice);
        assert.equal(res[p.name].ok, false, p.name);
        assert.equal(res[p.name].reason, 'marker missing or not unique', p.name);
    }
    // the named end marker twice (two vEBTree sections) is ambiguous too
    const veb2 = LIVE + VEB + ' ---\nexport class A {}\n' + VEB + ' ---\nexport class B {}\n';
    assert.equal(checkAll(veb2).prefix.reason, 'marker missing or not unique');
    // the end marker ahead of the start marker is not an end
    const s = LIVE.indexOf(pinOf('prefix').from);
    const early = LIVE.slice(0, s) + VEB.slice(1) + ' ---\n' + LIVE.slice(s);
    assert.equal(checkAll(early).prefix.reason, 'marker missing or not unique');
});

test('pass control: an appended vEBTree section keeps every pin', () => {
    // the pre-vEB cut of LIVE (LIVE itself once the real vEB section exists)
    const PRE = count(LIVE, VEB) === 1 ? LIVE.slice(0, LIVE.indexOf(VEB)) : LIVE;
    const appended = PRE + '\n// --- vEBTree (0.5.0) ---\nexport class vEBTree {}\n';
    const res = checkAll(appended);
    for (const p of PIN.regions) {
        assert.equal(res[p.name].reason, '', p.name);
        assert.equal(res[p.name].ok, true, p.name);
    }
    // without the vEB marker the same appended code would grow the prefix
    const unmarked = PRE + '\nexport class vEBTree {}\n';
    assert.match(checkAll(unmarked).prefix.reason, /^bytes /);
});
