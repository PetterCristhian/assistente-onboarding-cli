import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  formatRateLimitNotice,
  waitSecondsFor,
} from "../src/chat/rate-limiter.js";
import { defaultSleep } from "../src/llm/retry.js";

/** A clock and a sleep that the test drives; sleeping moves the clock. */
function fakeTime(start = 0) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
    advance(ms: number) {
      current += ms;
    },
    sleeps,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
  };
}

function limiterWith(max: number, windowSeconds: number, time = fakeTime()) {
  return {
    time,
    limiter: createRateLimiter({
      maxRequests: max,
      windowSeconds,
      now: time.now,
      sleep: time.sleep,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createRateLimiter: tryAcquire", () => {
  it("accepts below the limit", () => {
    const { limiter } = limiterWith(3, 60);

    expect(limiter.tryAcquire()).toEqual({ allowed: true });
    expect(limiter.tryAcquire()).toEqual({ allowed: true });
    expect(limiter.tryAcquire()).toEqual({ allowed: true });
  });

  it("refuses at the limit with the time until the oldest slot frees", () => {
    const { limiter, time } = limiterWith(2, 60);
    time.set(1000);
    limiter.tryAcquire();
    time.set(5000);
    limiter.tryAcquire();
    time.set(20_000);

    expect(limiter.tryAcquire()).toEqual({
      allowed: false,
      retryAfterMs: 1000 + 60_000 - 20_000,
    });
  });

  it("frees the slot at the exact edge of the window, not before", () => {
    const { limiter, time } = limiterWith(1, 10);
    limiter.tryAcquire();
    time.set(9999);

    expect(limiter.tryAcquire()).toEqual({ allowed: false, retryAfterMs: 1 });

    time.set(10_000);

    expect(limiter.tryAcquire()).toEqual({ allowed: true });
  });

  it("accepts again after the whole window", () => {
    const { limiter, time } = limiterWith(2, 60);
    limiter.tryAcquire();
    limiter.tryAcquire();
    time.advance(60_000);

    expect(limiter.tryAcquire()).toEqual({ allowed: true });
    expect(limiter.tryAcquire()).toEqual({ allowed: true });
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it("slides: only the slots that left the window are freed", () => {
    const { limiter, time } = limiterWith(2, 60);
    limiter.tryAcquire(); // t = 0
    time.set(30_000);
    limiter.tryAcquire(); // t = 30 s
    time.set(60_000);

    expect(limiter.tryAcquire()).toEqual({ allowed: true }); // the first left
    expect(limiter.tryAcquire()).toEqual({
      allowed: false,
      retryAfterMs: 30_000, // waits for the one taken at 30 s
    });
  });

  it("exposes the limit in force", () => {
    const { limiter } = limiterWith(3, 45);

    expect(limiter.maxRequests).toBe(3);
    expect(limiter.windowSeconds).toBe(45);
  });

  it("works with a limit of 1", () => {
    const { limiter } = limiterWith(1, 60);

    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it("works with a window of 1 s", () => {
    const { limiter, time } = limiterWith(1, 1);
    limiter.tryAcquire();
    time.set(500);

    expect(limiter.tryAcquire()).toEqual({ allowed: false, retryAfterMs: 500 });

    time.set(1000);

    expect(limiter.tryAcquire().allowed).toBe(true);
  });

  it("works with a huge limit", () => {
    const { limiter } = limiterWith(Number.MAX_SAFE_INTEGER, 60);

    for (let index = 0; index < 1000; index += 1) {
      expect(limiter.tryAcquire().allowed).toBe(true);
    }
  });

  it("keeps the order when the clock goes back", () => {
    const { limiter, time } = limiterWith(2, 10);
    time.set(5000);
    limiter.tryAcquire();
    time.set(1000); // goes back: counted as 5000
    limiter.tryAcquire();

    expect(limiter.tryAcquire()).toEqual({
      allowed: false,
      retryAfterMs: 10_000,
    });

    time.set(15_000);

    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it("handles fractional times, as the monotonic clock gives", () => {
    const { limiter, time } = limiterWith(1, 1);
    time.set(123.5);
    limiter.tryAcquire();
    time.set(500.25);

    const refused = limiter.tryAcquire();

    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterMs).toBe(623.25);
    }

    time.set(1123.5);

    expect(limiter.tryAcquire().allowed).toBe(true);
  });

  it("refuses without taking a slot, so it never holds more than the limit", () => {
    const { limiter, time } = limiterWith(2, 10);
    limiter.tryAcquire();
    limiter.tryAcquire();
    for (let index = 0; index < 50; index += 1) {
      time.advance(10);
      expect(limiter.tryAcquire().allowed).toBe(false);
    }
    // Refusals took nothing: the slots free 10 s after the accepted ones.
    time.set(10_000);

    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws a RangeError for a limit of %s",
    (value) => {
      expect(() => limiterWith(value, 60)).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws a RangeError for a window of %s",
    (value) => {
      expect(() => limiterWith(1, value)).toThrow(RangeError);
    },
  );
});

describe("waitSecondsFor", () => {
  it.each([
    [1, 1],
    [999, 1],
    [1000, 1],
    [1001, 2],
    [37_000, 37],
    [37_001, 38],
    [0, 1],
    [0.4, 1],
  ])("%s ms -> %s s", (ms, seconds) => {
    expect(waitSecondsFor(ms)).toBe(seconds);
  });
});

describe("formatRateLimitNotice", () => {
  it("states the limit and the seconds to wait", () => {
    expect(formatRateLimitNotice(2, 60, 37)).toBe(
      "Limite de perguntas atingido (2 perguntas a cada 60 s). Aguarde 37 segundos e envie de novo.",
    );
  });

  it("uses the singular", () => {
    expect(formatRateLimitNotice(1, 1, 1)).toBe(
      "Limite de perguntas atingido (1 pergunta a cada 1 s). Aguarde 1 segundo e envie de novo.",
    );
  });
});

describe("createRateLimiter: acquire", () => {
  it("without wait is the same as tryAcquire", async () => {
    const { limiter } = limiterWith(1, 60);

    expect(await limiter.acquire()).toEqual({ allowed: true });
    expect(await limiter.acquire({ wait: false })).toMatchObject({
      allowed: false,
    });
  });

  it("sleeps exactly the time to wait and then accepts", async () => {
    const { limiter, time } = limiterWith(1, 60);
    time.set(1000);
    limiter.tryAcquire();
    time.set(11_000);
    const waits: number[] = [];

    const result = await limiter.acquire({
      wait: true,
      onWait: (ms) => waits.push(ms),
    });

    expect(result).toEqual({ allowed: true });
    expect(time.sleeps).toEqual([50_000]);
    expect(waits).toEqual([50_000]);
  });

  it("does not sleep when there is a free slot", async () => {
    const { limiter, time } = limiterWith(1, 60);
    const onWait = vi.fn();

    await limiter.acquire({ wait: true, onWait });

    expect(time.sleeps).toEqual([]);
    expect(onWait).not.toHaveBeenCalled();
  });

  it("rounds a fractional wait up to a whole millisecond", async () => {
    const { limiter, time } = limiterWith(1, 1);
    time.set(0.5);
    limiter.tryAcquire();
    time.set(10);

    await limiter.acquire({ wait: true });

    expect(time.sleeps).toEqual([991]);
  });

  it("does not take a slot when the signal is already aborted", async () => {
    const { limiter } = limiterWith(1, 60);
    const controller = new AbortController();
    controller.abort();

    await expect(
      limiter.acquire({ wait: true, signal: controller.signal }),
    ).rejects.toBeDefined();

    expect(limiter.tryAcquire()).toEqual({ allowed: true });
  });

  it("rejects when the signal aborts during the wait, leaving no timer", async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: 60,
      now: () => performance.now(),
      sleep: defaultSleep,
    });
    limiter.tryAcquire();
    const controller = new AbortController();

    const pending = limiter.acquire({ wait: true, signal: controller.signal });
    const outcome = expect(pending).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await outcome;

    expect(vi.getTimerCount()).toBe(0);
    // The aborted wait took nothing: after the window, one slot is free.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(limiter.tryAcquire()).toEqual({ allowed: true });
  });

  it("lets only one of two simultaneous waits pass per window", async () => {
    // A sleep that the test releases by hand, so both waits wake together.
    const time = fakeTime();
    const pending: Array<() => void> = [];
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: 10,
      now: time.now,
      sleep: () => new Promise<void>((resolve) => pending.push(resolve)),
    });
    limiter.tryAcquire();
    const order: string[] = [];
    const flush = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve();
      }
    };

    const first = limiter
      .acquire({ wait: true })
      .then(() => order.push("first"));
    const second = limiter
      .acquire({ wait: true })
      .then(() => order.push("second"));
    await flush();
    expect(pending).toHaveLength(2);

    time.set(10_000);
    pending.splice(0).forEach((wake) => wake());
    await first;
    await flush();

    // The first took the slot; the second checked again and sleeps again.
    expect(order).toEqual(["first"]);
    expect(pending).toHaveLength(1);

    time.set(20_000);
    pending.splice(0).forEach((wake) => wake());
    await second;

    expect(order).toEqual(["first", "second"]);
  });

  it("caps a long sleep at the timer limit and checks again", async () => {
    const maxTimer = 2 ** 31 - 1;
    const windowSeconds = 4_000_000; // 4e9 ms, above the timer limit
    const { limiter, time } = limiterWith(1, windowSeconds);
    limiter.tryAcquire();

    await limiter.acquire({ wait: true });

    expect(time.sleeps).toEqual([maxTimer, windowSeconds * 1000 - maxTimer]);
  });
});
