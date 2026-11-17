// QA of ENG-52: boundaries of the sliding window and of the wait mode that
// the tests of the implementation do not pin down. No network, no real time
// except where a real timer is the point.
import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  formatRateLimitNotice,
  waitSecondsFor,
} from "../src/chat/rate-limiter.js";
import { defaultSleep } from "../src/llm/retry.js";

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function refusedSeconds(
  limiter: ReturnType<typeof createRateLimiter>,
): number | undefined {
  const result = limiter.tryAcquire();
  return result.allowed ? undefined : waitSecondsFor(result.retryAfterMs);
}

describe("rate limiter, QA of ENG-52", () => {
  it("shows a number that decreases over a run of refusals, never 0", () => {
    const time = clock();
    const limiter = createRateLimiter({
      maxRequests: 2,
      windowSeconds: 5,
      now: time.now,
      sleep: () => Promise.resolve(),
    });
    limiter.tryAcquire();
    limiter.tryAcquire();

    const shown: number[] = [];
    for (let at = 100; at < 5000; at += 700) {
      time.set(at);
      shown.push(refusedSeconds(limiter) ?? -1);
    }

    expect(shown).toEqual([5, 5, 4, 3, 3, 2, 1]);
    expect(Math.min(...shown)).toBe(1);
  });

  it("says about the whole window for the third of three quick questions", () => {
    const time = clock(10);
    const limiter = createRateLimiter({
      maxRequests: 2,
      windowSeconds: 3600,
      now: time.now,
      sleep: () => Promise.resolve(),
    });
    limiter.tryAcquire();
    time.advance(3);
    limiter.tryAcquire();
    time.advance(3);

    expect(refusedSeconds(limiter)).toBe(3600);
    expect(formatRateLimitNotice(2, 3600, 3600)).toBe(
      "Limite de perguntas atingido (2 perguntas a cada 3600 s). Aguarde 3600 segundos e envie de novo.",
    );
  });

  it("holds the same limit after many thousands of refusals", () => {
    const time = clock();
    const limiter = createRateLimiter({
      maxRequests: 3,
      windowSeconds: 10,
      now: time.now,
      sleep: () => Promise.resolve(),
    });
    for (let i = 0; i < 3; i += 1) {
      limiter.tryAcquire();
    }
    for (let i = 0; i < 20_000; i += 1) {
      time.advance(0.25);
      expect(limiter.tryAcquire().allowed).toBe(false);
    }
    // 5000 ms passed: still inside the window, and the refusals took nothing.
    time.set(10_000);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it("does not overflow with the largest accepted window", () => {
    const time = clock();
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: Number.MAX_SAFE_INTEGER,
      now: time.now,
      sleep: () => Promise.resolve(),
    });
    expect(limiter.tryAcquire().allowed).toBe(true);
    time.advance(1e12);
    const result = limiter.tryAcquire();
    expect(result.allowed).toBe(false);
    expect(refusedSeconds(limiter)).toBeGreaterThan(1e15);
  });

  it("gives each of five waiters its own window, with no slot lost or doubled", async () => {
    const time = clock();
    const pending: Array<() => void> = [];
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: 10,
      now: time.now,
      sleep: () => new Promise<void>((resolve) => pending.push(resolve)),
    });
    limiter.tryAcquire();
    const grantedAt: number[] = [];
    const waiters = Array.from({ length: 5 }, () =>
      limiter.acquire({ wait: true }).then(() => grantedAt.push(time.now())),
    );
    const flush = async (): Promise<void> => {
      for (let turn = 0; turn < 8; turn += 1) {
        await Promise.resolve();
      }
    };
    await flush();

    for (let window = 1; window <= 5; window += 1) {
      time.set(window * 10_000);
      pending.splice(0).forEach((wake) => wake());
      await flush();
      expect(grantedAt).toHaveLength(window);
    }
    await Promise.all(waiters);

    expect(grantedAt).toEqual([10_000, 20_000, 30_000, 40_000, 50_000]);
  });

  it("an aborted waiter takes no slot and the others still get theirs", async () => {
    const time = clock();
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: 1,
      now: () => performance.now() + time.now(),
      sleep: defaultSleep,
    });
    limiter.tryAcquire();
    const controller = new AbortController();
    const aborted = limiter.acquire({ wait: true, signal: controller.signal });
    const kept = limiter.acquire({ wait: true });
    const settled = aborted.then(
      () => "granted",
      (error: unknown) => (error instanceof Error ? error.name : "rejected"),
    );
    controller.abort();

    expect(await settled).toBe("AbortError");
    expect((await kept).allowed).toBe(true);
    // The kept one holds the only slot of this window; the aborted took none.
    expect(limiter.tryAcquire().allowed).toBe(false);
  });

  it("an already aborted signal rejects at once, even with a free slot", async () => {
    const limiter = createRateLimiter({
      maxRequests: 5,
      windowSeconds: 60,
      now: () => 0,
      sleep: defaultSleep,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      limiter.acquire({ wait: true, signal: controller.signal }),
    ).rejects.toBeDefined();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryAcquire().allowed).toBe(true);
    }
    expect(limiter.tryAcquire().allowed).toBe(false);
  });
});
