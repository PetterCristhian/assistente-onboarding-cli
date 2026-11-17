// Normalization used to compare terms and texts without regard to case and
// accents. Shared by the case checks and by the runner verdict.

// Invisible format characters (zero-width space and joiners, soft hyphen, bidi
// marks, BOM): a model can emit them in the middle of a word.
const FORMAT_CHARACTERS = /\p{Cf}/gu;
const COMBINING_MARKS = /\p{M}/gu;
const SHARP_S = /[ßſ]/gu;

/**
 * NFKD (so fullwidth letters and ligatures fold to plain ones), drops format
 * characters and combining marks, lowercases, turns the sharp s into "ss" and
 * collapses runs of whitespace. It does not trim: a term such as "def " keeps
 * its trailing space on purpose.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(FORMAT_CHARACTERS, "")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(SHARP_S, "ss")
    .replace(/\s+/gu, " ");
}
