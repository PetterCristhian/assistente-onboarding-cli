// Places where a key was once missed because the character right before it
// is a letter or a digit (QA of ENG-44, B6). Each entry builds the text around
// the given secret, so the same list serves redact(), the scan and the writer.
export type Placement = readonly [label: string, build: (s: string) => string];

const ESC = "\x1b";

/** The letter or digit before the key is the end of an escape sequence. */
export const AFTER_AN_ESCAPE: readonly Placement[] = [
  [
    "a line break inside a JSON string",
    (s) => JSON.stringify({ pergunta: `minha chave antiga:\n${s}` }),
  ],
  ["a tab inside a JSON string", (s) => JSON.stringify({ p: `chave\t${s}` })],
  [
    "a carriage return inside a JSON string",
    (s) => JSON.stringify({ p: `chave\r${s}` }),
  ],
  ["CRLF inside a JSON string", (s) => JSON.stringify({ p: `chave\r\n${s}` })],
  [
    "a line break in JSON serialized twice",
    (s) => JSON.stringify(JSON.stringify({ p: `chave:\n${s}` })),
  ],
  ["a literal \\u003d", (s) => `OPENAI_API_KEY\\u003d${s}`],
  ["a literal \\u0022", (s) => `{\\u0022k\\u0022:\\u0022${s}\\u0022}`],
  ["a literal \\u000a", (s) => `linha\\u000a${s}`],
  ["a literal \\x3d", (s) => `k\\x3d${s}`],
  ["%20 in a URL", (s) => `Authorization%3A%20Bearer%20${s}`],
  ["%3D in a URL", (s) => `https://x.invalid/?api_key%3D${s}&n=1`],
  ["%3A in a URL", (s) => `chave%3A${s}`],
  ["an ANSI colour", (s) => `${ESC}[31m${s}${ESC}[0m`],
  ["an ANSI reset", (s) => `erro${ESC}[0m${s}`],
  [
    "an ANSI reset inside a JSON string",
    (s) => JSON.stringify({ p: `${ESC}[0m${s}` }),
  ],
];

/** The key is glued to an ordinary word or number. */
export const GLUED_TO_A_WORD: readonly Placement[] = [
  ["Bearer with no space", (s) => `Authorization: Bearer${s}`],
  ["apikey", (s) => `apikey${s}`],
  ["a status code", (s) => `401${s}`],
];

/** Ordinary text that must never be taken for a key. */
export const ORDINARY_TEXT: readonly string[] = [
  "***task-force***",
  "disk-***",
  "***risk-x***",
  "task-force-management-department",
  "helpdesk-abertura-de-chamados-ti",
  "**negrito**",
  "task-list",
  "risk-based",
];
