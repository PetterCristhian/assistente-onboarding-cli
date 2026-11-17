// The simulated provider of the demonstration, with real HTTP on 127.0.0.1:
// nothing leaves the machine and no real key is involved.
import { Agent, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiLlmClient } from "../src/llm/client.js";
import {
  DEMO_API_KEY,
  DEMO_TIMING,
  demoClientConfig,
} from "../scripts/demo-falhas/config.js";
import {
  isPortRefused,
  startStubServer,
  type StubServer,
} from "../scripts/demo-falhas/stub-server.js";

const servers: StubServer[] = [];

async function start(): Promise<StubServer> {
  const server = await startStubServer(DEMO_API_KEY);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function post(
  url: string,
  key: string | undefined = DEMO_API_KEY,
): Promise<Response> {
  return fetch(`${url}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
    body: "{}",
  });
}

describe("startStubServer", () => {
  it("listens only on 127.0.0.1, on a free port", async () => {
    const server = await start();

    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    expect(server.baseUrlFor("cenario-1")).toBe(
      `http://127.0.0.1:${server.port}/cenario-1/v1`,
    );
  });

  it("takes a different port each time it starts", async () => {
    const first = await start();
    const second = await start();

    expect(second.port).not.toBe(first.port);
  });

  it("answers each path from its own script, in order", async () => {
    const server = await start();
    server.script("cenario-1", [
      { status: 429, headers: { "Retry-After": "1" }, body: { code: "x" } },
      { status: 200, body: "success" },
    ]);
    server.script("cenario-2", [{ status: 401, body: { code: "y" } }]);

    const second = await post(server.baseUrlFor("cenario-2"));
    const first = await post(server.baseUrlFor("cenario-1"));
    const third = await post(server.baseUrlFor("cenario-1"));

    expect(second.status).toBe(401);
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("1");
    expect(third.status).toBe(200);
    expect(third.headers.get("content-type")).toBe("text/event-stream");
    expect(server.stats("cenario-1")).toEqual({
      requests: 2,
      withDemoKey: 2,
      unexpected: 0,
    });
    expect(server.stats("cenario-2").requests).toBe(1);
  });

  it("answers 500 and counts it as unexpected when the script is spent", async () => {
    const server = await start();
    server.script("cenario-1", [{ status: 200, body: "success" }]);

    await (await post(server.baseUrlFor("cenario-1"))).text();
    const extra = await post(server.baseUrlFor("cenario-1"));
    await extra.text();

    expect(extra.status).toBe(500);
    expect(server.stats("cenario-1")).toMatchObject({
      requests: 2,
      unexpected: 1,
    });
  });

  it("answers 500 and counts as unexpected a path with no script", async () => {
    const server = await start();
    server.script("cenario-1", []);

    const stray = await post(server.baseUrlFor("desconhecido"));
    await stray.text();

    expect(stray.status).toBe(500);
    expect(server.stats("cenario-1").unexpected).toBe(1);
  });

  it("tells a request with the key from one without it, and never echoes the key", async () => {
    const server = await start();
    server.script("cenario-1", [
      { status: 401, body: { code: "invalid_api_key" } },
      { status: 401, body: { code: "invalid_api_key" } },
    ]);

    const withKey = await post(server.baseUrlFor("cenario-1"));
    const bodyWithKey = await withKey.text();
    const without = await post(server.baseUrlFor("cenario-1"), "outra-chave");
    const bodyWithout = await without.text();

    expect(server.stats("cenario-1")).toMatchObject({
      requests: 2,
      withDemoKey: 1,
    });
    for (const body of [bodyWithKey, bodyWithout]) {
      expect(body).not.toContain(DEMO_API_KEY);
      expect(JSON.parse(body)).toEqual({
        error: {
          message: "Erro simulado.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });
    }
  });

  it("is read to its end by the real client, as a streamed answer", async () => {
    const server = await start();
    server.script("cenario-1", [{ status: 200, body: "success" }]);
    const client = createOpenAiLlmClient(demoClientConfig(DEMO_TIMING), {
      baseURL: server.baseUrlFor("cenario-1"),
    });
    const chunks: string[] = [];

    const result = await client.streamText({
      instructions: "x",
      input: [{ role: "user", content: "y" }],
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe("Resposta simulada do provedor local.");
    expect(result.model).toBe("modelo-simulado");
    expect(chunks.join("")).toBe(result.text);
  });

  it("closes even with a keep-alive connection open, and then refuses connections", async () => {
    const server = await start();
    server.script("cenario-1", [{ status: 200, body: "success" }]);
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/cenario-1/v1/responses",
          method: "POST",
          agent,
        },
        (response) => {
          response.resume();
          response.on("end", resolve);
        },
      );
      outgoing.on("error", reject);
      outgoing.end("{}");
    });
    expect(server.openConnections()).toBeGreaterThan(0);

    await server.stop();
    agent.destroy();

    expect(server.openConnections()).toBe(0);
    expect(await isPortRefused(server.port)).toBe(true);
  });

  it("can be stopped twice", async () => {
    const server = await start();

    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

describe("isPortRefused", () => {
  it("is false while something listens, and true when nothing does", async () => {
    const server = await start();
    expect(await isPortRefused(server.port)).toBe(false);

    await server.stop();
    expect(await isPortRefused(server.port)).toBe(true);
  });

  it("is true for a port that was just released", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const address = listener.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => listener.close(() => resolve()));

    expect(await isPortRefused(port)).toBe(true);
  });
});
