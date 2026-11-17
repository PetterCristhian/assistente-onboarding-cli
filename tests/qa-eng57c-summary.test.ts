// QA of ENG-57 part 3: the new invariants of summarySchema against what the
// real aggregator produces (no false negative), forged summaries (no false
// positive), exitCodeFor in every combination and the partial state.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/chat/rate-limiter.js";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import {
  aggregateBattery,
  summarySchema,
  type BatterySummary,
} from "../evals/aggregate.js";
import type { ExecutionLine } from "../evals/record.js";
import { renderReport } from "../evals/report.js";
import {
  exitCodeFor,
  runBattery,
  type BatteryDeps,
  type BatteryResult,
} from "../evals/runner.js";
import { approvedStep, makeCritiqueDeps } from "./helpers/critique-fixtures.js";
import { BATTERY, makeCase, makeLine } from "./helpers/eval-lines.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

/** A small deterministic generator, so that a failure can be repeated. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function plan(count: number) {
  return Array.from({ length: count }, (_, index) =>
    makeCase(`CT${String(index + 1).padStart(2, "0")}`, {
      regras: index % 2 === 0 ? ["P1", "P3"] : ["P2"],
    }),
  );
}

describe("summarySchema accepts what the real aggregator produces", () => {
  it("for 300 random plans, runs and subsets of lines (partial, incomplete, complete)", () => {
    const random = lcg(57);
    for (let round = 0; round < 300; round += 1) {
      const casesCount = 1 + Math.floor(random() * 6);
      const runs = 1 + Math.floor(random() * 10);
      const catalog = casesCount + Math.floor(random() * 3);
      const cases = plan(casesCount);
      const lines: ExecutionLine[] = [];
      for (const caso of cases) {
        for (let run = 1; run <= runs; run += 1) {
          if (random() < 0.2) {
            continue;
          }
          const pick = random();
          lines.push(
            makeLine({
              casoId: caso.id,
              execucao: run,
              resultado: pick < 0.7 ? "passou" : pick < 0.9 ? "falhou" : "erro",
              ...(pick >= 0.9 ? { judgeError: true } : {}),
            }),
          );
        }
      }
      if (lines.length === 0) {
        continue;
      }
      const summary = aggregateBattery({
        lines,
        plan: { runs, casos: cases },
        batteryId: BATTERY,
        catalogSize: catalog,
      });
      const parsed = summarySchema.safeParse(summary);
      expect(
        parsed.success ? "" : JSON.stringify(parsed.error.issues),
        `round ${round}: ${casesCount} cases, ${runs} runs`,
      ).toBe("");
      // And the report can be rendered for it.
      expect(() => renderReport(summary, lines)).not.toThrow();
    }
  });

  it.each([
    ["one case, one run", 1, 1, 1],
    ["one case, ten runs", 1, 10, 1],
    ["three runs, whole catalog", 3, 3, 3],
    ["two runs, whole catalog (partial by runs)", 3, 2, 3],
    ["subset of the catalog with 3 runs (partial by --case)", 2, 3, 12],
  ])("%s", (_label, casesCount, runs, catalog) => {
    const cases = plan(casesCount);
    const lines = cases.flatMap((caso) =>
      Array.from({ length: runs }, (_, index) =>
        makeLine({
          casoId: caso.id,
          execucao: index + 1,
          resultado: "passou",
        }),
      ),
    );
    const summary = aggregateBattery({
      lines,
      plan: { runs, casos: cases },
      batteryId: BATTERY,
      catalogSize: catalog,
    });

    expect(summarySchema.safeParse(summary).success).toBe(true);
    expect(summary.f13Mensuravel).toBe(runs >= 3 && casesCount === catalog);
  });
});

describe("summarySchema refuses forged summaries", () => {
  const cases = plan(3);
  const lines = cases.flatMap((caso) =>
    [1, 2, 3].map((run) =>
      makeLine({
        casoId: caso.id,
        execucao: run,
        resultado: run === 2 && caso.id === "CT02" ? "falhou" : "passou",
      }),
    ),
  );
  const base: BatterySummary = aggregateBattery({
    lines,
    plan: { runs: 3, casos: cases },
    batteryId: BATTERY,
    catalogSize: 3,
  });
  const clone = (): BatterySummary => structuredClone(base);

  it("the legitimate one passes", () => {
    expect(summarySchema.safeParse(base).success).toBe(true);
  });

  const forgeries: [string, (summary: BatterySummary) => void][] = [
    ["execucoesEsperadas", (s) => void (s.execucoesEsperadas += 1)],
    ["porCaso passou", (s) => void (s.porCaso[0]!.passou -= 1)],
    ["porCaso falhou", (s) => void (s.porCaso[0]!.falhou += 1)],
    ["porCaso erro", (s) => void (s.porCaso[0]!.erro += 1)],
    ["porCaso ausentes", (s) => void (s.porCaso[0]!.ausentes += 1)],
    ["consistencia", (s) => void (s.porCaso[1]!.consistencia = "3/3")],
    [
      "consistencia esperadas",
      (s) => void (s.porCaso[0]!.consistencia = "3/9"),
    ],
    ["todasAprovadas true", (s) => void (s.porCaso[1]!.todasAprovadas = true)],
    [
      "todasAprovadas false",
      (s) => void (s.porCaso[0]!.todasAprovadas = false),
    ],
    [
      "casosTodasAprovadas",
      (s) => void (s.taxaConsistenciaGeral.casosTodasAprovadas = 3),
    ],
    ["casos", (s) => void (s.taxaConsistenciaGeral.casos = 2)],
    [
      "f13 with 2 runs",
      (s) => {
        s.execucoesPorCaso = 2;
        s.execucoesEsperadas = 6;
        s.porCaso.forEach((c) => {
          c.esperadas = 2;
        });
      },
    ],
    ["totais", (s) => void (s.totais.passou += 1)],
    ["completa", (s) => void (s.completa = false)],
  ];

  it.each(forgeries)("%s", (_label, forge) => {
    const forged = clone();
    forge(forged);

    expect(summarySchema.safeParse(forged).success).toBe(false);
  });
});

describe("exitCodeFor, every combination", () => {
  const line = makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" });
  const results = [true, false] as const;

  function make(
    interrupted: boolean,
    failed: boolean,
    errored: boolean,
    absent: boolean,
    reportFailed: boolean,
  ): BatteryResult {
    return {
      folder: "outputs/x",
      file: "outputs/x/execucoes.jsonl",
      lines: absent ? [line] : [line, line],
      expected: 2,
      interrupted,
      counts: {
        passou: 0,
        falhou: failed ? 1 : 0,
        erro: errored ? 1 : 0,
      },
      summary: null,
      reportError: reportFailed ? "relatório falhou" : null,
    };
  }

  it("follows the documented precedence in all 32 combinations", () => {
    for (const interrupted of results) {
      for (const failed of results) {
        for (const errored of results) {
          for (const absent of results) {
            for (const reportFailed of results) {
              const expected = interrupted
                ? 130
                : failed || errored || absent
                  ? 1
                  : reportFailed
                    ? 2
                    : 0;
              expect(
                exitCodeFor(
                  make(interrupted, failed, errored, absent, reportFailed),
                ),
                JSON.stringify({
                  interrupted,
                  failed,
                  errored,
                  absent,
                  reportFailed,
                }),
              ).toBe(expected);
            }
          }
        }
      }
    }
  });
});

const KEY = fakeOpenAiKey();
const FOLDER = `outputs/${BATTERY}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function harness(overrides: Partial<BatteryDeps>, script: FakeLlmStep[]) {
  const root = mkdtempSync(join(tmpdir(), "made-up-qa-57c-"));
  roots.push(root);
  const printed: string[] = [];
  const redact = createRedactor([KEY]);
  let ticks = 0;
  let milliseconds = 0;
  const cases = [makeCase("CT01"), makeCase("CT02")];
  const deps: BatteryDeps = {
    cases,
    runs: 1,
    batteryId: BATTERY,
    llm: createFakeLlmClient(script),
    judge: () =>
      Promise.resolve({
        situacao: "ok" as const,
        passou: true,
        justificativa: "ok",
        modelo: "modelo-juiz",
        novasTentativas: 0,
      }),
    fingerprints: {
      hashContexto: `sha256:${"1".repeat(64)}`,
      hashCasos: `sha256:${"2".repeat(64)}`,
    },
    catalogSize: cases.length,
    contexts: new Map([
      ["dora-teixeira", { instructions: "I", critique: makeCritiqueDeps() }],
    ]),
    redact,
    redactStream: () => createStreamRedactor([KEY]),
    limiter: createRateLimiter({
      maxRequests: 1000,
      windowSeconds: 60,
      now: () => 0,
      sleep: () => Promise.resolve(),
    }),
    writer: createSafeWriter({ redact, rootDir: root }),
    now: () => new Date(Date.UTC(2026, 10, 20, 14, 31, (ticks += 1))),
    nowMs: () => (milliseconds += 250),
    print: (text) => printed.push(text),
    ...overrides,
  };
  return { root, printed, deps };
}

const twoTurns = (): FakeLlmStep[] =>
  Array.from({ length: 2 }, () => [
    { text: "alfa beta" },
    approvedStep(),
  ]).flat();

describe("runBattery: the report fails", () => {
  it("never prints a key that the aggregator message carries", async () => {
    // The plan repeats a case whose id holds a key: the aggregator quotes it.
    const dup = makeCase("CT01");
    const hostile = { ...dup, titulo: KEY };
    const ready = harness({ cases: [dup, hostile], runs: 1 }, twoTurns());

    const result = await runBattery(ready.deps);

    expect(result.reportError).not.toBeNull();
    expect(ready.printed.join("")).not.toContain(KEY);
    expect(result.reportError ?? "").not.toContain(KEY);
    expect(result.reportError ?? "").not.toMatch(/\n/);
  });

  it("says that a complete battery has a complete file, without a doubled period", async () => {
    const dup = makeCase("CT01");
    const ready = harness({ cases: [dup, { ...dup }], runs: 1 }, twoTurns());

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(false);
    expect(result.lines.length).toBe(result.expected);
    const output = ready.printed.join("");
    expect(output).toMatch(
      /relatório não gerado: .*; execucoes\.jsonl está completo/,
    );
    expect(output).not.toContain(".;");
    expect(result.reportError ?? "").not.toMatch(/[.\s]$/);
  });

  it("says what the interrupted battery has, not that the file is complete", async () => {
    const controller = new AbortController();
    let calls = 0;
    const ready = harness(
      {
        runs: 1,
        fingerprints: {
          get hashContexto() {
            calls += 1;
            return `sha256:${String(calls % 9)}${"1".repeat(63)}`;
          },
          hashCasos: `sha256:${"2".repeat(64)}`,
        },
        cases: [makeCase("CT01"), makeCase("CT02"), makeCase("CT03")],
        catalogSize: 3,
        signal: controller.signal,
      },
      [...twoTurns(), { text: "tres", wait: () => controller.abort() }],
    );

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(true);
    expect(exitCodeFor(result)).toBe(130);
    const output = ready.printed.join("");
    expect(result.lines.length).toBeLessThan(result.expected);
    expect(result.reportError).not.toBeNull();
    // With 2 of 3 executions written, "está completo" would be untrue.
    expect(output).not.toMatch(/execucoes\.jsonl está completo/);
    expect(output).toContain(
      "execucoes.jsonl contém as execuções gravadas até a interrupção",
    );
    expect(output).not.toContain(".;");
    expect(readdirSync(join(ready.root, FOLDER))).toContain("execucoes.jsonl");
  });
});
