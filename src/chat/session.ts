// One chat session: the history of the turns and the single pipeline that
// answers a question (architecture rule 6). It knows no terminal: whatever
// is shown goes to the ChatOutput that the caller passes in, so that the
// chat and the test battery can share it.
import {
  APIUserAbortError,
  LlmResponseError,
  type LlmClient,
  type LlmMessage,
  type LlmTextResult,
} from "../llm/client.js";
import {
  summarizeError,
  type ErrorSummary,
} from "../security/error-summary.js";
import type { Redactor } from "../security/redact.js";

export type NoticeLevel = "info" | "warning" | "error";

/** Where the session sends what the user sees. */
export interface ChatOutput {
  /** A piece of the answer, as it arrives. No line break is implied. */
  chunk(text: string): void;
  /** The answer is over (complete or cut): closes the line. */
  endAnswer(): void;
  notice(level: NoticeLevel, text: string): void;
}

export interface ChatSessionDeps {
  readonly llm: LlmClient;
  /** The whole assembled context. */
  readonly instructions: string;
  readonly output: ChatOutput;
  readonly redact: Redactor;
}

export type TurnResult =
  | { status: "answered"; text: string; model: string; chunks: number }
  | { status: "cancelled" }
  | { status: "failed"; summary: ErrorSummary };

export interface ChatSession {
  readonly history: readonly LlmMessage[];
  ask(
    question: string,
    options?: { signal?: AbortSignal },
  ): Promise<TurnResult>;
  clear(): void;
}

const BUSY_MESSAGE = "turno em andamento";

function failureText(error: unknown, summary: ErrorSummary): string {
  // The message of this error is already written for the user.
  if (error instanceof LlmResponseError) {
    return summary.message;
  }
  const details = [
    summary.status === undefined ? undefined : `status ${summary.status}`,
    summary.code === undefined ? undefined : `código ${summary.code}`,
  ].filter((part) => part !== undefined);
  const where = details.length === 0 ? "" : ` (${details.join(", ")})`;
  return `Não foi possível obter a resposta${where}. ${summary.message}`;
}

export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const history: LlmMessage[] = [];
  let busy = false;

  /** The draft of the answer: the model streams it to the output. */
  function draftAnswer(
    input: readonly LlmMessage[],
    signal: AbortSignal | undefined,
    onChunk: (chunk: string) => void,
  ): Promise<LlmTextResult> {
    return deps.llm.streamText({
      instructions: deps.instructions,
      input,
      ...(signal === undefined ? {} : { signal }),
      onChunk,
    });
  }

  /**
   * The only place that writes to the history (architecture rule 5).
   * ENG-53 puts the self-evaluation between `draftAnswer` and this call:
   * only an approved text, or the safe message, may get here.
   */
  function commitTurn(question: string, text: string): void {
    history.push(
      { role: "user", content: question },
      { role: "assistant", content: text },
    );
    deps.output.endAnswer();
  }

  async function ask(
    question: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TurnResult> {
    if (busy) {
      throw new Error(BUSY_MESSAGE);
    }
    busy = true;
    const { signal } = options;
    let streamed = false;
    try {
      const input: LlmMessage[] = [
        ...history,
        { role: "user", content: question },
      ];
      const result = await draftAnswer(input, signal, (chunk) => {
        streamed = true;
        deps.output.chunk(chunk);
      });
      commitTurn(question, result.text);
      return {
        status: "answered",
        text: result.text,
        model: result.model,
        chunks: result.chunks,
      };
    } catch (error) {
      if (streamed) {
        deps.output.endAnswer();
      }
      if (error instanceof APIUserAbortError || signal?.aborted === true) {
        return { status: "cancelled" };
      }
      const summary = summarizeError(error, deps.redact);
      if (streamed) {
        deps.output.notice("warning", "Resposta interrompida.");
      }
      deps.output.notice("error", failureText(error, summary));
      return { status: "failed", summary };
    } finally {
      busy = false;
    }
  }

  return {
    get history(): readonly LlmMessage[] {
      return [...history];
    },
    ask,
    clear(): void {
      history.length = 0;
    },
  };
}
