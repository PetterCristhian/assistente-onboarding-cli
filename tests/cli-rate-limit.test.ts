// End to end: the real entry point in a child process, with the fake `fetch`
// of tests/helpers/preload-fake-fetch.ts. The network is blocked before
// anything else runs, and a probe confirms the block first: if it does not
// hold, the tests that start the chat do not run.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ENV_VARIABLE_NAMES } from "../src/config/env.js";
import {
  FAKE_FETCH_ANSWER,
  FAKE_FETCH_BLOCK_MESSAGE,
  FAKE_FETCH_MARKER,
} from "./helpers/fake-fetch-constants.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRELOAD = pathToFileURL(
  fileURLToPath(new URL("./helpers/preload-fake-fetch.ts", import.meta.url)),
).href;
const CHILD_TIMEOUT_MS = 30_000;

// Every variable blank: an empty one counts as not defined and also keeps a
// local ".env" from filling it in.
const BLANK_VARIABLES = Object.fromEntries(
  ENV_VARIABLE_NAMES.map((name) => [name, ""]),
);

function spawnNode(
  args: string[],
  variables: Record<string, string>,
  input: string,
) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", PRELOAD, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      input,
      env: { ...process.env, ...BLANK_VARIABLES, ...variables },
      timeout: CHILD_TIMEOUT_MS,
    },
  );
}

// Each attempt must fail with the message of the block. Only the loopback and
// the host name "localhost" are used, so a hole in the block could not reach
// a real server.
const PROBE = `
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const attempts = {
  netConnect: () => net.connect(9, "127.0.0.1"),
  netCreateConnection: () => net.createConnection({ port: 9, host: "127.0.0.1" }),
  socketConnect: () => new net.Socket().connect(9, "127.0.0.1"),
  tlsConnect: () => tls.connect(9, "127.0.0.1"),
  dnsLookup: () => dns.lookup("localhost", () => {}),
  dnsPromisesLookup: () => dns.promises.lookup("localhost"),
  dnsResolve4: () => dns.resolve4("localhost", () => {}),
  httpGet: () => http.get("http://127.0.0.1:9/"),
  httpsGet: () => https.get("https://127.0.0.1:9/"),
  fetchOtherUrl: () => fetch("http://127.0.0.1:9/"),
  fetchOtherHttps: () => fetch("https://localhost/"),
};
(async () => {
  const result = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    try {
      await attempt();
      result[name] = "OPEN";
    } catch (error) {
      result[name] = String(error && error.message);
    }
  }
  console.log(JSON.stringify(result));
})();
`;

beforeAll(() => {
  const probe = spawnNode(["-e", PROBE], {}, "");
  const result = JSON.parse(probe.stdout.trim()) as Record<string, string>;

  expect(Object.keys(result).length).toBeGreaterThanOrEqual(11);
  for (const [name, outcome] of Object.entries(result)) {
    expect([name, outcome]).toEqual([name, FAKE_FETCH_BLOCK_MESSAGE]);
  }
});

describe("the preload of the fake fetch", () => {
  it("answers for the URL of the API without any network", () => {
    const script = `
      fetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
        .then((response) => console.log(response.status));
    `;
    const run = spawnNode(["-e", script], {}, "");

    expect(run.stdout.trim()).toBe("200");
    expect(run.stderr).toContain(FAKE_FETCH_MARKER);
  });
});

describe("src/cli/main.ts with the local rate limit", () => {
  it("answers two questions and refuses the third, without calling the model for it", () => {
    const run = spawnNode(
      ["src/cli/main.ts"],
      {
        OPENAI_API_KEY: fakeOpenAiKey(),
        RATE_LIMIT_MAX_REQUESTS: "2",
        RATE_LIMIT_WINDOW_SECONDS: "60",
      },
      "Pergunta 1\nPergunta 2\nPergunta 3\n/sair\n",
    );

    expect(run.status).toBe(0);
    expect(run.stdout.split(FAKE_FETCH_ANSWER)).toHaveLength(3);

    const notice =
      /Limite de perguntas atingido \(2 perguntas a cada 60 s\)\. Aguarde \d+ segundos? e envie de novo\./;
    const match = notice.exec(run.stderr);
    expect(match).not.toBeNull();

    // How many calls one question makes may change (the self-evaluation adds
    // one): what matters is that none happens after the refusal.
    const at = match?.index ?? 0;
    const before = run.stderr.slice(0, at);
    const after = run.stderr.slice(at);
    expect(before.split(FAKE_FETCH_MARKER).length - 1).toBeGreaterThanOrEqual(
      2,
    );
    expect(after).not.toContain(FAKE_FETCH_MARKER);
    expect(run.stderr).not.toMatch(/^\s+at /m);
  });

  it("does not limit anything below the default limit of 20", () => {
    const run = spawnNode(
      ["src/cli/main.ts"],
      { OPENAI_API_KEY: fakeOpenAiKey() },
      "P1\nP2\nP3\n/sair\n",
    );

    expect(run.status).toBe(0);
    expect(run.stdout.split(FAKE_FETCH_ANSWER)).toHaveLength(4);
    expect(run.stderr).not.toContain("Limite de perguntas");
  });

  it("refuses a limit of 0 as a configuration error, before any call", () => {
    const run = spawnNode(
      ["src/cli/main.ts"],
      { OPENAI_API_KEY: fakeOpenAiKey(), RATE_LIMIT_MAX_REQUESTS: "0" },
      "/sair\n",
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("RATE_LIMIT_MAX_REQUESTS");
    expect(run.stderr).not.toContain(FAKE_FETCH_MARKER);
  });
});
