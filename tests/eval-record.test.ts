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
  parseExecutionLine,
  type ExecutionLine,
  type JudgeResult,
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

type CheckLine = ExecutionLine["veredito"]["checagens"][number];
const HASH = `sha256:${"a".repeat(64)}`;
const JUDGE_OK: JudgeResult = {
  situacao: "ok",
  passou: true,
  justificativa: "cumpre a rubrica",
  modelo: "modelo-juiz",
  novasTentativas: 0,
};
const JUDGE_ERROR: JudgeResult = {
  situacao: "erro",
  resumo: { mensagem: "falha" },
  novasTentativas: 2,
};

/** The verdict of a line, with the judge and the checks that the test sets. */
function withVerdict(veredito: ExecutionLine["veredito"]): ExecutionLine {
  return makeLine({ veredito });
}

function makeLine(overrides: Partial<ExecutionLine> = {}): ExecutionLine {
  return buildExecutionLine({
    bateria: "2026-11-20T14-30-00Z",
    casoId: "CT01",
    execucao: 1,
    dataHora: "2026-11-20T14:31:07.412Z",
    modelo: "modelo-x",
    perfil: "dora-teixeira",
    hashContexto: HASH,
    hashCasos: HASH,
    turnos: [answeredTurnLine("Pergunta?", answered(), MEASURE)],
    veredito: {
      resultado: "passou",
      checagens: [{ tipo: "semEmoji", alvo: [], ok: true }],
      juiz: JUDGE_OK,
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
      { ...line, hashContexto: "sha256:abc" },
      { ...line, hashCasos: `sha1:${"a".repeat(64)}` },
      { ...line, hashCasos: `sha256:${"A".repeat(64)}` },
      { ...line, esquema: 2 },
    ];

    for (const candidate of invalid) {
      expect(execucaoSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("refuses a pass without a judge that passed, or without checks that passed", () => {
    const ok: CheckLine = { tipo: "semEmoji", alvo: [], ok: true };
    const bad: CheckLine = { tipo: "semEmoji", alvo: [], ok: false };
    const refused: ExecutionLine["veredito"][] = [
      { resultado: "passou", checagens: [ok], juiz: null },
      { resultado: "passou", checagens: [ok], juiz: JUDGE_ERROR },
      {
        resultado: "passou",
        checagens: [ok],
        juiz: { ...JUDGE_OK, passou: false },
      },
      { resultado: "passou", checagens: [ok, bad], juiz: JUDGE_OK },
      { resultado: "passou", checagens: [], juiz: JUDGE_OK },
    ];

    for (const veredito of refused) {
      expect(execucaoSchema.safeParse(withVerdict(veredito)).success).toBe(
        false,
      );
    }
    expect(
      execucaoSchema.safeParse(
        withVerdict({ resultado: "passou", checagens: [ok], juiz: JUDGE_OK }),
      ).success,
    ).toBe(true);
  });

  it("requires an infrastructure error to carry no checks and no judge", () => {
    const ok: CheckLine = { tipo: "semEmoji", alvo: [], ok: true };
    const accepted: ExecutionLine["veredito"][] = [
      { resultado: "erro", motivo: "m", checagens: [], juiz: null },
      // The judge was unavailable: checks that held, and an error of the judge.
      { resultado: "erro", motivo: "m", checagens: [ok], juiz: JUDGE_ERROR },
      {
        resultado: "falhou",
        checagens: [ok],
        juiz: { ...JUDGE_OK, passou: false },
      },
    ];
    const refused: ExecutionLine["veredito"][] = [
      { resultado: "erro", motivo: "m", checagens: [ok], juiz: null },
      { resultado: "erro", motivo: "m", checagens: [ok], juiz: JUDGE_OK },
    ];

    for (const veredito of accepted) {
      expect(execucaoSchema.safeParse(withVerdict(veredito)).success).toBe(
        true,
      );
    }
    for (const veredito of refused) {
      expect(execucaoSchema.safeParse(withVerdict(veredito)).success).toBe(
        false,
      );
    }
  });

  it("is strict about the judge: no passou on an error, no extra key", () => {
    const ok: CheckLine = { tipo: "semEmoji", alvo: [], ok: true };
    const candidates: unknown[] = [
      { ...JUDGE_ERROR, passou: true },
      { ...JUDGE_OK, extra: 1 },
      { situacao: "ok", passou: true },
    ];

    for (const juiz of candidates) {
      expect(
        execucaoSchema.safeParse({
          ...makeLine(),
          veredito: { resultado: "falhou", checagens: [ok], juiz },
        }).success,
      ).toBe(false);
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

  it("builds the line with the verdict and the judge", () => {
    const line = makeLine();

    expect(line.veredito.juiz).toEqual(JUDGE_OK);
    expect(line.veredito.checagens).toEqual([
      { tipo: "semEmoji", alvo: [], ok: true },
    ]);
    expect(Object.keys(line)).toEqual([
      "esquema",
      "bateria",
      "casoId",
      "execucao",
      "dataHora",
      "modelo",
      "perfil",
      "hashContexto",
      "hashCasos",
      "turnos",
      "veredito",
    ]);
    expect(line.esquema).toBe(1);
  });
});

describe("parseExecutionLine", () => {
  it("reads a line of the current format", () => {
    const line = makeLine();

    expect(parseExecutionLine(JSON.parse(JSON.stringify(line)))).toEqual(line);
  });

  it("refuses a line of the old format, with a clear message", () => {
    const old: Record<string, unknown> = { ...makeLine() };
    delete old["esquema"];

    expect(() => parseExecutionLine(old)).toThrow(/formato antigo.*esquema/);
    expect(() => parseExecutionLine("texto")).toThrow(/formato antigo/);
  });

  it("refuses another version of the format", () => {
    expect(() => parseExecutionLine({ ...makeLine(), esquema: 2 })).toThrow(
      /esquema não suportado/,
    );
  });
});
