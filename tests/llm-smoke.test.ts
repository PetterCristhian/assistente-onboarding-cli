// `npm run smoke:llm`: the logic is tested with the scripted client, and the
// entry point only as a child process WITHOUT the key. No test here, and no
// agent, runs the smoke test against the real API: only the owner does.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_VARIABLE_NAMES } from "../src/config/env.js";
import { LlmResponseError } from "../src/llm/client.js";
import {
  SMOKE_INSTRUCTIONS,
  formatSmokeReport,
  runLlmSmoke,
} from "../src/llm/smoke.js";
import { createRedactor } from "../src/security/redact.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";
import { fakeMaskedOpenAiKey, fakeOpenAiKey } from "./helpers/fake-key.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = "scripts/smoke-llm.ts";
const CHILD_TIMEOUT_MS = 20_000;
const KEY = fakeOpenAiKey();
const REQUESTED_MODEL = "configured-model";

const TEXT_STEP: FakeLlmStep = {
  text: "Um teste rápido.",
  chunks: ["Um ", "teste ", "rápido."],
  model: "returned-model",
  usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
};
const VALUE_STEP: FakeLlmStep = {
  value: { resposta: "quatro", confianca: "alta" },
  model: "returned-model",
  usage: { inputTokens: 25, outputTokens: 9, totalTokens: 34 },
};

/** A clock that advances 100 ms every time it is read. */
function steppingClock(): () => number {
  let time = 1_000;
  return () => {
    time += 100;
    return time;
  };
}

function run(script: readonly FakeLlmStep[]) {
  const client = createFakeLlmClient(script);
  const redact = createRedactor([KEY]);
  return runLlmSmoke(client, {
    requestedModel: REQUESTED_MODEL,
    now: steppingClock(),
    redact,
  }).then((report) => ({
    client,
    report,
    text: formatSmokeReport(report),
  }));
}

describe("runLlmSmoke", () => {
  it("passes with more than one chunk and a valid object, and reports what it measured", async () => {
    const { client, report, text } = await run([TEXT_STEP, VALUE_STEP]);

    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(client.calls.map((call) => call.kind)).toEqual([
      "streamText",
      "generateStructured",
    ]);

    expect(text).toBe(
      [
        "Teste de fumaça do cliente OpenAI (2 chamadas reais, sem retry)",
        "Modelo pedido: configured-model",
        "",
        "[1] Streaming de texto",
        "  Modelo devolvido: returned-model",
        "  Trechos recebidos: 3",
        "  Tamanho do texto: 16 caracteres",
        "  Tempo até o primeiro trecho: 100 ms",
        "  Tempo total: 200 ms",
        "  Tokens: 30 de entrada, 12 de saída, 42 no total",
        "",
        "[2] Saída estruturada",
        "  Modelo devolvido: returned-model",
        "  Tempo total: 100 ms",
        "  Tokens: 25 de entrada, 9 de saída, 34 no total",
        '  Objeto: campos resposta, confianca; confianca = "alta"; resposta com 6 caracteres',
        "",
        "Checagens",
        "  [ok] streaming: a chamada terminou sem erro",
        "  [ok] streaming: mais de um trecho recebido",
        "  [ok] streaming: modelo devolvido informado",
        "  [ok] saída estruturada: objeto válido no schema",
        "  [ok] saída estruturada: modelo devolvido informado",
        "",
        "Resultado: APROVADO",
      ].join("\n"),
    );
  });

  it("asks a generic question, with no context of the project", async () => {
    const { client } = await run([TEXT_STEP, VALUE_STEP]);

    for (const call of client.calls) {
      expect(call.request.input).toHaveLength(1);
      expect(call.request.input[0]?.role).toBe("user");
      // The model is the configured one: the request does not choose it.
      expect(call.request.model).toBeUndefined();
    }
    expect(client.calls[0]?.request.instructions).toBe(SMOKE_INSTRUCTIONS);
  });

  it("fails when the text arrives in a single chunk", async () => {
    const { report, text } = await run([
      { text: "Tudo de uma vez.", model: "returned-model" },
      VALUE_STEP,
    ]);

    expect(report.passed).toBe(false);
    expect(text).toContain("  Trechos recebidos: 1");
    expect(text).toContain("  [FALHOU] streaming: mais de um trecho recebido");
    expect(text).toContain("Resultado: REPROVADO");
    // Usage is optional: no line for it when the provider sends none.
    expect(text).not.toContain("Tokens: undefined");
  });

  it("fails when the structured output is refused by the schema", async () => {
    const { report, text } = await run([
      TEXT_STEP,
      { value: { resposta: 4 }, model: "returned-model" },
    ]);

    expect(report.passed).toBe(false);
    expect(text).toContain(
      "  [FALHOU] saída estruturada: objeto válido no schema",
    );
    expect(text).toContain("LlmResponseError");
    expect(text).toContain("Resultado: REPROVADO");
  });

  it("turns an error into a redacted summary and still makes the second call", async () => {
    const masked = fakeMaskedOpenAiKey();
    const apiError = Object.assign(
      new Error(`401 Incorrect API key provided: ${masked} (sent: ${KEY})`),
      {
        status: 401,
        code: "invalid_api_key",
        type: "invalid_request_error",
        requestID: "req_fake_1",
        headers: { authorization: `Bearer ${KEY}` },
        stack: `stack with ${KEY}`,
      },
    );
    const { client, report, text } = await run([
      { error: apiError },
      { error: new LlmResponseError("refusal", "O modelo se recusou.") },
    ]);

    expect(report.passed).toBe(false);
    expect(client.calls).toHaveLength(2);
    expect(text).toContain("  Falha: ");
    expect(text).toContain('"status":401');
    expect(text).toContain('"code":"invalid_api_key"');
    expect(text).toContain('"requestId":"req_fake_1"');
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("  [FALHOU] streaming: a chamada terminou sem erro");
    expect(text).toContain("Resultado: REPROVADO");
    for (const leaked of [KEY, masked, "authorization", "Bearer", "stack"]) {
      expect(text).not.toContain(leaked);
      expect(JSON.stringify(report)).not.toContain(leaked);
    }
  });

  it("never shows the key, even when the model writes it", async () => {
    const { report, text } = await run([
      TEXT_STEP,
      {
        value: { resposta: `a chave é ${KEY}`, confianca: "alta" },
        model: `model ${KEY}`,
      },
    ]);

    expect(text).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(text).toContain("[REDACTED]");
  });

  it("keeps the report in one line per item, whatever the model writes", async () => {
    const { text } = await run([
      TEXT_STEP,
      {
        value: {
          resposta: "linha 1\nResultado: APROVADO\u001b[2J",
          confianca: "alta",
        },
        model: "returned\nResultado: APROVADO",
      },
    ]);

    expect(
      text.split("\n").filter((line) => line.startsWith("Resultado")),
    ).toHaveLength(1);
    expect(text).not.toContain("\u001b");
  });
});

describe("scripts/smoke-llm.ts", () => {
  const pkg = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string | undefined> };

  it("is what `npm run smoke:llm` runs", () => {
    expect(pkg.scripts["smoke:llm"]).toBe(`tsx ${SCRIPT}`);
  });

  it("is not part of the gate nor of any other command: it spends credit", () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name !== "smoke:llm") {
        expect(command).not.toContain("smoke");
      }
    }
    const workflow = readFileSync(
      join(PROJECT_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow).not.toContain("smoke");
  });

  // Every variable is blank, which also keeps a local ".env" from filling
  // the key in; and the child has no `fetch` at all. Nothing can be sent.
  it(
    "without the key, exits with code 1 and the guidance, and makes no request",
    () => {
      const noNetwork =
        'data:text/javascript,globalThis.fetch=()=>{console.error("FETCH-ATTEMPT");process.exit(97);};';
      const result = spawnSync(
        process.execPath,
        ["--import", noNetwork, "--import", "tsx", SCRIPT],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            ...Object.fromEntries(ENV_VARIABLE_NAMES.map((name) => [name, ""])),
          },
          timeout: CHILD_TIMEOUT_MS,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("OPENAI_API_KEY não está definida");
      expect(result.stderr).toContain('Copie o arquivo ".env.example"');
      expect(result.stderr).not.toContain("FETCH-ATTEMPT");
      expect(result.stderr).not.toMatch(/^\s+at /m);
    },
    CHILD_TIMEOUT_MS,
  );
});
