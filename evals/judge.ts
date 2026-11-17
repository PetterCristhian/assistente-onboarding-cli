// The judge of the battery (ADR 0006, ENG-57): one structured call that decides
// whether the final answer of an execution meets the rubric of its case.
//
// It uses the SAME client as the chatbot (architecture rule 2): the retry, the
// deadline and the cancellation are the ones of src/llm/client.ts, and this file
// neither creates a client nor retries. Only the model differs, and it comes in
// as a parameter (EVAL_JUDGE_MODEL, read by src/config/env.ts).
//
// What the judge reads is a gabarito (the expected behavior and the rubric, from
// the case) and a conversation. The conversation is DATA written by a model
// under test, and it may try to steer the verdict. So it is escaped and put in
// blocks that it cannot close, the prompt says to treat it as data, and `passou`
// is read ONLY from the JSON that the schema validated, never from free text.
import { z } from "zod";
import { cleanReason } from "../src/chat/critique.js";
import type { LlmClient, StructuredRequest } from "../src/llm/client.js";
import { summarizeError } from "../src/security/error-summary.js";
import type { Redactor } from "../src/security/redact.js";
import { describeErrorSummary, type JudgeResult } from "./record.js";
import { createRetryCounter } from "./retry-count.js";

/**
 * What the judge returns. Strict, for the structured output of the provider.
 * The reason comes BEFORE the verdict, so that the model reasons first.
 */
export const judgeSchema = z.strictObject({
  justificativa: z.string(),
  passou: z.boolean(),
});

export const JUDGE_SCHEMA_NAME = "juiz";

/** One turn of the conversation, as the judge reads it. */
export interface JudgeTurn {
  readonly pergunta: string;
  readonly respostaFinal: string;
}

export interface JudgeInput {
  /** The expected behavior of the case, from the case file. */
  readonly comportamentoEsperado: string;
  readonly rubrica: string;
  /** Every turn, in order. The last one is the one that is judged. */
  readonly turnos: readonly JudgeTurn[];
}

export type Judge = (
  input: JudgeInput,
  signal?: AbortSignal,
) => Promise<JudgeResult>;

export interface JudgeDeps {
  readonly llm: LlmClient;
  /** The model of the judge (not the one of the chatbot). */
  readonly model: string;
  /** The text of context/juiz.md. */
  readonly prompt: string;
  readonly redact: Redactor;
}

const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * Format characters go first: `<` + U+200B + `/resposta` must not escape.
 * Then the three signs of markup, so that no text can open or close a block.
 */
function escapeData(text: string): string {
  return text
    .replace(FORMAT_CHARACTERS, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function block(tag: string, text: string): string {
  return `<${tag}>\n${escapeData(text)}\n</${tag}>`;
}

function turnBlock(turn: JudgeTurn, judged: boolean): string {
  const open = judged ? '<turno avaliado="sim">' : "<turno>";
  return `${open}\n${block("pergunta", turn.pergunta)}\n${block("resposta", turn.respostaFinal)}\n</turno>`;
}

export function buildJudgeRequest(
  input: JudgeInput,
  prompt: string,
): Pick<
  StructuredRequest<typeof judgeSchema>,
  "instructions" | "input" | "schema" | "schemaName"
> {
  const last = input.turnos.length - 1;
  const conversation = input.turnos
    .map((turn, index) => turnBlock(turn, index === last))
    .join("\n");
  return {
    instructions: prompt,
    input: [
      {
        role: "user",
        content: [
          block("comportamento_esperado", input.comportamentoEsperado),
          block("rubrica", input.rubrica),
          `<conversa>\n${conversation}\n</conversa>`,
        ].join("\n"),
      },
    ],
    schema: judgeSchema,
    schemaName: JUDGE_SCHEMA_NAME,
  };
}

/**
 * Never throws: any failure (network, retries spent, an answer outside the
 * schema, a refusal) becomes `situacao: "erro"`, with no `passou`. A judge
 * that did not answer is not a judge that approved.
 */
export function createJudge(deps: JudgeDeps): Judge {
  return async (input, signal) => {
    // One counter per call, so that the retries of this judgment are its own.
    const counter = createRetryCounter(deps.llm);
    try {
      const result = await counter.client.generateStructured({
        ...buildJudgeRequest(input, deps.prompt),
        model: deps.model,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        situacao: "ok",
        passou: result.value.passou,
        justificativa: cleanReason(result.value.justificativa, deps.redact),
        modelo: result.model,
        novasTentativas: counter.retries(),
      };
    } catch (error) {
      return {
        situacao: "erro",
        resumo: describeErrorSummary(summarizeError(error, deps.redact)),
        novasTentativas: counter.retries(),
      };
    }
  };
}
