// The numbers of the demonstration (ENG-54), and the configuration of the
// real client built from them. `parseConfig` is pure: nothing here reads the
// environment or a ".env" file, so the demonstration needs no real key.
import { parseConfig } from "../../src/config/env.js";
import type { LlmClientConfig } from "../../src/llm/client.js";

/**
 * A key that exists only here and opens nothing. It has no "sk-" prefix, so
 * no scanner takes it for a credential, and it has more than 8 characters, so
 * the redactor treats it as an exact secret (docs/adr/0005, decision 25).
 */
export const DEMO_API_KEY = "chave-falsa-da-demonstracao-sem-valor";

export interface DemoTiming {
  /** New tries after the first call. */
  readonly maxRetries: number;
  /** The wait before the first new try; it doubles after each one. */
  readonly baseDelayMs: number;
  /** The `Retry-After` that the simulated provider sends, in seconds. */
  readonly retryAfterSeconds: number;
  /** The deadline of each try. */
  readonly requestTimeoutMs: number;
}

export const DEMO_TIMING: DemoTiming = {
  maxRetries: 3,
  baseDelayMs: 100,
  retryAfterSeconds: 1,
  requestTimeoutMs: 5000,
};

/** The configuration of the client of one scenario. */
export function demoClientConfig(timing: DemoTiming): LlmClientConfig {
  const config = parseConfig({
    OPENAI_API_KEY: DEMO_API_KEY,
    RETRY_MAX_ATTEMPTS: String(timing.maxRetries),
    RETRY_BASE_DELAY_MS: String(timing.baseDelayMs),
    REQUEST_TIMEOUT_MS: String(timing.requestTimeoutMs),
  });
  return config;
}
