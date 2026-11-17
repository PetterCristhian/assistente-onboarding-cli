// `compare` and the transcript of the demonstration: pure functions, no
// network. The transcript is versioned, so it must be deterministic and free
// of anything that changes between runs or that looks like a secret.
import { describe, expect, it } from "vitest";
import { formatRetryNotice } from "../src/llm/errors.js";
import { DEMO_API_KEY, DEMO_TIMING } from "../scripts/demo-falhas/config.js";
import type { Observed } from "../scripts/demo-falhas/observe.js";
import {
  compare,
  formatHeader,
  formatScenarioBlock,
  formatSummary,
  summaryRow,
  type SummaryExtra,
} from "../scripts/demo-falhas/report.js";
import {
  buildScenarios,
  type ScenarioSpec,
} from "../scripts/demo-falhas/scenarios.js";

const scenarios = buildScenarios(DEMO_TIMING);

function spec(number: number): ScenarioSpec {
  const found = scenarios[number - 1];
  if (found === undefined) {
    throw new Error("no such scenario");
  }
  return found;
}

const notice = (retry: number, delayMs: number) =>
  formatRetryNotice({
    retry,
    maxRetries: 3,
    delayMs,
    cause: { kind: "rate_limit", status: 429, retryAfterMs: delayMs },
  });

const ONE: Observed = {
  calls: 2,
  serverRequests: 2,
  waitsMs: [1000],
  realWaitsMs: [1004],
  notices: [notice(1, 1000)],
  waitSources: ["retry-after"],
  outcome: "success",
  unexpectedRequests: 0,
  keyOnAllRequests: true,
};

const FOUR: Observed = {
  calls: 1,
  serverRequests: 1,
  waitsMs: [],
  realWaitsMs: [],
  notices: [],
  waitSources: [],
  outcome: "failure",
  status: 401,
  failureClass: "fatal:auth",
  userMessage: "A chave da OpenAI foi recusada. Confira o valor.",
  unexpectedRequests: 0,
  keyOnAllRequests: true,
};

const EXTRA: SummaryExtra = {
  serverClosed: true,
  withinTimeLimit: true,
  timeLimitSeconds: 60,
};

function failed(checks: ReturnType<typeof compare>): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.label);
}

describe("compare", () => {
  it("passes when everything is as expected", () => {
    expect(failed(compare(spec(1), ONE))).toEqual([]);
    expect(failed(compare(spec(4), FOUR))).toEqual([]);
  });

  it.each<[string, Partial<Observed>]>([
    ["Chamadas do cliente", { calls: 3 }],
    ["Requisições recebidas pelo servidor", { serverRequests: 3 }],
    ["Esperas planejadas (ms)", { waitsMs: [100] }],
    ["Origem da espera", { waitSources: ["backoff"] }],
    ["Avisos de nova tentativa", { notices: [] }],
    ["Desfecho", { outcome: "failure" }],
    ["Requisições fora do roteiro", { unexpectedRequests: 1 }],
    ["Chave da demonstração em toda requisição", { keyOnAllRequests: false }],
  ])("fails on %s when it differs", (label, change) => {
    expect(failed(compare(spec(1), { ...ONE, ...change }))).toContain(label);
  });

  it("fails when a real wait is shorter than the planned one, beyond the tolerance", () => {
    const labels = failed(compare(spec(1), { ...ONE, realWaitsMs: [900] }));

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^Espera real de pelo menos a planejada/);
  });

  it("accepts a real wait a little under the planned one, and any wait above it", () => {
    expect(failed(compare(spec(1), { ...ONE, realWaitsMs: [990] }))).toEqual(
      [],
    );
    expect(failed(compare(spec(1), { ...ONE, realWaitsMs: [30_000] }))).toEqual(
      [],
    );
  });

  it("fails on the status, the class and the message of a failure", () => {
    expect(failed(compare(spec(4), { ...FOUR, status: 403 }))).toContain(
      "Status HTTP da falha",
    );
    expect(
      failed(compare(spec(4), { ...FOUR, failureClass: "fatal:permission" })),
    ).toContain("Classificação da falha");
    expect(
      failed(compare(spec(4), { ...FOUR, userMessage: "Outro texto." })),
    ).toContain("Mensagem ao usuário");
  });

  it("expects no HTTP status in the scenario of the refused connection", () => {
    const five = spec(5);
    const observed: Observed = {
      calls: 4,
      waitsMs: [100, 200, 400],
      realWaitsMs: [100, 200, 400],
      notices: ["a", "b", "c"],
      waitSources: ["backoff", "backoff", "backoff"],
      outcome: "failure",
      failureClass: "transient:connection",
      userMessage:
        "Falha de conexão com o provedor. Desisti depois de 4 tentativas.",
      unexpectedRequests: 0,
      keyOnAllRequests: true,
    };

    expect(failed(compare(five, observed))).toEqual([]);
    expect(failed(compare(five, { ...observed, status: 500 }))).toEqual([
      "Status HTTP da falha",
    ]);
  });
});

describe("formatSummary", () => {
  const rows = (oks: boolean[]) =>
    oks.map((ok, index) => ({
      number: index + 1,
      expected: "2 chamadas, sucesso",
      obtained: ok ? "2 chamadas, sucesso" : "1 chamada, falha 500",
      ok,
    }));

  it("is all right only when every scenario, the server and the time are", () => {
    const good = formatSummary(rows([true, true, true, true, true]), EXTRA);

    expect(good.allOk).toBe(true);
    expect(good.text).toContain(
      "Resultado geral: 5 de 5 cenários conferem (mais o encerramento do servidor). Código de saída 0.",
    );
    expect(good.text).toContain("CONFERE");
    expect(good.text).not.toContain("DIVERGE");
  });

  it("is not when a scenario differs", () => {
    const bad = formatSummary(rows([true, false, true, true, true]), EXTRA);

    expect(bad.allOk).toBe(false);
    expect(bad.text).toContain("4 de 5 cenários conferem");
    expect(bad.text).toContain("Código de saída 1.");
    expect(bad.text).toContain("DIVERGE");
  });

  it("is not when the server did not close", () => {
    const bad = formatSummary(rows([true, true]), {
      ...EXTRA,
      serverClosed: false,
    });

    expect(bad.allOk).toBe(false);
    expect(bad.text).toContain("Código de saída 1.");
  });

  it("is not when the time limit was passed", () => {
    const bad = formatSummary(rows([true, true]), {
      ...EXTRA,
      withinTimeLimit: false,
    });

    expect(bad.allOk).toBe(false);
    expect(bad.text).toContain("a duração passou do limite");
  });

  it("builds a row from a scenario and what was observed", () => {
    const entry = summaryRow(spec(4), FOUR, compare(spec(4), FOUR));

    expect(entry).toEqual({
      number: 4,
      expected: "1 chamada, falha 401",
      obtained: "1 chamada, falha 401",
      ok: true,
    });
  });
});

describe("the text of the transcript", () => {
  function transcript(): string {
    const parts = [formatHeader(DEMO_TIMING)];
    parts.push(
      formatScenarioBlock(spec(1), ONE, compare(spec(1), ONE)),
      formatScenarioBlock(spec(4), FOUR, compare(spec(4), FOUR)),
      formatSummary(
        [
          summaryRow(spec(1), ONE, compare(spec(1), ONE)),
          summaryRow(spec(4), FOUR, compare(spec(4), FOUR)),
        ],
        EXTRA,
      ).text,
    );
    return `${parts.join("\n\n")}\n`;
  }

  it("is the same every time it is written", () => {
    expect(transcript()).toBe(transcript());
  });

  it("shows the warning exactly as the chat prints it", () => {
    expect(transcript()).toContain(`  Aviso: ${notice(1, 1000)}`);
    expect(transcript()).toContain(
      "  Espera planejada: 1000 ms (origem: Retry-After do provedor)",
    );
  });

  it("says that a scenario made no new try when there is no warning", () => {
    expect(formatScenarioBlock(spec(4), FOUR, [])).toContain(
      "Nenhum aviso: o cliente não tentou de novo.",
    );
  });

  it("holds no port, date, key, header name, emoji or measured time", () => {
    const text = transcript();

    expect(text).not.toMatch(/:\d{4,5}\b/);
    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(text).not.toMatch(/\b\d{1,2}:\d{2}(:\d{2})?\b/);
    expect(text).not.toMatch(/sk-/i);
    expect(text).not.toContain(DEMO_API_KEY);
    expect(text).not.toMatch(/authorization|bearer/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toContain("1004");
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("\r");
  });

  it("describes the client in the header from the timing it is given", () => {
    expect(formatHeader(DEMO_TIMING)).toContain(
      "até 3 novas tentativas (4 chamadas), espera base de 100 ms dobrando a cada tentativa, sem jitter, teto de 30 s.",
    );
  });
});
