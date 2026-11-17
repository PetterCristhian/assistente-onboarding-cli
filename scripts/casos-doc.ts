// Entry point of `npm run casos:doc` (ENG-57): writes docs/CASOS-DE-TESTE.md
// from evals/casos.json. It only wires the real pieces: the logic lives in
// evals/cases-doc-cli.ts. No key, no request. Exit code: 0 = written, 2 = not.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCasesDocCli } from "../evals/cases-doc-cli.js";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

process.exitCode = await runCasesDocCli({
  readCases: () => readFileSync(join(rootDir, "evals", "casos.json"), "utf8"),
  rootDir,
  stdout: process.stdout,
  stderr: process.stderr,
});
