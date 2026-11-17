// Redaction of an answer that arrives in pieces (ENG-53): a key split between
// two pieces must not reach the screen, and what is shown must be what
// redact() gives for the whole text.
import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "../src/security/redact.js";
import { createStreamRedactor } from "../src/security/stream-redact.js";
import { createFakeKeyGenerator, fakeOpenAiKey } from "./helpers/fake-key.js";

const KEY = fakeOpenAiKey();
const BEARER_TOKEN = "abcdefghij0123456789KLMNOP";

/** What a screen would show for the pieces, and the pieces released one by one. */
function run(
  chunks: readonly string[],
  secrets: readonly string[] = [KEY],
): { shown: string; released: string[] } {
  const stream = createStreamRedactor(secrets);
  const released = chunks.map((chunk) => stream.push(chunk));
  released.push(stream.flush());
  return { shown: released.join(""), released };
}

function splitAt(text: string, points: readonly number[]): string[] {
  const edges = [0, ...points, text.length];
  return edges.slice(1).map((end, index) => text.slice(edges[index], end));
}

describe("createStreamRedactor", () => {
  it("redacts a key that arrives in one piece", () => {
    const { shown } = run([`a chave é ${KEY}.`]);

    expect(shown).toBe(`a chave é ${REDACTED}.`);
  });

  it("passes ordinary text through at once", () => {
    const stream = createStreamRedactor([KEY]);

    expect(stream.push("Olá, ")).toBe("Olá, ");
    expect(stream.push("tudo bem?")).toBe("tudo bem?");
    expect(stream.flush()).toBe("");
  });

  it("never lets a key split in two pieces reach the output, at any point", () => {
    const text = `antes ${KEY} depois`;
    for (let point = 1; point < text.length; point += 1) {
      const { shown, released } = run(splitAt(text, [point]));

      expect(shown).toBe(`antes ${REDACTED} depois`);
      for (const piece of released) {
        expect(piece).not.toContain(KEY.slice(0, 6));
      }
    }
  });

  it("works with the key split in as many pieces as it has characters", () => {
    const text = `antes ${KEY} depois`;
    const { shown, released } = run([...text]);

    expect(shown).toBe(`antes ${REDACTED} depois`);
    for (const piece of released) {
      expect(piece).not.toContain("sk-");
    }
  });

  it("works with the key at the start and at the end of the text", () => {
    expect(run(splitAt(KEY, [3, 10, 20])).shown).toBe(REDACTED);
    expect(run(splitAt(`x ${KEY}`, [4, 9])).shown).toBe(`x ${REDACTED}`);
  });

  it("redacts an exact secret that does not look like a key, split anywhere", () => {
    const secret = "valor-secreto-123";
    const text = `veja ${secret} aqui`;
    for (let point = 1; point < text.length; point += 1) {
      const { shown, released } = run(splitAt(text, [point]), [secret]);

      expect(shown).toBe(`veja ${REDACTED} aqui`);
      for (const piece of released) {
        expect(piece).not.toContain("valor");
      }
    }
  });

  it("redacts a masked key split in pieces", () => {
    const masked = ["sk", "proj", `${"*".repeat(30)}wXyZ`].join("-");
    const text = `erro com ${masked} fim`;

    expect(run(splitAt(text, [12, 20, 30])).shown).toBe(redact(text));
    expect(run(splitAt(text, [12, 20, 30])).shown).not.toContain("wXyZ");
  });

  it("redacts the token of an authorization header, split anywhere", () => {
    const text = `cabeçalho Bearer ${BEARER_TOKEN} fim`;
    for (let point = 1; point < text.length; point += 1) {
      const { shown, released } = run(splitAt(text, [point]), []);

      expect(shown).toBe(`cabeçalho Bearer ${REDACTED} fim`);
      for (const piece of released) {
        expect(piece).not.toContain("abcdefghij");
      }
    }
  });

  it("does not hold ordinary words that end like the prefix", () => {
    const stream = createStreamRedactor([KEY]);

    expect(stream.push("A task-force management ")).toBe(
      "A task-force management ",
    );
    expect(stream.push("do disk-based backup.")).toBe("do disk-based backup.");
    expect(stream.flush()).toBe("");
  });

  it("releases a word that ends like the prefix when the text goes on, or at the end", () => {
    const stream = createStreamRedactor([KEY]);
    const first = stream.push("a task-force");

    expect(first + stream.push(" segue") + stream.flush()).toBe(
      "a task-force segue",
    );
    expect(run(["a task-force"]).shown).toBe("a task-force");
  });

  it("keeps a word that merely ends in a letter of the prefix", () => {
    const stream = createStreamRedactor([KEY]);

    expect(stream.push("os") + stream.flush()).toBe("os");
    expect(stream.push("sk") + stream.push("i") + stream.flush()).toBe("ski");
  });

  it("flushes what it kept back, redacted, and starts a new text", () => {
    const stream = createStreamRedactor([KEY]);

    expect(stream.push(`chave ${KEY}`)).toBe("chave ");
    expect(stream.flush()).toBe(REDACTED);
    expect(stream.flush()).toBe("");
    expect(stream.push("outra")).toBe("outra");
  });

  it("has no effect on a flush of nothing", () => {
    expect(createStreamRedactor([KEY]).flush()).toBe("");
  });

  it("ignores exact secrets that are too short, as redact() does", () => {
    const stream = createStreamRedactor(["abc", "", "   "]);

    expect(stream.push("abc abc abc")).toBe("abc abc abc");
  });

  it("gives, for any split of any text, the same as redact() on the whole", () => {
    const keys = createFakeKeyGenerator(7);
    const texts = [
      `um ${KEY} dois ${KEY}`,
      `lista:\n1. ${keys.legacy()}\n2. Bearer ${BEARER_TOKEN}\n3. fim`,
      "task-force e disk-based e sk e s e Bea e Bearer e Bearer tokens",
      `${KEY}${KEY}`,
      `x${KEY}\n${KEY}y`,
      `**sk-** e ${["sk", "***"].join("-")} e sk-**`,
      "Authorization: Bearer   " + BEARER_TOKEN,
      "texto sem nada",
    ];
    let seed = 12345;
    const next = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 0x1_0000_0000) * limit);
    };

    for (const text of texts) {
      const expected = redact(text, [KEY]);
      for (let round = 0; round < 60; round += 1) {
        const points = Array.from({ length: 1 + next(8) }, () =>
          next(text.length),
        ).sort((a, b) => a - b);
        const { shown } = run(splitAt(text, points));

        expect(shown).toBe(expected);
      }
    }
  });

  it("never shows part of a key after what was released, over many splits", () => {
    const text = `a ${KEY} b ${KEY} c`;
    for (let first = 1; first < text.length; first += 3) {
      for (let second = first + 1; second < text.length; second += 5) {
        const { released } = run(splitAt(text, [first, second]));
        let shownSoFar = "";
        for (const piece of released) {
          shownSoFar += piece;

          expect(shownSoFar).not.toContain("sk-proj");
        }
      }
    }
  });
});

describe("redact: Bearer token (ENG-53)", () => {
  it.each([
    [`Bearer ${BEARER_TOKEN}`, `Bearer ${REDACTED}`],
    [`bearer ${BEARER_TOKEN}, fim`, `bearer ${REDACTED}, fim`],
    [`BEARER   ${BEARER_TOKEN}\nfim`, `BEARER   ${REDACTED}\nfim`],
    [`a Bearer ${BEARER_TOKEN}.x-y_z fim`, `a Bearer ${REDACTED} fim`],
  ])("redacts the token in %j", (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each([
    "Bearer tokens são usados",
    "o Bearer authentic",
    "Bearer",
    "Bearer ",
    "xBearer 0123456789abcdef0123",
  ])("leaves %j alone", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("keeps working next to a key, which is redacted first", () => {
    expect(redact(`Bearer ${KEY}`)).toBe(`Bearer ${REDACTED}`);
  });

  it("stays fast on a very long token", () => {
    const started = performance.now();

    expect(redact(`Bearer ${"a".repeat(2_000_000)}`)).toBe(
      `Bearer ${REDACTED}`,
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
