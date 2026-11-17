// The runner of the battery with a scripted LlmClient: no network, no key, no
// real time. The disk is the real one only inside a temporary folder.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRateLimiter,
  type RateLimiter,
} from "../src/chat/rate-limiter.js";
import { ContextError } from "../src/context/types.js";
import type { LlmClient, StreamTextRequest } from "../src/llm/client.js";
import { createRedactor, type Redactor } from "../src/security/redact.js";
import {
  createSafeWriter,
  type SafeWriter,
} from "../src/security/safe-writer.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import type { BatteryContext } from "../evals/contexts.js";
import { loadBatteryContexts } from "../evals/contexts.js";
import { execucaoSchema, type ExecutionLine } from "../evals/record.js";
import {
  exitCodeFor,
  planExecutions,
  runBattery,
  type BatteryDeps,
  type BatteryResult,
} from "../evals/runner.js";
import type { Caso } from "../evals/schema.js";
import { EVALUATION_UNAVAILABLE, FALLBACK_REASON } from "../evals/verdict.js";
import {
  FALLBACK_MESSAGE,
  approvedStep,
  makeCritiqueDeps,
  rejectedStep,
} from "./helpers/critique-fixtures.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeLlmClient,
  type FakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const KEY = fakeOpenAiKey();
const BATTERY_ID = "2026-11-20T14-30-00Z";
const FILE = `outputs/${BATTERY_ID}/execucoes.jsonl`;
const FIXTURE_CONTEXT = join(
  import.meta.dirname,
  "fixtures",
  "minimal-context",
);

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "made-up-eval-runner-"));
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
  instructions: "INSTRUCOES-DO-ASSISTENTE",
  critique: makeCritiqueDeps(),
};

/** A draft that the evaluator approves. */
function approvedTurn(text: string): FakeLlmStep[] {
  return [{ text }, approvedStep()];
}

/** Clocks that move by a fixed step on every read: nothing is the real time. */
function makeClocks() {
  let ticks = 0;
  let milliseconds = 0;
  return {
    now: () => new Date(Date.UTC(2026, 10, 20, 14, 31, (ticks += 1))),
    nowMs: () => (milliseconds += 250),
  };
}

interface Setup {
  readonly root: string;
  readonly printed: string[];
  readonly deps: BatteryDeps;
}

function setup(
  llm: LlmClient,
  cases: readonly Caso[],
  overrides: Partial<BatteryDeps> = {},
  runs = 1,
): Setup {
  const root = temporaryRoot();
  const printed: string[] = [];
  const strong = createRedactor([KEY]);
  const deps: BatteryDeps = {
    cases,
    runs,
    batteryId: BATTERY_ID,
    llm,
    contexts: new Map(
      cases.map((caso): [string, BatteryContext] => [caso.perfil, CONTEXT]),
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
    ...makeClocks(),
    print: (text) => printed.push(text),
    ...overrides,
  };
  return { root, printed, deps };
}

function readLines(root: string): ExecutionLine[] {
  return readFileSync(join(root, FILE), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => execucaoSchema.parse(JSON.parse(line)));
}

function firstOf<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined) {
    throw new Error("expected at least one item");
  }
  return first;
}

describe("planExecutions", () => {
  it("goes by rounds: every case once, then every case again", () => {
    const plan = planExecutions([makeCase("CT01"), makeCase("CT02")], 2);

    expect(plan.map((item) => `${item.caso.id}/${item.execucao}`)).toEqual([
      "CT01/1",
      "CT02/1",
      "CT01/2",
      "CT02/2",
    ]);
  });
});

describe("runBattery: 2 cases x 2 executions", () => {
  async function run() {
    const fake = createFakeLlmClient([
      ...approvedTurn("alfa um"),
      ...approvedTurn("beta um"),
      ...approvedTurn("alfa dois"),
      ...approvedTurn("beta dois"),
    ]);
    const cases = [
      makeCase("CT01", {
        criterios: {
          deveConter: [["alfa"]],
          naoDeveConter: [],
          rubrica: "r",
        },
      }),
      makeCase("CT02", {
        perfil: "egon-pires",
        criterios: {
          deveConter: [["gama"]],
          naoDeveConter: [],
          rubrica: "r",
        },
      }),
    ];
    const ready = setup(fake, cases, {}, 2);
    const result = await runBattery(ready.deps);
    return { fake, ready, result };
  }

  it("writes four lines in order, each valid for the schema", async () => {
    const { ready, result } = await run();
    const lines = readLines(ready.root);

    expect(lines.map((line) => `${line.casoId}/${line.execucao}`)).toEqual([
      "CT01/1",
      "CT02/1",
      "CT01/2",
      "CT02/2",
    ]);
    expect(lines.map((line) => line.veredito.resultado)).toEqual([
      "passou",
      "falhou",
      "passou",
      "falhou",
    ]);
    expect(result.lines).toEqual(lines);
    expect(result.folder).toBe(`outputs/${BATTERY_ID}`);
    expect(result.file).toBe(FILE);
    expect(result.counts).toEqual({ passou: 2, falhou: 2, erro: 0 });
    expect(result.expected).toBe(4);
    expect(result.interrupted).toBe(false);
    expect(exitCodeFor(result)).toBe(1);
    for (const line of lines) {
      expect(line.bateria).toBe(BATTERY_ID);
      expect(line.turnos).toHaveLength(1);
      expect(line.modelo).toBe("fake-model");
    }
    expect(lines.map((line) => line.perfil)).toEqual([
      "dora-teixeira",
      "egon-pires",
      "dora-teixeira",
      "egon-pires",
    ]);
  });

  it("starts every execution with a new session", async () => {
    const { fake } = await run();
    const drafts = fake.calls.filter((call) => call.kind === "streamText");

    expect(drafts).toHaveLength(4);
    for (const draft of drafts) {
      expect(draft.request.input).toHaveLength(1);
      expect(draft.request.instructions).toBe("INSTRUCOES-DO-ASSISTENTE");
    }
  });

  it("records the turn and the self-evaluation of each line", async () => {
    const { ready } = await run();
    const turn = firstOf(firstOf(readLines(ready.root)).turnos);

    expect(turn).toMatchObject({
      situacao: "respondido",
      pergunta: "Pergunta de CT01?",
      rascunho: "alfa um",
      respostaFinal: "alfa um",
      origemFinal: "rascunho",
      autoavaliacao: { situacao: "ok", aprovada: true, violacoes: [] },
      chamadas: 2,
      novasTentativas: 0,
      modelo: "fake-model",
    });
  });

  it("shows the progress: the case, the execution and the result", async () => {
    const { ready } = await run();
    const text = ready.printed.join("");

    expect(text).toContain("[1/4] CT01 execução 1/2 ...\n");
    expect(text).toContain(
      "[1/4] CT01 execução 1/2 ... passou | origem rascunho | ",
    );
    expect(text).toContain(
      "[4/4] CT02 execução 2/2 ... falhou | origem rascunho | ",
    );
    expect(text).toContain(
      "Resumo: 4 de 4 execuções gravadas | passou 2 | falhou 2 | erro 0",
    );
    expect(text).toContain(`Pasta: outputs/${BATTERY_ID}/`);
    expect(text).not.toContain("alfa um");
    expect(ready.printed.every((piece) => piece.endsWith("\n"))).toBe(true);
  });

  it("keeps the folder out of the disk until the first line", async () => {
    const root = temporaryRoot();
    const { deps } = setup(createFakeLlmClient([]), []);

    const result = await runBattery({
      ...deps,
      writer: createSafeWriter({ redact: createRedactor([]), rootDir: root }),
    });

    expect(result.lines).toEqual([]);
    expect(() => readFileSync(join(root, FILE))).toThrow();
  });
});

describe("runBattery: time", () => {
  it("takes the date of each execution and the duration of each turn from the clocks it gets", async () => {
    const fake = createFakeLlmClient([
      ...approvedTurn("um"),
      ...approvedTurn("dois"),
    ]);
    const ready = setup(fake, [makeCase("CT01")], {}, 2);

    await runBattery(ready.deps);
    const lines = readLines(ready.root);

    for (const line of lines) {
      expect(line.dataHora.startsWith("2026-11-20T14:31:")).toBe(true);
      expect(line.dataHora.startsWith("1970")).toBe(false);
    }
    expect(new Set(lines.map((line) => line.dataHora)).size).toBe(2);
    // Two reads of the clock around the turn, 250 ms apart.
    expect(lines.map((line) => firstOf(line.turnos).duracaoMs)).toEqual([
      250, 250,
    ]);
  });
});

describe("runBattery: several turns in one case", () => {
  const caso = makeCase("CT03", {
    categoria: "acompanhamento",
    turnos: ["Primeira?", "Segunda?"],
    criterios: { deveConter: [["final"]], naoDeveConter: [], rubrica: "r" },
  });

  it("sends the questions in order, in the same session, and judges only the last", async () => {
    const fake = createFakeLlmClient([
      ...approvedTurn("resposta um sem o termo"),
      ...approvedTurn("resposta com o termo final"),
    ]);
    const ready = setup(fake, [caso]);

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);
    const drafts = fake.calls.filter((call) => call.kind === "streamText");

    expect(line?.turnos.map((turn) => turn.pergunta)).toEqual([
      "Primeira?",
      "Segunda?",
    ]);
    expect(line?.veredito.resultado).toBe("passou");
    expect(drafts.map((draft) => draft.request.input.length)).toEqual([1, 3]);
    expect(drafts[1]?.request.input[0]).toEqual({
      role: "user",
      content: "Primeira?",
    });
  });

  it("does not send the second question when the first turn fails", async () => {
    const fake = createFakeLlmClient([
      { error: Object.assign(new Error("falha"), { status: 500 }) },
    ]);
    const ready = setup(fake, [caso]);

    const result = await runBattery(ready.deps);
    const [line] = readLines(ready.root);

    expect(fake.calls).toHaveLength(1);
    expect(line?.turnos).toHaveLength(1);
    expect(line?.turnos[0]).toMatchObject({
      situacao: "erro",
      erro: { status: 500 },
    });
    expect(line?.turnos[0]).not.toHaveProperty("respostaFinal");
    expect(line?.veredito).toMatchObject({
      resultado: "erro",
      motivo: "turno 1 de 2 falhou",
      checagens: [],
    });
    expect(result.counts.erro).toBe(1);
  });

  it("is an error when the second turn fails, keeping the first turn", async () => {
    const fake = createFakeLlmClient([
      ...approvedTurn("resposta um"),
      { error: new Error("falha") },
    ]);
    const ready = setup(fake, [caso]);

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);

    expect(line?.turnos.map((turn) => turn.situacao)).toEqual([
      "respondido",
      "erro",
    ]);
    expect(line?.veredito.motivo).toBe("turno 2 de 2 falhou");
    expect(line?.modelo).toBe("fake-model");
  });
});

describe("runBattery: the key never reaches the disk", () => {
  const leaking = makeCase("CT01");
  const withKey = `A chave é ${KEY} e acabou`;

  it("keeps the key out of the draft and of the revision", async () => {
    const fake = createFakeLlmClient([
      { text: withKey },
      rejectedStep("P2", `motivo com ${KEY}`),
      { text: `Revisão com ${KEY}` },
    ]);
    const ready = setup(fake, [leaking]);

    await runBattery(ready.deps);
    const content = readFileSync(join(ready.root, FILE), "utf8");

    expect(content).not.toContain(KEY);
    expect(ready.printed.join("")).not.toContain(KEY);
    expect(content).toContain("[REDACTED]");
  });

  it("is stopped by the writer even when the redactor of the session lets it through", async () => {
    const weak: Redactor = (text) => text;
    const strong = createRedactor([KEY]);
    const root = temporaryRoot();
    const real = createSafeWriter({ redact: strong, rootDir: root });
    const handed: string[] = [];
    const spy: SafeWriter = {
      ...real,
      appendJsonLine: (path, value) => {
        handed.push(JSON.stringify(value));
        return real.appendJsonLine(path, value);
      },
    };
    const fake = createFakeLlmClient(approvedTurn(withKey));
    const ready = setup(fake, [leaking], {
      redact: weak,
      redactStream: () => ({ push: (piece) => piece, flush: () => "" }),
      writer: spy,
    });

    await runBattery(ready.deps);

    // The line did reach the writer with the key; the file did not get it.
    expect(handed.join("")).toContain(KEY);
    expect(readFileSync(join(root, FILE), "utf8")).not.toContain(KEY);
  });
});

describe("runBattery: error, failure and pass are different results", () => {
  it("records a failure of the provider as an error and goes on", async () => {
    const fake = createFakeLlmClient([
      { error: Object.assign(new Error("indisponível"), { status: 503 }) },
      ...approvedTurn("tudo certo"),
    ]);
    const ready = setup(fake, [makeCase("CT01")], {}, 2);

    const result = await runBattery(ready.deps);
    const lines = readLines(ready.root);

    expect(lines.map((line) => line.veredito.resultado)).toEqual([
      "erro",
      "passou",
    ]);
    expect(result.counts).toEqual({ passou: 1, falhou: 0, erro: 1 });
    expect(exitCodeFor(result)).toBe(1);
    expect(ready.printed.join("")).toContain(
      "execução 1/2 ... erro | turno 1 de 1 falhou | ",
    );
  });

  it("is an error when the self-evaluation is unavailable", async () => {
    const fake = createFakeLlmClient([
      { text: "rascunho" },
      { error: new Error("sem avaliação") },
    ]);
    const ready = setup(fake, [makeCase("CT01")]);

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);

    expect(line?.veredito).toMatchObject({
      resultado: "erro",
      motivo: EVALUATION_UNAVAILABLE,
      checagens: [],
    });
    expect(firstOf(line?.turnos ?? [])).toMatchObject({
      origemFinal: "fallback",
      respostaFinal: FALLBACK_MESSAGE,
      autoavaliacao: { situacao: "erro" },
    });
  });

  it("is an error when the evaluation of the revision is unavailable", async () => {
    const fake = createFakeLlmClient([
      { text: "rascunho" },
      rejectedStep(),
      { text: "revisão" },
      { error: new Error("sem avaliação") },
    ]);
    const ready = setup(fake, [makeCase("CT01")]);

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);

    expect(line?.veredito.resultado).toBe("erro");
    expect(line?.veredito.motivo).toBe(EVALUATION_UNAVAILABLE);
  });

  it("fails, with the check of the origin, when the answer is the safe message", async () => {
    const fake = createFakeLlmClient([
      { text: "rascunho" },
      rejectedStep("P1"),
      { text: "revisão" },
      rejectedStep("P1"),
    ]);
    const caso = makeCase("CT01", {
      criterios: {
        deveConter: [["MENSAGEM-SEGURA"]],
        naoDeveConter: [],
        rubrica: "r",
      },
    });
    const ready = setup(fake, [caso]);

    const result = await runBattery(ready.deps);
    const [line] = readLines(ready.root);

    expect(line?.veredito.resultado).toBe("falhou");
    expect(line?.veredito.motivo).toBe(FALLBACK_REASON);
    expect(line?.veredito.checagens).toContainEqual({
      tipo: "origem",
      alvo: ["fallback"],
      ok: false,
    });
    // The content check is still computed (the safe message has the term).
    expect(line?.veredito.checagens).toContainEqual({
      tipo: "deveConter",
      alvo: ["MENSAGEM-SEGURA"],
      ok: true,
    });
    expect(firstOf(line?.turnos ?? [])).toMatchObject({
      origemFinal: "fallback",
      revisao: { texto: "revisão", autoavaliacao: { situacao: "ok" } },
    });
    expect(exitCodeFor(result)).toBe(1);
  });

  it("fails, with a warning, when the revision cannot be written", async () => {
    const fake = createFakeLlmClient([
      { text: "rascunho" },
      rejectedStep(),
      { error: new Error("sem revisão") },
    ]);
    const ready = setup(fake, [makeCase("CT01")]);

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);
    const turn = firstOf(line?.turnos ?? []);

    expect(line?.veredito.resultado).toBe("falhou");
    expect(turn.avisos.map((notice) => notice.texto).join("\n")).toContain(
      "[revisão]",
    );
  });

  it("keeps the retraction among the notices of the turn", async () => {
    const fake = createFakeLlmClient([
      { text: "rascunho" },
      rejectedStep("P2", "usou emoji"),
      { text: "revisão boa" },
      approvedStep(),
    ]);
    const ready = setup(fake, [makeCase("CT01")]);

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);
    const turn = firstOf(line?.turnos ?? []);

    expect(line?.veredito.resultado).toBe("passou");
    expect(turn).toMatchObject({
      origemFinal: "revisao",
      respostaFinal: "revisão boa",
      rascunho: "rascunho",
      chamadas: 4,
    });
    expect(
      turn.avisos.some((notice) => notice.texto.includes("foi retirada")),
    ).toBe(true);
  });

  it("is an error, not a pass, when the limiter refuses in wait mode", async () => {
    const refusing: RateLimiter = {
      maxRequests: 1,
      windowSeconds: 60,
      tryAcquire: () => ({ allowed: false, retryAfterMs: 1000 }),
      acquire: () => Promise.resolve({ allowed: false, retryAfterMs: 1000 }),
    };
    const fake = createFakeLlmClient([]);
    const ready = setup(fake, [makeCase("CT01")], { limiter: refusing });

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);

    expect(fake.calls).toHaveLength(0);
    expect(line?.veredito.resultado).toBe("erro");
  });
});

describe("runBattery: the local limit", () => {
  it("waits for a free slot and finishes every execution", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowSeconds: 1,
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms);
        time += ms;
        return Promise.resolve();
      },
    });
    const fake = createFakeLlmClient([
      ...approvedTurn("um"),
      ...approvedTurn("dois"),
      ...approvedTurn("tres"),
      ...approvedTurn("quatro"),
    ]);
    const ready = setup(
      fake,
      [makeCase("CT01"), makeCase("CT02")],
      { limiter },
      2,
    );

    const result = await runBattery(ready.deps);
    const lines = readLines(ready.root);

    expect(lines).toHaveLength(4);
    expect(result.counts.passou).toBe(4);
    expect(exitCodeFor(result)).toBe(0);
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(ready.printed.join("")).toContain(
      "  aguardando 1 s (limite local)\n",
    );
    expect(
      firstOf(lines.slice(1)).turnos[0]?.avisos.map((notice) => notice.texto),
    ).toContainEqual(expect.stringContaining("Aguardando 1 s"));
  });
});

describe("runBattery: new tries", () => {
  it("counts the new tries of each turn alone", async () => {
    const fake = createFakeLlmClient([
      ...approvedTurn("um"),
      ...approvedTurn("dois"),
    ]);
    const retrying: LlmClient = {
      generateStructured: (request) => fake.generateStructured(request),
      streamText: (request: StreamTextRequest) => {
        // The first draft needs two new tries; the second needs none.
        if (
          fake.calls.filter((call) => call.kind === "streamText").length === 0
        ) {
          for (const retry of [1, 2]) {
            request.onRetry?.({
              retry,
              maxRetries: 3,
              delayMs: 10,
              cause: { kind: "transient", reason: "connection" },
            });
          }
        }
        return fake.streamText(request);
      },
    };
    const caso = makeCase("CT03", {
      categoria: "acompanhamento",
      turnos: ["Primeira?", "Segunda?"],
    });
    const ready = setup(retrying, [caso]);

    await runBattery(ready.deps);
    const [line] = readLines(ready.root);

    expect(line?.turnos.map((turn) => turn.novasTentativas)).toEqual([2, 0]);
    expect(
      firstOf(line?.turnos ?? []).avisos.some((notice) =>
        notice.texto.includes("entativa 1 de 3"),
      ),
    ).toBe(true);
  });
});

describe("runBattery: interruption", () => {
  it("does not write the execution that was cut, and stops", async () => {
    const controller = new AbortController();
    const fake = createFakeLlmClient([
      ...approvedTurn("um"),
      { text: "dois", wait: () => controller.abort() },
    ]);
    const ready = setup(
      fake,
      [makeCase("CT01"), makeCase("CT02")],
      { signal: controller.signal },
      2,
    );

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(readLines(ready.root)).toHaveLength(1);
    expect(exitCodeFor(result)).toBe(130);
    expect(ready.printed.join("")).toContain(
      "Bateria interrompida antes do fim.",
    );
    expect(fake.calls).toHaveLength(3);
  });

  it("makes no call at all when the signal is aborted from the start", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = createFakeLlmClient([]);
    const ready = setup(fake, [makeCase("CT01")], {
      signal: controller.signal,
    });

    const result = await runBattery(ready.deps);

    expect(result.interrupted).toBe(true);
    expect(result.lines).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect(ready.printed.join("")).toContain("Nenhuma execução foi gravada.");
  });
});

describe("runBattery: a failure to write", () => {
  it("stops the battery instead of going on without evidence", async () => {
    const fake = createFakeLlmClient([
      ...approvedTurn("um"),
      ...approvedTurn("dois"),
    ]);
    const failing: SafeWriter = {
      ...createSafeWriter({
        redact: createRedactor([]),
        rootDir: temporaryRoot(),
      }),
      appendJsonLine: () => Promise.reject(new Error("disco cheio")),
    };
    const ready = setup(fake, [makeCase("CT01")], { writer: failing }, 2);

    await expect(runBattery(ready.deps)).rejects.toThrow("disco cheio");
    expect(fake.calls).toHaveLength(2);
  });
});

describe("exitCodeFor", () => {
  function result(overrides: Partial<BatteryResult>): BatteryResult {
    return {
      folder: "outputs/x",
      file: "outputs/x/execucoes.jsonl",
      lines: [],
      expected: 0,
      interrupted: false,
      counts: { passou: 0, falhou: 0, erro: 0 },
      ...overrides,
    };
  }
  const line = {} as ExecutionLine;

  it("is 0 only when every expected execution passed", () => {
    expect(
      exitCodeFor(
        result({
          lines: [line, line],
          expected: 2,
          counts: { passou: 2, falhou: 0, erro: 0 },
        }),
      ),
    ).toBe(0);
  });

  it("is 1 for a failure, for an error and for a battery that ended short", () => {
    expect(
      exitCodeFor(
        result({
          lines: [line],
          expected: 1,
          counts: { passou: 0, falhou: 1, erro: 0 },
        }),
      ),
    ).toBe(1);
    expect(
      exitCodeFor(
        result({
          lines: [line],
          expected: 1,
          counts: { passou: 0, falhou: 0, erro: 1 },
        }),
      ),
    ).toBe(1);
    expect(
      exitCodeFor(
        result({
          lines: [line],
          expected: 2,
          counts: { passou: 1, falhou: 0, erro: 0 },
        }),
      ),
    ).toBe(1);
  });

  it("is 130 when interrupted, even if what ran passed", () => {
    expect(
      exitCodeFor(
        result({
          lines: [line],
          expected: 2,
          interrupted: true,
          counts: { passou: 1, falhou: 0, erro: 0 },
        }),
      ),
    ).toBe(130);
  });
});

describe("loadBatteryContexts", () => {
  const now = () => new Date(2026, 10, 20, 12, 0, 0);

  it("loads one context per profile, with the same frozen date", () => {
    const contexts = loadBatteryContexts({
      cases: [
        makeCase("CT01"),
        makeCase("CT02", { perfil: "egon-pires" }),
        makeCase("CT03"),
      ],
      contextDir: FIXTURE_CONTEXT,
      now,
    });

    expect([...contexts.keys()]).toEqual(["dora-teixeira", "egon-pires"]);
    const dora = contexts.get("dora-teixeira");
    const egon = contexts.get("egon-pires");
    expect(dora?.instructions).toContain("Dora Teixeira");
    expect(egon?.instructions).toContain("Egon Pires");
    expect(dora?.instructions).toContain("2026-11-20");
    expect(dora?.critique.fallbackMessage.length).toBeGreaterThan(0);
    expect(dora?.critique.evaluatorContext).not.toContain(
      dora?.critique.evaluatorPrompt ?? "?",
    );
  });

  it("names the case of a profile that does not exist, before any call", () => {
    const fake: FakeLlmClient = createFakeLlmClient([]);

    expect(() =>
      loadBatteryContexts({
        cases: [makeCase("CT01"), makeCase("CT07", { perfil: "nao-existe" })],
        contextDir: FIXTURE_CONTEXT,
        now,
      }),
    ).toThrow(ContextError);
    expect(() =>
      loadBatteryContexts({
        cases: [makeCase("CT07", { perfil: "nao-existe" })],
        contextDir: FIXTURE_CONTEXT,
        now,
      }),
    ).toThrow(/^CT07: Perfil "nao-existe" não encontrado/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a folder with no safe message", () => {
    expect(() =>
      loadBatteryContexts({
        cases: [makeCase("CT01")],
        contextDir: join(FIXTURE_CONTEXT, "04-empresa"),
        now,
      }),
    ).toThrow(ContextError);
  });
});
