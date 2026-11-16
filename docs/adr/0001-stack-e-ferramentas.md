# ADR 0001 — Stack e ferramentas

- Status: proposta (16/11/2026)
- Relacionado: PRD D2, D3; F4, F15

## Contexto

TypeScript e OpenAI são fixos pelo enunciado. O avaliador precisa rodar o chat seguindo só o README, então cada ferramenta extra é um risco de instalação. O PRD exclui do MVP: persistência, autenticação, interface gráfica, empacotamento e pipeline de CI.

## Decisão

- Node.js >= 22 (o SDK `openai` 7.x exige essa versão), TypeScript `strict` em ESM, executado com `tsx`, sem etapa de build.
- npm com lockfile versionado.
- Biblioteca padrão para o terminal (`node:readline/promises`, `node:util.parseArgs`) e para o `.env` (`process.loadEnvFile`).
- Duas dependências de runtime: `openai` e `zod`.
- Vitest para testes unitários (sem rede); ESLint + typescript-eslint + Prettier.
- Sem banco, sem hospedagem, sem autenticação de usuário.
- Sem pipeline de CI. O portão de qualidade é local: `npm run check` (lint + typecheck + testes unitários + varredura de segredos).

## Alternativas descartadas

- Bun ou Deno: runtime incomum para o avaliador.
- `tsc` + `dist/`: etapa extra sem benefício em CLI local.
- `commander`, `inquirer`, `ink`, `dotenv`: a biblioteca padrão cobre o necessário.
- Jest: configuração trabalhosa com ESM e TypeScript.
- GitHub Actions: o PRD coloca CI fora do MVP. Além disso, a bateria F12 exige a chave real, que não deve ir para um repositório público nem como segredo de CI sem necessidade.

## Consequências

- Instalação do avaliador: Node + `npm install` + `.env`.
- Sem CI, a disciplina de rodar `npm run check` antes de cada commit fica por conta de quem implementa (regra em `CLAUDE.md`).
- Testes unitários cobrem só lógica determinística (montagem de contexto, retry, rate limit, redação, veredito). Eles não substituem a bateria F12, que roda contra o modelo real, como o PRD exige.
- Na data desta ADR, o Node não foi encontrado no PATH da máquina de desenvolvimento: a issue 1 começa pela instalação.
