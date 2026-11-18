// The interactive loop: reads lines, runs the commands and hands the
// questions to the session. The only module that reads the terminal input.
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import type { EvaluationOutcome, TurnCritique } from "../chat/critique.js";
import type { ChatSession, TurnResult } from "../chat/session.js";
import type { StatefulSession } from "../memory/stateful-session.js";
import { HELP_LINES, parseInput } from "./commands.js";
import {
  sanitizeForTerminal,
  sanitizeUntrusted,
  type TextSink,
} from "./renderer.js";

const PROMPT = "> ";
const CLEARED_MESSAGE = "Histórico apagado.";
const DETAILS_ON_MESSAGE = "Detalhes ligados.";
const DETAILS_OFF_MESSAGE = "Detalhes desligados.";

export interface ChatLoopDeps {
  readonly input: Readable;
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly session: ChatSession;
  /**
   * The same session, with its state on the disk: turns on the commands of
   * the session, of the memory and of the compression.
   */
  readonly stateful?: StatefulSession;
  /** The assembled context, as printed by /contexto. */
  readonly contextText: string;
  readonly profileName: string;
  /** Aborted when the program is told to stop (Ctrl+C). */
  readonly shutdown?: AbortSignal;
  /**
   * Starts the detailed mode: after each answered turn, a technical line and
   * the result of the self-evaluation, on stderr. /detalhes toggles it.
   */
  readonly verbose?: boolean;
  /** Milliseconds, monotonic. Default: performance.now. */
  readonly now?: () => number;
}

type Answered = Extract<TurnResult, { status: "answered" }>;

/** Never the question, the answer or the context: only counts and names. */
function turnDetails(result: Answered, elapsedMs: number): string {
  const tokens =
    result.usage === undefined
      ? "?/?"
      : `${result.usage.inputTokens}/${result.usage.outputTokens}`;
  return `${sanitizeUntrusted(
    `[detalhes] modelo=${result.model} trechos=${result.chunks} tokens=${tokens} tempo=${Math.round(elapsedMs)}ms`,
  )}\n`;
}

/**
 * Why the evaluation has no verdict: fixed text plus status, code and type.
 * The `message` of the summary is never shown (it is the raw text of the SDK
 * for an API error, and the one of a 401 quotes the key, masked); it stays in
 * the log only.
 */
function describeEvaluationError(
  outcome: Extract<EvaluationOutcome, { status: "error" }>,
): string {
  const { status, code, type } = outcome.summary;
  const extras = [
    status === undefined ? undefined : `status ${status}`,
    code === undefined ? undefined : `código ${code}`,
    type === undefined ? undefined : `tipo ${type}`,
  ].filter((extra) => extra !== undefined);
  return extras.length === 0
    ? "falha na avaliação"
    : `falha na avaliação (${extras.join(", ")})`;
}

/**
 * The result of the self-evaluation. The text of the reasons comes from the
 * model: the line is neutralized as a whole before it is printed.
 */
function critiqueDetails(critique: TurnCritique): string {
  const { evaluation } = critique;
  const tail = `origem=${critique.origin}; chamadas=${critique.llmCalls}`;
  let line: string;
  if (evaluation.status === "error") {
    line = `[autoavaliação] erro: ${describeEvaluationError(evaluation)}; ${tail}`;
  } else if (evaluation.approved) {
    line = "[autoavaliação] aprovada";
  } else {
    const violations = evaluation.violations
      .map((violation) => `${violation.rule} (${violation.reason})`)
      .join(", ");
    line = `[autoavaliação] reprovada: ${violations}; ${tail}`;
  }
  return `${sanitizeUntrusted(line)}\n`;
}

const NO_STATE_MESSAGE = "Comando indisponível: esta sessão não é gravada.";

function sessionLine(stateful: StatefulSession): string {
  return `Sessão: ${stateful.id} (para retomar: npm run chat -- --sessao ${stateful.id})`;
}

function tokensLine(stateful: StatefulSession): string {
  const stats = stateful.stats();
  return `Histórico enviado: ${stats.history.messages} mensagens, ~${stats.history.tokens} tokens; resumo: ~${stats.summaryTokens} tokens; turnos gravados: ${stats.totalTurns}.`;
}

/** The text of the items comes from the model: neutralized as a whole. */
function memoryLines(stateful: StatefulSession): string {
  if (!stateful.memoryEnabled) {
    return "Memória desligada nesta execução (--sem-memoria).\n";
  }
  const items = stateful.memoryItems();
  if (items.length === 0) {
    return "Memória vazia.\n";
  }
  // One line at a time: a line break inside the text of an item is
  // neutralized, the ones between the items are not.
  return [
    `Memória (${items.length} ${items.length === 1 ? "item" : "itens"}):`,
    ...items.map((item) =>
      sanitizeUntrusted(
        `  [${item.categoria}] ${item.texto} (${item.criadoEm.slice(0, 10)}, sessão ${item.sessao})`,
      ),
    ),
    "",
  ].join("\n");
}

/** Which memory items went into the context of the question. */
function selectionDetails(stateful: StatefulSession): string {
  const selected = stateful.lastSelection();
  const line =
    selected.length === 0
      ? "[memória] nenhum item usado nesta pergunta"
      : `[memória] itens no contexto: ${selected.map((item) => `${item.id} (${item.categoria})`).join(", ")}`;
  return `${sanitizeUntrusted(`${line}; ${tokensLine(stateful)}`)}\n`;
}

/** Runs until /sair, end of input or Ctrl+C. Returns the exit code. */
export async function runChat(deps: ChatLoopDeps): Promise<number> {
  const { stdout, stderr, session, stateful } = deps;
  const now = deps.now ?? (() => performance.now());
  const rl = createInterface({ input: deps.input, terminal: false });
  let turn: AbortController | undefined;
  let stopped = false;
  let leftByCommand = false;
  let detailed = deps.verbose === true;

  // Idempotent: cancels the running turn and ends the loop.
  const abort = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    turn?.abort();
    rl.close();
  };
  rl.on("SIGINT", abort);
  deps.shutdown?.addEventListener("abort", abort);

  try {
    // A closed interface never ends a `for await`: leave before it.
    if (deps.shutdown?.aborted === true) {
      return 0;
    }
    stdout.write(`Olá, ${deps.profileName}.\n`);
    if (stateful !== undefined) {
      stdout.write(`${sessionLine(stateful)}\n`);
      const turns = stateful.stats().totalTurns;
      if (turns > 0) {
        stdout.write(
          `Sessão retomada: ${turns} ${turns === 1 ? "turno anterior" : "turnos anteriores"}.\n`,
        );
      }
    }
    stdout.write(`${HELP_LINES.join("\n")}\n`);
    stdout.write(PROMPT);

    for await (const line of rl) {
      const parsed = parseInput(line);
      if (parsed.kind === "command" && parsed.name === "sair") {
        leftByCommand = true;
        break;
      }
      switch (parsed.kind) {
        case "empty":
          break;
        case "unknown":
          stderr.write(
            `Comando desconhecido: ${sanitizeForTerminal(parsed.raw)}. Digite /ajuda.\n`,
          );
          break;
        case "command":
          switch (parsed.name) {
            case "limpar":
              if (stateful === undefined) {
                session.clear();
                stdout.write(`${CLEARED_MESSAGE}\n`);
              } else {
                await stateful.clear();
                stdout.write(
                  `${CLEARED_MESSAGE} A memória do perfil foi mantida (use /esquecer para apagá-la).\n`,
                );
              }
              break;
            case "sessao":
              stdout.write(
                `${stateful === undefined ? NO_STATE_MESSAGE : sessionLine(stateful)}\n`,
              );
              break;
            case "memoria":
              stdout.write(
                stateful === undefined
                  ? `${NO_STATE_MESSAGE}\n`
                  : memoryLines(stateful),
              );
              break;
            case "esquecer":
              if (stateful === undefined) {
                stdout.write(`${NO_STATE_MESSAGE}\n`);
              } else {
                const forgotten = await stateful.forgetMemory();
                stdout.write(
                  `Memória apagada (${forgotten} ${forgotten === 1 ? "item" : "itens"}).\n`,
                );
              }
              break;
            case "tokens":
              stdout.write(
                `${stateful === undefined ? NO_STATE_MESSAGE : tokensLine(stateful)}\n`,
              );
              break;
            case "comprimir":
              if (stateful === undefined) {
                stdout.write(`${NO_STATE_MESSAGE}\n`);
              } else {
                turn = new AbortController();
                try {
                  const report = await stateful.compressNow(turn.signal);
                  if (report === undefined) {
                    stdout.write("Nada a comprimir.\n");
                  }
                } finally {
                  turn = undefined;
                }
              }
              break;
            case "contexto":
              stdout.write(`${sanitizeForTerminal(deps.contextText)}\n`);
              break;
            case "detalhes":
              // Takes no slot of the rate limit: it never reaches the model.
              detailed = !detailed;
              stdout.write(
                `${detailed ? DETAILS_ON_MESSAGE : DETAILS_OFF_MESSAGE}\n`,
              );
              break;
            case "ajuda":
              stdout.write(`${HELP_LINES.join("\n")}\n`);
              break;
            case "sair":
              // Left above, before the switch; kept so that none falls through.
              break;
          }
          break;
        case "question": {
          turn = new AbortController();
          try {
            const startedAt = now();
            const result = await session.ask(parsed.text, {
              signal: turn.signal,
            });
            if (detailed && result.status === "answered") {
              stderr.write(turnDetails(result, now() - startedAt));
              stderr.write(critiqueDetails(result.critique));
              if (stateful !== undefined) {
                stderr.write(selectionDetails(stateful));
              }
            }
          } finally {
            turn = undefined;
          }
          break;
        }
      }
      if (stopped) {
        break;
      }
      stdout.write(PROMPT);
    }
    // End of input: the last prompt has no newline; do not leave the shell's
    // cursor on that line. After /sair or Ctrl+C there is nothing to finish.
    if (!leftByCommand && !stopped) {
      stdout.write("\n");
    }
    return 0;
  } finally {
    deps.shutdown?.removeEventListener("abort", abort);
    rl.off("SIGINT", abort);
    rl.close();
  }
}
