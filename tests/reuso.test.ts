// The reuse guide (docs/REUSO.md) names the files that a context folder needs.
// The example folder it points to must have all of them. The command of the
// guide (--show-context --context-dir) is run against that folder in
// tests/cli-main.test.ts ("reads another context folder and nothing of the
// real one"), so it is not run again here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadCompanyData,
  loadCritiquePrompts,
  loadFallbackMessage,
  loadJudgePrompt,
  loadUserProfile,
} from "../src/context/loaders.js";
import { REVISION_VIOLATIONS_MARKER } from "../src/context/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = join(ROOT, "tests", "fixtures", "minimal-context");
const REUSO = readFileSync(join(ROOT, "docs", "REUSO.md"), "utf8");

const REQUIRED_FILES = [
  "01-instrucoes-globais.md",
  "02-politicas.md",
  "fallback.md",
  "avaliador.md",
  "revisao.md",
  "juiz.md",
];

describe("docs/REUSO.md and the example context folder", () => {
  it("names every required file and the two folders of data", () => {
    for (const name of [...REQUIRED_FILES, "03-usuario", "04-empresa"]) {
      expect(REUSO).toContain(name);
    }
    expect(REUSO).toContain("tests/fixtures/minimal-context/");
  });

  it("has every required file in the example folder", () => {
    for (const name of REQUIRED_FILES) {
      expect(existsSync(join(FIXTURE, name)), name).toBe(true);
    }
  });

  it("has at least one profile and one company document", () => {
    const profiles = readdirSync(join(FIXTURE, "03-usuario")).filter((name) =>
      name.endsWith(".json"),
    );
    const documents = readdirSync(join(FIXTURE, "04-empresa")).filter((name) =>
      name.endsWith(".md"),
    );
    expect(profiles.length).toBeGreaterThan(0);
    expect(documents.length).toBeGreaterThan(0);
  });

  it("holds the marker of the violations in revisao.md, as the guide says", () => {
    expect(REUSO).toContain(REVISION_VIOLATIONS_MARKER);
    expect(
      readFileSync(join(FIXTURE, "revisao.md"), "utf8").includes(
        REVISION_VIOLATIONS_MARKER,
      ),
    ).toBe(true);
  });

  it("is accepted by the loaders", () => {
    expect(loadCritiquePrompts(FIXTURE).revision).toContain(
      REVISION_VIOLATIONS_MARKER,
    );
    expect(loadFallbackMessage(FIXTURE)).not.toBe("");
    expect(loadJudgePrompt(FIXTURE)).not.toBe("");
    expect(loadCompanyData(join(FIXTURE, "04-empresa")).length).toBeGreaterThan(
      0,
    );
    expect(
      loadUserProfile(join(FIXTURE, "03-usuario", "dora-teixeira.json")).nome,
    ).toBe("Dora Teixeira");
  });

  it("cites the command that shows the context of another folder", () => {
    expect(REUSO).toContain("--show-context --context-dir");
  });
});
