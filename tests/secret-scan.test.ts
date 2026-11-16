import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  NoFilesScannedError,
  describeScanFailure,
  findSecretsInText,
  listRepositoryFiles,
  scanRepository,
} from "../src/security/secret-scan.js";
import { fakeMaskedOpenAiKey, fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

const temporaryFolders: string[] = [];

function createTemporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "eng44-secret-scan-"));
  temporaryFolders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("findSecretsInText", () => {
  it("reports line and column of a key, without the value", () => {
    const text = `linha um\nlinha dois\nchave: ${KEY}\nlinha quatro\n`;

    const findings = findSecretsInText(text);

    expect(findings).toEqual([{ line: 3, column: 8 }]);
    expect(JSON.stringify(findings)).not.toContain(KEY);
  });

  it("reports every occurrence, also with CRLF line endings", () => {
    const text = `${KEY}\r\nx ${KEY} y ${fakeOpenAiKey("B")}\r\n`;

    expect(findSecretsInText(text)).toEqual([
      { line: 1, column: 1 },
      { line: 2, column: 3 },
      { line: 2, column: KEY.length + 6 },
    ]);
  });

  // Decision: the masked form counts as a finding. It only shows up in a
  // versioned file when an error message was written without redaction.
  it.each([
    ["project key", {}],
    ["classic key with few asterisks", { project: false, asterisks: 3 }],
  ])("reports a masked key as a finding: %s", (_label, options) => {
    const masked = fakeMaskedOpenAiKey(options);

    const findings = findSecretsInText(`erro 401\n  chave: ${masked}.\n`);

    expect(findings).toEqual([{ line: 2, column: 10 }]);
  });

  it("reports a key-shaped line of 8 MB instead of failing", () => {
    const line = `x ${KEY}${"a".repeat(8 * 1024 * 1024)}`;

    expect(findSecretsInText(`primeira\n${line}\nterceira\n`)).toEqual([
      { line: 2, column: 3 },
    ]);
  });

  it("finds nothing in a clean text", () => {
    expect(findSecretsInText("OPENAI_API_KEY=\n# sem valor real\n")).toEqual(
      [],
    );
    expect(findSecretsInText("")).toEqual([]);
  });
});

/** The bytes of a UTF-16 file, seen the way the scan reads them (latin1). */
function utf16AsLatin1(
  text: string,
  options: { bigEndian?: boolean; bom?: boolean } = {},
): string {
  const bytes = Buffer.from(
    `${options.bom === true ? "\ufeff" : ""}${text}`,
    "utf16le",
  );
  if (options.bigEndian === true) {
    bytes.swap16();
  }
  return bytes.toString("latin1");
}

describe("findSecretsInText with UTF-16 content", () => {
  const text = `primeira\r\nsegunda\r\nchave: ${KEY}\r\n`;

  it.each([
    ["UTF-16LE with BOM", { bom: true }],
    ["UTF-16LE without BOM", {}],
    ["UTF-16BE with BOM", { bigEndian: true, bom: true }],
    ["UTF-16BE without BOM", { bigEndian: true }],
  ])(
    "finds a key in %s, with line and column in characters",
    (_label, options) => {
      expect(findSecretsInText(utf16AsLatin1(text, options))).toEqual([
        { line: 3, column: 8 },
      ]);
    },
  );

  it.each([
    ["UTF-16LE", {}],
    ["UTF-16BE", { bigEndian: true }],
  ])(
    "does not count the BOM in the column of the first line (%s)",
    (_label, options) => {
      const content = utf16AsLatin1(`x ${KEY}\n`, { ...options, bom: true });

      expect(findSecretsInText(content)).toEqual([{ line: 1, column: 3 }]);
    },
  );

  it("reports a key once when the file has NUL bytes around it", () => {
    const content = `\0\xff\xfe\0${KEY}\0\x01\n\0 ${KEY}`;

    expect(findSecretsInText(content)).toEqual([
      { line: 1, column: 5 },
      { line: 2, column: 3 },
    ]);
  });

  it("finds nothing in a clean UTF-16 text", () => {
    const clean = "OPENAI_API_KEY=\r\n# sem valor real\r\n";

    expect(findSecretsInText(utf16AsLatin1(clean, { bom: true }))).toEqual([]);
  });

  it("finds nothing, quickly, in a large binary content full of NUL bytes", () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      // Every byte value, with a NUL after each one and some line breaks.
      bytes[index] = index % 2 === 0 ? (index / 2) % 256 : 0;
    }
    const startedAt = performance.now();

    const findings = findSecretsInText(bytes.toString("latin1"));

    expect(findings).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(3000);
  });

  it("finds a UTF-16 key of several megabytes", () => {
    const line = utf16AsLatin1(`x ${KEY}${"a".repeat(2 * 1024 * 1024)}`);

    expect(findSecretsInText(line)).toEqual([{ line: 1, column: 3 }]);
  });
});

// Taking every NUL byte out of a line glued unrelated strings of a binary
// together. Only bytes that alternate with NUL, as in UTF-16, are joined now.
describe("findSecretsInText with strings separated by NUL bytes", () => {
  const PREFIX = ["sk", ""].join("-");
  const tail = "a".repeat(24);

  it.each([
    ["a word that ends like the prefix", `\x01\x02task-\0${tail}\0outra\0`],
    ["the prefix alone", `\0${PREFIX}\0${tail}\0`],
    ["two strings that only add up", `${PREFIX}abcdefghij\0klmnopqrstuvwxyz\0`],
    ["NUL padding in the middle", `${PREFIX}abc\0\0\0\0${tail}\n`],
    ["a single NUL in a UTF-16 looking run", `s\0k\0-\0${tail}`],
    [
      "UTF-16 that stops being UTF-16",
      `${utf16AsLatin1(`${PREFIX}abc`)}${tail}`,
    ],
  ])("does not join the strings of a binary: %s", (_label, content) => {
    expect(findSecretsInText(content)).toEqual([]);
  });

  it.each([
    ["at an even offset", "\x7fELF\0\0\x01\x02"],
    ["at an odd offset", "\x7fELF\0\0\x01"],
  ])("still finds a UTF-16 key inside a binary, %s", (_label, header) => {
    const littleEndian = `${header}${utf16AsLatin1(`x ${KEY}`)}\0\0\xff`;
    const bigEndian = `${header}${utf16AsLatin1(`x ${KEY}`, { bigEndian: true })}\0\0\xff`;
    // Counted in characters: the NUL bytes of the line are left out.
    const column = header.replaceAll("\0", "").length + 3;

    expect(findSecretsInText(littleEndian)).toEqual([{ line: 1, column }]);
    expect(findSecretsInText(bigEndian)).toEqual([{ line: 1, column }]);
  });

  it("finds two UTF-16 keys in the same line, in order", () => {
    const content = utf16AsLatin1(`${KEY} e ${fakeOpenAiKey("B")}\r\n`);

    expect(findSecretsInText(content)).toEqual([
      { line: 1, column: 1 },
      { line: 1, column: KEY.length + 4 },
    ]);
  });
});

describe("scanRepository", () => {
  it("reports the file that holds a key and skips unreadable files", () => {
    const contents: Record<string, string | undefined> = {
      "limpo.txt": "nada aqui\n",
      "pasta/vazado.txt": `primeira linha\ntoken=${KEY}\n`,
      "apagado.txt": undefined,
    };
    const readPaths: string[] = [];

    const result = scanRepository({
      rootDir: "raiz",
      listFiles: (rootDir) => {
        expect(rootDir).toBe("raiz");
        return Object.keys(contents);
      },
      readFile: (absolutePath) => {
        readPaths.push(absolutePath);
        const name = Object.keys(contents).find(
          (file) => join("raiz", file) === absolutePath,
        );
        return name === undefined ? undefined : contents[name];
      },
    });

    expect(readPaths).toHaveLength(3);
    expect(result.scannedFiles).toBe(2);
    expect(result.findings).toEqual([
      { file: "pasta/vazado.txt", line: 2, column: 7 },
    ]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("scans a real Git folder and respects .gitignore", () => {
    const rootDir = createTemporaryFolder();
    execFileSync("git", ["init", "--quiet"], { cwd: rootDir, stdio: "ignore" });
    writeFileSync(join(rootDir, ".gitignore"), "ignorado.txt\n");
    writeFileSync(join(rootDir, "limpo.txt"), "sem credencial\n");
    writeFileSync(join(rootDir, "vazado.txt"), `a\nb\nchave ${KEY}\n`);
    writeFileSync(join(rootDir, "ignorado.txt"), `chave ${KEY}\n`);
    writeFileSync(join(rootDir, "binário çã.bin"), Buffer.from([0, 255, 10]));

    const result = scanRepository({ rootDir });

    expect(result.findings).toEqual([
      { file: "vazado.txt", line: 3, column: 7 },
    ]);
    expect(result.scannedFiles).toBe(4);
  });

  it.each([
    ["UTF-16LE with BOM", { bom: true }],
    ["UTF-16LE without BOM", {}],
    ["UTF-16BE", { bigEndian: true, bom: true }],
  ])("finds a key in a real %s file", (_label, options) => {
    const rootDir = createTemporaryFolder();
    execFileSync("git", ["init", "--quiet"], { cwd: rootDir, stdio: "ignore" });
    // What `echo "<key>" > nota.txt` writes in Windows PowerShell 5.1.
    writeFileSync(
      join(rootDir, "nota.txt"),
      Buffer.from(utf16AsLatin1(`${KEY}\r\n`, options), "latin1"),
    );
    writeFileSync(
      join(rootDir, "limpo.txt"),
      Buffer.from(utf16AsLatin1("sem credencial\r\n", options), "latin1"),
    );

    const result = scanRepository({ rootDir });

    expect(result.findings).toEqual([{ file: "nota.txt", line: 1, column: 1 }]);
    expect(result.scannedFiles).toBe(2);
  });

  it("reports a key in the path of a file, with the path redacted", () => {
    const result = scanRepository({
      rootDir: "raiz",
      listFiles: () => [
        "limpo.txt",
        `outputs/${KEY}.txt`,
        `pasta-${KEY}/vazado.txt`,
        `apagado-${KEY}.txt`,
      ],
      readFile: (absolutePath) => {
        if (absolutePath.includes("apagado")) {
          return undefined;
        }
        return absolutePath.endsWith("vazado.txt") ? `a\n${KEY}\n` : "x\n";
      },
    });

    expect(result.scannedFiles).toBe(3);
    expect(result.findings).toEqual([
      { file: "outputs/[REDACTED].txt", line: 0, column: 0, inPath: true },
      { file: "pasta-[REDACTED]/vazado.txt", line: 0, column: 0, inPath: true },
      { file: "pasta-[REDACTED]/vazado.txt", line: 2, column: 1 },
      { file: "apagado-[REDACTED].txt", line: 0, column: 0, inPath: true },
    ]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("skips a file that is in the index but no longer on disk", () => {
    const rootDir = createTemporaryFolder();
    execFileSync("git", ["init", "--quiet"], { cwd: rootDir, stdio: "ignore" });
    writeFileSync(join(rootDir, "apagado.txt"), "x\n");
    writeFileSync(join(rootDir, "fica.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: rootDir, stdio: "ignore" });
    rmSync(join(rootDir, "apagado.txt"));

    const result = scanRepository({ rootDir });

    expect(result).toEqual({ scannedFiles: 1, findings: [] });
  });

  it("fails when Git lists no file at all", () => {
    const scan = () => scanRepository({ rootDir: "raiz", listFiles: () => [] });

    expect(scan).toThrow(NoFilesScannedError);
    expect(scan).toThrow("no file was scanned (0 listed)");
  });

  it("fails when no listed file could be read", () => {
    let caught: unknown;
    try {
      // What happens when the list comes from another repository.
      scanRepository({
        rootDir: "raiz",
        listFiles: () => ["a.txt", "pasta/b.txt"],
        readFile: () => undefined,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NoFilesScannedError);
    expect(caught instanceof NoFilesScannedError && caught.listedFiles).toBe(2);
  });

  it("fails in a real Git folder where every file is ignored", () => {
    const rootDir = createTemporaryFolder();
    execFileSync("git", ["init", "--quiet"], { cwd: rootDir, stdio: "ignore" });
    writeFileSync(join(rootDir, ".gitignore"), "*\n");
    writeFileSync(join(rootDir, "nota.txt"), "sem credencial\n");

    expect(() => scanRepository({ rootDir })).toThrow(NoFilesScannedError);
  });

  it("lets a failure to list the files propagate", () => {
    expect(() =>
      scanRepository({
        rootDir: "raiz",
        listFiles: () => {
          throw new Error("git failed");
        },
      }),
    ).toThrow("git failed");
  });
});

describe("describeScanFailure", () => {
  it("blames Git only for a failure of the Git child process", () => {
    let gitError: unknown;
    try {
      listRepositoryFiles(join(createTemporaryFolder(), "nao-existe"));
    } catch (error) {
      gitError = error;
    }

    expect(describeScanFailure(gitError)).toMatch(
      /^não foi possível listar os arquivos com o Git \(.+\)\.$/,
    );
  });

  it("blames Git when it ends with a failure outside a repository", () => {
    let gitError: unknown;
    try {
      listRepositoryFiles(createTemporaryFolder());
    } catch (error) {
      gitError = error;
    }

    expect(describeScanFailure(gitError)).toMatch(
      /^não foi possível listar os arquivos com o Git \(código de saída \d+\)\.$/,
    );
  });

  it.each([
    ["a stack overflow of the engine", new RangeError(`estouro em ${KEY}`)],
    [
      "a file that cannot be read",
      Object.assign(new Error(`EACCES: ${KEY}`), { code: "EACCES" }),
    ],
    ["something that is not an error", `texto ${KEY}`],
  ])(
    "does not blame Git for %s, and never quotes the error",
    (_label, error) => {
      const message = describeScanFailure(error);

      expect(message).toContain("a varredura falhou ao examinar os arquivos (");
      expect(message).not.toContain("Git");
      expect(message).not.toContain(KEY.slice(0, 12));
    },
  );

  it("names the kind of failure", () => {
    expect(describeScanFailure(new RangeError("x"))).toContain("(RangeError)");
    expect(
      describeScanFailure(Object.assign(new Error("x"), { code: "EACCES" })),
    ).toContain("(EACCES)");
    expect(describeScanFailure(undefined)).toContain("(erro desconhecido)");
  });

  it("explains a scan that read no file", () => {
    expect(describeScanFailure(new NoFilesScannedError(3))).toContain(
      "nenhum arquivo foi varrido (o Git listou 3 arquivos)",
    );
  });
});

describe("the repository itself", () => {
  it("lists versioned files and leaves out ignored ones", () => {
    const files = listRepositoryFiles(PROJECT_ROOT);

    expect(files).toContain("package.json");
    expect(files).toContain("tests/secret-scan.test.ts");
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("logs/"))).toBe(false);
    expect(files).not.toContain(".env");
  });

  it("has no key-shaped sequence in any file that Git does not ignore", () => {
    const result = scanRepository({ rootDir: PROJECT_ROOT });

    expect(result.findings).toEqual([]);
    expect(result.scannedFiles).toBeGreaterThan(20);
  });
});

describe("findSecretsInText: other places and encodings (QA)", () => {
  it.each([
    ["UTF-16LE", {}],
    ["UTF-16BE", { bigEndian: true }],
  ])("finds the masked key of a 401 message in %s", (_label, options) => {
    const content = utf16AsLatin1(
      `erro: ${fakeMaskedOpenAiKey()}\r\n`,
      options,
    );

    expect(findSecretsInText(content)).toEqual([{ line: 1, column: 7 }]);
  });

  it("finds a UTF-16 key appended to a UTF-8 text that ends with a line break", () => {
    // What `>>` of Windows PowerShell 5.1 does to an existing UTF-8 file.
    const content = `anotações\n${utf16AsLatin1(`${KEY}\r\n`)}`;

    expect(findSecretsInText(content)).toEqual([{ line: 2, column: 1 }]);
  });

  it("finds a key inside JSON and at the end of a file with no line break", () => {
    expect(findSecretsInText(`{"a":{"k":"${KEY}"}}`)).toEqual([
      { line: 1, column: 12 },
    ]);
    expect(findSecretsInText(`linha\n${KEY}`)).toEqual([
      { line: 2, column: 1 },
    ]);
  });

  it("finds nothing in Markdown and in words that end like the prefix", () => {
    const text =
      "**negrito** e ***forte***\n- task-list, risk-based, ask-me\n***\n| task-id | *** |\n";

    expect(findSecretsInText(text)).toEqual([]);
    expect(findSecretsInText(utf16AsLatin1(text))).toEqual([]);
  });

  it("stays fast with one key in each of many lines", () => {
    const lines = 100_000;
    const startedAt = performance.now();

    expect(findSecretsInText(`${KEY}\n`.repeat(lines))).toHaveLength(lines);
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});

describe("findSecretsInText: many UTF-16 keys in a single line", () => {
  it("stays linear, with every column right", () => {
    const count = 20_000;
    const item = `${["sk", ""].join("-")}${"a".repeat(20)} `;
    const content = utf16AsLatin1(item.repeat(count));
    const startedAt = performance.now();

    const findings = findSecretsInText(content);

    expect(performance.now() - startedAt).toBeLessThan(5000);
    expect(findings).toHaveLength(count);
    expect(findings[1]).toEqual({ line: 1, column: item.length + 1 });
    expect(findings[count - 1]).toEqual({
      line: 1,
      column: (count - 1) * item.length + 1,
    });
  });
});

/** The bytes of a UTF-32 file, seen the way the scan reads them (latin1). */
function utf32AsLatin1(
  text: string,
  options: { bigEndian?: boolean; bom?: boolean } = {},
): string {
  const codePoints = [...`${options.bom === true ? "\ufeff" : ""}${text}`].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const bytes = Buffer.alloc(codePoints.length * 4);
  codePoints.forEach((codePoint, index) => {
    if (options.bigEndian === true) {
      bytes.writeUInt32BE(codePoint, index * 4);
    } else {
      bytes.writeUInt32LE(codePoint, index * 4);
    }
  });
  return bytes.toString("latin1");
}

// The UTF-16 reading only took, at an odd offset, a character whose NUL byte
// came before it: little endian text glued to an odd number of bytes was lost.
describe("findSecretsInText: UTF-16 at any offset and UTF-32", () => {
  it.each([
    ["one byte", "a"],
    ["two bytes", "ab"],
    ["three bytes", "abc"],
    ["four bytes", "abcd"],
  ])(
    "finds a UTF-16 key glued to %s of UTF-8 text with no line break",
    (_label, before) => {
      // What `>>` of Windows PowerShell 5.1 does to an existing UTF-8 file.
      const expected = [{ line: 1, column: before.length + 1 }];

      expect(findSecretsInText(before + utf16AsLatin1(`${KEY}\r\n`))).toEqual(
        expected,
      );
      expect(
        findSecretsInText(
          before + utf16AsLatin1(`${KEY}\r\n`, { bigEndian: true }),
        ),
      ).toEqual(expected);
    },
  );

  it("finds a masked UTF-16 key glued to an odd number of bytes", () => {
    const content = `abc${utf16AsLatin1(`${fakeMaskedOpenAiKey()}\r\n`)}`;

    expect(findSecretsInText(content)).toEqual([{ line: 1, column: 4 }]);
  });

  it("finds a UTF-16 key right after a character whose low byte is a line break", () => {
    // U+4E0A is the bytes 0A 4E: the line is cut in the middle of it.
    const content = utf16AsLatin1(`\u4e0a${KEY}\r\n`);

    expect(findSecretsInText(content)).toEqual([{ line: 2, column: 2 }]);
  });

  it.each([
    ["UTF-32LE", {}],
    ["UTF-32LE with BOM", { bom: true }],
    ["UTF-32BE", { bigEndian: true }],
    ["UTF-32BE with BOM", { bigEndian: true, bom: true }],
  ])("finds a key in %s, with line and column in characters", (_l, options) => {
    const content = utf32AsLatin1(
      `x ${KEY}\r\nsegunda\r\nchave: ${KEY}\r\n`,
      options,
    );

    expect(findSecretsInText(content)).toEqual([
      { line: 1, column: 3 },
      { line: 3, column: 8 },
    ]);
  });

  it.each([
    ["UTF-32LE", {}],
    ["UTF-32BE", { bigEndian: true }],
  ])("finds a masked key and a glued key in %s", (_label, options) => {
    const masked = utf32AsLatin1(`erro: ${fakeMaskedOpenAiKey()}\n`, options);
    const glued = `abc${utf32AsLatin1(`${KEY}\n`, options)}`;

    expect(findSecretsInText(masked)).toEqual([{ line: 1, column: 7 }]);
    expect(findSecretsInText(glued)).toEqual([{ line: 1, column: 4 }]);
  });

  it("reports once a key that reads the same in both byte orders", () => {
    // NUL, character, NUL, character...: big endian, or little endian at 1.
    const content = `\0${utf16AsLatin1(`${KEY} ${fakeOpenAiKey("B")}`)}`;

    expect(findSecretsInText(content)).toEqual([
      { line: 1, column: 1 },
      { line: 1, column: KEY.length + 2 },
    ]);
  });

  it.each([
    ["clean UTF-32", utf32AsLatin1("OPENAI_API_KEY=\r\n# sem valor real\r\n")],
    [
      "UTF-32 that stops being UTF-32",
      `${utf32AsLatin1(`${["sk", ""].join("-")}abc`)}${"a".repeat(24)}`,
    ],
    [
      "UTF-32 with a string after it",
      `${utf32AsLatin1(["sk", ""].join("-"))}\0${"a".repeat(24)}\0`,
    ],
    [
      "strings at an odd offset",
      `\x01${["sk", ""].join("-")}abcdefghij\0klmnopqrstuvwxyz\0`,
    ],
    ["a UTF-16 looking run at an odd offset", `\x01s\0k\0-\0${"a".repeat(24)}`],
  ])("does not join what is not a key: %s", (_label, content) => {
    expect(findSecretsInText(content)).toEqual([]);
  });
});
