// The command-line options of `npm run chat`. The only file of src/ that uses
// parseArgs. There is no option for the API key, on purpose: it comes from
// OPENAI_API_KEY only (src/config/env.ts). This module is pure: it receives
// the list of arguments and reads nothing from the process.
import { parseArgs } from "node:util";
import type { ContextOptions } from "../context/loaders.js";

export interface CliOptions {
  /** File that replaces the first layer. */
  readonly systemPrompt?: string;
  /** Slug of a profile of 03-usuario/ or the path of a .json file. */
  readonly profile?: string;
  /** Folder with the four layers, instead of context/. */
  readonly contextDir?: string;
  readonly showContext: boolean;
  readonly verbose: boolean;
}

export type ParsedArgs =
  | { kind: "run"; options: CliOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const OPTION_DEFINITIONS = {
  "system-prompt": { type: "string" },
  perfil: { type: "string" },
  "context-dir": { type: "string" },
  "show-context": { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const STRING_OPTIONS: ReadonlySet<string> = new Set([
  "system-prompt",
  "perfil",
  "context-dir",
]);

// A name that is safe to quote in a message: short, lower case, hyphens.
const QUOTABLE_OPTION_NAME = /^--[a-z0-9-]{1,32}$/;

export const HELP_TEXT = [
  "Uso: npm run chat -- [opções]",
  "",
  "Opções:",
  "  --system-prompt <arquivo>  substitui só a camada 1 (instruções globais); .md ou .txt",
  "  --perfil <nome|arquivo>    perfil: nome de 03-usuario/ ou caminho de um arquivo .json",
  "  --context-dir <pasta>      lê as quatro camadas de outra pasta, no lugar de context/",
  "  --show-context             imprime o contexto montado e sai; não chama o modelo nem exige chave",
  "  --verbose                  detalhes técnicos e resultado da autoavaliação por turno, em stderr",
  "  -h, --help                 mostra esta ajuda",
  "",
  "A chave vem de OPENAI_API_KEY (.env ou ambiente); nunca é argumento.",
].join("\n");

function usageError(message: string): ParsedArgs {
  return { kind: "error", message };
}

interface LooseOptionToken {
  readonly name: string;
  readonly rawName: string;
  readonly value: string | undefined;
  readonly inlineValue: boolean | undefined;
}

/** Re-reads the arguments without failing, only to find what went wrong. */
function looseOptionTokens(argv: readonly string[]): LooseOptionToken[] {
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTION_DEFINITIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  return tokens.flatMap((token) =>
    token.kind === "option"
      ? [
          {
            name: token.name,
            rawName: token.rawName,
            value: token.value,
            inlineValue: token.inlineValue,
          },
        ]
      : [],
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

// Never the message of the runtime: it repeats the offending argument, which
// may be a key written in the wrong place. Only our own text, and the name of
// an option when it is short and has the shape of a name.
function describeParseFailure(
  code: string | undefined,
  argv: readonly string[],
): string {
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const unknown = looseOptionTokens(argv).find(
      (token) => !Object.hasOwn(OPTION_DEFINITIONS, token.name),
    );
    const name = unknown?.rawName.split("=")[0] ?? "";
    return QUOTABLE_OPTION_NAME.test(name)
      ? `opção desconhecida: ${name}`
      : "opção desconhecida";
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const tokens = looseOptionTokens(argv);
    // Without strict mode, a value that looks like an option is taken as the
    // value of the string option before it; in strict mode that is an error.
    const missing = tokens.find(
      (token) =>
        STRING_OPTIONS.has(token.name) &&
        (token.value === undefined ||
          (token.inlineValue === false && token.value.startsWith("-"))),
    );
    if (missing !== undefined) {
      return `a opção --${missing.name} exige um valor`;
    }
    const extra = tokens.find(
      (token) => !STRING_OPTIONS.has(token.name) && token.inlineValue === true,
    );
    if (extra !== undefined && Object.hasOwn(OPTION_DEFINITIONS, extra.name)) {
      return `a opção --${extra.name} não aceita valor`;
    }
    return "valor de opção inválido";
  }
  if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
    return "argumentos posicionais não são aceitos";
  }
  return "argumentos inválidos";
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTION_DEFINITIONS,
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
  } catch (error) {
    return usageError(describeParseFailure(errorCode(error), argv));
  }

  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") {
      continue;
    }
    if (seen.has(token.name)) {
      return usageError(
        `a opção --${token.name} foi informada mais de uma vez`,
      );
    }
    seen.add(token.name);
  }

  const { values } = parsed;
  for (const name of STRING_OPTIONS) {
    const value = (values as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim() === "") {
      return usageError(`a opção --${name} exige um valor`);
    }
  }

  if (values.help === true) {
    return { kind: "help" };
  }

  const systemPrompt = values["system-prompt"];
  const profile = values.perfil;
  const contextDir = values["context-dir"];
  return {
    kind: "run",
    options: {
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(profile === undefined ? {} : { profile }),
      ...(contextDir === undefined ? {} : { contextDir }),
      showContext: values["show-context"] === true,
      verbose: values.verbose === true,
    },
  };
}

/**
 * A path when it has a separator, ends in ".json" (any case) or has a colon
 * (a drive on Windows); otherwise the slug of a profile of 03-usuario/. There
 * is no fallback from one to the other.
 */
export function classifyProfileArg(
  value: string,
): { profile: string } | { profileFile: string } {
  const isPath =
    /[\\/]/.test(value) || /\.json$/i.test(value) || value.includes(":");
  return isPath ? { profileFile: value } : { profile: value };
}

export function toContextOptions(options: CliOptions): ContextOptions {
  return {
    ...(options.contextDir === undefined
      ? {}
      : { contextDir: options.contextDir }),
    ...(options.systemPrompt === undefined
      ? {}
      : { globalInstructionsFile: options.systemPrompt }),
    ...(options.profile === undefined
      ? {}
      : classifyProfileArg(options.profile)),
  };
}
