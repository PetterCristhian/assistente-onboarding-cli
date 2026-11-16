import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redact } from "../src/security/redact.js";

// Contract of the policies document (docs/adr/0003-contexto-em-quatro-camadas.md
// and F1 of docs/PRD.md): five rules, four fixed fields each, no data.
const DOCUMENT = new URL("../context/02-politicas.md", import.meta.url);

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

const BOM = "﻿";
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
