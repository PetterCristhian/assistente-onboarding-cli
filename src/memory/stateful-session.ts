// A chat session that remembers: it wraps the one pipeline of the turn
// (src/chat/session.ts) and adds, around each question,
//   before: the memory items that matter and the summary of the conversation,
//           as extra context;
//   after:  the turn saved to the session file, the new facts saved to the
//           memory of the profile, and the history compressed when it is
//           over the limits.
// Nothing here writes to the history: only approved texts reach it, through
// the inner session (architecture rule 5). A failure to save, to extract or
// to summarize is told and never changes the answer.
import type {
  AskOptions,
  ChatOutput,
  ChatSession,
  TurnResult,
} from "../chat/session.js";
import {
  APIUserAbortError,
  type LlmClient,
  type LlmMessage,
} from "../llm/client.js";
import { summarizeError } from "../security/error-summary.js";
import type { Redactor } from "../security/redact.js";
import type { StateStore } from "../storage/state-store.js";
import {
  buildSummaryRequest,
  measureHistory,
  messagesToDrop,
  type CompressionLimits,
  type HistorySize,
} from "./compression.js";
import { buildExtractionRequest, newItemsFrom } from "./extraction.js";
import {
  buildExtraContext,
  estimateTokens,
  selectRelevant,
} from "./retrieval.js";
import type { MemoryFile, MemoryItem, SessionFile } from "./types.js";

export interface MemoryPromptTexts {
  readonly usage: string;
  readonly extraction: string;
  readonly summary: string;
}

export interface StatefulLimits extends CompressionLimits {
  readonly memoryMaxItems: number;
}

export interface StatefulSessionDeps {
  /** Created with `initialHistory: activeHistoryOf(sessionFile)`. */
  readonly session: ChatSession;
  readonly llm: LlmClient;
  readonly store: StateStore;
  /** A new session or one read from the disk. */
  readonly sessionFile: SessionFile;
  /** False: the memory is neither read nor written. */
  readonly memoryEnabled: boolean;
  readonly prompts: MemoryPromptTexts;
  readonly limits: StatefulLimits;
  readonly output: ChatOutput;
  readonly redact: Redactor;
  readonly now: () => Date;
}

export interface CompressionReport {
  readonly before: HistorySize;
  readonly after: HistorySize;
  readonly summaryTokens: number;
}

export interface SessionStats {
  readonly history: HistorySize;
  readonly summaryTokens: number;
  readonly totalTurns: number;
  readonly memoryItems: number;
}

export interface StatefulSession {
  readonly id: string;
  readonly history: readonly LlmMessage[];
  readonly memoryEnabled: boolean;
  ask(question: string, options?: AskOptions): Promise<TurnResult>;
  /** Empties the history and the summary of the session; the memory stays. */
  clear(): Promise<void>;
  dropOldest(count: number): void;
  /** The memory of the profile, as kept now. */
  memoryItems(): readonly MemoryItem[];
  /** The items that went into the context of the last question. */
  lastSelection(): readonly MemoryItem[];
  /** The last automatic or forced compression of this run, if any. */
  lastCompression(): CompressionReport | undefined;
  forgetMemory(): Promise<number>;
  /** Forces a compression now. Undefined when there is nothing to drop. */
  compressNow(signal?: AbortSignal): Promise<CompressionReport | undefined>;
  stats(): SessionStats;
}

/** Share of the context that the memory items may take, in tokens. */
const MEMORY_TOKEN_BUDGET = 400;

/** The messages that a resumed session still sends whole to the model. */
export function activeHistoryOf(file: SessionFile): LlmMessage[] {
  const all = file.turnos.flatMap((turn): LlmMessage[] => [
    { role: "user", content: turn.pergunta },
    { role: "assistant", content: turn.resposta },
  ]);
  const active = Math.min(file.mensagensAtivas, all.length);
  return active === 0 ? [] : all.slice(-active);
}

export function newSessionFile(
  id: string,
  profile: string,
  at: string,
): SessionFile {
  return {
    versao: 1,
    id,
    perfil: profile,
    criadaEm: at,
    atualizadaEm: at,
    resumo: "",
    mensagensAtivas: 0,
    turnos: [],
  };
}

export function createStatefulSession(
  deps: StatefulSessionDeps,
): StatefulSession {
  const { session: inner, store, output, redact, limits } = deps;
  let file: SessionFile = deps.sessionFile;
  let memory: MemoryFile = deps.memoryEnabled
    ? store.loadMemory(file.perfil)
    : { versao: 1, perfil: file.perfil, itens: [] };
  let selection: readonly MemoryItem[] = [];
  let compression: CompressionReport | undefined;

  function warn(what: string, error: unknown): void {
    output.notice(
      "warning",
      `${what}: ${summarizeError(error, redact).message}`,
    );
  }

  function isCancellation(error: unknown, signal?: AbortSignal): boolean {
    return error instanceof APIUserAbortError || signal?.aborted === true;
  }

  async function saveSession(changes: Partial<SessionFile>): Promise<void> {
    file = { ...file, ...changes, atualizadaEm: deps.now().toISOString() };
    try {
      await store.saveSession(file);
    } catch (error) {
      warn("Não foi possível gravar a sessão", error);
    }
  }

  async function remember(
    question: string,
    answer: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = await deps.llm.generateStructured({
        ...buildExtractionRequest({
          extractionPrompt: deps.prompts.extraction,
          known: memory.itens,
          question,
          answer,
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      const added = newItemsFrom(
        result.value,
        memory.itens,
        { at: deps.now().toISOString(), session: file.id },
        redact,
      );
      if (added.length === 0) {
        return;
      }
      memory = { ...memory, itens: [...memory.itens, ...added] };
      await store.saveMemory(memory);
      const categories = [...new Set(added.map((item) => item.categoria))];
      output.notice(
        "info",
        `Memória atualizada: ${added.length} ${added.length === 1 ? "item novo" : "itens novos"} (${categories.join(", ")}).`,
      );
    } catch (error) {
      if (!isCancellation(error, signal)) {
        warn("Não foi possível atualizar a memória", error);
      }
    }
  }

  async function compress(
    force: boolean,
    signal?: AbortSignal,
  ): Promise<CompressionReport | undefined> {
    const history = inner.history;
    const drop = messagesToDrop(history, limits, force);
    if (drop === 0) {
      return undefined;
    }
    const before = measureHistory(history);
    let summary: string;
    try {
      const result = await deps.llm.streamText({
        ...buildSummaryRequest({
          summaryPrompt: deps.prompts.summary,
          previousSummary: file.resumo,
          leaving: history.slice(0, drop),
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      summary = redact(result.text).trim();
    } catch (error) {
      // Nothing is dropped without its summary: the next turn tries again.
      if (!isCancellation(error, signal)) {
        warn("Não foi possível comprimir o histórico", error);
      }
      return undefined;
    }
    if (summary === "") {
      return undefined;
    }
    inner.dropOldest(drop);
    const after = measureHistory(inner.history);
    await saveSession({ resumo: summary, mensagensAtivas: after.messages });
    const report: CompressionReport = {
      before,
      after,
      summaryTokens: estimateTokens(summary),
    };
    compression = report;
    output.notice(
      "info",
      `Histórico comprimido: ${before.messages} → ${after.messages} mensagens, ~${before.tokens} → ~${after.tokens + report.summaryTokens} tokens (resumo incluído).`,
    );
    return report;
  }

  return {
    get id(): string {
      return file.id;
    },
    get history(): readonly LlmMessage[] {
      return inner.history;
    },
    memoryEnabled: deps.memoryEnabled,

    async ask(question, options = {}) {
      selection = deps.memoryEnabled
        ? selectRelevant(memory.itens, question, {
            maxItems: limits.memoryMaxItems,
            maxTokens: MEMORY_TOKEN_BUDGET,
          })
        : [];
      const extraContext = buildExtraContext({
        usageRule: deps.prompts.usage,
        selected: selection,
        summary: file.resumo,
      });
      const result = await inner.ask(question, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(extraContext === "" ? {} : { extraContext }),
      });
      if (result.status !== "answered") {
        return result;
      }

      await saveSession({
        turnos: [
          ...file.turnos,
          {
            em: deps.now().toISOString(),
            pergunta: redact(question),
            resposta: result.text,
            origem: result.critique.origin,
          },
        ],
        mensagensAtivas: inner.history.length,
      });
      // Also after the safe message: the facts come from what the user said,
      // not from the answer.
      if (deps.memoryEnabled) {
        await remember(question, result.text, options.signal);
      }
      await compress(false, options.signal);
      return result;
    },

    async clear() {
      inner.clear();
      await saveSession({ resumo: "", mensagensAtivas: 0 });
    },

    dropOldest(count) {
      inner.dropOldest(count);
    },

    memoryItems: () => memory.itens,
    lastSelection: () => selection,
    lastCompression: () => compression,

    async forgetMemory() {
      const count = memory.itens.length;
      memory = { ...memory, itens: [] };
      if (deps.memoryEnabled) {
        await store.saveMemory(memory);
      }
      return count;
    },

    compressNow: (signal) => compress(true, signal),

    stats: () => ({
      history: measureHistory(inner.history),
      summaryTokens: estimateTokens(file.resumo),
      totalTurns: file.turnos.length,
      memoryItems: memory.itens.length,
    }),
  };
}
