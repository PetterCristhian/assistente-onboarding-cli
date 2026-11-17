// Fabricated cases and execution lines for the tests of the aggregator and of
// the report: valid by the real line schema, with only what a test varies.
import {
  execucaoSchema,
  type ExecutionLine,
  type OpinionLine,
  type TurnLine,
} from "../../evals/record.js";
import type { Caso } from "../../evals/schema.js";

export const HASH_CONTEXT = `sha256:${"1234567890ab".repeat(5)}1234`;
export const HASH_CASES = `sha256:${"abcdef012345".repeat(5)}abcd`;
export const BATTERY = "2026-11-20T14-30-00Z";

export function makeCase(id: string, overrides: Partial<Caso> = {}): Caso {
  return {
    id,
    titulo: `Caso ${id}`,
    categoria: "caminho-feliz",
    regras: ["P3"],
    perfil: "dora-teixeira",
    turnos: [`Pergunta de ${id}?`],
    comportamentoEsperado: "Algo.",
    criterios: { deveConter: [["alfa"]], naoDeveConter: [], rubrica: "R." },
    ...overrides,
  };
}

const APPROVED: OpinionLine = {
  situacao: "ok",
  aprovada: true,
  violacoes: [],
};

export function rejected(...rules: ("P1" | "P2" | "P3" | "P4" | "P5")[]) {
  const opinion: OpinionLine = {
    situacao: "ok",
    aprovada: false,
    violacoes: rules.map((regra) => ({ regra, motivo: `motivo ${regra}` })),
  };
  return opinion;
}

export interface AnsweredOptions {
  readonly question?: string;
  readonly draft?: string;
  readonly final?: string;
  readonly origin?: "rascunho" | "revisao" | "fallback";
  readonly evaluation?: OpinionLine;
  readonly revision?: { text: string; evaluation?: OpinionLine };
  readonly model?: string;
  readonly retries?: number;
}

export function answeredTurn(options: AnsweredOptions = {}): TurnLine {
  const final = options.final ?? "Resposta final.";
  return {
    pergunta: options.question ?? "Pergunta?",
    novasTentativas: options.retries ?? 0,
    duracaoMs: 10,
    avisos: [],
    situacao: "respondido",
    rascunho: options.draft ?? final,
    autoavaliacao: options.evaluation ?? APPROVED,
    ...(options.revision === undefined
      ? {}
      : {
          revisao: {
            texto: options.revision.text,
            ...(options.revision.evaluation === undefined
              ? {}
              : { autoavaliacao: options.revision.evaluation }),
          },
        }),
    origemFinal: options.origin ?? "rascunho",
    respostaFinal: final,
    modelo: options.model ?? "modelo-chat",
    chamadas: 2,
  };
}

export function failedTurn(retries = 0): TurnLine {
  return {
    pergunta: "Pergunta?",
    novasTentativas: retries,
    duracaoMs: 10,
    avisos: [],
    situacao: "erro",
    erro: { status: 500, mensagem: "falha do provedor" },
  };
}

export interface LineOptions {
  readonly casoId: string;
  readonly execucao: number;
  readonly resultado: "passou" | "falhou" | "erro";
  readonly turnos?: readonly TurnLine[];
  readonly dataHora?: string;
  readonly bateria?: string;
  readonly hashContexto?: string;
  readonly hashCasos?: string;
  readonly modelo?: string | null;
  readonly judgeModel?: string;
  readonly judgeRetries?: number;
  readonly judgeReason?: string;
  readonly judgeError?: boolean;
  readonly motivo?: string;
  readonly checks?: ExecutionLine["veredito"]["checagens"];
}

/** A line that the real schema accepts, for a `resultado` of the test's choice. */
export function makeLine(options: LineOptions): ExecutionLine {
  const base = {
    esquema: 1 as const,
    bateria: options.bateria ?? BATTERY,
    casoId: options.casoId,
    execucao: options.execucao,
    dataHora: options.dataHora ?? "2026-11-20T14:31:07.412Z",
    modelo: options.modelo === undefined ? "modelo-chat" : options.modelo,
    perfil: "dora-teixeira",
    hashContexto: options.hashContexto ?? HASH_CONTEXT,
    hashCasos: options.hashCasos ?? HASH_CASES,
  };
  const okChecks = options.checks ?? [
    { tipo: "deveConter" as const, alvo: ["alfa", "beta"], ok: true },
    { tipo: "semEmoji" as const, alvo: [], ok: true },
    { tipo: "origem" as const, alvo: ["fallback"], ok: true },
  ];
  const judgeOk = (passou: boolean) => ({
    situacao: "ok" as const,
    passou,
    justificativa: options.judgeReason ?? "cumpre a rubrica",
    modelo: options.judgeModel ?? "modelo-juiz",
    novasTentativas: options.judgeRetries ?? 0,
  });
  if (options.resultado === "erro" && options.judgeError === true) {
    // The judge did not answer and the checks held: the verdict is an erro.
    return execucaoSchema.parse({
      ...base,
      turnos: options.turnos ?? [answeredTurn()],
      veredito: {
        resultado: "erro",
        motivo: options.motivo ?? "juiz indisponível",
        checagens: okChecks,
        juiz: {
          situacao: "erro",
          resumo: { mensagem: "juiz fora do ar" },
          novasTentativas: options.judgeRetries ?? 0,
        },
      },
    });
  }
  if (options.resultado === "erro") {
    return execucaoSchema.parse({
      ...base,
      turnos: options.turnos ?? [failedTurn()],
      veredito: {
        resultado: "erro",
        motivo: options.motivo ?? "turno 1 de 1 falhou",
        checagens: [],
        juiz: null,
      },
    });
  }
  const failed = options.resultado === "falhou";
  return execucaoSchema.parse({
    ...base,
    turnos: options.turnos ?? [answeredTurn()],
    veredito: {
      resultado: options.resultado,
      ...(options.motivo === undefined ? {} : { motivo: options.motivo }),
      checagens: okChecks,
      juiz: judgeOk(!failed),
    },
  });
}

/** Every execution of every case, all with the same `resultado`. */
export function fullBattery(
  cases: readonly Caso[],
  runs: number,
  resultado: "passou" | "falhou" | "erro" = "passou",
): ExecutionLine[] {
  return Array.from({ length: runs }, (_, run) =>
    cases.map((caso) =>
      makeLine({ casoId: caso.id, execucao: run + 1, resultado }),
    ),
  ).flat();
}
