// End to end: `npm run eval` in a child process. The network is blocked for
// everything (sockets, TLS, DNS, http) and the global `fetch` answers only for
// the URL of the API, from a script, so no call can reach a real server; a
// probe confirms the block before anything here trusts it. The files go to a
// temporary folder: the real outputs/ is checked to stay as it was, no log of a
// chat session is written, and the real ".env" is never read (the configuration is built by
// tests/helpers/eval-probe.ts from a fake key).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_VARIABLE_NAMES } from "../src/config/env.js";
import { execucaoSchema, type ExecutionLine } from "../evals/record.js";
import { FAKE_FETCH_BLOCK_MESSAGE } from "./helpers/fake-fetch-constants.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const helper = (name: string): string =>
  pathToFileURL(fileURLToPath(new URL(`./helpers/${name}`, import.meta.url)))
    .href;
const BLOCKING_PRELOAD = helper("preload-fake-fetch.ts");
const SCRIPT_PRELOAD = helper("preload-qa-script.ts");
const PROBE_SCRIPT = "tests/helpers/eval-probe.ts";
const CHILD_TIMEOUT_MS = 60_000;
const BLANK_VARIABLES = Object.fromEntries(
  ENV_VARIABLE_NAMES.map((name) => [name, ""]),
);
const KEY = fakeOpenAiKey();

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "made-up-eval-e2e-"));
  roots.push(root);
  return root;
}

type Step =
  | { kind: "draft"; chunks: string[] }
  | { kind: "verdict"; value: unknown }
  | { kind: "status"; status: number };

const APPROVED: Step = {
  kind: "verdict",
  value: { aprovada: true, violacoes: [] },
};
function answer(text: string): Step[] {
  return [{ kind: "draft", chunks: [text] }, APPROVED];
}

interface Run {
  readonly root: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The bodies of the requests that reached the fake API. */
  readonly requests: number;
  readonly elapsedMs: number;
}

function runProbe(
  args: string[],
  script: Step[],
  probeEnv: Record<string, string> = {},
): Run {
  const root = temporaryRoot();
  const record = join(root, "requests.jsonl");
  writeFileSync(record, "");
  const started = performance.now();
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      BLOCKING_PRELOAD,
      "--import",
      SCRIPT_PRELOAD,
      PROBE_SCRIPT,
      root,
      ...args,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        ...BLANK_VARIABLES,
        QA_FETCH_SCRIPT: JSON.stringify(script),
        QA_FETCH_RECORD: record,
        EVAL_PROBE_ENV: JSON.stringify({
          OPENAI_API_KEY: KEY,
          RETRY_BASE_DELAY_MS: "1",
          RETRY_MAX_ATTEMPTS: "1",
          ...probeEnv,
        }),
      },
    },
  );
  return {
    root,
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    requests: readFileSync(record, "utf8").split("\n").filter(Boolean).length,
    elapsedMs: performance.now() - started,
  };
}

function linesOf(run: Run): ExecutionLine[] {
  const folders = readdirSync(join(run.root, "outputs"));
  expect(folders).toHaveLength(1);
  const file = join(run.root, "outputs", folders[0] ?? "", "execucoes.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => execucaoSchema.parse(JSON.parse(line)));
}

// Each blocked function is recognised by its name first, and only then
// called: a function that is not the block is never called.
const BLOCK_PROBE = `
const fns = {
  netConnect: require("node:net").connect,
  socketConnect: require("node:net").Socket.prototype.connect,
  tlsConnect: require("node:tls").connect,
  dnsLookup: require("node:dns").lookup,
  dnsPromisesLookup: require("node:dns").promises.lookup,
  httpGet: require("node:http").get,
  httpsRequest: require("node:https").request,
};
const out = {};
for (const [name, fn] of Object.entries(fns)) {
  if (fn.name !== "blocked") { out[name] = "NOT-REPLACED"; continue; }
  try { fn(); out[name] = "OPEN"; } catch (e) { out[name] = e.message; }
}
fetch("http://127.0.0.1:9/").then(
  () => { out.fetchOtherUrl = "OPEN"; },
  (e) => { out.fetchOtherUrl = e.message; },
).then(() => console.log(JSON.stringify(out)));
`;

function confirmBlock(): void {
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      BLOCKING_PRELOAD,
      "--import",
      SCRIPT_PRELOAD,
      "-e",
      BLOCK_PROBE,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        ...BLANK_VARIABLES,
        QA_FETCH_SCRIPT: "[]",
        QA_FETCH_RECORD: join(tmpdir(), "made-up-eval-e2e-probe.jsonl"),
      },
    },
  );
  const result = JSON.parse(probe.stdout.trim()) as Record<string, string>;
  expect(Object.keys(result)).toHaveLength(8);
  for (const [name, outcome] of Object.entries(result)) {
    expect([name, outcome]).toEqual([name, FAKE_FETCH_BLOCK_MESSAGE]);
  }
}

function listing(folder: string): string[] {
  const path = join(PROJECT_ROOT, folder);
  return existsSync(path)
    ? readdirSync(path, { recursive: true, encoding: "utf8" }).sort()
    : [];
}

let outputsBefore: string[];
const everyOutput: string[] = [];

beforeAll(() => {
  confirmBlock();
  outputsBefore = listing("outputs");
});

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("npm run eval in a child process, over a fake API", () => {
  it("passes with exit code 0: --case and --runs, and one line per execution", () => {
    const run = runProbe(
      ["--case", "CT06", "--runs", "2"],
      [...answer(`Uma resposta curta. ${KEY}`), ...answer("Outra resposta.")],
    );
    everyOutput.push(run.stdout, run.stderr);
    expect(existsSync(join(run.root, "logs"))).toBe(false);

    expect(run.status).toBe(0);
    expect(run.requests).toBe(4);
    const lines = linesOf(run);
    expect(lines.map((line) => `${line.casoId}/${line.execucao}`)).toEqual([
      "CT06/1",
      "CT06/2",
    ]);
    expect(lines.map((line) => line.veredito.resultado)).toEqual([
      "passou",
      "passou",
    ]);
    expect(lines[0]?.dataHora.startsWith("1970")).toBe(false);
    expect(run.stdout).toContain("[1/2] CT06 execução 1/2 ...");
    expect(run.stdout).toContain("... passou | origem rascunho |");
    expect(run.stdout).toContain(
      "Resumo: 2 de 2 execuções gravadas | passou 2 | falhou 0 | erro 0",
    );
    const file = readFileSync(
      join(
        run.root,
        "outputs",
        readdirSync(join(run.root, "outputs"))[0] ?? "",
        "execucoes.jsonl",
      ),
      "utf8",
    );
    expect(file).not.toContain(KEY);
    expect(file).toContain("[REDACTED]");
  });

  it("exits with 1 when an execution fails", () => {
    const run = runProbe(
      ["--case", "CT01", "--runs", "1"],
      answer("Uma resposta sem nenhum dos termos esperados."),
    );
    everyOutput.push(run.stdout, run.stderr);
    expect(existsSync(join(run.root, "logs"))).toBe(false);

    expect(run.status).toBe(1);
    const [line] = linesOf(run);
    expect(line?.veredito.resultado).toBe("falhou");
    expect(run.stdout).toContain("... falhou | origem rascunho |");
  });

  it("records a 5xx that outlasts the retry as an error and goes on", () => {
    const run = runProbe(
      ["--case", "CT06", "--runs", "2"],
      [
        { kind: "status", status: 500 },
        { kind: "status", status: 500 },
        ...answer("Resposta da segunda execução."),
      ],
    );
    everyOutput.push(run.stdout, run.stderr);
    expect(existsSync(join(run.root, "logs"))).toBe(false);

    expect(run.status).toBe(1);
    const lines = linesOf(run);
    expect(lines.map((line) => line.veredito.resultado)).toEqual([
      "erro",
      "passou",
    ]);
    expect(lines[0]?.turnos[0]).toMatchObject({
      situacao: "erro",
      novasTentativas: 1,
      erro: { status: 500 },
    });
  });

  it("waits for the local limit and still finishes", () => {
    const run = runProbe(
      ["--case", "CT06", "--runs", "2"],
      [...answer("Primeira."), ...answer("Segunda.")],
      { RATE_LIMIT_MAX_REQUESTS: "1", RATE_LIMIT_WINDOW_SECONDS: "1" },
    );
    everyOutput.push(run.stdout, run.stderr);
    expect(existsSync(join(run.root, "logs"))).toBe(false);

    expect(run.status).toBe(0);
    expect(linesOf(run)).toHaveLength(2);
    expect(run.stdout).toContain("aguardando 1 s (limite local)");
    expect(run.elapsedMs).toBeGreaterThan(900);
  });

  it("exits with 2, listing the valid ids, and makes no call for an unknown case", () => {
    const run = runProbe(["--case", "CT99"], []);
    everyOutput.push(run.stdout, run.stderr);
    expect(existsSync(join(run.root, "logs"))).toBe(false);

    expect(run.status).toBe(2);
    expect(run.requests).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Casos válidos: CT01, CT02,");
    expect(run.stderr).toContain("CT12.");
    expect(existsSync(join(run.root, "outputs"))).toBe(false);
  });

  it("leaves the real outputs/ as it was, and never shows the key", () => {
    expect(listing("outputs")).toEqual(outputsBefore);

    expect(everyOutput.length).toBeGreaterThan(0);
    for (const text of everyOutput) {
      expect(text).not.toContain(KEY);
    }
  });
});

describe("scripts/eval.ts itself, only for what writes nothing", () => {
  function runScript(args: string[], variables: Record<string, string> = {}) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/eval.ts", ...args],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        // Every variable blank: an empty one is "not defined", and it keeps a
        // local ".env" from filling it in.
        env: { ...process.env, ...BLANK_VARIABLES, ...variables },
      },
    );
  }

  it("prints the help and exits with 0", () => {
    const result = runScript(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Uso: npm run eval");
    expect(result.stderr).toBe("");
  });

  it("refuses an invalid argument with exit code 2, without echoing a key", () => {
    const result = runScript(["--api-key", KEY]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("opção desconhecida: --api-key");
    expect(result.stderr).toContain("Use --help");
    expect(result.stderr).not.toContain(KEY);
  });

  it("exits with 2 and guidance when there is no key, before any call", () => {
    const result = runScript(["--case", "CT06"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENAI_API_KEY não está definida");
    expect(result.stderr).toContain('Copie o arquivo ".env.example"');
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(listing("outputs")).toEqual(outputsBefore);
  });

  it("exits with 2 for an unknown case, before the key is read", () => {
    const result = runScript(["--case", "CT99"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Casos válidos: CT01, CT02,");
    expect(result.stderr).not.toContain("OPENAI_API_KEY");
  });
});
