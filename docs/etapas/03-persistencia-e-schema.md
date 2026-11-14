# Etapa 3 — Persistência e schema com invariantes no banco

> Commit: `4b26556 feat(persistence): PostgreSQL schema with database-enforced invariants`
>
> Código: `src/wagering/infrastructure/persistence/` · Testes: `test/integration/schema-constraints.test.ts`

## Objetivo

Criar o schema do PostgreSQL de forma que **o próprio banco recuse qualquer estado inválido**, e escrever a camada de
persistência (repositórios e unit of work) que conecta o domínio da etapa 2 ao banco.

## O princípio desta etapa

> Mesmo um bug no código de aplicação não deve conseguir confirmar um estado que viole unicidade, imutabilidade,
> saldo não-negativo ou a consistência entre saldo e ledger.

O domínio aplica as regras primeiro, para dar respostas claras. O banco aplica de novo, como última barreira. Em um
sistema distribuído com várias instâncias, versões diferentes do código podem estar rodando ao mesmo tempo, alguém
pode rodar um script manual, um caminho novo pode esquecer uma validação. As constraints valem para todos.

## O que foi feito

| Item | Arquivo(s) |
|---|---|
| Migrations versionadas e reversíveis | `migrations/1761000000000` a `…0004` (a `…0005` veio na etapa 8) |
| Lista explícita de migrations | `migrations/index.ts` |
| CLI de migração | `scripts/migrate.ts` (`up`, `down`, `down --all`, `status`) |
| Records do TypeORM separados do domínio | `schemas.ts` (`EntitySchema`, sem decorators) |
| Mapeamento record ↔ agregado | `mappers.ts` |
| Repositórios | `typeorm-repositories.ts` |
| Unit of work com timeouts e retry | `typeorm-unit-of-work.ts` |
| Classificação de erros do PostgreSQL | `pg-errors.ts` |
| Cursor opaco do ledger | `ledger-cursor.ts` |
| Portas da aplicação | `src/wagering/application/ports.ts` |

## O schema, tabela por tabela

### `wallets`

- `balance NUMERIC(20,2)` com `CHECK (balance >= 0)`.
- `UNIQUE (player_id, currency)`: uma wallet por jogador e moeda.
- `UNIQUE (id, currency)`: existe só para ser alvo de uma FK composta do ledger (abaixo).
- Trigger `wallets_guard` (BEFORE UPDATE OR DELETE):
  - wallets nunca são apagadas;
  - `id`, `player_id`, `currency` e `created_at` são imutáveis;
  - se o saldo muda, a versão sobe **exatamente 1**;
  - se o saldo não muda, a versão não pode mudar.
- `TRUNCATE` proibido pela função compartilhada `forbid_truncate()` (migration `…0000`).

### `wager_transactions`

É ao mesmo tempo o registro de idempotência e a trilha de auditoria de toda operação aceita.

- Unicidade persistente: `UNIQUE (idempotency_key)` (depois escopada por provedor, etapa 8) e
  `UNIQUE (provider_id, external_transaction_id)`.
- **Reversão no máximo uma vez:** índice único parcial `uq_wager_reversed_once (reference_transaction_id) WHERE kind
  IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`. Dois estornos simultâneos da mesma transação não conseguem ser
  confirmados juntos, mesmo que passem pelas validações da aplicação ao mesmo tempo.
- CHECKs de coerência de estado, todos na forma "A se e somente se B":
  - `ck_wager_processed_at`: `PROCESSED` ⇔ `processed_at` preenchido;
  - `ck_wager_failure_code`: `REJECTED`/`FAILED` ⇔ `failure_code` preenchido;
  - `ck_wager_pending_schedule`: `PENDING_REFERENCE` ⇔ `next_reference_attempt_at` preenchido;
  - `ck_wager_opening_internal`: `OPENING` ⇔ `provider_id = 'internal'`;
  - `ck_wager_reference_required`, `ck_wager_bet_without_reference`, `ck_wager_amount` (zero só em LOSS).
- Trigger `wager_transactions_guard`:
  - **replica a state machine do domínio**: estados terminais não mudam; só as transições da tabela são aceitas;
  - colunas de negócio (valor, moeda, wallet, kind, hash, chaves, referência externa, …) são imutáveis;
  - `reference_attempts` nunca diminui;
  - transações nunca são apagadas.
- Índices parciais para as pendentes: por data de próxima tentativa (`ix_wager_pending_due`) e por referência
  aguardada (`ix_wager_pending_by_reference`).

### `ledger_journals` e `ledger_entries`

Ledger de partidas dobradas, **append-only**.

- `ledger_journals`: um por transação financeira (PK = `transaction_id`).
- `ledger_entries`: os lançamentos. Cada journal tem exatamente um lançamento `WALLET` e um em conta de sistema
  (`HOUSE` ou `FUNDING`).
- `sequence BIGINT GENERATED ALWAYS AS IDENTITY`: identidade monotônica, usada como cursor de paginação.
- `ck_ledger_wallet_shape`: lançamentos `WALLET` têm `wallet_id`, saldos e versão; os de sistema não têm.
- `ck_ledger_arithmetic`: `balance_after = balance_before ± amount`.
- `ck_ledger_balances_non_negative`.
- `fk_ledger_wallet_currency (wallet_id, currency) → wallets(id, currency)`: **a moeda do lançamento é a da wallet**,
  garantido por FK, sem trigger.
- `uq_ledger_one_posting_per_account (transaction_id, account)`: no máximo um lançamento por conta em cada transação.
- `uq_ledger_wallet_version (wallet_id, wallet_version)`: um lançamento por versão da wallet.
- Triggers:
  - `ledger_append_only`: `UPDATE` e `DELETE` lançam exceção; `TRUNCATE` também é proibido;
  - `ledger_entries_chain` (BEFORE INSERT): cada lançamento da wallet parte do `balance_after` do anterior, com versão
    maior; o primeiro parte de zero;
  - `trg_ledger_journal_balanced` (**constraint trigger deferred**): no commit, o journal tem 2 lançamentos, 1 de
    wallet, Σ débitos = Σ créditos e uma única moeda;
  - `trg_wallets_match_ledger` e `trg_ledger_entries_match_wallet` (**constraint triggers deferred**): no commit, o
    saldo e a versão materializados da wallet são iguais ao último lançamento dela. Uma wallet sem lançamentos só é
    válida com saldo 0 e versão 1.

### `inbox_messages` e `outbox_messages`

- Inbox: PK `(consumer_name, message_id)`. A PK é a própria deduplicação; duas entregas simultâneas da mesma mensagem
  se serializam nela.
- Outbox: evento com `partition_key`, `payload jsonb`, `attempts`, `next_attempt_at`, `published_at`, e
  `locked_until`/`locked_by` para o lease entre publishers concorrentes (etapa 6).
- Trigger `outbox_guard`: o conteúdo do evento é imutável e, depois de publicado, `published_at` não muda mais.
- Índice parcial `ix_outbox_due` só sobre eventos não publicados.

## Decisões e justificativas

### Invariantes no banco, não só no código

- **Alternativa descartada:** confiar apenas nas validações da aplicação.
- **Por quê não:** com N instâncias concorrentes, a única entidade que vê todas as escritas é o banco. Uma validação
  em memória pode passar em duas instâncias ao mesmo tempo.
- **Custo:** os triggers deferred fazem algumas consultas extras no commit. As consultas são indexadas e limitadas à
  wallet da transação; o teste de carga (etapa 7) não mostrou isso como gargalo.

### Triggers *deferred* para saldo × ledger e journal balanceado

- **Problema:** dentro de uma transação, a ordem natural é inserir a transação, depois o journal, depois os
  lançamentos, depois atualizar o saldo. Uma checagem imediata falharia no meio do caminho.
- **Decisão:** `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`. A validação acontece no `COMMIT`, quando tudo já
  foi escrito.
- **Efeito colateral útil:** uma mudança de saldo sem lançamento (ou vice-versa) **não pode ser confirmada**. Por isso
  a reconciliação (etapa 4) só encontra divergência se alguém desligar os triggers de propósito, e é exatamente assim
  que o teste de reconciliação cria uma divergência.

### TypeORM em vez de MikroORM

- O enunciado prefere MikroORM e aceita TypeORM. A escolha seguiu a recomendação recebida.
- Os recursos que esta solução usa existem nos dois: transação explícita, lock pessimista, migrations com `up`/`down`.
- A falta de Unit of Work / Identity Map explícitos no TypeORM não pesa aqui: a unit of work é a própria transação
  SQL, e as escritas são explícitas (um `INSERT` por registro novo e um `UPDATE` condicional para o saldo). Um flush
  implícito no caminho do dinheiro seria menos previsível.

### Records separados do domínio (`EntitySchema`)

- **Decisão:** entidades TypeORM declaradas com `EntitySchema`, sem decorators, em `schemas.ts`. Repositórios mapeiam
  record ↔ agregado em `mappers.ts`.
- **Por quê:** o domínio mantém construtores privados e estado privado, e não conhece o ORM. O ORM não precisa
  instanciar classes de domínio por reflexão.

### `NUMERIC(20,2)` lido como string

- O driver `pg` devolve `NUMERIC` como **string**, que vira `Money.fromStored(amount, currency)`. Na escrita,
  `money.amount` já é a string com 2 casas. O valor nunca passa por `number`.
- Valor e moeda em colunas separadas (`amount` + `currency`).
- Agregações usam `SUM` em `NUMERIC`, que é exato no PostgreSQL; o resultado volta como string.

### Migrations escritas em SQL, numa lista explícita

- **SQL à mão** porque triggers, constraint triggers, índices parciais e FKs compostas não são expressáveis pelo
  `synchronize` do ORM, que fica desligado.
- **Lista explícita** (`migrations/index.ts`) em vez de glob de arquivos: funciona igual no Bun, nos testes e dentro
  do container, sem depender de caminho ou extensão.
- **Reversíveis:** toda migration tem `down`, e o teste desce até zero e sobe de novo.
- `migrationsTransactionMode: "each"`: cada migration em sua própria transação.
- Tabela de controle `schema_migrations`.
- **Regra seguida depois:** migrations já aplicadas não são editadas. Quando a idempotência passou a ser escopada por
  provedor (etapa 8), isso virou uma migration nova (`…0005`).

### Unit of work: uma transação por caso de uso

`TypeOrmUnitOfWork.run(work, options)`:

- abre uma transação (READ COMMITTED por padrão; a reconciliação pede REPEATABLE READ);
- define `lock_timeout` e `statement_timeout` com `set_config(…, true)`, ou seja, **escopados à transação**, sem
  vazar para a próxima transação que reutilizar a conexão do pool;
- em erro **transitório**, faz rollback e repete até `TX_MAX_RETRIES`, com backoff exponencial e *full jitter*
  (`random() · min(1000, 25 · 2^tentativa)` ms), para que escritores concorrentes não repitam em sincronia;
- esgotadas as tentativas, lança `TransientInfrastructureError` (HTTP 503 ou retry na fila);
- conta conflitos de lock e retries nas métricas.

**Por que READ COMMITTED basta:** a correção não depende do nível de isolamento. Todo caminho de escrita trava antes a
linha da wallet (`SELECT … FOR UPDATE`), então escritores da mesma wallet se serializam e veem o estado mais recente
ao obter o lock. Um isolamento mais alto só traria mais falhas de serialização para repetir.

O que é considerado transitório (`pg-errors.ts`):

- SQLSTATEs: `40001` (serialização), `40P01` (deadlock), `55P03` (`lock_timeout`), `57014` (`statement_timeout`),
  `57P01`–`57P03` (shutdown), `53300` (conexões demais), classe `08` (conexão);
- erros de rede do Node (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, …) e mensagens de conexão encerrada do driver;
- `ConcurrencyConflictError` (update condicional que não casou);
- três violações de unicidade específicas, que se resolvem sozinhas na nova tentativa (detalhes na etapa 4).

### Repositórios: decisões pontuais

- `WalletRepository.lockById`: `SELECT … FOR UPDATE` (`setLock("pessimistic_write")`).
- `saveBalance(wallet, expectedVersion)`: `UPDATE … WHERE id = ? AND version = ?`. Se nenhuma linha casar, lança
  `ConcurrencyConflictError`. É redundante com o lock, de propósito (veja a etapa 4).
- `InboxRepository.receive`: `INSERT … ON CONFLICT DO NOTHING RETURNING`. Se nada voltou, a mensagem é duplicada.
- `UniqueViolationError` carrega o **nome da constraint**, para que a aplicação decida o que a violação significa
  (wallet duplicada, corrida de idempotência, estorno duplo).
- `listWalletEntries`: paginação por *keyset* (`sequence < cursor ORDER BY sequence DESC LIMIT n+1`). Buscar `n+1`
  diz se há próxima página sem um `COUNT`.

### Cursor opaco do ledger

- Formato: `base64url({"v":1,"s":"<sequence>"})`.
- **Opaco** para o cliente não depender do formato interno; o campo `v` permite mudar o formato no futuro.
- **Estável:** como `sequence` é monotônica e a página é "mais antigos que o cursor", novas entradas não deslocam as
  páginas já lidas (o que aconteceria com `OFFSET`).

## Testes

`test/integration/schema-constraints.test.ts` (17 testes na entrega da etapa), contra um PostgreSQL real:

- migrations reversíveis: desce até zero e sobe de novo;
- wallets: saldo negativo recusado, unicidade player+moeda, saldo positivo sem ledger não confirma, versão sobe uma
  vez e só com lançamento correspondente, wallet não pode ser apagada;
- ledger: append-only (UPDATE, DELETE, TRUNCATE), aritmética, encadeamento, journal balanceado, um lançamento de
  wallet por transação;
- transações: unicidade de chave e de id externo, terminal imutável e transições válidas, referência obrigatória,
  OPENING só do provedor interno, reversão uma única vez;
- inbox única por consumidor + mensagem; payload da outbox imutável e publicação definitiva.

Cada teste tenta violar a regra **diretamente por SQL**, sem passar pela aplicação, para provar que é o banco quem
recusa.

## Limitações

- Os triggers são PL/pgSQL: amarram o projeto ao PostgreSQL. É uma troca consciente; o desafio é PostgreSQL.
- O saldo das contas de sistema não é materializado (decisão da etapa 2), então não há consulta pronta para o saldo da
  casa.
