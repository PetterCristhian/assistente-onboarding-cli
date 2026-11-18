// The comparison with and without memory (discipline 2): every case of
// evals/casos-memoria.json runs twice against the real model, once with the
// memory on and once with it off, through the same pipeline as the chat
// (createChatSession inside createStatefulSession). A case is a list of
// sessions; each one is a new chat or the resumption of the one before it.
// The verdict is deterministic: terms that the last answer (or the stored
// memory) must or must not hold. Everything is written by the safe writer,
// under outputs/memoria/<id>/, including the state of each run.
import { z } from "zod";
import { normalizeForMatch } from "../../evals/normalize.js";
import {
  buildEvaluatorContext,
  type CritiqueDeps,
} from "../../src/chat/critique.js";
import { createChatSession, type ChatOutput } from "../../src/chat/session.js";
import { buildContext } from "../../src/context/builder.js";
import {
  loadContext,
  loadCritiquePrompts,
  loadFallbackMessage,
  loadMemoryPrompts,
} from "../../src/context/loaders.js";
import type { LlmClient } from "../../src/llm/client.js";
import {
  activeHistoryOf,
  createStatefulSession,
  newSessionFile,
  type StatefulLimits,
} from "../../src/memory/stateful-session.js";
import { slugify } from "../../src/memory/types.js";
import type { Redactor } from "../../src/security/redact.js";
import type { SafeWriter } from "../../src/security/safe-writer.js";
import { createStateStore } from "../../src/storage/state-store.js";

const termList = z.array(z.string().min(1)).default([]);

const caseSchema = z.strictObject({
  id: z.string().regex(/^M\d{2}$/),
  titulo: z.string().min(1),
  /** True: the last answer can only be right with the memory on. */
  dependeDeMemoria: z.boolean(),
  /** Limits of the compression, when the case needs low ones. */
  limites: z
    .strictObject({
      maxTokens: z.number().int().min(1),
      maxMessages: z.number().int().min(2),
      keepMessages: z.number().int().min(2),
    })
    .optional(),
  sessoes: z
    .array(
      z.strictObject({
        perfil: z.string().min(1),
        /** Resumes the session before it, instead of starting a new one. */
        retomar: z.boolean().default(false),
        turnos: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  esperado: z.strictObject({
    contemTodos: termList,
    contemAlgum: termList,
    naoContem: termList,
    memoriaNaoContem: termList,
    /** True: the history must have been compressed at least once. */
    comprimiu: z.boolean().default(false),
  }),
});
const casesSchema = z.array(caseSchema).min(1);
type MemoryCase = z.infer<typeof caseSchema>;

type Mode = "com-memoria" | "sem-memoria";

interface TurnLine {
  readonly sessao: string;
  readonly perfil: string;
  readonly pergunta: string;
  readonly resposta: string;
  readonly status: string;
  readonly memoriaNoContexto: readonly string[];
  readonly avisos: readonly string[];
}

interface ModeResult {
  readonly passou: boolean;
  readonly falhas: readonly string[];
  readonly comprimiu: boolean;
  readonly itensDeMemoria: readonly string[];
  readonly turnos: readonly TurnLine[];
}

export interface ComparisonDeps {
  readonly casesText: string;
  readonly contextDir: string;
  readonly llm: LlmClient;
  readonly writer: SafeWriter;
  readonly redact: Redactor;
  readonly defaults: StatefulLimits;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly signal?: AbortSignal;
}

interface ProfileContext {
  readonly slug: string;
  readonly instructions: string;
  readonly critique: CritiqueDeps;
}

function has(text: string, term: string): boolean {
  return normalizeForMatch(text).includes(normalizeForMatch(term));
}

function fenced(text: string): string {
  return `~~~~text\n${text.replace(/~~~~/g, "~~~")}\n~~~~`;
}

/** Returns the exit code: 0 only when every case behaved as expected. */
export async function runComparison(deps: ComparisonDeps): Promise<number> {
  const cases = casesSchema.parse(JSON.parse(deps.casesText) as unknown);
  const prompts = loadCritiquePrompts(deps.contextDir);
  const fallbackMessage = loadFallbackMessage(deps.contextDir);
  const memoryPrompts = loadMemoryPrompts(deps.contextDir);
  const startedAt = deps.now();
  const batteryId = `${startedAt.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;
  const folder = `outputs/memoria/${batteryId}`;

  const contexts = new Map<string, ProfileContext>();
  const contextOf = (profile: string): ProfileContext => {
    const known = contexts.get(profile);
    if (known !== undefined) {
      return known;
    }
    const { layers } = loadContext(
      { contextDir: deps.contextDir, profile },
      { now: () => startedAt },
    );
    const built = buildContext(layers);
    const made: ProfileContext = {
      slug: slugify(layers.userProfile.nome),
      instructions: built.text,
      critique: {
        evaluatorContext: buildEvaluatorContext(built.sections),
        evaluatorPrompt: prompts.evaluator,
        revisionPrompt: prompts.revision,
        fallbackMessage,
      },
    };
    contexts.set(profile, made);
    return made;
  };
  // Every profile is loaded before the first call: a wrong one stops here.
  for (const item of cases) {
    for (const session of item.sessoes) {
      contextOf(session.perfil);
    }
  }

  async function runCase(item: MemoryCase, mode: Mode): Promise<ModeResult> {
    const store = createStateStore({
      writer: deps.writer,
      baseDir: `${folder}/estado/${mode}/${item.id.toLowerCase()}`,
    });
    const turns: TurnLine[] = [];
    const failures: string[] = [];
    let compressed = false;
    let lastAnswer = "";
    let previousId: string | undefined;

    for (const [index, spec] of item.sessoes.entries()) {
      const context = contextOf(spec.perfil);
      const sessionId = `${item.id.toLowerCase()}-s${index + 1}`;
      const resumed =
        spec.retomar && previousId !== undefined
          ? store.loadSession(previousId)
          : undefined;
      const file =
        resumed ??
        newSessionFile(sessionId, context.slug, deps.now().toISOString());
      const notices: string[] = [];
      const output: ChatOutput = {
        chunk: () => undefined,
        endAnswer: () => undefined,
        retraction: (text) => notices.push(text),
        notice: (_level, text) => notices.push(text),
      };
      const session = createStatefulSession({
        session: createChatSession({
          llm: deps.llm,
          instructions: context.instructions,
          critique: context.critique,
          output,
          redact: deps.redact,
          now: deps.now,
          initialHistory: activeHistoryOf(file),
        }),
        llm: deps.llm,
        store,
        sessionFile: file,
        memoryEnabled: mode === "com-memoria",
        prompts: memoryPrompts,
        limits: { ...deps.defaults, ...item.limites },
        output,
        redact: deps.redact,
        now: deps.now,
      });
      previousId = file.id;

      for (const question of spec.turnos) {
        const result = await session.ask(
          question,
          deps.signal === undefined ? {} : { signal: deps.signal },
        );
        const answer = result.status === "answered" ? result.text : "";
        if (result.status !== "answered") {
          failures.push(`turno não respondido (${result.status})`);
        }
        lastAnswer = answer;
        turns.push({
          sessao: file.id,
          perfil: spec.perfil,
          pergunta: question,
          resposta: answer,
          status: result.status,
          memoriaNoContexto: session
            .lastSelection()
            .map((entry) => `[${entry.categoria}] ${entry.texto}`),
          avisos: notices.splice(0),
        });
      }
      compressed ||= session.lastCompression() !== undefined;
    }

    const firstProfile = contextOf(item.sessoes[0]?.perfil ?? "").slug;
    const memory =
      mode === "com-memoria"
        ? store
            .loadMemory(firstProfile)
            .itens.map((entry) => `[${entry.categoria}] ${entry.texto}`)
        : [];
    const { esperado } = item;
    for (const term of esperado.contemTodos) {
      if (!has(lastAnswer, term)) {
        failures.push(`a resposta final não contém "${term}"`);
      }
    }
    if (
      esperado.contemAlgum.length > 0 &&
      !esperado.contemAlgum.some((term) => has(lastAnswer, term))
    ) {
      failures.push(
        `a resposta final não contém nenhum de: ${esperado.contemAlgum.join(", ")}`,
      );
    }
    for (const term of esperado.naoContem) {
      if (has(lastAnswer, term)) {
        failures.push(`a resposta final contém "${term}"`);
      }
    }
    for (const term of esperado.memoriaNaoContem) {
      if (memory.some((entry) => has(entry, term))) {
        failures.push(`a memória gravada contém "${term}"`);
      }
    }
    if (esperado.comprimiu && !compressed) {
      failures.push("o histórico não foi comprimido");
    }
    return {
      passou: failures.length === 0,
      falhas: failures,
      comprimiu: compressed,
      itensDeMemoria: memory,
      turnos: turns,
    };
  }

  const results: {
    caso: MemoryCase;
    comMemoria: ModeResult;
    semMemoria: ModeResult;
    conforme: boolean;
    leitura: string;
  }[] = [];
  for (const item of cases) {
    deps.log(`${item.id} ${item.titulo}`);
    const comMemoria = await runCase(item, "com-memoria");
    deps.log(`  com memória: ${comMemoria.passou ? "passou" : "falhou"}`);
    const semMemoria = await runCase(item, "sem-memoria");
    deps.log(`  sem memória: ${semMemoria.passou ? "passou" : "falhou"}`);
    // A case that depends on the memory proves it by failing without it.
    const conforme = item.dependeDeMemoria
      ? comMemoria.passou && !semMemoria.passou
      : comMemoria.passou && semMemoria.passou;
    const leitura = item.dependeDeMemoria
      ? conforme
        ? "a memória fez a diferença"
        : "a memória não fez a diferença esperada"
      : conforme
        ? "correto nos dois modos"
        : "comportamento incorreto";
    results.push({ caso: item, comMemoria, semMemoria, conforme, leitura });
    await deps.writer.appendJsonLine(`${folder}/execucoes.jsonl`, {
      caso: item.id,
      titulo: item.titulo,
      dependeDeMemoria: item.dependeDeMemoria,
      conforme,
      leitura,
      comMemoria,
      semMemoria,
    });
  }

  const allConform = results.every((entry) => entry.conforme);
  const mark = (result: ModeResult): string =>
    result.passou ? "passou" : "falhou";
  const lines: string[] = [
    "# Comparação com memória e sem memória",
    "",
    `Bateria ${batteryId}. Cada caso roda duas vezes contra o modelo real, pelo mesmo pipeline do chat: com a memória ligada e com ela desligada (\`--sem-memoria\`). O estado gravado em cada execução está em \`estado/\`.`,
    "",
    "Um caso que depende de memória só está conforme se passa com memória e falha sem ela. Os demais precisam passar nos dois modos.",
    "",
    "| Caso | Título | Depende de memória | Com memória | Sem memória | Leitura |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (entry) =>
        `| ${entry.caso.id} | ${entry.caso.titulo.replace(/\|/g, "/")} | ${entry.caso.dependeDeMemoria ? "sim" : "não"} | ${mark(entry.comMemoria)} | ${mark(entry.semMemoria)} | ${entry.leitura} |`,
    ),
    "",
    `Resultado: ${results.filter((entry) => entry.conforme).length} de ${results.length} casos conformes.`,
    "",
  ];
  for (const entry of results) {
    lines.push(`## ${entry.caso.id} — ${entry.caso.titulo}`, "");
    for (const [label, result] of [
      ["Com memória", entry.comMemoria],
      ["Sem memória", entry.semMemoria],
    ] as const) {
      lines.push(`### ${label}: ${mark(result)}`, "");
      if (result.falhas.length > 0) {
        lines.push(...result.falhas.map((failure) => `- ${failure}`), "");
      }
      if (result.comprimiu) {
        lines.push("O histórico foi comprimido durante o caso.", "");
      }
      for (const turn of result.turnos) {
        lines.push(
          `Sessão \`${turn.sessao}\`, perfil \`${turn.perfil}\`. Pergunta:`,
          "",
          fenced(turn.pergunta),
          "",
          turn.memoriaNoContexto.length === 0
            ? "Memória no contexto: nenhuma."
            : `Memória no contexto: ${turn.memoriaNoContexto.length} item(ns).`,
          "",
          "Resposta:",
          "",
          fenced(turn.resposta === "" ? `(${turn.status})` : turn.resposta),
          "",
        );
      }
      if (result.itensDeMemoria.length > 0) {
        lines.push(
          "Memória gravada ao final:",
          "",
          fenced(result.itensDeMemoria.join("\n")),
          "",
        );
      }
    }
  }
  await deps.writer.writeJson(`${folder}/comparacao.json`, {
    bateria: batteryId,
    conformes: results.filter((entry) => entry.conforme).length,
    total: results.length,
    casos: results.map((entry) => ({
      caso: entry.caso.id,
      dependeDeMemoria: entry.caso.dependeDeMemoria,
      comMemoria: entry.comMemoria.passou,
      semMemoria: entry.semMemoria.passou,
      conforme: entry.conforme,
      leitura: entry.leitura,
    })),
  });
  await deps.writer.writeText(`${folder}/COMPARACAO.md`, lines.join("\n"));
  deps.log(
    `${results.filter((entry) => entry.conforme).length}/${results.length} casos conformes. Relatório: ${folder}/COMPARACAO.md`,
  );
  return allConform ? 0 : 1;
}
