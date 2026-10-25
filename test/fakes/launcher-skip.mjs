/**
 * @zakkster/lite-loglogn -- QA control (F10): BigUniverse.test.js stand-in whose
 * only tests are skipped / todo (the launcher must exit nonzero: it ran no test of
 * its own). Not a test file.
 */

import test from 'node:test';

test('skipped', { skip: 'fake' }, () => {});
test('todo', { todo: 'fake' }, () => {});
