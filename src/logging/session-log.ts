// The log of a chat session: one JSON line per turn, in logs/ (ignored by
// Git). It writes only through the single safe writer, which redacts every
// string (architecture rule 4), and it reads neither the clock nor the disk
// by itself: both are passed in. A failure to write never reaches the chat.
import type { TurnRecord } from "../chat/session.js";
import type { EvaluationOutcome, TurnCritique } from "../chat/critique.js";
import {
  summarizeError,
  type ErrorSummary,
} from "../security/error-summary.js";
import type { Redactor } from "../security/redact.js";
import type { SafeWriter } from "../security/safe-writer.js";

export interface SessionLogDeps {
  readonly writer: SafeWriter;
  /** The clock; read once, for the name of the file. */
  readonly now: () => Date;
  /** Name of the profile in use, written in each line. */
  readonly profile: string;
  /** For the summary of a failure to write. */
  readonly redact: Redactor;
  /** Where the one warning about a failure to write goes. */
  readonly warn: (text: string) => void;
}

export interface SessionLog {
  /** Relative to the project root, always under logs/. */
  readonly path: string;
  /** Never rejects. */
  append(record: TurnRecord): Promise<void>;
}

const LOG_FOLDER = "logs";

/** The ISO time of the start, without the colons that Windows does not allow. */
function fileStamp(start: Date): string {
  return start.toISOString().replaceAll(":", "");
}

const STATUS_NAMES = {
  answered: "respondido",
  failed: "falhou",
  cancelled: "cancelado",
} as const;

/** The keys of the files that we write are in Portuguese. */
export function describeOutcome(outcome: EvaluationOutcome): object {
  if (outcome.status === "error") {
    return { situacao: "erro", resumo: describeSummary(outcome.summary) };
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

export function describeSummary(summary: ErrorSummary): object {
  return {
    ...(summary.status === undefined ? {} : { status: summary.status }),
    ...(summary.code === undefined ? {} : { codigo: summary.code }),
    ...(summary.type === undefined ? {} : { tipo: summary.type }),
    mensagem: summary.message,
  };
}

function describeCritique(critique: TurnCritique): object {
  return {
    rascunho: critique.draft,
    parecer: describeOutcome(critique.evaluation),
    ...(critique.revision === undefined
      ? {}
      : {
          revisao: {
            texto: critique.revision.text,
            ...(critique.revision.evaluation === undefined
              ? {}
              : { parecer: describeOutcome(critique.revision.evaluation) }),
          },
        }),
    origem: critique.origin,
    regraViolada: critique.violatedRules,
    chamadas: critique.llmCalls,
  };
}

function describeRecord(profile: string, record: TurnRecord): object {
  return {
    perfil: profile,
    momento: record.at,
    situacao: STATUS_NAMES[record.status],
    pergunta: record.question,
    ...(record.model === undefined ? {} : { modelo: record.model }),
    ...(record.critique === undefined ? {} : describeCritique(record.critique)),
    ...(record.summary === undefined
      ? {}
      : { erro: describeSummary(record.summary) }),
  };
}

export function createSessionLog(deps: SessionLogDeps): SessionLog {
  const path = `${LOG_FOLDER}/sessao-${fileStamp(deps.now())}.jsonl`;
  let warned = false;

  return {
    path,
    async append(record) {
      try {
        await deps.writer.appendJsonLine(
          path,
          describeRecord(deps.profile, record),
        );
      } catch (error) {
        // Once: a full disk would otherwise repeat it after every turn. The
        // summary holds status, code, type and message, never the error.
        if (!warned) {
          warned = true;
          deps.warn(
            `Não foi possível gravar o log da sessão (${path}); o chat continua e este aviso não se repete. Motivo: ${summarizeError(error, deps.redact).message}`,
          );
        }
      }
    },
  };
}
