// Builds fake credentials at runtime. Test sources must never hold a contiguous
// key-shaped literal: `npm run check:secrets` scans tests/ like any other folder.
export function fakeOpenAiKey(fill = "A"): string {
  return ["sk", "proj", fill.repeat(32)].join("-");
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
