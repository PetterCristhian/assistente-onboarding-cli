# ADR 0005 — Retry, rate limit e como evidenciá-los

- Status: proposta (16/11/2026)
- Relacionado: F8, F9a, F9b; T7 e T8 do enunciado

## Contexto

F8 exige retry limitado com espera crescente e aviso ao usuário; erros não recuperáveis não devem ser repetidos. F9a exige esperar e tentar de novo quando o provedor responde que o limite foi excedido. O PRD reconhece que F9a não é reproduzível manualmente: com limite padrão de 5.000 RPM, um chat de terminal nunca recebe 429 de verdade. Sem um mecanismo de evidência, o requisito existiria só no código.

## Decisão

### Mecanismo

1. **Retry próprio; o do SDK é desligado.** O cliente é criado com `maxRetries: 0` e `timeout` explícito. O SDK tenta de novo sozinho e em silêncio por padrão, o que impediria os avisos de "tentando novamente" e tornaria o comportamento não testável. O `timeout` do SDK não cobre o corpo de um stream (só conta até os cabeçalhos da resposta); por isso `REQUEST_TIMEOUT_MS` é imposto também por um temporizador do próprio cliente, **por tentativa** (ADR 0002, decisão 7): cada nova tentativa recebe o prazo inteiro, e não existe prazo total da chamada. O pior caso é, portanto, de `(RETRY_MAX_ATTEMPTS + 1) x REQUEST_TIMEOUT_MS` mais as esperas (cada uma de no máximo 30 s). Um stream que estoura o prazo da tentativa termina com o mesmo erro de timeout do SDK, que é transitório.
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

### Decisões da implementação (ENG-51)

9. **Classificação de `LlmResponseError`.** Só `interrupted` (a resposta não pôde ser lida até o fim) e `failed` (o provedor informou a falha) são repetíveis, como falha transitória. `malformed`, `incomplete`, `empty`, `refusal` e `invalid_output` são fatais (razão `response`) e mantêm a própria mensagem: repetir não muda o contrato violado, a decisão do modelo nem o limite de tokens. Qualquer outro erro que não seja do provedor (um `TypeError`, um texto, o que o `onChunk` ou o `onRetry` do chamador lança) é fatal e desconhecido: não é repetido nem engolido.
10. **Prazo por tentativa.** Ver a decisão 1.
11. **Teto de 30 s e `Retry-After` longo.** A espera nunca passa de 30 s, constante em `src/llm/retry.ts`. Se o provedor pede, em `retry-after-ms` ou `retry-after`, uma espera maior que o teto, a chamada falha na hora, sem esperar e sem aviso de nova tentativa, e a mensagem diz: "o provedor pediu para aguardar N s; tente de novo mais tarde". O erro original é relançado sem alteração; o valor pedido fica guardado à parte (um `WeakMap` em `retry.ts`) para a mensagem. `retry-after` aceita segundos (inteiros ou decimais) e data HTTP. Valor inválido, negativo, infinito ou data já passada não conta: cai no backoff.
12. **Jitter só para cima.** `exp = min(30 s, base x 2^(n-1))` e `espera = min(30 s, round(exp x (1 + 0,2 x aleatório)))`, com o aleatório em `[0, 1)`: de 0 a 20% a mais, nunca menos que a base. O número aleatório é injetado.
13. **Orçamento compartilhado.** O 429 e as falhas transitórias gastam as mesmas `RETRY_MAX_ATTEMPTS` novas tentativas; não há um orçamento por classe. Esgotado o orçamento, o último erro original é relançado, sem wrapper, para que o resumo de erro e a sessão leiam `status` e `code`.
14. **Streaming interrompido.** A sessão fecha a linha da resposta parcial (`endAnswer`), avisa em uma linha que a resposta foi interrompida, que o texto acima está incompleto e será descartado, e que a geração recomeça do zero (com a tentativa e a espera); a nova geração é impressa logo abaixo. O texto parcial nunca entra no histórico: só o texto da tentativa que vence chega a `commitTurn`. Se a última tentativa falha depois de algum texto, a linha é fechada uma vez, e o aviso "Resposta interrompida." precede a mensagem de erro.
15. **`onRetry` por requisição.** O aviso de nova tentativa é um callback do `LlmRequest` (`onRetry`), não da configuração do cliente: quem chama decide o que mostrar (o chat imprime uma linha; a bateria pode registrar). É chamado antes da espera. Um erro lançado por ele encerra a chamada.
16. **Espera abortável.** A espera recebe o `AbortSignal` da chamada e rejeita na hora quando ele aborta, sem deixar temporizador nem ouvinte; o cancelamento durante a espera termina com `APIUserAbortError`, sem nova requisição. Ctrl+C: o primeiro cancela o turno; o segundo encerra o programa na hora, com o código de saída que um erro de escrita tenha definido (ou 0).
17. **Mensagens ao usuário.** Textos fixos em português mais o status e um código curto (identificador de até 40 caracteres); nunca o `error.message` do SDK, cujo texto de um 401 cita a chave mascarada. A mensagem final ainda passa por `redact()` na sessão. Um erro que não é do SDK (por exemplo, o de um `onChunk` do chamador) mantém a própria mensagem, já redigida.
18. **Exceção da fumaça.** `npm run smoke:llm` cria o cliente com `retryMaxAttempts: 0` (ADR 0002, decisão 11).

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
