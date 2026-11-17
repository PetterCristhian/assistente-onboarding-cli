import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_VARIABLE_NAMES } from "../src/config/env.js";
import {
  LAYER_MARKERS,
  POLICY_PRECEDENCE_CLAUSE,
} from "../src/context/builder.js";
import {
  DEFAULT_CONTEXT_DIR,
  listProfiles,
  loadContextLayers,
} from "../src/context/loaders.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = fakeOpenAiKey();
const CHILD_TIMEOUT_MS = 20_000;
const FIXTURE_DIR = "tests/fixtures/minimal-context";
const EXTERNAL_PROFILE = "tests/fixtures/perfil-externo.json";

// Every variable is set to an empty string: an empty variable is treated as
// not defined by the config and also keeps a local ".env" from filling it in
// (the env file loader never overwrites a variable that is already present).
const BLANK_VARIABLES = Object.fromEntries(
  ENV_VARIABLE_NAMES.map((name) => [name, ""]),
);

function runMain(
  extraArgs: string[] = [],
  variables: Record<string, string> = {},
  input = "",
) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/main.ts", ...extraArgs],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      input,
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

/** The text between the markers of one layer, markers included. */
function sectionOf(
  text: string,
  layer: keyof typeof LAYER_MARKERS,
): string | undefined {
  const marker = LAYER_MARKERS[layer];
  const start = text.indexOf(`<${marker}>`);
  const closing = `</${marker}>`;
  const end = text.indexOf(closing);
  return start === -1 || end === -1
    ? undefined
    : text.slice(start, end + closing.length);
}

function countMarkers(text: string): number {
  return Object.values(LAYER_MARKERS).reduce(
    (total, marker) =>
      total +
      (text.includes(`<${marker}>`) ? 1 : 0) +
      (text.includes(`</${marker}>`) ? 1 : 0),
    0,
  );
}

function expectUsageError(
  result: ReturnType<typeof runMain>,
  expected: string,
): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(expected);
  expect(result.stderr).toContain("Use --help");
  expect(result.stderr).not.toMatch(/^\s+at /m);
}

function expectContextError(
  result: ReturnType<typeof runMain>,
  path: string,
): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.startsWith("contexto:")).toBe(true);
  expect(result.stderr).toContain(path);
  expect(result.stderr).not.toMatch(/^\s+at /m);
}

function withTemporaryFile(
  name: string,
  content: string,
  action: (file: string) => void,
): void {
  const folder = mkdtempSync(join(tmpdir(), "made-up-cli-"));
  try {
    const file = join(folder, name);
    writeFileSync(file, content);
    action(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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

  // The key is not an option: the parser refuses it before anything else.
  it.each([
    ["--api-key <key>", ["--api-key", KEY], "opção desconhecida: --api-key"],
    [
      "--openai-api-key=<key>",
      [`--openai-api-key=${KEY}`],
      "opção desconhecida: --openai-api-key",
    ],
    [
      "OPENAI_API_KEY=<key> as an argument",
      [`OPENAI_API_KEY=${KEY}`],
      "argumentos posicionais não são aceitos",
    ],
  ])(
    "does not accept the key through %s",
    (_label, extraArgs, expected) => {
      const result = runMain(extraArgs);

      expectUsageError(result, expected);
      expect(result.stderr).not.toContain(KEY);
      expect(result.stderr).not.toContain("OPENAI_API_KEY não está definida");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "does not read the key for --help or --show-context given with a key argument",
    () => {
      for (const flag of ["--help", "--show-context"]) {
        const result = runMain([flag, "--api-key", KEY]);

        expectUsageError(result, "opção desconhecida");
        expect(result.stderr).not.toContain(KEY);
      }
    },
    CHILD_TIMEOUT_MS,
  );
});

describe("src/cli/main.ts with the key in the environment", () => {
  it(
    "greets the default profile, lists the commands and ends on /sair, never printing the key",
    () => {
      const layers = loadContextLayers({}, { now: () => new Date() });
      const result = runMain([], { OPENAI_API_KEY: KEY }, "/sair\n");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Olá, ${layers.userProfile.nome}.`);
      expect(result.stdout).toContain("/ajuda");
      expect(result.stdout).not.toContain(KEY);
      expect(result.stderr).not.toContain(KEY);
      expect(result.stderr).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "ends with 0 at the end of the input, without a question reaching the model",
    () => {
      const result = runMain([], { OPENAI_API_KEY: KEY }, "");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "greets the profile that --perfil picks",
    () => {
      const [, second] = listProfiles(DEFAULT_CONTEXT_DIR);
      const layers = loadContextLayers(
        { profile: second ?? "" },
        { now: () => new Date() },
      );
      const result = runMain(
        ["--perfil", second ?? ""],
        { OPENAI_API_KEY: KEY },
        "/sair\n",
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Olá, ${layers.userProfile.nome}.`);
      expect(result.stderr).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "prints the sources of the context to stderr with --verbose, never the key",
    () => {
      const result = runMain(
        ["--verbose", "--context-dir", FIXTURE_DIR],
        { OPENAI_API_KEY: KEY },
        "/sair\n",
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("[detalhes] instruções globais:");
      expect(result.stderr).toContain("01-instrucoes-globais.md");
      expect(result.stderr).toContain("02-politicas.md");
      expect(result.stderr).toContain("dora-teixeira.json");
      expect(result.stderr).toContain("04-empresa");
      expect(result.stderr).not.toContain(KEY);
      expect(result.stdout).not.toContain("[detalhes]");
      expect(result.stdout).not.toContain(KEY);
    },
    CHILD_TIMEOUT_MS,
  );
});

describe("src/cli/main.ts --help", () => {
  it.each([["--help"], ["-h"]])(
    "lists the options with %s and exits with 0, writing nothing to stderr",
    (flag) => {
      const result = runMain([flag]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      for (const option of [
        "--system-prompt",
        "--perfil",
        "--context-dir",
        "--show-context",
        "--verbose",
        "--help",
      ]) {
        expect(result.stdout).toContain(option);
      }
      expect(result.stdout).not.toMatch(/--api-key|--chave|--key/);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "reaches the script through the tsx command, as npm run chat does",
    () => {
      const result = spawnSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "src/cli/main.ts", "--help"],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          env: { ...process.env, ...BLANK_VARIABLES },
          timeout: CHILD_TIMEOUT_MS,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--show-context");
    },
    CHILD_TIMEOUT_MS,
  );
});

describe("src/cli/main.ts --show-context", () => {
  it(
    "prints the eight markers without a key and without writing to stderr",
    () => {
      const result = runMain(["--show-context"]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(countMarkers(result.stdout)).toBe(8);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "does not print the key when it is in the environment",
    () => {
      const result = runMain(["--show-context"], { OPENAI_API_KEY: KEY });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(KEY);
      expect(result.stderr).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "reads another context folder and nothing of the real one",
    () => {
      const real = loadContextLayers({}, { now: () => new Date() });
      const result = runMain(["--show-context", "--context-dir", FIXTURE_DIR]);

      expect(result.status).toBe(0);
      expect(countMarkers(result.stdout)).toBe(8);
      expect(result.stdout).toContain("Mercearia Fixture");
      expect(result.stdout).toContain("Nome: Dora Teixeira");
      expect(result.stdout).toContain("07h45");
      expect(result.stdout).not.toContain(real.userProfile.nome);
      expect(result.stdout).not.toContain(real.policies.slice(0, 80));
      expect(result.stdout).not.toContain(real.globalInstructions.slice(0, 80));
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "changes only the user section when --perfil changes",
    () => {
      const [first, second] = listProfiles(DEFAULT_CONTEXT_DIR);
      const a = runMain(["--show-context", "--perfil", first ?? ""]);
      const b = runMain(["--show-context", "--perfil", second ?? ""]);

      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(first).not.toBe(second);
      for (const layer of [
        "globalInstructions",
        "policies",
        "companyData",
      ] as const) {
        expect(sectionOf(a.stdout, layer)).toBeDefined();
        expect(sectionOf(a.stdout, layer)).toBe(sectionOf(b.stdout, layer));
      }
      expect(sectionOf(a.stdout, "userData")).not.toBe(
        sectionOf(b.stdout, "userData"),
      );
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "reads a profile from a file",
    () => {
      const result = runMain(["--show-context", "--perfil", EXTERNAL_PROFILE]);

      expect(result.status).toBe(0);
      expect(sectionOf(result.stdout, "userData")).toContain(
        "Nome: Fabio Externo",
      );
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "replaces only the first layer with --system-prompt, keeping the policies and their clause",
    () => {
      const real = loadContextLayers({}, { now: () => new Date() });
      withTemporaryFile(
        "informal.md",
        "Fale de modo bem informal, com gírias do dia a dia.\n",
        (file) => {
          const result = runMain(["--show-context", "--system-prompt", file]);

          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          expect(sectionOf(result.stdout, "globalInstructions")).toContain(
            "gírias do dia a dia",
          );
          expect(result.stdout).not.toContain(
            real.globalInstructions.slice(0, 80),
          );
          const policies = sectionOf(result.stdout, "policies") ?? "";
          expect(policies).toContain(POLICY_PRECEDENCE_CLAUSE);
          expect(policies).toContain(real.policies);
        },
      );
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "keeps stdout clean with --verbose, the sources going to stderr",
    () => {
      const result = runMain(["--show-context", "--verbose"]);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("[detalhes]");
      expect(countMarkers(result.stdout)).toBe(8);
      expect(result.stderr).toContain("[detalhes] perfil:");
      expect(result.stderr).toContain("[detalhes] pasta da empresa:");
    },
    CHILD_TIMEOUT_MS,
  );
});

describe("src/cli/main.ts with options that cannot be used", () => {
  it(
    "names the file of a --system-prompt that does not exist",
    () => {
      const result = runMain(["--system-prompt", "inexistente.md"]);

      expectContextError(result, "inexistente.md");
      expect(result.stderr).toContain("não encontrado");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "lists the available profiles when the name does not exist",
    () => {
      const result = runMain(["--perfil", "nao-existe"]);
      const names = listProfiles(DEFAULT_CONTEXT_DIR);

      expectContextError(result, "nao-existe");
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(result.stderr).toContain(name);
      }
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "names the file of a profile path that does not exist",
    () => {
      const result = runMain(["--perfil", "nao-existe.json"]);

      expectContextError(result, "nao-existe.json");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "names a context folder that does not exist",
    () => {
      const result = runMain(["--context-dir", "pasta-inexistente"]);

      expectContextError(result, "pasta-inexistente");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "refuses an env file as the system prompt without reading it",
    () => {
      const result = runMain(["--system-prompt", ".env"]);

      expectContextError(result, ".env");
      expect(result.stderr).toContain("arquivo de ambiente");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "refuses an unknown option, pointing to --help",
    () => {
      expectUsageError(runMain(["--nada"]), "opção desconhecida: --nada");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "refuses an option without its value",
    () => {
      expectUsageError(
        runMain(["--perfil"]),
        "a opção --perfil exige um valor",
      );
      expectUsageError(
        runMain(["--perfil", "--verbose"]),
        "a opção --perfil exige um valor",
      );
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "prints a control character of the arguments as inert text",
    () => {
      const result = runMain(["--system-prompt", "x\u001b[31my.md"]);

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("\u001b");
    },
    CHILD_TIMEOUT_MS,
  );
});
