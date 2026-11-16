import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDACTED, createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import type { SafeWriter } from "../src/security/safe-writer.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();

let rootDir: string;
let writer: SafeWriter;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "eng44-safe-writer-"));
  writer = createSafeWriter({ redact: createRedactor([KEY]), rootDir });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createSafeWriter", () => {
  it("writes a redacted text, creating the folders", async () => {
    const path = await writer.writeText(
      "outputs/x/a.txt",
      `resposta com a chave ${KEY} no meio\n`,
    );

    const content = await readFile(path, "utf8");
    expect(path).toBe(resolve(rootDir, "outputs", "x", "a.txt"));
    expect(content).not.toContain(KEY);
    expect(content).toBe(`resposta com a chave ${REDACTED} no meio\n`);
  });

  it("redacts a key-shaped sequence that is not the key in use", async () => {
    const other = fakeOpenAiKey("B");

    const path = await writer.writeText("logs/outra.txt", `valor: ${other}`);

    expect(await readFile(path, "utf8")).toBe(`valor: ${REDACTED}`);
  });

  it("overwrites on writeText and accumulates on appendText", async () => {
    await writer.writeText("outputs/a.txt", "primeiro\n");
    await writer.writeText("outputs/a.txt", "segundo\n");
    await writer.appendText("outputs/a.txt", `terceiro ${KEY}\n`);

    const content = await readFile(join(rootDir, "outputs", "a.txt"), "utf8");
    expect(content).toBe(`segundo\nterceiro ${REDACTED}\n`);
  });

  it("appends one redacted JSON document per line", async () => {
    await writer.appendJsonLine("logs/s.jsonl", { turno: 1, resposta: KEY });
    const path = await writer.appendJsonLine("logs/s.jsonl", {
      turno: 2,
      resposta: `Bearer ${KEY}`,
    });

    const content = await readFile(path, "utf8");
    const lines = content.trimEnd().split("\n");

    expect(content).not.toContain(KEY);
    expect(content.endsWith("\n")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines.map((line): unknown => JSON.parse(line))).toEqual([
      { turno: 1, resposta: REDACTED },
      { turno: 2, resposta: `Bearer ${REDACTED}` },
    ]);
  });

  it("writes indented JSON ending with a line break", async () => {
    const path = await writer.writeJson("outputs/2026/resumo.json", {
      total: 36,
      chave: KEY,
    });

    const content = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(content);

    expect(content.endsWith("}\n")).toBe(true);
    expect(content).toContain('\n  "total": 36');
    expect(content).not.toContain(KEY);
    expect(parsed).toEqual({ total: 36, chave: REDACTED });
  });

  it.each([
    ["a parent folder", "../fora.txt"],
    ["another project folder", "src/x.ts"],
    ["the bare outputs folder", "outputs"],
    ["the bare logs folder", "logs/"],
    ["a path that leaves outputs", "outputs/../src/x"],
    ["a path that leaves the root", "outputs/../../fora.txt"],
    ["an absolute path", resolve(tmpdir(), "eng44-absoluto.txt")],
    ["an empty path", ""],
  ])("refuses %s and writes nothing", async (_label, target) => {
    const attempts = [
      () => writer.writeText(target, "x"),
      () => writer.appendText(target, "x"),
      () => writer.writeJson(target, { x: 1 }),
      () => writer.appendJsonLine(target, { x: 1 }),
    ];

    for (const attempt of attempts) {
      // Called directly: a synchronous throw would fail the test here.
      await expect(attempt()).rejects.toThrow(
        "O escritor só grava em outputs/ e logs/.",
      );
    }
    expect(await readdir(rootDir)).toEqual([]);
    expect(existsSync(resolve(tmpdir(), "eng44-absoluto.txt"))).toBe(false);
  });

  it("refuses an absolute path even when it points inside outputs", async () => {
    const inside = resolve(rootDir, "outputs", "a.txt");

    await expect(writer.writeText(inside, "x")).rejects.toThrow(
      `Caminho de escrita não permitido: "${inside}".`,
    );
    expect(await readdir(rootDir)).toEqual([]);
  });

  it.each([
    ["undefined", () => undefined],
    ["a function", () => () => 1],
    ["a symbol", () => Symbol("x")],
    ["a BigInt", () => 10n],
    ["a nested BigInt", () => ({ total: { valor: 10n } })],
    [
      "a circular reference",
      () => {
        const value: Record<string, unknown> = { nome: "a" };
        value.self = value;
        return value;
      },
    ],
    [
      "a toJSON that throws",
      () => ({
        toJSON: () => {
          throw new Error(`falhou com ${KEY}`);
        },
      }),
    ],
  ])(
    "rejects, in Portuguese, a value that cannot be turned into JSON: %s",
    async (_label, build) => {
      const attempts = [
        () => writer.writeJson("outputs/s.json", build()),
        () => writer.appendJsonLine("logs/s.jsonl", build()),
      ];

      for (const attempt of attempts) {
        // Called directly: a synchronous throw would fail the test here.
        const error: unknown = await attempt().then(
          () => undefined,
          (reason: unknown) => reason,
        );

        expect(error).toBeInstanceOf(Error);
        expect(error instanceof Error ? error.message : "").toBe(
          "O valor informado não pode ser convertido em JSON.",
        );
      }
      expect(await readdir(rootDir)).toEqual([]);
    },
  );

  it("refuses a path that holds the key in use, without showing it", async () => {
    const attempts = [
      () => writer.writeText(`outputs/${KEY}.txt`, "x"),
      () => writer.appendText(`logs/${KEY}/a.txt`, "x"),
      () => writer.writeJson(`outputs/resumo-${KEY}.json`, { x: 1 }),
      () => writer.appendJsonLine(`logs/s-${KEY}.jsonl`, { x: 1 }),
    ];

    for (const attempt of attempts) {
      const error: unknown = await attempt().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      const message = error instanceof Error ? error.message : "";

      expect(message).toContain("Caminho de escrita não permitido");
      expect(message).toContain("o caminho contém uma possível credencial");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(KEY.slice(0, 12));
    }
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("refuses a path with a key-shaped sequence that is not the key in use", async () => {
    const other = fakeOpenAiKey("B");

    await expect(writer.writeText(`outputs/${other}.txt`, "x")).rejects.toThrow(
      "o caminho contém uma possível credencial",
    );
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("redacts the path in the message of a path that is not allowed", async () => {
    const plainWriter = createSafeWriter({
      redact: createRedactor(["chave-fora-do-padrao-123"]),
      rootDir,
    });
    const attempts = [
      () => writer.writeText(`src/${KEY}.txt`, "x"),
      () => writer.writeText(`../${KEY}.txt`, "x"),
      () => writer.writeJson(resolve(rootDir, "outputs", `${KEY}.json`), 1),
      () => plainWriter.appendText("src/chave-fora-do-padrao-123.txt", "x"),
    ];

    for (const attempt of attempts) {
      const error: unknown = await attempt().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      const message = error instanceof Error ? error.message : "";

      expect(message).toContain("Caminho de escrita não permitido");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(KEY.slice(0, 12));
      expect(message).not.toContain("chave-fora-do-padrao");
    }
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("redacts a key in nested keys and values of a JSON document", async () => {
    const value = {
      [KEY]: { lista: [KEY, { [`k_${KEY}`]: `Bearer ${KEY}` }] },
      headers: { authorization: `Bearer ${KEY}` },
    };

    const path = await writer.writeJson("outputs/aninhado.json", value);
    await writer.appendJsonLine("logs/aninhado.jsonl", value);

    const content = await readFile(path, "utf8");
    const line = await readFile(
      join(rootDir, "logs", "aninhado.jsonl"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(content);
    expect(content).not.toContain(KEY);
    expect(line).not.toContain(KEY);
    expect(parsed).toEqual({
      [REDACTED]: {
        lista: [REDACTED, { [`k_${REDACTED}`]: `Bearer ${REDACTED}` }],
      },
      headers: { authorization: `Bearer ${REDACTED}` },
    });
  });

  // Same result on Windows and on Linux, where "\" is not a separator.
  it.each([
    ["backslashes that leave outputs", "outputs\\..\\src\\x.txt"],
    ["backslashes that leave the root", "logs\\..\\..\\fora.txt"],
    ["a capitalized folder", "Outputs/a.txt"],
    ["an upper-case folder", "LOGS/a.txt"],
    ["a folder that only starts like outputs", "outputs-extra/a.txt"],
    ["a folder that only starts like logs", "logs2/a.txt"],
    ["the outputs folder itself, with a dot", "outputs/."],
    ["a path that comes back to the bare folder", "outputs/x/.."],
  ])("refuses %s and writes nothing", async (_label, target) => {
    await expect(writer.writeText(target, "x")).rejects.toThrow(
      "O escritor só grava em outputs/ e logs/.",
    );
    await expect(writer.appendText(target, "x")).rejects.toThrow(
      "O escritor só grava em outputs/ e logs/.",
    );
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("accepts a path that goes around but stays inside outputs", async () => {
    const path = await writer.writeText("./outputs/x/../y/./a.txt", "ok\n");

    expect(path).toBe(resolve(rootDir, "outputs", "y", "a.txt"));
    expect(await readFile(path, "utf8")).toBe("ok\n");
  });
});
