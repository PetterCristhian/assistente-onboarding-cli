// The `fetch` that the client of the demonstration uses: it refuses every URL
// that is not plain HTTP to the literal address 127.0.0.1, so that a wrong
// base URL could never send a request out of the machine, and it counts the
// calls that went through (the real tries of the client).

/** How many requests the client really made. */
export interface CallCounter {
  calls: number;
}

const ALLOWED_PROTOCOL = "http:";
const ALLOWED_HOSTNAME = "127.0.0.1";

export const LOOPBACK_REFUSED_MESSAGE =
  "Endereço recusado: a demonstração só fala com 127.0.0.1.";

function urlOf(input: string | URL | Request): URL {
  const text = input instanceof Request ? input.url : String(input);
  return new URL(text);
}

export function createLoopbackFetch(
  base: typeof fetch,
  counter: CallCounter,
): typeof fetch {
  return async (input, init) => {
    let url: URL;
    try {
      url = urlOf(input);
    } catch {
      throw new Error(LOOPBACK_REFUSED_MESSAGE);
    }
    if (
      url.protocol !== ALLOWED_PROTOCOL ||
      url.hostname !== ALLOWED_HOSTNAME
    ) {
      throw new Error(LOOPBACK_REFUSED_MESSAGE);
    }
    counter.calls += 1;
    return base(input, init);
  };
}
