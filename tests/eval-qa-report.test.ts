// QA of ENG-57 part 2: edge cases of the verdict schema, the report and the end
// of the battery. In process, no network, no key, temporary disk only.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/chat/rate-limiter.js";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import { aggregateBattery, summarySchema } from "../evals/aggregate.js";
import { fenceBlock, untrustedBlock } from "../evals/markdown.js";
import {
  execucaoSchema,
  parseExecutionLine,
  type JudgeResult,
} from "../evals/record.js";
import { renderReport } from "../evals/report.js";
import { exitCodeFor, runBattery, type BatteryDeps } from "../evals/runner.js";
import { buildVerdict, type Outcome } from "../evals/verdict.js";
import { approvedStep, makeCritiqueDeps } from "./helpers/critique-fixtures.js";
import {
  answeredTurn,
  BATTERY,
  fullBattery,
  HASH_CASES,
  HASH_CONTEXT,
  makeCase,
  makeLine,
} from "./helpers/eval-lines.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const KEY = fakeOpenAiKey();
const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "made-up-eval-qa-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("every verdict that buildVerdict can produce is a valid line", () => {
  const caso = makeCase("CT01", {
    criterios: {
      deveConter: [["alfa"]],
      naoDeveConter: ["proibido"],
      rubrica: "R.",
    },
  });
  const judgeOk = (passou: boolean): JudgeResult => ({
    situacao: "ok",
    passou,
    justificativa: "j",
    modelo: "m",
    novasTentativas: 0,
  });
  const judgeError: JudgeResult = {
    situacao: "erro",
    resumo: { mensagem: "fora do ar" },
    novasTentativas: 2,
  };
  const texts = ["alfa", "nada", "alfa proibido", "alfa 😀", ""];
  const origins = ["rascunho", "revisao", "fallback"] as const;
  const judges: (JudgeResult | undefined)[] = [
    undefined,
    judgeOk(true),
    judgeOk(false),
    judgeError,
  ];

  it("accepts the whole matrix of outcomes", () => {
    let accepted = 0;
    const outcomes: Outcome[] = [
      { kind: "error", motivo: "turno 1 de 1 falhou" },
      ...texts.flatMap((text) =>
        origins.flatMap((origin) =>
          [false, true].map((evaluationFailed): Outcome => ({
            kind: "answered",
            text,
            origin,
            evaluationFailed,
          })),
        ),
      ),
    ];
    for (const outcome of outcomes) {
      for (const juiz of judges) {
        const veredito = buildVerdict(caso, outcome, juiz);
        const line = {
          esquema: 1,
          bateria: BATTERY,
          casoId: "CT01",
          execucao: 1,
          dataHora: "2026-11-20T14:31:07.412Z",
          modelo: null,
          perfil: "dora-teixeira",
          hashContexto: HASH_CONTEXT,
          hashCasos: HASH_CASES,
          turnos: [answeredTurn()],
          veredito: {
            resultado: veredito.resultado,
            ...(veredito.motivo === undefined
              ? {}
              : { motivo: veredito.motivo }),
            checagens: veredito.checagens.map((check) => ({ ...check })),
            juiz: veredito.juiz,
          },
        };
        const parsed = execucaoSchema.safeParse(line);
        expect(
          parsed.success,
          JSON.stringify({ outcome, juiz, veredito }),
        ).toBe(true);
        accepted += 1;
      }
    }
    expect(accepted).toBe(outcomes.length * judges.length);
  });
});

describe("the report is a pure function of the lines", () => {
  const plan = [makeCase("CT01"), makeCase("CT02", { regras: ["P1", "P4"] })];

  function summaryOf(lines: ReturnType<typeof fullBattery>, runs: number) {
    return aggregateBattery({
      lines,
      plan: { runs, casos: plan },
      batteryId: BATTERY,
      catalogSize: plan.length,
    });
  }

  it("is byte for byte the same after a round trip through JSON lines", () => {
    const lines = [
      ...fullBattery(plan, 2),
      makeLine({
        casoId: "CT01",
        execucao: 3,
        resultado: "falhou",
        judgeReason: "texto `com` | pipe\r\n# e título ‮",
        turnos: [answeredTurn({ question: "```\n~~~", final: "a b\u0000c" })],
      }),
    ];
    const summary = summaryOf(lines, 3);
    const first = renderReport(summary, lines);

    const jsonl = lines.map((line) => JSON.stringify(line)).join("\n");
    const again = jsonl
      .split("\n")
      .map((raw) => parseExecutionLine(JSON.parse(raw)));
    const second = renderReport(summaryOf(again, 3), again);

    expect(second).toBe(first);
    expect(renderReport(summary, lines)).toBe(first);
    expect(first).not.toContain("\r");
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
  });

  it("does not depend on the order of the lines", () => {
    const lines = fullBattery(plan, 3);
    const shuffled = [...lines].reverse();
    expect(JSON.stringify(summaryOf(shuffled, 3))).toBe(
      JSON.stringify(summaryOf(lines, 3)),
    );
    expect(renderReport(summaryOf(shuffled, 3), shuffled)).toBe(
      renderReport(summaryOf(lines, 3), lines),
    );
  });

  it("closes the totals for --runs 1, 5 and 10", () => {
    for (const runs of [1, 5, 10]) {
      const lines = fullBattery(plan, runs);
      const summary = summarySchema.parse(summaryOf(lines, runs));
      expect(summary.execucoesEsperadas).toBe(plan.length * runs);
      expect(summary.porCaso.map((caso) => caso.consistencia)).toEqual([
        `${runs}/${runs}`,
        `${runs}/${runs}`,
      ]);
      expect(summary.parcial).toBe(runs < 3);
      expect(summary.f13Atendido).toBe(runs >= 3);
    }
  });

  it("refuses a repeated execution and one outside 1..runs", () => {
    const lines = fullBattery(plan, 2);
    expect(() =>
      summaryOf(
        [
          ...lines,
          makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" }),
        ],
        2,
      ),
    ).toThrow(/duas vezes/);
    expect(() =>
      summaryOf(
        [makeLine({ casoId: "CT01", execucao: 3, resultado: "passou" })],
        2,
      ),
    ).toThrow(/fora de 1 a 2/);
  });
});

describe("fenced blocks: the text can never close its own fence", () => {
  // The CommonMark rule: a closing fence is a line of at least as many
  // backticks as the opening one, indented by up to 3 spaces, and nothing else.
  function closesEarly(block: string): boolean {
    const rows = block.split("\n");
    const opening = rows[0] ?? "";
    for (const row of rows.slice(1, -1)) {
      const match = /^ {0,3}(`+)[ \t]*$/.exec(row);
      if (match !== null && (match[1]?.length ?? 0) >= opening.length) {
        return true;
      }
    }
    return false;
  }

  it("holds for generated runs of backticks, spaces and line breaks", () => {
    let seed = 7;
    const next = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 4294967296) * limit);
    };
    const pieces = [
      "`",
      "``",
      "```",
      "````",
      "`````",
      " ",
      "   ",
      "\n",
      "\r\n",
      "\r",
      "~~~",
      "x",
      " ",
    ];
    for (let round = 0; round < 500; round += 1) {
      let text = "";
      for (let step = 0; step < 1 + next(40); step += 1) {
        text += pieces[next(pieces.length)] ?? "";
      }
      expect(closesEarly(untrustedBlock(text)), JSON.stringify(text)).toBe(
        false,
      );
      expect(closesEarly(fenceBlock(text)), JSON.stringify(text)).toBe(false);
    }
  });

  it("stays bounded for a megabyte of text and for a megabyte of backticks", () => {
    for (const text of [
      "x".repeat(1_000_000),
      "`".repeat(1_000_000),
      "😀".repeat(1_000_000),
    ]) {
      const block = untrustedBlock(text);
      expect(block.length).toBeLessThan(40_000);
      expect(closesEarly(block)).toBe(false);
    }
  });
});

describe("the end of the battery", () => {
  function deps(
    script: readonly FakeLlmStep[],
    overrides: Partial<BatteryDeps> = {},
  ) {
    const root = temporaryRoot();
    const redact = createRedactor([KEY]);
    const printed: string[] = [];
    let ticks = 0;
    const base: BatteryDeps = {
      cases: [makeCase("CT01"), makeCase("CT02")],
      runs: 1,
      batteryId: BATTERY,
      llm: createFakeLlmClient(script),
      judge: () =>
        Promise.resolve({
          situacao: "ok",
          passou: true,
          justificativa: "ok",
          modelo: "juiz",
          novasTentativas: 0,
        } satisfies JudgeResult),
      fingerprints: { hashContexto: HASH_CONTEXT, hashCasos: HASH_CASES },
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
      nowMs: () => (ticks += 1) * 100,
      print: (text) => printed.push(text),
      ...overrides,
    };
    return { root, printed, deps: base };
  }
  const turn = (text: string): FakeLlmStep[] => [{ text }, approvedStep()];

  it("an interruption during the judge drops that execution, writes the earlier ones and exits 130", async () => {
    const controller = new AbortController();
    let calls = 0;
    const ready = deps([...turn("alfa"), ...turn("alfa")], {
      signal: controller.signal,
      judge: () => {
        calls += 1;
        if (calls === 2) {
          controller.abort();
        }
        return Promise.resolve({
          situacao: "ok",
          passou: true,
          justificativa: "ok",
          modelo: "juiz",
          novasTentativas: 0,
        } satisfies JudgeResult);
      },
    });

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(exitCodeFor(result)).toBe(130);
    const folder = join(ready.root, "outputs", BATTERY);
    const rows = readFileSync(join(folder, "execucoes.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    expect(rows).toHaveLength(1);
    const report = readFileSync(join(folder, "RELATORIO.md"), "utf8");
    expect(report).toContain("**INCOMPLETA: 1 de 2**");
    expect(report).not.toContain("\r");
    expect(readFileSync(join(folder, "resumo.json"), "utf8")).not.toContain(
      "\r",
    );
  });

  it("a failure to write resumo.json leaves no RELATORIO.md behind", async () => {
    const ready = deps(turn("alfa"), { cases: [makeCase("CT01")] });
    const real = ready.deps.writer;
    await expect(
      runBattery({
        ...ready.deps,
        writer: {
          ...real,
          writeJson: () => Promise.reject(new Error("falhou")),
        },
      }),
    ).rejects.toThrow("falhou");
    const folder = join(ready.root, "outputs", BATTERY);
    expect(existsSync(join(folder, "execucoes.jsonl"))).toBe(true);
    expect(existsSync(join(folder, "RELATORIO.md"))).toBe(false);
    expect(existsSync(join(folder, "resumo.json"))).toBe(false);
  });

  it("writes the files with LF only, even when a text holds CRLF", async () => {
    const ready = deps(turn("alfa\r\nbeta\r\n"), { cases: [makeCase("CT01")] });
    await runBattery(ready.deps);
    const folder = join(ready.root, "outputs", BATTERY);
    for (const name of ["RELATORIO.md", "resumo.json"]) {
      expect(readFileSync(join(folder, name), "utf8")).not.toContain("\r");
    }
  });

  it("keeps a key with underscores out of every file, stdout included, when it comes from the judge and the model name", async () => {
    const key = [
      "sk",
      "proj",
      "AAAA_BBBB-CCCC_7Qz9",
      "DDDD_EEEE-FFFF_8Rx0",
    ].join("-");
    const ready = deps(turn(`alfa ${key}`), {
      cases: [makeCase("CT01")],
      redact: createRedactor([KEY, key]),
      judge: () =>
        Promise.resolve({
          situacao: "ok",
          passou: false,
          justificativa: `viu ${key}`,
          modelo: key,
          novasTentativas: 0,
        } satisfies JudgeResult),
    });
    // The writer redacts with its own redactor: give it the same key list.
    await runBattery({
      ...ready.deps,
      writer: createSafeWriter({
        redact: createRedactor([KEY, key]),
        rootDir: ready.root,
      }),
    });
    const folder = join(ready.root, "outputs", BATTERY);
    for (const name of ["execucoes.jsonl", "resumo.json", "RELATORIO.md"]) {
      const content = readFileSync(join(folder, name), "utf8");
      expect(content, name).not.toContain(key);
      expect(content, name).not.toContain("AAAA");
      expect(content, name).not.toContain("DDDD");
    }
    expect(ready.printed.join("")).not.toContain("AAAA");
  });
});
