/**
 * @zakkster/lite-loglogn -- QA fake (F10): BigUniverse.test.js stand-in: SIGKILLs itself
 * Not a test file; consumed only by test/WorkerFakes.test.js.
 */

process.kill(process.pid, 'SIGKILL');
