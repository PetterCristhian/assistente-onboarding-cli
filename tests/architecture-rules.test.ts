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

/** Drops block comments and the comments that start a line or follow a space. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
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

  // The smoke test is the only exception to withRetry (ADR 0002, decision 11):
  // it makes one try per call, on purpose. The demonstration of failures is NOT
  // an exception: it uses the same client, so the retry that it shows is the
  // retry of the chat (ADR 0005, decision 24).
  it("creates the real client only in the entry points: the chat, the battery, the smoke test and the demo", () => {
    const callers = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /\bcreateOpenAiLlmClient\s*\(/,
    ).filter((file) => file !== "src/llm/client.ts");

    expect(callers).toEqual([
      "scripts/comparacao-memoria.ts",
      "scripts/demo-falhas/run.ts",
      "scripts/eval.ts",
      "scripts/smoke-llm.ts",
      "src/cli/main.ts",
    ]);
    expect(readSource("scripts/smoke-llm.ts")).toMatch(/retryMaxAttempts: 0\b/);
  });

  // ENG-54: what the demonstration shows is the retry of the chat, against a
  // simulated provider reached only through the base URL. Nothing of the retry
  // is copied, nothing is read from the environment, and the disk is written
  // only by the safe writer.
  describe("the demonstration of failures (scripts/demo-falhas*)", () => {
    const files = listTypeScriptFiles("scripts").filter((file) =>
      file.startsWith("scripts/demo-falhas"),
    );

    it("is made of the entry point and the folder with its pieces", () => {
      expect(files).toEqual([
        "scripts/demo-falhas.ts",
        "scripts/demo-falhas/config.ts",
        "scripts/demo-falhas/loopback-fetch.ts",
        "scripts/demo-falhas/observe.ts",
        "scripts/demo-falhas/report.ts",
        "scripts/demo-falhas/run.ts",
        "scripts/demo-falhas/scenarios.ts",
        "scripts/demo-falhas/stub-server.ts",
      ]);
    });

    it("does not copy the retry, turn it off, read the environment or write to the disk", () => {
      const forbidden = [
        /retryMaxAttempts\s*:\s*0\b/,
        /\bwithRetry\(/,
        /\bcomputeDelay\b/,
        /\bprocess\s*\.\s*env\b/,
        /\bloadConfig\b/,
        /\bloadEnvFile\b/,
        /writeFile|appendFile|createWriteStream/,
        /\bnew\s+OpenAI\b/,
      ];

      for (const pattern of forbidden) {
        expect([pattern.source, filesMatching(files, pattern)]).toEqual([
          pattern.source,
          [],
        ]);
      }
    });

    it("reaches the simulated provider through the base URL and waits with the wait of the chat", () => {
      const run = readSource("scripts/demo-falhas/run.ts");

      expect(run).toMatch(/\bbaseURL\b/);
      expect(run).toMatch(/\bdefaultSleep\b/);
      expect(run).toMatch(/from\s+"\.\.\/\.\.\/src\/llm\/retry\.js"/);
      expect(run.match(/\bcreateOpenAiLlmClient\s*\(/g)).toHaveLength(1);
    });

    it("keeps the entry point to wiring: no server, no socket, no scenario logic", () => {
      const entry = readSource("scripts/demo-falhas.ts");

      expect(entry).not.toMatch(/node:http|node:net|\bhttp\b|\bnet\b/);
      expect(entry).not.toMatch(/\bprocess\s*\.\s*exit\s*\(/);
      expect(entry).toMatch(/\bprocess\.exitCode\b/);
      expect(entry).toMatch(/\bcreateSafeWriter\b/);
      expect(entry).toMatch(/\bAbortController\b/);
      expect(entry).toMatch(/\bSIGINT\b/);
    });
  });

  // The limiter is created in one place per entry point, so that the policy
  // (refuse or wait) is chosen by the entry point and not by the pipeline.
  it("creates the rate limiter only in the chat entry point and in the battery", () => {
    const creators = filesMatching(
      listTypeScriptFiles("src", "evals", "scripts"),
      /\bcreateRateLimiter\s*\(/,
    ).filter((file) => file !== "src/chat/rate-limiter.ts");

    expect(creators).toEqual(["evals/cli.ts", "src/cli/main.ts"]);
  });

  // ENG-56: the battery is the second border. It runs the pipeline of the chat
  // and has no pipeline of its own; its entry point only wires the real pieces.
  describe("the battery (evals/ and scripts/eval.ts)", () => {
    const files = listTypeScriptFiles("evals");

    it("is made of the pieces that the plan names", () => {
      expect(files).toEqual(
        expect.arrayContaining([
          "evals/aggregate.ts",
          "evals/args.ts",
          "evals/battery-id.ts",
          "evals/cases-doc-cli.ts",
          "evals/cases-doc.ts",
          "evals/cli.ts",
          "evals/collector.ts",
          "evals/context-hash.ts",
          "evals/contexts.ts",
          "evals/judge.ts",
          "evals/markdown.ts",
          "evals/record.ts",
          "evals/redact-lines.ts",
          "evals/report.ts",
          "evals/retry-count.ts",
          "evals/runner.ts",
          "evals/verdict.ts",
        ]),
      );
    });

    it("calls the model client only in the judge and in the decorator that counts the new tries", () => {
      const callers = filesMatching(
        files,
        /\.\s*(?:streamText|generateStructured)\s*\(/,
      );

      expect(callers).toEqual(["evals/judge.ts", "evals/retry-count.ts"]);
    });

    // ENG-57: the judge goes through the same client as the chatbot (rule 2),
    // so the retry, the deadline and the cancellation are the same. It never
    // creates a client nor retries, and it names its model.
    it("keeps the judge on the one path to the provider, with its own model", () => {
      const judge = readSource("evals/judge.ts");

      expect(judge).not.toMatch(/["']openai["'/]/);
      expect(judge).not.toMatch(/\bwithRetry\b|\bcreateOpenAiLlmClient\b/);
      expect(judge).not.toMatch(/\bnew\s+OpenAI\b/);
      expect(judge).toMatch(/\bcreateRetryCounter\b/);
      expect(filesMatching(files, /\bgpt-[\w.-]+/)).toEqual([]);
    });

    it("runs the turns through createChatSession, with the clock always passed", () => {
      const runner = readSource("evals/runner.ts");

      expect(runner).toMatch(
        /import\s*\{[^}]*\bcreateChatSession\b[^}]*\}\s*from\s*"\.\.\/src\/chat\/session\.js"/,
      );
      expect(runner.match(/\bcreateChatSession\(/g)).toHaveLength(1);
      expect(runner).toMatch(/\bnow: deps\.now\b/);
      expect(runner).not.toMatch(/\bonTurn\b|new\s+Date\s*\(/);
    });

    it("does not write the log of a chat session, nor read the environment, the process, the clock or the disk", () => {
      expect(filesMatching(files, /logging\/session-log/)).toEqual([]);
      expect(filesMatching(files, /\bprocess\b|loadEnvFile/)).toEqual([]);
      expect(filesMatching(files, /node:fs|from\s+["']fs["']/)).toEqual([]);
      // node:crypto is allowed (the hashes): it neither reads nor writes.
      expect(
        filesMatching(
          files,
          /new\s+Date\s*\(|Date\s*\.\s*now|performance\s*\.\s*now/,
        ),
      ).toEqual([]);
      expect(
        filesMatching(files, /writeFile|appendFile|createWriteStream/),
      ).toEqual([]);
    });

    it("writes only through the safe writer, and only to outputs/", () => {
      expect(filesMatching(files, /\bappendJsonLine\(/)).toEqual([
        "evals/cli.ts",
        "evals/runner.ts",
      ]);
      expect(readSource("evals/runner.ts")).toMatch(
        /\bOUTPUTS_FOLDER = "outputs"/,
      );
    });

    // ENG-57 part 2: the summary and the report are written once, by the
    // runner, through the writer (the CLI only wraps its failures). The
    // aggregator, the renderer and the sanitizers are pure: they hold no writer.
    it("writes the summary and the report only in the runner, and keeps the pure pieces pure", () => {
      // cases-doc-cli.ts writes docs/CASOS-DE-TESTE.md, never outputs/.
      expect(filesMatching(files, /\.\s*(?:writeJson|writeText)\(/)).toEqual([
        "evals/cases-doc-cli.ts",
        "evals/cli.ts",
        "evals/runner.ts",
      ]);
      const pure = [
        "evals/aggregate.ts",
        "evals/cases-doc.ts",
        "evals/markdown.ts",
        "evals/redact-lines.ts",
        "evals/report.ts",
      ];
      for (const file of pure) {
        const source = readSource(file);
        expect(source, file).not.toMatch(/safe-writer|SafeWriter|node:/);
        expect(source, file).not.toMatch(/\bsleep\b|Math\.random/);
      }
      // The whole family of pure pieces: no clock, no environment, no disk.
      // A mention in a comment does not count; Date.parse is allowed (it reads
      // a string, not the clock), and node:crypto is the hashes' one import.
      for (const file of [
        ...pure,
        "evals/context-hash.ts",
        "evals/verdict.ts",
        "evals/record.ts",
      ]) {
        const source = withoutComments(readSource(file));
        expect(source, file).not.toMatch(
          /new\s+Date\s*\(|Date\s*\.\s*now|performance\s*\.\s*now/,
        );
        expect(source, file).not.toMatch(/\bprocess\s*\.\s*env\b/);
        expect(source, file).not.toMatch(/node:(?!crypto["'])/);
        expect(source, file).not.toMatch(/safe-writer|SafeWriter/);
      }
      // No regeneration: nothing reads the files back to render them again.
      expect(filesMatching(files, /readFile|readdir|existsSync/)).toEqual([]);
    });

    it("keeps the entry point to wiring: no logic, no process.exit, Ctrl+C by AbortController", () => {
      const entry = readSource("scripts/eval.ts");

      expect(entry).not.toMatch(/\b(?:if|for|while|switch)\s*\(/);
      // Wiring only: short, no ternary and no list handling.
      expect(entry.split("\n").length).toBeLessThanOrEqual(60);
      expect(entry).not.toMatch(/\s\?\s[^?]*\s:\s/);
      expect(entry).not.toMatch(/\.\s*(?:map|filter|reduce|flatMap)\s*\(/);
      expect(entry).not.toMatch(/\bprocess\s*\.\s*exit\s*\(/);
      expect(entry).toMatch(/\bprocess\.exitCode\b/);
      expect(entry).toMatch(/\bAbortController\b/);
      expect(entry).toMatch(/\bSIGINT\b/);
      expect(entry).toMatch(/\brunEvalCli\b/);
      expect(entry).not.toMatch(/\bcreateSafeWriter\b|\bwithRetry\b/);
      expect(entry).not.toMatch(/\bprocess\s*\.\s*env\b|loadEnvFile/);
    });

    // The writer is used by its name only where it is meant to be: taking a
    // method out of it (a destructuring or a string key) would slip past the
    // `.writeJson(` checks above.
    it("does not take a method out of the writer outside the runner and the CLIs", () => {
      const methods = "writeJson|writeText|appendJsonLine|appendText";
      const holders = filesMatching(
        files,
        new RegExp(
          `\\{[^}]*\\b(?:${methods})\\b[^}]*\\}\\s*=[^=>]|\\[\\s*["'\`](?:${methods})["'\`]\\s*\\]`,
        ),
      );

      expect(
        holders.filter(
          (file) =>
            ![
              "evals/cases-doc-cli.ts",
              "evals/cli.ts",
              "evals/runner.ts",
            ].includes(file),
        ),
      ).toEqual([]);
    });

    // ENG-57 part 3: the one exception to "the writer only writes outputs/ and
    // logs/" is the generated catalog, and only the casos:doc entry opts in.
    describe("npm run casos:doc", () => {
      it("keeps the entry point to wiring: no logic, no process.exit", () => {
        const entry = readSource("scripts/casos-doc.ts");

        expect(entry).not.toMatch(/\b(?:if|for|while|switch)\s*\(/);
        expect(entry.split("\n").length).toBeLessThanOrEqual(30);
        expect(entry).not.toMatch(/\s\?\s[^?]*\s:\s/);
        expect(entry).not.toMatch(/\.\s*(?:map|filter|reduce|flatMap)\s*\(/);
        expect(entry).not.toMatch(/\bprocess\s*\.\s*exit\s*\(/);
        expect(entry).toMatch(/\bprocess\.exitCode\b/);
        expect(entry).toMatch(/\brunCasesDocCli\b/);
        expect(entry).not.toMatch(/\bprocess\s*\.\s*env\b|loadEnvFile/);
        expect(entry).not.toMatch(/writeFile|createSafeWriter/);
      });

      it("creates its writer with exactly the one extra file", () => {
        const cli = readSource("evals/cases-doc-cli.ts");

        expect(
          filesMatching(
            listTypeScriptFiles("src", "evals", "scripts"),
            /\bcreateSafeWriter\s*\(/,
          ).filter((file) => file.includes("cases-doc")),
        ).toEqual(["evals/cases-doc-cli.ts"]);
        expect(cli.match(/\bextraFiles\s*:/g)).toHaveLength(1);
        expect(cli).toMatch(/\bextraFiles: \[CASES_DOC_FILE\]/);
        expect(readSource("evals/cases-doc.ts")).toMatch(
          /\bCASES_DOC_FILE = "docs\/CASOS-DE-TESTE\.md";/,
        );
      });

      it("mentions extraFiles only in the safe writer and in the casos:doc entry", () => {
        expect(
          filesMatching(
            listTypeScriptFiles("src", "evals", "scripts"),
            /\bextraFiles\b/,
          ),
        ).toEqual(["evals/cases-doc-cli.ts", "src/security/safe-writer.ts"]);
      });

      it("keeps the document renderer free of the disk, the process and the clock", () => {
        for (const file of ["evals/cases-doc.ts"]) {
          const source = readSource(file);

          expect(source, file).not.toMatch(/node:|\bprocess\b|safe-writer/);
          expect(source, file).not.toMatch(
            /new\s+Date\s*\(|Date\s*\.\s*now|performance\s*\.\s*now/,
          );
        }
      });
    });

    it("has no option for the key in the parser", () => {
      const source = readSource("evals/args.ts");
      const block = /OPTION_DEFINITIONS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(
        source,
      );
      const names = [
        ...(block?.[1] ?? "").matchAll(/^\s*"?([\w-]+)"?\s*:\s*\{/gm),
      ].map((match) => match[1] ?? "");

      expect(names).toEqual(["runs", "case", "help"]);
    });
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

  // The log is written by the single safe writer; this folder has no disk and
  // no clock of its own.
  it("keeps src/logging/ free of the disk and of the clock", () => {
    const files = listTypeScriptFiles("src").filter((file) =>
      file.startsWith("src/logging/"),
    );

    expect(files).toContain("src/logging/session-log.ts");
    expect(
      filesMatching(
        files,
        /node:fs|from\s+["']fs["']|writeFile|appendFile|createWriteStream|new\s+Date\s*\(|Date\s*\.\s*now|performance\s*\.\s*now/,
      ),
    ).toEqual([]);
    expect(filesMatching(files, /\bprocess\b|\bconsole\b/)).toEqual([]);
    expect(readSource("src/logging/session-log.ts")).toMatch(
      /\bwriter\s*\.\s*appendJsonLine\(/,
    );
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
