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

### Alterado

- `npm run chat` passa a exigir `OPENAI_API_KEY`: sem a chave, encerra com código diferente de zero e uma orientação em português, sem stack trace (ENG-44).
- `npm run check` passa a incluir `npm run check:secrets`, e `npm run lint` passa a falhar também com avisos do ESLint (ENG-44).
- ADR 0001, `docs/ARQUITETURA.md` e issue 1 de `docs/BACKLOG.md`: o projeto passa a ter um workflow pequeno de CI, por decisão do dono (o PRD deixava CI fora do MVP).
