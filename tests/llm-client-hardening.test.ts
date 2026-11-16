// Findings of the QA and of the review of the OpenAI client (ENG-48), each
// with the test that failed before its fix. The real SDK with a fake `fetch`:
// no request ever leaves the process, and the key is a fake one built at
// runtime.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createOpenAiLlmClient,
  type LlmClient,
  type LlmClientConfig,
} from "../src/llm/client.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";
import {
  createFakeOpenAiFetch,
  fakeResponseBody,
  sseAnswer,
  type FakeFetchStep,
} from "./helpers/fake-openai-fetch.js";

const KEY = fakeOpenAiKey();
const OTHER_KEY = fakeOpenAiKey("C");
const CONFIG: LlmClientConfig = {
  openaiApiKey: KEY,
  openaiModel: "configured-model",
  openaiReasoningEffort: "low",
  requestTimeoutMs: 5_000,
};
const REQUEST = {
  instructions: "Assembled context.",
  input: [{ role: "user" as const, content: "question" }],
};
const verdictSchema = z.object({ approved: z.boolean(), reason: z.string() });
const VERDICT = { approved: true, reason: "fine" };

function setup(script: readonly FakeFetchStep[], config = CONFIG) {
  const fake = createFakeOpenAiFetch(script);
  const client = createOpenAiLlmClient(config, { fetch: fake.fetch });
  return { client, requests: fake.requests };
}

function jsonAnswer(value: unknown): FakeFetchStep {
  return {
    kind: "json",
    body: fakeResponseBody({ text: JSON.stringify(value) }),
  };
}

function structured(client: LlmClient, signal?: AbortSignal) {
  return client.generateStructured({
    ...REQUEST,
    schema: verdictSchema,
    schemaName: "verdict",
    ...(signal === undefined ? {} : { signal }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OPENAI_CUSTOM_HEADERS, which the SDK reads by itself", () => {
  it("cannot replace the credential nor add an organization or a project", async () => {
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      [
        `Authorization: Bearer ${OTHER_KEY}`,
        "OpenAI-Organization: org-env",
        "OpenAI-Project: proj_env",
        "X-Extra: 1",
      ].join("\n"),
    );
    const { client, requests } = setup([
      sseAnswer(["ok"]),
      jsonAnswer(VERDICT),
    ]);

    await client.streamText(REQUEST);
    await structured(client);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(request.headers).not.toHaveProperty("openai-organization");
      expect(request.headers).not.toHaveProperty("openai-project");
      expect(JSON.stringify(request.headers)).not.toContain(OTHER_KEY);
      // Known limit (ADR 0002, decision 9): a header with any other name is
      // still sent. Refusing the variable is left to the configuration.
      expect(request.headers["x-extra"]).toBe("1");
    }
  });

  it("does not let a lower-case name slip through either", async () => {
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      `authorization: Bearer ${OTHER_KEY}\nopenai-organization: org-env\nopenai-project: proj_env`,
    );
    const { client, requests } = setup([sseAnswer(["ok"])]);

    await client.streamText(REQUEST);

    expect(requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(requests[0]?.headers).not.toHaveProperty("openai-organization");
    expect(requests[0]?.headers).not.toHaveProperty("openai-project");
  });
});
