// Runs a Node child process with tests/helpers/preload-loopback-only.ts and
// confirms that the block holds before any test trusts it. Only addresses of
// the documentation range (192.0.2.0/24, RFC 5737) and reserved names
// (.invalid) are tried, so a hole in the block could not reach a real server.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import {
  LOOPBACK_ONLY_BLOCKED_MARKER,
  LOOPBACK_ONLY_BLOCK_MESSAGE,
  LOOPBACK_ONLY_CONNECT_MARKER,
} from "./loopback-only-constants.js";

export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const PRELOAD = pathToFileURL(
  fileURLToPath(new URL("./preload-loopback-only.ts", import.meta.url)),
).href;

export function spawnWithLoopbackOnly(
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", PRELOAD, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    },
  );
}

const PROBE = `
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const attempts = {
  publicIp: () => net.connect(80, "192.0.2.1"),
  publicIpOptions: () => net.connect({ port: 80, host: "192.0.2.1" }),
  createConnection: () => net.createConnection({ port: 80, host: "192.0.2.1" }),
  socketConnect: () => new net.Socket().connect(80, "192.0.2.1"),
  localhostName: () => net.connect(80, "localhost"),
  tlsConnect: () => tls.connect(443, "192.0.2.1"),
  dnsLookup: () => dns.lookup("example.invalid", () => {}),
  dnsPromisesLookup: () => dns.promises.lookup("example.invalid"),
  dnsResolve4: () => dns.resolve4("example.invalid", () => {}),
  fetchHttps: () => fetch("https://example.invalid/"),
  fetchPublicIp: () => fetch("http://192.0.2.1/"),
};
const connectLocal = (port) => new Promise((resolve, reject) => {
  const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(); });
  socket.on("error", reject);
});
(async () => {
  const result = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    try {
      const value = await attempt();
      if (value && typeof value.destroy === "function") value.destroy();
      result[name] = "OPEN";
    } catch (error) {
      result[name] = String(error && error.message);
    }
  }
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await connectLocal(server.address().port);
    result.loopback = "OPEN";
  } catch (error) {
    result.loopback = String(error && error.message);
  }
  server.close();
  console.log(JSON.stringify(result));
  process.exit(0);
})();
`;

/** Throws (through `expect`) unless the block holds and 127.0.0.1 works. */
export function confirmLoopbackOnlyBlock(): void {
  const probe = spawnWithLoopbackOnly(["-e", PROBE], {}, 30_000);
  const result = JSON.parse(probe.stdout.trim()) as Record<string, string>;

  const blocked = Object.entries(result).filter(
    ([name]) => name !== "loopback",
  );
  expect(blocked.length).toBeGreaterThanOrEqual(11);
  for (const [name, outcome] of blocked) {
    // The fetch wraps the error of the socket in its own "fetch failed".
    const expected = name.startsWith("fetch")
      ? "fetch failed"
      : LOOPBACK_ONLY_BLOCK_MESSAGE;
    expect([name, outcome]).toEqual([name, expected]);
  }
  expect(result["loopback"]).toBe("OPEN");

  // The fetches were stopped by the block itself, at the socket.
  expect(probe.stderr).toContain(
    `${LOOPBACK_ONLY_BLOCKED_MARKER} example.invalid`,
  );
  expect(probe.stderr).toContain(`${LOOPBACK_ONLY_BLOCKED_MARKER} 192.0.2.1`);
  expect(probe.stderr).toContain(`${LOOPBACK_ONLY_CONNECT_MARKER} 127.0.0.1`);
}
