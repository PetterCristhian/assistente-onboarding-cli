import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNS,
  EVAL_HELP_TEXT,
  parseEvalArgs,
  type ParsedEvalArgs,
} from "../evals/args.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();

function messageOf(parsed: ParsedEvalArgs): string {
  if (parsed.kind !== "error") {
    throw new Error(`expected an error, got ${parsed.kind}`);
  }
  return parsed.message;
}

describe("parseEvalArgs", () => {
  it("runs every case 3 times by default", () => {
    expect(parseEvalArgs([])).toEqual({
      kind: "run",
      options: { runs: DEFAULT_RUNS },
    });
    expect(DEFAULT_RUNS).toBe(3);
  });

  it("reads --runs and --case, in either form", () => {
    expect(parseEvalArgs(["--runs", "5", "--case", "CT03"])).toEqual({
      kind: "run",
      options: { runs: 5, caseId: "CT03" },
    });
    expect(parseEvalArgs(["--runs=1", "--case=CT12"])).toEqual({
      kind: "run",
      options: { runs: 1, caseId: "CT12" },
    });
  });

  it.each(["1", "10"])("accepts --runs %s", (value) => {
    expect(parseEvalArgs(["--runs", value]).kind).toBe("run");
  });

  it.each(["0", "11", "abc", "1.5", "-1", "", " 3", "1e1", "99999"])(
    "refuses --runs %j",
    (value) => {
      expect(parseEvalArgs(["--runs", value]).kind).toBe("error");
      expect(parseEvalArgs([`--runs=${value}`]).kind).toBe("error");
    },
  );

  it("says what --runs wants, without repeating the value", () => {
    expect(messageOf(parseEvalArgs(["--runs", "abc"]))).toBe(
      "--runs deve ser um número inteiro de 1 a 10",
    );
    expect(messageOf(parseEvalArgs(["--runs", "11"]))).toContain("de 1 a 10");
    expect(messageOf(parseEvalArgs(["--runs"]))).toBe(
      "a opção --runs exige um valor",
    );
  });

  it.each(["ct03", "CT3", "CT003", "CT03 ", "todos", "../x"])(
    "refuses --case %j",
    (value) => {
      const parsed = parseEvalArgs(["--case", value]);

      expect(messageOf(parsed)).toBe(
        "--case deve ter o formato CT00, por exemplo CT03",
      );
    },
  );

  it("refuses an option given twice", () => {
    expect(messageOf(parseEvalArgs(["--runs", "2", "--runs", "3"]))).toBe(
      "a opção --runs foi informada mais de uma vez",
    );
    expect(messageOf(parseEvalArgs(["--case=CT01", "--case=CT02"]))).toBe(
      "a opção --case foi informada mais de uma vez",
    );
  });

  it("refuses positional arguments and unknown options", () => {
    expect(messageOf(parseEvalArgs(["CT03"]))).toBe(
      "argumentos posicionais não são aceitos",
    );
    expect(messageOf(parseEvalArgs(["--verbose"]))).toBe(
      "opção desconhecida: --verbose",
    );
  });

  it("does not take the key, and never echoes it", () => {
    for (const argv of [
      ["--api-key", KEY],
      [`--api-key=${KEY}`],
      [`--openai-api-key=${KEY}`],
      [KEY],
      ["--runs", KEY],
      ["--case", KEY],
      [`--${KEY}`],
    ]) {
      const message = messageOf(parseEvalArgs(argv));

      expect(message).not.toContain(KEY);
      expect(message).not.toContain("sk-");
    }
    expect(messageOf(parseEvalArgs(["--api-key", KEY]))).toBe(
      "opção desconhecida: --api-key",
    );
    expect(EVAL_HELP_TEXT).not.toMatch(/--api-key|--chave|--key/);
  });

  it("does not quote an option name that is long or odd", () => {
    expect(messageOf(parseEvalArgs([`--${"a".repeat(40)}`]))).toBe(
      "opção desconhecida",
    );
    expect(messageOf(parseEvalArgs(["--Ação"]))).toBe("opção desconhecida");
  });

  it("refuses a value for --help", () => {
    expect(messageOf(parseEvalArgs(["--help=x"]))).toBe(
      "a opção --help não aceita valor",
    );
  });

  it("shows the help for --help and -h, whatever else is valid", () => {
    expect(parseEvalArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseEvalArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseEvalArgs(["--runs", "2", "-h"])).toEqual({ kind: "help" });
    expect(EVAL_HELP_TEXT).toContain("--runs <n>");
    expect(EVAL_HELP_TEXT).toContain("--case <id>");
    expect(EVAL_HELP_TEXT).toContain("consome crédito");
  });
});
