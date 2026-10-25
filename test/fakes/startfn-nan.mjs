/**
 * @zakkster/lite-loglogn -- QA fake (F10): startFn body: asserts on a NaN measurement
 * Not a test file; consumed only by test/WorkerFakes.test.js.
 */

export default function body({ assert }) {
    const measured = Number.NaN;
    assert.ok(measured === 1, 'measured ' + measured);
}
