# ADR 0007 — Proteção da credencial em repositório público

- Status: proposta (16/11/2026)
- Relacionado: F12, F15; risco "Vazamento de credencial" do PRD

## Contexto

A entrega é um repositório Git público. O projeto usa a chave de API paga do dono e versiona arquivos gerados por execução (`outputs/`). Há três caminhos de vazamento: o próprio `.env`, textos gravados em outputs e logs (mensagens de erro, objetos de erro do SDK, cabeçalhos), e o histórico do Git (um commit apagado depois continua lá).

## Decisão

1. **Leitura só por variável de ambiente.** `OPENAI_API_KEY` vem do ambiente ou de `.env`, carregado por `src/config/env.ts`. Nenhum outro módulo lê `process.env`. A chave não é aceita por argumento de linha de comando (ficaria no histórico do shell).
2. **`.gitignore` desde o primeiro commit:** `.env`, `.env.*` (com exceção de `.env.example`), `node_modules/`, `logs/`. O `.env.example` é versionado só com nomes de variáveis e valores de exemplo sem validade.
3. **Redação central.** `src/security/redact.ts` expõe `redact(texto)`, que substitui por `[REDACTED]`: (a) o valor exato da chave em uso (segredos exatos com menos de 8 caracteres são ignorados, para não corromper o texto) e (b) qualquer sequência com formato de chave: `sk-` seguido de 20 ou mais caracteres, ou a forma mascarada que a API cita em erros 401 (`sk-`, três ou mais asteriscos e os últimos caracteres; formato não confirmado contra a API real). Um ou dois asteriscos encerram a sequência (são Markdown em volta da chave, não máscara). A sequência é detectada em qualquer posição, inclusive colada a uma letra ou dígito (`Bearer` sem espaço, `401` seguido da chave, `\n` de uma string JSON). A única exceção existe porque `sk-` também é o fim de palavras comuns (`task-`, `disk-`, `helpdesk-`) e as respostas gravadas não podem ser corrompidas: a sequência é deixada como está quando valem as duas condições ao mesmo tempo: (i) vem logo depois de uma letra ou dígito ASCII que não é o fim de uma sequência de escape (`\n`, `\t`, `\r` e as demais de uma letra, `\uXXXX`, `\xXX`, `%XX`, `=XX`, e o fim de uma cor ANSI como `[31m`); e (ii) não tem nenhum dígito nem letra maiúscula no meio de uma palavra (maiúscula só é tolerada como inicial, logo depois de `-` ou `_`), isto é, lê-se como palavras com hífen (`task-force-management-department`). **Premissa:** uma chave real tem 40 ou mais caracteres aleatórios; a chance de uma delas não ter nenhum dígito nem maiúscula no meio é desprezível. Na dúvida, redige-se a mais. Toda escrita em `outputs/` e `logs/` passa por um único escritor que aplica `redact`: o padrão de formato de chave é sempre aplicado, qualquer que seja o redator que o escritor receba. Em `writeJson` e `appendJsonLine` a redação acontece duas vezes: em cada string (valores e nomes de propriedade, em qualquer profundidade) antes de serializar, e de novo no texto final. Não se chama `fs.writeFile` para esses diretórios fora dele.
4. **Erros são resumidos antes de serem gravados ou exibidos:** apenas status, código, tipo, mensagem e identificador da requisição. Nunca o objeto de erro inteiro, a requisição ou os cabeçalhos.
5. **Sem log de depuração do SDK** nos comandos do projeto.
6. **Varredura:** `npm run check:secrets` procura padrões de chave em todos os arquivos do diretório de trabalho que não são ignorados pelo Git, e falha se encontrar. Uma varredura que não leu nenhum arquivo também é falha (código 2), não aprovação. Faz parte de `npm run check`.
7. **Antes de tornar o repositório público** (issue 19): rodar a varredura também sobre todo o histórico (`git log -p`) e conferir que `.env` nunca foi adicionado.
8. **Se a chave vazar:** revogar no painel da OpenAI imediatamente e gerar outra. Reescrever o histórico não desfaz a exposição.

## Adendo (ENG-50): `--system-prompt` envia o arquivo ao provedor

O arquivo indicado em `--system-prompt` vira a camada 1 e, como todo o contexto, é enviado ao provedor a cada chamada. O projeto não o inspeciona em busca de segredos. Por isso a opção recusa um arquivo cujo nome começa com `.env`, só aceita `.md` ou `.txt`, só lê arquivo comum de até 64 KiB, e o README avisa que o conteúdo sai da máquina. O mesmo vale para o arquivo de perfil. A chave continua fora de qualquer argumento de linha de comando: o parser não declara essa opção e nunca repete na mensagem de erro o texto de um argumento que não reconhece.

## Adendo (ENG-51): `OPENAI_CUSTOM_HEADERS` e mensagens ao usuário

- `OPENAI_CUSTOM_HEADERS` é recusada em `loadConfig` (erro de configuração, sem repetir o valor): o SDK a lê por conta própria e a aplica depois dos cabeçalhos de autenticação (ADR 0002, decisão 9). A mitigação por cabeçalhos próprios em `src/llm/client.ts` continua como segunda barreira.
- As mensagens mostradas ao usuário sobre falhas do provedor são textos fixos mais o status e um código curto (identificador de até 40 caracteres). **Nunca o `error.message` do SDK**: o de um 401 cita a chave mascarada. Cabeçalhos de resposta são lidos só para o `retry-after` e nunca saem do módulo de classificação (`src/llm/errors.ts`). O texto final ainda passa por `redact()` na sessão, e um erro que não é do SDK mantém a própria mensagem, já redigida.

## Alternativas descartadas

- Confiar só no `.gitignore`: não protege outputs nem logs.
- Ferramentas externas (gitleaks, git-secrets) ou hooks de pre-commit: instalação extra para um padrão de chave único; a varredura local resolve.
- Não versionar `outputs/`: contraria o entregável E4.
- Redigir só no fim, com um script sobre os arquivos prontos: basta esquecer de rodar uma vez.

## Consequências

- O padrão `sk-...` pode redigir um texto inofensivo com a mesma forma (por exemplo, uma palavra terminada em `sk` seguida de hífen e de um trecho longo com dígito). Aceito: falso positivo é melhor que vazamento.
- Uma sequência colada a uma letra ou dígito, só com minúsculas, `-` e `_` (ou com maiúsculas apenas em iniciais), não é redigida pelo formato nem acusada pela varredura; se for a chave em uso, o valor exato ainda a redige. Aceito pela premissa da decisão 3. A exceção para maiúsculas em iniciais existe porque o executável do Node contém nomes como `Petropavlovsk-Kamchatski-…`, e a varredura não pode acusar binários legítimos.
- No escritor, dois nomes de propriedade que fiquem iguais depois da redação viram uma só propriedade no JSON gravado.
- Se o usuário colar uma chave no chat por engano, ela é redigida nos logs e outputs, mas é enviada ao provedor como parte da pergunta. Fora do alcance do projeto.
- A varredura cobre o formato de chave da OpenAI. Outros segredos não fazem parte do projeto.
