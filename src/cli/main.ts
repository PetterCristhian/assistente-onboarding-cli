// Entry point of `npm run chat`. Thin: it reads the arguments (the only file
// of src/ that does), wires the pieces, owns Ctrl+C and sets the exit code.
// The key is never an argument: only src/config/env.ts reads the environment.
// Exit codes: 0 = normal end (also --help and --show-context), 1 = invalid
// use, configuration or context problem, 2 = unexpected error.
import { buildEvaluatorContext, type CritiqueDeps } from "../chat/critique.js";
import { createRateLimiter } from "../chat/rate-limiter.js";
import { createChatSession } from "../chat/session.js";
import { ConfigError, loadConfig } from "../config/env.js";
import { buildContext } from "../context/builder.js";
import {
  DEFAULT_CONTEXT_DIR,
  loadContext,
  loadCritiquePrompts,
  loadFallbackMessage,
  type ContextSources,
} from "../context/loaders.js";
import { ContextError } from "../context/types.js";
import { createOpenAiLlmClient } from "../llm/client.js";
import { defaultSleep } from "../llm/retry.js";
import { createRedactor, type Redactor } from "../security/redact.js";
import { createStreamRedactor } from "../security/stream-redact.js";
import { HELP_TEXT, parseCliArgs, toContextOptions } from "./args.js";
import { createInterruptHandler } from "./interrupt.js";
import { guardOutputStreams } from "./output-guard.js";
import { runChat } from "./chat-loop.js";
import { createTerminalOutput, sanitizeForTerminal } from "./renderer.js";

const USAGE_HINT = "Use --help para ver as opções.";

/** The four sources of the context, one line each. Provisional (ENG-53). */
function describeSources(sources: ContextSources): string[] {
  return [
    `[detalhes] instruções globais: ${sources.globalInstructionsFile}`,
    `[detalhes] políticas: ${sources.policiesFile}`,
    `[detalhes] perfil: ${sources.userProfileFile}`,
    `[detalhes] pasta da empresa: ${sources.companyDataDir}`,
  ];
}

async function main(): Promise<number> {
  // Without a key until the configuration exists; replaced by one with it.
  let redactText: Redactor = createRedactor([]);
  // Messages may quote a path taken from the arguments, which can hold
  // terminal control characters: nothing is printed as it came.
  const printError = (message: string): void => {
    console.error(sanitizeForTerminal(redactText(message)));
  };

  // A closed or broken output ends the program: EPIPE (the reader went away)
  // is a normal end, any other write error is a failure; neither prints a
  // stack trace.
  const shutdown = new AbortController();
  const outputs = guardOutputStreams(
    { stdout: process.stdout, stderr: process.stderr },
    () => shutdown.abort(),
  );

  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.kind === "error") {
      printError(`${parsed.message}\n${USAGE_HINT}`);
      return 1;
    }
    if (parsed.kind === "help") {
      process.stdout.write(`${HELP_TEXT}\n`);
      return outputs.exitCode() ?? 0;
    }

    const { options } = parsed;
    const { layers, sources } = loadContext(toContextOptions(options), {
      now: () => new Date(),
    });
    const context = buildContext(layers);
    if (options.verbose) {
      // stderr: with --show-context the stdout holds only the context.
      for (const line of describeSources(sources)) {
        process.stderr.write(`${sanitizeForTerminal(line)}\n`);
      }
    }

    // Before the configuration: no key, no .env, no client, no network.
    if (options.showContext) {
      process.stdout.write(`${sanitizeForTerminal(context.text)}\n`);
      return outputs.exitCode() ?? 0;
    }

    // Also before the configuration: a missing safe message or prompt is a
    // problem of the context, and the chat does not start without them.
    const contextDir = options.contextDir ?? DEFAULT_CONTEXT_DIR;
    const prompts = loadCritiquePrompts(contextDir);
    const critique: CritiqueDeps = {
      evaluatorContext: buildEvaluatorContext(context.sections),
      evaluatorPrompt: prompts.evaluator,
      revisionPrompt: prompts.revision,
      fallbackMessage: loadFallbackMessage(contextDir),
    };

    const config = loadConfig();
    redactText = createRedactor([config.openaiApiKey]);

    // The limit on questions (F9b, ADR 0005): the chat refuses the excess.
    // The clock is monotonic on purpose: a change of the system time, forward
    // or back, must neither free nor block the slots.
    const limiter = createRateLimiter({
      maxRequests: config.rateLimitMaxRequests,
      windowSeconds: config.rateLimitWindowSeconds,
      now: () => performance.now(),
      sleep: defaultSleep,
    });

    const session = createChatSession({
      llm: createOpenAiLlmClient(config),
      instructions: context.text,
      critique,
      output: createTerminalOutput(process.stdout, process.stderr),
      redact: redactText,
      redactStream: () => createStreamRedactor([config.openaiApiKey]),
      now: () => new Date(),
      rateLimit: { limiter, mode: "refuse" },
    });

    // First Ctrl+C: stop in an orderly way (this also ends a wait for a new
    // try). Second: leave now, with the exit code that a write error set.
    const onSigint = createInterruptHandler({
      abort: () => shutdown.abort(),
      exit: () => process.exit(outputs.exitCode() ?? 0),
    });
    process.on("SIGINT", onSigint);
    try {
      const code = await runChat({
        input: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        session,
        contextText: context.text,
        profileName: layers.userProfile.nome,
        shutdown: shutdown.signal,
        verbose: options.verbose,
      });
      return outputs.exitCode() ?? code;
    } finally {
      process.off("SIGINT", onSigint);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      printError(error.message);
      return 1;
    }
    if (error instanceof ContextError) {
      printError(`contexto: ${error.message}`);
      return 1;
    }
    // Only the message, in one line: never the error itself nor its stack.
    const message = error instanceof Error ? error.message : String(error);
    printError(`erro inesperado: ${message.replace(/\s+/g, " ").trim()}`);
    return 2;
  }
}

process.exitCode = await main();
