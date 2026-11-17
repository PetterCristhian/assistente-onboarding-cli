// One chat session: the history of the turns and the single pipeline that
// answers a question (architecture rule 6). It knows no terminal: whatever
// is shown goes to the ChatOutput that the caller passes in, so that the
// chat and the test battery can share it.
import {
  formatRateLimitNotice,
  waitSecondsFor,
  type RateLimiter,
} from "./rate-limiter.js";
import {
  APIError,
  APIUserAbortError,
  type LlmClient,
  type LlmMessage,
  type LlmTextResult,
  type LlmUsage,
} from "../llm/client.js";
import { describeFailure, formatRetryNotice } from "../llm/errors.js";
import type { RetryEvent } from "../llm/retry.js";
import {
  summarizeError,
  type ErrorSummary,
} from "../security/error-summary.js";
import type { Redactor } from "../security/redact.js";

export type NoticeLevel = "info" | "warning" | "error";

/** Where the session sends what the user sees. */
export interface ChatOutput {
  /** A piece of the answer, as it arrives. No line break is implied. */
  chunk(text: string): void;
  /** The answer is over (complete or cut): closes the line. */
  endAnswer(): void;
  notice(level: NoticeLevel, text: string): void;
}

export interface ChatSessionDeps {
  readonly llm: LlmClient;
  /** The whole assembled context. */
  readonly instructions: string;
  readonly output: ChatOutput;
  readonly redact: Redactor;
  /**
   * The local limit on questions. Without it there is no limit. The policy
   * is the caller's: the chat refuses, the battery waits.
   */
  readonly rateLimit?: {
    readonly limiter: RateLimiter;
    readonly mode: "refuse" | "wait";
  };
}

export type TurnResult =
  | {
      status: "answered";
      text: string;
      model: string;
      chunks: number;
      /** As reported by the provider; absent when it reported none. */
      usage?: LlmUsage;
    }
  | { status: "cancelled" }
  /** The local limit was reached: the question was not sent nor kept. */
  | { status: "rate_limited"; waitSeconds: number }
  | { status: "failed"; summary: ErrorSummary };

export interface ChatSession {
  readonly history: readonly LlmMessage[];
  ask(
    question: string,
    options?: { signal?: AbortSignal },
  ): Promise<TurnResult>;
  clear(): void;
}

const BUSY_MESSAGE = "turno em andamento";

export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const history: LlmMessage[] = [];
  let busy = false;
  // Whether a line of the answer is open on the output: some text was
  // streamed and the line was not closed yet.
  let open = false;

  /** The draft of the answer: the model streams it to the output. */
  function draftAnswer(
    input: readonly LlmMessage[],
    signal: AbortSignal | undefined,
    onChunk: (chunk: string) => void,
    onRetry: (event: RetryEvent) => void,
  ): Promise<LlmTextResult> {
    return deps.llm.streamText({
      instructions: deps.instructions,
      input,
      ...(signal === undefined ? {} : { signal }),
      onChunk,
      onRetry,
    });
  }

  /**
   * The only place that writes to the history (architecture rule 5).
   * ENG-53 puts the self-evaluation between `draftAnswer` and this call:
   * only an approved text, or the safe message, may get here.
   */
  function commitTurn(question: string, text: string): void {
    // Before the history changes: if closing the line fails, the turn is not
    // kept. Cleared first, so that the failure path does not close it twice.
    open = false;
    deps.output.endAnswer();
    history.push(
      { role: "user", content: question },
      { role: "assistant", content: text },
    );
  }

  /** Takes a slot of the local limit; a result only when the turn must end. */
  async function takeRateLimitSlot(
    signal: AbortSignal | undefined,
  ): Promise<TurnResult | undefined> {
    const { rateLimit } = deps;
    if (rateLimit === undefined) {
      return undefined;
    }
    const waiting = rateLimit.mode === "wait";
    const slot = await rateLimit.limiter.acquire({
      wait: waiting,
      ...(signal === undefined ? {} : { signal }),
      onWait: (retryAfterMs) => {
        deps.output.notice(
          "info",
          `Aguardando ${waitSecondsFor(retryAfterMs)} s para respeitar o limite de perguntas.`,
        );
      },
    });
    if (slot.allowed) {
      return undefined;
    }
    const waitSeconds = waitSecondsFor(slot.retryAfterMs);
    deps.output.notice(
      "warning",
      formatRateLimitNotice(
        rateLimit.limiter.maxRequests,
        rateLimit.limiter.windowSeconds,
        waitSeconds,
      ),
    );
    return { status: "rate_limited", waitSeconds };
  }

  async function ask(
    question: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TurnResult> {
    if (busy) {
      throw new Error(BUSY_MESSAGE);
    }
    busy = true;
    open = false;
    const { signal } = options;
    let retries = 0;
    let maxRetries = 0;
    try {
      // A slot is taken once per accepted question. A turn that fails or is
      // cancelled after this point does not give it back.
      const limited = await takeRateLimitSlot(signal);
      if (limited !== undefined) {
        return limited;
      }
      const input: LlmMessage[] = [
        ...history,
        { role: "user", content: question },
      ];
      const result = await draftAnswer(
        input,
        signal,
        (chunk) => {
          open = true;
          deps.output.chunk(chunk);
        },
        (event) => {
          // What was streamed by this try is thrown away: the line is closed,
          // the user is told, and the next try writes below it. Only the text
          // of the try that wins reaches the history.
          const partial = open;
          if (open) {
            open = false;
            deps.output.endAnswer();
          }
          retries = event.retry;
          maxRetries = event.maxRetries;
          deps.output.notice(
            "warning",
            formatRetryNotice(event, { partialText: partial }),
          );
        },
      );
      commitTurn(question, result.text);
      return {
        status: "answered",
        text: result.text,
        model: result.model,
        chunks: result.chunks,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    } catch (error) {
      const hadText = open;
      if (open) {
        open = false;
        deps.output.endAnswer();
      }
      if (error instanceof APIUserAbortError || signal?.aborted === true) {
        return { status: "cancelled" };
      }
      const summary = summarizeError(error, deps.redact);
      if (hadText) {
        deps.output.notice("warning", "Resposta interrompida.");
      }
      deps.output.notice(
        "error",
        deps.redact(
          describeFailure(error, {
            retries,
            maxRetries,
            // The message of an error of the SDK is never shown: the one of
            // a 401 quotes the key. Any other error keeps its own message.
            ...(error instanceof APIError
              ? {}
              : { unknownMessage: summary.message }),
          }),
        ),
      );
      return { status: "failed", summary };
    } finally {
      busy = false;
    }
  }

  return {
    get history(): readonly LlmMessage[] {
      return [...history];
    },
    ask,
    clear(): void {
      if (busy) {
        throw new Error(BUSY_MESSAGE);
      }
      history.length = 0;
    },
  };
}
