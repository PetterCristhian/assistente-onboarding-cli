// Format, size and safety checks that hold for every file of context/,
// whatever its layer. The expressions are the ones of the policies document
// test (tests/policies-document.test.ts).
import { describe, expect, it } from "vitest";
import { redact } from "../src/security/redact.js";
import {
  emailDomain,
  extractEmails,
  listContextFiles,
  readContextFile,
  readContextFiles,
} from "./helpers/context-files.js";

// docs/BACKLOG.md, issue 4: about 6 thousand estimated tokens.
const CHARACTER_BUDGET = 24_000;

// Layers that hold no company data (docs/adr/0003-contexto-em-quatro-camadas.md).
const FILES_WITHOUT_COMPANY_DATA = [
  "01-instrucoes-globais.md",
  "02-politicas.md",
];

// Written as code points: an invisible character in the source is easy to lose.
const BOM = String.fromCodePoint(0xfeff);
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const KEYCAP = String.fromCodePoint(0x20e3);

const FILES = listContextFiles();

function allEmails(): string[] {
  return readContextFiles(FILES).flatMap((file) => extractEmails(file.content));
}

describe("context files", () => {
  it("finds the files it is supposed to check", () => {
    expect(FILES).toContain("02-politicas.md");
  });

  it.each(FILES)("leaves %s untouched by the redaction of secrets", (path) => {
    const content = readContextFile(path);

    expect(redact(content)).toBe(content);
  });

  it.each(FILES)("keeps %s not empty and without a BOM", (path) => {
    const content = readContextFile(path);

    expect(content.trim()).not.toBe("");
    expect(content.startsWith(BOM)).toBe(false);
  });

  it.each(FILES)(
    "uses in %s line feeds only, with no other blank character than the space",
    (path) => {
      // Carriage return, tab, no-break space and the like.
      expect(readContextFile(path)).not.toMatch(/[^\S \n]/u);
    },
  );

  it.each(FILES)(
    "ends %s with a single line break and has no trailing space",
    (path) => {
      const content = readContextFile(path);

      expect(content.endsWith("\n")).toBe(true);
      expect(content.endsWith("\n\n")).toBe(false);
      expect(content).not.toMatch(/ $/m);
    },
  );

  it.each(FILES)("keeps %s valid UTF-8 with no invisible character", (path) => {
    const content = readContextFile(path);

    // What the decoder leaves in place of a byte that is not UTF-8.
    expect(content).not.toContain(REPLACEMENT_CHARACTER);
    // Zero-width characters, direction marks and a BOM anywhere.
    expect(content).not.toMatch(/\p{Cf}/u);
  });

  it.each(FILES)("has no emoji in %s", (path) => {
    const content = readContextFile(path);

    expect(content).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(content).not.toMatch(
      /\p{Regional_Indicator}|\p{Variation_Selector}/u,
    );
    expect(content).not.toContain(KEYCAP);
  });

  it.each(FILES)("has no web address in %s", (path) => {
    const content = readContextFile(path).toLowerCase();

    expect(content).not.toContain("http");
    expect(content).not.toContain("www.");
  });

  it.each(FILES)("uses @ in %s only inside an e-mail address", (path) => {
    const content = readContextFile(path);

    expect(extractEmails(content)).toHaveLength(content.split("@").length - 1);
  });

  it("stays within the character budget", () => {
    const total = readContextFiles(FILES).reduce(
      (sum, file) => sum + file.content.length,
      0,
    );

    expect(total).toBeLessThan(CHARACTER_BUDGET);
  });

  it("writes every e-mail address under one reserved fictitious domain", () => {
    const domains = [...new Set(allEmails().map(emailDomain))];

    expect(domains.length).toBeLessThanOrEqual(1);
    for (const domain of domains) {
      expect(domain).toMatch(/^[a-z0-9-]+\.example$/);
    }
  });

  // The company name is the label of the e-mail domain. It is read from the
  // data and never written here.
  it("does not name the company in the layers that hold no company data", () => {
    const labels = [
      ...new Set(
        allEmails().map((email) => emailDomain(email).split(".")[0] ?? ""),
      ),
    ];
    const present = FILES_WITHOUT_COMPANY_DATA.filter((path) =>
      FILES.includes(path),
    );

    expect(present).toContain("02-politicas.md");
    for (const path of present) {
      const content = readContextFile(path).toLowerCase();
      for (const label of labels) {
        expect(label).not.toBe("");
        expect(content).not.toContain(label);
      }
    }
  });
});
