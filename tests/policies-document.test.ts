import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redact } from "../src/security/redact.js";

// Contract of the policies document (docs/adr/0003-contexto-em-quatro-camadas.md
// and F1 of docs/PRD.md): five rules, four fixed fields each, no data.
const DOCUMENT = fileURLToPath(
  new URL("../context/02-politicas.md", import.meta.url),
);

const RULES = [
  { id: "P1", heading: "P1 — Tema proibido" },
  { id: "P2", heading: "P2 — Linguagem formal" },
  { id: "P3", heading: "P3 — Escopo" },
  { id: "P4", heading: "P4 — Encaminhamento a humanos" },
  { id: "P5", heading: "P5 — Resistência a manipulação" },
] as const;

const LABELS = {
  identifier: "Identificador",
  description: "Descrição",
  example: "Exemplo de pergunta que aciona a regra",
  behaviour: "Comportamento esperado",
} as const;

// The only rule whose description holds a nested list, and its item count.
const RULE_WITH_NESTED_LIST = "P4";
const NESTED_LIST_ITEMS = 6;

// Written as code points: an invisible character in the source is easy to lose.
const BOM = String.fromCodePoint(0xfeff);
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const KEYCAP = String.fromCodePoint(0x20e3);
const FIELD_LINE = /^- \*\*(.+?):\*\*(.*)$/;
const NESTED_ITEM_LINE = /^\s+- \S/;

interface Field {
  label: string;
  value: string;
}

interface Section {
  heading: string;
  fields: Field[];
  nestedItems: number;
}

function readDocument(): string {
  return readFileSync(DOCUMENT, "utf8");
}

/** Splits the document into its H2 sections and their top-level fields. */
function parseSections(content: string): Section[] {
  const sections: Section[] = [];
  let section: Section | undefined;
  let field: Field | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      section = { heading: line.slice(3).trim(), fields: [], nestedItems: 0 };
      sections.push(section);
      field = undefined;
      continue;
    }
    if (section === undefined) {
      continue;
    }
    const match = FIELD_LINE.exec(line);
    const label = match?.[1];
    if (label !== undefined) {
      field = { label, value: (match?.[2] ?? "").trim() };
      section.fields.push(field);
      continue;
    }
    if (NESTED_ITEM_LINE.test(line)) {
      section.nestedItems += 1;
    }
    // Continuation lines belong to the field above them.
    if (field !== undefined && line.trim() !== "") {
      field.value = `${field.value}\n${line.trim()}`.trim();
    }
  }
  return sections;
}

function findSection(id: string): Section {
  const section = parseSections(readDocument()).find((candidate) =>
    candidate.heading.startsWith(`${id} `),
  );
  if (section === undefined) {
    throw new Error(`Section ${id} not found`);
  }
  return section;
}

function fieldValues(section: Section, label: string): string[] {
  return section.fields
    .filter((field) => field.label === label)
    .map((field) => field.value);
}

describe("policies document", () => {
  it("exists, is not empty and has no BOM", () => {
    expect(existsSync(DOCUMENT)).toBe(true);

    const content = readDocument();

    expect(content.trim()).not.toBe("");
    expect(content.startsWith(BOM)).toBe(false);
  });

  it("has exactly the five rule sections, in order", () => {
    const headings = parseSections(readDocument()).map(
      (section) => section.heading,
    );

    expect(headings).toEqual(RULES.map((rule) => rule.heading));
  });

  it.each(RULES)("gives $id the four fields, once each", ({ id }) => {
    const section = findSection(id);

    expect(section.fields.map((field) => field.label).sort()).toEqual(
      Object.values(LABELS).sort(),
    );
    for (const field of section.fields) {
      expect(field.value).not.toBe("");
    }
  });

  it.each(RULES)("repeats in $id the identifier of its heading", ({ id }) => {
    expect(fieldValues(findSection(id), LABELS.identifier)).toEqual([id]);
  });

  it.each(RULES)("shows in $id a quoted example question", ({ id }) => {
    const [example] = fieldValues(findSection(id), LABELS.example);

    expect(example).toMatch(/"[^"]+\?"/);
  });

  it.each(RULES)("keeps the nested list of $id as agreed", ({ id }) => {
    const expected = id === RULE_WITH_NESTED_LIST ? NESTED_LIST_ITEMS : 0;

    expect(findSection(id).nestedItems).toBe(expected);
  });

  it("holds no digit other than the rule identifiers", () => {
    const withoutIdentifiers = readDocument().replace(/P[1-5](?!\d)/g, "");

    expect(withoutIdentifiers).not.toMatch(/\d/);
  });

  it.each(["@", "http", "www.", "R$"])("does not contain %s", (marker) => {
    expect(readDocument().toLowerCase()).not.toContain(marker.toLowerCase());
  });

  it("has no emoji", () => {
    expect(readDocument()).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("is left untouched by the redaction of secrets", () => {
    const content = readDocument();

    expect(redact(content)).toBe(content);
  });
});

// Lists of every kind, by the field that holds them. "stray" counts the items
// that are outside the agreed place: before the first rule, at the top level
// of a rule without being one of its fields, or with another kind of marker.
function countListItems(content: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let heading: string | undefined;
  let label: string | undefined;

  const add = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      heading = line.slice(3).trim();
      label = undefined;
      continue;
    }
    const match = FIELD_LINE.exec(line);
    if (heading !== undefined && match?.[1] !== undefined) {
      label = match[1];
      continue;
    }
    if (!/^\s*(?:[-*+]|\p{N}+[.)])\s/u.test(line)) {
      continue;
    }
    const isNested = NESTED_ITEM_LINE.test(line);
    if (heading === undefined || label === undefined || !isNested) {
      add("stray");
    } else {
      add(`${heading.slice(0, 2)}/${label}`);
    }
  }
  return counts;
}

describe("policies document: file format", () => {
  it("uses line feeds only, with no other blank character than the space", () => {
    // Carriage return, tab, no-break space and the like.
    expect(readDocument()).not.toMatch(/[^\S \n]/u);
  });

  it("ends with a single line break and has no trailing space", () => {
    const content = readDocument();

    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
    expect(content).not.toMatch(/ $/m);
  });

  it("is valid UTF-8 with no invisible character", () => {
    const content = readDocument();

    // What the decoder leaves in place of a byte that is not UTF-8.
    expect(content).not.toContain(REPLACEMENT_CHARACTER);
    // Zero-width characters, direction marks and a BOM anywhere.
    expect(content).not.toMatch(/\p{Cf}/u);
  });

  it("has no emoji made of flags, keycaps or variation selectors", () => {
    expect(readDocument()).not.toMatch(
      /\p{Regional_Indicator}|\p{Variation_Selector}/u,
    );
    expect(readDocument()).not.toContain(KEYCAP);
  });

  it("holds no number of any script other than the rule identifiers", () => {
    const withoutIdentifiers = readDocument().replace(/P[1-5](?!\p{N})/gu, "");

    expect(withoutIdentifiers).not.toMatch(/\p{N}/u);
  });

  it.each(["%", "$", "€", "£"])("does not contain %s", (marker) => {
    expect(readDocument()).not.toContain(marker);
  });

  it("has nothing shaped like an address (a dot or a slash inside a word)", () => {
    expect(readDocument()).not.toMatch(/\p{L}[./\\]\p{L}/u);
  });
});

describe("policies document: layout", () => {
  it("has one title on the first line and no heading besides the rules", () => {
    const lines = readDocument().split("\n");
    const levels = lines
      .filter((line) => /^#+(?:\s|$)/.test(line))
      .map((line) => line.indexOf(" "));

    expect(lines[0]).toMatch(/^# \S/);
    expect(levels).toEqual([1, ...RULES.map(() => 2)]);
    // Underlined headings.
    expect(readDocument()).not.toMatch(/^\s*(?:=+|-{2,})\s*$/m);
  });

  it.each(RULES)("lists the fields of $id in the agreed order", ({ id }) => {
    expect(findSection(id).fields.map((field) => field.label)).toEqual(
      Object.values(LABELS),
    );
  });

  it("keeps its only list inside the description of the agreed rule", () => {
    expect(countListItems(readDocument())).toEqual({
      [`${RULE_WITH_NESTED_LIST}/${LABELS.description}`]: NESTED_LIST_ITEMS,
    });
  });

  it.each(RULES)(
    "fills the example of $id with one quoted question",
    ({ id }) => {
      const [example] = fieldValues(findSection(id), LABELS.example);

      expect(example).toMatch(/^"[^"]+\?"$/);
    },
  );

  it("gives each rule an example of its own", () => {
    const examples = RULES.flatMap(({ id }) =>
      fieldValues(findSection(id), LABELS.example),
    );

    expect(new Set(examples).size).toBe(RULES.length);
  });
});
