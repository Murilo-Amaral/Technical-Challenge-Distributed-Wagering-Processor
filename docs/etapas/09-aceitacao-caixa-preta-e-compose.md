# Etapa 9 — Teste de aceitação caixa-preta e ajuste do Compose

> Commits: `a8cfa93 fix(compose): do not let the local .env disable authentication` e
> `eab6016 test: add black-box acceptance test (bun run test:acceptance)`
>
> Código: `scripts/acceptance-test.ts`, `docker-compose.yml`

## Objetivo

Verificar os requisitos do desafio **do jeito que um avaliador ou um provedor os veria**: contra a stack completa do
Compose, usando apenas as interfaces externas. Todas as suítes anteriores importam código da aplicação ou sobem
processos com configuração de teste; esta não.

## Por que um teste caixa-preta, além das suítes existentes

- As suítes de integração e concorrência usam `AUTH_MODE=disabled`, banco `wagering_test` e filas com sufixo
  aleatório. Elas provam o código, não a **montagem**: imagem Docker, variáveis do Compose, realm do Keycloak, job de
  migração, três réplicas.
- Um problema de configuração passa despercebido por testes que não usam aquela configuração. Foi exatamente o que
  aconteceu (abaixo).

## O teste (`bun run test:acceptance`)

- Interfaces usadas: API HTTP com **tokens reais do Keycloak**, filas SQS e, **somente leitura**, o banco para os
  invariantes finais.
- 57 checagens agrupadas pelas seções do enunciado:
  - health e autenticação (sem token → 401; papéis; provedor só age pelo próprio `providerId`);
  - wallets e o cenário obrigatório 100/80/80;
  - idempotência e a mesma aposta 50 vezes em paralelo;
  - regras de BET, WIN, LOSS, REFUND e ROLLBACK com seus `failureCode`;
  - identidade do provedor;
  - SQS: referência fora de ordem, reentregas e DLQ;
  - ledger (cursor) e reconciliação;
  - outbox e os 4 tipos de evento;
  - métricas expostas e eco do `X-Correlation-Id`;
  - invariantes finais: saldo = ledger em todas as wallets, journals balanceados, nenhum saldo negativo.

### Decisões de desenho

- **Repetível:** cada execução gera ids novos, então pode rodar várias vezes contra a mesma stack sem limpar nada.
- **Códigos de saída distintos:** 1 se alguma checagem falhar, 2 se a stack não estiver no ar. Um CI distingue "o
  sistema está errado" de "o ambiente não subiu".
- **Autenticação opcional:** com `KEYCLOAK_ADMIN_PASSWORD`, usa tokens reais (lendo os client secrets pela API de
  administração, como o `keycloak-token.sh`). Sem ela, assume uma stack com `COMPOSE_AUTH_MODE=disabled` e marca as
  checagens de autenticação como puladas, em vez de falhar.
- **Sem dependências da aplicação:** só `@aws-sdk/client-sqs`, `pg` e `fetch`. O teste não importa nada de `src/`.
- Endereços configuráveis: `API_URL`, `KEYCLOAK_URL`, `SQS_ENDPOINT`, `DATABASE_URL`.

```bash
docker compose up -d --build --wait
```

```bash
KEYCLOAK_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" bun run test:acceptance
```

## O bug que o teste encontrou (`a8cfa93`)

### Sintoma

A execução contra a stack revelou que ela tinha subido **sem autenticação**: as checagens que esperam 401 para
requisições sem token não passavam.

### Causa

- O `docker compose` carrega automaticamente o arquivo `.env` da pasta para interpolar variáveis.
- O `.env` usado para rodar a aplicação localmente (copiado de `.env.example`) tem `AUTH_MODE=disabled`.
- O `docker-compose.yml` repassava `AUTH_MODE` para os containers. Resultado: quem tivesse um `.env` local subia a
  stack do Compose **sem autenticação, sem nenhum aviso visível**.

Nenhuma suíte anterior pegaria isso: todas rodam com autenticação desabilitada por decisão, ou com um emissor OIDC
local configurado diretamente.

### Correção

- O Compose passou a ler uma variável **própria**: `AUTH_MODE: ${COMPOSE_AUTH_MODE:-keycloak}`.
- O padrão da stack é sempre `keycloak`. Desligar a autenticação no Compose exige pedir isso explicitamente:

```bash
COMPOSE_AUTH_MODE=disabled docker compose up -d --wait
```

- README atualizado explicando o motivo.

### Por que essa abordagem

- **Alternativa considerada:** remover `AUTH_MODE` do `.env.example`. Não resolveria para quem já tem um `.env`, e a
  execução local sem container continua precisando do modo desabilitado por conveniência.
- **Alternativa considerada:** fixar `keycloak` no Compose sem variável. Impediria subir a stack sem autenticação para
  depuração.
- Uma variável com nome diferente separa os dois contextos: o `.env` local continua valendo para `bun run start`, e
  não vaza para o Compose.

## Também nesta etapa

`docs/LOAD_TEST.md` ganhou a rodada C, executada depois das correções de ordem por wallet da etapa 8.

## Lição

Testes que exercitam a montagem final pegam uma classe de erro (configuração, interpolação, integração entre
containers) que nenhum teste de código pega. Vale ter pelo menos um.
