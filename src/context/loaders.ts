// One loader per context layer (docs/adr/0003-contexto-em-quatro-camadas.md).
// Each one reads only its own source. The disk and the clock are received as
// parameters; nothing here reads the environment, the arguments or the time.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import {
  ContextError,
  hasLineBreak,
  singleLineFieldProblem,
  userProfileSchema,
  REVISION_VIOLATIONS_MARKER,
  type CompanyDocument,
  type ContextLayers,
  type CritiquePrompts,
  type UserProfile,
} from "./types.js";

export interface ContextFileReader {
  /** Throws an error with a `code` (ENOENT, EISDIR...) when it cannot read. */
  readText(path: string): string;
  /** Names of the files of the folder, without its subfolders. */
  listFiles(directory: string): string[];
}

/** Largest file of any layer: far above the real ones, far below a mistake. */
export const MAX_LAYER_FILE_BYTES = 64 * 1024;

/** Not a regular file (a folder, a device, a pipe). */
const NOT_REGULAR_CODE = "ENOTREG";
/** Larger than MAX_LAYER_FILE_BYTES. */
const TOO_BIG_CODE = "EFBIG";

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export const nodeFileReader: ContextFileReader = {
  readText: (path) => {
    // Checked before reading: a device or a huge file is never read.
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw codedError(NOT_REGULAR_CODE);
    }
    if (stats.size > MAX_LAYER_FILE_BYTES) {
      throw codedError(TOO_BIG_CODE);
    }
    return readFileSync(path, "utf8");
  },
  listFiles: (directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
};

/** context/ at the project root, wherever the cwd is. */
export const DEFAULT_CONTEXT_DIR = resolve(
  fileURLToPath(new URL("../../context", import.meta.url)),
);

const GLOBAL_INSTRUCTIONS_FILE = "01-instrucoes-globais.md";
const POLICIES_FILE = "02-politicas.md";
const FALLBACK_FILE = "fallback.md";
const EVALUATOR_PROMPT_FILE = "avaliador.md";
const REVISION_PROMPT_FILE = "revisao.md";
const USER_PROFILE_DIR = "03-usuario";
const COMPANY_DATA_DIR = "04-empresa";
const PROFILE_EXTENSION = ".json";
const COMPANY_DATA_EXTENSION = ".md";
// Files that the user picks must look like what the layer holds.
const GLOBAL_INSTRUCTIONS_EXTENSIONS: readonly string[] = [".md", ".txt"];
const PROFILE_FILE_EXTENSIONS: readonly string[] = [PROFILE_EXTENSION];
const ENV_FILE_PREFIX = ".env";

// Names of the layers in the error messages.
const GLOBAL_INSTRUCTIONS_LAYER = "instruções globais";
const POLICIES_LAYER = "políticas";
const USER_DATA_LAYER = "dados do usuário";
const COMPANY_DATA_LAYER = "dados da empresa";
// Files of context/ that are not a layer (they never go in the context).
const FALLBACK_LAYER = "mensagem segura";
const EVALUATOR_PROMPT_LAYER = "prompt do avaliador";
const REVISION_PROMPT_LAYER = "prompt da revisão";

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const PROFILE_FIELDS = Object.keys(userProfileSchema.shape);
const DATE_FIELD: keyof UserProfile = "dataInicio";

export interface ContextSources {
  readonly globalInstructionsFile: string;
  readonly policiesFile: string;
  readonly userProfileFile: string;
  readonly companyDataDir: string;
}

export interface ContextOptions {
  /** Another folder with the same structure. Default: DEFAULT_CONTEXT_DIR. */
  readonly contextDir?: string;
  /** Name of a profile, without folder and without extension. */
  readonly profile?: string;
  /** Path of a profile file; excludes `profile`. */
  readonly profileFile?: string;
  /** Another file for the first layer; the other three do not change. */
  readonly globalInstructionsFile?: string;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

// Only the code is quoted: the message of the system repeats the path and
// may carry more than that.
function unreadable(path: string, error: unknown): ContextError {
  return new ContextError(
    `Não foi possível ler ${path} (${readErrorCode(error) ?? "erro desconhecido"}).`,
  );
}

/** Ordered by code unit: the same order on every machine and locale. */
function sortByCode(names: string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function normalizeText(raw: string): string {
  const withoutMark = raw.startsWith(BYTE_ORDER_MARK)
    ? raw.slice(BYTE_ORDER_MARK.length)
    : raw;
  return withoutMark.replaceAll("\r\n", "\n").trim();
}

/** The normalized text of one file of a layer, never empty. */
function readLayerFile(
  file: string,
  layer: string,
  reader: ContextFileReader,
): string {
  const path = resolve(file);
  let raw: string;
  try {
    raw = reader.readText(path);
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ENOENT") {
      throw new ContextError(
        `Arquivo da camada "${layer}" não encontrado. Caminho esperado: ${path}.`,
      );
    }
    if (code === NOT_REGULAR_CODE) {
      throw new ContextError(
        `O caminho da camada "${layer}" não é um arquivo comum: ${path}.`,
      );
    }
    if (code === TOO_BIG_CODE) {
      throw new ContextError(
        `O arquivo da camada "${layer}" excede ${MAX_LAYER_FILE_BYTES / 1024} KiB: ${path}.`,
      );
    }
    throw unreadable(path, error);
  }

  const text = normalizeText(raw);
  if (text === "") {
    throw new ContextError(
      `O arquivo da camada "${layer}" está vazio: ${path}.`,
    );
  }
  return text;
}

/** The ordered names with the given extension in a folder, never empty. */
function listLayerFiles(
  directory: string,
  layer: string,
  extension: string,
  reader: ContextFileReader,
): string[] {
  const path = resolve(directory);
  let names: string[];
  try {
    names = reader.listFiles(path);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      throw new ContextError(
        `Pasta da camada "${layer}" não encontrada. Caminho esperado: ${path}.`,
      );
    }
    throw unreadable(path, error);
  }

  // A name that is only the extension (".md") is not a file of the layer.
  const matching = sortByCode(
    names.filter(
      (name) => name.endsWith(extension) && name.length > extension.length,
    ),
  );
  if (matching.length === 0) {
    throw new ContextError(
      `A pasta da camada "${layer}" não contém nenhum arquivo ${extension}: ${path}.`,
    );
  }
  return matching;
}

/** An empty path would be read as the current folder. */
function refuseEmptyContextDir(contextDir: string): void {
  if (contextDir.trim() === "") {
    throw new ContextError(
      "A pasta de contexto informada está vazia: informe o caminho de uma pasta.",
    );
  }
}

/** Names of the profiles of a context folder, ordered, without extension. */
export function listProfiles(
  contextDir: string,
  reader: ContextFileReader = nodeFileReader,
): string[] {
  refuseEmptyContextDir(contextDir);
  return listLayerFiles(
    join(contextDir, USER_PROFILE_DIR),
    USER_DATA_LAYER,
    PROFILE_EXTENSION,
    reader,
  ).map((name) => name.slice(0, -PROFILE_EXTENSION.length));
}

function isPlainProfileName(profile: string): boolean {
  return (
    profile.trim() !== "" && !/[\\/]/.test(profile) && !profile.includes("..")
  );
}

/** A file picked by the user: never an env file, and an expected extension. */
function refuseUnsuitableFile(
  file: string,
  extensions: readonly string[],
  what: string,
): void {
  const path = resolve(file);
  if (basename(path).toLowerCase().startsWith(ENV_FILE_PREFIX)) {
    throw new ContextError(
      `${what} não pode ser um arquivo de ambiente (.env): ${path}.`,
    );
  }
  if (!extensions.includes(extname(path).toLowerCase())) {
    throw new ContextError(
      `${what} deve ter a extensão ${extensions.join(" ou ")}: ${path}.`,
    );
  }
}

/** The context folder must exist and be readable as a folder. */
function requireContextDir(
  contextDir: string,
  reader: ContextFileReader,
): void {
  try {
    reader.listFiles(contextDir);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      throw new ContextError(
        `Pasta de contexto não encontrada. Caminho esperado: ${contextDir}.`,
      );
    }
    throw unreadable(contextDir, error);
  }
}

/**
 * Where each layer is read from. Lists the profiles (or, with a profile file,
 * only checks the context folder); reads no file.
 */
export function resolveContextSources(
  options: ContextOptions = {},
  reader: ContextFileReader = nodeFileReader,
): ContextSources {
  const { profile, profileFile } = options;
  if (profile !== undefined && profileFile !== undefined) {
    throw new ContextError(
      "Informe o perfil por nome ou por arquivo, não os dois.",
    );
  }
  if (profile !== undefined && !isPlainProfileName(profile)) {
    throw new ContextError(
      `Perfil "${profile}" inválido: informe apenas o nome do perfil, sem pasta nem extensão.`,
    );
  }

  // An empty path would be resolved to the current folder.
  const { globalInstructionsFile } = options;
  if (globalInstructionsFile?.trim() === "") {
    throw new ContextError(
      "O arquivo de instruções globais informado está vazio: informe o caminho de um arquivo.",
    );
  }

  if (profileFile?.trim() === "") {
    throw new ContextError(
      "O arquivo de perfil informado está vazio: informe o caminho de um arquivo.",
    );
  }
  if (globalInstructionsFile !== undefined) {
    refuseUnsuitableFile(
      globalInstructionsFile,
      GLOBAL_INSTRUCTIONS_EXTENSIONS,
      "O arquivo de instruções globais",
    );
  }
  if (profileFile !== undefined) {
    refuseUnsuitableFile(
      profileFile,
      PROFILE_FILE_EXTENSIONS,
      "O arquivo de perfil",
    );
  }

  refuseEmptyContextDir(options.contextDir ?? DEFAULT_CONTEXT_DIR);
  const contextDir = resolve(options.contextDir ?? DEFAULT_CONTEXT_DIR);

  let userProfileFile: string;
  if (profileFile === undefined) {
    const profiles = listProfiles(contextDir, reader);
    // listProfiles never returns an empty list.
    const chosen = profile ?? profiles[0] ?? "";
    userProfileFile = join(
      contextDir,
      USER_PROFILE_DIR,
      `${chosen}${PROFILE_EXTENSION}`,
    );
    if (!profiles.includes(chosen)) {
      throw new ContextError(
        `Perfil "${chosen}" não encontrado. Caminho esperado: ${userProfileFile}. Perfis disponíveis: ${profiles.join(", ")}.`,
      );
    }
  } else {
    requireContextDir(contextDir, reader);
    userProfileFile = resolve(profileFile);
  }

  return {
    globalInstructionsFile:
      globalInstructionsFile === undefined
        ? join(contextDir, GLOBAL_INSTRUCTIONS_FILE)
        : resolve(globalInstructionsFile),
    policiesFile: join(contextDir, POLICIES_FILE),
    userProfileFile,
    companyDataDir: join(contextDir, COMPANY_DATA_DIR),
  };
}

export function loadGlobalInstructions(
  file: string,
  reader: ContextFileReader = nodeFileReader,
): string {
  return readLayerFile(file, GLOBAL_INSTRUCTIONS_LAYER, reader);
}

export function loadPolicies(
  file: string,
  reader: ContextFileReader = nodeFileReader,
): string {
  return readLayerFile(file, POLICIES_LAYER, reader);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A text with content and a line break; a blank one is reported as empty. */
function isMultilineText(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim() !== "" && hasLineBreak(value)
  );
}

/** One line per problem, written here (zod's own text is not used). */
function describeProfileProblems(
  path: string,
  raw: unknown,
  issues: readonly z.core.$ZodIssue[],
): string {
  const prefix = `Perfil inválido em ${path}:`;
  if (!isRecord(raw)) {
    return `${prefix} o conteúdo deve ser um objeto JSON com os campos ${PROFILE_FIELDS.slice(0, -1).join(", ")} e ${PROFILE_FIELDS.at(-1) ?? ""}.`;
  }

  const failed = new Set<string>();
  const unrecognized = new Set<string>();
  for (const issue of issues) {
    // An extra key is reported with an empty path and the list of keys.
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        unrecognized.add(key);
      }
    } else if (issue.path.length > 0) {
      failed.add(String(issue.path[0]));
    }
  }

  const lines: string[] = [];
  for (const field of PROFILE_FIELDS) {
    if (!failed.has(field)) {
      continue;
    }
    if (!Object.hasOwn(raw, field)) {
      lines.push(`${prefix} campo "${field}" é obrigatório.`);
    } else if (field === DATE_FIELD) {
      lines.push(
        `${prefix} campo "${field}" deve ser uma data existente no formato AAAA-MM-DD.`,
      );
    } else if (isMultilineText(raw[field])) {
      lines.push(`${prefix} ${singleLineFieldProblem(field)}`);
    } else {
      // Also the message of a value padded with blanks, which is not empty.
      lines.push(
        `${prefix} campo "${field}" deve ser um texto não vazio, sem espaços no início ou no fim.`,
      );
    }
  }
  for (const key of unrecognized) {
    lines.push(`${prefix} campo "${key}" não é reconhecido.`);
  }
  // Never an empty message, whatever the validator reports.
  return lines.length > 0
    ? lines.join("\n")
    : `${prefix} o conteúdo não segue o formato esperado.`;
}

export function loadUserProfile(
  file: string,
  reader: ContextFileReader = nodeFileReader,
): UserProfile {
  const path = resolve(file);
  const text = readLayerFile(path, USER_DATA_LAYER, reader);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ContextError(`O perfil ${path} não é um JSON válido.`);
  }

  const parsed = userProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContextError(
      describeProfileProblems(path, raw, parsed.error.issues),
    );
  }
  return parsed.data;
}

/** Every Markdown file of the folder, ordered by name. */
export function loadCompanyData(
  directory: string,
  reader: ContextFileReader = nodeFileReader,
): CompanyDocument[] {
  const path = resolve(directory);
  return listLayerFiles(
    path,
    COMPANY_DATA_LAYER,
    COMPANY_DATA_EXTENSION,
    reader,
  ).map((name) => ({
    name,
    content: readLayerFile(join(path, name), COMPANY_DATA_LAYER, reader),
  }));
}

/**
 * The fixed safe message (fallback.md). Read at start-up: a missing or empty
 * file stops the chat, so that the failure path never depends on the disk.
 */
export function loadFallbackMessage(
  contextDir: string,
  reader: ContextFileReader = nodeFileReader,
): string {
  refuseEmptyContextDir(contextDir);
  return readLayerFile(join(contextDir, FALLBACK_FILE), FALLBACK_LAYER, reader);
}

/** The prompts of the evaluator and of the revision (ENG-53). */
export function loadCritiquePrompts(
  contextDir: string,
  reader: ContextFileReader = nodeFileReader,
): CritiquePrompts {
  refuseEmptyContextDir(contextDir);
  const evaluator = readLayerFile(
    join(contextDir, EVALUATOR_PROMPT_FILE),
    EVALUATOR_PROMPT_LAYER,
    reader,
  );
  const revision = readLayerFile(
    join(contextDir, REVISION_PROMPT_FILE),
    REVISION_PROMPT_LAYER,
    reader,
  );
  if (!revision.includes(REVISION_VIOLATIONS_MARKER)) {
    throw new ContextError(
      `O ${REVISION_PROMPT_LAYER} deve conter o marcador ${REVISION_VIOLATIONS_MARKER}: ${join(contextDir, REVISION_PROMPT_FILE)}.`,
    );
  }
  return { evaluator, revision };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** "AAAA-MM-DD (day of the week)", in the local time of the machine. */
export function formatCurrentDate(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new ContextError("A data atual recebida do relógio não é válida.");
  }
  // The format has four digits for the year, with no sign.
  if (now.getFullYear() < 1 || now.getFullYear() > 9999) {
    throw new ContextError(
      "A data atual recebida do relógio está fora do intervalo aceito (anos de 1 a 9999).",
    );
  }
  const year = String(now.getFullYear()).padStart(4, "0");
  const date = `${year}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(
    now,
  );
  return `${date} (${weekday})`;
}

export interface LoadContextDeps {
  readonly reader?: ContextFileReader;
  /** The clock. No default: only the entry points read the real time. */
  readonly now: () => Date;
}

/** The layers and where each one came from. */
export function loadContext(
  options: ContextOptions,
  deps: LoadContextDeps,
): { layers: ContextLayers; sources: ContextSources } {
  const reader = deps.reader ?? nodeFileReader;
  const sources = resolveContextSources(options, reader);

  const layers: ContextLayers = {
    globalInstructions: loadGlobalInstructions(
      sources.globalInstructionsFile,
      reader,
    ),
    policies: loadPolicies(sources.policiesFile, reader),
    userProfile: loadUserProfile(sources.userProfileFile, reader),
    companyData: loadCompanyData(sources.companyDataDir, reader),
    currentDate: formatCurrentDate(deps.now()),
  };
  return { layers, sources };
}

export function loadContextLayers(
  options: ContextOptions,
  deps: LoadContextDeps,
): ContextLayers {
  return loadContext(options, deps).layers;
}
