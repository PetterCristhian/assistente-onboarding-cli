// RELATORIO.md (ENG-57, part 2): the summary of the battery and the transcript
// of every execution, as Markdown. Pure and deterministic: LF line breaks, no
// clock (the date is the `inicio` of the summary), no disk. It is written once,
// at the end of the battery, and never regenerated (architecture rule 7).
//
// What a model wrote (questions, drafts, answers, reasons, notices, the
// justification of the judge, the name of the model) enters only inside a
// fenced block or as escaped inline text (evals/markdown.ts). The cells of the
// tables carry only our own data (ids, numbers, the title of the case), with
// the pipe escaped.
import type { BatterySummary } from "./aggregate.js";
import { inlineText, tableCell, untrustedBlock } from "./markdown.js";
import type {
  ErrorSummaryLine,
  ExecutionLine,
  OpinionLine,
  TurnLine,
} from "./record.js";

const HASH_PREFIX = "sha256:";
const SHORT_HASH_LENGTH = 12;

/** "91,7%": from the integers, so that the text never depends on a float. */
export function formatPercent(numerator: number, denominator: number): string {
  const percent = denominator === 0 ? 0 : (numerator / denominator) * 100;
  return `${percent.toFixed(1).replace(".", ",")}%`;
}

/** "11/12 casos com todas as execuções aprovadas (91,7%)". */
export function describeGeneralConsistency(summary: BatterySummary): string {
  const { casosTodasAprovadas, casos } = summary.taxaConsistenciaGeral;
  return `${casosTodasAprovadas}/${casos} casos com todas as execuções aprovadas (${formatPercent(casosTodasAprovadas, casos)})`;
}

/** F13 met, measured but not met, or why it was not validated. */
export function describeF13(summary: BatterySummary): string {
  if (summary.f13Atingido) {
    return "F13: atingido (todas as execuções aprovadas)";
  }
  if (summary.f13Mensuravel) {
    const { casosTodasAprovadas, casos } = summary.taxaConsistenciaGeral;
    return `F13: medido, meta não atingida (${casosTodasAprovadas}/${casos} casos com todas as execuções aprovadas)`;
  }
  return summary.parcial
    ? "F13: não validado (parcial)"
    : "F13: não validado (incompleta)";
}

/** What the terminal shows at the end: n/N per case, the general rate, F13. */
export function describeConsistencyLines(summary: BatterySummary): string[] {
  return [
    "Consistência por caso:",
    ...summary.porCaso.map(
      (caso) => `  ${caso.id}  ${caso.consistencia}  ${caso.titulo}`,
    ),
    `Consistência geral: ${describeGeneralConsistency(summary)}`,
    describeF13(summary),
  ];
}

function shortHash(hash: string): string {
  return hash.slice(0, HASH_PREFIX.length + SHORT_HASH_LENGTH);
}

function modelList(models: readonly string[]): string {
  return models.length === 0
    ? "nenhum"
    : models.map((model) => inlineText(model)).join(", ");
}

function header(summary: BatterySummary): string[] {
  const lines = [`# Relatório da bateria ${inlineText(summary.bateria)}`, ""];
  if (summary.totais.ausentes > 0) {
    lines.push(
      `**INCOMPLETA: ${summary.execucoesGravadas} de ${summary.execucoesEsperadas}**`,
      "",
    );
  }
  lines.push(
    `- Data: ${inlineText(summary.inicio)}`,
    `- Chatbot: ${modelList(summary.modeloChatbot)}`,
    `- Juiz: ${modelList(summary.modeloJuiz)} (mesmo modelo: ${summary.juizMesmoModelo ? "sim" : "não"})`,
  );
  if (summary.juizMesmoModelo) {
    lines.push(
      "- Aviso: o juiz é o mesmo modelo do chatbot; a avaliação pode herdar o viés do modelo avaliado. É uma limitação desta bateria.",
    );
  }
  lines.push(
    `- Contexto (context/): ${inlineText(shortHash(summary.hashContexto))} (completo em resumo.json)`,
    `- Casos (casos.json): ${inlineText(shortHash(summary.hashCasos))} (completo em resumo.json)`,
    `- Execuções: ${summary.execucoesGravadas} de ${summary.execucoesEsperadas}`,
    `- ${describeF13(summary)}`,
    "",
  );
  return lines;
}

function caseTable(summary: BatterySummary): string[] {
  return [
    "## Consistência por caso",
    "",
    "| Caso | Título | Consistência | passou | falhou | erro | ausentes |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...summary.porCaso.map(
      (caso) =>
        `| ${tableCell(caso.id)} | ${tableCell(caso.titulo)} | ${tableCell(caso.consistencia)} | ${caso.passou} | ${caso.falhou} | ${caso.erro} | ${caso.ausentes} |`,
    ),
    "",
  ];
}

function ruleTable(summary: BatterySummary): string[] {
  return [
    "## Consistência por regra",
    "",
    "| Regra | Casos | Esperadas | passou | falhou | erro | ausentes | Taxa |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.porRegra.map(
      (rule) =>
        `| ${tableCell(rule.regra)} | ${rule.casos} | ${rule.esperadas} | ${rule.passou} | ${rule.falhou} | ${rule.erro} | ${rule.ausentes} | ${formatPercent(rule.passou, rule.esperadas)} |`,
    ),
    "",
  ];
}

function summarySection(summary: BatterySummary): string[] {
  const { autoavaliacao, juiz, taxaExecucoesAprovadas } = summary;
  const { origemFinal } = autoavaliacao;
  const violations = Object.entries(autoavaliacao.violacoesPorRegra)
    .map(([rule, total]) => `${inlineText(rule)} ${total}`)
    .join(", ");
  return [
    "## Resumo",
    "",
    `- Consistência geral: ${describeGeneralConsistency(summary)}`,
    `- Execuções aprovadas: ${taxaExecucoesAprovadas.passou}/${taxaExecucoesAprovadas.esperadas} (${formatPercent(taxaExecucoesAprovadas.passou, taxaExecucoesAprovadas.esperadas)})`,
    `- Rascunhos reprovados pela autoavaliação: ${autoavaliacao.rascunhosReprovados} de ${autoavaliacao.turnosRespondidos} turnos respondidos`,
    `- Revisões reprovadas: ${autoavaliacao.revisoesReprovadas}`,
    `- Origem da resposta final: rascunho ${origemFinal.rascunho}, revisão ${origemFinal.revisao}, mensagem segura ${origemFinal.fallback}`,
    `- Violações apontadas pela autoavaliação: ${violations}`,
    `- Juiz: aprovou ${juiz.aprovou}, reprovou ${juiz.reprovou}, erro ${juiz.erro}, não executado ${juiz.naoExecutado}`,
    `- Novas tentativas (chatbot e juiz): ${summary.novasTentativas}`,
    "",
  ];
}

function describeError(summary: ErrorSummaryLine): string {
  const parts = [
    summary.status === undefined ? undefined : `status ${summary.status}`,
    summary.codigo === undefined ? undefined : `código ${summary.codigo}`,
    summary.tipo === undefined ? undefined : `tipo ${summary.tipo}`,
    summary.mensagem,
  ].filter((part): part is string => part !== undefined);
  return inlineText(parts.join(" | "));
}

function describeOpinion(opinion: OpinionLine): string {
  if (opinion.situacao === "erro") {
    return `indisponível (${describeError(opinion.resumo)})`;
  }
  if (opinion.aprovada) {
    return "aprovada";
  }
  const reasons = opinion.violacoes
    .map((violation) => `${violation.regra}: ${inlineText(violation.motivo)}`)
    .join("; ");
  return reasons === "" ? "reprovada" : `reprovada (${reasons})`;
}

function isRejectedOrFailed(opinion: OpinionLine): boolean {
  return opinion.situacao === "erro" || !opinion.aprovada;
}

function turnSection(turn: TurnLine, index: number, total: number): string[] {
  const position = `Turno ${index + 1} de ${total}`;
  const question = ["Pergunta:", "", untrustedBlock(turn.pergunta), ""];
  const notices =
    turn.avisos.length === 0
      ? []
      : [
          "Avisos:",
          "",
          ...turn.avisos.map(
            (notice) =>
              `- ${inlineText(notice.nivel)}: ${inlineText(notice.texto)}`,
          ),
          "",
        ];
  if (turn.situacao === "erro") {
    return [
      `#### ${position} (falhou)`,
      "",
      ...question,
      `Erro: ${describeError(turn.erro)}`,
      "",
      ...notices,
    ];
  }
  if (turn.situacao === "cancelado") {
    return [`#### ${position} (cancelado)`, "", ...question, ...notices];
  }
  const showDraft =
    isRejectedOrFailed(turn.autoavaliacao) ||
    turn.rascunho !== turn.respostaFinal;
  return [
    `#### ${position} (origem: ${inlineText(turn.origemFinal)})`,
    "",
    ...question,
    ...(showDraft
      ? [
          "Rascunho:",
          "",
          untrustedBlock(turn.rascunho),
          "",
          `Autoavaliação do rascunho: ${describeOpinion(turn.autoavaliacao)}`,
          "",
        ]
      : []),
    ...(turn.revisao === undefined
      ? []
      : [
          "Revisão:",
          "",
          untrustedBlock(turn.revisao.texto),
          "",
          turn.revisao.autoavaliacao === undefined
            ? "Autoavaliação da revisão: não feita"
            : `Autoavaliação da revisão: ${describeOpinion(turn.revisao.autoavaliacao)}`,
          "",
        ]),
    "Resposta final:",
    "",
    untrustedBlock(turn.respostaFinal),
    "",
    ...notices,
  ];
}

function checkLine(check: ExecutionLine["veredito"]["checagens"][number]) {
  const separator = check.tipo === "deveConter" ? " ou " : ", ";
  // The check of the origin passes when the origin is NOT the one it names.
  const lead = check.tipo === "origem" ? ": diferente de " : ": ";
  const target =
    check.alvo.length === 0
      ? ""
      : `${lead}${check.alvo.map((term) => inlineText(term)).join(separator)}`;
  return `- [${check.ok ? "x" : " "}] ${inlineText(check.tipo)}${target}`;
}

function judgeLine(line: ExecutionLine): string {
  const { juiz } = line.veredito;
  if (juiz === null) {
    return "- Juiz: não executado";
  }
  if (juiz.situacao === "erro") {
    return `- Juiz: erro (${describeError(juiz.resumo)})`;
  }
  return `- Juiz: ${juiz.passou ? "aprovou" : "reprovou"} (modelo ${inlineText(juiz.modelo)}). Justificativa: ${inlineText(juiz.justificativa)}`;
}

function executionSection(line: ExecutionLine, title: string): string[] {
  const { veredito } = line;
  return [
    `### ${tableCell(line.casoId)} · execução ${line.execucao} · ${inlineText(veredito.resultado)}`,
    "",
    `- Caso: ${inlineText(title)}`,
    `- Data: ${inlineText(line.dataHora)}`,
    `- Modelo: ${line.modelo === null ? "nenhum" : inlineText(line.modelo)}`,
    `- Veredito: ${inlineText(veredito.resultado)}`,
    ...(veredito.motivo === undefined
      ? []
      : [`- Motivo: ${inlineText(veredito.motivo)}`]),
    judgeLine(line),
    "",
    ...(veredito.checagens.length === 0
      ? ["Checagens: nenhuma", ""]
      : ["Checagens:", "", ...veredito.checagens.map(checkLine), ""]),
    ...line.turnos.flatMap((turn, index) =>
      turnSection(turn, index, line.turnos.length),
    ),
  ];
}

function transcript(
  summary: BatterySummary,
  lines: readonly ExecutionLine[],
): string[] {
  const byKey = new Map(
    lines.map((line): [string, ExecutionLine] => [
      `${line.casoId}/${line.execucao}`,
      line,
    ]),
  );
  const sections = summary.porCaso.flatMap((caso) =>
    Array.from({ length: summary.execucoesPorCaso }, (_, index) => {
      const run = index + 1;
      const line = byKey.get(`${caso.id}/${run}`);
      return line === undefined
        ? [`### ${tableCell(caso.id)} · execução ${run} · sem execução`, ""]
        : executionSection(line, caso.titulo);
    }).flat(),
  );
  return ["## Transcrição das execuções", "", ...sections];
}

/** The whole report. `lines` are the lines that the summary was made from. */
export function renderReport(
  summary: BatterySummary,
  lines: readonly ExecutionLine[],
): string {
  const text = [
    ...header(summary),
    ...caseTable(summary),
    ...ruleTable(summary),
    ...summarySection(summary),
    ...transcript(summary, lines),
  ].join("\n");
  return `${text.trimEnd()}\n`;
}
