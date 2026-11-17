// Entry point of `npm run demo:falhas` (ENG-54): shows the retry and the rate
// limit of the real client against a simulated provider on 127.0.0.1. It needs
// no key and no internet. It only wires the pieces: the logic lives in
// scripts/demo-falhas/. Exit code: 0 = every scenario matched, 1 = one did not,
// 2 = an unexpected error, 130 = interrupted with Ctrl+C.
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { DEMO_API_KEY, DEMO_TIMING } from "./demo-falhas/config.js";
import { runDemo } from "./demo-falhas/run.js";

const redactKey = createRedactor([DEMO_API_KEY]);
const controller = new AbortController();
const onInterrupt = (): void => controller.abort(new Error("interrupted"));
process.once("SIGINT", onInterrupt);

const started = performance.now();
try {
  const result = await runDemo({
    timing: DEMO_TIMING,
    writer: createSafeWriter({ redact: redactKey }),
    print: (text) => process.stdout.write(text),
    now: () => performance.now(),
    signal: controller.signal,
  });
  // The duration and the path are for the terminal only: the file stays the same.
  console.log(
    `Duração total: ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  if (result.written !== undefined) {
    console.log(`Transcrição gravada em ${result.written}`);
  }
  process.exitCode = result.exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`demo:falhas: erro inesperado: ${redactKey(message)}`);
  process.exitCode = 2;
} finally {
  process.off("SIGINT", onInterrupt);
}
