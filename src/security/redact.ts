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
const SECRET_PATTERN_SOURCE =
  "sk-(?:[A-Za-z0-9_*-]{20,}|[A-Za-z0-9_-]*\\*{3,}[A-Za-z0-9_*-]*)";

/** Returns a new instance on every call, so no `lastIndex` state is shared. */
export function createSecretPattern(): RegExp {
  return new RegExp(SECRET_PATTERN_SOURCE, "g");
}

export type Redactor = (text: string) => string;

/**
 * Replaces by `[REDACTED]` every exact occurrence of the given secrets and
 * every sequence shaped like a key.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  // An empty secret would make split("") tear the text apart.
  const exactSecrets = secrets
    .filter((secret) => secret.trim() !== "")
    .sort((a, b) => b.length - a.length);

  let result = text;
  for (const secret of exactSecrets) {
    result = result.split(secret).join(REDACTED);
  }
  return result.replace(createSecretPattern(), REDACTED);
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const ownSecrets = [...secrets];
  return (text) => redact(text, ownSecrets);
}
