// The only path to the provider (CLAUDE.md, architecture rule 2): the
// LlmClient interface that the rest of the project depends on.
// See docs/adr/0002-modelo-e-api-openai.md.
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type {
  EasyInputMessage,
  Response,
  ResponseUsage,
} from "openai/resources/responses/responses";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  /** The assembled context, or the prompt of the reviewer or of the judge. */
  readonly instructions: string;
  /** The history followed by the question. Never empty. */
  readonly input: readonly LlmMessage[];
  /** Default: the model of the configuration. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface StreamTextRequest extends LlmRequest {
  /** Called with each piece of text, in order, as it arrives. */
  readonly onChunk?: (chunk: string) => void;
}

export interface LlmTextResult {
  /** The whole text: the pieces, joined. */
  readonly text: string;
  /** The model that answered, as reported by the provider. */
  readonly model: string;
  /** How many pieces of text arrived. */
  readonly chunks: number;
  readonly usage?: LlmUsage;
}

export interface StructuredRequest<S extends z.ZodType> extends LlmRequest {
  readonly schema: S;
  /** Name of the schema, shown to the model. */
  readonly schemaName: string;
}

export interface LlmStructuredResult<T> {
  readonly value: T;
  /** The model that answered, as reported by the provider. */
  readonly model: string;
  readonly usage?: LlmUsage;
}

export interface LlmClient {
  streamText(request: StreamTextRequest): Promise<LlmTextResult>;
  generateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<LlmStructuredResult<z.infer<S>>>;
}

/**
 * What the provider answered without an error of transport or of API, but
 * that is no usable answer:
 * - interrupted: the stream ended before the answer was complete;
 * - failed / incomplete: the provider reported the answer as such;
 * - empty: complete, with no text;
 * - refusal: the model refused to answer;
 * - invalid_output: structured output that is not JSON or not in the schema.
 */
export type LlmResponseErrorKind =
  | "interrupted"
  | "failed"
  | "incomplete"
  | "empty"
  | "refusal"
  | "invalid_output";

/** The message is written for the user and never quotes the model output. */
export class LlmResponseError extends Error {
  override readonly name = "LlmResponseError";
  readonly kind: LlmResponseErrorKind;
  readonly model?: string;

  constructor(kind: LlmResponseErrorKind, message: string, model?: string) {
    super(message);
    this.kind = kind;
    if (model !== undefined) {
      this.model = model;
    }
  }
}

// --- Implementation over the SDK (Responses API) --------------------------

export type LlmClientConfig = Pick<
  AppConfig,
  "openaiApiKey" | "openaiModel" | "openaiReasoningEffort" | "requestTimeoutMs"
>;

export interface OpenAiClientDeps {
  /** Default: the global `fetch`. Tests pass a fake one. */
  fetch?: typeof fetch;
  /** Default: the public address of the API. The local stub passes its own. */
  baseURL?: string;
}

// Written out so that the SDK never falls back to OPENAI_BASE_URL.
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const MESSAGES = {
  interrupted: "A resposta do modelo foi interrompida antes de terminar.",
  failed: "O provedor informou que a geração da resposta falhou",
  incomplete: "A resposta do modelo ficou incompleta",
  empty: "O modelo não devolveu nenhum texto.",
  refusal: "O modelo se recusou a responder.",
  notJson: "A saída estruturada do modelo não é um JSON válido.",
  outsideSchema: "A saída estruturada do modelo não segue o formato esperado",
} as const;

// A short identifier of the provider or a field name of the schema: the only
// things, besides fixed text, that go into a message.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MAX_FIELDS_IN_MESSAGE = 5;
// The longest delay that a timer accepts; a longer one would fire at once.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function withDetail(message: string, label: string, detail: unknown): string {
  return typeof detail === "string" && IDENTIFIER.test(detail)
    ? `${message} (${label}: ${detail}).`
    : `${message}.`;
}

function toUsage(usage: ResponseUsage | undefined): { usage?: LlmUsage } {
  if (usage === undefined) {
    return {};
  }
  return {
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    },
  };
}

function hasRefusal(response: Response): boolean {
  return response.output.some(
    (item) =>
      item.type === "message" &&
      item.content.some((content) => content.type === "refusal"),
  );
}

/** Why a response that ended carries no usable output. */
function unusableResponse(response: Response): LlmResponseError {
  if (response.status === "failed") {
    return new LlmResponseError(
      "failed",
      withDetail(MESSAGES.failed, "código", response.error?.code),
      response.model,
    );
  }
  if (response.status === "incomplete") {
    return new LlmResponseError(
      "incomplete",
      withDetail(
        MESSAGES.incomplete,
        "motivo",
        response.incomplete_details?.reason,
      ),
      response.model,
    );
  }
  return hasRefusal(response)
    ? new LlmResponseError("refusal", MESSAGES.refusal, response.model)
    : new LlmResponseError("empty", MESSAGES.empty, response.model);
}

/** Names the refused fields; never their values. */
function outsideSchemaMessage(error: z.ZodError): string {
  const fields = [
    ...new Set(
      error.issues
        .map((issue) => issue.path)
        .filter(
          (path) =>
            path.length > 0 &&
            path.every(
              (segment) =>
                typeof segment === "number" ||
                (typeof segment === "string" && IDENTIFIER.test(segment)),
            ),
        )
        .map((path) => path.join(".")),
    ),
  ].slice(0, MAX_FIELDS_IN_MESSAGE);
  return fields.length > 0
    ? `${MESSAGES.outsideSchema} (campos: ${fields.join(", ")}).`
    : `${MESSAGES.outsideSchema}.`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toInput(messages: readonly LlmMessage[]): EasyInputMessage[] {
  if (messages.length === 0) {
    throw new TypeError("LlmRequest.input must not be empty.");
  }
  return messages.map(({ role, content }) => ({ role, content }));
}

/**
 * The SDK client lives only in this closure: its `apiKey` is a public
 * property, so it must never be reachable from the object that is returned.
 * Every option that the SDK would read from the environment is given here.
 */
export function createOpenAiLlmClient(
  config: LlmClientConfig,
  deps: OpenAiClientDeps = {},
): LlmClient {
  const deadlineMs = Math.min(config.requestTimeoutMs, MAX_TIMER_DELAY_MS);
  const sdk = new OpenAI({
    apiKey: config.openaiApiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: deps.baseURL ?? DEFAULT_BASE_URL,
    // The retry is ours (ADR 0005): the SDK never tries again by itself.
    maxRetries: 0,
    timeout: deadlineMs,
    logLevel: "off",
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const defaultModel = config.openaiModel;
  const reasoning = { effort: config.openaiReasoningEffort };

  /**
   * Runs one call under the total deadline (REQUEST_TIMEOUT_MS), which also
   * covers the body of a stream: the timeout of the SDK ends when the headers
   * arrive. When the deadline or the caller interrupts the call, the SDK may
   * just end the stream in silence, so the outcome is decided here: a timeout
   * error for the deadline, an abort error for the caller.
   */
  async function withDeadline<T>(
    callerSignal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, deadlineMs);
    const signal =
      callerSignal === undefined
        ? deadline.signal
        : AbortSignal.any([callerSignal, deadline.signal]);
    // The call ends when it is interrupted, even if what runs under it does
    // not react to the signal.
    const interrupted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new APIUserAbortError());
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([run(signal), interrupted]);
    } catch (error) {
      if (timedOut) {
        throw error instanceof APIConnectionTimeoutError
          ? error
          : new APIConnectionTimeoutError();
      }
      if (callerSignal?.aborted === true) {
        throw error instanceof APIUserAbortError
          ? error
          : new APIUserAbortError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function streamTextUnder(
    request: StreamTextRequest,
    input: EasyInputMessage[],
    signal: AbortSignal,
  ): Promise<LlmTextResult> {
    const stream = await sdk.responses.create(
      {
        model: request.model ?? defaultModel,
        instructions: request.instructions,
        input,
        store: false,
        reasoning,
        stream: true,
      },
      { signal },
    );

    // The final event carries no text: the text is the pieces, joined.
    let text = "";
    let chunks = 0;
    let completed: Response | undefined;
    for await (const event of stream) {
      // Nothing is delivered after the call was interrupted. Leaving the
      // loop also makes the SDK abort the request.
      if (signal.aborted) {
        break;
      }
      switch (event.type) {
        case "response.output_text.delta":
          text += event.delta;
          chunks += 1;
          request.onChunk?.(event.delta);
          break;
        case "response.completed":
          completed = event.response;
          break;
        case "response.failed":
        case "response.incomplete":
          throw unusableResponse(event.response);
        default:
          break;
      }
    }

    // The SDK ends the iteration in silence when the stream is cut short.
    if (completed === undefined) {
      throw new LlmResponseError("interrupted", MESSAGES.interrupted);
    }
    if (text === "") {
      throw unusableResponse(completed);
    }
    return {
      text,
      model: completed.model,
      chunks,
      ...toUsage(completed.usage),
    };
  }

  // Not `async`: a refused request is a rejected promise, like the rest.
  function streamText(request: StreamTextRequest): Promise<LlmTextResult> {
    try {
      const input = toInput(request.input);
      return withDeadline(request.signal, (signal) =>
        streamTextUnder(request, input, signal),
      );
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  async function generateStructuredUnder<S extends z.ZodType>(
    request: StructuredRequest<S>,
    input: EasyInputMessage[],
    signal: AbortSignal,
  ): Promise<LlmStructuredResult<z.infer<S>>> {
    let response: Response & { output_parsed: unknown };
    try {
      response = await sdk.responses.parse(
        {
          model: request.model ?? defaultModel,
          instructions: request.instructions,
          input,
          store: false,
          reasoning,
          text: { format: zodTextFormat(request.schema, request.schemaName) },
        },
        { signal },
      );
    } catch (error) {
      // The SDK parses the output while reading the answer, so the model that
      // answered is not known here.
      if (error instanceof z.ZodError) {
        throw new LlmResponseError(
          "invalid_output",
          outsideSchemaMessage(error),
        );
      }
      if (error instanceof SyntaxError) {
        throw new LlmResponseError("invalid_output", MESSAGES.notJson);
      }
      throw error;
    }

    // A refusal and an incomplete answer do not throw: nothing was parsed.
    if (response.output_parsed === null) {
      throw unusableResponse(response);
    }
    const checked = request.schema.safeParse(response.output_parsed);
    if (!checked.success) {
      throw new LlmResponseError(
        "invalid_output",
        outsideSchemaMessage(checked.error),
        response.model,
      );
    }
    return {
      value: checked.data,
      model: response.model,
      ...toUsage(response.usage),
    };
  }

  function generateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<LlmStructuredResult<z.infer<S>>> {
    try {
      const input = toInput(request.input);
      return withDeadline(request.signal, (signal) =>
        generateStructuredUnder(request, input, signal),
      );
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  return Object.freeze({ streamText, generateStructured });
}
