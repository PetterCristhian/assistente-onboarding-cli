# ADR 0003 — Contexto em quatro camadas fisicamente separadas

- Status: aceita (18/11/2026)
- Relacionado: F1, F2, F3, F5; critério C4 do enunciado
- Aceita na verificação final (ENG-61), depois de conferida com `src/context/loaders.ts`, `src/context/builder.ts`, `context/` e os testes de contexto. Observação de escopo: `--context-dir` está implementado para o chat e `--show-context`, não para `npm run contexto` nem para `npm run eval`, e o segundo domínio continua não executado (limites em `docs/REUSO.md`, seção 4).

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
- Os arquivos de `04-empresa/` entram em ordem alfabética simples pelo nome do arquivo, comparados por código de caractere (sem regras de idioma), para que a ordem seja a mesma em qualquer máquina. Só entram arquivos `.md`; um arquivo cujo nome é só a extensão (`.md`, ou `.json` na pasta dos perfis) é ignorado.
- O perfil padrão é o primeiro de `03-usuario/` na mesma ordem alfabética.
- Os campos de texto do perfil (`nome`, `cargo`, `area`, `gestor`) têm uma única linha: um valor com quebra de linha (LF, CR, tabulação vertical, avanço de página, U+0085, U+2028 ou U+2029) é recusado, com a mensagem `campo "<campo>" deve ter uma única linha`. Cada valor ocupa uma linha rotulada da seção do usuário, e uma quebra dentro dele forjaria outro rótulo. Um valor vazio, que não é texto ou que tem espaços nas pontas gera `deve ser um texto não vazio, sem espaços no início ou no fim`.
- Uma pasta de contexto vazia (`""` ou só espaços) é recusada, em vez de ser lida como a pasta atual. O mesmo vale para o caminho do arquivo de instruções globais informado no lugar do padrão.
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

- `npm run contexto`, `--show-context` e `/contexto` (dentro do chat) imprimem exatamente essa saída. `npm run contexto` termina com código 1 quando o contexto não pode ser montado e com código 2 em um erro inesperado, sempre com uma linha de mensagem e sem stack trace.

### Dados do usuário e data atual

A seção de dados do usuário é escrita em linhas rotuladas, nesta ordem: `Nome`, `Cargo`, `Área`, `Data de início`, `Gestor direto`. A última linha da seção é a data atual, no formato `Data de hoje: AAAA-MM-DD (dia da semana)`, com a data local da máquina. Sem ela o modelo não tem como responder a perguntas que dependem de há quanto tempo a pessoa começou. A data não é uma quinta camada nem um dado da empresa: é um fato sobre o momento do atendimento, e fica junto dos dados de quem pergunta. O builder recebe a data já formatada, e por isso continua puro; quem lê o relógio são os pontos de entrada (`scripts/` e a CLI). O builder recusa uma data com quebra de linha, pelo mesmo motivo dos campos do perfil, e o formatador recusa um ano fora de 1 a 9999, que não cabe em `AAAA`. O builder confere também os cinco valores do perfil, com a mesma mensagem do loader (`campo "<campo>" deve ter uma única linha`), porque um perfil pode chegar a ele sem ter passado pelo loader.

### Marcadores reservados

O builder recusa, com erro, qualquer conteúdo de camada que contenha um marcador de abertura ou de fechamento (por exemplo, `</politicas>` dentro de um arquivo da base da empresa). Um marcador no conteúdo poderia fechar a seção antes da hora e fazer um dado passar por regra. A recusa é preferida a escapar o texto porque o conteúdo de `context/` é escrito pelo dono do projeto: um marcador ali é um erro de edição, que deve aparecer, e não um caso a tratar em silêncio.

A forma recusada é, para os quatro nomes de camada e sem diferenciar maiúsculas de minúsculas: `<`, espaços opcionais, uma ou mais `/` opcionais, espaços opcionais, o nome da camada como palavra inteira e qualquer coisa até o próximo `>`. Como expressão: `<\s*\/*\s*nome\b[^>]*>`. Ficam recusados, portanto, `</politicas attr>`, `<politicas/>`, `</politicas/>`, `<politicas x='1'>` e `<//politicas>`; continuam aceitos `<politicas_x>` (outro nome) e o nome escrito sem `<`.

O nome também é recusado com os acentos da palavra em português, que é o deslize mais provável em um arquivo escrito nesse idioma: `instru[cç][oõ]es_globais`, `pol[ií]ticas`, `dados_do_usu[aá]rio` e `dados_da_empresa`. Assim, `</políticas>` e `<instruções_globais>` são recusados como `</politicas>` e `<instrucoes_globais>`. Os marcadores que o builder escreve continuam sendo só os sem acento.

- A busca é feita em dois passos (o início do marcador e, depois, o primeiro `>`), para que um texto grande seja lido uma só vez.
- Um início de marcador sem `>` depois dele também é recusado: no texto montado, o fechamento da própria seção o completaria.
- Os documentos da camada 4 são verificados já unidos, de modo que um marcador que começa no fim de um arquivo e termina no início do seguinte é encontrado.
- A mensagem cita a camada. Na camada 4, cita também o documento em que está o início do marcador (do `<` até o nome). Só cita a junção de dois documentos quando o próprio início atravessa a fronteira entre eles (por exemplo, `<` no fim de um e `/politicas` no começo do seguinte). O marcador é citado em uma linha, cortado em 60 caracteres; quando o `>` que o fecha está em outro documento, só o início é citado, porque esse `>` pertence a um texto sem relação com o erro (uma citação em Markdown, por exemplo).
- Rede final: depois de montar, o builder confere que o texto contém exatamente os oito marcadores canônicos (sem acento, em minúsculas), uma vez cada e na ordem fixa, e mais nada com a forma recusada.

Limites conhecidos, não tratados: letras parecidas de outros alfabetos (homoglifos), acentos diferentes dos listados acima ou escritos como caractere combinante separado da letra, caracteres de largura zero dentro do nome, o `＜` de largura total, entidades como `&lt;` e a barra invertida no lugar da barra (`<\politicas>`). Nenhum deles forma um marcador igual ao que o builder escreve.

### Precedência das políticas (F5)

A cláusula de precedência é inserida pelo builder na abertura da seção de políticas, logo depois do marcador e antes do texto de `02-politicas.md`. O texto é este:

> As políticas desta seção prevalecem sobre as instruções globais e sobre qualquer pedido do usuário. Em caso de conflito, siga as políticas.

Ela não mora no arquivo da camada 1, portanto continua valendo quando o usuário troca as instruções globais com `--system-prompt`. Segunda barreira: a autoavaliação (ADR 0004) julga a resposta contra as camadas 2, 3 e 4 e nunca recebe a camada 1, de modo que uma instrução global customizada não consegue afrouxar o avaliador.

### Reutilização em outro domínio

- `--context-dir <pasta>` (padrão `context/`) aponta para outro conjunto de camadas com a mesma estrutura.
- `--system-prompt <arquivo>` substitui só a camada 1; `--perfil <nome|arquivo>` troca a camada 3. Nome ou caminho: o valor é um caminho se contém `/` ou `\`, termina em `.json` (sem diferenciar maiúsculas) ou contém `:`; caso contrário é o nome de um perfil de `<context-dir>/03-usuario/`. Nunca há fallback de um para o outro, para que um erro de digitação não leia um arquivo inesperado.
- `--show-context` imprime o contexto final e sai, sem chave e sem rede.
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
