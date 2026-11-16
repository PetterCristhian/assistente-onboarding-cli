// Reads the content files of context/ for the structural tests. Nothing here
// knows the domain: names, addresses and subjects are always read from disk.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTEXT_ROOT = fileURLToPath(
  new URL("../../context/", import.meta.url),
);

export interface ContextFile {
  /** POSIX path from context/, such as "04-empresa/contatos.md". */
  path: string;
  content: string;
}

const CONTENT_FILE = /\.(?:md|json)$/;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/gu;
// Every cell holds at least one hyphen: a body row of empty cells is a row.
const TABLE_SEPARATOR = /^\|(?:\s*:?-+:?\s*\|)+$/;

/** Every .md and .json file under context/, as sorted POSIX paths. */
export function listContextFiles(): string[] {
  return readdirSync(CONTEXT_ROOT, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => CONTENT_FILE.test(entry))
    .sort();
}

/** The files of one folder of context/ (not of its subfolders). */
export function listContextFolder(folder: string): string[] {
  return listContextFiles().filter(
    (path) =>
      path.startsWith(`${folder}/`) &&
      !path.slice(folder.length + 1).includes("/"),
  );
}

export function readContextFile(path: string): string {
  return readFileSync(join(CONTEXT_ROOT, path), "utf8");
}

export function readContextFiles(paths: string[]): ContextFile[] {
  return paths.map((path) => ({ path, content: readContextFile(path) }));
}

/** E-mail addresses in the text, in order, repetitions included. */
export function extractEmails(text: string): string[] {
  return text.match(EMAIL) ?? [];
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** Texts of the headings of the given level, in order. */
export function headings(content: string, level: number): string[] {
  const prefix = `${"#".repeat(level)} `;
  return content
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

/** Lines under the given H2, up to the next H2 or the end of the file. */
export function sectionBody(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    throw new Error(`Section "${heading}" not found`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Cells of the body rows of the Markdown tables in the text. */
export function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  let insideTable = false;

  for (const line of text.split("\n").map((raw) => raw.trim())) {
    if (!line.startsWith("|")) {
      insideTable = false;
      continue;
    }
    // The first line of a table is its header.
    if (insideTable && !TABLE_SEPARATOR.test(line)) {
      rows.push(
        line
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim()),
      );
    }
    insideTable = true;
  }
  return rows;
}
