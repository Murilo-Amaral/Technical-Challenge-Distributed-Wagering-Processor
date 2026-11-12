# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas
de múltiplos provedores, por **HTTP** e por **SQS**. Ele continua correto com mensagens duplicadas, fora de ordem e
processadas em paralelo por várias instâncias.

- **Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · PostgreSQL 16 · TypeORM 0.3 · SQS (LocalStack) · Keycloak
  (OIDC) · Docker Compose.
- **Decisões, trade-offs e limitações:** [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- **Teste de carga:** [`docs/LOAD_TEST.md`](./docs/LOAD_TEST.md).

---

## Sumário

1. [Pré-requisitos](#pré-requisitos)
2. [Subindo tudo com Docker Compose](#subindo-tudo-com-docker-compose)
3. [Rodando localmente (sem containerizar a aplicação)](#rodando-localmente)
4. [Comandos](#comandos)
5. [Testes](#testes)
6. [API HTTP](#api-http)
7. [Mensageria (SQS)](#mensageria-sqs)
8. [Autenticação (Keycloak)](#autenticação-keycloak)
9. [Observabilidade](#observabilidade)
10. [Configuração](#configuração)
11. [Estrutura do projeto](#estrutura-do-projeto)

---

## Pré-requisitos

- [Bun](https://bun.sh) ≥ 1.1. O projeto foi desenvolvido e testado com Bun 1.4.4.
- Docker e Docker Compose v2.
- Portas livres: `3000` (API), `5432` (PostgreSQL), `4566` (LocalStack) e `8080` (Keycloak).

## Subindo tudo com Docker Compose

```bash
export KEYCLOAK_ADMIN_PASSWORD='escolha-uma-senha-local'
```

```bash
docker compose up -d --build --wait
```

Isso sobe:

| Serviço | O que é |
|---|---|
| `postgres` | PostgreSQL 16. Cria também o banco `wagering_test`, usado pelas suítes de teste. |
| `localstack` | SQS com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo`. |
| `keycloak` | IdP OIDC, com o realm `wagering` importado de `infra/keycloak/realm-wagering.json`. |
| `migrate` | Job único que aplica as migrations e termina. |
| `api` | Instância pública na porta 3000. Roda HTTP, o consumidor SQS, o relay da outbox e o worker de referências pendentes. |
| `worker` ×2 | Mais duas instâncias competindo pelas mesmas wallets, fila e outbox. |

No Compose a API sobe com `AUTH_MODE=keycloak`. Para obter um token e fazer chamadas:

```bash
OPERATOR=$(scripts/keycloak-token.sh backoffice)
```

```bash
PROVIDER_A=$(scripts/keycloak-token.sh provider-a)
```

```bash
curl -s -X POST localhost:3000/wallets \
  -H "Authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H "Authorization: Bearer $PROVIDER_A" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Para subir sem autenticação (desenvolvimento), use `AUTH_MODE=disabled docker compose up -d --wait`.

Para derrubar tudo, incluindo os volumes:

```bash
docker compose down -v
```

## Rodando localmente

Só a infraestrutura em containers; a aplicação roda direto no Bun.

```bash
bun install
```

```bash
bun run infra:up
```

```bash
cp .env.example .env
```

```bash
bun run migration:up
```

```bash
bun run start
```

Por padrão o `.env.example` usa `AUTH_MODE=disabled`, então dá para chamar a API sem token.

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start` / `start:dev` | Sobe o serviço; `start:dev` usa watch mode. |
| `bun run infra:up` / `infra:down` | Sobe ou derruba PostgreSQL e LocalStack. |
| `bun run migration:up` | Aplica as migrations pendentes. |
| `bun run migration:down` | Reverte a última migration. `bun run scripts/migrate.ts down --all` reverte todas. |
| `bun run migration:status` | Informa se há migrations pendentes. |
| `bun run lint` / `lint:fix` | Biome: lint e formatação. |
| `bun run typecheck` | `tsc --noEmit` em modo estrito. |
| `bun run check` | Lint, typecheck e testes de unidade. |
| `bun run test:unit` | Testes de unidade (domínio puro, sem I/O). |
| `bun run test:integration` | Integração com PostgreSQL e LocalStack reais. |
| `bun run test:concurrency` | Concorrência e falhas: paralelismo real, processos reais, `docker pause`. |
| `bun run test:all` | Unidade, integração e concorrência, nessa ordem. |
| `bun run test:load` | Teste de carga com 3 instâncias (veja `docs/LOAD_TEST.md`). |

## Testes

As suítes de integração e concorrência precisam de `bun run infra:up`. Elas usam o banco `wagering_test`, que é
recriado por migrations no início de cada arquivo, e filas SQS com sufixo aleatório, então nunca tocam dados de
desenvolvimento. **Nenhuma suíte substitui PostgreSQL ou SQS por mocks.**

| Suíte | Arquivos | Cobre |
|---|---|---|
| Unidade (73) | `test/unit/*` | `Money` (escala, entradas inválidas, sem arredondamento), invariantes da `Wallet`, state machine, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, hash canônico e payload divergente, inbox/outbox, backoff. |
| Integração | `test/integration/schema-constraints` | Migrations reversíveis (down até zero e up de novo) e cada constraint ou trigger do schema. |
| | `wagering-flows` | Fluxos completos, replay, conflitos, atomicidade wallet/ledger/inbox/outbox, referências fora de ordem, worker de pendências com limite, reconciliação detectando divergência, cursor estável. |
| | `messaging` | Consumidor SQS: inbox e redelivery, ack de rejeições, DLQ com motivo, retry com backoff até a DLQ, SIGTERM; outbox: dois publishers concorrentes, takeover após lease, retry do broker. |
| | `http-api`, `http-auth`, `keycloak-e2e` | Contrato HTTP, status por situação, OIDC com JWKS real (local) e com o Keycloak real (opcional). |
| Concorrência | `test/concurrency/hot-wallet` | 50× a mesma aposta em paralelo, cenário 100/80/80, hot wallet com 200 operações, wallets distintas em paralelo, REFUND × ROLLBACK simultâneos. |
| | `multi-instance` | 3 processos reais; `SIGKILL` depois do commit e antes do ack; reinício sob carga com SIGTERM, inclusive ROLLBACK chegando antes da BET. |
| | `infrastructure-outage` | `docker pause` no PostgreSQL e no LocalStack: readiness, 503 retentável e recuperação. |

Todas as suítes terminam verificando o invariante `wallet.balance == saldo reconstruído pelo ledger` e que todo
journal está balanceado.

O teste contra o Keycloak real roda quando `KEYCLOAK_ADMIN_PASSWORD` está definido e o Keycloak está no ar; caso
contrário, ele é pulado. As mesmas regras também são testadas com um emissor OIDC local, com chaves RSA e JWKS reais.

## API HTTP

| Método e rota | Papel exigido | Descrição |
|---|---|---|
| `POST /wallets` | operator | Cria a wallet. Um saldo inicial > 0 gera a transação interna `OPENING` e o lançamento no ledger. |
| `GET /wallets/:walletId` | operator | Saldo e versão. |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | operator | Lançamentos do mais novo para o mais antigo, com cursor opaco e estável (`limit` ≤ 200). |
| `POST /wallets/:walletId/reconciliation` | operator | Saldo materializado comparado ao saldo reconstruído pelo ledger. |
| `POST /wagering/transactions` | provider / operator | Submete uma operação. O header `Idempotency-Key` é obrigatório. |
| `GET /wagering/transactions/:transactionId` | provider (dono) / operator | Consulta pelo id interno. |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | provider (dono) / operator | Consulta pelo id do provedor. |
| `GET /health/live` · `GET /health/ready` | aberto | Liveness e readiness (PostgreSQL + SQS). |
| `GET /metrics` | aberto | Métricas no formato Prometheus. |

### Status HTTP

| Situação | Status | Corpo |
|---|---|---|
| Operação aplicada agora | `201` | `{transactionId, status: "PROCESSED", balance, idempotentReplay: false}` |
| Replay de operação aplicada | `200` | O mesmo corpo, com `idempotentReplay: true` |
| Aceita, aguardando a referência | `202` | `status: "PENDING_REFERENCE"`, `referenceExternalTransactionId`, `nextReferenceAttemptAt` |
| Rejeitada por regra de negócio (terminal) | `422` | `status: "REJECTED"`, `failureCode` |
| Payload inválido | `400` | `error.code = VALIDATION_ERROR` e `details` |
| Token ausente ou inválido | `401` | `UNAUTHORIZED` |
| Papel ou provedor não autorizado | `403` | `PROVIDER_FORBIDDEN` |
| Wallet ou transação inexistente | `404` | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| Conflito de idempotência ou unicidade | `409` | `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_TRANSACTION_ID_CONFLICT` / `WALLET_ALREADY_EXISTS` |
| Falha transitória de infraestrutura | `503` | `SERVICE_UNAVAILABLE`, header `Retry-After: 1` |

Todo erro traz `error.retryable` (booleano), para o provedor decidir se pode reenviar sem interpretar a mensagem.
Os `failureCode` estão documentados em [`ARCHITECTURE.md`](./ARCHITECTURE.md#códigos-de-falha).

## Mensageria (SQS)

Os provedores publicam na fila `wager-transactions.fifo`, com `MessageGroupId = walletId`:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Os eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e
`WagerTransactionPendingReference`) são publicados pela outbox em `wagering-events.fifo`, com
`MessageGroupId = walletId` e `MessageDeduplicationId = eventId`. A entrega é *at-least-once*, e o consumidor
deve deduplicar por `eventId`.

## Autenticação (Keycloak)

- Cada provedor é um *client* confidencial no Keycloak (`provider-a`, `provider-b`), autenticado por
  `client_credentials`.
- O token traz `aud=wagering-api`, o papel `wagering-provider` e o claim `provider_id`.
- A API valida assinatura (JWKS), `iss`, `aud` e `exp` localmente, e exige que o `providerId` do payload seja o do
  token.
- O client `backoffice` tem o papel `wagering-operator` (wallets, ledger e reconciliação).
- **Nenhum client secret fica no repositório.** O Keycloak gera os secrets na importação, e
  `scripts/keycloak-token.sh` os lê pela API de administração local.
- `AUTH_MODE=disabled` é o ponto de extensão explícito para desenvolvimento e testes.

## Observabilidade

- **Logs JSON** (pino) com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. Valores
  monetários, payloads e tokens são *redacted*.
- O header `X-Correlation-Id` é propagado: se a requisição não trouxer um, o serviço gera e devolve na resposta.
- **Métricas** em `/metrics`:

  | Métrica | O que mede |
  |---|---|
  | `wagering_transactions_total{status,kind,source}` | Transações por status |
  | `wagering_duplicates_detected_total{type}` | Replays, inbox e conflitos |
  | `wagering_retries_total` | Retries |
  | `wagering_lock_conflicts_total` | Conflitos de lock |
  | `wagering_dlq_messages_total{reason}` | Mensagens na DLQ |
  | `wagering_outbox_lag_seconds` e `wagering_outbox_pending` | Atraso e tamanho da outbox |
  | `wagering_processing_duration_seconds` | Latência de processamento |
  | `wagering_reconciliations_total{consistent}` | Resultado das reconciliações |

- **Health:**
  - `/health/live` responde enquanto o processo está vivo, sem checar dependências.
  - `/health/ready` checa PostgreSQL e SQS e devolve 503 se algum estiver fora.

## Configuração

Todas as variáveis são validadas na inicialização (`src/config/app-config.ts`) e estão listadas com valores locais em
`.env.example`. As principais:

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | PostgreSQL |
| `DB_POOL_SIZE` / `DB_LOCK_TIMEOUT_MS` / `TX_MAX_RETRIES` | `10` / `5000` / `3` | Pool, `lock_timeout` por transação, retries transitórios |
| `SQS_ENDPOINT` / `SQS_CREATE_QUEUES` | — / `true` | LocalStack; criação idempotente das filas |
| `WORKERS` | `consumer,outbox,pending-references` | Componentes de background que este processo roda |
| `CONSUMER_MAX_RECEIVES` / `CONSUMER_RETRY_BASE_S` | `5` / `2` | Tentativas antes da DLQ; backoff base |
| `PENDING_REF_MAX_ATTEMPTS` / `PENDING_REF_BASE_DELAY_MS` / `PENDING_REF_MAX_DELAY_MS` | `10` / `2000` / `120000` | Janela de espera por referências fora de ordem |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_MS` / `OUTBOX_LEASE_MS` | `50` / `500` / `30000` | Relay da outbox |
| `AUTH_MODE` | `disabled` (local) / `keycloak` (Compose) | Autenticação |
| `OIDC_ISSUER_URL` / `OIDC_JWKS_URL` / `OIDC_AUDIENCE` | realm `wagering` | Validação de tokens |

## Estrutura do projeto

```
src/
  main.ts                         bootstrap + SIGTERM
  bootstrap/                      composition root (container) e fábrica da aplicação Nest
  config/                         configuração validada (zod)
  wagering/
    domain/                       Money, Wallet, WagerTransaction (state machine), ledger de partidas dobradas,
                                  Settlement (regras), Inbox/Outbox, eventos de integração, hash canônico
    application/                  use cases + portas (UnitOfWork, repositórios, Clock, IdGenerator, Metrics, Logger)
    infrastructure/
      persistence/                TypeORM: migrations, schemas, repositórios, unit of work, classificação de erros PG
      messaging/                  consumidor SQS, publisher de eventos, criação das filas
      observability/              logger pino, métricas Prometheus
      workers.ts                  runner periódico (relay da outbox, pendências)
    interface/http/               controllers, mapeamento de erros, guard OIDC, política de identidade do provedor
test/  unit · integration · concurrency · support
scripts/  migrate.ts · load-test.ts · keycloak-token.sh
infra/    postgres · localstack · keycloak
```
