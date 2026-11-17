// Pure functions: compare what happened with what was expected, and write the
// transcript. The text is deterministic on purpose, because it is versioned:
// no date, no port, no measured time, no version and no absolute path. Of the
// real durations, only a yes or no (was the wait at least the planned one?)
// is written.
import { MAX_RETRY_DELAY_MS } from "../../src/llm/retry.js";
import type { DemoTiming } from "./config.js";
import type { Observed } from "./observe.js";
import type { ScenarioSpec, WaitSource } from "./scenarios.js";

export interface Check {
  readonly label: string;
  readonly expected: string;
  readonly obtained: string;
  readonly ok: boolean;
}

/** A wait that ended up to this much earlier than planned still counts. */
export const WAIT_TOLERANCE_MS = 15;

const SOURCE_TEXT: Readonly<Record<WaitSource, string>> = {
  "retry-after": "Retry-After do provedor",
  backoff: "espera exponencial do cliente",
  none: "nenhuma",
};

function listText(values: readonly (number | string)[]): string {
  return `[${values.join(", ")}]`;
}

function yesNo(value: boolean): string {
  return value ? "sim" : "não";
}

function sourceText(sources: readonly WaitSource[]): string {
  const distinct = [...new Set(sources)];
  if (distinct.length === 0) {
    return SOURCE_TEXT.none;
  }
  return distinct.map((source) => SOURCE_TEXT[source]).join(" e ");
}

function realWaitsReachPlanned(obs: Observed): boolean {
  return (
    obs.realWaitsMs.length === obs.waitsMs.length &&
    obs.waitsMs.every(
      (planned, index) =>
        (obs.realWaitsMs[index] ?? -Infinity) >= planned - WAIT_TOLERANCE_MS,
    )
  );
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function compare(spec: ScenarioSpec, obs: Observed): Check[] {
  const want = spec.expected;
  const checks: Check[] = [];
  const add = (
    label: string,
    expected: string,
    obtained: string,
    ok: boolean,
  ): void => {
    checks.push({ label, expected, obtained, ok });
  };

  add(
    "Chamadas do cliente",
    String(want.calls),
    String(obs.calls),
    obs.calls === want.calls,
  );
  if (spec.steps !== "closed-port") {
    const received = obs.serverRequests;
    add(
      "Requisições recebidas pelo servidor",
      String(want.calls),
      received === undefined ? "nenhuma informação" : String(received),
      received === want.calls,
    );
  }
  add(
    "Esperas planejadas (ms)",
    listText(want.waitsMs),
    listText(obs.waitsMs),
    sameList(obs.waitsMs, want.waitsMs),
  );
  const expectedSources: WaitSource[] =
    want.waitSource === "none" ? [] : [want.waitSource];
  add(
    "Origem da espera",
    sourceText(expectedSources),
    sourceText(obs.waitSources),
    obs.waitSources.length === want.waitsMs.length &&
      obs.waitSources.every((source) => source === want.waitSource),
  );
  add(
    `Espera real de pelo menos a planejada (tolerância de ${WAIT_TOLERANCE_MS} ms)`,
    "sim",
    yesNo(realWaitsReachPlanned(obs)),
    realWaitsReachPlanned(obs),
  );
  add(
    "Avisos de nova tentativa",
    String(want.waitsMs.length),
    String(obs.notices.length),
    obs.notices.length === want.waitsMs.length,
  );
  add(
    "Desfecho",
    want.outcome === "success" ? "sucesso" : "falha",
    obs.outcome === "success" ? "sucesso" : "falha",
    obs.outcome === want.outcome,
  );
  if (want.outcome === "failure") {
    add(
      "Status HTTP da falha",
      want.status === undefined ? "nenhum" : String(want.status),
      obs.status === undefined ? "nenhum" : String(obs.status),
      obs.status === want.status,
    );
    if (want.failureClass !== undefined) {
      add(
        "Classificação da falha",
        want.failureClass,
        obs.failureClass ?? "nenhuma",
        obs.failureClass === want.failureClass,
      );
    }
    if (want.messageIncludes !== undefined) {
      const holds = obs.userMessage?.includes(want.messageIncludes) === true;
      add(
        "Mensagem ao usuário",
        `contém "${want.messageIncludes}"`,
        holds ? "contém o trecho" : "não contém o trecho",
        holds,
      );
    }
  }
  add(
    "Requisições fora do roteiro",
    "0",
    String(obs.unexpectedRequests),
    obs.unexpectedRequests === 0,
  );
  if (spec.steps !== "closed-port") {
    add(
      "Chave da demonstração em toda requisição",
      "sim",
      yesNo(obs.keyOnAllRequests),
      obs.keyOnAllRequests,
    );
  }
  return checks;
}

function millisecondsText(ms: number): string {
  return `${ms} ms`;
}

export function formatHeader(t: DemoTiming): string {
  return [
    "Demonstração de falhas do provedor: retry e rate limit (ENG-54)",
    "Servidor simulado em 127.0.0.1 (porta livre, encerrado ao final). Chave falsa. Nenhuma requisição sai da máquina.",
    `Cliente real (LlmClient + withRetry): até ${t.maxRetries} novas tentativas (${1 + t.maxRetries} chamadas), espera base de ${millisecondsText(t.baseDelayMs)} dobrando a cada tentativa, sem jitter, teto de ${MAX_RETRY_DELAY_MS / 1000} s.`,
  ].join("\n");
}

function outcomeLine(obs: Observed): string {
  if (obs.outcome === "success") {
    return `Desfecho: sucesso na chamada ${obs.calls}.`;
  }
  const calls = `${obs.calls} ${obs.calls === 1 ? "chamada" : "chamadas"}`;
  const status =
    obs.status === undefined ? "sem status HTTP" : `status HTTP ${obs.status}`;
  return `Desfecho: falha depois de ${calls} (${status}).`;
}

export function formatScenarioBlock(
  spec: ScenarioSpec,
  obs: Observed,
  checks: readonly Check[],
): string {
  const lines = [
    `== Cenário ${spec.number}: ${spec.title} ==`,
    `Roteiro do servidor: ${spec.script}`,
  ];
  if (obs.notices.length === 0) {
    lines.push("  Nenhum aviso: o cliente não tentou de novo.");
  }
  obs.notices.forEach((notice, index) => {
    const planned = obs.waitsMs[index];
    const source = obs.waitSources[index];
    lines.push(`  Aviso: ${notice}`);
    if (planned !== undefined && source !== undefined) {
      lines.push(
        `  Espera planejada: ${millisecondsText(planned)} (origem: ${SOURCE_TEXT[source]})`,
      );
    }
  });
  lines.push(outcomeLine(obs));
  if (obs.userMessage !== undefined) {
    lines.push(`Mensagem ao usuário: ${obs.userMessage}`);
  }
  for (const check of checks) {
    lines.push(
      `  [${check.ok ? "ok" : "FALHOU"}] ${check.label}: esperado ${check.expected}, obtido ${check.obtained}`,
    );
  }
  return lines.join("\n");
}

export interface SummaryRow {
  readonly number: number;
  readonly expected: string;
  readonly obtained: string;
  readonly ok: boolean;
}

function describeResult(
  calls: number,
  outcome: "success" | "failure",
  status: number | undefined,
): string {
  const word = calls === 1 ? "chamada" : "chamadas";
  const result =
    outcome === "success"
      ? "sucesso"
      : status === undefined
        ? "falha sem status"
        : `falha ${status}`;
  return `${calls} ${word}, ${result}`;
}

export function summaryRow(
  spec: ScenarioSpec,
  obs: Observed,
  checks: readonly Check[],
): SummaryRow {
  const want = spec.expected;
  return {
    number: spec.number,
    expected: describeResult(want.calls, want.outcome, want.status),
    obtained: describeResult(obs.calls, obs.outcome, obs.status),
    ok: checks.every((check) => check.ok),
  };
}

export interface SummaryExtra {
  /** The local server is closed and its port refuses connections. */
  readonly serverClosed: boolean;
  /** The whole demonstration took less than the limit. */
  readonly withinTimeLimit: boolean;
  /** The limit, in seconds. */
  readonly timeLimitSeconds: number;
}

const COLUMN_WIDTH = 28;

function row(cells: readonly string[]): string {
  return [
    cells[0]?.padEnd(10),
    cells[1]?.padEnd(COLUMN_WIDTH),
    cells[2]?.padEnd(COLUMN_WIDTH),
    cells[3],
  ].join(" | ");
}

export function formatSummary(
  rows: readonly SummaryRow[],
  extra: SummaryExtra,
): { text: string; allOk: boolean } {
  const matching = rows.filter((entry) => entry.ok).length;
  const allOk =
    matching === rows.length && extra.serverClosed && extra.withinTimeLimit;
  const lines = [
    "== Resumo ==",
    row(["Cenário", "Esperado", "Obtido", "Resultado"]),
    ...rows.map((entry) =>
      row([
        String(entry.number),
        entry.expected,
        entry.obtained,
        entry.ok ? "CONFERE" : "DIVERGE",
      ]),
    ),
    `Servidor local encerrado ao final: esperado sim, obtido ${yesNo(extra.serverClosed)} | ${extra.serverClosed ? "CONFERE" : "DIVERGE"}`,
    `Duração total abaixo de ${extra.timeLimitSeconds} s: esperado sim, obtido ${yesNo(extra.withinTimeLimit)} | ${extra.withinTimeLimit ? "CONFERE" : "DIVERGE"}`,
    `Resultado geral: ${matching} de ${rows.length} cenários conferem${extra.serverClosed ? " (mais o encerramento do servidor)" : "; o servidor local não encerrou como esperado"}${extra.withinTimeLimit ? "" : "; a duração passou do limite"}. Código de saída ${allOk ? 0 : 1}.`,
  ];
  return { text: lines.join("\n"), allOk };
}
