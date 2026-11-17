// The five scenarios of the demonstration and what each must show. The
// expected values are worked out here on their own terms (base * 2^(n-1), the
// Retry-After in seconds), never by calling the code under test: a check
// against its own output would prove nothing.
import type { DemoTiming } from "./config.js";
import type { StubStep } from "./stub-server.js";

/** Where the wait before a new try comes from. "none": no new try is made. */
export type WaitSource = "retry-after" | "backoff" | "none";

export interface Expected {
  /** Real requests made by the client. */
  readonly calls: number;
  /** The wait planned before each new try, in ms. */
  readonly waitsMs: readonly number[];
  readonly outcome: "success" | "failure";
  /** The HTTP status of the failure; absent when there is none. */
  readonly status?: number;
  readonly waitSource: WaitSource;
  /** `kind:reason` of `classifyError`, for a failure. */
  readonly failureClass?: string;
  /** A fixed piece of the message that the user reads, for a failure. */
  readonly messageIncludes?: string;
}

export interface ScenarioSpec {
  /** The path prefix on the stub; also the name of the scenario there. */
  readonly id: string;
  readonly number: number;
  readonly title: string;
  /** The script of the server, in words, for the transcript. */
  readonly script: string;
  readonly steps: readonly StubStep[] | "closed-port";
  readonly expected: Expected;
}

/** base, 2 * base, 4 * base, ...: one wait for each new try allowed. */
function backoffWaits(t: DemoTiming): number[] {
  return Array.from(
    { length: t.maxRetries },
    (_, index) => t.baseDelayMs * 2 ** index,
  );
}

function triesText(calls: number): string {
  return `${calls} ${calls === 1 ? "tentativa" : "tentativas"}`;
}

export function buildScenarios(t: DemoTiming): ScenarioSpec[] {
  const allCalls = 1 + t.maxRetries;
  const retryAfter = String(t.retryAfterSeconds);
  return [
    {
      id: "cenario-1",
      number: 1,
      title: "429 com Retry-After e depois sucesso",
      script: `429 com "Retry-After: ${retryAfter}"; depois 200.`,
      steps: [
        {
          status: 429,
          headers: { "Retry-After": retryAfter },
          body: { code: "rate_limit_exceeded" },
        },
        { status: 200, body: "success" },
      ],
      expected: {
        calls: 2,
        waitsMs: [t.retryAfterSeconds * 1000],
        outcome: "success",
        waitSource: "retry-after",
      },
    },
    {
      id: "cenario-2",
      number: 2,
      title: "429 sem cabeçalho e depois sucesso",
      script: "429 sem cabeçalho de espera; depois 200.",
      steps: [
        { status: 429, body: { code: "rate_limit_exceeded" } },
        { status: 200, body: "success" },
      ],
      expected: {
        calls: 2,
        waitsMs: [t.baseDelayMs],
        outcome: "success",
        waitSource: "backoff",
      },
    },
    {
      id: "cenario-3",
      number: 3,
      title: "500 repetido até esgotar as tentativas",
      script: `500 em todas as ${allCalls} chamadas.`,
      steps: Array.from({ length: allCalls }, () => ({
        status: 500,
        body: { code: "server_error" },
      })),
      expected: {
        calls: allCalls,
        waitsMs: backoffWaits(t),
        outcome: "failure",
        status: 500,
        waitSource: "backoff",
        failureClass: "transient:http_status",
        messageIncludes: `Desisti depois de ${triesText(allCalls)}`,
      },
    },
    {
      id: "cenario-4",
      number: 4,
      title: "401 sem nova tentativa",
      script: "401 na primeira chamada.",
      steps: [{ status: 401, body: { code: "invalid_api_key" } }],
      expected: {
        calls: 1,
        waitsMs: [],
        outcome: "failure",
        status: 401,
        waitSource: "none",
        failureClass: "fatal:auth",
        messageIncludes: "A chave da OpenAI foi recusada",
      },
    },
    {
      id: "cenario-5",
      number: 5,
      title: "conexão recusada até esgotar as tentativas",
      script: "nenhum servidor escutando na porta; a conexão é recusada.",
      steps: "closed-port",
      expected: {
        calls: allCalls,
        waitsMs: backoffWaits(t),
        outcome: "failure",
        waitSource: "backoff",
        failureClass: "transient:connection",
        messageIncludes: "Falha de conexão com o provedor",
      },
    },
  ];
}
