// Tells the failures of a call apart (docs/adr/0005): which ones are worth
// another try, which one asks for a wait, which ones are final. It also
// writes what the user reads about them.
//
// The messages are FIXED text plus a status and a short code. The `message`
// of an error of the SDK is never used: the one of a 401 quotes the key,
// masked. Headers are read only for the wait that the provider asks for, and
// never leave this module.
//
// The imports of the classes go to ./client.js, which imports this file back:
// the cycle is harmless because everything here uses them inside functions.
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  LlmResponseError,
} from "./client.js";
import { retryAfterRefused, type RetryEvent } from "./retry.js";

export type TransientReason =
  "connection" | "timeout" | "http_status" | "interrupted" | "provider_failed";

export type FatalReason =
  | "auth"
  | "permission"
  | "bad_request"
  | "not_found"
  | "unprocessable"
  | "insufficient_quota"
  | "http_status"
  | "response"
  | "unknown";

export type ErrorClass =
  | { kind: "transient"; reason: TransientReason; status?: number }
  | {
      kind: "rate_limit";
      status: 429;
      /** The wait asked for by `retry-after-ms` or `retry-after` (seconds). */
      retryAfterMs?: number;
      /** The moment asked for by `retry-after` written as an HTTP date. */
      retryAfterAt?: number;
    }
  | { kind: "fatal"; reason: FatalReason; status?: number }
  | { kind: "cancelled" };

// --- Reading what the error carries ----------------------------------------

function pick(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

const QUOTA_CODE = "insufficient_quota";

function mentionsQuota(value: unknown): boolean {
  if (value === QUOTA_CODE) {
    return true;
  }
  return (
    pick(value, "code") === QUOTA_CODE || pick(value, "type") === QUOTA_CODE
  );
}

function isOutOfQuota(error: unknown): boolean {
  return (
    mentionsQuota(pick(error, "code")) ||
    mentionsQuota(pick(error, "type")) ||
    mentionsQuota(pick(error, "error"))
  );
}

const SECONDS = /^\d+(?:\.\d+)?$/;

function headerOf(error: unknown, name: string): string | undefined {
  const headers = pick(error, "headers");
  const get = pick(headers, "get");
  if (typeof get !== "function") {
    return undefined;
  }
  try {
    const value: unknown = get.call(headers, name);
    return typeof value === "string" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function toMs(text: string, unit: number): number | undefined {
  if (!SECONDS.test(text)) {
    return undefined;
  }
  const ms = Math.round(Number(text) * unit);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The wait that the provider asks for: `retry-after-ms` first, then
 * `retry-after` (seconds, or an HTTP date). Anything that does not read as a
 * wait (text, negative, infinite) is ignored.
 */
function readRetryAfter(error: unknown): {
  retryAfterMs?: number;
  retryAfterAt?: number;
} {
  const inMs = headerOf(error, "retry-after-ms");
  const fromMs = inMs === undefined ? undefined : toMs(inMs, 1);
  if (fromMs !== undefined) {
    return { retryAfterMs: fromMs };
  }
  const after = headerOf(error, "retry-after");
  if (after === undefined) {
    return {};
  }
  const fromSeconds = toMs(after, 1000);
  if (fromSeconds !== undefined) {
    return { retryAfterMs: fromSeconds };
  }
  // A date has letters: this keeps `Date.parse` from reading "-3" as a year.
  if (/[A-Za-z]/.test(after)) {
    const at = Date.parse(after);
    if (Number.isFinite(at)) {
      return { retryAfterAt: at };
    }
  }
  return {};
}

const FATAL_BY_STATUS: Readonly<Record<number, FatalReason>> = {
  400: "bad_request",
  401: "auth",
  403: "permission",
  404: "not_found",
  422: "unprocessable",
};

function classifyResponseError(error: LlmResponseError): ErrorClass {
  if (error.kind === "interrupted") {
    return { kind: "transient", reason: "interrupted" };
  }
  if (error.kind === "failed") {
    return { kind: "transient", reason: "provider_failed" };
  }
  return { kind: "fatal", reason: "response" };
}

/**
 * Never throws. An error that is not one of the provider (a TypeError, a
 * string, what the callback of the caller throws) is final: it is neither
 * repeated nor swallowed.
 */
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof APIUserAbortError) {
    return { kind: "cancelled" };
  }
  if (error instanceof LlmResponseError) {
    return classifyResponseError(error);
  }
  if (error instanceof APIConnectionTimeoutError) {
    return { kind: "transient", reason: "timeout" };
  }
  if (error instanceof APIConnectionError) {
    return { kind: "transient", reason: "connection" };
  }
  if (error instanceof APIError) {
    const status: unknown = error.status;
    if (typeof status !== "number" || !Number.isInteger(status)) {
      return { kind: "fatal", reason: "unknown" };
    }
    if (status === 429) {
      return isOutOfQuota(error)
        ? { kind: "fatal", reason: "insufficient_quota", status }
        : { kind: "rate_limit", status, ...readRetryAfter(error) };
    }
    if (status === 408 || status === 409 || status >= 500) {
      return { kind: "transient", reason: "http_status", status };
    }
    return {
      kind: "fatal",
      reason: FATAL_BY_STATUS[status] ?? "http_status",
      status,
    };
  }
  return { kind: "fatal", reason: "unknown" };
}

// --- What the user reads ---------------------------------------------------

const SHORT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function shortCode(error: unknown): string | undefined {
  const cause = pick(error, "cause");
  for (const holder of [error, cause, pick(cause, "cause")]) {
    const code = pick(holder, "code");
    if (typeof code === "string" && SHORT_IDENTIFIER.test(code)) {
      return code;
    }
  }
  return undefined;
}

function statusOf(error: unknown): number | undefined {
  const status = pick(error, "status");
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : undefined;
}

function where(error: unknown): string {
  const status = statusOf(error);
  const code = shortCode(error);
  const details = [
    status === undefined ? undefined : `status ${status}`,
    code === undefined ? undefined : `código ${code}`,
  ].filter((part) => part !== undefined);
  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}

function seconds(ms: number): string {
  const value = Math.ceil(ms / 100) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

type Transient = Extract<ErrorClass, { kind: "transient" }>;
type Retryable = Extract<ErrorClass, { kind: "transient" | "rate_limit" }>;

const TRANSIENT_TEXT: Readonly<Record<TransientReason, string>> = {
  connection: "Falha de conexão com o provedor",
  timeout: "A requisição excedeu o prazo",
  http_status: "O provedor está com problemas",
  interrupted: "A resposta foi interrompida",
  provider_failed: "O provedor informou que a geração falhou",
};

function describeTransient(cause: Transient, withStatus: boolean): string {
  const text = TRANSIENT_TEXT[cause.reason];
  return withStatus && cause.status !== undefined
    ? `${text} (HTTP ${cause.status})`
    : text;
}

/** Why a new try is being made, in a few words. */
export function describeRetryCause(cause: Retryable): string {
  return cause.kind === "rate_limit"
    ? "O provedor limitou as requisições (HTTP 429)"
    : describeTransient(cause, true);
}

/** The line shown before each new try. */
export function formatRetryNotice(
  event: RetryEvent,
  options: { partialText?: boolean } = {},
): string {
  const when = `nova tentativa ${event.retry} de ${event.maxRetries}, em ${seconds(event.delayMs)} s`;
  if (options.partialText === true) {
    return `A resposta foi interrompida; o texto acima está incompleto e será descartado. Gerando de novo do zero (${when}).`;
  }
  return `${describeRetryCause(event.cause)}. ${when.charAt(0).toUpperCase()}${when.slice(1)}.`;
}

const FATAL_TEXT: Readonly<
  Record<Exclude<FatalReason, "response" | "unknown" | "http_status">, string>
> = {
  auth: 'A chave da OpenAI foi recusada. Confira o valor de OPENAI_API_KEY no arquivo ".env" e, se preciso, gere uma chave nova no painel da OpenAI.',
  permission:
    "A chave não tem permissão para esta requisição. Confira as permissões do projeto e o acesso ao modelo no painel da OpenAI.",
  bad_request:
    "A requisição foi recusada pelo provedor por ser inválida. Confira OPENAI_MODEL e as demais configurações.",
  not_found:
    'O provedor não encontrou o recurso pedido. Confira OPENAI_MODEL no arquivo ".env".',
  unprocessable:
    "A requisição foi recusada pelo provedor por não poder ser processada. Confira OPENAI_MODEL e as demais configurações.",
  insufficient_quota:
    "A conta está sem crédito ou a cota se esgotou. Verifique o plano e o faturamento no painel da OpenAI; esperar não resolve.",
};

/**
 * The message for a call that ended in failure. `retries` is how many new
 * tries were made; `maxRetries` is how many were allowed.
 */
export function describeFailure(
  error: unknown,
  context: {
    retries: number;
    maxRetries: number;
    /**
     * Added to the message of an error that is none of the provider's. The
     * caller passes it already redacted. Never given for an error of the SDK.
     */
    unknownMessage?: string;
  },
): string {
  const detail = where(error);
  const attempts = context.retries + 1;
  const tries = `${attempts} ${plural(attempts, "tentativa", "tentativas")}`;
  const asked = retryAfterRefused(error);
  if (asked !== undefined) {
    return `O provedor pediu para aguardar ${seconds(asked)} s${detail}; tente de novo mais tarde.`;
  }
  const kind = classifyError(error);
  switch (kind.kind) {
    case "cancelled":
      return "Operação cancelada.";
    case "rate_limit":
      return `O provedor continua limitando as requisições${detail} depois de ${tries}. Aguarde um pouco e tente de novo.`;
    case "transient": {
      // The message of this error is already written for the user.
      if (error instanceof LlmResponseError) {
        return context.retries === 0
          ? error.message
          : `${error.message} Desisti depois de ${tries}; tente de novo.`;
      }
      return `${describeTransient(kind, false)}${detail}. Desisti depois de ${tries}; verifique a conexão e tente de novo.`;
    }
    case "fatal":
      switch (kind.reason) {
        case "response":
          return error instanceof LlmResponseError
            ? error.message
            : "A resposta do provedor não pôde ser usada.";
        case "unknown":
          return `Não foi possível obter a resposta${detail}.${context.unknownMessage === undefined ? "" : ` ${context.unknownMessage}`}`;
        case "http_status":
          return `O provedor recusou a requisição${detail}.`;
        default:
          return `${FATAL_TEXT[kind.reason]}${detail === "" ? "" : ` ${detail.trim()}`}`;
      }
  }
}
