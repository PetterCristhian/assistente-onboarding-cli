import { describe, expect, it } from "vitest";
import { HELP_LINES, parseInput } from "../src/cli/commands.js";

describe("parseInput", () => {
  it.each(["", "   ", "\t"])("ignores the empty line %j", (line) => {
    expect(parseInput(line)).toEqual({ kind: "empty" });
  });

  it.each([
    ["/sair", "sair"],
    ["/SAIR", "sair"],
    [" /limpar ", "limpar"],
    ["/Contexto", "contexto"],
    ["/ajuda", "ajuda"],
  ])("reads %j as a command", (line, name) => {
    expect(parseInput(line)).toEqual({ kind: "command", name });
  });

  it.each(["/xyz", "/detalhes", "/", "/sair agora", "/limpar tudo"])(
    "reads %j as unknown",
    (line) => {
      expect(parseInput(line)).toEqual({ kind: "unknown", raw: line.trim() });
    },
  );

  it("trims a question and does not take a slash in the middle as a command", () => {
    expect(parseInput("  Como peço férias?  ")).toEqual({
      kind: "question",
      text: "Como peço férias?",
    });
    expect(parseInput("o que é /sair?")).toMatchObject({ kind: "question" });
  });

  it("lists every command in the help", () => {
    const help = HELP_LINES.join("\n");
    for (const name of ["/sair", "/limpar", "/contexto", "/ajuda"]) {
      expect(help).toContain(name);
    }
    expect(help).not.toContain("/detalhes");
  });
});
