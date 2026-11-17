// A fake `fetch` for the tests of the real SDK client: records every request
// and answers from a script, in order. Nothing here touches the network.

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON body, parsed; `undefined` when there is none. */
  readonly body: unknown;
}

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

export type FakeFetchStep =
  /** A streaming answer. With `hang`, the body never ends after the events. */
  | {
      readonly kind: "sse";
      readonly events: readonly SseEvent[];
      readonly hang?: boolean;
      /** The body does not react to the abort signal of the request. */
      readonly ignoreAbort?: boolean;
    }
  /** A JSON answer: a success, or an HTTP error with a status. */
  | {
      readonly kind: "json";
      readonly status?: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  /**
   * A body written as given, piece by piece, with any content type. With
   * `breakAfter`, the body fails after its pieces, as a dropped connection
   * does in the real `fetch`.
   */
  | {
      readonly kind: "raw";
      readonly status?: number;
      readonly contentType: string;
      readonly parts: readonly string[];
      readonly breakAfter?: boolean;
    }
  /** No answer at all: pending until the request is aborted. */
  | { readonly kind: "no-response" }
  /** The connection fails, as `fetch` does: a TypeError with a cause. */
  | { readonly kind: "network-error"; readonly code: string };

export interface FakeOpenAiFetch {
  readonly fetch: typeof fetch;
  readonly requests: readonly RecordedRequest[];
}

function abortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

function sseBody(
  events: readonly SseEvent[],
  hang: boolean,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        try {
          controller.error(abortError());
        } catch {
          // Already closed: nothing to interrupt.
        }
      });
    },
    // One event per pull, so that the reader sees them one at a time.
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted === true) {
        return;
      }
      const next = events[index];
      index += 1;
      if (next !== undefined) {
        controller.enqueue(
          encoder.encode(
            `event: ${next.event}\ndata: ${JSON.stringify(next.data)}\n\n`,
          ),
        );
        return;
      }
      if (hang) {
        // Stays open until the request is aborted.
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        return;
      }
      controller.close();
    },
  });
}

/** What the real `fetch` throws when the connection drops in the body. */
export function droppedConnectionError(): TypeError {
  return new TypeError("terminated", {
    cause: Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    }),
  });
}

function piecewiseBody(
  parts: readonly string[],
  breakAfter: boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Promise.resolve();
      const next = parts[index];
      index += 1;
      if (next !== undefined) {
        controller.enqueue(encoder.encode(next));
      } else if (breakAfter) {
        controller.error(droppedConnectionError());
      } else {
        controller.close();
      }
    },
  });
}

export function createFakeOpenAiFetch(
  script: readonly FakeFetchStep[],
): FakeOpenAiFetch {
  const steps = [...script];
  const requests: RecordedRequest[] = [];

  const fakeFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const rawBody = init?.body;
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof rawBody === "string"
          ? (JSON.parse(rawBody) as unknown)
          : undefined,
    });

    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    const step = steps.shift();
    if (step === undefined) {
      return Promise.reject(
        new Error("Fake fetch: the script has no step left."),
      );
    }

    switch (step.kind) {
      case "sse":
        return Promise.resolve(
          new Response(
            sseBody(
              step.events,
              step.hang === true,
              step.ignoreAbort === true ? undefined : signal,
            ),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          ),
        );
      case "json":
        return Promise.resolve(
          new Response(JSON.stringify(step.body), {
            status: step.status ?? 200,
            headers: { "content-type": "application/json", ...step.headers },
          }),
        );
      case "raw":
        return Promise.resolve(
          new Response(piecewiseBody(step.parts, step.breakAfter === true), {
            status: step.status ?? 200,
            headers: { "content-type": step.contentType },
          }),
        );
      case "no-response":
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(abortError()));
        });
      case "network-error":
        return Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect failed"), {
              code: step.code,
            }),
          }),
        );
    }
  };

  return { fetch: fakeFetch, requests };
}

// --- Payloads in the format of the Responses API -------------------------

export interface FakeUsage {
  readonly input: number;
  readonly output: number;
}

export interface FakeResponseOptions {
  readonly model?: string;
  readonly status?: "completed" | "failed" | "incomplete";
  /** Text of the answer. Without it (and without refusal): no output. */
  readonly text?: string;
  readonly refusal?: string;
  readonly usage?: FakeUsage;
  readonly errorCode?: string;
  readonly incompleteReason?: string;
}

export const FAKE_RETURNED_MODEL = "returned-model-2026-01-01";

/** A response object, as in a JSON answer or inside a final stream event. */
export function fakeResponseBody(options: FakeResponseOptions = {}): unknown {
  const content =
    options.refusal !== undefined
      ? [{ type: "refusal", refusal: options.refusal }]
      : options.text !== undefined
        ? [{ type: "output_text", text: options.text, annotations: [] }]
        : [];
  const usage = options.usage ?? { input: 11, output: 7 };
  return {
    id: "resp_fake",
    object: "response",
    created_at: 1_700_000_000,
    status: options.status ?? "completed",
    model: options.model ?? FAKE_RETURNED_MODEL,
    error:
      options.errorCode === undefined
        ? null
        : { code: options.errorCode, message: "provider failure" },
    incomplete_details:
      options.incompleteReason === undefined
        ? null
        : { reason: options.incompleteReason },
    output:
      content.length === 0
        ? []
        : [
            {
              type: "message",
              id: "msg_fake",
              role: "assistant",
              status: "completed",
              content,
            },
          ],
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
  };
}

export function textDelta(delta: string): SseEvent {
  return {
    event: "response.output_text.delta",
    data: { type: "response.output_text.delta", delta },
  };
}

/** One event of a stream, as the bytes that the provider would write. */
export function sseText(event: SseEvent): string {
  return `event: ${event.event}
data: ${JSON.stringify(event.data)}

`;
}

/** The final event of a stream: completed, failed or incomplete. */
export function finalEvent(options: FakeResponseOptions = {}): SseEvent {
  const type = `response.${options.status ?? "completed"}`;
  return { event: type, data: { type, response: fakeResponseBody(options) } };
}

export function errorEvent(code: string, message: string): SseEvent {
  return {
    event: "error",
    data: { type: "error", code, message, param: null },
  };
}

/** A whole streaming answer: one delta per chunk and the completed event. */
export function sseAnswer(
  chunks: readonly string[],
  options: FakeResponseOptions = {},
): FakeFetchStep {
  return {
    kind: "sse",
    events: [
      ...chunks.map(textDelta),
      finalEvent({ text: chunks.join(""), ...options }),
    ],
  };
}

/** The body of an HTTP error, as the API writes it. */
export function apiErrorBody(
  message: string,
  code: string,
  type = "invalid_request_error",
): unknown {
  return { error: { message, type, code, param: null } };
}
