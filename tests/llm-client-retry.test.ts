// The retry inside the real client (src/llm/client.ts), with the real SDK and
// a fake `fetch`: no network, a fake key. The wait is injected, so no test
// waits for real, except the one about the timeout of each try.
import { APIConnectionError, APIConnectionTimeoutError } from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  APIError,
  APIUserAbortError,
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClientConfig,
} from "../src/llm/client.js";
import type { RetryEvent } from "../src/llm/retry.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  apiErrorBody,
  createFakeOpenAiFetch,
  fakeResponseBody,
  sseAnswer,
  textDelta,
  type FakeFetchStep,
} from "./helpers/fake-openai-fetch.js";

const CONFIG: LlmClientConfig = {
  openaiApiKey: fakeOpenAiKey(),
  openaiModel: "configured-model",
  openaiReasoningEffort: "low",
  requestTimeoutMs: 5_000,
  retryMaxAttempts: 3,
  retryBaseDelayMs: 1_000,
};
const REQUEST = {
  instructions: "Assembled context.",
  input: [{ role: "user" as const, content: "question" }],
};
const SCHEMA = z.object({ ok: z.boolean() });

const unavailable: FakeFetchStep = {
  kind: "json",
  status: 503,
  body: apiErrorBody("Overloaded.", "server_error", "server_error"),
};
const structuredOk: FakeFetchStep = {
  kind: "json",
  body: fakeResponseBody({ text: JSON.stringify({ ok: true }) }),
};

function setup(
  script: readonly FakeFetchStep[],
  config: Partial<LlmClientConfig> = {},
) {
  const fake = createFakeOpenAiFetch(script);
  const waits: number[] = [];
  const events: RetryEvent[] = [];
  const client = createOpenAiLlmClient(
    { ...CONFIG, ...config },
    {
      fetch: fake.fetch,
      retry: {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        random: () => 0,
      },
    },
  );
  const onRetry = (event: RetryEvent): void => {
    events.push(event);
  };
  return { fake, waits, events, client, onRetry };
}

const calls = {
  streamText: (
    client: ReturnType<typeof setup>["client"],
    onRetry: (event: RetryEvent) => void,
    extra: { signal?: AbortSignal; onChunk?: (chunk: string) => void } = {},
  ) => client.streamText({ ...REQUEST, onRetry, ...extra }),
  generateStructured: (
    client: ReturnType<typeof setup>["client"],
    onRetry: (event: RetryEvent) => void,
    extra: { signal?: AbortSignal } = {},
  ) =>
    client.generateStructured({
      ...REQUEST,
      schema: SCHEMA,
      schemaName: "probe",
      onRetry,
      ...extra,
    }),
};

describe("transient failures, in both kinds of call", () => {
  it("streamText: [503, 503, success] makes three requests and two notices", async () => {
    const { fake, waits, events, client, onRetry } = setup([
      unavailable,
      unavailable,
      sseAnswer(["a", "b"]),
    ]);

    const result = await calls.streamText(client, onRetry);

    expect(result.text).toBe("ab");
    expect(fake.requests).toHaveLength(3);
    expect(events.map((e) => [e.retry, e.maxRetries])).toEqual([
      [1, 3],
      [2, 3],
    ]);
    expect(events[0]?.cause).toEqual({
      kind: "transient",
      reason: "http_status",
      status: 503,
    });
    expect(waits).toEqual([1000, 2000]);
  });

  it("generateStructured: [503, 503, success] makes three requests and two notices", async () => {
    const { fake, events, client, onRetry } = setup([
      unavailable,
      unavailable,
      structuredOk,
    ]);

    const result = await calls.generateStructured(client, onRetry);

    expect(result.value).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(3);
    expect(events).toHaveLength(2);
  });

  it("repeats a refused connection until the tries run out", async () => {
    const refused: FakeFetchStep = {
      kind: "network-error",
      code: "ECONNREFUSED",
    };
    const { fake, events, client, onRetry } = setup([
      refused,
      refused,
      refused,
      refused,
    ]);

    const error = await calls
      .streamText(client, onRetry)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(APIConnectionError);
    expect(fake.requests).toHaveLength(4);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.cause.kind === "transient")).toBe(true);
  });

  it("makes one request only with zero retries", async () => {
    const { fake, events, client, onRetry } = setup([unavailable], {
      retryMaxAttempts: 0,
    });

    const error = await calls
      .streamText(client, onRetry)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(APIError);
    expect(fake.requests).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("gives up with the original error, which keeps its status", async () => {
    const { client, onRetry } = setup([
      unavailable,
      unavailable,
      unavailable,
      unavailable,
    ]);

    const error = await calls
      .streamText(client, onRetry)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(503);
  });
});

describe("rate limit", () => {
  it("waits for retry-after-ms and tries again", async () => {
    const { fake, waits, events, client, onRetry } = setup([
      {
        kind: "json",
        status: 429,
        body: apiErrorBody("Slow down.", "rate_limit_exceeded", "requests"),
        headers: { "retry-after-ms": "2500" },
      },
      sseAnswer(["ok"]),
    ]);

    const result = await calls.streamText(client, onRetry);

    expect(result.text).toBe("ok");
    expect(waits).toEqual([2500]);
    expect(events[0]?.cause.kind).toBe("rate_limit");
    expect(fake.requests).toHaveLength(2);
  });

  it("does not retry a 429 for lack of credit", async () => {
    const { fake, events, client, onRetry } = setup([
      {
        kind: "json",
        status: 429,
        body: apiErrorBody(
          "Quota.",
          "insufficient_quota",
          "insufficient_quota",
        ),
      },
    ]);

    await expect(calls.streamText(client, onRetry)).rejects.toBeInstanceOf(
      APIError,
    );

    expect(fake.requests).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("fails at once when the provider asks for more than 30 s", async () => {
    const { fake, waits, events, client, onRetry } = setup([
      {
        kind: "json",
        status: 429,
        body: apiErrorBody("Slow down.", "rate_limit_exceeded", "requests"),
        headers: { "retry-after": "60" },
      },
    ]);

    await expect(calls.streamText(client, onRetry)).rejects.toBeInstanceOf(
      APIError,
    );

    expect(fake.requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("fatal failures", () => {
  it("does not retry a 401", async () => {
    const { fake, events, client, onRetry } = setup([
      {
        kind: "json",
        status: 401,
        body: apiErrorBody("Bad key.", "invalid_api_key"),
      },
    ]);

    await expect(
      calls.generateStructured(client, onRetry),
    ).rejects.toBeInstanceOf(APIError);

    expect(fake.requests).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("does not retry an answer that is final (refusal, empty)", async () => {
    const { fake, client, onRetry } = setup([
      {
        kind: "json",
        body: fakeResponseBody({ refusal: "No." }),
      },
    ]);

    const error = await calls
      .generateStructured(client, onRetry)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmResponseError);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("a stream that is cut in the middle", () => {
  it("starts again from zero, and the final text is only that of the second try", async () => {
    const chunks: string[] = [];
    const { fake, events, client, onRetry } = setup([
      { kind: "sse", events: [textDelta("par"), textDelta("tial")] },
      sseAnswer(["whole ", "answer"]),
    ]);

    const result = await calls.streamText(client, onRetry, {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe("whole answer");
    expect(result.chunks).toBe(2);
    expect(chunks).toEqual(["par", "tial", "whole ", "answer"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.cause).toEqual({
      kind: "transient",
      reason: "interrupted",
    });
    expect(fake.requests).toHaveLength(2);
  });
});

describe("timeout", () => {
  it("is counted for each try, not for the whole call", async () => {
    const { fake, events, client, onRetry } = setup(
      [{ kind: "no-response" }, { kind: "no-response" }, sseAnswer(["late"])],
      { requestTimeoutMs: 40, retryMaxAttempts: 2 },
    );

    const result = await calls.streamText(client, onRetry);

    expect(result.text).toBe("late");
    expect(fake.requests).toHaveLength(3);
    expect(events.map((e) => e.cause)).toEqual([
      { kind: "transient", reason: "timeout" },
      { kind: "transient", reason: "timeout" },
    ]);
  });

  it("gives up with the timeout error when every try times out", async () => {
    const { fake, client, onRetry } = setup(
      [{ kind: "no-response" }, { kind: "no-response" }],
      { requestTimeoutMs: 30, retryMaxAttempts: 1 },
    );

    const error = await calls
      .streamText(client, onRetry)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(APIConnectionTimeoutError);
    expect(fake.requests).toHaveLength(2);
  });
});

describe("cancellation", () => {
  it("while waiting for a new try: abort error, and no new request", async () => {
    const controller = new AbortController();
    const fake = createFakeOpenAiFetch([unavailable, sseAnswer(["never"])]);
    const client = createOpenAiLlmClient(CONFIG, {
      fetch: fake.fetch,
      retry: {
        // The real wait: it must end by itself when the caller aborts.
        random: () => 0,
      },
    });
    const events: RetryEvent[] = [];

    const outcome = client
      .streamText({
        ...REQUEST,
        signal: controller.signal,
        onRetry: (event) => {
          events.push(event);
          // Aborts while the (one second long) wait runs.
          setTimeout(() => controller.abort(), 5);
        },
      })
      .catch((e: unknown) => e);
    const started = Date.now();
    const error = await outcome;

    expect(error).toBeInstanceOf(APIUserAbortError);
    expect(Date.now() - started).toBeLessThan(900);
    expect(fake.requests).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("before the first try: abort error, and no request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fake, client, onRetry } = setup([sseAnswer(["never"])]);

    await expect(
      calls.generateStructured(client, onRetry, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(APIUserAbortError);

    expect(fake.requests).toEqual([]);
  });
});

describe("what the notice of the caller throws", () => {
  it("ends the call, and is not retried nor swallowed", async () => {
    const { fake, client } = setup([unavailable, sseAnswer(["x"])]);
    const boom = new Error("notice failed");

    const error = await client
      .streamText({
        ...REQUEST,
        onRetry: () => {
          throw boom;
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBe(boom);
    expect(fake.requests).toHaveLength(1);
  });
});
