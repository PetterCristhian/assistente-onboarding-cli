import { readFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { APIUserAbortError } from "openai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as llm from "../src/llm/client.js";
import { LlmResponseError } from "../src/llm/client.js";
import {
  FAKE_LLM_MODEL,
  createFakeLlmClient,
} from "./helpers/fake-llm-client.js";

const INSTRUCTIONS = "Answer in one short sentence.";
const QUESTION = { role: "user", content: "What is a unit test?" } as const;
const verdictSchema = z.object({ approved: z.boolean(), reason: z.string() });

describe("createFakeLlmClient", () => {
  it("delivers the chunks in order and returns the whole text", async () => {
    const client = createFakeLlmClient([
      { text: "one two three", chunks: ["one ", "two ", "three"] },
    ]);
    const received: string[] = [];

    const result = await client.streamText({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      onChunk: (chunk) => received.push(chunk),
    });

    expect(received).toEqual(["one ", "two ", "three"]);
    expect(result).toEqual({
      text: "one two three",
      model: FAKE_LLM_MODEL,
      chunks: 3,
    });
  });

  it("delivers the text as a single chunk when no chunks are scripted", async () => {
    const client = createFakeLlmClient([{ text: "whole", model: "other" }]);
    const received: string[] = [];

    const result = await client.streamText({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      onChunk: (chunk) => received.push(chunk),
    });

    expect(received).toEqual(["whole"]);
    expect(result).toEqual({ text: "whole", model: "other", chunks: 1 });
  });

  it("works without onChunk", async () => {
    const client = createFakeLlmClient([{ text: "ab", chunks: ["a", "b"] }]);

    const result = await client.streamText({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
    });

    expect(result.text).toBe("ab");
    expect(result.chunks).toBe(2);
  });

  it("returns the scripted value validated by the schema of the request", async () => {
    const client = createFakeLlmClient([
      { value: { approved: true, reason: "ok" }, model: "judge" },
    ]);

    const result = await client.generateStructured({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      schema: verdictSchema,
      schemaName: "verdict",
    });

    expect(result).toEqual({
      value: { approved: true, reason: "ok" },
      model: "judge",
    });
  });

  it("rejects a scripted value that the schema refuses", async () => {
    const client = createFakeLlmClient([{ value: { approved: "yes" } }]);

    const failure = client.generateStructured({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      schema: verdictSchema,
      schemaName: "verdict",
    });

    await expect(failure).rejects.toBeInstanceOf(LlmResponseError);
    await expect(failure).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("records every call with its kind and request, in order", async () => {
    const client = createFakeLlmClient([
      { text: "first" },
      { value: { approved: false, reason: "no" } },
    ]);
    const history = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      QUESTION,
    ] as const;

    await client.streamText({ instructions: INSTRUCTIONS, input: history });
    await client.generateStructured({
      instructions: "Judge it.",
      input: [QUESTION],
      schema: verdictSchema,
      schemaName: "verdict",
      model: "judge",
    });

    expect(client.calls.map((call) => call.kind)).toEqual([
      "streamText",
      "generateStructured",
    ]);
    expect(client.calls[0]?.request.instructions).toBe(INSTRUCTIONS);
    expect(client.calls[0]?.request.input).toEqual(history);
    expect(client.calls[1]?.request.instructions).toBe("Judge it.");
    expect(client.calls[1]?.request.model).toBe("judge");
  });

  it("throws the scripted error, in either method", async () => {
    const boom = new Error("scripted failure");
    const client = createFakeLlmClient([{ error: boom }, { error: boom }]);

    await expect(
      client.streamText({ instructions: INSTRUCTIONS, input: [QUESTION] }),
    ).rejects.toBe(boom);
    await expect(
      client.generateStructured({
        instructions: INSTRUCTIONS,
        input: [QUESTION],
        schema: verdictSchema,
        schemaName: "verdict",
      }),
    ).rejects.toBe(boom);
    expect(client.calls).toHaveLength(2);
  });

  it("fails when the script has no step left", async () => {
    const client = createFakeLlmClient([]);

    await expect(
      client.streamText({ instructions: INSTRUCTIONS, input: [QUESTION] }),
    ).rejects.toThrow(/no step left/);
  });

  it("fails when the next step is of the other kind", async () => {
    const client = createFakeLlmClient([{ value: {} }, { text: "x" }]);

    await expect(
      client.streamText({ instructions: INSTRUCTIONS, input: [QUESTION] }),
    ).rejects.toThrow(/expected a text step/);
    await expect(
      client.generateStructured({
        instructions: INSTRUCTIONS,
        input: [QUESTION],
        schema: verdictSchema,
        schemaName: "verdict",
      }),
    ).rejects.toThrow(/expected a value step/);
  });
});

// The scripted client must not accept what the real one refuses, nor behave
// more kindly: a test that passes with it has to mean something.
describe("createFakeLlmClient: as strict as the real client", () => {
  const structuredRequest = {
    instructions: INSTRUCTIONS,
    input: [QUESTION],
    schema: verdictSchema,
    schemaName: "verdict",
  };

  it("refuses an empty input with the error of the real client, taking no step", async () => {
    const client = createFakeLlmClient([
      { text: "kept" },
      { value: { approved: true, reason: "ok" } },
    ]);

    const text = client.streamText({ instructions: INSTRUCTIONS, input: [] });
    const object = client.generateStructured({
      ...structuredRequest,
      input: [],
    });

    for (const failure of [text, object]) {
      await expect(failure).rejects.toThrow(TypeError);
      await expect(failure).rejects.toThrow(
        "LlmRequest.input must not be empty.",
      );
    }
    expect(client.calls).toHaveLength(2);
    // The script is intact: the refused calls took nothing from it.
    await expect(
      client.streamText({ instructions: INSTRUCTIONS, input: [QUESTION] }),
    ).resolves.toMatchObject({ text: "kept" });
  });

  it("rejects with the abort error when the signal is already aborted, taking no step", async () => {
    const client = createFakeLlmClient([{ text: "kept" }]);
    const signal = AbortSignal.abort();
    const received: string[] = [];

    await expect(
      client.streamText({
        instructions: INSTRUCTIONS,
        input: [QUESTION],
        signal,
        onChunk: (chunk) => received.push(chunk),
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
    await expect(
      client.generateStructured({ ...structuredRequest, signal }),
    ).rejects.toBeInstanceOf(APIUserAbortError);

    expect(received).toEqual([]);
    await expect(
      client.streamText({ instructions: INSTRUCTIONS, input: [QUESTION] }),
    ).resolves.toMatchObject({ text: "kept" });
  });

  it("rejects with the abort error, and delivers nothing else, when cancelled in the middle", async () => {
    const client = createFakeLlmClient([
      { text: "one two three", chunks: ["one ", "two ", "three"] },
      { text: "last", chunks: ["la", "st"] },
    ]);
    const received: string[] = [];

    for (const stopAt of [1, 2]) {
      const controller = new AbortController();
      received.length = 0;

      await expect(
        client.streamText({
          instructions: INSTRUCTIONS,
          input: [QUESTION],
          signal: controller.signal,
          onChunk: (chunk) => {
            received.push(chunk);
            if (received.length === stopAt) {
              controller.abort();
            }
          },
        }),
      ).rejects.toBeInstanceOf(APIUserAbortError);

      // Also when it is the last chunk that cancels: no result is returned.
      expect(received).toHaveLength(stopAt);
    }
  });

  it("refuses a script whose text is not its chunks joined", () => {
    expect(() =>
      createFakeLlmClient([{ text: "whole", chunks: ["wh", "ole!"] }]),
    ).toThrow(/must be the `chunks` joined/);
    expect(() => createFakeLlmClient([{ text: "whole", chunks: [] }])).toThrow(
      /must be the `chunks` joined/,
    );
    expect(() =>
      createFakeLlmClient([{ text: "", chunks: [] }, { text: "a" }]),
    ).not.toThrow();
  });

  it("delivers nothing during the call itself, and one chunk per turn", async () => {
    const client = createFakeLlmClient([
      { text: "abc", chunks: ["a", "b", "c"] },
    ]);
    const order: string[] = [];

    const pending = client.streamText({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      onChunk: (chunk) => {
        order.push(chunk);
        // Runs before anything that is scheduled later.
        queueMicrotask(() => order.push("turn"));
      },
    });
    // The call has returned and nothing was delivered yet.
    expect(order).toEqual([]);
    await pending;

    expect(order).toEqual(["a", "turn", "b", "turn", "c", "turn"]);
  });

  it("records a snapshot of the request, not the object of the caller", async () => {
    const client = createFakeLlmClient([{ text: "first" }]);
    const history = [{ role: "user" as const, content: "question" }];
    const onChunk = () => undefined;
    const signal = new AbortController().signal;

    await client.streamText({
      instructions: INSTRUCTIONS,
      input: history,
      signal,
      onChunk,
    });
    // What a session does after the turn.
    history.push({ role: "user" as const, content: "another" });
    history[0] = { role: "user", content: "changed" };

    const recorded = client.calls[0]?.request;
    expect(recorded?.input).toEqual([{ role: "user", content: "question" }]);
    expect(recorded?.input).not.toBe(history);
    expect(recorded?.instructions).toBe(INSTRUCTIONS);
    // What cannot be copied is kept as it was given.
    expect(recorded?.signal).toBe(signal);
    expect((recorded as { onChunk?: unknown }).onChunk).toBe(onChunk);
  });

  it("delivers the chunks of a partial step and then rejects with its error", async () => {
    const dropped = Object.assign(new Error("connection lost"), {
      status: 503,
    });
    const client = createFakeLlmClient([
      { chunks: ["part ", "of it"], error: dropped },
      { chunks: [], error: "only a text" },
      { text: "the retry" },
    ]);
    const received: string[] = [];
    const request = {
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      onChunk: (chunk: string) => received.push(chunk),
    };

    await expect(client.streamText(request)).rejects.toBe(dropped);
    expect(received).toEqual(["part ", "of it"]);
    await expect(client.streamText(request)).rejects.toThrow("only a text");
    // The script goes on: what a retry would receive.
    expect((await client.streamText(request)).text).toBe("the retry");
    expect(received).toEqual(["part ", "of it", "the retry"]);
  });

  it("refuses a partial step in a structured call", async () => {
    const client = createFakeLlmClient([
      { chunks: ["x"], error: new Error("never thrown") },
    ]);

    await expect(client.generateStructured(structuredRequest)).rejects.toThrow(
      /expected a value step/,
    );
  });

  it("holds a step until the promise of the test settles, with no timer", async () => {
    vi.useFakeTimers();
    try {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const client = createFakeLlmClient([
        { text: "ab", chunks: ["a", "b"], wait: gate },
        { value: { approved: true, reason: "ok" }, wait: gate },
      ]);
      const received: string[] = [];
      let settled = false;

      const pending = client
        .streamText({
          instructions: INSTRUCTIONS,
          input: [QUESTION],
          onChunk: (chunk) => received.push(chunk),
        })
        .finally(() => {
          settled = true;
        });
      for (let turn = 0; turn < 20; turn += 1) {
        await Promise.resolve();
      }
      expect(settled).toBe(false);
      expect(received).toEqual([]);

      release();

      expect((await pending).text).toBe("ab");
      expect(received).toEqual(["a", "b"]);
      // The same promise, already settled, holds nothing.
      expect(
        (await client.generateStructured(structuredRequest)).value,
      ).toEqual({ approved: true, reason: "ok" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls a wait function once, when its step starts, and waits for what it returns", async () => {
    const started: string[] = [];
    let release = (): void => undefined;
    const client = createFakeLlmClient([
      {
        text: "first",
        wait: () => {
          started.push("first");
        },
      },
      {
        error: new Error("after the wait"),
        wait: () => {
          started.push("second");
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    ]);
    const request = { instructions: INSTRUCTIONS, input: [QUESTION] };

    expect(started).toEqual([]);
    await client.streamText(request);
    expect(started).toEqual(["first"]);

    const failure = client.streamText(request);
    expect(started).toEqual(["first", "second"]);
    release();

    await expect(failure).rejects.toThrow("after the wait");
    expect(started).toEqual(["first", "second"]);
  });

  it("ends a held call with the abort error when it is cancelled, leaving no listener", async () => {
    const never = new Promise<void>(() => undefined);
    const client = createFakeLlmClient([
      { text: "never delivered", wait: never },
      { value: { approved: true, reason: "ok" }, wait: () => never },
    ]);
    const controller = new AbortController();
    const received: string[] = [];

    const text = client.streamText({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      signal: controller.signal,
      onChunk: (chunk) => received.push(chunk),
    });
    const object = client.generateStructured({
      ...structuredRequest,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(text).rejects.toBeInstanceOf(APIUserAbortError);
    await expect(object).rejects.toBeInstanceOf(APIUserAbortError);
    expect(received).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("removes its listener from the signal when a held call ends by itself", async () => {
    const controller = new AbortController();
    const client = createFakeLlmClient([
      { text: "done", wait: Promise.resolve() },
    ]);

    await client.streamText({
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      signal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("createFakeLlmClient: the second review (ENG-48)", () => {
  it("reports an empty text as the real client does", async () => {
    const client = createFakeLlmClient([
      { text: "", model: "writer" },
      { text: "", chunks: ["", ""] },
    ]);
    const received: string[] = [];
    const request = {
      instructions: INSTRUCTIONS,
      input: [QUESTION],
      onChunk: (chunk: string) => received.push(chunk),
    };

    const first = await client.streamText(request).catch((e: unknown) => e);
    const second = await client.streamText(request).catch((e: unknown) => e);

    expect(first).toBeInstanceOf(LlmResponseError);
    expect(first).toMatchObject({ kind: "empty", model: "writer" });
    expect(second).toMatchObject({ kind: "empty", model: FAKE_LLM_MODEL });
    // The empty pieces that the script names still arrive, as in a stream.
    expect(received).toEqual(["", ""]);
  });

  it("takes the errors of the SDK from the client, not from the SDK", async () => {
    const source = await readFile(
      new URL("./helpers/fake-llm-client.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["']openai/);
  });

  it("finds in the client the errors of the SDK that the project needs", () => {
    const abort = new llm.APIUserAbortError();
    const timeout = new llm.APIConnectionTimeoutError();

    expect(abort).toBeInstanceOf(APIUserAbortError);
    expect(timeout).toBeInstanceOf(llm.APIConnectionError);
    expect(timeout).toBeInstanceOf(llm.APIError);
    expect(llm.RateLimitError.prototype).toBeInstanceOf(llm.APIError);
  });
});
