// What `npm run casos:doc` does, with the world passed in: the text of the
// cases, the root folder and the terminal. The entry point (scripts/casos-doc.ts)
// only wires the real ones. It needs no key and makes no request.
//
// Exit codes: 0 = the document was written; 2 = it was not (invalid cases or a
// failure to write). The error is one redacted line, never a stack.
import { sanitizeForTerminal, type TextSink } from "../src/cli/renderer.js";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { CASES_DOC_FILE, renderCasesDoc } from "./cases-doc.js";
import { parseCases } from "./schema.js";

export interface CasesDocCliDeps {
  /** The text of evals/casos.json. */
  readonly readCases: () => string;
  /** The project root. Default: the real one. */
  readonly rootDir?: string;
  readonly stdout: TextSink;
  readonly stderr: TextSink;
}

export async function runCasesDocCli(deps: CasesDocCliDeps): Promise<number> {
  // No key is involved here; the writer still applies the base pattern.
  const redactText = createRedactor([]);
  try {
    const cases = parseCases(deps.readCases());
    const writer = createSafeWriter({
      redact: redactText,
      ...(deps.rootDir === undefined ? {} : { rootDir: deps.rootDir }),
      extraFiles: [CASES_DOC_FILE],
    });
    await writer.writeText(CASES_DOC_FILE, renderCasesDoc(cases));
    deps.stdout.write(`Gerado ${CASES_DOC_FILE} (${cases.length} casos).\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const oneLine = redactText(message).replace(/\s+/g, " ").trim();
    deps.stderr.write(`casos:doc: ${sanitizeForTerminal(oneLine)}\n`);
    return 2;
  }
}
