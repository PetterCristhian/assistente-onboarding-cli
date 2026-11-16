import { describe, expect, it } from "vitest";
import { z } from "zod";
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
