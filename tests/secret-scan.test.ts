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
import { fakeOpenAiKey } from "./helpers/fake-key.js";

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

  it("finds nothing in a clean text", () => {
    expect(findSecretsInText("OPENAI_API_KEY=\n# sem valor real\n")).toEqual(
      [],
    );
    expect(findSecretsInText("")).toEqual([]);
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
