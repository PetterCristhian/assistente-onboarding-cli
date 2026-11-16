// Logic of `npm run check:secrets` (docs/adr/0007-protecao-da-credencial.md,
// decision 6): looks for key-shaped sequences in every file of the working
// directory that Git does not ignore, and in their paths. Findings never carry
// the value found.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findSecretSpans, redact } from "./redact.js";

export interface SecretFinding {
  /** Path relative to the root, redacted: it may hold the pattern itself. */
  file: string;
  /** 1-based. Zero when the pattern is in the path, not in the content. */
  line: number;
  column: number;
  /** Present when the pattern is in the path of the file. */
  inPath?: true;
}

// The two byte order marks of UTF-16, as they look in a latin1 string.
const UTF16_BYTE_ORDER_MARK = /^(?:\xff\xfe|\xfe\xff)/;

function findColumns(lineText: string): number[] {
  return findSecretSpans(lineText).map((span) => span.start + 1);
}

// The start of a key in UTF-16, in either byte order.
const UTF16_KEY_START = "s\0k\0-";

/**
 * Reads the line as UTF-16: keeps the bytes at the even (parity 0) or odd
 * (parity 1) positions whose pair is a NUL byte, and puts a NUL in the place
 * of the others, so that a sequence never goes across bytes that are not
 * UTF-16. The character at index i comes from the byte at parity + 2 * i.
 *
 * Parity 0 is little endian from the start of the file. Parity 1 is big
 * endian, and also little endian after the first line: the NUL byte of the
 * line break stays at the start of the next line.
 */
function readAsUtf16(lineText: string, parity: 0 | 1): string {
  let decoded = "";
  for (let index = parity; index < lineText.length; index += 2) {
    const pair = lineText[parity === 0 ? index + 1 : index - 1];
    decoded += pair === "\0" ? lineText[index] : "\0";
  }
  return decoded;
}

/** Columns in characters: the NUL bytes and the byte order mark do not count. */
function findUtf16Columns(lineText: string, isFirstLine: boolean): number[] {
  const columns: number[] = [];
  for (const parity of [0, 1] as const) {
    for (const span of findSecretSpans(readAsUtf16(lineText, parity))) {
      const before = lineText
        .slice(0, parity + 2 * span.start)
        .replaceAll("\0", "");
      columns.push(
        (isFirstLine ? before.replace(UTF16_BYTE_ORDER_MARK, "") : before)
          .length + 1,
      );
    }
  }
  return columns.sort((a, b) => a - b);
}

/**
 * Expects the content decoded as latin1 (one character per byte).
 *
 * A line with no key is looked at again as UTF-16 (what `>` writes in Windows
 * PowerShell 5.1): every ASCII character comes with a NUL byte, which hides
 * the key from the pattern. Both byte orders are tried, with or without a
 * byte order mark, without guessing the encoding of the file. Only bytes that
 * alternate with NUL are joined: strings of a binary that are merely
 * separated by NUL bytes are not glued together.
 */
export function findSecretsInText(
  text: string,
): Array<{ line: number; column: number }> {
  const findings: Array<{ line: number; column: number }> = [];

  text.split("\n").forEach((lineText, index) => {
    let columns = findColumns(lineText);
    if (columns.length === 0 && lineText.includes(UTF16_KEY_START)) {
      columns = findUtf16Columns(lineText, index === 0);
    }
    for (const column of columns) {
      findings.push({ line: index + 1, column });
    }
  });
  return findings;
}

/** Tracked files plus untracked ones that are not ignored, relative to rootDir. */
export function listRepositoryFiles(rootDir: string): string[] {
  // No shell; -z avoids quoting of paths with accents.
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return output.split("\0").filter((file) => file !== "");
}

/**
 * Reads as latin1: safe for binary files, and a key is plain ASCII. Returns
 * undefined for a file that is gone (deleted but still in the index) or that
 * is not a regular file.
 */
function readFileIfRegular(absolutePath: string): string | undefined {
  const stats = statSync(absolutePath, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) {
    return undefined;
  }
  return readFileSync(absolutePath, "latin1");
}

export interface SecretScanDeps {
  rootDir: string;
  listFiles?: (rootDir: string) => string[];
  readFile?: (absolutePath: string) => string | undefined;
}

/**
 * A scan that read nothing proves nothing: Git listed no file, or none of the
 * listed files exists under rootDir (the list came from another repository,
 * for instance through GIT_DIR).
 */
export class NoFilesScannedError extends Error {
  override readonly name = "NoFilesScannedError";

  constructor(readonly listedFiles: number) {
    super(`no file was scanned (${listedFiles} listed)`);
  }
}

function readProperty(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null && name in error
    ? (error as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Says, in Portuguese and without the text of the error (it could quote the
 * content of a file), why the scan could not run. Only a failure of the Git
 * child process is blamed on Git.
 */
export function describeScanFailure(error: unknown): string {
  if (error instanceof NoFilesScannedError) {
    return `nenhum arquivo foi varrido (o Git listou ${error.listedFiles} arquivos). A varredura não pode ser dada como limpa. Verifique se o comando roda dentro do repositório e se GIT_DIR ou GIT_WORK_TREE não apontam para outro lugar.`;
  }

  const code = readProperty(error, "code");
  const status = readProperty(error, "status");
  // What execFileSync puts in its errors: the arguments of the child process
  // when it could not start, its pid when it ended with a failure.
  if (
    readProperty(error, "spawnargs") !== undefined ||
    readProperty(error, "pid") !== undefined
  ) {
    const detail =
      typeof code === "string"
        ? code
        : typeof status === "number"
          ? `código de saída ${status}`
          : "erro desconhecido";
    return `não foi possível listar os arquivos com o Git (${detail}).`;
  }

  const name = error instanceof Error ? error.name : "erro desconhecido";
  return `a varredura falhou ao examinar os arquivos (${typeof code === "string" ? code : name}). Nenhuma conclusão pode ser tirada sobre o repositório.`;
}

/** Throws NoFilesScannedError when not a single file could be read. */
export function scanRepository(deps: SecretScanDeps): {
  scannedFiles: number;
  findings: SecretFinding[];
} {
  const listFiles = deps.listFiles ?? listRepositoryFiles;
  const readFile = deps.readFile ?? readFileIfRegular;
  const findings: SecretFinding[] = [];
  let scannedFiles = 0;

  // No exception list: tests/ and outputs/ are scanned like everything else.
  const files = listFiles(deps.rootDir);
  for (const file of files) {
    // The name of a file is as public as its content.
    const shownFile = redact(file);
    if (shownFile !== file) {
      findings.push({ file: shownFile, line: 0, column: 0, inPath: true });
    }

    const text = readFile(join(deps.rootDir, file));
    if (text === undefined) {
      continue;
    }
    scannedFiles += 1;
    for (const { line, column } of findSecretsInText(text)) {
      findings.push({ file: shownFile, line, column });
    }
  }
  if (scannedFiles === 0) {
    throw new NoFilesScannedError(files.length);
  }
  return { scannedFiles, findings };
}
