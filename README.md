# Assistente de Onboarding — Chatbot CLI com Camada de Políticas

Chatbot de terminal em TypeScript, com a OpenAI, que responde dúvidas de onboarding de uma empresa fictícia obedecendo a um conjunto de políticas (P1–P5), com o contexto organizado em quatro camadas separadas e evidências de teste versionadas. Trabalho de pós-graduação (Engenharia de Contexto em IA).

> **Estado:** projeto em construção. Este README é o inicial; o guia completo de uso, com roteiro de demonstração, é a issue 18 de [`docs/BACKLOG.md`](docs/BACKLOG.md). Com o esqueleto (issue 1) e a configuração por ambiente (issue 2) implementados, já funcionam `npm test`, `npm run check` (que agora inclui a varredura de segredos, `npm run check:secrets`) e `npm run chat`. Com os carregadores e o montador de contexto (issue 5), funciona também `npm run contexto`, que não precisa da chave. Com o cliente da OpenAI (issue 6), existe o teste de fumaça `npm run smoke:llm`, que usa a chave e gasta crédito. O `npm run chat` exige `OPENAI_API_KEY` no `.env` ou no ambiente: sem ela, encerra com uma orientação de correção; com ela, por enquanto imprime só uma mensagem provisória. Os demais comandos chegam nas issues seguintes.

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

Para ver o contexto que o modelo recebe, sem a chave e sem acesso à rede:

```bash
npm run contexto
```

O comando imprime as quatro camadas de `context/`, cada uma entre os seus marcadores e sempre na mesma ordem: `<instrucoes_globais>`, `<politicas>`, `<dados_do_usuario>` e `<dados_da_empresa>`. Por enquanto ele não aceita opções e usa o perfil padrão, que é o primeiro de `context/03-usuario/` em ordem alfabética; a escolha do perfil e da pasta de contexto chega com as opções do chat. Se um arquivo de camada estiver ausente, vazio ou inválido, o comando encerra com código 1 e uma mensagem que cita o caminho esperado.

As demais variáveis são opcionais e estão descritas em `.env.example` e na seção 7 de [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Como testar

| Comando | O que faz | Usa a chave? |
|---|---|---|
| `npm test` | Testes unitários (Vitest), sem rede | Não |
| `npm run contexto` | Imprime o contexto montado (as quatro camadas) do perfil padrão | Não |
| `npm run check` | Portão de qualidade: lint + typecheck + testes unitários + varredura de segredos | Não |
| `npm run demo:falhas` | Demonstração de retry e rate limit com servidor local | Não |
| `npm run smoke:llm` | Teste de fumaça do cliente: duas chamadas curtas à API real (streaming e saída estruturada) | **Sim, e consome crédito** |
| `npm run eval` | Bateria de 12 casos x 3 execuções contra o modelo real | **Sim, e consome crédito** |

### Teste de fumaça do cliente (`npm run smoke:llm`)

Confirma, contra a API real, que o modelo configurado, o `reasoning.effort` e a saída estruturada são aceitos. Faz duas chamadas curtas, sem novas tentativas, com uma pergunta genérica. **Usa a chave do `.env` e gasta crédito: rode à mão, uma vez, e nunca em laço.** Não faz parte do `npm run check` nem do CI.

O comando imprime o modelo pedido e o devolvido, o número de trechos recebidos, o tamanho do texto, o tempo até o primeiro trecho e o total, os tokens, o objeto estruturado e uma linha por checagem, terminando em `Resultado: APROVADO` ou `Resultado: REPROVADO`. Nada é gravado em disco e tudo o que é impresso passa pela redação de segredos; em caso de falha, aparece só o resumo do erro (status, código, tipo e mensagem). Código de saída: 0 quando o texto chega em mais de um trecho e o objeto é válido; 1 quando alguma checagem falha ou a chave não está configurada; 2 em erro inesperado.

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
