/**
 * @zakkster/lite-loglogn -- QA fake (F10): startFn body: never returns (the kill timer must fire)
 * Not a test file; consumed only by test/WorkerFakes.test.js.
 */

export default function body() {
    for (;;) { /* spin */ }
}
