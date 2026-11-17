// The self-critique (docs/adr/0004-streaming-e-self-critique.md): the schema
// of the evaluation and the requests of the evaluator and of the revision.
// Pure: no model call, no disk, no clock, no rate limiter. The session decides
// when each request is made.
import { z } from "zod";
import {
  REVISION_VIOLATIONS_MARKER,
  type ContextSections,
} from "../context/types.js";
import type { LlmMessage, StructuredRequest } from "../llm/client.js";
import type { ErrorSummary } from "../security/error-summary.js";
import type { Redactor } from "../security/redact.js";

/** The policies that an answer can violate. */
export const RULE_IDS = ["P1", "P2", "P3", "P4", "P5"] as const;
export type RuleId = (typeof RULE_IDS)[number];

/**
 * What the evaluator returns. Strict on purpose, for the structured output of
 * the provider: an object at the root, no optional field and no length or
 * `refine` checks (those are done by `normalizeEvaluation`).
 */
export const evaluationSchema = z.strictObject({
  aprovada: z.boolean(),
  violacoes: z.array(
    z.strictObject({
      regra: z.enum(RULE_IDS),
      motivo: z.string(),
    }),
  ),
});
export type RawEvaluation = z.infer<typeof evaluationSchema>;

export const EVALUATION_SCHEMA_NAME = "autoavaliacao";

/** Used when the evaluator rejects an answer and names no rule. */
export const UNKNOWN_RULE = "desconhecida";
export type ViolationRule = RuleId | typeof UNKNOWN_RULE;

export interface Violation {
  readonly rule: ViolationRule;
  /** Text of the model, already cleaned (see `cleanReason`). */
  readonly reason: string;
}

/** A verdict that follows the rules of `normalizeEvaluation`. */
export interface Verdict {
  readonly approved: boolean;
  readonly violations: readonly Violation[];
}

/** What came out of one evaluation: a verdict, or why there is none. */
export type EvaluationOutcome =
  | ({ readonly status: "ok" } & Verdict)
  | { readonly status: "error"; readonly summary: ErrorSummary };

/** Where the final text of a turn came from. */
export type Origin = "rascunho" | "revisao" | "fallback";

export interface TurnCritique {
  /** The draft, already redacted: what was shown first. */
  readonly draft: string;
  readonly evaluation: EvaluationOutcome;
  /** Present when a revision was written (even one that was not used). */
  readonly revision?: {
    readonly text: string;
    /** Absent when the revision was dropped before it was evaluated. */
    readonly evaluation?: EvaluationOutcome;
  };
  readonly origin: Origin;
  /** Distinct rules of the rejecting verdicts, in order of appearance. */
  readonly violatedRules: readonly ViolationRule[];
  /** Logical calls to the model in the turn (a retry is not counted). */
  readonly llmCalls: number;
}

/** What the session needs to run the self-critique. */
export interface CritiqueDeps {
  /** Layers 2, 3 and 4 as the evaluator reads them (see below). */
  readonly evaluatorContext: string;
  /** Role of the auditor (context/avaliador.md). */
  readonly evaluatorPrompt: string;
  /** Rewrite request with the marker of the violations (context/revisao.md). */
  readonly revisionPrompt: string;
  /** The fixed safe message (context/fallback.md). Never sent to the model. */
  readonly fallbackMessage: string;
  /** How many messages of the history the evaluator sees. */
  readonly recentHistoryMessages?: number;
}

export const DEFAULT_RECENT_HISTORY_MESSAGES = 6;
export const MAX_REASON_LENGTH = 200;
const NO_REASON = "sem motivo informado";
const UNKNOWN_RULE_REASON =
  "a avaliação reprovou a resposta sem indicar a regra";

/**
 * Layers 2, 3 and 4, already marked. The evaluator never receives layer 1:
 * the global instructions are for the assistant, and the auditor checks the
 * policies, the user data and the company data.
 */
export function buildEvaluatorContext(sections: ContextSections): string {
  return [sections.policies, sections.userData, sections.companyData].join(
    "\n\n",
  );
}

// A tag of the delimiters, opening or closing, inside the text under audit.
const DELIMITER_TAG = /<(\s*\/?\s*(?:pergunta|rascunho)\b)/gi;

/** The text cannot close (or open) the delimiter that holds it. */
function neutralizeDelimiters(text: string): string {
  return text.replace(DELIMITER_TAG, "&lt;$1");
}

export interface EvaluationInput {
  readonly evaluatorPrompt: string;
  readonly evaluatorContext: string;
  readonly history: readonly LlmMessage[];
  readonly question: string;
  readonly draft: string;
  readonly recentHistoryMessages?: number;
}

/** The last messages of the history, starting at a message of the user. */
function recentMessages(
  history: readonly LlmMessage[],
  count: number,
): LlmMessage[] {
  const recent = count <= 0 ? [] : history.slice(-count);
  while (recent[0]?.role === "assistant") {
    recent.shift();
  }
  return recent;
}

export function buildEvaluationRequest(
  input: EvaluationInput,
): Pick<
  StructuredRequest<typeof evaluationSchema>,
  "instructions" | "input" | "schema" | "schemaName"
> {
  const count = input.recentHistoryMessages ?? DEFAULT_RECENT_HISTORY_MESSAGES;
  return {
    instructions: `${input.evaluatorPrompt}\n\n${input.evaluatorContext}`,
    input: [
      ...recentMessages(input.history, count),
      {
        role: "user",
        content: `<pergunta>\n${neutralizeDelimiters(input.question)}\n</pergunta>\n<rascunho>\n${neutralizeDelimiters(input.draft)}\n</rascunho>`,
      },
    ],
    schema: evaluationSchema,
    schemaName: EVALUATION_SCHEMA_NAME,
  };
}

const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * The reason is text of the model: redacted, flattened into one line without
 * control or format characters, free of angle brackets (so that it cannot
 * close the delimiter of the revision prompt) and cut. Redaction comes first,
 * so that a cut key still gets caught.
 */
export function cleanReason(reason: string, redact: Redactor): string {
  // Invisible characters may sit in the middle of a key. Taken out (not
  // replaced by a blank), the key is whole again and gets caught; when
  // nothing is caught that way, the usual form (a blank in their place)
  // keeps the words apart.
  const joined = reason.replace(INVISIBLE_CHARACTERS, "");
  const joinedSafe = redact(joined);
  const base =
    joinedSafe !== joined
      ? joinedSafe
      : redact(reason.replace(INVISIBLE_CHARACTERS, " "));
  const flat = base.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const cut = [...flat].slice(0, MAX_REASON_LENGTH).join("").trim();
  return cut === "" ? NO_REASON : cut;
}

/**
 * Fixes a verdict that contradicts itself, always towards rejection:
 * - approved with violations listed: rejected;
 * - rejected with no violation listed: rejected, with an unknown rule.
 */
export function normalizeEvaluation(
  raw: RawEvaluation,
  redact: Redactor,
): Verdict {
  const violations: Violation[] = raw.violacoes.map((item) => ({
    rule: item.regra,
    reason: cleanReason(item.motivo, redact),
  }));
  if (raw.aprovada && violations.length === 0) {
    return { approved: true, violations: [] };
  }
  if (violations.length === 0) {
    return {
      approved: false,
      violations: [{ rule: UNKNOWN_RULE, reason: UNKNOWN_RULE_REASON }],
    };
  }
  return { approved: false, violations };
}

/** The distinct rules, in order of appearance. */
export function rulesOf(violations: readonly Violation[]): ViolationRule[] {
  return [...new Set(violations.map((violation) => violation.rule))];
}

function describeRule(rule: ViolationRule): string {
  return rule === UNKNOWN_RULE ? "regra não identificada" : `regra ${rule}`;
}

/** One line per violation, as the revision prompt and the screen read it. */
export function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map((violation) => `${describeRule(violation.rule)}: ${violation.reason}`)
    .join("; ");
}

export interface RevisionInput {
  /** The whole context, with layer 1: the revision writes as the assistant. */
  readonly instructions: string;
  readonly revisionPrompt: string;
  readonly history: readonly LlmMessage[];
  readonly question: string;
  /** The rejected draft, already redacted. */
  readonly draft: string;
  readonly violations: readonly Violation[];
}

/** No `onChunk`: the text of a revision is shown only after it is approved. */
export function buildRevisionRequest(input: RevisionInput): {
  readonly instructions: string;
  readonly input: readonly LlmMessage[];
} {
  const list = input.violations
    .map(
      (violation) => `- ${describeRule(violation.rule)}: ${violation.reason}`,
    )
    .join("\n");
  // A function as replacement: no `$` of the reason is read as a pattern.
  const request = input.revisionPrompt.replaceAll(
    REVISION_VIOLATIONS_MARKER,
    () => `\n<violacoes>\n${list}\n</violacoes>\n`,
  );
  return {
    instructions: input.instructions,
    input: [
      ...input.history,
      { role: "user", content: input.question },
      { role: "assistant", content: input.draft },
      { role: "user", content: request },
    ],
  };
}
