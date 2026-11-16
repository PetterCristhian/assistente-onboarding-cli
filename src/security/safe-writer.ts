// The only disk writer for outputs/ and logs/ (CLAUDE.md, architecture rule 4).
// Every text goes through the redactor before it reaches the disk.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redact as redactBasePattern } from "./redact.js";
import type { Redactor } from "./redact.js";

export interface SafeWriter {
  /** Creates the folders and overwrites the file. Returns the absolute path. */
  writeText(relativePath: string, content: string): Promise<string>;
  /** Creates the folders and appends to the file. Returns the absolute path. */
  appendText(relativePath: string, content: string): Promise<string>;
  /** Writes indented JSON ending with a line break. */
  writeJson(relativePath: string, value: unknown): Promise<string>;
  /** Appends one JSON document in a single line (JSON Lines). */
  appendJsonLine(relativePath: string, value: unknown): Promise<string>;
}

export interface SafeWriterOptions {
  /** Usually createRedactor([key in use]). The base pattern always applies. */
  redact: Redactor;
  /** Default: the project root, wherever the cwd is. */
  rootDir?: string;
}

const ALLOWED_TOP_LEVEL_DIRECTORIES = ["outputs", "logs"];

const NOT_SERIALIZABLE_MESSAGE =
  "O valor informado não pode ser convertido em JSON.";

function serialize(value: unknown, indentation?: number): string {
  let json: unknown;
  try {
    json = JSON.stringify(value, null, indentation);
  } catch {
    // BigInt, circular reference, a toJSON that throws. The original error is
    // dropped on purpose: its text is in English and may quote the value.
    throw new Error(NOT_SERIALIZABLE_MESSAGE);
  }
  // undefined, a function or a symbol: JSON.stringify returns undefined.
  if (typeof json !== "string") {
    throw new Error(NOT_SERIALIZABLE_MESSAGE);
  }
  return `${json}\n`;
}

export function createSafeWriter(options: SafeWriterOptions): SafeWriter {
  const rootDir = resolve(
    options.rootDir ?? fileURLToPath(new URL("../../", import.meta.url)),
  );

  // The writer does not trust the redactor it receives: whatever it does (or
  // fails to do), the key-shaped pattern is applied last.
  const applyRedaction: Redactor = (text) =>
    redactBasePattern(options.redact(text));

  function resolveTarget(relativePath: string): string {
    // A file name is as public as the content: outputs/ is versioned.
    const shownPath = applyRedaction(relativePath);
    if (shownPath !== relativePath) {
      throw new Error(
        "Caminho de escrita não permitido: o caminho contém uma possível credencial (o valor não é exibido). Nada foi gravado.",
      );
    }

    const absolutePath = resolve(rootDir, relativePath);
    const segments = relative(rootDir, absolutePath).split(sep);
    const topLevel = segments[0] ?? "";

    if (
      isAbsolute(relativePath) ||
      !ALLOWED_TOP_LEVEL_DIRECTORIES.includes(topLevel) ||
      segments.length < 2
    ) {
      throw new Error(
        `Caminho de escrita não permitido: "${shownPath}". O escritor só grava em outputs/ e logs/.`,
      );
    }
    return absolutePath;
  }

  async function write(
    relativePath: string,
    content: string,
    mode: "overwrite" | "append",
  ): Promise<string> {
    const absolutePath = resolveTarget(relativePath);
    const safeContent = applyRedaction(content);

    await mkdir(dirname(absolutePath), { recursive: true });
    if (mode === "append") {
      await appendFile(absolutePath, safeContent, "utf8");
    } else {
      await writeFile(absolutePath, safeContent, "utf8");
    }
    return absolutePath;
  }

  return {
    writeText: (relativePath, content) =>
      write(relativePath, content, "overwrite"),
    appendText: (relativePath, content) =>
      write(relativePath, content, "append"),
    // Redaction runs on the final text, after JSON.stringify. Both are async
    // so that a value that cannot be serialized rejects instead of throwing.
    writeJson: async (relativePath, value) =>
      write(relativePath, serialize(value, 2), "overwrite"),
    appendJsonLine: async (relativePath, value) =>
      write(relativePath, serialize(value), "append"),
  };
}
