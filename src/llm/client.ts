// The only path to the provider (CLAUDE.md, architecture rule 2): the
// LlmClient interface that the rest of the project depends on.
// See docs/adr/0002-modelo-e-api-openai.md.
import type { z } from "zod";

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  /** The assembled context, or the prompt of the reviewer or of the judge. */
  readonly instructions: string;
  /** The history followed by the question. Never empty. */
  readonly input: readonly LlmMessage[];
  /** Default: the model of the configuration. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface StreamTextRequest extends LlmRequest {
  /** Called with each piece of text, in order, as it arrives. */
  readonly onChunk?: (chunk: string) => void;
}

export interface LlmTextResult {
  /** The whole text: the pieces, joined. */
  readonly text: string;
  /** The model that answered, as reported by the provider. */
  readonly model: string;
  /** How many pieces of text arrived. */
  readonly chunks: number;
  readonly usage?: LlmUsage;
}

export interface StructuredRequest<S extends z.ZodType> extends LlmRequest {
  readonly schema: S;
  /** Name of the schema, shown to the model. */
  readonly schemaName: string;
}

export interface LlmStructuredResult<T> {
  readonly value: T;
  /** The model that answered, as reported by the provider. */
  readonly model: string;
  readonly usage?: LlmUsage;
}

export interface LlmClient {
  streamText(request: StreamTextRequest): Promise<LlmTextResult>;
  generateStructured<S extends z.ZodType>(
    request: StructuredRequest<S>,
  ): Promise<LlmStructuredResult<z.infer<S>>>;
}

/**
 * What the provider answered without an error of transport or of API, but
 * that is no usable answer:
 * - interrupted: the stream ended before the answer was complete;
 * - failed / incomplete: the provider reported the answer as such;
 * - empty: complete, with no text;
 * - refusal: the model refused to answer;
 * - invalid_output: structured output that is not JSON or not in the schema.
 */
export type LlmResponseErrorKind =
  | "interrupted"
  | "failed"
  | "incomplete"
  | "empty"
  | "refusal"
  | "invalid_output";

/** The message is written for the user and never quotes the model output. */
export class LlmResponseError extends Error {
  override readonly name = "LlmResponseError";
  readonly kind: LlmResponseErrorKind;
  readonly model?: string;

  constructor(kind: LlmResponseErrorKind, message: string, model?: string) {
    super(message);
    this.kind = kind;
    if (model !== undefined) {
      this.model = model;
    }
  }
}
