// A scripted LlmClient for tests: no SDK client, no network, no key. Each
// call takes the next step of the script, in order. It is as strict as the
// real client (src/llm/client.ts) about what it accepts and about
// cancellation, so that a test that passes here does not fail there.
import { APIUserAbortError } from "openai";
import type { z } from "zod";
import {
  LlmResponseError,
  type LlmClient,
  type LlmRequest,
  type LlmStructuredResult,
  type LlmTextResult,
  type LlmUsage,
  type StreamTextRequest,
  type StructuredRequest,
} from "../../src/llm/client.js";

export const FAKE_LLM_MODEL = "fake-model";

/**
 * Holds a step until the test lets it go: a promise, or a function that is
 * called once, when the step starts, and may return a promise. Nothing is
 * delivered before it settles. No real timer is involved: the test decides.
 * A call that is cancelled while it waits rejects at once, like the real one.
 */
export type FakeWait =
  PromiseLike<unknown> | (() => PromiseLike<unknown> | void);

interface FakeStepTiming {
  readonly wait?: FakeWait;
}

/**
 * Answers a streamText call. Without `chunks`, the text is a single chunk.
 * With `chunks`, the text must be the chunks joined, as in the real client.
 */
export interface FakeTextStep extends FakeStepTiming {
  readonly text: string;
  readonly chunks?: readonly string[];
  readonly model?: string;
  readonly usage?: LlmUsage;
}

/** Answers a generateStructured call. Checked by the schema of the request. */
export interface FakeValueStep extends FakeStepTiming {
  readonly value: unknown;
  readonly model?: string;
  readonly usage?: LlmUsage;
}

/** Makes the next call, of either kind, reject with the given error. */
export interface FakeErrorStep extends FakeStepTiming {
  readonly error: unknown;
}

/**
 * Answers a streamText call with some chunks and then the given error: a
 * stream that fails after part of the answer was already delivered.
 */
export interface FakePartialStep extends FakeStepTiming {
  readonly chunks: readonly string[];
  readonly error: unknown;
}

export type FakeLlmStep =
  FakeTextStep | FakeValueStep | FakeErrorStep | FakePartialStep;

export type FakeLlmCall =
  | { readonly kind: "streamText"; readonly request: StreamTextRequest }
  | {
      readonly kind: "generateStructured";
      readonly request: StructuredRequest<z.ZodType>;
    };

export interface FakeLlmClient extends LlmClient {
  /**
   * Every call received so far, in order. Each request is a snapshot: its
   * data (instructions, input, model) is a copy made when the call arrived.
   */
  readonly calls: readonly FakeLlmCall[];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isPartial(step: FakeLlmStep): step is FakePartialStep {
  return "error" in step && "chunks" in step;
}

function checkScript(script: readonly FakeLlmStep[]): void {
  for (const step of script) {
    if (
      "text" in step &&
      step.chunks !== undefined &&
      step.chunks.join("") !== step.text
    ) {
      throw new Error(
        "Fake LLM client: `text` must be the `chunks` joined, as in the real client.",
      );
    }
  }
}

/**
 * The callback, the signal and the schema are kept as they are (they cannot
 * be cloned); the data is copied, so that a history that the caller changes
 * afterwards does not change what was recorded.
 */
function snapshot<R extends LlmRequest>(request: R): R {
  return { ...request, input: structuredClone(request.input) };
}

/** The same checks, in the same order, as the real client. */
function refuseBeforeStarting(request: LlmRequest): void {
  if (request.input.length === 0) {
    throw new TypeError("LlmRequest.input must not be empty.");
  }
  throwIfAborted(request.signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new APIUserAbortError();
  }
}

async function hold(
  wait: FakeWait | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (wait === undefined) {
    return;
  }
  const pending = Promise.resolve(typeof wait === "function" ? wait() : wait);
  if (signal === undefined) {
    await pending;
    return;
  }
  let stopListening = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new APIUserAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    stopListening = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([pending, aborted]);
  } finally {
    stopListening();
  }
}

/** Lets one turn of the microtask queue pass: no real timer. */
async function nextTick(signal: AbortSignal | undefined): Promise<void> {
  await Promise.resolve();
  throwIfAborted(signal);
}

/** Throws when a step of the script contradicts itself. */
export function createFakeLlmClient(
  script: readonly FakeLlmStep[],
): FakeLlmClient {
  checkScript(script);
  const steps = [...script];
  const calls: FakeLlmCall[] = [];

  function nextStep(): FakeLlmStep {
    const step = steps.shift();
    if (step === undefined) {
      throw new Error("Fake LLM client: the script has no step left.");
    }
    return step;
  }

  // Both are `async`, so that every failure, also a mistake in the script,
  // comes out as a rejected promise and never as a synchronous throw. A call
  // that is refused before it starts takes no step of the script.
  async function runStreamText(
    request: StreamTextRequest,
  ): Promise<LlmTextResult> {
    refuseBeforeStarting(request);
    const step = nextStep();
    await hold(step.wait, request.signal);
    throwIfAborted(request.signal);
    if ("error" in step && !isPartial(step)) {
      throw asError(step.error);
    }
    if (!("text" in step) && !isPartial(step)) {
      throw new Error("Fake LLM client: expected a text step.");
    }

    // One chunk per turn, each after an `await`: as in a real stream, none
    // is delivered while the caller is still inside the call.
    const chunks = isPartial(step) ? step.chunks : (step.chunks ?? [step.text]);
    for (const chunk of chunks) {
      await nextTick(request.signal);
      request.onChunk?.(chunk);
    }
    await nextTick(request.signal);
    if (isPartial(step)) {
      throw asError(step.error);
    }
    return {
      text: step.text,
      model: step.model ?? FAKE_LLM_MODEL,
      chunks: chunks.length,
      ...(step.usage === undefined ? {} : { usage: step.usage }),
    };
  }

  async function runGenerateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<LlmStructuredResult<z.infer<S>>> {
    refuseBeforeStarting(request);
    const step = nextStep();
    await hold(step.wait, request.signal);
    await nextTick(request.signal);
    if (isPartial(step)) {
      throw new Error("Fake LLM client: expected a value step.");
    }
    if ("error" in step) {
      throw asError(step.error);
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
    return {
      value: parsed.data,
      model,
      ...(step.usage === undefined ? {} : { usage: step.usage }),
    };
  }

  function streamText(request: StreamTextRequest): Promise<LlmTextResult> {
    calls.push({ kind: "streamText", request: snapshot(request) });
    return runStreamText(request);
  }

  function generateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<LlmStructuredResult<z.infer<S>>> {
    calls.push({ kind: "generateStructured", request: snapshot(request) });
    return runGenerateStructured(request);
  }

  return { calls, streamText, generateStructured };
}
