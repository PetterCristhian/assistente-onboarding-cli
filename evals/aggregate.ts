// The aggregator of the battery (ENG-57, part 2): turns the lines of
// execucoes.jsonl into the numbers of resumo.json, with the consistency per
// case (F13) and per rule. Pure and deterministic: the same input gives the
// same output, with no clock, no disk and no randomness. The date of the
// battery is the smallest `dataHora` of its lines.
//
// It reads `resultado` as written: the line schema (evals/record.ts) already
// refuses a `resultado` that its own checks and judge contradict, so nothing is
// recomputed here. An `erro`, a `falhou` and an execution that is missing all
// count as "not respected".
import { z } from "zod";
import { RULE_IDS, UNKNOWN_RULE } from "../src/chat/critique.js";
import { HASH_PATTERN } from "./context-hash.js";
import type { ExecutionLine } from "./record.js";
import { CATEGORIES, RULES, type Caso } from "./schema.js";

/** The format of resumo.json that this file defines. */
export const SUMMARY_SCHEMA_VERSION = 1;

/** The F13 minimum: executions of each case. */
export const F13_MIN_RUNS = 3;

const RATE_DECIMALS = 10_000;

const count = z.number().int().min(0);
const rate = z.number().min(0).max(1);
const hash = z.string().regex(HASH_PATTERN, "formato sha256:<64 hex>");

const caseSummarySchema = z.strictObject({
  id: z.string().regex(/^CT\d{2}$/),
  titulo: z.string(),
  categoria: z.enum(CATEGORIES),
  regras: z.array(z.enum(RULES)).min(1),
  esperadas: count,
  passou: count,
  falhou: count,
  erro: count,
  ausentes: count,
  /** "n/N": N is the number of executions asked for (--runs). */
  consistencia: z.string().regex(/^\d+\/\d+$/),
  todasAprovadas: z.boolean(),
});

const ruleSummarySchema = z.strictObject({
  regra: z.enum(RULES),
  casos: count,
  esperadas: count,
  passou: count,
  falhou: count,
  erro: count,
  ausentes: count,
  taxa: rate,
});

export const summarySchema = z
  .strictObject({
    esquema: z.literal(SUMMARY_SCHEMA_VERSION),
    bateria: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/),
    /** The smallest `dataHora` of the lines, ISO 8601. */
    inicio: z.iso.datetime(),
    modeloChatbot: z.array(z.string()),
    modeloJuiz: z.array(z.string()),
    juizMesmoModelo: z.boolean(),
    hashContexto: hash,
    hashCasos: hash,
    execucoesPorCaso: z.number().int().min(1),
    execucoesEsperadas: z.number().int().min(1),
    execucoesGravadas: count,
    completa: z.boolean(),
    /** --case or --runs below 3: F13 cannot be validated. */
    parcial: z.boolean(),
    f13Atendido: z.boolean(),
    totais: z.strictObject({
      passou: count,
      falhou: count,
      erro: count,
      ausentes: count,
    }),
    taxaConsistenciaGeral: z.strictObject({
      casosTodasAprovadas: count,
      casos: count,
      taxa: rate,
    }),
    taxaExecucoesAprovadas: z.strictObject({
      passou: count,
      esperadas: count,
      taxa: rate,
    }),
    porCaso: z.array(caseSummarySchema).min(1),
    porRegra: z.array(ruleSummarySchema).min(1),
    autoavaliacao: z.strictObject({
      turnosRespondidos: count,
      /** An answered turn whose self-evaluation said no (and did not fail). */
      rascunhosReprovados: count,
      revisoesReprovadas: count,
      origemFinal: z.strictObject({
        rascunho: count,
        revisao: count,
        fallback: count,
      }),
      violacoesPorRegra: z.record(z.string(), count),
    }),
    juiz: z.strictObject({
      aprovou: count,
      reprovou: count,
      erro: count,
      naoExecutado: count,
    }),
    /** Chatbot and judge together. */
    novasTentativas: count,
  })
  .superRefine((summary, ctx) => {
    const { totais } = summary;
    const written = totais.passou + totais.falhou + totais.erro;
    if (
      written !== summary.execucoesGravadas ||
      written + totais.ausentes !== summary.execucoesEsperadas
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["totais"],
        message: "os totais não fecham com as execuções esperadas e gravadas",
      });
    }
    if (summary.completa !== (totais.ausentes === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["completa"],
        message: "completa deve ser verdadeiro só quando não há ausentes",
      });
    }
    if (summary.f13Atendido && (summary.parcial || !summary.completa)) {
      ctx.addIssue({
        code: "custom",
        path: ["f13Atendido"],
        message:
          "F13 não pode estar atendido numa bateria parcial ou incompleta",
      });
    }
  });

export type BatterySummary = z.infer<typeof summarySchema>;
export type CaseSummary = z.infer<typeof caseSummarySchema>;

export interface AggregateInput {
  /** What was written, in any order. At least one. */
  readonly lines: readonly ExecutionLine[];
  /** What the battery had to run: the selected cases and the runs of each. */
  readonly plan: {
    readonly runs: number;
    readonly casos: readonly Caso[];
  };
  readonly batteryId: string;
  /** How many cases evals/casos.json has: F13 needs all of them selected. */
  readonly catalogSize: number;
}

/** A rate with 4 decimals, so that the file is the same on every machine. */
function roundRate(numerator: number, denominator: number): number {
  return denominator === 0
    ? 0
    : Math.round((numerator / denominator) * RATE_DECIMALS) / RATE_DECIMALS;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function onlyOne(
  values: readonly string[],
  what: string,
  batteryId: string,
): string {
  const distinct = sortedUnique(values);
  const [first] = distinct;
  if (first === undefined || distinct.length !== 1) {
    throw new Error(
      `Bateria ${batteryId}: as linhas têm ${what} diferentes (${distinct.length}); uma bateria só pode ter um.`,
    );
  }
  return first;
}

interface Tally {
  passou: number;
  falhou: number;
  erro: number;
}

/** Checks the invariants of the lines against the plan; throws if broken. */
function checkLines(input: AggregateInput): void {
  const { lines, plan, batteryId } = input;
  if (lines.length === 0) {
    throw new Error(`Bateria ${batteryId}: nenhuma linha para agregar.`);
  }
  const known = new Set(plan.casos.map((caso) => caso.id));
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.bateria !== batteryId) {
      throw new Error(
        `Bateria ${batteryId}: há linha de outra bateria (${line.bateria}).`,
      );
    }
    if (!known.has(line.casoId)) {
      throw new Error(
        `Bateria ${batteryId}: a linha de ${line.casoId} não pertence ao plano.`,
      );
    }
    if (line.execucao < 1 || line.execucao > plan.runs) {
      throw new Error(
        `Bateria ${batteryId}: ${line.casoId} tem a execução ${line.execucao}, fora de 1 a ${plan.runs}.`,
      );
    }
    const key = `${line.casoId}/${line.execucao}`;
    if (seen.has(key)) {
      throw new Error(`Bateria ${batteryId}: ${key} aparece duas vezes.`);
    }
    seen.add(key);
  }
}

export function aggregateBattery(input: AggregateInput): BatterySummary {
  const { lines, plan, batteryId } = input;
  const { runs } = plan;
  if (!Number.isInteger(runs) || runs < 1 || plan.casos.length === 0) {
    throw new Error(`Bateria ${batteryId}: plano inválido.`);
  }
  checkLines(input);

  const hashContexto = onlyOne(
    lines.map((line) => line.hashContexto),
    "hashes de context/",
    batteryId,
  );
  const hashCasos = onlyOne(
    lines.map((line) => line.hashCasos),
    "hashes de casos.json",
    batteryId,
  );
  const inicio = lines.reduce((earliest, line) =>
    Date.parse(line.dataHora) < Date.parse(earliest.dataHora) ? line : earliest,
  ).dataHora;

  const tallies = new Map<string, Tally>(
    plan.casos.map((caso) => [caso.id, { passou: 0, falhou: 0, erro: 0 }]),
  );
  const totals: Tally = { passou: 0, falhou: 0, erro: 0 };
  const origins = { rascunho: 0, revisao: 0, fallback: 0 };
  const violations: Record<string, number> = Object.fromEntries(
    [...RULE_IDS, UNKNOWN_RULE].map((rule) => [rule, 0]),
  );
  const judge = { aprovou: 0, reprovou: 0, erro: 0, naoExecutado: 0 };
  const chatbotModels: string[] = [];
  const judgeModels: string[] = [];
  let answered = 0;
  let draftsRejected = 0;
  let revisionsRejected = 0;
  let retries = 0;

  for (const line of lines) {
    const { resultado, juiz } = line.veredito;
    const tally = tallies.get(line.casoId);
    if (tally !== undefined) {
      tally[resultado] += 1;
    }
    totals[resultado] += 1;

    if (line.modelo !== null) {
      chatbotModels.push(line.modelo);
    }
    if (juiz === null) {
      judge.naoExecutado += 1;
    } else if (juiz.situacao === "erro") {
      judge.erro += 1;
      retries += juiz.novasTentativas;
    } else {
      judgeModels.push(juiz.modelo);
      judge[juiz.passou ? "aprovou" : "reprovou"] += 1;
      retries += juiz.novasTentativas;
    }

    for (const turn of line.turnos) {
      retries += turn.novasTentativas;
      if (turn.situacao !== "respondido") {
        continue;
      }
      answered += 1;
      origins[turn.origemFinal] += 1;
      for (const opinion of [turn.autoavaliacao, turn.revisao?.autoavaliacao]) {
        if (opinion?.situacao !== "ok") {
          continue;
        }
        for (const violation of opinion.violacoes) {
          violations[violation.regra] = (violations[violation.regra] ?? 0) + 1;
        }
      }
      if (
        turn.autoavaliacao.situacao === "ok" &&
        !turn.autoavaliacao.aprovada
      ) {
        draftsRejected += 1;
      }
      const revised = turn.revisao?.autoavaliacao;
      if (revised?.situacao === "ok" && !revised.aprovada) {
        revisionsRejected += 1;
      }
    }
  }

  const porCaso = plan.casos.map((caso): CaseSummary => {
    const tally = tallies.get(caso.id) ?? { passou: 0, falhou: 0, erro: 0 };
    return {
      id: caso.id,
      titulo: caso.titulo,
      categoria: caso.categoria,
      regras: [...caso.regras],
      esperadas: runs,
      ...tally,
      ausentes: runs - (tally.passou + tally.falhou + tally.erro),
      consistencia: `${tally.passou}/${runs}`,
      todasAprovadas: tally.passou === runs,
    };
  });

  // A case with several rules counts its executions in each one of them.
  const porRegra = RULES.flatMap((regra) => {
    const cases = porCaso.filter((caso) => caso.regras.includes(regra));
    if (cases.length === 0) {
      return [];
    }
    const sum = (field: "passou" | "falhou" | "erro" | "ausentes"): number =>
      cases.reduce((total, caso) => total + caso[field], 0);
    const esperadas = cases.length * runs;
    return [
      {
        regra,
        casos: cases.length,
        esperadas,
        passou: sum("passou"),
        falhou: sum("falhou"),
        erro: sum("erro"),
        ausentes: sum("ausentes"),
        taxa: roundRate(sum("passou"), esperadas),
      },
    ];
  });

  const expected = plan.casos.length * runs;
  const absent = expected - lines.length;
  const allApproved = porCaso.filter((caso) => caso.todasAprovadas).length;
  const modeloChatbot = sortedUnique(chatbotModels);
  const modeloJuiz = sortedUnique(judgeModels);
  const complete = absent === 0;
  const partial = runs < F13_MIN_RUNS || plan.casos.length < input.catalogSize;

  return {
    esquema: SUMMARY_SCHEMA_VERSION,
    bateria: batteryId,
    inicio,
    modeloChatbot,
    modeloJuiz,
    juizMesmoModelo:
      modeloJuiz.length > 0 && sameValues(modeloChatbot, modeloJuiz),
    hashContexto,
    hashCasos,
    execucoesPorCaso: runs,
    execucoesEsperadas: expected,
    execucoesGravadas: lines.length,
    completa: complete,
    parcial: partial,
    f13Atendido: !partial && complete,
    totais: { ...totals, ausentes: absent },
    taxaConsistenciaGeral: {
      casosTodasAprovadas: allApproved,
      casos: porCaso.length,
      taxa: roundRate(allApproved, porCaso.length),
    },
    taxaExecucoesAprovadas: {
      passou: totals.passou,
      esperadas: expected,
      taxa: roundRate(totals.passou, expected),
    },
    porCaso,
    porRegra,
    autoavaliacao: {
      turnosRespondidos: answered,
      rascunhosReprovados: draftsRejected,
      revisoesReprovadas: revisionsRejected,
      origemFinal: origins,
      violacoesPorRegra: violations,
    },
    juiz: judge,
    novasTentativas: retries,
  };
}
