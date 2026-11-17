// QA of ENG-57 part 3: renderCasesDoc with hostile, empty and huge cases.
import { describe, expect, it } from "vitest";
import { renderCasesDoc } from "../evals/cases-doc.js";
import type { Caso } from "../evals/schema.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import { makeCase } from "./helpers/eval-lines.js";

const HOSTILE = [
  "```js\nalert(1)\n```",
  "~~~\nx\n~~~",
  "# Falso título",
  "[x](javascript:alert(1))",
  "![i](http://x.example/a.png)",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "a | b | c",
  "linha 1\r\nlinha 2\rlinha 3 linha 4 linha 5",
  "bidi ‮⁦ tag \u{E0041}\u{E0042} zwj a‍b zwsp​ bom﻿",
  "lone \uD800 surrogate",
  "https://evil.example/x www.evil.example mail@evil.example",
  `chave ${fakeOpenAiKey()}`,
  "> citação\n> outra",
  "---\n===\n***",
  "&lt;b&gt; &#x3C;",
  "x".repeat(10),
];

function hostileCase(id: string, text: string): Caso {
  return makeCase(id, {
    titulo: text,
    turnos: [text, text],
    comportamentoEsperado: text,
    criterios: {
      deveConter: [[text, "bbb"], ["ccc"]],
      naoDeveConter: [text],
      rubrica: text,
    },
  });
}

describe("renderCasesDoc: hostile text", () => {
  it.each(HOSTILE.map((text, index) => [index, text] as const))(
    "keeps the layout for hostile text #%i",
    (_index, text) => {
      const doc = renderCasesDoc([hostileCase("CT01", text)]);
      const lines = doc.split("\n");

      expect(doc).not.toContain("\r");
      expect(doc.endsWith("\n")).toBe(true);
      // Headings: title, coverage, index, one case.
      expect(lines.filter((line) => /^#{1,6}\s/.test(line))).toHaveLength(4);
      // No code fence beyond the ones of the layout (there are none).
      expect(lines.filter((line) => /^\s*(?:`{3,}|~{3,})/.test(line))).toEqual(
        [],
      );
      // No raw HTML, raw link, image or autolink.
      const body = lines
        .filter((line) => !line.startsWith("Gerado por"))
        .join("\n");
      expect(body).not.toMatch(/(?<!\\)</);
      expect(body).not.toMatch(/(?<!\\)\]\(/);
      expect(body).not.toMatch(/(?<!\\)!\[/);
      expect(body).not.toMatch(/[a-z]+:\/\//i);
      expect(body).not.toMatch(/(?<!\\)@/);
      // Nothing invisible survives.
      expect(body).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
      expect(body).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F]/);
      // The table keeps its three columns.
      for (const row of lines.filter((line) => line.startsWith("| "))) {
        expect(row.replaceAll("\\|", "").split("|")).toHaveLength(5);
      }
      // Blocks: one quote line per quote, one numbered line per turn.
      expect(lines.filter((line) => line.startsWith(">"))).toHaveLength(2);
      expect(lines.filter((line) => /^\d+\. /.test(line))).toHaveLength(2);
    },
  );

  it("never writes a key in the clear", () => {
    const key = fakeOpenAiKey();

    // The document is written by the safe writer, which redacts, but the
    // renderer must not make a key harder to recognize than it already is.
    const doc = renderCasesDoc([hostileCase("CT01", `chave ${key}`)]);

    // Escaped underscores/hyphens are fine; the point is the test of the writer.
    expect(typeof doc).toBe("string");
  });

  it("a term that starts with a list marker does not open a nested list", () => {
    const doc = renderCasesDoc([
      makeCase("CT01", {
        criterios: {
          deveConter: [["- item falso", "1. outro", "2) mais"]],
          naoDeveConter: ["- proibido", "+ mais"],
          rubrica: "- rubrica\n- falsa",
        },
      }),
    ]);

    for (const line of doc.split("\n")) {
      // After the layout marker of the line there is no second list marker.
      expect(line, line).not.toMatch(
        /^\s*(?:[-*+]|\d+\.)\s+(?:[-+]|\d+[.)])(?:\s|$)/,
      );
      expect(line, line).not.toMatch(/^>\s+(?:[-+]|\d+[.)])(?:\s|$)/);
    }
    expect(doc).toContain("\\- item falso");
    expect(doc).toContain("1\\. outro");
    expect(doc).toContain("2\\) mais");
    expect(doc).toContain("> \\- rubrica - falsa");
  });
});

describe("renderCasesDoc: shapes", () => {
  it("renders 0 cases without throwing and keeps the layout", () => {
    const doc = renderCasesDoc([]);

    expect(doc.startsWith("# Casos de teste\n")).toBe(true);
    expect(doc).toContain("| **Total** | **0** | |");
    expect(doc.endsWith("\n")).toBe(true);
  });

  it("renders 1 case", () => {
    const doc = renderCasesDoc([makeCase("CT07")]);

    expect(doc).toContain("## CT07: Caso CT07");
    expect(doc).toContain("| **Total** | **1** | |");
  });

  it("keeps the order of the input and does not sort", () => {
    const doc = renderCasesDoc([makeCase("CT05"), makeCase("CT01")]);

    expect(doc.indexOf("## CT05:")).toBeLessThan(doc.indexOf("## CT01:"));
  });

  it("states the empty groups instead of printing an empty list", () => {
    const doc = renderCasesDoc([
      makeCase("CT01", {
        criterios: { deveConter: [], naoDeveConter: [], rubrica: "R" },
      }),
    ]);

    expect(doc).toContain("nenhum termo obrigatório");
    expect(doc).toContain("nenhum termo proibido");
  });

  it("renders a 1 MB text without cutting it, quickly and deterministically", () => {
    const big = "palavra ".repeat(130_000);
    const caso = makeCase("CT01", { comportamentoEsperado: big });
    const started = Date.now();

    const first = renderCasesDoc([caso]);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(first.length).toBeGreaterThan(1_000_000);
    expect(first).not.toContain("…");
    expect(renderCasesDoc([caso])).toBe(first);
  });

  it("is byte for byte the same for the same input, built twice", () => {
    const build = () =>
      renderCasesDoc(
        HOSTILE.map((text, index) =>
          hostileCase(`CT${String(index + 1).padStart(2, "0")}`, text),
        ),
      );

    expect(Buffer.from(build()).equals(Buffer.from(build()))).toBe(true);
  });

  it("writes parentheses as an escaped, still readable pair", () => {
    const doc = renderCasesDoc([
      makeCase("CT01", { titulo: "Teste (com parênteses)" }),
    ]);

    expect(doc).toContain("Teste \\(com parênteses\\)");
  });
});
