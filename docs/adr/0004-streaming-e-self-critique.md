# ADR 0004 — Streaming e self-critique no mesmo turno

- Status: proposta (16/11/2026)
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
