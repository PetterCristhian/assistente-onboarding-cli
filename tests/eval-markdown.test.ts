// The sanitizers of the report: text that a model wrote must never close a
// fence, open a heading, a link, a table or HTML, nor hide behind invisible
// characters. Includes a light, seeded fuzz (no randomness between runs).
import { describe, expect, it } from "vitest";
import {
  TRUNCATION_NOTE,
  fenceBlock,
  inlineText,
  tableCell,
  truncateBlock,
  untrustedBlock,
  visibleControls,
} from "../evals/markdown.js";

const cp = String.fromCodePoint;

/** The lines of a block that CommonMark would take as its closing fence. */
function closingLines(block: string): number[] {
  const lines = block.split("\n");
  const open = /^`+/.exec(lines[0] ?? "")?.[0].length ?? 0;
  return lines.flatMap((line, index) =>
    index > 0 && new RegExp(`^ {0,3}\`{${open},}\\s*$`).test(line)
      ? [index]
      : [],
  );
}

/** A small seeded generator (mulberry32): the fuzz is the same on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  "`",
  "``",
  "```",
  "~~~",
  "\n",
  "\r",
  "\t",
  " ",
  "#",
  "*",
  "_",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "|",
  "!",
  "&",
  "\\",
  "http://x",
  "www.x",
  "a",
  "ç",
  "\u001b",
  cp(0x202e),
  cp(0x200b),
  cp(0xe0041),
  cp(0x1f600),
];

function randomText(next: () => number): string {
  const length = Math.floor(next() * 40);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "";
  }
  return text;
}

describe("fenceBlock", () => {
  it("uses at least 4 backticks and one more than the longest run", () => {
    expect(fenceBlock("oi")).toBe("````\noi\n````");
    expect(fenceBlock("a ``` b")).toBe("````\na ``` b\n````");
    expect(fenceBlock("a ```` b")).toBe("`````\na ```` b\n`````");
    expect(fenceBlock("`".repeat(9))).toBe(
      `${"`".repeat(10)}\n${"`".repeat(9)}\n${"`".repeat(10)}`,
    );
  });

  it("is never closed by the text, whatever the text is (fuzz)", () => {
    const next = generator(7);
    for (let round = 0; round < 500; round += 1) {
      const block = fenceBlock(randomText(next));
      const lines = block.split("\n");
      expect(closingLines(block)).toEqual([lines.length - 1]);
    }
  });

  it("is not closed by a fence line inside the text", () => {
    const block = fenceBlock("antes\n```\n# titulo\n````\ndepois");
    expect(closingLines(block)).toEqual([block.split("\n").length - 1]);
  });
});

describe("visibleControls", () => {
  it("shows controls, format characters and tag characters as ⟦U+XXXX⟧", () => {
    expect(visibleControls("a\u001bb")).toBe("a⟦U+001B⟧b");
    expect(visibleControls(`x${cp(0x202e)}y`)).toBe("x⟦U+202E⟧y");
    expect(visibleControls(`x${cp(0x200b)}${cp(0x00ad)}`)).toBe(
      "x⟦U+200B⟧⟦U+00AD⟧",
    );
    expect(visibleControls(`${cp(0xe0041)}${cp(0xe0001)}${cp(0xe0002)}`)).toBe(
      "⟦U+E0041⟧⟦U+E0001⟧⟦U+E0002⟧",
    );
    expect(visibleControls("a\u0085b\u007fc")).toBe("a⟦U+0085⟧b⟦U+007F⟧c");
    expect(visibleControls("a b")).toBe("a⟦U+2028⟧b");
  });

  it("keeps the line break and the tab, reads CRLF as LF and shows a lone CR", () => {
    expect(visibleControls("a\nb\tc")).toBe("a\nb\tc");
    expect(visibleControls("a\r\nb")).toBe("a\nb");
    expect(visibleControls("a\rb")).toBe("a⟦U+000D⟧b");
  });

  it("leaves ordinary text, accents and emoji alone", () => {
    expect(visibleControls("Olá, ação! 😀")).toBe("Olá, ação! 😀");
  });

  it("leaves no control or format character behind (fuzz)", () => {
    const next = generator(11);
    for (let round = 0; round < 300; round += 1) {
      const shown = visibleControls(randomText(next));
      expect(shown.replace(/[\n\t]/g, "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
  });
});

describe("truncateBlock", () => {
  it("keeps a short text and cuts a long one with the note", () => {
    expect(truncateBlock("curto")).toBe("curto");
    expect(truncateBlock("a".repeat(4000))).toBe("a".repeat(4000));
    const cut = truncateBlock("a".repeat(4001));
    expect(cut).toBe(`${"a".repeat(4000)}\n${TRUNCATION_NOTE}`);
    expect(TRUNCATION_NOTE).toContain("execucoes.jsonl");
  });

  it("does not split a surrogate pair", () => {
    const cut = truncateBlock("😀".repeat(10), 3);
    expect(cut.startsWith("😀😀😀\n")).toBe(true);
  });
});

describe("inlineText", () => {
  it("escapes every sign of Markdown", () => {
    expect(inlineText("# t [l](http://x) <b> a|b *_`~!")).toBe(
      "\\# t \\[l\\]\\(http:\\//x\\) \\<b\\> a\\|b \\*\\_\\`\\~\\!",
    );
  });

  it("flattens line breaks and tabs", () => {
    expect(inlineText("a\n\n# b\tc\r\nd")).toBe("a \\# b c d");
  });

  it("cuts at max characters and says so with an ellipsis", () => {
    expect(inlineText("a".repeat(10), 4)).toBe("aaaa…");
    expect(inlineText("a".repeat(300))).toBe("a".repeat(300));
    expect([...inlineText("a".repeat(301))]).toHaveLength(301);
  });

  it("makes the invisible visible", () => {
    expect(inlineText(`a${cp(0x202e)}b\u001b`)).toBe("a⟦U+202E⟧b⟦U+001B⟧");
  });

  it("breaks the automatic links", () => {
    expect(inlineText("http://x e https://y e www.z.com")).not.toMatch(
      /:\/\/|www\./i,
    );
  });

  it("leaves only escaped signs, on one line (fuzz)", () => {
    const next = generator(13);
    for (let round = 0; round < 500; round += 1) {
      const text = inlineText(randomText(next), 30);
      expect(text).not.toMatch(/[\n\r]/);
      // Take away every escaped pair: no sign may be left.
      const rest = text.replace(/\\./gu, "");
      expect(rest).not.toMatch(/[\\`*_[\]()<>|#!~&]/);
      expect(text).not.toMatch(/:\/\//);
      expect(text).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
  });
});

describe("tableCell and untrustedBlock", () => {
  it("escapes the pipe of a cell and keeps it on one line", () => {
    expect(tableCell("a | b\nc")).toBe("a \\| b c");
  });

  it("composes the visible controls, the cut and the fence", () => {
    const block = untrustedBlock(`x\u001b${"`".repeat(5)}${"y".repeat(5000)}`);
    expect(block.startsWith("``````\n")).toBe(true);
    expect(block).toContain("⟦U+001B⟧");
    expect(block).toContain(TRUNCATION_NOTE);
    expect(closingLines(block)).toEqual([block.split("\n").length - 1]);
  });
});
