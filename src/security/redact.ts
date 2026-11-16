// Central redaction of credentials (docs/adr/0007-protecao-da-credencial.md).
// Pure functions, no global registry: the key in use is passed in explicitly,
// usually through createRedactor([config.openaiApiKey]).

export const REDACTED = "[REDACTED]";

// Single source of the key shape, shared with the repository scan. Two forms:
//   1. the prefix and 20 or more key characters;
//   2. the masked form that the API quotes in a 401 message: the prefix, maybe
//      some key characters, three or more asterisks and whatever follows them.
//      The exact masked format was not confirmed against the real API.
// In both, the sequence goes on over key characters and runs of three or more
// asterisks. A run of one or two asterisks ends it: that is Markdown (bold or
// italic) around the key, not a mask. Three asterisks right after a key are
// taken with it: they cannot be told from a mask with nothing after it.
//
// The prefix must not come right after an ASCII letter or digit: there it is
// the end of a word (task-, disk-, helpdesk-), and the answers of the model
// are written through redact(). The price is a key glued to a letter or
// digit, which only the exact secret catches. "_" and "-" do not count as
// part of a word: no word ends in "sk" right after them, and a key does come
// after them (NAME_<key>, copy-<key>).
const KEY_PREFIX = "sk-";
const KEY_CHARACTERS = "A-Za-z0-9_-";
const NOT_AFTER = "A-Za-z0-9";
const MIN_KEY_LENGTH = 20;
const MIN_MASK_ASTERISKS = 3;

// Only the start of a sequence is matched by a regular expression, with
// bounded quantifiers. The rest is walked by findSecretSpans: an unbounded
// greedy quantifier overflows the stack of the engine on a run of millions of
// key characters ("Maximum call stack size exceeded").
const SECRET_START_SOURCE = `(?<![${NOT_AFTER}])${KEY_PREFIX}(?:[${KEY_CHARACTERS}]{${MIN_KEY_LENGTH}}|[${KEY_CHARACTERS}]{0,${MIN_KEY_LENGTH - 1}}[*]{${MIN_MASK_ASTERISKS}})`;
// What ends a sequence: a character that cannot be part of it, or a run of
// asterisks shorter than a mask.
const SECRET_END_SOURCE = `[^*${KEY_CHARACTERS}]|(?<![*])[*]{1,${MIN_MASK_ASTERISKS - 1}}(?![*])`;

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
  const secretEnd = new RegExp(SECRET_END_SOURCE, "g");
  const spans: SecretSpan[] = [];

  for (
    let match = secretStart.exec(text);
    match !== null;
    match = secretStart.exec(text)
  ) {
    // The sequence goes on up to the first thing that cannot be part of it.
    secretEnd.lastIndex = secretStart.lastIndex;
    const end = secretEnd.exec(text)?.index ?? text.length;
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
