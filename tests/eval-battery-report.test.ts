// The end of the battery: the summary (resumo.json) and the report
// (RELATORIO.md) are written once, by the safe writer, in the folder of the
// battery. In process, with everything injected: no network, no key, and the
// disk is a temporary folder (the real outputs/ is never touched).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/chat/rate-limiter.js";
import { parseConfig } from "../src/config/env.js";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import { aggregateBattery, summarySchema } from "../evals/aggregate.js";
import { runEvalCli, type EvalCliDeps } from "../evals/cli.js";
import type { Judge } from "../evals/judge.js";
import { redactLines } from "../evals/redact-lines.js";
import type { JudgeResult } from "../evals/record.js";
import { renderReport } from "../evals/report.js";
import { exitCodeFor, runBattery, type BatteryDeps } from "../evals/runner.js";
import { approvedStep, makeCritiqueDeps } from "./helpers/critique-fixtures.js";
import {
  answeredTurn,
  fullBattery,
  makeCase,
  makeLine,
} from "./helpers/eval-lines.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const KEY = fakeOpenAiKey();
const BATTERY_ID = "2026-11-20T14-30-00Z";
const FOLDER = `outputs/${BATTERY_ID}`;
const FIXTURE_CONTEXT = join(
  import.meta.dirname,
  "fixtures",
  "minimal-context",
);

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "made-up-eval-report-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function passed(passou = true): JudgeResult {
  return {
    situacao: "ok",
    passou,
    justificativa: "decisão do juiz",
    modelo: "modelo-juiz",
    novasTentativas: 0,
  };
}

function approvedTurn(text: string): FakeLlmStep[] {
  return [{ text }, approvedStep()];
}

function batteryDeps(
  script: readonly FakeLlmStep[],
  overrides: Partial<BatteryDeps> = {},
  root = temporaryRoot(),
) {
  const printed: string[] = [];
  const redact = createRedactor([KEY]);
  let ticks = 0;
  let milliseconds = 0;
  const cases = [makeCase("CT01"), makeCase("CT02", { regras: ["P1", "P3"] })];
  const deps: BatteryDeps = {
    cases,
    runs: 3,
    batteryId: BATTERY_ID,
    llm: createFakeLlmClient(script),
    judge: () => Promise.resolve(passed()),
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

function turns(count: number, text = "alfa beta"): FakeLlmStep[] {
  return Array.from({ length: count }, () => approvedTurn(text)).flat();
}

function read(root: string, name: string): string {
  return readFileSync(join(root, FOLDER, name), "utf8");
}

describe("runBattery: the summary and the report", () => {
  it("writes execucoes.jsonl, resumo.json and RELATORIO.md in the folder of the battery", async () => {
    const ready = batteryDeps(turns(6));

    const result = await runBattery(ready.deps);

    expect(readdirSync(join(ready.root, FOLDER)).sort()).toEqual([
      "RELATORIO.md",
      "execucoes.jsonl",
      "resumo.json",
    ]);
    const summary = summarySchema.parse(
      JSON.parse(read(ready.root, "resumo.json")),
    );
    expect(summary).toEqual(result.summary);
    expect(summary).toMatchObject({
      bateria: BATTERY_ID,
      execucoesEsperadas: 6,
      execucoesGravadas: 6,
      completa: true,
      parcial: false,
      f13Mensuravel: true,
      f13Atingido: true,
      juizMesmoModelo: false,
    });
    expect(summary.porCaso.map((caso) => caso.consistencia)).toEqual([
      "3/3",
      "3/3",
    ]);
    expect(summary.inicio).toBe("2026-11-20T14:31:01.000Z");
    const report = read(ready.root, "RELATORIO.md");
    expect(report).toContain(`# Relatório da bateria ${BATTERY_ID}`);
    expect(report).toContain("- F13: atingido (todas as execuções aprovadas)");
    expect(report).toContain("### CT02 · execução 3 · passou");
    expect(exitCodeFor(result)).toBe(0);
    const printed = ready.printed.join("");
    expect(printed).toContain("Consistência por caso:");
    expect(printed).toContain("  CT01  3/3  Caso CT01");
    expect(printed).toContain(
      "Consistência geral: 2/2 casos com todas as execuções aprovadas (100,0%)",
    );
    expect(printed).toContain("F13: atingido (todas as execuções aprovadas)");
    expect(printed).toContain(`Pasta: ${FOLDER}/`);
    expect(printed).toContain(`Relatório: ${FOLDER}/RELATORIO.md`);
  });

  it("writes both files only after the last execution, once", async () => {
    const real = createSafeWriter({
      redact: createRedactor([KEY]),
      rootDir: temporaryRoot(),
    });
    const order: string[] = [];
    const spy = {
      ...real,
      appendJsonLine: (path: string, value: unknown) => {
        order.push("line");
        return real.appendJsonLine(path, value);
      },
      writeJson: (path: string, value: unknown) => {
        order.push(`json:${path.split("/").pop()}`);
        return real.writeJson(path, value);
      },
      writeText: (path: string, content: string) => {
        order.push(`text:${path.split("/").pop()}`);
        return real.writeText(path, content);
      },
    };
    const ready = batteryDeps(turns(6), { writer: spy });

    await runBattery(ready.deps);

    expect(order).toEqual([
      "line",
      "line",
      "line",
      "line",
      "line",
      "line",
      "json:resumo.json",
      "text:RELATORIO.md",
    ]);
  });

  it("a judge that says no is a failure in the report, and the exit code is 1", async () => {
    const judge: Judge = (input) =>
      Promise.resolve(passed(!input.turnos[0]?.pergunta.includes("CT02")));
    const ready = batteryDeps(turns(2), {
      judge,
      runs: 1,
    });

    const result = await runBattery(ready.deps);
    const report = read(ready.root, "RELATORIO.md");

    expect(exitCodeFor(result)).toBe(1);
    expect(report).toContain("| CT02 | Caso CT02 | 0/1 | 0 | 1 | 0 | 0 |");
    expect(report).toContain("### CT02 · execução 1 · falhou");
    expect(report).toContain("- Juiz: reprovou (modelo modelo-juiz)");
    expect(report).toContain("- F13: não validado (parcial)");
  });

  it("is partial with --case or fewer than 3 runs, and still exits 0 if all passed", async () => {
    const ready = batteryDeps(turns(4), { runs: 2, catalogSize: 12 });

    const result = await runBattery(ready.deps);
    const summary = summarySchema.parse(
      JSON.parse(read(ready.root, "resumo.json")),
    );

    expect(summary).toMatchObject({
      parcial: true,
      f13Mensuravel: false,
      f13Atingido: false,
    });
    expect(read(ready.root, "RELATORIO.md")).toContain(
      "F13: não validado (parcial)",
    );
    expect(exitCodeFor(result)).toBe(0);
  });

  it("a judge that throws is an erro in the report, and the battery goes on", async () => {
    let calls = 0;
    const ready = batteryDeps(turns(2), {
      runs: 1,
      judge: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("juiz quebrou");
        }
        return Promise.resolve(passed());
      },
    });

    const result = await runBattery(ready.deps);
    const report = read(ready.root, "RELATORIO.md");

    expect(result.counts).toEqual({ passou: 1, falhou: 0, erro: 1 });
    expect(report).toContain("- Juiz: erro (tipo Error \\| juiz quebrou)");
    expect(report).toContain("- Motivo: juiz indisponível");
    expect(exitCodeFor(result)).toBe(1);
  });

  it("an interrupted battery with one line writes an INCOMPLETA report", async () => {
    const controller = new AbortController();
    const ready = batteryDeps(
      [
        ...approvedTurn("alfa beta"),
        { text: "dois", wait: () => controller.abort() },
      ],
      { signal: controller.signal, runs: 1 },
    );

    const result = await runBattery(ready.deps);
    const report = read(ready.root, "RELATORIO.md");

    expect(result.interrupted).toBe(true);
    expect(exitCodeFor(result)).toBe(130);
    expect(report).toContain("**INCOMPLETA: 1 de 2**");
    expect(report).toContain("### CT02 · execução 1 · sem execução");
    expect(
      summarySchema.parse(JSON.parse(read(ready.root, "resumo.json"))),
    ).toMatchObject({
      completa: false,
      f13Mensuravel: false,
      f13Atingido: false,
    });
  });

  it("writes nothing when there is no line", async () => {
    const controller = new AbortController();
    controller.abort();
    const ready = batteryDeps([], { signal: controller.signal });

    const result = await runBattery(ready.deps);

    expect(result.summary).toBeNull();
    expect(existsSync(join(ready.root, "outputs"))).toBe(false);
    expect(ready.printed.join("")).toContain("Nenhuma execução foi gravada.");
    expect(ready.printed.join("")).not.toContain("Consistência");
  });

  it("lets a failure to write the report out, as an error", async () => {
    const real = createSafeWriter({
      redact: createRedactor([KEY]),
      rootDir: temporaryRoot(),
    });
    const ready = batteryDeps(turns(1), {
      runs: 1,
      cases: [makeCase("CT01")],
      writer: {
        ...real,
        writeText: () => Promise.reject(new Error("disco cheio")),
      },
    });

    await expect(runBattery(ready.deps)).rejects.toThrow("disco cheio");
  });
});

describe("runBattery: an invariant of the lines", () => {
  it("keeps the result and writes no report when the plan repeats a case", async () => {
    const dup = makeCase("CT01");
    const ready = batteryDeps(turns(2), { cases: [dup, dup], runs: 1 });

    const result = await runBattery(ready.deps);

    expect(result.reportError).toMatch(/duas vezes/);
    expect(result.summary).toBeNull();
    expect(result.lines).toHaveLength(2);
    expect(existsSync(join(ready.root, FOLDER, "execucoes.jsonl"))).toBe(true);
    expect(existsSync(join(ready.root, FOLDER, "RELATORIO.md"))).toBe(false);
    expect(existsSync(join(ready.root, FOLDER, "resumo.json"))).toBe(false);
  });
});

describe("runBattery: a report that cannot be built", () => {
  /** The context hash changes from one line to the next: the aggregator refuses. */
  function divergentHashes(): BatteryDeps["fingerprints"] {
    let calls = 0;
    return {
      get hashContexto() {
        calls += 1;
        return `sha256:${String(calls % 10).repeat(64)}`;
      },
      hashCasos: `sha256:${"2".repeat(64)}`,
    };
  }

  it("says so, keeps the lines and exits 2 when every execution passed", async () => {
    const ready = batteryDeps(turns(2), {
      runs: 1,
      fingerprints: divergentHashes(),
    });

    const result = await runBattery(ready.deps);

    const output = ready.printed.join("");
    expect(result.reportError).toMatch(/hashes de context\/ diferentes/);
    expect(output).toMatch(
      /relatório não gerado: .*hashes de context\/ diferentes.*; execucoes\.jsonl está completo/,
    );
    expect(output).not.toContain("Pasta:");
    expect(result.counts).toEqual({ passou: 2, falhou: 0, erro: 0 });
    expect(
      read(ready.root, "execucoes.jsonl").trimEnd().split("\n"),
    ).toHaveLength(2);
    expect(readdirSync(join(ready.root, FOLDER))).toEqual(["execucoes.jsonl"]);
    expect(exitCodeFor(result)).toBe(2);
  });

  it("never masks a failed execution: the code stays 1", async () => {
    const ready = batteryDeps(turns(2), {
      runs: 1,
      fingerprints: divergentHashes(),
      judge: () => Promise.resolve(passed(false)),
    });

    const result = await runBattery(ready.deps);

    expect(result.reportError).not.toBeNull();
    expect(result.counts.falhou).toBe(2);
    expect(exitCodeFor(result)).toBe(1);
  });
});

describe("redactLines", () => {
  it("takes a key out of every field, even one that the Markdown would escape", () => {
    // A key with underscores: the Markdown escape would turn each one into
    // "\_", and the redactor of the writer would no longer see the key.
    const key = ["sk", "proj", "AAAA_BBBB_CCCC_7Qz9"].join("-");
    const redact = createRedactor([key]);
    const lines = [
      makeLine({
        casoId: "CT01",
        execucao: 1,
        resultado: "falhou",
        judgeReason: `com ${key}`,
        motivo: `motivo ${key}`,
        modelo: key,
        turnos: [
          answeredTurn({
            question: key,
            draft: key,
            final: key,
            evaluation: {
              situacao: "ok",
              aprovada: false,
              violacoes: [{ regra: "P2", motivo: key }],
            },
          }),
        ],
      }),
    ];
    const plan = [makeCase("CT01")];
    const unsafe = renderReport(summaryOf(lines, plan), lines);
    expect(unsafe).toContain(key.replaceAll("_", "\\_"));

    const safe = redactLines(lines, redact);
    const report = renderReport(summaryOf(safe, plan), safe);

    expect(JSON.stringify(safe)).not.toContain(key);
    expect(report).not.toContain(key);
    expect(report).not.toContain("AAAA");
    expect(report).toContain("REDACTED");
  });

  it("does not change what holds no key", () => {
    const lines = fullBattery([makeCase("CT01")], 2);
    expect(redactLines(lines, createRedactor([KEY]))).toEqual(lines);
  });
});

function summaryOf(
  lines: Parameters<typeof redactLines>[0],
  plan: ReturnType<typeof makeCase>[],
) {
  return aggregateBattery({
    lines,
    plan: { runs: 1, casos: plan },
    batteryId: BATTERY_ID,
    catalogSize: plan.length,
  });
}

// ---- runEvalCli: exit codes ------------------------------------------------

const CASES = JSON.stringify([
  {
    id: "CT01",
    titulo: "Primeiro",
    categoria: "caminho-feliz",
    regras: ["P3"],
    perfil: "dora-teixeira",
    turnos: ["Pergunta um?"],
    comportamentoEsperado: "Algo.",
    criterios: { deveConter: [["alfa"]], naoDeveConter: [], rubrica: "r" },
  },
  {
    id: "CT02",
    titulo: "Segundo",
    categoria: "caminho-feliz",
    regras: ["P3"],
    perfil: "egon-pires",
    turnos: ["Pergunta dois?"],
    comportamentoEsperado: "Algo.",
    criterios: { deveConter: [["beta"]], naoDeveConter: [], rubrica: "r" },
  },
]);

function judged(passou = true): FakeLlmStep {
  return { value: { justificativa: "decisão do juiz", passou } };
}

function turn(text: string, passou = true): FakeLlmStep[] {
  return [{ text }, approvedStep(), judged(passou)];
}

function cliHarness(
  argv: string[],
  script: readonly FakeLlmStep[],
  overrides: Partial<EvalCliDeps> = {},
) {
  const root = temporaryRoot();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fake = createFakeLlmClient(script);
  let ms = 0;
  const deps: EvalCliDeps = {
    argv,
    readCases: () => CASES,
    contextDir: FIXTURE_CONTEXT,
    rootDir: root,
    loadConfig: vi.fn(() =>
      parseConfig({
        OPENAI_API_KEY: KEY,
        RETRY_BASE_DELAY_MS: "1",
        RETRY_MAX_ATTEMPTS: "1",
      }),
    ),
    createClient: () => fake,
    nowMs: () => (ms += 100),
    sleep: () => Promise.resolve(),
    now: () => new Date("2026-11-20T14:30:00.412Z"),
    folderExists: (id) => existsSync(join(root, "outputs", id)),
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
    ...overrides,
  };
  return { root, stdout, stderr, deps };
}

describe("runEvalCli: the report", () => {
  it("exits 0 and leaves the three files when everything passes", async () => {
    const h = cliHarness(["--runs", "1"], [...turn("alfa"), ...turn("beta")]);

    expect(await runEvalCli(h.deps)).toBe(0);

    expect(readdirSync(join(h.root, FOLDER)).sort()).toEqual([
      "RELATORIO.md",
      "execucoes.jsonl",
      "resumo.json",
    ]);
    const summary = summarySchema.parse(
      JSON.parse(read(h.root, "resumo.json")),
    );
    // Both cases of the file, but one run: partial.
    expect(summary).toMatchObject({
      parcial: true,
      f13Mensuravel: false,
      f13Atingido: false,
    });
    expect(h.stdout.join("")).toContain("  CT01  1/1  Primeiro");
    expect(h.stderr.join("")).toBe("");
  });

  it("with 3 runs and every case, F13 is met", async () => {
    const h = cliHarness(
      [],
      [
        ...turn("alfa"),
        ...turn("beta"),
        ...turn("alfa"),
        ...turn("beta"),
        ...turn("alfa"),
        ...turn("beta"),
      ],
    );

    expect(await runEvalCli(h.deps)).toBe(0);
    expect(read(h.root, "RELATORIO.md")).toContain(
      "- F13: atingido (todas as execuções aprovadas)",
    );
  });

  it("with --case the battery is partial, and exits 0 if what ran passed", async () => {
    const h = cliHarness(
      ["--case", "CT01"],
      [...turn("alfa"), ...turn("alfa"), ...turn("alfa")],
    );

    expect(await runEvalCli(h.deps)).toBe(0);
    expect(read(h.root, "RELATORIO.md")).toContain(
      "F13: não validado (parcial)",
    );
    expect(
      summarySchema.parse(JSON.parse(read(h.root, "resumo.json"))),
    ).toMatchObject({
      parcial: true,
      f13Mensuravel: false,
      f13Atingido: false,
      porCaso: [{ id: "CT01" }],
    });
  });

  it("exits 1 when the judge fails an execution, with the failure in the report", async () => {
    const h = cliHarness(
      ["--runs", "1"],
      [...turn("alfa", false), ...turn("beta")],
    );

    expect(await runEvalCli(h.deps)).toBe(1);
    expect(read(h.root, "RELATORIO.md")).toContain(
      "### CT01 · execução 1 · falhou",
    );
  });

  it("exits 130 with an INCOMPLETA report when interrupted after one line", async () => {
    const controller = new AbortController();
    const h = cliHarness(
      ["--runs", "1"],
      [...turn("alfa"), { text: "beta", wait: () => controller.abort() }],
      { signal: controller.signal },
    );

    expect(await runEvalCli(h.deps)).toBe(130);
    expect(read(h.root, "RELATORIO.md")).toContain("INCOMPLETA: 1 de 2");
  });

  it("exits 130 and writes no folder when interrupted before any line", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = cliHarness([], [], { signal: controller.signal });

    expect(await runEvalCli(h.deps)).toBe(130);
    expect(existsSync(join(h.root, "outputs"))).toBe(false);
  });

  it("exits 2 when resumo.json cannot be written, with a redacted one-line message", async () => {
    const h = cliHarness(["--runs", "1"], [...turn("alfa"), ...turn("beta")], {
      folderExists: () => false,
    });
    // A folder where the file should be: the write fails.
    mkdirSync(join(h.root, FOLDER, "resumo.json"), { recursive: true });

    expect(await runEvalCli(h.deps)).toBe(2);

    const stderr = h.stderr.join("");
    expect(stderr).toContain(`Não foi possível gravar ${FOLDER}/resumo.json`);
    expect(stderr).not.toContain("o resumo da bateria");
    expect(stderr).toContain("resumo.json pode existir sem RELATORIO.md");
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr).not.toContain(KEY);
    // The lines that were written stay.
    expect(existsSync(join(h.root, FOLDER, "execucoes.jsonl"))).toBe(true);
  });

  it("exits 1, not 2, when resumo.json cannot be written and an execution failed", async () => {
    const h = cliHarness(
      ["--runs", "1"],
      [...turn("alfa", false), ...turn("beta")],
      { folderExists: () => false },
    );
    mkdirSync(join(h.root, FOLDER, "resumo.json"), { recursive: true });

    expect(await runEvalCli(h.deps)).toBe(1);
    expect(h.stderr.join("")).toContain(`${FOLDER}/resumo.json`);
  });

  it("exits 1, not 2, when RELATORIO.md cannot be written and an execution failed", async () => {
    const h = cliHarness(
      ["--runs", "1"],
      [...turn("alfa", false), ...turn("beta")],
      { folderExists: () => false },
    );
    mkdirSync(join(h.root, FOLDER, "RELATORIO.md"), { recursive: true });

    expect(await runEvalCli(h.deps)).toBe(1);
  });

  it("exits 130 when interrupted and the summary cannot be written", async () => {
    const controller = new AbortController();
    const h = cliHarness(
      ["--runs", "1"],
      [...turn("alfa"), { text: "beta", wait: () => controller.abort() }],
      { signal: controller.signal, folderExists: () => false },
    );
    mkdirSync(join(h.root, FOLDER, "resumo.json"), { recursive: true });

    expect(await runEvalCli(h.deps)).toBe(130);
  });

  it("exits 2 when RELATORIO.md cannot be written", async () => {
    const h = cliHarness(["--runs", "1"], [...turn("alfa"), ...turn("beta")], {
      folderExists: () => false,
    });
    mkdirSync(join(h.root, FOLDER, "RELATORIO.md"), { recursive: true });

    expect(await runEvalCli(h.deps)).toBe(2);
    expect(h.stderr.join("")).toContain(`${FOLDER}/RELATORIO.md`);
  });

  it("never prints or writes the key", async () => {
    const h = cliHarness(
      ["--runs", "1"],
      [...turn(`alfa ${KEY}`), ...turn("beta")],
    );

    await runEvalCli(h.deps);

    for (const name of ["execucoes.jsonl", "resumo.json", "RELATORIO.md"]) {
      expect(read(h.root, name)).not.toContain(KEY);
    }
    expect(h.stdout.join("")).not.toContain(KEY);
    expect(h.stderr.join("")).not.toContain(KEY);
  });
});
