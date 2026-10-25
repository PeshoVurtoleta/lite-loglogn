/**
 * @zakkster/lite-loglogn -- QA fake (F10): BigUniverse.test.js stand-in: a test that asserts on a NaN measurement
 * Not a test file; consumed only by test/WorkerFakes.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

test('nan measurement', () => {
    const measured = Number.NaN;
    assert.ok(measured === 1, 'measured ' + measured);
});
