// The only place that writes chat text to the terminal streams.
import type { ChatOutput } from "../chat/session.js";

export interface TextSink {
  write(text: string): unknown;
}

// \p{Cc} is exactly the C0 controls, DEL and the C1 controls; newline and tab
// are kept. ESC is among them, so a terminal sequence loses its first byte
// and is printed as inert text. Doing it per chunk is enough: a sequence
// split between two chunks has the ESC in one of them and is neutralized
// there, so no state is needed. The Unicode tag characters (U+E0000 to
// U+E007F) are neutralized too: they are invisible, and a text can hide
// instructions in them. Unlike the broader UNSAFE_TO_PRINT of the config,
// the other format characters (ZWJ in emoji, bidi marks) are kept: model text
// may legitimately contain them.
const TERMINAL_CONTROLS = /(?![\n\t])\p{Cc}|[\u{E0000}-\u{E007F}]/gu;
const CONTROL_MARKER = "�";

/** Display-only: the text kept in the history is never changed. */
export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_CONTROLS, CONTROL_MARKER);
}

// For what is not the body of an answer: reasons of the evaluator, the rule,
// the technical lines, the retraction and the notices. Here every control
// (line breaks and tabs too, so that a text cannot forge a line of its own)
// and every format character is neutralized, bidi marks and tag characters
// included, except the zero-width joiner and non-joiner, which spell some
// scripts and emoji.
const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;
const UNTRUSTED_UNSAFE = /\p{Cc}|\p{Cf}/gu;

/** Longest text that goes through `sanitizeUntrusted`, in characters. */
export const MAX_UNTRUSTED_LENGTH = 1000;
const ELLIPSIS = "…";

function neutralizeUnsafe(character: string): string {
  const code = character.codePointAt(0);
  return code === ZERO_WIDTH_JOINER || code === ZERO_WIDTH_NON_JOINER
    ? character
    : CONTROL_MARKER;
}

/** Display-only, on one line, and never longer than the limit. */
export function sanitizeUntrusted(
  text: string,
  maxLength: number = MAX_UNTRUSTED_LENGTH,
): string {
  const flat = text.replace(UNTRUSTED_UNSAFE, neutralizeUnsafe);
  const characters = [...flat];
  return characters.length <= maxLength
    ? flat
    : `${characters.slice(0, maxLength - 1).join("")}${ELLIPSIS}`;
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
    retraction(text) {
      stdout.write(`${sanitizeUntrusted(text)}\n`);
    },
    notice(_level, text) {
      stderr.write(`${sanitizeUntrusted(text)}\n`);
    },
  };
}
