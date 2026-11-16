# Assistente de Onboarding — Chatbot CLI com Camada de Políticas

> Este arquivo é lido por todos os agentes. Mantenha-o curto e atualizado.

## O que é
Chatbot de terminal em TypeScript, com a OpenAI, que responde dúvidas de onboarding de uma empresa fictícia obedecendo às políticas P1–P5, com contexto em quatro camadas separadas e evidências de teste (12 casos x 3 execuções). Trabalho de pós-graduação (Engenharia de Contexto em IA). Detalhes em `docs/PRD.md`.

## Stack
- Linguagem: TypeScript `strict`, ESM, Node.js >= 22, executado com `tsx` (sem build)
- Framework: nenhum. Terminal com `node:readline/promises` e `node:util.parseArgs`
- LLM: SDK `openai`, Responses API, modelo `gpt-6-luna` (configurável por `OPENAI_MODEL`)
- Validação: `zod`. Testes unitários: Vitest. Lint/format: ESLint + Prettier
- Banco: nenhum (histórico em memória)
- Hospedagem: nenhuma (execução local). CI: GitHub Actions mínimo (`npm ci` + `npm run check` a cada push na `main` e a cada PR), sem a chave da OpenAI (ver ADR 0001)
- Detalhes e justificativas: `docs/ARQUITETURA.md` e `docs/adr/`

## Comandos
- Instalar: `npm install`
- Rodar o chat: `npm run chat` (opções: `--perfil`, `--system-prompt`, `--context-dir`, `--verbose`, `--show-context`)
- Ver o contexto montado: `npm run contexto`
- Testes unitários (sem rede, sem chave): `npm test`
- Bateria contra o modelo real (usa a chave e gasta crédito): `npm run eval`
- Teste de fumaça do cliente OpenAI (usa a chave e gasta crédito; não rodar em laço): `npm run smoke:llm`
- Demonstração de retry e rate limit (stub local, sem chave): `npm run demo:falhas`
- Gerar `docs/CASOS-DE-TESTE.md`: `npm run casos:doc`
- Lint/format: `npm run lint` / `npm run format`
- Tipos: `npm run typecheck`
- Varredura de segredos: `npm run check:secrets`
- Portão antes de cada commit: `npm run check` (lint + typecheck + test + check:secrets)
- Build: não há

## Estrutura
```
context/    as 4 camadas (conteúdo, sem código): 01-instrucoes-globais.md,
            02-politicas.md, 03-usuario/*.json, 04-empresa/*.md, fallback.md
src/        cli/ config/ context/ llm/ chat/ security/ logging/
evals/      casos.json, runner.ts, verdict.ts, report.ts
scripts/    demo-falhas.ts, show-context.ts, check-secrets.ts
tests/      testes unitários (Vitest)
outputs/    resultados das baterias e evidências (VERSIONADO, entregável)
logs/       logs de sessão (IGNORADO pelo git)
docs/       PRD, ARQUITETURA, BACKLOG, adr/, CASOS-DE-TESTE, REUSO, ANALISE
```

## Convenções
- Idioma do código: inglês (nomes de variáveis, funções e commits); documentação em português
- Em português também: todo o conteúdo de `context/`, `evals/casos.json`, mensagens exibidas ao usuário e chaves dos arquivos de output
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`)
- Branches: `feat/<slug>`, `fix/<slug>`
- Arquivos em `kebab-case.ts`; testes em `tests/<modulo>.test.ts`
- Sem `any`. Dados externos (env, JSON de perfil, casos, saída do modelo) sempre validados com `zod`
- Injeção de dependência por parâmetro: `LlmClient`, relógio e função de espera são passados, nunca importados direto, para permitir teste sem rede e com tempo falso

### Regras de arquitetura (não negociáveis)
1. **Domínio fora de `src/`.** Nome da empresa, regras, contatos e base de conhecimento existem só em `context/` e `evals/casos.json`. Regra não vai em arquivo de dados; dado não vai em arquivo de regra.
2. **Um só caminho para a OpenAI.** Toda chamada passa por `src/llm/client.ts`, sempre envolvida por `withRetry`. O cliente do SDK é criado com `maxRetries: 0`.
3. **Um só leitor de ambiente.** Apenas `src/config/env.ts` lê `process.env`. O identificador do modelo não aparece como literal em outro lugar.
4. **Um só escritor de disco para `outputs/` e `logs/`,** que aplica `redact()`. Erros são gravados resumidos (status, código, tipo, mensagem), nunca o objeto inteiro nem cabeçalhos.
5. **Invariante da autoavaliação.** Só entra no histórico e só é chamado de resposta final um texto aprovado pela autoavaliação ou a mensagem segura de `context/fallback.md`. Falha na autoavaliação conta como reprovação.
6. **Chat e bateria usam o mesmo pipeline** (`src/chat/session.ts`). Não duplicar lógica de turno em `evals/`.
7. **Outputs de bateria não são editados à mão nem apagados.** Cada execução gera uma pasta nova em `outputs/`.

## Definição de pronto
- [ ] Critérios de aceite da issue atendidos
- [ ] Testes novos e existentes passando (`npm test`)
- [ ] `npm run check` sem erros
- [ ] Nenhuma credencial nos arquivos alterados (`npm run check:secrets`)
- [ ] QA aprovado e revisor sem bloqueantes
- [ ] README/ADR atualizados, se a mudança alterar comando, variável ou decisão
- [ ] PR aberto com link da issue

## Nunca
- Commitar segredos ou `.env`. O repositório é PÚBLICO. A chave da OpenAI só existe em `.env` local (ignorado) ou em variável de ambiente; `.env.example` nunca recebe valor real
- Imprimir, registrar em log ou gravar em output a chave, cabeçalhos de requisição ou objetos de erro inteiros do SDK
- Colar a chave em issue, PR, mensagem de commit, documentação ou conversa com agente
- Aceitar a chave por argumento de linha de comando
- Rodar `npm run eval` em laço ou sem necessidade: usa a chave do dono e gasta crédito
- Trabalhar direto na `main`
- Desabilitar testes ou regras de lint para fazer passar
- Adicionar dependência nova sem justificar no plano (runtime hoje: só `openai` e `zod`)
- Ampliar o escopo além do PRD (sem RAG, sem persistência, sem segundo domínio, sem outro provedor; o CI fica só no `npm run check`, sem secrets e sem `npm run eval`)
- Ajustar um caso de teste ou seu critério só para fazer a bateria passar: corrige-se o contexto, e a iteração é registrada em `docs/ANALISE.md`

Se uma chave vazar: avisar o dono na hora para revogá-la no painel da OpenAI. Reescrever o histórico do Git não resolve.

## Projeto no Linear
- Time/Projeto: a definir pelo orquestrador ao criar as issues de `docs/BACKLOG.md`
