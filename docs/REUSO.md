# Reuso da estrutura de contexto em outro domínio

Este guia mostra o que trocar para aplicar a estrutura do projeto (quatro camadas separadas, política com identificador, autoavaliação) a outro domínio, e onde o código de hoje ainda prende o domínio de onboarding. Cobre F2 do PRD. Os limites estão na seção 4: leia antes de começar.

Nota: este é um guia técnico de como a estrutura funciona. O projeto não tem licença (todos os direitos reservados), então o reuso do código depende de autorização do autor.

## 1. Domínio e código

| Domínio (o que se troca) | Código (o que não se troca) |
|---|---|
| `context/01-instrucoes-globais.md` (camada 1) | `src/` (carregadores, montador, chat, cliente, segurança) |
| `context/02-politicas.md` (camada 2) | `scripts/` |
| `context/03-usuario/*.json` (camada 3) | `evals/` (runner, veredito, relatório), exceto `evals/casos.json` |
| `context/04-empresa/*.md` (camada 4) | |
| `context/fallback.md`, `context/avaliador.md`, `context/revisao.md`, `context/juiz.md` | |
| `evals/casos.json` | |

`revisao.md` precisa conter o marcador `{{violacoes}}`: o carregador recusa o arquivo sem ele.

## 2. Passo a passo com uma pasta de exemplo

`tests/fixtures/minimal-context/` é um contexto mínimo de outro domínio (uma mercearia fictícia). Os comandos abaixo não usam chave nem rede. Copie a pasta para fora do repositório, para que o lint do projeto não a leia:

```powershell
Copy-Item -Recurse tests/fixtures/minimal-context ../meu-dominio   # PowerShell
```

```bash
cp -r tests/fixtures/minimal-context ../meu-dominio                # bash
```

1. Troque `01-instrucoes-globais.md` (papel, tom e formato) e `02-politicas.md` (as regras).
2. Troque os perfis de `03-usuario/` (um `.json` por pessoa) e os documentos de `04-empresa/` (um `.md` por assunto).
3. Troque `fallback.md` (mensagem segura) e reescreva `avaliador.md`, `revisao.md` e `juiz.md` (seção 4).
4. Veja o contexto montado, sem chave e sem rede (o mesmo comando vale nos dois shells):

```bash
npm run chat -- --show-context --context-dir ../meu-dominio
```

O caminho é lido a partir da pasta atual. Os arquivos de camada têm no máximo 64 KiB cada, e `03-usuario/` e `04-empresa/` são lidos em ordem alfabética do nome do arquivo. Sem `--perfil`, vale o primeiro perfil dessa ordem.

## 3. O que funciona hoje

- Trocar o conteúdo das quatro camadas e dos arquivos de apoio sem editar `src/`, desde que sejam respeitados os limites abaixo.
- Trocar só o perfil (`--perfil`) ou só as instruções globais (`--system-prompt`).
- Ver o contexto final com as quatro camadas delimitadas (`--show-context`).
- Conversar no terminal com outra pasta (`--context-dir`), com chave.

## 4. Limitações verificadas

- **Perfil fixo.** `userProfileSchema` (`src/context/types.ts`) é estrito e exige os cinco campos `nome`, `cargo`, `area`, `dataInicio` (AAAA-MM-DD) e `gestor`. Um campo extra é recusado e todos são obrigatórios.
- **Rótulos e mensagens em `src/`.** Os marcadores das camadas, a cláusula de precedência da política, os rótulos do perfil (`Nome: ...`), a saudação `Olá, {nome}.` e as mensagens ao usuário, em português, ficam no código, não no domínio.
- **Regras P1 a P5 fixas.** Os identificadores vêm de `src/chat/critique.ts` (a saída do avaliador só aceita P1 a P5) e de `evals/schema.ts`. Um domínio novo deve manter cinco regras com esses ids. O schema de saída do avaliador só aceita os ids P1 a P5 (`src/chat/critique.ts`). Se a saída trouxer outro id, ela é inválida, a falha da autoavaliação conta como reprovação e o usuário recebe a mensagem segura de `fallback.md`. Um domínio com outros ids não consegue ser avaliado corretamente. A pasta de exemplo usa outros ids (F1 e F2) e por isso serve só para `--show-context`.
- **Prompts de apoio presos ao onboarding.** `avaliador.md`, `revisao.md` e `juiz.md` mencionam onboarding e P1 a P5 e precisam ser reescritos.
- **A bateria não aceita outro domínio por opção.** `scripts/eval.ts` fixa `context/` e `evals/casos.json`, e `evals/args.ts` só tem `--runs`, `--case` e `--help`. Para rodar a bateria em outro domínio, é preciso substituir `context/` e `evals/casos.json` em uma cópia do repositório. Nessa cópia, `casos.json` continua limitado pelas categorias e regras de `evals/schema.ts` e pelos perfis que existirem em `03-usuario/`, e vários testes presos ao domínio atual falharão (por exemplo `tests/context-content.test.ts`, `tests/company-data.test.ts`, `tests/policies-document.test.ts`).
- **`--context-dir` vale para o chat e para `--show-context`**, não para `npm run contexto` nem para `npm run eval`.
- **Arquivos de memória (disciplina 2).** O chat também lê `memoria-uso.md`, `memoria-extracao.md` e `resumo.md` na inicialização e encerra com erro se faltarem. Um domínio novo precisa escrever os três, ou usar `--efemera`, que não grava sessão nem usa memória. A pasta de exemplo não os tem.
- **O `--show-context` não valida os arquivos de apoio.** Ele não lê `fallback.md`, `avaliador.md` nem `revisao.md`; o chat lê os três na inicialização e encerra com erro se faltarem (ou se `revisao.md` não tiver `{{violacoes}}`).

Melhoria pós-MVP, fora do escopo atual: opções `--context-dir` e `--casos` no `npm run eval`.

## 5. Como verificar

- `npm run chat -- --show-context --context-dir <pasta>`: as quatro seções aparecem entre marcadores, com o conteúdo da pasta.
- `npm test`: os testes de `tests/reuso.test.ts` conferem que a pasta de exemplo tem todos os arquivos exigidos acima e que este guia cita o comando da seção 2.
