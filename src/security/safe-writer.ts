// The only disk writer for outputs/ and logs/ (CLAUDE.md, architecture rule 4).
// Every text goes through the redactor before it reaches the disk.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  redact: Redactor;
  /** Default: the project root, wherever the cwd is. */
  rootDir?: string;
}

const ALLOWED_TOP_LEVEL_DIRECTORIES = ["outputs", "logs"];

function serialize(value: unknown, indentation?: number): string {
  const json: unknown = JSON.stringify(value, null, indentation);
  if (typeof json !== "string") {
    throw new Error("O valor informado não pode ser convertido em JSON.");
  }
  return `${json}\n`;
}

export function createSafeWriter(options: SafeWriterOptions): SafeWriter {
  const rootDir = resolve(
    options.rootDir ?? fileURLToPath(new URL("../../", import.meta.url)),
  );

  function resolveTarget(relativePath: string): string {
    const absolutePath = resolve(rootDir, relativePath);
    const segments = relative(rootDir, absolutePath).split(sep);
    const topLevel = segments[0] ?? "";

    if (
      isAbsolute(relativePath) ||
      !ALLOWED_TOP_LEVEL_DIRECTORIES.includes(topLevel) ||
      segments.length < 2
    ) {
      throw new Error(
        `Caminho de escrita não permitido: "${relativePath}". O escritor só grava em outputs/ e logs/.`,
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
    const safeContent = options.redact(content);

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
    // Redaction runs on the final text, after JSON.stringify.
    writeJson: (relativePath, value) =>
      write(relativePath, serialize(value, 2), "overwrite"),
    appendJsonLine: (relativePath, value) =>
      write(relativePath, serialize(value), "append"),
  };
}
