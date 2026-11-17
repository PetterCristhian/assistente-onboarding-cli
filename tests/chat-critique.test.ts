// The self-critique in the turn pipeline (ENG-53), over a fake client: no
// network, no key. The assertions read what the session sent (fake.calls),
// what it showed (the events of the output) and what it kept (the history).
import { describe, expect, it, vi } from "vitest";
import { UNKNOWN_RULE } from "../src/chat/critique.js";
import {
  createRateLimiter,
  type RateLimiter,
} from "../src/chat/rate-limiter.js";
import {
  createChatSession,
  type ChatOutput,
  type ChatSessionDeps,
  type TurnRecord,
  type TurnResult,
} from "../src/chat/session.js";
import {
  APIUserAbortError,
  LlmResponseError,
  type LlmClient,
  type LlmMessage,
} from "../src/llm/client.js";
import type { RetryEvent } from "../src/llm/retry.js";
import { createRedactor, REDACTED } from "../src/security/redact.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import {
  approvedStep,
  EVALUATOR_CONTEXT,
  EVALUATOR_PROMPT,
  FALLBACK_MESSAGE,
  makeCritiqueDeps,
  rejectedStep,
} from "./helpers/critique-fixtures.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeLlmClient,
  type FakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const KEY = fakeOpenAiKey();
// Written as code points: an invisible character in the source is easy to lose.
const ESC = String.fromCodePoint(0x1b);
const CR = String.fromCodePoint(0x0d);
const BIDI = String.fromCodePoint(0x202e);
const INSTRUCTIONS = "CONTEXTO-COMPLETO com SENTINELA-CAMADA-UM";

interface Recorder extends ChatOutput {
  readonly events: string[];
  /** True while a line of the answer is open on the screen. */
  isOpen(): boolean;
  /** How many calls the fake had received when each chunk arrived. */
  readonly callsAtChunk: number[];
  onEnd?: (count: number) => void;
}

function recorder(fake: FakeLlmClient): Recorder {
  const events: string[] = [];
  const callsAtChunk: number[] = [];
  let open = false;
  let ends = 0;
  const output: Recorder = {
    events,
    callsAtChunk,
    isOpen: () => open,
    chunk: (text) => {
      open = true;
      callsAtChunk.push(fake.calls.length);
      events.push(`chunk:${text}`);
    },
    endAnswer: () => {
      open = false;
      ends += 1;
      events.push("end");
      output.onEnd?.(ends);
    },
    retraction: (text) => void events.push(`retraction:${text}`),
    notice: (level, text) => void events.push(`${level}:${text}`),
  };
  return output;
}

interface Options {
  critique?: Partial<Parameters<typeof makeCritiqueDeps>[0]>;
  limiter?: RateLimiter;
  mode?: "refuse" | "wait";
  streaming?: boolean;
  onTurn?: ChatSessionDeps["onTurn"];
  wrap?: (fake: FakeLlmClient) => LlmClient;
}

function setup(script: readonly FakeLlmStep[], options: Options = {}) {
  const fake = createFakeLlmClient(script);
  const output = recorder(fake);
  const session = createChatSession({
    llm: options.wrap?.(fake) ?? fake,
    instructions: INSTRUCTIONS,
    critique: makeCritiqueDeps(options.critique),
    output,
    redact: createRedactor([KEY]),
    ...(options.streaming === true
      ? { redactStream: () => createStreamRedactor([KEY]) }
      : {}),
    ...(options.limiter === undefined
      ? {}
      : {
          rateLimit: {
            limiter: options.limiter,
            mode: options.mode ?? "refuse",
          },
        }),
    ...(options.onTurn === undefined ? {} : { onTurn: options.onTurn }),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { fake, output, session };
}

function answered(result: TurnResult) {
  if (result.status !== "answered") {
    throw new Error(`expected an answered turn, got ${result.status}`);
  }
  return result;
}

function assistantTexts(history: readonly LlmMessage[]): string[] {
  return history
    .filter((message) => message.role === "assistant")
    .map((message) => message.content);
}

const kinds = (fake: FakeLlmClient) => fake.calls.map((call) => call.kind);

describe("self-critique: the four paths", () => {
  it("approved: the draft that was shown is the final answer", async () => {
    const { fake, output, session } = setup([
      { text: "abc", chunks: ["a", "bc"] },
      approvedStep(),
    ]);

    const result = answered(await session.ask("P"));

    expect(kinds(fake)).toEqual(["streamText", "generateStructured"]);
    expect(result.text).toBe("abc");
    expect(result.critique).toMatchObject({
      draft: "abc",
      origin: "rascunho",
      violatedRules: [],
      llmCalls: 2,
      evaluation: { status: "ok", approved: true, violations: [] },
    });
    expect(result.critique.revision).toBeUndefined();
    expect(output.events).toEqual(["chunk:a", "chunk:bc", "end"]);
    expect(session.history).toEqual([
      { role: "user", content: "P" },
      { role: "assistant", content: "abc" },
    ]);
  });

  it("rejected, revision approved: withdraws the draft and shows only the approved revision", async () => {
    let eventsAtSecondEvaluation: string[] = [];
    const { fake, output, session } = setup([
      { text: "RASCUNHO-RUIM" },
      rejectedStep("P2", "usou gíria"),
      { text: "REVISAO-BOA" },
      {
        ...approvedStep(),
        wait: () => {
          eventsAtSecondEvaluation = [...output.events];
        },
      },
    ]);

    const result = answered(await session.ask("P"));

    expect(kinds(fake)).toEqual([
      "streamText",
      "generateStructured",
      "streamText",
      "generateStructured",
    ]);
    expect(result.text).toBe("REVISAO-BOA");
    expect(result.critique).toMatchObject({
      draft: "RASCUNHO-RUIM",
      origin: "revisao",
      violatedRules: ["P2"],
      llmCalls: 4,
      revision: { text: "REVISAO-BOA", evaluation: { approved: true } },
    });
    // Nothing of the revision is shown before the second approval.
    expect(eventsAtSecondEvaluation).toEqual([
      "chunk:RASCUNHO-RUIM",
      "end",
      expect.stringMatching(/^retraction:.*regra P2: usou gíria/),
    ]);
    expect(output.events).toEqual([
      "chunk:RASCUNHO-RUIM",
      "end",
      expect.stringMatching(/^retraction:/),
      "chunk:REVISAO-BOA",
      "end",
    ]);
    expect(session.history).toEqual([
      { role: "user", content: "P" },
      { role: "assistant", content: "REVISAO-BOA" },
    ]);
  });

  it("rejected, revision rejected: shows the safe message and keeps it", async () => {
    const { fake, output, session } = setup([
      { text: "RASCUNHO-RUIM" },
      rejectedStep("P3"),
      { text: "REVISAO-RUIM" },
      rejectedStep("P4", "ainda inventa"),
    ]);

    const result = answered(await session.ask("P"));

    expect(fake.calls).toHaveLength(4);
    expect(result.text).toBe(FALLBACK_MESSAGE);
    expect(result.critique).toMatchObject({
      origin: "fallback",
      violatedRules: ["P3", "P4"],
      llmCalls: 4,
      revision: { text: "REVISAO-RUIM", evaluation: { approved: false } },
    });
    expect(output.events).toContain(`chunk:${FALLBACK_MESSAGE}`);
    expect(output.events.join("\n")).not.toContain("chunk:REVISAO-RUIM");
    expect(output.isOpen()).toBe(false);
    expect(assistantTexts(session.history)).toEqual([FALLBACK_MESSAGE]);
  });

  it("error in the evaluation: fail-closed, with a notice that holds no message of the SDK", async () => {
    const { fake, output, session } = setup([
      { text: "RASCUNHO" },
      { error: new Error(`falha secreta com ${KEY}`) },
    ]);

    const result = answered(await session.ask("P"));

    expect(fake.calls).toHaveLength(2);
    expect(result.text).toBe(FALLBACK_MESSAGE);
    expect(result.critique.origin).toBe("fallback");
    expect(result.critique.evaluation.status).toBe("error");
    expect(
      output.events.some((event) =>
        event.startsWith("warning:[autoavaliação]"),
      ),
    ).toBe(true);
    expect(output.events.join("\n")).not.toContain(KEY);
    expect(assistantTexts(session.history)).toEqual([FALLBACK_MESSAGE]);
  });
});

describe("self-critique: variations that end in the safe message", () => {
  it("an error while writing the revision", async () => {
    const { fake, output, session } = setup([
      { text: "RASCUNHO" },
      rejectedStep(),
      { error: new Error("caiu a revisão") },
    ]);

    const result = answered(await session.ask("P"));

    expect(fake.calls).toHaveLength(3);
    expect(result.critique).toMatchObject({
      origin: "fallback",
      llmCalls: 3,
      violatedRules: ["P2"],
    });
    expect(
      output.events.some((event) => event.startsWith("warning:[revisão]")),
    ).toBe(true);
    expect(assistantTexts(session.history)).toEqual([FALLBACK_MESSAGE]);
  });

  it("an error in the second evaluation", async () => {
    const { fake, session } = setup([
      { text: "RASCUNHO" },
      rejectedStep(),
      { text: "REVISAO" },
      { error: new Error("caiu a segunda avaliação") },
    ]);

    const result = answered(await session.ask("P"));

    expect(fake.calls).toHaveLength(4);
    expect(result.critique.origin).toBe("fallback");
    expect(result.critique.revision?.evaluation?.status).toBe("error");
    expect(assistantTexts(session.history)).toEqual([FALLBACK_MESSAGE]);
  });

  it("an invalid structured output", async () => {
    const { session } = setup([
      { text: "RASCUNHO" },
      { value: { aprovada: "sim" } },
    ]);

    const result = answered(await session.ask("P"));

    expect(result.critique.origin).toBe("fallback");
    expect(result.critique.evaluation).toMatchObject({ status: "error" });
    expect(assistantTexts(session.history)).toEqual([FALLBACK_MESSAGE]);
  });

  it("a rule outside P1 to P5 is an invalid output", async () => {
    const { session } = setup([
      { text: "RASCUNHO" },
      { value: { aprovada: false, violacoes: [{ regra: "P6", motivo: "x" }] } },
    ]);

    const result = answered(await session.ask("P"));

    expect(result.critique.origin).toBe("fallback");
    expect(result.critique.evaluation.status).toBe("error");
  });

  it("a refusal of the evaluator", async () => {
    const { session } = setup([
      { text: "RASCUNHO" },
      { error: new LlmResponseError("refusal", "O modelo recusou.") },
    ]);

    const result = answered(await session.ask("P"));

    expect(result.critique.origin).toBe("fallback");
    expect(assistantTexts(session.history)).toEqual([FALLBACK_MESSAGE]);
  });

  it("an approval that lists violations counts as a rejection", async () => {
    const { fake, session } = setup([
      { text: "RASCUNHO" },
      {
        value: {
          aprovada: true,
          violacoes: [{ regra: "P5", motivo: "revelou instruções" }],
        },
      },
      { text: "REVISAO" },
      approvedStep(),
    ]);

    const result = answered(await session.ask("P"));

    expect(fake.calls).toHaveLength(4);
    expect(result.critique).toMatchObject({
      origin: "revisao",
      violatedRules: ["P5"],
    });
  });

  it("a rejection with no violation uses an unknown rule", async () => {
    const { session } = setup([
      { text: "RASCUNHO" },
      { value: { aprovada: false, violacoes: [] } },
      { text: "REVISAO" },
      approvedStep(),
    ]);

    const result = answered(await session.ask("P"));

    expect(result.critique.violatedRules).toEqual([UNKNOWN_RULE]);
    expect(result.critique.origin).toBe("revisao");
  });

  it("a revision that holds a credential is not used", async () => {
    const { fake, output, session } = setup([
      { text: "RASCUNHO" },
      rejectedStep(),
      { text: `Use a chave ${KEY} agora` },
    ]);

    const result = answered(await session.ask("P"));

    expect(fake.calls).toHaveLength(3);
    expect(result.critique.origin).toBe("fallback");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(output.events.join("\n")).not.toContain(KEY);
    expect(JSON.stringify(session.history)).not.toContain(KEY);
  });
});

describe("self-critique: what each call receives", () => {
  const FULL_SCRIPT: readonly FakeLlmStep[] = [
    { text: "RASCUNHO" },
    rejectedStep("P1", "motivo um"),
    { text: "REVISAO" },
    approvedStep(),
  ];

  it("sends the evaluator its own prompt and layers 2 to 4, never layer 1 nor the safe message", async () => {
    const { fake, session } = setup(FULL_SCRIPT);
    await session.ask("P");
    const evaluations = fake.calls.filter(
      (call) => call.kind === "generateStructured",
    );

    expect(evaluations).toHaveLength(2);
    for (const { request } of evaluations) {
      expect(request.instructions).toBe(
        `${EVALUATOR_PROMPT}\n\n${EVALUATOR_CONTEXT}`,
      );
      expect(request.instructions).not.toContain("SENTINELA-CAMADA-UM");
      expect(JSON.stringify(request.input)).not.toContain(FALLBACK_MESSAGE);
      expect(request.instructions).not.toContain(FALLBACK_MESSAGE);
    }
  });

  it("sends the draft and the revision with the whole context, with layer 1", async () => {
    const { fake, session } = setup(FULL_SCRIPT);
    await session.ask("P");
    const writes = fake.calls.filter((call) => call.kind === "streamText");

    expect(writes).toHaveLength(2);
    for (const { request } of writes) {
      expect(request.instructions).toBe(INSTRUCTIONS);
    }
  });

  it("never sends the safe message to the model, in any path", async () => {
    const scripts: (readonly FakeLlmStep[])[] = [
      FULL_SCRIPT,
      [{ text: "R" }, approvedStep()],
      [{ text: "R" }, rejectedStep(), { text: "R2" }, rejectedStep()],
      [{ text: "R" }, { error: new Error("x") }],
    ];
    for (const script of scripts) {
      const { fake, session } = setup(script);
      await session.ask("P1");
      // The second question carries the history, which may hold the message.
      await session.ask("P2").catch(() => undefined);

      for (const call of fake.calls) {
        expect(call.request.instructions).not.toContain(FALLBACK_MESSAGE);
      }
    }
  });

  it("sends the evaluator the question and the draft in delimiters", async () => {
    const { fake, session } = setup([{ text: "RASCUNHO" }, approvedStep()]);
    await session.ask("PERGUNTA");

    expect(fake.calls[1]?.request.input).toEqual([
      {
        role: "user",
        content:
          "<pergunta>\nPERGUNTA\n</pergunta>\n<rascunho>\nRASCUNHO\n</rascunho>",
      },
    ]);
  });

  it("sends the evaluator only the last 6 messages of the history", async () => {
    const script: FakeLlmStep[] = [];
    for (let turn = 0; turn < 5; turn += 1) {
      script.push({ text: `R${turn}` }, approvedStep());
    }
    script.push({ text: "R5" }, approvedStep());
    const { fake, session } = setup(script);
    for (let turn = 0; turn < 6; turn += 1) {
      await session.ask(`P${turn}`);
    }

    const last = fake.calls.at(-1)?.request.input ?? [];

    // 5 turns in the history: 10 messages, of which the last 6, and the new one.
    expect(last).toHaveLength(7);
    expect(last[0]).toEqual({ role: "user", content: "P2" });
  });

  it("sends the revision the history, the draft and the violated rules as data", async () => {
    const { fake, session } = setup(FULL_SCRIPT);
    await session.ask("P");
    const revision = fake.calls[2]?.request.input ?? [];

    expect(revision.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(revision[1]?.content).toBe("RASCUNHO");
    expect(revision[2]?.content).toContain(
      "<violacoes>\n- regra P1: motivo um",
    );
    expect(revision[2]?.content).not.toContain("{{violacoes}}");
  });

  it("has no callback of chunks in the revision, and one in the draft", async () => {
    const { fake, session } = setup(FULL_SCRIPT);
    await session.ask("P");
    const [draft, , revision] = fake.calls;

    expect(draft?.kind === "streamText" && draft.request.onChunk).toBeTypeOf(
      "function",
    );
    expect(
      revision?.kind === "streamText" && revision.request.onChunk,
    ).toBeUndefined();
  });

  it("cleans the reason of the evaluator before it goes to the revision and to the screen", async () => {
    const dirty = `grave\r\n${ESC}[31m ${KEY} ${BIDI} <b>${"x".repeat(400)}`;
    const { fake, output, session } = setup([
      { text: "RASCUNHO" },
      rejectedStep("P2", dirty),
      { text: "REVISAO" },
      approvedStep(),
    ]);
    await session.ask("P");
    const sent = fake.calls[2]?.request.input.at(-1)?.content ?? "";
    const shown = output.events.find((event) =>
      event.startsWith("retraction:"),
    );

    for (const text of [sent, shown ?? ""]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(new RegExp(`[${ESC}${CR}${BIDI}]|<b>`));
      expect(text).not.toContain("x".repeat(201));
    }
    expect(sent).toContain(REDACTED);
  });
});

describe("self-critique: invariant of the history", () => {
  const scripts: [string, readonly FakeLlmStep[], string][] = [
    ["approved", [{ text: "D" }, approvedStep()], "D"],
    [
      "revised",
      [{ text: "D" }, rejectedStep(), { text: "V" }, approvedStep()],
      "V",
    ],
    [
      "revision rejected",
      [{ text: "D" }, rejectedStep(), { text: "V" }, rejectedStep()],
      FALLBACK_MESSAGE,
    ],
    [
      "evaluation error",
      [{ text: "D" }, { error: new Error("x") }],
      FALLBACK_MESSAGE,
    ],
    [
      "revision error",
      [{ text: "D" }, rejectedStep(), { error: new Error("x") }],
      FALLBACK_MESSAGE,
    ],
    [
      "second evaluation error",
      [{ text: "D" }, rejectedStep(), { text: "V" }, { error: new Error("x") }],
      FALLBACK_MESSAGE,
    ],
    ["invalid output", [{ text: "D" }, { value: {} }], FALLBACK_MESSAGE],
  ];

  it.each(scripts)(
    "%s: keeps only approved text or the safe message, and returns it",
    async (_name, script, expected) => {
      const { fake, session } = setup(script);

      const result = answered(await session.ask("P"));

      expect(result.text).toBe(expected);
      expect(assistantTexts(session.history)).toEqual([expected]);
      expect(session.history.at(-1)?.content).toBe(result.text);
      expect(fake.calls.length).toBeLessThanOrEqual(4);
      expect(result.critique.llmCalls).toBe(fake.calls.length);
    },
  );

  it("holds over many turns: every message of the assistant is approved or the safe one", async () => {
    const script: FakeLlmStep[] = scripts.flatMap(([, steps]) => steps);
    const { fake, session } = setup(script);
    const allowed = new Set(scripts.map(([, , expected]) => expected));

    for (let turn = 0; turn < scripts.length; turn += 1) {
      const before = fake.calls.length;
      await session.ask(`P${turn}`);

      expect(fake.calls.length - before).toBeLessThanOrEqual(4);
    }

    expect(assistantTexts(session.history)).toHaveLength(scripts.length);
    for (const text of assistantTexts(session.history)) {
      expect(allowed.has(text)).toBe(true);
    }
    expect(assistantTexts(session.history)).not.toContain("D" + "x");
  });

  it("never keeps a rejected draft or a rejected revision", async () => {
    const { session } = setup([
      { text: "REJEITADO-1" },
      rejectedStep(),
      { text: "REJEITADO-2" },
      rejectedStep(),
    ]);
    await session.ask("P");

    const kept = JSON.stringify(session.history);

    expect(kept).not.toContain("REJEITADO");
  });
});

describe("self-critique: streaming and order", () => {
  it("shows the draft incrementally, before the evaluator is called", async () => {
    const { fake, output, session } = setup([
      { text: "abc", chunks: ["a", "b", "c"] },
      approvedStep(),
    ]);

    await session.ask("P");

    expect(output.callsAtChunk).toEqual([1, 1, 1]);
    expect(fake.calls).toHaveLength(2);
  });

  it("closes the line of the draft before the evaluation starts", async () => {
    let eventsAtEvaluation: string[] = [];
    const { output, session } = setup([
      { text: "abc", chunks: ["a", "bc"] },
      {
        ...approvedStep(),
        wait: () => {
          eventsAtEvaluation = [...output.events];
        },
      },
    ]);

    await session.ask("P");

    expect(eventsAtEvaluation).toEqual(["chunk:a", "chunk:bc", "end"]);
  });

  it("says the draft was withdrawn, with the rule, before anything of the revision", async () => {
    const { output, session } = setup([
      { text: "D" },
      rejectedStep("P4", "faltou o encaminhamento"),
      { text: "V" },
      approvedStep(),
    ]);

    await session.ask("P");
    const retraction = output.events.findIndex((event) =>
      event.startsWith("retraction:"),
    );
    const revision = output.events.indexOf("chunk:V");

    expect(retraction).toBeGreaterThan(-1);
    expect(retraction).toBeLessThan(revision);
    expect(output.events[retraction]).toMatch(
      /retirada.*regra P4: faltou o encaminhamento/,
    );
  });

  it("shows no retraction when the draft is approved", async () => {
    const { output, session } = setup([{ text: "D" }, approvedStep()]);

    await session.ask("P");

    expect(output.events.some((e) => e.startsWith("retraction:"))).toBe(false);
  });
});

describe("self-critique: redaction", () => {
  const first = KEY.slice(0, 11);
  const second = KEY.slice(11);

  it("hides a key split in two chunks on the screen, in the history, in the evaluator and in the result", async () => {
    const records: TurnRecord[] = [];
    const { fake, output, session } = setup(
      [
        {
          text: `Sua chave é ${KEY} ok`,
          chunks: [`Sua chave é ${first}`, `${second} ok`],
        },
        approvedStep(),
      ],
      { streaming: true, onTurn: (record) => void records.push(record) },
    );

    const result = answered(await session.ask("P"));
    const everywhere = [
      output.events.join(""),
      JSON.stringify(session.history),
      JSON.stringify(fake.calls.map((call) => call.request.input)),
      JSON.stringify(result),
      JSON.stringify(records),
    ];

    for (const text of everywhere) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(first);
    }
    expect(result.text).toBe(`Sua chave é ${REDACTED} ok`);
    expect(
      output.events
        .filter((event) => event.startsWith("chunk:"))
        .map((event) => event.slice("chunk:".length))
        .join(""),
    ).toBe(`Sua chave é ${REDACTED} ok`);
  });

  it("does not hold back the draft when there is nothing to hide", async () => {
    const { output, session } = setup(
      [
        { text: "Olá, tudo bem?", chunks: ["Olá, ", "tudo bem?"] },
        approvedStep(),
      ],
      { streaming: true },
    );

    await session.ask("P");

    expect(output.events).toEqual(["chunk:Olá, ", "chunk:tudo bem?", "end"]);
  });

  it("releases what was held back when the answer ends", async () => {
    const { output, session } = setup(
      [{ text: "termina em s", chunks: ["termina em ", "s"] }, approvedStep()],
      { streaming: true },
    );

    const result = answered(await session.ask("P"));

    expect(output.events.join("")).toContain("chunk:s");
    expect(result.text).toBe("termina em s");
  });

  it("starts a new redactor for each try of the draft", async () => {
    // A cut stream: the tail held back by the redactor of the first try must
    // not appear in the text of the second.
    let call = 0;
    const llm: LlmClient = {
      streamText: (request) => {
        call += 1;
        if (call === 1) {
          request.onChunk?.(`começo ${first}`);
          request.onRetry?.({
            retry: 1,
            maxRetries: 3,
            delayMs: 0,
            cause: { kind: "transient", reason: "interrupted" },
          });
        }
        request.onChunk?.("texto limpo");
        return Promise.resolve({
          text: "texto limpo",
          model: "m",
          chunks: 1,
        });
      },
      generateStructured: (request) =>
        Promise.resolve({
          value: request.schema.parse({ aprovada: true, violacoes: [] }),
          model: "m",
        }),
    };
    const { output, session } = setup([], { streaming: true, wrap: () => llm });

    await session.ask("P");

    expect(output.events.join("\n")).not.toContain(first);
    expect(output.events.at(-2)).toBe("chunk:texto limpo");
  });
});

describe("self-critique: the local rate limit", () => {
  function limiterWith(max: number): {
    limiter: RateLimiter;
    acquires: () => number;
  } {
    let now = 0;
    const real = createRateLimiter({
      maxRequests: max,
      windowSeconds: 60,
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    const acquire = vi.fn((options: Parameters<RateLimiter["acquire"]>[0]) =>
      real.acquire(options),
    );
    return {
      limiter: { ...real, acquire },
      acquires: () => acquire.mock.calls.length,
    };
  }

  const FOUR_CALLS: readonly FakeLlmStep[] = [
    { text: "D" },
    rejectedStep(),
    { text: "V" },
    approvedStep(),
  ];

  it("takes one slot for a turn of four calls, and refuses the next question without calls", async () => {
    const { limiter, acquires } = limiterWith(1);
    const { fake, output, session } = setup(FOUR_CALLS, { limiter });

    const first = await session.ask("P1");
    const second = await session.ask("P2");

    expect(first.status).toBe("answered");
    expect(fake.calls).toHaveLength(4);
    expect(acquires()).toBe(2);
    expect(second.status).toBe("rate_limited");
    expect(fake.calls).toHaveLength(4);
    expect(session.history).toHaveLength(2);
    expect(output.events.some((e) => e.startsWith("warning:Limite"))).toBe(
      true,
    );
  });

  it("takes exactly one slot per accepted question, whatever the path", async () => {
    const { limiter, acquires } = limiterWith(10);
    const { session } = setup(
      [
        { text: "D" },
        approvedStep(),
        ...FOUR_CALLS,
        { text: "D" },
        { error: new Error("x") },
      ],
      { limiter },
    );

    await session.ask("P1");
    expect(acquires()).toBe(1);
    await session.ask("P2");
    expect(acquires()).toBe(2);
    await session.ask("P3");
    expect(acquires()).toBe(3);
  });

  it("in wait mode, also takes one slot and waits for the next question", async () => {
    const { limiter, acquires } = limiterWith(1);
    const { fake, output, session } = setup([...FOUR_CALLS, ...FOUR_CALLS], {
      limiter,
      mode: "wait",
    });

    await session.ask("P1");
    const second = await session.ask("P2");

    expect(second.status).toBe("answered");
    expect(acquires()).toBe(2);
    expect(fake.calls).toHaveLength(8);
    expect(output.events.some((e) => e.startsWith("info:Aguardando"))).toBe(
      true,
    );
  });
});

describe("self-critique: cancellation", () => {
  /** A step held until the test releases it (or the call is cancelled). */
  function held(): { promise: Promise<void>; release: () => void } {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let index = 0; index < 200 && !condition(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  // The phase that is running when the user cancels: the 1st to the 4th call.
  it.each([
    ["the draft", 1],
    ["the first evaluation", 2],
    ["the revision", 3],
    ["the second evaluation", 4],
  ])(
    "cancels during %s: nothing is kept, no call follows, the line is closed",
    async (_name, target) => {
      const gate = held();
      const steps: FakeLlmStep[] = [
        { text: "D" },
        rejectedStep(),
        { text: "V" },
        approvedStep(),
      ];
      steps[target - 1] = {
        ...steps[target - 1],
        wait: gate.promise,
      } as FakeLlmStep;
      const { fake, output, session } = setup(steps);
      const controller = new AbortController();

      const pending = session.ask("P", { signal: controller.signal });
      await until(() => fake.calls.length === target);
      controller.abort();
      const result = await pending;
      gate.release();
      const callsAfter = fake.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toEqual({ status: "cancelled" });
      expect(session.history).toEqual([]);
      expect(fake.calls).toHaveLength(callsAfter);
      expect(fake.calls).toHaveLength(target);
      expect(output.isOpen()).toBe(false);
      const notices = output.events.filter((event) =>
        event.startsWith("info:"),
      );
      expect(notices.length).toBe(target === 1 ? 0 : 1);
      if (target > 1) {
        expect(notices[0]).toContain("não foi guardada");
      }
    },
  );

  it("cancels while the line of the draft is being closed", async () => {
    const controller = new AbortController();
    const { fake, output, session } = setup([{ text: "D" }, approvedStep()]);
    output.onEnd = () => controller.abort();

    const result = await session.ask("P", { signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(session.history).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expect(output.isOpen()).toBe(false);
  });

  it("cancels while the line of the revision is being closed, right before the commit", async () => {
    const controller = new AbortController();
    const { fake, output, session } = setup([
      { text: "D" },
      rejectedStep(),
      { text: "V" },
      approvedStep(),
    ]);
    output.onEnd = (count) => {
      if (count === 2) {
        controller.abort();
      }
    };

    const result = await session.ask("P", { signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(session.history).toEqual([]);
    expect(fake.calls).toHaveLength(4);
    expect(output.isOpen()).toBe(false);
  });

  it("cancels right after the approval, before the commit", async () => {
    const controller = new AbortController();
    const { session } = setup([{ text: "D" }, approvedStep()], {
      wrap: (fake) => ({
        streamText: (request) => fake.streamText(request),
        generateStructured: async (request) => {
          const value = await fake.generateStructured(request);
          controller.abort();
          return value;
        },
      }),
    });

    const result = await session.ask("P", { signal: controller.signal });

    expect(result).toEqual({ status: "cancelled" });
    expect(session.history).toEqual([]);
  });

  it("accepts the next question after a cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { session } = setup([{ text: "D" }, approvedStep()]);

    expect(
      (await session.ask("P1", { signal: controller.signal })).status,
    ).toBe("cancelled");
    expect((await session.ask("P2")).status).toBe("answered");
  });
});

describe("self-critique: retries per phase", () => {
  function retryEvent(retry: number): RetryEvent {
    return {
      retry,
      maxRetries: 3,
      delayMs: 1000,
      cause: { kind: "transient", reason: "timeout" },
    };
  }

  it("tells about each phase with its own label, and counts logical calls", async () => {
    let writes = 0;
    const llm: LlmClient = {
      streamText: (request) => {
        writes += 1;
        request.onRetry?.(retryEvent(1));
        if (writes === 1) {
          request.onChunk?.("D");
        }
        return Promise.resolve({
          text: writes === 1 ? "D" : "V",
          model: "m",
          chunks: 1,
        });
      },
      generateStructured: (request) => {
        request.onRetry?.(retryEvent(1));
        request.onRetry?.(retryEvent(2));
        const approved = request.onRetry !== undefined && writes === 2;
        return Promise.resolve({
          value: request.schema.parse(
            approved
              ? { aprovada: true, violacoes: [] }
              : { aprovada: false, violacoes: [{ regra: "P2", motivo: "m" }] },
          ),
          model: "m",
        });
      },
    };
    const { output, session } = setup([], { wrap: () => llm });

    const result = answered(await session.ask("P"));
    const warnings = output.events.filter((event) =>
      event.startsWith("warning:"),
    );

    expect(result.critique.llmCalls).toBe(4);
    expect(warnings).toHaveLength(1 + 2 + 1 + 2);
    // The draft: the text above is incomplete. The other phases: a label.
    expect(warnings[0]).toMatch(/interrompida|tentativa/i);
    expect(warnings[0]).not.toMatch(/^warning:\[/);
    expect(warnings[1]).toMatch(/^warning:\[autoavaliação\]/);
    expect(warnings[2]).toMatch(/^warning:\[autoavaliação\]/);
    expect(warnings[3]).toMatch(/^warning:\[revisão\]/);
    expect(warnings[4]).toMatch(/^warning:\[autoavaliação\]/);
  });

  it("tells that the text of the draft is incomplete only for the draft", async () => {
    let call = 0;
    const llm: LlmClient = {
      streamText: (request) => {
        call += 1;
        request.onChunk?.("parte");
        request.onRetry?.(retryEvent(1));
        request.onChunk?.("tudo");
        return Promise.resolve({ text: "tudo", model: "m", chunks: 1 });
      },
      generateStructured: (request) => {
        request.onRetry?.(retryEvent(1));
        return Promise.resolve({
          value: request.schema.parse({ aprovada: true, violacoes: [] }),
          model: "m",
        });
      },
    };
    const { output, session } = setup([], { wrap: () => llm });

    await session.ask("P");
    const warnings = output.events.filter((e) => e.startsWith("warning:"));

    expect(call).toBe(1);
    expect(warnings[0]).toContain("texto acima está incompleto");
    expect(warnings[1]).not.toContain("texto acima está incompleto");
  });

  it("a failure of the draft is still a failed turn, with nothing kept", async () => {
    const { fake, output, session } = setup([{ error: new Error("caiu") }]);

    const result = await session.ask("P");

    expect(result.status).toBe("failed");
    expect(session.history).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expect(output.events.at(-1)).toMatch(/^error:/);
  });
});

describe("self-critique: usage", () => {
  it("adds up the usage of every call of the turn", async () => {
    const usage = (n: number) => ({
      inputTokens: n,
      outputTokens: 2 * n,
      totalTokens: 3 * n,
    });
    const { session } = setup([
      { text: "D", usage: usage(1) },
      { ...rejectedStep(), usage: usage(2) },
      { text: "V", usage: usage(3) },
      { ...approvedStep(), usage: usage(4) },
    ]);

    const result = answered(await session.ask("P"));

    expect(result.usage).toEqual(usage(10));
  });

  it("sums only what was reported, and leaves it out when nothing was", async () => {
    const { session } = setup([
      { text: "D" },
      {
        ...approvedStep(),
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      },
    ]);

    const result = answered(await session.ask("P"));

    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
    });
  });
});

describe("self-critique: the record of the turn", () => {
  it("hands the record of an answered turn to onTurn, with every field", async () => {
    const records: TurnRecord[] = [];
    const { session } = setup(
      [
        { text: "RASCUNHO" },
        rejectedStep("P3", "inventou"),
        { text: "REVISAO" },
        approvedStep(),
      ],
      { onTurn: (record) => void records.push(record) },
    );

    await session.ask("Pergunta");

    expect(records).toEqual([
      {
        at: "2026-01-02T03:04:05.000Z",
        status: "answered",
        question: "Pergunta",
        model: "fake-model",
        critique: {
          draft: "RASCUNHO",
          evaluation: {
            status: "ok",
            approved: false,
            violations: [{ rule: "P3", reason: "inventou" }],
          },
          revision: {
            text: "REVISAO",
            evaluation: { status: "ok", approved: true, violations: [] },
          },
          origin: "revisao",
          violatedRules: ["P3"],
          llmCalls: 4,
        },
      },
    ]);
  });

  it("records the origin of a fallback and an error of the evaluation", async () => {
    const records: TurnRecord[] = [];
    const { session } = setup([{ text: "D" }, { error: new Error("falhou") }], {
      onTurn: (record) => void records.push(record),
    });

    await session.ask("P");

    expect(records[0]?.critique).toMatchObject({
      origin: "fallback",
      evaluation: { status: "error", summary: { message: "falhou" } },
    });
  });

  it("records a failed turn, with the summary of the error and no critique", async () => {
    const records: TurnRecord[] = [];
    const { session } = setup([{ error: new Error("caiu") }], {
      onTurn: (record) => void records.push(record),
    });

    await session.ask("P");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "failed", question: "P" });
    expect(records[0]?.summary?.message).toBe("caiu");
    expect(records[0]).not.toHaveProperty("critique");
  });

  it("records a cancelled turn", async () => {
    const records: TurnRecord[] = [];
    const controller = new AbortController();
    controller.abort();
    const { session } = setup([{ text: "D" }], {
      onTurn: (record) => void records.push(record),
    });

    await session.ask("P", { signal: controller.signal });

    expect(records).toEqual([
      { at: "2026-01-02T03:04:05.000Z", status: "cancelled", question: "P" },
    ]);
  });

  it("does not record a question that the limit refused", async () => {
    const records: TurnRecord[] = [];
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: 60,
      now: () => 0,
      sleep: () => Promise.reject(new Error("must not sleep")),
    });
    const { session } = setup([{ text: "D" }, approvedStep()], {
      limiter,
      onTurn: (record) => void records.push(record),
    });

    await session.ask("P1");
    await session.ask("P2");

    expect(records).toHaveLength(1);
  });

  it("is not affected by an onTurn that throws, and tells about it without the secret", async () => {
    const { output, session } = setup([{ text: "D" }, approvedStep()], {
      onTurn: () => {
        throw new Error(`disco cheio ${KEY}`);
      },
    });

    const result = await session.ask("P");

    expect(result.status).toBe("answered");
    expect(session.history).toHaveLength(2);
    const warning = output.events.find((e) => e.startsWith("warning:Não foi"));
    expect(warning).toBeDefined();
    expect(output.events.join("\n")).not.toContain(KEY);
  });

  it("waits for an onTurn that is asynchronous before it accepts the next question", async () => {
    const order: string[] = [];
    const { session } = setup(
      [{ text: "D" }, approvedStep(), { text: "D2" }, approvedStep()],
      {
        onTurn: async (record) => {
          await Promise.resolve();
          order.push(record.question);
        },
      },
    );

    await session.ask("P1");
    await session.ask("P2");

    expect(order).toEqual(["P1", "P2"]);
  });

  it("refuses a second question while the record of the first is being written", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session } = setup([{ text: "D" }, approvedStep()], {
      onTurn: () => gate,
    });

    const first = session.ask("P1");
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(session.ask("P2")).rejects.toThrow("turno em andamento");
    release();
    await first;
  });
});

describe("self-critique: a closed output and unexpected errors", () => {
  it("is not kept when the output fails while showing the revision", async () => {
    const { output, session } = setup([
      { text: "D" },
      rejectedStep(),
      { text: "V" },
      approvedStep(),
    ]);
    output.chunk = (text) => {
      if (text === "V") {
        throw new Error("pipe fechado");
      }
    };

    const result = await session.ask("P");

    expect(result.status).toBe("failed");
    expect(session.history).toEqual([]);
  });

  it("an abort error raised by the client counts as a cancellation", async () => {
    const { session } = setup([
      { text: "D" },
      { error: new APIUserAbortError() },
    ]);

    const result = await session.ask("P");

    expect(result).toEqual({ status: "cancelled" });
    expect(session.history).toEqual([]);
  });
});
