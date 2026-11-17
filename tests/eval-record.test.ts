import { describe, expect, it } from "vitest";
import type { EvaluationOutcome, TurnCritique } from "../src/chat/critique.js";
import type { TurnResult } from "../src/chat/session.js";
import {
  describeOutcome,
  describeSummary,
} from "../src/logging/session-log.js";
import {
  answeredTurnLine,
  buildExecutionLine,
  describeEvaluation,
  describeErrorSummary,
  execucaoSchema,
  failedTurnLine,
  type ExecutionLine,
  type TurnMeasure,
} from "../evals/record.js";

const MEASURE: TurnMeasure = {
  durationMs: 1234.6,
  retries: 1,
  notices: [{ nivel: "warning", texto: "aviso" }],
};

function answered(
  critique: Partial<TurnCritique> = {},
): Extract<TurnResult, { status: "answered" }> {
  return {
    status: "answered",
    text: "Resposta final",
    model: "modelo-x",
    chunks: 1,
    critique: {
      draft: "Rascunho",
      evaluation: { status: "ok", approved: true, violations: [] },
      origin: "rascunho",
      violatedRules: [],
      llmCalls: 2,
      ...critique,
    },
  };
}

function makeLine(overrides: Partial<ExecutionLine> = {}): ExecutionLine {
  return buildExecutionLine({
    bateria: "2026-11-20T14-30-00Z",
    casoId: "CT01",
    execucao: 1,
    dataHora: "2026-11-20T14:31:07.412Z",
    modelo: "modelo-x",
    perfil: "dora-teixeira",
    turnos: [answeredTurnLine("Pergunta?", answered(), MEASURE)],
    veredito: {
      resultado: "passou",
      checagens: [{ tipo: "semEmoji", alvo: [], ok: true }],
      juiz: null,
    },
    ...overrides,
  });
}

describe("execucaoSchema", () => {
  it("accepts an answered line, a failed turn and a line with a revision", () => {
    const withRevision = answeredTurnLine(
      "P?",
      answered({
        evaluation: {
          status: "ok",
          approved: false,
          violations: [{ rule: "P2", reason: "motivo" }],
        },
        revision: {
          text: "Revisão",
          evaluation: { status: "ok", approved: true, violations: [] },
        },
        origin: "revisao",
        violatedRules: ["P2"],
        llmCalls: 4,
      }),
      MEASURE,
    );
    const failed = failedTurnLine("P?", { status: 500, message: "x" }, MEASURE);

    for (const turnos of [[withRevision], [failed]]) {
      expect(execucaoSchema.safeParse(makeLine({ turnos })).success).toBe(true);
    }
    expect(execucaoSchema.safeParse(makeLine()).success).toBe(true);
  });

  it("accepts a null model and the suffix of a repeated battery id", () => {
    const line = makeLine({
      modelo: null,
      bateria: "2026-11-20T14-30-00Z-2",
    });

    expect(execucaoSchema.safeParse(line).success).toBe(true);
  });

  it("is strict: an extra key, anywhere, is refused", () => {
    const line = makeLine();
    const [turn] = line.turnos;

    expect(execucaoSchema.safeParse({ ...line, extra: 1 }).success).toBe(false);
    expect(
      execucaoSchema.safeParse({ ...line, turnos: [{ ...turn, extra: 1 }] })
        .success,
    ).toBe(false);
    expect(
      execucaoSchema.safeParse({
        ...line,
        veredito: { ...line.veredito, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it("refuses wrong values", () => {
    const line = makeLine();
    const invalid: unknown[] = [
      { ...line, casoId: "caso1" },
      { ...line, execucao: 0 },
      { ...line, dataHora: "ontem" },
      { ...line, bateria: "2026-11-20T14:30:00Z" },
      { ...line, turnos: [] },
      { ...line, veredito: { ...line.veredito, resultado: "talvez" } },
      { ...line, veredito: { ...line.veredito, juiz: { passou: true } } },
    ];

    for (const candidate of invalid) {
      expect(execucaoSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("does not let a failed turn carry a draft or a final answer", () => {
    const failed = failedTurnLine("P?", { message: "x" }, MEASURE);

    expect(
      execucaoSchema.safeParse(
        makeLine({ turnos: [{ ...failed, rascunho: "r" } as never] }),
      ).success,
    ).toBe(false);
    expect(failed).not.toHaveProperty("respostaFinal");
    expect(failed).not.toHaveProperty("rascunho");
  });
});

describe("the pieces of a turn", () => {
  it("rounds the duration and copies the measures", () => {
    const turn = answeredTurnLine("P?", answered(), MEASURE);

    expect(turn).toMatchObject({
      situacao: "respondido",
      pergunta: "P?",
      novasTentativas: 1,
      duracaoMs: 1235,
      avisos: [{ nivel: "warning", texto: "aviso" }],
      origemFinal: "rascunho",
      respostaFinal: "Resposta final",
      rascunho: "Rascunho",
      modelo: "modelo-x",
      chamadas: 2,
    });
    expect(turn).not.toHaveProperty("revisao");
  });

  it("keeps a revision that was dropped before its evaluation", () => {
    const turn = answeredTurnLine(
      "P?",
      answered({ revision: { text: "Revisão" }, origin: "fallback" }),
      MEASURE,
    );

    expect(turn).toMatchObject({ revisao: { texto: "Revisão" } });
    expect(turn).not.toHaveProperty("revisao.autoavaliacao");
  });

  it("describes an opinion exactly like the session log does", () => {
    const outcomes: EvaluationOutcome[] = [
      { status: "ok", approved: true, violations: [] },
      {
        status: "ok",
        approved: false,
        violations: [
          { rule: "P1", reason: "a" },
          { rule: "desconhecida", reason: "b" },
        ],
      },
      {
        status: "error",
        summary: { status: 503, code: "c", type: "t", message: "m" },
      },
      { status: "error", summary: { message: "só a mensagem" } },
    ];

    for (const outcome of outcomes) {
      expect(describeEvaluation(outcome)).toEqual(describeOutcome(outcome));
    }
    expect(
      describeErrorSummary({ status: 429, code: "x", message: "m" }),
    ).toEqual(describeSummary({ status: 429, code: "x", message: "m" }));
  });

  it("builds the line with the verdict and no judge", () => {
    const line = makeLine();

    expect(line.veredito.juiz).toBeNull();
    expect(line.veredito.checagens).toEqual([
      { tipo: "semEmoji", alvo: [], ok: true },
    ]);
    expect(Object.keys(line)).toEqual([
      "bateria",
      "casoId",
      "execucao",
      "dataHora",
      "modelo",
      "perfil",
      "turnos",
      "veredito",
    ]);
  });
});
