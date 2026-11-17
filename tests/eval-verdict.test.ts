import { describe, expect, it } from "vitest";
import {
  EVALUATION_UNAVAILABLE,
  FALLBACK_REASON,
  JUDGE_NOT_RUN,
  JUDGE_UNAVAILABLE,
  buildVerdict,
  containsTerm,
  hasEmoji,
  needsJudge,
  runChecks,
  type Outcome,
} from "../evals/verdict.js";
import type { JudgeResult } from "../evals/record.js";
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

const JUDGE_PASSED: JudgeResult = {
  situacao: "ok",
  passou: true,
  justificativa: "cumpre",
  modelo: "modelo-juiz",
  novasTentativas: 0,
};
const JUDGE_FAILED: JudgeResult = { ...JUDGE_PASSED, passou: false };
const JUDGE_ERROR: JudgeResult = {
  situacao: "erro",
  resumo: { mensagem: "falha" },
  novasTentativas: 3,
};

describe("needsJudge", () => {
  it("is true only for an answer that is not the safe message and was evaluated", () => {
    expect(needsJudge(answered("x"))).toBe(true);
    expect(needsJudge(answered("x", { origin: "revisao" }))).toBe(true);
    expect(needsJudge(answered("x", { origin: "fallback" }))).toBe(false);
    expect(needsJudge(answered("x", { evaluationFailed: true }))).toBe(false);
    expect(needsJudge({ kind: "error", motivo: "m" })).toBe(false);
  });
});

describe("buildVerdict", () => {
  const caso = makeCase({ deveConter: [["alfa"]], naoDeveConter: ["delta"] });

  it("passes when every check holds and the judge passed", () => {
    const verdict = buildVerdict(caso, answered("alfa"), JUDGE_PASSED);

    expect(verdict.resultado).toBe("passou");
    expect(verdict.motivo).toBeUndefined();
    expect(verdict.juiz).toEqual(JUDGE_PASSED);
    expect(verdict.checagens).toHaveLength(4);
  });

  it("fails when the judge failed, even with every check ok", () => {
    const verdict = buildVerdict(caso, answered("alfa"), JUDGE_FAILED);

    expect(verdict.resultado).toBe("falhou");
    expect(verdict.juiz).toEqual(JUDGE_FAILED);
    expect(verdict.checagens.every((check) => check.ok)).toBe(true);
  });

  it("fails when a check does not hold, even if the judge passed, and keeps both parts", () => {
    for (const text of ["sem nada", "alfa delta", "alfa \u{1F600}"]) {
      const verdict = buildVerdict(caso, answered(text), JUDGE_PASSED);

      expect(verdict.resultado).toBe("falhou");
      expect(verdict.juiz).toEqual(JUDGE_PASSED);
      expect(verdict.checagens.some((check) => !check.ok)).toBe(true);
    }
  });

  it("fails when a check does not hold and the judge failed or erred", () => {
    expect(buildVerdict(caso, answered("x"), JUDGE_FAILED).resultado).toBe(
      "falhou",
    );
    const erred = buildVerdict(caso, answered("x"), JUDGE_ERROR);

    expect(erred.resultado).toBe("falhou");
    expect(erred.juiz).toEqual(JUDGE_ERROR);
  });

  it("is an error when the checks hold and the judge is unavailable", () => {
    const verdict = buildVerdict(caso, answered("alfa"), JUDGE_ERROR);

    expect(verdict.resultado).toBe("erro");
    expect(verdict.motivo).toBe(JUDGE_UNAVAILABLE);
    expect(verdict.juiz).toEqual(JUDGE_ERROR);
    expect(verdict.checagens.every((check) => check.ok)).toBe(true);
  });

  it("never passes when the judge is needed and none came", () => {
    const verdict = buildVerdict(caso, answered("alfa"));

    expect(verdict.resultado).toBe("falhou");
    expect(verdict.motivo).toBe(JUDGE_NOT_RUN);
    expect(verdict.juiz).toBeNull();
  });

  it("fails on the safe message even when every check holds, with no judge", () => {
    for (const juiz of [undefined, JUDGE_PASSED]) {
      const verdict = buildVerdict(
        caso,
        answered("alfa", { origin: "fallback" }),
        juiz,
      );

      expect(verdict.resultado).toBe("falhou");
      expect(verdict.motivo).toBe(FALLBACK_REASON);
      expect(verdict.juiz).toBeNull();
      expect(verdict.checagens.at(-1)).toEqual({
        tipo: "origem",
        alvo: ["fallback"],
        ok: false,
      });
      expect(verdict.checagens.slice(0, 2).every((check) => check.ok)).toBe(
        true,
      );
    }
  });

  it("is an error, with no checks and no judge, when the evaluation was unavailable", () => {
    const verdict = buildVerdict(
      caso,
      answered("alfa", { origin: "fallback", evaluationFailed: true }),
      JUDGE_PASSED,
    );

    expect(verdict).toEqual({
      resultado: "erro",
      motivo: EVALUATION_UNAVAILABLE,
      checagens: [],
      juiz: null,
    });
  });

  it("is an error, with no checks and no judge, for an infrastructure failure", () => {
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
