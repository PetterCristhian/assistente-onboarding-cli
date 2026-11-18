# ADR 0008 — Persistência de sessão, memória do funcionário e compressão

- Status: aceita (18/11/2026), implementada na disciplina 2
- Relacionado: `docs/PRD-DISCIPLINA-02.md` (G1 a G22); estende as ADRs 0003 e 0004
- Substitui: a decisão "sem estado persistente" da arquitetura da disciplina 1 (`docs/ARQUITETURA.md`, seções 1 e 9)

## Contexto

A disciplina 2 pede um chatbot com estado: sessão que pode ser retomada pelo identificador, memória de longo prazo por usuário, usada só quando pertinente, e compressão do histórico quando ele cresce. O projeto da disciplina 1 tinha histórico só em memória e proibia persistência. O prazo é curto (entrega em 19/11/2026), então a mudança precisa tocar o mínimo possível no pipeline já validado por 36 execuções aprovadas.

## Decisão

1. **O pipeline do turno não muda.** `src/chat/session.ts` ganha só três pontos de extensão: `initialHistory` (retomada), `extraContext` por pergunta (memória e resumo) e `dropOldest` (janela deslizante). Tudo o mais fica em `src/memory/stateful-session.ts`, que embrulha a sessão. Chat e comparação usam o mesmo embrulho (regra de arquitetura 6).
2. **Armazenamento em arquivos JSON**, sem banco e sem dependência nova: `data/sessoes/<id>.json` e `data/memoria/<perfil>.json`, validados com `zod` na leitura (`src/storage/state-store.ts`). A escrita passa pelo escritor único, que agora aceita `data/` além de `outputs/` e `logs/`, e redige segredos. `data/` é ignorada pelo Git porque o repositório é público.
3. **Estrutura da memória:** itens com `id`, `categoria` (`solicitacoes`, `preferencias`, `problemas`, `relacionamento`), `texto`, `palavrasChave`, `criadoEm` e `sessao`. Um arquivo por perfil: a memória nunca cruza perfis.
4. **Gravação da memória:** depois de um turno com resposta final, uma chamada de saída estruturada extrai os fatos novos declarados pelo usuário (`context/memoria-extracao.md`). Isso vale também quando o turno termina na mensagem segura, porque o fato vem da fala do usuário e não da resposta (na primeira comparação, bateria `2026-11-18T18-27-24Z`, a regra oposta fez o caso M01 perder o fato; corrigido no código, sem alterar o caso). Relato sensível não tem o conteúdo gravado; registra-se só o encaminhamento. Itens repetidos são descartados no código.
5. **Recuperação determinística, sem chamada ao modelo:** a pergunta e cada item são reduzidos a radicais de palavras, sem palavras vazias; entra o item que compartilha ao menos um radical com a pergunta (texto, palavras-chave ou nome da categoria). Preferências entram sempre, porque moldam qualquer resposta. Há teto de itens (`MEMORY_MAX_ITEMS`) e de tokens. Pergunta sem relação com a memória não recebe item nenhum, o que é a principal defesa contra uso irrelevante.
6. **Uso na resposta:** os itens escolhidos formam uma seção própria, `<memoria_do_usuario>`, acrescentada depois das quatro camadas e aberta pela regra de uso (`context/memoria-uso.md`). O avaliador recebe a mesma seção, para não reprovar como invenção uma resposta que cita a memória. O montador das quatro camadas e seus oito marcadores não mudam.
7. **Compressão em quatro técnicas combinadas** (`src/memory/compression.ts`):
   - condicional: só acontece acima de `COMPRESS_MAX_TOKENS` ou `COMPRESS_MAX_MESSAGES`, ou quando forçada por `/comprimir`;
   - janela deslizante: ficam inteiras as últimas `COMPRESS_KEEP_MESSAGES` mensagens;
   - limite por tokens: a janela encolhe mais enquanto passar do teto de tokens, mantendo ao menos um turno;
   - sumarização: o que sai é incorporado a um resumo acumulado (`context/resumo.md`), gravado com a sessão e enviado na seção `<resumo_da_conversa>`.
   Nada é descartado sem resumo: se a chamada de resumo falha, o histórico fica como está e a tentativa se repete no turno seguinte.
8. **Contagem de tokens por estimativa** (4 caracteres por token), sem tokenizador, para não acrescentar dependência. O consumo real de cada turno continua vindo da API e aparece no modo detalhado.
9. **Invariante da autoavaliação preservada.** Só o pipeline escreve no histórico. O arquivo de sessão guarda apenas respostas finais. O resumo e a memória não entram no histórico: vão como contexto, marcados como dados. O resumo é texto do modelo não autoavaliado, derivado só de textos aprovados; a resposta que o usa é autoavaliada normalmente.
10. **Evidência:** `npm run eval:memoria` roda os casos de `evals/casos-memoria.json` duas vezes (com memória e sem memória) contra o modelo real e grava `outputs/memoria/<id>/` com `COMPARACAO.md`, `comparacao.json`, `execucoes.jsonl` e o estado de cada execução. Veredito determinístico, sem juiz. Um caso que depende de memória só é conforme se passa com memória e falha sem ela.
11. **`--efemera`** desliga sessão e memória (comportamento da disciplina 1). É usada pelos testes de ponta a ponta, que assim não gravam nada em `data/`.

## Alternativas descartadas

- **SQLite (`node:sqlite`):** resolveria consultas, mas o volume é de poucos itens por perfil e arquivos JSON são legíveis pelo avaliador sem ferramenta.
- **Embeddings ou busca semântica:** fora do escopo (PRD); a recuperação por radicais basta para dezenas de itens e é auditável.
- **Escolher a memória com uma chamada ao modelo:** mais uma chamada por turno e resultado não determinístico.
- **Regra P6 nas políticas:** exigiria mudar o schema do avaliador, o schema dos casos e os 12 casos da disciplina 1. A regra de uso ficou em arquivo próprio, que abre a seção de memória.
- **Resumo dentro do histórico, como mensagem do assistente:** violaria a regra 5 (texto não autoavaliado no histórico).

## Consequências e limites

- Cada turno com memória ligada faz uma chamada a mais (extração); a compressão faz outra, só quando dispara.
- A recuperação por radicais não entende sinônimos que o extrator não tenha listado em `palavrasChave`; uma pergunta muito vaga ("como ficou aquilo?") pode não trazer o item.
- Itens contraditórios não são resolvidos: os dois ficam, e o mais recente tem prioridade na ordenação. O usuário pode apagar tudo com `/esquecer`; não há edição de item.
- Os dados em `data/` não são cifrados.
- A bateria da disciplina 1 (`npm run eval`) não usa o embrulho com memória; os 12 casos não foram rodados de novo com memória ligada.
- Um `--context-dir` de outro domínio precisa dos três arquivos novos (`memoria-uso.md`, `memoria-extracao.md`, `resumo.md`), ou do uso de `--efemera`.
