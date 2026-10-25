/**
 * @zakkster/lite-loglogn -- QA fake (F10): startFn body: the worker exits 0 before posting any result
 * Not a test file; consumed only by test/WorkerFakes.test.js.
 */

export default function body() {
    process.exit(0);
}
