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

const verdictSchema = z.strictObject({
  resultado: z.enum(["passou", "falhou", "erro"]),
  motivo: z.string().optional(),
  checagens: z.array(checkSchema),
  juiz: z.null(),
});

export const execucaoSchema = z.strictObject({
  bateria: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/),
  casoId: z.string().regex(/^CT\d{2}$/),
  execucao: z.number().int().min(1),
  /** The start of the execution, ISO 8601. */
  dataHora: z.iso.datetime(),
  /** The model of the last turn that was answered; null when none was. */
  modelo: z.string().nullable(),
  perfil: z.string(),
  turnos: z.array(turnSchema).min(1),
  veredito: verdictSchema,
});

export type ExecutionLine = z.infer<typeof execucaoSchema>;
export type TurnLine = z.infer<typeof turnSchema>;
export type OpinionLine = z.infer<typeof opinionSchema>;
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
  readonly turnos: readonly TurnLine[];
  readonly veredito: Verdict;
}

export function buildExecutionLine(input: ExecutionInput): ExecutionLine {
  return {
    bateria: input.bateria,
    casoId: input.casoId,
    execucao: input.execucao,
    dataHora: input.dataHora,
    modelo: input.modelo,
    perfil: input.perfil,
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
      juiz: null,
    },
  };
}
