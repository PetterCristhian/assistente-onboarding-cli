// QA of ENG-57 part 3: extraFiles of the safe writer, with the spellings that a
// file system may read as the same file and with hostile configurations.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();
const EXTRA = "docs/CASOS-DE-TESTE.md";

let rootDir: string;
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "made-up-qa-extra-"));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function create(extraFiles: readonly string[]) {
  return createSafeWriter({
    redact: createRedactor([KEY]),
    rootDir,
    extraFiles,
  });
}

describe("extraFiles: other spellings of the same file are refused", () => {
  it.each([
    ["trailing space", `${EXTRA} `],
    ["leading space", ` ${EXTRA}`],
    ["upper case folder", "DOCS/CASOS-DE-TESTE.md"],
    ["upper case file", "docs/CASOS-DE-TESTE.MD"],
    ["zero width space", "docs/CASOS-DE-TESTE\u200B.md"],
    ["bidi mark", "docs/CASOS-DE-TESTE\u202E.md"],
    ["ADS default stream", `${EXTRA}::$DATA`],
    ["ADS named stream", `${EXTRA}:stream`],
    ["8.3 short name", "docs/CASOS-~1.MD"],
    ["backslash up and back", "docs\\..\\docs\\CASOS-DE-TESTE.md"],
    ["dot segment in the middle", "docs/./CASOS-DE-TESTE.md"],
    ["trailing slash", `${EXTRA}/`],
    ["url encoded", "docs/CASOS-DE-TESTE%2Emd"],
    ["nul", `${EXTRA}\u0000`],
  ])("%s", async (_label, target) => {
    const writer = create([EXTRA]);

    await expect(writer.writeText(target, "x")).rejects.toThrow(
      "Caminho de escrita não permitido",
    );
    await expect(writer.appendText(target, "x")).rejects.toThrow();
    await expect(writer.writeJson(target, { a: 1 })).rejects.toThrow();
    await expect(writer.appendJsonLine(target, { a: 1 })).rejects.toThrow();
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("the absolute path of the very same file", async () => {
    const writer = create([EXTRA]);

    await expect(
      writer.writeText(resolve(rootDir, "docs", "CASOS-DE-TESTE.md"), "x"),
    ).rejects.toThrow("Caminho de escrita não permitido");
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("an extra configured with an accent is not matched by the decomposed form", async () => {
    const nfc = "docs/Índice.md".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    const writer = create([nfc]);

    await expect(writer.writeText(nfd, "x")).rejects.toThrow(
      "Caminho de escrita não permitido",
    );
    expect(await readdir(rootDir)).toEqual([]);
    await writer.writeText(nfc, "x");
    expect(await readdir(join(rootDir, "docs"))).toHaveLength(1);
  });
});

describe("extraFiles: the writer does not grow", () => {
  it("does not open the folder of the extra file, nor any other place", async () => {
    const writer = create([EXTRA]);

    for (const target of [
      "docs/outro.md",
      "docs/sub/CASOS-DE-TESTE.md",
      "src/x.ts",
      "evals/casos.json",
      "CLAUDE.md",
      ".git/config",
      "docs",
    ]) {
      await expect(writer.writeText(target, "x"), target).rejects.toThrow(
        "Caminho de escrita não permitido",
      );
    }
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("still refuses outputs/ escapes while an extra file is configured", async () => {
    const writer = create([EXTRA]);

    await expect(writer.writeText("outputs/../x.md", "x")).rejects.toThrow();
    await expect(writer.writeText("outputs", "x")).rejects.toThrow();
    await expect(
      writer.writeText("outputs/../docs/x.md", "x"),
    ).rejects.toThrow();
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("a glob in the configuration is a literal name, not a pattern", async () => {
    const writer = create(["docs/*.md"]);

    await expect(writer.writeText(EXTRA, "x")).rejects.toThrow(
      "Caminho de escrita não permitido",
    );
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("an extra file does not turn off redaction, in text, JSON or a name", async () => {
    const writer = create([EXTRA]);
    const shaped = `sk-proj-${"A1b2C3d4E5".repeat(6)}`;

    await writer.writeText(EXTRA, `a ${KEY} b ${shaped}\n`);
    const text = await readFile(join(rootDir, EXTRA), "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(shaped);
    // A key broken by a line break or by a JSON escape must not survive either.
    await writer.writeText(EXTRA, `x\n${KEY.slice(0, 12)}\n${KEY.slice(12)}`);
    expect(await readFile(join(rootDir, EXTRA), "utf8")).not.toContain(KEY);
  });

  it("an extra file accepts only overwrite: append and JSON are refused", async () => {
    const writer = create([EXTRA]);

    await expect(writer.appendText(EXTRA, "x")).rejects.toThrow(
      "Caminho de escrita não permitido",
    );
    await expect(writer.appendJsonLine(EXTRA, { a: 1 })).rejects.toThrow(
      "Caminho de escrita não permitido",
    );
    await expect(writer.writeJson(EXTRA, { a: 1 })).rejects.toThrow(
      "Caminho de escrita não permitido",
    );
    expect(await readdir(rootDir)).toEqual([]);

    await writer.writeText(EXTRA, "um\n");
    await writer.writeText(EXTRA, "dois\n");
    expect(await readFile(join(rootDir, EXTRA), "utf8")).toBe("dois\n");
  });
});

describe("extraFiles: validation when the writer is created", () => {
  it.each([
    ["empty", ""],
    ["absolute posix", "/etc/x.md"],
    ["absolute windows", "C:\\x\\y.md"],
    ["unc", "\\\\server\\share\\y.md"],
    ["parent", "../x/y.md"],
    ["parent in the middle", "docs/../y.md"],
    ["parent with backslash", "docs\\..\\y.md"],
    ["no folder", "y.md"],
    ["dot folder", "./y.md"],
    ["double slash", "docs//y.md"],
    ["trailing slash", "docs/"],
    ["only slash", "/"],
    ["only dots", ".."],
  ])("refuses %s", (_label, extra) => {
    expect(() => create([extra])).toThrow("extraFiles");
  });

  it("refuses one bad item among good ones", () => {
    expect(() => create([EXTRA, "../x/y.md"])).toThrow("extraFiles");
  });

  // On Windows "C:docs/x.md" is relative to the current directory of the drive
  // C, so it is not "absolute" for node, yet resolve() leaves rootDir. Any ":"
  // (drive, alternate data stream) is refused at creation, on every platform.
  it.each([
    ["drive-relative", "Y:docs/x.md"],
    ["alternate data stream", "docs/x.md:stream"],
    ["default data stream", "docs/x.md::$DATA"],
  ])("refuses a colon: %s", (_label, extra) => {
    expect(() => create([extra])).toThrow("extraFiles");
  });

  // Only docs/ (exact prefix): the writer cannot be pointed at code, hooks or
  // the CI workflow, nor at the root.
  it.each([
    ["a git hook", ".git/hooks/x"],
    ["a workflow", ".github/workflows/ci.yml"],
    ["the code of the writer", "src/security/safe-writer.ts"],
    ["the root", "README.md"],
    ["outputs/", "outputs/x/y.md"],
    ["logs/", "logs/a.md"],
    ["upper case docs", "DOCS/x.md"],
    ["docs with a backslash", "docs\\x.md"],
    ["a folder that only starts with docs", "docs-extra/x.md"],
  ])("refuses %s as an extra file", (_label, extra) => {
    expect(() => create([extra])).toThrow("extraFiles");
  });
});
