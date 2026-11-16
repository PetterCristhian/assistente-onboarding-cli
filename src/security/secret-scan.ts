// Logic of `npm run check:secrets` (docs/adr/0007-protecao-da-credencial.md,
// decision 6): looks for key-shaped sequences in every file of the working
// directory that Git does not ignore. Findings never carry the value found.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSecretPattern } from "./redact.js";

export interface SecretFinding {
  file: string;
  line: number;
  column: number;
}

export function findSecretsInText(
  text: string,
): Array<{ line: number; column: number }> {
  const findings: Array<{ line: number; column: number }> = [];

  text.split("\n").forEach((lineText, index) => {
    for (const match of lineText.matchAll(createSecretPattern())) {
      findings.push({ line: index + 1, column: match.index + 1 });
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

export function scanRepository(deps: SecretScanDeps): {
  scannedFiles: number;
  findings: SecretFinding[];
} {
  const listFiles = deps.listFiles ?? listRepositoryFiles;
  const readFile = deps.readFile ?? readFileIfRegular;
  const findings: SecretFinding[] = [];
  let scannedFiles = 0;

  // No exception list: tests/ and outputs/ are scanned like everything else.
  for (const file of listFiles(deps.rootDir)) {
    const text = readFile(join(deps.rootDir, file));
    if (text === undefined) {
      continue;
    }
    scannedFiles += 1;
    for (const { line, column } of findSecretsInText(text)) {
      findings.push({ file, line, column });
    }
  }
  return { scannedFiles, findings };
}
