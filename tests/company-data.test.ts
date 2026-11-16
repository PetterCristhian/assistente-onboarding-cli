// Structure of the company knowledge base of context/04-empresa/ (layer 4 of
// docs/adr/0003-contexto-em-quatro-camadas.md) and its ties to the policies
// document. Subjects, channels and addresses are read from the files.
import { describe, expect, it } from "vitest";
import {
  extractEmails,
  headings,
  listContextFolder,
  readContextFile,
  readContextFiles,
  sectionBody,
  tableRows,
} from "./helpers/context-files.js";

const COMPANY_FOLDER = "04-empresa";
const PROFILE_FOLDER = "03-usuario";
const CONTACTS = `${COMPANY_FOLDER}/contatos.md`;
const POLICIES = "02-politicas.md";

// docs/ARQUITETURA.md, section 6.
const COMPANY_FILES = [
  "beneficios.md",
  "contatos.md",
  "ferramentas.md",
  "normas-internas.md",
  "processos.md",
].map((name) => `${COMPANY_FOLDER}/${name}`);

const SUBJECT_FILES = COMPANY_FILES.filter((path) => path !== CONTACTS);

const CONTACT_SECTIONS = {
  bySubject: "Contatos por assunto",
  byCase: "Canais humanos por tipo de caso",
  general: "Canal geral",
} as const;

// The rule of the policies document that lists the critical cases.
const ESCALATION_RULE = "P4";
const CRITICAL_CASES = 6;

function readContacts(): string {
  return readContextFile(CONTACTS);
}

/** Ignores case, surrounding spaces and the punctuation that ends an item. */
function normalize(text: string): string {
  return text
    .trim()
    .replace(/[;.:,]+$/, "")
    .trim()
    .toLowerCase();
}

/** The nested list of the escalation rule, as written in the policies. */
function criticalCases(): string[] {
  const policies = readContextFile(POLICIES);
  const heading = headings(policies, 2).find((candidate) =>
    candidate.startsWith(`${ESCALATION_RULE} `),
  );
  if (heading === undefined) {
    throw new Error(`Rule ${ESCALATION_RULE} not found`);
  }
  return sectionBody(policies, heading)
    .split("\n")
    .flatMap((line) => {
      const item = /^\s+- (\S.*)$/.exec(line)?.[1];
      return item === undefined ? [] : [normalize(item)];
    });
}

function caseRows(): string[][] {
  return tableRows(sectionBody(readContacts(), CONTACT_SECTIONS.byCase));
}

function subjectRows(): string[][] {
  return tableRows(sectionBody(readContacts(), CONTACT_SECTIONS.bySubject));
}

function generalEmails(): string[] {
  return [
    ...new Set(
      extractEmails(sectionBody(readContacts(), CONTACT_SECTIONS.general)),
    ),
  ];
}

describe("company data", () => {
  it("is made of exactly the five files of the architecture", () => {
    expect(listContextFolder(COMPANY_FOLDER)).toEqual(COMPANY_FILES);
  });

  it.each(COMPANY_FILES)("gives %s one title, on the first line", (path) => {
    const content = readContextFile(path);

    expect(content.split("\n")[0]).toMatch(/^# \S/);
    expect(headings(content, 1)).toHaveLength(1);
  });

  it.each(SUBJECT_FILES)("splits %s into subjects", (path) => {
    const subjects = headings(readContextFile(path), 2);

    expect(subjects.length).toBeGreaterThan(0);
    expect(new Set(subjects.map(normalize)).size).toBe(subjects.length);
  });

  it.each([
    ...listContextFolder(COMPANY_FOLDER),
    ...listContextFolder(PROFILE_FOLDER),
  ])("holds in %s data only, with no word about the chatbot", (path) => {
    const content = readContextFile(path);

    expect(content).not.toMatch(/assistente|chatbot/i);
    expect(content).not.toMatch(/P[1-5]/);
  });
});

describe("company data: contacts", () => {
  it("has the three sections, in order", () => {
    expect(headings(readContacts(), 2)).toEqual(
      Object.values(CONTACT_SECTIONS),
    );
  });

  it("reads the critical cases from the policies document", () => {
    const cases = criticalCases();

    expect(cases).toHaveLength(CRITICAL_CASES);
    expect(new Set(cases).size).toBe(CRITICAL_CASES);
  });

  it("lists one human channel for each critical case of the policies", () => {
    const listed = caseRows().map((row) => normalize(row[0] ?? ""));

    expect(listed).toEqual(criticalCases());
  });

  it("gives each critical case a channel name and one e-mail address", () => {
    const rows = caseRows();

    expect(rows).toHaveLength(CRITICAL_CASES);
    for (const row of rows) {
      expect(row.every((cell) => cell !== "")).toBe(true);
      expect(extractEmails(row.join(" | "))).toHaveLength(1);
    }
  });

  it("names exactly one general channel address", () => {
    expect(generalEmails()).toHaveLength(1);
  });

  it("gives the critical cases and the general channel distinct addresses", () => {
    const addresses = [
      ...caseRows().flatMap((row) => extractEmails(row.join(" | "))),
      ...generalEmails(),
    ].map((email) => email.toLowerCase());

    expect(addresses).toHaveLength(CRITICAL_CASES + 1);
    expect(new Set(addresses).size).toBe(CRITICAL_CASES + 1);
  });

  it.each(
    readContextFiles(SUBJECT_FILES).flatMap((file) =>
      headings(file.content, 2).map((subject) => ({
        path: file.path,
        subject,
      })),
    ),
  )(
    "has one contact row, with one e-mail address, for $subject of $path",
    ({ subject }) => {
      const rows = subjectRows().filter(
        (row) => normalize(row[0] ?? "") === normalize(subject),
      );

      expect(rows).toHaveLength(1);
      expect(extractEmails((rows[0] ?? []).join(" | "))).toHaveLength(1);
    },
  );
});
