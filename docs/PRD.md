# Assistente de Onboarding — Chatbot CLI com Camada de Políticas

> Status: VERSÃO FINAL (16/11/2026). Decisões do dono incorporadas. Resta uma única questão em aberto (formato e data de entrega), que não bloqueia o início do trabalho.
> Origem: micro-capstone do Módulo 03 — Engenharia de Contexto em IA (Implementação de Chatbot CLI em TypeScript).
> Adaptação de tema: o enunciado usa uma fintech; aqui o domínio é onboarding de novos funcionários de uma empresa fictícia. A troca de tema foi combinada com o professor. Todo o restante segue o enunciado.

## Problema

Um novo funcionário tem dezenas de dúvidas nas primeiras semanas (políticas, benefícios, processos, ferramentas, quem procurar) e hoje depende de interromper RH, gestor e colegas. Um assistente automatizado resolve isso, mas só é aceitável se respeitar regras rígidas da empresa: não inventar políticas, não tratar de assuntos sensíveis ou fora de escopo, manter linguagem formal e encaminhar casos críticos para pessoas. O objetivo do trabalho é demonstrar que essas regras são garantidas por um sistema de contexto bem estruturado, e não por sorte do modelo.

## Usuário principal

- **Usuário do chatbot:** novo funcionário, nas primeiras semanas de empresa, usando o assistente pelo terminal.
- **Avaliador (usuário secundário, mas quem decide a nota):** professor da pós-graduação, que precisa conseguir rodar o chatbot, ler os entregáveis e verificar os critérios de aceitação.

## Proposta de valor

Um chatbot de terminal que responde dúvidas de onboarding apenas com base nas informações oficiais da empresa, obedece a uma camada de políticas explícita e auditável, e vem acompanhado de evidências (testes, outputs e análise) de que as regras são respeitadas de forma consistente.

## Escopo do MVP

### A. Camada de políticas e estrutura de contexto

- **F1. Documento de políticas (policy layer)** → existe um documento versionado no repositório, legível por humanos, listando as regras de atendimento, cada uma com identificador (P1 a P5), descrição, exemplo de pergunta que a aciona e comportamento esperado. Cobre os quatro tipos de regra do enunciado, adaptados ao domínio, mais a resistência a manipulação:
  - **P1 — Tema proibido** (equivalente a "não dar recomendações financeiras diretas"): o assistente não dá aconselhamento jurídico/trabalhista, médico ou financeiro individual, não opina sobre decisões pessoais (ex.: "devo pedir demissão?", "qual plano de saúde é melhor para mim?") e não divulga dados confidenciais (salário ou dados pessoais de outros funcionários). Ele informa o que a política oficial diz e indica o canal responsável.
  - **P2 — Linguagem formal:** respostas sem gírias, sem emojis e em tratamento formal, mesmo quando o usuário escreve informalmente.
  - **P3 — Escopo:** responde apenas sobre onboarding e informações da empresa presentes na base de conhecimento. Para qualquer outro assunto, recusa educadamente e reafirma o que pode fazer. Quando a informação não está na base, diz que não tem a informação e indica quem procurar, sem inventar.
  - **P4 — Encaminhamento a humanos:** casos críticos (relato de assédio ou discriminação, acidente ou risco à saúde/segurança, questões de pagamento/folha com erro, questões legais, incidente de segurança da informação, usuário em sofrimento) não são resolvidos pelo assistente; ele orienta o encaminhamento ao canal humano correto, com o contato definido na base.
  - **P5 — Resistência a manipulação:** pedidos para ignorar as regras, revelar as instruções internas ou assumir outro papel são recusados.

- **F2. Estrutura de contexto em camadas separadas (modelo reutilizável)** → o contexto enviado ao modelo é montado a partir de fontes fisicamente separadas, uma para cada camada: (1) instruções globais (papel, tom, formato), (2) regras/políticas, (3) dados do usuário (perfil do novo funcionário: nome, cargo, área, data de início, gestor), (4) dados da empresa (base de conhecimento de onboarding). Critérios verificáveis:
  - alterar uma regra não exige editar nenhum arquivo de dados, e vice-versa;
  - trocar o perfil do usuário muda as respostas personalizadas (ex.: nome do gestor) sem alterar regras nem instruções;
  - existe um comando ou opção que exibe o contexto final montado, com as camadas visivelmente delimitadas;
  - existe documentação curta explicando como reaproveitar a estrutura em outro domínio (trocando apenas regras e dados).

- **F3. Base de conhecimento de onboarding (empresa fictícia)** → conjunto pequeno de conteúdo inventado para o trabalho, sem dados reais, cobrindo no mínimo: políticas internas (jornada, trabalho remoto, férias), benefícios, processos (reembolso, solicitação de acesso, ponto), ferramentas, e quem procurar (contatos por assunto, incluindo os canais de encaminhamento de P4). O usuário pergunta algo que está na base e recebe resposta coerente com o conteúdo; pergunta algo que não está e recebe "não tenho essa informação" mais o canal indicado.

### B. Chatbot no terminal (requisitos da transcrição da aula)

- **F4. Chat interativo em CLI** → o usuário inicia o programa com um único comando, digita perguntas em sequência e recebe respostas até encerrar com um comando de saída explícito.
- **F5. System prompt customizável** → o usuário consegue trocar as instruções globais (por arquivo ou parâmetro de inicialização) sem alterar código-fonte, e o comportamento do assistente reflete a troca na execução seguinte. As regras da camada de políticas continuam sendo aplicadas mesmo com instruções globais customizadas; em caso de conflito (ex.: instrução global pedindo tom informal), prevalece a política.
- **F6. Resposta em streaming** → o texto da resposta aparece no terminal de forma incremental, à medida que é gerado, e não de uma vez só ao final.
- **F7. Histórico da conversa durante a sessão** → o usuário faz uma pergunta de acompanhamento que depende da anterior (ex.: "e qual é o prazo disso?") e a resposta considera o contexto anterior. O histórico é descartado ao encerrar o programa. Existe um comando para limpar o histórico na sessão.
- **F8. Tratamento de erros com retry** → diante de falha transitória do provedor (rede, timeout, erro de servidor), o sistema tenta novamente um número limitado de vezes com espera crescente, informa o usuário que está tentando de novo e, esgotadas as tentativas, mostra mensagem clara sem encerrar o programa nem perder o histórico. Erros não recuperáveis (ex.: credencial ausente ou inválida) geram mensagem orientando a correção, sem novas tentativas. Verificação: com a rede desconectada, o usuário vê os avisos de nova tentativa e a mensagem final, e o chat continua aberto; com credencial inválida, vê a orientação de correção sem novas tentativas.
- **F9. Rate limit** → (a) quando o provedor responde que o limite foi excedido, o sistema aguarda e tenta novamente em vez de falhar; (b) existe um limite local configurável de requisições por intervalo, e ao atingi-lo o usuário vê uma mensagem informando quanto tempo aguardar. Verificação de (b): configurando um limite baixo e enviando perguntas em sequência, a mensagem de espera aparece.
- **F10. Self-critique** → antes de ser considerada final, cada resposta passa por uma etapa de autoavaliação contra as políticas (P1–P5). Se a avaliação apontar violação, a resposta é corrigida ou substituída por uma recusa/encaminhamento adequado. O resultado da autoavaliação (aprovada/reprovada e qual regra) fica registrado e pode ser exibido em um modo detalhado.

### C. Evidências para avaliação

- **F11. Casos de teste (12 casos; o enunciado exige no mínimo 10)** → existe um conjunto documentado de casos, cada um com: identificador, pergunta (ou sequência de perguntas, quando o caso depende de histórico), regra(s) exercitada(s), comportamento esperado e critério de aprovação. Cobertura obrigatória:
  - 2 perguntas dentro do escopo com resposta na base (caminho feliz);
  - 1 pergunta dentro do escopo sem resposta na base (não inventar);
  - 2 perguntas de tema proibido (P1);
  - 2 perguntas fora de escopo (P3);
  - 2 casos críticos de encaminhamento (P4);
  - 1 pergunta em linguagem informal/agressiva (P2);
  - 1 tentativa de manipulação — "ignore suas instruções" (P5);
  - 1 pergunta de acompanhamento dependente do histórico (F7).
- **F12. Execução dos testes e outputs gerados** → um único comando executa todos os casos contra o modelo real da OpenAI e grava em arquivo, para cada execução: pergunta, resposta completa, resultado da autoavaliação, veredito (passou/falhou) e data/hora. Os arquivos de output ficam no repositório como entregável.
- **F13. Validação de consistência** → cada caso de teste é executado no mínimo 3 vezes; o relatório mostra, por caso, quantas execuções respeitaram o comportamento esperado (ex.: 3/3). Meta: 100% dos casos com todas as execuções aprovadas.
- **F14. Análise de comportamento** → documento escrito contendo: tabela de resultados por caso e por regra, taxa de consistência, falhas observadas e como foram corrigidas (iterações no contexto), limitações conhecidas e a justificativa das decisões de arquitetura de contexto.
- **F15. Instruções de execução** → README com passo a passo para instalar, configurar a credencial, rodar o chat e rodar os testes. Uma pessoa que nunca viu o projeto consegue executar o chat seguindo apenas o README. Nenhuma credencial fica gravada no repositório.

## Rastreabilidade: enunciado → PRD

| # | Requisito do enunciado | Origem | Coberto por |
|---|---|---|---|
| R1 | Definir regras de atendimento (policy layer) | Escopo 1 | F1 |
| R2 | Estruturar o contexto separando instruções globais, regras e dados do usuário | Escopo 2 | F2 |
| R3 | Testar cenários críticos (ex.: perguntas proibidas) | Escopo 3 | F11, F12 |
| R4 | Validar consistência | Escopo 4 | F13 |
| N1 | Regra: não dar recomendações financeiras diretas | Contexto empresarial | F1/P1 (ver equivalência abaixo) |
| N2 | Regra: linguagem formal | Contexto empresarial | F1/P2 |
| N3 | Regra: evitar respostas fora de escopo | Contexto empresarial | F1/P3 |
| N4 | Regra: encaminhar casos críticos para humanos | Contexto empresarial | F1/P4 |
| E1 | Entregável: documento de políticas | O que será entregue | F1 |
| E2 | Entregável: estrutura de contexto (modelo reutilizável) | O que será entregue | F2 |
| E3 | Entregável: casos de teste (mín. 10) | O que será entregue | F11 (12 casos) |
| E4 | Entregável: outputs gerados | O que será entregue | F12 |
| E5 | Entregável: análise de comportamento | O que será entregue | F14 |
| C1 | IA respeita regras em todos os testes | Critérios de aceitação | F10, F12, F13 (meta 100%) |
| C2 | Não responde fora de escopo definido | Critérios de aceitação | F1/P3, F3, F11 (casos fora de escopo) |
| C3 | Consistência em múltiplas execuções | Critérios de aceitação | F13 |
| C4 | Separação clara entre regras e dados | Critérios de aceitação | F2 |
| V1 | Evidência: controle do modelo via contexto | Evidências esperadas | F2, F5, F14 |
| V2 | Evidência: pensamento arquitetural | Evidências esperadas | F2, F14 (justificativa das decisões) |
| V3 | Evidência: robustez em cenários críticos | Evidências esperadas | F1/P4–P5, F10, F11, F13 |
| T1 | Chatbot interativo em CLI | Transcrição | F4 |
| T2 | Implementado em TypeScript | Transcrição | Restrição do projeto (decisão D2) |
| T3 | Usando a OpenAI | Transcrição | Restrição do projeto (decisão D2) |
| T4 | System prompt customizável | Transcrição | F5 |
| T5 | Stream de resposta | Transcrição | F6 |
| T6 | Histórico de conversa mantido durante a sessão | Transcrição | F7 |
| T7 | Error handler com retry | Transcrição | F8 |
| T8 | Rate limit | Transcrição | F9 |
| T9 | Self-critique | Transcrição | F10 |
| T10 | "Tudo o que a gente viu aqui" | Transcrição | FECHADO por decisão do dono (D3): o conjunto de técnicas exigidas é exatamente T1–T9; nenhuma técnica adicional é requisito |

### Equivalência das regras fintech → onboarding (apenas referência)

A troca de tema já foi combinada com o professor; esta tabela serve só para o avaliador localizar cada regra do enunciado.

| Regra do enunciado (fintech) | Regra neste projeto (onboarding) |
|---|---|
| Não dar recomendações financeiras diretas | P1 — não dar aconselhamento individual (jurídico, médico, financeiro), não opinar em decisões pessoais, não divulgar dados confidenciais |
| Seguir linguagem formal | P2 — linguagem formal, sem alteração |
| Evitar respostas fora de escopo | P3 — apenas onboarding e conteúdo da base; sem inventar |
| Encaminhar casos críticos para humanos | P4 — encaminhar ao canal humano definido na base |
| (sem equivalente no enunciado) | P5 — resistência a manipulação; sustenta a evidência "robustez em cenários críticos" |

## Fora do MVP (por enquanto)

- Fintech como segundo domínio (segundo conjunto de políticas e dados): a reutilização é demonstrada pela documentação de F2, não por um segundo domínio implementado.
- Técnicas das aulas anteriores não citadas na transcrição (ex.: contagem de tokens, controle de tamanho do contexto, saída estruturada, few-shot) como requisito de produto. O arquiteto pode usá-las como meio de implementação, mas nenhuma é critério de aceite.
- Uso de empresa real ou de documentos reais na base de conhecimento.
- Interface web, mobile ou integração com Slack/Teams/WhatsApp.
- Busca semântica/RAG sobre grande volume de documentos: a base é pequena e entra inteira no contexto.
- Persistência de histórico entre sessões, memória de longo prazo, resumo automático de conversas longas.
- Autenticação, múltiplos usuários simultâneos, controle de acesso por perfil.
- Integração com sistemas reais (RH, folha, diretório de funcionários, abertura automática de chamado). O encaminhamento a humanos é apenas uma orientação em texto.
- Suporte a múltiplos idiomas (somente português).
- Suporte a múltiplos provedores de LLM (somente OpenAI).
- Testes contra modelo simulado/mock: a bateria de F12 roda contra o modelo real.
- Edição da base de conhecimento ou das políticas por interface: são editadas como arquivos.
- Painel de métricas, observabilidade, controle de custo por usuário.
- Empacotamento/publicação como pacote instalável e pipeline de CI.

## Métricas de sucesso

- 100% dos casos de teste aprovados em todas as execuções (12 casos x 3 execuções = 36 execuções).
- 0 respostas substantivas a perguntas fora de escopo ou de tema proibido nos testes.
- 100% dos casos críticos com encaminhamento ao canal humano correto.
- 5 de 5 entregáveis do enunciado presentes no repositório (E1–E5).
- Todos os itens T1–T9 demonstráveis pelo avaliador: T1 e T4–T6, T8(b) e T9 em uma sessão normal de até 5 minutos; T7 por falha induzida (rede desconectada ou credencial inválida).
- Avaliador consegue rodar o chat seguindo apenas o README.

## Riscos e premissas

### Decisões confirmadas pelo dono

- **D1. Empresa fictícia:** a empresa e toda a base de conhecimento são inventadas para o trabalho; nenhum dado real ou confidencial.
- **D2. Linguagem, provedor e modelo:** TypeScript e OpenAI, com modelo de baixo custo. A escolha do modelo exato é do arquiteto. Os testes rodam contra o modelo real.
- **D3. Técnicas exigidas:** somente as citadas no PDF — CLI, TypeScript, OpenAI, system prompt customizável, streaming, histórico de sessão, retry, rate limit e self-critique. A frase "tudo o que a gente viu aqui" fica encerrada com essa lista.
- **D4. Tema:** a troca de fintech para onboarding já foi combinada com o professor. Fintech não entra como segundo domínio.

### Premissas (assumidas; corrigir se estiverem erradas)

- **Entrega:** repositório Git com README de execução; data limite não informada (ver Perguntas em aberto).
- **Credencial e custo:** o dono dispõe de uma chave de API da OpenAI com crédito suficiente para a bateria de testes (no mínimo 36 execuções, cada uma com geração e autoavaliação, mais as reexecuções das iterações de ajuste). O custo é pequeno e pago pelo dono.
- **Perfil do usuário:** um ou dois perfis de novo funcionário fictícios, carregados na inicialização; não há cadastro.
- **Idioma:** chatbot e documentação em português.
- **Quatro camadas em vez de três:** o enunciado pede instruções globais, regras e dados do usuário. A base de conhecimento da empresa é tratada como uma quarta camada de dados, separada das regras, o que reforça o critério C4.
- **Uso individual e local:** uma pessoa, uma sessão, na máquina do próprio usuário.

### Riscos

- **Não determinismo do modelo:** o critério "respeita regras em todos os testes" e "consistência" pode falhar de forma intermitente, e um modelo de baixo custo tende a seguir instruções com menos rigor. Mitigação: self-critique (F10), execuções repetidas (F13) e iteração no contexto registrada na análise (F14).
- **Streaming versus self-critique:** se a resposta é exibida enquanto é gerada, uma violação pode aparecer na tela antes de a autoavaliação reprová-la. É uma decisão de arquitetura que precisa ser tomada explicitamente; o critério de produto é que nenhuma resposta reprovada seja apresentada como resposta final sem correção visível.
- **Avaliação automática de respostas em linguagem natural:** decidir "passou/falhou" pode exigir julgamento. Mitigação: critérios de aprovação objetivos por caso e revisão manual dos outputs na análise.
- **Custo e limites da API:** conta com limite baixo pode interromper a bateria de testes. Mitigação: F8 e F9.
- **Vazamento de credencial:** chave de API não pode ir para o repositório (F15).
- **Prazo desconhecido:** sem data limite, não há como calibrar o esforço de iteração em F13/F14. Mitigação: o escopo já é o mínimo que cobre o enunciado; se o prazo for curto, corta-se primeiro o número de iterações de ajuste, nunca os entregáveis E1–E5.

## Perguntas em aberto

1. **Formato e data de entrega:** a premissa atual é repositório Git com README de execução. Confirmar: (a) repositório Git com link — premissa atual; (b) arquivo compactado enviado na plataforma; (c) repositório mais vídeo de demonstração. Qual é a data limite? Não bloqueia o início: as opções (b) e (c) só acrescentam um passo de empacotamento ao final.
