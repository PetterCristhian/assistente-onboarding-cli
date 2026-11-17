// The simulated provider of the demonstration: a plain HTTP server of this
// process, only on 127.0.0.1, on a free port. Each scenario has its own path
// prefix (/cenario-3/v1/responses) and its own script of answers: every
// request takes the next step of the script of its path. A request that finds
// the script spent, or a path with no script, gets a 500 and is counted as
// unexpected, which fails the check of the scenario.
//
// The authorization header is compared inside and never printed or stored.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Socket,
} from "node:net";

export const STUB_HOST = "127.0.0.1";

export interface StubStep {
  readonly status: number;
  /** Extra headers of the answer, such as `Retry-After`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** "success" is a streamed answer; the other is the code of an error body. */
  readonly body: "success" | { readonly code: string };
}

export interface StubStats {
  /** Requests that reached the path of the scenario. */
  readonly requests: number;
  /** Of those, the ones that carried the key of the demonstration. */
  readonly withDemoKey: number;
  /** Requests with no step left to answer them, or to a path with no script. */
  readonly unexpected: number;
}

export interface StubServer {
  readonly host: typeof STUB_HOST;
  readonly port: number;
  baseUrlFor(id: string): string;
  script(id: string, steps: readonly StubStep[]): void;
  stats(id: string): StubStats;
  openConnections(): number;
  /** True while the listener of this server is open (not the state of the port). */
  isListening(): boolean;
  /** Idempotent: closes the open connections and the listener. */
  stop(): Promise<void>;
}

interface Route {
  steps: StubStep[];
  requests: number;
  withDemoKey: number;
  unexpected: number;
}

const SUCCESS_TEXT = "Resposta simulada do provedor local.";
const SIMULATED_MODEL = "modelo-simulado";
const PATH_PATTERN = /^\/([^/]+)\/v1\/responses$/;

function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function successBody(): string {
  return [
    sseEvent("response.output_text.delta", { delta: SUCCESS_TEXT }),
    sseEvent("response.completed", {
      response: {
        id: "resp_simulada",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        model: SIMULATED_MODEL,
        error: null,
        incomplete_details: null,
        output: [
          {
            type: "message",
            id: "msg_simulada",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: SUCCESS_TEXT, annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    }),
  ].join("");
}

/** A fixed error body: it never quotes the key, nor anything from the request. */
function errorBody(status: number, code: string): string {
  const type = status >= 500 ? "server_error" : "invalid_request_error";
  return JSON.stringify({ error: { message: "Erro simulado.", type, code } });
}

function send(response: ServerResponse, step: StubStep | undefined): void {
  if (step === undefined) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(errorBody(500, "roteiro_esgotado"));
    return;
  }
  if (step.body === "success") {
    response.writeHead(step.status, {
      "content-type": "text/event-stream",
      ...step.headers,
    });
    response.end(successBody());
    return;
  }
  response.writeHead(step.status, {
    "content-type": "application/json",
    ...step.headers,
  });
  response.end(errorBody(step.status, step.body.code));
}

export async function startStubServer(apiKey: string): Promise<StubServer> {
  const routes = new Map<string, Route>();
  const sockets = new Set<Socket>();
  let strayRequests = 0;

  function handle(request: IncomingMessage, response: ServerResponse): void {
    // The body is read to its end (and dropped) before the answer.
    request.resume();
    request.on("end", () => {
      const id = PATH_PATTERN.exec(
        new URL(request.url ?? "/", `http://${STUB_HOST}`).pathname,
      )?.[1];
      const route = id === undefined ? undefined : routes.get(id);
      if (route === undefined) {
        strayRequests += 1;
        send(response, undefined);
        return;
      }
      route.requests += 1;
      if (request.headers.authorization === `Bearer ${apiKey}`) {
        route.withDemoKey += 1;
      }
      const step = route.steps.shift();
      if (step === undefined) {
        route.unexpected += 1;
      }
      send(response, step);
    });
  }

  const server: Server = createServer(handle);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, STUB_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  if (address.address !== STUB_HOST) {
    server.close();
    throw new Error("O servidor simulado não ficou preso ao 127.0.0.1.");
  }
  const port = address.port;

  let stopping: Promise<void> | undefined;

  return {
    host: STUB_HOST,
    port,
    baseUrlFor: (id) => `http://${STUB_HOST}:${port}/${id}/v1`,
    script(id, steps) {
      routes.set(id, {
        steps: [...steps],
        requests: 0,
        withDemoKey: 0,
        unexpected: 0,
      });
    },
    stats(id) {
      const route = routes.get(id);
      return {
        requests: route?.requests ?? 0,
        withDemoKey: route?.withDemoKey ?? 0,
        unexpected: (route?.unexpected ?? 0) + strayRequests,
      };
    },
    openConnections: () => sockets.size,
    isListening: () => server.listening,
    stop() {
      stopping ??= new Promise<void>((resolve) => {
        // The server reports itself closed only after every connection ended.
        server.close(() => {
          sockets.clear();
          resolve();
        });
        server.closeAllConnections();
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      return stopping;
    },
  };
}

/** True when a connection to the port is refused: nothing is listening. */
export function isPortRefused(
  port: number,
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: STUB_HOST, port });
    const finish = (refused: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED"),
    );
  });
}

/**
 * A port that refuses connections right now, found by opening and closing a
 * listener (at most `attempts` times). Used when the port that the server just
 * freed was taken by another process in the meantime.
 */
export async function findRefusedPort(
  attempts = 5,
): Promise<number | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = createNetServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, STUB_HOST, () => {
        resolve((probe.address() as AddressInfo).port);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (await isPortRefused(port)) {
      return port;
    }
  }
  return undefined;
}
