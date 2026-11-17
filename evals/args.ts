// The command-line options of `npm run eval`. There is no option for the API
// key, on purpose: it comes from OPENAI_API_KEY only (src/config/env.ts). Like
// src/cli/args.ts, this module is pure and never repeats an argument in a
// message: a value may be a key written in the wrong place.
import { parseArgs } from "node:util";

export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 10;

export interface EvalOptions {
  /** Executions of each case. */
  readonly runs: number;
  /** Runs only this case. */
  readonly caseId?: string;
}

export type ParsedEvalArgs =
  | { kind: "run"; options: EvalOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const OPTION_DEFINITIONS = {
  runs: { type: "string" },
  case: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const STRING_OPTIONS: ReadonlySet<string> = new Set(["runs", "case"]);

// A name that is safe to quote in a message: short, lower case, hyphens.
const QUOTABLE_OPTION_NAME = /^--[a-z0-9-]{1,32}$/;

export const EVAL_HELP_TEXT = [
  "Uso: npm run eval -- [opções]",
  "",
  "Opções:",
  `  --runs <n>   execuções de cada caso, inteiro de 1 a ${MAX_RUNS} (padrão: ${DEFAULT_RUNS})`,
  "  --case <id>  roda só um caso, por exemplo CT03",
  "  -h, --help   mostra esta ajuda",
  "",
  "Chama o modelo real: usa a chave de OPENAI_API_KEY (.env ou ambiente) e consome crédito.",
  "A chave nunca é argumento. O resultado vai para outputs/<data-hora>/execucoes.jsonl.",
].join("\n");

function usageError(message: string): ParsedEvalArgs {
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

export function parseEvalArgs(argv: readonly string[]): ParsedEvalArgs {
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

  let runs = DEFAULT_RUNS;
  if (values.runs !== undefined) {
    if (!/^[0-9]{1,3}$/.test(values.runs)) {
      return usageError(`--runs deve ser um número inteiro de 1 a ${MAX_RUNS}`);
    }
    runs = Number(values.runs);
    if (runs < 1 || runs > MAX_RUNS) {
      return usageError(`--runs deve ser um número inteiro de 1 a ${MAX_RUNS}`);
    }
  }
  const caseId = values.case;
  if (caseId !== undefined && !/^CT\d{2}$/.test(caseId)) {
    return usageError("--case deve ter o formato CT00, por exemplo CT03");
  }

  return {
    kind: "run",
    options: { runs, ...(caseId === undefined ? {} : { caseId }) },
  };
}
