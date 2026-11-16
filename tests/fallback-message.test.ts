// The fixed safe message (docs/adr/0004-streaming-e-self-critique.md): plain
// text shown as it is on the terminal, pointing to the general channel of the
// contacts file. The address is read from the data and never written here.
import { describe, expect, it } from "vitest";
import {
  extractEmails,
  readContextFile,
  sectionBody,
} from "./helpers/context-files.js";

const MESSAGE = "fallback.md";
const CONTACTS = "04-empresa/contatos.md";
const GENERAL_CHANNEL_SECTION = "Canal geral";

function readMessage(): string {
  return readContextFile(MESSAGE);
}

describe("fixed safe message", () => {
  it("is not empty", () => {
    expect(readMessage().trim()).not.toBe("");
  });

  it("is a single paragraph", () => {
    expect(readMessage().trimEnd()).not.toContain("\n");
  });

  it.each(["#", "*"])("has no Markdown marker %s", (marker) => {
    expect(readMessage()).not.toContain(marker);
  });

  it("has no list item", () => {
    expect(readMessage()).not.toMatch(/^\s*(?:[-*+]|\p{N}+[.)])\s/mu);
  });

  it("has no emoji", () => {
    expect(readMessage()).not.toMatch(
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Variation_Selector}/u,
    );
  });

  it("points only to the general channel of the contacts file", () => {
    const general = extractEmails(
      sectionBody(readContextFile(CONTACTS), GENERAL_CHANNEL_SECTION),
    );
    const cited = extractEmails(readMessage());

    expect(cited.length).toBeGreaterThan(0);
    for (const email of cited) {
      expect(general).toContain(email);
    }
  });
});
