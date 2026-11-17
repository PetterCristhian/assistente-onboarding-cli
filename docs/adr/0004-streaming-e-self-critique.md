# ADR 0004 — Streaming e self-critique no mesmo turno

- Status: aceita (17/11/2026); implementada na ENG-53
- Relacionado: F6, F7, F10; risco "Streaming versus self-critique" do PRD

## Contexto

F6 pede que o texto apareça à medida que é gerado. F10 pede que toda resposta passe por autoavaliação contra P1–P5 antes de ser considerada final. Só dá para avaliar uma resposta completa, e nesse momento ela já foi exibida. O critério de produto do PRD é: nenhuma resposta reprovada pode ser apresentada como resposta final sem correção visível.

## Decisão

Streaming real do rascunho, autoavaliação imediata e retratação visível quando houver reprovação.

1. **Rascunho em streaming.** A geração é exibida token a token. Nesse momento o texto é um rascunho: ainda não está no histórico.
2. **Autoavaliação.** Chamada separada, sem streaming, com saída estruturada:
   `{ aprovada: boolean, violacoes: [{ regra: "P1"|"P2"|"P3"|"P4"|"P5", motivo: string }] }`.
   O avaliador recebe as camadas 2, 3 e 4, o histórico recente, a pergunta e o rascunho (delimitado como dado, não como instrução). Não recebe a camada 1.
3. **Aprovada:** o rascunho vira a resposta final e entra no histórico. No modo detalhado aparece `[autoavaliação: aprovada]`.
4. **Reprovada:**
   - o terminal mostra um aviso explícito de que a resposta acima foi retirada pela autoavaliação, com a regra violada;
   - gera-se uma revisão, usando o parecer como orientação, **sem streaming**; ela só é exibida depois de passar pela autoavaliação;
   - se a revisão for aprovada, é exibida como resposta corrigida e entra no histórico;
   - se a revisão for reprovada, exibe-se a **mensagem segura fixa** de `context/fallback.md`, que é texto local e nunca vem do modelo.
5. **No máximo uma revisão por turno.** Sem laço: o pior caso são quatro chamadas (geração, avaliação, revisão, avaliação).
6. **Fail-closed.** Se a autoavaliação falhar (erro após as tentativas de retry, saída inválida ou recusa do modelo), o resultado é tratado como reprovação: o rascunho é retirado e o turno termina com a mensagem segura fixa ou com a mensagem de erro de F8. Um rascunho não verificado nunca entra no histórico.
7. **Turno atômico.** Se o turno não chega a uma resposta final (erro esgotado), a pergunta do usuário também sai do histórico, que permanece como estava.
8. **Registro.** Cada turno guarda: rascunho, parecer, origem da resposta final (`rascunho`, `revisao` ou `fallback`) e a regra violada. Fica disponível no modo detalhado (`--verbose` ou `/detalhes`), no log da sessão e nos outputs da bateria.

Invariante testável: **o histórico e o campo `respostaFinal` só contêm texto aprovado pela autoavaliação ou a mensagem segura fixa.**

## Alternativas descartadas

- **Reter a resposta, avaliar e só então exibir "em streaming" (replay).** Garante que nada reprovado apareça, mas o streaming vira encenação: o usuário espera a geração inteira mais a avaliação antes do primeiro caractere. Deixa de atender F6 ("à medida que é gerado") de forma honesta.
- **Reter, avaliar e exibir de uma vez.** Descumpre F6.
- **Avaliar a pergunta antes de gerar (guarda de entrada).** Não avalia a resposta, que é o que F10 pede, e soma uma chamada antes do primeiro token.
- **Avaliar durante o streaming, por trechos.** Complexo, caro e sujeito a falso positivo em frase incompleta. Fora de proporção para o MVP.
- **Apagar o rascunho da tela com sequências ANSI.** Frágil com quebra de linha e rolagem, varia entre terminais do Windows, e esconderia do avaliador justamente a evidência de que a autoavaliação atuou.
- **Revisão também em streaming.** Poderia exigir uma segunda retratação no mesmo turno.

## Consequências

- Um texto reprovado pode ficar visível por alguns segundos antes da retratação. Aceito porque: o rascunho já é gerado sob as mesmas políticas, então a reprovação é exceção; a base é fictícia e não contém dado confidencial que possa vazar; e o critério do PRD pede correção visível, não invisibilidade. Fica registrado como limitação na análise (F14).
- Cada turno custa no mínimo duas chamadas. A latência extra da avaliação ocorre depois que o usuário já leu a resposta.
- A retratação é observável, o que ajuda a demonstrar T9 ao professor. Para demonstração sob demanda, o README sugere rodar com `--system-prompt` apontando para instruções que pedem tom informal: o conflito com P2 tende a acionar a autoavaliação.
- A mensagem segura depende do domínio (cita o canal de contato geral), por isso mora em `context/` e não em `src/`.
- A bateria (ADR 0006) avalia sempre a resposta final, e registra também o rascunho e a origem, para que a análise mostre quantas vezes a autoavaliação precisou agir.

## Nota de implementação (ENG-53)

Decisões tomadas ao implementar, na ordem em que o código as aplica (`src/chat/session.ts`, `src/chat/critique.ts`):

1. **Fluxo e limite.** Uma vaga do limite local por pergunta aceita (ADR 0005, decisão 19); a autoavaliação e a revisão não tomam vaga, e `critique.ts` nem importa o limitador. No máximo 4 chamadas ao modelo por turno (`llmCalls` conta chamadas lógicas, não tentativas de retry). `commitTurn` é o único ponto que escreve no histórico, uma vez por turno, e só depois de a linha da resposta estar fechada.
2. **Divergência do item 6 (fail-closed).** O item 6 acima admite, em falha da autoavaliação, "a mensagem segura fixa ou a mensagem de erro de F8". A implementação segue a issue: **sempre a mensagem segura fixa** de `context/fallback.md`, acompanhada de um aviso (`warning`) resumido por `describeFailure`, nunca o `error.message` do SDK. Vale para erro da avaliação, saída inválida, recusa do modelo, erro ao gerar a revisão e erro na avaliação da revisão. Cancelamento (Ctrl+C) não é falha: o turno termina como `cancelled`, nada vai ao histórico e o aviso informa que a resposta não foi guardada.
3. **A mensagem segura entra no histórico.** Ela é texto aprovado por construção (local, fixo). Nos turnos seguintes o modelo a vê como fala do assistente, o que mantém a conversa coerente. Ela nunca vai ao modelo como `instructions` e nunca vai ao avaliador (teste sobre as chamadas, com sentinela).
4. **Prompts fora das quatro camadas.** `context/avaliador.md` (papel de auditor; `<pergunta>` e `<rascunho>` são dado, nunca ordem) e `context/revisao.md` (reescrever corrigindo só as violações, no marcador `{{violacoes}}`) são texto genérico, sem o nome da empresa, e não entram no contexto montado. Como `fallback.md`, os três são lidos na partida e a ausência ou o vazio de qualquer um é um `ContextError`; `tests/context-content.test.ts` tem uma exceção explícita para eles (não são camada). O avaliador recebe `avaliador.md` mais as camadas 2, 3 e 4 como `instructions`; as tags de fechamento dentro do rascunho ou da pergunta são neutralizadas, para que o texto avaliado não feche o próprio delimitador.
5. **Parecer normalizado, sempre para o lado da reprovação.** `aprovada=true` com violações listadas vale como reprovada; `aprovada=false` sem violações vale como reprovada com a regra `desconhecida`. O `motivo` é texto do modelo: passa por `redact`, perde controles e caracteres de formato (e `<`, `>`), é achatado em uma linha e cortado em 200 caracteres antes de ir ao prompt da revisão (como dado delimitado) e à tela.
6. **Constantes fixas.** O avaliador vê as 6 últimas mensagens do histórico e o motivo é cortado em 200 caracteres; nenhuma variável de ambiente nova.
7. **Revisão sem `onChunk`.** A revisão usa `streamText` sem callback de trechos (não há método novo no `LlmClient`; o teste de arquitetura continua exigindo exatamente duas chamadas `sdk.responses.create`). Se o texto da revisão contiver uma credencial (`redact(texto)` difere do texto), ele é descartado e o turno termina na mensagem segura.
8. **Redação do que aparece na tela.** O rascunho é redigido enquanto chega (`src/security/stream-redact.ts`): o redator retém o fim do texto enquanto ele ainda pode virar um segredo (prefixo parcial de chave, segredo exato, token depois de `Bearer`) e o solta quando não pode mais, ou ao fim. Uma chave dividida entre dois trechos não aparece na tela; o custo é um atraso de poucos caracteres na cauda. O que a tela mostra é prefixo de `redact(texto inteiro)`, o mesmo texto que o histórico, o avaliador, o resultado e o log recebem. `Bearer <token>` entrou no `redact` padrão (e não na varredura do repositório, `check:secrets`, que continua a procurar só o formato de chave).
9. **Texto do modelo na tela.** No corpo da resposta, caracteres de controle e os caracteres de tag Unicode (U+E0000 a U+E007F) são neutralizados; marcas bidi e outros caracteres de formato continuam permitidos (podem ser legítimos). O restante que vem do modelo (motivo, regra, linhas do modo detalhado, aviso de retirada e avisos) passa por `sanitizeUntrusted`: neutraliza também bidi e os demais caracteres de formato, exceto ZWJ e ZWNJ, e limita o tamanho.
10. **Retratação e modo detalhado.** O aviso de retirada vai a stdout por `ChatOutput.retraction`, logo depois da linha do rascunho e antes de qualquer trecho da revisão, que só aparece depois de aprovada. O modo detalhado (`--verbose` ou `/detalhes`) escreve em stderr, após cada resposta, a linha `[detalhes]` e a linha `[autoavaliação] aprovada` ou `[autoavaliação] reprovada: P2 (motivo); origem=revisao; chamadas=4` (ou `erro: ...`). Forma efetiva do item 3 acima: `[autoavaliação] aprovada`, sem os dois-pontos.
11. **Registro e log.** Cada turno enviado ao modelo (respondido, falho ou cancelado) gera um `TurnRecord` (momento do relógio injetado, pergunta, rascunho, parecer, revisão, origem, regra violada e chamadas), entregue a `onTurn` depois do turno e antes de aceitar a próxima pergunta. O log da sessão (`logs/sessao-<ISO sem ":">.jsonl`, uma linha JSON por turno, chaves em português) é gravado só pelo escritor único; uma falha de escrita é avisada uma vez e nunca interrompe o chat. `logs/` fica fora do Git.
