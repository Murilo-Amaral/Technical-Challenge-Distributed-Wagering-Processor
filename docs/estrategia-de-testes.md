# Estratégia de testes

Este documento reúne, num só lugar, como o projeto é testado e o que cada suíte prova. Os detalhes de cada teste
estão no documento da etapa em que ele foi escrito.

## Princípios

1. **Infraestrutura real, nunca mocks de PostgreSQL ou SQS.** Locks de linha, constraints, deadlocks, visibility
   timeout e grupos FIFO só existem nos componentes reais.
2. **Paralelismo real.** Testes de concorrência disparam operações simultâneas, cada uma com sua conexão e transação,
   e deixam o PostgreSQL decidir a intercalação. Nada de "simular" concorrência executando em sequência.
3. **Falhas reais.** Processos morrem com `SIGKILL` e `SIGTERM`; containers são congelados com `docker pause`.
4. **Invariante final em toda suíte.** Independentemente do cenário, todas terminam verificando que o sistema ficou
   consistente.
5. **Determinismo onde possível.** O domínio recebe relógio e ids por parâmetro; o worker de pendências usa um
   `TestClock` controlável.

## Pirâmide

| Nível | Comando | Infra | Etapa(s) |
|---|---|---|---|
| Unidade | `bun run test:unit` | nenhuma | 2, 8 |
| Integração | `bun run test:integration` | PostgreSQL + LocalStack (+ Keycloak opcional) | 3, 4, 5, 6, 8 |
| Concorrência e falhas | `bun run test:concurrency` | PostgreSQL + LocalStack + Docker CLI | 4, 6, 7 |
| Carga | `bun run test:load` | PostgreSQL + LocalStack | 7 |
| Aceitação caixa-preta | `bun run test:acceptance` | stack completa do Compose | 9 |

`bun run check` roda lint, typecheck e unidade; `bun run test:all` roda unidade, integração e concorrência.

## O que cada suíte prova

| Arquivo | Prova |
|---|---|
| `test/unit/money.test.ts` | Dinheiro exato, sem arredondamento, entradas inválidas recusadas. |
| `test/unit/wallet.test.ts` | Saldo nunca negativo; toda mudança gera um lançamento balanceado; versão. |
| `test/unit/wager-transaction.test.ts` | State machine; terminais imutáveis; regras de referência e valor. |
| `test/unit/settlement.test.ts` | Cada regra de BET/WIN/LOSS/REFUND/ROLLBACK e de referência fora de ordem. |
| `test/unit/idempotency-and-messaging.test.ts` | Hash canônico; inbox; outbox e backoff. |
| `test/unit/sqs-event-publisher.test.ts` | Um evento por wallet por chamada; retenção após falha. |
| `test/integration/schema-constraints.test.ts` | O **banco** recusa cada estado inválido (testado por SQL direto); migrations reversíveis. |
| `test/integration/wagering-flows.test.ts` | Fluxos completos, replay, conflitos, atomicidade, referências fora de ordem, reconciliação, cursor. |
| `test/integration/messaging.test.ts` | Consumidor (inbox, ack, DLQ, retry, SIGTERM) e outbox (publishers concorrentes, lease, ordem, retry). |
| `test/integration/http-api.test.ts` | Contrato HTTP e status por situação; métricas; correlação. |
| `test/integration/http-auth.test.ts` | OIDC com emissor local e JWKS real: 401, 403, 503 do JWKS, identidade do provedor. |
| `test/integration/keycloak-e2e.test.ts` | Tokens reais do Keycloak (opcional). |
| `test/concurrency/hot-wallet.test.ts` | 50× a mesma BET; 100/80/80; hot wallet; ausência de lock global; REFUND × ROLLBACK. |
| `test/concurrency/multi-instance.test.ts` | 3 processos; `SIGKILL` entre commit e ack; reinício sob carga. |
| `test/concurrency/infrastructure-outage.test.ts` | PostgreSQL e SQS fora: readiness, 503 retentável, recuperação, nada gravado na falha. |
| `scripts/load-test.ts` | Latência, vazão, lag da outbox e invariante sob carga. |
| `scripts/acceptance-test.ts` | 57 checagens dos requisitos pela interface externa da stack montada. |

## Infraestrutura de teste (`test/support/`)

| Arquivo | Papel |
|---|---|
| `db.ts` | Abre o banco `wagering_test` e o recria: `DROP SCHEMA public CASCADE` e todas as migrations (o `TRUNCATE` é proibido no ledger por design). Isso também exercita as migrations a cada arquivo. |
| `sqs.ts` | Cria filas com sufixo aleatório por arquivo, envia envelopes e espera condições. |
| `harness.ts` | Monta os casos de uso com o `TestClock`; `assertLedgerInvariant`. |
| `app.ts` | Sobe a aplicação real (Nest + PostgreSQL + LocalStack) no mesmo processo, em porta aleatória e sem workers, para os testes HTTP. |
| `instances.ts` | Sobe processos reais (`bun run src/main.ts`) em portas aleatórias, com retry se a porta estiver ocupada. |
| `domain-builders.ts` | Fábricas de objetos de domínio para os testes de unidade. |

Isolamento: o banco de teste é separado do de desenvolvimento, e as filas têm sufixo aleatório, então as suítes não
interferem entre si nem com dados locais.

## O invariante final

`assertLedgerInvariant` (em `test/support/harness.ts`) verifica, ao fim de cada suíte:

- para toda wallet, `balance` = saldo reconstruído pelos lançamentos do ledger;
- a versão da wallet = versão do último lançamento;
- todo journal está balanceado (Σ débitos = Σ créditos).

O teste de carga usa o mesmo invariante como portão de aprovação, e o teste de aceitação faz a mesma checagem por SQL
somente leitura.

## Fault injection

`FAULT_INJECTION=crash-after-commit-before-ack` faz o consumidor matar o próprio processo entre o commit e o ack, para
provar que a inbox absorve a reentrega. A configuração recusa essa variável quando `NODE_ENV=production`.

## Lacunas conhecidas

- Cobertura de código não é medida por ferramenta; a suíte foi guiada pelos cenários do enunciado.
- A vazão da ingestão por SQS não é medida (só sua correção).
- LocalStack não reproduz cotas nem todos os detalhes do SQS da AWS.
