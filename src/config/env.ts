// The only reader of environment variables in src/ (CLAUDE.md, architecture
// rule 3). Defaults follow docs/ARQUITETURA.md, section 7.
//
// AppConfig carries the credential in plain text: never print or serialize it.
import { closeSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MIN_EXACT_SECRET_LENGTH, redact } from "../security/redact.js";

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AppConfig {
  readonly openaiApiKey: string;
  readonly openaiModel: string;
  readonly openaiReasoningEffort: ReasoningEffort;
  readonly evalJudgeModel: string;
  readonly requestTimeoutMs: number;
  readonly retryMaxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly rateLimitMaxRequests: number;
  readonly rateLimitWindowSeconds: number;
}

export type EnvSource = Record<string, string | undefined>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

// The only place in src/ where the model identifier is written.
const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

interface IntegerRule {
  readonly min: number;
  readonly fallback: number;
}

const INTEGER_RULES = {
  REQUEST_TIMEOUT_MS: { min: 1, fallback: 60000 },
  RETRY_MAX_ATTEMPTS: { min: 0, fallback: 3 },
  RETRY_BASE_DELAY_MS: { min: 1, fallback: 1000 },
  RATE_LIMIT_MAX_REQUESTS: { min: 1, fallback: 20 },
  RATE_LIMIT_WINDOW_SECONDS: { min: 1, fallback: 60 },
} as const satisfies Record<string, IntegerRule>;

const API_KEY_VARIABLE = "OPENAI_API_KEY";
const REASONING_EFFORT_VARIABLE = "OPENAI_REASONING_EFFORT";
const MAX_QUOTED_VALUE_LENGTH = 40;
// Control and format characters (ESC, line breaks, bidi overrides...) of a
// quoted value: shown as a marker, so the value cannot drive the terminal.
const UNSAFE_TO_PRINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const UNSAFE_TO_PRINT_MARKER = "\ufffd";
const ENV_FILE_HEAD_LENGTH = 64;

/** Trims the value and treats an empty one (`NAME=`) as not defined. */
function normalize(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// z.coerce.number() is avoided on purpose: it accepts "", "1e3" and "0x10".
function integerVariable(rule: IntegerRule) {
  return z.preprocess(
    normalize,
    z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(rule.min))
      .default(rule.fallback),
  );
}

const envSchema = z.object({
  // After trimming, white space can only be in the middle: a key pasted with
  // a line break, or two values in the same line. A key shorter than the
  // shortest secret that redact() replaces is no key, and it would be quoted
  // in the message about another variable.
  OPENAI_API_KEY: z.preprocess(
    normalize,
    z.string().regex(/^\S+$/u).min(MIN_EXACT_SECRET_LENGTH),
  ),
  OPENAI_MODEL: z.preprocess(
    normalize,
    z.string().default(DEFAULT_OPENAI_MODEL),
  ),
  OPENAI_REASONING_EFFORT: z.preprocess(
    normalize,
    z.enum(REASONING_EFFORTS).default(DEFAULT_REASONING_EFFORT),
  ),
  EVAL_JUDGE_MODEL: z.preprocess(normalize, z.string().optional()),
  REQUEST_TIMEOUT_MS: integerVariable(INTEGER_RULES.REQUEST_TIMEOUT_MS),
  RETRY_MAX_ATTEMPTS: integerVariable(INTEGER_RULES.RETRY_MAX_ATTEMPTS),
  RETRY_BASE_DELAY_MS: integerVariable(INTEGER_RULES.RETRY_BASE_DELAY_MS),
  RATE_LIMIT_MAX_REQUESTS: integerVariable(
    INTEGER_RULES.RATE_LIMIT_MAX_REQUESTS,
  ),
  RATE_LIMIT_WINDOW_SECONDS: integerVariable(
    INTEGER_RULES.RATE_LIMIT_WINDOW_SECONDS,
  ),
});

export const ENV_VARIABLE_NAMES: readonly string[] = Object.freeze(
  Object.keys(envSchema.shape),
);

const MISSING_API_KEY_MESSAGE = [
  `Configuração incompleta: a variável ${API_KEY_VARIABLE} não está definida.`,
  "Como corrigir:",
  '  1. Copie o arquivo ".env.example" para ".env"',
  "     (PowerShell: Copy-Item .env.example .env | bash: cp .env.example .env).",
  `  2. Abra o ".env" e preencha ${API_KEY_VARIABLE} com a sua chave da OpenAI.`,
  "A chave não é aceita por argumento de linha de comando e nunca deve ser versionada.",
].join("\n");

const API_KEY_WHITE_SPACE_MESSAGE = `Configuração inválida: ${API_KEY_VARIABLE} contém espaço, tabulação ou quebra de linha no meio do valor (o valor não é exibido). Cole a chave inteira em uma única linha, sem espaços, no ".env" ou na variável de ambiente.`;

const API_KEY_TOO_SHORT_MESSAGE = `Configuração inválida: ${API_KEY_VARIABLE} tem menos de ${MIN_EXACT_SECRET_LENGTH} caracteres (o valor não é exibido): não é uma chave da OpenAI. Cole a chave inteira no ".env" ou na variável de ambiente.`;

function envFileEncodingMessage(problem: string): string {
  return [
    `Configuração incompleta: ${problem}`,
    "Como corrigir:",
    '  1. Abra o arquivo em um editor de texto e salve o ".env" em UTF-8 sem BOM',
    '     (no Bloco de Notas, escolha "UTF-8", não "UTF-8 com BOM" nem "UTF-16").',
    '  2. Não crie o ".env" com ">" no Windows PowerShell 5: ele grava UTF-16 por padrão.',
    "     Prefira copiar o modelo (Copy-Item .env.example .env) e editar a cópia.",
  ].join("\n");
}

const ENV_FILE_ENCODING_MESSAGE = envFileEncodingMessage(
  `o arquivo ".env" existe, mas não está em UTF-8 sem BOM, por isso ${API_KEY_VARIABLE} não foi lida.`,
);

// With a UTF-8 byte order mark, the loader keeps the mark in the name of the
// first variable of the file, which is then never found by its real name.
const BYTE_ORDER_MARK = "﻿";
const PLAIN_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envFileByteOrderMarkMessage(mangledName: string): string {
  const name = mangledName.slice(BYTE_ORDER_MARK.length);
  // The name is only shown when it cannot carry anything else.
  const shown = PLAIN_VARIABLE_NAME.test(name) ? ` (${name})` : "";
  return envFileEncodingMessage(
    `o arquivo ".env" começa com uma marca de ordem de bytes (BOM), por isso a primeira variável do arquivo${shown} não foi lida.`,
  );
}

// The three quotes that a ".env" accepts around a value.
const QUOTES = /["'`]+/gu;
const QUOTES_AND_WHITE_SPACE = /["'`\s]+/u;

/** The forms in which the key may show up inside another value. */
function keyVariants(source: EnvSource): string[] {
  const raw = source[API_KEY_VARIABLE] ?? "";
  const trimmed = raw.trim();
  const unquoted = /^(["'])(.*)\1$/s.exec(trimmed)?.[2] ?? trimmed;
  // Quotes that do not match (only one, two kinds, doubled, in the middle) are
  // not taken out above: the value without any quote and its pieces between
  // quotes are forms of the key too. So are the pieces of a key with white
  // space inside, which is rejected. redact() ignores the pieces that are too
  // short to be told from ordinary text.
  const withoutQuotes = trimmed.replace(QUOTES, "").trim();
  const pieces = trimmed.split(QUOTES_AND_WHITE_SPACE);
  return [
    ...new Set([
      raw,
      trimmed,
      unquoted,
      unquoted.trim(),
      withoutQuotes,
      ...pieces,
    ]),
  ];
}

function isIntegerVariable(name: string): name is keyof typeof INTEGER_RULES {
  return Object.hasOwn(INTEGER_RULES, name);
}

/** Quotes a received value for an error message, never leaking a credential. */
function describeReceived(name: string, source: EnvSource): string {
  const raw = (source[name] ?? "").trim();
  const safe = redact(raw, keyVariants(source)).replace(
    UNSAFE_TO_PRINT,
    UNSAFE_TO_PRINT_MARKER,
  );
  const shown =
    safe.length > MAX_QUOTED_VALUE_LENGTH
      ? `${safe.slice(0, MAX_QUOTED_VALUE_LENGTH)}...`
      : safe;
  return `(valor recebido: "${shown}")`;
}

function howToFix(fallback: string | number): string {
  return `Corrija o valor no ".env" ou na variável de ambiente, ou remova-o para usar o padrão (${fallback}).`;
}

function describeProblem(name: string, source: EnvSource): string {
  if (name === API_KEY_VARIABLE) {
    // Present but refused by the schema: white space inside, or too short.
    const value = normalize(source[name]);
    if (typeof value !== "string") {
      return MISSING_API_KEY_MESSAGE;
    }
    return /\s/u.test(value)
      ? API_KEY_WHITE_SPACE_MESSAGE
      : API_KEY_TOO_SHORT_MESSAGE;
  }
  if (isIntegerVariable(name)) {
    const rule = INTEGER_RULES[name];
    return `Configuração inválida: ${name} deve ser um número inteiro maior ou igual a ${rule.min} ${describeReceived(name, source)}. ${howToFix(rule.fallback)}`;
  }
  if (name === REASONING_EFFORT_VARIABLE) {
    return `Configuração inválida: ${name} deve ser um destes valores: ${REASONING_EFFORTS.join(", ")} ${describeReceived(name, source)}. ${howToFix(DEFAULT_REASONING_EFFORT)}`;
  }
  return `Configuração inválida: ${name} tem um valor que não pode ser usado. Corrija o valor no ".env" ou na variável de ambiente.`;
}

/** Pure: validates the given variables and applies the defaults. */
export function parseConfig(source: EnvSource): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    // One message per variable, written here (zod's own text is not used).
    const failed = new Set<string>();
    for (const issue of parsed.error.issues) {
      failed.add(String(issue.path[0]));
    }
    const ordered = [
      ...ENV_VARIABLE_NAMES.filter((name) => failed.has(name)),
      ...[...failed].filter((name) => !ENV_VARIABLE_NAMES.includes(name)),
    ].sort(
      (a, b) => Number(b === API_KEY_VARIABLE) - Number(a === API_KEY_VARIABLE),
    );
    throw new ConfigError(
      ordered.map((name) => describeProblem(name, source)).join("\n"),
    );
  }

  const values = parsed.data;
  return Object.freeze({
    openaiApiKey: values.OPENAI_API_KEY,
    openaiModel: values.OPENAI_MODEL,
    openaiReasoningEffort: values.OPENAI_REASONING_EFFORT,
    evalJudgeModel: values.EVAL_JUDGE_MODEL ?? values.OPENAI_MODEL,
    requestTimeoutMs: values.REQUEST_TIMEOUT_MS,
    retryMaxAttempts: values.RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: values.RETRY_BASE_DELAY_MS,
    rateLimitMaxRequests: values.RATE_LIMIT_MAX_REQUESTS,
    rateLimitWindowSeconds: values.RATE_LIMIT_WINDOW_SECONDS,
  });
}

export interface LoadConfigDeps {
  /** Variables to validate. Default: the environment of the process. */
  env?: EnvSource;
  /** Loads a ".env" file into the environment. */
  loadEnvFile?: (path: string) => void;
  /** Default: the ".env" at the project root, wherever the cwd is. */
  envFilePath?: string;
  /**
   * Returns the first bytes of the ".env", to explain a wrong encoding. Only
   * called when the key is missing after a ".env" that exists was loaded.
   * Default: reads the disk, unless `loadEnvFile` was injected (then none).
   */
  readEnvFileHead?: (path: string) => Uint8Array;
}

function readFileHead(path: string): Uint8Array {
  const descriptor = openSync(path, "r");
  try {
    const head = new Uint8Array(ENV_FILE_HEAD_LENGTH);
    const length = readSync(descriptor, head, 0, head.length, 0);
    return head.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * True for a UTF-8 byte order mark and for UTF-16, with or without one: a
 * NUL byte never appears in a ".env" saved as UTF-8.
 */
function hasUnsupportedEncoding(head: Uint8Array): boolean {
  const [first, second, third] = head;
  return (
    (first === 0xef && second === 0xbb && third === 0xbf) ||
    (first === 0xff && second === 0xfe) ||
    (first === 0xfe && second === 0xff) ||
    head.includes(0)
  );
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

/**
 * Loads ".env" (when it exists) and validates the environment. No cache and
 * no module state: every call reads again.
 */
export function loadConfig(deps: LoadConfigDeps = {}): AppConfig {
  const env = deps.env ?? process.env;
  let envFileEncodingIsWrong = false;
  let mangledName: string | undefined;

  // With an injected env and no injected loader, no file is read at all.
  if (deps.env === undefined || deps.loadEnvFile !== undefined) {
    const loadEnvFile =
      deps.loadEnvFile ?? ((path: string) => process.loadEnvFile(path));
    const envFilePath =
      deps.envFilePath ?? fileURLToPath(new URL("../../.env", import.meta.url));

    let envFileWasLoaded = false;
    try {
      loadEnvFile(envFilePath);
      envFileWasLoaded = true;
    } catch (error) {
      const code = readErrorCode(error);
      if (code !== "ENOENT") {
        throw new ConfigError(
          `Não foi possível ler o arquivo ".env" (${code ?? "erro desconhecido"}). Verifique se ele é um arquivo de texto no formato NOME=valor.`,
        );
      }
    }

    // Names that the loader created with the mark are of no use, and their
    // values may be the credential: they do not stay in the environment.
    if (envFileWasLoaded) {
      for (const name of Object.keys(env)) {
        if (name.startsWith(BYTE_ORDER_MARK)) {
          mangledName ??= name;
          delete env[name];
        }
      }
    }

    // A ".env" with a byte order mark or in UTF-16 loads without an error,
    // but its names come out wrong: say so instead of "not defined".
    const readEnvFileHead =
      deps.readEnvFileHead ??
      (deps.loadEnvFile === undefined ? readFileHead : undefined);
    if (
      envFileWasLoaded &&
      readEnvFileHead !== undefined &&
      normalize(env[API_KEY_VARIABLE]) === undefined
    ) {
      try {
        envFileEncodingIsWrong = hasUnsupportedEncoding(
          readEnvFileHead(envFilePath),
        );
      } catch {
        // Not being able to look is not an error: the usual guidance follows.
      }
    }
  }

  if (envFileEncodingIsWrong) {
    throw new ConfigError(ENV_FILE_ENCODING_MESSAGE);
  }
  // The key was read (it is in another line, or came from the shell), but the
  // first variable of the file was dropped: never go on in silence.
  if (mangledName !== undefined) {
    throw new ConfigError(envFileByteOrderMarkMessage(mangledName));
  }
  return parseConfig(env);
}
