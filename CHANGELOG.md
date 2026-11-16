# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado

- Documentação inicial: PRD, arquitetura, ADRs 0001–0007 e backlog do MVP.
- Entorno do repositório: `.gitignore`, `.gitattributes` (finais de linha em LF), `.editorconfig`, `.nvmrc` (Node 24) e `.env.example` com todas as variáveis, sem valores reais.
- Workflow de CI no GitHub Actions (`.github/workflows/ci.yml`): `npm ci` + `npm run check` a cada PR e a cada push na `main`, sem usar a chave da OpenAI.
- `README.md` inicial.

### Alterado

- ADR 0001, `docs/ARQUITETURA.md` e issue 1 de `docs/BACKLOG.md`: o projeto passa a ter um workflow pequeno de CI, por decisão do dono (o PRD deixava CI fora do MVP).
