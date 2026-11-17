// The runner of the battery (ADR 0006): runs every case through the pipeline
// of the chat (`createChatSession`, architecture rule 6), in a new session per
// execution, applies the deterministic checks and writes one line per
// execution to outputs/<id>/execucoes.jsonl through the single safe writer.
// It has no pipeline of its own: the session does the draft, the evaluation,
// the revision, the retry and the wait for the local limit.
//
// Everything that varies is passed in (the client, the clocks, the limiter,
// the writer, where to print): the tests need no network and no real time.
import {
  waitSecondsFor,
  type AcquireOptions,
  type RateLimiter,
} from "../src/chat/rate-limiter.js";
import { createChatSession, type TurnResult } from "../src/chat/session.js";
import { sanitizeUntrusted } from "../src/cli/renderer.js";
import type { LlmClient } from "../src/llm/client.js";
import {
  summarizeError,
  type ErrorSummary,
} from "../src/security/error-summary.js";
import type { Redactor } from "../src/security/redact.js";
import type { SafeWriter } from "../src/security/safe-writer.js";
import type { StreamRedactor } from "../src/security/stream-redact.js";
import { createCollectingOutput } from "./collector.js";
import type { BatteryContext } from "./contexts.js";
import {
  answeredTurnLine,
  buildExecutionLine,
  failedTurnLine,
  type ExecutionLine,
  type TurnLine,
} from "./record.js";
import { createRetryCounter } from "./retry-count.js";
import type { Caso } from "./schema.js";
import { buildVerdict, type Outcome } from "./verdict.js";

export const OUTPUTS_FOLDER = "outputs";
export const EXECUTIONS_FILE = "execucoes.jsonl";

export interface PlannedExecution {
  readonly caso: Caso;
  /** From 1: which run of the case this is. */
  readonly execucao: number;
}

/** By rounds: round 1 with every case, then round 2, and so on. */
export function planExecutions(
  cases: readonly Caso[],
  runs: number,
): PlannedExecution[] {
  const planned: PlannedExecution[] = [];
  for (let execucao = 1; execucao <= runs; execucao += 1) {
    for (const caso of cases) {
      planned.push({ caso, execucao });
    }
  }
  return planned;
}

export interface BatteryDeps {
  readonly cases: readonly Caso[];
  /** Executions of each case. */
  readonly runs: number;
  /** The name of the folder in outputs/. */
  readonly batteryId: string;
  readonly llm: LlmClient;
  /** By profile slug, for every profile that the cases use. */
  readonly contexts: ReadonlyMap<string, BatteryContext>;
  readonly redact: Redactor;
  readonly redactStream: () => StreamRedactor;
  /** One for the whole battery: the limit counts all the questions. */
  readonly limiter: RateLimiter;
  readonly writer: SafeWriter;
  /** The date and time of each execution. */
  readonly now: () => Date;
  /** A monotonic clock in milliseconds, for the durations. */
  readonly nowMs: () => number;
  /** Receives whole lines, line break included. */
  readonly print: (text: string) => void;
  readonly signal?: AbortSignal;
}

export interface BatteryCounts {
  passou: number;
  falhou: number;
  erro: number;
}

export interface BatteryResult {
  /** Relative to the project root. */
  readonly folder: string;
  readonly file: string;
  /** The lines written, in order. */
  readonly lines: readonly ExecutionLine[];
  /** How many executions the battery had to run. */
  readonly expected: number;
  readonly interrupted: boolean;
  readonly counts: BatteryCounts;
}

/** 0 = every execution passed; 1 = one failed or erred; 130 = interrupted. */
export function exitCodeFor(result: BatteryResult): number {
  if (result.interrupted) {
    return 130;
  }
  const { counts } = result;
  return counts.falhou === 0 &&
    counts.erro === 0 &&
    result.lines.length === result.expected
    ? 0
    : 1;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1).replace(".", ",")} s`;
}

/** The reading of one execution, before the verdict. */
interface Played {
  readonly turns: TurnLine[];
  readonly outcome: Outcome;
  readonly model: string | null;
  readonly origin: string | null;
}

const UNEXPECTED_RATE_LIMIT: ErrorSummary = {
  message: "limite local atingido durante a espera (inesperado)",
};

export async function runBattery(deps: BatteryDeps): Promise<BatteryResult> {
  const planned = planExecutions(deps.cases, deps.runs);
  const total = planned.length;
  const folder = `${OUTPUTS_FOLDER}/${deps.batteryId}`;
  const file = `${folder}/${EXECUTIONS_FILE}`;
  const lines: ExecutionLine[] = [];
  const counts: BatteryCounts = { passou: 0, falhou: 0, erro: 0 };
  let interrupted = false;

  const show = (text: string): void => {
    deps.print(`${sanitizeUntrusted(deps.redact(text))}\n`);
  };

  // The wait for the local limit is shown as it happens; the session also
  // keeps its own notice, which goes to the record of the turn.
  const observedLimiter: RateLimiter = {
    maxRequests: deps.limiter.maxRequests,
    windowSeconds: deps.limiter.windowSeconds,
    tryAcquire: () => deps.limiter.tryAcquire(),
    acquire: (options: AcquireOptions = {}) =>
      deps.limiter.acquire({
        ...options,
        onWait: (retryAfterMs) => {
          show(`  aguardando ${waitSecondsFor(retryAfterMs)} s (limite local)`);
          options.onWait?.(retryAfterMs);
        },
      }),
  };

  async function play(
    caso: Caso,
    context: BatteryContext,
  ): Promise<Played | "cancelled"> {
    const counter = createRetryCounter(deps.llm);
    const collector = createCollectingOutput();
    // No turn hook: the battery does not write the log of a chat session.
    const session = createChatSession({
      llm: counter.client,
      instructions: context.instructions,
      critique: context.critique,
      output: collector,
      redact: deps.redact,
      redactStream: deps.redactStream,
      now: deps.now,
      rateLimit: { limiter: observedLimiter, mode: "wait" },
    });

    const turns: TurnLine[] = [];
    let model: string | null = null;
    let last: Extract<TurnResult, { status: "answered" }> | undefined;

    for (const [index, question] of caso.turnos.entries()) {
      counter.reset();
      collector.take();
      const started = deps.nowMs();
      let result: TurnResult | undefined;
      let thrown: ErrorSummary | undefined;
      try {
        result = await session.ask(
          question,
          deps.signal === undefined ? {} : { signal: deps.signal },
        );
      } catch (error) {
        // Only what escapes the session: the write to the disk is outside.
        thrown = summarizeError(error, deps.redact);
      }
      const measure = {
        durationMs: deps.nowMs() - started,
        retries: counter.retries(),
        notices: collector.take().notices,
      };

      if (result?.status === "cancelled" || deps.signal?.aborted === true) {
        return "cancelled";
      }
      if (result?.status === "answered") {
        turns.push(answeredTurnLine(question, result, measure));
        model = result.model;
        last = result;
        continue;
      }
      const summary =
        thrown ??
        (result?.status === "failed" ? result.summary : UNEXPECTED_RATE_LIMIT);
      turns.push(failedTurnLine(question, summary, measure));
      return {
        turns,
        outcome: {
          kind: "error",
          motivo: `turno ${index + 1} de ${caso.turnos.length} falhou`,
        },
        model,
        origin: null,
      };
    }

    if (last === undefined) {
      // Unreachable: a case has at least one turn. Never a pass by default.
      return {
        turns,
        outcome: { kind: "error", motivo: "nenhum turno foi respondido" },
        model,
        origin: null,
      };
    }
    const { critique } = last;
    return {
      turns,
      outcome: {
        kind: "answered",
        text: last.text,
        origin: critique.origin,
        evaluationFailed:
          critique.evaluation.status === "error" ||
          critique.revision?.evaluation?.status === "error",
      },
      model,
      origin: critique.origin,
    };
  }

  for (const [index, { caso, execucao }] of planned.entries()) {
    if (deps.signal?.aborted === true) {
      interrupted = true;
      break;
    }
    const context = deps.contexts.get(caso.perfil);
    if (context === undefined) {
      throw new Error(`${caso.id}: o contexto do perfil não foi carregado.`);
    }
    const position = String(index + 1).padStart(String(total).length);
    const label = `[${position}/${total}] ${caso.id} execução ${execucao}/${deps.runs}`;
    show(`${label} ...`);

    const startedAt = deps.now().toISOString();
    const started = deps.nowMs();
    const played = await play(caso, context);
    if (played === "cancelled") {
      // An execution cut in the middle is not a result: it is not written.
      interrupted = true;
      break;
    }
    const veredito = buildVerdict(caso, played.outcome);
    const line = buildExecutionLine({
      bateria: deps.batteryId,
      casoId: caso.id,
      execucao,
      dataHora: startedAt,
      modelo: played.model,
      perfil: caso.perfil,
      turnos: played.turns,
      veredito,
    });
    // Not caught: a battery that cannot write its evidence must stop.
    await deps.writer.appendJsonLine(file, line);
    lines.push(line);
    counts[veredito.resultado] += 1;

    const detail =
      veredito.resultado === "erro"
        ? (veredito.motivo ?? "sem motivo")
        : `origem ${played.origin ?? "-"}`;
    show(
      `${label} ... ${veredito.resultado} | ${detail} | ${formatSeconds(deps.nowMs() - started)}`,
    );
  }

  show(
    `Resumo: ${lines.length} de ${total} execuções gravadas | passou ${counts.passou} | falhou ${counts.falhou} | erro ${counts.erro}`,
  );
  if (interrupted) {
    show("Bateria interrompida antes do fim.");
  }
  show(
    lines.length === 0 ? "Nenhuma execução foi gravada." : `Pasta: ${folder}/`,
  );

  return { folder, file, lines, expected: total, interrupted, counts };
}
