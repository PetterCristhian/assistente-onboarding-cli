// Structure of the global instructions (layer 1 of
// docs/adr/0003-contexto-em-quatro-camadas.md): role, tone and format only,
// with no company data and no policy rule.
import { describe, expect, it } from "vitest";
import { headings, readContextFile } from "./helpers/context-files.js";

const DOCUMENT = "01-instrucoes-globais.md";
const SECTIONS = ["Papel", "Tom", "Formato das respostas"];

function readDocument(): string {
  return readContextFile(DOCUMENT);
}

describe("global instructions", () => {
  it("has one title, on the first line", () => {
    const content = readDocument();

    expect(content.split("\n")[0]).toMatch(/^# \S/);
    expect(headings(content, 1)).toHaveLength(1);
  });

  it("has exactly the three sections, in order", () => {
    const content = readDocument();
    const levels = content
      .split("\n")
      .filter((line) => /^#+(?:\s|$)/.test(line))
      .map((line) => line.indexOf(" "));

    expect(headings(content, 2)).toEqual(SECTIONS);
    expect(levels).toEqual([1, ...SECTIONS.map(() => 2)]);
  });

  it("holds no number, of any script", () => {
    expect(readDocument()).not.toMatch(/\p{N}/u);
  });

  it.each(["@", "http", "R$"])("does not contain %s", (marker) => {
    expect(readDocument().toLowerCase()).not.toContain(marker.toLowerCase());
  });

  it("names no policy rule", () => {
    expect(readDocument()).not.toMatch(/\bP[1-5]\b/);
  });
});
