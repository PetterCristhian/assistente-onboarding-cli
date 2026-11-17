// Run by the end-to-end test of the demonstration in a child process, with
// tests/helpers/preload-loopback-only.ts: the same demonstration as
// `npm run demo:falhas`, but writing the transcript under the folder given as
// the first argument instead of the project root.
import { createRedactor } from "../../src/security/redact.js";
import { createSafeWriter } from "../../src/security/safe-writer.js";
import { DEMO_API_KEY, DEMO_TIMING } from "../../scripts/demo-falhas/config.js";
import { runDemo } from "../../scripts/demo-falhas/run.js";

const rootDir = process.argv[2];
if (rootDir === undefined) {
  throw new Error("missing root directory argument");
}

const result = await runDemo({
  timing: DEMO_TIMING,
  writer: createSafeWriter({
    redact: createRedactor([DEMO_API_KEY]),
    rootDir,
  }),
  print: (text) => process.stdout.write(text),
  now: () => performance.now(),
});
process.exitCode = result.exitCode;
