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
// Where a sequence may start. The prefix is also the end of ordinary words
// (task-, disk-, helpdesk-), and the answers of the model are written through
// redact(), so a candidate is dropped only when BOTH hold:
//   - it comes right after an ASCII letter or digit that is not the end of an
//     escape sequence (see ESCAPE_END); and
//   - it has no digit, and no upper-case letter other than the first of a
//     word (right after "-" or "_"): it reads as words with hyphens
//     (task-force-management-department, Petropavlovsk-Kamchatski-..., a
//     name found in the executable of Node, disk-***).
// Premise (ADR 0007): a real key has 40 or more random characters, so one
// with no digit and no upper-case letter inside a word is statistically
// negligible.
// Everything else is taken, whatever comes before it: a false positive is a
// nuisance, a false negative publishes the key. "_" and "-" never count as
// part of a word.
const KEY_PREFIX = "sk-";
const KEY_CHARACTERS = "A-Za-z0-9_-";
const MIN_KEY_LENGTH = 20;
const MIN_MASK_ASTERISKS = 3;

// Only the start of a sequence is matched by a regular expression, with
// bounded quantifiers. The rest is walked by findSecretSpans: an unbounded
// greedy quantifier overflows the stack of the engine on a run of millions of
// key characters ("Maximum call stack size exceeded").
const SECRET_START_SOURCE = `${KEY_PREFIX}(?:[${KEY_CHARACTERS}]{${MIN_KEY_LENGTH}}|[${KEY_CHARACTERS}]{0,${MIN_KEY_LENGTH - 1}}[*]{${MIN_MASK_ASTERISKS}})`;
// What ends a sequence: a character that cannot be part of it, or a run of
// asterisks shorter than a mask.
const SECRET_END_SOURCE = `[^*${KEY_CHARACTERS}]|(?<![*])[*]{1,${MIN_MASK_ASTERISKS - 1}}(?![*])`;

// The end of an escape sequence is a letter or digit that belongs to no word,
// so a key may start right after it. The writer redacts the text produced by
// JSON.stringify, where a key at the start of a line comes right after the
// "n" of a line break. Covered: the one-letter escapes of JSON and of string
// literals, \uXXXX, \xXX, %XX (URL), =XX (quoted-printable) and the end of an
// ANSI colour sequence ("[31m", whatever the form of the ESC before it). Only
// the few characters right before the prefix are looked at.
// Not global: test() keeps no state between calls.
const ESCAPE_END =
  /(?:\\[abefnrtv0]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|[%=][0-9A-Fa-f]{2}|\[[0-9;]{0,12}m)$/;
// The longest of them: "[", twelve parameter characters and "m".
const MAX_ESCAPE_LENGTH = 14;

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiUpperCase(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLowerCase(code: number): boolean {
  return code >= 97 && code <= 122;
}

/** True when the prefix at "index" is not the end of an ordinary word. */
function startsAtBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const before = text.charCodeAt(index - 1);
  if (
    !isAsciiDigit(before) &&
    !isAsciiUpperCase(before) &&
    !isAsciiLowerCase(before)
  ) {
    return true;
  }
  return ESCAPE_END.test(
    text.slice(Math.max(0, index - MAX_ESCAPE_LENGTH), index),
  );
}

const HYPHEN = 45;
const UNDERSCORE = 95;

/**
 * Index of the first character in [from, to) that words with hyphens do not
 * have, or -1: a digit, or an upper-case letter that is not the first of a
 * word. "from" is never the start of the text: it is at or after a prefix.
 */
function findKeyOnlyCharacter(text: string, from: number, to: number): number {
  for (let index = from; index < to; index += 1) {
    const code = text.charCodeAt(index);
    if (isAsciiDigit(code)) {
      return index;
    }
    if (isAsciiUpperCase(code)) {
      const before = text.charCodeAt(index - 1);
      if (before !== HYPHEN && before !== UNDERSCORE) {
        return index;
      }
    }
  }
  return -1;
}

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

  // A dropped candidate may hold others ("ask-ask-ask-..."), and all of them
  // share the same end. What was learned about the stretch up to that end is
  // kept, so that no character is walked once per candidate.
  let knownEnd = -1;
  let strongSearchedUpTo = -1;
  let strongAt = -1;

  for (
    let match = secretStart.exec(text);
    match !== null;
    match = secretStart.exec(text)
  ) {
    const start = match.index;
    // The sequence goes on up to the first thing that cannot be part of it.
    // Nothing inside the matched start can end it, so an end already found
    // at or after this point is still the first one.
    if (knownEnd < secretStart.lastIndex) {
      secretEnd.lastIndex = secretStart.lastIndex;
      knownEnd = secretEnd.exec(text)?.index ?? text.length;
    }
    const end = knownEnd;

    let isSecret = startsAtBoundary(text, start);
    if (!isSecret) {
      // Same end: same stretch, already searched from an earlier start for
      // a character that only a key has. The answer holds unless the one
      // found is now behind this start.
      if (strongSearchedUpTo !== end || (strongAt !== -1 && strongAt < start)) {
        strongAt = findKeyOnlyCharacter(text, start, end);
        strongSearchedUpTo = end;
      }
      isSecret = strongAt !== -1;
    }

    if (isSecret) {
      spans.push({ start, end });
      secretStart.lastIndex = end;
    } else {
      // Words with hyphens. A sequence may still start inside them, after a
      // "-" or a "_" (palavra-<key>).
      secretStart.lastIndex = start + KEY_PREFIX.length;
    }
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

// The token of an authorization header (ENG-53): "Bearer", blanks and a long
// run of token characters (RFC 6750 plus the base64 and URL-safe ones). It is
// applied by redact() only. It does not belong to findSecretSpans, which is
// the scanner of the repository: documents may quote the word "Bearer".
// Sixteen characters keep ordinary prose ("Bearer tokens") out of it.
export const BEARER_KEYWORD = "bearer";
export const BEARER_MAX_BLANKS = 64;
const BEARER_MIN_TOKEN_LENGTH = 16;
const BEARER_TOKEN_CHARACTERS = "A-Za-z0-9._~+/=-";
const BEARER_TOKEN_CHARACTER = new RegExp(`[${BEARER_TOKEN_CHARACTERS}]`);
// Only the start is a regular expression, with bounded quantifiers; the end of
// the token is walked, as in findSecretSpans.
const BEARER_START_SOURCE = `\\b${BEARER_KEYWORD}\\s{1,${BEARER_MAX_BLANKS}}(?=[${BEARER_TOKEN_CHARACTERS}]{${BEARER_MIN_TOKEN_LENGTH}})`;

/** True for a character that can be part of the token after "Bearer". */
export function isBearerTokenCharacter(character: string): boolean {
  return BEARER_TOKEN_CHARACTER.test(character);
}

function replaceBearerTokens(text: string): string {
  const start = new RegExp(BEARER_START_SOURCE, "gi");
  let result = "";
  let copiedUpTo = 0;
  for (let match = start.exec(text); match !== null; match = start.exec(text)) {
    const tokenStart = match.index + match[0].length;
    let tokenEnd = tokenStart;
    while (
      tokenEnd < text.length &&
      isBearerTokenCharacter(text.charAt(tokenEnd))
    ) {
      tokenEnd += 1;
    }
    result += text.slice(copiedUpTo, tokenStart) + REDACTED;
    copiedUpTo = tokenEnd;
    start.lastIndex = tokenEnd;
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
 * ones with at least MIN_EXACT_SECRET_LENGTH characters), every sequence
 * shaped like a key and the token that follows "Bearer".
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
  return replaceBearerTokens(replaceKeyShapedSequences(result));
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const ownSecrets = [...secrets];
  return (text) => redact(text, ownSecrets);
}
