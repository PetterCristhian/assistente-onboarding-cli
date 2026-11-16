import { describe, expect, it } from "vitest";
import {
  MIN_EXACT_SECRET_LENGTH,
  REDACTED,
  createRedactor,
  findSecretSpans,
  redact,
} from "../src/security/redact.js";
import {
  createFakeKeyGenerator,
  fakeLowerCaseKeyShape,
  fakeMaskedOpenAiKey,
  fakeOpenAiKey,
} from "./helpers/fake-key.js";
import {
  AFTER_AN_ESCAPE,
  GLUED_TO_A_WORD,
  ORDINARY_TEXT,
} from "./helpers/key-placements.js";

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

  it("reports where each key-shaped sequence starts and ends", () => {
    const key = fakeOpenAiKey();
    const masked = fakeMaskedOpenAiKey({ asterisks: 3 });
    const text = `a ${key} b ${masked}.`;

    const spans = findSecretSpans(text);

    expect(spans).toEqual([
      { start: 2, end: 2 + key.length },
      { start: key.length + 5, end: key.length + 5 + masked.length },
    ]);
    // No state is kept between calls.
    expect(findSecretSpans(text)).toEqual(spans);
    expect(findSecretSpans("texto comum, task-1")).toEqual([]);
  });

  it("takes a key glued to another as a single sequence", () => {
    const glued = `${fakeOpenAiKey()}${fakeOpenAiKey("B")}`;

    expect(findSecretSpans(`x ${glued}`)).toEqual([
      { start: 2, end: 2 + glued.length },
    ]);
  });
});

// A greedy regular expression overflows the stack of the engine on a run of
// millions of key characters: the scan died and the writer would throw.
describe("redact: very long key-shaped sequences", () => {
  const LENGTH = 8 * 1024 * 1024;

  it("redacts a key-shaped sequence of 8 MB", () => {
    const text = `antes ${PREFIX}${"a".repeat(LENGTH)} depois`;

    expect(redact(text)).toBe(`antes ${REDACTED} depois`);
  });

  it("redacts a masked sequence of 8 MB", () => {
    const text = `${PREFIX}${"*".repeat(LENGTH)}wXyZ.`;

    expect(redact(text)).toBe(`${REDACTED}.`);
  });

  it("stays fast when the prefix repeats millions of times", () => {
    const short = `${PREFIX}a `.repeat(1024 * 1024);
    const glued = PREFIX.repeat(2 * 1024 * 1024);
    const startedAt = performance.now();

    expect(redact(short)).toBe(short);
    expect(redact(`${glued} fim`)).toBe(`${REDACTED} fim`);
    expect(performance.now() - startedAt).toBeLessThan(5000);
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
    ["glued to a symbol after letters", `abc_${key}`, `abc_${REDACTED}`],
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

// QA of the walker that replaced the single regular expression: the same
// sequences must be found wherever they are, and ordinary text must stay.
describe("redact: where a key can be (QA)", () => {
  const key = fakeOpenAiKey("q");
  const other = fakeOpenAiKey("w");

  it.each([
    ["between parentheses", `(${key})`, `(${REDACTED})`],
    ["between quotes", `'${key}'`, `'${REDACTED}'`],
    [
      "in a query string",
      `https://x.invalid/v1?k=${key}&b=1`,
      `https://x.invalid/v1?k=${REDACTED}&b=1`,
    ],
    [
      "in the user part of a URL",
      `https://${key}@x.invalid/`,
      `https://${REDACTED}@x.invalid/`,
    ],
    ["glued to a colon after text", `chave:${key}`, `chave:${REDACTED}`],
    ["followed by a full stop", `${key}.`, `${REDACTED}.`],
    ["between tabs", `a\t${key}\tb`, `a\t${REDACTED}\tb`],
    ["between accented letters", `é${key}ç`, `é${REDACTED}ç`],
    [
      "at the end of the text, with no line break",
      `linha\n${key}`,
      `linha\n${REDACTED}`,
    ],
    ["between CRLF line breaks", `a\r\n${key}\r\nb`, `a\r\n${REDACTED}\r\nb`],
    [
      "after a short use of the prefix",
      `${PREFIX}abc ${key}`,
      `${PREFIX}abc ${REDACTED}`,
    ],
    ["two separated by a comma", `${key},${other}`, `${REDACTED},${REDACTED}`],
    ["in an HTML tag", `<b>${key}</b>`, `<b>${REDACTED}</b>`],
  ])("replaces a key %s", (_label, text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it("ends the last span at the end of the text", () => {
    const text = `${key} ${other}`;

    expect(findSecretSpans(text)).toEqual([
      { start: 0, end: key.length },
      { start: key.length + 1, end: text.length },
    ]);
  });

  it.each([
    "use a task-list de hoje",
    "risk-based e ask-me-anything",
    "**task-force** e *task-force*",
    "| task-id | *** |",
    "desk-1 *** desk-2",
    "helpdesk-suporte@empresa.invalid",
    `o prefixo ${PREFIX} sozinho, ${PREFIX}** e ${PREFIX}*`,
    "- [ ] task-1\n***\n",
  ])("keeps ordinary text unchanged: %s", (text) => {
    expect(redact(text)).toBe(text);
    expect(findSecretSpans(text)).toEqual([]);
  });

  it("stays fast on megabytes of sequences that are one character short", () => {
    const nearMiss = `${PREFIX}${"a".repeat(19)} `.repeat(350_000);
    const startedAt = performance.now();

    expect(redact(nearMiss)).toBe(nearMiss);
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });

  it("stays fast on hundreds of thousands of keys in a single line", () => {
    const text = `${PREFIX}${"a".repeat(20)} `.repeat(350_000);
    const startedAt = performance.now();

    expect(redact(text)).toBe(`${REDACTED} `.repeat(350_000));
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});

// The prefix is also the end of ordinary words (task-, disk-, helpdesk-), and
// asterisks are also Markdown: neither may be taken for a key. Only what
// reads as words with hyphens is left alone: glued to a letter or digit AND
// with no digit and no upper-case letter inside a word.
describe("redact: boundary before the prefix and Markdown around a key", () => {
  const key = fakeOpenAiKey("m");

  it.each([
    "***task-force***",
    "disk-***",
    "um ***risk-x*** no texto",
    "| desk-*** | ask-**** |",
    "task-force-management-department",
    "helpdesk-abertura-de-chamados-ti",
    "o item 9task-force-management-department",
    `x9${fakeLowerCaseKeyShape()}`,
    `abc${PREFIX}***wxyz`,
    `abc${PREFIX}${"a".repeat(24)}****`,
    "***task-force-management-department***",
    "Task-Force-Management-Department",
    // Names of time zones found in the executable of Node.
    "Petropavlovsk-Kamchatski-standaardtyd",
  ])("keeps a word that only ends like the prefix: %s", (text) => {
    expect(redact(text)).toBe(text);
    expect(findSecretSpans(text)).toEqual([]);
  });

  it.each([
    ["an equals sign", "KEY="],
    ["a double quote", '"'],
    ["a single quote", "'"],
    ["a slash", "/"],
    ["a colon", ":"],
    ["an at sign", "@"],
    ["a parenthesis", "("],
    ["a space", "valor "],
    ["a full stop", "fim."],
    ["a comma", "a,"],
    ["an underscore", "MINHA_"],
    ["a hyphen", "copia-"],
    ["an asterisk", "*"],
    ["an accented letter", "é"],
  ])("replaces a key right after %s", (_label, before) => {
    const masked = fakeMaskedOpenAiKey({ start: "abc", asterisks: 3 });

    expect(redact(`${before}${key} fim`)).toBe(`${before}${REDACTED} fim`);
    expect(redact(`${before}${masked} fim`)).toBe(`${before}${REDACTED} fim`);
  });

  // Inverted after QA (B6): a boundary before the prefix let a key through
  // whenever a letter or digit came right before it.
  it.each([["texto"], ["Texto9"], ["A"], ["0"]])(
    "replaces a key glued to %j, registered or not",
    (before) => {
      const text = `${before}${key} fim`;

      expect(redact(text)).toBe(`${before}${REDACTED} fim`);
      expect(redact(text, [key])).toBe(`${before}${REDACTED} fim`);
      expect(findSecretSpans(text)).toEqual([
        { start: before.length, end: before.length + key.length },
      ]);
    },
  );

  it.each([
    ["an upper-case letter after the mask", `abc${PREFIX}***wXyZ`],
    // Built at runtime: the scan of the repository would report them.
    ["a digit before the mask", ["disk", "7***"].join("-")],
    [
      "a digit in a long word",
      ["task", "force-2024-management-plan"].join("-"),
    ],
    [
      "an upper-case letter inside a word",
      ["task", "forceManagementDepartment"].join("-"),
    ],
  ])("redacts too much rather than too little: %s", (_label, text) => {
    // Accepted price: with a digit or an upper-case letter inside a word,
    // the sequence no longer reads as plain words with hyphens.
    expect(redact(text)).toContain(REDACTED);
  });

  it("only leaves alone, glued to a letter, what has no digit and no upper-case letter inside a word", () => {
    const lowerCase = fakeLowerCaseKeyShape(40);

    // Premise of ADR 0007: no real key is like this one.
    expect(redact(`texto${lowerCase}`)).toBe(`texto${lowerCase}`);
    expect(redact(`texto${lowerCase}`, [lowerCase])).toBe(`texto${REDACTED}`);
    expect(redact(`texto ${lowerCase}`)).toBe(`texto ${REDACTED}`);
    expect(redact(`texto${lowerCase}7`)).toBe(`texto${REDACTED}`);
    expect(redact(`texto${lowerCase}Z`)).toBe(`texto${REDACTED}`);
    expect(redact(`texto${lowerCase}-Zz`)).toBe(`texto${lowerCase}-Zz`);
  });

  it("finds a key after a hyphen inside words that are left alone", () => {
    const lowerCase = fakeLowerCaseKeyShape();
    const text = `task-force-management-department-${lowerCase} fim`;

    expect(redact(text)).toBe(
      `task-force-management-department-${REDACTED} fim`,
    );
  });

  it.each([
    ["bold", "**", "**"],
    ["italic", "*", "*"],
    ["bold in a sentence", "a chave **", "** vazou"],
    ["a list item with one asterisk after", "- ", "* nota"],
  ])("keeps the Markdown around a key: %s", (_label, before, after) => {
    const masked = fakeMaskedOpenAiKey({ start: "abc", asterisks: 3 });

    expect(redact(`${before}${key}${after}`)).toBe(
      `${before}${REDACTED}${after}`,
    );
    expect(redact(`${before}${masked}${after}`)).toBe(
      `${before}${REDACTED}${after}`,
    );
  });

  it.each([
    ["visible start and end", { start: "abc", asterisks: 3 }],
    ["no visible start", { project: false, asterisks: 3 }],
    ["only asterisks", { asterisks: 8, end: "" }],
    ["long visible start", { start: "a".repeat(30), asterisks: 5 }],
  ])("still replaces the whole masked key: %s", (_label, options) => {
    const masked = fakeMaskedOpenAiKey(options);

    expect(redact(masked)).toBe(REDACTED);
    expect(redact(`(${masked})`)).toBe(`(${REDACTED})`);
    expect(findSecretSpans(masked)).toEqual([{ start: 0, end: masked.length }]);
  });
});

// QA of ENG-44 (B6): the writer redacts what JSON.stringify produced, where a
// key at the start of a line comes right after the "n" of "\n".
describe("redact: a key right after a letter or digit that ends no word", () => {
  const key = fakeOpenAiKey("m");
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ["a key", key],
    ["a key-shaped sequence in lower case", fakeLowerCaseKeyShape()],
    ["a masked key", fakeMaskedOpenAiKey()],
    [
      "a masked key in lower case",
      fakeMaskedOpenAiKey({ start: "abc", asterisks: 3, end: "wxyz" }),
    ],
  ];

  describe.each(secrets)("%s", (_label, secret) => {
    it.each(AFTER_AN_ESCAPE)("is replaced after %s", (_placement, build) => {
      const text = build(secret);

      expect(redact(text)).toBe(build(REDACTED));
      expect(redact(text)).not.toContain(secret);
      expect(findSecretSpans(text)).toHaveLength(1);
    });
  });

  it.each(GLUED_TO_A_WORD)("replaces a key glued to %s", (_label, build) => {
    const masked = fakeMaskedOpenAiKey();

    expect(redact(build(key))).toBe(build(REDACTED));
    expect(redact(build(masked))).toBe(build(REDACTED));
  });

  it.each(ORDINARY_TEXT)("keeps ordinary text unchanged: %s", (text) => {
    const inJson = JSON.stringify({
      resposta: `linha
${text}	fim`,
    });

    expect(redact(text)).toBe(text);
    expect(findSecretSpans(text)).toEqual([]);
    expect(redact(inJson)).toBe(inJson);
  });

  it("keeps the Markdown bold around a key", () => {
    expect(redact(`**${key}**`)).toBe(`**${REDACTED}**`);
  });

  it.each([
    ["a Windows path", "C:\temp\task-force-management-department"],
    ["a link", "[task-force-management-department](https://x.invalid)"],
    ["a percentage", "100%task-force-management-department"],
  ])("keeps a word after %s", (_label, text) => {
    expect(redact(text)).toBe(text);
  });

  it("stays fast on millions of words that end like the prefix", () => {
    const words = "ask-".repeat(2 * 1024 * 1024);
    const withDigit = `${"ask-".repeat(1024 * 1024)}9 `;
    const startedAt = performance.now();

    expect(redact(words) === words).toBe(true);
    expect(redact(`${words}***`) === `${words}***`).toBe(true);
    expect(redact(withDigit)).toBe(`a${REDACTED} `);
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });

  it("stays fast when every word has its own digit", () => {
    const text = `task-${"a".repeat(20)}9-`.repeat(300_000);
    const startedAt = performance.now();

    expect(redact(`${text} fim`)).toBe(`ta${REDACTED} fim`);
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});

// QA of ENG-44, retest of B6: keys in the formats that real ones have, with
// random bodies, glued to a letter or a digit. None may be left in the text.
describe("redact: random keys in real formats glued to a letter or digit (QA)", () => {
  const SAMPLES = 2000;

  it.each([
    ["the prefix and 48 letters and digits", "legacy"],
    ["a project key", "proj"],
    ["a service account key", "svcacct"],
    ["an admin key", "admin"],
  ])("replaces every one of them: %s", (_label, format) => {
    const generator = createFakeKeyGenerator(20261116);
    let missed = 0;

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const key =
        format === "legacy"
          ? generator.legacy()
          : generator.withSegment(format);
      const before = `${generator.letterOrDigit()}${generator.letterOrDigit()}`;
      const text = `${before}${key} fim`;

      if (
        redact(text) !== `${before}${REDACTED} fim` ||
        findSecretSpans(text).length !== 1
      ) {
        missed += 1;
      }
    }
    expect(missed).toBe(0);
  });

  it.each([
    ["JSON serialized three times", 3],
    ["JSON serialized four times", 4],
  ])("replaces a key at the start of a line in %s", (_label, times) => {
    for (const secret of [fakeOpenAiKey("q"), fakeLowerCaseKeyShape()]) {
      let text = `chave:\n${secret}`;
      for (let round = 0; round < times; round += 1) {
        text = JSON.stringify(text);
      }

      expect(redact(text)).not.toContain(secret);
      expect(findSecretSpans(text)).toHaveLength(1);
    }
  });

  it.each([
    ["a literal ESC written as u001b", String.raw`erro\u001b[0m`],
    ["a literal ESC written as x1b", String.raw`\x1b[31m`],
    ["a literal ESC written as 033", String.raw`\033[0m`],
    ["a 256-colour sequence", "\x1b[38;5;196m"],
    ["a literal backslash, r, backslash, n", String.raw`linha\r\n`],
    ["a quoted-printable =3D", "k=3D"],
    ["a lower-case %0a", "x%0a"],
  ])("replaces a lower-case key-shaped sequence after %s", (_label, before) => {
    const secret = fakeLowerCaseKeyShape();

    expect(redact(`${before}${secret}`)).toBe(`${before}${REDACTED}`);
  });

  it("replaces a key quoted in the message and in the stack of an error", () => {
    const key = fakeOpenAiKey("s");
    const error = new Error(`401 Incorrect API key provided: ${key}.`);
    const text = `falha\n${String(error.stack)}\n    at${key}`;

    expect(redact(text)).not.toContain(key);
    expect(redact(JSON.stringify({ erro: text }))).not.toContain(key);
  });
});
