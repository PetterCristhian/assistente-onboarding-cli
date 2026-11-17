// The block of tests/helpers/preload-loopback-only.ts, confirmed in a child
// process: the demo tests rely on it to prove that nothing leaves the machine.
import { describe, it } from "vitest";
import { confirmLoopbackOnlyBlock } from "./helpers/loopback-probe.js";

describe("the loopback-only preload", () => {
  it("blocks DNS, sockets, TLS and fetch for anything but 127.0.0.1", () => {
    confirmLoopbackOnlyBlock();
  }, 30_000);
});
