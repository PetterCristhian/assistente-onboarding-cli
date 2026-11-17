// Normalization used to compare terms and texts without regard to case and
// accents. Shared by the case checks and by the runner verdict.

/**
 * NFD, drops combining marks, lowercases and collapses runs of whitespace.
 * It does not trim: a term such as "def " keeps its trailing space on purpose.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ");
}
