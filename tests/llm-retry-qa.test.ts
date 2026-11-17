// QA of ENG-51: numbers, edge cases and hostile input. No network, fake key.
import { APIConnectionError, APIError } from "openai";
import { describe, expect, it } from "vitest";
import { createChatSession, type ChatOutput } from "../src/chat/session.js";
import {
  APIUserAbortError,
  LlmResponseError,
  createOpenAiLlmClient,
  type LlmClientConfig,
  type LlmResponseErrorKind,
} from "../src/llm/client.js";
import {
  classifyError,
  describeFailure,
  formatRetryNotice,
} from "../src/llm/errors.js";
import {
  computeDelay,
  defaultSleep,
  retryAfterRefused,
  withRetry,
  type RetryDeps,
  type RetryEvent,
} from "../src/llm/retry.js";
import { createRedactor } from "../src/security/redact.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeOpenAiFetch,
  type FakeFetchStep,
} from "./helpers/fake-openai-fetch.js";
import { makeCritiqueDeps } from "./helpers/critique-fixtures.js";

const KEY = fakeOpenAiKey();

function httpError(
  status: number,
  body: unknown = { message: "x" },
  headers: Record<string, string> = {},
): APIError {
  return APIError.generate(
    status,
    { error: body },
    `${status} msg`,
    new Headers(headers),
  );
}

describe("classification table (ADR 0005)", () => {
  it.each([
    [401, "auth"],
    [403, "permission"],
    [400, "bad_request"],
    [404, "not_found"],
    [422, "unprocessable"],
    [402, "http_status"],
    [413, "http_status"],
    [301, "http_status"],
    [307, "http_status"],
  ])("HTTP %i is fatal (%s)", (status, reason) => {
    expect(classifyError(httpError(status))).toMatchObject({
      kind: "fatal",
      reason,
    });
  });

  it("429 with insufficient_quota anywhere is fatal", () => {
    for (const body of [
      { code: "insufficient_quota" },
      { type: "insufficient_quota" },
    ]) {
      expect(classifyError(httpError(429, body)).kind).toBe("fatal");
    }
    expect(classifyError(httpError(429, { code: "other" })).kind).toBe(
      "rate_limit",
    );
  });

  it("LlmResponseError: only interrupted and failed are retryable", () => {
    const kinds: LlmResponseErrorKind[] = [
      "interrupted",
      "failed",
      "malformed",
      "incomplete",
      "empty",
      "refusal",
      "invalid_output",
    ];
    for (const kind of kinds) {
      const got = classifyError(new LlmResponseError(kind, "m")).kind;
      expect(got).toBe(
        kind === "interrupted" || kind === "failed" ? "transient" : "fatal",
      );
    }
  });

  it("never throws on weird values", () => {
    for (const v of [null, undefined, 1, "x", {}, Symbol("s")]) {
      expect(classifyError(v)).toEqual({ kind: "fatal", reason: "unknown" });
    }
    const trap = (): never => {
      throw new Error("trap");
    };
    const hostile = new Proxy({}, { get: trap, has: trap });
    expect(() => classifyError(hostile)).not.toThrow();
  });
});

describe("backoff numbers", () => {
  const p = { maxRetries: 10, baseDelayMs: 1000 };
  const steps = [1, 2, 3, 4, 5, 6, 7];
  it("random 0 and ~1", () => {
    expect(steps.map((r) => computeDelay(r, p, () => 0))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(steps.map((r) => computeDelay(r, p, () => 0.999999))).toEqual([
      1200, 2400, 4800, 9600, 19200, 30000, 30000,
    ]);
  });
  it("huge base and retry never exceed the ceiling and stay finite", () => {
    for (const base of [
      1e9,
      Number.MAX_SAFE_INTEGER,
      1e308,
      Number.MAX_VALUE,
    ]) {
      for (const r of [1, 50, 2000, 1e6]) {
        expect(
          computeDelay(r, { maxRetries: 1, baseDelayMs: base }, () => 0.9),
        ).toBe(30000);
      }
    }
  });
});

function fixture(over: Partial<RetryDeps> = {}) {
  const sleeps: number[] = [];
  const notices: RetryEvent[] = [];
  const deps: RetryDeps = {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    now: () => 1_000_000,
    classify: classifyError,
    onRetry: (e) => void notices.push(e),
    ...over,
  };
  return { sleeps, notices, deps };
}

async function run(
  errors: Error[],
  maxRetries: number,
  over: Partial<RetryDeps> = {},
) {
  const f = fixture(over);
  let calls = 0;
  const outcome = await withRetry(
    () => {
      const e = errors[calls];
      calls += 1;
      return e === undefined ? Promise.resolve("ok") : Promise.reject(e);
    },
    { maxRetries, baseDelayMs: 1000 },
    f.deps,
  ).then(
    (v) => ({ v, err: undefined as unknown }),
    (err: unknown) => ({ v: undefined, err }),
  );
  return { ...f, calls, ...outcome };
}

describe("withRetry counts", () => {
  it("0 is a single call, 1 is two, and the budget is shared", async () => {
    const e = httpError(503);
    expect((await run([e, e, e], 0)).calls).toBe(1);
    expect((await run([e, e, e], 1)).calls).toBe(2);
    expect((await run([e, e, e, e, e], 3)).calls).toBe(4);
    const mixed = await run(
      [httpError(429), httpError(503), httpError(429), httpError(503)],
      3,
    );
    expect(mixed.calls).toBe(4);
    expect(mixed.sleeps).toEqual([1000, 2000, 4000]);
  });
  it("a large budget recovers and the ceiling holds", async () => {
    const errs = Array.from({ length: 20 }, () => httpError(500));
    const r = await run(errs, 100);
    expect(r.v).toBe("ok");
    expect(Math.max(...r.sleeps)).toBe(30000);
    expect(r.sleeps.length).toBe(20);
  });
  it("fatal statuses call exactly once", async () => {
    for (const s of [400, 401, 403, 404, 422, 402, 413]) {
      expect((await run([httpError(s), httpError(s)], 5)).calls).toBe(1);
    }
    expect(
      (await run([httpError(429, { code: "insufficient_quota" })], 5)).calls,
    ).toBe(1);
  });
});

describe("retry-after", () => {
  const rl = (headers: Record<string, string>) =>
    httpError(429, undefined, headers);
  it.each([
    [{ "retry-after-ms": "2500" }, 2500],
    [{ "retry-after": "3" }, 3000],
    [{ "retry-after": "1.5" }, 1500],
    [{ "retry-after": "0" }, 0],
    [{ "retry-after-ms": "0" }, 0],
    [{ "retry-after-ms": "100", "retry-after": "20" }, 100],
    [{ "retry-after": "30" }, 30000],
    [{ "retry-after": "garbage" }, 1000],
    [{ "retry-after": "-5" }, 1000],
    [{ "retry-after": "Infinity" }, 1000],
    [{ "retry-after": "NaN" }, 1000],
    [{ "retry-after": "" }, 1000],
    [{ "retry-after": "1e2" }, 1000],
    [{ "retry-after": "1e9" }, 1000],
    [{ "retry-after-ms": "bad", "retry-after": "2" }, 2000],
    [{ "retry-after": "Thu, 01 Jan 1970 00:16:45 GMT" }, 5000],
    [{ "retry-after": "Thu, 01 Jan 1970 00:00:01 GMT" }, 1000],
  ])("%j waits %i ms", async (headers, expected) => {
    const r = await run([rl(headers)], 3, { now: () => 1_000_000 });
    expect(r.v).toBe("ok");
    expect(r.sleeps).toEqual([expected]);
  });

  it.each<Record<string, string>>([
    { "retry-after": "31" },
    { "retry-after": "999999999999999999999" },
    { "retry-after-ms": "30001" },
    { "retry-after": "Fri, 01 Jan 2100 00:00:00 GMT" },
  ])("%j gives up at once with the original error", async (headers) => {
    const e = rl(headers);
    const r = await run([e, e], 3);
    expect(r.calls).toBe(1);
    expect(r.err).toBe(e);
    expect(r.sleeps).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(retryAfterRefused(e)).toBeGreaterThan(30000);
    expect(describeFailure(e, { retries: 0, maxRetries: 3 })).toMatch(
      /pediu para aguardar/,
    );
  });

  it("the refused wait does not leak to other errors or primitives", async () => {
    const refused = rl({ "retry-after": "99" });
    await run([refused], 3);
    const other = rl({});
    expect(retryAfterRefused(other)).toBeUndefined();
    expect(retryAfterRefused(null)).toBeUndefined();
    expect(retryAfterRefused("x")).toBeUndefined();
    const ex = await run([other, other, other, other], 3);
    expect(retryAfterRefused(ex.err)).toBeUndefined();
    expect(describeFailure(ex.err, { retries: 3, maxRetries: 3 })).toMatch(
      /continua limitando/,
    );
  });
});

describe("messages never carry secrets or the provider body", () => {
  const hostile = [
    `Incorrect API key provided: ${KEY}`,
    "\u001b]0;pwned\u0007\u001b[2J",
    "Bearer abc authorization: x-api-key",
    "<html><body>502 Bad Gateway</body></html>",
  ];
  it("describeFailure ignores error.message for APIError of every status", () => {
    for (const status of [400, 401, 403, 404, 422, 429, 500, 503, 402, 301]) {
      for (const text of hostile) {
        const e = APIError.generate(
          status,
          { error: { message: text, code: text, type: text } },
          text,
          new Headers({ "x-secret": KEY, authorization: `Bearer ${KEY}` }),
        );
        const out = describeFailure(e, { retries: 3, maxRetries: 3 });
        expect(out).not.toContain(KEY);
        expect(out).not.toMatch(
          /Bearer|authorization|x-api-key|pwned|<html|\u001b/i,
        );
      }
    }
  });
  it("extreme values do not break the formatters", () => {
    const cause = {
      kind: "transient",
      reason: "http_status",
      status: 503,
    } as const;
    for (const delayMs of [-1, 0, NaN, Infinity, 1e300, 2 ** 53]) {
      for (const retry of [-1, 0, NaN, 1e9]) {
        const text = formatRetryNotice({
          retry,
          maxRetries: -3,
          delayMs,
          cause,
        });
        expect(text).not.toMatch(/undefined|\[object/);
      }
    }
    for (const status of [NaN, Infinity, -1, 1.5, 0, "503", null]) {
      const e = new APIConnectionError({});
      (e as unknown as { status: unknown }).status = status;
      const text = describeFailure(e, { retries: -2, maxRetries: NaN });
      expect(text).not.toMatch(/NaN|undefined/);
    }
  });
});

describe("session with the real client and a hostile provider", () => {
  const config: LlmClientConfig = {
    openaiApiKey: KEY,
    openaiModel: "m",
    openaiReasoningEffort: "low",
    requestTimeoutMs: 5000,
    retryMaxAttempts: 1,
    retryBaseDelayMs: 1,
  };
  async function show(step: FakeFetchStep) {
    const fake = createFakeOpenAiFetch([step, step, step]);
    const client = createOpenAiLlmClient(config, {
      fetch: fake.fetch,
      retry: { sleep: () => Promise.resolve() },
    });
    const events: string[] = [];
    const output: ChatOutput = {
      chunk: (t) => void events.push(`chunk:${t}`),
      endAnswer: () => void events.push("end"),
      retraction: (text) => void events.push(`retraction:${text}`),
      notice: (l, t) => void events.push(`${l}:${t}`),
    };
    const session = createChatSession({
      llm: client,
      instructions: "i",
      critique: makeCritiqueDeps(),
      output,
      redact: createRedactor([KEY]),
    });
    const r = await session.ask("q");
    return { events, r, history: session.history, calls: fake.requests.length };
  }
  const bodies: Array<[string, string]> = [
    [
      "key",
      JSON.stringify({
        error: { message: `bad ${KEY}`, code: KEY, type: KEY },
      }),
    ],
    [
      "ansi",
      JSON.stringify({
        error: {
          message: "\u001b]0;pwned\u0007\u001b[2J",
          code: "\u001b[31mred",
          type: "t",
        },
      }),
    ],
    ["big", "x".repeat(1_000_000)],
    ["invalid-json", "{not json"],
    ["html", "<html><h1>Bad Gateway</h1></html>"],
  ];
  for (const status of [401, 403, 400, 404, 422, 429, 500, 503, 402]) {
    for (const [name, raw] of bodies) {
      it(`status ${status} body ${name}`, async () => {
        const { events, r, history, calls } = await show({
          kind: "raw",
          status,
          contentType: name === "html" ? "text/html" : "application/json",
          parts: [raw],
        });
        const all = events.join("\n");
        expect(r.status).toBe("failed");
        expect(history).toEqual([]);
        const retried = status === 429 || status >= 500;
        expect(calls).toBe(retried ? 2 : 1);
        expect(all).not.toContain(KEY);
        expect(all).not.toMatch(
          /Bearer|authorization|x-api-key|pwned|Bad Gateway|\u001b|xxxxxxxx/i,
        );
        expect(all.length).toBeLessThan(2000);
      });
    }
  }
});

describe("non-API errors with the key in the message", () => {
  it("hides the exact and the simply encoded forms", async () => {
    const b64 = Buffer.from(KEY).toString("base64");
    const forms = [
      `fail ${KEY}`,
      `fail ${b64}`,
      `fail ${encodeURIComponent(KEY)}`,
    ];
    for (const message of forms) {
      const events: string[] = [];
      const session = createChatSession({
        llm: {
          streamText: () => Promise.reject(new Error(message)),
          generateStructured: () => Promise.reject(new Error(message)),
        },
        instructions: "i",
        critique: makeCritiqueDeps(),
        output: {
          chunk: () => undefined,
          endAnswer: () => undefined,
          retraction: () => undefined,
          notice: (l, t) => void events.push(`${l}:${t}`),
        },
        redact: createRedactor([KEY]),
      });
      await session.ask("q");
      const all = events.join("\n");
      expect(all).not.toContain(KEY);
    }
  });
});

describe("abort and timers", () => {
  const base: LlmClientConfig = {
    openaiApiKey: KEY,
    openaiModel: "m",
    openaiReasoningEffort: "low",
    requestTimeoutMs: 5000,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 60_000,
  };
  it("defaultSleep releases its timer when the signal aborts", async () => {
    const c = new AbortController();
    const p = defaultSleep(60_000, c.signal);
    c.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    await expect(defaultSleep(1, c.signal)).rejects.toThrow("stop");
  });
  it("abort during the wait ends at once with APIUserAbortError", async () => {
    const step: FakeFetchStep = {
      kind: "json",
      status: 503,
      body: { error: { message: "x" } },
    };
    const fake = createFakeOpenAiFetch([step, step]);
    const c = new AbortController();
    const client = createOpenAiLlmClient(base, { fetch: fake.fetch });
    const t0 = Date.now();
    const p = client.streamText({
      instructions: "i",
      input: [{ role: "user", content: "q" }],
      signal: c.signal,
      onChunk: () => undefined,
      onRetry: () => queueMicrotask(() => c.abort()),
    });
    await expect(p).rejects.toBeInstanceOf(APIUserAbortError);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fake.requests).toHaveLength(1);
  });
  it("a signal already aborted makes no request", async () => {
    const fake = createFakeOpenAiFetch([]);
    const c = new AbortController();
    c.abort();
    const client = createOpenAiLlmClient(base, { fetch: fake.fetch });
    await expect(
      client.streamText({
        instructions: "i",
        input: [{ role: "user", content: "q" }],
        signal: c.signal,
        onChunk: () => undefined,
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
    expect(fake.requests).toHaveLength(0);
  });
});
