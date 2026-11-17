// QA edge cases of the failure demonstration (ENG-54): the loopback-only
// fetch, a hostile provider that quotes the key, and a refused port that is
// taken by another listener. Everything stays on 127.0.0.1 or in fake fetches.
import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import {
  DEMO_API_KEY,
  DEMO_TIMING,
  demoClientConfig,
} from "../scripts/demo-falhas/config.js";
import {
  LOOPBACK_REFUSED_MESSAGE,
  createLoopbackFetch,
  type CallCounter,
} from "../scripts/demo-falhas/loopback-fetch.js";
import { runScenario } from "../scripts/demo-falhas/observe.js";
import { compare, formatScenarioBlock } from "../scripts/demo-falhas/report.js";
import { buildScenarios } from "../scripts/demo-falhas/scenarios.js";
import {
  findRefusedPort,
  isPortRefused,
} from "../scripts/demo-falhas/stub-server.js";

function spyFetch(): { fetch: typeof fetch; reached: string[] } {
  const reached: string[] = [];
  const base: typeof fetch = (input) => {
    reached.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { fetch: base, reached };
}

describe("createLoopbackFetch: what is refused", () => {
  const refused = [
    "http://localhost:1234/v1",
    "http://[::1]:1234/v1",
    "http://127.0.0.2:1234/v1",
    "http://127.0.0.1.example.invalid/v1",
    "http://127.0.0.1@example.invalid/v1",
    "http://127.0.0.1:80@example.invalid/v1",
    "https://127.0.0.1:1234/v1",
    "https://api.openai.com/v1",
    "ftp://127.0.0.1/v1",
    "not a url",
    "",
  ];

  it.each(refused)("refuses %j before any request is made", async (url) => {
    const spy = spyFetch();
    const counter: CallCounter = { calls: 0 };
    const guarded = createLoopbackFetch(spy.fetch, counter);

    await expect(guarded(url)).rejects.toThrow(LOOPBACK_REFUSED_MESSAGE);
    expect(spy.reached).toEqual([]);
    expect(counter.calls).toBe(0);
  });

  it("lets 127.0.0.1 through, also as a Request and as a URL, and counts it", async () => {
    const spy = spyFetch();
    const counter: CallCounter = { calls: 0 };
    const guarded = createLoopbackFetch(spy.fetch, counter);

    await guarded("http://127.0.0.1:9/a");
    await guarded(new URL("http://127.0.0.1:9/b"));
    await guarded(new Request("http://127.0.0.1:9/c"));
    // The decimal form is normalised by URL to the same literal address.
    await guarded("http://2130706433:9/d");

    expect(counter.calls).toBe(4);
    expect(spy.reached).toHaveLength(4);
  });
});

describe("a hostile provider that quotes the key", () => {
  const hostileFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            message: `Incorrect API key provided: ${DEMO_API_KEY}. Authorization: Bearer ${DEMO_API_KEY}`,
            type: "invalid_request_error",
            code: `${DEMO_API_KEY}`,
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "x-leak": DEMO_API_KEY,
            "set-cookie": `session=${DEMO_API_KEY}`,
          },
        },
      ),
    );

  it("never reaches the observation, the block or the summary", async () => {
    const [, , , spec] = buildScenarios(DEMO_TIMING);
    if (spec === undefined) {
      throw new Error("scenario 4 missing");
    }
    const counter: CallCounter = { calls: 0 };
    const client = createOpenAiLlmClient(demoClientConfig(DEMO_TIMING), {
      baseURL: "http://127.0.0.1:9/cenario-4/v1",
      fetch: createLoopbackFetch(hostileFetch, counter),
      retry: { random: () => 0, sleep: () => Promise.resolve() },
    });

    const observed = await runScenario(spec, {
      client,
      timing: DEMO_TIMING,
      counter,
      realWaits: [],
    });
    const block = formatScenarioBlock(spec, observed, compare(spec, observed));

    expect(observed.outcome).toBe("failure");
    expect(JSON.stringify(observed)).not.toContain(DEMO_API_KEY);
    expect(block).not.toContain(DEMO_API_KEY);
    expect(block).not.toContain("x-leak");
    expect(block).not.toContain("session=");
    expect(block).not.toContain("Incorrect API key");
  });

  it("never waits more than the ceiling for an absurd Retry-After", async () => {
    const [first] = buildScenarios(DEMO_TIMING);
    if (first === undefined) {
      throw new Error("scenario 1 missing");
    }
    const waits: number[] = [];
    let served = 0;
    const absurd: typeof fetch = () => {
      served += 1;
      return Promise.resolve(
        served === 1
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "99999999999" },
            })
          : new Response("{}", { status: 500 }),
      );
    };
    const counter: CallCounter = { calls: 0 };
    const client = createOpenAiLlmClient(demoClientConfig(DEMO_TIMING), {
      baseURL: "http://127.0.0.1:9/cenario-1/v1",
      fetch: createLoopbackFetch(absurd, counter),
      retry: {
        random: () => 0,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    });

    await runScenario(first, {
      client,
      timing: DEMO_TIMING,
      counter,
      realWaits: [],
    });

    // Either it waits no more than the ceiling or it gives up with no wait.
    for (const ms of waits) {
      expect(ms).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("the port of the refused-connection scenario", () => {
  it("is not trusted when another listener took it: findRefusedPort finds another", async () => {
    const occupant: Server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) =>
      occupant.listen(0, "127.0.0.1", resolve),
    );
    const taken = (occupant.address() as { port: number }).port;
    try {
      expect(await isPortRefused(taken)).toBe(false);
      const other = await findRefusedPort();
      expect(other).toBeDefined();
      expect(other).not.toBe(taken);
      expect(await isPortRefused(other as number)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    }
  });

  it("gives up with undefined when every attempt is zero", async () => {
    expect(await findRefusedPort(0)).toBeUndefined();
  });
});
