// The scripted LlmClient used the way the next issues will use it: a turn
// with history (session), an answer followed by its review (self-review) and
// a run that goes on after an error (battery runner). The small pipeline
// below exists only in this test and depends on nothing but the interface.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LlmResponseError,
  type LlmClient,
  type LlmMessage,
} from "../src/llm/client.js";
import {
  FAKE_LLM_MODEL,
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const reviewSchema = z.object({
  approved: z.boolean(),
  violations: z.array(z.enum(["P1", "P2", "P3", "P4", "P5"])),
});
const FALLBACK = "safe fallback message";

interface TurnResult {
  readonly answer: string;
  readonly shown: string;
  readonly model: string | undefined;
}

/** Answer, then review; only an approved answer enters the history. */
async function turn(
  client: LlmClient,
  history: LlmMessage[],
  question: string,
): Promise<TurnResult> {
  let shown = "";
  const input = [...history, { role: "user" as const, content: question }];
  try {
    const draft = await client.streamText({
      instructions: "context",
      input,
      onChunk: (chunk) => {
        shown += chunk;
      },
    });
    const review = await client.generateStructured({
      instructions: "reviewer",
      input: [{ role: "user", content: draft.text }],
      schema: reviewSchema,
      schemaName: "review",
    });
    const answer = review.value.approved ? draft.text : FALLBACK;
    history.push(
      { role: "user", content: question },
      { role: "assistant", content: answer },
    );
    return { answer, shown, model: draft.model };
  } catch {
    // A failure of the review counts as a rejection.
    history.push(
      { role: "user", content: question },
      { role: "assistant", content: FALLBACK },
    );
    return { answer: FALLBACK, shown, model: undefined };
  }
}

describe("the scripted client in a turn pipeline", () => {
  it("serves two turns with review, and shows the history sent in the second", async () => {
    const client = createFakeLlmClient([
      { text: "first answer", chunks: ["first ", "answer"] },
      { value: { approved: true, violations: [] } },
      { text: "second answer", model: "another-model" },
      { value: { approved: false, violations: ["P2"] } },
    ]);
    const history: LlmMessage[] = [];

    const first = await turn(client, history, "first question");
    const second = await turn(client, history, "and the deadline?");

    expect(first).toEqual({
      answer: "first answer",
      shown: "first answer",
      model: FAKE_LLM_MODEL,
    });
    expect(second).toEqual({
      answer: FALLBACK,
      shown: "second answer",
      model: "another-model",
    });
    expect(client.calls.map((call) => call.kind)).toEqual([
      "streamText",
      "generateStructured",
      "streamText",
      "generateStructured",
    ]);
    // The second generation received the first turn and the new question.
    expect(client.calls[2]?.request.input).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "and the deadline?" },
    ]);
    expect(client.calls[1]?.request.instructions).toBe("reviewer");
    expect(history).toHaveLength(4);
  });

  it.each([
    ["a review outside the schema", { value: { approved: "yes" } }],
    [
      "a review that fails",
      { error: new LlmResponseError("refusal", "O modelo se recusou.") },
    ],
    [
      "a review with an unknown policy",
      { value: { approved: false, violations: ["P9"] } },
    ],
  ] satisfies [string, FakeLlmStep][])(
    "lets the pipeline treat %s as a rejection",
    async (_label, reviewStep) => {
      const client = createFakeLlmClient([{ text: "draft" }, reviewStep]);
      const history: LlmMessage[] = [];

      const result = await turn(client, history, "question");

      expect(result.answer).toBe(FALLBACK);
      expect(history.at(-1)).toEqual({ role: "assistant", content: FALLBACK });
      expect(client.calls).toHaveLength(2);
    },
  );

  it("lets a runner go on after a failed case: the script continues at the next step", async () => {
    const rateLimit = Object.assign(new Error("429 Rate limit reached."), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    const client = createFakeLlmClient([
      { error: rateLimit },
      { text: "case two" },
      { value: { approved: true, violations: [] } },
    ]);

    const outcomes: string[] = [];
    for (const question of ["case one", "case two"]) {
      outcomes.push((await turn(client, [], question)).answer);
    }

    expect(outcomes).toEqual([FALLBACK, "case two"]);
    expect(client.calls).toHaveLength(3);
  });

  it("rejects with the very error object of the script, with its extra fields", async () => {
    const scripted = Object.assign(new Error("503 Overloaded."), {
      status: 503,
      headers: new Headers({ "retry-after": "2" }),
    });
    const client = createFakeLlmClient([
      { error: scripted },
      { error: "only a text" },
    ]);

    const first = await client
      .streamText({
        instructions: "x",
        input: [{ role: "user", content: "y" }],
      })
      .catch((error: unknown) => error);
    const second = await client
      .streamText({
        instructions: "x",
        input: [{ role: "user", content: "y" }],
      })
      .catch((error: unknown) => error);

    expect(first).toBe(scripted);
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toBe("only a text");
  });

  it("never throws at the call: every failure is a rejected promise", async () => {
    const client = createFakeLlmClient([]);
    let promise: Promise<unknown> | undefined;

    expect(() => {
      promise = client.generateStructured({
        instructions: "x",
        input: [{ role: "user", content: "y" }],
        schema: reviewSchema,
        schemaName: "review",
      });
    }).not.toThrow();

    await expect(promise).rejects.toThrow("no step left");
    // The call was recorded even though it failed.
    expect(client.calls).toHaveLength(1);
  });

  it("is not changed by a script that is changed after the client was created", async () => {
    const script: FakeLlmStep[] = [{ text: "kept" }];
    const client = createFakeLlmClient(script);
    script.length = 0;
    script.push({ text: "replaced" });

    const result = await client.streamText({
      instructions: "x",
      input: [{ role: "user", content: "y" }],
    });

    expect(result.text).toBe("kept");
  });

  it("gives independent clients independent scripts and records", async () => {
    const script: FakeLlmStep[] = [{ text: "only step" }];
    const one = createFakeLlmClient(script);
    const two = createFakeLlmClient(script);
    const request = {
      instructions: "x",
      input: [{ role: "user" as const, content: "y" }],
    };

    await one.streamText(request);

    expect((await two.streamText(request)).text).toBe("only step");
    expect(one.calls).toHaveLength(1);
    expect(two.calls).toHaveLength(1);
  });
});
