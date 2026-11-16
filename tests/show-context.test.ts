// `npm run contexto`: prints the assembled context, with no key and no network.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_VARIABLE_NAMES } from "../src/config/env.js";
import { LAYER_MARKERS } from "../src/context/builder.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = "scripts/show-context.ts";
const CHILD_TIMEOUT_MS = 20_000;

// Every variable is set to an empty string: an empty variable is treated as
// not defined, and it keeps a local ".env" from filling it in.
const BLANK_VARIABLES = Object.fromEntries(
  ENV_VARIABLE_NAMES.map((name) => [name, ""]),
);

function runScript(cwd: string = PROJECT_ROOT) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(PROJECT_ROOT, SCRIPT)],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...BLANK_VARIABLES },
      timeout: CHILD_TIMEOUT_MS,
    },
  );
}

/** Opening and closing markers of the four layers, in the fixed order. */
function expectedMarkers(): string[] {
  return Object.values(LAYER_MARKERS).flatMap((marker) => [
    `<${marker}>`,
    `</${marker}>`,
  ]);
}

describe("scripts/show-context.ts", () => {
  it("is what `npm run contexto` runs", () => {
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string | undefined> };

    expect(pkg.scripts.contexto).toBe(`tsx ${SCRIPT}`);
  });

  it(
    "prints the four sections in order, without the key and with nothing on stderr",
    () => {
      const result = runScript();

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const markerLines = result.stdout
        .split("\n")
        .filter((line) => expectedMarkers().includes(line));
      expect(markerLines).toEqual(expectedMarkers());
      expect(result.stdout.startsWith(expectedMarkers()[0] ?? "")).toBe(true);
      expect(
        result.stdout.endsWith(`${expectedMarkers().at(-1) ?? ""}\n`),
      ).toBe(true);
      expect(result.stdout).not.toContain("\r");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "prints the same context whatever the current directory",
    () => {
      const fromRoot = runScript();
      const fromTests = runScript(join(PROJECT_ROOT, "tests"));

      expect(fromTests.status).toBe(0);
      expect(fromTests.stderr).toBe("");
      expect(fromTests.stdout).toBe(fromRoot.stdout);
    },
    CHILD_TIMEOUT_MS,
  );
});
