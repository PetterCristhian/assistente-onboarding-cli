// Logic of `npm run smoke:llm` (entry point: scripts/smoke-llm.ts): two short
// calls through the LlmClient, to confirm against the real API what
// docs/adr/0002-modelo-e-api-openai.md states. It spends credit: it is run by
// hand, by the owner of the key, and never by the gate nor by the CI.
//
// Pure with respect to the outside: the client, the clock and the redactor
// are parameters, nothing is printed and nothing is written to disk.
import { z } from "zod";
import {
  summarizeError,
  type ErrorSummary,
} from "../security/error-summary.js";
import type { Redactor } from "../security/redact.js";
import type { LlmClient, LlmUsage } from "./client.js";

// Generic on purpose: nothing of the project's domain goes into the code.
export const SMOKE_INSTRUCTIONS =
  "Responda em português do Brasil, em três frases curtas.";
const SMOKE_QUESTION = "Explique o que é um teste de fumaça em software.";
const STRUCTURED_INSTRUCTIONS = "Responda somente com o objeto pedido.";
const STRUCTURED_QUESTION =
  "Quanto é dois mais dois? Responda por extenso e informe a sua confiança.";
const smokeSchema = z.object({
  resposta: z.string(),
  confianca: z.enum(["baixa", "media", "alta"]),
});
const SMOKE_SCHEMA_NAME = "smoke_answer";

export interface SmokeOptions {
  /** The configured model, to show next to the one that answered. */
  readonly requestedModel: string;
  /** A clock in milliseconds. Only differences between readings are used. */
  readonly now: () => number;
  /** Applied to everything that comes from the provider. */
  readonly redact: Redactor;
}

export interface SmokeFailure {
  readonly ok: false;
  /** Status, code, type and message only: never the error itself. */
  readonly error: ErrorSummary;
}

export interface SmokeStreamingSuccess {
  readonly ok: true;
  readonly model: string;
  readonly chunks: number;
  readonly textLength: number;
  readonly firstChunkMs: number | null;
  readonly totalMs: number;
  readonly usage?: LlmUsage;
}

export interface SmokeStructuredSuccess {
  readonly ok: true;
  readonly model: string;
  /** The validated object, as one line of JSON. */
  readonly objectJson: string;
  readonly totalMs: number;
  readonly usage?: LlmUsage;
}

export interface SmokeCheck {
  readonly name: string;
  readonly passed: boolean;
}

export interface SmokeReport {
  readonly requestedModel: string;
  readonly streaming: SmokeStreamingSuccess | SmokeFailure;
  readonly structured: SmokeStructuredSuccess | SmokeFailure;
  readonly checks: readonly SmokeCheck[];
  /** True only with more than one chunk and a valid object. */
  readonly passed: boolean;
}

// What a provider writes must not break a line nor drive the terminal.
const UNSAFE_TO_PRINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const UNSAFE_TO_PRINT_MARKER = "�";

function oneLine(text: string, redact: Redactor): string {
  return redact(text).replace(UNSAFE_TO_PRINT, UNSAFE_TO_PRINT_MARKER);
}

function failure(error: unknown, redact: Redactor): SmokeFailure {
  const summary = summarizeError(error, redact);
  return {
    ok: false,
    error: { ...summary, message: oneLine(summary.message, redact) },
  };
}

function optionalUsage(usage: LlmUsage | undefined): { usage?: LlmUsage } {
  return usage === undefined ? {} : { usage };
}

async function smokeStreaming(
  client: LlmClient,
  { now, redact }: SmokeOptions,
): Promise<SmokeStreamingSuccess | SmokeFailure> {
  const startedAt = now();
  let firstChunkAt: number | null = null;
  try {
    const result = await client.streamText({
      instructions: SMOKE_INSTRUCTIONS,
      input: [{ role: "user", content: SMOKE_QUESTION }],
      onChunk: () => {
        firstChunkAt ??= now();
      },
    });
    const finishedAt = now();
    return {
      ok: true,
      model: oneLine(result.model, redact),
      chunks: result.chunks,
      textLength: result.text.length,
      firstChunkMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
      totalMs: finishedAt - startedAt,
      ...optionalUsage(result.usage),
    };
  } catch (error) {
    return failure(error, redact);
  }
}

async function smokeStructured(
  client: LlmClient,
  { now, redact }: SmokeOptions,
): Promise<SmokeStructuredSuccess | SmokeFailure> {
  const startedAt = now();
  try {
    const result = await client.generateStructured({
      instructions: STRUCTURED_INSTRUCTIONS,
      input: [{ role: "user", content: STRUCTURED_QUESTION }],
      schema: smokeSchema,
      schemaName: SMOKE_SCHEMA_NAME,
    });
    const finishedAt = now();
    // Checked again here: the report never calls an object valid on trust.
    const value = smokeSchema.parse(result.value);
    return {
      ok: true,
      model: oneLine(result.model, redact),
      objectJson: oneLine(JSON.stringify(value), redact),
      totalMs: finishedAt - startedAt,
      ...optionalUsage(result.usage),
    };
  } catch (error) {
    return failure(error, redact);
  }
}

/** Makes the two calls, one after the other, with no retry. Never throws. */
export async function runLlmSmoke(
  client: LlmClient,
  options: SmokeOptions,
): Promise<SmokeReport> {
  const streaming = await smokeStreaming(client, options);
  const structured = await smokeStructured(client, options);

  const checks: SmokeCheck[] = [
    { name: "streaming: a chamada terminou sem erro", passed: streaming.ok },
    {
      name: "streaming: mais de um trecho recebido",
      passed: streaming.ok && streaming.chunks > 1,
    },
    {
      name: "streaming: modelo devolvido informado",
      passed: streaming.ok && streaming.model.trim() !== "",
    },
    {
      name: "saída estruturada: objeto válido no schema",
      passed: structured.ok,
    },
    {
      name: "saída estruturada: modelo devolvido informado",
      passed: structured.ok && structured.model.trim() !== "",
    },
  ];

  return {
    requestedModel: oneLine(options.requestedModel, options.redact),
    streaming,
    structured,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

function usageLine(usage: LlmUsage | undefined): string[] {
  return usage === undefined
    ? []
    : [
        `  Tokens: ${usage.inputTokens} de entrada, ${usage.outputTokens} de saída, ${usage.totalTokens} no total`,
      ];
}

function failureLine(failed: SmokeFailure): string {
  return `  Falha: ${JSON.stringify(failed.error)}`;
}

/** The report as text, for the terminal. Holds only what the report holds. */
export function formatSmokeReport(report: SmokeReport): string {
  const { streaming, structured } = report;
  return [
    "Teste de fumaça do cliente OpenAI (2 chamadas reais, sem retry)",
    `Modelo pedido: ${report.requestedModel}`,
    "",
    "[1] Streaming de texto",
    ...(streaming.ok
      ? [
          `  Modelo devolvido: ${streaming.model}`,
          `  Trechos recebidos: ${streaming.chunks}`,
          `  Tamanho do texto: ${streaming.textLength} caracteres`,
          `  Tempo até o primeiro trecho: ${streaming.firstChunkMs === null ? "nenhum trecho" : `${Math.round(streaming.firstChunkMs)} ms`}`,
          `  Tempo total: ${Math.round(streaming.totalMs)} ms`,
          ...usageLine(streaming.usage),
        ]
      : [failureLine(streaming)]),
    "",
    "[2] Saída estruturada",
    ...(structured.ok
      ? [
          `  Modelo devolvido: ${structured.model}`,
          `  Tempo total: ${Math.round(structured.totalMs)} ms`,
          ...usageLine(structured.usage),
          `  Objeto: ${structured.objectJson}`,
        ]
      : [failureLine(structured)]),
    "",
    "Checagens",
    ...report.checks.map(
      (check) => `  [${check.passed ? "ok" : "FALHOU"}] ${check.name}`,
    ),
    "",
    `Resultado: ${report.passed ? "APROVADO" : "REPROVADO"}`,
  ].join("\n");
}
