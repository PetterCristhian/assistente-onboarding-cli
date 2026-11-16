import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("parseConfig: key with white space inside", () => {
  const half = KEY.slice(0, 20);
  const rest = KEY.slice(20);

  it.each([
    ["a space", `${half} ${rest}`],
    ["a tab", `${half}\t${rest}`],
    ["a line break", `${half}\n${rest}`],
    ["a CRLF line break", `${half}\r\n${rest}`],
    ["a no-break space", `${half} ${rest}`],
    ["a space, with spaces around too", `  ${half} ${rest}\n`],
    ["two keys in a row", `${KEY} ${fakeOpenAiKey("B")}`],
    ["a short value", "minha chave"],
  ])("rejects a key with %s, without echoing it", (_label, value) => {
    const message = configErrorMessage({ OPENAI_API_KEY: value });

    expect(message).toBe(
      'Configuração inválida: OPENAI_API_KEY contém espaço, tabulação ou quebra de linha no meio do valor (o valor não é exibido). Cole a chave inteira em uma única linha, sem espaços, no ".env" ou na variável de ambiente.',
    );
    expect(message).not.toContain(half.slice(0, 8));
    expect(message).not.toContain(rest.slice(-8));
    expect(message).not.toContain("minha");
  });

  it("still accepts white space only around the key", () => {
    expect(parseConfig({ OPENAI_API_KEY: ` \t${KEY}\r\n` }).openaiApiKey).toBe(
      KEY,
    );
  });

  it("reports it first, and never echoes a piece of the key from another variable", () => {
    const message = configErrorMessage({
      OPENAI_API_KEY: `${half} ${rest}`,
      RETRY_MAX_ATTEMPTS: half,
      OPENAI_REASONING_EFFORT: rest,
    });
    const lines = message.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("OPENAI_API_KEY contém espaço");
    expect(message).not.toContain(half);
    expect(message).not.toContain(rest);
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

  it.each([
    ["spaces", (key: string) => `  ${key}  `],
    ["a tab and a line break", (key: string) => `\t${key}\n`],
    ["double quotes", (key: string) => `"${key}"`],
    ["single quotes", (key: string) => `'${key}'`],
    ["spaces and quotes", (key: string) => `  "${key}"  `],
    ["quotes and inner spaces", (key: string) => `" ${key} "`],
  ])(
    "never echoes a key outside the usual shape when OPENAI_API_KEY has %s around it",
    (_label, wrap) => {
      const plain = "minha-chave-azure-0123456789";
      const message = configErrorMessage({
        OPENAI_API_KEY: wrap(plain),
        RETRY_MAX_ATTEMPTS: plain,
        OPENAI_REASONING_EFFORT: ` ${plain} `,
      });

      expect(message).toContain("RETRY_MAX_ATTEMPTS");
      expect(message).toContain("OPENAI_REASONING_EFFORT");
      expect(message).toContain('(valor recebido: "[REDACTED]")');
      expect(message).not.toContain(plain);
      expect(message).not.toContain("minha-chave");
    },
  );

  it("never echoes the quoted form of the key either", () => {
    const plain = "minha-chave-azure-0123456789";
    const message = configErrorMessage({
      OPENAI_API_KEY: `"${plain}"`,
      RETRY_MAX_ATTEMPTS: `"${plain}"`,
    });

    expect(message).not.toContain("minha-chave");
  });

  it("replaces control characters of the received value by a visible marker", () => {
    const message = configErrorMessage({
      OPENAI_API_KEY: KEY,
      RETRY_MAX_ATTEMPTS:
        "1\u001b[2J\u001b[31mx\r\ny\u0007\u0000\u009b\u202e\u2028z",
      OPENAI_REASONING_EFFORT: "a\nConfiguração inválida: falsa",
    });

    expect(message).toContain(
      '(valor recebido: "1\ufffd[2J\ufffd[31mx\ufffd\ufffdy\ufffd\ufffd\ufffd\ufffd\ufffdz")',
    );
    expect(message).toContain('"a\ufffdConfiguração inválida: falsa"');
    // One line per problem: the value cannot add a line of its own.
    expect(message.split("\n")).toHaveLength(2);
    expect(message.replaceAll("\n", "")).not.toMatch(/\p{Cc}|\p{Cf}/u);
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

  describe("with a .env in the wrong encoding", () => {
    const ENCODING_MESSAGE = 'salve o ".env" em UTF-8 sem BOM';
    const secretLine = `OPENAI_API_KEY=${KEY}\r\n`;

    function utf16(text: string, bigEndian = false): Uint8Array {
      const bytes = Buffer.from(text, "utf16le");
      return bigEndian ? bytes.swap16() : bytes;
    }

    function loadMessage(head: Uint8Array, env: EnvSource = {}): string {
      try {
        loadConfig({
          env,
          loadEnvFile: () => {},
          readEnvFileHead: () => head,
          envFilePath: "/tmp/projeto/.env",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return error instanceof Error ? error.message : "";
      }
      throw new Error("loadConfig should have thrown");
    }

    it.each([
      [
        "a UTF-8 BOM",
        () =>
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(secretLine),
          ]),
      ],
      ["UTF-16LE with BOM", () => utf16(`\ufeff${secretLine}`)],
      ["UTF-16LE without BOM", () => utf16(secretLine)],
      ["UTF-16BE with BOM", () => utf16(`\ufeff${secretLine}`, true)],
      ["UTF-16BE without BOM", () => utf16(secretLine, true)],
    ])("explains the problem for %s, without the content", (_label, build) => {
      const message = loadMessage(build().subarray(0, 64));

      expect(message).toContain(ENCODING_MESSAGE);
      expect(message).toContain("OPENAI_API_KEY");
      expect(message).toContain("PowerShell 5");
      expect(message).not.toContain("não está definida");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(KEY.slice(0, 8));
      expect(message).not.toMatch(/\p{Cf}/u);
    });

    it("passes the path of the env file to the reader of the first bytes", () => {
      const readEnvFileHead = vi.fn(() => new Uint8Array([0xef, 0xbb, 0xbf]));

      expect(() =>
        loadConfig({
          env: {},
          loadEnvFile: () => {},
          readEnvFileHead,
          envFilePath: "/tmp/projeto/.env",
        }),
      ).toThrow(ENCODING_MESSAGE);
      expect(readEnvFileHead).toHaveBeenCalledTimes(1);
      expect(readEnvFileHead).toHaveBeenCalledWith("/tmp/projeto/.env");
    });

    it.each([
      ["plain UTF-8", () => Buffer.from("OPENAI_API_KEY=\n")],
      ["an empty file", () => new Uint8Array(0)],
      [
        "UTF-8 with accents",
        () => Buffer.from("# configuração\nOPENAI_API_KEY=\n"),
      ],
    ])("keeps the usual guidance for %s", (_label, build) => {
      const message = loadMessage(build());

      expect(message).toContain("OPENAI_API_KEY não está definida");
      expect(message).not.toContain(ENCODING_MESSAGE);
    });

    it("does not look at the bytes when the key is present", () => {
      const readEnvFileHead = vi.fn(() => new Uint8Array([0xef, 0xbb, 0xbf]));

      const config = loadConfig({
        env: { OPENAI_API_KEY: KEY },
        loadEnvFile: () => {},
        readEnvFileHead,
      });

      expect(config.openaiApiKey).toBe(KEY);
      expect(readEnvFileHead).not.toHaveBeenCalled();
    });

    it("does not look at the bytes when the env file does not exist", () => {
      const readEnvFileHead = vi.fn(() => new Uint8Array([0xef, 0xbb, 0xbf]));
      const load = () =>
        loadConfig({
          env: {},
          loadEnvFile: () => {
            throw errorWithCode("ENOENT");
          },
          readEnvFileHead,
        });

      expect(load).toThrow("OPENAI_API_KEY não está definida");
      expect(readEnvFileHead).not.toHaveBeenCalled();
    });

    it("keeps the usual guidance when the first bytes cannot be read", () => {
      const load = () =>
        loadConfig({
          env: {},
          loadEnvFile: () => {},
          readEnvFileHead: () => {
            throw errorWithCode("EACCES");
          },
        });

      expect(load).toThrow(ConfigError);
      expect(load).toThrow("OPENAI_API_KEY não está definida");
    });

    it("reads no byte when only the env is injected, or only the loader", () => {
      const readEnvFileHead = vi.fn(() => new Uint8Array([0xef, 0xbb, 0xbf]));

      // Only the env: no file at all, not even through an injected reader.
      expect(() => loadConfig({ env: {}, readEnvFileHead })).toThrow(
        "OPENAI_API_KEY não está definida",
      );
      expect(readEnvFileHead).not.toHaveBeenCalled();

      // Injected loader without a reader: the real disk is not touched. The
      // path is a UTF-16 file that exists, so a real read would change the
      // message.
      const folder = mkdtempSync(join(tmpdir(), "eng44-env-head-"));
      try {
        const envFilePath = join(folder, ".env");
        writeFileSync(envFilePath, utf16(`\ufeff${secretLine}`));

        expect(() =>
          loadConfig({ env: {}, loadEnvFile: () => {}, envFilePath }),
        ).toThrow("OPENAI_API_KEY não está definida");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });
  });

  it("reads no file when only the env is injected", () => {
    const spy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});

    const config = loadConfig({ env: { OPENAI_API_KEY: KEY } });

    expect(spy).not.toHaveBeenCalled();
    expect(config.openaiModel).toBe("gpt-6-luna");
  });

  it("uses process.loadEnvFile and process.env by default", () => {
    const spy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    // Blank first: a variable left in the shell of the developer (for example
    // RETRY_MAX_ATTEMPTS=abc) must not decide the result of this test.
    for (const name of ENV_VARIABLE_NAMES) {
      vi.stubEnv(name, "");
    }
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

// The tests above inject the loader. These go through the real
// process.loadEnvFile with a file on disk, in a temporary folder: the ".env"
// of the project root is never read or written.
describe("loadConfig with a real .env file", () => {
  let folder: string;
  let envFilePath: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "eng44-env-file-"));
    envFilePath = join(folder, ".env");
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * Runs loadConfig against process.env without the nine variables (the env
   * file loader never overwrites a variable that is already present), then
   * puts the environment back exactly as it was.
   */
  function loadWithCleanEnvironment(preset: Record<string, string> = {}) {
    const saved = ENV_VARIABLE_NAMES.map(
      (name) => [name, process.env[name]] as const,
    );
    for (const name of ENV_VARIABLE_NAMES) {
      delete process.env[name];
    }
    Object.assign(process.env, preset);

    try {
      return loadConfig({ envFilePath });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  }

  function loadErrorMessage(preset: Record<string, string> = {}): string {
    try {
      loadWithCleanEnvironment(preset);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return error instanceof Error ? error.message : "";
    }
    throw new Error("loadConfig should have thrown");
  }

  it("reads the key and the other values from the file", () => {
    writeFileSync(
      envFilePath,
      `OPENAI_API_KEY=${KEY}\nOPENAI_MODEL=modelo-do-arquivo\nRETRY_MAX_ATTEMPTS=5\n`,
    );

    const config = loadWithCleanEnvironment();

    expect(config.openaiApiKey).toBe(KEY);
    expect(config.openaiModel).toBe("modelo-do-arquivo");
    expect(config.retryMaxAttempts).toBe(5);
    expect(config.requestTimeoutMs).toBe(60000);
  });

  it("accepts CRLF line endings, quotes and an inline comment", () => {
    writeFileSync(
      envFilePath,
      `OPENAI_API_KEY="${KEY}"\r\nRETRY_MAX_ATTEMPTS=4 # comentário\r\n`,
    );

    const config = loadWithCleanEnvironment();

    expect(config.openaiApiKey).toBe(KEY);
    expect(config.retryMaxAttempts).toBe(4);
  });

  it("leaves the environment of the process as it was", () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${KEY}\n`);
    const before = ENV_VARIABLE_NAMES.map((name) => process.env[name]);

    loadWithCleanEnvironment();

    expect(ENV_VARIABLE_NAMES.map((name) => process.env[name])).toEqual(before);
  });

  it("gives the guidance when the file has an empty key", () => {
    writeFileSync(envFilePath, "OPENAI_API_KEY=\n");

    expect(loadErrorMessage()).toContain("OPENAI_API_KEY não está definida");
  });

  it("gives the guidance for an untouched copy of .env.example", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../.env.example", import.meta.url)),
    );
    writeFileSync(envFilePath, example);

    const message = loadErrorMessage();

    expect(message).toContain("OPENAI_API_KEY não está definida");
    expect(message.split("\n")).toHaveLength(6);
  });

  it("gives the guidance, not a read error, when the file does not exist", () => {
    const message = loadErrorMessage();

    expect(message).toContain("OPENAI_API_KEY não está definida");
    expect(message).not.toContain("Não foi possível ler");
  });

  it("gives the guidance for a file that is not in the NAME=value format", () => {
    writeFileSync(envFilePath, `isto não é um env\n{"json": true}\n: : :\n`);

    expect(loadErrorMessage()).toContain("OPENAI_API_KEY não está definida");
  });

  it("lets an empty variable of the shell block the value of the file", () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${KEY}\n`);

    const message = loadErrorMessage({ OPENAI_API_KEY: "" });

    expect(message).toContain("OPENAI_API_KEY não está definida");
    expect(message).not.toContain(KEY);
  });

  it("prefers a variable of the shell over the value of the file", () => {
    const other = fakeOpenAiKey("B");
    writeFileSync(envFilePath, `OPENAI_API_KEY=${KEY}\n`);

    const config = loadWithCleanEnvironment({ OPENAI_API_KEY: other });

    expect(config.openaiApiKey).toBe(other);
  });

  it.each([
    [
      "a UTF-8 BOM",
      (text: string) =>
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    ],
    // What `"OPENAI_API_KEY=..." > .env` writes in Windows PowerShell 5.1.
    [
      "UTF-16LE with BOM",
      (text: string) => Buffer.from(`\ufeff${text}`, "utf16le"),
    ],
    ["UTF-16LE without BOM", (text: string) => Buffer.from(text, "utf16le")],
    [
      "UTF-16BE with BOM",
      (text: string) => Buffer.from(`\ufeff${text}`, "utf16le").swap16(),
    ],
  ])(
    "explains that a real file with %s must be saved again",
    (_label, encode) => {
      writeFileSync(
        envFilePath,
        encode(`OPENAI_API_KEY=${KEY}\r\nRETRY_MAX_ATTEMPTS=5\r\n`),
      );

      const message = loadErrorMessage();

      expect(message).toContain('salve o ".env" em UTF-8 sem BOM');
      expect(message).not.toContain("não está definida");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(KEY.slice(0, 8));
    },
  );

  it("does not complain about the encoding when the shell provides the key", () => {
    writeFileSync(
      envFilePath,
      Buffer.from("\ufeffOPENAI_MODEL=x\r\n", "utf16le"),
    );

    const config = loadWithCleanEnvironment({ OPENAI_API_KEY: KEY });

    expect(config.openaiApiKey).toBe(KEY);
  });

  it("never echoes a key that the file puts in other variables", () => {
    writeFileSync(
      envFilePath,
      [
        `OPENAI_API_KEY=${KEY}`,
        `OPENAI_REASONING_EFFORT=${KEY}`,
        `REQUEST_TIMEOUT_MS=${KEY}`,
        "RETRY_MAX_ATTEMPTS=abc",
        "",
      ].join("\n"),
    );

    const message = loadErrorMessage();

    expect(message).toContain("OPENAI_REASONING_EFFORT");
    expect(message).toContain("REQUEST_TIMEOUT_MS");
    expect(message).toContain("RETRY_MAX_ATTEMPTS");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(KEY.slice(0, 12));
  });

  it("reports a .env that cannot be read as a file, without a stack trace", () => {
    mkdirSync(envFilePath);

    const message = loadErrorMessage();

    expect(message).toContain('Não foi possível ler o arquivo ".env"');
    expect(message).not.toMatch(/^\s+at /m);
  });
});
