# Etapa 4 — Casos de uso, idempotência e concorrência

> Commit: `580e65b feat(application): wagering use cases with persistent idempotency`
>
> Código: `src/wagering/application/` · Testes: `test/integration/wagering-flows.test.ts`,
> `test/concurrency/hot-wallet.test.ts`

## Objetivo

Juntar domínio (etapa 2) e persistência (etapa 3) em casos de uso que:

- processam cada operação **numa única transação SQL**;
- são **idempotentes de forma persistente** (sem cache em memória);
- serializam escritores **por wallet**, entre todas as instâncias, sem lock global;
- resolvem **referências fora de ordem**;
- servem igualmente para HTTP e SQS.

Esta é a etapa que materializa as garantias centrais do desafio.

## Casos de uso

| Caso de uso | Arquivo | O que faz |
|---|---|---|
| `SubmitWagerTransaction` | `submit-wager-transaction.ts` | Ponto de entrada único das operações de aposta, para HTTP e SQS. |
| `WagerProcessor` | `wager-processor.ts` | Serviço de aplicação compartilhado: resolve referência, chama `Settlement`, persiste efeitos e liquida dependentes. |
| `CreateWallet` | `create-wallet.ts` | Abre a wallet; saldo inicial > 0 gera a transação `OPENING` e o journal com `FUNDING`. |
| `ProcessPendingReferences` | `process-pending-references.ts` | Worker agendado que tenta de novo as transações `PENDING_REFERENCE` vencidas. |
| `PublishOutbox` | `publish-outbox.ts` | Relay da outbox (detalhado na etapa 6). |
| `ReconcileWallet` | `reconcile-wallet.ts` | Compara saldo materializado com o saldo reconstruído pelo ledger. |
| `WageringQueries` | `queries.ts` | Consultas: wallet, ledger paginado, transação por id interno ou externo. |
| `parseWagerCommand` | `wager-request.ts` | Validação de entrada (zod) e cálculo do `payloadHash`, compartilhados por HTTP e SQS. |

As dependências chegam por **portas** (`ports.ts`, `metrics.ts`, `logger.ts`, `event-publisher.ts`): `UnitOfWork`,
repositórios, `Clock`, `IdGenerator`, `Metrics`, `AppLogger`, `EventPublisher`. Nenhum caso de uso conhece TypeORM,
SQS, pino ou Prometheus.

## O fluxo de `SubmitWagerTransaction`

Tudo abaixo acontece **dentro de uma transação SQL**:

1. **Inbox** (apenas quando veio da fila): `INSERT … ON CONFLICT DO NOTHING` em `(consumerName, messageId)`. Se a
   mensagem já existe, devolve `duplicate-message` sem nenhum efeito. Se o mesmo `messageId` chegou com outro
   conteúdo, sinaliza `payloadMismatch` (o consumidor manda para a DLQ, etapa 6).
2. **Lock da wallet:** `SELECT … FOR UPDATE`. É o ponto de serialização por wallet.
3. **Idempotência:**
   - busca por `(providerId, idempotencyKey)`: mesmo hash → **replay**; hash diferente → `IDEMPOTENCY_KEY_CONFLICT`;
   - senão, busca por `(providerId, externalTransactionId)`: mesmo hash → replay; diferente →
     `EXTERNAL_TRANSACTION_ID_CONFLICT`.
4. Wallet inexistente → `WALLET_NOT_FOUND` (a busca de idempotência roda antes, veja a etapa 8).
5. Cria a `WagerTransaction` (status `PENDING`) e chama `WagerProcessor.processNew`:
   - resolve a referência, se houver;
   - `Settlement.settle` decide o desfecho e movimenta wallet e transação;
   - `INSERT` da transação; `INSERT` do journal e dos 2 lançamentos; `UPDATE` condicional do saldo; `INSERT` dos
     eventos na outbox;
   - liquida as transações `PENDING_REFERENCE` da mesma wallet que esperavam por esta.
6. **Commit.** Só então o HTTP responde ou o consumidor faz ack.

### Por que um único caso de uso para HTTP e SQS

- **Decisão:** o controller HTTP e o consumidor SQS chamam exatamente o mesmo `SubmitWagerTransaction.execute`, com a
  mesma validação (`parseWagerCommand`). A única diferença é a inbox, opcional.
- **Por quê:** duas implementações divergiriam com o tempo. Com uma só, uma operação enviada por HTTP e depois
  reenviada pela fila (ou vice-versa) cai no mesmo replay, porque o hash ignora o canal.

## Concorrência

**Unidade de concorrência: `walletId`.** Três camadas, da mais à menos usada:

1. **Lock pessimista da linha da wallet** (`SELECT … FOR UPDATE`) antes de qualquer leitura que decida algo
   (idempotência, saldo, referência). Escritores da mesma wallet esperam em fila no PostgreSQL; wallets diferentes
   seguem em paralelo.
2. **Update condicionado à versão:** `UPDATE wallets … WHERE id = ? AND version = ?`. Se não casar,
   `ConcurrencyConflictError` e a transação é refeita.
3. **Constraints** como última barreira: `CHECK (balance >= 0)`, encadeamento do ledger, versão única.

### Decisão: lock pessimista, e não otimista puro

- **Alternativa considerada:** controle otimista (ler sem lock, gravar com `WHERE version = ?`, repetir em conflito).
- **Por que não:** numa *hot wallet*, N escritores leem a mesma versão, N−1 falham e repetem, e a disputa se repete.
  O trabalho desperdiçado cresce com a contenção, justamente quando o sistema mais precisa de vazão.
- **Por que o pessimista é barato aqui:** a transação é curta (poucos `INSERT`s e um `UPDATE`) e **não faz I/O
  externo** enquanto segura o lock: a publicação de eventos acontece depois, pelo relay. O PostgreSQL enfileira os
  escritores e cada um faz o trabalho uma única vez.
- `lock_timeout` (5 s por padrão) limita esperas patológicas; estourar vira erro transitório com retry.

### Por que manter o update condicionado se já há lock

É redundante de propósito: nos testes ele nunca disparou. Ele existe para que um caminho futuro que esqueça de travar a
wallet não consiga causar *lost update*. A falha vira um retry, não um saldo errado.

### Nenhum lock global

- Contas de sistema (`HOUSE`, `FUNDING`) não têm linha de saldo para atualizar (etapa 2).
- A outbox usa `FOR UPDATE SKIP LOCKED` (etapa 6).
- O worker de pendências trava a wallet de cada candidata individualmente.

### Ordem de locks e ausência de deadlock entre wallets

Todo caminho trava **a wallet primeiro** e só depois linhas de transações dessa wallet (worker de pendências,
dependentes). Uma referência que pertence a outra wallet é **lida sem lock**. Isso é seguro porque só referências em
estado terminal (portanto imutáveis, pelo trigger da etapa 3) são usadas para liquidar; uma referência não terminal
mantém o dependente esperando. Assim não há ciclo de espera entre wallets.

### O cenário obrigatório 100/80/80

Wallet com 100.00; duas BETs de 80.00 em paralelo. A segunda transação espera o lock, enxerga 20.00 e é rejeitada com
`INSUFFICIENT_FUNDS`. Resultado: uma `PROCESSED`, uma `REJECTED`, saldo 20.00, exatamente um `DEBIT` no ledger.

## Idempotência

### Fonte e escopo da chave

- HTTP: header `Idempotency-Key` (obrigatório). SQS: `data.idempotencyKey`.
- Qualquer string de 1 a 256 caracteres; o formato recomendado é `{providerId}:{externalTransactionId}`.
- A chave é única **por provedor**. Na entrega desta etapa a unicidade era global; passou a ser por provedor na
  segunda revisão (etapa 8), para que um provedor não consiga ocupar nem sondar chaves de outro.

### Replay devolve o resultado original

- Mesma chave e mesmo hash: devolve a transação gravada, com o **status e o saldo daquele momento**
  (`result_balance_*`) e `idempotentReplay: true`. No HTTP o status é 200, para distinguir de 201 ("aplicada agora").
- Uma transação que estava pendente e já foi liquidada devolve o estado **atual**: o "resultado original" de uma
  pendência é o seu desfecho.

### Persistência, não memória

As duas chaves são `UNIQUE` no banco. Não existe cache de idempotência: um cache em memória não é visto pelas outras
instâncias e se perde num restart.

### Corridas de unicidade que se resolvem sozinhas

- **Mesma chave, mesma wallet:** os dois pedidos se serializam no lock da wallet; o segundo encontra o primeiro já
  commitado e vira replay.
- **Mesma chave, wallets diferentes:** cada pedido trava uma wallet distinta e ambos tentam inserir. Um recebe
  `23505` (violação de unicidade). O unit of work trata `uq_wager_provider_idempotency_key` e
  `uq_wager_provider_external_id` como **transitórios** e refaz a transação; na nova tentativa a linha do outro já
  está commitada e a resposta vira replay ou conflito.
- **Dois estornos da mesma transação:** `uq_wager_reversed_once` recebe o mesmo tratamento; na nova tentativa o
  `Settlement` vê a referência já revertida e responde `REFERENCE_ALREADY_REVERSED`.

### Inbox × idempotência de negócio

São camadas diferentes e complementares:

- a **inbox** deduplica a *mensagem* (`messageId`), na mesma transação do efeito;
- a **idempotência** deduplica a *operação* (chave + hash). A mesma operação reenviada pela fila com outro
  `messageId` passa pela inbox e cai no replay.

## Referências fora de ordem

- REFUND/ROLLBACK (referência obrigatória) e WIN/LOSS (opcional) cuja referência ainda não existe ficam em
  `PENDING_REFERENCE`, sem efeito no saldo. HTTP 202 e evento `WagerTransactionPendingReference`, emitido **uma
  única vez** (reagendamentos são internos).
- **Resolução imediata (caminho comum):** quando a referência chega, `WagerProcessor.settleDependents` busca, com lock,
  as pendentes da mesma wallet que apontam para ela e as liquida **na mesma transação**. Cadeias funcionam porque
  `processPending` chama `settleDependents` de novo (BET → REFUND → ROLLBACK do REFUND, chegando em ordem inversa).
- **Worker agendado (rede de segurança):** `ProcessPendingReferences` cobre a referência que nunca chega ou que chega
  em outra wallet. Para cada candidata vencida: transação própria, lock da wallet, lock e releitura da transação; se
  outra instância já a tratou, pula.
- **Limite:** `PENDING_REF_MAX_ATTEMPTS=10`, atraso base 2 s, dobrando até 120 s: ~8 minutos de janela total.
  Provedores costumam reenviar a operação original em segundos ou poucos minutos; uma janela maior manteria
  reversões em aberto sem ganho. Tudo configurável.
- **Esgotado:** `REJECTED` com `REFERENCE_NOT_FOUND`.
- **Erro não transitório** ao reprocessar: `FAILED` com `PROCESSING_FAILED` (terminal e auditável, sem loop infinito).
  Erro transitório: a candidata fica intacta e é tentada no próximo ciclo.

## Abertura de wallet (`CreateWallet`)

- Uma transação SQL: `INSERT` da wallet; se o saldo inicial for positivo, a transação interna `OPENING`
  (`providerId = "internal"`, chave `internal:opening:<walletId>`), o journal wallet `CREDIT` / `FUNDING` `DEBIT` e os
  eventos `WalletBalanceChanged` e `WagerTransactionProcessed`.
- **Por que uma transação `OPENING` em vez de só gravar o saldo:** o trigger deferred exige que todo saldo seja
  explicado pelo ledger, e todo lançamento do ledger pertence a uma transação. O saldo inicial passa pelo mesmo
  caminho auditável de qualquer outro movimento.
- Wallet duplicada (`uq_wallets_player_currency`) vira `WalletAlreadyExistsError` (409).

## Reconciliação (`ReconcileWallet`)

- Compara `wallet.balance` com Σ créditos − Σ débitos dos lançamentos da wallet.
- Roda em **REPEATABLE READ** para ler saldo e soma no mesmo snapshot; em READ COMMITTED, um commit concorrente entre
  as duas leituras geraria uma divergência falsa.
- **Nunca corrige.** Divergência é logada como erro, contada na métrica `wagering_reconciliations_total` e devolvida na
  resposta. Corrigir automaticamente esconderia a causa e poderia apagar evidência de um bug ou de uma intervenção
  indevida.

## Validação de entrada (`wager-request.ts`)

- zod com identificadores restritos a `[A-Za-z0-9._:-]` e tamanhos máximos iguais aos das colunas.
- `walletId` deve ser UUID.
- `OPENING` é recusado (é interno); REFUND/ROLLBACK sem referência e BET com referência são recusados já na entrada.
- Valor zero só para LOSS.
- Todos os problemas encontrados voltam juntos em `details`, não só o primeiro.
- Campos extras são ignorados: não entram no hash nem são persistidos.

## Testes

`test/integration/wagering-flows.test.ts` (PostgreSQL real):

- abertura com e sem saldo; wallet duplicada;
- BET e replay com o saldo da época; conflito de chave; conflito de id externo; chave reaproveitada com wallet
  desconhecida; escopo da chave por provedor;
- saldo insuficiente e moeda divergente persistidos como `REJECTED`, sem lançamento; wallet inexistente sem nada
  persistido; OPENING e payload malformado recusados antes do banco;
- rodada completa BET → WIN → LOSS → REFUND → ROLLBACK; ROLLBACK de WIN sem saldo;
- **atomicidade:** uma falha depois de escrever ledger e saldo desfaz wallet, transação, ledger, inbox e outbox
  juntos;
- referências fora de ordem: REFUND antes da BET; cadeia em ordem inversa; worker com backoff até
  `REFERENCE_NOT_FOUND` (usando um `TestClock` controlável);
- reconciliação detecta e **não corrige** uma divergência criada com os triggers desligados
  (`session_replication_role = replica`);
- cursor do ledger estável com novas entradas sendo inseridas.

`test/concurrency/hot-wallet.test.ts` (paralelismo real: cada operação com sua conexão e transação):

- a mesma BET 50× em paralelo debita uma única vez;
- cenário 100/80/80;
- hot wallet com 200 operações mistas: nunca negativa, sem *lost update*;
- wallets distintas em paralelo (prova de que não há lock global);
- REFUND e ROLLBACK simultâneos da mesma BET: exatamente um vence.

Todas terminam conferindo o invariante `saldo == ledger` (veja [`estrategia-de-testes.md`](../estrategia-de-testes.md)).

## Limitações

- O lock por wallet limita a vazão de **uma** wallet extremamente quente à latência de uma transação curta. É a escolha
  correta para dinheiro; mitigações possíveis estão em [`ARCHITECTURE.md`](../../ARCHITECTURE.md#trade-offs-e-limitações).
- A espera por referências é limitada por configuração; uma referência que chegue depois da janela não reabre a
  transação rejeitada (o provedor precisa enviar uma nova operação).
