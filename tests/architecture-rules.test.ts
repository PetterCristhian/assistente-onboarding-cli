// Structural checks for the architecture rules of CLAUDE.md that this issue
// puts in place. They read the sources as text, so a comment counts too.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { HELP_TEXT, parseCliArgs } from "../src/cli/args.js";
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

  // Architecture rule 2: one path to the provider, always inside withRetry.
  it("imports the SDK of the provider only in src/llm/client.ts", () => {
    const importers = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]openai(?:\/[^"'`]*)?["'`]/,
    );

    expect(importers).toEqual(["src/llm/client.ts"]);
  });

  it("creates the SDK client only in src/llm/client.ts, with its own retry turned off", () => {
    const creators = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /\bnew\s+OpenAI\b/,
    );
    const client = readSource("src/llm/client.ts");

    expect(creators).toEqual(["src/llm/client.ts"]);
    expect(client.match(/\bnew\s+OpenAI\b/g)).toHaveLength(1);
    expect(client).toMatch(/\bmaxRetries: 0,/);
    expect(client.match(/\bmaxRetries\b/g)).toHaveLength(1);
  });

  /** The text of a function of client.ts, from its header to its closing brace. */
  function functionBody(source: string, header: RegExp): string {
    const start = header.exec(source);
    expect(start).not.toBeNull();
    const from = start?.index ?? 0;
    const end = source.indexOf("\n  }\n", from);
    expect(end).toBeGreaterThan(from);
    return source.slice(from, end);
  }

  it("wraps every call of the SDK client in withRetry, in one place (runCall)", () => {
    const client = readSource("src/llm/client.ts");
    const runCall = functionBody(client, /\n {2}function runCall</);

    expect(client.match(/\bwithRetry\(/g)).toHaveLength(1);
    expect(runCall).toMatch(/\bwithRetry\(/);
    expect(
      client.match(/\bsdk\s*\.\s*responses\s*\.\s*create\b/g),
    ).toHaveLength(2);
    for (const header of [
      /\n {2}function streamText\(/,
      /\n {2}function generateStructured</,
    ]) {
      const body = functionBody(client, header);

      expect(body).toMatch(/\brunCall\(/);
      expect(body).not.toMatch(/\bwithRetry\(|\bwithDeadline\(|\bsdk\b/);
    }
  });

  // The smoke test is the registered exception to withRetry (ADR 0002,
  // decision 11): it makes one try per call, on purpose.
  it("creates the real client only in the chat entry point and in the smoke test", () => {
    const callers = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /\bcreateOpenAiLlmClient\s*\(/,
    ).filter((file) => file !== "src/llm/client.ts");

    expect(callers).toEqual(["scripts/smoke-llm.ts", "src/cli/main.ts"]);
    expect(readSource("scripts/smoke-llm.ts")).toMatch(/retryMaxAttempts: 0\b/);
  });

  // The limiter is created in one place, so that the policy (refuse or wait) is
  // chosen by the entry point and not by the pipeline.
  it("creates the rate limiter only in the chat entry point", () => {
    const creators = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /\bcreateRateLimiter\s*\(/,
    ).filter((file) => file !== "src/chat/rate-limiter.ts");

    expect(creators).toEqual(["src/cli/main.ts"]);
  });

  it("imports errors.ts before client.ts without breaking the cycle between them", async () => {
    vi.resetModules();
    const errors = await import("../src/llm/errors.js");
    const client = await import("../src/llm/client.js");

    expect(errors.classifyError(new client.APIUserAbortError()).kind).toBe(
      "cancelled",
    );
  });

  // ADR 0002, decision 6: the model does not document these parameters.
  it("names no sampling parameter in src/llm/", () => {
    const files = listTypeScriptFiles("src").filter((file) =>
      file.startsWith("src/llm/"),
    );

    expect(files).toContain("src/llm/client.ts");
    expect(filesMatching(files, /\btemperature\b|\btop_p\b|\bseed\b/i)).toEqual(
      [],
    );
  });

  it("writes to disk only through src/security/safe-writer.ts", () => {
    const writers = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /writeFile|appendFile|createWriteStream/,
    );

    expect(writers).toEqual(["src/security/safe-writer.ts"]);
  });

  // The session is reusable by the battery: no terminal, no disk, no node:.
  it("keeps src/chat/ free of terminal, process, disk and node: modules", () => {
    const files = listTypeScriptFiles("src").filter((file) =>
      file.startsWith("src/chat/"),
    );

    expect(files).toContain("src/chat/session.ts");
    expect(files).toContain("src/chat/rate-limiter.ts");
    expect(
      filesMatching(files, /readline|\bprocess\b|\bconsole\b|node:/),
    ).toEqual([]);
    expect(
      filesMatching(
        ["src/chat/session.ts"],
        /writeFile|appendFile|createWriteStream/,
      ),
    ).toEqual([]);
  });

  // Architecture rule 5: one writer of the history, and it runs once per turn.
  it("writes to the history in one place of the session, once", () => {
    const session = readSource("src/chat/session.ts");

    expect(session.match(/\bhistory\s*\.\s*push\(/g)).toHaveLength(1);
    expect(session.match(/\bcommitTurn\(/g)).toHaveLength(2);
    expect(
      filesMatching(
        listTypeScriptFiles("src").filter(
          (file) => file !== "src/chat/session.ts",
        ),
        /\bhistory\s*\.\s*push\(/,
      ),
    ).toEqual([]);
  });

  // The slot of the limit is taken once per question, by the session; the
  // evaluation and the revision are part of the same question.
  it("takes the slot of the rate limit once in the session and never in the critique", () => {
    const session = readSource("src/chat/session.ts");
    const critique = readSource("src/chat/critique.ts");

    expect(session.match(/\bawait\s+takeRateLimitSlot\(/g)).toHaveLength(1);
    expect(critique).not.toMatch(/rate-limiter|RateLimiter|\bacquire\b/);
  });

  it("keeps the critique pure: no disk, no clock, no environment", () => {
    const critique = readSource("src/chat/critique.ts");
    const imported = [...critique.matchAll(/\bfrom\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(imported).toEqual([
      "zod",
      "../context/types.js",
      "../llm/client.js",
      "../security/error-summary.js",
      "../security/redact.js",
    ]);
    expect(critique).not.toMatch(/\bDate\b|Math\s*\.\s*random|\bawait\b/);
  });

  // The limiter has no clock, no timer and no import: all of it is a parameter.
  it("keeps the rate limiter pure: no clock, no timer, no environment, no import", () => {
    const limiter = readSource("src/chat/rate-limiter.ts");

    expect(limiter).not.toMatch(
      /\bprocess|\bDate\b|\bperformance\b|\bsetTimeout\b|\bsetInterval\b/,
    );
    expect(limiter).not.toMatch(/\bimport\b|\brequire\s*\(/);
  });

  it("reads the terminal input only in src/cli/", () => {
    const readers = filesMatching(listTypeScriptFiles("src"), /readline/);

    expect(readers.length).toBeGreaterThan(0);
    expect(readers.every((file) => file.startsWith("src/cli/"))).toBe(true);
  });

  // The key is not accepted through a command-line argument: one file parses
  // the arguments, one file reads them, and the parser has no option for it.
  it("reads the arguments only in src/cli/main.ts and parses them only in src/cli/args.ts", () => {
    const files = listTypeScriptFiles("src");

    expect(filesMatching(files, /process\s*\.\s*argv\b/)).toEqual([
      "src/cli/main.ts",
    ]);
    expect(filesMatching(files, /parseArgs/)).toEqual(["src/cli/args.ts"]);
  });

  it("declares no option for the key in the parser", () => {
    const source = readSource("src/cli/args.ts");
    const block = /OPTION_DEFINITIONS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(
      source,
    );
    const names = [
      ...(block?.[1] ?? "").matchAll(/^\s*"?([\w-]+)"?\s*:\s*\{/gm),
    ].map((match) => match[1] ?? "");

    expect(names).toEqual(
      expect.arrayContaining(["system-prompt", "perfil", "context-dir"]),
    );
    for (const name of names) {
      expect(name).not.toMatch(
        /key|chave|token|secret|senha|password|credential/i,
      );
    }
    expect(parseCliArgs(["--api-key", "x"]).kind).toBe("error");
    expect(HELP_TEXT).not.toMatch(/--api-key|--chave|--key/);
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
