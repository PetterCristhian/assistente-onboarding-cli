import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context/builder.js";
import { loadContextLayers } from "../src/context/loaders.js";
import { createChatSession } from "../src/chat/session.js";
import { runChat } from "../src/cli/chat-loop.js";
import { createTerminalOutput } from "../src/cli/renderer.js";
import { createRedactor } from "../src/security/redact.js";
import { type FakeLlmStep } from "./helpers/fake-llm-client.js";
import {
  createApprovingFakeClient,
  draftCalls,
  makeCritiqueDeps,
} from "./helpers/critique-fixtures.js";

const layers = loadContextLayers({}, { now: () => new Date(2025, 0, 6) });
const context = buildContext(layers);

function collect(stream: PassThrough): () => string {
  let text = "";
  stream.on("data", (data: Buffer) => {
    text += data.toString("utf8");
  });
  return () => text;
}

function setup(
  script: readonly FakeLlmStep[],
  shutdown?: AbortSignal,
  extra: {
    verbose?: boolean;
    now?: () => number;
    contextText?: string;
  } = {},
) {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const fake = createApprovingFakeClient(script);
  const session = createChatSession({
    llm: fake,
    instructions: context.text,
    critique: makeCritiqueDeps(),
    output: createTerminalOutput(stdout, stderr),
    redact: createRedactor([]),
  });
  const done = runChat({
    input,
    stdout,
    stderr,
    session,
    contextText: context.text,
    profileName: layers.userProfile.nome,
    ...extra,
    ...(shutdown === undefined ? {} : { shutdown }),
  });
  return { input, fake, out, err, done };
}

describe("runChat", () => {
  it("greets the profile and lists the commands", async () => {
    const { input, out, done } = setup([]);
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(out()).toContain(`Olá, ${layers.userProfile.nome}.`);
    expect(out()).toContain("/ajuda");
    expect(out()).toContain("/sair");
  });

  it("answers questions in sequence until /sair", async () => {
    const { input, fake, out, done } = setup([
      { text: "R1", chunks: ["R", "1"] },
      { text: "R2" },
    ]);
    input.write("P1\n");
    input.write("P2\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(draftCalls(fake)).toHaveLength(2);
    expect(out()).toContain("R1\n");
    expect(out()).toContain("R2\n");
  });

  it("exits with 0 at the end of the input", async () => {
    const { input, fake, done } = setup([{ text: "R" }]);
    input.end("P\n");

    expect(await done).toBe(0);
    expect(draftCalls(fake)).toHaveLength(1);
  });

  it("ignores empty lines and warns about unknown commands, without the model", async () => {
    const { input, fake, out, err, done } = setup([]);
    input.write("\n   \n");
    input.write("/xyz\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(draftCalls(fake)).toHaveLength(0);
    expect(err()).toContain("Comando desconhecido: /xyz. Digite /ajuda.");
    expect(out()).not.toContain("Comando desconhecido");
  });

  it("forgets the history on /limpar and says so", async () => {
    const { input, fake, out, done } = setup([{ text: "R1" }, { text: "R2" }]);
    input.write("P1\n/limpar\nP2\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(out()).toContain("Histórico apagado.");
    expect(draftCalls(fake).at(-1)?.request.input).toEqual([
      { role: "user", content: "P2" },
    ]);
  });

  it("prints exactly the context on /contexto and the help on /ajuda", async () => {
    const { input, fake, out, done } = setup([]);
    input.write("/contexto\n/ajuda\n");
    input.end("/sair\n");

    await done;
    expect(out()).toContain(`${context.text}\n`);
    expect(out().split("Comandos:")).toHaveLength(3);
    expect(draftCalls(fake)).toHaveLength(0);
  });

  it("keeps the chat open after a failed turn", async () => {
    const { input, fake, err, done } = setup([
      { error: new Error("caiu") },
      { text: "R2" },
    ]);
    input.write("P1\nP2\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(err()).toContain("caiu");
    expect(draftCalls(fake).at(-1)?.request.input).toEqual([
      { role: "user", content: "P2" },
    ]);
  });

  it("ends cleanly when shutdown is aborted during a held turn, twice", async () => {
    const controller = new AbortController();
    const held = new Promise<void>(() => undefined);
    const { input, fake, err, done } = setup(
      [{ text: "R", wait: held }],
      controller.signal,
    );
    input.write("P\n");
    while (draftCalls(fake).length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    controller.abort();
    controller.abort();

    expect(await done).toBe(0);
    expect(err()).not.toMatch(/^\s+at /m);
  });

  it("ends at once when shutdown is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fake, done } = setup([], controller.signal);

    expect(await done).toBe(0);
    expect(draftCalls(fake)).toHaveLength(0);
  });
});

describe("runChat with verbose (ENG-50)", () => {
  const USAGE = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };

  function fakeClock(...values: number[]): () => number {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)] ?? 0;
  }

  it("prints one technical line per answered turn to stderr", async () => {
    const { input, out, err, done } = setup(
      [{ text: "R1", chunks: ["R", "1"], usage: USAGE }, { text: "R2" }],
      undefined,
      { verbose: true, now: fakeClock(100, 350, 400, 400) },
    );
    input.write("P1\n");
    input.write("P2\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(err()).toBe(
      "[detalhes] modelo=fake-model trechos=2 tokens=12/34 tempo=250ms\n" +
        "[autoavaliação] aprovada\n" +
        "[detalhes] modelo=fake-model trechos=1 tokens=?/? tempo=0ms\n" +
        "[autoavaliação] aprovada\n",
    );
    expect(out()).not.toContain("[detalhes]");
  });

  it("never prints the question, the answer or the context", async () => {
    const { input, err, done } = setup(
      [{ text: "RESPOSTA-SECRETA" }],
      undefined,
      {
        verbose: true,
      },
    );
    input.write("PERGUNTA-SECRETA\n");
    input.end("/sair\n");

    await done;

    expect(err()).not.toContain("PERGUNTA-SECRETA");
    expect(err()).not.toContain("RESPOSTA-SECRETA");
    expect(err()).not.toContain(layers.policies.slice(0, 40));
  });

  it("prints nothing extra when verbose is false or absent", async () => {
    for (const extra of [{ verbose: false }, {}]) {
      const { input, err, done } = setup([{ text: "R" }], undefined, extra);
      input.write("P\n");
      input.end("/sair\n");

      await done;

      expect(err()).toBe("");
    }
  });

  it("prints no line for a turn that failed", async () => {
    const { input, err, done } = setup(
      [{ error: new Error("falha inventada") }],
      undefined,
      { verbose: true },
    );
    input.write("P\n");
    input.end("/sair\n");

    await done;

    expect(err()).not.toContain("[detalhes]");
  });
});

describe("runChat /contexto (ENG-50)", () => {
  it("prints the context as inert text, without terminal controls", async () => {
    const { input, out, done } = setup([], undefined, {
      contextText: "linha\u001b[31m vermelha",
    });
    input.write("/contexto\n");
    input.end("/sair\n");

    await done;

    expect(out()).not.toContain("\u001b");
    expect(out()).toContain("linha");
  });
});
