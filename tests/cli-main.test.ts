import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_VARIABLE_NAMES } from "../src/config/env.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = fakeOpenAiKey();
const CHILD_TIMEOUT_MS = 20_000;

// Every variable is set to an empty string: an empty variable is treated as
// not defined by the config and also keeps a local ".env" from filling it in
// (the env file loader never overwrites a variable that is already present).
const BLANK_VARIABLES = Object.fromEntries(
  ENV_VARIABLE_NAMES.map((name) => [name, ""]),
);

function runMain(
  extraArgs: string[] = [],
  variables: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/main.ts", ...extraArgs],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...BLANK_VARIABLES, ...variables },
      timeout: CHILD_TIMEOUT_MS,
    },
  );
}

function expectGuidance(stderr: string): void {
  expect(stderr).toContain("OPENAI_API_KEY não está definida");
  expect(stderr).toContain('Copie o arquivo ".env.example" para ".env"');
  expect(stderr).toContain("preencha OPENAI_API_KEY");
  expect(stderr).not.toMatch(/^\s+at /m);
  expect(stderr).not.toContain("ConfigError");
}

describe("src/cli/main.ts without the key", () => {
  it(
    "exits with a non-zero code and guidance in Portuguese, without a stack trace",
    () => {
      const result = runMain();

      expect(result.status).toBe(1);
      expectGuidance(result.stderr);
      expect(result.stdout).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );

  // Issue 8 adds the argument parser; it must keep this behavior.
  it.each([
    ["--api-key <key>", ["--api-key", KEY]],
    ["--openai-api-key=<key>", [`--openai-api-key=${KEY}`]],
    ["OPENAI_API_KEY=<key> as an argument", [`OPENAI_API_KEY=${KEY}`]],
  ])(
    "does not accept the key through %s",
    (_label, extraArgs) => {
      const result = runMain(extraArgs);

      expect(result.status).toBe(1);
      expectGuidance(result.stderr);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(KEY);
    },
    CHILD_TIMEOUT_MS,
  );
});

describe("src/cli/main.ts with the key in the environment", () => {
  it(
    "starts and never prints the key",
    () => {
      const result = runMain([], { OPENAI_API_KEY: KEY });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Assistente de onboarding");
      expect(result.stdout).not.toContain(KEY);
      expect(result.stderr).not.toContain(KEY);
    },
    CHILD_TIMEOUT_MS,
  );
});
