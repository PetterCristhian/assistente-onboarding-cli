// What the user sees when the provider fails and the call is tried again
// (ENG-51). No network and no real key: either a scripted client or the real
// one over a fake `fetch`, with the wait injected.
import { APIError } from "openai";
import { describe, expect, it } from "vitest";
import { createChatSession, type ChatOutput } from "../src/chat/session.js";
import {
  createOpenAiLlmClient,
  type LlmClient,
  type LlmTextResult,
  type StreamTextRequest,
} from "../src/llm/client.js";
import type { RetryEvent } from "../src/llm/retry.js";
import { createRedactor } from "../src/security/redact.js";
import { fakeMaskedOpenAiKey, fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  apiErrorBody,
  createFakeOpenAiFetch,
  sseAnswer,
  textDelta,
  type FakeFetchStep,
} from "./helpers/fake-openai-fetch.js";

const KEY = fakeOpenAiKey();

interface Recorder extends ChatOutput {
  readonly events: string[];
}

function recorder(): Recorder {
  const events: string[] = [];
  return {
    events,
    chunk: (text) => void events.push(`chunk:${text}`),
    endAnswer: () => void events.push("end"),
    notice: (level, text) => void events.push(`${level}:${text}`),
  };
}

function httpError(
  status: number,
  body: unknown = { message: "Provider text." },
  headers: Record<string, string> = {},
): APIError {
  return APIError.generate(
    status,
    { error: body },
    `${status} Provider text.`,
    new Headers(headers),
  );
}

function event(retry: number, cause?: RetryEvent["cause"]): RetryEvent {
  return {
    retry,
    maxRetries: 3,
    delayMs: 1000 * retry,
    cause: cause ?? { kind: "transient", reason: "http_status", status: 503 },
  };
}

function answer(text: string): LlmTextResult {
  return { text, model: "fake-model", chunks: 1 };
}

/** A client whose streamText is the given function; no other call is made. */
function scripted(
  handler: (request: StreamTextRequest, call: number) => Promise<LlmTextResult>,
): LlmClient & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    streamText: (request) => {
      calls += 1;
      return handler(request, calls);
    },
    generateStructured: () => Promise.reject(new Error("not used")),
  };
}

function open(llm: LlmClient) {
  const output = recorder();
  const session = createChatSession({
    llm,
    instructions: "Context.",
    output,
    redact: createRedactor([KEY]),
  });
  return { output, session };
}

describe("the notices of a new try", () => {
  it("shows one line for each new try and, when all fail, a clear message, with the history untouched", async () => {
    const llm = scripted((request, call) => {
      if (call === 1) {
        request.onRetry?.(event(1));
        request.onRetry?.(event(2));
        request.onRetry?.(event(3));
        return Promise.reject(httpError(503));
      }
      return Promise.resolve(answer("Second turn."));
    });
    const { output, session } = open(llm);

    const result = await session.ask("Q1");

    expect(result.status).toBe("failed");
    expect(session.history).toEqual([]);
    expect(output.events).toHaveLength(4);
    expect(output.events[0]).toMatch(
      /^warning:.*\(HTTP 503\).*Nova tentativa 1 de 3, em 1 s\.$/,
    );
    expect(output.events[2]).toMatch(/Nova tentativa 3 de 3, em 3 s\./);
    expect(output.events[3]).toMatch(/^error:.*status 503.*4 tentativas/);

    // The chat stays open.
    expect((await session.ask("Q2")).status).toBe("answered");
    expect(session.history).toEqual([
      { role: "user", content: "Q2" },
      { role: "assistant", content: "Second turn." },
    ]);
  });

  it("closes the line, warns and starts again below it when a stream is cut", async () => {
    const llm = scripted((request) => {
      request.onChunk?.("par");
      request.onChunk?.("tial");
      request.onRetry?.(event(1, { kind: "transient", reason: "interrupted" }));
      request.onChunk?.("whole answer");
      return Promise.resolve(answer("whole answer"));
    });
    const { output, session } = open(llm);

    const result = await session.ask("Q");

    expect(result).toMatchObject({ status: "answered", text: "whole answer" });
    expect(output.events).toEqual([
      "chunk:par",
      "chunk:tial",
      "end",
      "warning:A resposta foi interrompida; o texto acima está incompleto e será descartado. Gerando de novo do zero (nova tentativa 1 de 3, em 1 s).",
      "chunk:whole answer",
      "end",
    ]);
    expect(session.history).toEqual([
      { role: "user", content: "Q" },
      { role: "assistant", content: "whole answer" },
    ]);
  });

  it("does not close a line that is not open", async () => {
    const llm = scripted((request) => {
      request.onRetry?.(event(1));
      request.onChunk?.("ok");
      return Promise.resolve(answer("ok"));
    });
    const { output, session } = open(llm);

    await session.ask("Q");

    expect(output.events.filter((e) => e === "end")).toHaveLength(1);
    expect(output.events[0]).toMatch(/^warning:/);
  });

  it("closes the open line once when the last try fails after some text", async () => {
    const llm = scripted((request) => {
      request.onChunk?.("part");
      return Promise.reject(httpError(503));
    });
    const { output, session } = open(llm);

    const result = await session.ask("Q");

    expect(result.status).toBe("failed");
    expect(output.events.slice(0, 3)).toEqual([
      "chunk:part",
      "end",
      "warning:Resposta interrompida.",
    ]);
    expect(output.events.filter((e) => e === "end")).toHaveLength(1);
    expect(session.history).toEqual([]);
  });
});

describe("failures that are not retried", () => {
  it("guides the user on a rejected key, without a notice of retry and without repeating the key", async () => {
    const llm = scripted(() =>
      Promise.reject(
        httpError(401, {
          message: `Incorrect API key provided: ${fakeMaskedOpenAiKey()}.`,
          code: "invalid_api_key",
        }),
      ),
    );
    const { output, session } = open(llm);

    await session.ask("Q");

    expect(llm.calls()).toBe(1);
    expect(output.events).toHaveLength(1);
    expect(output.events[0]).toMatch(/^error:.*OPENAI_API_KEY/);
    expect(output.events.join("\n")).not.toMatch(/sk-|Incorrect API key/);
  });

  it("explains a lack of credit as a matter of billing", async () => {
    const llm = scripted(() =>
      Promise.reject(
        httpError(429, { code: "insufficient_quota", message: "Quota." }),
      ),
    );
    const { output, session } = open(llm);

    await session.ask("Q");

    expect(llm.calls()).toBe(1);
    expect(output.events).toHaveLength(1);
    expect(output.events[0]).toMatch(/faturamento/);
    expect(output.events[0]).toMatch(/esperar não resolve/);
  });

  it("keeps showing the message of an error that is not the provider's", async () => {
    const llm = scripted(() => Promise.reject(new Error("caiu")));
    const { output, session } = open(llm);

    await session.ask("Q");

    expect(output.events.join("\n")).toContain("caiu");
  });
});

describe("with the real client over a fake fetch", () => {
  const CONFIG = {
    openaiApiKey: KEY,
    openaiModel: "configured-model",
    openaiReasoningEffort: "low" as const,
    requestTimeoutMs: 5_000,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 1_000,
  };
  const unavailable: FakeFetchStep = {
    kind: "json",
    status: 503,
    body: apiErrorBody("Overloaded.", "server_error", "server_error"),
  };

  function real(
    script: readonly FakeFetchStep[],
    sleep: (ms: number, signal?: AbortSignal) => Promise<void> = () =>
      Promise.resolve(),
  ) {
    const fake = createFakeOpenAiFetch(script);
    const llm = createOpenAiLlmClient(CONFIG, {
      fetch: fake.fetch,
      retry: { sleep, random: () => 0 },
    });
    return { fake, ...open(llm) };
  }

  it("recovers after two 503 and keeps only the final answer", async () => {
    const { fake, output, session } = real([
      unavailable,
      unavailable,
      sseAnswer(["Hello ", "there"]),
    ]);

    const result = await session.ask("Q");

    expect(result).toMatchObject({ status: "answered", text: "Hello there" });
    expect(fake.requests).toHaveLength(3);
    expect(output.events.filter((e) => e.startsWith("warning:"))).toHaveLength(
      2,
    );
    expect(session.history).toHaveLength(2);
  });

  it("starts again from zero when the stream is cut", async () => {
    const { output, session } = real([
      { kind: "sse", events: [textDelta("par"), textDelta("tial")] },
      sseAnswer(["whole"]),
    ]);

    await session.ask("Q");

    expect(output.events).toEqual([
      "chunk:par",
      "chunk:tial",
      "end",
      expect.stringMatching(/^warning:A resposta foi interrompida;/),
      "chunk:whole",
      "end",
    ]);
    expect(session.history.at(-1)).toEqual({
      role: "assistant",
      content: "whole",
    });
  });

  it("gives up after the last try, and the chat goes on", async () => {
    const { fake, output, session } = real([
      unavailable,
      unavailable,
      unavailable,
      unavailable,
      sseAnswer(["fine"]),
    ]);

    const failed = await session.ask("Q1");

    expect(failed.status).toBe("failed");
    expect(fake.requests).toHaveLength(4);
    expect(output.events.at(-1)).toMatch(/^error:.*4 tentativas/);
    expect(session.history).toEqual([]);
    expect((await session.ask("Q2")).status).toBe("answered");
  });

  it("tells the user to wait when the provider asks for more than 30 s", async () => {
    const { fake, output, session } = real([
      {
        kind: "json",
        status: 429,
        body: apiErrorBody("Slow.", "rate_limit_exceeded", "requests"),
        headers: { "retry-after": "90" },
      },
    ]);

    await session.ask("Q");

    expect(fake.requests).toHaveLength(1);
    expect(output.events).toHaveLength(1);
    expect(output.events[0]).toMatch(/pediu para aguardar 90 s.*mais tarde/);
  });

  it("repeats a refused connection and says how many tries were made", async () => {
    const refused: FakeFetchStep = {
      kind: "network-error",
      code: "ECONNREFUSED",
    };
    const { output, session } = real([refused, refused, refused, refused]);

    await session.ask("Q");

    expect(output.events.at(-1)).toMatch(/conexão.*ECONNREFUSED.*4 tentativas/);
  });

  it("never prints the key, headers or the text of the SDK, even when a 401 quotes the key", async () => {
    const { output, session } = real([
      {
        kind: "json",
        status: 401,
        body: apiErrorBody(
          `Incorrect API key provided: ${KEY}. Also ${fakeMaskedOpenAiKey()}.`,
          "invalid_api_key",
        ),
        headers: { authorization: `Bearer ${KEY}` },
      },
    ]);

    const result = await session.ask("Q");

    const shown = `${output.events.join("\n")}\n${JSON.stringify(result)}`;
    expect(shown).toContain("OPENAI_API_KEY");
    expect(shown).not.toContain(KEY);
    expect(shown).not.toMatch(/sk-|Bearer|authorization/i);
  });

  it("is cancelled while waiting: no new request and no failure message", async () => {
    const controller = new AbortController();
    const { fake, output, session } = real(
      [unavailable, sseAnswer(["never"])],
      (_ms, signal) => {
        controller.abort();
        return Promise.reject(signal?.reason as Error);
      },
    );

    const result = await session.ask("Q", { signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(fake.requests).toHaveLength(1);
    expect(output.events.some((e) => e.startsWith("error:"))).toBe(false);
    expect(session.history).toEqual([]);
  });
});
