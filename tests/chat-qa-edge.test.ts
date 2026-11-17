import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createChatSession } from "../src/chat/session.js";
import { runChat } from "../src/cli/chat-loop.js";
import { createTerminalOutput } from "../src/cli/renderer.js";
import { LlmResponseError } from "../src/llm/client.js";
import { createRedactor } from "../src/security/redact.js";
import { createFakeLlmClient } from "./helpers/fake-llm-client.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

// Edge cases of the interactive chat (ENG-49), added by QA.
const KEY = fakeOpenAiKey();

function setup(script: Parameters<typeof createFakeLlmClient>[0]) {
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (d: Buffer) => void (out += d.toString("utf8")));
  stderr.on("data", (d: Buffer) => void (err += d.toString("utf8")));
  const fake = createFakeLlmClient(script);
  const session = createChatSession({
    llm: fake,
    instructions: "CTX",
    output: createTerminalOutput(stdout, stderr),
    redact: createRedactor([KEY]),
  });
  const done = runChat({
    input,
    stdout,
    stderr,
    session,
    contextText: "CTX",
    profileName: "Perfil",
  });
  return { input, fake, session, done, out: () => out, err: () => err };
}

describe("chat edge cases", () => {
  it("handles CRLF input and a huge line without losing the turn", async () => {
    const big = "x".repeat(1_000_000);
    const { input, fake, done } = setup([{ text: "R1" }, { text: "R2" }]);
    input.write(`${big}\r\nok\r\n`);
    input.end("/sair\r\nnunca\r\n");

    expect(await done).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.request.input[0]?.content).toBe(big);
    expect(fake.calls[1]?.request.input).toHaveLength(3);
  });

  it("treats '/', '/ SAIR' and '/sair agora' as unknown, without the model", async () => {
    const { input, fake, err, done } = setup([]);
    input.end("/\n/ SAIR\n/sair agora\n/detalhes\n/SAIR\n");

    expect(await done).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(err().match(/Comando desconhecido/g)).toHaveLength(4);
  });

  it("never prints the key, a stack or headers when a response error quotes the key", async () => {
    const { input, fake, out, err, session, done } = setup([
      { error: new LlmResponseError("failed", `chave ${KEY} inválida`) },
      { text: "R2" },
    ]);
    input.write("P1\nP2\n");
    input.end("/sair\n");

    expect(await done).toBe(0);
    expect(out() + err()).not.toContain(KEY);
    expect(err()).not.toMatch(/^\s+at /m);
    expect(err()).not.toMatch(/authorization|bearer/i);
    expect(fake.calls[1]?.request.input).toHaveLength(1);
    expect(session.history).toHaveLength(2);
  });

  it("keeps the unicode and the control characters of a question as typed", async () => {
    const { input, fake, done } = setup([{ text: "R" }]);
    input.end("olá 🎉 日本語\n");

    expect(await done).toBe(0);
    expect(fake.calls[0]?.request.input[0]?.content).toBe("olá 🎉 日本語");
  });

  it("is cancelled, without chunks, when the signal is already aborted, and the session recovers", async () => {
    const { session, fake } = setup([{ text: "R" }]);
    const controller = new AbortController();
    controller.abort();

    expect(await session.ask("P", { signal: controller.signal })).toEqual({
      status: "cancelled",
    });
    expect(session.history).toHaveLength(0);
    expect((await session.ask("P2")).status).toBe("answered");
    expect(fake.calls.at(-1)?.request.input).toHaveLength(1);
  });
});
