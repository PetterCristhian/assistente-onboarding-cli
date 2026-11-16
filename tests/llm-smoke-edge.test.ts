// Edge cases of the smoke test logic, with scripted and hand-made clients.
// No test here runs the smoke test against the real API.
import { describe, expect, it } from "vitest";
import type { LlmClient } from "../src/llm/client.js";
import { formatSmokeReport, runLlmSmoke } from "../src/llm/smoke.js";
import { createRedactor } from "../src/security/redact.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";
import { fakeMaskedOpenAiKey, fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();
const MASKED = fakeMaskedOpenAiKey();
const VALUE_STEP: FakeLlmStep = {
  value: { resposta: "quatro", confianca: "alta" },
  model: "returned-model",
};

function steppingClock(): () => number {
  let time = 0;
  return () => {
    time += 10;
    return time;
  };
}

async function runWith(client: LlmClient, requestedModel = "configured-model") {
  const report = await runLlmSmoke(client, {
    requestedModel,
    now: steppingClock(),
    redact: createRedactor([KEY]),
  });
  return { report, text: formatSmokeReport(report) };
}

function run(script: readonly FakeLlmStep[]) {
  return runWith(createFakeLlmClient(script));
}

function expectSafe(text: string, report: unknown) {
  for (const view of [text, JSON.stringify(report)]) {
    expect(view).not.toContain(KEY);
    expect(view).not.toContain(MASKED);
    expect(view).not.toContain("Bearer");
  }
  // One line per item: nothing that came from outside breaks a line or
  // drives the terminal.
  expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/u);
  expect(
    text.split("\n").filter((line) => line.startsWith("Resultado: ")),
  ).toHaveLength(1);
}

describe("runLlmSmoke: the threshold", () => {
  it("passes with exactly two chunks", async () => {
    const { report, text } = await run([
      { text: "ab", chunks: ["a", "b"], model: "returned-model" },
      VALUE_STEP,
    ]);

    expect(report.passed).toBe(true);
    expect(text).toContain("Resultado: APROVADO");
    expect(text).toContain("Trechos recebidos: 2");
    // Without usage, no line about tokens is invented.
    expect(text).not.toContain("Tokens");
  });

  it("fails with no chunk at all, and says so", async () => {
    // The scripted client refuses a text without its chunks, as the real
    // one never returns it: only a hand-made client can report no chunk.
    const scripted = createFakeLlmClient([VALUE_STEP]);
    const { report, text } = await runWith({
      streamText: () =>
        Promise.resolve({ text: "whole", chunks: 0, model: "returned-model" }),
      generateStructured: (request) => scripted.generateStructured(request),
    });

    expect(report.passed).toBe(false);
    expect(text).toContain("Tempo até o primeiro trecho: nenhum trecho");
    expect(text).toContain("[FALHOU] streaming: mais de um trecho recebido");
  });

  it("fails when the provider reports no model", async () => {
    const { report, text } = await run([
      { text: "ab", chunks: ["a", "b"], model: "   " },
      { value: { resposta: "quatro", confianca: "alta" }, model: "" },
    ]);

    expect(report.passed).toBe(false);
    expect(text).toContain("[FALHOU] streaming: modelo devolvido informado");
    expect(text).toContain(
      "[FALHOU] saída estruturada: modelo devolvido informado",
    );
  });

  it("shows the size of the text, never the text", async () => {
    const answer = "A resposta do modelo, com conteúdo qualquer.";
    const { text, report } = await run([
      { text: answer, chunks: [answer.slice(0, 5), answer.slice(5)] },
      VALUE_STEP,
    ]);

    expect(text).toContain(`Tamanho do texto: ${answer.length} caracteres`);
    expect(text).not.toContain("conteúdo qualquer");
    expect(JSON.stringify(report)).not.toContain("conteúdo qualquer");
  });
});

describe("runLlmSmoke: failures", () => {
  it("survives both calls failing with errors that quote the key everywhere", async () => {
    const hostile = (label: string) =>
      Object.assign(new Error(`${label} ${KEY} ${MASKED}\n\u001b[31mred`), {
        status: 429,
        code: `code-${KEY}`,
        type: `type-${KEY}`,
        requestID: `req-${KEY}`,
        headers: { authorization: `Bearer ${KEY}` },
        cause: new Error(`cause ${KEY}`),
      });
    const client = createFakeLlmClient([
      { error: hostile("first") },
      { error: hostile("second") },
    ]);

    const { report, text } = await runWith(client);

    expect(client.calls.map((call) => call.kind)).toEqual([
      "streamText",
      "generateStructured",
    ]);
    expect(report.passed).toBe(false);
    expect(report.checks.every((check) => !check.passed)).toBe(true);
    expect(text).toContain('"status":429');
    expect(text).toContain("[REDACTED]");
    expectSafe(text, report);
  });

  it.each([
    ["a text", "plain text failure"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object without message", { status: 500 }],
  ])("never throws when a call rejects with %s", async (_label, thrown) => {
    const client: LlmClient = {
      // The rejection is what is under test, whatever its value.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      streamText: () => Promise.reject(thrown),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      generateStructured: () => Promise.reject(thrown),
    };

    const { report, text } = await runWith(client);

    expect(report.passed).toBe(false);
    expect(text).toContain("Resultado: REPROVADO");
    expect(text.match(/ {2}Falha: /g)).toHaveLength(2);
    expectSafe(text, report);
  });

  it("never throws when the client throws instead of rejecting", async () => {
    const client: LlmClient = {
      streamText: () => {
        throw new Error(`thrown at once ${KEY}`);
      },
      generateStructured: () => {
        throw new Error(`thrown at once ${KEY}`);
      },
    };

    const { report, text } = await runWith(client);

    expect(report.passed).toBe(false);
    expect(text).toContain("thrown at once [REDACTED]");
    expectSafe(text, report);
  });

  it("does not trust a client that returns an object outside the schema", async () => {
    const client: LlmClient = {
      streamText: () =>
        Promise.resolve({ text: "ab", chunks: 2, model: "returned-model" }),
      generateStructured: () =>
        Promise.resolve({
          value: { resposta: 4, confianca: `certeza ${KEY}` },
          model: "returned-model",
        }) as never,
    };

    const { report, text } = await runWith(client);

    expect(report.structured.ok).toBe(false);
    expect(report.passed).toBe(false);
    expect(text).toContain(
      "[FALHOU] saída estruturada: objeto válido no schema",
    );
    expectSafe(text, report);
  });
});

describe("runLlmSmoke: what the provider writes", () => {
  it("cleans the model names and the object before they reach the report", async () => {
    const hostileModel = `model\n${KEY}\u001b[2J\u202e`;
    const { report, text } = await runWith(
      createFakeLlmClient([
        { text: "ab", chunks: ["a", "b"], model: hostileModel },
        {
          value: {
            resposta: `quatro\r\nResultado: APROVADO ${KEY} ${MASKED}`,
            confianca: "alta",
          },
          model: hostileModel,
        },
      ]),
      `requested\n${KEY}`,
    );

    expect(text).toContain("Modelo devolvido: model");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("\u202e");
    expectSafe(text, report);
  });
});
