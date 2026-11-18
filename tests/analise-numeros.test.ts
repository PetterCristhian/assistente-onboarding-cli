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

  it("matches every cited value with resumo.json", () => {
    for (const [id, cited, folder, path] of checked) {
      const got = readFromSummary(folder!, path!);
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
