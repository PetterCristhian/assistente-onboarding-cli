import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context/builder.js";
import { loadContextLayers } from "../src/context/loaders.js";
import { createChatSession, type ChatOutput } from "../src/chat/session.js";
import { LlmResponseError, type LlmClient } from "../src/llm/client.js";
import { createRedactor } from "../src/security/redact.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();
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

function setup(script: readonly FakeLlmStep[], llm?: LlmClient) {
  const fake = createFakeLlmClient(script);
  const output = recorder();
  const session = createChatSession({
    llm: llm ?? fake,
    instructions: context.text,
    output,
    redact: createRedactor([KEY]),
  });
  return { fake, output, session };
}

function lastRequest(fake: ReturnType<typeof createFakeLlmClient>) {
  const call = fake.calls.at(-1);
  if (call === undefined) {
    throw new Error("no call");
  }
  return call.request;
}

describe("createChatSession", () => {
  it("keeps the question and the answer of a turn in the history", async () => {
    const { session } = setup([{ text: "Resposta 1" }]);

    const result = await session.ask("Pergunta 1");

    expect(result).toMatchObject({ status: "answered", text: "Resposta 1" });
    expect(session.history).toEqual([
      { role: "user", content: "Pergunta 1" },
      { role: "assistant", content: "Resposta 1" },
    ]);
  });

  it("sends the history with the next question", async () => {
    const { fake, session } = setup([{ text: "R1" }, { text: "R2" }]);

    await session.ask("P1");
    await session.ask("P2");

    expect(lastRequest(fake).input).toEqual([
      { role: "user", content: "P1" },
      { role: "assistant", content: "R1" },
      { role: "user", content: "P2" },
    ]);
    expect(session.history).toHaveLength(4);
  });

  it("clears the history", async () => {
    const { fake, session } = setup([{ text: "R1" }, { text: "R2" }]);

    await session.ask("P1");
    session.clear();
    expect(session.history).toEqual([]);
    await session.ask("P2");

    expect(lastRequest(fake).input).toEqual([{ role: "user", content: "P2" }]);
  });

  it("sends the whole context, with the manager, and no model or sampling", async () => {
    const { fake, session } = setup([{ text: "R" }]);

    await session.ask("P");

    const request = lastRequest(fake);
    expect(request.instructions).toBe(context.text);
    expect(request.instructions).toContain(
      `Gestor direto: ${layers.userProfile.gestor}`,
    );
    expect(Object.keys(request)).not.toContain("model");
    expect(JSON.stringify(Object.keys(request))).not.toMatch(
      /temperature|seed|top_p/,
    );
  });

  it("hands the chunks to the output in order and closes the answer once", async () => {
    const { output, session } = setup([
      { text: "abc", chunks: ["a", "b", "c"] },
    ]);

    await session.ask("P");

    expect(output.events).toEqual(["chunk:a", "chunk:b", "chunk:c", "end"]);
  });

  it("does not expose the history for changes", async () => {
    const { session } = setup([{ text: "R" }]);
    await session.ask("P");

    (session.history as unknown[]).length = 0;

    expect(session.history).toHaveLength(2);
  });

  it("fails on a response error with its own message and no history", async () => {
    const { output, session } = setup([
      {
        error: new LlmResponseError(
          "empty",
          "O modelo não devolveu nenhum texto.",
        ),
      },
    ]);

    const result = await session.ask("P");

    expect(result.status).toBe("failed");
    expect(session.history).toEqual([]);
    expect(output.events).toEqual([
      "error:O modelo não devolveu nenhum texto.",
    ]);
  });

  it("fails on another error without the key, the stack or the object", async () => {
    const error = Object.assign(new Error(`falha com ${KEY}`), {
      status: 401,
      code: "invalid_api_key",
    });
    const { output, session } = setup([{ error }]);

    const result = await session.ask("P");

    expect(result.status).toBe("failed");
    expect(session.history).toEqual([]);
    const shown = output.events.join("\n");
    expect(shown).toContain("status 401, código invalid_api_key");
    expect(shown).not.toContain(KEY);
    expect(shown).not.toMatch(/^\s+at /m);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("keeps the history after an error in the middle of the stream", async () => {
    const { output, session } = setup([
      { text: "R1" },
      { chunks: ["parte"], error: new Error("caiu") },
    ]);
    await session.ask("P1");

    const result = await session.ask("P2");

    expect(result.status).toBe("failed");
    expect(session.history).toHaveLength(2);
    expect(output.events).toContain("chunk:parte");
    expect(output.events).toContain("warning:Resposta interrompida.");
  });

  it("is cancelled by the signal, with the history unchanged", async () => {
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = setup([{ text: "R", wait: held }]);

    const pending = session.ask("P", { signal: controller.signal });
    controller.abort();
    const result = await pending;
    release();

    expect(result).toEqual({ status: "cancelled" });
    expect(session.history).toEqual([]);
  });

  it("refuses a second question while one is running, then recovers", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = setup([{ text: "R1", wait: held }, { text: "R2" }]);

    const first = session.ask("P1");
    await expect(session.ask("P2")).rejects.toThrow("turno em andamento");
    release();
    await first;

    expect((await session.ask("P3")).status).toBe("answered");
  });
});

describe("createChatSession turn state (ENG-51)", () => {
  it("refuses clear() while a turn runs, and keeps the history", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = setup([{ text: "R1" }, { text: "R2", wait: held }]);
    await session.ask("P1");

    const pending = session.ask("P2");
    expect(() => session.clear()).toThrow("turno em andamento");
    release();
    await pending;

    expect(session.history).toHaveLength(4);
    session.clear();
    expect(session.history).toEqual([]);
  });

  it("does not keep the turn when closing the line fails, and closes it only once", async () => {
    let ends = 0;
    const events: string[] = [];
    const session = createChatSession({
      llm: createFakeLlmClient([{ text: "R" }, { text: "R2" }]),
      instructions: context.text,
      output: {
        chunk: (text) => void events.push(`chunk:${text}`),
        endAnswer: () => {
          ends += 1;
          throw new Error("closed pipe");
        },
        notice: (level, text) => void events.push(`${level}:${text}`),
      },
      redact: createRedactor([KEY]),
    });

    const result = await session.ask("P");

    expect(result.status).toBe("failed");
    expect(session.history).toEqual([]);
    expect(ends).toBe(1);
    expect(events.at(-1)).toMatch(/^error:/);
  });
});

describe("createChatSession usage (ENG-50)", () => {
  const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

  it("hands on the usage that the provider reported", async () => {
    const { session } = setup([{ text: "R", usage: USAGE }]);

    expect(await session.ask("P")).toEqual({
      status: "answered",
      text: "R",
      model: "fake-model",
      chunks: 1,
      usage: USAGE,
    });
  });

  it("leaves the usage out when the provider reported none", async () => {
    const { session } = setup([{ text: "R" }]);

    const result = await session.ask("P");

    expect(result).toMatchObject({ status: "answered" });
    expect(result).not.toHaveProperty("usage");
  });
});
