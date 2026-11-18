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
  /**
   * Exact relative paths under docs/, outside outputs/ and logs/, that this
   * writer may also write (a generated document such as
   * docs/CASOS-DE-TESTE.md), by overwrite only (writeText): never appended to
   * and never as JSON. Compared as written: no other spelling of the same file
   * is accepted. Symlinks and junctions in docs/ are not checked (the same
   * limit as outputs/). Default: none.
   */
  extraFiles?: readonly string[];
}

// data/ holds the sessions and the memories of the chat (ignored by Git).
const ALLOWED_TOP_LEVEL_DIRECTORIES = ["outputs", "logs", "data"];
const EXTRA_FILES_PREFIX = "docs/";

const NOT_SERIALIZABLE_MESSAGE =
  "O valor informado não pode ser convertido em JSON.";

/**
 * Redacts every string before it is escaped by JSON.stringify: an escape
 * (a line break written as "\n", a quote as '\"') changes what comes before
 * and inside a secret, and the redaction of the final text alone could miss
 * it. Used as the replacer, so it sees exactly what is going to be written
 * (after toJSON) and changes nothing about what can or cannot be serialized.
 */
function createStringRedactor(redactText: Redactor) {
  return (_name: string, value: unknown): unknown => {
    if (typeof value === "string") {
      return redactText(value);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    // The names of the properties are strings too. The object is only
    // copied when a name changes; its values are visited next, by
    // JSON.stringify itself, which also still finds a circular reference.
    const names = Object.keys(value);
    const safeNames = names.map(redactText);
    if (safeNames.every((safeName, index) => safeName === names[index])) {
      return value;
    }
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    names.forEach((name, index) => {
      // defineProperty: a name such as "__proto__" stays an own property.
      Object.defineProperty(copy, safeNames[index] ?? name, {
        value: source[name],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return copy;
  };
}

function serialize(
  value: unknown,
  redactText: Redactor,
  indentation?: number,
): string {
  let json: unknown;
  try {
    json = JSON.stringify(value, createStringRedactor(redactText), indentation);
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

  const extraFiles = new Set(options.extraFiles ?? []);
  for (const extra of extraFiles) {
    const parts = extra.split(/[\\/]/);
    if (
      extra === "" ||
      // Only the generated documents folder: never src/, .git/, .github/ or
      // the root. The exact prefix, in the spelling that was written.
      !extra.startsWith(EXTRA_FILES_PREFIX) ||
      isAbsolute(extra) ||
      // A drive ("Y:docs/x.md", relative to the drive's cwd) or an alternate
      // data stream: neither stays inside the root.
      extra.includes(":") ||
      parts.length < 2 ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(
        "extraFiles aceita só caminhos relativos normalizados dentro de docs/, sem ':' e sem subir de pasta.",
      );
    }
  }

  // The writer does not trust the redactor it receives: whatever it does (or
  // fails to do), the key-shaped pattern is applied last.
  const applyRedaction: Redactor = (text) =>
    redactBasePattern(options.redact(text));

  function resolveTarget(relativePath: string, allowExtra: boolean): string {
    // A file name is as public as the content: outputs/ is versioned.
    const shownPath = applyRedaction(relativePath);
    if (shownPath !== relativePath) {
      throw new Error(
        "Caminho de escrita não permitido: o caminho contém uma possível credencial (o valor não é exibido). Nada foi gravado.",
      );
    }

    const absolutePath = resolve(rootDir, relativePath);
    // An extra file is accepted only when the text is exactly one of them, and
    // only by overwrite of plain text; otherwise it falls to the check below,
    // which refuses it (it is outside outputs/ and logs/).
    if (allowExtra && extraFiles.has(relativePath)) {
      return absolutePath;
    }
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
    allowExtra = false,
  ): Promise<string> {
    const absolutePath = resolveTarget(relativePath, allowExtra);
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
      write(relativePath, content, "overwrite", true),
    appendText: (relativePath, content) =>
      write(relativePath, content, "append"),
    // Redaction runs twice: on every string before JSON.stringify, and on
    // the final text in write(). Both are async so that a value that cannot
    // be serialized rejects instead of throwing.
    writeJson: async (relativePath, value) =>
      write(relativePath, serialize(value, applyRedaction, 2), "overwrite"),
    appendJsonLine: async (relativePath, value) =>
      write(relativePath, serialize(value, applyRedaction), "append"),
  };
}
