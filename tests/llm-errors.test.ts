import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import { describe, expect, it, vi } from "vitest";
import { LlmResponseError } from "../src/llm/client.js";
import type { LlmResponseErrorKind } from "../src/llm/client.js";
import {
  classifyError,
  describeFailure,
  describeRetryCause,
  formatRetryNotice,
  type ErrorClass,
} from "../src/llm/errors.js";
import { fakeMaskedOpenAiKey, fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();

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

describe("classifyError", () => {
  it("tells connection failures and timeouts apart", () => {
    expect(classifyError(new APIConnectionError({}))).toEqual({
      kind: "transient",
      reason: "connection",
    });
    expect(classifyError(new APIConnectionTimeoutError())).toEqual({
      kind: "transient",
      reason: "timeout",
    });
  });

  it.each([408, 409, 500, 502, 503, 599])(
    "treats HTTP %i as transient",
    (status) => {
      expect(classifyError(httpError(status))).toEqual({
        kind: "transient",
        reason: "http_status",
        status,
      });
    },
  );

  it("treats 429 as a rate limit, with or without a body", () => {
    const plain = classifyError(httpError(429, undefined));
    const coded = classifyError(
      httpError(429, { code: "rate_limit_exceeded", type: "requests" }),
    );

    expect(plain).toEqual({ kind: "rate_limit", status: 429 });
    expect(coded).toEqual({ kind: "rate_limit", status: 429 });
  });

  it("treats 429 with insufficient_quota as fatal, wherever the code is", () => {
    const inCode = httpError(429, { code: "insufficient_quota" });
    const inType = httpError(429, { type: "insufficient_quota" });
    const inNested = Object.assign(httpError(429, undefined), {
      error: { code: "insufficient_quota" },
    });
    const asText = Object.assign(httpError(429, undefined), {
      error: "insufficient_quota",
    });

    for (const error of [inCode, inType, inNested, asText]) {
      expect(classifyError(error)).toEqual({
        kind: "fatal",
        reason: "insufficient_quota",
        status: 429,
      });
    }
  });

  it.each([
    [401, "auth"],
    [403, "permission"],
    [400, "bad_request"],
    [404, "not_found"],
    [422, "unprocessable"],
    [402, "http_status"],
    [413, "http_status"],
  ])("treats HTTP %i as fatal (%s)", (status, reason) => {
    expect(classifyError(httpError(status))).toEqual({
      kind: "fatal",
      reason,
      status,
    });
  });

  it("treats an abort as cancelled", () => {
    expect(classifyError(new APIUserAbortError())).toEqual({
      kind: "cancelled",
    });
  });

  it.each<[LlmResponseErrorKind, ErrorClass]>([
    ["interrupted", { kind: "transient", reason: "interrupted" }],
    ["failed", { kind: "transient", reason: "provider_failed" }],
    ["malformed", { kind: "fatal", reason: "response" }],
    ["incomplete", { kind: "fatal", reason: "response" }],
    ["empty", { kind: "fatal", reason: "response" }],
    ["refusal", { kind: "fatal", reason: "response" }],
    ["invalid_output", { kind: "fatal", reason: "response" }],
  ])("classifies LlmResponseError %s", (kind, expected) => {
    expect(classifyError(new LlmResponseError(kind, "Message."))).toEqual(
      expected,
    );
  });

  it("treats anything else as fatal and unknown", () => {
    expect(classifyError(new TypeError("bug"))).toEqual({
      kind: "fatal",
      reason: "unknown",
    });
    expect(classifyError("text")).toEqual({ kind: "fatal", reason: "unknown" });
    expect(classifyError(undefined)).toEqual({
      kind: "fatal",
      reason: "unknown",
    });
  });
});

describe("classifyError: what the provider asks for in the headers", () => {
  const limited = (headers: Record<string, string>): ErrorClass =>
    classifyError(httpError(429, undefined, headers));

  it("reads retry-after-ms", () => {
    expect(limited({ "retry-after-ms": "1500" })).toMatchObject({
      retryAfterMs: 1500,
    });
  });

  it("reads retry-after in seconds, integer or decimal", () => {
    expect(limited({ "retry-after": "2" })).toMatchObject({
      retryAfterMs: 2000,
    });
    expect(limited({ "retry-after": "0.5" })).toMatchObject({
      retryAfterMs: 500,
    });
  });

  it("reads retry-after as an HTTP date, future or past", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const past = new Date(Date.now() - 60_000).toUTCString();

    expect(limited({ "retry-after": future })).toMatchObject({
      retryAfterAt: Date.parse(future),
    });
    expect(limited({ "retry-after": past })).toMatchObject({
      retryAfterAt: Date.parse(past),
    });
  });

  it("ignores values that are not a wait", () => {
    for (const value of ["abc", "-3", "Infinity", "1e999", ""]) {
      expect(limited({ "retry-after": value })).toEqual({
        kind: "rate_limit",
        status: 429,
      });
    }
    expect(limited({ "retry-after-ms": "-5" })).toEqual({
      kind: "rate_limit",
      status: 429,
    });
  });

  it("prefers retry-after-ms when both are present", () => {
    expect(
      limited({ "retry-after-ms": "250", "retry-after": "9" }),
    ).toMatchObject({ retryAfterMs: 250 });
  });

  it("falls back to retry-after when retry-after-ms is not a wait", () => {
    expect(
      limited({ "retry-after-ms": "abc", "retry-after": "3" }),
    ).toMatchObject({ retryAfterMs: 3000 });
  });

  it("does not carry the headers in the class", () => {
    const result = limited({
      authorization: `Bearer ${KEY}`,
      "retry-after": "1",
    });

    expect(JSON.stringify(result)).not.toMatch(/authorization|Bearer/i);
  });
});

describe("what the user reads", () => {
  const leaky = httpError(
    401,
    { message: `Incorrect API key provided: ${fakeMaskedOpenAiKey()}.` },
    { authorization: `Bearer ${KEY}` },
  );
  const context = { retries: 0, maxRetries: 3 };

  function everything(): string[] {
    const errors: unknown[] = [
      leaky,
      httpError(403),
      httpError(400),
      httpError(404),
      httpError(422),
      httpError(402),
      httpError(429, { code: "insufficient_quota" }),
      httpError(429, undefined, { "retry-after": "3" }),
      httpError(503),
      new APIConnectionError({ cause: new Error(`fetch ${KEY}`) }),
      new APIConnectionTimeoutError(),
      new APIUserAbortError(),
      new TypeError(`bug with ${KEY}`),
      new LlmResponseError("interrupted", "Message."),
    ];
    const texts = errors.flatMap((error) => [
      describeFailure(error, context),
      describeFailure(error, { retries: 3, maxRetries: 3 }),
    ]);
    const causes = [
      { kind: "transient", reason: "connection" },
      { kind: "transient", reason: "http_status", status: 503 },
      { kind: "rate_limit", status: 429 },
    ] as const;
    for (const cause of causes) {
      const event = { retry: 1, maxRetries: 3, delayMs: 1000, cause };
      texts.push(
        describeRetryCause(cause),
        formatRetryNotice(event),
        formatRetryNotice(event, { partialText: true }),
      );
    }
    return texts;
  }

  it("never holds the key, the masked key, headers or the text of the SDK", () => {
    for (const text of everything()) {
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(/sk-|Bearer|authorization|Incorrect API key/i);
      expect(text).not.toContain("Provider text");
    }
  });

  it("guides the user on a rejected key, without repeating it", () => {
    const text = describeFailure(leaky, context);

    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("status 401");
  });

  it("tells that waiting does not fix a lack of credit", () => {
    const text = describeFailure(
      httpError(429, { code: "insufficient_quota" }),
      context,
    );

    expect(text).toMatch(/crédito/);
    expect(text).toMatch(/faturamento/);
    expect(text).toMatch(/esperar não resolve/);
  });

  it("names the model setting for 404 and 400", () => {
    expect(describeFailure(httpError(404), context)).toContain("OPENAI_MODEL");
    expect(describeFailure(httpError(400), context)).toMatch(/inválida/);
    expect(describeFailure(httpError(403), context)).toMatch(/permiss/);
  });

  it("says how many attempts were made when the retries ran out", () => {
    const exhausted = { retries: 3, maxRetries: 3 };
    const limited = describeFailure(httpError(429), exhausted);
    const down = describeFailure(httpError(503), exhausted);
    const offline = describeFailure(new APIConnectionError({}), exhausted);

    expect(limited).toMatch(/limitando.*4 tentativas/);
    expect(down).toMatch(/status 503.*4 tentativas/);
    expect(offline).toMatch(/conexão.*4 tentativas/);
  });

  it("keeps the message of an LlmResponseError", () => {
    const fatal = new LlmResponseError("refusal", "O modelo se recusou.");
    const transient = new LlmResponseError("interrupted", "Cortada.");

    expect(describeFailure(fatal, context)).toBe("O modelo se recusou.");
    expect(describeFailure(transient, { retries: 3, maxRetries: 3 })).toContain(
      "Cortada.",
    );
  });

  it("shows only a short code, never a long or odd one", () => {
    const error = httpError(500, { code: "server_error" });
    const odd = Object.assign(httpError(500), { code: `x-${KEY}` });

    expect(describeFailure(error, context)).toContain("código server_error");
    expect(describeFailure(odd, context)).not.toContain("código");
  });

  it("shows the code that is behind a connection failure", () => {
    const error = new APIConnectionError({
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      }),
    });

    expect(describeFailure(error, context)).toContain("código ECONNREFUSED");
  });

  it("formats the notice of a new try", () => {
    const cause = { kind: "transient", reason: "connection" } as const;

    expect(
      formatRetryNotice({ retry: 2, maxRetries: 3, delayMs: 2000, cause }),
    ).toBe("Falha de conexão com o provedor. Nova tentativa 2 de 3, em 2 s.");
    expect(
      formatRetryNotice(
        { retry: 1, maxRetries: 3, delayMs: 1500, cause },
        { partialText: true },
      ),
    ).toMatch(
      /interrompida.*descartado.*do zero.*nova tentativa 1 de 3, em 1\.5 s/,
    );
  });
});

describe("module order", () => {
  it("works when errors.ts is imported before client.ts", async () => {
    // The cycle errors <-> client is harmless: the classes are used in functions.
    vi.resetModules();
    const errors = await import("../src/llm/errors.js");
    const client = await import("../src/llm/client.js");

    expect(errors.classifyError(new client.APIUserAbortError()).kind).toBe(
      "cancelled",
    );
    expect(
      errors.classifyError(new client.LlmResponseError("failed", "x")).kind,
    ).toBe("transient");
  });
});
