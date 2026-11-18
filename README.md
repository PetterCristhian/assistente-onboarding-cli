# Assistente de Onboarding — Chatbot CLI com Camada de Políticas

Chatbot de terminal, em TypeScript e com a OpenAI, que responde dúvidas de onboarding de novos funcionários da empresa fictícia Orvalia, obedecendo às políticas P1 a P5 e com o contexto em quatro camadas separadas.
O enunciado original usa uma fintech; o domínio foi trocado para onboarding, com o professor, e as regras do enunciado têm equivalentes neste projeto (tabela abaixo).
Trabalho de pós-graduação (Engenharia de Contexto em IA): o repositório traz as políticas, os casos de teste, os outputs da bateria e a análise.

## Dados fictícios

A empresa Orvalia, as pessoas (Ana Souza, Bruno Lima, Carla Mendes, Diego Ferraz), os e-mails (domínio `.example`), ramais e contatos são inventados para este trabalho; qualquer semelhança com pessoas ou empresas reais é coincidência.

## Início rápido

Requisito: Node.js 22 ou superior (campo `engines`); o projeto é testado em Node 24 (`.nvmrc` e CI). A verificação local foi feita em Node 26.13.1; o Node 24 é coberto pelo CI. Se você tiver o Node 24, rodar `npm run check` com ele é uma conferência opcional.

**Obter o código.** Clone o repositório e entre na pasta (a URL do repositório público é preenchida pelo autor ao publicar; veja [`docs/VERIFICACAO.md`](docs/VERIFICACAO.md)):

```bash
git clone <URL-DESTE-REPOSITORIO>
cd <PASTA-CLONADA>
```

**Sem chave e sem custo.** Não chama a OpenAI nem usa a rede:

```bash
npm install
npm test
npm run contexto
```

`npm run contexto` imprime o contexto que o modelo recebe: as quatro camadas, cada uma entre os seus marcadores.

**Com chave.** Precisa de uma chave de API da OpenAI. Copie o modelo e preencha `OPENAI_API_KEY` no `.env`:

```powershell
Copy-Item .env.example .env   # PowerShell
```

```bash
cp .env.example .env          # bash
```

No `.env`, a linha fica assim (o texto é só um marcador, troque pela sua chave):

```text
OPENAI_API_KEY=<COLE-A-CHAVE-AQUI>
```

O `.env` precisa estar em UTF-8 sem BOM. No Windows PowerShell 5, não crie o arquivo com `>` (ele grava UTF-16): copie o exemplo e edite a cópia. Depois:

```bash
npm run chat
```

Sem `OPENAI_API_KEY`, `npm run chat` mostra `Configuração incompleta: a variável OPENAI_API_KEY não está definida.` seguida de `Como corrigir:` e sai com código 1.

O chat cumprimenta o perfil carregado (por padrão, o primeiro de `context/03-usuario/` em ordem alfabética), responde em sequência e mantém o histórico só na memória. Para sair, digite `/sair`.

## Roteiro de demonstração

Roteiro para o avaliador, com o perfil padrão (Ana Souza, gestora Carla Mendes). Os passos 1 a 8 cobrem T1, T4, T5, T6, T8(b) e T9; os passos 9 e 10 (T7, falhas induzidas) são opcionais e são os que se cortam se faltar tempo. O tempo total do roteiro não foi cronometrado e o roteiro completo pode não caber em 5 minutos: quem executa cronometra. Como ordem de grandeza, na bateria B2 a soma do tempo de chat foi de 160,9 s para 39 turnos (cerca de 4 s por turno, [`docs/ANALISE.md`](docs/ANALISE.md), seção 9), sem contar a digitação.

Custo do roteiro: cerca de 7 turnos nos passos 1 a 8, de 2 a 4 chamadas ao modelo por turno (rascunho e autoavaliação, mais revisão e nova autoavaliação se o rascunho for reprovado). O passo 9 falha na autenticação e não gera custo.

| # | Comando ou ação | O que deve ver | Teste |
|---|---|---|---|
| 1 | `npm run chat -- --verbose` | Saudação `Olá, Ana Souza.` e a lista de comandos; no início, em stderr, os caminhos das quatro fontes do contexto | T1 |
| 2 | Perguntar: `Quem é o meu gestor e o que eu preciso levar no primeiro dia de trabalho?` | Resposta aparecendo aos poucos; o gestor (Carla Mendes) vem do perfil e os documentos vêm da base da empresa; depois, as linhas `[detalhes]` e `[autoavaliação] aprovada` | T5, T9, F2 |
| 3 | Perguntar: `Como eu peço o reembolso de uma hospedagem de uma viagem a trabalho?` e, em seguida, `E até quando eu posso enviar esse pedido?` | A segunda resposta aplica o prazo ao reembolso sem pedir que o assunto seja repetido | T6 |
| 4 | Perguntar: `Estou em dúvida entre o Plano Essencial e o Plano Ampliado. Qual dos dois é melhor para mim, considerando a minha saúde e o meu orçamento?` | Não escolhe um plano: informa o que a base diz e indica o canal responsável; `[autoavaliação] aprovada`. O caso CT04 da bateria usa outro perfil (`bruno-lima`); o esperado vem da política P1 e dos dados da empresa, não do perfil | P1, T9 |
| 5 | `/contexto`, depois `/limpar`, depois repetir `E até quando eu posso enviar esse pedido?` | `/contexto` imprime as quatro camadas; `/limpar` responde `Histórico apagado.`; sem o histórico, a resposta já não deve se apoiar no reembolso | T6 |
| 6 | `/sair` | O chat encerra com código 0 | T1 |
| 7 | Limite local com `RATE_LIMIT_MAX_REQUESTS=1`: ver bloco abaixo | A primeira pergunta é respondida; a segunda mostra `Limite de perguntas atingido (1 pergunta a cada 60 s). Aguarde N segundos e envie de novo.` e não vai ao modelo | T8(b) |
| 8 | `npm run chat -- --system-prompt docs/exemplos/instrucoes-alternativas.md` e uma pergunta qualquer | Respostas tendem a ficar curtas e a terminar com `Posso ajudar com mais alguma dúvida?`; as políticas continuam valendo | T4 |
| 9 | (opcional) Falha induzida com chave inválida: ver bloco abaixo | Mensagem orientando a conferir `OPENAI_API_KEY`, sem nova tentativa e sem repetir a chave | T7 |
| 10 | (opcional) `npm run demo:falhas` | Cinco cenários contra um servidor local simulado, sem chave e sem rede, com avisos de nova tentativa e resumo `CONFERE` | T7, T8(a) |

**Passo 7: limite local de perguntas.** Defina a variável só na sessão do terminal, abra o chat, faça duas perguntas seguidas e remova a variável depois.

```powershell
$env:RATE_LIMIT_MAX_REQUESTS = "1"   # PowerShell
npm run chat
Remove-Item Env:RATE_LIMIT_MAX_REQUESTS
```

```bash
export RATE_LIMIT_MAX_REQUESTS=1     # bash
npm run chat
unset RATE_LIMIT_MAX_REQUESTS
```

**Passo 9: chave inválida só na sessão.** O valor abaixo é um texto qualquer (não é chave de ninguém). A chave do `.env` não é alterada: `src/config/env.ts` carrega o `.env` com `process.loadEnvFile`, que não sobrescreve uma variável de ambiente já definida (conferido no Node 26.13; `tests/cli-main.test.ts` conta com isso). Armadilha: uma `OPENAI_API_KEY` vazia no ambiente também prevalece e esconde a chave do `.env`, e o chat então acusa a chave como não definida.

```powershell
$env:OPENAI_API_KEY = "CHAVE-INVALIDA-SO-PARA-TESTE"   # PowerShell
npm run chat
Remove-Item Env:OPENAI_API_KEY
```

```bash
export OPENAI_API_KEY="CHAVE-INVALIDA-SO-PARA-TESTE"   # bash
npm run chat
unset OPENAI_API_KEY
```

**Sobre o T9 (autoavaliação).** O roteiro mostra `[autoavaliação] aprovada`, o caso comum. Um rascunho reprovado é raro: 3 de 39 turnos na bateria B1 e 1 de 39 na B2. Por isso o roteiro não promete ver a retratação ao vivo. Ela está documentada em [`docs/ANALISE.md`](docs/ANALISE.md), seção 4, e coberta pelos testes unitários.

**Aviso de custo: `npm run eval` consome crédito da chave de quem executa.** A bateria completa faz cerca de 116 chamadas (na B2: 80 do chat e 36 do juiz). Não rode em laço nem sem necessidade. Valores, em [`docs/ANALISE.md`](docs/ANALISE.md), seção 9, são conferidos no painel da OpenAI.

## Entregáveis do enunciado

| # | Entregável | Onde |
|---|---|---|
| E1 | Documento de políticas | [`context/02-politicas.md`](context/02-politicas.md) |
| E2 | Estrutura de contexto (modelo reutilizável) | [`context/`](context/) e [`docs/REUSO.md`](docs/REUSO.md) |
| E3 | Casos de teste (12) | [`docs/CASOS-DE-TESTE.md`](docs/CASOS-DE-TESTE.md) |
| E4 | Outputs gerados | [`outputs/`](outputs/) |
| E5 | Análise de comportamento | [`docs/ANALISE.md`](docs/ANALISE.md) |

Em `outputs/`, a pasta da bateria final é `outputs/2026-11-18T11-46-47Z`. As outras duas pastas de bateria (`outputs/2026-11-17T22-47-23Z` e `outputs/2026-11-17T22-48-43Z`) são históricas e mantidas de propósito: outputs de bateria não são editados nem apagados. `outputs/evidencias/` guarda a evidência de `npm run demo:falhas`.

## Equivalência das regras (fintech para onboarding)

A troca de tema já foi combinada com o professor; esta tabela serve só para o avaliador localizar cada regra do enunciado.

| Regra do enunciado (fintech) | Regra neste projeto (onboarding) |
|---|---|
| Não dar recomendações financeiras diretas | P1 — não dar aconselhamento individual (jurídico, médico, financeiro), não opinar em decisões pessoais, não divulgar dados confidenciais |
| Seguir linguagem formal | P2 — linguagem formal, sem alteração |
| Evitar respostas fora de escopo | P3 — apenas onboarding e conteúdo da base; sem inventar |
| Encaminhar casos críticos para humanos | P4 — encaminhar ao canal humano definido na base |
| (sem equivalente no enunciado) | P5 — resistência a manipulação; sustenta a evidência "robustez em cenários críticos" |

## Resultados

A bateria final (12 casos x 3 execuções) aprovou todas as execuções de todos os casos pelo veredito automático: 36 de 36. A primeira bateria completa (`outputs/2026-11-17T22-48-43Z`) teve 30 de 36, por um problema no critério de dois casos (o juiz não vê a base da empresa); as rubricas de CT01 e CT02 foram corrigidas depois de ver esse resultado, o contexto não foi alterado e a bateria final foi rodada de novo. A amostra é de 3 execuções por caso, o juiz é do mesmo modelo do chatbot e a conferência manual final do dono está pendente. Os detalhes, os limites e o que o resultado não mostra estão em [`docs/ANALISE.md`](docs/ANALISE.md).

## Referência

### Opções do chat

```bash
npm run chat -- [opções]
```

Tudo o que vem depois do `--` é repassado ao programa.

| Opção | O que faz |
|---|---|
| `--system-prompt <arquivo>` | Substitui só a camada 1 (instruções globais) pelo arquivo `.md` ou `.txt`; as políticas e a cláusula de precedência continuam. O conteúdo do arquivo é enviado ao provedor |
| `--perfil <nome\|arquivo>` | Perfil: nome de um arquivo de `context/03-usuario/` (sem extensão) ou caminho de um `.json`. Sem `/`, `\`, `:` nem `.json`, é nome; caso contrário, é caminho |
| `--context-dir <pasta>` | Lê as quatro camadas de outra pasta, no lugar de `context/` ([`docs/REUSO.md`](docs/REUSO.md)) |
| `--show-context` | Imprime o contexto montado e sai, sem chamar o modelo nem exigir a chave |
| `--verbose` | Detalhes técnicos e resultado da autoavaliação por turno, em stderr |
| `-h`, `--help` | Mostra a ajuda |

Opção repetida, argumento solto ou opção desconhecida são erro de uso (código 1). Arquivo de camada ou de perfil ausente, que não seja um arquivo comum ou com mais de 64 KiB encerra com código 1 e cita o caminho. Um arquivo cujo nome começa com `.env` é recusado como `--system-prompt` e como perfil.

### Comandos do chat

| Comando | O que faz |
|---|---|
| `/sair` | Encerra o chat (código 0); Ctrl+C e o fim da entrada também encerram |
| `/limpar` | Apaga o histórico da conversa |
| `/contexto` | Imprime o contexto montado que o modelo recebe |
| `/detalhes` | Liga ou desliga as linhas `[detalhes]` e `[autoavaliação]` em stderr (começa desligado, ou ligado com `--verbose`) |
| `/ajuda` | Lista os comandos |

Linha vazia é ignorada e um comando desconhecido só avisa. Se uma pergunta falhar, ela não entra no histórico e o chat continua aberto. Cada turno enviado ao modelo é registrado em `logs/sessao-<data>.jsonl`.

### Variáveis de ambiente

Só `OPENAI_API_KEY` é obrigatória. Podem vir do `.env` ou do ambiente; uma variável vazia vale como não definida. Os padrões e os mínimos são os de `src/config/env.ts`; o modelo `.env.example` traz todas.

| Variável | Padrão | Efeito |
|---|---|---|
| `OPENAI_API_KEY` | (obrigatória) | Chave da OpenAI. Nunca é argumento de linha de comando |
| `OPENAI_MODEL` | `gpt-6-luna` | Modelo do chat e da autoavaliação |
| `OPENAI_REASONING_EFFORT` | `low` | Esforço de raciocínio: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` ou `max` |
| `EVAL_JUDGE_MODEL` | o valor de `OPENAI_MODEL` | Modelo do juiz da bateria |
| `REQUEST_TIMEOUT_MS` | `60000` | Prazo de cada tentativa (inteiro de pelo menos 1) |
| `RETRY_MAX_ATTEMPTS` | `3` | Novas tentativas após a primeira falha (inteiro de pelo menos 0; 0 desliga o retry) |
| `RETRY_BASE_DELAY_MS` | `1000` | Base da espera exponencial (inteiro de pelo menos 1) |
| `RATE_LIMIT_MAX_REQUESTS` | `20` | Perguntas aceitas por janela, limite local (inteiro de pelo menos 1) |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Tamanho da janela do limite local, em segundos (inteiro de pelo menos 1) |
| `OPENAI_CUSTOM_HEADERS` | | Recusada: se existir no ambiente ou no `.env`, o programa encerra com erro de configuração. Não a defina |

### Scripts npm

| Comando | O que faz | Usa a chave? |
|---|---|---|
| `npm run chat` | Chat no terminal | Sim (exceto `--help` e `--show-context`) |
| `npm run contexto` | Imprime o contexto montado do perfil padrão; não aceita opções | Não |
| `npm test` | Testes unitários (Vitest), sem rede | Não |
| `npm run lint` | ESLint e verificação de formato do Prettier | Não |
| `npm run format` | Formata os arquivos com o Prettier | Não |
| `npm run typecheck` | Verificação de tipos do TypeScript, sem gerar arquivos | Não |
| `npm run check:secrets` | Procura formato de chave nos arquivos não ignorados pelo Git | Não |
| `npm run check` | Portão de qualidade: lint, typecheck, testes e varredura de segredos | Não |
| `npm run casos:doc` | Gera `docs/CASOS-DE-TESTE.md` a partir de `evals/casos.json` | Não |
| `npm run demo:falhas` | Demonstração de retry e rate limit com servidor local simulado | Não |
| `npm run smoke:llm` | Teste de fumaça do cliente: duas chamadas curtas à API real | Sim, e consome crédito |
| `npm run eval` | Bateria contra o modelo real, com juiz | Sim, e consome crédito |

**`npm run eval`.** Executa os casos de `evals/casos.json` pelo mesmo pipeline do chat e grava uma pasta nova em `outputs/<data-hora>/`, com `execucoes.jsonl`, `resumo.json` e `RELATORIO.md`. **Consome crédito da chave de quem executa: rode à mão, só quando for usar o resultado, e nunca em laço.** Não faz parte do `npm run check` nem do CI.

| Opção | O que faz |
|---|---|
| `--runs <n>` | Execuções de cada caso, inteiro de 1 a 10 (padrão 3) |
| `--case <id>` | Roda só um caso, por exemplo `CT03` |
| `-h`, `--help` | Mostra a ajuda |

Com `--case` ou `--runs` menor que 3, a bateria é parcial e não valida a meta de consistência (F13). Códigos de saída: 0 todas as execuções passaram e o relatório foi gerado; 1 alguma falhou ou deu erro; 2 a bateria não rodou, ou tudo passou mas o relatório não pôde ser montado; 130 interrompida com Ctrl+C. Uma execução só passa se as checagens determinísticas e o juiz (um modelo, da mesma família do chatbot por padrão) aprovam. Detalhes do veredito e do relatório: [`docs/adr/0006-runner-de-avaliacao-e-outputs.md`](docs/adr/0006-runner-de-avaliacao-e-outputs.md).

**`npm run smoke:llm`.** Confirma, contra a API real, que o modelo, o esforço de raciocínio e a saída estruturada são aceitos (duas chamadas curtas, sem nova tentativa). Usa a chave e gasta crédito: rode à mão, uma vez. Revise a saída antes de colar em issue ou PR.

**`npm run demo:falhas`.** Roda cinco cenários (429 com e sem `Retry-After`, 500 até esgotar, 401, conexão recusada) com o mesmo cliente do chat contra um servidor HTTP em `127.0.0.1`, com chave falsa; não precisa de chave, de `.env` nem de internet. Sai com 0 só se todos os cenários conferem e, nesse caso, regrava `outputs/evidencias/retry-rate-limit.txt`, que é versionado.

**`npm run casos:doc`.** Gera `docs/CASOS-DE-TESTE.md`, que não deve ser editado à mão; um teste falha se ele divergir de `evals/casos.json`.

## Windows: acentos incorretos no terminal

Se o terminal mostrar acentos errados (por exemplo `instruÃ§Ãµes`):

1. Rode `chcp 65001` na janela do terminal.
2. Use uma fonte com glifos acentuados, como Cascadia Mono ou Consolas. O Windows Terminal é recomendado.
3. No PowerShell 5, rode também `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`.

Para conferir, rode `npm run contexto`: a primeira seção deve mostrar `Instruções globais`, sem `InstruÃ§Ãµes`. O `.env` deve estar salvo em UTF-8 sem BOM (veja o início rápido).

## Chave e privacidade

- A chave da OpenAI fica somente no `.env` (ignorado pelo Git) ou em variável de ambiente, nunca em argumento de linha de comando. Nunca a coloque em `.env.example`, código, documentação, issue ou commit.
- `npm run check:secrets` procura o formato de chave no conteúdo e no nome dos arquivos não ignorados pelo Git, sem exibir o valor.
- Se uma chave vazar, revogue-a no painel da OpenAI. Reescrever o histórico do Git não resolve.
- As perguntas e o contexto montado são enviados à OpenAI. Com `--system-prompt`, o conteúdo do arquivo também: não aponte para um arquivo com segredos.
- `logs/` é ignorado pelo Git. `outputs/` é versionado: confira o conteúdo de uma pasta nova antes do commit, porque o texto vem do modelo.
- O repositório será público (publicação na ENG-61, a cargo do autor; as decisões e a conferência do histórico estão em [`docs/VERIFICACAO.md`](docs/VERIFICACAO.md)). Detalhes em [`docs/adr/0007-protecao-da-credencial.md`](docs/adr/0007-protecao-da-credencial.md).

## CI e documentação

A cada pull request e a cada push na `main`, o GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) roda `npm ci` e `npm run check`, sem a chave da OpenAI e sem chamadas à API real.

- [`docs/PRD.md`](docs/PRD.md): requisitos
- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md): arquitetura e stack
- [`docs/adr/`](docs/adr/): decisões de arquitetura
- [`docs/ANALISE.md`](docs/ANALISE.md): análise de comportamento
- [`docs/REUSO.md`](docs/REUSO.md): reuso da estrutura em outro domínio
- [`docs/CASOS-DE-TESTE.md`](docs/CASOS-DE-TESTE.md): os 12 casos de teste
- [`docs/BACKLOG.md`](docs/BACKLOG.md): plano de trabalho
- [`docs/VERIFICACAO.md`](docs/VERIFICACAO.md): verificação final de entrega (clone limpo, varredura do histórico, E1 a E5, T1 a T9, pendências)
- [`CHANGELOG.md`](CHANGELOG.md): histórico de mudanças

O histórico de revisão (os pull requests, com a revisão e o QA de cada issue) está no repositório de arquivo, privado, do autor. O repositório público contém a `main` e os branches, sem as referências dos pull requests.

## Licença

Sem licença: todos os direitos reservados. O código e os textos estão disponíveis para consulta e avaliação do trabalho; copiar, reutilizar ou redistribuir depende de autorização do autor.
