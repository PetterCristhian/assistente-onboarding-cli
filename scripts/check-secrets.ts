// Entry point of `npm run check:secrets`. The logic lives in
// src/security/secret-scan.ts; this file only reports and sets the exit code:
// 0 = clean, 1 = possible credential found, 2 = the scan could not run.
import { fileURLToPath } from "node:url";
import {
  describeScanFailure,
  scanRepository,
} from "../src/security/secret-scan.js";

function main(): number {
  const rootDir = fileURLToPath(new URL("../", import.meta.url));

  let result: ReturnType<typeof scanRepository>;
  try {
    result = scanRepository({ rootDir });
  } catch (error) {
    // Never pass in silence: a scan that did not run is a failure.
    console.error(`check:secrets: ${describeScanFailure(error)}`);
    return 2;
  }

  if (result.findings.length > 0) {
    console.error(
      "check:secrets: possível credencial encontrada (o valor não é exibido):",
    );
    for (const finding of result.findings) {
      console.error(
        finding.inPath === true
          ? `  - ${finding.file} (no nome do arquivo)`
          : `  - ${finding.file}:${finding.line}:${finding.column}`,
      );
    }
    console.error(
      "Remova o valor do arquivo (ou renomeie o arquivo, se o valor estiver no nome). Se for uma chave real, revogue-a no painel da OpenAI: reescrever o histórico do Git não resolve.",
    );
    return 1;
  }

  console.log(
    `check:secrets: nenhuma credencial encontrada em ${result.scannedFiles} arquivos.`,
  );
  return 0;
}

process.exitCode = main();
