// The detailed mode (ENG-53): --verbose or /detalhes shows, after each answer,
// the technical line and the result of the self-evaluation, on stderr.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/chat/rate-limiter.js";
import { createChatSession } from "../src/chat/session.js";
import { runChat } from "../src/cli/chat-loop.js";
import {
  MAX_UNTRUSTED_LENGTH,
  createTerminalOutput,
  sanitizeForTerminal,
  sanitizeUntrusted,
} from "../src/cli/renderer.js";
import { createRedactor } from "../src/security/redact.js";
import {
  approvedStep,
  makeCritiqueDeps,
  rejectedStep,
} from "./helpers/critique-fixtures.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

// Written as code points: an invisible character in the source is easy to lose.
const CR = String.fromCodePoint(0x0d);
const ESC = String.fromCodePoint(0x1b);
const BIDI = String.fromCodePoint(0x202e);
const ZWJ = String.fromCodePoint(0x200d);
const ZWNJ = String.fromCodePoint(0x200c);
const TAG = String.fromCodePoint(0xe0041);
const MARKER = String.fromCodePoint(0xfffd);

function collect(stream: PassThrough): () => string {
  let text = "";
  stream.on("data", (data: Buffer) => {
    text += data.toString("utf8");
  });
  return () => text;
}

function setup(
  script: readonly FakeLlmStep[],
  options: { verbose?: boolean; maxQuestions?: number } = {},
) {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const fake = createFakeLlmClient(script);
  const session = createChatSession({
    llm: fake,
    instructions: "CTX",
    critique: makeCritiqueDeps(),
    output: createTerminalOutput(stdout, stderr),
    redact: createRedactor([]),
    ...(options.maxQuestions === undefined
      ? {}
      : {
          rateLimit: {
            limiter: createRateLimiter({
              maxRequests: options.maxQuestions,
              windowSeconds: 60,
              now: () => 0,
              sleep: () => Promise.reject(new Error("must not sleep")),
            }),
            mode: "refuse" as const,
          },
        }),
  });
  const done = runChat({
    input,
    stdout,
    stderr,
    session,
    contextText: "CTX",
    profileName: "Perfil",
    now: () => 0,
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
  });
  return { input, fake, out, err, done };
}

describe("/detalhes", () => {
  it("turns the details on and off, and says so on stdout", async () => {
    const { input, out, err, done } = setup([]);
    input.write("/detalhes\n");
    input.write("/detalhes\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(out()).toContain("Detalhes ligados.\n");
    expect(out()).toContain("Detalhes desligados.\n");
    expect(out().indexOf("ligados")).toBeLessThan(out().indexOf("desligados"));
    expect(err()).toBe("");
  });

  it("is listed in the help, and does not fall into the help branch", async () => {
    const { input, out, done } = setup([]);
    input.write("/detalhes\n");
    input.end("/sair\n");

    await done;

    // The help is printed once, at the start; /detalhes adds none.
    expect(out().split("Comandos:")).toHaveLength(2);
    expect(out()).toContain("/detalhes");
  });

  it("starts off: a turn prints nothing technical", async () => {
    const { input, out, err, done } = setup([{ text: "R" }, approvedStep()]);
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(err()).toBe("");
    expect(out()).not.toContain("[autoavaliação]");
    expect(out()).not.toContain("[detalhes]");
  });

  it("shows the result of the evaluation after the answer once it is on", async () => {
    const { input, err, done } = setup([
      { text: "R1" },
      approvedStep(),
      { text: "R2" },
      approvedStep(),
    ]);
    input.write("P1\n");
    input.write("/detalhes\n");
    input.write("P2\n");
    input.write("/detalhes\n");
    input.end("/sair\n");

    await done;

    expect(err().match(/\[autoavaliação\] aprovada\n/g)).toHaveLength(1);
    expect(err().match(/\[detalhes\] modelo=/g)).toHaveLength(1);
  });

  it("with --verbose the details start on, and /detalhes turns them off", async () => {
    const { input, err, done } = setup(
      [{ text: "R1" }, approvedStep(), { text: "R2" }, approvedStep()],
      { verbose: true },
    );
    input.write("P1\n");
    input.write("/detalhes\n");
    input.write("P2\n");
    input.end("/sair\n");

    await done;

    expect(err().match(/\[autoavaliação\]/g)).toHaveLength(1);
  });

  it("takes no slot of the rate limit", async () => {
    const { input, fake, out, done } = setup([{ text: "R" }, approvedStep()], {
      maxQuestions: 1,
    });
    for (let index = 0; index < 5; index += 1) {
      input.write("/detalhes\n");
    }
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(fake.calls).toHaveLength(2);
    expect(out()).toContain("R\n");
  });
});

describe("the result of the evaluation in the details", () => {
  it("approved: one short line", async () => {
    const { input, err, done } = setup([{ text: "R" }, approvedStep()], {
      verbose: true,
    });
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(err()).toBe(
      "[detalhes] modelo=fake-model trechos=1 tokens=?/? tempo=0ms\n[autoavaliação] aprovada\n",
    );
  });

  it("rejected, then revised: the rule, the reason, the origin and the calls", async () => {
    const { input, err, out, done } = setup(
      [
        { text: "RASCUNHO" },
        rejectedStep("P2", "usou gíria"),
        { text: "REVISAO" },
        approvedStep(),
      ],
      { verbose: true },
    );
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(err()).toContain(
      "[autoavaliação] reprovada: P2 (usou gíria); origem=revisao; chamadas=4\n",
    );
    expect(out()).toMatch(
      /RASCUNHO\n.*retirada.*regra P2: usou gíria.*\nREVISAO\n/s,
    );
  });

  it("the safe message as the origin", async () => {
    const { input, err, done } = setup(
      [{ text: "R" }, rejectedStep("P4"), { text: "V" }, rejectedStep("P4")],
      { verbose: true },
    );
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(err()).toContain(
      "reprovada: P4 (motivo de teste); origem=fallback; chamadas=4",
    );
  });

  it("an evaluation that failed: the error, summarized, and the origin", async () => {
    const error = Object.assign(new Error("falha na avaliação"), {
      status: 500,
      code: "server_error",
    });
    const { input, err, done } = setup([{ text: "R" }, { error }], {
      verbose: true,
    });
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(err()).toContain(
      "[autoavaliação] erro: falha na avaliação (status 500, código server_error); origem=fallback; chamadas=2\n",
    );
  });

  it("neutralizes a reason with a carriage return, bidi and tag characters", async () => {
    const reason = `um${CR}dois${BIDI}três${TAG}${ESC}[31m quatro`;
    const { input, err, out, done } = setup(
      [
        { text: "R" },
        rejectedStep("P1", reason),
        { text: "V" },
        approvedStep(),
      ],
      { verbose: true },
    );
    input.write("P\n");
    input.end("/sair\n");

    await done;

    for (const text of [err(), out()]) {
      expect(text).not.toContain(CR);
      expect(text).not.toContain(BIDI);
      expect(text).not.toContain(TAG);
      expect(text).not.toContain(ESC);
    }
    expect(err()).toContain(
      "[autoavaliação] reprovada: P1 (um dois três [31m quatro)",
    );
  });

  it("a line that is never longer than the limit", async () => {
    const { input, err, done } = setup(
      [
        { text: "R" },
        rejectedStep("P1", "x".repeat(5000)),
        { text: "V" },
        approvedStep(),
      ],
      { verbose: true },
    );
    input.write("P\n");
    input.end("/sair\n");

    await done;

    const line = err()
      .split("\n")
      .find((entry) => entry.startsWith("[autoavaliação] reprovada"));
    expect(line).toBeDefined();
    expect([...(line ?? "")].length).toBeLessThanOrEqual(MAX_UNTRUSTED_LENGTH);
  });

  it("prints nothing for a turn that was not answered", async () => {
    const { input, err, done } = setup([{ error: new Error("caiu") }], {
      verbose: true,
    });
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(err()).not.toContain("[autoavaliação]");
    expect(err()).not.toContain("[detalhes]");
  });
});

describe("the retraction on the screen", () => {
  it("goes to stdout, after the line of the draft and before the revision", async () => {
    const { input, out, err, done } = setup([
      { text: "RASCUNHO" },
      rejectedStep("P3", "inventou"),
      { text: "REVISAO" },
      approvedStep(),
    ]);
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(out()).toMatch(
      /^[\s\S]*RASCUNHO\nA resposta acima foi retirada[^\n]*regra P3: inventou[^\n]*\nREVISAO\n/,
    );
    expect(err()).not.toContain("retirada");
  });
});

describe("sanitizeForTerminal and the tag characters", () => {
  it("neutralizes the tag characters in the body of an answer", () => {
    expect(sanitizeForTerminal(`a${TAG}b`)).toBe(`a${MARKER}b`);
    expect(sanitizeForTerminal(String.fromCodePoint(0xe0000))).toBe(MARKER);
    expect(sanitizeForTerminal(String.fromCodePoint(0xe007f))).toBe(MARKER);
    expect(sanitizeForTerminal(String.fromCodePoint(0xe0080))).not.toBe(MARKER);
  });

  it("keeps the bidi marks and the joiners in the body, as before", () => {
    const text = `a${BIDI}b${ZWJ}c${ZWNJ}d`;

    expect(sanitizeForTerminal(text)).toBe(text);
  });
});

describe("sanitizeUntrusted", () => {
  it("neutralizes controls, line breaks, bidi and other format characters", () => {
    expect(sanitizeUntrusted(`a${BIDI}b${CR}c\nd\te${TAG}f${ESC}`)).toBe(
      `a${MARKER}b${MARKER}c${MARKER}d${MARKER}e${MARKER}f${MARKER}`,
    );
    expect(sanitizeUntrusted(`x${String.fromCodePoint(0xfeff)}y`)).toBe(
      `x${MARKER}y`,
    );
  });

  it("keeps the zero-width joiner and non-joiner", () => {
    const text = `a${ZWJ}b${ZWNJ}c`;

    expect(sanitizeUntrusted(text)).toBe(text);
  });

  it("keeps ordinary text, accents and emoji", () => {
    const text = "Ação é ótima: 👨‍👩‍👧 日本語";

    expect(sanitizeUntrusted(text)).toBe(text);
  });

  it("cuts a long text at the limit, by characters, with an ellipsis", () => {
    const cut = sanitizeUntrusted("é".repeat(MAX_UNTRUSTED_LENGTH + 50));

    expect([...cut]).toHaveLength(MAX_UNTRUSTED_LENGTH);
    expect(cut.endsWith("…")).toBe(true);
    expect(sanitizeUntrusted("é".repeat(MAX_UNTRUSTED_LENGTH))).toBe(
      "é".repeat(MAX_UNTRUSTED_LENGTH),
    );
    expect(sanitizeUntrusted("abcdef", 4)).toBe("abc…");
  });

  it("is what the notices and the retraction go through", () => {
    const out: string[] = [];
    const err: string[] = [];
    const output = createTerminalOutput(
      { write: (text) => out.push(text) },
      { write: (text) => err.push(text) },
    );

    output.notice("warning", `aviso${BIDI}${CR}fim`);
    output.retraction(`retirada${TAG}`);

    expect(err).toEqual([`aviso${MARKER}${MARKER}fim\n`]);
    expect(out).toEqual([`retirada${MARKER}\n`]);
  });
});
