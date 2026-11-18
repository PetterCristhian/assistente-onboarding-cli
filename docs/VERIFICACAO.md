# Verificação final de entrega (ENG-61)

Registro da verificação final do projeto (issue 19 do backlog). Cada linha diz quem executou e o que foi feito. O que depende da chave da OpenAI, do dono ou de uma pessoa externa está marcado como PENDENTE e não foi preenchido nem inventado.

## Cabeçalho

| Item | Valor |
|---|---|
| Data | 2026-11-18 |
| Commit verificado | `d261f41` (ponta da `main` antes desta issue). O PR da ENG-61 muda só documentação; o squash do PR gera outro SHA, que não foi verificado aqui |
| Onde | Clone limpo do repositório local, em pasta de caminho só com caracteres ASCII, fora da pasta do projeto |
| Sistema | Windows 11, Git 2.56.0, Git Bash |
| Node e npm | Node v26.13.1, npm 11.20.0. O `.nvmrc` e o CI usam Node 24; o `engines` pede Node >= 22. A verificação local foi feita em Node 26.13.1; o Node 24 (`.nvmrc`) é coberto pelo CI, e nenhuma execução local usou Node 24 ou 22. Recomendação opcional ao dono: rodar `npm run check` com Node 24 antes de publicar, se tiver essa versão |
| Sem chave | O clone não tinha `.env`, e `OPENAI_API_KEY` não estava definida no ambiente da verificação. Nenhuma chamada à OpenAI foi feita |
| Quem executou | "agente": tudo o que está marcado como feito. "dono/pessoa externa": tudo o que está marcado como PENDENTE |

## 1. Segurança do repositório

Comandos rodados pelo agente no repositório local, que tinha 229 commits alcançáveis por `--all` (inclui os branches remotos já buscados; não inclui as referências de pull request, que o clone não traz).

| # | Verificação | Comando | Esperado | Obtido | Quem |
|---|---|---|---|---|---|
| S1 | Padrão de chave no histórico inteiro | `git log -p --all \| grep -cE 'sk-[A-Za-z0-9_-]{20,}'` | 22 linhas, todas falsos positivos | 22 linhas (detalhe na seção 1.1) | agente |
| S2 | `.env` adicionado em algum commit | `git log --all --diff-filter=A --name-only --format= \| grep -E '(^\|/)\.env'` | só `.env.example` | só `.env.example` (1 vez) | agente |
| S3 | Commits que tocam `.env` | `git log --all --format=%h -- .env \| wc -l` | 0 | 0 | agente |
| S4 | Commits que tocam PDF | `git log --all --format=%h -- '*.pdf' \| wc -l` | 0 | 0 | agente |
| S5 | Domínios dos e-mails de autor e de committer | `git log --all --format=%ae` e `--format=%ce`, cada um passado por `sed 's/.*@//' \| sort \| uniq -c` | domínios de endereço oculto do GitHub | Autor: `users.noreply.github.com` em 229 commits. Committer: `users.noreply.github.com` em 209 e `github.com` em 20 (committer do próprio GitHub nos merges feitos pela interface web) | agente |
| S6 | Arquivos versionados | `git ls-files` (226 arquivos) | sem symlink, PDF, binário, `.env` nem `logs/` | 0 symlinks (nenhum modo 120000, todos 100644); 0 arquivos com extensão de PDF, imagem (png, jpg, gif, ico), fonte, compactado (zip) ou executável (exe, dll, bin); todos os 226 são texto (`git grep -Il ''` lista os 226); 0 em `.env` ou `logs/` | agente |
| S7 | Varredura de segredos nos arquivos | `npm run check:secrets` no clone limpo | passa | "nenhuma credencial encontrada em 226 arquivos", código 0 | agente |
| S8 | Busca do valor da chave real no histórico | `git log -p --all \| Select-String -SimpleMatch $env:OPENAI_API_KEY \| Measure-Object` (PowerShell, no repositório local, com a chave do dono no ambiente) | 0 | PENDENTE: só o dono tem o valor da chave; o agente não a leu | dono |
| S9 | E-mail pessoal da conta em commits fora do clone | Achado do planejamento, não reconferido pelo agente | tratado | 3 commits do PR 1, acessíveis só por `refs/pull/1/head` no GitHub, com o e-mail pessoal da conta no autor e no committer. Não aparecem no repositório local nem no clone, e o agente não tentou buscar essas referências. Decisão do dono: não reescrever o histórico; criar um repositório novo e público só com a `main` e os branches, sem as referências de pull request | planner, dono |

### 1.1 As 22 linhas de S1

O comando conta linhas do histórico, em diff de adição e de remoção. O agente separou as 22 por categoria, sem copiar nenhuma sequência que se pareça com chave:

| Categoria | Linhas | Onde | Por que não é credencial |
|---|---|---|---|
| Palavra composta em inglês cujo segundo termo é "force" (o fim de uma palavra terminada em "sk", hífen e palavras comuns) | 16 | `tests/redact.test.ts` (11), `tests/secret-scan.test.ts`, `tests/helpers/key-placements.ts`, `src/security/redact.ts` (comentário), `CHANGELOG.md`, `docs/adr/0007-protecao-da-credencial.md` | Texto escrito de propósito nos testes e nos comentários da redação, para provar que palavras comuns não são redigidas |
| Palavras em português que começam com "abertu" depois de um hífen e do fim de uma palavra em "sk" | 3 | `tests/redact.test.ts` (2), `tests/helpers/key-placements.ts` (1) | Mesmo propósito: texto longo com hífen que não é chave |
| Nome de uma localidade russa em inglês (o texto que existe dentro do executável do Node) | 1 | `tests/redact.test.ts` | Caso de teste do ADR 0007 (binários legítimos não podem ser acusados) |
| Chave fictícia de teste, de sequência óbvia, com o prefixo de projeto | 2 | `tests/eval-markdown.test.ts` (ENG-57): uma linha de adição no commit `5ff3d4b` e a linha de remoção no commit `b95a354`, que passou a montar a chave em tempo de execução | Valor inventado (letras e dígitos em ordem), nunca foi uma credencial. São 2 linhas, mas 1 só chave; ela não existe mais no código atual |

Diferença em relação ao planejamento: o planejamento previu 21 palavras e 1 chave fictícia em `tests/redact.test.ts` (ENG-44). A contagem total confere (22), mas a chave fictícia está em `tests/eval-markdown.test.ts` (ENG-57) e conta 2 linhas, e as palavras são 20 linhas. Nada disso muda a conclusão.

## 2. Entregáveis E1 a E5

Conferido pelo agente no clone limpo. O teste `tests/readme.test.ts` confere os mesmos links a cada `npm test`.

| # | Entregável | Arquivo no repositório | Linkado no README | Conferência |
|---|---|---|---|---|
| E1 | Documento de políticas | `context/02-politicas.md` | sim | existe; P1 a P5 |
| E2 | Estrutura de contexto reutilizável | `context/` e `docs/REUSO.md` | sim | existem; o guia aponta para `tests/fixtures/minimal-context/` |
| E3 | Casos de teste | `docs/CASOS-DE-TESTE.md` | sim | existe; `npm run casos:doc` regenera sem diferença (12 casos) |
| E4 | Outputs gerados | `outputs/` | sim | 3 pastas de bateria (B0, B1, B2) e `outputs/evidencias/`; 10 arquivos versionados |
| E5 | Análise de comportamento | `docs/ANALISE.md` | sim | existe; números conferidos por `tests/analise-numeros.test.ts` |

Resultado: 5 de 5 presentes e ligados no README.

## 3. Itens T1 a T9

O roteiro do README (seção "Roteiro de demonstração") usa a chave nos passos que chamam o modelo. Esses passos são do dono ou da pessoa externa e estão PENDENTES. O agente executou, no clone limpo e sem chave, só os passos sem custo.

| # | Item do enunciado | Passo do roteiro | O que o agente executou (sem chave) | Resultado do agente | Passo com chave |
|---|---|---|---|---|---|
| T1 | Chatbot interativo em CLI | 1 e 6 | `npm run chat` sem chave; `npm run chat -- --help` | Sem chave: mensagem "Configuração incompleta: a variável OPENAI_API_KEY não está definida.", código 1. `--help` lista as 6 opções (`--system-prompt`, `--perfil`, `--context-dir`, `--verbose`, `--show-context`, `--help`), código 0 | PENDENTE: executa o dono com a chave (abrir o chat, saudação, `/sair` com código 0) |
| T2 | Implementado em TypeScript | n/a | Conferência no código | `tsconfig.json` com `strict: true`; `npm run typecheck` passou dentro de `npm run check` | n/a |
| T3 | Usando a OpenAI | n/a | Conferência no código | Dependência `openai`; toda chamada passa por `src/llm/client.ts` (teste de arquitetura) | O teste de fumaça de 16/11/2026 está no ADR 0002; nova execução PENDENTE se o dono quiser |
| T4 | System prompt customizável | 8 | `npm run chat -- --show-context --perfil bruno-lima` | O contexto sai com as quatro camadas e o perfil escolhido (`Nome: Bruno Lima`), código 0, sem chave. A parte de `--system-prompt` com resposta do modelo não foi executada | PENDENTE: executa o dono com a chave |
| T5 | Stream de resposta | 2 | nenhum | Streaming coberto por testes unitários (`npm test` passou) | PENDENTE: executa o dono com a chave |
| T6 | Histórico de conversa na sessão | 3 e 5 | nenhum | Histórico coberto por testes unitários | PENDENTE: executa o dono com a chave |
| T7 | Error handler com retry | 9 e 10 | `npm run demo:falhas` | Código 0, cinco cenários com resumo `CONFERE`; depois da execução, `git diff` e `git status` do clone ficaram vazios (a transcrição regravada é idêntica à versionada) | Passo 9 (chave inválida contra a API real) PENDENTE: executa o dono ou a pessoa externa |
| T8 | Rate limit | 7 e 10 | `npm run demo:falhas` (T8a) | Cenários 429 com e sem `Retry-After` conferem | Passo 7 (T8b, `RATE_LIMIT_MAX_REQUESTS=1` no chat real) PENDENTE: executa o dono com a chave |
| T9 | Self-critique | 2 e 4 | nenhum | Autoavaliação coberta por testes unitários e pelas três baterias versionadas | PENDENTE: executa o dono com a chave |

Outros passos sem custo executados pelo agente no clone limpo:

| Comando | Resultado |
|---|---|
| `npm run contexto` | Código 0, 277 linhas, as quatro camadas delimitadas (abertura de cada uma presente) |
| `npm run chat -- --show-context` | Código 0, sem `.env` e sem chave |
| `npm run casos:doc` | "Gerado docs/CASOS-DE-TESTE.md (12 casos).", sem diferença no `git diff` |

Resultado do dono ou da pessoa externa, ao executar o roteiro com a chave (PENDENTE):

| Campo | Valor |
|---|---|
| Pessoa que executou o roteiro a partir do README, sem ter participado do projeto | PENDENTE. Papel: PENDENTE. O nome só entra com o consentimento da pessoa |
| Data da execução | PENDENTE |
| Tempo total do roteiro | PENDENTE (o README diz que o roteiro não foi cronometrado) |
| T1, T4, T5, T6, T7 (passo 9), T8(b) e T9 vistos como descrito | PENDENTE |
| Dificuldades encontradas no README | PENDENTE |

## 4. Clone limpo

Feito pelo agente em um clone do repositório local, ramo `main`, commit `d261f41`.

| Passo | Comando | Resultado |
|---|---|---|
| Clone | `git clone <repositório local> <pasta ASCII> -b main` | `d261f41` |
| Instalação | `npm ci` | código 0. O npm avisa que scripts de instalação (do `esbuild`) não foram executados; isso não impediu nenhum comando seguinte |
| Portão | `npm run check` | código 0: lint, typecheck, 90 arquivos de teste e 3161 testes aprovados, e varredura de segredos |
| Segredos | `npm run check:secrets` | código 0: nenhuma credencial em 226 arquivos |

O mesmo `npm run check` deve ser rodado de novo, pelo CI, sobre o commit do squash do PR. O resultado do `npm run check` sobre o último commit do branch da ENG-61 consta no relatório do agente que implementou esta issue, não neste arquivo (o arquivo não pode conter o SHA do commit que o contém).

## 5. ADRs

Os sete ADRs foram conferidos contra o código por amostragem das afirmações que podem ser testadas (modelo e parâmetros do cliente, `maxRetries: 0`, leitor único do ambiente, classificação de erros e teto de espera, criadores do cliente real, formato da linha de `execucoes.jsonl`, ordem da bateria, `.gitignore`, loaders e builder). Não foi uma releitura linha a linha de todo o texto.

| ADR | Status antigo | Status novo | Divergência com o código |
|---|---|---|---|
| 0001 Stack e ferramentas | proposta (16/11/2026) | aceita (18/11/2026) | Consequências obsoletas corrigidas (workflow que "passa sem executar" e Node ausente do PATH) |
| 0002 Modelo e API da OpenAI | proposta (16/11/2026) | aceita (18/11/2026) | A decisão 11 listava 2 criadores do cliente real e o código tem 4 (`src/cli/main.ts`, `scripts/eval.ts`, `scripts/demo-falhas/run.ts`, `scripts/smoke-llm.ts`); a decisão 3 se contradizia sobre a confirmação do dono. Texto corrigido e registrado no próprio ADR. Ressalva mantida: `phase` e `output_index` não observados contra a API real |
| 0003 Contexto em quatro camadas | proposta (16/11/2026) | aceita (18/11/2026) | Nenhuma. Nota: `--context-dir` não vale para `npm run contexto` nem para `npm run eval` (já dito em `docs/REUSO.md`) |
| 0004 Streaming e self-critique | aceita (17/11/2026); implementada na ENG-53 | sem mudança | Divergências já registradas na nota de implementação do próprio ADR |
| 0005 Retry, rate limit e evidências | proposta (16/11/2026) | aceita (18/11/2026) | Nenhuma. O 429 real do provedor nunca foi observado; a evidência é a demonstração local |
| 0006 Runner e outputs | proposta (16/11/2026) | aceita (18/11/2026) | Os desvios do formato da linha já estão nas notas de implementação (ENG-56 e ENG-57); o veredito tem 3 camadas na prática |
| 0007 Proteção da credencial | proposta (16/11/2026) | aceita (18/11/2026) | Nenhuma. Registrado o resultado da varredura do histórico (decisão 7) |

Também atualizados: o status de `docs/ARQUITETURA.md` ("APROVADA e implementada (18/11/2026)") e as divergências verificadas dela (6 opções de linha de comando, árvore de pastas, executáveis, custo marcado como estimativa).

## 6. Campos PENDENTES do dono

| Campo | Onde | Situação |
|---|---|---|
| Conferência manual final das respostas (ENG-58) | `docs/ANALISE.md`, seções 5 e Apêndice B | PENDENTE: data e confirmação do dono |
| Custo real das baterias B0, B1 e B2 | `docs/ANALISE.md`, seção 9 | PENDENTE: a preencher pelo dono, a partir do painel da OpenAI |
| Roteiro do README executado por pessoa externa, com a chave | seção 3 deste arquivo | PENDENTE |
| Busca do valor da chave real no histórico (S8) | seção 1 deste arquivo | PENDENTE |
| Busca pelo nome fictício "Orvalia" | README, seção "Dados fictícios" | PENDENTE: busca feita pelo dono antes de publicar. O agente não fez nenhuma busca e não afirma resultado |
| URL e data da publicação | seção 7 | PENDENTE |
| Formato de entrega (pergunta em aberto do PRD: link do repositório, arquivo compactado ou vídeo) | `docs/PRD.md`, Perguntas em aberto | PENDENTE: a premissa continua sendo o link do repositório público; se o formato mudar, o empacotamento é um passo do dono |

## 7. Publicação (PENDENTE)

Decisões do dono, já tomadas:

1. O histórico não é reescrito. Será criado um repositório novo e público só com a `main` e os branches, sem as referências de pull request. O repositório atual fica privado, como arquivo. Os pull requests, que são a evidência de revisão e de QA, ficam nesse arquivo privado.
2. O projeto fica sem licença: todos os direitos reservados. Não existe `LICENSE` nem o campo `license` no `package.json`.
3. Os dados da empresa e das pessoas são fictícios (aviso no README).

Marcas para o dono, ao publicar:

- [ ] Preencher `<URL-DESTE-REPOSITORIO>` no passo "Obter o código" do README.
- [ ] Trocar, no README, a frase "O repositório será público" por uma forma no presente que não use a expressão "repositório é público" (por exemplo, "O repositório está público"), porque `tests/readme.test.ts` recusa essa expressão (o teste existe para barrar um resquício da primeira versão). Se preferir a expressão proibida, o teste também precisa mudar.
- [ ] Empurrar ao repositório novo só `main` e os branches (`refs/heads`), com refspec explícito: `git push <novo> 'refs/heads/*:refs/heads/*'`. Nunca `--all`, `--mirror` nem referências de pull request.
- [ ] Depois do push, no repositório NOVO: repetir `git log -p --all | grep -cE 'sk-[A-Za-z0-9_-]{20,}'` (esperado 22, as mesmas falsas positivas de S1) e a busca do valor da chave real (S8).
- [ ] No repositório novo, conferir autores e committers com `git log --all --format='%ae %ce'` (olhar só os domínios: devem ser os de endereço oculto do GitHub, como em S5) e, com `git ls-remote <novo>`, que aparece só `refs/heads` (nenhum `refs/pull`).
- [ ] Conferir que o repositório novo não é um fork e não tem pull requests nem issues importadas.
- [ ] Manter o repositório atual como Private (não torná-lo público depois) e, se couber, pedir ao suporte do GitHub a remoção de caches de referências órfãs.
- [ ] Cruzar com S9: o agente não buscou as referências de pull request (`refs/pull`); esta lista é o que garante que elas não chegam ao repositório novo.
- [ ] Rodar a busca pelo nome "Orvalia".
- [ ] Registrar abaixo a URL e a data.

| Campo | Valor |
|---|---|
| URL do repositório público | PENDENTE |
| Data da publicação | PENDENTE |
| Resultado de `git ls-remote` (sem `refs/pull`) | PENDENTE |
