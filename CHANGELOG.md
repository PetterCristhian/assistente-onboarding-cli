# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado

- Documentação inicial: PRD, arquitetura, ADRs 0001–0007 e backlog do MVP.
- Entorno do repositório: `.gitignore`, `.gitattributes` (finais de linha em LF), `.editorconfig`, `.nvmrc` (Node 24) e `.env.example` com todas as variáveis, sem valores reais.
- Workflow de CI no GitHub Actions (`.github/workflows/ci.yml`): `npm ci` + `npm run check` a cada PR e a cada push na `main`, sem usar a chave da OpenAI.
- `README.md` inicial.
- Esqueleto do projeto TypeScript (ENG-43): `package.json` (ESM, Node >= 22) com `package-lock.json`, `tsconfig.json` em modo `strict`, ESLint + typescript-eslint, Prettier, Vitest com um teste de exemplo, entrada provisória em `src/cli/main.ts`, pastas da arquitetura e os comandos `npm run chat`, `npm test`, `npm run lint`, `npm run format`, `npm run typecheck` e `npm run check`.
- Configuração por ambiente e redação de segredos (ENG-44): `src/config/env.ts` como leitor único das variáveis de ambiente (carrega o `.env`, valida com `zod` e aplica os padrões); `redact()` em `src/security/redact.ts`; escritor único de `outputs/` e `logs/` em `src/security/safe-writer.ts`; resumo de erros em `src/security/error-summary.ts`; e o comando `npm run check:secrets`, que varre os arquivos não ignorados pelo Git.

### Corrigido

- `npm run check:secrets` passa a encontrar uma chave em arquivo UTF-16 (o que o `>` do Windows PowerShell 5 grava) e no nome ou caminho de um arquivo; nesse caso o caminho é exibido redigido, seguido de `(no nome do arquivo)` (ENG-44).
- O escritor de `outputs/` e `logs/` recusa um caminho que contenha uma credencial, não exibe mais o caminho sem redação na mensagem de caminho não permitido, e `writeJson`/`appendJsonLine` rejeitam a Promise (em vez de lançar) com uma mensagem em português para valor que não pode virar JSON (ENG-44).
- Um `.env` com BOM ou em UTF-16 passa a gerar uma orientação própria (salvar em UTF-8 sem BOM) em vez de "a variável não está definida" (ENG-44).
- A mensagem de configuração inválida não exibe mais a chave quando `OPENAI_API_KEY` tem espaços ou aspas em volta, e troca caracteres de controle do valor citado por um marcador visível (ENG-44).
- O resumo de erros limita `code`, `type` e `requestId` a 200 caracteres (ENG-44).
- `redact()` passa a remover também a chave mascarada que a API cita em erros 401 (o prefixo `sk-`, com ou sem `proj-`, seguido de três ou mais asteriscos e dos últimos caracteres), e o `npm run check:secrets` passa a acusar essa forma. O formato exato não foi confirmado contra a API real (ENG-44).
- O escritor de `outputs/` e `logs/` aplica sempre o padrão de chave, ao conteúdo e ao caminho, qualquer que seja o redator recebido (ENG-44).
- `redact()` ignora segredos exatos com menos de 8 caracteres, que antes trocavam letras e palavras comuns por `[REDACTED]` em todo o texto; o padrão de chave não muda (ENG-44).
- `OPENAI_API_KEY` com espaço, tabulação ou quebra de linha no meio do valor passa a ser recusada, com uma mensagem que não exibe o valor (ENG-44).
- `npm run check:secrets` termina com código 2 quando nenhum arquivo é varrido (antes, passava), e só atribui ao Git as falhas do próprio Git (ENG-44).
- Uma sequência com formato de chave de vários megabytes não derruba mais a redação nem a varredura (ENG-44).
- `npm run check:secrets` não acusa mais um binário cujas cadeias de texto são apenas separadas por bytes NUL; arquivos UTF-16 continuam cobertos (ENG-44).
- Um `.env` com BOM em que a chave não está na primeira linha passa a gerar a orientação de salvar em UTF-8 sem BOM, citando a variável que não foi lida, em vez de ignorar essa variável em silêncio (ENG-44).
- A mensagem de configuração inválida não exibe mais a chave quando `OPENAI_API_KEY` tem aspas malformadas (ENG-44).

### Alterado

- `npm run chat` passa a exigir `OPENAI_API_KEY`: sem a chave, encerra com código diferente de zero e uma orientação em português, sem stack trace (ENG-44).
- `npm run check` passa a incluir `npm run check:secrets`, e `npm run lint` passa a falhar também com avisos do ESLint (ENG-44).
- ADR 0001, `docs/ARQUITETURA.md` e issue 1 de `docs/BACKLOG.md`: o projeto passa a ter um workflow pequeno de CI, por decisão do dono (o PRD deixava CI fora do MVP).
