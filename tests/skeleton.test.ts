import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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

// docs/ARQUITETURA.md, section 7.
const OPTIONAL_ENV_VARIABLES = [
  "OPENAI_MODEL",
  "OPENAI_REASONING_EFFORT",
  "EVAL_JUDGE_MODEL",
  "REQUEST_TIMEOUT_MS",
  "RETRY_MAX_ATTEMPTS",
  "RETRY_BASE_DELAY_MS",
  "RATE_LIMIT_MAX_REQUESTS",
  "RATE_LIMIT_WINDOW_SECONDS",
];

function fromRoot(relativePath: string): URL {
  return new URL(`../${relativePath}`, import.meta.url);
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

    const check = pkg.scripts.check ?? "";
    const lintAt = check.indexOf("npm run lint");
    const typecheckAt = check.indexOf("npm run typecheck");
    const testAt = check.indexOf("npm run test");

    expect(lintAt).toBeGreaterThanOrEqual(0);
    expect(typecheckAt).toBeGreaterThan(lintAt);
    expect(testAt).toBeGreaterThan(typecheckAt);
  });

  it("runs on a supported Node.js version", () => {
    const major = Number(process.versions.node.split(".")[0]);

    expect(major).toBeGreaterThanOrEqual(22);
  });

  it("depends only on the packages listed in the architecture", () => {
    const pkg = readPackageJson();

    expect(Object.keys(pkg.dependencies).sort()).toEqual(RUNTIME_DEPENDENCIES);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(DEV_DEPENDENCIES);
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

  it("keeps .env.example complete and without a real credential", () => {
    const lines = readFileSync(fromRoot(".env.example"), "utf8").split(/\r?\n/);

    expect(lines).toContain("OPENAI_API_KEY=");
    expect(lines.filter((line) => /^\s*OPENAI_API_KEY\s*=/.test(line))).toEqual(
      ["OPENAI_API_KEY="],
    );
    for (const name of OPTIONAL_ENV_VARIABLES) {
      const pattern = new RegExp(`^#? ?${name}=`);
      expect(lines.some((line) => pattern.test(line))).toBe(true);
    }
  });
});
