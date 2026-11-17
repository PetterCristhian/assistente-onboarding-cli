// The real SDK with a fake `fetch`: no request ever leaves the process, and
// the key is a fake one built at runtime.
import { inspect } from "node:util";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClientConfig,
  type LlmMessage,
} from "../src/llm/client.js";
import { summarizeError } from "../src/security/error-summary.js";
import { createRedactor } from "../src/security/redact.js";
import { fakeMaskedOpenAiKey, fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  FAKE_RETURNED_MODEL,
  apiErrorBody,
  createFakeOpenAiFetch,
  errorEvent,
  fakeResponseBody,
  finalEvent,
  sseAnswer,
  textDelta,
  type FakeFetchStep,
} from "./helpers/fake-openai-fetch.js";

const KEY = fakeOpenAiKey();
const CONFIG: LlmClientConfig = {
  openaiApiKey: KEY,
  openaiModel: "configured-model",
  openaiReasoningEffort: "low",
  requestTimeoutMs: 5_000,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1,
};
const INSTRUCTIONS = "Assembled context goes here.";
const HISTORY: readonly LlmMessage[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

function setup(script: readonly FakeFetchStep[], config = CONFIG) {
  const fake = createFakeOpenAiFetch(script);
  const client = createOpenAiLlmClient(config, { fetch: fake.fetch });
  return { client, requests: fake.requests };
}

function bodyOf(
  request: { body: unknown } | undefined,
): Record<string, unknown> {
  expect(request).toBeDefined();
  return request?.body as Record<string, unknown>;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

describe("streamText: the request", () => {
  it("sends the context, the history and the options of the configuration", async () => {
    const { client, requests } = setup([sseAnswer(["ok"])]);

    await client.streamText({ instructions: INSTRUCTIONS, input: HISTORY });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method.toUpperCase()).toBe("POST");
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(bodyOf(requests[0])).toEqual({
      model: "configured-model",
      instructions: INSTRUCTIONS,
      input: HISTORY,
      store: false,
      reasoning: { effort: "low" },
      stream: true,
    });
  });

  it("sends no sampling parameter and no server-side state", async () => {
    const { client, requests } = setup([sseAnswer(["ok"])]);

    await client.streamText({ instructions: INSTRUCTIONS, input: HISTORY });

    const body = bodyOf(requests[0]);
    for (const name of [
      "temperature",
      "top_p",
      "seed",
      "previous_response_id",
    ]) {
      expect(body).not.toHaveProperty(name);
    }
  });

  it("uses the model of the request instead of the configured one", async () => {
    const { client, requests } = setup([sseAnswer(["ok"])]);

    await client.streamText({
      instructions: INSTRUCTIONS,
      input: HISTORY,
      model: "judge-model",
    });

    expect(bodyOf(requests[0]).model).toBe("judge-model");
  });

  it("uses the base URL it was given", async () => {
    const fake = createFakeOpenAiFetch([sseAnswer(["ok"])]);
    const client = createOpenAiLlmClient(CONFIG, {
      fetch: fake.fetch,
      baseURL: "http://127.0.0.1:9/v1",
    });

    await client.streamText({ instructions: INSTRUCTIONS, input: HISTORY });

    expect(fake.requests[0]?.url).toBe("http://127.0.0.1:9/v1/responses");
  });

  it("refuses an empty input without making a request", async () => {
    const { client, requests } = setup([sseAnswer(["ok"])]);

    await expect(
      client.streamText({ instructions: INSTRUCTIONS, input: [] }),
    ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});

describe("streamText: the answer", () => {
  it("delivers each chunk in order and returns the text, the model and the usage", async () => {
    const { client } = setup([
      sseAnswer(["Uni", "t te", "sts."], { usage: { input: 30, output: 12 } }),
    ]);
    const received: string[] = [];

    const result = await client.streamText({
      instructions: INSTRUCTIONS,
      input: HISTORY,
      onChunk: (chunk) => received.push(chunk),
    });

    expect(received).toEqual(["Uni", "t te", "sts."]);
    expect(result).toEqual({
      text: "Unit tests.",
      model: FAKE_RETURNED_MODEL,
      chunks: 3,
      usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
    });
    // The model that answered, not the one that was asked for.
    expect(result.model).not.toBe(CONFIG.openaiModel);
  });

  it("returns the same result without onChunk", async () => {
    const { client } = setup([sseAnswer(["Uni", "t te", "sts."])]);

    const result = await client.streamText({
      instructions: INSTRUCTIONS,
      input: HISTORY,
    });

    expect(result.text).toBe("Unit tests.");
    expect(result.chunks).toBe(3);
    expect(result.model).toBe(FAKE_RETURNED_MODEL);
  });

  it("ignores the events it does not use", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [
          { event: "response.created", data: { type: "response.created" } },
          textDelta("a"),
          {
            event: "response.output_text.done",
            data: { type: "response.output_text.done", text: "a" },
          },
          finalEvent({ text: "a" }),
        ],
      },
    ]);

    const result = await client.streamText({
      instructions: INSTRUCTIONS,
      input: HISTORY,
    });

    expect(result.text).toBe("a");
    expect(result.chunks).toBe(1);
  });

  it("reports a stream that ends before the answer is complete", async () => {
    const { client } = setup([
      { kind: "sse", events: [textDelta("partial "), textDelta("text")] },
    ]);

    const error = await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );

    expect(error).toBeInstanceOf(LlmResponseError);
    expect(error).toMatchObject({ kind: "interrupted" });
    expect((error as Error).message).not.toContain("partial");
  });

  it.each([
    [
      "failed",
      [
        textDelta("partial"),
        finalEvent({ status: "failed", errorCode: "server_error" }),
      ],
    ],
    [
      "incomplete",
      [
        textDelta("partial"),
        finalEvent({
          status: "incomplete",
          incompleteReason: "max_output_tokens",
        }),
      ],
    ],
    ["empty", [finalEvent({})]],
    ["refusal", [finalEvent({ refusal: "I will not answer that." })]],
  ] as const)("reports an answer that is %s", async (kind, events) => {
    const { client } = setup([{ kind: "sse", events }]);

    const error = await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );

    expect(error).toBeInstanceOf(LlmResponseError);
    expect(error).toMatchObject({ kind, model: FAKE_RETURNED_MODEL });
    expect((error as Error).message).not.toContain("partial");
    expect((error as Error).message).not.toContain("I will not");
  });

  it("passes on the error of an error event of the stream, with its code", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [textDelta("partial"), errorEvent("server_error", "It broke.")],
      },
    ]);

    const error = await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );

    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({ code: "server_error" });
    expect((error as APIError).status).toBeUndefined();
  });
});

const verdictSchema = z.object({ approved: z.boolean(), reason: z.string() });

function structured(client: ReturnType<typeof setup>["client"]) {
  return client.generateStructured({
    instructions: "Judge the answer.",
    input: [{ role: "user", content: "the answer to judge" }],
    schema: verdictSchema,
    schemaName: "verdict",
  });
}

describe("generateStructured", () => {
  it("asks for a strict JSON schema and returns the typed object and the model", async () => {
    const { client, requests } = setup([
      {
        kind: "json",
        body: fakeResponseBody({
          text: JSON.stringify({ approved: true, reason: "fine" }),
          usage: { input: 20, output: 5 },
        }),
      },
    ]);

    const result = await structured(client);

    const approved: boolean = result.value.approved;
    expect(approved).toBe(true);
    expect(result).toEqual({
      value: { approved: true, reason: "fine" },
      model: FAKE_RETURNED_MODEL,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    const body = bodyOf(requests[0]);
    expect(body).toMatchObject({
      model: "configured-model",
      instructions: "Judge the answer.",
      input: [{ role: "user", content: "the answer to judge" }],
      store: false,
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", strict: true, name: "verdict" } },
    });
    const format = (body.text as { format: { schema: unknown } }).format;
    expect(format.schema).toMatchObject({
      type: "object",
      required: ["approved", "reason"],
      additionalProperties: false,
    });
    expect(body.stream).not.toBe(true);
    for (const name of ["temperature", "top_p", "seed"]) {
      expect(body).not.toHaveProperty(name);
    }
  });

  it("uses the model of the request instead of the configured one", async () => {
    const { client, requests } = setup([
      {
        kind: "json",
        body: fakeResponseBody({
          text: JSON.stringify({ approved: false, reason: "no" }),
        }),
      },
    ]);

    await client.generateStructured({
      instructions: "Judge the answer.",
      input: [{ role: "user", content: "x" }],
      schema: verdictSchema,
      schemaName: "verdict",
      model: "judge-model",
    });

    expect(bodyOf(requests[0]).model).toBe("judge-model");
  });

  it.each([
    [
      "malformed JSON",
      { text: '{"approved": tru SECRET-TEXT' },
      "invalid_output",
    ],
    [
      "JSON outside the schema",
      { text: JSON.stringify({ approved: "SECRET-TEXT", reason: 3 }) },
      "invalid_output",
    ],
    ["a refusal", { refusal: "SECRET-TEXT: I will not." }, "refusal"],
    [
      "an incomplete answer",
      { status: "incomplete", incompleteReason: "max_output_tokens" },
      "incomplete",
    ],
    [
      "a failed answer",
      { status: "failed", errorCode: "server_error" },
      "failed",
    ],
    ["no output at all", {}, "empty"],
  ] as const)(
    "reports %s without quoting the model",
    async (_label, options, kind) => {
      const { client } = setup([
        { kind: "json", body: fakeResponseBody(options) },
      ]);

      const error = await rejectionOf(structured(client));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind });
      // The answer of the provider was read, so the model is known even
      // when what it wrote is refused.
      expect((error as LlmResponseError).model).toBe(FAKE_RETURNED_MODEL);
      expect((error as Error).message).not.toContain("SECRET-TEXT");
      expect(JSON.stringify(error)).not.toContain("SECRET-TEXT");
      expect((error as Error).cause).toBeUndefined();
    },
  );

  it("names the fields that the schema refused", async () => {
    const { client } = setup([
      {
        kind: "json",
        body: fakeResponseBody({
          text: JSON.stringify({ approved: "yes", reason: "ok" }),
        }),
      },
    ]);

    const error = await rejectionOf(structured(client));

    expect((error as Error).message).toContain("approved");
    expect((error as Error).message).not.toContain("yes");
  });

  it("refuses an empty input without making a request", async () => {
    const { client, requests } = setup([]);

    await expect(
      client.generateStructured({
        instructions: "Judge.",
        input: [],
        schema: verdictSchema,
        schemaName: "verdict",
      }),
    ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});

const SHORT_TIMEOUT: LlmClientConfig = { ...CONFIG, requestTimeoutMs: 60 };
// For the test that needs a chunk to arrive BEFORE the deadline: with 60 ms,
// a busy machine could reach the deadline first.
const ROOMY_TIMEOUT: LlmClientConfig = { ...CONFIG, requestTimeoutMs: 300 };
const TEST_TIMEOUT_MS = 3_000;
const VERDICT_JSON = JSON.stringify({ approved: true, reason: "fine" });

describe("total deadline of a call", () => {
  it(
    "gives up when the server never answers",
    async () => {
      const { client, requests } = setup(
        [{ kind: "no-response" }, { kind: "no-response" }],
        SHORT_TIMEOUT,
      );

      await expect(
        client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
      ).rejects.toBeInstanceOf(APIConnectionTimeoutError);
      await expect(structured(client)).rejects.toBeInstanceOf(
        APIConnectionTimeoutError,
      );
      // No second attempt by the SDK.
      expect(requests).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives up when the body of the stream stops arriving",
    async () => {
      const { client } = setup(
        [{ kind: "sse", events: [textDelta("partial")], hang: true }],
        ROOMY_TIMEOUT,
      );
      const received: string[] = [];

      const error = await rejectionOf(
        client.streamText({
          instructions: INSTRUCTIONS,
          input: HISTORY,
          onChunk: (chunk) => received.push(chunk),
        }),
      );

      expect(error).toBeInstanceOf(APIConnectionTimeoutError);
      expect(received).toEqual(["partial"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives up even when the transport does not react to the cancellation",
    async () => {
      const { client } = setup(
        [
          {
            kind: "sse",
            events: [textDelta("partial")],
            hang: true,
            ignoreAbort: true,
          },
        ],
        SHORT_TIMEOUT,
      );

      await expect(
        client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
      ).rejects.toBeInstanceOf(APIConnectionTimeoutError);
    },
    TEST_TIMEOUT_MS,
  );

  it("leaves no timer behind after an answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { client } = setup([
        { kind: "json", body: fakeResponseBody({ text: VERDICT_JSON }) },
      ]);

      await structured(client);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cancellation by the caller", () => {
  it("rejects with the abort error when the signal is already aborted", async () => {
    const { client } = setup([
      sseAnswer(["never"]),
      { kind: "json", body: fakeResponseBody({ text: VERDICT_JSON }) },
    ]);
    const received: string[] = [];
    const signal = AbortSignal.abort();

    await expect(
      client.streamText({
        instructions: INSTRUCTIONS,
        input: HISTORY,
        signal,
        onChunk: (chunk) => received.push(chunk),
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
    await expect(
      client.generateStructured({
        instructions: "Judge.",
        input: [{ role: "user", content: "x" }],
        schema: verdictSchema,
        schemaName: "verdict",
        signal,
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
    expect(received).toEqual([]);
  });

  it(
    "rejects with the abort error, and delivers nothing else, when cancelled in the middle",
    async () => {
      const { client } = setup([sseAnswer(["one", "two", "three", "four"])]);
      const controller = new AbortController();
      const received: string[] = [];

      const error = await rejectionOf(
        client.streamText({
          instructions: INSTRUCTIONS,
          input: HISTORY,
          signal: controller.signal,
          onChunk: (chunk) => {
            received.push(chunk);
            controller.abort();
          },
        }),
      );

      expect(error).toBeInstanceOf(APIUserAbortError);
      expect(received).toEqual(["one"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("errors of the API and of the connection", () => {
  it("does not try again after an HTTP 500", async () => {
    const { client, requests } = setup([
      {
        kind: "json",
        status: 500,
        body: apiErrorBody("The server had an error.", "server_error"),
      },
      sseAnswer(["must not be requested"]),
    ]);

    const error = await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );

    expect(error).toBeInstanceOf(InternalServerError);
    expect(error).toMatchObject({ status: 500 });
    expect(requests).toHaveLength(1);
  });

  it("passes on a 429 with its status, code and readable headers", async () => {
    const { client, requests } = setup([
      {
        kind: "json",
        status: 429,
        headers: { "retry-after": "7", "x-request-id": "req_fake_1" },
        body: apiErrorBody(
          "Rate limit reached.",
          "rate_limit_exceeded",
          "requests",
        ),
      },
    ]);

    const error = await rejectionOf(structured(client));

    expect(error).toBeInstanceOf(RateLimitError);
    const rateLimit = error as RateLimitError;
    expect(rateLimit.status).toBe(429);
    expect(rateLimit.code).toBe("rate_limit_exceeded");
    expect(rateLimit.headers.get("retry-after")).toBe("7");
    expect(rateLimit.requestID).toBe("req_fake_1");
    expect(requests).toHaveLength(1);
  });

  it("passes on a failure of connection, without trying again", async () => {
    const { client, requests } = setup([
      { kind: "network-error", code: "ECONNREFUSED" },
      sseAnswer(["must not be requested"]),
    ]);

    const error = await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );

    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).not.toBeInstanceOf(APIConnectionTimeoutError);
    expect(requests).toHaveLength(1);
  });

  it("gives a 401 whose summary does not show the key that the provider quoted", async () => {
    const masked = fakeMaskedOpenAiKey();
    const { client } = setup([
      {
        kind: "json",
        status: 401,
        body: apiErrorBody(
          `Incorrect API key provided: ${masked}. The key sent was ${KEY}.`,
          "invalid_api_key",
        ),
      },
    ]);

    const error = await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );

    expect(error).toBeInstanceOf(AuthenticationError);
    // The message of the SDK repeats the body: this is why it is summarized.
    expect((error as Error).message).toContain(KEY);
    const summary = summarizeError(error, createRedactor([KEY]));
    const written = JSON.stringify(summary);
    expect(summary.status).toBe(401);
    expect(summary.code).toBe("invalid_api_key");
    expect(written).not.toContain(KEY);
    expect(written).not.toContain(masked);
  });
});

describe("the key and the client object", () => {
  it("cannot be reached from the client that is returned", async () => {
    const { client } = setup([sseAnswer(["ok"])]);
    await client.streamText({ instructions: INSTRUCTIONS, input: HISTORY });

    const views = [
      inspect(client, { depth: 10, showHidden: true, getters: true }),
      JSON.stringify(client),
      Object.prototype.toString.call(client),
      Object.keys(client).join(","),
      Object.getOwnPropertyNames(client).join(","),
      // The source text of each method.
      ...Object.values(client).map((member: unknown) =>
        typeof member === "function"
          ? Function.prototype.toString.call(member)
          : inspect(member),
      ),
    ];

    for (const view of views) {
      expect(view).not.toContain(KEY);
      expect(view).not.toContain("apiKey");
    }
    expect(Object.keys(client).sort()).toEqual([
      "generateStructured",
      "streamText",
    ]);
    expect(Object.isFrozen(client)).toBe(true);
  });
});

describe("silence and isolation from the environment", () => {
  const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

  function spyOnOutput() {
    const spies = [
      ...CONSOLE_METHODS.map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
      ),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];
    return {
      calls: () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
      restore: () => spies.forEach((spy) => spy.mockRestore()),
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function exerciseSuccessAndErrors(): Promise<
    ReturnType<typeof setup>["requests"]
  > {
    const { client, requests } = setup([
      sseAnswer(["a", "b"]),
      { kind: "json", body: fakeResponseBody({ text: VERDICT_JSON }) },
      {
        kind: "json",
        status: 401,
        body: apiErrorBody(`Incorrect API key: ${KEY}`, "invalid_api_key"),
      },
      { kind: "json", body: fakeResponseBody({ text: "not json" }) },
      { kind: "sse", events: [textDelta("cut")] },
      { kind: "sse", events: [{ event: "broken", data: "x" }] },
    ]);
    await client.streamText({ instructions: INSTRUCTIONS, input: HISTORY });
    await structured(client);
    await rejectionOf(structured(client));
    await rejectionOf(structured(client));
    await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );
    await rejectionOf(
      client.streamText({ instructions: INSTRUCTIONS, input: HISTORY }),
    );
    return requests;
  }

  it("writes nothing to the console, on success or on error", async () => {
    const output = spyOnOutput();
    let calls: number;
    try {
      await exerciseSuccessAndErrors();
      calls = output.calls();
    } finally {
      output.restore();
    }

    expect(calls).toBe(0);
  });

  it("ignores the variables that the SDK would read by itself", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:9/elsewhere");
    vi.stubEnv("OPENAI_LOG", "debug");
    vi.stubEnv("OPENAI_ORG_ID", "org-from-environment");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj_from_environment");
    vi.stubEnv("OPENAI_API_KEY", fakeOpenAiKey("B"));
    const output = spyOnOutput();
    let calls: number;
    let requests: ReturnType<typeof setup>["requests"];
    try {
      requests = await exerciseSuccessAndErrors();
      calls = output.calls();
    } finally {
      output.restore();
    }

    expect(calls).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(6);
    for (const request of requests) {
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.headers).not.toHaveProperty("openai-organization");
      expect(request.headers).not.toHaveProperty("openai-project");
      expect(JSON.stringify(request.headers)).not.toContain("environment");
    }
  });
});
