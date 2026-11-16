// Summarizes an error before it is recorded or shown
// (docs/adr/0007-protecao-da-credencial.md, decision 4).
//
// Only status, code, type, message and request id are read. Headers, the
// response body, the request and the stack are never touched, so they cannot
// end up in outputs/ or logs/.
import type { Redactor } from "./redact.js";

export interface ErrorSummary {
  status?: number;
  code?: string;
  type?: string;
  message: string;
  requestId?: string;
}

const MAX_MESSAGE_LENGTH = 500;
// code, type and request id are short identifiers; anything longer is cut.
const MAX_FIELD_LENGTH = 200;
const UNKNOWN_ERROR_MESSAGE = "Erro desconhecido.";

/** Duck typing on purpose: this module does not depend on the SDK. */
function pick(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function pickString(value: unknown, key: string): string | undefined {
  const found = pick(value, key);
  return typeof found === "string" && found !== "" ? found : undefined;
}

function readMessage(error: unknown): string {
  if (typeof error === "string" && error !== "") {
    return error;
  }
  return pickString(error, "message") ?? UNKNOWN_ERROR_MESSAGE;
}

export function summarizeError(error: unknown, redact: Redactor): ErrorSummary {
  // Redact before truncating: a cut key could stop matching the pattern.
  const summary: ErrorSummary = {
    message: redact(readMessage(error)).slice(0, MAX_MESSAGE_LENGTH),
  };

  const status = pick(error, "status");
  if (typeof status === "number" && Number.isInteger(status)) {
    summary.status = status;
  }

  const code =
    pickString(error, "code") ?? pickString(pick(error, "cause"), "code");
  if (code !== undefined) {
    summary.code = redact(code).slice(0, MAX_FIELD_LENGTH);
  }

  const type = pickString(error, "type") ?? pickString(error, "name");
  if (type !== undefined) {
    summary.type = redact(type).slice(0, MAX_FIELD_LENGTH);
  }

  const requestId =
    pickString(error, "requestID") ?? pickString(error, "request_id");
  if (requestId !== undefined) {
    summary.requestId = redact(requestId).slice(0, MAX_FIELD_LENGTH);
  }

  return summary;
}
