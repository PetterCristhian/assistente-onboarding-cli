// Entry point of `npm run smoke:llm`: two short calls to the REAL API, with
// the key of the ".env". It spends credit: run it by hand, once, and never in
// a loop; it is not part of `npm run check` nor of the CI. The logic lives in
// src/llm/smoke.ts; this file only loads the configuration, reads the clock,
// reports and sets the exit code: 0 = approved, 1 = failed or configuration
// missing, 2 = an unexpected error.
//
// Nothing is written to disk, and everything printed goes through redact().
import { ConfigError, loadConfig, type AppConfig } from "../src/config/env.js";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import { formatSmokeReport, runLlmSmoke } from "../src/llm/smoke.js";
import { createRedactor, redact } from "../src/security/redact.js";

function describeUnexpected(error: unknown): string {
  // Only the message, in one line: never the error itself nor its stack.
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim();
}

async function main(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // The message is written for the user: no stack trace.
      console.error(`smoke:llm: ${error.message}`);
      return 1;
    }
    console.error(
      `smoke:llm: erro inesperado: ${redact(describeUnexpected(error))}`,
    );
    return 2;
  }

  const redactKey = createRedactor([config.openaiApiKey]);
  try {
    // The smoke test never retries, on purpose (ADR 0002, decision 11): a
    // wrong premise must show up as a failure, and no credit is spent twice.
    const client = createOpenAiLlmClient({ ...config, retryMaxAttempts: 0 });
    const report = await runLlmSmoke(client, {
      requestedModel: config.openaiModel,
      now: () => performance.now(),
      redact: redactKey,
    });
    console.log(redactKey(formatSmokeReport(report)));
    return report.passed ? 0 : 1;
  } catch (error) {
    console.error(
      `smoke:llm: erro inesperado: ${redactKey(describeUnexpected(error))}`,
    );
    return 2;
  }
}

process.exitCode = await main();
