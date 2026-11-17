// The log of the session (ENG-53): one JSON line per turn, through the single
// safe writer, in a temporary folder. The disk is the real one only here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChatSession, type TurnRecord } from "../src/chat/session.js";
import { createSessionLog } from "../src/logging/session-log.js";
import { createRedactor } from "../src/security/redact.js";
import {
  createSafeWriter,
  type SafeWriter,
} from "../src/security/safe-writer.js";
import {
  approvedStep,
  makeCritiqueDeps,
  rejectedStep,
} from "./helpers/critique-fixtures.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import { createFakeLlmClient } from "./helpers/fake-llm-client.js";

const KEY = fakeOpenAiKey();
const redact = createRedactor([KEY]);
const START = new Date("2026-03-04T05:06:07.089Z");

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "made-up-session-log-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function answeredRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    at: "2026-03-04T05:06:08.000Z",
    status: "answered",
    question: "Pergunta",
    model: "m",
    critique: {
      draft: "Rascunho",
      evaluation: { status: "ok", approved: true, violations: [] },
      origin: "rascunho",
      violatedRules: [],
      llmCalls: 2,
    },
    ...overrides,
  };
}

function lines(root: string, path: string): string[] {
  return readFileSync(join(root, path), "utf8").split("\n").filter(Boolean);
}

function parseLine(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "") as Record<string, unknown>;
}

function logOver(writer: SafeWriter, warnings: string[] = []) {
  return createSessionLog({
    writer,
    now: () => START,
    profile: "Perfil",
    redact,
    warn: (text) => void warnings.push(text),
  });
}

describe("createSessionLog", () => {
  it("names the file after the start, without colons, under logs/", () => {
    const log = logOver(createSafeWriter({ redact, rootDir: temporaryRoot() }));

    expect(log.path).toBe("logs/sessao-2026-03-04T050607.089Z.jsonl");
    expect(log.path).not.toContain(":");
    expect(log.path.startsWith("logs/")).toBe(true);
  });

  it("reads the clock once, for the name", () => {
    let reads = 0;
    const log = createSessionLog({
      writer: createSafeWriter({ redact, rootDir: temporaryRoot() }),
      now: () => {
        reads += 1;
        return START;
      },
      profile: "Perfil",
      redact,
      warn: () => undefined,
    });

    void log.append(answeredRecord());

    expect(reads).toBe(1);
  });

  it("writes one JSON line per turn, with the keys in Portuguese", async () => {
    const root = temporaryRoot();
    const log = logOver(createSafeWriter({ redact, rootDir: root }));

    await log.append(answeredRecord());
    await log.append(
      answeredRecord({
        question: "Outra",
        critique: {
          draft: "D",
          evaluation: {
            status: "ok",
            approved: false,
            violations: [{ rule: "P2", reason: "gíria" }],
          },
          revision: {
            text: "V",
            evaluation: { status: "ok", approved: true, violations: [] },
          },
          origin: "revisao",
          violatedRules: ["P2"],
          llmCalls: 4,
        },
      }),
    );
    const written = lines(root, log.path);

    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0] ?? "")).toEqual({
      perfil: "Perfil",
      momento: "2026-03-04T05:06:08.000Z",
      situacao: "respondido",
      pergunta: "Pergunta",
      modelo: "m",
      rascunho: "Rascunho",
      parecer: { situacao: "ok", aprovada: true, violacoes: [] },
      origem: "rascunho",
      regraViolada: [],
      chamadas: 2,
    });
    expect(JSON.parse(written[1] ?? "")).toMatchObject({
      pergunta: "Outra",
      origem: "revisao",
      regraViolada: ["P2"],
      parecer: {
        aprovada: false,
        violacoes: [{ regra: "P2", motivo: "gíria" }],
      },
      revisao: { texto: "V", parecer: { aprovada: true } },
    });
  });

  it("writes a failed turn with the summary of the error, and a cancelled one", async () => {
    const root = temporaryRoot();
    const log = logOver(createSafeWriter({ redact, rootDir: root }));

    await log.append({
      at: "t1",
      status: "failed",
      question: "P",
      summary: { status: 503, code: "server_error", message: "indisponível" },
    });
    await log.append({ at: "t2", status: "cancelled", question: "P" });
    const [failed, cancelled] = lines(root, log.path).map(parseLine);

    expect(failed).toMatchObject({
      situacao: "falhou",
      erro: { status: 503, codigo: "server_error", mensagem: "indisponível" },
    });
    expect(cancelled).toMatchObject({ situacao: "cancelado" });
    expect(cancelled).not.toHaveProperty("rascunho");
  });

  it("writes an evaluation that failed as an error, with the summary", async () => {
    const root = temporaryRoot();
    const log = logOver(createSafeWriter({ redact, rootDir: root }));

    await log.append(
      answeredRecord({
        critique: {
          draft: "D",
          evaluation: { status: "error", summary: { message: "caiu" } },
          origin: "fallback",
          violatedRules: [],
          llmCalls: 2,
        },
      }),
    );

    expect(JSON.parse(lines(root, log.path)[0] ?? "")).toMatchObject({
      parecer: { situacao: "erro", resumo: { mensagem: "caiu" } },
      origem: "fallback",
    });
  });

  it("never leaves a key in the file, wherever it was", async () => {
    const root = temporaryRoot();
    const log = logOver(createSafeWriter({ redact, rootDir: root }));

    await log.append(
      answeredRecord({
        question: `chave ${KEY}`,
        critique: {
          draft: `rascunho ${KEY}`,
          evaluation: {
            status: "ok",
            approved: false,
            violations: [{ rule: "P3", reason: `motivo ${KEY}` }],
          },
          revision: { text: `revisão ${KEY}` },
          origin: "fallback",
          violatedRules: ["P3"],
          llmCalls: 3,
        },
      }),
    );

    const file = readFileSync(join(root, log.path), "utf8");

    expect(file).not.toContain(KEY);
    expect(file).not.toContain(KEY.slice(0, 12));
    expect(file).toContain("[REDACTED]");
  });

  it("does not let a failure to write reach the chat, and warns only once", async () => {
    const warnings: string[] = [];
    const failing: SafeWriter = {
      writeText: () => Promise.reject(new Error("não usado")),
      appendText: () => Promise.reject(new Error("não usado")),
      writeJson: () => Promise.reject(new Error("não usado")),
      appendJsonLine: () =>
        Promise.reject(
          Object.assign(new Error(`disco cheio ${KEY}`), { code: "ENOSPC" }),
        ),
    };
    const log = logOver(failing, warnings);

    await expect(log.append(answeredRecord())).resolves.toBeUndefined();
    await expect(log.append(answeredRecord())).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("disco cheio");
    expect(warnings[0]).toContain(log.path);
    expect(warnings[0]).not.toContain(KEY);
  });

  it("does not let a writer that throws at once reach the chat", async () => {
    const warnings: string[] = [];
    const throwing = {
      appendJsonLine: () => {
        throw new Error("falha síncrona");
      },
    } as unknown as SafeWriter;

    await expect(
      logOver(throwing, warnings).append(answeredRecord()),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
  });
});

describe("the session log with a session", () => {
  it("records each turn, with the rejected draft, and nothing of the key", async () => {
    const root = temporaryRoot();
    const log = logOver(createSafeWriter({ redact, rootDir: root }));
    const session = createChatSession({
      llm: createFakeLlmClient([
        { text: `rascunho com ${KEY}` },
        rejectedStep("P1", "dado confidencial"),
        { text: "revisão boa" },
        approvedStep(),
        { text: "segunda" },
        approvedStep(),
      ]),
      instructions: "CTX",
      critique: makeCritiqueDeps(),
      output: {
        chunk: () => undefined,
        endAnswer: () => undefined,
        retraction: () => undefined,
        notice: () => undefined,
      },
      redact,
      onTurn: (record) => log.append(record),
      now: () => START,
    });

    await session.ask("primeira");
    await session.ask("segunda pergunta");
    const written = lines(root, log.path);

    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0] ?? "")).toMatchObject({
      situacao: "respondido",
      origem: "revisao",
      regraViolada: ["P1"],
      chamadas: 4,
      momento: START.toISOString(),
    });
    expect(written.join("\n")).not.toContain(KEY);
    expect(parseLine(written[0]).rascunho).toContain("[REDACTED]");
  });

  it("keeps logs/ out of Git", () => {
    const ignore = readFileSync(
      new URL("../.gitignore", import.meta.url),
      "utf8",
    ).split("\n");

    expect(ignore).toContain("logs/");
  });
});
