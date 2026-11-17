// Loaded with `node --import` before the demo in its end-to-end test. Unlike
// tests/helpers/preload-fake-fetch.ts it fakes nothing: the real `fetch`, the
// real SDK and the real sockets run, but only towards the literal address
// 127.0.0.1. Everything else is blocked before it leaves the process:
//   - every function of `dns` (a host name is never resolved), except
//     `lookup` of the literal 127.0.0.1, which `server.listen` needs;
//   - `net.connect`, `net.createConnection` and `Socket.prototype.connect`
//     for any host that is not 127.0.0.1;
//   - `tls.connect` for any host that is not 127.0.0.1.
// Every attempt is written to stderr as one line, so that a test can see
// where the process tried to go:
//   [loopback-only] connect <host>   (allowed: the host is 127.0.0.1)
//   [loopback-only] blocked <host>   (refused, with an error)
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import {
  LOOPBACK_ONLY_BLOCK_MESSAGE,
  LOOPBACK_ONLY_CONNECT_MARKER,
  LOOPBACK_ONLY_BLOCKED_MARKER,
} from "./loopback-only-constants.js";

const ALLOWED_HOST = "127.0.0.1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The host of the arguments of a `connect`, in any of the forms Node takes. */
function hostOf(args: readonly unknown[]): string {
  let first: unknown = args[0];
  // Socket.prototype.connect also receives the arguments already normalized:
  // an array whose first item holds the options.
  if (Array.isArray(first)) {
    first = first[0];
  }
  if (isRecord(first)) {
    if (typeof first["path"] === "string") {
      return `path:${first["path"]}`;
    }
    const host = first["host"];
    return typeof host === "string" && host !== "" ? host : "localhost";
  }
  if (typeof first === "number" || typeof first === "string") {
    // connect(port, host?) or connect(path) when the first is not a number.
    if (typeof first === "string" && Number.isNaN(Number(first))) {
      return `path:${first}`;
    }
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  return "unknown";
}

function guard(args: readonly unknown[]): string {
  const host = hostOf(args);
  if (host !== ALLOWED_HOST) {
    process.stderr.write(`${LOOPBACK_ONLY_BLOCKED_MARKER} ${host}\n`);
    throw new Error(LOOPBACK_ONLY_BLOCK_MESSAGE);
  }
  return host;
}

function blocked(): never {
  process.stderr.write(`${LOOPBACK_ONLY_BLOCKED_MARKER} dns\n`);
  throw new Error(LOOPBACK_ONLY_BLOCK_MESSAGE);
}

function replaceWithBlock(target: object, names: readonly string[]): void {
  for (const name of names) {
    Object.defineProperty(target, name, {
      value: blocked,
      configurable: true,
      writable: true,
    });
  }
}

const DNS_NAMES = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCname",
  "resolveMx",
  "resolveNs",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
const originalLookup = dns.lookup;
const originalPromisesLookup = dns.promises.lookup;
replaceWithBlock(dns, DNS_NAMES);
replaceWithBlock(dns.promises, DNS_NAMES);
// `server.listen(port, "127.0.0.1")` asks `dns.lookup` about the address, and
// for an IP literal that answers at once, with no query to any resolver. So
// that one form (and only that one) is let through.
Object.defineProperty(dns, "lookup", {
  value: function lookup(this: unknown, ...args: unknown[]): unknown {
    if (args[0] !== ALLOWED_HOST) {
      blocked();
    }
    return Reflect.apply(originalLookup, this, args);
  },
  configurable: true,
  writable: true,
});
Object.defineProperty(dns.promises, "lookup", {
  value: function lookup(this: unknown, ...args: unknown[]): unknown {
    if (args[0] !== ALLOWED_HOST) {
      blocked();
    }
    return Reflect.apply(originalPromisesLookup, this, args);
  },
  configurable: true,
  writable: true,
});

type AnyFunction = (...args: unknown[]) => unknown;

function replaceWithGuard(target: object, name: string, log: boolean): void {
  const original = Reflect.get(target, name) as AnyFunction;
  Object.defineProperty(target, name, {
    value: function guarded(this: unknown, ...args: unknown[]): unknown {
      const host = guard(args);
      if (log) {
        process.stderr.write(`${LOOPBACK_ONLY_CONNECT_MARKER} ${host}\n`);
      }
      return original.apply(this, args);
    },
    configurable: true,
    writable: true,
  });
}

// Every connection of a plain socket ends in Socket.prototype.connect, which
// is the only place that logs an allowed one, so that each shows up once.
replaceWithGuard(net, "connect", false);
replaceWithGuard(net, "createConnection", false);
replaceWithGuard(net.Socket.prototype, "connect", true);
replaceWithGuard(tls, "connect", false);
