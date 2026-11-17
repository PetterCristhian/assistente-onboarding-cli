// Entry point of `npm run eval` (ENG-56). It only wires the real pieces: the
// logic lives in evals/cli.ts. It calls the real model, so it uses the key of
// OPENAI_API_KEY and costs money. The first Ctrl+C stops in an orderly way (the
// execution in course is dropped, what was written stays); the second one
// leaves at once. Exit code: see evals/cli.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/env.js";
import { DEFAULT_CONTEXT_DIR } from "../src/context/loaders.js";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import { defaultSleep } from "../src/llm/retry.js";
import { runEvalCli } from "../evals/cli.js";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const interrupt = new AbortController();
const onInterrupt = (): void => interrupt.abort(new Error("interrupted"));
process.once("SIGINT", onInterrupt);

try {
  process.exitCode = await runEvalCli({
    argv: process.argv.slice(2),
    readCases: () => readFileSync(join(rootDir, "evals", "casos.json"), "utf8"),
    contextDir: DEFAULT_CONTEXT_DIR,
    loadConfig: () => loadConfig(),
    createClient: (config) => createOpenAiLlmClient(config),
    nowMs: () => performance.now(),
    sleep: defaultSleep,
    now: () => new Date(),
    folderExists: (id) => existsSync(join(rootDir, "outputs", id)),
    stdout: process.stdout,
    stderr: process.stderr,
    signal: interrupt.signal,
  });
} finally {
  process.off("SIGINT", onInterrupt);
}
