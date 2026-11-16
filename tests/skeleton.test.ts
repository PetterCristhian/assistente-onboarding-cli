import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ENV_VARIABLE_NAMES, parseConfig } from "../src/config/env.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const packageJsonSchema = z.object({
  type: z.string(),
  engines: z.object({ node: z.string() }),
  scripts: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});

// docs/ARQUITETURA.md, section 2: any other dependency needs a justification.
const RUNTIME_DEPENDENCIES = ["openai", "zod"];
const DEV_DEPENDENCIES = [
  "@types/node",
  "eslint",
  "prettier",
  "tsx",
  "typescript",
  "typescript-eslint",
  "vitest",
];

// docs/ARQUITETURA.md, section 6 (logs/ is git-ignored and created on demand).
const ARCHITECTURE_DIRECTORIES = [
  "context/03-usuario",
  "context/04-empresa",
  "src/cli",
  "src/config",
  "src/context",
  "src/llm",
  "src/chat",
  "src/security",
  "src/logging",
  "evals",
  "scripts",
  "tests",
  "outputs/evidencias",
  "docs/adr",
];

// docs/ARQUITETURA.md, section 7: the schema is the single list of variables.
const OPTIONAL_ENV_VARIABLES = ENV_VARIABLE_NAMES.filter(
  (name) => name !== "OPENAI_API_KEY",
);

function fromRoot(relativePath: string): URL {
  return new URL(`../${relativePath}`, import.meta.url);
}

function readEnvExampleLines(): string[] {
  return readFileSync(fromRoot(".env.example"), "utf8").split(/\r?\n/);
}

function readPackageJson(): z.infer<typeof packageJsonSchema> {
  const raw = readFileSync(fromRoot("package.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  return packageJsonSchema.parse(parsed);
}

describe("project skeleton", () => {
  it("declares ESM, the supported Node range and the gate scripts", () => {
    const pkg = readPackageJson();

    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.chat).toBe("tsx src/cli/main.ts");
    expect(pkg.scripts["check:secrets"]).toBe("tsx scripts/check-secrets.ts");

    const check = pkg.scripts.check ?? "";
    const lintAt = check.indexOf("npm run lint");
    const typecheckAt = check.indexOf("npm run typecheck");
    const testAt = check.indexOf("npm run test");
    const secretsAt = check.indexOf("npm run check:secrets");

    expect(lintAt).toBeGreaterThanOrEqual(0);
    expect(typecheckAt).toBeGreaterThan(lintAt);
    expect(testAt).toBeGreaterThan(typecheckAt);
    expect(secretsAt).toBeGreaterThan(testAt);
  });

  it("runs on a supported Node.js version", () => {
    const major = Number(process.versions.node.split(".")[0]);

    expect(major).toBeGreaterThanOrEqual(22);
  });

  it("depends only on the packages listed in the architecture", () => {
    const pkg = readPackageJson();

    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      [...RUNTIME_DEPENDENCIES].sort(),
    );
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(
      [...DEV_DEPENDENCIES].sort(),
    );
  });

  it("chains the gate with && so that a failing step fails the gate", () => {
    const check = readPackageJson().scripts.check ?? "";

    expect(check).toContain("&&");
    expect(check).not.toMatch(/\|\||;|(?<!&)&(?!&)/);
  });

  it.each(ARCHITECTURE_DIRECTORIES)("has the %s directory", (directory) => {
    const location = fromRoot(directory);

    expect(existsSync(location)).toBe(true);
    expect(statSync(location).isDirectory()).toBe(true);
  });

  it.each(ARCHITECTURE_DIRECTORIES)(
    "keeps .gitkeep in %s only while the directory is empty",
    (directory) => {
      const entries = readdirSync(fromRoot(directory));

      if (entries.includes(".gitkeep")) {
        expect(entries).toEqual([".gitkeep"]);
      }
    },
  );

  it("keeps .env.example complete and without a real credential", () => {
    const lines = readEnvExampleLines();

    expect(lines).toContain("OPENAI_API_KEY=");
    expect(lines.filter((line) => /^\s*OPENAI_API_KEY\s*=/.test(line))).toEqual(
      ["OPENAI_API_KEY="],
    );
    for (const name of OPTIONAL_ENV_VARIABLES) {
      const pattern = new RegExp(`^#? ?${name}=`);
      expect(lines.some((line) => pattern.test(line))).toBe(true);
    }
  });

  it("documents in .env.example exactly the variables of the schema", () => {
    const documented = readEnvExampleLines().flatMap((line) => {
      const name = /^#? ?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      return name === undefined ? [] : [name];
    });

    expect(documented.sort()).toEqual([...ENV_VARIABLE_NAMES].sort());
  });

  it("shows in .env.example the same defaults that the schema applies", () => {
    const base = { OPENAI_API_KEY: fakeOpenAiKey() };
    const examples = readEnvExampleLines().flatMap((line) => {
      const match = /^# ([A-Z][A-Z0-9_]*)=(.+)$/.exec(line);
      const name = match?.[1];
      const value = match?.[2];
      return name === undefined || value === undefined ? [] : [{ name, value }];
    });

    // Every optional variable except EVAL_JUDGE_MODEL, whose example is empty.
    expect(examples.map((example) => example.name).sort()).toEqual(
      OPTIONAL_ENV_VARIABLES.filter(
        (name) => name !== "EVAL_JUDGE_MODEL",
      ).sort(),
    );
    for (const { name, value } of examples) {
      expect(parseConfig({ ...base, [name]: value })).toEqual(
        parseConfig(base),
      );
    }
  });
});
