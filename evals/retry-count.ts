// Counts the new tries that the client makes, per turn. A decorator of the
// LlmClient: it only chains the `onRetry` that the session passes and counts.
// It has no retry of its own (the retry lives inside the real client, rule 2)
// and it is the only file of evals/ that calls the client directly.
import type { z } from "zod";
import type {
  LlmClient,
  LlmStructuredResult,
  LlmTextResult,
  StreamTextRequest,
  StructuredRequest,
} from "../src/llm/client.js";

export interface RetryCounter {
  readonly client: LlmClient;
  /** New tries since the last `reset`, over all the calls. */
  retries(): number;
  reset(): void;
}

export function createRetryCounter(inner: LlmClient): RetryCounter {
  let count = 0;

  function streamText(request: StreamTextRequest): Promise<LlmTextResult> {
    return inner.streamText({
      ...request,
      onRetry: (event) => {
        count += 1;
        request.onRetry?.(event);
      },
    });
  }

  function generateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<LlmStructuredResult<z.infer<S>>> {
    return inner.generateStructured({
      ...request,
      onRetry: (event) => {
        count += 1;
        request.onRetry?.(event);
      },
    });
  }

  return {
    client: { streamText, generateStructured },
    retries: () => count,
    reset: () => {
      count = 0;
    },
  };
}
