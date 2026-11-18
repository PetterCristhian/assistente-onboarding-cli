// Format, size and safety checks that hold for every file of context/,
// whatever its layer. The expressions are the ones of the policies document
// test (tests/policies-document.test.ts).
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context/builder.js";
import {
  DEFAULT_CONTEXT_DIR,
  listProfiles,
  loadContextLayers,
} from "../src/context/loaders.js";
import { redact } from "../src/security/redact.js";
import {
  emailDomain,
  extractEmails,
  listContextFiles,
  readContextFile,
  readContextFiles,
} from "./helpers/context-files.js";

// docs/BACKLOG.md, issue 4: about 6 thousand estimated tokens. It holds for
// the files and for the text that the builder assembles from them.
const CHARACTER_BUDGET = 24_000;

// Files of context/ that are no layer: the safe message and the two prompts of
// the self-critique (ENG-53), plus the prompt of the judge (ENG-57). They never go into the assembled context.
const NON_LAYER_FILES = [
  "fallback.md",
  "avaliador.md",
  "revisao.md",
  "juiz.md",
  "memoria-uso.md",
  "memoria-extracao.md",
  "resumo.md",
];

// Layers that hold no company data (docs/adr/0003-contexto-em-quatro-camadas.md).
const FILES_WITHOUT_COMPANY_DATA = [
  "01-instrucoes-globais.md",
  "02-politicas.md",
  "avaliador.md",
  "revisao.md",
  "juiz.md",
  "memoria-uso.md",
  "memoria-extracao.md",
  "resumo.md",
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
    // The prompts are sent in calls of their own, not in the context.
    const total = readContextFiles(
      FILES.filter(
        (path) =>
          ![
            "avaliador.md",
            "revisao.md",
            "juiz.md",
            "memoria-extracao.md",
            "resumo.md",
          ].includes(path),
      ),
    ).reduce((sum, file) => sum + file.content.length, 0);

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

// What the model receives: the four layers of one profile, with the markers,
// the precedence clause and the current date that the builder adds.
describe("assembled context", () => {
  const PROFILES = listProfiles(DEFAULT_CONTEXT_DIR);
  // Seven days in a row, so that every name of a day of the week is covered.
  const WEEK = Array.from(
    { length: 7 },
    (_, day) => new Date(2026, 10, 16 + day, 12),
  );

  function assemble(profile: string, now: Date): string {
    return buildContext(loadContextLayers({ profile }, { now: () => now }))
      .text;
  }

  it("finds the profiles it is supposed to check", () => {
    expect(PROFILES.length).toBeGreaterThanOrEqual(2);
  });

  it.each(PROFILES)(
    "stays within the character budget for %s, on every day of the week",
    (profile) => {
      for (const day of WEEK) {
        expect(assemble(profile, day).length).toBeLessThan(CHARACTER_BUDGET);
      }
    },
  );

  it.each(PROFILES)(
    "is left untouched by the redaction of secrets for %s",
    (profile) => {
      for (const day of WEEK) {
        const text = assemble(profile, day);

        expect(redact(text)).toBe(text);
      }
    },
  );

  it.each(PROFILES)("holds every layer file of %s whole", (profile) => {
    const text = assemble(profile, WEEK[0] ?? new Date(0));
    const layerFiles = FILES.filter(
      (path) => path.endsWith(".md") && !NON_LAYER_FILES.includes(path),
    );

    expect(layerFiles.length).toBeGreaterThanOrEqual(3);
    for (const path of layerFiles) {
      expect(text).toContain(readContextFile(path).trim());
    }
  });
});
