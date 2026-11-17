// Redaction of a text that arrives in pieces (ENG-53). The answer of the model
// goes to the screen as it is streamed, so a key may be split between two
// pieces: neither piece holds it, and redacting each one alone would let it
// through. The redactor keeps back the end of the text while it could still
// become a secret, and releases it when it cannot, or at the end (flush).
//
// What it releases is always a prefix of redact(whole text): the same text
// that the history and the logs receive. Before the end, only what is already
// decided is released; the text kept back is, at most, an open sequence (a
// key-shaped one, an exact secret or a "Bearer" token still being written).
import {
  BEARER_KEYWORD,
  BEARER_MAX_BLANKS,
  MIN_EXACT_SECRET_LENGTH,
  isBearerTokenCharacter,
  redact,
} from "./redact.js";

export interface StreamRedactor {
  /** The part of the redacted text that is ready, possibly empty. */
  push(chunk: string): string;
  /** What was kept back, redacted. Starts a new text afterwards. */
  flush(): string;
}

// How much of the released text is kept as context: more than the longest
// look-behind of redact() (an escape sequence before a key prefix).
const MIN_CONTEXT_LENGTH = 32;
const KEY_PREFIX = "sk-";
// The characters of a key, with the asterisks of a masked one.
const KEY_RUN_CHARACTER = /[A-Za-z0-9_*-]/;

/** Start of the open key-shaped sequence at the end of the text, or -1. */
function openKeyStart(text: string): number {
  let runStart = text.length;
  while (runStart > 0 && KEY_RUN_CHARACTER.test(text.charAt(runStart - 1))) {
    runStart -= 1;
  }
  const prefixAt = text.indexOf(KEY_PREFIX, runStart);
  if (prefixAt !== -1) {
    return prefixAt;
  }
  // The prefix itself may be cut in two: "s" or "sk" at the very end.
  for (let length = KEY_PREFIX.length - 1; length >= 1; length -= 1) {
    if (
      text.length - length >= runStart &&
      text.endsWith(KEY_PREFIX.slice(0, length))
    ) {
      return text.length - length;
    }
  }
  return -1;
}

/** Start of the longest end of the text that is a start of an exact secret. */
function openSecretStart(text: string, secrets: readonly string[]): number {
  let start = -1;
  for (const secret of secrets) {
    const longest = Math.min(secret.length - 1, text.length);
    for (let length = longest; length >= 1; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        const candidate = text.length - length;
        start = start === -1 ? candidate : Math.min(start, candidate);
        break;
      }
    }
  }
  return start;
}

/** Start of a "Bearer" whose token may still grow, or -1. */
function openBearerStart(text: string): number {
  const lower = text.toLowerCase();
  // The earliest one wins: a token that is still open, with blanks and token
  // characters up to the end of the text.
  for (
    let at = lower.indexOf(BEARER_KEYWORD);
    at !== -1;
    at = lower.indexOf(BEARER_KEYWORD, at + 1)
  ) {
    let index = at + BEARER_KEYWORD.length;
    while (index < text.length && /\s/.test(text.charAt(index))) {
      index += 1;
    }
    if (index - (at + BEARER_KEYWORD.length) > BEARER_MAX_BLANKS) {
      continue;
    }
    while (index < text.length && isBearerTokenCharacter(text.charAt(index))) {
      index += 1;
    }
    if (index === text.length) {
      return at;
    }
  }
  // The word itself, cut at the end ("Bea").
  for (let length = BEARER_KEYWORD.length - 1; length >= 1; length -= 1) {
    if (lower.endsWith(BEARER_KEYWORD.slice(0, length))) {
      return text.length - length;
    }
  }
  return -1;
}

/**
 * `secrets` are the exact values (the key in use); the key-shaped sequences
 * and the "Bearer" tokens are always covered, as in `redact`.
 */
export function createStreamRedactor(
  secrets: readonly string[],
): StreamRedactor {
  // The same ones that redact() takes into account.
  const exactSecrets = secrets.filter(
    (secret) => secret.trim().length >= MIN_EXACT_SECRET_LENGTH,
  );
  // Only the end of the text is kept: `context` is the last stretch that was
  // already released, as it came (it is what redact() needs to see before a
  // sequence: the character before a prefix, an escape sequence), and
  // `pending` is what is not released yet. Every push works on the window
  // `context + pending`, so its cost grows with the piece and with what is
  // held back, never with the whole text.
  const contextLength = Math.max(
    MIN_CONTEXT_LENGTH,
    ...exactSecrets.map((secret) => secret.length),
  );
  let context = "";
  let pending = "";

  /**
   * The redacted form of `window.slice(0, end)` that is new. The context goes
   * through redact() on its own, to know how much of the result was already
   * released. If redact() changes it differently inside the window (a case
   * that the holds are meant to rule out), nothing is released: the text stays
   * pending and the next call tries again, never a leak.
   */
  function release(window: string, end: number): string | undefined {
    const out = redact(window.slice(0, end), exactSecrets);
    const contextOut = redact(context, exactSecrets);
    return out.startsWith(contextOut)
      ? out.slice(contextOut.length)
      : undefined;
  }

  return {
    push(chunk) {
      pending += chunk;
      const window = context + pending;
      const holds = [
        openKeyStart(window),
        openSecretStart(window, exactSecrets),
        openBearerStart(window),
      ].filter((start) => start !== -1);
      const end = Math.max(
        context.length,
        holds.length === 0 ? window.length : Math.min(...holds),
      );
      if (end === context.length) {
        return "";
      }
      const ready = release(window, end);
      if (ready === undefined) {
        return "";
      }
      context = window.slice(Math.max(0, end - contextLength), end);
      pending = window.slice(end);
      return ready;
    },
    flush() {
      const window = context + pending;
      const out = redact(window, exactSecrets);
      const contextOut = redact(context, exactSecrets);
      // If the context was changed, the whole window is shown: the few
      // characters that may repeat are better than a key that passes.
      const rest = out.startsWith(contextOut)
        ? out.slice(contextOut.length)
        : out;
      context = "";
      pending = "";
      return rest;
    },
  };
}
