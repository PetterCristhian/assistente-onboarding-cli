// Edge cases found by QA (ENG-55): Unicode in normalizeForMatch and weak spots
// of the term and profile fields in the case schema.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeForMatch } from "../evals/normalize.js";
import { parseCases } from "../evals/schema.js";

type Mutable = {
  perfil: string;
  criterios: { deveConter: string[][]; naoDeveConter: string[] };
};

function withCase(mutate: (caso: Mutable) => void): string {
  const cases = JSON.parse(
    readFileSync(new URL("../evals/casos.json", import.meta.url), "utf8"),
  ) as Mutable[];
  const target = cases[1];
  if (!target) throw new Error("CT02 missing");
  mutate(target);
  return JSON.stringify(cases);
}

describe("normalizeForMatch, Unicode", () => {
  it("treats NFC and NFD spellings as equal", () => {
    expect(normalizeForMatch("Ação".normalize("NFC"))).toBe(
      normalizeForMatch("Ação".normalize("NFD")),
    );
    expect(normalizeForMatch("ÁÉÍÓÚ Ç")).toBe("aeiou c");
  });

  it("handles dotted capital I and no-break space", () => {
    expect(normalizeForMatch("İSTANBUL")).toBe("istanbul");
    expect(normalizeForMatch("a\u00a0 \t\n b")).toBe("a b");
  });

  it("is idempotent", () => {
    for (const text of ["Ação  É", "İß\u200b", "\u0301", " def "]) {
      expect(normalizeForMatch(normalizeForMatch(text))).toBe(
        normalizeForMatch(text),
      );
    }
  });

  it("keeps edge spaces, so a term like 'def ' does not match 'undef'", () => {
    expect(normalizeForMatch("undef")).not.toContain(normalizeForMatch("def "));
    expect(normalizeForMatch("def f(x):")).toContain(normalizeForMatch("def "));
  });

  it("documents the known limits: zero-width, fullwidth and sharp s are not folded", () => {
    expect(normalizeForMatch("Car\u200bla")).not.toContain("carla");
    expect(normalizeForMatch("ＣＰＦ")).not.toContain("cpf");
    expect(normalizeForMatch("STRAßE")).not.toContain("strasse");
  });
});

describe("parseCases, weak spots", () => {
  it("is still accepted without error for the shipped file", () => {
    expect(
      parseCases(withCase(() => undefined)).map((caso) => caso.id),
    ).toHaveLength(12);
  });

  // A term that normalizes to nothing or to blanks matches every text.
  it("rejects a forbidden term made only of spaces", () => {
    expect(() =>
      parseCases(
        withCase((caso) => {
          caso.criterios.naoDeveConter = ["   "];
        }),
      ),
    ).toThrow();
  });

  it("rejects a term that normalizes to the empty string", () => {
    expect(() =>
      parseCases(
        withCase((caso) => {
          caso.criterios.deveConter = [["\u0301\u0301\u0301"]];
        }),
      ),
    ).toThrow();
  });

  it("rejects a profile name that is a path", () => {
    expect(() =>
      parseCases(
        withCase((caso) => {
          caso.perfil = "../../x";
        }),
      ),
    ).toThrow();
  });

  it("keeps accepting a term with a trailing space and a simple slug profile", () => {
    expect(() =>
      parseCases(
        withCase((caso) => {
          caso.criterios.naoDeveConter = ["def "];
          caso.perfil = "ana-souza";
        }),
      ),
    ).not.toThrow();
  });

  it("rejects profile names with slashes, dots or uppercase", () => {
    for (const perfil of ["a/b", "a\b", "ana.json", "..", "Ana", "-ana"]) {
      expect(() =>
        parseCases(
          withCase((caso) => {
            caso.perfil = perfil;
          }),
        ),
      ).toThrow();
    }
  });
});
