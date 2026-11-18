# Assistente de Onboarding — Persistência, Memória e Compressão (Disciplina 02)

> Status: APROVADO pelo dono em 18/11/2026, com escopo de evidências reduzido pelo prazo (entrega em 19/11/2026, 19h). O que foi cortado está na seção "Ajustes pelo prazo".
> Origem: micro-capstone do Módulo 03, Disciplina 02 — Implementando Chatbot com Persistência e Compressão.
> Relação com a disciplina 1: este PRD **estende** `docs/PRD.md`, que continua válido e não é editado. O estado entregue na disciplina 1 está na tag `disciplina-01`.
> Adaptação de tema: o enunciado descreve um assistente de CRM B2B com memória de cliente. Por decisão do dono (D1), o domínio continua sendo onboarding de funcionários; a memória passa a ser a do funcionário. A equivalência está na seção "Equivalência CRM → onboarding".

## Problema

O assistente da disciplina 1 esquece tudo ao encerrar o programa. O novo funcionário que volta no dia seguinte precisa repetir quem é, o que já pediu e o que já deu errado, e recebe respostas genéricas. Além disso, em conversas longas o histórico cresce sem limite, o que aumenta custo e latência a cada turno. O objetivo deste trabalho é demonstrar que o assistente consegue manter estado ao longo do tempo (statefulness), usar esse estado para responder melhor e manter o contexto enxuto, sem usar memória de forma errada ou fora de hora.

## Usuário principal

- **Usuário do chatbot:** novo funcionário, que agora conversa com o assistente em várias sessões ao longo das primeiras semanas.
- **Avaliador:** professor da pós-graduação, que precisa conseguir retomar uma sessão, ver a memória sendo usada, ver a compressão acontecer e comparar o comportamento com e sem memória.

## Proposta de valor

O mesmo chatbot de terminal, agora com sessões que podem ser retomadas por identificador, memória persistente por funcionário usada apenas quando é pertinente, e compressão automática do histórico, tudo acompanhado de evidências de que as respostas melhoram com o histórico e de que a memória não é usada de forma incorreta.

## Escopo do MVP

As políticas P1–P5, a autoavaliação e as quatro camadas da disciplina 1 continuam valendo sem alteração de comportamento. As funcionalidades abaixo usam o prefixo G para não colidir com F1–F15.

### A. Persistência de sessão

- **G1. Sessão identificada e gravada em disco** → ao iniciar o chat, o usuário vê o identificador da sessão. Cada turno concluído fica gravado. Ao encerrar o programa e iniciar de novo informando o identificador, a conversa continua de onde parou: uma pergunta de acompanhamento que depende da sessão anterior é respondida corretamente.
- **G2. Listar e escolher sessões** → existe um comando ou opção que lista as sessões gravadas (identificador, perfil, data da última mensagem, número de turnos). Informar um identificador inexistente gera mensagem clara, sem criar sessão por engano.
- **G3. Limpar não apaga memória** → o comando de limpar histórico da disciplina 1 zera o histórico da sessão atual, mas não apaga a memória do funcionário (G4). A diferença aparece na mensagem exibida.

### B. Memória do funcionário

- **G4. Estrutura de memória** → existe uma estrutura documentada e validada, por funcionário, com quatro categorias: solicitações, preferências, problemas anteriores e contexto de relacionamento. Cada item registra o que foi dito, quando e em qual sessão. A estrutura é um entregável do enunciado e fica descrita na documentação.
- **G5. Armazenar interações** → depois de um turno com resposta final, fatos novos declarados pelo usuário são gravados na memória na categoria correta. Verificação: o usuário diz "prefiro respostas em tópicos" e "meu acesso ao sistema de ponto foi negado ontem"; ao consultar a memória, os dois itens aparecem nas categorias certas. Só entra na memória o que o usuário declarou; suposições do modelo não entram.
- **G6. Recuperar o que é relevante** → a cada pergunta, o sistema seleciona apenas os itens de memória pertinentes, dentro de um teto configurável. Verificação: com memória contendo itens de assuntos diferentes, uma pergunta sobre reembolso traz os itens de reembolso e não os demais; o modo detalhado mostra quais itens foram selecionados.
- **G7. Usar a memória na resposta** → os itens selecionados entram no contexto como uma camada própria, visivelmente delimitada, separada das regras e dos dados da empresa. O comando que exibe o contexto montado mostra essa camada. Verificação: em uma sessão nova, a pergunta "como ficou aquele problema que relatei?" é respondida citando o problema registrado em sessão anterior.
- **G8. Evitar uso excessivo ou irrelevante** → uma pergunta sem relação com a memória recebe resposta que não cita itens de memória. Uma nova regra de política (P6 — uso de memória) define quando a memória pode ser citada, e a autoavaliação passa a conferi-la. Memória nunca cruza funcionários: o perfil B não recebe nada do perfil A.
- **G9. Dados sensíveis não viram memória** → relatos de casos críticos de P4 (assédio, saúde, sofrimento) não têm o conteúdo gravado; registra-se apenas que houve encaminhamento e para qual canal.
- **G10. Ver e apagar a memória** → o usuário consegue ver a própria memória e apagar um item ou tudo, por comando no chat.
- **G11. Modo sem memória** → existe uma opção de inicialização que desliga leitura e gravação de memória, mantendo todo o resto igual. É a base da comparação de G18.

### C. Compressão de contexto

- **G12. Medição do contexto** → o usuário consegue ver, por comando ou no modo detalhado, quantos tokens e quantas mensagens o histórico atual ocupa.
- **G13. Janela deslizante** → apenas as últimas N mensagens (configurável) seguem inteiras para o modelo.
- **G14. Sumarização das mensagens antigas** → o que sai da janela é substituído por um resumo acumulado, que acompanha a conversa e é gravado junto com a sessão. Verificação: depois da compressão, uma pergunta sobre algo dito antes da janela ainda é respondida corretamente.
- **G15. Compressão condicional** → a compressão só acontece quando o histórico passa de um limite configurável de tokens ou de mensagens; abaixo dele nada é alterado. O usuário é avisado quando ela ocorre, e o modo detalhado mostra tamanho antes e depois.
- **G16. Limite por tokens** → mesmo depois da sumarização, o histórico enviado respeita um teto de tokens; se necessário, as mensagens mais antigas são descartadas primeiro. As camadas de regras nunca são cortadas.
- **G17. Compressão manual** → existe um comando para forçar a compressão na hora, útil para a demonstração.

### D. Evidências para avaliação

- **G18. Comparação com memória e sem memória** → um único comando executa os mesmos casos nos dois modos contra o modelo real e gera um relatório lado a lado, por caso: resposta em cada modo e veredito. Meta: os casos que dependem de histórico passam com memória e falham sem ela.
- **G19. Casos multi-turno e multi-sessão** → conjunto documentado de casos novos, cada um com sequência de turnos, marcação de onde a sessão é encerrada e retomada, comportamento esperado e critério de aprovação. Cobertura mínima:
  - 2 casos de retomada de sessão (pergunta depende da sessão anterior);
  - 2 casos de uso de memória entre sessões diferentes (uma por categoria, no mínimo 2 das 4 categorias);
  - 2 casos negativos (pergunta sem relação com a memória não deve citá-la);
  - 1 caso de isolamento entre perfis;
  - 1 caso de dado sensível que não deve ser gravado;
  - 2 casos de conversa longa que aciona a compressão e depois pergunta algo anterior à janela.
- **G20. Consistência** → cada caso novo é executado no mínimo 3 vezes, com o mesmo critério da disciplina 1. Os 12 casos da disciplina 1 continuam passando com memória ligada (não regressão).
- **G21. Exemplos de interação** → a documentação traz pelo menos 2 transcrições reais de conversa em mais de uma sessão, retiradas dos outputs.
- **G22. Análise e instruções** → documento de análise com os resultados de G18–G20, a economia de tokens obtida pela compressão, falhas e correções, e limitações. README atualizado com o roteiro de demonstração: criar sessão, sair, retomar, ver memória, forçar compressão, rodar sem memória.

## Ajustes pelo prazo

Entrega em 19/11/2026, às 19h, com a orientação do dono de produzir o código o mais rápido possível e o mínimo de testes. Em relação ao texto acima:

- **G8:** a regra de uso da memória não virou P6. Ela está em `context/memoria-uso.md`, que abre a seção de memória e é lida também pelo avaliador. Criar P6 exigiria mudar o schema do avaliador e os casos da disciplina 1.
- **G10:** só é possível ver a memória e apagar tudo (`/esquecer`); não há como apagar um item isolado.
- **G18–G19:** 6 casos no lugar de 10 (`evals/casos-memoria.json`): 2 de memória entre sessões, 1 negativo, 1 de isolamento entre perfis, 1 de retomada com compressão e 1 de dado sensível. Veredito determinístico, sem juiz.
- **G20:** cada caso roda 1 vez em cada modo, não 3. Os 12 casos da disciplina 1 não foram rodados de novo com memória ligada.
- **G21–G22:** as transcrições ficam no próprio relatório da comparação (`outputs/memoria/<id>/COMPARACAO.md`); não há documento de análise separado.
- **Testes unitários:** um arquivo (`tests/memory.test.ts`) para seleção de memória, compressão, extração e a sessão com estado.

## Rastreabilidade: enunciado → PRD

| # | Requisito do enunciado | Origem | Coberto por |
|---|---|---|---|
| R1 | Definir estrutura de memória | Escopo 1 | G4 |
| R2 | Armazenar interações | Escopo 2 | G1, G5 |
| R3 | Recuperar informações relevantes | Escopo 3 | G6 |
| R4 | Usar memória na geração de respostas | Escopo 4 | G7 |
| R5 | Evitar uso excessivo ou irrelevante de memória | Escopo 5 | G8, G9, G16 |
| E1 | Entregável: estrutura de armazenamento de memória | O que será entregue | G4 |
| E2 | Entregável: lógica de recuperação | O que será entregue | G6 |
| E3 | Entregável: exemplos de interação multi-turno | O que será entregue | G19, G21 |
| E4 | Entregável: comparação com e sem memória | O que será entregue | G11, G18 |
| C1 | Memória é realmente utilizada nas respostas | Critérios de aceitação | G7, G19 |
| C2 | Respostas melhoram com histórico | Critérios de aceitação | G18 |
| C3 | Não há uso incorreto ou irrelevante | Critérios de aceitação | G8, G9, G19 (casos negativos) |
| C4 | Sistema mantém consistência ao longo do tempo | Critérios de aceitação | G14, G20 |
| V1 | Evidência: entendimento de statefulness | Evidências esperadas | G1–G3, G5 |
| V2 | Evidência: uso eficiente de contexto | Evidências esperadas | G6, G12–G16, G22 |
| V3 | Evidência: melhoria real na experiência | Evidências esperadas | G18, G21 |
| T1 | CLI com persistência de dados | Transcrição | G1 |
| T2 | Recuperar a sessão pelo identificador | Transcrição | G1, G2 |
| T3 | Compressão quando há muitos tokens ou mensagens | Transcrição | G15 |
| T4 | Janela deslizante ("slide window") | Transcrição | G13 |
| T5 | "Stitch context" | Transcrição | G14 (ver pergunta em aberto 2) |
| T6 | "Maybe compress" | Transcrição | G15 (ver pergunta em aberto 2) |
| T7 | Compressão por token | Transcrição | G12, G16 |
| T8 | Sumarização de janela | Transcrição | G14 |

### Equivalência CRM → onboarding

| Enunciado (CRM B2B) | Neste projeto (onboarding) |
|---|---|
| Cliente | Novo funcionário (perfil da camada de dados do usuário) |
| Histórico de pedidos | Solicitações feitas (acesso, reembolso, equipamento, férias) |
| Preferências | Preferências de atendimento (formato da resposta, forma de tratamento) |
| Problemas anteriores | Problemas relatados (ex.: acesso negado, ponto não registrado) |
| Contexto de relacionamento | Etapa do onboarding, pendências em aberto e encaminhamentos já feitos |

## Fora do MVP (por enquanto)

- Domínio de CRM, como substituto ou como segundo domínio.
- Busca semântica, embeddings ou banco vetorial: a seleção de memória é feita sobre um volume pequeno de itens.
- Servidor de banco de dados externo. O armazenamento é local; o formato é decisão do arquiteto.
- Vários usuários simultâneos, autenticação, sincronização entre máquinas.
- Criptografia dos dados gravados.
- Expiração automática de memória por tempo e resolução automática de itens contraditórios além de "o mais recente prevalece".
- Edição de itens de memória (só ver e apagar).
- Integração com sistemas reais de RH ou de chamados.
- Tudo o que já estava fora do MVP da disciplina 1 e não foi trazido para dentro aqui.

## Métricas de sucesso

- 100% dos casos novos aprovados em 3 de 3 execuções com memória ligada.
- 100% dos casos dependentes de histórico reprovados com memória desligada (prova de que a melhora vem da memória).
- 0 citações de memória nos casos negativos e 0 vazamentos entre perfis.
- 12 de 12 casos da disciplina 1 continuam aprovados.
- Em conversa longa, o histórico enviado fica abaixo do teto configurado, com redução de tokens medida e registrada na análise.
- 4 de 4 entregáveis do enunciado presentes (E1–E4).
- Avaliador consegue retomar uma sessão e ver a compressão seguindo apenas o README.

## Riscos e premissas

### Decisões confirmadas pelo dono

- **D1. Domínio:** continua onboarding; a memória é do funcionário.
- **D3. Tema aceito pelo professor:** onboarding no lugar de CRM também nesta disciplina (informado pelo dono em 18/11/2026).
- **D4. Prazo:** entrega em 19/11/2026, às 19h; evidências reduzidas ao mínimo.
- **D2. Repositório:** a disciplina 2 evolui este repositório. A entrega da disciplina 1 fica preservada na tag `disciplina-01`, e `docs/PRD.md` não é editado.

### Premissas (assumidas; corrigir se estiverem erradas)

- **Dados gravados fora do Git:** sessões e memórias reais ficam em pasta ignorada pelo Git, porque o repositório é público. Só vão para o repositório os outputs das baterias, que usam perfis fictícios.
- **Identidade:** o funcionário é identificado pelo perfil escolhido na inicialização; não há login.
- **Mesmo provedor e modelo** da disciplina 1; extração de memória e sumarização usam o mesmo caminho de chamada.
- **Regras do projeto a rever pelo arquiteto:** o `CLAUDE.md` hoje diz "sem persistência" e "banco: nenhum"; a invariante da autoavaliação precisa valer também para o que é gravado; o escritor único de disco precisa cobrir a nova pasta de dados.
- **Outputs da disciplina 1** não são alterados nem apagados.

### Riscos

- **Tema ainda não combinado com o professor:** o enunciado é de CRM. Se a adaptação não for aceita, o conteúdo de `context/` e os casos precisam ser refeitos; o código não muda.
- **Resumo que perde ou distorce fatos:** a compressão pode gerar inconsistência ao longo do tempo. Mitigação: casos de conversa longa (G19) e fatos duráveis guardados na memória, não só no resumo.
- **Memória errada vira verdade permanente:** um item extraído incorretamente contamina as sessões seguintes. Mitigação: só fatos declarados pelo usuário (G5), ver e apagar (G10).
- **Custo e latência por turno:** extração de memória e sumarização são chamadas extras ao modelo. Mitigação: sumarizar só acima do limite (G15); medir na análise.
- **Dados pessoais em disco:** risco de vazamento em repositório público. Mitigação: pasta ignorada, redação de segredos e G9.
- **Regressão das políticas:** a nova camada pode enfraquecer P1–P5. Mitigação: G20 roda os 12 casos antigos.
- **Custo da comparação:** G18 dobra as execuções da bateria. Mitigação: a comparação roda só os casos novos.

## Perguntas em aberto

1. **Nomes das técnicas:** "stitch context" e "maybe compress" vêm de transcrição automática. Quais são os nomes e o comportamento exatos no código das aulas? Hoje estão mapeados para sumarização (G14) e compressão condicional (G15). O dono vai conferir.
