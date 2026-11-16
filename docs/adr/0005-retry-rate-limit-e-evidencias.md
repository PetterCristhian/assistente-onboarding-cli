# ADR 0005 — Retry, rate limit e como evidenciá-los

- Status: proposta (16/11/2026)
- Relacionado: F8, F9a, F9b; T7 e T8 do enunciado

## Contexto

F8 exige retry limitado com espera crescente e aviso ao usuário; erros não recuperáveis não devem ser repetidos. F9a exige esperar e tentar de novo quando o provedor responde que o limite foi excedido. O PRD reconhece que F9a não é reproduzível manualmente: com limite padrão de 5.000 RPM, um chat de terminal nunca recebe 429 de verdade. Sem um mecanismo de evidência, o requisito existiria só no código.

## Decisão

### Mecanismo

1. **Retry próprio; o do SDK é desligado.** O cliente é criado com `maxRetries: 0` e `timeout` explícito. O SDK tenta de novo sozinho e em silêncio por padrão, o que impediria os avisos de "tentando novamente" e tornaria o comportamento não testável.
2. **Ponto único:** `withRetry()` em `src/llm/retry.ts` envolve toda chamada feita por `LlmClient` (geração, revisão, autoavaliação, juiz).
3. **Classificação** em `src/llm/errors.ts`, a partir das classes de erro do SDK:

| Classe | Exemplos | Ação |
|---|---|---|
| Transitório | falha de conexão, timeout, HTTP 408, 409, 5xx | Retry com backoff exponencial e jitter |
| Rate limit do provedor | HTTP 429 | Espera o tempo de `retry-after-ms` / `retry-after` quando presente; senão backoff. Depois tenta de novo |
| Fatal | 401, 403, 400, 404, 422; 429 com código `insufficient_quota` | Sem retry; mensagem orientando a correção |

   O 429 por falta de crédito (`insufficient_quota`) é tratado como fatal de propósito: esperar não resolve, e a mensagem orienta a verificar o faturamento.
4. **Limites:** `RETRY_MAX_ATTEMPTS` (padrão 3 novas tentativas), `RETRY_BASE_DELAY_MS` (padrão 1000; esperas de cerca de 1 s, 2 s, 4 s), teto de 30 s por espera.
5. **Aviso ao usuário:** a cada nova tentativa, uma linha com o motivo, o tempo de espera e o número da tentativa. Esgotadas as tentativas, mensagem clara; o chat continua aberto e o histórico fica intacto (turno atômico, ADR 0004).
6. **Falha no meio do streaming:** o texto parcial é descartado, o terminal avisa que a resposta foi interrompida e a geração recomeça do zero dentro do mesmo orçamento de tentativas.
7. **Chave ausente:** verificada na inicialização, antes de qualquer chamada; o programa encerra com orientação (copiar `.env.example` para `.env` e preencher). **Chave inválida:** o 401 da primeira chamada gera a orientação de correção, sem retry, e o chat permanece aberto.
8. **Limite local (F9b):** janela deslizante em `src/chat/rate-limiter.ts`, contando perguntas do usuário, com `RATE_LIMIT_MAX_REQUESTS` por `RATE_LIMIT_WINDOW_SECONDS`. No chat, a pergunta que excede o limite não é enviada e o usuário vê quantos segundos aguardar. Na bateria, o mesmo limitador é usado em modo de espera (aguarda em vez de recusar), para a execução não falhar por causa dele.

O relógio e a função de espera são injetados em `withRetry` e no limitador, para permitir teste com tempo falso.

### Evidência em três níveis

| Nível | O que prova | Como |
|---|---|---|
| 1. Testes unitários | A lógica: quantas tentativas, quais esperas, respeito a `retry-after`, nenhuma tentativa em erro fatal, janela do limite local | Vitest com fake timers e um `LlmClient` falso. Roda em `npm test`, sem rede |
| 2. `npm run demo:falhas` | O caminho real de ponta a ponta sem depender do provedor: SDK real, erros tipados reais, `withRetry` real, avisos reais no terminal | Um servidor `node:http` local faz o papel da API; o cliente OpenAI é criado com `baseURL` apontando para ele e uma chave falsa. Cenários: 429 com `Retry-After` seguido de sucesso; 429 sem cabeçalho; 500 repetido até esgotar; 401 sem retry; conexão recusada. A transcrição é gravada em `outputs/evidencias/retry-rate-limit.txt` |
| 3. Roteiro manual | O comportamento no chat real, como descrito no PRD | README: (a) desconectar a rede e enviar uma pergunta; (b) rodar com chave inválida; (c) `RATE_LIMIT_MAX_REQUESTS=2` e três perguntas seguidas |

O nível 2 é o que responde ao ponto em aberto do PRD: qualquer pessoa reproduz o tratamento de 429 com um comando, sem gastar crédito e sem precisar de chave.

## Alternativas descartadas

- **Confiar no retry embutido do SDK.** Silencioso, sem aviso ao usuário e sem como demonstrar.
- **Variável de ambiente que injeta falhas dentro do código de produção** (`SIMULATE_429=1`). Deixa um caminho de teste no produto e não exercita a interpretação real da resposta HTTP pelo SDK.
- **Provocar 429 real disparando requisições em rajada.** Com 5.000 RPM é inviável, custa crédito e não é determinístico.
- **Bibliotecas de retry ou de rate limit** (`p-retry`, `bottleneck`). São poucas dezenas de linhas, e a disciplina pede que a técnica seja demonstrada.
- **Limite local por token (token bucket) ou por chamada à API.** Contar perguntas do usuário é mais simples de explicar e de verificar ("limite 2, terceira pergunta bloqueada").

## Consequências

- O stub do nível 2 precisa devolver uma resposta de sucesso mínima no formato de streaming da Responses API. É a única parte que depende do formato do provedor; fica isolada em `scripts/demo-falhas.ts`.
- O PRD exclui testes contra modelo simulado para a bateria F12. Isso continua valendo: o stub serve só para induzir falhas de transporte e não avalia comportamento do modelo.
- A transcrição de evidência usa chave falsa e passa pela redação de segredos como qualquer outro arquivo gravado (ADR 0007).
