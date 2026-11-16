// Entry point of `npm run contexto`: prints the context that the model would
// receive, with the default profile. Needs no key and makes no request. The
// logic lives in src/context/; this file only reads the clock, reports and
// sets the exit code: 0 = printed, 1 = the context could not be assembled,
// 2 = an unexpected error.
import { buildContext } from "../src/context/builder.js";
import { loadContextLayers } from "../src/context/loaders.js";
import { ContextError } from "../src/context/types.js";

function main(): number {
  try {
    const layers = loadContextLayers({}, { now: () => new Date() });
    console.log(buildContext(layers).text);
    return 0;
  } catch (error) {
    if (error instanceof ContextError) {
      // The message is written for the user: no stack trace.
      console.error(`contexto: ${error.message}`);
      return 1;
    }
    // Only the message, in one line: never the error itself nor its stack.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `contexto: erro inesperado: ${message.replace(/\s+/g, " ").trim()}`,
    );
    return 2;
  }
}

process.exitCode = main();
