// Run by the end-to-end test of `npm run eval` in a child process, with the
// network blocked and the global `fetch` replaced (preload-fake-fetch.ts and
// preload-qa-script.ts). The same command as scripts/eval.ts, with three
// differences that keep a test away from the real project: the files are
// written under the folder given as the first argument, the configuration
// is built from EVAL_PROBE_ENV (a JSON object) and never from the environment
// or from a ".env", and the key is a fake one. The rest of the arguments are
// the arguments of `npm run eval`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../../src/config/env.js";
import { DEFAULT_CONTEXT_DIR } from "../../src/context/loaders.js";
import { createOpenAiLlmClient } from "../../src/llm/client.js";
import { defaultSleep } from "../../src/llm/retry.js";
import { runEvalCli } from "../../evals/cli.js";

const [rootDir, ...argv] = process.argv.slice(2);
if (rootDir === undefined) {
  throw new Error("missing root directory argument");
}
const source = JSON.parse(process.env["EVAL_PROBE_ENV"] ?? "{}") as Record<
  string,
  string
>;
const casesFile = fileURLToPath(
  new URL("../../evals/casos.json", import.meta.url),
);

process.exitCode = await runEvalCli({
  argv,
  readCases: () => readFileSync(casesFile, "utf8"),
  contextDir: DEFAULT_CONTEXT_DIR,
  rootDir,
  loadConfig: () => parseConfig(source),
  createClient: (config) => createOpenAiLlmClient(config),
  nowMs: () => performance.now(),
  sleep: defaultSleep,
  now: () => new Date(),
  folderExists: (id) => existsSync(join(rootDir, "outputs", id)),
  stdout: process.stdout,
  stderr: process.stderr,
});
