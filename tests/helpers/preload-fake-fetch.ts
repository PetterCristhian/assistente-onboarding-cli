// Loaded with `node --import` before src/cli/main.ts in the end-to-end tests
// of the chat. It does two things, so that no test can reach a real server:
//   1. blocks every way to the network that Node offers (sockets, TLS, DNS,
//      http and https), and
//   2. replaces the global `fetch` with a fake that answers only for the URL
//      of the API, from a script, and blocks any other URL.
// The SDK reads the global `fetch` when the client is created, which is after
// this file ran. Every call that reaches the fake writes one marker line to
// stderr, so that a test can see how many calls happened and when.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  FAKE_FETCH_ANSWER,
  FAKE_FETCH_BLOCK_MESSAGE,
  FAKE_FETCH_MARKER,
} from "./fake-fetch-constants.js";
import {
  createFakeOpenAiFetch,
  fakeResponseBody,
  sseAnswer,
  type FakeFetchStep,
} from "./fake-openai-fetch.js";

const API_PREFIX = "https://api.openai.com/v1/";

function blocked(): never {
  throw new Error(FAKE_FETCH_BLOCK_MESSAGE);
}

function replace(target: object, names: readonly string[]): void {
  for (const name of names) {
    Object.defineProperty(target, name, {
      value: blocked,
      configurable: true,
      writable: true,
    });
  }
}

replace(net, ["connect", "createConnection"]);
replace(net.Socket.prototype, ["connect"]);
replace(tls, ["connect"]);
replace(dns, [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "reverse",
]);
replace(dns.promises, [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "reverse",
]);
replace(http, ["request", "get"]);
replace(https, ["request", "get"]);

// A turn takes two calls (ENG-53): the draft, streamed, and the evaluation of
// it, structured, which here always approves.
const turn: readonly FakeFetchStep[] = [
  sseAnswer([FAKE_FETCH_ANSWER], { text: FAKE_FETCH_ANSWER }),
  {
    kind: "json",
    body: fakeResponseBody({
      text: JSON.stringify({ aprovada: true, violacoes: [] }),
    }),
  },
];
const script = Array.from({ length: 25 }, () => turn).flat();
const fake = createFakeOpenAiFetch(script);

globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(API_PREFIX)) {
    return Promise.reject(new Error(FAKE_FETCH_BLOCK_MESSAGE));
  }
  process.stderr.write(`${FAKE_FETCH_MARKER}\n`);
  return fake.fetch(input, init);
};
