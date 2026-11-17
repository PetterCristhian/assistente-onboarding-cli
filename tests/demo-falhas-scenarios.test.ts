// The scenarios of the demonstration and the guard of its `fetch`.
import { describe, expect, it } from "vitest";
import {
  LOOPBACK_REFUSED_MESSAGE,
  createLoopbackFetch,
  type CallCounter,
} from "../scripts/demo-falhas/loopback-fetch.js";

describe("createLoopbackFetch", () => {
  function setup() {
    const seen: string[] = [];
    const base: typeof fetch = (input) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response("ok"));
    };
    const counter: CallCounter = { calls: 0 };
    return { seen, counter, guarded: createLoopbackFetch(base, counter) };
  }

  it.each([
    "https://127.0.0.1:1234/x",
    "http://localhost:1234/x",
    "http://192.0.2.1/x",
    "http://127.0.0.2:1234/x",
    "https://api.openai.com/v1/responses",
    "ftp://127.0.0.1/x",
    "isto não é uma URL",
  ])("refuses %s and counts nothing", async (url) => {
    const { seen, counter, guarded } = setup();

    await expect(guarded(url)).rejects.toThrow(LOOPBACK_REFUSED_MESSAGE);
    expect(seen).toEqual([]);
    expect(counter.calls).toBe(0);
  });

  it("refuses a URL given as a URL object or a Request too", async () => {
    const { counter, guarded } = setup();

    await expect(guarded(new URL("https://api.openai.com/v1"))).rejects.toThrow(
      LOOPBACK_REFUSED_MESSAGE,
    );
    await expect(
      guarded(new Request("http://localhost:1234/x")),
    ).rejects.toThrow(LOOPBACK_REFUSED_MESSAGE);
    expect(counter.calls).toBe(0);
  });

  it("lets 127.0.0.1 through and counts each call", async () => {
    const { seen, counter, guarded } = setup();

    await guarded("http://127.0.0.1:1234/a");
    await guarded(new URL("http://127.0.0.1:1234/b"));
    await guarded(new Request("http://127.0.0.1:1234/c"));

    expect(counter.calls).toBe(3);
    expect(seen).toEqual([
      "http://127.0.0.1:1234/a",
      "http://127.0.0.1:1234/b",
      "http://127.0.0.1:1234/c",
    ]);
  });
});
