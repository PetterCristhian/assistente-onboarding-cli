// End-to-end checks of the entry point of `npm run check:secrets`: the exit
// codes and what it prints. The scan logic is covered by secret-scan.test.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fakeOpenAiKey } from "./helpers/fake-key.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = fakeOpenAiKey();
const CHILD_TIMEOUT_MS = 20_000;

const temporaryFolders: string[] = [];

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function runScript(
  script: string,
  variables: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  // The cwd stays at the project root so that Node finds tsx; the script
  // resolves the folder it scans from its own location, not from the cwd.
  return spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...variables },
    timeout: CHILD_TIMEOUT_MS,
  });
}

/**
 * Copies the script and the two modules it needs to a temporary Git folder,
 * so a file with a fake key can exist without touching this repository.
 */
function createScannedCopy(): string {
  const folder = mkdtempSync(join(tmpdir(), "eng44-check-secrets-"));
  temporaryFolders.push(folder);

  mkdirSync(join(folder, "scripts"));
  mkdirSync(join(folder, "src", "security"), { recursive: true });
  for (const file of [
    "package.json",
    "scripts/check-secrets.ts",
    "src/security/secret-scan.ts",
    "src/security/redact.ts",
  ]) {
    cpSync(join(PROJECT_ROOT, file), join(folder, file));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: folder, stdio: "ignore" });
  return folder;
}

describe("scripts/check-secrets.ts", () => {
  it(
    "exits with 0 and counts the files in this repository",
    () => {
      const result = runScript("scripts/check-secrets.ts");

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /^check:secrets: nenhuma credencial encontrada em \d+ arquivos\.\n$/,
      );
      expect(result.stderr).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "exits with 1 and shows file, line and column, never the value",
    () => {
      const folder = createScannedCopy();
      mkdirSync(join(folder, "outputs", "com espaço"), { recursive: true });
      writeFileSync(
        join(folder, "outputs", "com espaço", "relatório.md"),
        `a\nb\n  chave: ${KEY}`,
      );
      writeFileSync(
        join(folder, "imagem.bin"),
        Buffer.concat([
          Buffer.from([0, 255, 254, 0]),
          Buffer.from(KEY, "latin1"),
          Buffer.from([0, 1, 2]),
        ]),
      );
      writeFileSync(join(folder, ".gitignore"), "ignorado.txt\n");
      writeFileSync(join(folder, "ignorado.txt"), `${KEY}\n`);

      const result = runScript(join(folder, "scripts", "check-secrets.ts"));
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("o valor não é exibido");
      expect(result.stderr).toContain(
        "  - outputs/com espaço/relatório.md:3:10\n",
      );
      expect(result.stderr).toContain("  - imagem.bin:1:5\n");
      expect(result.stderr).toContain("revogue-a no painel da OpenAI");
      expect(output).not.toContain("ignorado.txt");
      expect(output).not.toContain(KEY);
      expect(output).not.toContain(KEY.slice(0, 12));
      expect(result.stdout).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );

  it(
    "exits with 2, never in silence, when Git cannot list the files",
    () => {
      const folder = mkdtempSync(join(tmpdir(), "eng44-check-secrets-"));
      temporaryFolders.push(folder);

      const result = runScript("scripts/check-secrets.ts", {
        GIT_DIR: join(folder, "nao-existe"),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "check:secrets: não foi possível listar os arquivos com o Git (",
      );
      expect(result.stderr).not.toMatch(/^\s+at /m);
      expect(result.stdout).toBe("");
    },
    CHILD_TIMEOUT_MS,
  );
});
