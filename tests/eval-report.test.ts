// The report: fabricated executions in, Markdown out. No model, no clock. The
// text of a model is hostile on purpose, and the report must neutralize it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateBattery, type BatterySummary } from "../evals/aggregate.js";
import { TRUNCATION_NOTE } from "../evals/markdown.js";
import { parseExecutionLine, type ExecutionLine } from "../evals/record.js";
import {
  describeF13,
  describeGeneralConsistency,
  formatPercent,
  renderReport,
} from "../evals/report.js";
import type { Caso } from "../evals/schema.js";
import { createRedactor } from "../src/security/redact.js";
import { createSafeWriter } from "../src/security/safe-writer.js";
import {
  BATTERY,
  HASH_CASES,
  HASH_CONTEXT,
  answeredTurn,
  failedTurn,
  fullBattery,
  makeCase,
  makeLine,
  rejected,
} from "./helpers/eval-lines.js";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const cp = String.fromCodePoint;
const CT01 = makeCase("CT01", { titulo: "Primeiro caso" });
const CT02 = makeCase("CT02", { titulo: "Segundo caso", regras: ["P1", "P3"] });

function summarize(
  lines: readonly ExecutionLine[],
  cases: readonly Caso[] = [CT01, CT02],
  runs = 3,
  catalogSize = cases.length,
): BatterySummary {
  return aggregateBattery({
    lines,
    plan: { runs, casos: cases },
    batteryId: BATTERY,
    catalogSize,
  });
}

function report(
  lines: readonly ExecutionLine[],
  cases: readonly Caso[] = [CT01, CT02],
  runs = 3,
  catalogSize = cases.length,
): string {
  return renderReport(summarize(lines, cases, runs, catalogSize), lines);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the text of the report", () => {
  const lines = [
    ...fullBattery([CT01, CT02], 2),
    makeLine({
      casoId: "CT01",
      execucao: 3,
      resultado: "falhou",
      motivo: "um motivo",
      turnos: [
        answeredTurn({
          question: "Qual é a política?",
          draft: "rascunho ruim",
          final: "mensagem segura",
          evaluation: rejected("P2"),
          revision: { text: "revisão ruim", evaluation: rejected("P3") },
          origin: "fallback",
          retries: 1,
        }),
      ],
    }),
    makeLine({ casoId: "CT02", execucao: 3, resultado: "erro" }),
  ];
  const text = report(lines);

  it("has the title, the date, the models, the hashes and the executions", () => {
    expect(text.startsWith(`# Relatório da bateria ${BATTERY}\n`)).toBe(true);
    expect(text).toContain("- Data: 2026-11-20T14:31:07.412Z");
    expect(text).toContain("- Chatbot: modelo-chat");
    expect(text).toContain("- Juiz: modelo-juiz (mesmo modelo: não)");
    expect(text).not.toContain("viés");
    expect(text).toContain(
      `- Contexto (context/): ${HASH_CONTEXT.slice(0, 19)} (completo em resumo.json)`,
    );
    expect(text).toContain(`- Casos (casos.json): ${HASH_CASES.slice(0, 19)}`);
    expect(text).not.toContain(HASH_CONTEXT);
    expect(text).toContain("- Execuções: 6 de 6");
    expect(text).toContain(
      "- F13: medido, meta não atingida (0/2 casos com todas as execuções aprovadas)",
    );
    expect(text).not.toContain("INCOMPLETA");
  });

  it("has the table per case and the table per rule", () => {
    expect(text).toContain("## Consistência por caso");
    expect(text).toContain(
      "| Caso | Título | Consistência | passou | falhou | erro | ausentes |",
    );
    expect(text).toContain("| CT01 | Primeiro caso | 2/3 | 2 | 1 | 0 | 0 |");
    expect(text).toContain("| CT02 | Segundo caso | 2/3 | 2 | 0 | 1 | 0 |");
    expect(text).toContain("## Consistência por regra");
    expect(text).toContain("| P1 | 1 | 3 | 2 | 0 | 1 | 0 | 66,7% |");
    expect(text).toContain("| P3 | 2 | 6 | 4 | 1 | 1 | 0 | 66,7% |");
  });

  it("has the summary", () => {
    expect(text).toContain("## Resumo");
    expect(text).toContain(
      "- Consistência geral: 0/2 casos com todas as execuções aprovadas (0,0%)",
    );
    expect(text).toContain("- Execuções aprovadas: 4/6 (66,7%)");
    expect(text).toContain(
      "- Rascunhos reprovados pela autoavaliação: 1 de 5 turnos respondidos",
    );
    expect(text).toContain("- Revisões reprovadas: 1");
    expect(text).toContain(
      "- Origem da resposta final: rascunho 4, revisão 0, mensagem segura 1",
    );
    expect(text).toContain(
      "- Juiz: aprovou 4, reprovou 1, erro 0, não executado 1",
    );
    expect(text).toContain("- Novas tentativas (chatbot e juiz): 1");
  });

  it("has a transcript section for every execution", () => {
    expect(text).toContain("## Transcrição das execuções");
    for (const caso of ["CT01", "CT02"]) {
      for (const run of [1, 2, 3]) {
        expect(text).toMatch(
          new RegExp(`^### ${caso} · execução ${run} · \\w+$`, "m"),
        );
      }
    }
    expect(text).toContain("### CT01 · execução 3 · falhou");
    expect(text).toContain("### CT02 · execução 3 · erro");
    expect(text).toContain("- Motivo: um motivo");
    expect(text).toContain("- [x] semEmoji");
    expect(text).toContain("- [x] deveConter: alfa ou beta");
    expect(text).toContain("- Juiz: aprovou (modelo modelo-juiz)");
    expect(text).toContain("Justificativa: cumpre a rubrica");
    expect(text).toContain("- Juiz: não executado");
    expect(text).toContain("#### Turno 1 de 1 (falhou)");
  });

  it("shows the draft and the self-evaluation only when they matter", () => {
    const [, afterFailed] = text.split("### CT01 · execução 3 · falhou");
    const failedSection = (afterFailed ?? "").split(/^### /m)[0] ?? "";
    expect(failedSection).toContain("#### Turno 1 de 1 (origem: fallback)");
    expect(failedSection).toContain("rascunho ruim");
    expect(failedSection).toContain("revisão ruim");
    expect(failedSection).toContain(
      "Autoavaliação do rascunho: reprovada (P2: motivo P2)",
    );
    expect(failedSection).toContain(
      "Autoavaliação da revisão: reprovada (P3: motivo P3)",
    );
    expect(failedSection).toContain("mensagem segura");

    const [, afterFirst] = text.split("### CT01 · execução 1 · passou");
    const passedSection = (afterFirst ?? "").split(/^### /m)[0] ?? "";
    expect(passedSection).not.toContain("Rascunho:");
    expect(passedSection).not.toContain("Autoavaliação");
    expect(passedSection).toContain("Pergunta:");
    expect(passedSection).toContain("Resposta final:");
  });

  it("shows the draft when it differs from the final answer even if approved", () => {
    const differing = report(
      [
        makeLine({
          casoId: "CT01",
          execucao: 1,
          resultado: "passou",
          turnos: [answeredTurn({ draft: "um", final: "dois" })],
        }),
      ],
      [CT01],
      1,
    );
    expect(differing).toContain("Rascunho:");
    expect(differing).toContain("Autoavaliação do rascunho: aprovada");
  });

  it("lists a missing execution as sem execução", () => {
    const interrupted = report(
      [makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" })],
      [CT01, CT02],
      2,
    );

    expect(interrupted).toContain("**INCOMPLETA: 1 de 4**");
    expect(interrupted).toContain("- Execuções: 1 de 4");
    expect(interrupted).toContain("- F13: não validado (parcial)");
    expect(interrupted).toContain("### CT01 · execução 2 · sem execução");
    expect(interrupted).toContain("### CT02 · execução 1 · sem execução");
    expect(interrupted).toContain(
      "| CT02 | Segundo caso | 0/2 | 0 | 0 | 0 | 2 |",
    );
  });

  it("says incompleta, not parcial, when a full battery was interrupted", () => {
    const interrupted = report(
      [makeLine({ casoId: "CT01", execucao: 1, resultado: "passou" })],
      [CT01, CT02],
      3,
    );

    expect(interrupted).toContain("INCOMPLETA: 1 de 6");
    expect(interrupted).toContain("- F13: não validado (incompleta)");
  });

  it("marks a partial battery that finished", () => {
    const partial = report(fullBattery([CT01], 3), [CT01], 3, 12);

    expect(partial).toContain("- F13: não validado (parcial)");
    expect(partial).not.toContain("INCOMPLETA");
  });

  it("warns about the bias when the judge is the chatbot's model", () => {
    const same = report(
      [
        makeLine({
          casoId: "CT01",
          execucao: 1,
          resultado: "passou",
          modelo: "m",
          judgeModel: "m",
        }),
      ],
      [CT01],
      1,
    );

    expect(same).toContain("(mesmo modelo: sim)");
    expect(same).toContain("viés");
  });

  it("says that the judge erred and that the turn failed", () => {
    const erred = report(
      [
        makeLine({
          casoId: "CT01",
          execucao: 1,
          resultado: "erro",
          judgeError: true,
        }),
        makeLine({
          casoId: "CT01",
          execucao: 2,
          resultado: "erro",
          turnos: [failedTurn(2)],
        }),
      ],
      [CT01],
      2,
    );

    expect(erred).toContain("- Juiz: erro (juiz fora do ar)");
    expect(erred).toContain("- Motivo: juiz indisponível");
    expect(erred).toContain("Erro: status 500 \\| falha do provedor");
    expect(erred).toContain("Checagens: nenhuma");
  });

  it("ends with one line break, uses only LF and is the same every time", () => {
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    expect(report(lines)).toBe(text);
  });
});

describe("formatPercent and the descriptions", () => {
  it("writes the percentage with a comma and one decimal", () => {
    expect(formatPercent(11, 12)).toBe("91,7%");
    expect(formatPercent(1, 1)).toBe("100,0%");
    expect(formatPercent(0, 5)).toBe("0,0%");
    expect(formatPercent(0, 0)).toBe("0,0%");
  });

  it("describes the general consistency and F13", () => {
    const summary = summarize(fullBattery([CT01, CT02], 3));
    expect(describeGeneralConsistency(summary)).toBe(
      "2/2 casos com todas as execuções aprovadas (100,0%)",
    );
    expect(describeF13(summary)).toBe(
      "F13: atingido (todas as execuções aprovadas)",
    );
  });

  it("says measured, goal not met, when a measurable battery has failures", () => {
    const summary = summarize(fullBattery([CT01, CT02], 3, "falhou"));
    expect(describeF13(summary)).toBe(
      "F13: medido, meta não atingida (0/2 casos com todas as execuções aprovadas)",
    );
  });
});

/** The lines of the report that are outside of every fenced block. */
function outsideFences(markdown: string): string[] {
  const outside: string[] = [];
  let open = 0;
  for (const line of markdown.split("\n")) {
    if (open === 0) {
      const fence = /^(`{4,})$/.exec(line);
      if (fence !== null) {
        open = fence[1]?.length ?? 0;
      } else {
        outside.push(line);
      }
    } else if (new RegExp(`^\`{${open},}$`).test(line)) {
      open = 0;
    }
  }
  expect(open).toBe(0);
  return outside;
}

const ALLOWED_HEADING =
  /^(# Relatório da bateria \S+|## (Consistência por caso|Consistência por regra|Resumo|Transcrição das execuções)|### CT\d\d · execução \d+ · \w+( \w+)?|#### Turno \d+ de \d+ \((origem: \w+|falhou|cancelado)\))$/;

describe("hostile text from a model", () => {
  const hostile = [
    "```\n# título falso\n```",
    "`````\n## outro\n`````",
    "# título",
    "[link](http://x)",
    "<script>alert(1)</script>",
    "| a | b |\n|---|---|\n| c | d |",
    `texto ${cp(0x202e)}invertido`,
    "ESC \u001b[31mvermelho\u001b[0m",
    `tag ${cp(0xe0041)}${cp(0xe0042)} chars`,
    `zero${cp(0x200b)}width e soft${cp(0x00ad)}hyphen`,
    "![img](http://x/a.png)",
    "http://exemplo.example e www.exemplo.example",
    "- item de lista\n1. outro\n> citação\n---\n===",
    "~~~\nnão fecha\n~~~",
  ];

  function hostileLines(sample: string): ExecutionLine[] {
    const base = answeredTurn({
      question: sample,
      draft: sample,
      final: sample,
      evaluation: {
        situacao: "ok",
        aprovada: false,
        violacoes: [{ regra: "P2", motivo: sample }],
      },
      revision: { text: sample, evaluation: rejected("P3") },
      origin: "revisao",
      model: sample,
    });
    return [
      makeLine({
        casoId: "CT01",
        execucao: 1,
        resultado: "falhou",
        modelo: sample,
        judgeModel: sample,
        judgeReason: sample,
        motivo: sample,
        checks: [
          { tipo: "deveConter", alvo: [sample, "x"], ok: false },
          { tipo: "naoDeveConter", alvo: [sample], ok: true },
          { tipo: "semEmoji", alvo: [], ok: true },
        ],
        turnos: [
          { ...base, avisos: [{ nivel: "warning", texto: sample }] },
          failedTurn(),
        ],
      }),
    ];
  }

  it("never closes a fence, nor opens a heading, a link, a table or HTML", () => {
    for (const sample of hostile) {
      const markdown = report(hostileLines(sample), [CT01], 1);
      const outside = outsideFences(markdown);

      const headings = outside.filter((line) => line.startsWith("#"));
      expect(headings.filter((line) => !ALLOWED_HEADING.test(line))).toEqual(
        [],
      );
      const joined = outside.join("\n");
      expect(joined).not.toMatch(/(?<!\\)</);
      expect(joined).not.toMatch(/(?<!\\)\]\(/);
      expect(joined).not.toMatch(/(?<!\\)!\[/);
      expect(joined).not.toMatch(/:\/\//);
      expect(joined).not.toMatch(/www\./i);
      // Only our own tables have a row that starts with a pipe.
      const rows = outside.filter((line) => line.startsWith("|"));
      expect(
        rows.every((row) => /^\| (CT\d\d|P\d|Caso|Regra|---) /.test(row)),
      ).toBe(true);
      expect(
        outside.filter(
          (line) => /(?<!\\)\|/.test(line) && !line.startsWith("|"),
        ),
      ).toEqual([]);
      // Nothing outside the fences starts a quote, a rule or a list of the model.
      expect(
        outside.filter((line) => /^(>|---|===|1\.|\* )/.test(line)),
      ).toEqual([]);
      expect(markdown.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(markdown).not.toMatch(/[\u{e0000}-\u{e007f}]/u);
    }
  });

  it("shows the invisible characters instead of writing them", () => {
    const markdown = report(hostileLines(hostile[6] ?? ""), [CT01], 1);

    expect(markdown).toContain("⟦U+202E⟧");
    expect(markdown).not.toContain(cp(0x202e));
    const escaped = report(hostileLines(hostile[7] ?? ""), [CT01], 1);
    expect(escaped).toContain("⟦U+001B⟧");
    expect(escaped).not.toContain("\u001b");
    const tags = report(hostileLines(hostile[8] ?? ""), [CT01], 1);
    expect(tags).toContain("⟦U+E0041⟧");
  });

  it("keeps a hostile case title out of the table structure", () => {
    const evil = makeCase("CT01", { titulo: "a | b\n# c [d](http://x)" });
    const markdown = report(fullBattery([evil], 1), [evil], 1);
    const row = markdown.split("\n").find((line) => line.startsWith("| CT01 "));

    expect(row).toBe(
      "| CT01 | a \\| b \\# c \\[d\\]\\(http:\\//x\\) | 1/1 | 1 | 0 | 0 | 0 |",
    );
  });
});

describe("a long text", () => {
  it("is cut in the transcript, with a note that points to execucoes.jsonl", () => {
    const long = "x".repeat(9000);
    const markdown = report(
      [
        makeLine({
          casoId: "CT01",
          execucao: 1,
          resultado: "passou",
          turnos: [answeredTurn({ final: long, question: long })],
        }),
      ],
      [CT01],
      1,
    );

    expect(markdown).toContain(TRUNCATION_NOTE);
    expect(markdown.match(/x{4000}\n/g)).toHaveLength(2);
    expect(markdown).not.toContain("x".repeat(4001));
  });

  it("does not cut a short text", () => {
    expect(report(fullBattery([CT01], 1), [CT01], 1)).not.toContain(
      TRUNCATION_NOTE,
    );
  });
});

describe("round trip", () => {
  it("renders the same text from lines kept in memory and lines read back from the jsonl", () => {
    const lines = [
      ...fullBattery([CT01, CT02], 2),
      makeLine({
        casoId: "CT01",
        execucao: 3,
        resultado: "falhou",
        judgeReason: `com ${cp(0x202e)} e "aspas" e \n quebra`,
        turnos: [
          answeredTurn({
            question: "ç é ``` ão\n# x",
            final: `${cp(0x1f600)} \u001b ${cp(0xe0041)}`,
            evaluation: rejected("P1"),
            revision: { text: "r", evaluation: rejected("P4") },
            origin: "fallback",
          }),
        ],
      }),
    ];
    const jsonl = lines.map((line) => JSON.stringify(line)).join("\n");
    const reread = jsonl
      .split("\n")
      .map((raw) => parseExecutionLine(JSON.parse(raw)));

    expect(reread).toEqual(lines);
    expect(report(reread)).toBe(report(lines));
    expect(renderReport(summarize(reread), reread)).toBe(report(lines));
  });
});

describe("a key in any field", () => {
  it("is not in the file that the safe writer writes", async () => {
    const key = fakeOpenAiKey();
    const lines = [
      makeLine({
        casoId: "CT01",
        execucao: 1,
        resultado: "falhou",
        modelo: `m-${key}`,
        judgeReason: `justificativa ${key}`,
        motivo: `motivo ${key}`,
        checks: [{ tipo: "deveConter", alvo: [key], ok: false }],
        turnos: [
          answeredTurn({
            question: `pergunta ${key}`,
            draft: `rascunho ${key}`,
            final: `final ${key}`,
            evaluation: rejected("P2"),
            revision: { text: `revisão ${key}`, evaluation: rejected("P3") },
            origin: "revisao",
          }),
        ],
      }),
    ];
    const markdown = report(lines, [CT01], 1);
    expect(markdown).toContain(key);

    const root = mkdtempSync(join(tmpdir(), "made-up-report-"));
    roots.push(root);
    const writer = createSafeWriter({
      redact: createRedactor([key]),
      rootDir: root,
    });
    await writer.writeText(`outputs/${BATTERY}/RELATORIO.md`, markdown);
    const written = readFileSync(
      join(root, "outputs", BATTERY, "RELATORIO.md"),
      "utf8",
    );

    expect(written).not.toContain(key);
    expect(written).toContain("[REDACTED]");
  });
});
