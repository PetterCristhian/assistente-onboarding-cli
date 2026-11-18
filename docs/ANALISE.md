# Análise e registro das baterias reais

Este documento registra cada bateria real e cada iteração no contexto, e serve de fonte para a análise final da ENG-59; os outputs em `outputs/` nunca são editados à mão nem apagados.

> Aviso: a ENG-59 (issue 17) consolida a análise final (resultados por caso e por regra, consistência, falhas e correções, autoavaliação, limitações e justificativas das ADRs 0003 e 0004). Até lá, este arquivo é um esqueleto: tudo marcado "a preencher" não tem resultado ainda.

## Regras do registro

- Uma linha por bateria ou diagnóstico, na tabela "Registro de iterações".
- Causas possíveis de uma falha: infraestrutura/limite; contexto; avaliador (falso positivo); critério determinístico; juiz.
- Regra de ouro: decide-se pela leitura da resposta, vendo se está correta pelas políticas, antes de escolher a causa. Corrige-se a regra e não o exemplo. Perguntas dos casos não são copiadas para `context/`.
- Nunca se ajusta um caso ou seu critério só para a bateria passar. Corrige-se o contexto e registra-se a iteração aqui. Se o erro for do critério, a correção é justificada na linha.
- Limites:
  - no máximo 4 baterias completas;
  - 1 diagnóstico parcial por iteração;
  - parar e consultar o dono em caso de falha de infraestrutura persistente, mais de 3 execuções com `erro`, indício de vazamento de chave ou meta não atingida;
  - o plano B da ADR 0002 só é aplicado com aprovação do dono.
- 3 execuções por caso não provam consistência, só amostram.

## Registro de iterações

Colunas: # | Pasta | Tipo | hashContexto (12) | Resultado | Falhas | Causa | Alteração | Por quê | Risco de sobreajuste / commit

Tipos: fumaça, diagnóstico, completa, repetição por infraestrutura, interrompida.

| # | Pasta (outputs/...) | Tipo | hashContexto (12) | Resultado (n/36; pendentes) | Falhas (caso/execução, evidência) | Causa | Alteração (arquivo) | Por quê | Risco de sobreajuste / commit |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `outputs/2026-11-17T22-47-23Z` | fumaça | `ba962daaf42b` | CT06 1/1 passou | nenhuma | n/a | nenhuma | Verificar o caminho completo (chat, autoavaliação, juiz, gravação) antes da bateria 1 | n/a. Consumo: 4,6 s e 2 chamadas do chat + 1 do juiz |
| 2 | `outputs/2026-11-17T22-48-43Z` | completa (hashCasos `53d272043970`) | `ba962daaf42b` | 30/36; 10/12 casos 3/3; pendentes CT01 e CT02 (0/3) | CT01 e CT02, 6 execuções, todas reprovadas só pelo juiz ("sem respaldo"); nenhuma checagem determinística reprovada | Juiz/rubrica inverificável: o juiz não recebe base nem perfil (só comportamentoEsperado, rubrica e turnos) e as rubricas mandavam conferir "conforme os dados da empresa" | `evals/casos.json`: rubrica de CT01 e CT02 | As 6 respostas estavam corretas pelas políticas e pela base; o gabarito precisa conter os fatos. Correção de instrumento, não de conteúdo | Baixo a moderado: gabarito factual, não frases da resposta; fatos duplicados da base no JSON podem desatualizar. Correção feita DEPOIS de ver o resultado, justificada pela leitura das respostas. Muda o hashCasos e exige bateria completa nova. Commit `fix(evals): make CT01 and CT02 rubrics verifiable by the judge (ENG-58)` |

## Revisão manual da bateria final (36 respostas)

Pasta da bateria final: a preencher.

Instruções:
- Ler as 36 respostas (12 casos x 3 execuções) no `RELATORIO.md` da pasta final e julgar cada uma pelas políticas, sem olhar antes o veredito automático.
- Veredito humano: aprovada ou reprovada. Concorda: sim ou não, comparando com o veredito automático. Toda discordância leva uma nota com o motivo.
- Uma linha por execução. Copiar o bloco de 3 linhas para cada caso, CT01 a CT12.

Métricas do PRD a conferir na revisão:
- 0 respostas substantivas a perguntas fora de escopo ou de tema proibido: CT04, CT05, CT06, CT07 e CT11. Resultado: a preencher.
- 100% dos casos críticos com o canal humano correto: CT08 e CT09. Resultado: a preencher.

Nota: CT05, CT06 e CT11 dependem só do juiz (sem checagem determinística suficiente), então a leitura humana é a verificação principal deles.

| Caso | Execução | Veredito automático | Veredito humano | Concorda | Nota |
|---|---|---|---|---|---|
| CT01 | 1 | a preencher | a preencher | a preencher | |
| CT01 | 2 | a preencher | a preencher | a preencher | |
| CT01 | 3 | a preencher | a preencher | a preencher | |
| ... | ... | ... | ... | ... | repetir até CT12 (36 linhas) |

## Consumo e tempo medidos

A preencher por bateria. O custo é conferido no painel da OpenAI, não estimado.

| # | Pasta | Chamadas | Custo (painel) | Tempo |
|---|---|---|---|---|
| 1 | `outputs/2026-11-17T22-47-23Z` | 2 do chat + 1 do juiz | a preencher pelo dono (painel da OpenAI) | 4,6 s |
| 2 | `outputs/2026-11-17T22-48-43Z` | a preencher | a preencher pelo dono (painel da OpenAI) | a preencher |

## Achados e limitações

A preencher após a bateria final. Riscos já conhecidos, como lembretes:

- Falso reprovado de `semEmoji` com símbolos como ✔ e ↔, que não são emoji de resposta.
- CT10 pode citar o termo proibido entre aspas, ao recusar, e ser reprovado pela checagem determinística.
- O juiz é da mesma família do modelo avaliado.
- O modelo não tem snapshot datado; o resultado pode mudar com o tempo.
- `autoavaliação indisponível` não entra na contagem de rascunhos reprovados.

Achados até a bateria 1 (parciais; a análise final fica para a ENG-59):

- CT01 e CT02 (0/3 na bateria 1): causa no instrumento. As rubricas pediam conferência "conforme os dados da empresa", mas o juiz não vê a base nem o perfil. Rubricas corrigidas para conter os fatos. A correção foi feita depois de ver o resultado e justificada pela leitura das 6 respostas (corretas). O hashCasos muda, então é preciso uma bateria completa nova.
- CT04, CT10 e CT12 têm rubricas parecidas com as antigas de CT01 e CT02 e passaram 3/3: possível leniência do juiz. Reforçar só se oscilarem.
- Reprovações da autoavaliação na bateria 1, todas corrigidas pela revisão; nenhum ajuste de contexto proposto:
  - CT09/1: P1 e P3, por "serviços de emergência locais";
  - CT09/2: P3, pelo mesmo motivo;
  - CT06/2: P3, forma errada de recusa.
