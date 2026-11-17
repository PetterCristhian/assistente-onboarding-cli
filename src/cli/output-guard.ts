// Turns a write error on stdout/stderr into a clean end of the chat. Without
// an 'error' listener Node throws it as an uncaught exception, with a stack.
import { sanitizeForTerminal, type TextSink } from "./renderer.js";

interface GuardedStream extends TextSink {
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export interface OutputGuard {
  /** 0 after EPIPE, 1 after another write error, undefined if none happened. */
  exitCode(): number | undefined;
}

/** Calls `stop` once, on the first write error of either stream. */
export function guardOutputStreams(
  streams: { readonly stdout: GuardedStream; readonly stderr: GuardedStream },
  stop: () => void,
): OutputGuard {
  let code: number | undefined;

  const handle = (failed: GuardedStream) => (error: unknown) => {
    // Only the first error counts: writing after a failure fails again.
    if (code !== undefined) {
      return;
    }
    const errno =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    code = errno === "EPIPE" ? 0 : 1;
    if (code === 1 && failed !== streams.stderr) {
      const message = error instanceof Error ? error.message : String(error);
      const oneLine = sanitizeForTerminal(message).replace(/\s+/g, " ").trim();
      streams.stderr.write(`erro ao escrever a saída: ${oneLine}\n`);
    }
    stop();
  };

  streams.stdout.on("error", handle(streams.stdout));
  streams.stderr.on("error", handle(streams.stderr));
  return { exitCode: () => code };
}
