// The whole demonstration (ENG-54), with everything it touches passed in: the
// numbers, the writer, the printer, the clock and the signal. This is the only
// file of the demonstration that creates the real client of the chat, so
// the retry that is shown is the one the chat uses: nothing of it is copied.
//
// Scenarios 1 to 4 run against the simulated server. For scenario 5 the server
// is stopped first, and the port that it just freed is the one that refuses
// the connections, which is a real refused connection with no name lookup.
import { createOpenAiLlmClient } from "../../src/llm/client.js";
import { defaultSleep } from "../../src/llm/retry.js";
import type { SafeWriter } from "../../src/security/safe-writer.js";
import { DEMO_API_KEY, demoClientConfig, type DemoTiming } from "./config.js";
import { createLoopbackFetch, type CallCounter } from "./loopback-fetch.js";
import { runScenario, type Observed } from "./observe.js";
import {
  compare,
  formatHeader,
  formatScenarioBlock,
  formatSummary,
  summaryRow,
  type SummaryRow,
} from "./report.js";
import { buildScenarios, type ScenarioSpec } from "./scenarios.js";
import {
  STUB_HOST,
  findRefusedPort,
  isPortRefused,
  startStubServer,
} from "./stub-server.js";

export const EVIDENCE_PATH = "outputs/evidencias/retry-rate-limit.txt";
export const TIME_LIMIT_SECONDS = 60;

export interface DemoDeps {
  readonly timing: DemoTiming;
  readonly writer: SafeWriter;
  /** Writes the text as it is: the chunks already hold their line breaks. */
  readonly print: (text: string) => void;
  /** A clock in ms; only differences are used. */
  readonly now: () => number;
  /** Aborts the demonstration (Ctrl+C): exit code 130 and nothing written. */
  readonly signal?: AbortSignal;
  /** The simulated server; a test passes its own to watch the shutdown. */
  readonly startServer?: typeof startStubServer;
}

export interface DemoResult {
  readonly exitCode: 0 | 1 | 130;
  /** What is written to the file: the same text that was printed. */
  readonly transcript: string;
  /** The absolute path of the file, when it was written. */
  readonly written?: string;
}

const NOT_WRITTEN_MESSAGE =
  "Transcrição não gravada: há cenários que não conferem";
const INTERRUPTED_MESSAGE = "Interrompido. Nada foi gravado.";
const NO_CLOSED_PORT_MESSAGE =
  "Não foi possível obter uma porta fechada para este cenário.";

export async function runDemo(deps: DemoDeps): Promise<DemoResult> {
  const { timing } = deps;
  const started = deps.now();
  const chunks: string[] = [];
  const emit = (text: string): void => {
    chunks.push(text);
    deps.print(text);
  };
  const transcript = (): string => chunks.join("");

  emit(`${formatHeader(timing)}\n\n`);

  const stub = await (deps.startServer ?? startStubServer)(DEMO_API_KEY);
  const rows: SummaryRow[] = [];

  /** Builds a client of its own for the scenario, so that its numbers are its own. */
  async function observe(
    spec: ScenarioSpec,
    baseURL: string,
    serverStats?: () => ReturnType<typeof stub.stats>,
  ): Promise<void> {
    const counter: CallCounter = { calls: 0 };
    const realWaits: number[] = [];
    // The same wait of the chat, with its real duration kept for the check.
    const measuringSleep = async (
      ms: number,
      signal?: AbortSignal,
    ): Promise<void> => {
      const begun = deps.now();
      await defaultSleep(ms, signal);
      realWaits.push(deps.now() - begun);
    };
    const client = createOpenAiLlmClient(demoClientConfig(timing), {
      baseURL,
      fetch: createLoopbackFetch(globalThis.fetch, counter),
      retry: { random: () => 0, sleep: measuringSleep },
    });
    const observed = await runScenario(spec, {
      client,
      timing,
      counter,
      realWaits,
      ...(serverStats === undefined ? {} : { serverStats }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    report(spec, observed);
  }

  function report(spec: ScenarioSpec, observed: Observed): void {
    const checks = compare(spec, observed);
    emit(`${formatScenarioBlock(spec, observed, checks)}\n\n`);
    rows.push(summaryRow(spec, observed, checks));
  }

  function interrupted(): DemoResult {
    deps.print(`
${INTERRUPTED_MESSAGE}
`);
    return { exitCode: 130, transcript: transcript() };
  }

  try {
    const scenarios = buildScenarios(timing);
    const served = scenarios.filter((spec) => spec.steps !== "closed-port");
    const refused = scenarios.filter((spec) => spec.steps === "closed-port");

    for (const spec of served) {
      if (spec.steps === "closed-port") {
        continue;
      }
      stub.script(spec.id, spec.steps);
      await observe(spec, stub.baseUrlFor(spec.id), () => stub.stats(spec.id));
    }

    const freedPort = stub.port;
    await stub.stop();
    const closedPort = (await isPortRefused(freedPort))
      ? freedPort
      : await findRefusedPort();
    for (const spec of refused) {
      if (closedPort === undefined) {
        report(spec, {
          calls: 0,
          waitsMs: [],
          realWaitsMs: [],
          notices: [],
          waitSources: [],
          outcome: "failure",
          userMessage: NO_CLOSED_PORT_MESSAGE,
          unexpectedRequests: 0,
          keyOnAllRequests: true,
        });
        continue;
      }
      await observe(spec, `http://${STUB_HOST}:${closedPort}/${spec.id}/v1`);
    }

    // Closed is judged by the server itself: the port may have been taken by
    // another process after it was freed, which says nothing about this server.
    const serverClosed = !stub.isListening() && stub.openConnections() === 0;
    const withinTimeLimit = deps.now() - started < TIME_LIMIT_SECONDS * 1000;
    const summary = formatSummary(rows, {
      serverClosed,
      withinTimeLimit,
      timeLimitSeconds: TIME_LIMIT_SECONDS,
    });
    emit(`${summary.text}\n`);

    if (deps.signal?.aborted === true) {
      return interrupted();
    }
    if (!summary.allOk) {
      deps.print(`${NOT_WRITTEN_MESSAGE}\n`);
      return { exitCode: 1, transcript: transcript() };
    }
    const written = await deps.writer.writeText(EVIDENCE_PATH, transcript());
    return { exitCode: 0, transcript: transcript(), written };
  } catch (error) {
    if (deps.signal?.aborted === true) {
      deps.print(`\n${INTERRUPTED_MESSAGE}\n`);
      return { exitCode: 130, transcript: transcript() };
    }
    throw error;
  } finally {
    await stub.stop();
  }
}
