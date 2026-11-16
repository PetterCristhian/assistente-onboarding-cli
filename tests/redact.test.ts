import { describe, expect, it } from "vitest";
import {
  MIN_EXACT_SECRET_LENGTH,
  REDACTED,
  createRedactor,
  createSecretPattern,
  redact,
} from "../src/security/redact.js";
import { fakeMaskedOpenAiKey, fakeOpenAiKey } from "./helpers/fake-key.js";

const PREFIX = ["sk", ""].join("-");

describe("redact", () => {
  it("replaces the exact key in use even when it does not look like a key", () => {
    const secret = "chave-curta-123";
    const redactor = createRedactor([secret]);

    const result = redactor(`a chave é ${secret}.`);

    expect(result).toBe(`a chave é ${REDACTED}.`);
  });

  it("replaces an unregistered key-shaped sequence of 20 characters", () => {
    const sequence = PREFIX + "a".repeat(20);

    expect(redact(`antes ${sequence} depois`)).toBe(`antes ${REDACTED} depois`);
  });

  it("keeps a sequence with only 19 characters after the prefix", () => {
    const text = `antes ${PREFIX + "a".repeat(19)} depois`;

    expect(redact(text)).toBe(text);
  });

  it("replaces every occurrence in the same string", () => {
    const key = fakeOpenAiKey();
    const other = fakeOpenAiKey("B");

    const result = redact(`${key} e ${other} e ${key}`);

    expect(result).toBe(`${REDACTED} e ${REDACTED} e ${REDACTED}`);
  });

  it("replaces a key inside JSON and inside an authorization header", () => {
    const key = fakeOpenAiKey();
    const json = JSON.stringify({ resposta: key, lista: [key] });
    const header = `Authorization: Bearer ${key}`;

    const redactedJson = redact(json, [key]);

    expect(redactedJson).not.toContain(key);
    expect(JSON.parse(redactedJson)).toEqual({
      resposta: REDACTED,
      lista: [REDACTED],
    });
    expect(redact(header)).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("replaces the longest registered secret first", () => {
    const short = "segredo-";
    const long = "segredo-completo";

    expect(redact(`x ${long} y`, [short, long])).toBe(`x ${REDACTED} y`);
  });

  it("ignores empty and blank secrets", () => {
    const text = "texto comum, sem credencial";

    expect(redact(text, ["", "   "])).toBe(text);
    expect(createRedactor([""])(text)).toBe(text);
  });

  it("returns a text without secrets unchanged", () => {
    const text = "Qual é o prazo de reembolso? Veja o item task-1.";

    expect(redact(text)).toBe(text);
    expect(redact(text, [fakeOpenAiKey()])).toBe(text);
  });

  it("gives the same result on consecutive calls", () => {
    const key = fakeOpenAiKey();
    const redactor = createRedactor([key]);
    const text = `Bearer ${key}`;

    expect(redactor(text)).toBe(redactor(text));
    expect(redact(text)).toBe(redact(text));
    expect(redact(text)).toBe(`Bearer ${REDACTED}`);
  });

  it("does not let later changes to the list affect the redactor", () => {
    const secrets = ["chave-curta-123"];
    const redactor = createRedactor(secrets);
    secrets.length = 0;

    expect(redactor("chave-curta-123")).toBe(REDACTED);
  });

  it("creates a new global pattern on every call", () => {
    const first = createSecretPattern();
    const second = createSecretPattern();

    expect(first).not.toBe(second);
    expect(first.global).toBe(true);
    expect(first.source).toBe(second.source);
  });
});

describe("redact: exact secrets that are too short", () => {
  const text = "a chave x9 abre a caixa; 1234567 e 12345678.";

  it.each([["x"], ["a"], ["x9"], ["1234567"], [" 1234567 "]])(
    "ignores the exact secret %j instead of tearing the text apart",
    (secret) => {
      expect(redact(text, [secret])).toBe(text);
      expect(createRedactor([secret])(text)).toBe(text);
    },
  );

  it("redacts an exact secret with the minimum length", () => {
    const secret = "12345678";

    expect(secret).toHaveLength(MIN_EXACT_SECRET_LENGTH);
    expect(redact(text, [secret])).toBe(
      `a chave x9 abre a caixa; 1234567 e ${REDACTED}.`,
    );
  });

  it("keeps the base pattern and the longer secrets working", () => {
    const key = fakeOpenAiKey();
    const redactor = createRedactor(["a", "chave-curta-123"]);

    expect(redactor(`a ${key} e a chave-curta-123`)).toBe(
      `a ${REDACTED} e a ${REDACTED}`,
    );
  });
});

// The API quotes a rejected key in the 401 message with asterisks in the
// middle. The exact format was not confirmed against the real API, so several
// plausible variations are covered.
describe("redact: masked key", () => {
  it.each([
    ["project key, many asterisks", {}],
    ["project key, few asterisks", { asterisks: 3 }],
    ["project key, start and end visible", { start: "AbCd", asterisks: 8 }],
    ["classic key, many asterisks", { project: false, asterisks: 44 }],
    ["classic key, few asterisks", { project: false, asterisks: 5 }],
    [
      "classic key, start and end visible",
      { project: false, start: "abc", asterisks: 3, end: "9_-z" },
    ],
    ["no character after the asterisks", { asterisks: 12, end: "" }],
    ["long visible start", { start: "a".repeat(24), asterisks: 4 }],
  ])("replaces the whole masked form: %s", (_label, options) => {
    const masked = fakeMaskedOpenAiKey(options);
    const text = `401 Incorrect API key provided: ${masked}. You can find your API key at https://example.invalid/keys.`;

    const result = redact(text);

    expect(result).toBe(
      `401 Incorrect API key provided: ${REDACTED}. You can find your API key at https://example.invalid/keys.`,
    );
    expect(result).not.toContain("*");
    expect(createRedactor([fakeOpenAiKey()])(text)).toBe(result);
  });

  it("leaves no visible character of a masked key behind", () => {
    const masked = fakeMaskedOpenAiKey({ start: "QqQq", end: "ZzZz" });

    const result = redact(`"${masked}" e (${masked})`);

    expect(result).toBe(`"${REDACTED}" e (${REDACTED})`);
    expect(result).not.toContain("QqQq");
    expect(result).not.toContain("ZzZz");
  });

  it("keeps the prefix followed by fewer than three asterisks", () => {
    // Markdown bold around the prefix is not a masked key.
    const text = `use o prefixo **${PREFIX}** e depois ${PREFIX}*x`;

    expect(redact(text)).toBe(text);
  });

  it("keeps ordinary text with asterisks unchanged", () => {
    const text = "*** separador ***\n- **negrito** e task-1 * 3 ** 2\n";

    expect(redact(text)).toBe(text);
  });
});

describe("redact: hostile inputs", () => {
  const key = fakeOpenAiKey();

  it("treats an exact secret as plain text, not as a regular expression", () => {
    const secret = "a.*+?^${}()|[]\\b/$&";

    expect(redact(`x ${secret} y $& $1 abc`, [secret])).toBe(
      `x ${REDACTED} y $& $1 abc`,
    );
  });

  it.each([
    ["glued to letters", `abc${key}`, `abc${REDACTED}`],
    ["between symbols", `k=${key};n=1`, `k=${REDACTED};n=1`],
    [
      "in a URL query",
      `https://example.invalid/v1?api_key=${key}&n=1`,
      `https://example.invalid/v1?api_key=${REDACTED}&n=1`,
    ],
    ["alone on a line", `a\n${key}\r\nb`, `a\n${REDACTED}\r\nb`],
    ["quoted", `'${key}' "${key}"`, `'${REDACTED}' "${REDACTED}"`],
  ])("replaces a key %s", (_label, text, expected) => {
    expect(redact(text)).toBe(expected);
    expect(redact(text, [key])).toBe(expected);
  });

  it("redacts every key of a very large text", () => {
    const text = `${"x".repeat(500)} ${key}\n`.repeat(4000);

    const result = redact(text, [key]);

    expect(result).not.toContain(key);
    expect(result.split(REDACTED)).toHaveLength(4001);
  });

  it("redacts both when a secret is a substring of another", () => {
    const result = redact("abcdefgh-ijkl abcdefgh", [
      "abcdefgh",
      "abcdefgh-ijkl",
    ]);

    expect(result).toBe(`${REDACTED} ${REDACTED}`);
  });
});
