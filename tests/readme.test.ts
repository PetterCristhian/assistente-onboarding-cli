// Checks the README and the reuse guide against the code: scripts, variables,
// options, paths and links. Light Markdown reading only (spans between
// backticks, link targets and simple tables); no network, no new dependency.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVAL_HELP_TEXT } from "../evals/args.js";
import { HELP_TEXT } from "../src/cli/args.js";
import {
  ENV_VARIABLE_NAMES,
  REASONING_EFFORTS,
  parseConfig,
  type AppConfig,
} from "../src/config/env.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const README = read("README.md");
const REUSO = read("docs/REUSO.md");
const PRD = read("docs/PRD.md");
const ENV_EXAMPLE = read(".env.example");
const PACKAGE = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  engines: { node: string };
};
const KEY = "x".repeat(20);
const DEFAULTS = parseConfig({ OPENAI_API_KEY: KEY });

// Battery folders, as in tests/analise-numeros.test.ts.
const FOLDERS = {
  B1: "2026-11-17T22-48-43Z",
  B2: "2026-11-18T11-46-47Z",
};

interface Summary {
  totais: { passou: number };
  autoavaliacao: { rascunhosReprovados: number; turnosRespondidos: number };
}

function summaryOf(folder: string): Summary {
  return JSON.parse(read(`outputs/${folder}/resumo.json`)) as Summary;
}

const SCRIPT_NAMES = Object.keys(PACKAGE.scripts);
const UNSUPPORTED_VARIABLE = "OPENAI_CUSTOM_HEADERS";
const EXPECTED_VARIABLES = [...ENV_VARIABLE_NAMES, UNSUPPORTED_VARIABLE].sort();

/** Names such as OPENAI_API_KEY: capitals and at least one underscore. */
function variablesIn(text: string): string[] {
  const found = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return [...new Set(found)].sort();
}

function optionsIn(text: string): string[] {
  const found = text.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [];
  return [...new Set(found)].sort();
}

/** From the line of the heading up to the next heading of the same level. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  expect(start, `heading not found: ${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const rest = lines.slice(start + 1);
  const length = rest.findIndex((line) => {
    const hashes = /^(#+) /.exec(line)?.[1];
    return hashes !== undefined && hashes.length <= level;
  });
  return rest.slice(0, length === -1 ? rest.length : length).join("\n");
}

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  expect(start, `text not found: ${from}`).toBeGreaterThanOrEqual(0);
  expect(end, `text not found: ${to}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

function withoutFences(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, "");
}

function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

function npmRunNames(text: string): string[] {
  return [...text.matchAll(/npm run ([a-z][a-z:-]*)/g)].map(
    (match) => match[1] ?? "",
  );
}

const PATH_ALLOWLIST = new Set([
  ".env",
  "logs/",
  "resumo.json",
  "execucoes.jsonl",
  "RELATORIO.md",
]);

function looksLikeRepositoryPath(token: string): boolean {
  if (PATH_ALLOWLIST.has(token)) {
    return false;
  }
  if (/\s|[<>*=:$(){}[\]|\\]/.test(token)) {
    return false;
  }
  if (/^(-|\/|\.\.)/.test(token) || /^\.[a-z]+$/.test(token)) {
    return false;
  }
  return (
    token.includes("/") || /\.(md|json|jsonl|ts|yml|txt|example)$/.test(token)
  );
}

describe("README: scripts", () => {
  it("cites only npm scripts that exist in package.json", () => {
    for (const [name, text] of [
      ["README.md", README],
      ["docs/REUSO.md", REUSO],
    ] as const) {
      for (const script of npmRunNames(text)) {
        expect(SCRIPT_NAMES, `${name}: npm run ${script}`).toContain(script);
      }
    }
  });

  it("mentions every script of package.json", () => {
    for (const script of SCRIPT_NAMES) {
      const cited =
        README.includes(`npm run ${script}`) ||
        (script === "test" && README.includes("npm test"));
      expect(cited, `script not in the README: ${script}`).toBe(true);
    }
  });
});

describe("README: environment variables", () => {
  it("lists exactly the variables of env.ts plus the refused one", () => {
    expect(variablesIn(README)).toEqual(EXPECTED_VARIABLES);
  });

  it("agrees with .env.example", () => {
    expect(variablesIn(ENV_EXAMPLE)).toEqual(EXPECTED_VARIABLES);
  });
});

const NUMERIC_VARIABLES: Record<string, keyof AppConfig> = {
  REQUEST_TIMEOUT_MS: "requestTimeoutMs",
  RETRY_MAX_ATTEMPTS: "retryMaxAttempts",
  RETRY_BASE_DELAY_MS: "retryBaseDelayMs",
  RATE_LIMIT_MAX_REQUESTS: "rateLimitMaxRequests",
  RATE_LIMIT_WINDOW_SECONDS: "rateLimitWindowSeconds",
};

function variableRow(name: string): string[] {
  const rows = tableRows(sectionOf(README, "### Variáveis de ambiente"));
  const row = rows.find((cells) => cells[0] === `\`${name}\``);
  expect(row, `row not found: ${name}`).toBeDefined();
  return row ?? [];
}

function unquote(cell: string | undefined): string {
  return (cell ?? "").replaceAll("`", "");
}

describe("README: defaults and minimums of the variables", () => {
  it.each(Object.entries(NUMERIC_VARIABLES))(
    "%s: default and minimum match env.ts",
    (name, field) => {
      const row = variableRow(name);
      expect(Number(unquote(row[1]))).toBe(DEFAULTS[field]);

      const minimum = Number(/pelo menos (\d+)/.exec(row[2] ?? "")?.[1]);
      expect(Number.isInteger(minimum), `no minimum for ${name}`).toBe(true);
      expect(() =>
        parseConfig({ OPENAI_API_KEY: KEY, [name]: String(minimum) }),
      ).not.toThrow();
      expect(() =>
        parseConfig({ OPENAI_API_KEY: KEY, [name]: String(minimum - 1) }),
      ).toThrow();
    },
  );

  it("OPENAI_MODEL: the default is the one of env.ts", () => {
    expect(unquote(variableRow("OPENAI_MODEL")[1])).toBe(DEFAULTS.openaiModel);
  });

  it("OPENAI_REASONING_EFFORT: default and accepted values match env.ts", () => {
    const row = variableRow("OPENAI_REASONING_EFFORT");
    expect(unquote(row[1])).toBe(DEFAULTS.openaiReasoningEffort);
    const listed = [...(row[2] ?? "").matchAll(/`([a-z]+)`/g)].map(
      (match) => match[1] ?? "",
    );
    expect(listed).toEqual([...REASONING_EFFORTS]);
  });
});

describe("README: Node version and result numbers", () => {
  it("cites the Node major version of engines.node", () => {
    const required = /(\d+)/.exec(PACKAGE.engines.node)?.[1];
    const cited = /Node\.js (\d+)/.exec(README)?.[1];
    expect(cited).toBeDefined();
    expect(cited).toBe(required);
  });

  it("cites the battery numbers found in the resumo.json files", () => {
    const b1 = summaryOf(FOLDERS.B1);
    const b2 = summaryOf(FOLDERS.B2);
    const phrases = [
      `${b1.totais.passou} de 36`,
      `${b2.totais.passou} de 36`,
      `${b1.autoavaliacao.rascunhosReprovados} de ${b1.autoavaliacao.turnosRespondidos}`,
      `${b2.autoavaliacao.rascunhosReprovados} de ${b2.autoavaliacao.turnosRespondidos}`,
    ];
    for (const phrase of phrases) {
      expect(README, `README should say "${phrase}"`).toContain(phrase);
    }
    // Every "N de 36" and "N de 39" of the README must be one of them.
    const cited = README.match(/\b\d+ de (?:36|39)\b/g) ?? [];
    expect(cited.length).toBeGreaterThanOrEqual(4);
    for (const text of cited) {
      expect(phrases, `unexpected number: ${text}`).toContain(text);
    }
  });
});

describe("README: command-line options", () => {
  it("lists exactly the options of the two help texts", () => {
    expect(optionsIn(README)).toEqual(
      [
        ...new Set([...optionsIn(HELP_TEXT), ...optionsIn(EVAL_HELP_TEXT)]),
      ].sort(),
    );
  });

  it("matches the chat options by section", () => {
    const section = sectionOf(README, "### Opções do chat");
    expect(optionsIn(section)).toEqual(optionsIn(HELP_TEXT));
  });

  it("matches the eval options by section", () => {
    const section = between(
      README,
      "**`npm run eval`.**",
      "**`npm run smoke:llm`.**",
    );
    expect(optionsIn(section)).toEqual(optionsIn(EVAL_HELP_TEXT));
  });

  it("lists the commands of the chat", () => {
    for (const command of [
      "/sair",
      "/limpar",
      "/contexto",
      "/detalhes",
      "/ajuda",
    ]) {
      expect(sectionOf(README, "### Comandos do chat")).toContain(
        `\`${command}\``,
      );
    }
  });
});

// The reuse guide names the files of a context folder without the prefix
// (`avaliador.md`, `03-usuario/`) and `casos.json` of evals/.
const REUSO_BASES = [ROOT, join(ROOT, "context"), join(ROOT, "evals")];

function citedPaths(text: string): string[] {
  return [...withoutFences(text).matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter(looksLikeRepositoryPath);
}

describe("README: paths and links", () => {
  it("only cites repository paths that exist", () => {
    const paths = citedPaths(README);
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      expect(existsSync(join(ROOT, path)), `missing: ${path}`).toBe(true);
    }
  });

  it("docs/REUSO.md only cites paths that exist", () => {
    const paths = citedPaths(REUSO);
    expect(paths.length).toBeGreaterThan(8);
    for (const path of paths) {
      const found = REUSO_BASES.some((base) => existsSync(join(base, path)));
      expect(found, `missing: ${path}`).toBe(true);
    }
  });

  it("links only to files that exist", () => {
    for (const [name, text, dir] of [
      ["README.md", README, ROOT],
      ["docs/REUSO.md", REUSO, join(ROOT, "docs")],
    ] as const) {
      const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((match) => match[1] ?? "")
        .filter((target) => !/^[a-z]+:/.test(target))
        .map((target) => target.split("#")[0] ?? "");
      if (name === "README.md") {
        expect(targets.length).toBeGreaterThan(10);
      }
      for (const target of targets) {
        expect(
          existsSync(join(dir, target)),
          `${name}: broken link: ${target}`,
        ).toBe(true);
      }
    }
  });

  it("links the five deliverables", () => {
    const section = sectionOf(README, "## Entregáveis do enunciado");
    for (const target of [
      "context/02-politicas.md",
      "context/",
      "docs/REUSO.md",
      "docs/CASOS-DE-TESTE.md",
      "outputs/",
      "docs/ANALISE.md",
    ]) {
      expect(section).toContain(`](${target})`);
    }
    expect(section).toContain("outputs/2026-11-18T11-46-47Z");
    for (const id of ["E1", "E2", "E3", "E4", "E5"]) {
      expect(section).toContain(`| ${id} |`);
    }
  });

  it("points to the final battery folder, which exists", () => {
    expect(existsSync(join(ROOT, "outputs", "2026-11-18T11-46-47Z"))).toBe(
      true,
    );
  });
});

describe("README: content that must not come back", () => {
  it("copies the equivalence table of the PRD, row by row", () => {
    const prd = tableRows(sectionOf(PRD, "### Equivalência"));
    const readme = tableRows(sectionOf(README, "## Equivalência"));
    // Header, separator and the five rules.
    expect(prd.length).toBe(7);
    expect(readme).toEqual(prd);
    expect(sectionOf(README, "## Equivalência")).toContain(
      "esta tabela serve só para o avaliador localizar cada regra",
    );
  });

  it("has no leftover of the first README", () => {
    expect(README).not.toContain("projeto em construção");
    expect(README).not.toMatch(/^#+ Deploy/m);
    expect(README).not.toMatch(/ENG-5\d/);
    expect(README).not.toContain("repositório é público");
  });
});

describe("docs: size and secrets", () => {
  it("keeps the reuse guide within about two pages", () => {
    expect(REUSO.trimEnd().split("\n").length).toBeLessThanOrEqual(100);
    expect(REUSO.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1200);
  });

  it("has no sequence shaped like a real key", () => {
    for (const [name, text] of [
      ["README.md", README],
      ["docs/REUSO.md", REUSO],
      [
        "docs/exemplos/instrucoes-alternativas.md",
        read("docs/exemplos/instrucoes-alternativas.md"),
      ],
    ] as const) {
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    }
  });
});
