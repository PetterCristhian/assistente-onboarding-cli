// One loader per context layer (docs/adr/0003-contexto-em-quatro-camadas.md).
// Each one reads only its own source. The disk and the clock are received as
// parameters; nothing here reads the environment, the arguments or the time.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import {
  ContextError,
  hasLineBreak,
  singleLineFieldProblem,
  userProfileSchema,
  type CompanyDocument,
  type ContextLayers,
  type UserProfile,
} from "./types.js";

export interface ContextFileReader {
  /** Throws an error with a `code` (ENOENT, EISDIR...) when it cannot read. */
  readText(path: string): string;
  /** Names of the files of the folder, without its subfolders. */
  listFiles(directory: string): string[];
}

export const nodeFileReader: ContextFileReader = {
  readText: (path) => readFileSync(path, "utf8"),
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
const USER_PROFILE_DIR = "03-usuario";
const COMPANY_DATA_DIR = "04-empresa";
const PROFILE_EXTENSION = ".json";
const COMPANY_DATA_EXTENSION = ".md";

// Names of the layers in the error messages.
const GLOBAL_INSTRUCTIONS_LAYER = "instruções globais";
const POLICIES_LAYER = "políticas";
const USER_DATA_LAYER = "dados do usuário";
const COMPANY_DATA_LAYER = "dados da empresa";

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
    if (readErrorCode(error) === "ENOENT") {
      throw new ContextError(
        `Arquivo da camada "${layer}" não encontrado. Caminho esperado: ${path}.`,
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

/** Where each layer is read from. Lists the profiles; reads no file. */
export function resolveContextSources(
  options: ContextOptions = {},
  reader: ContextFileReader = nodeFileReader,
): ContextSources {
  const { profile } = options;
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

  refuseEmptyContextDir(options.contextDir ?? DEFAULT_CONTEXT_DIR);
  const contextDir = resolve(options.contextDir ?? DEFAULT_CONTEXT_DIR);
  const profileDir = join(contextDir, USER_PROFILE_DIR);
  const profiles = listProfiles(contextDir, reader);
  // listProfiles never returns an empty list.
  const chosen = profile ?? profiles[0] ?? "";
  const userProfileFile = join(profileDir, `${chosen}${PROFILE_EXTENSION}`);

  if (!profiles.includes(chosen)) {
    throw new ContextError(
      `Perfil "${chosen}" não encontrado. Caminho esperado: ${userProfileFile}. Perfis disponíveis: ${profiles.join(", ")}.`,
    );
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

export function loadContextLayers(
  options: ContextOptions,
  deps: LoadContextDeps,
): ContextLayers {
  const reader = deps.reader ?? nodeFileReader;
  const sources = resolveContextSources(options, reader);

  return {
    globalInstructions: loadGlobalInstructions(
      sources.globalInstructionsFile,
      reader,
    ),
    policies: loadPolicies(sources.policiesFile, reader),
    userProfile: loadUserProfile(sources.userProfileFile, reader),
    companyData: loadCompanyData(sources.companyDataDir, reader),
    currentDate: formatCurrentDate(deps.now()),
  };
}
