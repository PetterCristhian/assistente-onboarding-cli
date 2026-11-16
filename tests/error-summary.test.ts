import { APIConnectionError, APIError, AuthenticationError } from "openai";
import { describe, expect, it } from "vitest";
import { summarizeError } from "../src/security/error-summary.js";
import { REDACTED, createRedactor } from "../src/security/redact.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();
const redactor = createRedactor([KEY]);

describe("summarizeError", () => {
  it("keeps only status, code, type, message and request id of an SDK error", () => {
    const sdkError = Object.assign(
      new Error(`401 Incorrect API key provided: ${KEY}.`),
      {
        status: 401,
        code: "invalid_api_key",
        type: "invalid_request_error",
        requestID: "req_123",
        param: null,
        headers: { authorization: `Bearer ${KEY}` },
        error: { message: `Incorrect API key provided: ${KEY}.` },
        request: { headers: { authorization: `Bearer ${KEY}` } },
        response: { body: KEY },
      },
    );

    const summary = summarizeError(sdkError, redactor);
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual({
      status: 401,
      code: "invalid_api_key",
      type: "invalid_request_error",
      message: `401 Incorrect API key provided: ${REDACTED}.`,
      requestId: "req_123",
    });
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("stack");
  });

  it("summarizes a plain Error with its name as type", () => {
    expect(summarizeError(new Error("x"), redactor)).toEqual({
      type: "Error",
      message: "x",
    });
  });

  it("reads the code of the cause when the error has none", () => {
    const error = new Error("Connection error.", {
      cause: { code: "ECONNREFUSED" },
    });

    expect(summarizeError(error, redactor)).toEqual({
      code: "ECONNREFUSED",
      type: "Error",
      message: "Connection error.",
    });
  });

  it("accepts request_id as the request identifier", () => {
    const summary = summarizeError(
      { message: "falhou", request_id: "req_abc" },
      redactor,
    );

    expect(summary).toEqual({ message: "falhou", requestId: "req_abc" });
  });

  it("ignores fields with the wrong type", () => {
    const summary = summarizeError(
      { message: "falhou", status: "500", code: 12, type: {}, requestID: 7 },
      redactor,
    );

    expect(summary).toEqual({ message: "falhou" });
  });

  it("uses a thrown string as the message, redacted", () => {
    expect(summarizeError(`falhou com ${KEY}`, redactor)).toEqual({
      message: `falhou com ${REDACTED}`,
    });
  });

  it.each([null, undefined, 42, {}])(
    "falls back to a generic message for %s",
    (thrown) => {
      expect(summarizeError(thrown, redactor)).toEqual({
        message: "Erro desconhecido.",
      });
    },
  );

  it("truncates a long message to 500 characters", () => {
    const summary = summarizeError(new Error("m".repeat(2000)), redactor);

    expect(summary.message).toHaveLength(500);
  });

  it("redacts before truncating, so a cut key never survives", () => {
    const error = new Error(`${"m".repeat(480)} ${KEY}`);

    const summary = summarizeError(error, redactor);

    expect(summary.message.length).toBeLessThanOrEqual(500);
    expect(summary.message).not.toContain(KEY.slice(0, 10));
  });
});

// Real error classes of the SDK, built without any network call.
describe("summarizeError with errors of the openai SDK", () => {
  const headers = new Headers({
    authorization: `Bearer ${KEY}`,
    "x-request-id": "req_abc123",
  });

  it("summarizes a real 401 without the key, the headers or the body", () => {
    const error = APIError.generate(
      401,
      {
        error: {
          message: `Incorrect API key provided: ${KEY}.`,
          type: "invalid_request_error",
          code: "invalid_api_key",
          param: null,
        },
      },
      undefined,
      headers,
    );

    const summary = summarizeError(error, redactor);
    const serialized = JSON.stringify(summary);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(summary).toEqual({
      status: 401,
      code: "invalid_api_key",
      type: "invalid_request_error",
      message: `401 Incorrect API key provided: ${REDACTED}.`,
      requestId: "req_abc123",
    });
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("authorization");
  });

  // Without a message in the body, the SDK writes the whole body into the
  // message of the error: it still has to come out redacted and bounded.
  it("redacts a body that the SDK copies into the message", () => {
    const error = APIError.generate(
      429,
      { error: { detail: `quota of ${KEY}`, filler: "x".repeat(2000) } },
      undefined,
      headers,
    );

    const summary = summarizeError(error, redactor);

    expect(summary.status).toBe(429);
    expect(summary.message).toContain(REDACTED);
    expect(summary.message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(summary)).not.toContain(KEY);
  });

  it("summarizes a real connection error with the code of its cause", () => {
    const error = new APIConnectionError({
      message: `connection to https://example.invalid/?key=${KEY} failed`,
      cause: Object.assign(new Error(`refused ${KEY}`), {
        code: "ECONNREFUSED",
      }),
    });

    const summary = summarizeError(error, redactor);

    expect(summary.code).toBe("ECONNREFUSED");
    expect(summary.status).toBeUndefined();
    expect(summary.message).toContain(REDACTED);
    expect(JSON.stringify(summary)).not.toContain(KEY);
  });
});
