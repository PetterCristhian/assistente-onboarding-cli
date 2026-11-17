// The interactive loop: reads lines, runs the commands and hands the
// questions to the session. The only module that reads the terminal input.
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import type { EvaluationOutcome, TurnCritique } from "../chat/critique.js";
import type { ChatSession, TurnResult } from "../chat/session.js";
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

/** Why the evaluation has no verdict, in a few words. */
function describeEvaluationError(
  outcome: Extract<EvaluationOutcome, { status: "error" }>,
): string {
  const { status, code, message } = outcome.summary;
  const extras = [
    status === undefined ? undefined : `status ${status}`,
    code === undefined ? undefined : `código ${code}`,
  ].filter((extra) => extra !== undefined);
  return extras.length === 0 ? message : `${message} (${extras.join(", ")})`;
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

/** Runs until /sair, end of input or Ctrl+C. Returns the exit code. */
export async function runChat(deps: ChatLoopDeps): Promise<number> {
  const { stdout, stderr, session } = deps;
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
              session.clear();
              stdout.write(`${CLEARED_MESSAGE}\n`);
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
