// Loaded AFTER tests/helpers/preload-fake-fetch.ts (which blocks every way to
// the network and installs the fake fetch). It only replaces the global
// `fetch` by a fake that follows a script chosen by the test, and records the
// body of every request of the API to a file, so that a test can read what the
// chat really sent. The URL check is the same: any other URL is blocked.
//
// The script comes from the environment of the child process (set by the test,
// never read by src/): QA_FETCH_SCRIPT is a JSON list of steps and
// QA_FETCH_RECORD is the file that receives one JSON body per line.
import { appendFileSync } from "node:fs";
import { FAKE_FETCH_BLOCK_MESSAGE } from "./fake-fetch-constants.js";
import {
  createFakeOpenAiFetch,
  fakeResponseBody,
  sseAnswer,
  type FakeFetchStep,
} from "./fake-openai-fetch.js";

type QaStep =
  | { kind: "draft"; chunks: string[] }
  | { kind: "verdict"; value: unknown }
  | { kind: "status"; status: number };

const API_PREFIX = "https://api.openai.com/v1/";
const script = JSON.parse(process.env["QA_FETCH_SCRIPT"] ?? "[]") as QaStep[];
const recordFile = process.env["QA_FETCH_RECORD"] ?? "";

const steps: FakeFetchStep[] = script.map((step): FakeFetchStep => {
  switch (step.kind) {
    case "draft":
      return sseAnswer(step.chunks, { text: step.chunks.join("") });
    case "verdict":
      return {
        kind: "json",
        body: fakeResponseBody({ text: JSON.stringify(step.value) }),
      };
    case "status":
      return {
        kind: "json",
        status: step.status,
        body: { error: { message: "x", type: "t", code: "c", param: null } },
      };
  }
});
const fake = createFakeOpenAiFetch(steps);

globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(API_PREFIX)) {
    return Promise.reject(new Error(FAKE_FETCH_BLOCK_MESSAGE));
  }
  const body = typeof init?.body === "string" ? init.body : "null";
  appendFileSync(recordFile, `${body}\n`);
  return fake.fetch(input, init);
};
