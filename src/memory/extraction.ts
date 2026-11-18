// Turns one answered turn into new memory items. Pure: it writes the request
// and merges what the model returned; the caller makes the call and saves.
import type { LlmMessage } from "../llm/client.js";
import type { Redactor } from "../security/redact.js";
import {
  EXTRACTION_SCHEMA_NAME,
  extractionSchema,
  type Extraction,
  type MemoryItem,
} from "./types.js";

const MAX_ITEM_LENGTH = 300;
const MAX_KEYWORDS = 8;

function quote(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

export function buildExtractionRequest(input: {
  readonly extractionPrompt: string;
  readonly known: readonly MemoryItem[];
  readonly question: string;
  readonly answer: string;
}): {
  readonly instructions: string;
  readonly input: readonly LlmMessage[];
  readonly schema: typeof extractionSchema;
  readonly schemaName: string;
} {
  const known =
    input.known.length === 0
      ? "(vazia)"
      : input.known
          .map((item) => `- [${item.categoria}] ${quote(item.texto)}`)
          .join("\n");
  return {
    instructions: input.extractionPrompt,
    input: [
      {
        role: "user",
        content: `<memoria_registrada>\n${known}\n</memoria_registrada>\n<mensagem_do_usuario>\n${quote(input.question)}\n</mensagem_do_usuario>\n<resposta_do_assistente>\n${quote(input.answer)}\n</resposta_do_assistente>`,
      },
    ],
    schema: extractionSchema,
    schemaName: EXTRACTION_SCHEMA_NAME,
  };
}

function sameText(a: string, b: string): boolean {
  const fold = (text: string): string =>
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return fold(a) === fold(b);
}

/**
 * The items to add: cleaned, redacted, one line each, and never a repeat of
 * what is already kept. The ids continue the count of the memory.
 */
export function newItemsFrom(
  extraction: Extraction,
  known: readonly MemoryItem[],
  meta: { readonly at: string; readonly session: string },
  redact: Redactor,
): MemoryItem[] {
  const added: MemoryItem[] = [];
  let next =
    known.reduce((highest, item) => {
      const number = Number(/^m(\d+)$/.exec(item.id)?.[1] ?? 0);
      return Math.max(highest, number);
    }, 0) + 1;
  for (const raw of extraction.itens) {
    const text = redact(raw.texto)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ITEM_LENGTH);
    if (
      text === "" ||
      [...known, ...added].some((item) => sameText(item.texto, text))
    ) {
      continue;
    }
    added.push({
      id: `m${next}`,
      categoria: raw.categoria,
      texto: text,
      palavrasChave: raw.palavrasChave
        .map((word) => redact(word).replace(/\s+/g, " ").trim())
        .filter((word) => word !== "")
        .slice(0, MAX_KEYWORDS),
      criadoEm: meta.at,
      sessao: meta.session,
    });
    next += 1;
  }
  return added;
}
