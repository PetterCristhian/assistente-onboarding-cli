// The only place that writes chat text to the terminal streams.
import type { ChatOutput } from "../chat/session.js";

export interface TextSink {
  write(text: string): unknown;
}

export function createTerminalOutput(
  stdout: TextSink,
  stderr: TextSink,
): ChatOutput {
  return {
    chunk(text) {
      stdout.write(text);
    },
    endAnswer() {
      stdout.write("\n");
    },
    notice(_level, text) {
      stderr.write(`${text}\n`);
    },
  };
}
