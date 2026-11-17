import { describe, expect, it } from "vitest";
import {
  HELP_TEXT,
  classifyProfileArg,
  parseCliArgs,
  toContextOptions,
  type CliOptions,
} from "../src/cli/args.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();

const DEFAULTS: CliOptions = { showContext: false, verbose: false };

function run(argv: string[]): CliOptions {
  const result = parseCliArgs(argv);
  if (result.kind !== "run") {
    throw new Error(`expected run, got ${result.kind}`);
  }
  return result.options;
}

function errorMessage(argv: string[]): string {
  const result = parseCliArgs(argv);
  if (result.kind !== "error") {
    throw new Error(`expected error, got ${result.kind}`);
  }
  return result.message;
}

describe("parseCliArgs", () => {
  it("has defaults with no argument", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run", options: DEFAULTS });
  });

  it("reads each option", () => {
    expect(run(["--system-prompt", "a.md"]).systemPrompt).toBe("a.md");
    expect(run(["--perfil", "x"]).profile).toBe("x");
    expect(run(["--perfil=x"]).profile).toBe("x");
    expect(run(["--context-dir", "pasta"]).contextDir).toBe("pasta");
    expect(run(["--show-context"]).showContext).toBe(true);
    expect(run(["--verbose"]).verbose).toBe(true);
  });

  it("reads all the options together", () => {
    expect(
      run([
        "--system-prompt=a.md",
        "--perfil",
        "p",
        "--context-dir=d",
        "--show-context",
        "--verbose",
      ]),
    ).toEqual({
      systemPrompt: "a.md",
      profile: "p",
      contextDir: "d",
      showContext: true,
      verbose: true,
    });
  });

  it.each([["--help"], ["-h"]])("returns the help for %s", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--verbose", flag])).toEqual({ kind: "help" });
  });

  it("names an unknown option", () => {
    expect(errorMessage(["--nada"])).toBe("opção desconhecida: --nada");
    expect(errorMessage(["--nada=1"])).toBe("opção desconhecida: --nada");
  });

  it("does not echo an unknown option that is not shaped like a name", () => {
    expect(errorMessage(["-x"])).toBe("opção desconhecida");
    expect(errorMessage([`--${"a".repeat(40)}`])).toBe("opção desconhecida");
    expect(errorMessage(["--ABC"])).toBe("opção desconhecida");
  });

  it.each([
    ["--api-key then KEY", ["--api-key", KEY]],
    ["--openai-api-key=KEY", [`--openai-api-key=${KEY}`]],
    ["OPENAI_API_KEY=KEY", [`OPENAI_API_KEY=${KEY}`]],
    ["KEY alone", [KEY]],
    ["-- KEY", ["--", KEY]],
  ])("never echoes the key of %s", (_label, argv) => {
    const message = errorMessage(argv);

    expect(message).not.toContain(KEY);
    expect(message).not.toContain("sk-");
  });

  it("refuses an option that exists for the key", () => {
    expect(parseCliArgs(["--api-key", "x"]).kind).toBe("error");
    expect(HELP_TEXT).not.toMatch(/--api-key|--chave|--key/);
  });

  it("asks for the missing value", () => {
    expect(errorMessage(["--perfil"])).toBe("a opção --perfil exige um valor");
    expect(errorMessage(["--perfil", "--verbose"])).toBe(
      "a opção --perfil exige um valor",
    );
    expect(errorMessage(["--system-prompt"])).toContain("--system-prompt");
  });

  it("refuses a blank value", () => {
    expect(errorMessage(["--perfil", ""])).toBe(
      "a opção --perfil exige um valor",
    );
    expect(errorMessage(["--context-dir=   "])).toBe(
      "a opção --context-dir exige um valor",
    );
  });

  it("refuses a value for a flag", () => {
    expect(errorMessage(["--verbose=sim"])).toBe(
      "a opção --verbose não aceita valor",
    );
  });

  it("refuses a repeated option", () => {
    expect(errorMessage(["--perfil", "a", "--perfil", "b"])).toBe(
      "a opção --perfil foi informada mais de uma vez",
    );
    expect(errorMessage(["--verbose", "--verbose"])).toContain("mais de uma");
  });

  it("refuses positional arguments, even after --", () => {
    expect(errorMessage(["algo"])).toBe(
      "argumentos posicionais não são aceitos",
    );
    expect(errorMessage(["--", "x"])).toBe(
      "argumentos posicionais não são aceitos",
    );
    expect(errorMessage(["--verbose", "x"])).toContain("posicionais");
  });

  it("accepts a lone --", () => {
    expect(parseCliArgs(["--"])).toEqual({ kind: "run", options: DEFAULTS });
  });
});

describe("classifyProfileArg", () => {
  it("takes a plain name as a slug", () => {
    expect(classifyProfileArg("ana")).toEqual({ profile: "ana" });
  });

  it.each([
    ["a/b.json"],
    ["a\\b"],
    ["x.JSON"],
    ["C:x"],
    ["C:\\x.json"],
    [".\\x.json"],
    ["./x"],
  ])("takes %s as a path", (value) => {
    expect(classifyProfileArg(value)).toEqual({ profileFile: value });
  });
});

describe("toContextOptions", () => {
  it("is empty by default", () => {
    expect(toContextOptions(DEFAULTS)).toEqual({});
  });

  it("maps each option", () => {
    expect(
      toContextOptions({
        ...DEFAULTS,
        systemPrompt: "a.md",
        contextDir: "d",
        profile: "ana",
      }),
    ).toEqual({
      globalInstructionsFile: "a.md",
      contextDir: "d",
      profile: "ana",
    });
    expect(toContextOptions({ ...DEFAULTS, profile: "p/x.json" })).toEqual({
      profileFile: "p/x.json",
    });
  });
});

describe("HELP_TEXT", () => {
  it("lists every option", () => {
    for (const option of [
      "--system-prompt <arquivo>",
      "--perfil <nome|arquivo>",
      "--context-dir <pasta>",
      "--show-context",
      "--verbose",
      "-h, --help",
      "OPENAI_API_KEY",
    ]) {
      expect(HELP_TEXT).toContain(option);
    }
  });
});
