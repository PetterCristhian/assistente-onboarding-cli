// Tries a call again when the failure is worth it (docs/adr/0005). It knows
// no SDK: what is worth another try is decided by the `classify` function that
// the caller passes in, and the clock, the wait and the random number are
// passed in too, so that the tests need no network and no real time.
import type { ErrorClass } from "./errors.js";

/** One new try that is about to start, after `delayMs` of waiting. */
export interface RetryEvent {
  /** Which new try this is, from 1. */
  readonly retry: number;
  /** How many new tries are allowed. */
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly cause: Extract<ErrorClass, { kind: "transient" | "rate_limit" }>;
}

export interface RetryPolicy {
  /** New tries after the first call. 0 means a single call. */
  readonly maxRetries: number;
  /** The wait before the first new try; it doubles after each one. */
  readonly baseDelayMs: number;
  /** The longest wait. Default: 30 s. */
  readonly maxDelayMs?: number;
}

export interface RetryDeps {
  /** Rejects at once, with the reason, when the signal aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** In [0, 1). */
  readonly random: () => number;
  /** Milliseconds since the epoch, to read a date in `retry-after`. */
  readonly now: () => number;
  readonly classify: (error: unknown) => ErrorClass;
  /** Called before each wait. An error that it throws ends the call. */
  readonly onRetry?: (event: RetryEvent) => void;
  readonly signal?: AbortSignal;
}

/** The longest wait between two tries: 30 s. */
export const MAX_RETRY_DELAY_MS = 30_000;

const JITTER = 0.2;

export function createRetryPolicy(
  retries: number,
  baseDelayMs: number,
  maxDelayMs?: number,
): RetryPolicy {
  return {
    maxRetries: retries,
    baseDelayMs,
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
  };
}

/**
 * The wait before a new try: base * 2^(retry - 1), at most the ceiling, plus
 * up to 20% of jitter (never less, so the base is always respected), and
 * again at most the ceiling.
 */
export function computeDelay(
  retry: number,
  policy: RetryPolicy,
  random: () => number,
): number {
  const ceiling = policy.maxDelayMs ?? MAX_RETRY_DELAY_MS;
  const exponential = Math.min(
    ceiling,
    policy.baseDelayMs * 2 ** Math.max(0, retry - 1),
  );
  return Math.min(ceiling, Math.round(exponential * (1 + JITTER * random())));
}

// The calls that ended because the provider asked for a wait longer than the
// ceiling: the original error is rethrown as it is, and the wait is kept here
// for the message that the user reads (describeFailure).
const refused = new WeakMap<object, number>();

/** The wait (ms) that made the retry give up at once, when that was the case. */
export function retryAfterRefused(error: unknown): number | undefined {
  return typeof error === "object" && error !== null
    ? refused.get(error)
    : undefined;
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("aborted");
}

// A function, so that the type checker does not remember an earlier answer:
// the signal can abort at any await.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The wait that the provider asked for, when it asked and it is not past. */
function requestedWait(
  cause: Extract<ErrorClass, { kind: "rate_limit" }>,
  now: () => number,
): number | undefined {
  if (cause.retryAfterMs !== undefined) {
    return cause.retryAfterMs;
  }
  if (cause.retryAfterAt !== undefined) {
    const wait = cause.retryAfterAt - now();
    // A date that has passed asks for nothing: back to the backoff.
    return wait > 0 ? wait : undefined;
  }
  return undefined;
}

/**
 * Calls `fn`, and again after a failure that `classify` calls transient or
 * rate limit, up to `maxRetries` times, waiting between the calls. The rate
 * limit and the transient failures share the same allowance. The error that
 * ends the call is the original one, never wrapped.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps,
): Promise<T> {
  const ceiling = policy.maxDelayMs ?? MAX_RETRY_DELAY_MS;
  for (let retry = 1; ; retry += 1) {
    if (isAborted(deps.signal)) {
      throw abortReason(deps.signal);
    }
    try {
      return await fn();
    } catch (error) {
      if (isAborted(deps.signal)) {
        throw abortReason(deps.signal);
      }
      const cause = deps.classify(error);
      if (cause.kind === "cancelled" || cause.kind === "fatal") {
        throw error;
      }
      let delayMs: number | undefined;
      if (cause.kind === "rate_limit") {
        delayMs = requestedWait(cause, deps.now);
        if (delayMs !== undefined && delayMs > ceiling) {
          // Too long to wait here: the user is told, and decides.
          if (typeof error === "object" && error !== null) {
            refused.set(error, delayMs);
          }
          throw error;
        }
      }
      if (retry > policy.maxRetries) {
        throw error;
      }
      delayMs ??= computeDelay(retry, policy, deps.random);
      deps.onRetry?.({
        retry,
        maxRetries: policy.maxRetries,
        delayMs,
        cause,
      });
      await deps.sleep(delayMs, deps.signal);
    }
  }
}

/** A timer that stops, and releases everything, as soon as the signal aborts. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (isAborted(signal)) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
