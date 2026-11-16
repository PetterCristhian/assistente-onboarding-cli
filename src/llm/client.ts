// The only path to the provider (CLAUDE.md, architecture rule 2): the
// LlmClient interface that the rest of the project depends on.
// See docs/adr/0002-modelo-e-api-openai.md.
import OpenAI, {
  APIConnectionTimeoutError,
  APIUserAbortError,
  OpenAIError,
} from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { EasyInputMessage } from "openai/resources/responses/responses";
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
 * What the provider answered without an error of API, but that is no usable
 * answer:
 * - interrupted: the answer could not be read to its end (the stream ended
 *   before the final event, the connection dropped, or what arrived is not
 *   what the provider writes);
 * - failed: the provider reported the answer as such, or sent one outside
 *   its own format;
 * - incomplete: the provider reported the answer as such;
 * - empty: complete, with no text;
 * - refusal: the model refused to answer;
 * - invalid_output: the answer was read, and the structured output of the
 *   MODEL is not JSON or not in the schema.
 */
export type LlmResponseErrorKind =
  | "interrupted"
  | "failed"
  | "incomplete"
  | "empty"
  | "refusal"
  | "invalid_output";

/**
 * What is kept of the failure of transport behind an interrupted answer: its
 * kind, never the error itself, whose text may quote what was being read.
 */
export interface LlmTransportCause {
  readonly name?: string;
  readonly code?: string;
}

/** The message is written for the user and never quotes the model output. */
export class LlmResponseError extends Error {
  override readonly name = "LlmResponseError";
  readonly kind: LlmResponseErrorKind;
  readonly model?: string;

  constructor(
    kind: LlmResponseErrorKind,
    message: string,
    model?: string,
    cause?: LlmTransportCause,
  ) {
    super(message, cause === undefined ? undefined : { cause });
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
  unreadable: "A resposta do provedor não pôde ser lida até o fim.",
  malformed: "O provedor devolveu uma resposta fora do formato esperado.",
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

// --- What is read from the provider ---------------------------------------
// The types of the SDK describe what the provider promises, and the SDK does
// not check them. Only the fields below are used, and they are checked here.

const providerUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
});

const providerResponseSchema = z.object({
  model: z.string().nullish(),
  status: z.string().nullish(),
  error: z.object({ code: z.unknown().optional() }).nullish(),
  incomplete_details: z.object({ reason: z.unknown().optional() }).nullish(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(z.object({ type: z.string(), text: z.string().nullish() }))
          .nullish(),
      }),
    )
    .nullish(),
  usage: providerUsageSchema.nullish(),
});

type ProviderResponse = z.infer<typeof providerResponseSchema>;

const streamEventSchema = z.object({
  type: z.string(),
  delta: z.unknown().optional(),
  response: z.unknown().optional(),
});

function malformedAnswer(model?: string): LlmResponseError {
  return new LlmResponseError("failed", MESSAGES.malformed, model);
}

/** The model that answered: a text that is not blank, or nothing. */
function modelOf(response: ProviderResponse): string | undefined {
  const model = response.model;
  return typeof model === "string" && model.trim() !== "" ? model : undefined;
}

function readResponse(raw: unknown): ProviderResponse {
  const parsed = providerResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw malformedAnswer();
  }
  return parsed.data;
}

/** A response that ended well: it must say which model answered. */
function readCompletedResponse(
  raw: unknown,
): ProviderResponse & { model: string } {
  const response = readResponse(raw);
  const model = modelOf(response);
  if (model === undefined) {
    throw malformedAnswer();
  }
  return { ...response, model };
}

function toUsage(usage: ProviderResponse["usage"]): { usage?: LlmUsage } {
  if (usage === undefined || usage === null) {
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

function messageContents(response: ProviderResponse) {
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? []);
}

/** The pieces of text of the answer, in order. Empty when it has none. */
function outputTexts(response: ProviderResponse): string[] {
  return messageContents(response)
    .filter((content) => content.type === "output_text")
    .map((content) => content.text ?? "");
}

function hasRefusal(response: ProviderResponse): boolean {
  return messageContents(response).some(
    (content) => content.type === "refusal",
  );
}

/**
 * Why a response that ended carries no usable output. `reported` is what the
 * stream said about it, which counts more than what the response repeats.
 */
function unusableResponse(
  response: ProviderResponse,
  reported?: "failed" | "incomplete",
): LlmResponseError {
  const status = reported ?? response.status;
  const model = modelOf(response);
  if (status === "failed") {
    return new LlmResponseError(
      "failed",
      withDetail(MESSAGES.failed, "código", response.error?.code),
      model,
    );
  }
  if (status === "incomplete") {
    return new LlmResponseError(
      "incomplete",
      withDetail(
        MESSAGES.incomplete,
        "motivo",
        response.incomplete_details?.reason,
      ),
      model,
    );
  }
  return hasRefusal(response)
    ? new LlmResponseError("refusal", MESSAGES.refusal, model)
    : new LlmResponseError("empty", MESSAGES.empty, model);
}

function identifierIn(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && IDENTIFIER.test(found)
    ? found
    : undefined;
}

/**
 * A failure while the answer was being read. The errors of the SDK (of API,
 * of connection, of timeout, of cancellation) pass as they are. Anything
 * else is the transport giving up in the middle (the `fetch` of Node throws
 * a TypeError, the SDK a SyntaxError for an event that is not JSON): it
 * becomes an interrupted answer, which carries only the kind of the failure.
 */
function failureWhileReading(error: unknown, message: string): unknown {
  if (error instanceof OpenAIError || error instanceof LlmResponseError) {
    return error;
  }
  const name = identifierIn(error, "name");
  const code =
    identifierIn(error, "code") ??
    identifierIn(error instanceof Error ? error.cause : undefined, "code");
  const cause: LlmTransportCause = Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
  });
  return new LlmResponseError(
    "interrupted",
    message,
    undefined,
    name === undefined && code === undefined ? undefined : cause,
  );
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
  // Sent with every call. The SDK reads OPENAI_CUSTOM_HEADERS by itself and
  // applies it after its own authentication headers, so that variable could
  // replace the credential or add an organization or a project. The headers
  // of a call come last and win; `null` removes a header. A header with any
  // other name cannot be blocked here (ADR 0002, decision 9).
  const callHeaders = {
    Authorization: `Bearer ${config.openaiApiKey}`,
    "OpenAI-Organization": null,
    "OpenAI-Project": null,
  };

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
      { signal, headers: callHeaders },
    );

    // The text is the pieces, joined, in the order in which they arrived.
    let text = "";
    let chunks = 0;
    let completed: (ProviderResponse & { model: string }) | undefined;
    // Read by hand, so that a failure of the transport (which comes out of
    // `next`) is told apart from what the callback of the caller throws.
    const events: AsyncIterator<unknown> = stream[Symbol.asyncIterator]();
    let ended = false;
    try {
      for (;;) {
        let next: IteratorResult<unknown>;
        try {
          next = await events.next();
        } catch (error) {
          ended = true;
          throw failureWhileReading(error, MESSAGES.interrupted);
        }
        if (next.done === true) {
          ended = true;
          break;
        }
        // Nothing is delivered after the call was interrupted.
        if (signal.aborted) {
          break;
        }
        const event = streamEventSchema.safeParse(next.value);
        if (!event.success) {
          // Not an event of the provider: nothing to use in it.
          continue;
        }
        switch (event.data.type) {
          case "response.output_text.delta": {
            const delta = event.data.delta;
            if (typeof delta !== "string") {
              throw malformedAnswer();
            }
            text += delta;
            chunks += 1;
            request.onChunk?.(delta);
            break;
          }
          case "response.completed":
            completed = readCompletedResponse(event.data.response);
            break;
          case "response.failed":
          case "response.incomplete": {
            const said = providerResponseSchema.safeParse(event.data.response);
            throw unusableResponse(
              said.success ? said.data : {},
              event.data.type === "response.failed" ? "failed" : "incomplete",
            );
          }
          default:
            break;
        }
      }
    } finally {
      // Leaving before the end makes the SDK abort the request. The call is
      // already decided: a failure to close the stream changes nothing.
      if (!ended) {
        await events.return?.().catch(() => undefined);
      }
    }

    // The SDK ends the iteration in silence when the stream is cut short.
    if (completed === undefined) {
      throw new LlmResponseError("interrupted", MESSAGES.interrupted);
    }
    if (text === "") {
      // No piece carried text. The final event may still hold the answer:
      // it is then delivered whole, as a single piece.
      const whole = outputTexts(completed).join("");
      if (whole === "") {
        throw unusableResponse(completed);
      }
      if (signal.aborted) {
        throw new APIUserAbortError();
      }
      text = whole;
      chunks += 1;
      request.onChunk?.(whole);
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
    // The raw HTTP answer: its body is read and checked here, in two steps,
    // so that an answer of the provider that cannot be read (transport) is
    // never taken for an invalid output of the model. The parsing helper of
    // the SDK throws the same SyntaxError for both.
    const http = await sdk.responses
      .create(
        {
          model: request.model ?? defaultModel,
          instructions: request.instructions,
          input,
          store: false,
          reasoning,
          text: { format: zodTextFormat(request.schema, request.schemaName) },
        },
        { signal, headers: callHeaders },
      )
      .asResponse();

    let body: unknown;
    try {
      body = JSON.parse(await http.text());
    } catch (error) {
      throw failureWhileReading(error, MESSAGES.unreadable);
    }

    const response = readResponse(body);
    if (response.status === "failed" || response.status === "incomplete") {
      throw unusableResponse(response);
    }
    const model = modelOf(response);
    if (model === undefined) {
      throw malformedAnswer();
    }
    const texts = outputTexts(response);
    if (texts.length === 0) {
      // A refusal, or no output at all.
      throw unusableResponse(response);
    }

    // From here on, what is judged is the output of the model.
    let output: unknown;
    try {
      output = JSON.parse(texts.join(""));
    } catch {
      throw new LlmResponseError("invalid_output", MESSAGES.notJson, model);
    }
    const checked = request.schema.safeParse(output);
    if (!checked.success) {
      throw new LlmResponseError(
        "invalid_output",
        outsideSchemaMessage(checked.error),
        model,
      );
    }
    return {
      value: checked.data,
      model,
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
