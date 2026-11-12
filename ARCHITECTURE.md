# Arquitetura

Este documento explica **como** a solução garante as invariantes do desafio, **por que** cada decisão foi tomada,
quais **interpretações** foram adotadas onde o enunciado deixa espaço e quais são as **limitações** conhecidas.

## Sumário

1. [Visão geral](#visão-geral)
2. [Camadas e fronteiras](#camadas-e-fronteiras)
3. [Fluxo de uma operação](#fluxo-de-uma-operação)
4. [Modelo de domínio](#modelo-de-domínio)
5. [Persistência: TypeORM, Money e estratégia transacional](#persistência-typeorm-money-e-estratégia-transacional)
6. [Garantias aplicadas no schema](#garantias-aplicadas-no-schema)
7. [Concorrência](#concorrência)
8. [Idempotência](#idempotência)
9. [Referências fora de ordem](#referências-fora-de-ordem)
10. [Códigos de falha](#códigos-de-falha)
11. [Mapeamento HTTP](#mapeamento-http)
12. [Consumidor SQS](#consumidor-sqs)
13. [Transactional Outbox](#transactional-outbox)
14. [Autenticação](#autenticação)
15. [Observabilidade](#observabilidade)
16. [Estratégia de testes](#estratégia-de-testes)
17. [Interpretações adotadas](#interpretações-adotadas)
18. [Requisito → implementação](#requisito--implementação)
19. [Trade-offs e limitações](#trade-offs-e-limitações)

---

## Visão geral

```
            HTTP (provedores / back-office)                 SQS wager-transactions.fifo
                       │  JWT (Keycloak)                             │ MessageGroupId = walletId
                       ▼                                             ▼
  ┌────────────────────────────────────────────────────────────────────────────────────┐
  │ Instância (N réplicas idênticas, sem estado em memória que importe para a correção)  │
  │                                                                                    │
  │  Controllers ──┐                                     ┌── SqsWagerConsumer           │
  │                ▼                                     ▼                               │
  │           SubmitWagerTransaction  (mesmo use case para HTTP e SQS)                    │
  │                │   uma transação SQL:                                               │
  │                │   [inbox] → lock da wallet → idempotência → Settlement →             │
  │                │   transação + ledger (2 lançamentos) + saldo + outbox [+ dependentes]  │
  │                ▼                                                                     │
  │   Workers: relay da outbox (lease + SKIP LOCKED) · referências pendentes (backoff)       │
  └───────────────────────┬───────────────────────────────────────────────┬─────────────┘
                          ▼                                               ▼
                   PostgreSQL 16                                SQS wagering-events.fifo
       (constraints, triggers, row locks = fonte da verdade)    (MessageDeduplicationId = eventId)
```

**Princípio central:** o banco é a fonte da verdade de todas as invariantes. O código de aplicação aplica as mesmas
regras primeiro, para dar respostas claras, mas mesmo um bug nele não consegue confirmar um estado que viole
unicidade, imutabilidade, não-negatividade ou consistência saldo × ledger. O broker (FIFO, deduplicação) é
otimização, não garantia.

## Camadas e fronteiras

| Camada | Pasta | Depende de | Responsabilidade |
|---|---|---|---|
| Domínio | `src/wagering/domain` | nada (só `node:crypto` para o hash) | Invariantes encapsuladas: construtores privados, factories `create`/`open`/`from` e `rehydrate`, transições explícitas. Sem NestJS nem ORM. |
| Aplicação | `src/wagering/application` | domínio + **portas** | Use cases e orquestração transacional. Portas: `UnitOfWork`, repositórios, `Clock`, `IdGenerator`, `Metrics`, `AppLogger`, `EventPublisher`. |
| Infraestrutura | `src/wagering/infrastructure` | aplicação | Adaptadores: TypeORM, SQS, pino, Prometheus, runner de workers. |
| Interface | `src/wagering/interface/http` | aplicação | Controllers, mapeamento erro → status, guard OIDC, política de identidade do provedor. |
| Composição | `src/bootstrap` | tudo | *Composition root*: constrói cada adaptador uma vez. O módulo Nest só expõe as instâncias, o que mantém os use cases livres de decorators. |

Há um único bounded context (`wagering`); dividir em mais seria complexidade sem ganho neste escopo.

## Fluxo de uma operação

`SubmitWagerTransaction.execute` (`src/wagering/application/submit-wager-transaction.ts`) roda numa única transação
SQL (READ COMMITTED, `lock_timeout` configurável):

1. **Inbox** (apenas SQS): `INSERT … ON CONFLICT DO NOTHING` em `(consumer_name, message_id)`. Se já existe, a
   mensagem é duplicada e recebe ack sem efeito. Entregas simultâneas da mesma mensagem se serializam na PK.
2. **Lock da wallet:** `SELECT … FOR UPDATE` na linha da wallet. É o ponto de serialização por wallet, válido entre
   todas as instâncias.
3. **Idempotência:** busca por `idempotency_key`. Mesmo hash → **replay** (devolve o resultado gravado); hash
   diferente → **409**. Em seguida, busca por `(provider_id, external_transaction_id)`, com a mesma regra.
4. **Settlement** (serviço de domínio puro): valida player/wallet/moeda e a referência; aplica débito ou crédito na
   `Wallet`, que devolve o `WalletLedgerEntry`; monta o journal de partidas dobradas; transiciona a
   `WagerTransaction`.
5. **Persistência:**
   - `INSERT` da transação;
   - `INSERT` do journal e dos 2 lançamentos;
   - `UPDATE wallets … WHERE id = ? AND version = ?` (condicional);
   - `INSERT` dos eventos na outbox.
6. **Dependentes:** transações `PENDING_REFERENCE` da mesma wallet que esperavam por esta são liquidadas na mesma
   transação, em cadeia (BET → REFUND → ROLLBACK do REFUND).
7. **Commit.** Só então o HTTP responde ou o consumidor faz ack. Os eventos são publicados depois, pelo relay.

## Modelo de domínio

### Money (`domain/money.ts`)

- Representação interna em **`bigint` de centavos**: aritmética exata, sem `number` em nenhum ponto do caminho do
  dinheiro.
- A entrada aceita apenas decimal simples não-negativo com até 2 casas, sem sinal, expoente, zeros à esquerda ou
  espaços. `"25"` e `"25.5"` são aceitos e normalizados para `"25.00"` e `"25.50"`. `"1.005"` é **rejeitado**: nunca
  há arredondamento implícito.
- Também são rejeitados `NaN`, `Infinity`, `1e3`, string vazia, negativos, valores não-string e valores acima de 18
  dígitos inteiros (o limite de `NUMERIC(20,2)`).
- Moeda ISO-4217 (`^[A-Z]{3}$`). Operações entre moedas diferentes lançam `CurrencyMismatchError`. O modelo é
  multi-moeda; os testes usam BRL e USD.
- `Money.fromStored` reidrata valores já persistidos e aceita sinal, porque diferenças de reconciliação podem ser
  negativas.

### Wallet (aggregate root, `domain/wallet.ts`)

- `open` cria na versão 1. Saldo inicial > 0 gera um lançamento `CREDIT` de abertura, que **pertence à versão 1**:
  criar já é a primeira versão.
- `debit` e `credit` devolvem o `WalletLedgerEntry` correspondente. Saldo e ledger mudam juntos, sempre: não existe
  forma de alterar o saldo sem produzir o lançamento.
- `version` incrementa somente quando o saldo muda (LOSS e rejeições não incrementam).
- Débito acima do saldo lança `InsufficientFundsError` e o estado permanece intacto.

### WagerTransaction e state machine (`domain/wager-transaction.ts`)

```
              ┌──────────────────────┐
              │       PENDING        │  (nasce aqui; nunca é persistida neste estado no fluxo síncrono)
              └──┬───────┬───────┬───┘
     processed   │       │       │  rejected / failed
                 ▼       │       ▼
          ┌──────────┐   │   ┌──────────┐  ┌────────┐
          │PROCESSED │   │   │ REJECTED │  │ FAILED │   ← terminais: sem transições de saída
          └──────────┘   │   └──────────┘  └────────┘
                 ▲       ▼       ▲            ▲
                 │  ┌───────────────────┐     │
                 └──┤ PENDING_REFERENCE ├─────┘
                    └───────┬───────────┘
                            └──► PENDING_REFERENCE  (reagendamento: tentativa + 1)
```

- A tabela `WAGER_TRANSITIONS` é a única fonte das transições no código. Transicionar um estado terminal lança
  `InvalidTransactionStateError`: é erro de programação, não caminho de negócio.
- **A mesma tabela está replicada no trigger `wager_transactions_guard`**, que também impede alterar colunas de
  negócio (valor, moeda, wallet, kind, hash, …) e apagar transações.
- `resultBalance` guarda o saldo observado quando a transação atingiu o estado atual. É ele que um replay devolve.
- `OPENING` é interno: o schema exige `provider_id = 'internal'` (`ck_wager_opening_internal`), e a validação de
  entrada o rejeita tanto na API quanto na fila.

### Ledger de partidas dobradas (`domain/ledger.ts`)

- `WalletLedgerEntry`: lançamento da wallet, com `balanceBefore`, `balanceAfter` e `walletVersion`. É
  estruturalmente imutável (só `readonly`, sem métodos de transição), e `create` valida `before ± amount = after`.
- `SystemLedgerEntry`: contra-lançamento numa conta de sistema, `HOUSE` (apostas) ou `FUNDING` (abertura).
- `LedgerJournal`: o par balanceado de uma transação, com direções opostas e mesmo valor (Σ débitos = Σ créditos).
- O saldo das contas de sistema **não é materializado** de propósito: uma linha `HOUSE` com saldo seria um ponto
  quente global, equivalente a um lock compartilhado por todas as wallets, o que a restrição 6 proíbe. O saldo da
  casa é derivável por `SUM` quando necessário.
- Convenção de direção: `DEBIT` diminui e `CREDIT` aumenta o saldo da wallet, como no enunciado.

### Settlement (`domain/settlement.ts`)

Serviço de domínio puro, com as regras da seção 7 do enunciado. A ordem das validações é:

1. o player é dono da wallet (`PLAYER_WALLET_MISMATCH`);
2. a moeda é a da wallet (`CURRENCY_MISMATCH`);
3. se houver referência:
   - ausente, ou ainda pendente → `PENDING_REFERENCE`, ou `REFERENCE_NOT_FOUND` se o limite de tentativas se esgotou;
   - não processada → `REFERENCE_NOT_PROCESSED`;
   - tipo não permitido → `REFERENCE_KIND_NOT_ALLOWED`;
   - contexto diferente (provider, player, wallet, moeda ou rodada) → `REFERENCE_CONTEXT_MISMATCH`;
   - nas reversões, valor diferente → `AMOUNT_MISMATCH`;
   - referência já revertida → `REFERENCE_ALREADY_REVERSED` (qualquer operação);
4. aplicação no saldo: débito sem saldo → `INSUFFICIENT_FUNDS` para BET e `REVERSAL_INSUFFICIENT_FUNDS` para
   ROLLBACK.

| Operação | Efeito | Referência |
|---|---|---|
| BET | débito | proibida |
| WIN | crédito | opcional, deve ser BET da mesma rodada |
| LOSS | nenhum (sem ledger, sem versão nova) | opcional, deve ser BET |
| REFUND | crédito | obrigatória, BET `PROCESSED`, mesmo valor |
| ROLLBACK | inverso da referência | obrigatória, BET, WIN ou REFUND `PROCESSED`, mesmo valor |

## Persistência: TypeORM, Money e estratégia transacional

**ORM: TypeORM 0.3.** O enunciado prefere MikroORM e aceita TypeORM; a escolha seguiu a recomendação recebida. Os
recursos que esta solução usa existem nos dois:

- transação explícita (`DataSource.transaction(isolation, fn)`);
- lock pessimista (`setLock("pessimistic_write")`);
- migrations em classes com `up` e `down`.

A ausência de Unit of Work / Identity Map explícitos no TypeORM não é um problema aqui. A *unit of work* é a própria
transação SQL, encapsulada na porta `UnitOfWork`, e as escritas são explícitas: um `INSERT` por registro novo e um
`UPDATE` condicional para o saldo. Prefiro isso a um flush implícito no caminho do dinheiro.

**Records separados do domínio.** As entidades TypeORM são `EntitySchema` (`persistence/schemas.ts`), sem
decorators. Os repositórios fazem o mapeamento record ↔ agregado (`mappers.ts`): reidratação via `rehydrate` e
escrita a partir dos getters. Assim o domínio não conhece o ORM e mantém construtores privados.

**Mapeamento do Money.** Valor e moeda ficam em colunas separadas: `NUMERIC(20,2)` + `CHAR(3)`. O driver `pg`
devolve `NUMERIC` como **string**, que vira `Money.fromStored(amount, currency)`. Na escrita, `money.amount` já é a
string com escala 2. Em nenhum momento o valor passa por `number`. Agregações (reconciliação) usam `SUM` em
`NUMERIC`, que é exato no PostgreSQL, e o resultado volta como string.

**Estratégia transacional.**

- Um use case corresponde a uma transação (`TypeOrmUnitOfWork`, READ COMMITTED).
- Cada transação define `lock_timeout` e `statement_timeout` via `set_config(..., true)`, escopados à transação.
- Erros transitórios fazem rollback e retry limitado (`TX_MAX_RETRIES`), com backoff exponencial e *full jitter*.
  Contam como transitórios: deadlock, `lock_timeout`, falha de serialização, perda de conexão, conflito de versão e
  as corridas de unicidade descritas em [Idempotência](#idempotência).
- Esgotadas as tentativas, o erro vira `TransientInfrastructureError` (HTTP 503 / retry na fila).
- A reconciliação usa REPEATABLE READ, para ler saldo e soma do ledger no mesmo snapshot.

## Garantias aplicadas no schema

As migrations ficam em `src/wagering/infrastructure/persistence/migrations`. São versionadas, reversíveis (`down`
testado até zero) e registradas numa lista explícita, sem glob, então funcionam igual no Bun, nos testes e nos
containers.

| Garantia | Onde no schema |
|---|---|
| Uma wallet por `player_id` + `currency` | `uq_wallets_player_currency` |
| Saldo nunca negativo | `ck_wallets_balance_non_negative`, `ck_ledger_balances_non_negative` |
| `version` sobe exatamente 1, e só quando o saldo muda | trigger `wallets_guard` (BEFORE UPDATE) |
| Toda mudança de saldo tem lançamento, e vice-versa | constraint triggers **deferred** `trg_wallets_match_ledger` e `trg_ledger_entries_match_wallet`: no commit, saldo e versão da wallet devem ser iguais ao último lançamento |
| Aritmética do lançamento | `ck_ledger_arithmetic`: `balance_after = balance_before ± amount` |
| Encadeamento do ledger | trigger `ledger_entries_chain`: cada lançamento parte do `balance_after` do anterior; o primeiro parte de 0 |
| Um lançamento por versão da wallet | `uq_ledger_wallet_version` |
| No máximo um lançamento da wallet por transação | `uq_ledger_one_posting_per_account (transaction_id, account)` |
| Partidas dobradas balanceadas | constraint trigger **deferred** `trg_ledger_journal_balanced`: 2 lançamentos, 1 de wallet, Σ débitos = Σ créditos, mesma moeda |
| Moeda do lançamento = moeda da wallet | FK composta `fk_ledger_wallet_currency (wallet_id, currency) → wallets(id, currency)` |
| Ledger imutável | triggers `ledger_append_only` (UPDATE/DELETE) e `forbid_truncate` (TRUNCATE) |
| Idempotência persistente | `uq_wager_idempotency_key`, `uq_wager_provider_external_id` |
| Reversão no máximo uma vez | índice único parcial `uq_wager_reversed_once (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| State machine e imutabilidade da transação | trigger `wager_transactions_guard` |
| Coerência de estado | `ck_wager_processed_at`, `ck_wager_failure_code`, `ck_wager_pending_schedule`, `ck_wager_reference_required`, `ck_wager_bet_without_reference`, `ck_wager_amount` |
| Inbox deduplicada | `pk_inbox_messages (consumer_name, message_id)` |
| Evento da outbox imutável; publicação definitiva | trigger `outbox_guard` |
| Wallets e transações nunca apagadas | `wallets_guard`, `wager_transactions_guard`, `forbid_truncate` |

Índices de suporte:

- `ix_wager_pending_due` e `ix_wager_pending_by_reference`: índices parciais das pendentes;
- `ix_outbox_due`: parcial das não publicadas;
- `ix_ledger_wallet_sequence`: paginação;
- `uq_ledger_sequence`: identidade monotônica que serve de cursor.

Os triggers *deferred* permitem a ordem natural de escrita dentro da transação e validam tudo no commit. Um efeito
colateral bom: a reconciliação só encontra divergências se alguém contornar os triggers. O teste de reconciliação
faz exatamente isso, com `session_replication_role = replica`, para provar que a divergência é detectada, logada,
contada e **não** corrigida.

## Concorrência

**Unidade de concorrência: `walletId`.** A estratégia combina três camadas:

1. **Lock pessimista por wallet:** `SELECT … FOR UPDATE` na linha da wallet, antes de qualquer leitura de decisão
   (idempotência, saldo, referência). Escritores da mesma wallet se serializam em todas as instâncias; wallets
   diferentes seguem em paralelo. Não existe lock global: as contas de sistema não são materializadas, e a outbox
   usa `SKIP LOCKED`.
2. **Update atômico condicionado:** `UPDATE wallets SET balance, version WHERE id = ? AND version = ?expected`. Se
   nenhuma linha casar, lança `ConcurrencyConflictError` e a transação é refeita. É redundante com o lock (e por isso
   nunca disparou nos testes), mas impede *lost update* mesmo se um caminho futuro esquecer o lock.
3. **Constraints como última barreira:** `CHECK (balance >= 0)`, encadeamento do ledger e versão única.

**Por que pessimista e não otimista puro?** Numa *hot wallet*, o otimismo gera uma tempestade de retries: N
escritores, N−1 falham, e repetem. Com o lock da linha, o PostgreSQL enfileira os escritores e cada um faz o
trabalho uma única vez. A transação é curta (poucos `INSERT`s, sem I/O externo dentro dela, porque a publicação
acontece fora, pela outbox), então segurar o lock é barato. `lock_timeout` (5 s por padrão) limita a espera
patológica e vira erro transitório com retry.

**Ordem de locks:** todo caminho trava **a wallet primeiro** e depois linhas de transações dessa wallet (worker de
pendências, dependentes). Não há ciclo possível entre wallets: uma referência de outra wallet é lida sem lock, o que
é seguro porque só referências em estado terminal, portanto imutáveis, são usadas para liquidar.

**Cenário obrigatório (100.00; duas BETs de 80.00 em paralelo):** a segunda transação espera o lock, enxerga 20.00
e é rejeitada com `INSUFFICIENT_FUNDS`. Resultado: uma `PROCESSED`, uma `REJECTED`, saldo 20.00, um único `DEBIT`.
Coberto em processo (`hot-wallet.test.ts`) e entre 3 processos diferentes (`multi-instance.test.ts`).

## Idempotência

- **Fonte da verdade:** `Idempotency-Key` no header HTTP, ou `data.idempotencyKey` na fila. O padrão recomendado é
  `{providerId}:{externalTransactionId}`, mas qualquer chave de 1 a 256 caracteres é aceita.
- **`payloadHash` = hex(SHA-256(JSON canônico))** do subconjunto de negócio:
  - campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
    `money {amount, currency}` e `referenceExternalTransactionId`;
  - o JSON canônico ordena as chaves recursivamente, remove membros `undefined` e não usa espaços;
  - `amount` entra já normalizado para escala 2, então `"25"` e `"25.00"` geram o mesmo hash;
  - header, `messageId`, `occurredAt` e outros metadados de transporte não entram;
  - implementação em `domain/payload-hash.ts`.
- **Replay:** mesma chave e mesmo hash devolvem a transação gravada, com o **status e o saldo observados naquele
  momento** (`result_balance_*`), e `idempotentReplay: true`. No HTTP o status é 200, para distinguir de 201.
- **Conflito:** mesma chave com hash diferente → 409 `IDEMPOTENCY_KEY_CONFLICT`. Mesmo
  `(providerId, externalTransactionId)` sob outra chave com payload diferente → 409
  `EXTERNAL_TRANSACTION_ID_CONFLICT`; com payload igual, é replay.
- **Persistência, não memória:** as duas chaves são `UNIQUE` no banco. Não existe cache de idempotência.
- **Corridas:** pedidos simultâneos da mesma chave na mesma wallet se serializam no lock da wallet, e o segundo vê o
  primeiro. Na mesma chave com `walletId` diferente, ambos travam wallets distintas e um recebe `23505`; o unit of
  work refaz, e na segunda tentativa a linha já está commitada, então a resposta vira replay ou conflito.
  `uq_wager_reversed_once` recebe o mesmo tratamento e vira `REFERENCE_ALREADY_REVERSED`.
- **Inbox (SQS):** deduplica a **mensagem** por `(consumerName, messageId)` na mesma transação do efeito. É uma camada
  adicional à idempotência de negócio: uma mesma operação reenviada com outro `messageId` cai no replay pela chave.

## Referências fora de ordem

- `REFUND`/`ROLLBACK` (obrigatório) ou `WIN`/`LOSS` (opcional) cuja referência não existe ficam em
  **`PENDING_REFERENCE`**, sem efeito no saldo. HTTP 202 e evento `WagerTransactionPendingReference`, emitido uma
  única vez.
- **Resolução imediata:** quando a referência chega, o mesmo fluxo que a liquida busca as pendentes da mesma wallet
  que esperavam por ela e as liquida na mesma transação, em cadeia. É o caminho comum: a espera dura o tempo entre
  as duas mensagens.
- **Worker agendado** (`ProcessPendingReferences`) com backoff exponencial, para os casos em que a referência nunca
  chega ou chega em outra wallet. Cada candidata é tratada numa transação própria (lock da wallet, depois reler a
  transação), e outra instância que já a tratou faz a candidata ser ignorada.
- **Limite:** `PENDING_REF_MAX_ATTEMPTS=10`, com atraso base de 2 s dobrando até o teto de 120 s. Entre a 1ª e a 10ª
  tentativa a janela total é 2+4+8+16+32+64+120+120+120 ≈ **8 minutos**.
  - Justificativa: provedores costumam reenviar a operação original em segundos, ou no máximo poucos minutos. Uma
    janela maior manteria reversões em aberto por tempo demais sem ganho real.
  - Tudo é configurável por ambiente.
- **Esgotado o limite:** `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.
- Erro **não transitório** ao reprocessar uma pendente: `FAILED` com `PROCESSING_FAILED`. Fica terminal e auditável,
  sem loop infinito.

## Códigos de falha

Todos são estáveis e legíveis por máquina (`domain/failure-code.ts` e `application/errors.ts`).

**Rejeições persistidas** (`status = REJECTED`, HTTP 422, evento `WagerTransactionRejected`):

| `failureCode` | Significado | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Não reenviar igual; só passa se o saldo mudar (o mesmo payload devolve o resultado original — use outra operação) |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de crédito deixaria o saldo negativo | Acionar a operação (situação diferente de "aposta sem saldo") |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | Corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | O player não é dono da wallet | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | A referência não chegou dentro da janela | Enviar a referência e depois uma nova operação, ou desistir |
| `REFERENCE_KIND_NOT_ALLOWED` | Ex.: REFUND de WIN, ROLLBACK de LOSS | Corrigir o payload |
| `REFERENCE_CONTEXT_MISMATCH` | Referência de outro player, wallet, moeda ou rodada | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | A referência foi REJECTED/FAILED | Desistir: nada a reverter |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida (vale para reversões e para WIN/LOSS sobre BET estornada) | Desistir: já aplicado |
| `AMOUNT_MISMATCH` | Valor da reversão ≠ valor da referência | Corrigir o payload (reversão parcial fora de escopo) |

**Falha terminal** (`status = FAILED`): `PROCESSING_FAILED`, erro permanente ao reprocessar. Exige investigação
manual.

**Erros não persistidos** (a requisição nem vira transação):

| Código | Status | Retentável? |
|---|---|---|
| `VALIDATION_ERROR` | 400 | não |
| `UNAUTHORIZED` / `PROVIDER_FORBIDDEN` | 401 / 403 | não |
| `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | 404 | não |
| `IDEMPOTENCY_KEY_CONFLICT` / `EXTERNAL_TRANSACTION_ID_CONFLICT` / `WALLET_ALREADY_EXISTS` | 409 | não |
| `SERVICE_UNAVAILABLE` | 503 | **sim** (`Retry-After`) |

## Mapeamento HTTP

Implementado em `interface/http/error-mapping.ts` (erros) e `presenters.ts#submissionStatus` (resultado), e
consistente entre todos os endpoints:

- `400` payload inválido · `401`/`403` autenticação e autorização · `404` recurso inexistente ·
  `409` conflito de idempotência ou unicidade · `503` falha transitória.
- Na submissão: `201` aplicada · `200` replay · `202` pendente de referência · `422` rejeitada por regra de negócio ·
  `500` FAILED.
- As consultas (`GET`) devolvem `200` com o recurso, qualquer que seja o status da transação: o status do recurso
  está no corpo.

## Consumidor SQS

`infrastructure/messaging/sqs-wager-consumer.ts`.

- Long polling de até 10 mensagens. Mensagens do mesmo `MessageGroupId` (wallet) são processadas **em sequência**;
  grupos diferentes, **em paralelo**. O polling continua enquanto um lote é processado (até 4 lotes em andamento),
  para um grupo lento não travar os demais; o SQS FIFO não entrega um grupo que ainda tem mensagens em andamento.
- Usa o **mesmo use case** do HTTP, com a inbox `(consumerName, messageId)` na mesma transação. O `data` passa pela
  mesma validação do corpo HTTP.
- **Ack (`DeleteMessage`) somente depois do commit.** Se o processo morrer entre o commit e o ack, a mensagem reaparece
  após o visibility timeout, e a inbox transforma o reprocessamento num no-op. Isso é testado com `SIGKILL` real.
- **Classificação:**

  | Resultado | Ação |
  |---|---|
  | PROCESSED / REJECTED / PENDING_REFERENCE / replay / duplicata de inbox | **ack** (negócio, terminal) |
  | Payload inválido, `OPENING`, conflito de idempotência, `messageId` reutilizado com outro conteúdo, wallet inexistente | **DLQ imediata** (permanente), com atributo `reason` |
  | Erro transitório (DB fora, lock timeout esgotado, erro inesperado) | **retry**: `ChangeMessageVisibility` com backoff `base·2^(n−1)` (teto configurável) |
  | Transitório na tentativa `CONSUMER_MAX_RECEIVES` (5) | **DLQ** com `reason = retries_exhausted:<erro>` |

  A redrive policy da fila (`maxReceiveCount` = o mesmo limite) é a rede de segurança caso o próprio consumidor
  falhe repetidamente antes de decidir. Rejeições de negócio vão para ack porque já estão persistidas e auditáveis.
  Erros permanentes que **não** podem ser persistidos vão para a DLQ, para não sumirem.
- **SIGTERM:**
  - o polling para;
  - o long poll em andamento **não** é abortado, porque um `ReceiveMessage` abortado pode ter retirado mensagens no
    servidor e travado o grupo FIFO até o timeout; ele termina em ≤ `WaitTimeSeconds` e o que trouxer é devolvido;
  - mensagens em andamento terminam, dentro do `SHUTDOWN_GRACE_MS`;
  - as recebidas que ainda não começaram voltam a ficar visíveis na hora (`VisibilityTimeout=0`).

  No Compose, `stop_grace_period: 30s`.

## Transactional Outbox

- Eventos são gravados em `outbox_messages` **na mesma transação** da mudança financeira. Publicar antes do commit é
  impossível por construção.
- **Relay** (`application/publish-outbox.ts`), em três passos curtos; nenhum segura transação aberta durante I/O com o
  broker:
  1. **lease:** `UPDATE … SET locked_until, locked_by WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *`,
     seguido de commit, de modo que publishers concorrentes pegam lotes disjuntos;
  2. publicação em `wagering-events.fifo` via `SendMessageBatch`;
  3. `published_at` nos que deram certo; `attempts` + 1 e `next_attempt_at` com backoff nos que falharam. O relay
     nunca desiste: o evento não se perde.
- **Crash depois de publicar e antes de marcar:** o lease expira e outra instância republica. A entrega é
  **at-least-once**:
  - o SQS FIFO descarta a repetição pelo `MessageDeduplicationId = eventId`, dentro da janela de 5 min;
  - fora da janela, o consumidor deduplica por `eventId`.

  Testado com lease expirando e com 3 relays concorrentes.
- **Ordem:** `MessageGroupId = walletId`, e o lote é enviado em ordem de `occurred_at`. Entre lotes de relays
  diferentes a ordem global não é garantida; os eventos carregam `walletVersion` (`WalletBalanceChanged`) e
  `occurredAt` para o consumidor ordenar ou descartar. Veja [Limitações](#trade-offs-e-limitações).
- **Envelope:** `IntegrationEvent<T>` é abstrata; cada evento é uma subclasse com `eventType` e `version` fixados no
  tipo. `data` carrega `MoneyProps` (strings), nunca `Money`.
- **Métrica de lag:** `wagering_outbox_lag_seconds`, a idade do evento não publicado mais antigo, e
  `wagering_outbox_pending`.

## Autenticação

Não vale pontos no desafio, mas foi pedida integração com IdP externo. **Keycloak** (OIDC):

- Realm `wagering` importado de `infra/keycloak/realm-wagering.json`.
- **Provedores são clients confidenciais** (`provider-a`, `provider-b`) com `client_credentials`:
  máquina-a-máquina, sem usuários nem senhas próprias.
  - Um *hardcoded claim mapper* injeta `provider_id`.
  - O *audience mapper* injeta `aud=wagering-api`.
  - A service account tem o papel de realm `wagering-provider`.
- `backoffice` tem `wagering-operator` (wallets, ledger, reconciliação, qualquer transação).
- A API valida o JWT **localmente** contra o JWKS do realm (`jose`, com cache e rotação de chaves), conferindo
  assinatura RS256, `iss`, `aud` e `exp`. Não há chamada ao IdP por requisição.
- **`ProviderIdentityPolicy`** (`auth/provider-identity.ts`): um provedor só submete ou lê transações cujo
  `providerId` é o do seu token. Operadores podem tudo. Em `GET /wagering/transactions/:id`, a transação de outro
  provedor responde 404, igual a um id inexistente, para não revelar existência.
- Health e métricas são abertos. Mensagens da fila são canal interno confiável, mas o `providerId` delas passa pelas
  mesmas validações de domínio, e a resolução de referência é sempre escopada por provider.
- **Sem segredos no repositório:** os client secrets são gerados pelo Keycloak na importação, e a senha de admin vem
  de `KEYCLOAK_ADMIN_PASSWORD`.
- `AUTH_MODE=disabled` é o ponto de extensão para desenvolvimento e testes: o `TokenVerifier` vira um no-op que
  devolve um operador anônimo, e um aviso é logado na inicialização.

## Observabilidade

- **Logs estruturados** (pino, JSON):
  - campos `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instance`;
  - os call sites logam apenas identificadores e status; por defesa, `money`, `amount`, `balance`, `payload`, `body`,
    `authorization` e `token` são *redacted*.
- **Correlação:** `X-Correlation-Id` (HTTP) ou `messageId` (SQS) viram o `correlationId` dos logs **e** dos eventos de
  integração. O `causationId` aponta a mensagem ou transação que causou o evento.
- **Métricas Prometheus** (`/metrics`):

  | Exigência do enunciado | Métrica |
  |---|---|
  | transações por status | `wagering_transactions_total{status,kind,source}` |
  | duplicatas | `wagering_duplicates_detected_total{type=idempotent_replay\|inbox\|conflict}` |
  | retries | `wagering_retries_total{component,reason}` |
  | mensagens em DLQ | `wagering_dlq_messages_total{reason}` |
  | conflitos de lock | `wagering_lock_conflicts_total{reason=lock_timeout\|deadlock\|serialization\|version_conflict}` |
  | outbox lag | `wagering_outbox_lag_seconds`, `wagering_outbox_pending` |
  | latência de processamento | `wagering_processing_duration_seconds{source,outcome}` (histograma) |

  Além dessas: `wagering_reconciliations_total{consistent}` e falhas de publicação da outbox.
- **Health:**
  - `/health/live` não checa dependências: uma queda do banco não deve reiniciar pods.
  - `/health/ready` checa PostgreSQL e SQS, com timeout de 2 s, e responde 503 se algum estiver fora.

## Estratégia de testes

- **Unidade:** domínio puro. Rápida e determinística: relógio e ids passados explicitamente.
- **Integração:** PostgreSQL e LocalStack reais. Cada arquivo recria o schema por migrations (o que também testa as
  migrations) e usa filas com sufixo aleatório. Para determinismo de tempo, o worker de pendências usa um `TestClock`
  controlável.
- **Concorrência:** paralelismo **real**, sem mocks sequenciais.
  - Em processo, cada operação usa sua própria conexão e transação, e o PostgreSQL decide a intercalação.
  - Entre processos, `Bun.spawn` de instâncias reais.
  - Falhas reais: `SIGKILL` via fault injection controlada por `FAULT_INJECTION`, recusada com
    `NODE_ENV=production`, e `docker pause` dos containers.
- **Invariante final** de todas as suítes: `wallet.balance == saldo reconstruído pelo ledger`, com versão igual à do
  último lançamento e todo journal balanceado (`test/support/harness.ts#assertLedgerInvariant`).

## Interpretações adotadas

1. **REFUND e ROLLBACK da mesma BET:** o enunciado diz "não pode ser revertida duas vezes pelo **mesmo tipo**". Adotei
   a leitura mais estrita: **uma transação é revertida no máximo uma vez, por qualquer tipo**. Permitir REFUND e
   ROLLBACK da mesma BET creditaria o jogador duas vezes. Desfazer um REFUND continua possível, via ROLLBACK *do
   REFUND*, que é outra referência. Garantido por `uq_wager_reversed_once`.
2. **WIN e LOSS podem referenciar** uma BET, que deve ser da mesma rodada. Se a referência for informada e não
   existir, eles também ficam `PENDING_REFERENCE`. Uma BET já revertida (REFUND/ROLLBACK) não pode mais ser
   liquidada por WIN/LOSS: `REFERENCE_ALREADY_REVERSED`.
3. **LOSS aceita valor `0.00`.** As demais operações exigem valor > 0.
4. **Wallet inexistente** na submissão: 404 `WALLET_NOT_FOUND`, sem persistir nada, porque a FK impede uma transação
   órfã. Via SQS vai para a DLQ, para não perder a mensagem. Se a wallet for criada depois, a mesma chave será
   processada normalmente.
5. **Replay de uma transação que estava pendente** devolve o estado **atual** (por exemplo, PROCESSED depois que a
   referência chegou): o "resultado original" de uma pendência é o seu desfecho.
6. **`PENDING` nunca é persistido** no fluxo síncrono: a transação nasce e é liquidada na mesma transação SQL. O
   estado existe no modelo e no schema para completude da state machine.
7. **Wallets só por operadores** (papel `wagering-operator`); provedores apenas operam apostas.
8. **Eventos da abertura:** `OPENING` publica `WalletBalanceChanged` e `WagerTransactionProcessed`, como qualquer
   transação aplicada.
9. **`FAILED`** é usado para erro permanente ao reprocessar pendências. No caminho síncrono, erro inesperado faz
   rollback de tudo e não grava nada: 500 no HTTP, retry ou DLQ na fila.
10. **Campos extras no payload** são ignorados (não entram no hash nem são persistidos).
11. **Fila de eventos:** o enunciado não nomeia o destino da outbox; usei `wagering-events.fifo`.

## Requisito → implementação

| Requisito (seção do enunciado) | Implementação | Teste |
|---|---|---|
| Money exato, 2 casas, sem `number` (6.1, 5.1) | `domain/money.ts` (`bigint`), `NUMERIC(20,2)` lido como string | `test/unit/money.test.ts` |
| Wallet: unicidade, não-negativo, versão (6.2) | `domain/wallet.ts` + `uq_wallets_player_currency`, CHECKs, `wallets_guard` | `wallet.test.ts`, `schema-constraints.test.ts` |
| WagerTransaction e state machine (6.3) | `WAGER_TRANSITIONS` + trigger `wager_transactions_guard` | `wager-transaction.test.ts`, `schema-constraints.test.ts` |
| Ledger imutável (6.4, 5.5) | `WalletLedgerEntry` só `readonly`; triggers append-only | `schema-constraints.test.ts` |
| Partidas dobradas (diferencial) | `LedgerJournal` + `trg_ledger_journal_balanced` | `wallet.test.ts`, `schema-constraints.test.ts` |
| Inbox/outbox na mesma transação (6.5, 11) | `SubmitWagerTransaction` numa `UnitOfWork` | `wagering-flows.test.ts` (atomicidade) |
| Regras BET/WIN/LOSS/REFUND/ROLLBACK (7) | `domain/settlement.ts` | `settlement.test.ts`, `wagering-flows.test.ts` |
| Referências fora de ordem (7.1) | resolução imediata + `ProcessPendingReferences` | `wagering-flows.test.ts`, `multi-instance.test.ts` |
| Códigos de falha (7.2) | `FailureCode` + tabela acima | todos |
| Concorrência por wallet, sem lock global (8, 5.6, 5.7) | `FOR UPDATE` + update condicionado + CHECK | `hot-wallet.test.ts`, `multi-instance.test.ts` |
| Cenário 100/80/80 (8) | — | `hot-wallet.test.ts`, `multi-instance.test.ts` |
| API, idempotência, status distintos (9) | controllers + `error-mapping.ts` | `http-api.test.ts` |
| Reconciliação sem correção silenciosa (9) | `ReconcileWallet` (log + métrica + resposta) | `wagering-flows.test.ts` |
| Health live/ready (9, 12) | `HealthController` | `http-api.test.ts`, `infrastructure-outage.test.ts` |
| Consumidor SQS: inbox, ack após commit, classificação, DLQ, SIGTERM (10) | `SqsWagerConsumer` | `messaging.test.ts`, `multi-instance.test.ts` |
| Outbox com publishers concorrentes, crash recovery (11) | `PublishOutbox` (lease + SKIP LOCKED) | `messaging.test.ts`, `multi-instance.test.ts` |
| Eventos tipados (11) | `IntegrationEvent` + 4 subclasses | `idempotency-and-messaging.test.ts` |
| Logs, métricas, health (12) | pino, Prometheus | `http-api.test.ts` |
| ≥ 3 instâncias (5.8, 13) | — | `multi-instance.test.ts` |
| Worker morto depois do commit e antes do ack (13) | fault injection | `multi-instance.test.ts` |
| PostgreSQL/SQS indisponíveis (3) | retries, 503, readiness | `infrastructure-outage.test.ts` |
| Migrations reversíveis (4) | `migrations/*` com `down` | `schema-constraints.test.ts` |
| Autenticação com IdP externo (2) | Keycloak + `OidcTokenVerifier` | `http-auth.test.ts`, `keycloak-e2e.test.ts` |
| Teste de carga (diferencial) | `scripts/load-test.ts` | `docs/LOAD_TEST.md` |

## Trade-offs e limitações

- **Lock pessimista numa hot wallet** serializa as operações daquela wallet: a vazão por wallet é limitada pela
  latência de uma transação curta. Essa é a escolha correta para dinheiro, mas uma única wallet extremamente quente
  não escala horizontalmente. Mitigações possíveis: transações ainda mais curtas, ou *batching* por wallet no
  consumidor.
- **Ordem dos eventos publicados** não é estritamente garantida entre lotes de relays diferentes. Para ordem estrita
  por wallet seria preciso um relay que só reivindica o evento mais antigo pendente de cada `partition_key`, ao custo
  de throughput. A escolha foi at-least-once com `walletVersion` e `occurredAt` nos eventos.
- **Throughput do relay** é o primeiro gargalo sob carga alta (veja `docs/LOAD_TEST.md`): o lag cresce, mas drena sem
  perda. Há knobs de configuração, e publicar lotes de wallets diferentes em paralelo fica como evolução.
- **Visibility timeout fixo:** não há heartbeat que estenda a visibilidade de mensagens lentas. O processamento é
  curto (dezenas de ms) e o timeout padrão é de 30 s; se uma mensagem passar disso, ela é reentregue e a inbox
  absorve o efeito.
- **Contas de sistema sem saldo materializado:** o saldo da casa é calculado por `SUM` sob demanda, sem endpoint para
  isso.
- **Cobertura de código** não é medida por ferramenta. A suíte foi guiada pelos cenários do enunciado.
- **TypeORM em vez do MikroORM preferencial:** escolha deliberada, justificada acima.
- **Keycloak em modo `start-dev`** no Compose: HTTP, banco embutido e admin bootstrap. Adequado para desenvolvimento,
  não para produção.
- **LocalStack 3.8 versus SQS real:** a semântica FIFO, de visibilidade e de redrive do LocalStack é muito próxima,
  mas não idêntica à da AWS. Os testes cobrem o comportamento, não as cotas da AWS.
