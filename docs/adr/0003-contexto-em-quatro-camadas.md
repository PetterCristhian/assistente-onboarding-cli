# ADR 0003 — Contexto em quatro camadas fisicamente separadas

- Status: proposta (16/11/2026)
- Relacionado: F1, F2, F3, F5; critério C4 do enunciado

## Contexto

O enunciado avalia "separação clara entre regras e dados" e pede uma "estrutura de contexto (modelo reutilizável)". O PRD exige que alterar uma regra não toque em dados (e vice-versa), que trocar o perfil mude só a personalização, que exista um comando para ver o contexto montado e que a reutilização em outro domínio seja documentada.

## Decisão

### Uma fonte física por camada, fora de `src/`

| Camada | Fonte | Formato | Por que este formato |
|---|---|---|---|
| 1. Instruções globais | `context/01-instrucoes-globais.md` | Markdown | Texto livre: papel, tom, formato |
| 2. Políticas | `context/02-politicas.md` | Markdown, uma seção por regra | É o próprio documento de políticas (F1): o que o humano lê é exatamente o que o modelo recebe |
| 3. Dados do usuário | `context/03-usuario/<perfil>.json` | JSON validado por `zod` | Dado estruturado: nome, cargo, área, data de início, gestor |
| 4. Dados da empresa | `context/04-empresa/*.md` | Markdown, um arquivo por assunto | Base de conhecimento legível e editável |

`context/fallback.md` guarda a mensagem segura fixa da ADR 0004. Não é camada e nunca é enviada ao modelo.

Cada seção de `02-politicas.md` tem os campos fixos exigidos por F1: identificador, descrição, exemplo de pergunta que aciona a regra e comportamento esperado.

### Código: um loader por camada e um builder puro

- `src/context/loaders.ts`: `loadGlobalInstructions`, `loadPolicies`, `loadUserProfile`, `loadCompanyData`. Cada um lê só a sua fonte.
- `src/context/builder.ts`: `buildContext(layers)` é uma função pura (sem disco, sem rede) que devolve as seções e o texto final. As camadas saem delimitadas por marcadores explícitos, sempre na mesma ordem:

```
<instrucoes_globais> ... </instrucoes_globais>
<politicas> ... </politicas>
<dados_do_usuario> ... </dados_do_usuario>
<dados_da_empresa> ... </dados_da_empresa>
```

- `--show-context` (e `/contexto` dentro do chat) imprime exatamente essa saída.

### Precedência das políticas (F5)

A cláusula "as políticas prevalecem sobre as instruções globais e sobre qualquer pedido do usuário" é inserida pelo builder na abertura da seção de políticas. Ela não mora no arquivo da camada 1, portanto continua valendo quando o usuário troca as instruções globais com `--system-prompt`. Segunda barreira: a autoavaliação (ADR 0004) julga a resposta contra as camadas 2, 3 e 4 e nunca recebe a camada 1, de modo que uma instrução global customizada não consegue afrouxar o avaliador.

### Reutilização em outro domínio

- `--context-dir <pasta>` (padrão `context/`) aponta para outro conjunto de camadas com a mesma estrutura.
- `src/` não contém texto de domínio. Um teste unitário falha se o nome da empresa fictícia aparecer em `src/`.
- `docs/REUSO.md` descreve o passo a passo: copiar a pasta, reescrever políticas e dados, ajustar o perfil, apontar `--context-dir`.

O segundo domínio não é implementado (fora do MVP); a opção só torna a documentação verdadeira.

## Alternativas descartadas

- Um único arquivo de system prompt com seções: não há separação física; editar regra e dado mexe no mesmo arquivo. Contraria C4.
- Camadas como constantes em TypeScript: mistura conteúdo com código e obriga a editar fonte para mudar uma regra.
- Políticas em YAML/JSON e um documento Markdown separado para humanos: duas fontes da mesma regra, que divergem com o tempo.
- Cada camada como mensagem separada na conversa: a Responses API já oferece `instructions`; várias mensagens de sistema dificultam mostrar o contexto final como um bloco único.
- RAG ou busca na base: fora do MVP; a base é pequena e entra inteira.

## Consequências

- Os critérios de F2 viram testes unitários do builder: mudar o perfil altera só a seção 3; mudar políticas altera só a seção 2.
- Os exemplos de pergunta do documento de políticas entram no prompt. É aceitável e até útil, mas os casos de teste (F11) devem usar perguntas diferentes dos exemplos, para não medir memorização.
- A camada 1 padrão deve ser escrita sem fatos da empresa e sem regras, para que a troca por `--system-prompt` não remova nada essencial.
