import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context/builder.js";
import { loadContextLayers } from "../src/context/loaders.js";
import { createChatSession } from "../src/chat/session.js";
import { runChat } from "../src/cli/chat-loop.js";
import { guardOutputStreams } from "../src/cli/output-guard.js";
import {
  createTerminalOutput,
  sanitizeForTerminal,
} from "../src/cli/renderer.js";
import { createRedactor } from "../src/security/redact.js";
import { createFakeLlmClient } from "./helpers/fake-llm-client.js";

const layers = loadContextLayers({}, { now: () => new Date(2025, 0, 6) });
const context = buildContext(layers);
const CONTROLS = /\p{Cc}/u;

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (data: Buffer) => {
    text += data.toString("utf8");
  });
  return { stream, text: () => text };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("sanitizeForTerminal", () => {
  it("neutralizes ESC, OSC, CSI, DEL, C1 and CR, keeping text, tab and newline", () => {
    const clean = sanitizeForTerminal(
      "a\u001b]0;titulo\u0007b\u001b[2Jc\u007fd\u009be\rf\tg\nh",
    );
    expect(clean).toBe("a�]0;titulo�b�[2Jc�d�e�f\tg\nh");
    expect(clean.replace(/[\t\n]/g, "")).not.toMatch(CONTROLS);
  });

  it("keeps accents, emoji sequences and other unicode", () => {
    const text = "Ação é ótima: 👨‍👩‍👧 日本語 — “ok”";
    expect(sanitizeForTerminal(text)).toBe(text);
  });

  it("neutralizes an ESC that ends a chunk, whatever follows in the next one", () => {
    const out = sink();
    const err = sink();
    const output = createTerminalOutput(out.stream, err.stream);
    output.chunk("antes\u001b");
    output.chunk("[2Jdepois");
    expect(out.text()).toBe("antes�[2Jdepois");
  });

  it("sanitizes notices, but the history keeps the original text", async () => {
    const out = sink();
    const err = sink();
    const fake = createFakeLlmClient([
      { text: "x\u001b[2Jy", chunks: ["x\u001b", "[2Jy"] },
      { error: new Error("falha\u001b]0;t\u0007") },
    ]);
    const session = createChatSession({
      llm: fake,
      instructions: context.text,
      output: createTerminalOutput(out.stream, err.stream),
      redact: createRedactor([]),
    });
    await session.ask("p1");
    await session.ask("p2");

    expect(out.text()).not.toContain("\u001b");
    expect(err.text()).not.toContain("\u001b");
    expect(err.text()).toContain("falha");
    expect(session.history.at(-1)?.content).toBe("x\u001b[2Jy");
  });
});

describe("output failures", () => {
  function failingWritable(code: string): Writable {
    return new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error(`write ${code}`), { code }));
      },
    });
  }

  function run(stdout: Writable, stderr: Writable) {
    const input = new PassThrough();
    const shutdown = new AbortController();
    const guard = guardOutputStreams({ stdout, stderr }, () =>
      shutdown.abort(),
    );
    const session = createChatSession({
      llm: createFakeLlmClient([{ text: "R" }]),
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
      shutdown: shutdown.signal,
    });
    return { guard, done };
  }

  it("ends with 0 and no throw when stdout is closed (EPIPE)", async () => {
    const { guard, done } = run(failingWritable("EPIPE"), sink().stream);

    expect(await done).toBe(0);
    expect(guard.exitCode()).toBe(0);
  });

  it("reports another write error in one line on stderr and exits with 1", async () => {
    const err = sink();
    const { guard, done } = run(failingWritable("ENOSPC"), err.stream);

    await done;
    expect(guard.exitCode()).toBe(1);
    expect(err.text()).toBe("erro ao escrever a saída: write ENOSPC\n");
  });

  it("handles a broken stderr without recursion and stops once", async () => {
    const broken = failingWritable("EPIPE");
    let stops = 0;
    const guard = guardOutputStreams(
      { stdout: sink().stream, stderr: broken },
      () => (stops += 1),
    );
    broken.write("x");
    await tick();
    broken.write("y");
    await tick();

    expect(guard.exitCode()).toBe(0);
    expect(stops).toBe(1);
  });
});

describe("end of input", () => {
  async function runWith(data: string): Promise<string> {
    const input = new PassThrough();
    const out = sink();
    const err = sink();
    const session = createChatSession({
      llm: createFakeLlmClient([]),
      instructions: context.text,
      output: createTerminalOutput(out.stream, err.stream),
      redact: createRedactor([]),
    });
    const done = runChat({
      input,
      stdout: out.stream,
      stderr: err.stream,
      session,
      contextText: context.text,
      profileName: layers.userProfile.nome,
    });
    input.end(data);
    await done;
    return out.text();
  }

  it("ends the prompt line at EOF", async () => {
    expect(await runWith("")).toMatch(/> \n$/);
  });

  it("does not add a newline after /sair", async () => {
    const text = await runWith("/sair\n");
    expect(text.endsWith("> ")).toBe(true);
  });
});
