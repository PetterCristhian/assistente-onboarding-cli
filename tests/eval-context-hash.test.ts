// The fingerprints of the battery (evals/context-hash.ts, ENG-57).
import { describe, expect, it } from "vitest";
import {
  HASH_PATTERN,
  hashContextFiles,
  hashText,
} from "../evals/context-hash.js";
import { readContextTree } from "../src/context/loaders.js";

// Written as a code point: an invisible character in the source is easy to lose.
const BOM = String.fromCodePoint(0xfeff);

const BASE = [
  { path: "01-a.md", text: "linha um\nlinha dois\n" },
  { path: "03-usuario/x.json", text: '{"a":1}\n' },
  { path: "juiz.md", text: "julgue\n" },
];

describe("hashContextFiles", () => {
  it("has the format sha256:<64 hex>", () => {
    expect(hashContextFiles(BASE)).toMatch(HASH_PATTERN);
    expect(hashText("x")).toMatch(HASH_PATTERN);
  });

  it("is the same with CRLF, CR or LF and with or without a BOM", () => {
    const crlf = BASE.map((file) => ({
      ...file,
      text: file.text.replaceAll("\n", "\r\n"),
    }));
    const bom = BASE.map((file) => ({ ...file, text: `${BOM}${file.text}` }));

    expect(hashContextFiles(crlf)).toBe(hashContextFiles(BASE));
    expect(hashContextFiles(bom)).toBe(hashContextFiles(BASE));
    expect(hashText("a\r\nb\rc")).toBe(hashText("a\nb\nc"));
    expect(hashText(`${BOM}a`)).toBe(hashText("a"));
  });

  it("does not trim: a final line break counts", () => {
    expect(hashText("a")).not.toBe(hashText("a\n"));
  });

  it("changes with one byte of one file", () => {
    const changed = BASE.map((file, index) =>
      index === 1 ? { ...file, text: '{"a":2}\n' } : file,
    );

    expect(hashContextFiles(changed)).not.toBe(hashContextFiles(BASE));
  });

  it("changes with the name of a file and with the judge prompt", () => {
    const renamed = BASE.map((file, index) =>
      index === 0 ? { ...file, path: "01-b.md" } : file,
    );
    const judge = BASE.map((file) =>
      file.path === "juiz.md" ? { ...file, text: "julgue!\n" } : file,
    );

    expect(hashContextFiles(renamed)).not.toBe(hashContextFiles(BASE));
    expect(hashContextFiles(judge)).not.toBe(hashContextFiles(BASE));
  });

  it("does not depend on the order of the list, nor on the separator of the path", () => {
    const reversed = [...BASE].reverse();
    const windows = BASE.map((file) => ({
      ...file,
      path: file.path.replaceAll("/", "\\"),
    }));

    expect(hashContextFiles(reversed)).toBe(hashContextFiles(BASE));
    expect(hashContextFiles(windows)).toBe(hashContextFiles(BASE));
  });

  it("tells apart where a file ends: a + bc is not ab + c", () => {
    const first = [
      { path: "x.md", text: "a" },
      { path: "y.md", text: "bc" },
    ];
    const second = [
      { path: "x.md", text: "ab" },
      { path: "y.md", text: "c" },
    ];

    expect(hashContextFiles(first)).not.toBe(hashContextFiles(second));
  });

  it("counts bytes, not characters", () => {
    const one = [{ path: "x.md", text: "é" }];
    const two = [{ path: "x.md", text: "e" }];

    expect(hashContextFiles(one)).not.toBe(hashContextFiles(two));
  });

  it("is the same for the tree of a folder that gets a hidden file", () => {
    const reader = (extra: boolean) => ({
      readText: (path: string): string => (path.endsWith("x.md") ? "a" : "b"),
      listFiles: (directory: string): string[] =>
        directory.endsWith("context")
          ? ["x.md", ...(extra ? [".x.md"] : [])]
          : [],
    });

    expect(hashContextFiles(readContextTree("context", reader(true)))).toBe(
      hashContextFiles(readContextTree("context", reader(false))),
    );
  });
});
