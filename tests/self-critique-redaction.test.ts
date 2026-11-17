// Fix of the QA of ENG-53 (B1): a key split by invisible characters in the
// reason of a verdict is redacted. No network, no key.
import { describe, expect, it } from "vitest";
import { cleanReason, normalizeEvaluation } from "../src/chat/critique.js";
import {
  createChatSession,
  type ChatOutput,
  type TurnRecord,
} from "../src/chat/session.js";
import { createRedactor, REDACTED } from "../src/security/redact.js";
import { makeCritiqueDeps, rejectedStep } from "./helpers/critique-fixtures.js";
import { createFakeLlmClient } from "./helpers/fake-llm-client.js";

const redact = createRedactor([]);
const HEAD = "sk-proj-AAAAAAAA";
const TAIL = "AAAAAAAAAAAAAAAAAAAA7Qz9";
// Written as code points: an invisible character in the source is easy to lose.
const INVISIBLES = [
  ["zero-width space", String.fromCodePoint(0x200b)],
  ["tag character", String.fromCodePoint(0xe0041)],
  ["bidi override", String.fromCodePoint(0x202e)],
  ["NUL", String.fromCodePoint(0x00)],
  ["escape", String.fromCodePoint(0x1b)],
  ["DEL", String.fromCodePoint(0x7f)],
] as const;

function splitKey(invisible: string): string {
  return `${HEAD}${invisible}${TAIL}`;
}

describe("B1: a key split by an invisible character is redacted", () => {
  it.each(INVISIBLES)("cleanReason, %s in the middle", (_name, invisible) => {
    const out = cleanReason(`vazou ${splitKey(invisible)} aqui`, redact);
    expect(out).toBe(`vazou ${REDACTED} aqui`);
  });

  it("keeps the words apart when there is no key", () => {
    expect(cleanReason("a\nb\u200bc", redact)).toBe("a b c");
  });

  it.each(INVISIBLES)(
    "the four outputs of a turn, %s in the middle",
    async (_name, invisible) => {
      const leaked = splitKey(invisible);
      const events: string[] = [];
      const output: ChatOutput = {
        chunk: (text) => void events.push(`chunk:${text}`),
        endAnswer: () => void events.push("end"),
        retraction: (text) => void events.push(`retraction:${text}`),
        notice: (level, text) => void events.push(`${level}:${text}`),
      };
      const records: TurnRecord[] = [];
      const fake = createFakeLlmClient([
        { text: "RASCUNHO" },
        rejectedStep("P2", `vazou ${leaked} aqui`),
        { text: "REVISAO" },
        rejectedStep("P3", `de novo ${leaked}`),
      ]);
      const session = createChatSession({
        llm: fake,
        instructions: "I",
        critique: makeCritiqueDeps(),
        output,
        redact,
        onTurn: (record) => void records.push(record),
      });

      await session.ask("P");

      const screen = events.join("\n");
      const log = JSON.stringify(records);
      const revisionPrompt = JSON.stringify(fake.calls[2]);
      for (const text of [screen, log, revisionPrompt]) {
        expect(text).not.toContain("7Qz9");
        expect(text).not.toContain("AAAAAAAA");
      }
      expect(screen).toContain(REDACTED);
      expect(log).toContain(REDACTED);
    },
  );

  it("normalizeEvaluation cleans the reason", () => {
    const verdict = normalizeEvaluation(
      {
        aprovada: false,
        violacoes: [{ regra: "P1", motivo: splitKey("\u200b") }],
      },
      redact,
    );
    expect(verdict.violations[0]?.reason).toBe(REDACTED);
  });
});
