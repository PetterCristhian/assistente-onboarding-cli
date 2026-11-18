# ADR 0001 — Stack e ferramentas

- Status: aceita (18/11/2026)
- Relacionado: PRD D2, D3; F4, F15
- Aceita na verificação final (ENG-61), depois de conferida com `package.json`, `.github/workflows/ci.yml` e o código: duas dependências de runtime, Node >= 22 em `engines`, `tsx` sem build, Vitest, ESLint e Prettier, e o CI de job único com `npm ci` e `npm run check`, sem secret. Registro em `docs/VERIFICACAO.md`.

## Contexto

TypeScript e OpenAI são fixos pelo enunciado. O avaliador precisa rodar o chat seguindo só o README, então cada ferramenta extra é um risco de instalação. O PRD exclui do MVP: persistência, autenticação, interface gráfica, empacotamento e pipeline de CI.

Revisão de 16/11/2026: o dono aprovou incluir um workflow pequeno de CI, apesar de o PRD deixar CI fora do MVP. A condição é que ele não use a chave da OpenAI (nenhum secret, nenhuma chamada à API real).

## Decisão

- Node.js >= 22 (o SDK `openai` 7.x exige essa versão), TypeScript `strict` em ESM, executado com `tsx`, sem etapa de build.
- npm com lockfile versionado.
- Biblioteca padrão para o terminal (`node:readline/promises`, `node:util.parseArgs`) e para o `.env` (`process.loadEnvFile`).
- Duas dependências de runtime: `openai` e `zod`.
- Vitest para testes unitários (sem rede); ESLint + typescript-eslint + Prettier.
- Sem banco, sem hospedagem, sem autenticação de usuário.
- O portão de qualidade é `npm run check` (lint + typecheck + testes unitários + varredura de segredos), rodado localmente antes de cada commit.
- CI mínimo no GitHub Actions (`.github/workflows/ci.yml`): a cada PR e a cada push na `main`, um único job faz `npm ci` e `npm run check`, com a versão do Node de `.nvmrc`. O workflow não referencia nenhum secret, não define `OPENAI_API_KEY` e não roda `npm run eval`: a bateria F12 continua sendo executada só localmente, com a chave do dono.

## Alternativas descartadas

- Bun ou Deno: runtime incomum para o avaliador.
- `tsc` + `dist/`: etapa extra sem benefício em CLI local.
- `commander`, `inquirer`, `ink`, `dotenv`: a biblioteca padrão cobre o necessário.
- Jest: configuração trabalhosa com ESM e TypeScript.
- Nenhum CI (proposta original, seguindo o PRD): descartada pelo dono; o custo de um job único é baixo e ele confere o portão a cada PR.
- Rodar a bateria F12 no CI: exige a chave real, que não deve ir para um repositório público nem como segredo de CI, e gastaria crédito a cada PR.
- Um job por verificação ou matriz de versões do Node: mais configuração do que o projeto precisa; `npm run check` já é o portão único.

## Consequências

- Instalação do avaliador: Node + `npm install` + `.env`.
- O CI confere o portão a cada PR, mas não substitui rodar `npm run check` antes de cada commit (regra em `CLAUDE.md`).
- O CI depende de `package.json` e `package-lock.json` versionados e do script `check`. Esses arquivos existem desde a issue 1 (ENG-43), e o workflow executa as verificações de fato. O passo que pula tudo quando os arquivos não existem é um resquício do arranque, sem efeito hoje.
- O CI roda sem `OPENAI_API_KEY`. Por isso, lint, typecheck, testes unitários e varredura de segredos precisam continuar funcionando sem a chave e sem rede.
- Testes unitários cobrem só lógica determinística (montagem de contexto, retry, rate limit, redação, veredito). Eles não substituem a bateria F12, que roda contra o modelo real, como o PRD exige.
- Na data desta ADR, o Node não foi encontrado no PATH da máquina de desenvolvimento, e a issue 1 começou pela instalação. A pendência foi resolvida na ENG-43.
