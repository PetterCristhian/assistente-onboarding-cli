// Builds fake credentials at runtime. Test sources must never hold a contiguous
// key-shaped literal: `npm run check:secrets` scans tests/ like any other folder.
//
// Like a real key, a fake one always has digits and upper-case letters: a
// sequence with neither, glued to a letter, is taken for words with hyphens
// (src/security/redact.ts). Use fakeLowerCaseKeyShape() for that case.
export function fakeOpenAiKey(fill = "A"): string {
  return ["sk", "proj", `${fill.repeat(28)}7Qz9`].join("-");
}

/** The prefix and only lower-case letters: shaped like a key, but not a real one. */
export function fakeLowerCaseKeyShape(length = 24): string {
  return ["sk", "a".repeat(length)].join("-");
}

export interface FakeMaskedKeyOptions {
  /** With the `proj-` segment after the prefix. Default: true. */
  project?: boolean;
  /** Default: 40. */
  asterisks?: number;
  /** Characters shown before the asterisks. Default: none. */
  start?: string;
  /** Characters shown after the asterisks. Default: "wXyZ". */
  end?: string;
}

/**
 * The masked form in which the API quotes a rejected key in a 401 message:
 * prefix, asterisks and the last characters. Same rule: built at runtime.
 */
export function fakeMaskedOpenAiKey(
  options: FakeMaskedKeyOptions = {},
): string {
  const body = `${options.start ?? ""}${"*".repeat(options.asterisks ?? 40)}${options.end ?? "wXyZ"}`;
  return ["sk", ...(options.project === false ? [] : ["proj"]), body].join("-");
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Fake keys in the formats that real ones have, with pseudo-random bodies.
 * Seeded, so that a failure can be reproduced: the same seed gives the same
 * keys. Never a real key, and never a literal in the source.
 */
export function createFakeKeyGenerator(seed: number) {
  let state = seed >>> 0;
  // Linear congruential generator (Numerical Recipes), upper bits only.
  const next = (limit: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x1_0000_0000) * limit);
  };
  const body = (alphabet: string, length: number): string =>
    Array.from({ length }, () => alphabet[next(alphabet.length)]).join("");
  const urlSafe = `${BASE62}-_`;

  return {
    /** A letter or digit, to glue before a key. */
    letterOrDigit: (): string => body(BASE62, 1),
    /** The prefix and 48 letters and digits. */
    legacy: (): string => ["sk", body(BASE62, 48)].join("-"),
    /** The prefix, a segment (proj, svcacct, admin) and about 150 characters. */
    withSegment: (segment: string): string =>
      ["sk", segment, body(urlSafe, 150)].join("-"),
  };
}
