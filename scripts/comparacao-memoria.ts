// Entry point of `npm run eval:memoria`. It only wires the real pieces: the
// logic lives in scripts/comparacao/run.ts. It calls the real model, so it
// uses the key of OPENAI_API_KEY and costs money.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/env.js";
import { DEFAULT_CONTEXT_DIR } from "../src/context/loaders.js";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { runComparison } from "./comparacao/run.js";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const interrupt = new AbortController();
const onInterrupt = (): void => interrupt.abort(new Error("interrupted"));
process.once("SIGINT", onInterrupt);

try {
  const config = loadConfig();
  const redact = createRedactor([config.openaiApiKey]);
  process.exitCode = await runComparison({
    casesText: readFileSync(
      join(rootDir, "evals", "casos-memoria.json"),
      "utf8",
    ),
    contextDir: DEFAULT_CONTEXT_DIR,
    llm: createOpenAiLlmClient(config),
    writer: createSafeWriter({ redact }),
    redact,
    defaults: {
      maxTokens: config.compressMaxTokens,
      maxMessages: config.compressMaxMessages,
      keepMessages: config.compressKeepMessages,
      memoryMaxItems: config.memoryMaxItems,
    },
    now: () => new Date(),
    log: (line) => process.stdout.write(`${line}\n`),
    signal: interrupt.signal,
  });
} catch (error) {
  // Only the message: never the error itself (it may carry the request).
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.replace(/\s+/g, " ").trim()}\n`);
  process.exitCode = 2;
} finally {
  process.off("SIGINT", onInterrupt);
}
