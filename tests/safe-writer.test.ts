import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDACTED, createRedactor } from "../src/security/redact.js";
import { findSecretsInText } from "../src/security/secret-scan.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import type { SafeWriter } from "../src/security/safe-writer.js";
import {
  createFakeKeyGenerator,
  fakeLowerCaseKeyShape,
  fakeMaskedOpenAiKey,
  fakeOpenAiKey,
} from "./helpers/fake-key.js";
import { AFTER_AN_ESCAPE, ORDINARY_TEXT } from "./helpers/key-placements.js";

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

  describe("with a redactor that does nothing", () => {
    let identityWriter: SafeWriter;

    beforeEach(() => {
      identityWriter = createSafeWriter({ redact: (text) => text, rootDir });
    });

    it("still applies the base pattern to every content it writes", async () => {
      const masked = fakeMaskedOpenAiKey();
      const text = await identityWriter.writeText(
        "outputs/a.txt",
        `chave ${KEY}\n`,
      );
      await identityWriter.appendText("outputs/a.txt", `erro: ${masked}.\n`);
      const json = await identityWriter.writeJson("outputs/a.json", {
        chave: KEY,
      });
      const lines = await identityWriter.appendJsonLine("logs/a.jsonl", {
        authorization: `Bearer ${KEY}`,
      });

      expect(await readFile(text, "utf8")).toBe(
        `chave ${REDACTED}\nerro: ${REDACTED}.\n`,
      );
      expect(JSON.parse(await readFile(json, "utf8"))).toEqual({
        chave: REDACTED,
      });
      expect(JSON.parse(await readFile(lines, "utf8"))).toEqual({
        authorization: `Bearer ${REDACTED}`,
      });
    });

    it("still refuses a path with a key-shaped sequence, redacted in the message", async () => {
      const attempts = [
        () => identityWriter.writeText(`outputs/${KEY}.txt`, "x"),
        () => identityWriter.appendText(`src/${KEY}.txt`, "x"),
      ];

      for (const attempt of attempts) {
        const error: unknown = await attempt().then(
          () => undefined,
          (reason: unknown) => reason,
        );
        const message = error instanceof Error ? error.message : "";

        expect(message).toContain("o caminho contém uma possível credencial");
        expect(message).not.toContain(KEY.slice(0, 12));
      }
      expect(await readdir(rootDir)).toEqual([]);
    });
  });

  it("applies the given redactor on top of the base pattern", async () => {
    const custom = createSafeWriter({
      redact: (text) => text.replaceAll("segredo-do-chamador", "<fora>"),
      rootDir,
    });

    const path = await custom.writeText(
      "logs/a.txt",
      `segredo-do-chamador e ${KEY}`,
    );

    expect(await readFile(path, "utf8")).toBe(`<fora> e ${REDACTED}`);
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

// QA of ENG-44 (B6): redaction ran only on the text that JSON.stringify
// produced, where a key at the start of a line comes right after the "n" of
// a line break.
describe("createSafeWriter: a key that JSON.stringify escapes around", () => {
  const other = fakeOpenAiKey("B");

  async function writeBoth(value: unknown): Promise<[string, string]> {
    const jsonPath = await writer.writeJson("outputs/run/turno.json", value);
    const linePath = await writer.appendJsonLine("logs/sessao.jsonl", value);
    const line = await readFile(linePath, "utf8");
    // Removed, so that the next call reads only what it appended.
    await rm(linePath);
    return [await readFile(jsonPath, "utf8"), line];
  }

  it("redacts a key at the start of a line of a string, in both methods", async () => {
    const contents = await writeBoth({
      pergunta: `minha chave antiga:\n${other}`,
    });

    for (const content of contents) {
      expect(content).not.toContain(other);
      expect(JSON.parse(content)).toEqual({
        pergunta: `minha chave antiga:\n${REDACTED}`,
      });
      expect(findSecretsInText(content)).toEqual([]);
    }
  });

  it.each([
    ["a tab", "\t"],
    ["a carriage return", "\r"],
    ["CRLF", "\r\n"],
    ["an ANSI reset", "\x1b[0m"],
    ["a quote", '"'],
    ["a backslash", "\\"],
    ["a form feed", "\f"],
  ])("redacts a key and a masked key after %s", async (_label, before) => {
    const masked = fakeMaskedOpenAiKey();

    const contents = await writeBoth({
      [`nome${before}${other}`]: [`a${before}${other}`, { b: before + masked }],
    });

    for (const content of contents) {
      expect(content).not.toContain(other);
      expect(content).not.toContain(masked);
      expect(JSON.parse(content)).toEqual({
        [`nome${before}${REDACTED}`]: [
          `a${before}${REDACTED}`,
          { b: before + REDACTED },
        ],
      });
      expect(findSecretsInText(content)).toEqual([]);
    }
  });

  it.each(AFTER_AN_ESCAPE)(
    "leaves no finding when a string already holds a key after %s",
    async (_label, build) => {
      const contents = await writeBoth({ texto: build(other) });

      for (const content of contents) {
        expect(content).not.toContain(other);
        expect(JSON.parse(content)).toEqual({ texto: build(REDACTED) });
        expect(findSecretsInText(content)).toEqual([]);
      }
    },
  );

  it("redacts each string before it is serialized, names and values at any depth", async () => {
    // Only the string itself holds this secret: in the JSON text the line
    // break and the quotes are escaped, and the exact value is not there.
    const secret = 'primeira linha\n"segunda" linha';
    const strict = createSafeWriter({
      redact: createRedactor([secret]),
      rootDir,
    });
    const value = {
      [secret]: 1,
      lista: [secret, [`x ${secret}`], { [`k ${secret}`]: { v: secret } }],
      data: { toJSON: () => `de toJSON: ${secret}` },
      numero: 7,
      nulo: null,
    };
    const expected = {
      [REDACTED]: 1,
      lista: [
        REDACTED,
        [`x ${REDACTED}`],
        { [`k ${REDACTED}`]: { v: REDACTED } },
      ],
      data: `de toJSON: ${REDACTED}`,
      numero: 7,
      nulo: null,
    };

    const jsonPath = await strict.writeJson("outputs/s.json", value);
    const linePath = await strict.appendJsonLine("logs/s.jsonl", value);

    for (const path of [jsonPath, linePath]) {
      const content = await readFile(path, "utf8");
      expect(content).not.toContain("segunda");
      expect(JSON.parse(content)).toEqual(expected);
    }
  });

  it("writes a top-level string and keeps the layout of the document", async () => {
    const [json, line] = await writeBoth(`chave:\n${other}`);
    const [indented, single] = await writeBoth({ a: [1, { b: "x" }], c: "y" });

    expect(json).toBe(`${JSON.stringify(`chave:\n${REDACTED}`)}\n`);
    expect(line).toBe(`${JSON.stringify(`chave:\n${REDACTED}`)}\n`);
    expect(indented).toBe(
      `${JSON.stringify({ a: [1, { b: "x" }], c: "y" }, null, 2)}\n`,
    );
    expect(single).toBe(`${JSON.stringify({ a: [1, { b: "x" }], c: "y" })}\n`);
  });

  it("keeps a property named __proto__ as a property", async () => {
    const value: unknown = JSON.parse(
      `{"__proto__":{"x":1},${JSON.stringify(`k ${other}`)}:2}`,
    );

    const [json] = await writeBoth(value);

    expect(json).toContain('"__proto__"');
    expect(JSON.parse(json)).toEqual(
      JSON.parse(`{"__proto__":{"x":1},"k ${REDACTED}":2}`),
    );
  });

  it("still rejects a circular value whose property names hold a key", async () => {
    const circular: Record<string, unknown> = { [`k ${other}`]: 1 };
    circular[`self ${other}`] = circular;

    for (const attempt of [
      () => writer.writeJson("outputs/c.json", circular),
      () => writer.appendJsonLine("logs/c.jsonl", circular),
    ]) {
      await expect(attempt()).rejects.toThrow(
        "O valor informado não pode ser convertido em JSON.",
      );
    }
    expect(await readdir(rootDir)).toEqual([]);
  });

  it.each(ORDINARY_TEXT)("keeps ordinary text unchanged: %s", async (text) => {
    const value = { resposta: `linha\n${text}\tfim`, [text]: [text] };

    for (const content of await writeBoth(value)) {
      expect(JSON.parse(content)).toEqual(value);
      expect(findSecretsInText(content)).toEqual([]);
    }
  });
});

// QA of ENG-44, retest of B6 and of the replacer of the JSON writer.
describe("createSafeWriter: other shapes of value and of text (QA)", () => {
  const other = fakeOpenAiKey("C");
  const another = fakeOpenAiKey("D");
  const lowerCase = fakeLowerCaseKeyShape();

  async function writtenBy(
    write: (target: SafeWriter) => Promise<string>,
  ): Promise<string> {
    const content = await readFile(await write(writer), "utf8");
    expect(findSecretsInText(content)).toEqual([]);
    for (const secret of [KEY, other, another, lowerCase]) {
      expect(content).not.toContain(secret);
    }
    return content;
  }

  it("redacts what toJSON returns, a string or an object with a key in a name", async () => {
    const content = await writtenBy((target) =>
      target.writeJson("outputs/run/a.json", {
        texto: { toJSON: () => `linha\n${other}` },
        objeto: { toJSON: () => ({ [`n\t${another}`]: `v\r${lowerCase}` }) },
      }),
    );

    expect(JSON.parse(content)).toEqual({
      texto: `linha\n${REDACTED}`,
      objeto: { [`n\t${REDACTED}`]: `v\r${REDACTED}` },
    });
  });

  it("redacts a String object, which the replacer sees as an object", async () => {
    const content = await writtenBy((target) =>
      target.appendJsonLine("logs/sessao.jsonl", {
        a: new String(`linha\n${other}`),
        b: new String(`linha\n${lowerCase}`),
        c: new String(KEY),
      }),
    );

    expect(JSON.parse(content)).toEqual({
      a: `linha\n${REDACTED}`,
      b: `linha\n${REDACTED}`,
      c: REDACTED,
    });
  });

  it("redacts a key in arrays inside arrays and in a getter", async () => {
    const value = {
      lista: [[[`a\n${other}`, [{ z: [another] }]]]],
      get [another]() {
        return `x\n${lowerCase}`;
      },
    };
    const content = await writtenBy((target) =>
      target.writeJson("outputs/run/b.json", value),
    );

    expect(JSON.parse(content)).toEqual({
      lista: [[[`a\n${REDACTED}`, [{ z: [REDACTED] }]]]],
      [REDACTED]: `x\n${REDACTED}`,
    });
  });

  it("redacts a key in a string that is JSON serialized three times", async () => {
    const inner = JSON.stringify(
      JSON.stringify(
        JSON.stringify({ a: `x\n${other}`, b: `y\t${lowerCase}` }),
      ),
    );

    await writtenBy((target) =>
      target.writeJson("outputs/run/c.json", { p: inner }),
    );
    await writtenBy((target) => target.writeText("outputs/run/c.txt", inner));
    await writtenBy((target) => target.appendText("logs/c.log", inner));
  });

  it("redacts a key in the message and in the stack of an error", async () => {
    const error = new Error(`401 Incorrect API key provided: ${other}.`);
    const content = await writtenBy((target) =>
      target.writeJson("outputs/run/d.json", {
        mensagem: String(error),
        pilha: `falha\n${String(error.stack)}\n    at${another}`,
      }),
    );

    expect(content).toContain(REDACTED);
  });

  it("redacts random keys in real formats glued to a letter or digit", async () => {
    const generator = createFakeKeyGenerator(44);
    const keys = Array.from({ length: 200 }, (_unused, index) =>
      index % 2 === 0 ? generator.legacy() : generator.withSegment("proj"),
    );
    const value = keys.map((key) => `${generator.letterOrDigit()}${key}`);
    const content = await writtenBy((target) =>
      target.writeJson("outputs/run/e.json", value),
    );

    for (const key of keys) {
      expect(content).not.toContain(key.slice(8, 28));
    }
    expect(JSON.parse(content)).toHaveLength(keys.length);
  });

  it("writes nothing when the given redactor throws", async () => {
    const failing = createSafeWriter({
      redact: () => {
        throw new Error("simulated failure of the redactor");
      },
      rootDir,
    });

    await expect(
      failing.writeJson("outputs/run/f.json", { p: other }),
    ).rejects.toThrow();
    await expect(
      failing.writeText("outputs/run/f.txt", other),
    ).rejects.toThrow();
    await expect(
      failing.appendJsonLine("logs/f.jsonl", { p: other }),
    ).rejects.toThrow();
    expect(await readdir(rootDir)).toEqual([]);
  });
});
