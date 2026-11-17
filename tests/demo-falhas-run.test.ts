// `runDemo` in this process, with the real client and the simulated server on
// 127.0.0.1, in the shortest timing: the retry that runs is the real one.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import {
  DEMO_API_KEY,
  type DemoTiming,
} from "../scripts/demo-falhas/config.js";
import { EVIDENCE_PATH, runDemo } from "../scripts/demo-falhas/run.js";
import {
  STUB_HOST,
  isPortRefused,
  startStubServer,
  type StubServer,
} from "../scripts/demo-falhas/stub-server.js";

const TIMING: DemoTiming = {
  maxRetries: 3,
  baseDelayMs: 1,
  retryAfterSeconds: 0,
  requestTimeoutMs: 5000,
};
// Calls per scenario: 2, 2, 4, 1 and 4. Notices: one per new try.
const TOTAL_CALLS = 13;
const TOTAL_NOTICES = 8;

let root: string;
let printed: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "demo-falhas-"));
  printed = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function deps(
  extra: {
    signal?: AbortSignal;
    startServer?: typeof startStubServer;
  } = {},
) {
  return {
    timing: TIMING,
    writer: createSafeWriter({
      redact: createRedactor([DEMO_API_KEY]),
      rootDir: root,
    }),
    print: (text: string) => printed.push(text),
    now: () => performance.now(),
    ...extra,
  };
}

const evidenceFile = () => join(root, ...EVIDENCE_PATH.split("/"));

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

describe("runDemo", () => {
  it("matches every scenario, prints the transcript and writes it", async () => {
    const result = await runDemo(deps());

    expect(result.exitCode).toBe(0);
    expect(result.written).toBe(evidenceFile());
    expect(readFileSync(evidenceFile(), "utf8")).toBe(result.transcript);
    expect(printed.join("")).toBe(result.transcript);
    expect(result.transcript).toContain(
      "Resultado geral: 5 de 5 cenários conferem (mais o encerramento do servidor). Código de saída 0.",
    );
    for (const number of [1, 2, 3, 4, 5]) {
      expect(result.transcript).toContain(`== Cenário ${number}: `);
    }
  });

  it("makes one warning for each new try, through the real retry", async () => {
    const real = globalThis.fetch;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      calls += 1;
      return real(input, init);
    });

    const result = await runDemo(deps());

    const notices = result.transcript.match(/^ {2}Aviso: /gm) ?? [];
    expect(calls).toBe(TOTAL_CALLS);
    expect(notices).toHaveLength(TOTAL_NOTICES);
    expect(notices.length).toBe(calls - 5);
  });

  it("exits 1 and writes nothing when a scenario does not match", async () => {
    const real = globalThis.fetch;
    let extra = false;
    // One more request in scenario 1 takes a step of its script: the client
    // then makes one call and not two.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (urlOf(input).includes("/cenario-1/") && !extra) {
        extra = true;
        await (await real(input, init)).text();
      }
      return real(input, init);
    });

    const result = await runDemo(deps());

    expect(result.exitCode).toBe(1);
    expect(result.written).toBeUndefined();
    expect(existsSync(evidenceFile())).toBe(false);
    expect(result.transcript).toContain("DIVERGE");
    expect(result.transcript).toContain("Código de saída 1.");
    expect(printed.join("")).toContain(
      "Transcrição não gravada: há cenários que não conferem",
    );
  });

  it("exits 130, closes the server and writes nothing when the signal aborts in the middle", async () => {
    const controller = new AbortController();
    const real = globalThis.fetch;
    let port = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(urlOf(input));
      port = Number(url.port);
      if (url.pathname.startsWith("/cenario-3/")) {
        controller.abort(new Error("interrupted"));
      }
      return real(input, init);
    });

    const result = await runDemo(deps({ signal: controller.signal }));

    expect(result.exitCode).toBe(130);
    expect(result.written).toBeUndefined();
    expect(existsSync(evidenceFile())).toBe(false);
    expect(port).toBeGreaterThan(0);
    expect(await isPortRefused(port)).toBe(true);
    expect(result.transcript).not.toContain("== Resumo ==");
    expect(printed.join("")).toContain("Interrompido. Nada foi gravado.");
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("interrupted"));

    const result = await runDemo(deps({ signal: controller.signal }));

    expect(result.exitCode).toBe(130);
    expect(existsSync(evidenceFile())).toBe(false);
  });

  it("judges the shutdown by the server, not by the port: a stranger on the freed port does not matter", async () => {
    const strangers: ReturnType<typeof createServer>[] = [];
    const startServer = async (key: string): Promise<StubServer> => {
      const real = await startStubServer(key);
      return {
        ...real,
        async stop() {
          await real.stop();
          if (strangers.length > 0) {
            return;
          }
          const stranger = createServer();
          strangers.push(stranger);
          await new Promise<void>((resolve) =>
            stranger.listen(real.port, STUB_HOST, resolve),
          );
        },
      };
    };

    try {
      const result = await runDemo(deps({ startServer }));

      expect(strangers.length).toBeGreaterThan(0);
      expect(strangers[0]?.listening).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.transcript).toContain(
        "Servidor local encerrado ao final: esperado sim, obtido sim | CONFERE",
      );
      expect(result.transcript).toContain("5 de 5 cenários conferem");
      expect(result.transcript).not.toContain("DIVERGE");
    } finally {
      await Promise.all(
        strangers.map(
          (stranger) =>
            new Promise<void>((resolve) => stranger.close(() => resolve())),
        ),
      );
    }
  });

  it("still diverges when the server did not close", async () => {
    let real: StubServer | undefined;
    const startServer = async (key: string): Promise<StubServer> => {
      real = await startStubServer(key);
      return { ...real, stop: () => Promise.resolve() };
    };

    try {
      const result = await runDemo(deps({ startServer }));

      expect(result.exitCode).toBe(1);
      expect(result.written).toBeUndefined();
      expect(result.transcript).toContain(
        "Servidor local encerrado ao final: esperado sim, obtido não | DIVERGE",
      );
    } finally {
      await real?.stop();
    }
  });
});
