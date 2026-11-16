// Central redaction of credentials (docs/adr/0007-protecao-da-credencial.md).
// Pure functions, no global registry: the key in use is passed in explicitly,
// usually through createRedactor([config.openaiApiKey]).

export const REDACTED = "[REDACTED]";

// Single source of the key shape, shared with the repository scan.
const SECRET_PATTERN_SOURCE = "sk-[A-Za-z0-9_-]{20,}";

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
