// QA of ENG-56: adversarial cases around the runner, the verdict, the
// arguments and the folder name. No network, no key, no real time; the disk is
// real only inside a temporary folder.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../src/chat/rate-limiter.js";
import { parseConfig } from "../src/config/env.js";
import { LlmResponseError, type LlmClient } from "../src/llm/client.js";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import { parseEvalArgs } from "../evals/args.js";
import { batteryIdFrom, uniqueBatteryId } from "../evals/battery-id.js";
import { runEvalCli, type EvalCliDeps } from "../evals/cli.js";
import type { BatteryContext } from "../evals/contexts.js";
import { execucaoSchema } from "../evals/record.js";
import {
  exitCodeFor,
  planExecutions,
  runBattery,
  type BatteryDeps,
} from "../evals/runner.js";
import type { Caso } from "../evals/schema.js";
import {
  EVALUATION_UNAVAILABLE,
  FALLBACK_REASON,
  buildVerdict,
  containsTerm,
  hasEmoji,
} from "../evals/verdict.js";
import {
  approvedStep,
  makeCritiqueDeps,
  rejectedStep,
} from "./helpers/critique-fixtures.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const KEY = fakeOpenAiKey();
const ID = "2026-11-20T14-30-00Z";
const FILE = `outputs/${ID}/execucoes.jsonl`;
const FIXTURE_CONTEXT = join(
  import.meta.dirname,
  "fixtures",
  "minimal-context",
);

const roots: string[] = [];
function temporaryRoot(prefix = "made-up-eval-qa-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeCase(id: string, overrides: Partial<Caso> = {}): Caso {
  return {
    id,
    titulo: `Caso ${id}`,
    categoria: "caminho-feliz",
    regras: ["P3"],
    perfil: "dora-teixeira",
    turnos: [`Pergunta de ${id}?`],
    comportamentoEsperado: "Algo.",
    criterios: { deveConter: [], naoDeveConter: [], rubrica: "Rubrica." },
    ...overrides,
  };
}

const CONTEXT: BatteryContext = {
  instructions: "INSTRUCOES",
  critique: makeCritiqueDeps(),
};

function approved(text: string): FakeLlmStep[] {
  return [{ text }, approvedStep()];
}

function setup(
  llm: LlmClient,
  cases: readonly Caso[],
  overrides: Partial<BatteryDeps> = {},
  runs = 1,
) {
  const root = temporaryRoot();
  const printed: string[] = [];
  const strong = createRedactor([KEY]);
  let ticks = 0;
  let ms = 0;
  const deps: BatteryDeps = {
    cases,
    runs,
    batteryId: ID,
    llm,
    // A judge that always approves: the runner and the verdict are what is tested.
    judge: () =>
      Promise.resolve({
        situacao: "ok",
        passou: true,
        justificativa: "ok",
        modelo: "modelo-juiz",
        novasTentativas: 0,
      }),
    fingerprints: {
      hashContexto: `sha256:${"1".repeat(64)}`,
      hashCasos: `sha256:${"2".repeat(64)}`,
    },
    contexts: new Map(
      cases.map((c): [string, BatteryContext] => [c.perfil, CONTEXT]),
    ),
    redact: strong,
    redactStream: () => createStreamRedactor([KEY]),
    limiter: createRateLimiter({
      maxRequests: 1000,
      windowSeconds: 60,
      now: () => 0,
      sleep: () => Promise.resolve(),
    }),
    writer: createSafeWriter({ redact: strong, rootDir: root }),
    now: () => new Date(Date.UTC(2026, 10, 20, 14, 31, (ticks += 1))),
    nowMs: () => (ms += 250),
    print: (text) => printed.push(text),
    ...overrides,
  };
  return { root, printed, deps };
}

function rawFile(root: string): string {
  return readFileSync(join(root, FILE), "utf8");
}

describe("parseEvalArgs: adversarial input", () => {
  const rejected: string[][] = [
    ["--runs", "0"],
    ["--runs", "11"],
    ["--runs", "1.5"],
    ["--runs", "abc"],
    ["--runs", ""],
    ["--runs", "1e1"],
    ["--runs", "0x2"],
    ["--runs", " 3"],
    ["--runs", "3 "],
    ["--runs", "-1"],
    ["--runs", "+3"],
    ["--runs", "1_0"],
    ["--runs", "٣"],
    ["--runs", "Infinity"],
    ["--runs", "NaN"],
    ["--runs", "99999999999999999999"],
    ["--runs", "3\n"],
    ["--runs"],
    ["--runs", "--case"],
    ["--case", "ct03"],
    ["--case", "CT3"],
    ["--case", "CT003"],
    ["--case", "CT03\n"],
    ["--case", "CT03 "],
    ["--case", "CT０３"],
    ["--case", ""],
    ["--case"],
    ["--case", "CT03", "--case", "CT04"],
    ["--runs", "3", "--runs", "3"],
    ["--runs=3", "--runs=3"],
    ["--", "--runs", "2"],
    ["extra"],
    ["-r", "3"],
    ["--help=x"],
  ];
  it.each(rejected)("rejects %j without throwing", (...argv) => {
    expect(parseEvalArgs(argv).kind).toBe("error");
  });

  it("accepts the documented forms", () => {
    expect(parseEvalArgs([])).toEqual({ kind: "run", options: { runs: 3 } });
    expect(parseEvalArgs(["--runs=3"])).toEqual({
      kind: "run",
      options: { runs: 3 },
    });
    expect(parseEvalArgs(["--runs", "10", "--case", "CT12"])).toEqual({
      kind: "run",
      options: { runs: 10, caseId: "CT12" },
    });
    expect(parseEvalArgs(["--runs", "1"])).toEqual({
      kind: "run",
      options: { runs: 1 },
    });
  });

  it.each([
    ["--api-key", "SEGREDO-XYZ"],
    ["--api-key=SEGREDO-XYZ"],
    ["SEGREDO-XYZ"],
    ["--runs", "SEGREDO-XYZ"],
    ["--runs=SEGREDO-XYZ"],
    ["--case", "SEGREDO-XYZ"],
    ["--case=SEGREDO-XYZ"],
    ["--SEGREDO-XYZ"],
    ["--help=SEGREDO-XYZ"],
    ["--runs", "3", "--api-key", "SEGREDO-XYZ"],
    ["-k", "SEGREDO-XYZ"],
    ["--", "SEGREDO-XYZ"],
  ])("never echoes the value in %j", (...argv) => {
    const shown = JSON.stringify(parseEvalArgs(argv)).toLowerCase();
    expect(shown).not.toContain("segredo-xyz");
  });
});

describe("planExecutions: edges", () => {
  it("plans nothing for no case and keeps the order of the cases", () => {
    expect(planExecutions([], 5)).toEqual([]);
    const cases = [makeCase("CT05"), makeCase("CT01")];
    expect(
      planExecutions(cases, 2).map((p) => `${p.caso.id}#${p.execucao}`),
    ).toEqual(["CT05#1", "CT01#1", "CT05#2", "CT01#2"]);
  });
});

describe("battery folder name", () => {
  it("never has a colon and survives sub-second and odd clocks", () => {
    expect(batteryIdFrom(new Date("2026-01-02T03:04:05.999Z"))).toBe(
      "2026-01-02T03-04-05Z",
    );
    expect(batteryIdFrom(new Date(0))).toBe("1970-01-01T00-00-00Z");
    expect(() => batteryIdFrom(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("walks the suffixes and gives up after a thousand", () => {
    const taken = new Set([ID, `${ID}-2`, `${ID}-3`]);
    expect(
      uniqueBatteryId(new Date("2026-11-20T14:30:00Z"), (id) => taken.has(id)),
    ).toBe(`${ID}-4`);
    expect(() =>
      uniqueBatteryId(new Date("2026-11-20T14:30:00Z"), () => true),
    ).toThrow();
  });
});

describe("hasEmoji and containsTerm: adversarial Unicode", () => {
  it.each([
    "\u{FE0F}",
    "1\u{FE0F}\u{20E3}",
    "#\u{FE0F}\u{20E3}",
    "\u{1F1E7}\u{1F1F7}",
    "\u{1F44D}\u{1F3FD}",
    "\u{1F468}‍\u{1F469}‍\u{1F467}",
    "texto \u{1F600} texto",
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}",
    "©\u{FE0F}",
    "❤",
    "✅",
  ])("detects an emoji in %j", (text) => {
    expect(hasEmoji(text)).toBe(true);
  });

  it.each([
    "",
    "Olá, tudo bem? (1) #2 *negrito* 3.",
    "© ® ™",
    "‍",
    "x‍y",
    "\u{E0067}",
    "a → b ← c — d • e",
    "R$ 10,00 € £",
  ])("does not flag plain text %j", (text) => {
    expect(hasEmoji(text)).toBe(false);
  });

  it("matches folded forms in both directions", () => {
    expect(containsTerm("ﬁnal", "FINAL")).toBe(true);
    expect(containsTerm("final", "ﬁnal")).toBe(true);
    expect(containsTerm("STRASSE", "Straße")).toBe(true);
    expect(containsTerm("Straße", "STRASSE")).toBe(true);
    expect(containsTerm("Car​la Mendes", "carla mendes")).toBe(true);
    expect(containsTerm("CARLA  MENDES", "carla mendes")).toBe(true);
    expect(containsTerm("José", "JOSE")).toBe(true);
    expect(containsTerm("José", "José")).toBe(true);
  });

  it("does not trim: a term with a trailing space needs the space", () => {
    expect(containsTerm("undef", "def ")).toBe(false);
    expect(containsTerm("a def b", "def ")).toBe(true);
    expect(containsTerm("def", "def ")).toBe(false);
  });

  it("handles empty text and long text without throwing", () => {
    expect(containsTerm("", "abc")).toBe(false);
    expect(containsTerm("x".repeat(2_000_000), "abc")).toBe(false);
    expect(hasEmoji("x".repeat(2_000_000))).toBe(false);
  });
});

describe("buildVerdict: every combination", () => {
  const caso = makeCase("CT01", {
    criterios: {
      deveConter: [["alfa"], ["beta", "gama"]],
      naoDeveConter: ["proibido"],
      rubrica: "r",
    },
  });
  const good = "alfa e gama";
  const bad = "so alfa proibido";
  const origins = ["rascunho", "revisao", "fallback"] as const;

  for (const origin of origins) {
    for (const evaluationFailed of [false, true]) {
      for (const text of [good, bad, ""]) {
        it(`origin=${origin} evalFailed=${evaluationFailed} text=${JSON.stringify(text)}`, () => {
          const judged = {
            situacao: "ok",
            passou: true,
            justificativa: "ok",
            modelo: "modelo-juiz",
            novasTentativas: 0,
          } as const;
          const verdict = buildVerdict(
            caso,
            { kind: "answered", text, origin, evaluationFailed },
            judged,
          );
          if (evaluationFailed) {
            expect(verdict.resultado).toBe("erro");
            expect(verdict.motivo).toBe(EVALUATION_UNAVAILABLE);
            expect(verdict.checagens).toEqual([]);
          } else if (origin === "fallback") {
            expect(verdict.resultado).toBe("falhou");
            expect(verdict.motivo).toBe(FALLBACK_REASON);
            expect(verdict.checagens.find((c) => c.tipo === "origem")?.ok).toBe(
              false,
            );
          } else if (text === good) {
            expect(verdict.resultado).toBe("passou");
            expect(verdict.checagens.every((c) => c.ok)).toBe(true);
          } else {
            expect(verdict.resultado).toBe("falhou");
          }
          // The judge is only recorded when it was needed.
          expect(verdict.juiz).toEqual(
            evaluationFailed || origin === "fallback" ? null : judged,
          );
        });
      }
    }
  }

  it("an infrastructure error carries no checks", () => {
    expect(buildVerdict(caso, { kind: "error", motivo: "x" })).toEqual({
      resultado: "erro",
      motivo: "x",
      checagens: [],
      juiz: null,
    });
  });

  it("a case with no criteria still checks emoji and origin", () => {
    const verdict = buildVerdict(makeCase("CT09"), {
      kind: "answered",
      text: "oi \u{1F600}",
      origin: "rascunho",
      evaluationFailed: false,
    });
    expect(verdict.resultado).toBe("falhou");
    expect(verdict.checagens.map((c) => c.tipo)).toEqual([
      "semEmoji",
      "origem",
    ]);
  });
});

describe("runBattery: cancellation and leaks", () => {
  it("drops an execution cut in the middle of a stream", async () => {
    const controller = new AbortController();
    const fake = createFakeLlmClient([
      {
        text: "meio",
        wait: () => {
          queueMicrotask(() => controller.abort());
          return new Promise(() => undefined);
        },
      },
    ]);
    const ready = setup(fake, [makeCase("CT01")], {
      signal: controller.signal,
    });

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(true);
    expect(result.lines).toEqual([]);
    expect(existsSync(join(ready.root, "outputs"))).toBe(false);
    expect(exitCodeFor(result)).toBe(130);
  });

  it("drops an execution cut while waiting for the local limit", async () => {
    const controller = new AbortController();
    let time = 0;
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: 1,
      now: () => time,
      sleep: (ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          queueMicrotask(() => controller.abort());
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
          time += ms;
        }),
    });
    const fake = createFakeLlmClient([...approved("um"), ...approved("dois")]);
    const ready = setup(
      fake,
      [makeCase("CT01")],
      { limiter, signal: controller.signal },
      2,
    );

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(true);
    expect(exitCodeFor(result)).toBe(130);
    if (existsSync(join(ready.root, FILE))) {
      for (const line of rawFile(ready.root).split("\n").filter(Boolean)) {
        expect(() => execucaoSchema.parse(JSON.parse(line))).not.toThrow();
      }
    }
  });

  it("does not write a multi-turn case cut in its second turn", async () => {
    const controller = new AbortController();
    const fake = createFakeLlmClient([
      ...approved("um"),
      { text: "dois", wait: () => controller.abort() },
    ]);
    const caso = makeCase("CT03", { turnos: ["a?", "b?"] });
    const ready = setup(fake, [caso], { signal: controller.signal });

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(true);
    expect(result.lines).toEqual([]);
    expect(existsSync(join(ready.root, "outputs"))).toBe(false);
  });

  it("keeps the key out and the record on one line with CR, LF and U+2028", async () => {
    const nasty = `linha1\nlinha2\r\nx y z ${KEY} ${KEY.slice(0, 10)}`;
    const fake = createFakeLlmClient([
      { text: nasty },
      rejectedStep("P2", `motivo ${KEY}\nquebra`),
      { text: `rev ${KEY} ` },
      approvedStep(),
    ]);
    const caso = makeCase("CT01", { turnos: [`pergunta ${KEY}`] });
    const ready = setup(fake, [caso]);

    await runBattery(ready.deps);
    const content = rawFile(ready.root);

    expect(content).not.toContain(KEY);
    expect(content.split("\n").filter(Boolean)).toHaveLength(1);
    expect(content.endsWith("\n")).toBe(true);
    const parsed = execucaoSchema.parse(JSON.parse(content.trim()));
    expect(parsed.turnos[0]?.situacao).toBe("respondido");
    expect(ready.printed.join("")).not.toContain(KEY);
  });

  it("keeps a key carried by an error of the provider out of the line", async () => {
    const fake = createFakeLlmClient([
      { error: new LlmResponseError("empty", `falha com ${KEY} no corpo`) },
    ]);
    const ready = setup(fake, [makeCase("CT01")]);

    const result = await runBattery(ready.deps);

    expect(result.counts.erro).toBe(1);
    expect(rawFile(ready.root)).not.toContain(KEY);
    expect(ready.printed.join("")).not.toContain(KEY);
  });

  it("counts the new tries of draft, evaluation and revision of one turn together", async () => {
    const fake = createFakeLlmClient([
      { text: "rascunho" },
      rejectedStep("P2"),
      { text: "revisao" },
      approvedStep(),
    ]);
    const event = {
      retry: 1,
      maxRetries: 3,
      delayMs: 1,
      cause: { kind: "transient", reason: "connection" },
    } as const;
    const retrying: LlmClient = {
      streamText: (request) => {
        request.onRetry?.(event);
        return fake.streamText(request);
      },
      generateStructured: (request) => {
        request.onRetry?.(event);
        return fake.generateStructured(request);
      },
    };
    const ready = setup(retrying, [makeCase("CT01")]);

    await runBattery(ready.deps);
    const parsed = execucaoSchema.parse(JSON.parse(rawFile(ready.root).trim()));

    expect(parsed.turnos[0]?.novasTentativas).toBe(4);
  });
});

describe("runBattery: multi-turn verdict", () => {
  it("judges only the last turn: a bad first answer does not fail the case", async () => {
    const caso = makeCase("CT03", {
      turnos: ["a?", "b?"],
      criterios: {
        deveConter: [["segunda"]],
        naoDeveConter: ["proibido"],
        rubrica: "r",
      },
    });
    const fake = createFakeLlmClient([
      ...approved("primeira proibido"),
      ...approved("a segunda ok"),
    ]);
    const ready = setup(fake, [caso]);

    const result = await runBattery(ready.deps);

    expect(result.counts).toEqual({ passou: 1, falhou: 0, erro: 0 });
  });
});

describe("runEvalCli: the evidence cannot be written", () => {
  const CASES = JSON.stringify([
    {
      id: "CT01",
      titulo: "Primeiro",
      categoria: "caminho-feliz",
      regras: ["P3"],
      perfil: "dora-teixeira",
      turnos: ["Pergunta?"],
      comportamentoEsperado: "Algo.",
      criterios: { deveConter: [], naoDeveConter: [], rubrica: "r" },
    },
  ]);

  function cliDeps(root: string, overrides: Partial<EvalCliDeps> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: EvalCliDeps = {
      argv: ["--runs", "1"],
      readCases: () => CASES,
      contextDir: FIXTURE_CONTEXT,
      rootDir: root,
      loadConfig: () =>
        parseConfig({ OPENAI_API_KEY: KEY, RETRY_MAX_ATTEMPTS: "1" }),
      createClient: () => createFakeLlmClient(approved("resposta")),
      nowMs: () => 0,
      sleep: () => Promise.resolve(),
      now: () => new Date("2026-11-20T14:30:00Z"),
      folderExists: () => false,
      stdout: { write: (t) => stdout.push(t) },
      stderr: { write: (t) => stderr.push(t) },
      ...overrides,
    };
    return { deps, stdout, stderr };
  }

  it("exits 2 and never prints the key even when the root path holds it", async () => {
    const root = temporaryRoot(`made-up-${KEY}-`);
    writeFileSync(join(root, "outputs"), "not a folder");
    const { deps, stdout, stderr } = cliDeps(root);

    const code = await runEvalCli(deps);

    expect(code).toBe(2);
    expect(stderr.join("")).not.toContain(KEY);
    expect(stdout.join("")).not.toContain(KEY);
    expect(stderr.join("")).not.toContain("\n\n");
  });

  it("redacts the key from an unexpected error and exits 2 without writing", async () => {
    const root = temporaryRoot();
    const { deps, stderr } = cliDeps(root, {
      createClient: () => {
        throw new Error(`boom ${KEY}\nstack`);
      },
      stdout: { write: vi.fn() },
    });

    expect(await runEvalCli(deps)).toBe(2);
    expect(stderr.join("")).not.toContain(KEY);
    expect(existsSync(join(root, "outputs"))).toBe(false);
  });
});
