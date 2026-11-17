// Fix of the QA of ENG-53 (B2): the work of a push grows with the piece and
// with what is held back, not with the whole text. The check is structural (the
// size of what reaches redact()), so that it does not depend on the speed of
// the machine.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED, redact as realRedact } from "../src/security/redact.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const seen = vi.hoisted(() => ({ lengths: [] as number[] }));

vi.mock("../src/security/redact.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/security/redact.js")>();
  return {
    ...original,
    redact: (text: string, secrets?: readonly string[]) => {
      seen.lengths.push(text.length);
      return original.redact(text, secrets);
    },
  };
});

const KEY = fakeOpenAiKey();
const CHUNKS = 5000;

beforeEach(() => {
  seen.lengths.length = 0;
});

function feed(chunks: Iterable<string>, secrets: readonly string[] = [KEY]) {
  const stream = createStreamRedactor(secrets);
  let shown = "";
  for (const chunk of chunks) {
    shown += stream.push(chunk);
  }
  return shown + stream.flush();
}

describe("createStreamRedactor: cost of a push", () => {
  it("one-character pieces: the text sent to redact() has a fixed size", () => {
    const text = "a".repeat(CHUNKS);

    const shown = feed(text);

    expect(shown).toBe(text);
    expect(Math.max(...seen.lengths)).toBeLessThan(200);
    // Quadratic would be about CHUNKS * CHUNKS / 2 = 12.5 million.
    expect(seen.lengths.reduce((a, b) => a + b, 0)).toBeLessThan(CHUNKS * 400);
  });

  it("one-kilobyte pieces: the work is the size of the piece", () => {
    const piece = "palavra ".repeat(128);
    const pieces = Array.from({ length: 200 }, () => piece);

    const shown = feed(pieces);

    expect(shown).toBe(pieces.join(""));
    expect(Math.max(...seen.lengths)).toBeLessThan(piece.length + 200);
  });

  it("a key in the middle of a long text is still caught, split anywhere", () => {
    const text = `${"x ".repeat(2000)}chave ${KEY} fim ${"y ".repeat(2000)}`;
    const expected = realRedact(text, [KEY]);

    for (const size of [1, 3, 7]) {
      const pieces: string[] = [];
      for (let at = 0; at < text.length; at += size) {
        pieces.push(text.slice(at, at + size));
      }
      const shown = feed(pieces);

      expect(shown).toBe(expected);
      expect(shown).toContain(REDACTED);
      expect(shown).not.toContain(KEY.slice(8, 30));
    }
  });

  it("the held tail is the only thing that grows", () => {
    const stream = createStreamRedactor([KEY]);
    const open = `sk-${"A".repeat(10)}`;
    let shown = stream.push(open);
    for (let index = 0; index < 5; index += 1) {
      shown += stream.push("B");
    }

    expect(shown).toBe("");
    expect(stream.flush()).toBe(`sk-${"A".repeat(10)}BBBBB`);
  });
});
