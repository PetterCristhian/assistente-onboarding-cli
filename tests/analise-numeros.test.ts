// docs/ANALISE.md x resumo.json: every number of Appendix C must match the
// summary of the cited battery folder (ENG-59, F14). The summaries are immutable.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const FINAL = "2026-11-18T11-46-47Z";
const lines = readFileSync(new URL("docs/ANALISE.md", ROOT), "utf8").split(
  /\r?\n/,
);
const header = lines.findIndex((l) => l.includes("caminho no resumo.json"));
const cells = (line: string): string[] =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim().replaceAll("`", ""));
const rows = lines
  .slice(header + 2)
  .filter((l) => l.startsWith("|"))
  .map(cells);
const readFromSummary = (folder: string, path: string): unknown => {
  const file = new URL(`outputs/${folder}/resumo.json`, ROOT);
  let value: unknown = JSON.parse(readFileSync(file, "utf8"));
  for (const token of path.match(/[^.[\]]+|\[[^\]]+\]/g) ?? []) {
    const key = token.startsWith("[") ? token.slice(1, -1) : token;
    const [field, wanted] = key.split("=");
    if (Array.isArray(value)) {
      const list: unknown[] = value;
      value =
        wanted === undefined
          ? list[Number(key)]
          : list.find((x) => (x as Record<string, unknown>)[field!] === wanted);
    } else {
      value = (value as Record<string, unknown> | undefined)?.[key];
    }
  }
  return value;
};
const checked = rows.filter(([, , folder]) =>
  existsSync(new URL(`outputs/${folder}/`, ROOT)),
);
const FOLDERS: Record<string, string> = {
  B0: "2026-11-17T22-47-23Z",
  B1: "2026-11-17T22-48-43Z",
  B2: FINAL,
};
const hashIds = ["hashContexto", "hashCasos"];
const caseIds = Array.from(
  { length: 12 },
  (_, i) => `CT${String(i + 1).padStart(2, "0")}`,
);
const common = [
  "totais.passou",
  "totais.falhou",
  "taxaConsistenciaGeral.casosTodasAprovadas",
  "f13Mensuravel",
  "f13Atingido",
  "autoavaliacao.rascunhosReprovados",
  "juiz.aprovou",
  ...hashIds,
];
const required: Record<string, string[]> = {
  B0: [...common, "parcial", "porCaso[CT06].consistencia"],
  B1: [
    ...common,
    "porCaso[CT01].consistencia",
    "porCaso[CT02].consistencia",
    "autoavaliacao.violacoesPorRegra.P1",
    "autoavaliacao.violacoesPorRegra.P3",
  ],
  B2: [
    ...common,
    ...["P1", "P2", "P3", "P4", "P5"].map((r) => `porRegra[${r}].passou`),
    ...caseIds.map((c) => `porCaso[${c}].consistencia`),
  ],
};

describe("docs/ANALISE.md, Appendix C", () => {
  it("has the table and cites the final battery folder", () => {
    expect(header).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain(`outputs/${FINAL}`);
  });

  it.each(["B0", "B1", "B2"])("has enough rows for %s", (battery) => {
    expect(
      checked.filter(([id]) => id!.startsWith(`${battery}.`)).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("points only to existing folders, except manual and derived rows", () => {
    const missing = rows.filter(
      ([, , folder]) =>
        !/^(revisão manual|derivado)/.test(folder!) &&
        !checked.some((r) => r[2] === folder),
    );
    expect(
      missing,
      `pasta inexistente: ${missing.map((r) => r[0]).join(", ")}`,
    ).toEqual([]);
  });

  it.each(Object.keys(required))(
    "keeps the required ids of %s (deleting a row fails)",
    (battery) => {
      const present = new Set(
        checked.filter(([, , f]) => f === FOLDERS[battery]).map(([id]) => id),
      );
      const missing = required[battery]!.filter(
        (p) => !present.has(`${battery}.${p}`),
      );
      expect(missing, `linhas ausentes em ${battery}`).toEqual([]);
    },
  );

  it("maps the id prefix to the battery folder of the row", () => {
    for (const [id, , folder] of checked) {
      const expected = FOLDERS[id!.split(".")[0]!];
      expect(folder, `${id}: pasta da linha`).toBe(expected);
    }
  });

  it("states the key results of section 0 in the prose", () => {
    const section0 = lines
      .slice(
        lines.findIndex((l) => l.startsWith("## 0.")),
        lines.findIndex((l) => l.startsWith("## 1.")),
      )
      .join(" ");
    const read = (f: string, p: string) =>
      String(readFromSummary(FOLDERS[f]!, p));
    const phrases = [
      `${read("B1", "totais.passou")} de 36`,
      `${read("B2", "totais.passou")} de 36`,
      `${read("B1", "autoavaliacao.rascunhosReprovados")} de ${read("B1", "autoavaliacao.turnosRespondidos")}`,
      `${read("B2", "autoavaliacao.rascunhosReprovados")} de ${read("B2", "autoavaliacao.turnosRespondidos")}`,
    ];
    expect(phrases).toEqual(["30 de 36", "36 de 36", "3 de 39", "1 de 39"]);
    for (const phrase of phrases) expect(section0).toContain(phrase);
  });

  it("matches every cited value with resumo.json", () => {
    for (const [id, cited, folder, path] of checked) {
      const got = readFromSummary(folder!, path!);
      if (typeof got === "string" && got.startsWith("sha256:")) {
        expect(cited, `${id}: hash com 12 caracteres`).toMatch(
          /^[0-9a-f]{12}$/,
        );
      }
      const text =
        typeof got === "string" && got.startsWith("sha256:")
          ? got.slice(7, 7 + cited!.length)
          : String(got);
      expect(
        text,
        `${id} (${folder}, ${path}): esperado ${cited}, obtido ${String(got)}`,
      ).toBe(cited);
    }
  });
});
