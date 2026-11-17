// Entry point of `npm run chat`. Thin: it wires the pieces, owns Ctrl+C and
// sets the exit code. No command-line option exists yet (issue ENG-50), and
// the key is never read from an argument: only src/config/env.ts reads the
// environment. Exit codes: 0 = normal end, 1 = configuration or context
// problem, 2 = unexpected error.
import { createChatSession } from "../chat/session.js";
import { ConfigError, loadConfig } from "../config/env.js";
import { buildContext } from "../context/builder.js";
import { loadContextLayers } from "../context/loaders.js";
import { ContextError } from "../context/types.js";
import { createOpenAiLlmClient } from "../llm/client.js";
import { createRedactor } from "../security/redact.js";
import { runChat } from "./chat-loop.js";
import { createTerminalOutput } from "./renderer.js";

async function main(): Promise<number> {
  try {
    const config = loadConfig();
    const layers = loadContextLayers({}, { now: () => new Date() });
    const context = buildContext(layers);

    const session = createChatSession({
      llm: createOpenAiLlmClient(config),
      instructions: context.text,
      output: createTerminalOutput(process.stdout, process.stderr),
      redact: createRedactor([config.openaiApiKey]),
    });

    const shutdown = new AbortController();
    const onSigint = (): void => shutdown.abort();
    process.on("SIGINT", onSigint);
    try {
      return await runChat({
        input: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        session,
        contextText: context.text,
        profileName: layers.userProfile.nome,
        shutdown: shutdown.signal,
      });
    } finally {
      process.off("SIGINT", onSigint);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    if (error instanceof ContextError) {
      console.error(`contexto: ${error.message}`);
      return 1;
    }
    // Only the message, in one line: never the error itself nor its stack.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`erro inesperado: ${message.replace(/\s+/g, " ").trim()}`);
    return 2;
  }
}

process.exitCode = await main();
