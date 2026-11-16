# ADR 0007 — Proteção da credencial em repositório público

- Status: proposta (16/11/2026)
- Relacionado: F12, F15; risco "Vazamento de credencial" do PRD

## Contexto

A entrega é um repositório Git público. O projeto usa a chave de API paga do dono e versiona arquivos gerados por execução (`outputs/`). Há três caminhos de vazamento: o próprio `.env`, textos gravados em outputs e logs (mensagens de erro, objetos de erro do SDK, cabeçalhos), e o histórico do Git (um commit apagado depois continua lá).

## Decisão

1. **Leitura só por variável de ambiente.** `OPENAI_API_KEY` vem do ambiente ou de `.env`, carregado por `src/config/env.ts`. Nenhum outro módulo lê `process.env`. A chave não é aceita por argumento de linha de comando (ficaria no histórico do shell).
2. **`.gitignore` desde o primeiro commit:** `.env`, `.env.*` (com exceção de `.env.example`), `node_modules/`, `logs/`. O `.env.example` é versionado só com nomes de variáveis e valores de exemplo sem validade.
3. **Redação central.** `src/security/redact.ts` expõe `redact(texto)`, que substitui por `[REDACTED]`: (a) o valor exato da chave em uso (segredos exatos com menos de 8 caracteres são ignorados, para não corromper o texto) e (b) qualquer sequência com formato de chave: `sk-` seguido de 20 ou mais caracteres, ou a forma mascarada que a API cita em erros 401 (`sk-`, três ou mais asteriscos e os últimos caracteres; formato não confirmado contra a API real). O prefixo só conta quando não vem logo depois de uma letra ou dígito ASCII: ali ele é o fim de uma palavra comum (`task-`, `helpdesk-`), e as respostas gravadas não podem ser corrompidas; o preço é que uma chave colada a uma letra ou dígito só é pega pelo valor exato de (a). Um ou dois asteriscos encerram a sequência (são Markdown em volta da chave, não máscara). Toda escrita em `outputs/` e `logs/` passa por um único escritor que aplica `redact`: o padrão de formato de chave é sempre aplicado, qualquer que seja o redator que o escritor receba. Não se chama `fs.writeFile` para esses diretórios fora dele.
4. **Erros são resumidos antes de serem gravados ou exibidos:** apenas status, código, tipo, mensagem e identificador da requisição. Nunca o objeto de erro inteiro, a requisição ou os cabeçalhos.
5. **Sem log de depuração do SDK** nos comandos do projeto.
6. **Varredura:** `npm run check:secrets` procura padrões de chave em todos os arquivos do diretório de trabalho que não são ignorados pelo Git, e falha se encontrar. Uma varredura que não leu nenhum arquivo também é falha (código 2), não aprovação. Faz parte de `npm run check`.
7. **Antes de tornar o repositório público** (issue 19): rodar a varredura também sobre todo o histórico (`git log -p`) e conferir que `.env` nunca foi adicionado.
8. **Se a chave vazar:** revogar no painel da OpenAI imediatamente e gerar outra. Reescrever o histórico não desfaz a exposição.

## Alternativas descartadas

- Confiar só no `.gitignore`: não protege outputs nem logs.
- Ferramentas externas (gitleaks, git-secrets) ou hooks de pre-commit: instalação extra para um padrão de chave único; a varredura local resolve.
- Não versionar `outputs/`: contraria o entregável E4.
- Redigir só no fim, com um script sobre os arquivos prontos: basta esquecer de rodar uma vez.

## Consequências

- O padrão `sk-...` pode redigir um texto inofensivo com a mesma forma. Aceito: falso positivo é melhor que vazamento.
- Se o usuário colar uma chave no chat por engano, ela é redigida nos logs e outputs, mas é enviada ao provedor como parte da pergunta. Fora do alcance do projeto.
- A varredura cobre o formato de chave da OpenAI. Outros segredos não fazem parte do projeto.
