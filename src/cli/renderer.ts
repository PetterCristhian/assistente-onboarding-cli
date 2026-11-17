// The only place that writes chat text to the terminal streams.
import type { ChatOutput } from "../chat/session.js";

export interface TextSink {
  write(text: string): unknown;
}

// \p{Cc} is exactly the C0 controls, DEL and the C1 controls; newline and tab
// are kept. ESC is among them, so a terminal sequence loses its first byte
// and is printed as inert text. Doing it per chunk is enough: a sequence
// split between two chunks has the ESC in one of them and is neutralized
// there, so no state is needed. Unlike the broader UNSAFE_TO_PRINT of the
// config, format characters (ZWJ in emoji, bidi marks) are kept: model text
// may legitimately contain them.
const TERMINAL_CONTROLS = /(?![\n\t])\p{Cc}/gu;
const CONTROL_MARKER = "�";

/** Display-only: the text kept in the history is never changed. */
export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_CONTROLS, CONTROL_MARKER);
}

export function createTerminalOutput(
  stdout: TextSink,
  stderr: TextSink,
): ChatOutput {
  return {
    chunk(text) {
      stdout.write(sanitizeForTerminal(text));
    },
    endAnswer() {
      stdout.write("\n");
    },
    notice(_level, text) {
      stderr.write(`${sanitizeForTerminal(text)}\n`);
    },
  };
}
