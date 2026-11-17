// The fingerprints of a battery (ADR 0006, ENG-57): one of the files of
// context/ and one of the cases, so that a result can be tied to the exact
// text that produced it. Pure: it reads nothing; the files are passed in.
//
// The text is normalized before it is hashed (no byte order mark, line breaks
// as LF, nothing trimmed), so that the same file checked out on Windows and on
// Linux has the same hash. The date that the builder injects into the context
// is not part of it: only the files are.
import { createHash } from "node:crypto";

export interface HashableFile {
  /** Relative to the context folder, with "/" or "\" as the separator. */
  readonly path: string;
  /** The text as it is on the disk. */
  readonly text: string;
}

/** The format of every fingerprint: the algorithm, a colon, 64 hex digits. */
export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

function normalize(raw: string): string {
  const withoutMark = raw.startsWith(BYTE_ORDER_MARK)
    ? raw.slice(BYTE_ORDER_MARK.length)
    : raw;
  return withoutMark.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** Ordered by code unit: the same order on every machine and locale. */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The hash of one text, normalized. Used for the file of the cases. */
export function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(normalize(text), "utf8").digest("hex")}`;
}

/**
 * The hash of a set of files, whatever the order in which they are given. Each
 * file adds its path, the length in bytes of its text and the text, each part
 * closed by a line break: no two different sets give the same stream.
 */
export function hashContextFiles(files: readonly HashableFile[]): string {
  const normalized = files
    .map((file) => ({ path: posixPath(file.path), text: normalize(file.text) }))
    .sort((a, b) => byCode(a.path, b.path));
  const hash = createHash("sha256");
  for (const file of normalized) {
    hash.update(
      `${file.path}\n${Buffer.byteLength(file.text, "utf8")}\n${file.text}\n`,
      "utf8",
    );
  }
  return `sha256:${hash.digest("hex")}`;
}
