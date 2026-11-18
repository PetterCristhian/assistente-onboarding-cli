// Shapes of what is kept between runs: the memory of a user and one chat
// session. The keys are in Portuguese, as in every file that is written.
import { z } from "zod";

export const MEMORY_CATEGORIES = [
  "solicitacoes",
  "preferencias",
  "problemas",
  "relacionamento",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const memoryItemSchema = z.strictObject({
  id: z.string().min(1),
  categoria: z.enum(MEMORY_CATEGORIES),
  texto: z.string().min(1),
  palavrasChave: z.array(z.string()),
  /** ISO 8601. */
  criadoEm: z.string().min(1),
  /** The session in which the user said it. */
  sessao: z.string().min(1),
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const memoryFileSchema = z.strictObject({
  versao: z.literal(1),
  /** Slug of the profile: the memory never crosses profiles. */
  perfil: z.string().min(1),
  itens: z.array(memoryItemSchema),
});
export type MemoryFile = z.infer<typeof memoryFileSchema>;

export const sessionTurnSchema = z.strictObject({
  em: z.string().min(1),
  pergunta: z.string(),
  /** Always an approved text or the safe message (architecture rule 5). */
  resposta: z.string(),
  origem: z.enum(["rascunho", "revisao", "fallback"]),
});
export type SessionTurn = z.infer<typeof sessionTurnSchema>;

export const sessionFileSchema = z.strictObject({
  versao: z.literal(1),
  id: z.string().min(1),
  perfil: z.string().min(1),
  criadaEm: z.string().min(1),
  atualizadaEm: z.string().min(1),
  /** Running summary of the messages that left the window. */
  resumo: z.string(),
  /** How many of the last messages are still sent whole to the model. */
  mensagensAtivas: z.number().int().min(0),
  /** Every turn of the session, compressed or not. */
  turnos: z.array(sessionTurnSchema),
});
export type SessionFile = z.infer<typeof sessionFileSchema>;

/** What the model returns when asked for the new facts of a turn. */
export const extractionSchema = z.strictObject({
  itens: z.array(
    z.strictObject({
      categoria: z.enum(MEMORY_CATEGORIES),
      texto: z.string(),
      palavrasChave: z.array(z.string()),
    }),
  ),
});
export type Extraction = z.infer<typeof extractionSchema>;

export const EXTRACTION_SCHEMA_NAME = "memoria";

/** Lower case, hyphens, at most 64: safe as a file name and to quote. */
export const STATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A name becomes lower case with hyphens. Empty when nothing is left. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
