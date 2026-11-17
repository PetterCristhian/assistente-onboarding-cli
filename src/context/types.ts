// Shapes of the four context layers (docs/adr/0003-contexto-em-quatro-camadas.md).
// No content lives here: names, rules and contacts exist only in context/.
import { z } from "zod";

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a date that exists: the 31st of a short month does not. */
function isExistingDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

// LF, VT, FF, CR, NEL (U+0085) and the line and paragraph separators.
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

/**
 * True for a text that would take more than one line. Each value of the user
 * section is written in a labeled line of its own: a line break inside one
 * would forge another label.
 */
export function hasLineBreak(value: string): boolean {
  return LINE_BREAK.test(value);
}

/** The problem of a profile value with a line break, as the user reads it. */
export function singleLineFieldProblem(field: string): string {
  return `campo "${field}" deve ter uma única linha.`;
}

const filledText = z
  .string()
  .refine(
    (value) =>
      value.trim() !== "" && value === value.trim() && !hasLineBreak(value),
  );

/** Contract of a file of the user data layer. The keys are in Portuguese. */
export const userProfileSchema = z.strictObject({
  nome: filledText,
  cargo: filledText,
  area: filledText,
  dataInicio: z.string().refine(isExistingDate),
  gestor: filledText,
});

export type UserProfile = z.infer<typeof userProfileSchema>;

export interface CompanyDocument {
  /** File name, such as "assunto.md". Not sent to the model. */
  readonly name: string;
  readonly content: string;
}

/** What the loaders read, ready for the builder. */
export interface ContextLayers {
  readonly globalInstructions: string;
  readonly policies: string;
  readonly userProfile: UserProfile;
  readonly companyData: readonly CompanyDocument[];
  /** Already formatted, so that the builder reads no clock. */
  readonly currentDate: string;
}

/** Each section already carries its opening and closing markers. */
export interface ContextSections {
  readonly globalInstructions: string;
  readonly policies: string;
  readonly userData: string;
  readonly companyData: string;
}

export interface BuiltContext {
  readonly sections: ContextSections;
  /** The four sections, in the fixed order, separated by a blank line. */
  readonly text: string;
}

/** The prompts of the self-critique: files of context/, outside the layers. */
export interface CritiquePrompts {
  /** Role of the auditor; the layers 2, 3 and 4 are appended after it. */
  readonly evaluator: string;
  /** Asks for the rewrite; holds REVISION_VIOLATIONS_MARKER once or more. */
  readonly revision: string;
}

/** Where the revision prompt receives the list of violated rules. */
export const REVISION_VIOLATIONS_MARKER = "{{violacoes}}";

export class ContextError extends Error {
  override readonly name = "ContextError";
}
