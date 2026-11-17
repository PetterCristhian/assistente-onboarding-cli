# Assistente de Onboarding — Chatbot CLI com Camada de Políticas

Chatbot de terminal em TypeScript, com a OpenAI, que responde dúvidas de onboarding de uma empresa fictícia obedecendo a um conjunto de políticas (P1–P5), com o contexto organizado em quatro camadas separadas e evidências de teste versionadas. Trabalho de pós-graduação (Engenharia de Contexto em IA).

> **Estado:** projeto em construção. Este README é o inicial; o guia completo de uso, com roteiro de demonstração, é a issue 18 de [`docs/BACKLOG.md`](docs/BACKLOG.md). Com o esqueleto (issue 1) e a configuração por ambiente (issue 2) implementados, já funcionam `npm test`, `npm run check` (que agora inclui a varredura de segredos, `npm run check:secrets`) e `npm run chat`. Com os carregadores e o montador de contexto (issue 5), funciona também `npm run contexto`, que não precisa da chave. Com o cliente da OpenAI (issue 6), existe o teste de fumaça `npm run smoke:llm`, que usa a chave e gasta crédito. Com o chat (ENG-49) e as opções de inicialização (ENG-50), o `npm run chat` aceita `--system-prompt`, `--perfil`, `--context-dir`, `--show-context` e `--verbose`. O `npm run chat` exige `OPENAI_API_KEY` no `.env` ou no ambiente, exceto com `--help` e `--show-context`, que não precisam da chave. Com a demonstração de falhas (ENG-54), `npm run demo:falhas` funciona sem chave e sem rede. Os demais comandos chegam nas issues seguintes.

## Requisitos

- Node.js 22 ou superior (recomendado: 24, a versão indicada em `.nvmrc`)
- npm (já vem com o Node)
- Uma chave de API da OpenAI, apenas para conversar com o modelo e rodar a bateria de avaliação. Os testes unitários não precisam dela.

## Como rodar localmente

```bash
npm install
```

Crie o arquivo `.env` a partir do exemplo e preencha `OPENAI_API_KEY`:

```powershell
Copy-Item .env.example .env   # PowerShell
```

```bash
cp .env.example .env          # bash
```

O `.env` precisa estar em UTF-8 sem BOM. No Windows PowerShell 5, não crie o arquivo com `>` (ele grava UTF-16): copie o exemplo e edite a cópia.

Depois:

```bash
npm run chat
```

O chat cumprimenta o perfil carregado, mostra a lista de comandos e responde em sequência, com a resposta aparecendo aos poucos. Uma pergunta de acompanhamento considera os turnos anteriores; o histórico fica só na memória e some ao sair. Comandos dentro do chat:

| Comando | O que faz |
|---|---|
| `/sair` | Encerra o chat (código 0). Ctrl+C e o fim da entrada também encerram, sem mensagem de erro |
| `/limpar` | Apaga o histórico da conversa |
| `/contexto` | Imprime o contexto montado que o modelo recebe |
| `/detalhes` | Liga ou desliga, no meio da conversa, as linhas `[detalhes]` e `[autoavaliação]` em stderr após cada resposta (começa desligado, ou ligado com `--verbose`). Não vai ao modelo e não consome vaga do limite de perguntas |
| `/ajuda` | Lista os comandos |

Linha vazia é ignorada e um comando desconhecido só avisa, sem chamar o modelo. Se uma pergunta falhar, ela não entra no histórico e o chat continua aberto.

### Autoavaliação das respostas (ENG-53)

Toda resposta é verificada contra as políticas P1 a P5 antes de ser guardada no histórico. O rascunho aparece aos poucos; em seguida, uma chamada separada avalia o texto. Se for aprovado, ele é a resposta final. Se for reprovado, o chat avisa em stdout que a resposta acima foi retirada, com a regra violada, e prepara uma única revisão, que só é exibida depois de também ser aprovada. Se a revisão for reprovada, ou se a verificação falhar (erro, saída inválida, recusa), o chat mostra a mensagem segura de `context/fallback.md`. O histórico só guarda texto aprovado ou essa mensagem. Cada turno faz no máximo 4 chamadas ao modelo e consome uma só vaga do limite de perguntas. Os prompts do avaliador e da revisão ficam em `context/avaliador.md` e `context/revisao.md`.

Cada turno enviado ao modelo é registrado em `logs/sessao-<data>.jsonl` (uma linha JSON por turno, com rascunho, parecer, origem da resposta final e regra violada; o escritor único redige as credenciais). A pasta `logs/` é ignorada pelo Git. Uma falha ao gravar o log é avisada uma vez e não interrompe o chat.

### Opções de inicialização

```bash
npm run chat -- [opções]
```

| Opção | O que faz |
|---|---|
| `--system-prompt <arquivo>` | Substitui só a camada 1 (instruções globais) pelo arquivo `.md` ou `.txt`. As políticas e a cláusula de precedência continuam no contexto. **O conteúdo do arquivo é enviado ao provedor**, como qualquer instrução: não aponte para um arquivo com segredos |
| `--perfil <nome\|arquivo>` | Troca a camada 3. Sem `/`, `\`, `:` nem extensão `.json`, é o nome de um perfil de `03-usuario/` (por exemplo `--perfil nome-do-perfil`); caso contrário é o caminho de um arquivo `.json`, a partir da pasta atual. Um nome nunca vira caminho, nem o contrário |
| `--context-dir <pasta>` | Lê as quatro camadas de outra pasta com a mesma estrutura de `context/` |
| `--show-context` | Imprime o contexto final, respeitando as outras opções, e sai com código 0. Não chama o modelo, não lê o `.env` e não exige a chave |
| `--verbose` | Detalhes técnicos em stderr: no início, os caminhos das quatro fontes do contexto; depois de cada resposta, uma linha `[detalhes]` com modelo, trechos, tokens (soma das chamadas do turno) e tempo, e uma linha `[autoavaliação]` com o resultado (`aprovada`, ou `reprovada: P2 (motivo); origem=revisao; chamadas=4`). Nunca imprime o contexto, a pergunta nem a chave. Equivale a começar com `/detalhes` ligado |
| `-h`, `--help` | Lista as opções |

A chave da API **não é** uma opção: ela vem só de `OPENAI_API_KEY` (`.env` ou ambiente), para não ficar no histórico do shell. Opção repetida, argumento solto ou opção desconhecida são erro de uso (código 1, com a dica `Use --help`). Arquivo de perfil, de instruções ou de camada que não exista, não seja um arquivo comum ou passe de 64 KiB também encerra com código 1 e uma mensagem que cita o caminho. Um arquivo cujo nome começa com `.env` é recusado como `--system-prompt` e como perfil.

Com `npm run chat --`, tudo o que vem depois do `--` é repassado ao programa.

Para ver o contexto que o modelo recebe, sem a chave e sem acesso à rede:

```bash
npm run contexto
```

O comando imprime as quatro camadas de `context/`, cada uma entre os seus marcadores e sempre na mesma ordem: `<instrucoes_globais>`, `<politicas>`, `<dados_do_usuario>` e `<dados_da_empresa>`. Ele não aceita opções e usa o perfil padrão, que é o primeiro de `context/03-usuario/` em ordem alfabética. Para escolher o perfil, as instruções ou a pasta de contexto, use `npm run chat -- --show-context` com as opções acima, por exemplo `npm run chat -- --show-context --perfil nome-do-perfil`. Se um arquivo de camada estiver ausente, vazio ou inválido, o comando encerra com código 1 e uma mensagem que cita o caminho esperado.

As demais variáveis são opcionais e estão descritas em `.env.example` e na seção 7 de [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md). As que governam falhas do provedor:

| Variável | Padrão | Efeito |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | `60000` | Prazo de **cada tentativa**, não da pergunta inteira |
| `RETRY_MAX_ATTEMPTS` | `3` | Novas tentativas após a primeira falha (0 desliga o retry) |
| `RETRY_BASE_DELAY_MS` | `1000` | Base da espera exponencial (cerca de 1 s, 2 s, 4 s, com até 20% de variação; no máximo 30 s) |
| `RATE_LIMIT_MAX_REQUESTS` | `20` | Perguntas aceitas por janela (limite local, inteiro de pelo menos 1; `0` é erro de configuração) |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Tamanho da janela do limite local, em segundos (inteiro de pelo menos 1) |
| `OPENAI_CUSTOM_HEADERS` | — | **Recusada**: se existir no ambiente ou no `.env`, o programa encerra com erro de configuração. Não a defina |

Quando o provedor falha de forma passageira (sem conexão, tempo esgotado, erro 5xx, limite de requisições), o chat mostra uma linha por nova tentativa, com o motivo, a espera e o número da tentativa. Erros que não adiantam repetir (chave inválida, sem crédito, requisição recusada) aparecem na hora, com orientação. Se as tentativas acabam, o chat continua aberto e o histórico fica como estava.

O limite local conta **perguntas do usuário**, numa janela deslizante: ao atingi-lo, a pergunta não vai ao modelo, não entra no histórico e o chat mostra quantos segundos aguardar (`Limite de perguntas atingido (2 perguntas a cada 60 s). Aguarde 37 segundos e envie de novo.`); o chat continua aberto e a janela libera as vagas aos poucos. Comandos (`/ajuda`, `/limpar`, `/contexto`, `/sair`) e linhas vazias não contam. As novas tentativas de uma chamada e a futura autoavaliação não consomem vagas, e um turno que falha ou é cancelado depois de aceito não devolve a sua. Se várias linhas chegam de uma vez (por exemplo, por um pipe), as que excedem o limite são descartadas, cada uma com a sua mensagem em stderr; nada fica em fila.

## Como testar

| Comando | O que faz | Usa a chave? |
|---|---|---|
| `npm test` | Testes unitários (Vitest), sem rede | Não |
| `npm run contexto` | Imprime o contexto montado (as quatro camadas) do perfil padrão | Não |
| `npm run chat -- --show-context` | Imprime o contexto montado respeitando `--perfil`, `--system-prompt` e `--context-dir`, sem chamar o modelo | Não |
| `npm run check` | Portão de qualidade: lint + typecheck + testes unitários + varredura de segredos | Não |
| `npm run demo:falhas` | Demonstração de retry e rate limit contra um servidor local simulado; regrava `outputs/evidencias/retry-rate-limit.txt` | Não |
| `npm run smoke:llm` | Teste de fumaça do cliente: duas chamadas curtas à API real (streaming e saída estruturada) | **Sim, e consome crédito** |
| `npm run eval` | Bateria de 12 casos x 3 execuções contra o modelo real | **Sim, e consome crédito** |

### Teste de fumaça do cliente (`npm run smoke:llm`)

Confirma, contra a API real, que o modelo configurado, o `reasoning.effort` e a saída estruturada são aceitos. Faz duas chamadas curtas, sem novas tentativas, com uma pergunta genérica. **Usa a chave do `.env` e gasta crédito: rode à mão, uma vez, e nunca em laço.** Não faz parte do `npm run check` nem do CI.

O comando imprime o modelo pedido e o devolvido, o número de trechos recebidos, o tamanho do texto, o tempo até o primeiro trecho e o total, os tokens, um resumo do objeto estruturado (nomes dos campos, valor do campo enumerado e tamanho do texto livre, nunca o texto) e uma linha por checagem, terminando em `Resultado: APROVADO` ou `Resultado: REPROVADO`. Nada é gravado em disco e tudo o que é impresso passa pela redação de segredos; em caso de falha, aparece só o resumo do erro (status, código, tipo e mensagem), com os identificadores de organização (`org-…`) e de projeto (`proj_…`) mascarados. Mesmo assim, **revise a saída antes de colar em um PR ou issue**: o repositório é público e a mensagem de erro é texto escrito pelo provedor. Código de saída: 0 quando o texto chega em mais de um trecho e o objeto é válido; 1 quando alguma checagem falha ou a chave não está configurada; 2 em erro inesperado.

### Demonstração de falhas (`npm run demo:falhas`)

Mostra, em poucos segundos (menos de 10 no Windows, e o limite é de 60), o tratamento de falhas do provedor pelo **mesmo cliente do chat** (`LlmClient` com `withRetry`, sem cópia da lógica). Um servidor HTTP local, preso a `127.0.0.1` numa porta livre e encerrado ao final, faz o papel da API; o cliente real fala com ele pela `baseURL`, com uma chave falsa. **Não precisa de chave, de `.env` nem de internet**, e nenhuma requisição sai da máquina.

Cinco cenários, cada um identificado na saída: (1) 429 com `Retry-After` e depois sucesso; (2) 429 sem cabeçalho e depois sucesso; (3) 500 repetido até esgotar as tentativas; (4) 401, sem nova tentativa; (5) conexão recusada até esgotar. Para cada um, a saída traz o roteiro do servidor, os avisos de nova tentativa (as mesmas linhas do chat), a espera planejada e a sua origem, o desfecho e uma lista de checagens `[ok]` com esperado x obtido. O resumo final tem uma linha por cenário (`CONFERE` ou `DIVERGE`). O código de saída é 0 só se todos conferem; com Ctrl+C o código é 130 e nada é gravado.

Os cenários usam `maxRetries: 3`, base de 100 ms e `Retry-After: 1`, sem jitter, para que a saída seja sempre a mesma. A transcrição é gravada, pelo escritor único, em [`outputs/evidencias/retry-rate-limit.txt`](outputs/evidencias/retry-rate-limit.txt), **somente se todos os cenários conferem**. O texto gravado não tem data, porta, tempo medido nem caminho; a duração total e o caminho do arquivo aparecem só no terminal. **Atenção: o comando reescreve esse arquivo, que é versionado.** Como o conteúdo é determinístico, rodar de novo não deve gerar diferença no `git diff`; se gerar, algo mudou no comportamento do cliente.

### Roteiro manual: falhas do provedor

Sem gastar crédito além de uma pergunta e sem alterar o código. Se preferir não usar a rede real, use a demonstração com servidor local, descrita na seção anterior (`npm run demo:falhas`).

- **(a) Rede desconectada.** Com o chat aberto (`npm run chat`), desligue a rede (Wi-Fi ou cabo) e faça uma pergunta. Aparecem linhas como `Falha de conexão com o provedor. Nova tentativa 1 de 3, em 1 s.`, depois 2 s e 4 s, e por fim a mensagem de que não foi possível obter a resposta depois de 4 tentativas. O chat continua aberto: religue a rede e pergunte de novo. Para ver o fim mais depressa, use `RETRY_MAX_ATTEMPTS=1` no `.env`.
- **(b) Chave inválida.** Troque o valor de `OPENAI_API_KEY` no `.env` por um texto qualquer com o formato de chave, abra o chat e faça uma pergunta. A resposta é uma única mensagem orientando a conferir `OPENAI_API_KEY` e gerar uma chave nova no painel, sem nova tentativa e sem repetir a chave. Restaure o `.env` depois.
- **(c) Limite local de perguntas.** Abra o chat com `RATE_LIMIT_MAX_REQUESTS=2` (por exemplo, `RATE_LIMIT_MAX_REQUESTS=2 npm run chat` em shell POSIX, ou a linha no `.env`) e faça três perguntas seguidas. As duas primeiras são respondidas; a terceira não vai ao modelo e mostra em stderr a mensagem com os segundos de espera. Passada a janela (60 s por padrão), uma nova pergunta é aceita.
- **Ctrl+C.** Durante a espera de uma nova tentativa, o primeiro Ctrl+C cancela a pergunta e encerra o chat; um segundo Ctrl+C, se algo travar, encerra o programa na hora.

## Integração contínua

A cada pull request e a cada push na `main`, o GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) instala as dependências com `npm ci` e roda `npm run check`. O workflow não usa a chave da OpenAI nem faz chamadas à API real; a bateria `npm run eval` e o teste de fumaça `npm run smoke:llm` só rodam localmente.

## Credencial

Este repositório é público. A chave da OpenAI fica somente no arquivo `.env` local, que é ignorado pelo Git, ou em variável de ambiente. Nunca coloque uma chave real em `.env.example`, em código, em documentação, em issue ou em mensagem de commit. O `npm run check:secrets` procura o formato de chave no conteúdo (inclusive em arquivos UTF-16) e no nome de cada arquivo não ignorado pelo Git, sem exibir o valor encontrado. Se uma chave vazar, revogue-a imediatamente no painel da OpenAI. Detalhes em [`docs/adr/0007-protecao-da-credencial.md`](docs/adr/0007-protecao-da-credencial.md).

## Deploy

Não há. A aplicação roda apenas localmente, no terminal.

## Documentação

- [`docs/PRD.md`](docs/PRD.md): requisitos
- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md): arquitetura e stack
- [`docs/adr/`](docs/adr/): decisões de arquitetura
- [`docs/BACKLOG.md`](docs/BACKLOG.md): plano de trabalho
- [`CHANGELOG.md`](CHANGELOG.md): histórico de mudanças
