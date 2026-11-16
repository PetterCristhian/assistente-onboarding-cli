import { describe, expect, it } from "vitest";
import {
  REDACTED,
  createRedactor,
  createSecretPattern,
  redact,
} from "../src/security/redact.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

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
    const short = "segredo";
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
