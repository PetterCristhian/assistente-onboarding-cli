import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context/builder.js";
import { loadContextLayers } from "../src/context/loaders.js";
import { createChatSession } from "../src/chat/session.js";
import { runChat } from "../src/cli/chat-loop.js";
import { createTerminalOutput } from "../src/cli/renderer.js";
import { createRedactor } from "../src/security/redact.js";
import {
  createFakeLlmClient,
  type FakeLlmStep,
} from "./helpers/fake-llm-client.js";

const layers = loadContextLayers({}, { now: () => new Date(2025, 0, 6) });
const context = buildContext(layers);

function collect(stream: PassThrough): () => string {
  let text = "";
  stream.on("data", (data: Buffer) => {
    text += data.toString("utf8");
  });
  return () => text;
}

function setup(script: readonly FakeLlmStep[], shutdown?: AbortSignal) {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = collect(stdout);
  const err = collect(stderr);
  const fake = createFakeLlmClient(script);
  const session = createChatSession({
    llm: fake,
    instructions: context.text,
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
    expect(fake.calls).toHaveLength(2);
    expect(out()).toContain("R1\n");
    expect(out()).toContain("R2\n");
  });

  it("exits with 0 at the end of the input", async () => {
    const { input, fake, done } = setup([{ text: "R" }]);
    input.end("P\n");

    expect(await done).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });

  it("ignores empty lines and warns about unknown commands, without the model", async () => {
    const { input, fake, out, err, done } = setup([]);
    input.write("\n   \n");
    input.write("/detalhes\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(err()).toContain("Comando desconhecido: /detalhes. Digite /ajuda.");
    expect(out()).not.toContain("Comando desconhecido");
  });

  it("forgets the history on /limpar and says so", async () => {
    const { input, fake, out, done } = setup([{ text: "R1" }, { text: "R2" }]);
    input.write("P1\n/limpar\nP2\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(out()).toContain("Histórico apagado.");
    expect(fake.calls.at(-1)?.request.input).toEqual([
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
    expect(fake.calls).toHaveLength(0);
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
    expect(fake.calls.at(-1)?.request.input).toEqual([
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
    while (fake.calls.length === 0) {
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
    expect(fake.calls).toHaveLength(0);
  });
});
