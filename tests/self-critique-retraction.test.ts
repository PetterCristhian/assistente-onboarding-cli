// Fix of the QA of ENG-53 (O2): the retraction also goes to the screen
// (stdout) on the error paths. No network, no key.
import { describe, expect, it } from "vitest";
import { createChatSession, type ChatOutput } from "../src/chat/session.js";
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

const SEP = "\n---\n";
const retractionsOf = (events: string[]) =>
  events.filter((event) => event.startsWith("retraction:"));

type Script = readonly FakeLlmStep[];

async function run(script: Script) {
  const events: string[] = [];
  const output: ChatOutput = {
    chunk: (text) => void events.push(`chunk:${text}`),
    endAnswer: () => void events.push("end"),
    retraction: (text) => void events.push(`retraction:${text}`),
    notice: (level, text) => void events.push(`${level}:${text}`),
  };
  const session = createChatSession({
    llm: createFakeLlmClient(script),
    instructions: "I",
    critique: makeCritiqueDeps(),
    output,
    redact: createRedactor(["SEGREDO-DO-SDK-12345"]),
  });
  await session.ask("P");
  return events;
}

const SDK_ERROR = new Error("mensagem do SDK SEGREDO-DO-SDK-12345");

describe("O2: the retraction also goes to the screen on the error paths", () => {
  it("error in the evaluation: draft, retraction, notice, fallback", async () => {
    const events = await run([{ text: "RASCUNHO" }, { error: SDK_ERROR }]);

    const draft = events.indexOf("chunk:RASCUNHO");
    const retraction = events.findIndex((e) => e.startsWith("retraction:"));
    const notice = events.findIndex((e) => e.startsWith("warning:"));
    const fallback = events.findIndex((e) => e.includes("chunk:MENSAGEM"));
    expect(draft).toBeGreaterThanOrEqual(0);
    expect(retraction).toBeGreaterThan(draft);
    expect(fallback).toBeGreaterThan(retraction);
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(events[retraction]).toContain("não pôde ser verificada");
    expect(retractionsOf(events).join(SEP)).not.toContain("mensagem do SDK");
    expect(events.join(SEP)).not.toContain("SEGREDO-DO-SDK");
  });

  it("error in the revision: the one retraction of the rejection comes before the fallback", async () => {
    const events = await run([
      { text: "RASCUNHO" },
      rejectedStep("P2"),
      { error: SDK_ERROR },
    ]);

    const retractions = events.filter((e) => e.startsWith("retraction:"));
    expect(retractions).toHaveLength(1);
    expect(events.findIndex((e) => e.startsWith("retraction:"))).toBeLessThan(
      events.findIndex((e) => e.includes("chunk:MENSAGEM")),
    );
    expect(retractionsOf(events).join(SEP)).not.toContain("mensagem do SDK");
  });

  it("error in the second evaluation: the revision was never shown, one retraction", async () => {
    const events = await run([
      { text: "RASCUNHO" },
      rejectedStep("P2"),
      { text: "REVISAO" },
      { error: SDK_ERROR },
    ]);

    expect(events.filter((e) => e.startsWith("retraction:"))).toHaveLength(1);
    expect(events.join(SEP)).not.toContain("chunk:REVISAO");
    expect(retractionsOf(events).join(SEP)).not.toContain("mensagem do SDK");
  });

  it("approved path: no retraction", async () => {
    const events = await run([{ text: "RASCUNHO" }, approvedStep()]);
    expect(events.some((e) => e.startsWith("retraction:"))).toBe(false);
  });
});
