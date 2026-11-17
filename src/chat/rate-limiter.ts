// Local limit on the questions of the user (F9b): a sliding window that
// counts accepted questions. It has no clock and no timer of its own: the
// caller passes both, so that tests run with fake time and without waiting.
// It counts questions, not calls to the model: the retries of one call and
// the self-evaluation of one answer never take a slot of their own.

export type TryAcquireResult =
  { allowed: true } | { allowed: false; retryAfterMs: number };

export interface AcquireOptions {
  /** Wait for a free slot instead of refusing. Default: refuse. */
  wait?: boolean;
  /** Stops a wait. An already aborted signal takes no slot. */
  signal?: AbortSignal;
  /** Called before each sleep of a wait, with the time still to wait. */
  onWait?: (retryAfterMs: number) => void;
}

export interface RateLimiter {
  /** The limit in force, for the message shown when a question is refused. */
  readonly maxRequests: number;
  readonly windowSeconds: number;
  /** Synchronous, so the check and the taking of the slot are one step. */
  tryAcquire(): TryAcquireResult;
  acquire(options?: AcquireOptions): Promise<TryAcquireResult>;
}

export interface RateLimiterDeps {
  /** Questions allowed in one window: an integer, at least 1. */
  maxRequests: number;
  /** Size of the window in seconds: an integer, at least 1. */
  windowSeconds: number;
  /** Milliseconds from any origin; may be fractional. */
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The longest delay that a timer accepts (a signed 32-bit integer). */
const MAX_SLEEP_MS = 2 ** 31 - 1;

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer of at least 1.`);
  }
}

/** Whole seconds to tell the user: rounded up, and never 0. */
export function waitSecondsFor(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatRateLimitNotice(
  max: number,
  windowSeconds: number,
  waitSeconds: number,
): string {
  return (
    `Limite de perguntas atingido (${plural(max, "pergunta", "perguntas")} ` +
    `a cada ${windowSeconds} s). ` +
    `Aguarde ${plural(waitSeconds, "segundo", "segundos")} e envie de novo.`
  );
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  requirePositiveInteger("maxRequests", deps.maxRequests);
  requirePositiveInteger("windowSeconds", deps.windowSeconds);
  const windowMs = deps.windowSeconds * 1000;
  // Times of the accepted questions, oldest first; never more than the max.
  const timestamps: number[] = [];
  // The latest time seen: a clock that goes back must not reorder the list.
  let lastTime = Number.NEGATIVE_INFINITY;

  function tryAcquire(): TryAcquireResult {
    const t = Math.max(deps.now(), lastTime);
    lastTime = t;
    // At the exact edge of the window the slot is already free.
    while (timestamps.length > 0 && t - (timestamps[0] ?? t) >= windowMs) {
      timestamps.shift();
    }
    const oldest = timestamps[0];
    if (timestamps.length < deps.maxRequests || oldest === undefined) {
      timestamps.push(t);
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: oldest + windowMs - t };
  }

  async function acquire(
    options: AcquireOptions = {},
  ): Promise<TryAcquireResult> {
    if (options.wait !== true) {
      return tryAcquire();
    }
    // Two waits that wake up together: the first takes the slot, the second
    // checks again and sleeps again. There is no queue.
    for (;;) {
      options.signal?.throwIfAborted();
      const result = tryAcquire();
      if (result.allowed) {
        return result;
      }
      options.onWait?.(result.retryAfterMs);
      await deps.sleep(
        Math.min(Math.ceil(result.retryAfterMs), MAX_SLEEP_MS),
        options.signal,
      );
    }
  }

  return {
    maxRequests: deps.maxRequests,
    windowSeconds: deps.windowSeconds,
    tryAcquire,
    acquire,
  };
}
