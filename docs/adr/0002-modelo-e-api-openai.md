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
3. **API: Responses** (`client.responses.create` com `stream: true` para geração; `client.responses.parse` com `zodTextFormat` para autoavaliação e juiz).
4. **Estado da conversa no cliente:** o histórico é uma lista em memória enviada em `input` a cada turno, com `store: false`. Não se usa `previous_response_id`: F7 pede histórico de sessão descartável e `/limpar`, e manter o estado local torna isso trivial e visível.
5. **Contexto em `instructions`:** as quatro camadas montadas vão no parâmetro `instructions`; o histórico e a pergunta vão em `input`.
6. **Parâmetros de amostragem:** `gpt-6-luna` é modelo de raciocínio e a página do modelo não documenta `temperature`, `top_p` nem `seed`. O projeto não envia esses parâmetros. Envia apenas `reasoning.effort`, configurável, com padrão `low`.

## Alternativas descartadas

- `gpt-5-nano`: metade do preço de entrada, mas sai do ar em menos de um mês.
- `gpt-4o-mini`: o modelo mais provável das aulas, porém com desligamento em janeiro de 2027 e mais caro que o escolhido.
- `gpt-6.1-terra`: seguiria as regras com mais rigor, mas custa 10x e o dono pediu baixo custo. Fica como plano B (ver consequências).
- Chat Completions: continua disponível, mas é a interface legada e tem restrições com modelos de raciocínio (por exemplo, function calling só com esforço `none`).
- `previous_response_id` / estado no servidor: esconderia o histórico, que é um requisito a demonstrar.

## Consequências

- A consistência (F13) não pode depender de `temperature: 0`. Ela vem do contexto, da autoavaliação e da mensagem segura fixa.
- `gpt-6-luna` não tem snapshot datado. Cada registro de output grava o campo `model` devolvido pela API, para deixar rastro se o provedor atualizar o modelo.
- A issue 6 inclui um teste de fumaça contra a API real para confirmar que modelo, `reasoning.effort` e saída estruturada são aceitos como descrito aqui. Se algo divergir, corrige-se esta ADR antes de seguir.
- Plano B se a meta de 100% não for atingida após as iterações de contexto: subir `reasoning.effort` para `medium`; em último caso, trocar `OPENAI_MODEL` para `gpt-6.1-terra`. Ambas são mudanças de configuração, e a segunda depende de aprovação do dono pelo custo.
- Custo estimado da bateria completa: cerca de US$ 0,10 (ver `docs/ARQUITETURA.md`, seção 8).
