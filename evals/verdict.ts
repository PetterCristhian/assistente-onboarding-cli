// The deterministic layer of the verdict (ADR 0006): objective checks over the
// final text of the LAST turn of an execution. Pure: no model, no disk, no
// clock. The judge (ENG-57) is a later layer; until then `juiz` is null.
import type { Origin } from "../src/chat/critique.js";
import { normalizeForMatch } from "./normalize.js";
import type { Caso } from "./schema.js";

export type CheckType = "deveConter" | "naoDeveConter" | "semEmoji" | "origem";

export interface Check {
  readonly tipo: CheckType;
  /** The terms of the group, the term, nothing (semEmoji) or "fallback". */
  readonly alvo: readonly string[];
  readonly ok: boolean;
}

export type Resultado = "passou" | "falhou" | "erro";

export interface Verdict {
  readonly resultado: Resultado;
  /** Present for `erro` and when the final text is the safe message. */
  readonly motivo?: string;
  /** Empty for `erro`: there is no text to check. */
  readonly checagens: readonly Check[];
  /** The judge of ENG-57 is not part of this delivery. */
  readonly juiz: null;
}

/** What one execution produced, as far as the verdict is concerned. */
export type Outcome =
  | {
      readonly kind: "answered";
      /** The final text of the last turn. */
      readonly text: string;
      readonly origin: Origin;
      /** The self-evaluation could not be made (an error, not a verdict). */
      readonly evaluationFailed: boolean;
    }
  | { readonly kind: "error"; readonly motivo: string };

export const EVALUATION_UNAVAILABLE = "autoavaliação indisponível";
export const FALLBACK_REASON =
  "a resposta final é a mensagem segura (a autoavaliação não aprovou nenhuma versão)";

/**
 * Whether the normalized text holds the normalized term. No trim: a term such
 * as "def " does not match "undef".
 */
export function containsTerm(text: string, term: string): boolean {
  return normalizeForMatch(text).includes(normalizeForMatch(term));
}

// The copyright, registered and trademark signs are pictographic for Unicode
// but are plain text here; with U+FE0F after them they are drawn as emoji,
// and the loose U+FE0F below catches that.
const PICTOGRAPHIC = /(?![©®™])\p{Extended_Pictographic}/u;
// Flags, skin tones, keycaps and the emoji presentation selector. \p{Emoji}
// is NOT used: it holds the digits, "#" and "*".
const EMOJI_PARTS = /\p{Regional_Indicator}|\p{Emoji_Modifier}|[0-9#*]️?⃣|️/u;

/** P2: no emoji. Runs on the raw text, not on the normalized one. */
export function hasEmoji(text: string): boolean {
  return PICTOGRAPHIC.test(text) || EMOJI_PARTS.test(text);
}

export function runChecks(
  criterios: Caso["criterios"],
  finalText: string,
  origin: Origin,
): Check[] {
  return [
    ...criterios.deveConter.map((group): Check => ({
      tipo: "deveConter",
      alvo: group,
      ok: group.some((term) => containsTerm(finalText, term)),
    })),
    ...criterios.naoDeveConter.map((term): Check => ({
      tipo: "naoDeveConter",
      alvo: [term],
      ok: !containsTerm(finalText, term),
    })),
    { tipo: "semEmoji", alvo: [], ok: !hasEmoji(finalText) },
    { tipo: "origem", alvo: ["fallback"], ok: origin !== "fallback" },
  ];
}

/**
 * Precedence: error > safe message (fails) > the checks. An execution whose
 * final text is the safe message always fails, whatever the checks say, but
 * the checks are still computed and recorded.
 */
export function buildVerdict(caso: Caso, outcome: Outcome): Verdict {
  if (outcome.kind === "error") {
    return {
      resultado: "erro",
      motivo: outcome.motivo,
      checagens: [],
      juiz: null,
    };
  }
  if (outcome.evaluationFailed) {
    return {
      resultado: "erro",
      motivo: EVALUATION_UNAVAILABLE,
      checagens: [],
      juiz: null,
    };
  }
  const checagens = runChecks(caso.criterios, outcome.text, outcome.origin);
  if (outcome.origin === "fallback") {
    return {
      resultado: "falhou",
      motivo: FALLBACK_REASON,
      checagens,
      juiz: null,
    };
  }
  return {
    resultado: checagens.every((check) => check.ok) ? "passou" : "falhou",
    checagens,
    juiz: null,
  };
}
