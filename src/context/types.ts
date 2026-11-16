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

const filledText = z
  .string()
  .refine((value) => value.trim() !== "" && value === value.trim());

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

export class ContextError extends Error {
  override readonly name = "ContextError";
}
