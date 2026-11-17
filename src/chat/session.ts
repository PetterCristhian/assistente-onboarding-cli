// One chat session: the history of the turns and the single pipeline that
// answers a question (architecture rule 6). It knows no terminal: whatever
// is shown goes to the ChatOutput that the caller passes in, so that the
// chat and the test battery can share it.
//
// The pipeline of a turn (docs/adr/0004-streaming-e-self-critique.md):
//   1. DRAFT     streamed to the output as it arrives;
//   2. EVALUATE  the self-evaluation of the draft (policies P1 to P5);
//   3. REVISE    only if rejected, once, shown only after approved;
//   4. EVALUATE  the revision;
//   and, when nothing is approved or anything fails, the FALLBACK message.
// At most 4 calls to the model per turn. Only an approved text or the safe
// message ever reaches the history (architecture rule 5).
import {
  buildEvaluationRequest,
  buildRevisionRequest,
  describeViolations,
  normalizeEvaluation,
  rulesOf,
  type CritiqueDeps,
  type EvaluationOutcome,
  type Origin,
  type TurnCritique,
} from "./critique.js";
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
import type { StreamRedactor } from "../security/stream-redact.js";

export type NoticeLevel = "info" | "warning" | "error";

/** Where the session sends what the user sees. */
export interface ChatOutput {
  /** A piece of the answer, as it arrives. No line break is implied. */
  chunk(text: string): void;
  /** The answer is over (complete or cut): closes the line. */
  endAnswer(): void;
  /** Tells that the answer shown above was withdrawn, and why. */
  retraction(text: string): void;
  notice(level: NoticeLevel, text: string): void;
}

/** What one turn leaves behind, for the log of the session. */
export interface TurnRecord {
  /** ISO 8601, from the clock of the session. */
  readonly at: string;
  readonly status: "answered" | "failed" | "cancelled";
  readonly question: string;
  /** Only for an answered turn. */
  readonly critique?: TurnCritique;
  /** Only for a failed turn. */
  readonly summary?: ErrorSummary;
  /** The model that wrote the final text, for an answered turn. */
  readonly model?: string;
}

export interface ChatSessionDeps {
  readonly llm: LlmClient;
  /** The whole assembled context. */
  readonly instructions: string;
  /** The self-evaluation: prompts, layers 2 to 4 and the safe message. */
  readonly critique: CritiqueDeps;
  readonly output: ChatOutput;
  readonly redact: Redactor;
  /**
   * Makes the redactor of the draft that is streamed (one per try). Without
   * it each piece is redacted alone, which cannot catch a key that is split
   * between two pieces: the entry points always pass it.
   */
  readonly redactStream?: () => StreamRedactor;
  /**
   * The local limit on questions. Without it there is no limit. The policy
   * is the caller's: the chat refuses, the battery waits.
   */
  readonly rateLimit?: {
    readonly limiter: RateLimiter;
    readonly mode: "refuse" | "wait";
  };
  /** Called after each turn that was sent to the model, awaited. */
  readonly onTurn?: (record: TurnRecord) => void | Promise<void>;
  /** The clock of `TurnRecord.at`. Without it, the epoch (tests). */
  readonly now?: () => Date;
}

export type TurnResult =
  | {
      status: "answered";
      /** The final text: the approved draft, the approved revision or the safe message. */
      text: string;
      /** The model that wrote the draft, or the revision if it was used. */
      model: string;
      /** Pieces of the draft, as streamed. */
      chunks: number;
      /** The sum over the calls of the turn; absent when none reported usage. */
      usage?: LlmUsage;
      critique: TurnCritique;
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

type Phase = "draft" | "evaluate" | "revise" | "reevaluate" | "commit";
type RetryCounters = Record<Phase, { retries: number; maxRetries: number }>;

const EVALUATION_LABEL = "[autoavaliação]";
const UNVERIFIED_RETRACTION =
  "A resposta acima foi retirada porque não pôde ser verificada.";
const REVISION_LABEL = "[revisão]";
const NO_RETRIES = { retries: 0, maxRetries: 0 };

/** The sum of the usage of the calls; undefined while none reported any. */
function addUsage(
  total: LlmUsage | undefined,
  more: LlmUsage | undefined,
): LlmUsage | undefined {
  if (more === undefined) {
    return total;
  }
  return total === undefined
    ? more
    : {
        inputTokens: total.inputTokens + more.inputTokens,
        outputTokens: total.outputTokens + more.outputTokens,
        totalTokens: total.totalTokens + more.totalTokens,
      };
}

export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const history: LlmMessage[] = [];
  let busy = false;
  // Whether a line of the answer is open on the output: some text was
  // streamed and the line was not closed yet.
  let open = false;

  function isCancellation(
    error: unknown,
    signal: AbortSignal | undefined,
  ): boolean {
    return error instanceof APIUserAbortError || signal?.aborted === true;
  }

  /** No call is made for a turn that was cancelled in the meantime. */
  function ensureNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new APIUserAbortError();
    }
  }

  function closeLine(): void {
    // Cleared first: if closing fails, the failure path does not close again.
    if (open) {
      open = false;
      deps.output.endAnswer();
    }
  }

  /**
   * The only place that writes to the history (architecture rule 5). Whoever
   * calls it has an approved text or the safe message, and has closed the
   * line of the answer already.
   */
  function commitTurn(question: string, text: string): void {
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

  /** The message of a failed call, never the message of an error of the SDK. */
  function describeError(
    error: unknown,
    counter: { retries: number; maxRetries: number },
  ): string {
    const summary = summarizeError(error, deps.redact);
    return deps.redact(
      describeFailure(error, {
        ...counter,
        // The message of an error of the SDK is never shown: the one of a 401
        // quotes the key. Any other error keeps its own message.
        ...(error instanceof APIError
          ? {}
          : { unknownMessage: summary.message }),
      }),
    );
  }

  /** The turn after the slot of the limit was taken. */
  async function runTurn(
    question: string,
    signal: AbortSignal | undefined,
  ): Promise<TurnResult> {
    open = false;
    // Not narrowed to "draft": the closures below move it.
    let phase = "draft" as Phase;
    const counters: RetryCounters = {
      draft: { ...NO_RETRIES },
      evaluate: { ...NO_RETRIES },
      revise: { ...NO_RETRIES },
      reevaluate: { ...NO_RETRIES },
      commit: { ...NO_RETRIES },
    };
    let llmCalls = 0;
    let usage: LlmUsage | undefined;
    const newStream: () => StreamRedactor =
      deps.redactStream ??
      (() => ({ push: (piece) => deps.redact(piece), flush: () => "" }));
    let stream = newStream();
    // The turns before this one: nothing changes the history until the commit.
    const past: readonly LlmMessage[] = [...history];

    // What was streamed by a try that is retried is thrown away: the line is
    // closed, the user is told, and the next try writes below it. The calls
    // of the other phases show no text, so they only tell about the retry.
    function makeOnRetry(
      forPhase: Exclude<Phase, "commit">,
    ): (event: RetryEvent) => void {
      return (event) => {
        counters[forPhase] = {
          retries: event.retry,
          maxRetries: event.maxRetries,
        };
        if (forPhase !== "draft") {
          const label =
            forPhase === "revise" ? REVISION_LABEL : EVALUATION_LABEL;
          deps.output.notice("warning", `${label} ${formatRetryNotice(event)}`);
          return;
        }
        const partial = open;
        closeLine();
        stream = newStream();
        deps.output.notice(
          "warning",
          formatRetryNotice(event, { partialText: partial }),
        );
      };
    }

    function show(piece: string): void {
      if (piece !== "") {
        open = true;
        deps.output.chunk(piece);
      }
    }

    /** The self-evaluation of a text; an error becomes an outcome. */
    async function evaluateText(
      forPhase: "evaluate" | "reevaluate",
      text: string,
      failureConsequence: string,
    ): Promise<EvaluationOutcome> {
      phase = forPhase;
      ensureNotCancelled(signal);
      llmCalls += 1;
      try {
        const request = buildEvaluationRequest({
          evaluatorPrompt: deps.critique.evaluatorPrompt,
          evaluatorContext: deps.critique.evaluatorContext,
          history: past,
          question,
          draft: text,
          ...(deps.critique.recentHistoryMessages === undefined
            ? {}
            : { recentHistoryMessages: deps.critique.recentHistoryMessages }),
        });
        const result = await deps.llm.generateStructured({
          ...request,
          ...(signal === undefined ? {} : { signal }),
          onRetry: makeOnRetry(forPhase),
        });
        usage = addUsage(usage, result.usage);
        return {
          status: "ok",
          ...normalizeEvaluation(result.value, deps.redact),
        };
      } catch (error) {
        if (isCancellation(error, signal)) {
          throw error;
        }
        deps.output.notice(
          "warning",
          `${EVALUATION_LABEL} ${describeError(error, counters[forPhase])} ${failureConsequence}`,
        );
        if (forPhase === "evaluate") {
          // The draft is on the screen: the withdrawal goes to the same
          // stream (stdout), with no message of the SDK. The revision was
          // never shown, so only the first evaluation needs it.
          deps.output.retraction(UNVERIFIED_RETRACTION);
        }
        return {
          status: "error",
          summary: summarizeError(error, deps.redact),
        };
      }
    }

    try {
      // A slot is taken once per accepted question. A turn that fails or is
      // cancelled after this point does not give it back. The evaluation and
      // the revision are part of the same question: they take no slot.
      const limited = await takeRateLimitSlot(signal);
      if (limited !== undefined) {
        return limited;
      }

      // 1. DRAFT
      llmCalls += 1;
      const drafted: LlmTextResult = await deps.llm.streamText({
        instructions: deps.instructions,
        input: [...past, { role: "user", content: question }],
        ...(signal === undefined ? {} : { signal }),
        onChunk: (piece) => {
          show(stream.push(piece));
        },
        onRetry: makeOnRetry("draft"),
      });
      usage = addUsage(usage, drafted.usage);
      show(stream.flush());
      closeLine();
      // What the screen got and what the history gets is the same text.
      const draft = deps.redact(drafted.text);

      /** Shows what was not shown yet, then keeps the turn. */
      const conclude = (
        origin: Origin,
        finalText: string,
        model: string,
        parts: {
          evaluation: EvaluationOutcome;
          revision?: TurnCritique["revision"];
          violated: TurnCritique["violatedRules"];
        },
      ): TurnResult => {
        if (origin !== "rascunho") {
          show(finalText);
          closeLine();
        }
        phase = "commit";
        ensureNotCancelled(signal);
        commitTurn(question, finalText);
        const critique: TurnCritique = {
          draft,
          evaluation: parts.evaluation,
          ...(parts.revision === undefined ? {} : { revision: parts.revision }),
          origin,
          violatedRules: parts.violated,
          llmCalls,
        };
        return {
          status: "answered",
          text: finalText,
          model,
          chunks: drafted.chunks,
          ...(usage === undefined ? {} : { usage }),
          critique,
        };
      };
      const fallback = (
        evaluation: EvaluationOutcome,
        violated: TurnCritique["violatedRules"],
        revision?: TurnCritique["revision"],
      ): TurnResult =>
        conclude("fallback", deps.critique.fallbackMessage, drafted.model, {
          evaluation,
          violated,
          ...(revision === undefined ? {} : { revision }),
        });

      // 2. EVALUATE the draft
      const first = await evaluateText(
        "evaluate",
        draft,
        UNVERIFIED_RETRACTION,
      );
      if (first.status === "error") {
        return fallback(first, []);
      }
      if (first.approved) {
        return conclude("rascunho", draft, drafted.model, {
          evaluation: first,
          violated: [],
        });
      }

      // Rejected: the draft is withdrawn in plain sight, and revised once.
      const firstRules = rulesOf(first.violations);
      deps.output.retraction(
        `A resposta acima foi retirada por violação de política (${describeViolations(first.violations)}). Uma versão corrigida será exibida somente depois de verificada.`,
      );

      // 3. REVISE: no `onChunk`, nothing of it is shown yet.
      phase = "revise";
      ensureNotCancelled(signal);
      llmCalls += 1;
      let revised: LlmTextResult;
      try {
        revised = await deps.llm.streamText({
          ...buildRevisionRequest({
            instructions: deps.instructions,
            revisionPrompt: deps.critique.revisionPrompt,
            history: past,
            question,
            draft,
            violations: first.violations,
          }),
          ...(signal === undefined ? {} : { signal }),
          onRetry: makeOnRetry("revise"),
        });
      } catch (error) {
        if (isCancellation(error, signal)) {
          throw error;
        }
        deps.output.notice(
          "warning",
          `${REVISION_LABEL} ${describeError(error, counters.revise)} A versão corrigida não pôde ser escrita.`,
        );
        return fallback(first, firstRules);
      }
      usage = addUsage(usage, revised.usage);
      const revision = deps.redact(revised.text);
      if (revision !== revised.text) {
        // The text of the model holds a credential: it is not used.
        deps.output.notice(
          "warning",
          `${REVISION_LABEL} A versão corrigida continha uma credencial e foi descartada.`,
        );
        return fallback(first, firstRules, { text: revision });
      }

      // 4. EVALUATE the revision
      const second = await evaluateText(
        "reevaluate",
        revision,
        "A versão corrigida foi descartada porque não pôde ser verificada.",
      );
      if (second.status === "ok" && second.approved) {
        return conclude("revisao", revision, revised.model, {
          evaluation: first,
          revision: { text: revision, evaluation: second },
          violated: firstRules,
        });
      }
      if (second.status === "ok") {
        deps.output.notice(
          "warning",
          `${EVALUATION_LABEL} A versão corrigida também não foi aprovada (${describeViolations(second.violations)}).`,
        );
      }
      return fallback(
        first,
        second.status === "ok"
          ? [...new Set([...firstRules, ...rulesOf(second.violations)])]
          : firstRules,
        { text: revision, evaluation: second },
      );
    } catch (error) {
      const hadText = open;
      closeLine();
      if (isCancellation(error, signal)) {
        if (phase === "commit") {
          deps.output.notice(
            "info",
            "Resposta cancelada antes de ser guardada.",
          );
        } else if (phase !== "draft") {
          deps.output.notice(
            "info",
            "Resposta cancelada antes da verificação; não foi guardada.",
          );
        }
        return { status: "cancelled" };
      }
      const summary = summarizeError(error, deps.redact);
      if (hadText) {
        deps.output.notice("warning", "Resposta interrompida.");
      }
      deps.output.notice(
        "error",
        describeError(error, counters[phase === "commit" ? "draft" : phase]),
      );
      return { status: "failed", summary };
    }
  }

  function toRecord(
    question: string,
    result: TurnResult,
  ): TurnRecord | undefined {
    const at = (deps.now?.() ?? new Date(0)).toISOString();
    switch (result.status) {
      case "answered":
        return {
          at,
          status: "answered",
          question,
          critique: result.critique,
          model: result.model,
        };
      case "failed":
        return { at, status: "failed", question, summary: result.summary };
      case "cancelled":
        return { at, status: "cancelled", question };
      case "rate_limited":
        // Not sent to the model: nothing to record.
        return undefined;
    }
  }

  async function ask(
    question: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TurnResult> {
    if (busy) {
      throw new Error(BUSY_MESSAGE);
    }
    busy = true;
    try {
      const result = await runTurn(question, options.signal);
      const record = toRecord(question, result);
      if (record !== undefined && deps.onTurn !== undefined) {
        try {
          await deps.onTurn(record);
        } catch (error) {
          // The log is not the answer: its failure does not change the turn.
          deps.output.notice(
            "warning",
            `Não foi possível registrar o turno: ${summarizeError(error, deps.redact).message}`,
          );
        }
      }
      return result;
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
