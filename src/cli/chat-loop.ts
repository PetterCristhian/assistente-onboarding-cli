// The interactive loop: reads lines, runs the commands and hands the
// questions to the session. The only module that reads the terminal input.
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import type { ChatSession, TurnResult } from "../chat/session.js";
import { HELP_LINES, parseInput } from "./commands.js";
import { sanitizeForTerminal, type TextSink } from "./renderer.js";

const PROMPT = "> ";
const CLEARED_MESSAGE = "Histórico apagado.";

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
  /** Prints one technical line per answered turn to stderr. Provisional. */
  readonly verbose?: boolean;
  /** Milliseconds, monotonic. Default: performance.now. */
  readonly now?: () => number;
}

/** Never the question, the answer or the context: only counts and names. */
function turnDetails(
  result: Extract<TurnResult, { status: "answered" }>,
  elapsedMs: number,
): string {
  const tokens =
    result.usage === undefined
      ? "?/?"
      : `${result.usage.inputTokens}/${result.usage.outputTokens}`;
  return sanitizeForTerminal(
    `[detalhes] modelo=${result.model} trechos=${result.chunks} tokens=${tokens} tempo=${Math.round(elapsedMs)}ms\n`,
  );
}

/** Runs until /sair, end of input or Ctrl+C. Returns the exit code. */
export async function runChat(deps: ChatLoopDeps): Promise<number> {
  const { stdout, stderr, session } = deps;
  const now = deps.now ?? (() => performance.now());
  const rl = createInterface({ input: deps.input, terminal: false });
  let turn: AbortController | undefined;
  let stopped = false;
  let leftByCommand = false;

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
          if (parsed.name === "limpar") {
            session.clear();
            stdout.write(`${CLEARED_MESSAGE}\n`);
          } else if (parsed.name === "contexto") {
            stdout.write(`${sanitizeForTerminal(deps.contextText)}\n`);
          } else {
            stdout.write(`${HELP_LINES.join("\n")}\n`);
          }
          break;
        case "question": {
          turn = new AbortController();
          try {
            const startedAt = now();
            const result = await session.ask(parsed.text, {
              signal: turn.signal,
            });
            if (deps.verbose === true && result.status === "answered") {
              stderr.write(turnDetails(result, now() - startedAt));
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
