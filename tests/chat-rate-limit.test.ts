import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildContext } from "../src/context/builder.js";
import { loadContextLayers } from "../src/context/loaders.js";
import {
  createRateLimiter,
  type RateLimiter,
} from "../src/chat/rate-limiter.js";
import { createChatSession, type ChatOutput } from "../src/chat/session.js";
import { runChat } from "../src/cli/chat-loop.js";
import { createTerminalOutput } from "../src/cli/renderer.js";
import { LlmResponseError, type LlmClient } from "../src/llm/client.js";
import { createRedactor } from "../src/security/redact.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const layers = loadContextLayers({}, { now: () => new Date(2025, 0, 6) });
const context = buildContext(layers);

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

/** A clock and a sleep that the test drives; sleeping moves the clock. */
function fakeTime() {
  let current = 0;
  const sleeps: number[] = [];
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
    sleeps,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}

function setup(
  script: readonly FakeLlmStep[],
  options: {
    max?: number;
    windowSeconds?: number;
    mode?: "refuse" | "wait";
    limiter?: RateLimiter;
    llm?: LlmClient;
  } = {},
) {
  const time = fakeTime();
  const limiter =
    options.limiter ??
    createRateLimiter({
      maxRequests: options.max ?? 2,
      windowSeconds: options.windowSeconds ?? 60,
      now: time.now,
      sleep: time.sleep,
    });
  const fake = createFakeLlmClient(script);
  const output = recorder();
  const session = createChatSession({
    llm: options.llm ?? fake,
    instructions: context.text,
    output,
    redact: createRedactor([]),
    rateLimit: { limiter, mode: options.mode ?? "refuse" },
  });
  return { time, limiter, fake, output, session };
}

describe("chat session with the local rate limit: refuse", () => {
  it("answers up to the limit and refuses the next question", async () => {
    const { session, fake, output, time } = setup(
      [{ text: "R1" }, { text: "R2" }],
      { max: 2, windowSeconds: 60 },
    );
    time.set(1000);
    await session.ask("P1");
    time.set(2000);
    await session.ask("P2");
    time.set(23_000);
    const eventsBefore = output.events.length;

    const result = await session.ask("P3");

    // The oldest slot (taken at 1 s) frees at 61 s: 38 s from now.
    expect(result).toEqual({ status: "rate_limited", waitSeconds: 38 });
    expect(fake.calls).toHaveLength(2);
    expect(output.events.slice(eventsBefore)).toEqual([
      "warning:Limite de perguntas atingido (2 perguntas a cada 60 s). Aguarde 38 segundos e envie de novo.",
    ]);
  });

  it("keeps the history intact when a question is refused", async () => {
    const { session } = setup([{ text: "R1" }], { max: 1 });
    await session.ask("P1");
    const before = session.history;

    await session.ask("P2");

    expect(session.history).toEqual(before);
    expect(session.history).toHaveLength(2);
  });

  it("rounds the wait up and never shows 0 seconds", async () => {
    const { session, time } = setup([{ text: "R1" }], {
      max: 1,
      windowSeconds: 60,
    });
    await session.ask("P1");

    time.set(58_999);
    expect(await session.ask("P2")).toEqual({
      status: "rate_limited",
      waitSeconds: 2,
    });

    time.set(59_999);
    expect(await session.ask("P2")).toEqual({
      status: "rate_limited",
      waitSeconds: 1,
    });
  });

  it("accepts questions again after the window", async () => {
    const { session, fake, time } = setup([{ text: "R1" }, { text: "R2" }], {
      max: 1,
      windowSeconds: 10,
    });
    await session.ask("P1");
    expect((await session.ask("P2")).status).toBe("rate_limited");

    time.set(10_000);
    const result = await session.ask("P2");

    expect(result).toMatchObject({ status: "answered", text: "R2" });
    expect(fake.calls).toHaveLength(2);
    expect(session.history.map((turn) => turn.content)).toEqual([
      "P1",
      "R1",
      "P2",
      "R2",
    ]);
  });

  it("sends the history without the refused question afterwards", async () => {
    const { session, fake, time } = setup([{ text: "R1" }, { text: "R2" }], {
      max: 1,
      windowSeconds: 10,
    });
    await session.ask("P1");
    await session.ask("recusada");
    time.set(10_000);
    await session.ask("P3");

    const last = fake.calls.at(-1);
    expect(JSON.stringify(last?.request.input)).not.toContain("recusada");
  });

  it("does not give the slot back to a turn that fails", async () => {
    const { session } = setup([{ error: new Error("falha") }], { max: 1 });

    expect((await session.ask("P1")).status).toBe("failed");

    expect((await session.ask("P2")).status).toBe("rate_limited");
  });

  it("does not give the slot back to a turn that fails after some text", async () => {
    const { session } = setup(
      [
        {
          chunks: ["parte"],
          error: new LlmResponseError("interrupted", "cortada", "m"),
        },
      ],
      { max: 1 },
    );

    expect((await session.ask("P1")).status).toBe("failed");

    expect((await session.ask("P2")).status).toBe("rate_limited");
  });

  it("does not give the slot back to a turn that is cancelled", async () => {
    const controller = new AbortController();
    const { session } = setup([{ text: "R", wait: () => controller.abort() }], {
      max: 1,
    });

    expect(await session.ask("P1", { signal: controller.signal })).toEqual({
      status: "cancelled",
    });

    expect((await session.ask("P2")).status).toBe("rate_limited");
  });

  it("does not take a second slot for the retries of one call", async () => {
    const acquire = vi.fn(() => Promise.resolve({ allowed: true } as const));
    const limiter: RateLimiter = {
      maxRequests: 5,
      windowSeconds: 60,
      tryAcquire: () => ({ allowed: true }),
      acquire,
    };
    const llm: LlmClient = {
      streamText: (request) => {
        for (const retry of [1, 2]) {
          request.onRetry?.({
            retry,
            maxRetries: 3,
            delayMs: 1000,
            cause: { kind: "transient", reason: "timeout" },
          });
        }
        request.onChunk?.("R");
        return Promise.resolve({ text: "R", model: "m", chunks: 1 });
      },
      generateStructured: () => Promise.reject(new Error("not used")),
    };
    const { session } = setup([], { limiter, llm });

    expect((await session.ask("P1")).status).toBe("answered");

    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("does not take a slot for a turn rejected as busy", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, limiter } = setup([{ text: "R1", wait: held }], {
      max: 2,
    });
    const first = session.ask("P1");

    await expect(session.ask("P2")).rejects.toThrow("turno em andamento");
    release();
    await first;

    expect(limiter.tryAcquire()).toEqual({ allowed: true });
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it("behaves as before without a limiter", async () => {
    const fake = createFakeLlmClient([
      { text: "R1" },
      { text: "R2" },
      { text: "R3" },
    ]);
    const output = recorder();
    const session = createChatSession({
      llm: fake,
      instructions: context.text,
      output,
      redact: createRedactor([]),
    });

    for (const question of ["P1", "P2", "P3"]) {
      expect((await session.ask(question)).status).toBe("answered");
    }

    expect(fake.calls).toHaveLength(3);
    expect(output.events.some((event) => event.startsWith("warning:"))).toBe(
      false,
    );
  });
});

describe("chat session with the local rate limit: wait", () => {
  it("waits for the slot and answers the third question", async () => {
    const { session, fake, output, time } = setup(
      [{ text: "R1" }, { text: "R2" }, { text: "R3" }],
      { max: 2, windowSeconds: 60, mode: "wait" },
    );
    await session.ask("P1");
    await session.ask("P2");

    const result = await session.ask("P3");

    expect(result).toMatchObject({ status: "answered", text: "R3" });
    expect(fake.calls).toHaveLength(3);
    expect(time.sleeps).toEqual([60_000]);
    expect(output.events).toContain(
      "info:Aguardando 60 s para respeitar o limite de perguntas.",
    );
    expect(output.events.some((event) => event.startsWith("warning:"))).toBe(
      false,
    );
  });

  it("does not warn when there is no need to wait", async () => {
    const { session, output } = setup([{ text: "R1" }], { mode: "wait" });

    await session.ask("P1");

    expect(output.events.some((event) => event.startsWith("info:"))).toBe(
      false,
    );
  });

  it("ends as cancelled when the signal aborts during the wait, taking no slot", async () => {
    const controller = new AbortController();
    const limiter = (() => {
      const time = fakeTime();
      return createRateLimiter({
        maxRequests: 1,
        windowSeconds: 60,
        now: time.now,
        // Aborts while the turn sleeps, as Ctrl+C would.
        sleep: () => {
          controller.abort();
          return Promise.reject(new DOMException("aborted", "AbortError"));
        },
      });
    })();
    const { session, fake } = setup([], { limiter, mode: "wait" });
    limiter.tryAcquire(); // the only slot is taken

    const result = await session.ask("P1", { signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(fake.calls).toHaveLength(0);
    expect(session.history).toEqual([]);
  });

  it("ends as cancelled, with no slot taken, when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { session, limiter, fake } = setup([], { mode: "wait" });

    const result = await session.ask("P1", { signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(fake.calls).toHaveLength(0);
    expect(limiter.tryAcquire()).toEqual({ allowed: true });
  });
});

function collect(stream: PassThrough): () => string {
  let text = "";
  stream.on("data", (data: Buffer) => {
    text += data.toString("utf8");
  });
  return () => text;
}

/** The chat loop over streams, with a limiter whose clock never moves. */
function setupLoop(script: readonly FakeLlmStep[], max: number) {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const fake = createFakeLlmClient(script);
  const session = createChatSession({
    llm: fake,
    instructions: context.text,
    output: createTerminalOutput(stdout, stderr),
    redact: createRedactor([]),
    rateLimit: {
      limiter: createRateLimiter({
        maxRequests: max,
        windowSeconds: 60,
        now: () => 0,
        sleep: () => Promise.reject(new Error("must not sleep")),
      }),
      mode: "refuse",
    },
  });
  const done = runChat({
    input,
    stdout,
    stderr,
    session,
    contextText: context.text,
    profileName: layers.userProfile.nome,
  });
  return { input, fake, out, err, done };
}

describe("chat loop with the local rate limit", () => {
  it("does not count commands nor empty lines", async () => {
    const { input, fake, out, err, done } = setupLoop([{ text: "R1" }], 1);
    input.write("/ajuda\n");
    input.write("/contexto\n");
    input.write("/limpar\n");
    input.write("/comando-desconhecido\n");
    input.write("\n");
    input.write("   \n");
    input.write("P1\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(out()).toContain("R1\n");
    expect(err()).not.toContain("Limite de perguntas");
  });

  it("drops the excess lines of a pasted batch, tells about each and goes on", async () => {
    const { input, fake, out, err, done } = setupLoop(
      [{ text: "R1" }, { text: "R2" }],
      2,
    );
    input.write("P1\nP2\nP3\nP4\n");
    input.end();

    expect(await done).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(out()).toContain("R1\n");
    expect(out()).toContain("R2\n");
    expect(err().match(/Limite de perguntas atingido/g)).toHaveLength(2);
    expect(err()).toContain("Aguarde 60 segundos");
  });

  it("keeps the chat open after a refusal", async () => {
    const { input, fake, err, done } = setupLoop([{ text: "R1" }], 1);
    input.write("P1\n");
    input.write("P2\n");
    input.write("/ajuda\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(err()).toContain("Limite de perguntas atingido");
  });
});
