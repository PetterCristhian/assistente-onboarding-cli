import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const packageJsonSchema = z.object({
  type: z.string(),
  engines: z.object({ node: z.string() }),
  scripts: z.record(z.string(), z.string()),
});

function readPackageJson(): z.infer<typeof packageJsonSchema> {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
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
});
