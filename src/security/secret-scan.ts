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

// The byte order marks of UTF-16 and UTF-32, as they look in a latin1 string.
// The NUL bytes of the UTF-32 little endian mark are not counted anyway.
const BYTE_ORDER_MARK = /^(?:\xff\xfe|\xfe\xff|\0\0\xfe\xff)/;

function findColumns(lineText: string): number[] {
  return findSecretSpans(lineText).map((span) => span.start + 1);
}

/**
 * A way of reading the bytes of a line as text of fixed width: a character
 * takes "width" bytes, of which only the first (little endian) or the last
 * (big endian) is not a NUL byte.
 */
interface WideEncoding {
  readonly width: 2 | 4;
  readonly bigEndian: boolean;
  /** The start of a key, the same in both byte orders. */
  readonly keyStart: string;
}

const WIDE_ENCODINGS: readonly WideEncoding[] = ([2, 4] as const).flatMap(
  (width) => {
    const separator = "\0".repeat(width - 1);
    const keyStart = ["s", "k", "-"].join(separator);
    return [
      { width, bigEndian: false, keyStart },
      { width, bigEndian: true, keyStart },
    ];
  },
);

const LAST_BYTE_VALUE = 0xff;

/**
 * Reads the line in the given encoding, with the first character starting at
 * the byte "offset". A group of bytes that is not a plain character in that
 * encoding (one of the others is not a NUL byte) becomes a NUL, so that a
 * sequence never goes across bytes that are not text: strings of a binary
 * that are merely separated by NUL bytes are not glued together.
 *
 * Every offset is tried by the caller. Text does not always start at a
 * multiple of the width: the NUL bytes of a line break stay at the start of
 * the next line, and ">>" of Windows PowerShell 5.1 appends UTF-16 to a UTF-8
 * file of any length.
 */
function readWide(
  lineText: string,
  encoding: WideEncoding,
  offset: number,
): string {
  const { width, bigEndian } = encoding;
  const count = Math.max(0, Math.floor((lineText.length - offset) / width));
  // Zero filled: a group stays a NUL unless it is found to be a character.
  const decoded = Buffer.alloc(count);

  for (let unit = 0; unit < count; unit += 1) {
    const first = offset + unit * width;
    const characterAt = bigEndian ? first + width - 1 : first;
    let isCharacter = true;
    for (let index = first; index < first + width; index += 1) {
      if (index !== characterAt && lineText.charCodeAt(index) !== 0) {
        isCharacter = false;
        break;
      }
    }
    const code = lineText.charCodeAt(characterAt);
    if (isCharacter && code <= LAST_BYTE_VALUE) {
      decoded[unit] = code;
    }
  }
  return decoded.toString("latin1");
}

interface ByteSpan {
  /** Offset of the byte that holds the first character of the sequence. */
  start: number;
  end: number;
}

function findWideSpans(lineText: string): ByteSpan[] {
  const spans: ByteSpan[] = [];
  for (const encoding of WIDE_ENCODINGS) {
    if (!lineText.includes(encoding.keyStart)) {
      continue;
    }
    const { width, bigEndian } = encoding;
    for (let offset = 0; offset < width; offset += 1) {
      const toByte = (unit: number) =>
        offset + unit * width + (bigEndian ? width - 1 : 0);
      for (const span of findSecretSpans(
        readWide(lineText, encoding, offset),
      )) {
        spans.push({ start: toByte(span.start), end: toByte(span.end) });
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Columns in characters of the given byte offsets, which must be in ascending
 * order: the NUL bytes and the byte order mark do not count. The line is
 * walked only once, whatever the number of offsets.
 */
function toColumns(
  lineText: string,
  offsets: readonly number[],
  isFirstLine: boolean,
): number[] {
  const markLength = isFirstLine
    ? (BYTE_ORDER_MARK.exec(lineText)?.[0].length ?? 0)
    : 0;
  const columns: number[] = [];
  let position = markLength;
  let characters = 0;
  for (const offset of offsets) {
    for (; position < offset; position += 1) {
      if (lineText[position] !== "\0") {
        characters += 1;
      }
    }
    columns.push(characters + 1);
  }
  return columns;
}

function findWideColumns(lineText: string, isFirstLine: boolean): number[] {
  const offsets: number[] = [];
  let reportedUpTo = 0;
  for (const span of findWideSpans(lineText)) {
    // The same bytes may be a key in more than one reading (NUL, character,
    // NUL... is big endian, and little endian one byte later): reported once.
    if (span.start >= reportedUpTo) {
      offsets.push(span.start);
      reportedUpTo = span.end;
    }
  }
  return toColumns(lineText, offsets, isFirstLine);
}

/**
 * Expects the content decoded as latin1 (one character per byte).
 *
 * A line with no key is looked at again as UTF-16 (what `>` writes in Windows
 * PowerShell 5.1) and as UTF-32: every ASCII character comes with one or
 * three NUL bytes, which hide the key from the pattern. Both byte orders are
 * tried at every offset, with or without a byte order mark, without guessing
 * the encoding of the file. Only bytes that alternate with NUL are joined:
 * strings of a binary that are merely separated by NUL bytes are not glued
 * together.
 */
export function findSecretsInText(
  text: string,
): Array<{ line: number; column: number }> {
  const findings: Array<{ line: number; column: number }> = [];

  text.split("\n").forEach((lineText, index) => {
    let columns = findColumns(lineText);
    if (columns.length === 0) {
      columns = findWideColumns(lineText, index === 0);
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
