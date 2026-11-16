import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  ENV_VARIABLE_NAMES,
  loadConfig,
  parseConfig,
} from "../src/config/env.js";
import type { EnvSource } from "../src/config/env.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();

const INTEGER_VARIABLES = [
  "REQUEST_TIMEOUT_MS",
  "RETRY_MAX_ATTEMPTS",
  "RETRY_BASE_DELAY_MS",
  "RATE_LIMIT_MAX_REQUESTS",
  "RATE_LIMIT_WINDOW_SECONDS",
];

function configErrorMessage(source: EnvSource): string {
  try {
    parseConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error("parseConfig should have thrown");
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseConfig: defaults", () => {
  it("applies the defaults of the architecture when only the key is set", () => {
    expect(parseConfig({ OPENAI_API_KEY: KEY })).toEqual({
      openaiApiKey: KEY,
      openaiModel: "gpt-6-luna",
      openaiReasoningEffort: "low",
      evalJudgeModel: "gpt-6-luna",
      requestTimeoutMs: 60000,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 1000,
      rateLimitMaxRequests: 20,
      rateLimitWindowSeconds: 60,
    });
  });

  it("exposes the nine variable names in the documented order", () => {
    expect(ENV_VARIABLE_NAMES).toEqual([
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "OPENAI_REASONING_EFFORT",
      "EVAL_JUDGE_MODEL",
      ...INTEGER_VARIABLES,
    ]);
  });

  it("makes the judge model follow OPENAI_MODEL unless it is set", () => {
    const followed = parseConfig({ OPENAI_API_KEY: KEY, OPENAI_MODEL: "x" });
    const explicit = parseConfig({
      OPENAI_API_KEY: KEY,
      OPENAI_MODEL: "x",
      EVAL_JUDGE_MODEL: "y",
    });

    expect(followed.openaiModel).toBe("x");
    expect(followed.evalJudgeModel).toBe("x");
    expect(explicit.evalJudgeModel).toBe("y");
  });

  it("trims values and treats an empty optional variable as not set", () => {
    const config = parseConfig({
      OPENAI_API_KEY: `  ${KEY}  `,
      OPENAI_MODEL: "",
      EVAL_JUDGE_MODEL: "   ",
      OPENAI_REASONING_EFFORT: " high ",
      RETRY_MAX_ATTEMPTS: " 5 ",
      REQUEST_TIMEOUT_MS: "",
    });

    expect(config.openaiApiKey).toBe(KEY);
    expect(config.openaiModel).toBe("gpt-6-luna");
    expect(config.evalJudgeModel).toBe("gpt-6-luna");
    expect(config.openaiReasoningEffort).toBe("high");
    expect(config.retryMaxAttempts).toBe(5);
    expect(config.requestTimeoutMs).toBe(60000);
  });

  it("accepts zero retries but not a zero timeout", () => {
    const config = parseConfig({
      OPENAI_API_KEY: KEY,
      RETRY_MAX_ATTEMPTS: "0",
    });

    expect(config.retryMaxAttempts).toBe(0);
    expect(
      configErrorMessage({ OPENAI_API_KEY: KEY, REQUEST_TIMEOUT_MS: "0" }),
    ).toContain("REQUEST_TIMEOUT_MS");
  });

  it("ignores unknown variables and returns a frozen object", () => {
    const config = parseConfig({ OPENAI_API_KEY: KEY, PATH: "/usr/bin" });

    expect(Object.keys(config)).toHaveLength(9);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe("parseConfig: missing key", () => {
  it.each([
    ["absent", {}],
    ["empty", { OPENAI_API_KEY: "" }],
    ["blank", { OPENAI_API_KEY: "   " }],
  ])("explains how to fix a key that is %s", (_label, source) => {
    const message = configErrorMessage(source);

    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain('Copie o arquivo ".env.example" para ".env"');
    expect(message).toContain("Copy-Item .env.example .env");
    expect(message).toContain("cp .env.example .env");
    expect(message).toContain("não é aceita por argumento");
  });

  it("names the error ConfigError", () => {
    const error = new ConfigError("x");

    expect(error.name).toBe("ConfigError");
    expect(error).toBeInstanceOf(Error);
  });

  it("reports the missing key first, one problem per line", () => {
    const message = configErrorMessage({
      RETRY_MAX_ATTEMPTS: "abc",
      OPENAI_REASONING_EFFORT: "altissimo",
    });
    const keyAt = message.indexOf("OPENAI_API_KEY");
    const effortAt = message.indexOf("OPENAI_REASONING_EFFORT deve");
    const retryAt = message.indexOf("RETRY_MAX_ATTEMPTS deve");

    expect(keyAt).toBeGreaterThanOrEqual(0);
    expect(effortAt).toBeGreaterThan(keyAt);
    expect(retryAt).toBeGreaterThan(effortAt);
    expect(
      message
        .split("\n")
        .filter((line) => line.startsWith("Configuração inválida:")),
    ).toHaveLength(2);
  });
});

describe("parseConfig: invalid values", () => {
  it.each(["abc", "1e3", "-1", "2.5", "0x10", "99999999999999999999999"])(
    "rejects RETRY_MAX_ATTEMPTS=%s citing the variable",
    (value) => {
      const message = configErrorMessage({
        OPENAI_API_KEY: KEY,
        RETRY_MAX_ATTEMPTS: value,
      });

      expect(message).toContain("RETRY_MAX_ATTEMPTS");
    },
  );

  it("writes the full guidance for an invalid integer", () => {
    expect(
      configErrorMessage({ OPENAI_API_KEY: KEY, RETRY_MAX_ATTEMPTS: "abc" }),
    ).toBe(
      'Configuração inválida: RETRY_MAX_ATTEMPTS deve ser um número inteiro maior ou igual a 0 (valor recebido: "abc"). Corrija o valor no ".env" ou na variável de ambiente, ou remova-o para usar o padrão (3).',
    );
  });

  it.each(INTEGER_VARIABLES)(
    "cites %s when its value is not a number",
    (name) => {
      const message = configErrorMessage({
        OPENAI_API_KEY: KEY,
        [name]: "abc",
      });

      expect(message).toContain(`${name} deve ser um número inteiro`);
      expect(message).not.toContain("OPENAI_API_KEY");
      expect(message.split("\n")).toHaveLength(1);
    },
  );

  it("cites the variable and the accepted values for an invalid effort", () => {
    const message = configErrorMessage({
      OPENAI_API_KEY: KEY,
      OPENAI_REASONING_EFFORT: "altissimo",
    });

    expect(message).toBe(
      'Configuração inválida: OPENAI_REASONING_EFFORT deve ser um destes valores: none, minimal, low, medium, high, xhigh, max (valor recebido: "altissimo"). Corrija o valor no ".env" ou na variável de ambiente, ou remova-o para usar o padrão (low).',
    );
  });

  it("never echoes a key pasted into another variable", () => {
    const pasted = fakeOpenAiKey("B");
    const inModel = configErrorMessage({
      OPENAI_API_KEY: KEY,
      OPENAI_MODEL: pasted,
      RETRY_MAX_ATTEMPTS: "abc",
    });
    const inInteger = configErrorMessage({
      OPENAI_API_KEY: KEY,
      RETRY_MAX_ATTEMPTS: `${"x".repeat(30)}${pasted}`,
    });
    const sameAsKey = configErrorMessage({
      OPENAI_API_KEY: "chave-curta-123",
      OPENAI_REASONING_EFFORT: "chave-curta-123",
    });

    expect(inModel).not.toContain(pasted);
    expect(inModel).not.toContain(KEY);
    expect(inInteger).toContain("RETRY_MAX_ATTEMPTS");
    expect(inInteger).not.toContain(pasted.slice(0, 12));
    expect(sameAsKey).not.toContain("chave-curta-123");
  });

  it("truncates a long received value", () => {
    const message = configErrorMessage({
      OPENAI_API_KEY: KEY,
      RETRY_MAX_ATTEMPTS: "z".repeat(200),
    });

    expect(message).toContain(`"${"z".repeat(40)}..."`);
    expect(message).not.toContain("z".repeat(41));
  });
});

describe("loadConfig", () => {
  it("loads the env file into the injected env before validating", () => {
    const env: EnvSource = {};
    const loadEnvFile = vi.fn((path: string) => {
      expect(path).toBe("/tmp/projeto/.env");
      env.OPENAI_API_KEY = KEY;
      env.RETRY_MAX_ATTEMPTS = "7";
    });

    const config = loadConfig({
      env,
      loadEnvFile,
      envFilePath: "/tmp/projeto/.env",
    });

    expect(loadEnvFile).toHaveBeenCalledTimes(1);
    expect(loadEnvFile).toHaveBeenCalledWith("/tmp/projeto/.env");
    expect(config.openaiApiKey).toBe(KEY);
    expect(config.retryMaxAttempts).toBe(7);
  });

  it("defaults the env file to the .env at the project root", () => {
    const loadEnvFile = vi.fn<(path: string) => void>();

    loadConfig({ env: { OPENAI_API_KEY: KEY }, loadEnvFile });

    const path = loadEnvFile.mock.calls[0]?.[0] ?? "";
    expect(path).toMatch(/[\\/]\.env$/);
    expect(path).not.toMatch(/[\\/]src[\\/]/);
  });

  it("goes on when the env file does not exist", () => {
    const config = loadConfig({
      env: { OPENAI_API_KEY: KEY },
      loadEnvFile: () => {
        throw errorWithCode("ENOENT");
      },
    });

    expect(config.openaiApiKey).toBe(KEY);
  });

  it("turns any other read failure into a ConfigError", () => {
    const load = () =>
      loadConfig({
        env: { OPENAI_API_KEY: KEY },
        loadEnvFile: () => {
          throw errorWithCode("EACCES");
        },
      });

    expect(load).toThrow(ConfigError);
    expect(load).toThrow(
      'Não foi possível ler o arquivo ".env" (EACCES). Verifique se ele é um arquivo de texto no formato NOME=valor.',
    );
  });

  it("reads no file when only the env is injected", () => {
    const spy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});

    const config = loadConfig({ env: { OPENAI_API_KEY: KEY } });

    expect(spy).not.toHaveBeenCalled();
    expect(config.openaiModel).toBe("gpt-6-luna");
  });

  it("uses process.loadEnvFile and process.env by default", () => {
    const spy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    vi.stubEnv("OPENAI_API_KEY", KEY);
    vi.stubEnv("OPENAI_MODEL", "modelo-de-teste");

    try {
      const config = loadConfig();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(config.openaiApiKey).toBe(KEY);
      expect(config.openaiModel).toBe("modelo-de-teste");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("has no side effect on import", async () => {
    const spy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});

    await expect(import("../src/config/env.js")).resolves.toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
