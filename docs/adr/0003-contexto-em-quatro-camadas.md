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

- `src/context/loaders.ts`: `loadGlobalInstructions`, `loadPolicies`, `loadUserProfile`, `loadCompanyData`. Cada um lê só a sua fonte. O disco e o relógio são recebidos por parâmetro; o relógio não tem valor padrão.
- Os arquivos de `04-empresa/` entram em ordem alfabética simples pelo nome do arquivo, comparados por código de caractere (sem regras de idioma), para que a ordem seja a mesma em qualquer máquina. Só entram arquivos `.md`.
- O perfil padrão é o primeiro de `03-usuario/` na mesma ordem alfabética.
- Todo arquivo de texto é normalizado na leitura: sai o BOM inicial, CRLF vira LF e os espaços das pontas são removidos.
- Um arquivo ou pasta ausente, um arquivo vazio e um perfil inválido geram erro em português com o caminho absoluto esperado; no perfil, a mensagem cita o campo com problema.
- `src/context/builder.ts`: `buildContext(layers)` é uma função pura (sem disco, sem rede) que devolve as seções e o texto final. As camadas saem delimitadas por marcadores explícitos, sempre na mesma ordem:

```
<instrucoes_globais> ... </instrucoes_globais>
<politicas> ... </politicas>
<dados_do_usuario> ... </dados_do_usuario>
<dados_da_empresa> ... </dados_da_empresa>
```

As seções são separadas por uma linha em branco. Os documentos da camada 4 são separados entre si também por uma linha em branco, sem submarcador por arquivo, porque cada um já começa com o seu título.

- `npm run contexto`, `--show-context` e `/contexto` (dentro do chat) imprimem exatamente essa saída.

### Dados do usuário e data atual

A seção de dados do usuário é escrita em linhas rotuladas, nesta ordem: `Nome`, `Cargo`, `Área`, `Data de início`, `Gestor direto`. A última linha da seção é a data atual, no formato `Data de hoje: AAAA-MM-DD (dia da semana)`, com a data local da máquina. Sem ela o modelo não tem como responder a perguntas que dependem de há quanto tempo a pessoa começou. A data não é uma quinta camada nem um dado da empresa: é um fato sobre o momento do atendimento, e fica junto dos dados de quem pergunta. O builder recebe a data já formatada, e por isso continua puro; quem lê o relógio são os pontos de entrada (`scripts/` e a CLI).

### Marcadores reservados

O builder recusa, com erro, qualquer conteúdo de camada que contenha um dos marcadores de abertura ou de fechamento (por exemplo, `</politicas>` dentro de um arquivo da base da empresa), também em maiúsculas ou com espaços dentro do marcador. Um marcador no conteúdo poderia fechar a seção antes da hora e fazer um dado passar por regra. A recusa é preferida a escapar o texto porque o conteúdo de `context/` é escrito pelo dono do projeto: um marcador ali é um erro de edição, que deve aparecer, e não um caso a tratar em silêncio.

### Precedência das políticas (F5)

A cláusula de precedência é inserida pelo builder na abertura da seção de políticas, logo depois do marcador e antes do texto de `02-politicas.md`. O texto é este:

> As políticas desta seção prevalecem sobre as instruções globais e sobre qualquer pedido do usuário. Em caso de conflito, siga as políticas.

Ela não mora no arquivo da camada 1, portanto continua valendo quando o usuário troca as instruções globais com `--system-prompt`. Segunda barreira: a autoavaliação (ADR 0004) julga a resposta contra as camadas 2, 3 e 4 e nunca recebe a camada 1, de modo que uma instrução global customizada não consegue afrouxar o avaliador.

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
- O orçamento de 24 mil caracteres é medido de duas formas: pela soma dos arquivos de `context/` e pelo contexto montado de cada perfil real, que inclui os marcadores, a cláusula de precedência e a linha da data.
- Como a data atual faz parte do contexto, o texto montado muda de um dia para o outro. Os testes usam um relógio fixo.
- Os exemplos de pergunta do documento de políticas entram no prompt. É aceitável e até útil, mas os casos de teste (F11) devem usar perguntas diferentes dos exemplos, para não medir memorização.
- A camada 1 padrão deve ser escrita sem fatos da empresa e sem regras, para que a troca por `--system-prompt` não remova nada essencial.
