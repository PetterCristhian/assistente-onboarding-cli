// runEvalCli in the same process, with everything injected: the arguments, the
// cases, the configuration, the client and the clocks. The disk is the real
// one only inside a temporary folder; the real outputs/ is never touched.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, parseConfig } from "../src/config/env.js";
import { runEvalCli, type EvalCliDeps } from "../evals/cli.js";
import { hashContextFiles, hashText } from "../evals/context-hash.js";
import { readContextTree } from "../src/context/loaders.js";
import { execucaoSchema, type ExecutionLine } from "../evals/record.js";
import { approvedStep } from "./helpers/critique-fixtures.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeLlmClient,
  type FakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const KEY = fakeOpenAiKey();
const FIXTURE_CONTEXT = join(
  import.meta.dirname,
  "fixtures",
  "minimal-context",
);
const NOW = new Date("2026-11-20T14:30:00.412Z");
const FOLDER = "2026-11-20T14-30-00Z";

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

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "made-up-eval-cli-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The answer of the judge that follows the self-evaluation of a turn. */
function judged(passou = true): FakeLlmStep {
  return { value: { justificativa: "decisão do juiz", passou } };
}

/** A draft, its approval and the judge: what one execution of one turn takes. */
function turn(text: string, passou = true): FakeLlmStep[] {
  return [{ text }, approvedStep(), judged(passou)];
}

interface Harness {
  readonly root: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly loadConfig: ReturnType<typeof vi.fn>;
  readonly createClient: ReturnType<typeof vi.fn>;
  readonly fake: FakeLlmClient;
  readonly deps: EvalCliDeps;
}

function harness(
  argv: string[],
  script: readonly FakeLlmStep[] = [],
  overrides: Partial<EvalCliDeps> = {},
  env: Record<string, string> = {},
): Harness {
  const root = temporaryRoot();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fake = createFakeLlmClient(script);
  const loadConfig = vi.fn(() =>
    parseConfig({
      OPENAI_API_KEY: KEY,
      RETRY_BASE_DELAY_MS: "1",
      RETRY_MAX_ATTEMPTS: "1",
      ...env,
    }),
  );
  const createClient = vi.fn(() => fake);
  let ms = 0;
  const deps: EvalCliDeps = {
    argv,
    readCases: () => CASES,
    contextDir: FIXTURE_CONTEXT,
    rootDir: root,
    loadConfig,
    createClient,
    nowMs: () => (ms += 100),
    sleep: () => Promise.resolve(),
    now: () => NOW,
    folderExists: (id) => existsSync(join(root, "outputs", id)),
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
    ...overrides,
  };
  return { root, stdout, stderr, loadConfig, createClient, fake, deps };
}

function linesOf(root: string, folder = FOLDER): ExecutionLine[] {
  return readFileSync(join(root, "outputs", folder, "execucoes.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => execucaoSchema.parse(JSON.parse(line)));
}

describe("runEvalCli: before anything is called", () => {
  it("lists the valid ids when the case does not exist, and calls nothing", async () => {
    const h = harness(["--case", "CT09"]);

    const code = await runEvalCli(h.deps);

    expect(code).toBe(2);
    const stderr = h.stderr.join("");
    expect(stderr).toContain("Casos válidos: CT01, CT02.");
    expect(stderr).not.toContain("CT09");
    expect(h.loadConfig).not.toHaveBeenCalled();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.fake.calls).toHaveLength(0);
    expect(existsSync(join(h.root, "outputs"))).toBe(false);
  });

  it("refuses an invalid argument without reading anything", async () => {
    const readCases = vi.fn(() => CASES);
    const h = harness(["--runs", "0"], [], { readCases });

    const code = await runEvalCli(h.deps);

    expect(code).toBe(2);
    expect(h.stderr.join("")).toContain("--runs deve ser um número inteiro");
    expect(h.stderr.join("")).toContain("Use --help");
    expect(readCases).not.toHaveBeenCalled();
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it("does not echo a key given as an argument", async () => {
    const h = harness(["--api-key", KEY]);

    const code = await runEvalCli(h.deps);

    expect(code).toBe(2);
    expect(h.stderr.join("")).not.toContain(KEY);
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it("prints the help to stdout and exits with 0", async () => {
    const h = harness(["--help"]);

    expect(await runEvalCli(h.deps)).toBe(0);
    expect(h.stdout.join("")).toContain("Uso: npm run eval");
    expect(h.stderr).toEqual([]);
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it("stops on a case file that is not valid", async () => {
    const h = harness([], [], { readCases: () => "{ não é json" });

    expect(await runEvalCli(h.deps)).toBe(2);
    expect(h.stderr.join("")).toContain("não é um JSON válido");
    expect(h.loadConfig).not.toHaveBeenCalled();
  });

  it("reports a missing profile with the case, before the configuration", async () => {
    const missing = JSON.parse(CASES) as { perfil: string }[];
    const [first] = missing;
    if (first) first.perfil = "nao-existe";
    const h = harness([], [], { readCases: () => JSON.stringify(missing) });

    expect(await runEvalCli(h.deps)).toBe(2);
    expect(h.stderr.join("")).toMatch(/^contexto: CT01: Perfil "nao-existe"/);
    expect(h.loadConfig).not.toHaveBeenCalled();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.fake.calls).toHaveLength(0);
  });

  it("only loads the profiles of the selected case", async () => {
    const missing = JSON.parse(CASES) as { perfil: string }[];
    const [first] = missing;
    if (first) first.perfil = "nao-existe";
    const h = harness(["--case", "CT02", "--runs", "1"], turn("beta"), {
      readCases: () => JSON.stringify(missing),
    });

    expect(await runEvalCli(h.deps)).toBe(0);
  });

  it("reads the configuration only after the context is good, and stops on its error", async () => {
    const h = harness([]);
    h.loadConfig.mockImplementation(() => {
      throw new ConfigError("OPENAI_API_KEY não está definida.");
    });

    const code = await runEvalCli(h.deps);

    expect(code).toBe(2);
    expect(h.loadConfig).toHaveBeenCalledTimes(1);
    expect(h.stderr.join("")).toBe("OPENAI_API_KEY não está definida.\n");
    expect(h.createClient).not.toHaveBeenCalled();
    expect(existsSync(join(h.root, "outputs"))).toBe(false);
  });
});

describe("runEvalCli: running", () => {
  it("runs the selected case alone, with --case", async () => {
    const h = harness(["--case", "CT02", "--runs", "1"], turn("tem beta aqui"));

    const code = await runEvalCli(h.deps);

    expect(code).toBe(0);
    const lines = linesOf(h.root);
    expect(lines.map((line) => line.casoId)).toEqual(["CT02"]);
    // The draft, the self-evaluation and the judge.
    expect(h.fake.calls).toHaveLength(3);
    expect(h.stdout.join("")).toContain("[1/1] CT02 execução 1/1 ...");
  });

  it("makes 3 executions of each case by default and --runs changes it", async () => {
    const script = Array.from({ length: 6 }, () => turn("alfa beta")).flat();
    const h = harness([], script);

    await runEvalCli(h.deps);

    expect(linesOf(h.root)).toHaveLength(6);
    const two = harness(["--runs", "2"], script);
    await runEvalCli(two.deps);
    expect(linesOf(two.root)).toHaveLength(4);
  });

  it("exits with 0 when everything passes and 1 when something fails", async () => {
    const passing = harness(
      ["--runs", "1"],
      [...turn("alfa"), ...turn("beta")],
    );
    const failing = harness(
      ["--runs", "1"],
      [...turn("alfa"), ...turn("nada")],
    );

    expect(await runEvalCli(passing.deps)).toBe(0);
    expect(await runEvalCli(failing.deps)).toBe(1);
    expect(linesOf(failing.root).map((l) => l.veredito.resultado)).toEqual([
      "passou",
      "falhou",
    ]);
  });

  it("exits with 1 for an error of infrastructure, and goes on", async () => {
    const h = harness(
      ["--runs", "1"],
      [
        { error: Object.assign(new Error("fora"), { status: 500 }) },
        ...turn("beta"),
      ],
    );

    expect(await runEvalCli(h.deps)).toBe(1);
    expect(linesOf(h.root).map((l) => l.veredito.resultado)).toEqual([
      "erro",
      "passou",
    ]);
  });

  it("names the folder after the start time, and never reuses one", async () => {
    const h = harness(["--runs", "1", "--case", "CT01"], turn("alfa"));
    mkdirSync(join(h.root, "outputs", FOLDER), { recursive: true });

    await runEvalCli(h.deps);

    expect(existsSync(join(h.root, "outputs", FOLDER, "execucoes.jsonl"))).toBe(
      false,
    );
    expect(linesOf(h.root, `${FOLDER}-2`)).toHaveLength(1);
    expect(linesOf(h.root, `${FOLDER}-2`)[0]?.bateria).toBe(`${FOLDER}-2`);
  });

  it("waits for the local limit of the configuration instead of failing", async () => {
    let ms = 0;
    const sleeps: number[] = [];
    const h = harness(
      ["--runs", "3", "--case", "CT01"],
      [...turn("alfa"), ...turn("alfa"), ...turn("alfa")],
      {
        nowMs: () => ms,
        sleep: (wait) => {
          sleeps.push(wait);
          ms += wait;
          return Promise.resolve();
        },
      },
      { RATE_LIMIT_MAX_REQUESTS: "1", RATE_LIMIT_WINDOW_SECONDS: "2" },
    );

    expect(await runEvalCli(h.deps)).toBe(0);
    // The question and the judge of each execution take a slot each.
    expect(sleeps).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(h.stdout.join("")).toContain("aguardando 2 s (limite local)");
  });

  it("exits with 1 when the judge fails an execution whose checks hold", async () => {
    const h = harness(["--runs", "1", "--case", "CT01"], turn("alfa", false));

    expect(await runEvalCli(h.deps)).toBe(1);
    expect(linesOf(h.root)[0]?.veredito).toMatchObject({
      resultado: "falhou",
      juiz: { situacao: "ok", passou: false },
    });
  });

  it("exits with 130 when it is interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([], [], { signal: controller.signal });

    expect(await runEvalCli(h.deps)).toBe(130);
    expect(h.fake.calls).toHaveLength(0);
    expect(existsSync(join(h.root, "outputs"))).toBe(false);
  });
});

describe("runEvalCli: the judge and the fingerprints", () => {
  it("uses one client for the chatbot and the judge, and the model of EVAL_JUDGE_MODEL for the judge", async () => {
    const h = harness(
      ["--runs", "1", "--case", "CT01"],
      turn("alfa"),
      {},
      { OPENAI_MODEL: "modelo-do-chat", EVAL_JUDGE_MODEL: "modelo-do-juiz" },
    );

    expect(await runEvalCli(h.deps)).toBe(0);

    expect(h.createClient).toHaveBeenCalledTimes(1);
    const [draft, evaluation, judge] = h.fake.calls;
    expect(draft?.kind).toBe("streamText");
    expect(evaluation?.request.model).toBeUndefined();
    expect(judge?.kind).toBe("generateStructured");
    expect(judge?.request.model).toBe("modelo-do-juiz");
  });

  it("writes the hashes of context/ and of the cases on every line", async () => {
    const h = harness(
      ["--runs", "2", "--case", "CT01"],
      [...turn("alfa"), ...turn("alfa")],
    );

    await runEvalCli(h.deps);
    const lines = linesOf(h.root);

    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.hashContexto)).size).toBe(1);
    expect(new Set(lines.map((line) => line.hashCasos)).size).toBe(1);
    expect(lines[0]?.hashCasos).toBe(hashText(CASES));
    expect(lines[0]?.hashContexto).toBe(
      hashContextFiles(readContextTree(FIXTURE_CONTEXT)),
    );
  });

  it("changes the hash of the cases when the text of the cases changes", async () => {
    const other = `${CASES}
`;
    const first = harness(["--runs", "1", "--case", "CT01"], turn("alfa"));
    const second = harness(["--runs", "1", "--case", "CT01"], turn("alfa"), {
      readCases: () => other,
    });

    await runEvalCli(first.deps);
    await runEvalCli(second.deps);

    expect(linesOf(first.root)[0]?.hashCasos).not.toBe(
      linesOf(second.root)[0]?.hashCasos,
    );
  });

  it("stops before the configuration when there is no judge prompt", async () => {
    const root = temporaryRoot();
    const noJudge = join(root, "context");
    cpSync(FIXTURE_CONTEXT, noJudge, { recursive: true });
    rmSync(join(noJudge, "juiz.md"));
    const h = harness([], [], { contextDir: noJudge });

    expect(await runEvalCli(h.deps)).toBe(2);
    expect(h.stderr.join("")).toMatch(/^contexto: .*juiz\.md/);
    expect(h.loadConfig).not.toHaveBeenCalled();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe("runEvalCli: what must not leak or crash", () => {
  it("redacts the key from an unexpected error and exits with 2, with no stack", async () => {
    const h = harness([]);
    h.createClient.mockImplementation(() => {
      throw new Error(`falha com ${KEY}\n    at algum lugar`);
    });

    const code = await runEvalCli(h.deps);

    expect(code).toBe(2);
    const stderr = h.stderr.join("");
    expect(stderr).not.toContain(KEY);
    expect(stderr).toMatch(/^erro inesperado: falha com .* at algum lugar\n$/);
  });

  it("stops with a clear message when the evidence cannot be written", async () => {
    const h = harness(["--runs", "1"], [...turn("alfa"), ...turn("beta")]);
    // outputs is a file: the folder of the battery cannot be created.
    writeFileSync(join(h.root, "outputs"), "não é uma pasta");

    const code = await runEvalCli(h.deps);

    expect(code).toBe(2);
    const stderr = h.stderr.join("");
    expect(stderr).toContain(
      `Não foi possível gravar o resultado em outputs/${FOLDER}/execucoes.jsonl`,
    );
    expect(stderr).toContain("A bateria foi interrompida");
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    // Stopped at the first execution: the second never reached the model.
    expect(h.fake.calls).toHaveLength(3);
  });

  it("neutralizes control characters in what it prints", async () => {
    const h = harness([]);
    h.loadConfig.mockImplementation(() => {
      throw new ConfigError("mensagem\u001b[31m com controle");
    });

    await runEvalCli(h.deps);

    expect(h.stderr.join("")).not.toContain("\u001b");
  });
});
