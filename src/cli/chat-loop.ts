// The interactive loop: reads lines, runs the commands and hands the
// questions to the session. The only module that reads the terminal input.
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import type { ChatSession } from "../chat/session.js";
import { HELP_LINES, parseInput } from "./commands.js";
import type { TextSink } from "./renderer.js";

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
}

/** Runs until /sair, end of input or Ctrl+C. Returns the exit code. */
export async function runChat(deps: ChatLoopDeps): Promise<number> {
  const { stdout, stderr, session } = deps;
  const rl = createInterface({ input: deps.input, terminal: false });
  let turn: AbortController | undefined;
  let stopped = false;

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
        break;
      }
      switch (parsed.kind) {
        case "empty":
          break;
        case "unknown":
          stderr.write(`Comando desconhecido: ${parsed.raw}. Digite /ajuda.\n`);
          break;
        case "command":
          if (parsed.name === "limpar") {
            session.clear();
            stdout.write(`${CLEARED_MESSAGE}\n`);
          } else if (parsed.name === "contexto") {
            stdout.write(`${deps.contextText}\n`);
          } else {
            stdout.write(`${HELP_LINES.join("\n")}\n`);
          }
          break;
        case "question": {
          turn = new AbortController();
          try {
            await session.ask(parsed.text, { signal: turn.signal });
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
    return 0;
  } finally {
    deps.shutdown?.removeEventListener("abort", abort);
    rl.off("SIGINT", abort);
    rl.close();
  }
}
