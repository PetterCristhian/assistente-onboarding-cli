// Structural checks for the architecture rules of CLAUDE.md that this issue
// puts in place. They read the sources as text, so a comment counts too.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { userProfileSchema } from "../src/context/types.js";
import {
  emailDomain,
  extractEmails,
  listContextFiles,
  listContextFolder,
  readContextFile,
} from "./helpers/context-files.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** TypeScript files under the given folders, as POSIX paths from the root. */
function listTypeScriptFiles(...folders: string[]): string[] {
  return folders
    .filter((folder) => existsSync(join(PROJECT_ROOT, folder)))
    .flatMap((folder) =>
      readdirSync(join(PROJECT_ROOT, folder), {
        recursive: true,
        encoding: "utf8",
      })
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => `${folder}/${entry.replaceAll("\\", "/")}`),
    )
    .sort();
}

function readSource(file: string): string {
  return readFileSync(join(PROJECT_ROOT, file), "utf8");
}

/**
 * The words that belong to the domain, read from context/ and never written
 * here: the company name (the label of the e-mail domain), the e-mail domain
 * and the people of the profiles.
 */
function domainTerms(): { company: string[]; people: string[] } {
  const domains = [
    ...new Set(
      listContextFiles()
        .flatMap((path) => extractEmails(readContextFile(path)))
        .map(emailDomain),
    ),
  ];
  const labels = domains.map((domain) => domain.split(".")[0] ?? "");
  const people = listContextFolder("03-usuario").flatMap((path) => {
    const parsed: unknown = JSON.parse(readContextFile(path));
    const { nome, gestor } = userProfileSchema.parse(parsed);
    return [nome, gestor];
  });
  return { company: [...labels, ...domains], people };
}

function filesMatching(files: string[], pattern: RegExp): string[] {
  return files.filter((file) =>
    pattern.test(readFileSync(join(PROJECT_ROOT, file), "utf8")),
  );
}

describe("architecture rules", () => {
  it("finds the source files it is supposed to check", () => {
    expect(listTypeScriptFiles("src")).toContain("src/config/env.ts");
    expect(listTypeScriptFiles("src", "evals", "scripts")).toContain(
      "scripts/check-secrets.ts",
    );
  });

  it("reads the environment only in src/config/env.ts", () => {
    const readers = filesMatching(
      listTypeScriptFiles("src"),
      /process\s*\.\s*env\b|loadEnvFile/,
    );

    expect(readers).toEqual(["src/config/env.ts"]);
  });

  it("writes the model identifier in exactly one file of src/", () => {
    const holders = filesMatching(listTypeScriptFiles("src"), /gpt-6-luna/);

    expect(holders).toEqual(["src/config/env.ts"]);
  });

  it("writes to disk only through src/security/safe-writer.ts", () => {
    const writers = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /writeFile|appendFile|createWriteStream/,
    );

    expect(writers).toEqual(["src/security/safe-writer.ts"]);
  });

  // The key is not accepted through a command-line argument. For now no file
  // of src/ reads the arguments at all. Issue 8 replaces this check by "the
  // parser declares no option for the key" and by the test of --help.
  it("does not read command-line arguments in src/", () => {
    const readers = filesMatching(
      listTypeScriptFiles("src"),
      /process\s*\.\s*argv\b|parseArgs/,
    );

    expect(readers).toEqual([]);
  });

  // Architecture rule 1: the domain exists only in context/ and in the cases.
  it("writes no company name, e-mail domain or person of a profile in the code", () => {
    const { company, people } = domainTerms();
    const files = listTypeScriptFiles("src", "scripts", "evals");

    // Guards against passing with nothing to look for or nothing to look at.
    expect(company.length).toBeGreaterThanOrEqual(2);
    expect(people.length).toBeGreaterThanOrEqual(2);
    expect(files.some((file) => file.startsWith("src/context/"))).toBe(true);
    expect(files.some((file) => file.startsWith("scripts/"))).toBe(true);

    const terms = [...company, ...people].map((term) => term.toLowerCase());
    for (const term of terms) {
      expect(term.trim().length).toBeGreaterThanOrEqual(4);
    }
    const holders = files.filter((file) => {
      const content = readSource(file).toLowerCase();
      return terms.some((term) => content.includes(term));
    });

    expect(holders).toEqual([]);
  });

  // The check above reads only TypeScript: a name in a file of another kind
  // would pass it. evals/ is left out, because its cases hold the domain.
  it("writes no company name, e-mail domain or person in any other file of src/ and scripts/", () => {
    const { company, people } = domainTerms();
    const terms = [...company, ...people].map((term) => term.toLowerCase());
    const files = ["src", "scripts"].flatMap((folder) =>
      readdirSync(join(PROJECT_ROOT, folder), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name)),
    );

    expect(terms.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeGreaterThan(0);

    const holders = files.filter((file) => {
      const content = readFileSync(file, "utf8").toLowerCase();
      return terms.some((term) => content.includes(term));
    });

    expect(holders).toEqual([]);
  });

  it("keeps the context builder pure: no disk, no clock, no environment", () => {
    const builder = readSource("src/context/builder.ts");
    const imported = [...builder.matchAll(/\bfrom\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(imported).toEqual(["./types.js"]);
    expect(builder).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\bimport\s+"/);
    expect(builder).not.toMatch(/\bprocess\b|\bDate\b|Math\s*\.\s*random/);
  });

  // The clock is a parameter: only the entry points read the real time.
  it("reads the clock in no file of src/context/", () => {
    const files = listTypeScriptFiles("src").filter((file) =>
      file.startsWith("src/context/"),
    );
    const readers = filesMatching(
      files,
      /new\s+Date\s*\(\s*\)|Date\s*\.\s*now|performance\s*\.\s*now/,
    );

    expect(files).toContain("src/context/loaders.ts");
    expect(readers).toEqual([]);
  });

  it("reads no environment and no argument in src/context/", () => {
    const files = listTypeScriptFiles("src").filter((file) =>
      file.startsWith("src/context/"),
    );

    expect(files).toContain("src/context/loaders.ts");
    expect(filesMatching(files, /\bprocess\b/)).toEqual([]);
  });
});
