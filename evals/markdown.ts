// Sanitizers for text that a model wrote, before it goes into RELATORIO.md.
// The report is read in a Markdown viewer, and that text is not trusted: it may
// try to close a fence, open a heading, a link, a table or HTML, or hide itself
// with control and invisible characters. Every such text enters the report
// either inside a fenced block (fenceBlock) or as escaped inline text
// (inlineText). Pure: no disk, no clock.

/** Appended to a block that was cut. */
export const TRUNCATION_NOTE =
  "(cortado; o texto completo está em execucoes.jsonl)";

export const MAX_BLOCK_LENGTH = 4000;
export const MAX_INLINE_LENGTH = 300;
const MIN_FENCE_LENGTH = 4;

// Controls (but not \n and \t), format characters (bidi, zero width, soft
// hyphen, tag characters), the line and paragraph separators and lone
// surrogates. The tag block is listed because most of its code points are
// unassigned, hence not \p{Cf}, and are still invisible in some renderers.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u{E0000}-\u{E007F}]/gu;

/**
 * Shows what cannot be seen as ⟦U+XXXX⟧. "\n" and "\t" stay; "\r\n" is read as
 * "\n" (a file written on Windows is not an attack), a lone "\r" is shown.
 */
export function visibleControls(text: string): string {
  return text.replaceAll("\r\n", "\n").replace(INVISIBLE, (character) => {
    if (character === "\n" || character === "\t") {
      return character;
    }
    const code = character.codePointAt(0) ?? 0;
    return `⟦U+${code.toString(16).toUpperCase().padStart(4, "0")}⟧`;
  });
}

function cutAt(text: string, max: number): string {
  // By code point, so that a surrogate pair is never split.
  return text.length <= max ? text : [...text].slice(0, max).join("");
}

/** Cuts a block that is too long and says so (the note is inside the block). */
export function truncateBlock(text: string, max = MAX_BLOCK_LENGTH): string {
  if ([...text].length <= max) {
    return text;
  }
  return `${cutAt(text, max)}\n${TRUNCATION_NOTE}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return longest;
}

/**
 * A fenced block whose fence is longer than any run of backticks in the text
 * (at least 4), so the text never closes it. The text is not changed here:
 * `visibleControls` and `truncateBlock` are the caller's choice.
 */
export function fenceBlock(text: string): string {
  const fence = "`".repeat(
    Math.max(MIN_FENCE_LENGTH, longestBacktickRun(text) + 1),
  );
  return `${fence}\n${text}\n${fence}`;
}

/** A block of untrusted text: visible controls, cut, then fenced. */
export function untrustedBlock(text: string): string {
  return fenceBlock(truncateBlock(visibleControls(text)));
}

const INLINE_SPECIALS = /[\\`*_[\]()<>|#!~&]/g;

/**
 * One line of untrusted text for the report: controls made visible, line
 * breaks flattened, cut to `max` characters, and every sign of Markdown (and
 * of an automatic link) escaped, so that it renders as plain text.
 */
export function inlineText(text: string, max = MAX_INLINE_LENGTH): string {
  const flat = visibleControls(text)
    .replace(/\s*\n\s*/g, " ")
    .replace(/\t/g, " ");
  const cut = [...flat].length > max ? `${cutAt(flat, max)}…` : flat;
  return cut
    .replace(INLINE_SPECIALS, (sign) => `\\${sign}`)
    .replaceAll("://", ":\\//")
    .replace(/www\./gi, (match) => `${match.slice(0, 3)}\\.`)
    // E-mail autolinks (a@b.co) and the mailto:/xmpp: schemes become links too.
    .replaceAll("@", "\\@")
    .replace(/\b(mailto|xmpp):/gi, (_match, scheme: string) => `${scheme}\\:`);
}

/** A table cell: our own data; inlineText escapes the pipe and flattens lines. */
export function tableCell(text: string): string {
  return inlineText(text, 120);
}
