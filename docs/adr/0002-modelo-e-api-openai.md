# ADR 0002 — Modelo e API da OpenAI

- Status: proposta (16/11/2026)
- Relacionado: PRD D2; F6, F10, F12

## Contexto

O dono pediu um modelo de baixo custo e a escolha exata ficou com o arquiteto. O catálogo foi conferido na documentação oficial em 16/11/2026 (páginas de modelos, preços e descontinuações em developers.openai.com), não de memória. O professor pode rodar o projeto semanas depois da entrega, então a data de desligamento do modelo importa tanto quanto o preço.

Preços por 1M de tokens (entrada / saída), camada padrão, e situação:

| Modelo | Preço (US$) | Situação em 16/11/2026 |
|---|---|---|
| `gpt-5-nano` | 0,05 / 0,40 | Desligamento em 11/12/2026 |
| `gpt-6-luna` | 0,10 / 0,50 | Corrente, sem data de desligamento |
| `gpt-4o-mini` | 0,15 / 0,60 | Desligamento em 14/01/2027 (substituto indicado: `gpt-6-luna`) |
| `gpt-5.6-luna` | 0,20 / 1,20 | Geração anterior |
| `gpt-5.4-nano` | 0,20 / 1,25 | Desligamento em 01/04/2027 |
| `gpt-5-mini` | 0,25 / 2,00 | Desligamento em 11/12/2026 |
| `gpt-6.1-terra` | 1,00 / 5,00 | Corrente |

## Decisão

1. **Modelo: `gpt-6-luna`**, para geração, autoavaliação e juiz da bateria. É o mais barato entre os que não têm desligamento marcado, e a página do modelo lista streaming, structured outputs e os endpoints Responses e Chat Completions. Janela de contexto de cerca de 1M tokens; limite padrão do nível inicial de 5.000 RPM.
2. **O identificador do modelo é configuração** (`OPENAI_MODEL`), nunca literal espalhado pelo código. Existe em um único lugar como valor padrão (`src/config/env.ts`).
3. **API: Responses** (`client.responses.create` com `stream: true` para geração; `client.responses.create` sem stream, com `text.format` gerado por `zodTextFormat`, para autoavaliação e juiz). Na geração, o texto chega em trechos, nos eventos `response.output_text.delta`, e a resposta completa é a concatenação desses trechos. O texto que o evento final `response.completed` traz em `output` só é usado como reserva, quando nenhum trecho chegou: nesse caso ele é entregue inteiro, como um único trecho. O modelo que respondeu e o consumo de tokens são lidos desse evento final. Na saída estruturada, o SDK envia `text.format` com `type: "json_schema"` e `strict: true`; o cliente lê o corpo HTTP bruto (`.asResponse()`), extrai o texto de `output` e só então interpreta o JSON e o valida com o mesmo schema `zod`. O auxiliar `client.responses.parse` não é usado: ele lança o mesmo `SyntaxError` para um corpo HTTP ilegível e para uma saída do modelo que não é JSON, e o cliente precisa distinguir os dois (decisão 8).
4. **Estado da conversa no cliente:** o histórico é uma lista em memória enviada em `input` a cada turno, com `store: false`. Não se usa `previous_response_id`: F7 pede histórico de sessão descartável e `/limpar`, e manter o estado local torna isso trivial e visível.
5. **Contexto em `instructions`:** as quatro camadas montadas vão no parâmetro `instructions`; o histórico e a pergunta vão em `input`.
6. **Parâmetros de amostragem:** `gpt-6-luna` é modelo de raciocínio e a página do modelo não documenta `temperature`, `top_p` nem `seed`. O projeto não envia esses parâmetros. Envia apenas `reasoning.effort`, configurável, com padrão `low`.
7. **Prazo total por chamada imposto pelo cliente do projeto.** `REQUEST_TIMEOUT_MS` vale para a chamada inteira, incluindo o corpo do streaming. O `timeout` do SDK, no streaming, só conta até a chegada dos cabeçalhos: um corpo que para de chegar ficaria pendurado. Por isso `src/llm/client.ts` mantém um temporizador próprio, que cancela a chamada e a encerra com o erro de timeout do SDK (`APIConnectionTimeoutError`).
8. **O que o SDK não sinaliza, o cliente sinaliza.** O SDK não lança erro quando o stream termina sem `response.completed`, quando chega `response.failed` ou `response.incomplete`, nem quando a chamada é cancelada no meio. O cliente detecta esses casos: cancelamento vira `APIUserAbortError`; os demais viram `LlmResponseError`, com um tipo (`interrupted`, `failed`, `incomplete`, `empty`, `refusal`, `invalid_output`) e uma mensagem que nunca cita a saída do modelo. Os erros do SDK (de API, de conexão, de timeout e de cancelamento) passam sem alteração. Três regras separam os tipos: (a) **`interrupted` é falha de leitura**: o stream acabou sem o evento final, a conexão caiu no meio do corpo (no Node, `TypeError: terminated`), um evento do stream não é JSON (`SyntaxError` do SDK) ou o corpo de uma resposta HTTP 200 não é JSON. O erro original não é guardado; fica em `cause` só o nome e o código dele (por exemplo `TypeError` / `UND_ERR_SOCKET`). É o tipo que a ENG-51 pode repetir. (b) **`failed` com a mensagem "fora do formato esperado" é resposta lida mas fora do contrato**: o SDK não valida o que recebe, então o cliente valida com `zod` o mínimo que usa (`delta` texto; `model` texto não vazio; `usage` opcional com três números; `output` lista de itens). Nunca sai `TypeError` nem `undefined` no resultado. (c) **`invalid_output` é só da saída do modelo**: a resposta do provedor foi lida e validada, e o texto que o modelo escreveu não é JSON ou não segue o schema. Um erro lançado pelo `onChunk` de quem chamou passa como está.
9. **O SDK não lê o ambiente.** O cliente do SDK é criado com chave, endereço, organização, projeto e nível de log explícitos (log desligado), para que `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` e `OPENAI_LOG` não mudem o comportamento por fora de `src/config/env.ts`. A exceção é `OPENAI_CUSTOM_HEADERS`, que o SDK lê sem oferecer opção para desligar e aplica **depois** dos cabeçalhos de autenticação: com essa variável no ambiente, a requisição sairia com outra credencial (`Authorization`), com `OpenAI-Organization`/`OpenAI-Project` de terceiros e com cabeçalhos extras. Mitigado em `src/llm/client.ts`: toda chamada envia cabeçalhos próprios, que têm precedência sobre os do ambiente, com `Authorization` igual à chave da configuração e `OpenAI-Organization` e `OpenAI-Project` anulados (valor `null`, que o SDK interpreta como "não enviar"). Risco que permanece: um cabeçalho com qualquer outro nome definido nessa variável (por exemplo `X-Extra`) continua sendo enviado, porque o cliente não lê o ambiente e não tem como conhecer esses nomes. Recusar a variável em `loadConfig` fica para a ENG-51. O objeto do SDK fica em closure e não é alcançável a partir do `LlmClient` devolvido, porque ele expõe a chave como propriedade pública.
10. **Schemas de saída estruturada são estritos.** O formato `strict: true` do provedor não tem campo opcional, e `zodTextFormat` recusa o schema antes de qualquer requisição quando ele não é compatível. Quem escreve o schema da autoavaliação e do juiz segue estas regras: a raiz é um objeto (`z.object`), nunca lista ou texto; não se usa `.optional()` (um campo que pode faltar é declarado com `.nullable()` e o modelo devolve `null`); não se usa `z.record` (todo objeto tem as propriedades declaradas e `additionalProperties: false`); não se usa `.transform()`. O schema enviado inclui a chave `$schema` com o identificador do JSON Schema draft-07, gerada pelo SDK; se a API a aceita é um item da fumaça (seção "Verificação").
11. **A fumaça é a exceção à regra do `withRetry`.** A regra de arquitetura 2 pede que toda chamada passe por `src/llm/client.ts` envolvida por `withRetry`. O `npm run smoke:llm` usa o cliente e, de propósito, não repete: são duas chamadas, uma tentativa cada, para que uma premissa errada da ADR apareça como falha e não seja escondida por uma nova tentativa, e para não gastar crédito em laço. Quando `withRetry` existir (ENG-51), essa exceção deve ser registrada no teste de arquitetura e no `CLAUDE.md`, e não removida.

## Alternativas descartadas

- `gpt-5-nano`: metade do preço de entrada, mas sai do ar em menos de um mês.
- `gpt-4o-mini`: o modelo mais provável das aulas, porém com desligamento em janeiro de 2027 e mais caro que o escolhido.
- `gpt-6.1-terra`: seguiria as regras com mais rigor, mas custa 10x e o dono pediu baixo custo. Fica como plano B (ver consequências).
- Chat Completions: continua disponível, mas é a interface legada e tem restrições com modelos de raciocínio (por exemplo, function calling só com esforço `none`).
- `previous_response_id` / estado no servidor: esconderia o histórico, que é um requisito a demonstrar.

## Consequências

- A consistência (F13) não pode depender de `temperature: 0`. Ela vem do contexto, da autoavaliação e da mensagem segura fixa.
- `gpt-6-luna` não tem snapshot datado. Cada registro de output grava o campo `model` devolvido pela API (lido do evento `response.completed` no streaming e da resposta na saída estruturada), para deixar rastro se o provedor atualizar o modelo. Quando a saída estruturada não é JSON ou não segue o schema, o erro `invalid_output` também traz o modelo que respondeu, porque a resposta do provedor já foi lida.
- A issue 6 inclui um teste de fumaça contra a API real (`npm run smoke:llm`) para confirmar que modelo, `reasoning.effort` e saída estruturada são aceitos como descrito aqui. Se algo divergir, corrige-se esta ADR antes de seguir. Se o modelo não for aceito, a troca do modelo depende de consulta ao dono. Ver a seção "Verificação".
- Plano B se a meta de 100% não for atingida após as iterações de contexto: subir `reasoning.effort` para `medium`; em último caso, trocar `OPENAI_MODEL` para `gpt-6.1-terra`. Ambas são mudanças de configuração, e a segunda depende de aprovação do dono pelo custo.
- Custo estimado da bateria completa: cerca de US$ 0,10 (ver `docs/ARQUITETURA.md`, seção 8).

## Verificação

**Situação: pendente.** O teste de fumaça contra a API real ainda não foi executado. Ele é rodado somente pelo dono da chave, no terminal dele, com `npm run smoke:llm` (duas chamadas curtas, sem retry; usa a chave e gasta crédito). Nenhum resultado é registrado aqui antes dessa execução.

O que os testes unitários já confirmam, com o SDK real (versão 7.57.0) e um `fetch` falso, sem rede: o corpo enviado (`model`, `instructions`, `input`, `store: false`, `reasoning.effort`, `stream: true`; nenhum parâmetro de amostragem), a leitura dos trechos e do evento final, o formato de `text.format` gerado por `zodTextFormat`, a separação entre resposta ilegível (`interrupted`), resposta fora do contrato (`failed`) e saída inválida do modelo (`invalid_output`), o prazo total, o cancelamento e a ausência de novas tentativas do SDK. Isso prova o que o projeto envia e como interpreta as respostas, não que a API aceita o pedido.

O que só a fumaça confirma:

| Item | Resultado |
|---|---|
| O modelo configurado é aceito pela Responses API | pendente |
| `reasoning.effort` com o valor padrão é aceito | pendente |
| O texto chega em mais de um trecho | pendente |
| `responses.create` com o `text.format` de `zodTextFormat` devolve um objeto válido no schema | pendente |
| O schema enviado, com a chave `$schema` (draft-07), é aceito | pendente |
| Campo `model` devolvido pela API | pendente |

Se a saída estruturada for recusada, o plano B é montar `text.format` à mão com `z.toJSONSchema`, e esta ADR é corrigida antes de seguir.
