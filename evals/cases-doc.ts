// Renders docs/CASOS-DE-TESTE.md from the cases (ENG-57, part 3; F11). Pure and
// deterministic: the same cases give the same text, with no date, no disk and
// LF line breaks. Everything that comes from the JSON is data, never layout:
// it goes through the sanitizers of evals/markdown.ts, so that a title or a
// term cannot open a heading, a table or a link. No domain word is written here.
import { inlineText } from "./markdown.js";
import { CATEGORIES, type Caso } from "./schema.js";

export const CASES_DOC_FILE = "docs/CASOS-DE-TESTE.md";

/** The text of the document is not cut: it is the catalog itself. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

function text(value: string): string {
  return inlineText(value, NO_LIMIT);
}

function renderCoverage(cases: readonly Caso[]): string[] {
  const rows = CATEGORIES.map((category) => {
    const ids = cases
      .filter((caso) => caso.categoria === category)
      .map((caso) => text(caso.id));
    return `| ${category} | ${ids.length} | ${ids.length === 0 ? "-" : ids.join(", ")} |`;
  });
  return [
    "## Cobertura por categoria",
    "",
    "| Categoria | Casos | Identificadores |",
    "|---|---|---|",
    ...rows,
    `| **Total** | **${cases.length}** | |`,
  ];
}

function renderIndex(cases: readonly Caso[]): string[] {
  return [
    "## Índice",
    "",
    ...cases.map(
      (caso) =>
        `- ${text(caso.id)}: ${text(caso.titulo)} (${text(caso.categoria)})`,
    ),
  ];
}

function renderCriteria(caso: Caso): string[] {
  const { deveConter, naoDeveConter, rubrica } = caso.criterios;
  const required =
    deveConter.length === 0
      ? ["- Deve conter: nenhum termo obrigatório."]
      : [
          "- Deve conter, de cada grupo, pelo menos um de:",
          ...deveConter.map(
            (group, index) =>
              `  - Grupo ${index + 1}: ${group.map(text).join(" ou ")}`,
          ),
        ];
  const forbidden =
    naoDeveConter.length === 0
      ? ["- Não deve conter: nenhum termo proibido."]
      : [
          "- Não deve conter nenhum de:",
          ...naoDeveConter.map((term) => `  - ${text(term)}`),
        ];
  return [
    "Checagens determinísticas (sem diferenciar maiúsculas e acentos):",
    "",
    ...required,
    ...forbidden,
    "- Em todos os casos: a resposta final não pode conter emoji.",
    "",
    "Rubrica do juiz:",
    "",
    `> ${text(rubrica)}`,
  ];
}

function renderCase(caso: Caso): string[] {
  return [
    `## ${text(caso.id)}: ${text(caso.titulo)}`,
    "",
    `- Categoria: ${text(caso.categoria)}`,
    `- Regras exercitadas: ${caso.regras.map(text).join(", ")}`,
    `- Perfil: ${text(caso.perfil)}`,
    "",
    caso.turnos.length === 1 ? "Pergunta:" : "Perguntas, uma por turno:",
    "",
    ...caso.turnos.map((turn, index) => `${index + 1}. ${text(turn)}`),
    "",
    "Comportamento esperado:",
    "",
    `> ${text(caso.comportamentoEsperado)}`,
    "",
    "Critério de aprovação: todas as checagens determinísticas e o juiz; a resposta final não pode ser a mensagem segura (fallback); o veredito é avaliado sobre o texto final do último turno.",
    "",
    ...renderCriteria(caso),
  ];
}

/** The whole document, ending with one line break. */
export function renderCasesDoc(cases: readonly Caso[]): string {
  const lines = [
    "# Casos de teste",
    "",
    "Gerado por `npm run casos:doc` a partir de `evals/casos.json`; não edite à mão.",
    "",
    ...renderCoverage(cases),
    "",
    ...renderIndex(cases),
    ...cases.flatMap((caso) => ["", ...renderCase(caso)]),
  ];
  return `${lines.join("\n")}\n`;
}
