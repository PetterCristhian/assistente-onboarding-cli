// Run as a child process by tests/llm-client-edge.test.ts: makes calls with
// a deadline of ten minutes and a fake `fetch`, then lets the process end by
// itself. A timer left behind by the client would keep it alive. No network,
// and the key is a fake one built at runtime.
import { z } from "zod";
import { createOpenAiLlmClient } from "../../src/llm/client.js";
import { fakeOpenAiKey } from "./fake-key.js";
import {
  apiErrorBody,
  createFakeOpenAiFetch,
  fakeResponseBody,
  sseAnswer,
} from "./fake-openai-fetch.js";

const fake = createFakeOpenAiFetch([
  sseAnswer(["a", "b"]),
  {
    kind: "json",
    body: fakeResponseBody({ text: JSON.stringify({ ok: true }) }),
  },
  {
    kind: "json",
    status: 500,
    body: apiErrorBody("Failure.", "server_error"),
  },
  { kind: "sse", events: [], hang: true },
]);
const client = createOpenAiLlmClient(
  {
    openaiApiKey: fakeOpenAiKey(),
    openaiModel: "probe-model",
    openaiReasoningEffort: "low",
    requestTimeoutMs: 600_000,
    retryMaxAttempts: 0,
    retryBaseDelayMs: 1,
  },
  { fetch: fake.fetch },
);
const request = {
  instructions: "x",
  input: [{ role: "user" as const, content: "y" }],
};

function nameOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

const text = await client.streamText(request);
const object = await client.generateStructured({
  ...request,
  schema: z.object({ ok: z.boolean() }),
  schemaName: "probe",
});
const failed = await client.streamText(request).then(
  () => "no error",
  (error: unknown) => nameOf(error),
);
const controller = new AbortController();
setTimeout(() => controller.abort(), 20);
const aborted = await client
  .streamText({ ...request, signal: controller.signal })
  .then(
    () => "no error",
    (error: unknown) => nameOf(error),
  );

console.log(
  `text:${text.text === "ab" ? "ok" : "wrong"} structured:${object.value.ok ? "ok" : "wrong"} error:${failed} aborted:${aborted}`,
);
