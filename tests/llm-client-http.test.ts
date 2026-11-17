// The real SDK and the real `fetch` against an HTTP server of this very
// process, on 127.0.0.1, with the base URL injected: what is checked here is
// what actually goes on the wire and what happens with a real connection.
// Nothing leaves the machine, and the key is a fake one built at runtime.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
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
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClient,
  type LlmClientConfig,
} from "../src/llm/client.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  FAKE_RETURNED_MODEL,
  apiErrorBody,
  fakeResponseBody,
} from "./helpers/fake-openai-fetch.js";

const KEY = fakeOpenAiKey();
const DEADLINE_MS = 250;
const TEST_TIMEOUT_MS = 15_000;
const CONFIG: LlmClientConfig = {
  openaiApiKey: KEY,
  openaiModel: "configured-model",
  openaiReasoningEffort: "medium",
  requestTimeoutMs: 10_000,
};
const REQUEST = {
  instructions: "Assembled context.",
  input: [
    { role: "user" as const, content: "first question" },
    { role: "assistant" as const, content: "first answer" },
    { role: "user" as const, content: "second question" },
  ],
};
const answerSchema = z.object({ approved: z.boolean(), reason: z.string() });
const ANSWER = { approved: true, reason: "fine" };

interface SeenRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type Reply = (context: {
  write: (text: string | Uint8Array) => void;
  end: (text?: string | Uint8Array) => void;
  head: (status: number, headers: Record<string, string>) => void;
  destroy: () => void;
  onClose: (listener: () => void) => void;
}) => void;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function delta(text: string): string {
  return sse("response.output_text.delta", {
    type: "response.output_text.delta",
    delta: text,
  });
}

function completed(text: string): string {
  return sse("response.completed", {
    type: "response.completed",
    response: fakeResponseBody({ text }),
  });
}

const SSE_HEADERS = { "content-type": "text/event-stream" };
const JSON_HEADERS = { "content-type": "application/json" };

interface LocalServer {
  readonly baseURL: string;
  readonly seen: SeenRequest[];
  /** How many requests had their connection closed before an answer ended. */
  closedEarly: () => number;
  reply: (reply: Reply) => void;
  stop: () => Promise<void>;
}

async function startServer(): Promise<LocalServer> {
  const seen: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  let closedEarly = 0;
  let current: Reply = ({ head, end }) => {
    head(500, JSON_HEADERS);
    end("{}");
  };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (piece: string) => {
      body += piece;
    });
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.on("close", () => {
        if (!response.writableFinished) {
          closedEarly += 1;
        }
      });
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
    closedEarly: () => closedEarly,
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
    schema: answerSchema,
    schemaName: "answer",
    ...(signal === undefined ? {} : { signal }),
  });
}

async function waitFor(condition: () => boolean, limitMs = 3_000) {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > limitMs) {
      throw new Error("The condition was not met in time.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let server: LocalServer;
let decoy: LocalServer;

beforeAll(async () => {
  server = await startServer();
  decoy = await startServer();
});

afterAll(async () => {
  await server.stop();
  await decoy.stop();
});

afterEach(() => {
  server.seen.length = 0;
  decoy.seen.length = 0;
  vi.unstubAllEnvs();
});

function clientWith(overrides: Partial<LlmClientConfig> = {}): LlmClient {
  return createOpenAiLlmClient(
    { ...CONFIG, ...overrides },
    { baseURL: server.baseURL },
  );
}

describe("what goes on the wire", () => {
  it(
    "streamText sends exactly the documented fields and headers",
    async () => {
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(delta("Olá, ") + delta("mundo") + completed("Olá, mundo"));
      });
      const received: string[] = [];

      const result = await clientWith().streamText({
        ...REQUEST,
        onChunk: (chunk) => received.push(chunk),
      });

      expect(result).toEqual({
        text: "Olá, mundo",
        model: FAKE_RETURNED_MODEL,
        chunks: 2,
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      });
      expect(received).toEqual(["Olá, ", "mundo"]);

      expect(server.seen).toHaveLength(1);
      const [request] = server.seen;
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe("/v1/responses");
      const body = JSON.parse(request?.body ?? "") as Record<string, unknown>;
      // The whole body: nothing else is sent, so no sampling parameter, no
      // server-side state and no tool can slip in.
      expect(body).toEqual({
        model: "configured-model",
        instructions: "Assembled context.",
        input: REQUEST.input,
        store: false,
        reasoning: { effort: "medium" },
        stream: true,
      });

      const headers = request?.headers ?? {};
      expect(headers.authorization).toBe(`Bearer ${KEY}`);
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-stainless-retry-count"]).toBe("0");
      expect(headers).not.toHaveProperty("openai-organization");
      expect(headers).not.toHaveProperty("openai-project");
      expect(headers).not.toHaveProperty("openai-beta");
      // The key travels in one header only.
      const holders = Object.entries(headers).filter(([, value]) =>
        String(value).includes(KEY),
      );
      expect(holders.map(([name]) => name)).toEqual(["authorization"]);
      expect(request?.url).not.toContain(KEY);
      expect(request?.body).not.toContain(KEY);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "generateStructured sends the same fields plus the strict format, and no stream",
    async () => {
      server.reply(({ head, end }) => {
        head(200, JSON_HEADERS);
        end(JSON.stringify(fakeResponseBody({ text: JSON.stringify(ANSWER) })));
      });

      const result = await structured(clientWith());

      expect(result.value).toEqual(ANSWER);
      expect(result.model).toBe(FAKE_RETURNED_MODEL);
      expect(server.seen).toHaveLength(1);
      const body = JSON.parse(server.seen[0]?.body ?? "") as Record<
        string,
        unknown
      >;
      expect(Object.keys(body).sort()).toEqual([
        "input",
        "instructions",
        "model",
        "reasoning",
        "store",
        "text",
      ]);
      expect(body.store).toBe(false);
      expect(body.reasoning).toEqual({ effort: "medium" });
      expect(body.text).toMatchObject({
        format: { type: "json_schema", name: "answer", strict: true },
      });
      expect(server.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(server.seen[0]?.headers).not.toHaveProperty("openai-organization");
      expect(server.seen[0]?.headers).not.toHaveProperty("openai-project");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never reaches the address of OPENAI_BASE_URL, nor uses the other variables of the SDK",
    async () => {
      vi.stubEnv("OPENAI_BASE_URL", decoy.baseURL);
      vi.stubEnv("OPENAI_API_KEY", fakeOpenAiKey("B"));
      vi.stubEnv("OPENAI_ADMIN_KEY", fakeOpenAiKey("D"));
      vi.stubEnv("OPENAI_ORG_ID", "org-from-environment");
      vi.stubEnv("OPENAI_PROJECT_ID", "proj_from_environment");
      vi.stubEnv("OPENAI_WEBHOOK_SECRET", "whsec_from_environment");
      vi.stubEnv("OPENAI_LOG", "debug");
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(delta("ok") + completed("ok"));
      });

      await clientWith().streamText(REQUEST);

      expect(decoy.seen).toHaveLength(0);
      expect(server.seen).toHaveLength(1);
      const headers = server.seen[0]?.headers ?? {};
      expect(headers.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(headers)).not.toContain("environment");
      expect(JSON.stringify(headers)).not.toContain(fakeOpenAiKey("B"));
      expect(JSON.stringify(headers)).not.toContain(fakeOpenAiKey("D"));
    },
    TEST_TIMEOUT_MS,
  );
});

describe("no retry by the SDK", () => {
  // Every status that the SDK tries again by default, and the header with
  // which a server asks for a new attempt.
  it.each<{ status: number; headers: Record<string, string> }>([
    { status: 408, headers: {} },
    { status: 409, headers: {} },
    { status: 429, headers: { "retry-after": "0" } },
    { status: 500, headers: {} },
    { status: 502, headers: {} },
    { status: 503, headers: { "retry-after-ms": "1" } },
    { status: 500, headers: { "x-should-retry": "true" } },
  ])(
    "makes a single request on HTTP $status $headers, in both methods",
    async ({ status, headers }) => {
      server.reply(({ head, end }) => {
        head(status, { ...JSON_HEADERS, ...headers });
        end(JSON.stringify(apiErrorBody("Provider failure.", "some_code")));
      });
      const client = clientWith();

      const streamError = await rejectionOf(client.streamText(REQUEST));
      expect(server.seen).toHaveLength(1);
      const structuredError = await rejectionOf(structured(client));
      expect(server.seen).toHaveLength(2);

      for (const error of [streamError, structuredError]) {
        expect(error).toBeInstanceOf(APIError);
        expect(error).toMatchObject({ status, code: "some_code" });
      }
      for (const request of server.seen) {
        expect(request.headers["x-stainless-retry-count"]).toBe("0");
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("total deadline, with a real connection", () => {
  async function expectTimeout(run: (client: LlmClient) => Promise<unknown>) {
    const closedBefore = server.closedEarly();
    const startedAt = performance.now();
    const error = await rejectionOf(
      run(clientWith({ requestTimeoutMs: DEADLINE_MS })),
    );
    const elapsed = performance.now() - startedAt;

    expect(error).toBeInstanceOf(APIConnectionTimeoutError);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 3_000);
    // One request, and the connection was dropped by the client.
    expect(server.seen).toHaveLength(1);
    await waitFor(() => server.closedEarly() > closedBefore);
  }

  it(
    "a server that accepts the request and never answers",
    async () => {
      server.reply(() => undefined);
      await expectTimeout((client) => client.streamText(REQUEST));
      server.seen.length = 0;
      await expectTimeout((client) => structured(client));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a server that sends the headers and stops",
    async () => {
      server.reply(({ head }) => head(200, SSE_HEADERS));
      await expectTimeout((client) => client.streamText(REQUEST));
      server.seen.length = 0;
      // Not a stream: the headers and the start of a JSON that never ends.
      server.reply(({ head, write }) => {
        head(200, JSON_HEADERS);
        write('{"id": "resp_fake", ');
      });
      await expectTimeout((client) => structured(client));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a stream that drips a chunk at intervals shorter than the deadline: the total counts",
    async () => {
      server.reply(({ head, write, onClose }) => {
        head(200, SSE_HEADERS);
        const timer = setInterval(() => write(delta("drip ")), 30);
        onClose(() => clearInterval(timer));
      });
      const received: string[] = [];
      let receivedAtRejection = -1;

      const startedAt = performance.now();
      const error = await rejectionOf(
        clientWith({ requestTimeoutMs: DEADLINE_MS }).streamText({
          ...REQUEST,
          onChunk: (chunk) => received.push(chunk),
        }),
      );
      const elapsed = performance.now() - startedAt;
      receivedAtRejection = received.length;

      expect(error).toBeInstanceOf(APIConnectionTimeoutError);
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS + 3_000);
      // Chunks did arrive before the deadline, and none arrives after it.
      expect(receivedAtRejection).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toHaveLength(receivedAtRejection);
      await waitFor(() => server.closedEarly() > 0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("cancellation, with a real connection", () => {
  it(
    "in the middle of a stream: abort error, nothing delivered afterwards, connection dropped",
    async () => {
      server.reply(({ head, write, onClose }) => {
        head(200, SSE_HEADERS);
        const timer = setInterval(() => write(delta("x")), 15);
        onClose(() => clearInterval(timer));
      });
      const controller = new AbortController();
      const received: string[] = [];
      const closedBefore = server.closedEarly();

      const error = await rejectionOf(
        clientWith().streamText({
          ...REQUEST,
          signal: controller.signal,
          onChunk: (chunk) => {
            received.push(chunk);
            if (received.length === 3) {
              controller.abort();
            }
          },
        }),
      );

      expect(error).toBeInstanceOf(APIUserAbortError);
      expect(error).not.toBeInstanceOf(APIConnectionTimeoutError);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(received).toHaveLength(3);
      await waitFor(() => server.closedEarly() > closedBefore);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "while a structured call waits for the answer",
    async () => {
      server.reply(() => undefined);
      const controller = new AbortController();
      const closedBefore = server.closedEarly();

      const pending = rejectionOf(structured(clientWith(), controller.signal));
      await waitFor(() => server.seen.length === 1);
      const abortedAt = performance.now();
      controller.abort();
      const error = await pending;

      expect(error).toBeInstanceOf(APIUserAbortError);
      expect(performance.now() - abortedAt).toBeLessThan(2_000);
      await waitFor(() => server.closedEarly() > closedBefore);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("what a real connection can deliver", () => {
  it(
    "five thousand chunks: all of them, in order, and the text is their concatenation",
    async () => {
      const pieces = Array.from({ length: 5_000 }, (_, index) => `${index},`);
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(pieces.map(delta).join("") + completed(pieces.join("")));
      });
      const received: string[] = [];

      const result = await clientWith().streamText({
        ...REQUEST,
        onChunk: (chunk) => received.push(chunk),
      });

      expect(result.chunks).toBe(5_000);
      expect(received).toEqual(pieces);
      expect(result.text).toBe(pieces.join(""));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a multi-byte character split between two packets, CRLF line ends and comments",
    async () => {
      const text = "ação 🚀 fim";
      server.reply(({ head, write, end }) => {
        head(200, SSE_HEADERS);
        const bytes = Buffer.from(
          (delta(text) + ": keep-alive\n\n" + completed(text)).replaceAll(
            "\n",
            "\r\n",
          ),
        );
        const cut = bytes.indexOf(Buffer.from("🚀")) + 2;
        write(bytes.subarray(0, cut));
        setTimeout(() => end(bytes.subarray(cut)), 40);
      });
      const received: string[] = [];

      const result = await clientWith().streamText({
        ...REQUEST,
        onChunk: (chunk) => received.push(chunk),
      });

      expect(result.text).toBe(text);
      expect(received).toEqual([text]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a connection that drops in the middle of the stream never yields an answer",
    async () => {
      server.reply(({ head, write, destroy }) => {
        head(200, SSE_HEADERS);
        write(
          delta("partial") + 'event: response.output_text.delta\ndata: {"ty',
        );
        setTimeout(destroy, 30);
      });
      const received: string[] = [];

      const error = await rejectionOf(
        clientWith().streamText({
          ...REQUEST,
          onChunk: (chunk) => received.push(chunk),
        }),
      );

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: "interrupted" });
      expect(error).not.toBeInstanceOf(APIUserAbortError);
      expect(error).not.toBeInstanceOf(APIConnectionTimeoutError);
      expect(received).toEqual(["partial"]);
      expect(server.seen).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a structured answer that is not JSON, or that drops in the middle, is interrupted and not invalid output",
    async () => {
      server.reply(({ head, end }) => {
        head(200, JSON_HEADERS);
        end("<html>502 Bad Gateway</html>");
      });
      const notJson = await rejectionOf(structured(clientWith()));

      const whole = JSON.stringify(
        fakeResponseBody({ text: JSON.stringify(ANSWER) }),
      );
      server.reply(({ head, write, destroy }) => {
        head(200, {
          ...JSON_HEADERS,
          "content-length": String(Buffer.byteLength(whole)),
        });
        write(whole.slice(0, 30));
        setTimeout(destroy, 30);
      });
      const dropped = await rejectionOf(structured(clientWith()));

      for (const error of [notJson, dropped]) {
        expect(error).toBeInstanceOf(LlmResponseError);
        expect(error).toMatchObject({ kind: "interrupted" });
        expect((error as Error).message).not.toContain("502");
      }
      expect(server.seen).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a stream that closes cleanly before the final event is reported as interrupted",
    async () => {
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(delta("partial"));
      });

      const error = await rejectionOf(clientWith().streamText(REQUEST));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: "interrupted" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an event whose data is not JSON rejects the call instead of being skipped",
    async () => {
      server.reply(({ head, end }) => {
        head(200, SSE_HEADERS);
        end(
          delta("a") +
            "event: response.output_text.delta\ndata: {not json\n\n" +
            completed("a"),
        );
      });

      const error = await rejectionOf(clientWith().streamText(REQUEST));

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: "interrupted" });
      expect((error as Error).message).not.toContain("not json");
      expect(server.seen).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});
