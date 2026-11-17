// What `npm run eval` does, with everything that touches the world passed in:
// the arguments, the files, the configuration, the client, the clocks, the
// terminal. The entry point (scripts/eval.ts) only wires the real ones.
//
// The order is on purpose, so that nothing costs money before it is right:
// arguments, the cases, the selection of the case, the context of every
// profile, the prompt of the judge and the fingerprints (all BEFORE the key is
// read), the configuration, and only then the client, the limiter and the
// folder.
//
// Exit codes: 0 = every execution passed; 1 = one failed or erred; 2 = the
// battery did not run (invalid use, configuration, context, an unexpected
// error, a failure to write); 130 = interrupted.
import { createRateLimiter } from "../src/chat/rate-limiter.js";
import { sanitizeForTerminal, type TextSink } from "../src/cli/renderer.js";
import { ConfigError, type AppConfig } from "../src/config/env.js";
import { loadJudgePrompt, readContextTree } from "../src/context/loaders.js";
import { ContextError } from "../src/context/types.js";
import type { LlmClient } from "../src/llm/client.js";
import { summarizeError } from "../src/security/error-summary.js";
import { createRedactor, type Redactor } from "../src/security/redact.js";
import {
  createSafeWriter,
  type SafeWriter,
} from "../src/security/safe-writer.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import { EVAL_HELP_TEXT, parseEvalArgs } from "./args.js";
import { uniqueBatteryId } from "./battery-id.js";
import { hashContextFiles, hashText } from "./context-hash.js";
import { loadBatteryContexts } from "./contexts.js";
import { createJudge } from "./judge.js";
import { exitCodeFor, runBattery } from "./runner.js";
import { parseCases, type Caso } from "./schema.js";

const USAGE_HINT = "Use --help para ver as opções.";

export interface EvalCliDeps {
  readonly argv: readonly string[];
  /** The text of evals/casos.json. */
  readonly readCases: () => string;
  /** The folder with the four layers and the prompts. */
  readonly contextDir: string;
  /** The project root, for the safe writer. Default: the real one. */
  readonly rootDir?: string;
  /** Reads the environment. Called only after the context is known good. */
  readonly loadConfig: () => AppConfig;
  readonly createClient: (config: AppConfig) => LlmClient;
  /** A monotonic clock in milliseconds: durations and the local limit. */
  readonly nowMs: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => Date;
  /** Whether outputs/<id> exists already. */
  readonly folderExists: (id: string) => boolean;
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly signal?: AbortSignal;
}

/** The disk refused a line: the battery stops, with a message of its own. */
class EvidenceWriteError extends Error {
  override readonly name = "EvidenceWriteError";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function selectCases(
  cases: readonly Caso[],
  caseId: string | undefined,
): { selected: Caso[] } | { unknown: string[] } {
  if (caseId === undefined) {
    return { selected: [...cases] };
  }
  const selected = cases.filter((caso) => caso.id === caseId);
  return selected.length > 0
    ? { selected }
    : { unknown: cases.map((caso) => caso.id) };
}

export async function runEvalCli(deps: EvalCliDeps): Promise<number> {
  // Without a key until the configuration exists; replaced by one with it.
  let redactText: Redactor = createRedactor([]);
  const printError = (message: string): void => {
    deps.stderr.write(`${sanitizeForTerminal(redactText(message))}\n`);
  };

  try {
    const parsed = parseEvalArgs(deps.argv);
    if (parsed.kind === "error") {
      printError(`${parsed.message}\n${USAGE_HINT}`);
      return 2;
    }
    if (parsed.kind === "help") {
      deps.stdout.write(`${EVAL_HELP_TEXT}\n`);
      return 0;
    }
    const { options } = parsed;

    const rawCases = deps.readCases();
    const cases = parseCases(rawCases);
    const choice = selectCases(cases, options.caseId);
    if ("unknown" in choice) {
      printError(
        `O caso informado não existe. Casos válidos: ${choice.unknown.join(", ")}.\n${USAGE_HINT}`,
      );
      return 2;
    }
    const { selected } = choice;

    // Before the configuration: no key, no .env, no client, no call.
    const contexts = loadBatteryContexts({
      cases: selected,
      contextDir: deps.contextDir,
      now: deps.now,
    });

    const judgePrompt = loadJudgePrompt(deps.contextDir);
    // The fingerprints of what is about to run, taken before the key is read.
    const fingerprints = {
      hashContexto: hashContextFiles(readContextTree(deps.contextDir)),
      hashCasos: hashText(rawCases),
    };

    const config = deps.loadConfig();
    redactText = createRedactor([config.openaiApiKey]);
    const redactStream = () => createStreamRedactor([config.openaiApiKey]);

    // One limiter for the whole battery, and it waits (the chat refuses).
    const limiter = createRateLimiter({
      maxRequests: config.rateLimitMaxRequests,
      windowSeconds: config.rateLimitWindowSeconds,
      now: deps.nowMs,
      sleep: deps.sleep,
    });

    const realWriter = createSafeWriter({
      redact: redactText,
      ...(deps.rootDir === undefined ? {} : { rootDir: deps.rootDir }),
    });
    const writer: SafeWriter = {
      ...realWriter,
      appendJsonLine: async (path, value) => {
        try {
          return await realWriter.appendJsonLine(path, value);
        } catch (error) {
          throw new EvidenceWriteError(
            `Não foi possível gravar o resultado em ${path}: ${summarizeError(error, redactText).message} A bateria foi interrompida; o que já foi gravado fica na pasta.`,
          );
        }
      },
    };

    const batteryId = uniqueBatteryId(deps.now(), deps.folderExists);
    // One client for the chatbot and for the judge: one path to the provider.
    const llm = deps.createClient(config);
    const result = await runBattery({
      cases: selected,
      runs: options.runs,
      batteryId,
      llm,
      judge: createJudge({
        llm,
        model: config.evalJudgeModel,
        prompt: judgePrompt,
        redact: redactText,
      }),
      fingerprints,
      contexts,
      redact: redactText,
      redactStream,
      limiter,
      writer,
      now: deps.now,
      nowMs: deps.nowMs,
      print: (text) => deps.stdout.write(text),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    return exitCodeFor(result);
  } catch (error) {
    if (error instanceof ConfigError) {
      printError(error.message);
    } else if (error instanceof ContextError) {
      printError(`contexto: ${error.message}`);
    } else if (error instanceof EvidenceWriteError) {
      printError(oneLine(error.message));
    } else {
      // Only the message, in one line: never the error itself nor its stack.
      const message = error instanceof Error ? error.message : String(error);
      printError(`erro inesperado: ${oneLine(message)}`);
    }
    return 2;
  }
}
