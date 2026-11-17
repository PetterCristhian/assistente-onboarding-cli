// The scenarios of the demonstration and the guard of its `fetch`.
import { describe, expect, it } from "vitest";
import type { DemoTiming } from "../scripts/demo-falhas/config.js";
import {
  LOOPBACK_REFUSED_MESSAGE,
  createLoopbackFetch,
  type CallCounter,
} from "../scripts/demo-falhas/loopback-fetch.js";
import { buildScenarios } from "../scripts/demo-falhas/scenarios.js";
import type { StubStep } from "../scripts/demo-falhas/stub-server.js";

describe("buildScenarios", () => {
  const timing: DemoTiming = {
    maxRetries: 3,
    baseDelayMs: 100,
    retryAfterSeconds: 1,
    requestTimeoutMs: 5000,
  };

  it("has the five scenarios, in order, each with its own path", () => {
    const scenarios = buildScenarios(timing);

    expect(scenarios.map((scenario) => scenario.number)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "cenario-1",
      "cenario-2",
      "cenario-3",
      "cenario-4",
      "cenario-5",
    ]);
  });

  it("expects the waits worked out on their own: 1000, 100 and 100, 200, 400", () => {
    const [one, two, three, four, five] = buildScenarios(timing);

    expect(one?.expected.waitsMs).toEqual([1000]);
    expect(one?.expected.waitSource).toBe("retry-after");
    expect(two?.expected.waitsMs).toEqual([100]);
    expect(two?.expected.waitSource).toBe("backoff");
    expect(three?.expected.waitsMs).toEqual([100, 200, 400]);
    expect(four?.expected.waitsMs).toEqual([]);
    expect(four?.expected.waitSource).toBe("none");
    expect(five?.expected.waitsMs).toEqual([100, 200, 400]);
  });

  it("follows the timing it is given", () => {
    const [one, , three] = buildScenarios({
      maxRetries: 2,
      baseDelayMs: 7,
      retryAfterSeconds: 0,
      requestTimeoutMs: 5000,
    });

    expect(one?.expected.waitsMs).toEqual([0]);
    expect(three?.expected.waitsMs).toEqual([7, 14]);
    expect(three?.expected.calls).toBe(3);
  });

  it("makes scenario 3 end after 1 + maxRetries calls, all of them answered with 500", () => {
    const three = buildScenarios(timing)[2];
    const steps = three?.steps as readonly StubStep[];

    expect(three?.expected.calls).toBe(4);
    expect(steps).toHaveLength(4);
    expect(steps.every((step) => step.status === 500)).toBe(true);
    expect(three?.expected.messageIncludes).toBe(
      "Desisti depois de 4 tentativas",
    );
  });

  it("scripts the 429 with the header in scenario 1 and without it in scenario 2", () => {
    const [one, two] = buildScenarios(timing);
    const first = (one?.steps as readonly StubStep[])[0];
    const second = (two?.steps as readonly StubStep[])[0];

    expect(first?.status).toBe(429);
    expect(first?.headers).toEqual({ "Retry-After": "1" });
    expect(second?.status).toBe(429);
    expect(second?.headers).toBeUndefined();
  });

  it("gives scenario 4 one 401 and no new try, and scenario 5 no server", () => {
    const [, , , four, five] = buildScenarios(timing);

    expect(four?.steps).toEqual([
      { status: 401, body: { code: "invalid_api_key" } },
    ]);
    expect(four?.expected.calls).toBe(1);
    expect(five?.steps).toBe("closed-port");
    expect(five?.expected.status).toBeUndefined();
    expect(five?.expected.calls).toBe(4);
  });
});

describe("createLoopbackFetch", () => {
  function setup() {
    const seen: string[] = [];
    const base: typeof fetch = (input) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response("ok"));
    };
    const counter: CallCounter = { calls: 0 };
    return { seen, counter, guarded: createLoopbackFetch(base, counter) };
  }

  it.each([
    "https://127.0.0.1:1234/x",
    "http://localhost:1234/x",
    "http://192.0.2.1/x",
    "http://127.0.0.2:1234/x",
    "https://api.openai.com/v1/responses",
    "ftp://127.0.0.1/x",
    "isto não é uma URL",
  ])("refuses %s and counts nothing", async (url) => {
    const { seen, counter, guarded } = setup();

    await expect(guarded(url)).rejects.toThrow(LOOPBACK_REFUSED_MESSAGE);
    expect(seen).toEqual([]);
    expect(counter.calls).toBe(0);
  });

  it("refuses a URL given as a URL object or a Request too", async () => {
    const { counter, guarded } = setup();

    await expect(guarded(new URL("https://api.openai.com/v1"))).rejects.toThrow(
      LOOPBACK_REFUSED_MESSAGE,
    );
    await expect(
      guarded(new Request("http://localhost:1234/x")),
    ).rejects.toThrow(LOOPBACK_REFUSED_MESSAGE);
    expect(counter.calls).toBe(0);
  });

  it("lets 127.0.0.1 through and counts each call", async () => {
    const { seen, counter, guarded } = setup();

    await guarded("http://127.0.0.1:1234/a");
    await guarded(new URL("http://127.0.0.1:1234/b"));
    await guarded(new Request("http://127.0.0.1:1234/c"));

    expect(counter.calls).toBe(3);
    expect(seen).toEqual([
      "http://127.0.0.1:1234/a",
      "http://127.0.0.1:1234/b",
      "http://127.0.0.1:1234/c",
    ]);
  });
});
