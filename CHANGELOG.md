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
- Documento de políticas (ENG-45): `context/02-politicas.md` com as cinco regras de atendimento, P1 a P5, cada uma com identificador, descrição, exemplo de pergunta que a aciona e comportamento esperado, sem nenhum dado da empresa ou de usuário; e um teste unitário que confere a estrutura do documento.
- Conteúdo do contexto (ENG-46): instruções globais em `context/01-instrucoes-globais.md` (papel, tom e formato das respostas, sem regra e sem dado da empresa); dois perfis fictícios em `context/03-usuario/`; base de conhecimento da empresa fictícia em `context/04-empresa/` (normas internas, benefícios, processos, ferramentas e contatos, com um canal humano para cada tipo de caso crítico da regra P4 e um canal geral); mensagem segura fixa em `context/fallback.md`; e testes unitários que conferem formato, tamanho total, redação de segredos e estrutura desses arquivos. Todos os dados são inventados e os e-mails usam um domínio reservado `.example`.
- Carregadores e montador de contexto (ENG-47): um carregador por camada em `src/context/loaders.ts` (instruções globais, políticas, perfil do usuário validado com `zod` e base da empresa em ordem alfabética de nome de arquivo), com mensagens de erro em português que citam o caminho esperado e, no perfil, o campo com problema; `buildContext` em `src/context/builder.ts`, função pura que devolve as quatro seções delimitadas por marcadores, sempre na mesma ordem, insere a cláusula de precedência das políticas na abertura da seção de políticas, acrescenta a data de hoje aos dados do usuário e recusa conteúdo que contenha um marcador reservado; e o comando `npm run contexto`, que imprime o contexto montado do perfil padrão (o primeiro em ordem alfabética) sem usar a chave nem a rede. Testes unitários novos conferem que trocar o perfil altera só a seção do usuário, que trocar as políticas altera só a seção de políticas, que o nome da empresa, o domínio de e-mail e as pessoas dos perfis não aparecem em `src/`, `scripts/` e `evals/`, e que o contexto montado de cada perfil cabe no orçamento de caracteres e não é alterado pela redação de segredos.
- Cliente da OpenAI (ENG-48): interface `LlmClient` em `src/llm/client.ts`, com `streamText` (texto em trechos, entregues por callback) e `generateStructured` (objeto validado por um schema `zod`), e a implementação sobre o SDK `openai` e a Responses API, com `maxRetries: 0`, `store: false`, `reasoning.effort` da configuração e nenhum parâmetro de amostragem. O modelo vem da configuração e o resultado traz o modelo devolvido pela API e o consumo de tokens. `REQUEST_TIMEOUT_MS` passa a ser o prazo total de cada chamada, incluindo o corpo do streaming. Resposta interrompida, falha, incompleta, vazia, recusada ou fora do schema vira `LlmResponseError`, com mensagem em português que não cita a saída do modelo; erros de transporte e de API do SDK passam sem alteração. O cliente do SDK não lê variáveis de ambiente, não escreve no console e não é alcançável a partir do objeto devolvido. Um cliente falso roteirizado (`tests/helpers/fake-llm-client.ts`) e um `fetch` falso permitem testar tudo sem rede e sem chave.
- Teste de fumaça do cliente (ENG-48): `npm run smoke:llm` faz duas chamadas curtas à API real e imprime um relatório redigido (modelo pedido e devolvido, trechos, tempos, tokens, objeto estruturado e checagens). Usa a chave e gasta crédito: é rodado à mão, fora do `npm run check` e do CI.
- Testes de arquitetura (ENG-48): o SDK `openai` só é importado e instanciado em `src/llm/client.ts`, com `maxRetries: 0`, e nenhum parâmetro de amostragem aparece em `src/llm/`.

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
- `npm run check:secrets` volta a encontrar uma chave UTF-16 colada a um número ímpar de bytes (o que o `>>` do Windows PowerShell 5 faz com um arquivo UTF-8 sem quebra de linha final) ou logo após um caractere cujo byte baixo é uma quebra de linha, e passa a encontrar uma chave em UTF-32 (ENG-44).
- `redact()` e o `npm run check:secrets` deixam de tomar por chave o fim de palavras comuns (`task-`, `disk-`, `helpdesk-` seguidos de texto longo ou de asteriscos). O negrito ou itálico de Markdown em volta de uma chave é preservado (ENG-44).
- `OPENAI_API_KEY` com menos de 8 caracteres passa a ser recusada, com uma mensagem que não exibe o valor (ENG-44).
- `loadConfig` não remove nem acusa mais uma variável com nome iniciado por BOM que já estava no ambiente antes de carregar o `.env`, e não falha com `TypeError` quando o ambiente recebido não pode ser alterado (ENG-44).
- `redact()` e o `npm run check:secrets` voltam a encontrar uma chave colada a uma letra ou dígito: logo depois de uma sequência de escape (`\n`, `\t`, `\r`, `\uXXXX`, `\xXX`, `%XX`, cor ANSI), de `Bearer` sem espaço ou de um número. Só fica intacta a sequência que vem depois de uma letra ou dígito e não tem dígito nem maiúscula no meio de uma palavra, isto é, palavras com hífen como `task-force-management-department` (ENG-44).
- `writeJson` e `appendJsonLine` redigem cada string (valores e nomes de propriedade) antes de serializar, além do texto final: uma chave no início de uma linha de uma string, que o JSON grava como `\n` seguido da chave, não fica mais inteira no arquivo (ENG-44).
- A mensagem de configuração inválida não exibe mais o valor de outra variável quando ele contém o valor de `OPENAI_API_KEY`, mesmo que a chave seja curta demais para ser redigida (ENG-44).

- Os campos de texto do perfil e a data de hoje passam a ser recusados quando têm quebra de linha, que antes forjava outras linhas rotuladas na seção de dados do usuário; a mensagem cita o arquivo e o campo (ENG-47).
- O montador de contexto passa a recusar um marcador reservado com atributo, barra a mais ou barra no fim (`</politicas attr>`, `<politicas/>`, `<//politicas>`), aberto e nunca fechado, ou partido entre dois documentos da base da empresa, e confere que o texto montado tem os oito marcadores uma vez cada. A mensagem passa a citar o documento da base da empresa, ou os dois documentos, em que o marcador está (ENG-47).
- Os carregadores ignoram um arquivo cujo nome é só a extensão (`.json`, `.md`), recusam uma pasta de contexto vazia e recusam uma data atual com ano fora de 1 a 9999 (ENG-47).
- O montador de contexto passa a recusar também uma quebra de linha nos cinco valores de um perfil que não passou pelo carregador, e um marcador reservado escrito com os acentos do nome da camada (`</políticas>`, `<instruções_globais>`, `<dados_do_usuário>`). Na base da empresa, a mensagem cita só o documento em que está o início do marcador, e a junção de dois documentos apenas quando o próprio início atravessa a fronteira entre eles (ENG-47).
- Os carregadores recusam um caminho vazio para o arquivo de instruções globais, e a mensagem de um valor de perfil com espaços nas pontas passa a dizer `deve ser um texto não vazio, sem espaços no início ou no fim` (ENG-47).
- `npm run contexto` relata um erro inesperado em uma linha (`contexto: erro inesperado: <mensagem>`), sem stack trace, e termina com código 2 (ENG-47).

### Alterado

- ADR 0002: registra que o texto do streaming é a concatenação dos trechos, que o modelo devolvido é lido do evento final, o prazo total imposto pelo cliente e a seção "Verificação", pendente do teste de fumaça. ADR 0005: registra que o `timeout` do SDK não cobre o corpo do stream (ENG-48).
- `npm run chat` passa a exigir `OPENAI_API_KEY`: sem a chave, encerra com código diferente de zero e uma orientação em português, sem stack trace (ENG-44).
- `npm run check` passa a incluir `npm run check:secrets`, e `npm run lint` passa a falhar também com avisos do ESLint (ENG-44).
- ADR 0001, `docs/ARQUITETURA.md` e issue 1 de `docs/BACKLOG.md`: o projeto passa a ter um workflow pequeno de CI, por decisão do dono (o PRD deixava CI fora do MVP).
