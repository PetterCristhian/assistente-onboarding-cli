// The compression of the history. Pure: it decides how many of the oldest
// messages leave and writes the request for their summary; the caller makes
// the call and drops the messages.
//
// The techniques, in the order they apply:
//   - conditional: nothing happens below the limits (unless forced);
//   - sliding window: only the last `keepMessages` stay whole;
//   - token limit: the window shrinks further while it is over `maxTokens`;
//   - summary: what leaves is folded into the running summary.
import type { LlmMessage } from "../llm/client.js";
import { estimateTokens } from "./retrieval.js";

export interface CompressionLimits {
  readonly maxTokens: number;
  readonly maxMessages: number;
  readonly keepMessages: number;
}

export interface HistorySize {
  readonly messages: number;
  /** Estimated. */
  readonly tokens: number;
}

export function measureHistory(history: readonly LlmMessage[]): HistorySize {
  return {
    messages: history.length,
    tokens: history.reduce(
      (total, message) => total + estimateTokens(message.content),
      0,
    ),
  };
}

/**
 * How many of the oldest messages must leave: 0 when the history is within
 * the limits and the compression was not forced. Always a whole number of
 * turns (question and answer), and at least one turn stays.
 */
export function messagesToDrop(
  history: readonly LlmMessage[],
  limits: CompressionLimits,
  force = false,
): number {
  const size = measureHistory(history);
  const over =
    size.messages > limits.maxMessages || size.tokens > limits.maxTokens;
  if (!over && !force) {
    return 0;
  }
  const keep = Math.max(2, limits.keepMessages + (limits.keepMessages % 2));
  let drop = Math.max(0, history.length - keep);
  drop -= drop % 2;
  while (
    history.length - drop > 2 &&
    measureHistory(history.slice(drop)).tokens > limits.maxTokens
  ) {
    drop += 2;
  }
  return drop;
}

const SPEAKERS = { user: "Usuário", assistant: "Assistente" } as const;

/** The request for the summary that replaces the messages that leave. */
export function buildSummaryRequest(input: {
  readonly summaryPrompt: string;
  readonly previousSummary: string;
  readonly leaving: readonly LlmMessage[];
}): { readonly instructions: string; readonly input: readonly LlmMessage[] } {
  const transcript = input.leaving
    .map(
      (message) =>
        `${SPEAKERS[message.role]}: ${message.content.replace(/</g, "‹").replace(/>/g, "›")}`,
    )
    .join("\n");
  const previous = input.previousSummary
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim();
  return {
    instructions: input.summaryPrompt,
    input: [
      {
        role: "user",
        content: `<resumo_anterior>\n${previous === "" ? "(vazio)" : previous}\n</resumo_anterior>\n<mensagens>\n${transcript}\n</mensagens>`,
      },
    ],
  };
}
