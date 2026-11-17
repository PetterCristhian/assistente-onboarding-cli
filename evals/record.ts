// One line of execucoes.jsonl (ADR 0006, with the deviations of its note of
// implementation): the strict schema, and the functions that build the pieces
// from what the session returns. The keys are in Portuguese, like every file
// that the project writes. Pure: it writes nothing; the line goes to the disk
// through the single safe writer, which redacts it.
import { z } from "zod";
import {
  RULE_IDS,
  UNKNOWN_RULE,
  type EvaluationOutcome,
} from "../src/chat/critique.js";
import type { TurnResult } from "../src/chat/session.js";
import type { ErrorSummary } from "../src/security/error-summary.js";
import { HASH_PATTERN } from "./context-hash.js";
import type { Verdict } from "./verdict.js";

const errorSummarySchema = z.strictObject({
  status: z.number().int().optional(),
  codigo: z.string().optional(),
  tipo: z.string().optional(),
  mensagem: z.string(),
});

/** The same shape as `describeOutcome` of the session log (a test checks it). */
const opinionSchema = z.discriminatedUnion("situacao", [
  z.strictObject({
    situacao: z.literal("ok"),
    aprovada: z.boolean(),
    violacoes: z.array(
      z.strictObject({
        regra: z.enum([...RULE_IDS, UNKNOWN_RULE]),
        motivo: z.string(),
      }),
    ),
  }),
  z.strictObject({
    situacao: z.literal("erro"),
    resumo: errorSummarySchema,
  }),
]);

const noticeSchema = z.strictObject({
  nivel: z.enum(["info", "warning", "error"]),
  texto: z.string(),
});

const measureShape = {
  pergunta: z.string(),
  novasTentativas: z.number().int().min(0),
  duracaoMs: z.number().int().min(0),
  avisos: z.array(noticeSchema),
};

const turnSchema = z.discriminatedUnion("situacao", [
  z.strictObject({
    ...measureShape,
    situacao: z.literal("respondido"),
    rascunho: z.string(),
    autoavaliacao: opinionSchema,
    revisao: z
      .strictObject({
        texto: z.string(),
        autoavaliacao: opinionSchema.optional(),
      })
      .optional(),
    origemFinal: z.enum(["rascunho", "revisao", "fallback"]),
    respostaFinal: z.string(),
    modelo: z.string(),
    chamadas: z.number().int().min(1),
  }),
  z.strictObject({
    ...measureShape,
    situacao: z.literal("erro"),
    erro: errorSummarySchema,
  }),
  z.strictObject({
    ...measureShape,
    situacao: z.literal("cancelado"),
  }),
]);

const checkSchema = z.strictObject({
  tipo: z.enum(["deveConter", "naoDeveConter", "semEmoji", "origem"]),
  alvo: z.array(z.string()),
  ok: z.boolean(),
});

/**
 * What the judge returned for one execution (evals/judge.ts): its decision and
 * reason, or why there is none. `passou` only exists on a validated answer.
 */
export const judgeResultSchema = z.discriminatedUnion("situacao", [
  z.strictObject({
    situacao: z.literal("ok"),
    passou: z.boolean(),
    justificativa: z.string(),
    modelo: z.string(),
    novasTentativas: z.number().int().min(0),
  }),
  z.strictObject({
    situacao: z.literal("erro"),
    resumo: errorSummarySchema,
    novasTentativas: z.number().int().min(0),
  }),
]);

/** Present on every line: the format of the line that this file defines. */
export const LINE_SCHEMA_VERSION = 1;

const hashSchema = z.string().regex(HASH_PATTERN, "formato sha256:<64 hex>");

const verdictSchema = z
  .strictObject({
    resultado: z.enum(["passou", "falhou", "erro"]),
    motivo: z.string().optional(),
    checagens: z.array(checkSchema),
    /** `null`: the judge was not run (error, no evaluation, safe message). */
    juiz: judgeResultSchema.nullable(),
  })
  .superRefine((verdict, ctx) => {
    const { resultado, checagens, juiz } = verdict;
    if (resultado === "passou") {
      if (
        checagens.length === 0 ||
        !checagens.every((check) => check.ok) ||
        juiz?.situacao !== "ok" ||
        !juiz.passou
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["resultado"],
          message:
            "passou exige checagens não vazias e todas ok, e o juiz com passou verdadeiro",
        });
      }
      return;
    }
    if (resultado === "falhou") {
      // The aggregator reads `resultado` as it is: a failure needs its reason
      // in the line itself (no judge, a check that failed, or a judge that
      // said no). Anything else is a pass or an error written as a failure.
      const reasoned =
        juiz === null ||
        checagens.some((check) => !check.ok) ||
        (juiz.situacao === "ok" && !juiz.passou);
      if (!reasoned) {
        ctx.addIssue({
          code: "custom",
          path: ["resultado"],
          message:
            "falhou exige juiz nulo, uma checagem que falhou ou o juiz com passou falso",
        });
      }
      return;
    }
    if (juiz === null) {
      if (checagens.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["checagens"],
          message: "erro de infraestrutura não tem checagens",
        });
      }
      if (verdict.motivo === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["motivo"],
          message: "erro sem juiz exige o motivo",
        });
      }
      return;
    }
    if (juiz.situacao !== "erro") {
      ctx.addIssue({
        code: "custom",
        path: ["juiz"],
        message: "erro com juiz exige que o juiz tenha dado erro",
      });
    }
    if (checagens.length === 0 || !checagens.every((check) => check.ok)) {
      ctx.addIssue({
        code: "custom",
        path: ["checagens"],
        message:
          "erro com juiz exige checagens não vazias e todas ok (senão seria falhou)",
      });
    }
  });

export const execucaoSchema = z.strictObject({
  esquema: z.literal(LINE_SCHEMA_VERSION),
  bateria: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/),
  casoId: z.string().regex(/^CT\d{2}$/),
  execucao: z.number().int().min(1),
  /** The start of the execution, ISO 8601. */
  dataHora: z.iso.datetime(),
  /** The model of the last turn that was answered; null when none was. */
  modelo: z.string().nullable(),
  perfil: z.string(),
  /** Of the files of context/ (profiles and judge prompt included). */
  hashContexto: hashSchema,
  /** Of evals/casos.json. */
  hashCasos: hashSchema,
  turnos: z.array(turnSchema).min(1),
  veredito: verdictSchema,
});

/**
 * Reads a line that was written before: a line with no `esquema` is from the
 * format of ENG-56 (no judge, no hashes) and is refused with a clear message,
 * as is any other version.
 */
export function parseExecutionLine(raw: unknown): ExecutionLine {
  const version =
    typeof raw === "object" && raw !== null && "esquema" in raw
      ? raw.esquema
      : undefined;
  if (version === undefined) {
    throw new Error(
      "Linha de execução no formato antigo (sem o campo esquema): regrave a bateria.",
    );
  }
  if (version !== LINE_SCHEMA_VERSION) {
    throw new Error(
      `Linha de execução com esquema não suportado (esperado ${LINE_SCHEMA_VERSION}).`,
    );
  }
  return execucaoSchema.parse(raw);
}

export type ExecutionLine = z.infer<typeof execucaoSchema>;
export type TurnLine = z.infer<typeof turnSchema>;
export type OpinionLine = z.infer<typeof opinionSchema>;
export type JudgeResult = z.infer<typeof judgeResultSchema>;
export type ErrorSummaryLine = z.infer<typeof errorSummarySchema>;
export type NoticeLine = z.infer<typeof noticeSchema>;

/** What is measured around a turn, whatever its outcome. */
export interface TurnMeasure {
  readonly durationMs: number;
  readonly retries: number;
  readonly notices: readonly NoticeLine[];
}

export function describeErrorSummary(summary: ErrorSummary): ErrorSummaryLine {
  return {
    ...(summary.status === undefined ? {} : { status: summary.status }),
    ...(summary.code === undefined ? {} : { codigo: summary.code }),
    ...(summary.type === undefined ? {} : { tipo: summary.type }),
    mensagem: summary.message,
  };
}

export function describeEvaluation(outcome: EvaluationOutcome): OpinionLine {
  if (outcome.status === "error") {
    return { situacao: "erro", resumo: describeErrorSummary(outcome.summary) };
  }
  return {
    situacao: "ok",
    aprovada: outcome.approved,
    violacoes: outcome.violations.map((violation) => ({
      regra: violation.rule,
      motivo: violation.reason,
    })),
  };
}

function measureOf(question: string, measure: TurnMeasure) {
  return {
    pergunta: question,
    novasTentativas: measure.retries,
    duracaoMs: Math.max(0, Math.round(measure.durationMs)),
    avisos: [...measure.notices],
  };
}

export function answeredTurnLine(
  question: string,
  result: Extract<TurnResult, { status: "answered" }>,
  measure: TurnMeasure,
): TurnLine {
  const { critique } = result;
  return {
    ...measureOf(question, measure),
    situacao: "respondido",
    rascunho: critique.draft,
    autoavaliacao: describeEvaluation(critique.evaluation),
    ...(critique.revision === undefined
      ? {}
      : {
          revisao: {
            texto: critique.revision.text,
            ...(critique.revision.evaluation === undefined
              ? {}
              : {
                  autoavaliacao: describeEvaluation(
                    critique.revision.evaluation,
                  ),
                }),
          },
        }),
    origemFinal: critique.origin,
    respostaFinal: result.text,
    modelo: result.model,
    chamadas: critique.llmCalls,
  };
}

export function failedTurnLine(
  question: string,
  summary: ErrorSummary,
  measure: TurnMeasure,
): TurnLine {
  return {
    ...measureOf(question, measure),
    situacao: "erro",
    erro: describeErrorSummary(summary),
  };
}

export interface ExecutionInput {
  readonly bateria: string;
  readonly casoId: string;
  readonly execucao: number;
  readonly dataHora: string;
  readonly modelo: string | null;
  readonly perfil: string;
  readonly hashContexto: string;
  readonly hashCasos: string;
  readonly turnos: readonly TurnLine[];
  readonly veredito: Verdict;
}

export function buildExecutionLine(input: ExecutionInput): ExecutionLine {
  return {
    esquema: LINE_SCHEMA_VERSION,
    bateria: input.bateria,
    casoId: input.casoId,
    execucao: input.execucao,
    dataHora: input.dataHora,
    modelo: input.modelo,
    perfil: input.perfil,
    hashContexto: input.hashContexto,
    hashCasos: input.hashCasos,
    turnos: [...input.turnos],
    veredito: {
      resultado: input.veredito.resultado,
      ...(input.veredito.motivo === undefined
        ? {}
        : { motivo: input.veredito.motivo }),
      checagens: input.veredito.checagens.map((check) => ({
        tipo: check.tipo,
        alvo: [...check.alvo],
        ok: check.ok,
      })),
      juiz: input.veredito.juiz === null ? null : { ...input.veredito.juiz },
    },
  };
}
