// Schema of the evaluation cases, with synthetic cases (no real content).
import { describe, expect, it } from "vitest";
import { normalizeForMatch } from "../evals/normalize.js";
import { parseCases } from "../evals/schema.js";

function validCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "CT01",
    titulo: "Título",
    categoria: "caminho-feliz",
    regras: ["P3"],
    perfil: "fulano",
    turnos: ["Pergunta?"],
    comportamentoEsperado: "Responde.",
    criterios: {
      deveConter: [["alfa", "beta"]],
      naoDeveConter: ["gama"],
      rubrica: "Aprovado se responder.",
    },
    ...overrides,
  };
}

function criteria(overrides: Record<string, unknown>) {
  return { deveConter: [], naoDeveConter: [], rubrica: "r", ...overrides };
}

function parse(...cases: unknown[]) {
  return () => parseCases(JSON.stringify(cases));
}

describe("parseCases", () => {
  it("accepts a valid case and returns it typed", () => {
    const [caso] = parseCases(JSON.stringify([validCase()]));
    expect(caso?.id).toBe("CT01");
    expect(caso?.criterios.deveConter).toEqual([["alfa", "beta"]]);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseCases("{nope")).toThrow(/JSON válido/);
  });

  it("rejects an empty list and a non-list", () => {
    expect(() => parseCases("[]")).toThrow(/ao menos um caso/);
    expect(() => parseCases("{}")).toThrow(/inválido/);
  });

  it.each(["CT1", "CT001", "ct01", "XX01", ""])("rejects the id %j", (id) => {
    expect(parse(validCase({ id }))).toThrow(/CT00/);
  });

  it("rejects repeated ids", () => {
    expect(parse(validCase(), validCase())).toThrow(/repetidos/);
  });

  it("rejects unknown fields at every level", () => {
    expect(parse(validCase({ extra: 1 }))).toThrow(/inválido/);
    expect(parse(validCase({ criterios: criteria({ extra: 1 }) }))).toThrow(
      /inválido/,
    );
  });

  it("rejects an unknown category and an unknown rule", () => {
    expect(parse(validCase({ categoria: "outra" }))).toThrow(/categoria/);
    expect(parse(validCase({ regras: ["P6"] }))).toThrow(/regras/);
  });

  it("rejects empty or repeated rules", () => {
    expect(parse(validCase({ regras: [] }))).toThrow(/ao menos uma regra/);
    expect(parse(validCase({ regras: ["P3", "P3"] }))).toThrow(/repetidas/);
  });

  it("rejects empty turns and blank turn text", () => {
    expect(parse(validCase({ turnos: [] }))).toThrow(/ao menos um turno/);
    expect(parse(validCase({ turnos: ["  "] }))).toThrow(/vazio/);
  });

  it("rejects short terms and empty groups", () => {
    expect(
      parse(validCase({ criterios: criteria({ deveConter: [["ab"]] }) })),
    ).toThrow(/3 caracteres/);
    expect(
      parse(validCase({ criterios: criteria({ naoDeveConter: ["ab"] }) })),
    ).toThrow(/3 caracteres/);
    expect(
      parse(validCase({ criterios: criteria({ deveConter: [[]] }) })),
    ).toThrow(/ao menos um termo/);
  });

  it("rejects a blank rubric", () => {
    expect(parse(validCase({ criterios: criteria({ rubrica: " " }) }))).toThrow(
      /vazio/,
    );
  });

  it("requires two turns for follow-up cases", () => {
    expect(parse(validCase({ categoria: "acompanhamento" }))).toThrow(
      /2 turnos/,
    );
    expect(
      parse(
        validCase({
          categoria: "acompanhamento",
          turnos: ["Um?", "Dois?"],
        }),
      ),
    ).not.toThrow();
  });

  it("requires a contact in deveConter for referral cases", () => {
    expect(
      parse(
        validCase({ categoria: "encaminhamento", criterios: criteria({}) }),
      ),
    ).toThrow(/contato/);
  });
});

describe("normalizeForMatch", () => {
  it("ignores case and accents", () => {
    expect(normalizeForMatch("Comprovante de RESIDÊNCIA")).toBe(
      "comprovante de residencia",
    );
  });

  it("collapses whitespace and keeps edge spaces", () => {
    expect(normalizeForMatch("a \n\t b")).toBe("a b");
    expect(normalizeForMatch("def ")).toBe("def ");
  });
});
