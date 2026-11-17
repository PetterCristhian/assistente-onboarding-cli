// Last adjustments of the OpenAI client before the PR (ENG-48), each with the
// test that failed before its fix: the status of the final event of a stream,
// the end of the reading at the final event, and a piece of text with no
// text. The real SDK with a fake `fetch`, or a server on 127.0.0.1: no request
// ever leaves the machine, and the key is a fake one built at runtime.
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  sseText,
  textDelta,
  type FakeFetchStep,
  type SseEvent,
} from "./helpers/fake-openai-fetch.js";

const TEST_TIMEOUT_MS = 15_000;
// Far longer than a test takes, far shorter than the timeout of a test: a
// call that waits for it is seen as a timeout error, not as a hung test.
const DEADLINE_MS = 1_500;
const CONFIG: LlmClientConfig = {
  openaiApiKey: fakeOpenAiKey(),
  openaiModel: "configured-model",
  openaiReasoningEffort: "low",
  requestTimeoutMs: DEADLINE_MS,
};
const REQUEST = {
  instructions: "Assembled context.",
  input: [{ role: "user" as const, content: "question" }],
};
const verdictSchema = z.object({ approved: z.boolean(), reason: z.string() });
const VERDICT = { approved: true, reason: "fine" };

function fetchClient(script: readonly FakeFetchStep[]): LlmClient {
  return createOpenAiLlmClient(CONFIG, {
    fetch: createFakeOpenAiFetch(script).fetch,
  });
}

async function streamOf(step: FakeFetchStep) {
  const delivered: string[] = [];
  const outcome = await fetchClient([step])
    .streamText({ ...REQUEST, onChunk: (chunk) => delivered.push(chunk) })
    .then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
  return { ...outcome, delivered };
}

/** A `response.completed` event whose response has the given changes. */
function completedEvent(
  text: string,
  changes: Record<string, unknown> = {},
): SseEvent {
  const type = "response.completed";
  return {
    event: type,
    data: {
      type,
      response: {
        ...(fakeResponseBody({ text }) as Record<string, unknown>),
        ...changes,
      },
    },
  };
}

describe("streamText: the status of the response in the final event", () => {
  it.each([
    ["incomplete", "incomplete"],
    ["failed", "failed"],
    ["cancelled", "failed"],
    ["in_progress", "failed"],
    ["queued", "failed"],
    ["some_future_status", "failed"],
    ["", "failed"],
  ])(
    "a completed event whose response is %s is %s, even with text delivered",
    async (status, kind) => {
      const { result, error, delivered } = await streamOf({
        kind: "sse",
        events: [
          textDelta("Hello"),
          textDelta(", world"),
          completedEvent("Hello, world", {
            status,
            incomplete_details: { reason: "max_output_tokens" },
            error: { code: "server_error", message: "provider failure" },
          }),
        ],
      });

      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind, model: FAKE_RETURNED_MODEL });
      // What was delivered was delivered: it is the outcome that changes.
      expect(delivered).toEqual(["Hello", ", world"]);
    },
  );

  it("names the reason of an incomplete response and the code of a failed one", async () => {
    const incomplete = await streamOf({
      kind: "sse",
      events: [
        textDelta("Hello"),
        completedEvent("Hello", {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ],
    });
    const failed = await streamOf({
      kind: "sse",
      events: [
        textDelta("Hello"),
        completedEvent("Hello", {
          status: "failed",
          error: { code: "server_error", message: "provider failure" },
        }),
      ],
    });

    expect((incomplete.error as Error).message).toContain("max_output_tokens");
    expect((failed.error as Error).message).toContain("server_error");
  });

  it("a status that is not completed counts before a missing model", async () => {
    const { error } = await streamOf({
      kind: "sse",
      events: [
        textDelta("Hello"),
        completedEvent("Hello", { status: "incomplete", model: undefined }),
      ],
    });

    expect(error).toMatchObject({ kind: "incomplete" });
  });

  it.each([
    ["completed", { status: "completed" }],
    ["absent", { status: undefined }],
    ["null", { status: null }],
  ])("a completed event whose status is %s is an answer", async (_t, extra) => {
    const { result, delivered } = await streamOf({
      kind: "sse",
      events: [textDelta("Hello"), completedEvent("Hello", extra)],
    });

    expect(result).toMatchObject({ text: "Hello", chunks: 1 });
    expect(delivered).toEqual(["Hello"]);
  });
});

describe("streamText: the final event ends the reading", () => {
  it("ignores a piece of text that comes after the final event", async () => {
    const { result, delivered } = await streamOf({
      kind: "sse",
      events: [
        textDelta("Hello"),
        completedEvent("Hello"),
        textDelta(" and more"),
      ],
    });

    expect(result).toMatchObject({ text: "Hello", chunks: 1 });
    expect(delivered).toEqual(["Hello"]);
  });

  it.each([
    ["an error event", errorEvent("server_error", "boom")],
    ["a failed event", finalEvent({ status: "failed" })],
    ["an incomplete event", finalEvent({ status: "incomplete" })],
    ["another completed event", completedEvent("Other", { model: "other" })],
  ])("ignores %s that comes after the final event", async (_title, late) => {
    const { result, error } = await streamOf({
      kind: "sse",
      events: [textDelta("Hello"), completedEvent("Hello"), late],
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ text: "Hello", model: FAKE_RETURNED_MODEL });
  });

  it(
    "does not wait for a body that stays open after the final event",
    async () => {
      const started = Date.now();
      const { result, error } = await streamOf({
        kind: "sse",
        events: [textDelta("Hello"), completedEvent("Hello")],
        hang: true,
      });

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ text: "Hello", chunks: 1 });
      expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["failed", "failed"],
    ["incomplete", "incomplete"],
  ] as const)(
    "does not wait for a body that stays open after a %s event",
    async (status, kind) => {
      const started = Date.now();
      const { error } = await streamOf({
        kind: "sse",
        events: [textDelta("Hello"), finalEvent({ status })],
        hang: true,
      });

      expect(error).toMatchObject({ kind });
      expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("streamText: a connection kept open by the server, on the wire", () => {
  let server: Server;
  let baseURL: string;
  const sockets = new Set<Socket>();
  let reply: (response: ServerResponse) => void = (response) => {
    response.end();
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => reply(response));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  /**
   * The server writes the events and never ends the response. Resolves with
   * who closed the connection: the client, or the test giving up.
   */
  function keepOpenAfter(events: readonly SseEvent[]) {
    let serverEnded = false;
    const closed = new Promise<"client" | "server">((resolve) => {
      reply = (response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(events.map(sseText).join(""));
        response.on("close", () => resolve(serverEnded ? "server" : "client"));
      };
    });
    const giveUp = new Promise<"still open">((resolve) => {
      const timer = setTimeout(() => resolve("still open"), 5_000);
      void closed.then(() => clearTimeout(timer));
    });
    return {
      closedBy: () => Promise.race([closed, giveUp]),
      markServerEnd: () => {
        serverEnded = true;
      },
    };
  }

  it(
    "returns the answer at the final event and closes the connection itself",
    async () => {
      const connection = keepOpenAfter([
        textDelta("Hello"),
        textDelta(", world"),
        completedEvent("Hello, world"),
      ]);
      const client = createOpenAiLlmClient(CONFIG, { baseURL });
      const delivered: string[] = [];
      const started = Date.now();

      const result = await client.streamText({
        ...REQUEST,
        onChunk: (chunk) => delivered.push(chunk),
      });
      const elapsed = Date.now() - started;

      expect(result).toMatchObject({
        text: "Hello, world",
        model: FAKE_RETURNED_MODEL,
        chunks: 2,
      });
      expect(delivered).toEqual(["Hello", ", world"]);
      // Well before the total deadline, which the open connection would cost.
      expect(elapsed).toBeLessThan(DEADLINE_MS);
      await expect(connection.closedBy()).resolves.toBe("client");
      connection.markServerEnd();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports a failed answer at its event and closes the connection itself",
    async () => {
      const connection = keepOpenAfter([
        textDelta("Hello"),
        finalEvent({ status: "failed", errorCode: "server_error" }),
      ]);
      const client = createOpenAiLlmClient(CONFIG, { baseURL });
      const started = Date.now();

      const error: unknown = await client.streamText(REQUEST).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(LlmResponseError);
      expect(error).toMatchObject({ kind: "failed" });
      expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
      await expect(connection.closedBy()).resolves.toBe("client");
      connection.markServerEnd();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("generateStructured: a piece of text with no text", () => {
  function part(fields: Record<string, unknown>): Record<string, unknown> {
    return { type: "output_text", annotations: [], ...fields };
  }

  function message(
    content: readonly unknown[],
    phase?: string,
  ): Record<string, unknown> {
    return {
      type: "message",
      id: "msg_fake",
      role: "assistant",
      status: "completed",
      content,
      ...(phase === undefined ? {} : { phase }),
    };
  }

  async function outcomeOf(output: readonly unknown[]) {
    const client = fetchClient([
      {
        kind: "json",
        body: { ...(fakeResponseBody() as Record<string, unknown>), output },
      },
    ]);
    return client
      .generateStructured({
        ...REQUEST,
        schema: verdictSchema,
        schemaName: "verdict",
      })
      .then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
  }

  const good = part({ text: JSON.stringify(VERDICT) });

  it.each([
    ["absent", part({})],
    ["null", part({ text: null })],
  ])(
    "is malformed when the text is %s, not invalid_output",
    async (_t, bad) => {
      const alone = await outcomeOf([message([bad])]);
      const beforeAnApproval = await outcomeOf([message([bad, good])]);

      for (const { result, error } of [alone, beforeAnApproval]) {
        expect(result).toBeUndefined();
        expect(error).toBeInstanceOf(LlmResponseError);
        expect(error).toMatchObject({
          kind: "malformed",
          model: FAKE_RETURNED_MODEL,
        });
      }
    },
  );

  it("an empty text is still the output of the model: invalid_output", async () => {
    const { error } = await outcomeOf([message([part({ text: "" })])]);

    expect(error).toMatchObject({ kind: "invalid_output" });
  });

  it("does not look at a commentary with no text", async () => {
    const { result } = await outcomeOf([
      message([part({})], "commentary"),
      message([good], "final_answer"),
    ]);

    expect(result?.value).toEqual(VERDICT);
  });
});
