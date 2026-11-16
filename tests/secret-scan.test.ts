import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
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
