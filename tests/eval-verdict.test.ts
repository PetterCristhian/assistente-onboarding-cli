import { describe, expect, it } from "vitest";
import {
  EVALUATION_UNAVAILABLE,
  FALLBACK_REASON,
  buildVerdict,
  containsTerm,
  hasEmoji,
  runChecks,
  type Outcome,
} from "../evals/verdict.js";
import type { Caso } from "../evals/schema.js";

function makeCase(criterios: Partial<Caso["criterios"]> = {}): Caso {
  return {
    id: "CT99",
    titulo: "Caso sintético",
    categoria: "caminho-feliz",
    regras: ["P3"],
    perfil: "dora-teixeira",
    turnos: ["Pergunta?"],
    comportamentoEsperado: "Algo.",
    criterios: {
      deveConter: [],
      naoDeveConter: [],
      rubrica: "Rubrica.",
      ...criterios,
    },
  };
}

function answered(
  text: string,
  overrides: Partial<Extract<Outcome, { kind: "answered" }>> = {},
): Outcome {
  return {
    kind: "answered",
    text,
    origin: "rascunho",
    evaluationFailed: false,
    ...overrides,
  };
}

describe("containsTerm", () => {
  it("ignores case, accents and runs of blanks", () => {
    expect(containsTerm("Prazo: DOIS  dias\núteis", "dois dias uteis")).toBe(
      true,
    );
    expect(containsTerm("Ação", "ACAO")).toBe(true);
  });

  it("does not trim: a term with a trailing space needs the space", () => {
    expect(containsTerm("undef", "def ")).toBe(false);
    expect(containsTerm("def f(x):", "def ")).toBe(true);
  });

  it("sees through zero-width characters, fullwidth letters and the sharp s", () => {
    expect(containsTerm("Car​la Mendes", "Carla Mendes")).toBe(true);
    expect(containsTerm("ＣＰＦ", "cpf")).toBe(true);
    expect(containsTerm("Straße", "strasse")).toBe(true);
  });
});

describe("hasEmoji", () => {
  it.each([
    "\u{1F600}",
    "\u{1F44D}\u{1F3FD}",
    "\u{1F1E7}\u{1F1F7}",
    "1️⃣",
    "❤️",
    "✔️",
    "texto \u{1F642} fim",
    "©️",
    "️",
    "#⃣",
  ])("detects %j", (text) => {
    expect(hasEmoji(text)).toBe(true);
  });

  it.each([
    "123 # * • → § R$ 100 **negrito** ç ã © ™",
    "Olá, tudo bem?",
    "1. item\n2. item",
    "® marca",
    "",
  ])("does not flag %j", (text) => {
    expect(hasEmoji(text)).toBe(false);
  });
});

describe("runChecks", () => {
  it("makes one check per group, one per forbidden term, and always the last two", () => {
    const checks = runChecks(
      {
        deveConter: [["alfa", "beta"], ["gama"]],
        naoDeveConter: ["delta", "épsilon"],
        rubrica: "r",
      },
      "Tem BETA e nada mais",
      "rascunho",
    );

    expect(checks).toEqual([
      { tipo: "deveConter", alvo: ["alfa", "beta"], ok: true },
      { tipo: "deveConter", alvo: ["gama"], ok: false },
      { tipo: "naoDeveConter", alvo: ["delta"], ok: true },
      { tipo: "naoDeveConter", alvo: ["épsilon"], ok: true },
      { tipo: "semEmoji", alvo: [], ok: true },
      { tipo: "origem", alvo: ["fallback"], ok: true },
    ]);
  });

  it("fails a forbidden term that is present, with other case and accents", () => {
    const checks = runChecks(
      { deveConter: [], naoDeveConter: ["Épsilon"], rubrica: "r" },
      "tem epsilon aqui",
      "revisao",
    );

    expect(checks[0]).toEqual({
      tipo: "naoDeveConter",
      alvo: ["Épsilon"],
      ok: false,
    });
  });

  it("marks the emoji and the fallback origin", () => {
    const checks = runChecks(
      { deveConter: [], naoDeveConter: [], rubrica: "r" },
      "oi \u{1F600}",
      "fallback",
    );

    expect(checks).toEqual([
      { tipo: "semEmoji", alvo: [], ok: false },
      { tipo: "origem", alvo: ["fallback"], ok: false },
    ]);
  });
});

describe("buildVerdict", () => {
  const caso = makeCase({ deveConter: [["alfa"]], naoDeveConter: ["delta"] });

  it("passes when every check holds", () => {
    const verdict = buildVerdict(caso, answered("alfa"));

    expect(verdict.resultado).toBe("passou");
    expect(verdict.motivo).toBeUndefined();
    expect(verdict.juiz).toBeNull();
    expect(verdict.checagens).toHaveLength(4);
  });

  it("fails when a check does not hold", () => {
    expect(buildVerdict(caso, answered("sem nada")).resultado).toBe("falhou");
    expect(buildVerdict(caso, answered("alfa delta")).resultado).toBe("falhou");
    expect(buildVerdict(caso, answered("alfa \u{1F600}")).resultado).toBe(
      "falhou",
    );
  });

  it("fails on the safe message even when every content check holds", () => {
    const verdict = buildVerdict(
      caso,
      answered("alfa", { origin: "fallback" }),
    );

    expect(verdict.resultado).toBe("falhou");
    expect(verdict.motivo).toBe(FALLBACK_REASON);
    expect(verdict.checagens.at(-1)).toEqual({
      tipo: "origem",
      alvo: ["fallback"],
      ok: false,
    });
    expect(verdict.checagens.slice(0, 2).every((check) => check.ok)).toBe(true);
  });

  it("is an error, with no checks, when the evaluation was unavailable", () => {
    const verdict = buildVerdict(
      caso,
      answered("alfa", { origin: "fallback", evaluationFailed: true }),
    );

    expect(verdict).toEqual({
      resultado: "erro",
      motivo: EVALUATION_UNAVAILABLE,
      checagens: [],
      juiz: null,
    });
  });

  it("is an error, with no checks, for an infrastructure failure", () => {
    expect(
      buildVerdict(caso, { kind: "error", motivo: "falha de teste" }),
    ).toEqual({
      resultado: "erro",
      motivo: "falha de teste",
      checagens: [],
      juiz: null,
    });
  });
});
