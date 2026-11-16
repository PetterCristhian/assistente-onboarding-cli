// Central redaction of credentials (docs/adr/0007-protecao-da-credencial.md).
// Pure functions, no global registry: the key in use is passed in explicitly,
// usually through createRedactor([config.openaiApiKey]).

export const REDACTED = "[REDACTED]";

// Single source of the key shape, shared with the repository scan. Two forms:
//   1. the prefix and 20 or more key characters;
//   2. the masked form that the API quotes in a 401 message: the prefix, maybe
//      some key characters, three or more asterisks and whatever follows them.
//      Fewer than three would also take Markdown bold around the prefix. The
//      exact masked format was not confirmed against the real API.
// The asterisk is accepted in form 1 so that a long visible start does not
// leave the asterisks and the last characters behind.
const KEY_PREFIX = "sk-";
const KEY_CHARACTERS = "A-Za-z0-9_-";
const MIN_KEY_LENGTH = 20;
const MIN_MASK_ASTERISKS = 3;

// Only the start of a sequence is matched by a regular expression, with
// bounded quantifiers. The rest is walked by findSecretSpans: an unbounded
// greedy quantifier overflows the stack of the engine on a run of millions of
// key characters ("Maximum call stack size exceeded").
const SECRET_START_SOURCE = `${KEY_PREFIX}(?:[*${KEY_CHARACTERS}]{${MIN_KEY_LENGTH}}|[${KEY_CHARACTERS}]{0,${MIN_KEY_LENGTH - 1}}\\*{${MIN_MASK_ASTERISKS}})`;
const AFTER_SECRET_SOURCE = `[^*${KEY_CHARACTERS}]`;

export interface SecretSpan {
  /** Index of the first character of the sequence. */
  start: number;
  /** Index right after its last character. */
  end: number;
}

/**
 * Finds every sequence shaped like a key, in linear time whatever the length
 * of a sequence. The patterns are created on every call: no `lastIndex` state
 * is shared.
 */
export function findSecretSpans(text: string): SecretSpan[] {
  const secretStart = new RegExp(SECRET_START_SOURCE, "g");
  const afterSecret = new RegExp(AFTER_SECRET_SOURCE, "g");
  const spans: SecretSpan[] = [];

  for (
    let match = secretStart.exec(text);
    match !== null;
    match = secretStart.exec(text)
  ) {
    // The sequence goes on up to the first character that cannot be part of it.
    afterSecret.lastIndex = secretStart.lastIndex;
    const end = afterSecret.exec(text)?.index ?? text.length;
    spans.push({ start: match.index, end });
    secretStart.lastIndex = end;
  }
  return spans;
}

function replaceKeyShapedSequences(text: string): string {
  let result = "";
  let copiedUpTo = 0;
  for (const { start, end } of findSecretSpans(text)) {
    result += text.slice(copiedUpTo, start) + REDACTED;
    copiedUpTo = end;
  }
  return copiedUpTo === 0 ? text : result + text.slice(copiedUpTo);
}

export type Redactor = (text: string) => string;

/**
 * Exact secrets shorter than this (after trimming) are ignored. Eight is far
 * below any real key (the ones of the API have more than 40 characters) and
 * long enough not to match ordinary words or pieces of them by accident.
 * The key-shaped pattern does not depend on this.
 */
export const MIN_EXACT_SECRET_LENGTH = 8;

/**
 * Replaces by `[REDACTED]` every exact occurrence of the given secrets (the
 * ones with at least MIN_EXACT_SECRET_LENGTH characters) and every sequence
 * shaped like a key.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  // An empty secret would make split("") tear the text apart, and a very
  // short one would replace ordinary letters and words all over the text.
  const exactSecrets = secrets
    .filter((secret) => secret.trim().length >= MIN_EXACT_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

  let result = text;
  for (const secret of exactSecrets) {
    result = result.split(secret).join(REDACTED);
  }
  return replaceKeyShapedSequences(result);
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const ownSecrets = [...secrets];
  return (text) => redact(text, ownSecrets);
}
