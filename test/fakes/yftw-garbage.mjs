// yftw-garbage -- QA fake for test/YftWitness.test.js (Y-B2): stands in for `witness.mjs --yft --smoke`. Not a test file.
import { writeSync } from "node:fs";
writeSync(1, "this is not a witness transcript\nlorem ipsum\n");
