// Runs one scenario with the real client and records what happened, in the
// terms that `compare` (report.ts) checks. What is recorded about a failure is
// its class and the message written by src/llm/errors.ts for the user: the
// text of the error of the SDK is never read, as it may quote the key.
import type { LlmClient } from "../../src/llm/client.js";
import {
  classifyError,
  describeFailure,
  formatRetryNotice,
} from "../../src/llm/errors.js";
import type { DemoTiming } from "./config.js";
import type { CallCounter } from "./loopback-fetch.js";
import type { ScenarioSpec, WaitSource } from "./scenarios.js";
import type { StubStats } from "./stub-server.js";

export interface Observed {
  /** Real requests made by the client. */
  readonly calls: number;
  /** Requests that reached the simulated server; absent when there is none. */
  readonly serverRequests?: number;
  /** The wait planned before each new try, in ms. */
  readonly waitsMs: readonly number[];
  /** The wait that really happened before each new try, in ms. */
  readonly realWaitsMs: readonly number[];
  /** The line of each warning of a new try, as the chat prints it. */
  readonly notices: readonly string[];
  readonly waitSources: readonly Exclude<WaitSource, "none">[];
  readonly outcome: "success" | "failure";
  readonly status?: number;
  /** `kind:reason` of `classifyError`, for a failure. */
  readonly failureClass?: string;
  /** The message that the user would read, for a failure. */
  readonly userMessage?: string;
  /** Requests that the script of the server did not foresee. */
  readonly unexpectedRequests: number;
  /** Whether every request carried the key of the demonstration. */
  readonly keyOnAllRequests: boolean;
}

export interface ScenarioContext {
  readonly client: LlmClient;
  readonly timing: DemoTiming;
  readonly counter: CallCounter;
  /** Filled by the sleep of the client with the real durations of the waits. */
  readonly realWaits: readonly number[];
  /** Absent for a scenario with no server. */
  readonly serverStats?: () => StubStats;
  readonly signal?: AbortSignal;
}

const QUESTION = "Pergunta de demonstração.";

type Outcome = Pick<
  Observed,
  "outcome" | "status" | "failureClass" | "userMessage"
>;

export async function runScenario(
  spec: ScenarioSpec,
  context: ScenarioContext,
): Promise<Observed> {
  const notices: string[] = [];
  const waitsMs: number[] = [];
  const waitSources: Exclude<WaitSource, "none">[] = [];

  function snapshot(result: Outcome): Observed {
    const stats = context.serverStats?.();
    return {
      calls: context.counter.calls,
      ...(stats === undefined ? {} : { serverRequests: stats.requests }),
      waitsMs,
      realWaitsMs: [...context.realWaits],
      notices,
      waitSources,
      unexpectedRequests: stats?.unexpected ?? 0,
      keyOnAllRequests:
        stats === undefined ? true : stats.withDemoKey === stats.requests,
      ...result,
    };
  }

  try {
    await context.client.streamText({
      instructions: `Demonstração ${spec.id}.`,
      input: [{ role: "user", content: QUESTION }],
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      onRetry: (event) => {
        notices.push(formatRetryNotice(event));
        waitsMs.push(event.delayMs);
        const asked =
          event.cause.kind === "rate_limit" &&
          (event.cause.retryAfterMs !== undefined ||
            event.cause.retryAfterAt !== undefined);
        waitSources.push(asked ? "retry-after" : "backoff");
      },
    });
    return snapshot({ outcome: "success" });
  } catch (error) {
    const cause = classifyError(error);
    if (cause.kind === "cancelled") {
      throw error;
    }
    return snapshot({
      outcome: "failure",
      ...("status" in cause && cause.status !== undefined
        ? { status: cause.status }
        : {}),
      failureClass:
        cause.kind === "rate_limit"
          ? "rate_limit"
          : `${cause.kind}:${cause.reason}`,
      userMessage: describeFailure(error, {
        retries: notices.length,
        maxRetries: context.timing.maxRetries,
      }),
    });
  }
}
