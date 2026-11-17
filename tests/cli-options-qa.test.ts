// Extra checks of the start-up options (ENG-50), run against the real
// src/cli/main.ts as a child process. No network, no real key.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_VARIABLE_NAMES } from "../src/config/env.js";
import { MAX_LAYER_FILE_BYTES } from "../src/context/loaders.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAIN = join(PROJECT_ROOT, "src", "cli", "main.ts");
const TSX_LOADER = "tsx";
const CHILD_TIMEOUT_MS = 30_000;
const KEY = fakeOpenAiKey("Q");
const FIXTURE_DIR = join(PROJECT_ROOT, "tests", "fixtures", "minimal-context");

const BLANK_VARIABLES = Object.fromEntries(
  ENV_VARIABLE_NAMES.map((name) => [name, ""]),
);

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "made-up-qa50-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// cwd is a temporary folder, not the project: nothing may depend on it.
function run(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", pathToImportUrl(TSX_LOADER), MAIN, ...args],
    {
      cwd: workDir,
      encoding: "utf8",
      input: "",
      env: { ...process.env, ...BLANK_VARIABLES },
      timeout: CHILD_TIMEOUT_MS,
    },
  );
}

// "tsx" must be resolved from the project, not from the temporary cwd.
function pathToImportUrl(specifier: string): string {
  return new URL(
    `file:///${join(PROJECT_ROOT, "node_modules", specifier, "dist", "loader.mjs").replace(/\\/g, "/")}`,
  ).href;
}

function fileWith(name: string, content: string | Buffer): string {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
}

describe("options of src/cli/main.ts, QA of ENG-50", () => {
  it.each([
    ["--api-key", KEY],
    [`--api-key=${KEY}`],
    [`--openai-api-key=${KEY}`],
    [`OPENAI_API_KEY=${KEY}`],
    ["--key", KEY],
    ["-k", KEY],
    [`-k${KEY}`],
    ["--apiKey", KEY],
    [`--OPENAI_API_KEY=${KEY}`],
    [`--OPENAI_API_KEY`, KEY],
    [KEY],
    [`--show-context=${KEY}`],
    [`--help=${KEY}`],
    ["--perfil", `--${KEY}`],
    [`-${KEY}`],
  ])(
    "never echoes a key written as an argument (%s)",
    (...args) => {
      const result = run(args);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(KEY);
      expect(result.stderr).not.toContain(KEY.slice(0, 20));
      expect(result.stderr).not.toMatch(/^\s+at /m);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "prints no raw control character when a path argument has one",
    () => {
      const result = run([
        "--perfil",
        "\u001b[31mX\u001b]0;title\u0007",
        "--show-context",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr.startsWith("contexto:")).toBe(true);
      expect(result.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "accepts a layer file of exactly 64 KiB and refuses one byte more",
    () => {
      const edge = fileWith("edge.md", "a".repeat(MAX_LAYER_FILE_BYTES));
      const over = fileWith("over.md", "a".repeat(MAX_LAYER_FILE_BYTES + 1));

      const accepted = run([
        "--show-context",
        "--context-dir",
        FIXTURE_DIR,
        "--system-prompt",
        edge,
      ]);
      const refused = run([
        "--show-context",
        "--context-dir",
        FIXTURE_DIR,
        "--system-prompt",
        over,
      ]);

      expect(accepted.status).toBe(0);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("excede 64 KiB");
      expect(refused.stderr).toContain(over);
    },
    CHILD_TIMEOUT_MS,
  );

  it.each([[".env"], [".env.local"], [".ENV"], [".env.md"], [".envrc.txt"]])(
    "refuses %s as the file of the first layer without reading it",
    (name) => {
      const file = fileWith(name, "PRIVATE_MARKER_ENV_LINE=1\n");

      const result = run(["--show-context", "--system-prompt", file]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("PRIVATE_MARKER_ENV_LINE");
      expect(result.stderr).toContain("arquivo de ambiente");
    },
    CHILD_TIMEOUT_MS,
  );

  it.each([
    ["file.md:stream"],
    ["file.md::$DATA"],
    ["file.md."],
    ["file.md "],
    ["file.json"],
    ["noextension"],
  ])(
    "refuses the path %s for the first layer by its extension",
    (name) => {
      const result = run([
        "--show-context",
        "--system-prompt",
        join(workDir, name),
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("deve ter a extensão .md ou .txt");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "keeps stdout identical with and without --verbose in --show-context",
    () => {
      const plain = run(["--show-context", "--context-dir", FIXTURE_DIR]);
      const verbose = run([
        "--show-context",
        "--verbose",
        "--context-dir",
        FIXTURE_DIR,
      ]);

      expect(plain.status).toBe(0);
      expect(verbose.status).toBe(0);
      expect(verbose.stdout).toBe(plain.stdout);
      expect(plain.stderr).toBe("");
      expect(verbose.stderr.split("\n").filter(Boolean)).toHaveLength(4);
      expect(verbose.stderr).not.toContain("Mercearia");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "refuses a profile file with a field that is not known, without echoing its value",
    () => {
      const file = fileWith(
        "extra-field.json",
        JSON.stringify({
          nome: "N",
          cargo: "C",
          area: "A",
          dataInicio: "2025-05-05",
          gestor: "G",
          extra: "VALUE_THAT_MUST_NOT_BE_ECHOED",
        }),
      );

      const result = run(["--show-context", "--perfil", file]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("extra");
      expect(result.stderr).not.toContain("VALUE_THAT_MUST_NOT_BE_ECHOED");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "does not fall back from a slug to a file nor from a file to a slug",
    () => {
      const slug = run([
        "--show-context",
        "--context-dir",
        FIXTURE_DIR,
        "--perfil",
        "egon-pires.json",
      ]);
      const asFile = run([
        "--show-context",
        "--context-dir",
        FIXTURE_DIR,
        "--perfil",
        "egon-pires",
      ]);

      expect(slug.status).toBe(1);
      expect(slug.stderr).toContain("não encontrado");
      expect(asFile.status).toBe(0);
      expect(asFile.stdout).toContain("Egon Pires");
    },
    CHILD_TIMEOUT_MS,
  );
});
