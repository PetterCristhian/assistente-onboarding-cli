// End to end: the demonstration in a child process, with the real `fetch` and
// real sockets, but with tests/helpers/preload-loopback-only.ts blocking every
// way out except the literal address 127.0.0.1. A probe confirms the block
// first: if it does not hold, nothing here runs.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_API_KEY } from "../scripts/demo-falhas/config.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  PROJECT_ROOT,
  confirmLoopbackOnlyBlock,
  spawnWithLoopbackOnly,
} from "./helpers/loopback-probe.js";
import {
  LOOPBACK_ONLY_BLOCKED_MARKER,
  LOOPBACK_ONLY_CONNECT_MARKER,
} from "./helpers/loopback-only-constants.js";

const CHILD_TIMEOUT_MS = 30_000;
const PROBE_SCRIPT = "tests/helpers/demo-falhas-probe.ts";
const EVIDENCE_RELATIVE = ["outputs", "evidencias", "retry-rate-limit.txt"];
// Different from anything the demonstration uses: it must change nothing.
const OTHER_BASE_URL = "https://other-provider.invalid/v1";

let root: string;
let run: ReturnType<typeof spawnWithLoopbackOnly>;
let elapsedMs: number;
const otherKey = fakeOpenAiKey("B");

beforeAll(() => {
  confirmLoopbackOnlyBlock();
  root = mkdtempSync(join(tmpdir(), "demo-falhas-e2e-"));
  const started = performance.now();
  run = spawnWithLoopbackOnly(
    [PROBE_SCRIPT, root],
    { OPENAI_API_KEY: otherKey, OPENAI_BASE_URL: OTHER_BASE_URL },
    CHILD_TIMEOUT_MS,
  );
  elapsedMs = performance.now() - started;
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the demonstration in a child process", () => {
  it("ends by itself with exit code 0", () => {
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(elapsedMs).toBeLessThan(30_000);
  });

  it("shows the five scenarios and the summary", () => {
    for (const number of [1, 2, 3, 4, 5]) {
      expect(run.stdout).toContain(`== Cenário ${number}: `);
    }
    expect(run.stdout).toContain(
      "Resultado geral: 5 de 5 cenários conferem (mais o encerramento do servidor). Código de saída 0.",
    );
  });

  it("only ever connects to 127.0.0.1", () => {
    const connected = [
      ...run.stderr.matchAll(
        new RegExp(`${escape(LOOPBACK_ONLY_CONNECT_MARKER)} (\\S+)`, "g"),
      ),
    ].map((match) => match[1]);

    // 13 calls, one connection or more for each of them.
    expect(connected.length).toBeGreaterThan(0);
    expect(new Set(connected)).toEqual(new Set(["127.0.0.1"]));
    expect(run.stderr).not.toContain(LOOPBACK_ONLY_BLOCKED_MARKER);
  });

  it("writes a file equal to what it printed", () => {
    const file = join(root, ...EVIDENCE_RELATIVE);

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(run.stdout);
  });

  it("prints what is versioned, byte for byte: nothing in it varies", () => {
    const versioned = readFileSync(
      join(PROJECT_ROOT, ...EVIDENCE_RELATIVE),
      "utf8",
    );

    expect(run.stdout).toBe(versioned);
  });

  it("is not changed by the key and the base URL of the environment, and shows neither", () => {
    for (const text of [run.stdout, run.stderr]) {
      expect(text).not.toContain(otherKey);
      expect(text).not.toContain(DEMO_API_KEY);
      expect(text).not.toContain(OTHER_BASE_URL);
      expect(text).not.toContain("other-provider");
    }
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
