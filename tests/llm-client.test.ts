// The real SDK with a fake `fetch`: no request ever leaves the process, and
// the key is a fake one built at runtime.
import { APIError } from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClientConfig,
  type LlmMessage,
} from "../src/llm/client.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  FAKE_RETURNED_MODEL,
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
      // The SDK refuses an invalid output while it reads the answer, before
      // handing it over: only then is the model that answered not known.
      expect((error as LlmResponseError).model).toBe(
        kind === "invalid_output" ? undefined : FAKE_RETURNED_MODEL,
      );
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
