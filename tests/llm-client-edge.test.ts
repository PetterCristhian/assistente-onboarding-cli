// Edge cases of the OpenAI client, with the real SDK and a fake `fetch`: odd
// streams, callbacks that throw, cancellation at every moment, timers,
// schemas, and every place where the key or the model output could show up.
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClient,
  type LlmClientConfig,
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

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = fakeOpenAiKey();
const CONFIG: LlmClientConfig = {
  openaiApiKey: KEY,
  openaiModel: "configured-model",
  openaiReasoningEffort: "low",
  requestTimeoutMs: 5_000,
};
const REQUEST = {
  instructions: "Assembled context.",
  input: [{ role: "user" as const, content: "question" }],
};
const TEST_TIMEOUT_MS = 5_000;
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("streamText: odd streams", () => {
  // The final event ends the reading: the pieces that come after it are not
  // read, and the answer is the text that the final event holds.
  it("ignores the pieces that come after a final event that comes first", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [finalEvent({ text: "ab" }), textDelta("a"), textDelta("b")],
      },
    ]);
    const received: string[] = [];

    const result = await client.streamText({
      ...REQUEST,
      onChunk: (chunk) => received.push(chunk),
    });

    expect(received).toEqual(["ab"]);
    expect(result.text).toBe("ab");
    expect(result.chunks).toBe(1);
    expect(result.model).toBe(FAKE_RETURNED_MODEL);
  });

  it("counts empty pieces without changing the text", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [
          textDelta(""),
          textDelta("x"),
          textDelta(""),
          finalEvent({ text: "x" }),
        ],
      },
    ]);
    const received: string[] = [];

    const result = await client.streamText({
      ...REQUEST,
      onChunk: (chunk) => received.push(chunk),
    });

    expect(result.text).toBe("x");
    expect(result.text).toBe(received.join(""));
    expect(result.chunks).toBe(received.length);
  });

  it("reports an answer made only of empty pieces as empty", async () => {
    const { client } = setup([
      { kind: "sse", events: [textDelta(""), finalEvent({ text: "" })] },
    ]);

    await expect(client.streamText(REQUEST)).rejects.toMatchObject({
      name: "LlmResponseError",
      kind: "empty",
    });
  });

  it("reports a refusal that arrives by the stream", async () => {
    const refusal = "I cannot help with that secret thing.";
    const { client } = setup([
      {
        kind: "sse",
        events: [
          {
            event: "response.refusal.delta",
            data: { type: "response.refusal.delta", delta: refusal },
          },
          finalEvent({ refusal }),
        ],
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
    expect(error).toMatchObject({
      kind: "refusal",
      model: FAKE_RETURNED_MODEL,
    });
    // The text of the refusal is neither delivered nor quoted.
    expect(received).toEqual([]);
    expect(inspect(error, { depth: 10 })).not.toContain("secret thing");
  });

  it.each(["failed", "incomplete"] as const)(
    "a %s answer wins over the text already received, which is not returned",
    async (status) => {
      const { client } = setup([
        {
          kind: "sse",
          events: [
            textDelta("partial text"),
            finalEvent({
              status,
              errorCode: "server_error",
              incompleteReason: "max_output_tokens",
            }),
          ],
        },
      ]);

      const error = await rejectionOf(client.streamText(REQUEST));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: status });
      expect(inspect(error, { depth: 10 })).not.toContain("partial text");
    },
  );

  it("puts in the message only a short identifier of the provider, never free text", async () => {
    const hostile = `quota of ${KEY} exceeded\u001b[31m`;
    const { client } = setup([
      {
        kind: "sse",
        events: [finalEvent({ status: "failed", errorCode: hostile })],
      },
      {
        kind: "sse",
        events: [
          finalEvent({ status: "incomplete", incompleteReason: hostile }),
        ],
      },
      {
        kind: "sse",
        events: [
          finalEvent({
            status: "incomplete",
            incompleteReason: "x".repeat(41),
          }),
        ],
      },
    ]);

    for (let call = 0; call < 3; call += 1) {
      const error = (await rejectionOf(client.streamText(REQUEST))) as Error;
      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("\u001b");
      expect(error.message).not.toContain("xxxx");
      expect(error.message).not.toContain("(");
    }
  });

  it("passes on what a callback throws, calls it no more and makes no other request", async () => {
    const { client, requests } = setup([
      sseAnswer(["a", "b", "c"]),
      sseAnswer(["must not be requested"]),
    ]);
    let calls = 0;
    const thrown = new RangeError("callback blew up");

    const error = await rejectionOf(
      client.streamText({
        ...REQUEST,
        onChunk: () => {
          calls += 1;
          throw thrown;
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(error).toBe(thrown);
    expect(calls).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("passes on the error event of the stream, whose summary hides a quoted key", async () => {
    const { client } = setup([
      {
        kind: "sse",
        events: [
          textDelta("a"),
          errorEvent("server_error", `Failure for ${KEY}.`),
        ],
      },
    ]);

    const error = await rejectionOf(client.streamText(REQUEST));

    expect(error).toBeInstanceOf(APIError);
    const summary = summarizeError(error, createRedactor([KEY]));
    expect(summary.code).toBe("server_error");
    expect(JSON.stringify(summary)).not.toContain(KEY);
  });

  it("treats a JSON answer to a streaming request as an interrupted stream", async () => {
    const { client } = setup([
      { kind: "json", body: fakeResponseBody({ text: "not a stream" }) },
    ]);

    await expect(client.streamText(REQUEST)).rejects.toMatchObject({
      name: "LlmResponseError",
      kind: "interrupted",
    });
  });
});

describe("cancellation at every moment", () => {
  it("after the answer: nothing happens, and no rejection is left unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { client } = setup([sseAnswer(["a", "b"]), jsonAnswer(VERDICT)]);
      const controller = new AbortController();
      const received: string[] = [];

      const text = await client.streamText({
        ...REQUEST,
        signal: controller.signal,
        onChunk: (chunk) => received.push(chunk),
      });
      const object = await structured(client, controller.signal);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(text.text).toBe("ab");
      expect(object.value).toEqual(VERDICT);
      expect(received).toEqual(["a", "b"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it(
    "before the first chunk, while the server has not answered",
    async () => {
      const { client, requests } = setup([
        { kind: "no-response" },
        { kind: "no-response" },
      ]);
      const controller = new AbortController();
      const received: string[] = [];

      const text = rejectionOf(
        client.streamText({
          ...REQUEST,
          signal: controller.signal,
          onChunk: (chunk) => received.push(chunk),
        }),
      );
      const object = rejectionOf(structured(client, controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();

      expect(await text).toBeInstanceOf(APIUserAbortError);
      expect(await object).toBeInstanceOf(APIUserAbortError);
      expect(await text).not.toBeInstanceOf(APIConnectionTimeoutError);
      expect(received).toEqual([]);
      expect(requests).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "of one call leaves another call of the same client alone",
    async () => {
      const { client } = setup([
        { kind: "sse", events: [textDelta("stuck")], hang: true },
        sseAnswer(["free ", "to ", "finish"]),
      ]);
      const controller = new AbortController();

      const cancelled = rejectionOf(
        client.streamText({ ...REQUEST, signal: controller.signal }),
      );
      const free = client.streamText(REQUEST);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();

      expect(await cancelled).toBeInstanceOf(APIUserAbortError);
      expect((await free).text).toBe("free to finish");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "even when the transport does not react, in a stream that keeps delivering",
    async () => {
      const { client } = setup([
        {
          kind: "sse",
          events: Array.from({ length: 200 }, (_, index) =>
            textDelta(`${index} `),
          ),
          ignoreAbort: true,
        },
      ]);
      const controller = new AbortController();
      const received: string[] = [];

      const error = await rejectionOf(
        client.streamText({
          ...REQUEST,
          signal: controller.signal,
          onChunk: (chunk) => {
            received.push(chunk);
            if (received.length === 5) {
              controller.abort();
            }
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(error).toBeInstanceOf(APIUserAbortError);
      expect(received).toHaveLength(5);
    },
    TEST_TIMEOUT_MS,
  );

  it("adds no listener to the signal of the caller, over many calls", async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
      const calls = 60;
      const { client } = setup(
        Array.from({ length: calls }, (_, index) =>
          index % 3 === 0
            ? jsonAnswer(VERDICT)
            : index % 3 === 1
              ? sseAnswer(["a", "b"])
              : ({
                  kind: "json",
                  status: 500,
                  body: apiErrorBody("Failure.", "server_error"),
                } satisfies FakeFetchStep),
        ),
      );
      const controller = new AbortController();

      for (let index = 0; index < calls; index += 1) {
        const call =
          index % 3 === 0
            ? structured(client, controller.signal)
            : client.streamText({ ...REQUEST, signal: controller.signal });
        await call.catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(
        warnings.filter(
          (warning) => warning.name === "MaxListenersExceededWarning",
        ),
      ).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

describe("timers of the total deadline", () => {
  it("are cleared after every kind of ending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client } = setup([
      // Each of these ends without any real timer of the fake `fetch`.
      jsonAnswer(VERDICT),
      { kind: "json", body: fakeResponseBody({ text: "not json" }) },
      { kind: "json", body: fakeResponseBody({ refusal: "no" }) },
      {
        kind: "json",
        status: 429,
        body: apiErrorBody("Slow down.", "rate_limit_exceeded"),
      },
      { kind: "network-error", code: "ECONNRESET" },
    ]);

    expect((await structured(client)).value).toEqual(VERDICT);
    for (let call = 0; call < 4; call += 1) {
      await rejectionOf(structured(client));
    }
    await rejectionOf(structured(client, AbortSignal.abort()));
    await rejectionOf(client.streamText({ instructions: "x", input: [] }));

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fire at once with a deadline longer than a timer accepts", async () => {
    const { client } = setup([sseAnswer(["a", "b"]), jsonAnswer(VERDICT)], {
      ...CONFIG,
      requestTimeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect((await client.streamText(REQUEST)).text).toBe("ab");
    expect((await structured(client)).value).toEqual(VERDICT);
  });

  it("gives the same timeout error to a structured call whose transport ignores the cancellation", async () => {
    const hangingFetch = (): Promise<Response> =>
      new Promise<Response>(() => undefined);
    const client = createOpenAiLlmClient(
      { ...CONFIG, requestTimeoutMs: 60 },
      { fetch: hangingFetch },
    );

    const startedAt = performance.now();
    const error = await rejectionOf(structured(client));

    expect(error).toBeInstanceOf(APIConnectionTimeoutError);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  // A pending timer of ten minutes would keep the process alive: the child
  // ends by itself, long before that, or the test fails by timeout.
  it("lets the process end right after the calls, with a deadline of ten minutes", () => {
    const startedAt = performance.now();
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/helpers/llm-client-exit-probe.ts"],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(
      "text:ok structured:ok error:InternalServerError aborted:APIUserAbortError",
    );
    expect(result.status).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(30_000);
  }, 40_000);
});

describe("generateStructured: schemas and outputs", () => {
  it("accepts enums, nested objects, arrays, nullable fields and unions inside an object", async () => {
    const schema = z.object({
      verdict: z.enum(["approved", "rejected"]),
      note: z.string().nullable(),
      score: z.union([z.number(), z.string()]),
      details: z.object({
        policies: z.array(z.object({ id: z.string(), ok: z.boolean() })),
        attempts: z.number().int(),
      }),
    });
    const value = {
      verdict: "rejected" as const,
      note: null,
      score: 3,
      details: { policies: [{ id: "P1", ok: false }], attempts: 2 },
    };
    const { client, requests } = setup([jsonAnswer(value)]);

    const result = await client.generateStructured({
      ...REQUEST,
      schema,
      schemaName: "review",
    });

    expect(result.value).toEqual(value);
    const body = requests[0]?.body as {
      text: { format: { strict: boolean; schema: Record<string, unknown> } };
    };
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["verdict", "note", "score", "details"],
    });
  });

  // The strict format of the provider has no optional field. Whoever writes
  // the schema of the self-review or of the judge finds out here, without a
  // request, and not in front of the real API.
  it.each([
    [
      "an optional field",
      z.object({ a: z.string(), b: z.string().optional() }),
    ],
    ["an array at the root", z.array(z.string())],
    ["a text at the root", z.string()],
    ["a record", z.record(z.string(), z.number())],
    [
      "a transformation",
      z.object({ a: z.string().transform((s) => s.length) }),
    ],
  ])("refuses %s before making any request", async (_label, schema) => {
    const { client, requests } = setup([jsonAnswer({})]);

    const error = await rejectionOf(
      client.generateStructured({ ...REQUEST, schema, schemaName: "x" }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LlmResponseError);
    expect(requests).toHaveLength(0);
  });

  it("returns what the schema produces: defaults applied and unknown keys dropped", async () => {
    const schema = z.object({ a: z.string(), b: z.string().default("filled") });
    const { client } = setup([jsonAnswer({ a: "x", extra: "dropped" })]);

    const result = await client.generateStructured({
      ...REQUEST,
      schema,
      schemaName: "x",
    });

    expect(result.value).toEqual({ a: "x", b: "filled" });
  });

  const MODEL_SECRET = "MODEL-OUTPUT-MARKER";
  it.each([
    ["truncated JSON", `{"approved": true, "reason": "${MODEL_SECRET} ${KEY}`],
    ["an empty text", ""],
    [
      "text around the JSON",
      `Sure! ${MODEL_SECRET} {"approved":true,"reason":"x"}`,
    ],
    ["a wrong type", JSON.stringify({ approved: MODEL_SECRET, reason: KEY })],
    ["a missing field", JSON.stringify({ approved: true })],
    [
      "a key that carries text",
      JSON.stringify({ [`${MODEL_SECRET} ${KEY}`]: 1 }),
    ],
    ["null", "null"],
    ["an array", JSON.stringify([MODEL_SECRET])],
  ])(
    "reports %s as invalid output, with nothing of the output in the error",
    async (_label, text) => {
      const { client } = setup([
        { kind: "json", body: fakeResponseBody({ text }) },
      ]);

      const error = await rejectionOf(structured(client));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: "invalid_output" });
      const views = [
        (error as Error).message,
        (error as Error).stack ?? "",
        String(error),
        JSON.stringify(error),
        inspect(error, { depth: 20, showHidden: true, getters: true }),
      ];
      for (const view of views) {
        expect(view).not.toContain(MODEL_SECRET);
        expect(view).not.toContain(KEY);
      }
      expect((error as Error).cause).toBeUndefined();
    },
  );

  it("names at most five refused fields, and only the ones that look like a field name", async () => {
    const schema = z.object({
      one: z.string(),
      two: z.string(),
      three: z.string(),
      four: z.string(),
      five: z.string(),
      six: z.string(),
      "odd name (with text)": z.string(),
    });
    const { client } = setup([jsonAnswer({})]);

    const error = (await rejectionOf(
      client.generateStructured({ ...REQUEST, schema, schemaName: "x" }),
    )) as Error;

    expect(error).toBeInstanceOf(LlmResponseError);
    expect(error.message).toContain("(campos: one, two, three, four, five).");
    expect(error.message).not.toContain("six");
    expect(error.message).not.toContain("odd name");
  });

  it.each([
    [
      "incomplete",
      {
        status: "incomplete",
        incompleteReason: "max_output_tokens",
        text: '{"approved": tr',
      },
    ],
    ["failed", { status: "failed", errorCode: "server_error" }],
    ["empty", {}],
    ["refusal", { refusal: "No, and here is why: MODEL-OUTPUT-MARKER" }],
  ] as const)(
    "reports a %s structured answer by its kind, with the model that answered",
    async (kind, options) => {
      const { client } = setup([
        { kind: "json", body: fakeResponseBody(options) },
      ]);

      const error = await rejectionOf(structured(client));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind, model: FAKE_RETURNED_MODEL });
      expect(inspect(error, { depth: 10 })).not.toContain(MODEL_SECRET);
    },
  );
});

describe("the key in everything the client throws", () => {
  const redactor = createRedactor([KEY]);
  const masked = fakeMaskedOpenAiKey();

  // Every error that the client can throw when the provider behaves badly,
  // including a provider that quotes the key back.
  const failures: readonly [string, FakeFetchStep][] = [
    [
      "401 quoting the key",
      {
        kind: "json",
        status: 401,
        body: apiErrorBody(
          `Incorrect API key ${KEY} (${masked}).`,
          "invalid_api_key",
        ),
        headers: { "x-echo": KEY },
      },
    ],
    [
      "429",
      {
        kind: "json",
        status: 429,
        body: apiErrorBody(`Rate limit for ${KEY}.`, KEY, KEY),
        headers: { "x-request-id": KEY },
      },
    ],
    [
      "500 with a text body",
      { kind: "json", status: 500, body: `oops ${KEY}` },
    ],
    ["network failure", { kind: "network-error", code: "ECONNRESET" }],
    ["no answer", { kind: "no-response" }],
    ["stream cut short", { kind: "sse", events: [textDelta(KEY)] }],
    [
      "error event",
      { kind: "sse", events: [errorEvent("server_error", `bad ${KEY}`)] },
    ],
    [
      "failed answer",
      {
        kind: "sse",
        events: [finalEvent({ status: "failed", errorCode: KEY })],
      },
    ],
    ["refusal", { kind: "sse", events: [finalEvent({ refusal: KEY })] }],
    ["invalid output", { kind: "json", body: fakeResponseBody({ text: KEY }) }],
  ];

  it.each(failures)(
    "%s: the summary never shows the key, in either method",
    async (_label, step) => {
      const { client } = setup([step, step], {
        ...CONFIG,
        requestTimeoutMs: 80,
      });

      for (const call of [
        () => client.streamText(REQUEST),
        () => structured(client),
      ]) {
        const error = await rejectionOf(call());
        const written = JSON.stringify(summarizeError(error, redactor));
        expect(written).not.toContain(KEY);
        expect(written).not.toContain(masked);
        expect(written).not.toContain("Bearer");
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The errors of the SDK repeat what the provider wrote, so they may hold a
  // key that the provider quoted. They must never hold what was SENT: the
  // request, its headers or the client.
  it.each(failures.filter(([label]) => !label.includes("quoting")))(
    "%s: the error carries nothing of the request",
    async (_label, step) => {
      const clean = JSON.parse(
        JSON.stringify(step).replaceAll(KEY, "provider-text"),
      ) as FakeFetchStep;
      const { client } = setup([clean, clean], {
        ...CONFIG,
        requestTimeoutMs: 80,
      });

      for (const call of [
        () => client.streamText(REQUEST),
        () => structured(client),
      ]) {
        const error = (await rejectionOf(call())) as Error;
        const views = [
          error.message,
          error.stack ?? "",
          String(error),
          JSON.stringify(error) ?? "",
          inspect(error, { depth: 20, showHidden: true, getters: true }),
        ];
        for (const view of views) {
          expect(view).not.toContain(KEY);
          expect(view).not.toContain("Bearer");
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it("is not reachable from the client, its methods or their prototypes", () => {
    const { client } = setup([]);
    const reachable = new Set<unknown>();
    const visit = (value: unknown, depth: number): void => {
      if (
        depth > 6 ||
        value === null ||
        (typeof value !== "object" && typeof value !== "function") ||
        reachable.has(value)
      ) {
        return;
      }
      reachable.add(value);
      for (const name of Reflect.ownKeys(value)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
        if (descriptor !== undefined && "value" in descriptor) {
          expect(String(descriptor.value)).not.toContain(KEY);
          visit(descriptor.value, depth + 1);
        }
      }
      visit(Object.getPrototypeOf(value), depth + 1);
    };

    visit(client, 0);

    expect(reachable.size).toBeGreaterThan(2);
    expect(Object.getPrototypeOf(client)).toBe(Object.prototype);
    expect(JSON.stringify(client)).toBe("{}");
  });
});
