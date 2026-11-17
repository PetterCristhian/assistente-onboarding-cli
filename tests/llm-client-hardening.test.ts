// Findings of the QA and of the review of the OpenAI client (ENG-48), each
// with the test that failed before its fix. The real SDK with a fake `fetch`:
// no request ever leaves the process, and the key is a fake one built at
// runtime.
import { getEventListeners } from "node:events";
import { inspect } from "node:util";
import { APIError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClient,
  type LlmClientConfig,
} from "../src/llm/client.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  FAKE_RETURNED_MODEL,
  createFakeOpenAiFetch,
  errorEvent,
  fakeResponseBody,
  finalEvent,
  sseAnswer,
  sseText,
  textDelta,
  type FakeFetchStep,
  type SseEvent,
} from "./helpers/fake-openai-fetch.js";

const KEY = fakeOpenAiKey();
const OTHER_KEY = fakeOpenAiKey("C");
const CONFIG: LlmClientConfig = {
  openaiApiKey: KEY,
  openaiModel: "configured-model",
  openaiReasoningEffort: "low",
  requestTimeoutMs: 5_000,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1,
};
const REQUEST = {
  instructions: "Assembled context.",
  input: [{ role: "user" as const, content: "question" }],
};
const verdictSchema = z.object({ approved: z.boolean(), reason: z.string() });
const VERDICT = { approved: true, reason: "fine" };

function setup(script: readonly FakeFetchStep[], config = CONFIG) {
  const fake = createFakeOpenAiFetch(script);
  const client = createOpenAiLlmClient(config, { fetch: fake.fetch });
  return { client, requests: fake.requests };
}

function jsonAnswer(value: unknown): FakeFetchStep {
  return {
    kind: "json",
    body: fakeResponseBody({ text: JSON.stringify(value) }),
  };
}

function structured(client: LlmClient, signal?: AbortSignal) {
  return client.generateStructured({
    ...REQUEST,
    schema: verdictSchema,
    schemaName: "verdict",
    ...(signal === undefined ? {} : { signal }),
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

/** Everything that an error shows when it is printed or serialized. */
function viewsOf(error: unknown): string[] {
  return [
    (error as Error).message,
    String(error),
    JSON.stringify(error) ?? "",
    inspect(error, { depth: 20, showHidden: true, getters: true }),
  ];
}

const SSE = "text/event-stream";
const JSON_TYPE = "application/json";
const STREAM_MARKER = "STREAM-CONTENT-MARKER";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OPENAI_CUSTOM_HEADERS, which the SDK reads by itself", () => {
  it("cannot replace the credential nor add an organization or a project", async () => {
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      [
        `Authorization: Bearer ${OTHER_KEY}`,
        "OpenAI-Organization: org-env",
        "OpenAI-Project: proj_env",
        "X-Extra: 1",
      ].join("\n"),
    );
    const { client, requests } = setup([
      sseAnswer(["ok"]),
      jsonAnswer(VERDICT),
    ]);

    await client.streamText(REQUEST);
    await structured(client);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.headers).not.toHaveProperty("openai-organization");
      expect(request.headers).not.toHaveProperty("openai-project");
      expect(JSON.stringify(request.headers)).not.toContain(OTHER_KEY);
      // Known limit (ADR 0002, decision 9): a header with any other name is
      // still sent. Refusing the variable is left to the configuration.
      expect(request.headers["x-extra"]).toBe("1");
    }
  });

  it("does not let a lower-case name slip through either", async () => {
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      `authorization: Bearer ${OTHER_KEY}\nopenai-organization: org-env\nopenai-project: proj_env`,
    );
    const { client, requests } = setup([sseAnswer(["ok"])]);

    await client.streamText(REQUEST);

    expect(requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(requests[0]?.headers).not.toHaveProperty("openai-organization");
    expect(requests[0]?.headers).not.toHaveProperty("openai-project");
  });
});

describe("streamText: a failure of transport in the middle of the stream", () => {
  it("reports a connection that drops as an interrupted answer", async () => {
    const { client, requests } = setup([
      {
        kind: "raw",
        contentType: SSE,
        parts: [sseText(textDelta(`partial ${STREAM_MARKER}`))],
        breakAfter: true,
      },
    ]);
    const received: string[] = [];

    const error = await rejectionOf(
      client.streamText({
        ...REQUEST,
        onChunk: (chunk) => received.push(chunk),
      }),
    );

    expect(error).toBeInstanceOf(LlmResponseError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ kind: "interrupted" });
    expect(received).toEqual([`partial ${STREAM_MARKER}`]);
    expect(requests).toHaveLength(1);
    for (const view of viewsOf(error)) {
      expect(view).not.toContain(STREAM_MARKER);
      expect(view).not.toContain("terminated");
    }
    // Only the kind of the failure is kept, never the error itself.
    expect((error as Error).cause).toEqual({
      name: "TypeError",
      code: "UND_ERR_SOCKET",
    });
  });

  it("reports an event whose data is not JSON as an interrupted answer", async () => {
    const { client } = setup([
      {
        kind: "raw",
        contentType: SSE,
        parts: [
          sseText(textDelta("a")),
          `event: response.output_text.delta\ndata: {${STREAM_MARKER}\n\n`,
          sseText(finalEvent({ text: "a" })),
        ],
      },
    ]);

    const error = await rejectionOf(client.streamText(REQUEST));

    expect(error).toBeInstanceOf(LlmResponseError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error).toMatchObject({ kind: "interrupted" });
    for (const view of viewsOf(error)) {
      expect(view).not.toContain(STREAM_MARKER);
    }
    expect((error as Error).cause).toEqual({ name: "SyntaxError" });
  });

  it("still passes on an error of the API, as it is", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [textDelta("a"), errorEvent("server_error", "It broke.")],
      },
    ]);

    const error = await rejectionOf(client.streamText(REQUEST));

    expect(error).toBeInstanceOf(APIError);
    expect(error).not.toBeInstanceOf(LlmResponseError);
    expect(error).toMatchObject({ code: "server_error" });
  });

  it("still passes on what the callback throws, even a TypeError or a SyntaxError", async () => {
    for (const thrown of [
      new TypeError("terminated"),
      new SyntaxError("callback could not parse"),
    ]) {
      const { client } = setup([sseAnswer(["a", "b"])]);

      const error = await rejectionOf(
        client.streamText({
          ...REQUEST,
          onChunk: () => {
            throw thrown;
          },
        }),
      );

      expect(error).toBe(thrown);
    }
  });
});

describe("generateStructured: an answer of the provider that cannot be read", () => {
  it.each([
    ["a page of HTML with the JSON content type", JSON_TYPE],
    ["a page of HTML with its own content type", "text/html"],
    ["a plain text", "text/plain"],
  ])(
    "reports %s as interrupted, not as invalid output",
    async (_label, type) => {
      const { client, requests } = setup([
        {
          kind: "raw",
          contentType: type,
          parts: [`<html>502 Bad Gateway ${STREAM_MARKER}</html>`],
        },
      ]);

      const error = await rejectionOf(structured(client));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: "interrupted" });
      expect(requests).toHaveLength(1);
      for (const view of viewsOf(error)) {
        expect(view).not.toContain(STREAM_MARKER);
        expect(view).not.toContain("502");
      }
    },
  );

  it("reports an empty body as interrupted", async () => {
    const { client } = setup([
      { kind: "raw", contentType: JSON_TYPE, parts: [] },
    ]);

    await expect(structured(client)).rejects.toMatchObject({
      name: "LlmResponseError",
      kind: "interrupted",
    });
  });

  it("reports a connection that drops in the middle of the body as interrupted", async () => {
    const whole = JSON.stringify(
      fakeResponseBody({ text: JSON.stringify(VERDICT) }),
    );
    const { client } = setup([
      {
        kind: "raw",
        contentType: JSON_TYPE,
        parts: [whole.slice(0, 40)],
        breakAfter: true,
      },
    ]);

    const error = await rejectionOf(structured(client));

    expect(error).toBeInstanceOf(LlmResponseError);
    expect(error).toMatchObject({ kind: "interrupted" });
    expect((error as Error).cause).toEqual({
      name: "TypeError",
      code: "UND_ERR_SOCKET",
    });
  });

  it("keeps invalid_output for what the MODEL wrote, with the model that answered", async () => {
    const { client } = setup([
      {
        kind: "json",
        body: fakeResponseBody({ text: `{"approved": ${STREAM_MARKER}` }),
      },
      {
        kind: "json",
        body: fakeResponseBody({ text: JSON.stringify({ approved: 1 }) }),
      },
    ]);

    for (let call = 0; call < 2; call += 1) {
      const error = await rejectionOf(structured(client));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({
        kind: "invalid_output",
        model: FAKE_RETURNED_MODEL,
      });
      expect((error as Error).cause).toBeUndefined();
      for (const view of viewsOf(error)) {
        expect(view).not.toContain(STREAM_MARKER);
      }
    }
  });
});

describe("what the provider sends is checked before it is used", () => {
  function event(type: string, fields: Record<string, unknown>): SseEvent {
    return { event: type, data: { type, ...fields } };
  }
  const DELTA = "response.output_text.delta";
  const body = (changes: Record<string, unknown>): Record<string, unknown> => ({
    ...(fakeResponseBody({ text: "a" }) as Record<string, unknown>),
    ...changes,
  });
  const BAD_USAGE = { input_tokens: "1", output_tokens: 2, total_tokens: 3 };

  it.each([
    ["no delta", event(DELTA, {})],
    ["a null delta", event(DELTA, { delta: null })],
    ["a number as delta", event(DELTA, { delta: 7 })],
    ["an object as delta", event(DELTA, { delta: { text: "x" } })],
  ])(
    "refuses a text event with %s, and delivers nothing of it",
    async (_label, bad) => {
      const { client } = setup([
        {
          kind: "sse",
          events: [textDelta("a"), bad, finalEvent({ text: "a" })],
        },
      ]);
      const received: string[] = [];

      const error = await rejectionOf(
        client.streamText({
          ...REQUEST,
          onChunk: (chunk) => received.push(chunk),
        }),
      );

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: "malformed" });
      expect(received).toEqual(["a"]);
    },
  );

  it.each([
    ["an empty response", {}],
    ["a null response", null],
    ["a text as response", "response"],
    ["no model", body({ model: undefined })],
    ["a null model", body({ model: null })],
    ["an empty model", body({ model: "" })],
    ["a blank model", body({ model: "   " })],
    ["a number as model", body({ model: 4 })],
    ["usage with a text", body({ usage: BAD_USAGE })],
    ["usage with a missing count", body({ usage: { input_tokens: 1 } })],
    ["an output that is not a list", body({ output: "text" })],
  ])("refuses a final event with %s", async (_label, response) => {
    const { client } = setup([
      {
        kind: "sse",
        events: [textDelta("a"), event("response.completed", { response })],
      },
    ]);

    const outcome = await client
      .streamText(REQUEST)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(LlmResponseError);
    expect(outcome).not.toBeInstanceOf(TypeError);
    expect(outcome).toMatchObject({ kind: "malformed" });
    expect((outcome as Error).message).toContain("fora do formato esperado");
  });

  it("refuses a final event with no response at all", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [textDelta("a"), event("response.completed", {})],
      },
    ]);

    await expect(client.streamText(REQUEST)).rejects.toMatchObject({
      name: "LlmResponseError",
      kind: "malformed",
    });
  });

  it.each([
    ["absent", { usage: undefined }],
    ["null", { usage: null }],
  ])("returns no usage when it is %s", async (_label, changes) => {
    const { client } = setup([
      {
        kind: "sse",
        events: [
          textDelta("a"),
          event("response.completed", { response: body(changes) }),
        ],
      },
      {
        kind: "json",
        body: {
          ...(fakeResponseBody({ text: JSON.stringify(VERDICT) }) as Record<
            string,
            unknown
          >),
          ...changes,
        },
      },
    ]);

    const text = await client.streamText(REQUEST);
    const object = await structured(client);

    expect(text).toEqual({ text: "a", model: FAKE_RETURNED_MODEL, chunks: 1 });
    expect(object).toEqual({ value: VERDICT, model: FAKE_RETURNED_MODEL });
  });

  it.each(["failed", "incomplete"] as const)(
    "still reports a %s event whose response says nothing",
    async (status) => {
      const { client } = setup([
        {
          kind: "sse",
          events: [event(`response.${status}`, { response: {} })],
        },
        { kind: "sse", events: [event(`response.${status}`, {})] },
      ]);

      for (let call = 0; call < 2; call += 1) {
        const error = await rejectionOf(client.streamText(REQUEST));

        expect(error).toBeInstanceOf(LlmResponseError);
        expect(error).toMatchObject({ kind: status });
        expect((error as LlmResponseError).model).toBeUndefined();
      }
    },
  );

  it.each([
    ["an empty object", {}],
    ["null", null],
    ["a text", "a text"],
    ["a list", []],
    ["a number", 3],
    ["no model", body({ model: undefined })],
    ["an empty model", body({ model: "" })],
    ["usage with a text", body({ usage: BAD_USAGE })],
    ["an output that is not a list", body({ output: { text: "x" } })],
    ["an output item that is not an object", body({ output: ["x"] })],
  ])(
    "refuses a structured answer that is %s, with no TypeError",
    async (_label, answer) => {
      const { client } = setup([{ kind: "json", body: answer }]);

      const error = await rejectionOf(structured(client));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ kind: "malformed" });
      expect((error as Error).message).toContain("fora do formato esperado");
    },
  );
});

describe("streamText: a final event with the text and no piece before it", () => {
  it("delivers the text of the final event as a single piece", async () => {
    const { client } = setup([
      { kind: "sse", events: [finalEvent({ text: "the whole answer" })] },
    ]);
    const received: string[] = [];

    const result = await client.streamText({
      ...REQUEST,
      onChunk: (chunk) => received.push(chunk),
    });

    expect(received).toEqual(["the whole answer"]);
    expect(result).toEqual({
      text: "the whole answer",
      model: FAKE_RETURNED_MODEL,
      chunks: 1,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });
  });

  it("does not use it when pieces did arrive: the text is the pieces", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [
          textDelta("from "),
          textDelta("pieces"),
          finalEvent({ text: "something else" }),
        ],
      },
    ]);
    const received: string[] = [];

    const result = await client.streamText({
      ...REQUEST,
      onChunk: (chunk) => received.push(chunk),
    });

    expect(result.text).toBe("from pieces");
    expect(result.chunks).toBe(2);
    expect(received).toEqual(["from ", "pieces"]);
  });

  it("keeps the count equal to the pieces delivered when empty pieces came first", async () => {
    const { client } = setup([
      { kind: "sse", events: [textDelta(""), finalEvent({ text: "late" })] },
    ]);
    const received: string[] = [];

    const result = await client.streamText({
      ...REQUEST,
      onChunk: (chunk) => received.push(chunk),
    });

    expect(result.text).toBe("late");
    expect(result.text).toBe(received.join(""));
    expect(result.chunks).toBe(received.length);
  });

  it("still reports a refusal and an empty answer", async () => {
    const { client } = setup([
      { kind: "sse", events: [finalEvent({ refusal: "no" })] },
      { kind: "sse", events: [finalEvent({})] },
    ]);

    await expect(client.streamText(REQUEST)).rejects.toMatchObject({
      kind: "refusal",
    });
    await expect(client.streamText(REQUEST)).rejects.toMatchObject({
      kind: "empty",
    });
  });
});

describe("generateStructured: the schema that goes on the wire", () => {
  // Recorded in ADR 0002, decision 10: whether the API accepts this key is
  // for the smoke test to confirm.
  it("carries the $schema key of JSON Schema draft-07, written by the SDK", async () => {
    const { client, requests } = setup([jsonAnswer(VERDICT)]);

    await structured(client);

    const body = requests[0]?.body as {
      text: { format: { schema: Record<string, unknown> } };
    };
    expect(body.text.format.schema.$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
    // Only what can be sent: the parsing helpers of the SDK stay local.
    expect(Object.keys(body.text.format).sort()).toEqual([
      "name",
      "schema",
      "strict",
      "type",
    ]);
  });
});

describe("the listener of the total deadline", () => {
  it("is removed from the signal of every call, however the call ends", async () => {
    // The signal that each call runs under is made of the signal of the
    // caller and of the deadline: the first one that the call builds.
    const signals: AbortSignal[] = [];
    const any = AbortSignal.any.bind(AbortSignal);
    vi.spyOn(AbortSignal, "any").mockImplementation((sources) => {
      const signal = any(sources);
      if ([...sources].includes(controller.signal)) {
        signals.push(signal);
      }
      return signal;
    });
    const controller = new AbortController();
    const { client } = setup([
      sseAnswer(["a", "b"]),
      jsonAnswer(VERDICT),
      { kind: "json", status: 500, body: { error: { message: "Failure." } } },
      { kind: "sse", events: [textDelta("cut")] },
      { kind: "json", body: fakeResponseBody({ text: "not json" }) },
    ]);
    const request = { ...REQUEST, signal: controller.signal };

    await client.streamText(request);
    await structured(client, controller.signal);
    await rejectionOf(client.streamText(request));
    await rejectionOf(client.streamText(request));
    await rejectionOf(structured(client, controller.signal));
    await rejectionOf(client.streamText({ ...request, input: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(signals).toHaveLength(5);
    for (const signal of signals) {
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
