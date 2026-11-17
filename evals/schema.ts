// Schema of evals/casos.json (ADR 0006). Holds no domain data: every case lives
// in the JSON file. The semantics of the fields are in the ADR.
import { z } from "zod";

export const CATEGORIES = [
  "caminho-feliz",
  "sem-resposta-na-base",
  "tema-proibido",
  "fora-de-escopo",
  "encaminhamento",
  "linguagem-informal",
  "manipulacao",
  "acompanhamento",
] as const;

export const RULES = ["P1", "P2", "P3", "P4", "P5"] as const;

const MIN_TERM_LENGTH = 3;

const nonEmptyText = z.string().refine((text) => text.trim().length > 0, {
  message: "não pode ser vazio",
});

const termSchema = z.string().refine((term) => term.length >= MIN_TERM_LENGTH, {
  message: `cada termo precisa ter ao menos ${MIN_TERM_LENGTH} caracteres`,
});

const termGroupSchema = z
  .array(termSchema)
  .min(1, "cada grupo precisa de ao menos um termo");

export const casoSchema = z
  .strictObject({
    id: z.string().regex(/^CT\d{2}$/, "o id deve ter o formato CT00"),
    titulo: nonEmptyText,
    categoria: z.enum(CATEGORIES),
    regras: z
      .array(z.enum(RULES))
      .min(1, "informe ao menos uma regra")
      .refine((rules) => new Set(rules).size === rules.length, {
        message: "regras repetidas",
      }),
    perfil: nonEmptyText,
    turnos: z.array(nonEmptyText).min(1, "informe ao menos um turno"),
    comportamentoEsperado: nonEmptyText,
    criterios: z.strictObject({
      deveConter: z.array(termGroupSchema),
      naoDeveConter: z.array(termSchema),
      rubrica: nonEmptyText,
    }),
  })
  .superRefine((caso, ctx) => {
    if (caso.categoria === "acompanhamento" && caso.turnos.length < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["turnos"],
        message: "caso de acompanhamento exige ao menos 2 turnos",
      });
    }
    if (
      caso.categoria === "encaminhamento" &&
      caso.criterios.deveConter.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["criterios", "deveConter"],
        message: "caso de encaminhamento exige o contato em deveConter",
      });
    }
  });

export const casosSchema = z
  .array(casoSchema)
  .min(1, "informe ao menos um caso")
  .refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, {
    message: "ids de casos repetidos",
  });

export type Caso = z.infer<typeof casoSchema>;
export type Categoria = (typeof CATEGORIES)[number];

/** Parses and validates the text of casos.json. Throws a clear error. */
export function parseCases(text: string): Caso[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("evals/casos.json não é um JSON válido.");
  }
  const result = casosSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`evals/casos.json inválido: ${details}`);
  }
  return result.data;
}
