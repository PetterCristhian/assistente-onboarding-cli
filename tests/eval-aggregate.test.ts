// The aggregator with fabricated executions: no model, no disk, no clock.
import { describe, expect, it } from "vitest";
import {
  aggregateBattery,
  summarySchema,
  type AggregateInput,
  type BatterySummary,
} from "../evals/aggregate.js";
import type { ExecutionLine } from "../evals/record.js";
import type { Caso } from "../evals/schema.js";
import {
  BATTERY,
  HASH_CASES,
  HASH_CONTEXT,
  answeredTurn,
  failedTurn,
  fullBattery,
  makeCase,
  makeLine,
  rejected,
} from "./helpers/eval-lines.js";

const CT01 = makeCase("CT01", { regras: ["P1", "P3"] });
const CT02 = makeCase("CT02", { regras: ["P3"] });
const CT03 = makeCase("CT03", { regras: ["P2"], titulo: "Terceiro | caso" });

function aggregate(
  lines: readonly ExecutionLine[],
  overrides: Partial<AggregateInput> = {},
  cases: readonly Caso[] = [CT01, CT02, CT03],
): BatterySummary {
  return aggregateBattery({
    lines,
    plan: { runs: 3, casos: cases },
    batteryId: BATTERY,
    catalogSize: cases.length,
    ...overrides,
  });
}

function caseOf(summary: BatterySummary, id: string) {
  const found = summary.porCaso.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no case ${id}`);
  }
  return found;
}

describe("aggregateBattery: consistency per case", () => {
  it("a case with every run approved is 3/3", () => {
    const summary = aggregate(fullBattery([CT01, CT02, CT03], 3));

    expect(caseOf(summary, "CT01")).toMatchObject({
      consistencia: "3/3",
      todasAprovadas: true,
      passou: 3,
      falhou: 0,
      erro: 0,
      ausentes: 0,
      esperadas: 3,
    });
    expect(summary.taxaConsistenciaGeral).toEqual({
      casosTodasAprovadas: 3,
      casos: 3,
      taxa: 1,
    });
    expect(summary.completa).toBe(true);
    expect(summary.f13Mensuravel).toBe(true);
    expect(summary.f13Atingido).toBe(true);
  });

  it("a case with one failed run is 2/3", () => {
    const lines = [
      ...fullBattery([CT01, CT03], 3),
      makeLine({ casoId: "CT02", execucao: 1, resultado: "passou" }),
      makeLine({ casoId: "CT02", execucao: 2, resultado: "falhou" }),
      makeLine({ casoId: "CT02", execucao: 3, resultado: "passou" }),
    ];
    const summary = aggregate(lines);

    expect(caseOf(summary, "CT02")).toMatchObject({
      consistencia: "2/3",
      todasAprovadas: false,
      passou: 2,
      falhou: 1,
    });
    expect(summary.taxaConsistenciaGeral).toEqual({
      casosTodasAprovadas: 2,
      casos: 3,
      taxa: 0.6667,
    });
    expect(summary.taxaExecucoesAprovadas).toEqual({
      passou: 8,
      esperadas: 9,
      taxa: 0.8889,
    });
    expect(summary.totais).toEqual({
      passou: 8,
      falhou: 1,
      erro: 0,
      ausentes: 0,
    });
  });

  it("an erro counts as not respected, whether it is the turn or the judge", () => {
    const lines = [
      ...fullBattery([CT01, CT02], 3),
      makeLine({ casoId: "CT03", execucao: 1, resultado: "passou" }),
      makeLine({ casoId: "CT03", execucao: 2, resultado: "erro" }),
      makeLine({
        casoId: "CT03",
        execucao: 3,
        resultado: "erro",
        judgeError: true,
      }),
    ];
    const summary = aggregate(lines);

    expect(caseOf(summary, "CT03")).toMatchObject({
      consistencia: "1/3",
      todasAprovadas: false,
      erro: 2,
    });
    expect(summary.totais.erro).toBe(2);
    expect(summary.juiz).toEqual({
      aprovou: 7,
      reprovou: 0,
      erro: 1,
      naoExecutado: 1,
    });
  });

  it("an interrupted battery has absent executions, and a case with no line shows up", () => {
    const lines = [
      makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" }),
      makeLine({ casoId: "CT02", execucao: 1, resultado: "passou" }),
      makeLine({ casoId: "CT01", execucao: 2, resultado: "passou" }),
    ];
    const summary = aggregate(lines);

    expect(summary.execucoesEsperadas).toBe(9);
    expect(summary.execucoesGravadas).toBe(3);
    expect(summary.completa).toBe(false);
    expect(summary.f13Mensuravel).toBe(false);
    expect(summary.f13Atingido).toBe(false);
    expect(summary.parcial).toBe(false);
    expect(summary.totais).toEqual({
      passou: 3,
      falhou: 0,
      erro: 0,
      ausentes: 6,
    });
    expect(caseOf(summary, "CT01")).toMatchObject({
      consistencia: "2/3",
      ausentes: 1,
    });
    expect(caseOf(summary, "CT03")).toMatchObject({
      consistencia: "0/3",
      passou: 0,
      ausentes: 3,
      todasAprovadas: false,
    });
    expect(summary.taxaExecucoesAprovadas.taxa).toBe(0.3333);
  });

  it("the denominator of n/N is --runs", () => {
    const summary = aggregate(fullBattery([CT01], 5), {
      plan: { runs: 5, casos: [CT01] },
      catalogSize: 1,
    });

    expect(caseOf(summary, "CT01").consistencia).toBe("5/5");
    expect(summary.execucoesPorCaso).toBe(5);
    expect(summary.execucoesEsperadas).toBe(5);
  });
});

describe("aggregateBattery: partial batteries and F13", () => {
  it("fewer than 3 runs is partial, and F13 is not met", () => {
    const summary = aggregate(fullBattery([CT01, CT02, CT03], 2), {
      plan: { runs: 2, casos: [CT01, CT02, CT03] },
    });

    expect(summary.parcial).toBe(true);
    expect(summary.completa).toBe(true);
    expect(summary.f13Mensuravel).toBe(false);
    expect(summary.f13Atingido).toBe(false);
  });

  it("a selection of the cases is partial, and F13 is not met", () => {
    const summary = aggregate(fullBattery([CT01], 3), {
      plan: { runs: 3, casos: [CT01] },
      catalogSize: 12,
    });

    expect(summary.parcial).toBe(true);
    expect(summary.f13Mensuravel).toBe(false);
    expect(summary.f13Atingido).toBe(false);
    expect(summary.porCaso).toHaveLength(1);
  });

  it("3 runs, every case and the battery complete is measurable, but not met with failures", () => {
    const lines = fullBattery([CT01, CT02, CT03], 3, "falhou");
    const summary = aggregate(lines);

    expect(summary.parcial).toBe(false);
    expect(summary.f13Mensuravel).toBe(true);
    expect(summary.f13Atingido).toBe(false);
    expect(summary.taxaConsistenciaGeral.taxa).toBe(0);
  });
});

describe("aggregateBattery: rules", () => {
  it("counts a case in each of its rules and a rule over several cases", () => {
    const lines = [
      ...fullBattery([CT01, CT03], 3),
      makeLine({ casoId: "CT02", execucao: 1, resultado: "passou" }),
      makeLine({ casoId: "CT02", execucao: 2, resultado: "falhou" }),
      makeLine({ casoId: "CT02", execucao: 3, resultado: "erro" }),
    ];
    const summary = aggregate(lines);

    expect(summary.porRegra.map((rule) => rule.regra)).toEqual([
      "P1",
      "P2",
      "P3",
    ]);
    const byRule = Object.fromEntries(
      summary.porRegra.map((rule) => [rule.regra, rule]),
    );
    // P1: CT01 only. P3: CT01 and CT02.
    expect(byRule["P1"]).toMatchObject({
      casos: 1,
      esperadas: 3,
      passou: 3,
      taxa: 1,
    });
    expect(byRule["P3"]).toMatchObject({
      casos: 2,
      esperadas: 6,
      passou: 4,
      falhou: 1,
      erro: 1,
      ausentes: 0,
      taxa: 0.6667,
    });
    expect(byRule["P2"]).toMatchObject({ casos: 1, passou: 3, taxa: 1 });
  });

  it("counts the absent executions in every rule of the case", () => {
    const summary = aggregate([
      makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" }),
    ]);
    const p3 = summary.porRegra.find((rule) => rule.regra === "P3");

    expect(p3).toMatchObject({
      casos: 2,
      esperadas: 6,
      passou: 1,
      ausentes: 5,
    });
  });
});

describe("aggregateBattery: self-evaluation, judge and retries", () => {
  it("counts rejected drafts, rejected revisions and the origin, over many turns", () => {
    const lines = [
      makeLine({
        casoId: "CT01",
        execucao: 1,
        resultado: "passou",
        turnos: [
          answeredTurn({ model: "modelo-chat" }),
          answeredTurn({
            evaluation: rejected("P2", "P3"),
            revision: { text: "revisado", evaluation: rejected("P3") },
            origin: "fallback",
            final: "mensagem segura",
            retries: 1,
          }),
          answeredTurn({
            evaluation: rejected("P1"),
            revision: {
              text: "revisado",
              evaluation: { situacao: "ok", aprovada: true, violacoes: [] },
            },
            origin: "revisao",
            final: "revisado",
          }),
        ],
        judgeRetries: 2,
      }),
      makeLine({
        casoId: "CT02",
        execucao: 1,
        resultado: "erro",
        turnos: [
          answeredTurn({
            evaluation: {
              situacao: "erro",
              resumo: { mensagem: "sem avaliação" },
            },
          }),
          failedTurn(3),
        ],
      }),
    ];
    const { autoavaliacao, novasTentativas, juiz } = aggregate(lines, {
      plan: { runs: 1, casos: [CT01, CT02, CT03] },
    });

    // 3 answered turns in the first line and 1 in the second.
    expect(autoavaliacao.turnosRespondidos).toBe(4);
    // Rejected drafts: turns 2 and 3 of the first line. The error is not a no.
    expect(autoavaliacao.rascunhosReprovados).toBe(2);
    // Rejected revisions: turn 2 only.
    expect(autoavaliacao.revisoesReprovadas).toBe(1);
    expect(autoavaliacao.origemFinal).toEqual({
      rascunho: 2,
      revisao: 1,
      fallback: 1,
    });
    expect(autoavaliacao.violacoesPorRegra).toEqual({
      P1: 1,
      P2: 1,
      P3: 2,
      P4: 0,
      P5: 0,
      desconhecida: 0,
    });
    // 1 (turn) + 3 (failed turn) + 2 (judge of the first line).
    expect(novasTentativas).toBe(6);
    expect(juiz).toEqual({
      aprovou: 1,
      reprovou: 0,
      erro: 0,
      naoExecutado: 1,
    });
  });

  it("lists the models and says whether the judge used the same one", () => {
    const different = aggregate(fullBattery([CT01], 3), {
      plan: { runs: 3, casos: [CT01] },
      catalogSize: 1,
    });
    expect(different.modeloChatbot).toEqual(["modelo-chat"]);
    expect(different.modeloJuiz).toEqual(["modelo-juiz"]);
    expect(different.juizMesmoModelo).toBe(false);

    const same = aggregate(
      [
        makeLine({
          casoId: "CT01",
          execucao: 1,
          resultado: "passou",
          modelo: "m1",
          judgeModel: "m1",
        }),
      ],
      { plan: { runs: 1, casos: [CT01] }, catalogSize: 1 },
    );
    expect(same.juizMesmoModelo).toBe(true);

    const noJudge = aggregate(
      [makeLine({ casoId: "CT01", execucao: 1, resultado: "erro" })],
      { plan: { runs: 1, casos: [CT01] }, catalogSize: 1 },
    );
    expect(noJudge.modeloJuiz).toEqual([]);
    expect(noJudge.juizMesmoModelo).toBe(false);
  });
});

describe("aggregateBattery: determinism and invariants", () => {
  it("takes the start from the smallest dataHora, whatever the order", () => {
    const lines = [
      makeLine({
        casoId: "CT01",
        execucao: 1,
        resultado: "passou",
        dataHora: "2026-11-20T14:31:07Z",
      }),
      makeLine({
        casoId: "CT01",
        execucao: 2,
        resultado: "passou",
        dataHora: "2026-11-20T14:31:07.412Z",
      }),
      makeLine({
        casoId: "CT01",
        execucao: 3,
        resultado: "passou",
        dataHora: "2026-11-20T14:30:59.999Z",
      }),
    ];
    const summary = aggregate(lines, {
      plan: { runs: 3, casos: [CT01] },
      catalogSize: 1,
    });

    expect(summary.inicio).toBe("2026-11-20T14:30:59.999Z");
    expect(
      aggregate([...lines].reverse(), {
        plan: { runs: 3, casos: [CT01] },
        catalogSize: 1,
      }),
    ).toEqual(summary);
  });

  it("is the same for the same input, and passes its own schema", () => {
    const lines = fullBattery([CT01, CT02, CT03], 3);
    const first = aggregate(lines);
    const second = aggregate(lines);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(summarySchema.parse(first)).toEqual(first);
    expect(first.hashContexto).toBe(HASH_CONTEXT);
    expect(first.hashCasos).toBe(HASH_CASES);
    expect(first.esquema).toBe(1);
  });

  it("passes its own schema for partial, interrupted and failed batteries", () => {
    const interrupted = aggregate([
      makeLine({ casoId: "CT01", execucao: 1, resultado: "falhou" }),
    ]);
    const partial = aggregate(fullBattery([CT01], 1), {
      plan: { runs: 1, casos: [CT01] },
      catalogSize: 12,
    });

    expect(() => summarySchema.parse(interrupted)).not.toThrow();
    expect(() => summarySchema.parse(partial)).not.toThrow();
  });

  it("rounds the rates to 4 decimals, the same way every time", () => {
    const cases = [1, 2, 3, 4, 5, 6, 7].map((n) => makeCase(`CT0${n}`));
    const lines = cases.flatMap((caso, index) =>
      Array.from({ length: 3 }, (_, run) =>
        makeLine({
          casoId: caso.id,
          execucao: run + 1,
          resultado: index === 0 && run === 0 ? "falhou" : "passou",
        }),
      ),
    );
    const summary = aggregate(lines, {
      plan: { runs: 3, casos: cases },
      catalogSize: 7,
    });

    expect(summary.taxaConsistenciaGeral.taxa).toBe(0.8571);
    expect(summary.taxaExecucoesAprovadas).toEqual({
      passou: 20,
      esperadas: 21,
      taxa: 0.9524,
    });
  });

  it("refuses lines whose hashes differ inside one battery", () => {
    const lines = [
      makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" }),
      makeLine({
        casoId: "CT01",
        execucao: 2,
        resultado: "passou",
        hashContexto: `sha256:${"f".repeat(64)}`,
      }),
    ];
    expect(() => aggregate(lines)).toThrow(/hashes de context\/ diferentes/);

    const other = [
      makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" }),
      makeLine({
        casoId: "CT01",
        execucao: 2,
        resultado: "passou",
        hashCasos: `sha256:${"f".repeat(64)}`,
      }),
    ];
    expect(() => aggregate(other)).toThrow(/hashes de casos.json diferentes/);
  });

  it("refuses lines that do not belong to the plan", () => {
    const line = (overrides: Partial<Parameters<typeof makeLine>[0]>) =>
      makeLine({
        casoId: "CT01",
        execucao: 1,
        resultado: "passou",
        ...overrides,
      });

    expect(() => aggregate([])).toThrow(/nenhuma linha/);
    expect(() => aggregate([line({ casoId: "CT09" })])).toThrow(
      /não pertence ao plano/,
    );
    expect(() => aggregate([line({ execucao: 4 })])).toThrow(/fora de 1 a 3/);
    expect(() => aggregate([line({}), line({})])).toThrow(/duas vezes/);
    expect(() =>
      aggregate([line({ bateria: "2026-11-21T10-00-00Z" })]),
    ).toThrow(/outra bateria/);
  });
});

describe("summarySchema", () => {
  const base = aggregate(fullBattery([CT01, CT02, CT03], 3));

  it("is strict: an extra key is refused", () => {
    expect(summarySchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(summarySchema.safeParse({ ...base, esquema: 2 }).success).toBe(
      false,
    );
  });

  it("refuses totals that do not add up and an F13 that cannot hold", () => {
    expect(
      summarySchema.safeParse({
        ...base,
        totais: { ...base.totais, passou: base.totais.passou + 1 },
      }).success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({ ...base, parcial: true, f13Mensuravel: true })
        .success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({
        ...base,
        f13Mensuravel: false,
        f13Atingido: true,
      }).success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({
        ...base,
        f13Mensuravel: true,
        f13Atingido: true,
        totais: {
          ...base.totais,
          passou: base.totais.passou - 1,
          falhou: base.totais.falhou + 1,
        },
      }).success,
    ).toBe(false);
    expect(summarySchema.safeParse({ ...base, completa: false }).success).toBe(
      false,
    );
  });

  it("refuses a bad hash and a rate out of range", () => {
    expect(
      summarySchema.safeParse({ ...base, hashContexto: "sha256:abc" }).success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({
        ...base,
        taxaExecucoesAprovadas: { passou: 9, esperadas: 9, taxa: 1.5 },
      }).success,
    ).toBe(false);
  });
});
