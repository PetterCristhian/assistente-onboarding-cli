// Reads one line typed by the user. Pure: no input or output.
export const COMMAND_NAMES = [
  "sair",
  "limpar",
  "contexto",
  "detalhes",
  "ajuda",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export type ParsedInput =
  | { kind: "empty" }
  | { kind: "question"; text: string }
  | { kind: "command"; name: CommandName }
  | { kind: "unknown"; raw: string };

export const HELP_LINES: readonly string[] = [
  "Comandos:",
  "  /sair      encerra o chat",
  "  /limpar    apaga o histórico da conversa",
  "  /contexto  mostra o contexto enviado ao modelo",
  "  /detalhes  liga ou desliga o resultado da autoavaliação após cada resposta",
  "  /ajuda     mostra esta lista",
];

function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

/**
 * A line that starts with "/" is a command; the name is not case-sensitive.
 * A command with anything after the name is unknown: it is never guessed.
 */
export function parseInput(line: string): ParsedInput {
  const text = line.trim();
  if (text === "") {
    return { kind: "empty" };
  }
  if (!text.startsWith("/")) {
    return { kind: "question", text };
  }
  const name = text.slice(1).toLowerCase();
  return isCommandName(name)
    ? { kind: "command", name }
    : { kind: "unknown", raw: text };
}
