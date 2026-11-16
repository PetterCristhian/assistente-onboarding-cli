// Entrada provisória do chat. O laço interativo chega na issue 7 do backlog.
// A configuração já é validada aqui: sem a chave, o programa encerra com
// orientação de correção, sem stack trace. Nada da configuração é impresso.
import { ConfigError, loadConfig } from "../config/env.js";

const PLACEHOLDER_MESSAGE =
  "Assistente de onboarding: esqueleto do projeto pronto. O chat interativo ainda não foi implementado.";

function main(): number {
  try {
    loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  console.log(PLACEHOLDER_MESSAGE);
  return 0;
}

process.exitCode = main();
