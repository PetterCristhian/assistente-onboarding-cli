// Cross-file consistency of the content of context/: what the structural
// tests of each file do not see. Channels, addresses, extensions and subjects
// are read from the files and never written here.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_ROOT,
  extractEmails,
  headings,
  listContextFiles,
  listContextFolder,
  readContextFile,
  sectionBody,
  tableRows,
} from "./helpers/context-files.js";

const COMPANY_FOLDER = "04-empresa";
const PROFILE_FOLDER = "03-usuario";
const CONTACTS = `${COMPANY_FOLDER}/contatos.md`;
const GLOBAL_INSTRUCTIONS = "01-instrucoes-globais.md";
const MESSAGE = "fallback.md";

const CONTACT_SECTIONS = {
  bySubject: "Contatos por assunto",
  byCase: "Canais humanos por tipo de caso",
  general: "Canal geral",
} as const;

// An internal extension: four digits standing alone.
const EXTENSION = /(?<!\d)\d{4}(?!\d)/g;

const SUBJECT_FILES = listContextFolder(COMPANY_FOLDER).filter(
  (path) => path !== CONTACTS,
);

interface Channel {
  name: string;
  emails: string[];
  extensions: string[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function contactSection(heading: string): string {
  return sectionBody(readContextFile(CONTACTS), heading);
}

/** One entry per table row: the second cell names the channel. */
function channelRows(heading: string): Channel[] {
  return tableRows(contactSection(heading)).map((row) => {
    const contact = row.slice(2).join(" | ");
    const emails = extractEmails(contact).map(normalize);
    const withoutEmails = emails.reduce(
      (text, email) => text.replace(new RegExp(email, "i"), " "),
      contact,
    );
    return {
      name: normalize(row[1] ?? ""),
      emails,
      extensions: withoutEmails.match(EXTENSION) ?? [],
    };
  });
}

function allChannelRows(): Channel[] {
  return [
    ...channelRows(CONTACT_SECTIONS.bySubject),
    ...channelRows(CONTACT_SECTIONS.byCase),
  ];
}

/** Distinct values of `value` seen for each `key`, over every table row. */
function group(
  key: (channel: Channel) => string,
  value: (channel: Channel) => string[],
): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const channel of allChannelRows()) {
    const values = groups.get(key(channel)) ?? new Set<string>();
    for (const item of value(channel)) {
      values.add(item);
    }
    groups.set(key(channel), values);
  }
  return groups;
}

/** The channel whose address is the one of the general channel section. */
function generalChannel(): Channel {
  const emails = [
    ...new Set(
      extractEmails(contactSection(CONTACT_SECTIONS.general)).map(normalize),
    ),
  ];
  const found = allChannelRows().find((channel) =>
    channel.emails.some((email) => emails.includes(email)),
  );
  if (found === undefined) {
    throw new Error("The general channel is in no table of the contacts");
  }
  return found;
}

/** Bodies of the H2 sections of a document, by heading. */
function sectionBodies(path: string): { heading: string; body: string }[] {
  const content = readContextFile(path);
  return headings(content, 2).map((heading) => ({
    heading,
    body: sectionBody(content, heading),
  }));
}

describe("context consistency: folder", () => {
  it("holds nothing but the Markdown and JSON files that the tests read", () => {
    const entries = readdirSync(CONTEXT_ROOT, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    expect(entries).toHaveLength(listContextFiles().length);
  });

  it("has no folder inside the folders of the layers", () => {
    const deep = listContextFiles().filter(
      (path) => path.split("/").length > 2,
    );

    expect(deep).toEqual([]);
  });
});

describe("context consistency: table reader", () => {
  it("keeps a body row whose cells are all empty", () => {
    const table = ["| a | b |", "| --- | :-: |", "| | |", "| c | d |"];

    expect(tableRows(table.join("\n"))).toEqual([
      ["", ""],
      ["c", "d"],
    ]);
  });
});

describe("context consistency: channels", () => {
  it("reads a channel name on every row of the two tables", () => {
    const rows = allChannelRows();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.name).not.toBe("");
    }
  });

  it("gives each channel name one e-mail address, everywhere", () => {
    const byName = group(
      (channel) => channel.name,
      (channel) => channel.emails,
    );

    for (const [name, emails] of byName) {
      expect([name, emails.size]).toEqual([name, 1]);
    }
  });

  it("gives each e-mail address one channel name, everywhere", () => {
    const byEmail = new Map<string, Set<string>>();
    for (const channel of allChannelRows()) {
      for (const email of channel.emails) {
        byEmail.set(
          email,
          (byEmail.get(email) ?? new Set<string>()).add(channel.name),
        );
      }
    }

    for (const [email, names] of byEmail) {
      expect([email, names.size]).toEqual([email, 1]);
    }
  });

  it("gives each channel one four-digit extension, used by no other", () => {
    const byName = group(
      (channel) => channel.name,
      (channel) => channel.extensions,
    );
    const extensions = [...byName.values()].flatMap((values) => [...values]);

    for (const [name, values] of byName) {
      expect([name, values.size]).toEqual([name, 1]);
    }
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it("writes on every row the one extension of its channel", () => {
    for (const row of allChannelRows()) {
      expect([row.name, row.extensions.length]).toEqual([row.name, 1]);
    }
  });

  it("names in the general channel section a channel of the tables, with the same extension", () => {
    const section = contactSection(CONTACT_SECTIONS.general);
    const channel = generalChannel();

    expect(normalize(section)).toContain(channel.name);
    expect(section.match(EXTENSION) ?? []).toEqual(channel.extensions);
  });

  it("lists in the table of subjects only subjects that exist in the data", () => {
    const subjects = SUBJECT_FILES.flatMap((path) =>
      headings(readContextFile(path), 2).map(normalize),
    );
    const listed = tableRows(contactSection(CONTACT_SECTIONS.bySubject)).map(
      (row) => normalize(row[0] ?? ""),
    );

    expect(listed.length).toBeGreaterThan(0);
    for (const subject of listed) {
      expect(subjects).toContain(subject);
    }
  });
});

describe("context consistency: fixed safe message", () => {
  it("names the general channel as the contacts file names it", () => {
    expect(normalize(readContextFile(MESSAGE))).toContain(
      generalChannel().name,
    );
  });

  it("holds no number that the general channel section does not hold", () => {
    const section = contactSection(CONTACT_SECTIONS.general);
    const numbers = readContextFile(MESSAGE).match(/\p{N}+/gu) ?? [];

    for (const number of numbers) {
      expect(section).toContain(number);
    }
  });

  it.each(["_", "`", "|", ">", "[", "{", "<"])(
    "has no markup or placeholder character %s",
    (marker) => {
      expect(readContextFile(MESSAGE)).not.toContain(marker);
    },
  );
});

describe("context consistency: sections", () => {
  it.each(
    [GLOBAL_INSTRUCTIONS, ...SUBJECT_FILES].flatMap((path) =>
      sectionBodies(path).map((section) => ({ path, ...section })),
    ),
  )("writes something under $heading of $path", ({ body }) => {
    expect(body.trim()).not.toBe("");
  });
});

describe("context consistency: data", () => {
  const DATA_FILES = [
    ...listContextFolder(COMPANY_FOLDER),
    ...listContextFolder(PROFILE_FOLDER),
  ];

  it("finds the data files", () => {
    expect(DATA_FILES.length).toBeGreaterThan(0);
  });

  it.each(DATA_FILES)("does not address the reader in %s", (path) => {
    // Data states facts in the third person. An order is written to someone.
    expect(readContextFile(path)).not.toMatch(
      /(?<!\p{L})(?:você|vocês|tu)(?!\p{L})/iu,
    );
  });

  it.each(DATA_FILES)("names no automated agent in %s", (path) => {
    expect(readContextFile(path)).not.toMatch(
      /(?<!\p{L})(?:robô|bot|IA|prompt|modelo de linguagem|inteligência artificial)(?!\p{L})/u,
    );
  });

  it.each(DATA_FILES)("has no telephone-shaped number in %s", (path) => {
    const content = readContextFile(path);

    // Five or more digits in a row, two groups joined by a hyphen, an area
    // code in brackets, a toll-free prefix.
    expect(content).not.toMatch(/\d{5,}/);
    expect(content).not.toMatch(/\d{4,5}-\d{4}(?!\d)/);
    expect(content).not.toMatch(/\(\d{2,3}\)/);
    expect(content).not.toMatch(/(?<!\d)0[38]00(?!\d)/);
  });

  it.each(listContextFiles())(
    "has in %s no host name outside an e-mail address",
    (path) => {
      const content = readContextFile(path);
      const withoutEmails = extractEmails(content).reduce(
        (text, email) => text.replace(email, " "),
        content,
      );

      // name.suffix with no space: a web address written without a scheme.
      expect(withoutEmails).not.toMatch(/[\p{L}\p{N}-]+\.\p{L}{2,}/u);
    },
  );

  it.each(
    listContextFolder(PROFILE_FOLDER).filter((path) => path.endsWith(".json")),
  )("writes each key of %s once", (path) => {
    // JSON.parse keeps the last of two equal keys and says nothing.
    const keys = [...readContextFile(path).matchAll(/^\s*"([^"]+)"\s*:/gm)].map(
      (match) => match[1],
    );

    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
