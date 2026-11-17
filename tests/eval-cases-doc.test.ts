// docs/CASOS-DE-TESTE.md: the renderer, the freshness of the versioned file and
// the entry point (ENG-57, part 3; F11).
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCasesDocCli } from "../evals/cases-doc-cli.js";
import { renderCasesDoc } from "../evals/cases-doc.js";
import { inlineText } from "../evals/markdown.js";
import { CATEGORIES, parseCases, type Caso } from "../evals/schema.js";

const CASES_TEXT = readFileSync(
  new URL("../evals/casos.json", import.meta.url),
  "utf8",
);
const cases = parseCases(CASES_TEXT);
const DOC_URL = new URL("../docs/CASOS-DE-TESTE.md", import.meta.url);

/** What the document shows for a text that comes from the JSON. */
const shown = (value: string): string =>
  inlineText(value, Number.MAX_SAFE_INTEGER);

describe("renderCasesDoc", () => {
  it("is deterministic: the same cases give the same text, in LF, ending with one break", () => {
    const first = renderCasesDoc(cases);

    expect(renderCasesDoc(cases)).toBe(first);
    expect(first).not.toContain("\r");
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
    expect(first).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });

  it("says that it is generated and must not be edited by hand", () => {
    expect(renderCasesDoc(cases)).toContain(
      "Gerado por `npm run casos:doc` a partir de `evals/casos.json`; não edite à mão.",
    );
  });

  it("shows every field that F11 asks for, for each one of the 12 cases", () => {
    const doc = renderCasesDoc(cases);

    expect(cases).toHaveLength(12);
    for (const caso of cases) {
      const section =
        doc.split(`\n## ${caso.id}: `)[1]?.split("\n## ")[0] ?? "";
      expect(section, caso.id).toContain(shown(caso.titulo));
      expect(section, caso.id).toContain(`Categoria: ${caso.categoria}`);
      expect(section, caso.id).toContain(
        `Regras exercitadas: ${caso.regras.join(", ")}`,
      );
      expect(section, caso.id).toContain(`Perfil: ${caso.perfil}`);
      caso.turnos.forEach((turn, index) => {
        expect(section, caso.id).toContain(`${index + 1}. ${shown(turn)}`);
      });
      expect(section, caso.id).toContain(shown(caso.comportamentoEsperado));
      expect(section, caso.id).toContain(shown(caso.criterios.rubrica));
      caso.criterios.deveConter.forEach((group, index) => {
        expect(section, caso.id).toContain(
          `Grupo ${index + 1}: ${group.map(shown).join(" ou ")}`,
        );
      });
      for (const term of caso.criterios.naoDeveConter) {
        expect(section, caso.id).toContain(`  - ${shown(term)}`);
      }
      if (caso.criterios.deveConter.length > 0) {
        expect(section, caso.id).toContain("pelo menos um de");
      }
      expect(section, caso.id).toContain("Rubrica do juiz");
    }
  });

  it("states the absence of required and forbidden terms instead of an empty list", () => {
    const [first] = cases;
    const bare: Caso = {
      ...(first as Caso),
      criterios: { deveConter: [], naoDeveConter: [], rubrica: "r" },
    };
    const doc = renderCasesDoc([bare]);

    expect(doc).toContain("Deve conter: nenhum termo obrigatório.");
    expect(doc).toContain("Não deve conter: nenhum termo proibido.");
  });

  it("numbers the questions of a case with several turns", () => {
    const multi = cases.find((caso) => caso.turnos.length > 1);

    expect(multi).toBeDefined();
    expect(renderCasesDoc(cases)).toContain("Perguntas, uma por turno:");
  });

  it("reports the coverage per category with the counts and the ids of casos.json", () => {
    const doc = renderCasesDoc(cases);

    for (const category of CATEGORIES) {
      const ids = cases
        .filter((caso) => caso.categoria === category)
        .map((caso) => caso.id);
      const row = `| ${category} | ${ids.length} | ${ids.length === 0 ? "-" : ids.join(", ")} |`;

      expect(doc, category).toContain(`\n${row}\n`);
    }
    expect(doc).toContain(`| **Total** | **${cases.length}** | |`);
    for (const caso of cases) {
      expect(doc).toContain(`- ${caso.id}: ${shown(caso.titulo)} (`);
    }
  });

  it("keeps the layout when the text of a case is hostile", () => {
    const hostile = "x ```\n# Falso título\n[link](https://a.example) | y ‮";
    const [first] = cases;
    const caso: Caso = {
      ...(first as Caso),
      id: "CT99",
      titulo: hostile,
      turnos: [hostile, hostile],
      comportamentoEsperado: hostile,
      criterios: {
        deveConter: [[hostile, "b b b"]],
        naoDeveConter: [hostile],
        rubrica: hostile,
      },
    };
    const doc = renderCasesDoc([caso]);
    const lines = doc.split("\n");

    // The only headings are the ones of the layout: title, two sections, one case.
    expect(lines.filter((line) => /^#{1,6}\s/.test(line))).toHaveLength(4);
    expect(lines.filter((line) => /^\s*(?:`{3,}|~{3,})/.test(line))).toEqual(
      [],
    );
    // No backtick but the ones of the header line, no raw link or bidi mark.
    const body = lines
      .filter((line) => !line.startsWith("Gerado por"))
      .join("\n");
    expect(body).not.toMatch(/(?<!\\)`/);
    expect(body).not.toMatch(/(?<!\\)\]\(/);
    expect(body).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(body).toContain("⟦U+202E⟧");
    // The table keeps its three columns: no unescaped pipe in a row.
    const rows = lines.filter((line) => line.startsWith("| "));
    for (const row of rows) {
      expect(row.replaceAll("\\|", "").split("|")).toHaveLength(5);
    }
    // The hostile line break did not start a new block.
    expect(lines.filter((line) => line.startsWith("> "))).toHaveLength(2);
    expect(lines.filter((line) => /^\d+\. /.test(line))).toHaveLength(2);
  });
});

describe("docs/CASOS-DE-TESTE.md", () => {
  it("is the output of the renderer for evals/casos.json (rode npm run casos:doc)", () => {
    const onDisk = readFileSync(DOC_URL, "utf8").replaceAll("\r\n", "\n");

    // Not edited by hand: when this fails, run `npm run casos:doc` and commit.
    expect(
      onDisk === renderCasesDoc(cases),
      "docs/CASOS-DE-TESTE.md está desatualizado: rode npm run casos:doc",
    ).toBe(true);
  });
});

describe("runCasesDocCli", () => {
  let rootDir: string;
  let out: string;
  let err: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "eng57-casos-doc-"));
    out = "";
    err = "";
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const run = (readCases: () => string): Promise<number> =>
    runCasesDocCli({
      readCases,
      rootDir,
      stdout: { write: (text) => (out += text) },
      stderr: { write: (text) => (err += text) },
    });

  it("writes only docs/CASOS-DE-TESTE.md, with the rendered text, and exits 0", async () => {
    const code = await run(() => CASES_TEXT);

    expect(code).toBe(0);
    expect(await readdir(rootDir)).toEqual(["docs"]);
    expect(await readdir(join(rootDir, "docs"))).toEqual(["CASOS-DE-TESTE.md"]);
    expect(existsSync(join(rootDir, "outputs"))).toBe(false);
    expect(
      await readFile(join(rootDir, "docs", "CASOS-DE-TESTE.md"), "utf8"),
    ).toBe(renderCasesDoc(cases));
    expect(out).toContain("docs/CASOS-DE-TESTE.md");
    expect(err).toBe("");
  });

  it("exits 2 with one line and no stack when casos.json is invalid, writing nothing", async () => {
    const code = await run(() => '[{"id": "x"}]');

    expect(code).toBe(2);
    expect(await readdir(rootDir)).toEqual([]);
    expect(err.startsWith("casos:doc: ")).toBe(true);
    expect(err.trimEnd().split("\n")).toHaveLength(1);
    expect(err).not.toMatch(/\n\s+at |\.ts:\d+/);
    expect(out).toBe("");
  });

  it("exits 2 when casos.json cannot be read", async () => {
    const code = await run(() => {
      throw new Error("ENOENT: sem arquivo");
    });

    expect(code).toBe(2);
    expect(err).toContain("casos:doc: ENOENT: sem arquivo");
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("exits 2 when the document cannot be written", async () => {
    // A file where the folder should be: the write fails, the message is redacted.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(rootDir, "docs"), "arquivo");

    const code = await run(() => CASES_TEXT);

    expect(code).toBe(2);
    expect(err.startsWith("casos:doc: ")).toBe(true);
    expect(err).not.toMatch(/\n\s+at /);
  });
});
