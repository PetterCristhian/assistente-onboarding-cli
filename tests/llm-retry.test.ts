import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorClass } from "../src/llm/errors.js";
import {
  computeDelay,
  defaultSleep,
  retryAfterRefused,
  withRetry,
  type RetryDeps,
  type RetryEvent,
  type RetryPolicy,
} from "../src/llm/retry.js";

class Transient extends Error {}
class Fatal extends Error {}
class Limited extends Error {
  constructor(
    readonly info: { retryAfterMs?: number; retryAfterAt?: number } = {},
  ) {
    super("limited");
  }
}
class Quota extends Error {}
class Cancelled extends Error {}

function classify(error: unknown): ErrorClass {
  if (error instanceof Transient) {
    return { kind: "transient", reason: "connection" };
  }
  if (error instanceof Limited) {
    return { kind: "rate_limit", status: 429, ...error.info };
  }
  if (error instanceof Cancelled) {
    return { kind: "cancelled" };
  }
  if (error instanceof Quota) {
    return { kind: "fatal", reason: "insufficient_quota", status: 429 };
  }
  return { kind: "fatal", reason: "unknown" };
}

interface Harness {
  readonly deps: RetryDeps;
  readonly waits: number[];
  readonly events: RetryEvent[];
}

function harness(overrides: Partial<RetryDeps> = {}): Harness {
  const waits: number[] = [];
  const events: RetryEvent[] = [];
  const deps: RetryDeps = {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    now: () => 1_000_000,
    classify,
    onRetry: (event) => events.push(event),
    ...overrides,
  };
  return { deps, waits, events };
}

/** A function that fails with the given errors, then succeeds. */
function flaky(errors: readonly Error[]): {
  fn: () => Promise<string>;
  calls: () => number;
} {
  let calls = 0;
  return {
    fn: () => {
      const error = errors[calls];
      calls += 1;
      return error === undefined
        ? Promise.resolve("ok")
        : Promise.reject(error);
    },
    calls: () => calls,
  };
}

const POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 100 };

afterEach(() => {
  vi.useRealTimers();
});

describe("computeDelay", () => {
  it("doubles from the base and adds nothing without jitter", () => {
    expect([1, 2, 3, 4].map((n) => computeDelay(n, POLICY, () => 0))).toEqual([
      100, 200, 400, 800,
    ]);
  });

  it("adds up to 20% of jitter, never less than the base", () => {
    expect(computeDelay(1, POLICY, () => 0.5)).toBe(110);
    expect(computeDelay(2, POLICY, () => 0.999999)).toBe(240);
    expect(computeDelay(1, POLICY, () => 0)).toBe(100);
  });

  it("never passes the ceiling of 30 s", () => {
    const policy = { maxRetries: 3, baseDelayMs: 20_000 };

    expect(computeDelay(1, policy, () => 0)).toBe(20_000);
    expect(computeDelay(2, policy, () => 0)).toBe(30_000);
    expect(computeDelay(3, policy, () => 0.9)).toBe(30_000);
    expect(computeDelay(2000, policy, () => 0.9)).toBe(30_000);
  });
});

describe("withRetry", () => {
  it("retries a transient failure with growing waits and then gives up with the original error", async () => {
    const { deps, waits, events } = harness();
    const errors = [1, 2, 3, 4].map(() => new Transient("down"));
    const { fn, calls } = flaky(errors);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(errors[3]);

    expect(calls()).toBe(4);
    expect(waits).toEqual([100, 200, 400]);
    expect(events.map((e) => [e.retry, e.maxRetries, e.delayMs])).toEqual([
      [1, 3, 100],
      [2, 3, 200],
      [3, 3, 400],
    ]);
    expect(events[0]?.cause).toEqual({
      kind: "transient",
      reason: "connection",
    });
  });

  it("adds the jitter to the wait", async () => {
    const { deps, waits } = harness({ random: () => 0.5 });
    const { fn } = flaky([new Transient("a"), new Transient("b")]);

    await withRetry(fn, POLICY, deps);

    expect(waits).toEqual([110, 220]);
  });

  it("stops at the ceiling", async () => {
    const { deps, waits } = harness();
    const { fn } = flaky([
      new Transient("a"),
      new Transient("b"),
      new Transient("c"),
    ]);

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 20_000 }, deps);

    expect(waits).toEqual([20_000, 30_000, 30_000]);
  });

  it("succeeds on the third call with two notices", async () => {
    const { deps, events } = harness();
    const { fn, calls } = flaky([new Transient("a"), new Transient("b")]);

    await expect(withRetry(fn, POLICY, deps)).resolves.toBe("ok");

    expect(calls()).toBe(3);
    expect(events).toHaveLength(2);
  });

  it("calls the notice before the wait", async () => {
    const order: string[] = [];
    const { deps } = harness({
      onRetry: () => order.push("notice"),
      sleep: () => {
        order.push("sleep");
        return Promise.resolve();
      },
    });
    const { fn } = flaky([new Transient("a")]);

    await withRetry(fn, POLICY, deps);

    expect(order).toEqual(["notice", "sleep"]);
  });

  it("calls a fatal error once, with no notice", async () => {
    const { deps, events } = harness();
    const error = new Fatal("bad");
    const { fn, calls } = flaky([error]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(error);

    expect(calls()).toBe(1);
    expect(events).toEqual([]);
  });

  it("calls insufficient_quota once", async () => {
    const { deps, events } = harness();
    const error = new Quota("quota");
    const { fn, calls } = flaky([error]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(error);

    expect(calls()).toBe(1);
    expect(events).toEqual([]);
  });

  it("does not retry a cancelled call", async () => {
    const { deps } = harness();
    const error = new Cancelled("stop");
    const { fn, calls } = flaky([error]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(error);

    expect(calls()).toBe(1);
  });

  it("makes a single call with zero retries", async () => {
    const { deps, events } = harness();
    const error = new Transient("down");
    const { fn, calls } = flaky([error, error]);

    await expect(
      withRetry(fn, { maxRetries: 0, baseDelayMs: 100 }, deps),
    ).rejects.toBe(error);

    expect(calls()).toBe(1);
    expect(events).toEqual([]);
  });

  it("lets a 429 and a transient failure share the allowance", async () => {
    const { deps, events } = harness();
    const last = new Limited();
    const { fn, calls } = flaky([
      new Limited(),
      new Transient("a"),
      new Limited(),
      last,
    ]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(last);

    expect(calls()).toBe(4);
    expect(events.map((e) => e.cause.kind)).toEqual([
      "rate_limit",
      "transient",
      "rate_limit",
    ]);
  });

  it("propagates what the notice throws, and does not retry", async () => {
    const boom = new Error("notice failed");
    const { deps } = harness({
      onRetry: () => {
        throw boom;
      },
    });
    const { fn, calls } = flaky([new Transient("a")]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(boom);

    expect(calls()).toBe(1);
  });
});

describe("withRetry: what a 429 asks for", () => {
  it("waits retry-after-ms", async () => {
    const { deps, waits } = harness();
    const { fn } = flaky([new Limited({ retryAfterMs: 1500 })]);

    await withRetry(fn, POLICY, deps);

    expect(waits).toEqual([1500]);
  });

  it("waits the seconds of retry-after", async () => {
    const { deps, waits } = harness();
    const { fn } = flaky([new Limited({ retryAfterMs: 2000 })]);

    await withRetry(fn, POLICY, deps);

    expect(waits).toEqual([2000]);
  });

  it("waits until the HTTP date, by the clock that was passed in", async () => {
    const { deps, waits } = harness({ now: () => 5_000 });
    const { fn } = flaky([new Limited({ retryAfterAt: 9_000 })]);

    await withRetry(fn, POLICY, deps);

    expect(waits).toEqual([4_000]);
  });

  it("falls back to the backoff for a date that has passed", async () => {
    const { deps, waits } = harness({ now: () => 5_000 });
    const { fn } = flaky([new Limited({ retryAfterAt: 1_000 })]);

    await withRetry(fn, POLICY, deps);

    expect(waits).toEqual([100]);
  });

  it("falls back to the backoff without a header", async () => {
    const { deps, waits } = harness();
    const { fn } = flaky([new Limited(), new Limited()]);

    await withRetry(fn, POLICY, deps);

    expect(waits).toEqual([100, 200]);
  });

  it("does not wait at all when the provider asks for more than 30 s", async () => {
    const { deps, waits, events } = harness();
    const error = new Limited({ retryAfterMs: 60_000 });
    const { fn, calls } = flaky([error]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(error);

    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
    expect(events).toEqual([]);
    expect(retryAfterRefused(error)).toBe(60_000);
  });

  it("also refuses a date that is more than 30 s away", async () => {
    const { deps } = harness({ now: () => 0 });
    const error = new Limited({ retryAfterAt: 45_000 });
    const { fn } = flaky([error]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBe(error);

    expect(retryAfterRefused(error)).toBe(45_000);
  });

  it("accepts exactly 30 s", async () => {
    const { deps, waits } = harness();
    const { fn } = flaky([new Limited({ retryAfterMs: 30_000 })]);

    await withRetry(fn, POLICY, deps);

    expect(waits).toEqual([30_000]);
  });

  it("remembers nothing about an error that was not refused", () => {
    expect(retryAfterRefused(new Error("x"))).toBeUndefined();
    expect(retryAfterRefused("text")).toBeUndefined();
  });
});

describe("withRetry: abort", () => {
  it("does not call the function when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = harness({ signal: controller.signal });
    const { fn, calls } = flaky([]);

    await expect(withRetry(fn, POLICY, deps)).rejects.toBeInstanceOf(Error);

    expect(calls()).toBe(0);
  });

  it("ends the wait at once and does not call again", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { deps, events } = harness({
      sleep: defaultSleep,
      signal: controller.signal,
    });
    const { fn, calls } = flaky([new Transient("a")]);

    const outcome = withRetry(fn, POLICY, deps).then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toHaveLength(1);
    controller.abort();
    const result = await outcome;

    expect(result).toBeInstanceOf(Error);
    expect(calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry an error that came with the abort", async () => {
    const controller = new AbortController();
    const { deps, events } = harness({ signal: controller.signal });
    const fn = (): Promise<string> => {
      controller.abort();
      return Promise.reject(new Transient("late"));
    };

    await expect(withRetry(fn, POLICY, deps)).rejects.toBeInstanceOf(Error);

    expect(events).toEqual([]);
  });
});

describe("defaultSleep", () => {
  it("resolves after the time, with fake timers", async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = defaultSleep(1000).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;

    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once when the signal aborts, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = defaultSleep(60_000, controller.signal);
    const outcome = sleeping.then(
      () => "resolved",
      (error: unknown) => error,
    );

    controller.abort();

    expect(await outcome).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects without a timer when the signal is already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await expect(defaultSleep(1000, controller.signal)).rejects.toBeInstanceOf(
      Error,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
