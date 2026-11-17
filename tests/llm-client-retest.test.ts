// Retest of the OpenAI client by the QA (ENG-48), after the two rounds of
// fixes: each finding checked again by itself, and attempts to break the rule
// of phase. The real SDK against an HTTP server of this very process, on
// 127.0.0.1 with the base URL injected, or with a fake `fetch`. Nothing
// leaves the machine, and the key is a fake one built at runtime.
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { inspect } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClient,
  type LlmClientConfig,
} from "../src/llm/client.js";
import { formatSmokeReport, runLlmSmoke } from "../src/llm/smoke.js";
import { createRedactor } from "../src/security/redact.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import { createFakeLlmClient } from "./helpers/fake-llm-client.js";
import {
  createFakeOpenAiFetch,
  fakeResponseBody,
  type FakeFetchStep,
  type SseEvent,
} from "./helpers/fake-openai-fetch.js";

const KEY = fakeOpenAiKey();
const OTHER_KEY = fakeOpenAiKey("D");
const MARKER = "RETEST-CONTENT-MARKER";
const TEST_TIMEOUT_MS = 15_000;
const DEADLINE_MS = 250;
const CONFIG: LlmClientConfig = {
  openaiApiKey: KEY,
  openaiModel: "configured-model",
  openaiReasoningEffort: "low",
  requestTimeoutMs: 10_000,
};
const REQUEST = {
  instructions: "Assembled context.",
  input: [{ role: "user" as const, content: "question" }],
};
const verdictSchema = z.object({ approved: z.boolean(), reason: z.string() });
const VERDICT = { approved: true, reason: "fine" };
const DATED_MODEL = "some-model-2026-10-01";

// --- A local server ------------------------------------------------------

interface Seen {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface ReplyContext {
  head: (status: number, headers: Record<string, string>) => void;
  write: (text: string) => void;
  end: (text?: string) => void;
  destroy: () => void;
  onClose: (listener: () => void) => void;
}

type Reply = (context: ReplyContext) => void;

interface LocalServer {
  readonly baseURL: string;
  readonly seen: Seen[];
  reply: (reply: Reply) => void;
  stop: () => Promise<void>;
}

async function startServer(): Promise<LocalServer> {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  let current: Reply = ({ head, end }) => {
    head(500, { "content-type": "application/json" });
    end("{}");
  };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (piece: string) => {
      body += piece;
    });
    request.on("end", () => {
      seen.push({ headers: request.headers, body });
      current({
        head: (status, headers) => {
          response.writeHead(status, headers);
          response.flushHeaders();
        },
        write: (text) => {
          if (!response.destroyed) {
            response.write(text);
          }
        },
        end: (text) => response.end(text),
        destroy: () => response.destroy(),
        onClose: (listener) => response.on("close", listener),
      });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    seen,
    reply: (reply) => {
      current = reply;
    },
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

let server: LocalServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.stop();
});

afterEach(() => {
  server.seen.length = 0;
  vi.unstubAllEnvs();
});

function wireClient(overrides: Partial<LlmClientConfig> = {}): LlmClient {
  return createOpenAiLlmClient(
    { ...CONFIG, ...overrides },
    { baseURL: server.baseURL },
  );
}

function fetchClient(script: readonly FakeFetchStep[]) {
  const fake = createFakeOpenAiFetch(script);
  return {
    client: createOpenAiLlmClient(CONFIG, { fetch: fake.fetch }),
    requests: fake.requests,
  };
}

const SSE_HEADERS = { "content-type": "text/event-stream" };
const JSON_HEADERS = { "content-type": "application/json" };

function sse(data: { type: string }): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function wireDelta(text: string): string {
  return sse({ type: "response.output_text.delta", delta: text } as {
    type: string;
  });
}

function wireCompleted(text: string): string {
  return sse({
    type: "response.completed",
    response: fakeResponseBody({ text }),
  } as { type: string });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

function structured(client: LlmClient, signal?: AbortSignal) {
  return client.generateStructured({
    ...REQUEST,
    schema: verdictSchema,
    schemaName: "verdict",
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Everything that an error shows when it is printed or serialized. */
function viewsOf(error: unknown): string {
  return [
    String(error),
    JSON.stringify(error) ?? "",
    inspect(error, { depth: 20, showHidden: true, getters: true }),
    error instanceof Error ? (error.stack ?? "") : "",
  ].join("\n");
}

function expectKind(error: unknown, kind: string): LlmResponseError {
  expect(error).toBeInstanceOf(LlmResponseError);
  const known = error as LlmResponseError;
  expect(known.kind).toBe(kind);
  expect(known).not.toBeInstanceOf(TypeError);
  expect(known.message).not.toContain("undefined");
  expect(viewsOf(known)).not.toContain(KEY);
  return known;
}

/** `cause` holds at most a name and a code, both short identifiers. */
function expectReducedCause(error: LlmResponseError): void {
  const cause = error.cause;
  if (cause === undefined) {
    return;
  }
  expect(cause).not.toBeInstanceOf(Error);
  expect(typeof cause).toBe("object");
  for (const [name, value] of Object.entries(cause as object)) {
    expect(["name", "code"]).toContain(name);
    expect(value).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/);
  }
}

// --- Payloads with phases -------------------------------------------------

type Phase = string | null | undefined;

function message(phase: Phase, ...texts: string[]): Record<string, unknown> {
  return {
    type: "message",
    id: "msg_x",
    role: "assistant",
    status: "completed",
    ...(phase === undefined ? {} : { phase }),
    content: texts.map((text) => ({
      type: "output_text",
      text,
      annotations: [],
      logprobs: [],
    })),
  };
}

const REASONING_ITEM = {
  type: "reasoning",
  id: "rs_x",
  summary: [{ type: "summary_text", text: "thinking" }],
  encrypted_content: null,
};

function bodyWith(
  output: readonly unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(fakeResponseBody() as Record<string, unknown>),
    output,
    ...extra,
  };
}

function jsonStep(body: unknown): FakeFetchStep {
  return { kind: "json", body };
}

function added(index: unknown, phase: Phase, type = "message"): SseEvent {
  const kind = "response.output_item.added";
  return {
    event: kind,
    data: {
      type: kind,
      ...(index === undefined ? {} : { output_index: index }),
      item: {
        type,
        id: "msg_x",
        role: "assistant",
        status: "in_progress",
        content: [],
        ...(phase === undefined ? {} : { phase }),
      },
    },
  };
}

function deltaAt(text: string, index?: unknown): SseEvent {
  const kind = "response.output_text.delta";
  return {
    event: kind,
    data: {
      type: kind,
      item_id: "msg_x",
      content_index: 0,
      ...(index === undefined ? {} : { output_index: index }),
      delta: text,
    },
  };
}

function completedWith(output: readonly unknown[]): SseEvent {
  const kind = "response.completed";
  return { event: kind, data: { type: kind, response: bodyWith(output) } };
}

async function streamOf(events: readonly SseEvent[]) {
  const { client } = fetchClient([{ kind: "sse", events }]);
  const delivered: string[] = [];
  const outcome = await client
    .streamText({ ...REQUEST, onChunk: (chunk) => delivered.push(chunk) })
    .then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
  return { ...outcome, delivered };
}

// --- B1 --------------------------------------------------------------------

describe("B1: OPENAI_CUSTOM_HEADERS, on the wire", () => {
  it.each([
    [
      "the usual spelling",
      [
        `Authorization: Bearer ${OTHER_KEY}`,
        `api-key: ${OTHER_KEY}`,
        `x-api-key: ${OTHER_KEY}`,
        "OpenAI-Organization: org-fromenv",
        "OpenAI-Project: proj_fromenv",
        "X-Extra: kept",
      ],
    ],
    [
      "other spellings of the same names",
      [
        `AUTHORIZATION : Bearer ${OTHER_KEY}`,
        `Api-Key:${OTHER_KEY}`,
        `X-API-KEY: ${OTHER_KEY}`,
        "openai-organization: org-fromenv",
        "OPENAI-PROJECT: proj_fromenv",
        "x-extra: kept",
      ],
    ],
  ])(
    "sends the credential of the configuration and nothing else: %s",
    async (_title, lines) => {
      vi.stubEnv("OPENAI_CUSTOM_HEADERS", lines.join("\n"));
      const client = wireClient();
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(wireDelta("ok") + wireCompleted("ok"));
      });
      await client.streamText(REQUEST);
      server.reply(({ head, end }) => {
        head(200, JSON_HEADERS);
        end(
          JSON.stringify(fakeResponseBody({ text: JSON.stringify(VERDICT) })),
        );
      });
      await structured(client);

      expect(server.seen).toHaveLength(2);
      for (const { headers } of server.seen) {
        expect(headers.authorization).toBe(`Bearer ${KEY}`);
        expect(headers).not.toHaveProperty("api-key");
        expect(headers).not.toHaveProperty("x-api-key");
        expect(headers).not.toHaveProperty("openai-organization");
        expect(headers).not.toHaveProperty("openai-project");
        expect(JSON.stringify(headers)).not.toContain(OTHER_KEY);
        expect(JSON.stringify(headers)).not.toContain("fromenv");
        // The documented limit (ADR 0002, decision 9).
        expect(headers["x-extra"]).toBe("kept");
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// --- B2 --------------------------------------------------------------------

describe("B2: a stream that breaks, on the wire", () => {
  it(
    "reports a destroyed socket as interrupted, with a reduced cause",
    async () => {
      server.reply(({ head, write, destroy }) => {
        head(200, SSE_HEADERS);
        write(wireDelta(MARKER));
        setTimeout(destroy, 30);
      });
      const delivered: string[] = [];
      const error = await rejectionOf(
        wireClient().streamText({
          ...REQUEST,
          onChunk: (chunk) => delivered.push(chunk),
        }),
      );

      const known = expectKind(error, "interrupted");
      expectReducedCause(known);
      expect(known.cause).toBeDefined();
      expect(delivered).toEqual([MARKER]);
      expect(viewsOf(known)).not.toContain(MARKER);
      expect(server.seen).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports an event that is not JSON as interrupted, without quoting it",
    async () => {
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(
          `${wireDelta("a")}event: response.output_text.delta\ndata: {"delta": ${MARKER}\n\n${wireCompleted("a")}`,
        );
      });
      const error = await rejectionOf(wireClient().streamText(REQUEST));

      const known = expectKind(error, "interrupted");
      expectReducedCause(known);
      expect(known.cause).toEqual({ name: "SyntaxError" });
      expect(viewsOf(known)).not.toContain(MARKER);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "passes the errors of the SDK and of the callback as they are",
    async () => {
      // An error of the API.
      server.reply(({ head, end }) => {
        head(500, JSON_HEADERS);
        end(JSON.stringify({ error: { message: "boom", type: "server" } }));
      });
      const api = await rejectionOf(wireClient().streamText(REQUEST));
      expect(api).toBeInstanceOf(APIError);
      expect((api as APIError).status).toBe(500);
      expect(api).not.toBeInstanceOf(LlmResponseError);

      // An error event inside the stream.
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(
          `event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: "boom", param: null })}\n\n`,
        );
      });
      const inStream = await rejectionOf(wireClient().streamText(REQUEST));
      expect(inStream).toBeInstanceOf(APIError);
      expect(inStream).not.toBeInstanceOf(LlmResponseError);

      // A cancellation in the middle.
      const controller = new AbortController();
      server.reply(({ head, write }) => {
        head(200, SSE_HEADERS);
        write(wireDelta("a"));
      });
      const aborted = await rejectionOf(
        wireClient().streamText({
          ...REQUEST,
          signal: controller.signal,
          onChunk: () => controller.abort(),
        }),
      );
      expect(aborted).toBeInstanceOf(APIUserAbortError);

      // The total deadline.
      const timedOut = await rejectionOf(
        wireClient({ requestTimeoutMs: DEADLINE_MS }).streamText(REQUEST),
      );
      expect(timedOut).toBeInstanceOf(APIConnectionTimeoutError);

      // What the callback throws, even with the look of a transport failure.
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(wireDelta("a") + wireCompleted("a"));
      });
      const thrown = Object.assign(new TypeError("terminated"), {
        code: "UND_ERR_SOCKET",
      });
      const fromCallback = await rejectionOf(
        wireClient().streamText({
          ...REQUEST,
          onChunk: () => {
            throw thrown;
          },
        }),
      );
      expect(fromCallback).toBe(thrown);
    },
    TEST_TIMEOUT_MS,
  );
});

// --- B3 --------------------------------------------------------------------

describe("B3: a structured answer that cannot be read, on the wire", () => {
  const truncated = JSON.stringify(
    fakeResponseBody({ text: JSON.stringify(VERDICT) }),
  ).slice(0, 80);

  it.each([
    ["an HTML page", "text/html", `<html><body>${MARKER}</body></html>`],
    ["an HTML page said to be JSON", "application/json", `<html>${MARKER}`],
    ["an empty body", "application/json", ""],
    ["a JSON cut short", "application/json", truncated],
    ["only white space", "application/json", " \n "],
  ])(
    "HTTP 200 with %s is interrupted",
    async (_title, contentType, body) => {
      server.reply(({ head, end }) => {
        head(200, { "content-type": contentType });
        end(body);
      });
      const error = await rejectionOf(structured(wireClient()));

      const known = expectKind(error, "interrupted");
      expectReducedCause(known);
      expect(viewsOf(known)).not.toContain(MARKER);
      expect(server.seen).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a socket destroyed in the middle of the body is interrupted",
    async () => {
      server.reply(({ head, write, destroy }) => {
        head(200, JSON_HEADERS);
        write(truncated);
        setTimeout(destroy, 30);
      });
      const error = await rejectionOf(structured(wireClient()));

      expectReducedCause(expectKind(error, "interrupted"));
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["not JSON", "approved: yes"],
    ["a JSON that is not an object", "[1, 2]"],
    ["outside the schema", JSON.stringify({ approved: "yes" })],
    ["JSON null", "null"],
  ])(
    "an output of the model that is %s is invalid_output",
    async (_t, text) => {
      const { client } = fetchClient([
        jsonStep(fakeResponseBody({ text, model: DATED_MODEL })),
      ]);
      const error = await rejectionOf(structured(client));

      const known = expectKind(error, "invalid_output");
      expect(known.model).toBe(DATED_MODEL);
      expect(known.cause).toBeUndefined();
    },
  );

  it("never quotes the output of the model in invalid_output", async () => {
    const { client } = fetchClient([
      jsonStep(
        fakeResponseBody({
          text: JSON.stringify({ approved: MARKER, [MARKER]: 1 }),
        }),
      ),
    ]);
    const error = await rejectionOf(structured(client));

    expect(viewsOf(expectKind(error, "invalid_output"))).not.toContain(MARKER);
  });
});

// --- B5 --------------------------------------------------------------------

describe("B5: an answer outside the contract is malformed", () => {
  it.each([
    ["an empty object", "{}"],
    ["null", "null"],
    ["a list", "[]"],
    ["a number", "7"],
    ["a text", '"text"'],
    ["true", "true"],
    ["a model that is a number", JSON.stringify(bodyWith([], { model: 7 }))],
    ["a blank model", JSON.stringify(bodyWith([], { model: "  " }))],
    ["an output that is a text", JSON.stringify(bodyWith([], { output: "x" }))],
    ["an item with no type", JSON.stringify(bodyWith([{ id: "x" }]))],
    ["an item that is null", JSON.stringify(bodyWith([null]))],
    [
      "a usage of texts",
      JSON.stringify(
        bodyWith([message(undefined, JSON.stringify(VERDICT))], {
          usage: { input_tokens: "1", output_tokens: "2", total_tokens: "3" },
        }),
      ),
    ],
    [
      "a message whose content is a text",
      JSON.stringify(
        bodyWith([{ type: "message", content: JSON.stringify(VERDICT) }]),
      ),
    ],
    [
      "a message whose phase is a number",
      JSON.stringify(
        bodyWith([
          { ...message(undefined, JSON.stringify(VERDICT)), phase: 1 },
        ]),
      ),
    ],
  ])("generateStructured: a body that is %s", async (_title, body) => {
    const { client } = fetchClient([
      { kind: "raw", contentType: "application/json", parts: [body] },
    ]);

    expectKind(await rejectionOf(structured(client)), "malformed");
  });

  it.each([
    ["absent", {}],
    ["a number", { delta: 7 }],
    ["null", { delta: null }],
    ["an object", { delta: { text: "x" } }],
    ["a list", { delta: ["x"] }],
  ])("streamText: a delta that is %s", async (_title, fields) => {
    const kind = "response.output_text.delta";
    const { error, delivered } = await streamOf([
      { event: kind, data: { type: kind, ...fields } },
      completedWith([message(undefined, "x")]),
    ]);

    expectKind(error, "malformed");
    expect(delivered).toEqual([]);
  });

  it.each([
    ["an empty response", { response: {} }],
    ["no response", {}],
    ["a null response", { response: null }],
    ["a response that is a text", { response: "done" }],
    ["a response that is a list", { response: [] }],
    ["a model that is a number", { response: bodyWith([], { model: 7 }) }],
    ["an empty model", { response: bodyWith([], { model: "" }) }],
    ["an output that is an object", { response: bodyWith([], { output: {} }) }],
  ])("streamText: a final event with %s", async (_title, fields) => {
    const kind = "response.completed";
    const { error, result } = await streamOf([
      deltaAt("text"),
      { event: kind, data: { type: kind, ...fields } },
    ]);

    expect(result).toBeUndefined();
    expectKind(error, "malformed");
  });

  it("streamText: events that are not objects are skipped, not a TypeError", async () => {
    const { client } = fetchClient([
      {
        kind: "raw",
        contentType: "text/event-stream",
        parts: [
          "data: null\n\n",
          "data: 7\n\n",
          'data: "text"\n\n',
          "data: []\n\n",
          'data: {"no_type": true}\n\n',
          ": a comment of the server\n\n",
          wireDelta("ok"),
          wireCompleted("ok"),
        ],
      },
    ]);

    const result = await client.streamText(REQUEST);

    expect(result.text).toBe("ok");
    expect(result.chunks).toBe(1);
  });

  it("accepts an answer as the provider plausibly writes it: structured", async () => {
    const { client } = fetchClient([
      jsonStep({
        id: "resp_1",
        object: "response",
        created_at: 1_790_000_000,
        completed_at: 1_790_000_002,
        status: "completed",
        background: false,
        billing: { payer: "developer" },
        error: null,
        incomplete_details: null,
        instructions: "x",
        max_output_tokens: null,
        model: DATED_MODEL,
        output: [
          REASONING_ITEM,
          { type: "some_future_item", payload: { deep: [1, { a: null }] } },
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: { type: "search", query: "x" },
          },
          message("commentary", "Let me check."),
          message("final_answer", JSON.stringify(VERDICT)),
        ],
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: "low", summary: null },
        service_tier: "default",
        store: false,
        temperature: 1,
        text: { format: { type: "json_schema", name: "verdict" } },
        tool_choice: "auto",
        tools: [],
        top_p: 1,
        truncation: "disabled",
        usage: {
          input_tokens: 30,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 50,
        },
        user: null,
        metadata: {},
        some_future_field: { anything: [1, 2, 3] },
      }),
    ]);

    const result = await structured(client);

    expect(result).toEqual({
      value: VERDICT,
      model: DATED_MODEL,
      usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
    });
  });

  it("accepts an answer as the provider plausibly writes it: streaming", async () => {
    const full = bodyWith(
      [
        REASONING_ITEM,
        message("commentary", "Let me check."),
        message("final_answer", "Hello, world"),
      ],
      {
        model: DATED_MODEL,
        usage: {
          input_tokens: 30,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 50,
        },
      },
    );
    const plain = (
      type: string,
      fields: Record<string, unknown>,
    ): SseEvent => ({
      event: type,
      data: { type, sequence_number: 1, ...fields },
    });
    const { result, delivered } = await streamOf([
      plain("response.created", {
        response: { ...full, status: "in_progress", output: [] },
      }),
      plain("response.in_progress", {
        response: { ...full, status: "in_progress", output: [] },
      }),
      added(0, undefined, "reasoning"),
      plain("response.output_item.done", {
        output_index: 0,
        item: REASONING_ITEM,
      }),
      added(1, "commentary"),
      plain("response.content_part.added", {
        output_index: 1,
        content_index: 0,
        part: { type: "output_text", text: "" },
      }),
      deltaAt("Let me ", 1),
      deltaAt("check.", 1),
      plain("response.output_text.done", {
        output_index: 1,
        text: "Let me check.",
      }),
      plain("response.output_item.done", {
        output_index: 1,
        item: message("commentary", "Let me check."),
      }),
      added(2, "final_answer"),
      deltaAt("Hello", 2),
      deltaAt(", world", 2),
      plain("response.output_text.done", {
        output_index: 2,
        text: "Hello, world",
      }),
      plain("response.some_future_event", { anything: 1 }),
      plain("response.completed", { response: full }),
    ]);

    expect(delivered).toEqual(["Hello", ", world"]);
    expect(result).toEqual({
      text: "Hello, world",
      model: DATED_MODEL,
      chunks: 2,
      usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
    });
  });

  it.each([
    ["no usage", { usage: undefined }],
    ["a null usage", { usage: null }],
    ["no status", { status: undefined }],
    ["a null status", { status: null }],
    [
      "no error nor incomplete_details",
      { error: undefined, incomplete_details: undefined },
    ],
  ])("accepts an answer with %s", async (_title, extra) => {
    const { client } = fetchClient([
      jsonStep(bodyWith([message(undefined, JSON.stringify(VERDICT))], extra)),
    ]);

    const result = await structured(client);

    expect(result.value).toEqual(VERDICT);
  });
});

// --- The rule of phase ------------------------------------------------------

describe("the rule of phase in generateStructured", () => {
  async function outcomeOf(
    output: readonly unknown[],
    extra: Record<string, unknown> = {},
  ) {
    const { client, requests } = fetchClient([
      jsonStep(bodyWith(output, extra)),
    ]);
    const outcome = await structured(client).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    expect(requests).toHaveLength(1);
    return outcome;
  }

  const good = JSON.stringify(VERDICT);
  const otherGood = JSON.stringify({ approved: false, reason: "second" });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["final_answer", "final_answer"],
  ])("reads a message whose phase is %s", async (_title, phase) => {
    const { result } = await outcomeOf([message(phase, good)]);

    expect(result?.value).toEqual(VERDICT);
  });

  it.each([
    ["commentary", "commentary"],
    ["unknown", "analysis"],
    ["an empty text", ""],
    ["another spelling", "Final_Answer"],
  ])("does not read a message whose phase is %s: empty", async (_t, phase) => {
    const { error } = await outcomeOf([message(phase, good)]);

    expect(expectKind(error, "empty").model).toBeDefined();
  });

  it("the first piece of the final answer decides, across messages and inside one", async () => {
    // A piece that is refused is never passed over for a later valid one.
    const acrossMessages = await outcomeOf([
      message("commentary", otherGood),
      message("final_answer", `{"approved": tru`),
      message("final_answer", good),
      message("final_answer", otherGood),
    ]);
    expect(acrossMessages.result).toBeUndefined();
    expect(
      expectKind(acrossMessages.error, "invalid_output").message,
    ).toContain("JSON");

    const insideOne = await outcomeOf([
      message(
        undefined,
        "",
        "not json",
        JSON.stringify({ approved: 1 }),
        good,
        otherGood,
      ),
    ]);
    expect(insideOne.result).toBeUndefined();
    expectKind(insideOne.error, "invalid_output");

    const outsideSchemaFirst = await outcomeOf([
      message(undefined, JSON.stringify({ approved: 1 }), good),
    ]);
    expect(outsideSchemaFirst.result).toBeUndefined();
    expect(
      expectKind(outsideSchemaFirst.error, "invalid_output").message,
    ).toContain("approved");

    // A valid commentary is still skipped, and of two valid pieces of the
    // final answer the first one is returned.
    const validFirst = await outcomeOf([
      message("commentary", otherGood),
      message("final_answer", good),
      message("final_answer", otherGood),
    ]);
    expect(validFirst.result?.value).toEqual(VERDICT);

    const validFirstInsideOne = await outcomeOf([
      message(undefined, good, otherGood, "not json"),
    ]);
    expect(validFirstInsideOne.result?.value).toEqual(VERDICT);
  });

  it("never joins the pieces: two halves of a JSON are not an answer", async () => {
    const half = Math.floor(good.length / 2);
    const { error } = await outcomeOf([
      message(undefined, good.slice(0, half), good.slice(half)),
    ]);

    expectKind(error, "invalid_output");
  });

  it("reports the first refused piece when none passes", async () => {
    const outside = await outcomeOf([
      message(undefined, JSON.stringify({ approved: 1 }), "not json"),
    ]);
    expect(expectKind(outside.error, "invalid_output").message).toContain(
      "approved",
    );

    const notJson = await outcomeOf([
      message(undefined, "not json", JSON.stringify({ approved: 1 })),
    ]);
    expect(expectKind(notJson.error, "invalid_output").message).toContain(
      "JSON",
    );
  });

  it("with a refusal and a text, reads the text; with only a refusal, refusal", async () => {
    const refusalPart = { type: "refusal", refusal: MARKER };
    const both = await outcomeOf([
      {
        ...message(undefined, good),
        content: [
          refusalPart,
          { type: "output_text", text: good, annotations: [] },
        ],
      },
    ]);
    expect(both.result?.value).toEqual(VERDICT);

    const only = await outcomeOf([
      { type: "message", role: "assistant", content: [refusalPart] },
    ]);
    const refusal = expectKind(only.error, "refusal");
    expect(viewsOf(refusal)).not.toContain(MARKER);

    // A refusal next to a commentary: no final answer, and a refusal.
    const withCommentary = await outcomeOf([
      message("commentary", good),
      { type: "message", role: "assistant", content: [refusalPart] },
    ]);
    expectKind(withCommentary.error, "refusal");
  });

  it.each([
    ["in_progress", "failed"],
    ["queued", "failed"],
    ["cancelled", "failed"],
    ["failed", "failed"],
    ["incomplete", "incomplete"],
    ["some_future_status", "failed"],
    ["", "failed"],
  ])(
    "does not read the output of a response whose status is %s: %s",
    async (status, kind) => {
      const { error, result } = await outcomeOf(
        [message("final_answer", good)],
        { status },
      );

      expect(result).toBeUndefined();
      expectKind(error, kind);
    },
  );
});

describe("the rule of phase in streamText", () => {
  const FINAL = [
    message("commentary", "C1C2"),
    message("final_answer", "A1A2"),
  ];

  it("drops the commentary when it is interleaved with the answer", async () => {
    const { result, delivered } = await streamOf([
      added(0, "commentary"),
      added(1, "final_answer"),
      deltaAt("C1", 0),
      deltaAt("A1", 1),
      deltaAt("C2", 0),
      deltaAt("A2", 1),
      completedWith(FINAL),
    ]);

    expect(delivered).toEqual(["A1", "A2"]);
    expect(result?.text).toBe("A1A2");
    expect(result?.chunks).toBe(2);
  });

  it.each([
    ["commentary", "commentary"],
    ["unknown", "analysis"],
    ["an empty text", ""],
  ])(
    "drops the pieces of a message whose phase is %s",
    async (_title, phase) => {
      const { result, delivered } = await streamOf([
        added(3, phase),
        deltaAt("C1", 3),
        added(4, null),
        deltaAt("A1", 4),
        completedWith(FINAL),
      ]);

      expect(delivered).toEqual(["A1"]);
      expect(result?.text).toBe("A1");
    },
  );

  it("joins the pieces of several answer messages, in order of arrival", async () => {
    const { result, delivered } = await streamOf([
      added(0, "final_answer"),
      added(1, "commentary"),
      added(2, undefined),
      deltaAt("A", 0),
      deltaAt("x", 1),
      deltaAt("B", 2),
      deltaAt("C", 0),
      completedWith(FINAL),
    ]);

    expect(delivered).toEqual(["A", "B", "C"]);
    expect(result?.text).toBe("ABC");
    expect(result?.chunks).toBe(3);
  });

  it("treats as answer the pieces of a message that was never announced", async () => {
    const { result, delivered } = await streamOf([
      added(0, "commentary"),
      deltaAt("C1", 0),
      deltaAt("A1", 5),
      completedWith(FINAL),
    ]);

    expect(delivered).toEqual(["A1"]);
    expect(result?.text).toBe("A1");
  });

  // The two documented limits (ADR 0002, decision 3): the filter needs the
  // announcement to come first and the piece to say where it belongs.
  it("documented limit: a piece with no output_index is treated as answer", async () => {
    const { delivered } = await streamOf([
      added(0, "commentary"),
      deltaAt("C1"),
      deltaAt("C2", "0"),
      completedWith(FINAL),
    ]);

    expect(delivered).toEqual(["C1", "C2"]);
  });

  it("documented limit: pieces that come before the announcement are delivered", async () => {
    const { delivered } = await streamOf([
      deltaAt("C1", 0),
      added(0, "commentary"),
      deltaAt("C2", 0),
      completedWith(FINAL),
    ]);

    expect(delivered).toEqual(["C1"]);
  });

  it("the reserve of the final event reads only the answer, as a single piece", async () => {
    const { result, delivered } = await streamOf([
      added(0, "commentary"),
      deltaAt("C1", 0),
      deltaAt("C2", 0),
      completedWith([
        message("commentary", "C1C2"),
        message("final_answer", "A1", "A2"),
        message("analysis", "zzz"),
        message(null, "A3"),
      ]),
    ]);

    expect(delivered).toEqual(["A1A2A3"]);
    expect(result?.text).toBe("A1A2A3");
    expect(result?.chunks).toBe(1);
  });

  it("only commentary, in the pieces and in the final event: empty, nothing delivered", async () => {
    const { error, delivered } = await streamOf([
      added(0, "commentary"),
      deltaAt("C1", 0),
      completedWith([message("commentary", "C1")]),
    ]);

    expectKind(error, "empty");
    expect(delivered).toEqual([]);
  });

  it("an announcement that is not a message, or with no usable index, hides nothing", async () => {
    const { delivered } = await streamOf([
      added(0, "commentary", "reasoning"),
      added(undefined, "commentary"),
      added("1", "commentary"),
      {
        event: "response.output_item.added",
        data: { type: "response.output_item.added", output_index: 2 },
      },
      {
        event: "response.output_item.added",
        data: {
          type: "response.output_item.added",
          output_index: 3,
          item: null,
        },
      },
      deltaAt("a", 0),
      deltaAt("b", 1),
      deltaAt("c", 2),
      deltaAt("d", 3),
      completedWith(FINAL),
    ]);

    expect(delivered).toEqual(["a", "b", "c", "d"]);
  });

  it("with the pieces of a text and a refusal in the final event, returns the text", async () => {
    const { result } = await streamOf([
      added(0, "final_answer"),
      deltaAt("A1", 0),
      completedWith([
        {
          type: "message",
          content: [
            { type: "refusal", refusal: "no" },
            { type: "output_text", text: "A1" },
          ],
        },
      ]),
    ]);

    expect(result?.text).toBe("A1");
  });
});

// --- Regressions, on the wire ----------------------------------------------

describe("regressions: the total deadline, on the wire", () => {
  const drip = (piece: () => string): Reply => {
    return ({ head, write, onClose }) => {
      head(200, SSE_HEADERS);
      const timer = setInterval(() => write(piece()), 40);
      onClose(() => clearInterval(timer));
    };
  };
  const cases: readonly (readonly [string, Reply])[] = [
    ["a server that says nothing", () => undefined],
    ["headers and then nothing", ({ head }) => head(200, SSE_HEADERS)],
    ["pieces of text that never stop", drip(() => wireDelta("x"))],
    ["comments that never stop", drip(() => ": keep-alive\n\n")],
    ["bytes of an event that never ends", drip(() => "da")],
  ];

  it.each(cases)(
    "streamText ends with the timeout error: %s",
    async (_title, reply) => {
      server.reply(reply);
      const startedAt = performance.now();
      const error = await rejectionOf(
        wireClient({ requestTimeoutMs: DEADLINE_MS }).streamText(REQUEST),
      );
      const elapsed = performance.now() - startedAt;

      expect(error).toBeInstanceOf(APIConnectionTimeoutError);
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000);
      expect(server.seen).toHaveLength(1);
      expect(viewsOf(error)).not.toContain(KEY);
    },
    TEST_TIMEOUT_MS,
  );

  const structuredCases: readonly (readonly [string, Reply])[] = [
    ["a server that says nothing", () => undefined],
    ["headers and then nothing", ({ head }) => head(200, JSON_HEADERS)],
    [
      "a body that drips",
      ({ head, write, onClose }) => {
        head(200, JSON_HEADERS);
        const timer = setInterval(() => write(" "), 40);
        onClose(() => clearInterval(timer));
      },
    ],
  ];

  it.each(structuredCases)(
    "generateStructured ends with the timeout error: %s",
    async (_title, reply) => {
      server.reply(reply);
      const startedAt = performance.now();
      const error = await rejectionOf(
        structured(wireClient({ requestTimeoutMs: DEADLINE_MS })),
      );
      const elapsed = performance.now() - startedAt;

      expect(error).toBeInstanceOf(APIConnectionTimeoutError);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000);
      expect(server.seen).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("regressions: cancellation, on the wire", () => {
  it(
    "before: no request leaves, in either method",
    async () => {
      const controller = new AbortController();
      controller.abort();
      const client = wireClient();

      const text = await rejectionOf(
        client.streamText({ ...REQUEST, signal: controller.signal }),
      );
      const object = await rejectionOf(structured(client, controller.signal));

      expect(text).toBeInstanceOf(APIUserAbortError);
      expect(object).toBeInstanceOf(APIUserAbortError);
      expect(server.seen).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "in the middle: the abort error, nothing delivered afterwards, the connection closed",
    async () => {
      let closed = false;
      server.reply(({ head, write, onClose }) => {
        head(200, SSE_HEADERS);
        const timer = setInterval(() => write(wireDelta("x")), 20);
        onClose(() => {
          closed = true;
          clearInterval(timer);
        });
      });
      const controller = new AbortController();
      const delivered: string[] = [];
      const error = await rejectionOf(
        wireClient().streamText({
          ...REQUEST,
          signal: controller.signal,
          onChunk: (chunk) => {
            delivered.push(chunk);
            if (delivered.length === 2) {
              controller.abort();
            }
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(error).toBeInstanceOf(APIUserAbortError);
      expect(delivered).toHaveLength(2);
      expect(closed).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "in the middle of a structured call that waits for the body",
    async () => {
      server.reply(({ head }) => head(200, JSON_HEADERS));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 80);

      const error = await rejectionOf(
        structured(wireClient(), controller.signal),
      );

      expect(error).toBeInstanceOf(APIUserAbortError);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "after: the result stands",
    async () => {
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(wireDelta("ok") + wireCompleted("ok"));
      });
      const controller = new AbortController();
      const result = await wireClient().streamText({
        ...REQUEST,
        signal: controller.signal,
      });
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(result.text).toBe("ok");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("regressions: one request, the body sent and the key", () => {
  it.each([429, 500, 503, 408, 409])(
    "makes a single request when the provider answers %i",
    async (status) => {
      server.reply(({ head, end }) => {
        head(status, {
          ...JSON_HEADERS,
          "retry-after": "0",
          "retry-after-ms": "1",
          "x-should-retry": "true",
        });
        end(
          JSON.stringify({
            error: { message: `quoted ${KEY}`, type: "x", code: "y" },
          }),
        );
      });
      const client = wireClient();

      const text = await rejectionOf(client.streamText(REQUEST));
      const object = await rejectionOf(structured(client));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(server.seen).toHaveLength(2);
      for (const error of [text, object]) {
        expect(error).toBeInstanceOf(APIError);
        expect((error as APIError).status).toBe(status);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends no sampling parameter and nothing that was not asked for",
    async () => {
      const client = wireClient();
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(wireDelta("ok") + wireCompleted("ok"));
      });
      await client.streamText(REQUEST);
      server.reply(({ head, end }) => {
        head(200, JSON_HEADERS);
        end(
          JSON.stringify(fakeResponseBody({ text: JSON.stringify(VERDICT) })),
        );
      });
      await structured(client);

      const [stream, object] = server.seen.map(
        ({ body }) => JSON.parse(body) as Record<string, unknown>,
      );
      expect(Object.keys(stream ?? {}).sort()).toEqual([
        "input",
        "instructions",
        "model",
        "reasoning",
        "store",
        "stream",
      ]);
      expect(Object.keys(object ?? {}).sort()).toEqual([
        "input",
        "instructions",
        "model",
        "reasoning",
        "store",
        "text",
      ]);
      for (const body of [stream, object]) {
        expect(body).toMatchObject({
          model: "configured-model",
          store: false,
          reasoning: { effort: "low" },
        });
      }
      for (const { body } of server.seen) {
        expect(body).not.toMatch(
          /temperature|top_p|seed|presence_penalty|frequency_penalty|logprobs|previous_response_id/,
        );
        expect(body).not.toContain(KEY);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the key out of the client and of every error, cause included",
    async () => {
      const client = wireClient({ requestTimeoutMs: DEADLINE_MS });
      const errors: unknown[] = [];

      server.reply(({ head, end }) => {
        head(401, JSON_HEADERS);
        end(
          JSON.stringify({
            error: { message: "bad key", code: "invalid_api_key" },
          }),
        );
      });
      errors.push(await rejectionOf(client.streamText(REQUEST)));
      errors.push(await rejectionOf(structured(client)));

      server.reply(({ head, write, destroy }) => {
        head(200, SSE_HEADERS);
        write(wireDelta("x"));
        setTimeout(destroy, 20);
      });
      errors.push(await rejectionOf(client.streamText(REQUEST)));

      server.reply(({ destroy }) => destroy());
      errors.push(await rejectionOf(client.streamText(REQUEST)));
      errors.push(await rejectionOf(structured(client)));

      server.reply(() => undefined);
      errors.push(await rejectionOf(client.streamText(REQUEST)));

      server.reply(({ head, end }) => {
        head(200, JSON_HEADERS);
        end("<html>");
      });
      errors.push(await rejectionOf(structured(client)));

      expect(errors).toHaveLength(7);
      for (const error of errors) {
        let current: unknown = error;
        for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
          expect(viewsOf(current)).not.toContain(KEY);
          expect(viewsOf(current)).not.toMatch(/Bearer /);
          current = (current as { cause?: unknown }).cause;
        }
      }
      expect(
        inspect(client, { depth: 20, showHidden: true, getters: true }),
      ).not.toContain(KEY);
      expect(Object.isFrozen(client)).toBe(true);
      expect(Object.keys(client).sort()).toEqual([
        "generateStructured",
        "streamText",
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

// --- B6 --------------------------------------------------------------------

describe("B6: the scripted client next to the real one", () => {
  it("does not import the SDK", () => {
    const source = readFileSync(
      new URL("./helpers/fake-llm-client.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["']openai/);
    expect(source).not.toMatch(/import\(\s*["']openai/);
    expect(source).not.toMatch(/require\(\s*["']openai/);
  });

  it("answers an empty input, an aborted signal and an empty text as the real one", async () => {
    const real = () =>
      fetchClient([
        { kind: "sse", events: [completedWith([])] },
        jsonStep(bodyWith([])),
      ]).client;
    const fake = () => createFakeLlmClient([{ text: "" }, { value: VERDICT }]);
    const aborted = new AbortController();
    aborted.abort();
    const describeError = (error: unknown) => ({
      class: (error as Error).constructor.name,
      message: (error as Error).message,
      kind: (error as { kind?: string }).kind,
    });

    for (const input of [
      { ...REQUEST, input: [] },
      { ...REQUEST, input: [], signal: aborted.signal },
      { ...REQUEST, signal: aborted.signal },
      REQUEST,
    ]) {
      const fromReal = await rejectionOf(real().streamText(input));
      const fromFake = await rejectionOf(fake().streamText(input));
      expect(describeError(fromFake)).toEqual(describeError(fromReal));
    }
    for (const input of [
      { ...REQUEST, input: [] },
      { ...REQUEST, signal: aborted.signal },
    ]) {
      const request = { ...input, schema: verdictSchema, schemaName: "v" };
      const fromReal = await rejectionOf(real().generateStructured(request));
      const fromFake = await rejectionOf(fake().generateStructured(request));
      expect(describeError(fromFake)).toEqual(describeError(fromReal));
    }
  });

  it("never throws in the call itself: every refusal is a rejected promise", async () => {
    const fake = createFakeLlmClient([]);
    const promises = [
      fake.streamText({ ...REQUEST, input: [] }),
      fake.generateStructured({
        ...REQUEST,
        input: [],
        schema: verdictSchema,
        schemaName: "v",
      }),
      fake.streamText(REQUEST),
    ];

    for (const promise of promises) {
      expect(await rejectionOf(promise)).toBeInstanceOf(Error);
    }
  });

  it("delivers the chunks after the call returned, honours the signal and keeps a snapshot", async () => {
    const fake = createFakeLlmClient([
      { text: "abc", chunks: ["a", "b", "c"] },
      { chunks: ["p"], error: new LlmResponseError("interrupted", "cut") },
    ]);
    const controller = new AbortController();
    const delivered: string[] = [];
    const input = [{ role: "user" as const, content: "original" }];
    const promise = fake.streamText({
      instructions: "i",
      input,
      signal: controller.signal,
      onChunk: (chunk) => {
        delivered.push(chunk);
        if (chunk === "b") {
          controller.abort();
        }
      },
    });
    expect(delivered).toEqual([]);
    input.push({ role: "user", content: "changed afterwards" });

    expect(await rejectionOf(promise)).toBeInstanceOf(APIUserAbortError);
    expect(delivered).toEqual(["a", "b"]);
    expect(fake.calls[0]?.request.input).toEqual([
      { role: "user", content: "original" },
    ]);

    const partial: string[] = [];
    const error = await rejectionOf(
      fake.streamText({ ...REQUEST, onChunk: (chunk) => partial.push(chunk) }),
    );
    expect(partial).toEqual(["p"]);
    expectKind(error, "interrupted");
  });

  it("holds a step with `wait` until the test lets it go", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeLlmClient([{ text: "x", wait: gate }]);
    const delivered: string[] = [];
    let settled = false;
    const promise = fake
      .streamText({ ...REQUEST, onChunk: (chunk) => delivered.push(chunk) })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(delivered).toEqual([]);

    release();

    expect((await promise).text).toBe("x");
    expect(delivered).toEqual(["x"]);
  });
});

// --- The other variables that the SDK would read ---------------------------

describe("regressions: the SDK does not read the environment", () => {
  it(
    "ignores the credentials, the organization, the project and the log level of the environment",
    async () => {
      vi.stubEnv("OPENAI_API_KEY", OTHER_KEY);
      vi.stubEnv("OPENAI_ADMIN_KEY", OTHER_KEY);
      vi.stubEnv("OPENAI_ORG_ID", "org-fromenv");
      vi.stubEnv("OPENAI_PROJECT_ID", "proj_fromenv");
      vi.stubEnv("OPENAI_WEBHOOK_SECRET", OTHER_KEY);
      vi.stubEnv("OPENAI_LOG", "debug");
      vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:9/v1");
      const written: unknown[] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map(
        (method) =>
          vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
            written.push(args);
          }),
      );
      try {
        const client = wireClient();
        server.reply(({ head, end }) => {
          head(200, SSE_HEADERS);
          end(wireDelta("ok") + wireCompleted("ok"));
        });
        await client.streamText(REQUEST);
        server.reply(({ head, end }) => {
          head(500, JSON_HEADERS);
          end("{}");
        });
        await rejectionOf(structured(client));
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }

      expect(written).toEqual([]);
      expect(server.seen).toHaveLength(2);
      for (const { headers } of server.seen) {
        expect(headers.authorization).toBe(`Bearer ${KEY}`);
        expect(JSON.stringify(headers)).not.toContain("fromenv");
        expect(JSON.stringify(headers)).not.toContain(OTHER_KEY);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// --- The smoke report, with the real client --------------------------------

describe("regressions: the smoke report, through the real client", () => {
  const ORG = `org-${"aB3".repeat(8)}`;
  const PROJECT = `proj_${"xY9".repeat(8)}`;

  async function reportOf(script: readonly FakeFetchStep[]) {
    const { client, requests } = fetchClient(script);
    let time = 0;
    const report = await runLlmSmoke(client, {
      requestedModel: "configured-model",
      now: () => (time += 5),
      redact: createRedactor([KEY]),
    });
    return { report, text: formatSmokeReport(report), requests };
  }

  it("shows sizes and identifiers of a good answer, never what the model wrote", async () => {
    const { report, text, requests } = await reportOf([
      {
        kind: "sse",
        events: [
          deltaAt(`${MARKER} one `),
          deltaAt(`${MARKER} two`),
          completedWith([message(undefined, `${MARKER} one ${MARKER} two`)]),
        ],
      },
      jsonStep(
        bodyWith([
          message(
            undefined,
            JSON.stringify({ resposta: `${MARKER} quatro`, confianca: "alta" }),
          ),
        ]),
      ),
    ]);

    expect(requests).toHaveLength(2);
    expect(report.passed).toBe(true);
    expect(text).toContain("Resultado: APROVADO");
    for (const view of [text, JSON.stringify(report)]) {
      expect(view).not.toContain(MARKER);
      expect(view).not.toContain(KEY);
    }
  });

  it("masks the organization, the project and the key in the failure of both calls, with no retry", async () => {
    const quoted = `Rate limit reached in organization ${ORG} and project ${PROJECT} with key ${KEY}.`;
    const failure: FakeFetchStep = {
      kind: "json",
      status: 429,
      body: {
        error: { message: quoted, type: "tokens", code: "rate_limit_exceeded" },
      },
      headers: { "retry-after": "0" },
    };
    const { report, text, requests } = await reportOf([failure, failure]);

    expect(requests).toHaveLength(2);
    expect(report.passed).toBe(false);
    expect(text).toContain("Resultado: REPROVADO");
    for (const view of [text, JSON.stringify(report)]) {
      expect(view).not.toContain(ORG);
      expect(view).not.toContain(PROJECT);
      expect(view).not.toContain(KEY);
      expect(view).not.toContain("Bearer");
    }
    expect(text).toContain("org-[oculto]");
    expect(text).toContain("proj_[oculto]");
  });

  it("does not quote the model when its structured output is refused", async () => {
    const { report, text } = await reportOf([
      {
        kind: "sse",
        events: [
          deltaAt("a"),
          deltaAt("b"),
          completedWith([message(null, "ab")]),
        ],
      },
      jsonStep(
        bodyWith([
          message(
            undefined,
            JSON.stringify({ resposta: MARKER, confianca: MARKER }),
          ),
        ]),
      ),
    ]);

    expect(report.passed).toBe(false);
    expect(text).not.toContain(MARKER);
    expect(JSON.stringify(report)).not.toContain(MARKER);
  });
});
