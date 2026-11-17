import { describe, expect, it } from "vitest";
import { createInterruptHandler } from "../src/cli/interrupt.js";

describe("createInterruptHandler", () => {
  it("aborts on the first Ctrl+C, exits on the second, and does nothing after", () => {
    const calls: string[] = [];
    const interrupt = createInterruptHandler({
      abort: () => void calls.push("abort"),
      exit: () => void calls.push("exit"),
    });

    expect(calls).toEqual([]);
    interrupt();
    expect(calls).toEqual(["abort"]);
    interrupt();
    expect(calls).toEqual(["abort", "exit"]);
    interrupt();
    interrupt();
    expect(calls).toEqual(["abort", "exit"]);
  });

  it("keeps the state of each handler apart", () => {
    const first: string[] = [];
    const second: string[] = [];
    const a = createInterruptHandler({
      abort: () => void first.push("abort"),
      exit: () => void first.push("exit"),
    });
    const b = createInterruptHandler({
      abort: () => void second.push("abort"),
      exit: () => void second.push("exit"),
    });

    a();
    a();
    b();

    expect(first).toEqual(["abort", "exit"]);
    expect(second).toEqual(["abort"]);
  });
});
