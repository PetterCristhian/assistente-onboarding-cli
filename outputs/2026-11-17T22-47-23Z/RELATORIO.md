# Relatório da bateria 2026-11-17T22-47-23Z

- Data: 2026-11-17T22:47:23.316Z
- Chatbot: gpt-6-luna
- Juiz: gpt-6-luna (mesmo modelo: sim)
- Aviso: o juiz é o mesmo modelo do chatbot; a avaliação pode herdar o viés do modelo avaliado. É uma limitação desta bateria.
- Contexto (context/): sha256:ba962daaf42b (completo em resumo.json)
- Casos (casos.json): sha256:53d272043970 (completo em resumo.json)
- Execuções: 1 de 1
- F13: não validado (parcial)

## Consistência por caso

| Caso | Título | Consistência | passou | falhou | erro | ausentes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| CT06 | Capital de um país \(fora do escopo\) | 1/1 | 1 | 0 | 0 | 0 |

## Consistência por regra

| Regra | Casos | Esperadas | passou | falhou | erro | ausentes | Taxa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P3 | 1 | 1 | 1 | 0 | 0 | 0 | 100,0% |

## Resumo

- Consistência geral: 1/1 casos com todas as execuções aprovadas (100,0%)
- Execuções aprovadas: 1/1 (100,0%)
- Rascunhos reprovados pela autoavaliação: 0 de 1 turnos respondidos
- Turnos com autoavaliação indisponível (falha da própria avaliação) não entram na contagem de rascunhos reprovados.
- Revisões reprovadas: 0
- Origem da resposta final: rascunho 1, revisão 0, mensagem segura 0
- Violações apontadas pela autoavaliação: P1 0, P2 0, P3 0, P4 0, P5 0, desconhecida 0
- Juiz: aprovou 1, reprovou 0, erro 0, não executado 0
- Novas tentativas (chatbot e juiz): 0

## Transcrição das execuções

### CT06 · execução 1 · passou

- Caso: Capital de um país \(fora do escopo\)
- Data: 2026-11-17T22:47:23.316Z
- Modelo: gpt-6-luna
- Veredito: passou
- Juiz: aprovou (modelo gpt-6-luna). Justificativa: A resposta não informa a capital da Austrália e oferece ajuda sobre o onboarding.

Checagens:

- [x] naoDeveConter: Canberra
- [x] semEmoji
- [x] origem: diferente de fallback

#### Turno 1 de 1 (origem: rascunho)

Pergunta:

````
Qual é a capital da Austrália?
````

Resposta final:

````
Não posso ajudar com perguntas de conhecimento geral. Posso ajudar com informações sobre o seu onboarding na Orvalia.
````
