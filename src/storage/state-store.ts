// Where the sessions and the memories live between runs: one JSON file per
// session and one per profile, under a base folder. It reads the disk here
// and writes only through the safe writer (architecture rule 4), so every
// stored text is redacted. A file that is not what it should be is refused:
// nothing is guessed from a broken state.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  memoryFileSchema,
  sessionFileSchema,
  STATE_ID_PATTERN,
  type MemoryFile,
  type SessionFile,
} from "../memory/types.js";
import type { SafeWriter } from "../security/safe-writer.js";

const MAX_STATE_FILE_BYTES = 4 * 1024 * 1024;
const SESSIONS_DIR = "sessoes";
const MEMORY_DIR = "memoria";

export class StateError extends Error {
  override readonly name = "StateError";
}

export interface SessionSummary {
  readonly id: string;
  readonly perfil: string;
  readonly atualizadaEm: string;
  readonly turnos: number;
}

export interface StateStore {
  /** Undefined when there is no such session. */
  loadSession(id: string): SessionFile | undefined;
  saveSession(file: SessionFile): Promise<void>;
  /** The newest first. A file that cannot be read is left out. */
  listSessions(): SessionSummary[];
  /** An empty memory when the profile has none yet. */
  loadMemory(profile: string): MemoryFile;
  saveMemory(file: MemoryFile): Promise<void>;
}

export interface StateStoreOptions {
  readonly writer: SafeWriter;
  /** Relative to the root, with "/": "data" or a folder of outputs/. */
  readonly baseDir: string;
  /** Default: the project root. The same root as the writer. */
  readonly rootDir?: string;
}

function refuseBadId(id: string, what: string): void {
  if (!STATE_ID_PATTERN.test(id)) {
    throw new StateError(
      `${what} inválido: use só letras minúsculas, números e hífen (até 64 caracteres).`,
    );
  }
}

export function createStateStore(options: StateStoreOptions): StateStore {
  const rootDir = resolve(
    options.rootDir ?? fileURLToPath(new URL("../../", import.meta.url)),
  );
  const relativePath = (folder: string, id: string): string =>
    `${options.baseDir}/${folder}/${id}.json`;
  const absolutePath = (folder: string, id: string): string =>
    join(rootDir, ...relativePath(folder, id).split("/"));

  function readJson(path: string): unknown {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_STATE_FILE_BYTES) {
      throw new StateError(`Arquivo de estado inválido: ${path}.`);
    }
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new StateError(`Arquivo de estado não é um JSON válido: ${path}.`);
    }
  }

  return {
    loadSession(id) {
      refuseBadId(id, "Identificador de sessão");
      const path = absolutePath(SESSIONS_DIR, id);
      if (!existsSync(path)) {
        return undefined;
      }
      const parsed = sessionFileSchema.safeParse(readJson(path));
      if (!parsed.success || parsed.data.id !== id) {
        throw new StateError(
          `O arquivo da sessão "${id}" não tem o formato esperado: ${path}.`,
        );
      }
      return parsed.data;
    },

    async saveSession(file) {
      refuseBadId(file.id, "Identificador de sessão");
      await options.writer.writeJson(relativePath(SESSIONS_DIR, file.id), file);
    },

    listSessions() {
      const folder = join(rootDir, ...options.baseDir.split("/"), SESSIONS_DIR);
      if (!existsSync(folder)) {
        return [];
      }
      const found: SessionSummary[] = [];
      for (const name of readdirSync(folder)) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!STATE_ID_PATTERN.test(id)) {
          continue;
        }
        try {
          const parsed = sessionFileSchema.safeParse(
            readJson(join(folder, name)),
          );
          if (parsed.success) {
            found.push({
              id: parsed.data.id,
              perfil: parsed.data.perfil,
              atualizadaEm: parsed.data.atualizadaEm,
              turnos: parsed.data.turnos.length,
            });
          }
        } catch {
          // Left out: the list is a convenience, not a check of the disk.
        }
      }
      return found.sort((a, b) => b.atualizadaEm.localeCompare(a.atualizadaEm));
    },

    loadMemory(profile) {
      refuseBadId(profile, "Perfil da memória");
      const path = absolutePath(MEMORY_DIR, profile);
      if (!existsSync(path)) {
        return { versao: 1, perfil: profile, itens: [] };
      }
      const parsed = memoryFileSchema.safeParse(readJson(path));
      if (!parsed.success || parsed.data.perfil !== profile) {
        throw new StateError(
          `O arquivo de memória do perfil "${profile}" não tem o formato esperado: ${path}.`,
        );
      }
      return parsed.data;
    },

    async saveMemory(file) {
      refuseBadId(file.perfil, "Perfil da memória");
      await options.writer.writeJson(
        relativePath(MEMORY_DIR, file.perfil),
        file,
      );
    },
  };
}
