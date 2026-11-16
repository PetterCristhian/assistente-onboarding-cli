// A scripted LlmClient for tests: no SDK, no network, no key. Each call takes
// the next step of the script, in order.
import type { z } from "zod";
import {
  LlmResponseError,
  type LlmClient,
  type LlmStructuredResult,
  type LlmTextResult,
  type LlmUsage,
  type StreamTextRequest,
  type StructuredRequest,
} from "../../src/llm/client.js";

export const FAKE_LLM_MODEL = "fake-model";

/** Answers a streamText call. Without `chunks`, the text is a single chunk. */
export interface FakeTextStep {
  readonly text: string;
  readonly chunks?: readonly string[];
  readonly model?: string;
  readonly usage?: LlmUsage;
}

/** Answers a generateStructured call. Checked by the schema of the request. */
export interface FakeValueStep {
  readonly value: unknown;
  readonly model?: string;
  readonly usage?: LlmUsage;
}

/** Makes the next call, of either kind, reject with the given error. */
export interface FakeErrorStep {
  readonly error: unknown;
}

export type FakeLlmStep = FakeTextStep | FakeValueStep | FakeErrorStep;

export type FakeLlmCall =
  | { readonly kind: "streamText"; readonly request: StreamTextRequest }
  | {
      readonly kind: "generateStructured";
      readonly request: StructuredRequest<z.ZodType>;
    };

export interface FakeLlmClient extends LlmClient {
  /** Every call received so far, in order. */
  readonly calls: readonly FakeLlmCall[];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createFakeLlmClient(
  script: readonly FakeLlmStep[],
): FakeLlmClient {
  const steps = [...script];
  const calls: FakeLlmCall[] = [];

  function nextStep(): FakeLlmStep {
    const step = steps.shift();
    if (step === undefined) {
      throw new Error("Fake LLM client: the script has no step left.");
    }
    return step;
  }

  // The methods are not `async`, so that a mistake in the script also comes
  // out as a rejected promise and never as a synchronous throw.
  function streamText(request: StreamTextRequest): Promise<LlmTextResult> {
    calls.push({ kind: "streamText", request });
    try {
      const step = nextStep();
      if ("error" in step) {
        return Promise.reject(asError(step.error));
      }
      if (!("text" in step)) {
        throw new Error("Fake LLM client: expected a text step.");
      }
      const chunks = step.chunks ?? [step.text];
      for (const chunk of chunks) {
        request.onChunk?.(chunk);
      }
      return Promise.resolve({
        text: step.text,
        model: step.model ?? FAKE_LLM_MODEL,
        chunks: chunks.length,
        ...(step.usage === undefined ? {} : { usage: step.usage }),
      });
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  function generateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<LlmStructuredResult<z.infer<S>>> {
    calls.push({ kind: "generateStructured", request });
    try {
      const step = nextStep();
      if ("error" in step) {
        return Promise.reject(asError(step.error));
      }
      if (!("value" in step)) {
        throw new Error("Fake LLM client: expected a value step.");
      }
      const model = step.model ?? FAKE_LLM_MODEL;
      const parsed = request.schema.safeParse(step.value);
      if (!parsed.success) {
        throw new LlmResponseError(
          "invalid_output",
          "A saída estruturada do modelo não segue o formato esperado.",
          model,
        );
      }
      return Promise.resolve({
        value: parsed.data,
        model,
        ...(step.usage === undefined ? {} : { usage: step.usage }),
      });
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  return { calls, streamText, generateStructured };
}
