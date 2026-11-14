# Etapa 2 — Modelo de domínio

> Commit: `0afdfc6 feat(domain): wagering domain model with state machine and double-entry ledger`
>
> Código: `src/wagering/domain/` · Testes: `test/unit/*`

## Objetivo

Expressar as regras de negócio do desafio em código puro, sem banco, sem framework e sem I/O: dinheiro exato,
wallet que nunca fica negativa, state machine explícita para as transações, ledger de partidas dobradas, regras de
cada tipo de operação e o hash que sustenta a idempotência.

## Por que o domínio veio antes da persistência

- Regras de negócio testadas de forma isolada são rápidas e determinísticas: relógio e ids entram como parâmetros.
  Os testes de unidade rodam em milissegundos.
- Fixar o modelo primeiro define o vocabulário (status, códigos de falha, direção de lançamento) que o schema da
  etapa 3 replica em constraints e triggers.
- Mantém a dependência na direção certa: a infraestrutura depende do domínio, nunca o contrário.

## Componentes

### `Money` — dinheiro exato (`money.ts`)

**O problema:** `number` em JavaScript é ponto flutuante binário. `0.1 + 0.2 !== 0.3`. Em um sistema financeiro isso
é inaceitável, e arredondar "para consertar" esconde erros.

**A solução:**

- Valor interno em **`bigint` de centavos** (unidades menores). Toda aritmética é inteira e exata.
- Escala fixa de 2 casas. A serialização sempre devolve 2 casas: `"25"` vira `"25.00"`.
- Entrada aceita somente decimal simples não-negativo, com regex estrita: sem sinal, sem expoente, sem zeros à
  esquerda, sem espaços, no máximo 2 casas decimais.
- **Nunca arredonda.** `"1.005"` é rejeitado com `InvalidMoneyError`, em vez de virar `1.00` ou `1.01`.
- Rejeita valores que não são string (`25` como `number` não é dinheiro), `NaN`, `Infinity`, `1e3`, string vazia e
  mais de 18 dígitos inteiros (o limite de `NUMERIC(20,2)`, que é a coluna do banco).
- Moeda ISO-4217 (`^[A-Z]{3}$`). Somar ou comparar moedas diferentes lança `CurrencyMismatchError`.
- Duas portas de entrada distintas:
  - `Money.from(props)`: para entrada externa, com todas as validações;
  - `Money.fromStored(amount, currency)`: para reidratar valores já persistidos; aceita sinal, porque a diferença de
    uma reconciliação pode ser negativa.

**Decisão:** dinheiro trafega como **string decimal** em todo contrato externo (`{ "amount": "25.00", "currency":
"BRL" }`), nunca como número JSON. Isso evita que qualquer cliente, parser ou log converta o valor para ponto
flutuante no caminho.

### `Wallet` — aggregate root (`wallet.ts`)

Invariantes garantidas pela classe:

1. o saldo nunca fica negativo (`debit` acima do saldo lança `InsufficientFundsError` e o estado não muda);
2. toda mudança de saldo devolve **exatamente um** `WalletLedgerEntry` que a descreve, e só mudanças produzem
   lançamento;
3. `version` começa em 1 e sobe 1 a cada mudança de saldo, e somente nela;
4. operações só aceitam a moeda da wallet.

Decisões:

- **`debit` e `credit` devolvem o lançamento.** Não existe API que altere o saldo sem produzir o registro do ledger.
  Saldo e ledger andam juntos por construção, não por disciplina de quem chama.
- **Abertura pertence à versão 1.** `Wallet.open` cria a wallet na versão 1; se o saldo inicial for positivo, o
  lançamento de abertura (`CREDIT`) também é da versão 1. Criar a wallet já é a primeira versão, não uma mudança
  adicional.
- Construtor privado: só se cria uma wallet por `open` (com validação) ou `rehydrate` (reconstrução a partir do
  banco, sem revalidar).

### `WagerTransaction` e a state machine (`wager-transaction.ts`)

Tipos: `OPENING` (interno), `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
Status: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.

```
PENDING ──► PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
PENDING_REFERENCE ──► PENDING_REFERENCE (reagendamento) | PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED ──► (nada: terminais)
```

Decisões:

- **Tabela única de transições** (`WAGER_TRANSITIONS`). Toda mudança de status passa por `transitionTo`, que consulta
  a tabela. Não há `if` espalhado decidindo o que é permitido.
- **Transição inválida é erro de programação**, não caminho de negócio: lança `InvalidTransactionStateError`. Uma
  rejeição de negócio é uma transição válida para `REJECTED` com um `failureCode`.
- **Estados terminais são imutáveis.** A mesma tabela foi replicada num trigger do banco na etapa 3.
- **`resultBalance`** guarda o saldo observado quando a transação chegou ao status atual. É ele que um replay
  idempotente devolve: "o resultado original" inclui o saldo daquele momento, não o saldo atual.
- **`PENDING_REFERENCE → PENDING_REFERENCE`** é o laço de reagendamento: cada tentativa sem sucesso incrementa
  `referenceAttempts` e agenda `nextReferenceAttemptAt` com backoff exponencial.
- Validações na criação: REFUND e ROLLBACK exigem referência; BET não pode ter referência; valor zero só é aceito em
  `LOSS`.
- Referências permitidas por tipo (`ALLOWED_REFERENCE_KINDS`): WIN, LOSS e REFUND só podem apontar uma BET; ROLLBACK
  pode apontar BET, WIN ou REFUND.
- Direção no ledger: BET debita; WIN, REFUND e OPENING creditam; ROLLBACK aplica o **inverso** da direção da
  referência; LOSS não move saldo.

### Ledger de partidas dobradas (`ledger.ts`)

O enunciado pede um ledger imutável; partidas dobradas eram um diferencial. Foram implementadas porque tornam o
ledger auto-verificável: em cada transação, Σ débitos = Σ créditos.

- **`WalletLedgerEntry`**: lado da wallet, com `balanceBefore`, `balanceAfter` e `walletVersion`. Só campos
  `readonly`, sem métodos de transição. `create` valida que `balanceBefore ± amount = balanceAfter`, que o valor é
  positivo e que o saldo resultante não é negativo.
- **`SystemLedgerEntry`**: contrapartida numa conta de sistema, `HOUSE` (operações de jogo) ou `FUNDING` (abertura de
  wallet).
- **`LedgerJournal`**: o par balanceado de uma transação. A contrapartida tem direção oposta e o mesmo valor.

**Decisão importante: as contas de sistema não têm saldo materializado.** Uma linha `HOUSE` com saldo seria
atualizada por toda aposta de toda wallet. Isso criaria um ponto quente global, equivalente a um lock compartilhado
por todas as wallets, exatamente o que o desafio proíbe. O saldo da casa continua derivável por `SUM` quando
necessário.

Convenção: `DEBIT` diminui e `CREDIT` aumenta o saldo **da wallet**, como no enunciado.

### `Settlement` — regras de negócio (`settlement.ts`)

Serviço de domínio puro que decide o desfecho de uma transação e movimenta os dois agregados (`WagerTransaction` e
`Wallet`) de forma coerente. Persistência, locks e eventos ficam com quem chama (etapa 4).

Ordem das validações (e por que nessa ordem):

1. **player é dono da wallet** → `PLAYER_WALLET_MISMATCH`;
2. **moeda é a da wallet** → `CURRENCY_MISMATCH`;
3. **referência**, se houver:
   - não existe, ou ainda está pendente → `PENDING_REFERENCE` (ou `REFERENCE_NOT_FOUND` se as tentativas acabaram);
   - não foi processada → `REFERENCE_NOT_PROCESSED`;
   - tipo não permitido → `REFERENCE_KIND_NOT_ALLOWED`;
   - contexto diferente (provider, player, wallet, moeda ou rodada) → `REFERENCE_CONTEXT_MISMATCH`;
   - reversão com valor diferente → `AMOUNT_MISMATCH`;
   - referência já revertida → `REFERENCE_ALREADY_REVERSED`;
4. **aplicação no saldo**: débito sem saldo → `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_INSUFFICIENT_FUNDS`
   (ROLLBACK de um crédito).

As validações de identidade e moeda vêm primeiro porque são erros do payload, independentes de qualquer outra
transação. A referência vem antes do saldo porque não faz sentido avaliar o efeito de uma operação cujo alvo ainda
não se conhece.

Decisões:

- **Uma referência que ainda está pendente mantém o dependente esperando.** Ela pode se resolver depois (cadeia
  BET → REFUND → ROLLBACK do REFUND chegando em ordem inversa).
- **Códigos distintos para saldo insuficiente.** `REVERSAL_INSUFFICIENT_FUNDS` (o jogador já gastou o prêmio que
  agora precisa ser estornado) é uma situação operacional diferente de "aposta sem saldo", e o provedor precisa
  saber disso sem ler mensagens de texto.
- `Settlement` devolve um resultado discriminado (`processed` com o journal, `rejected` com o código,
  `pending-reference` indicando se é a primeira vez). Quem chama decide o que persistir e quais eventos emitir.

### Códigos de falha (`failure-code.ts`)

Enum estável e legível por máquina, persistido em transações `REJECTED`/`FAILED`. Cada código tem uma ação esperada
do provedor. A tabela completa está em [`ARCHITECTURE.md`](../../ARCHITECTURE.md#códigos-de-falha).

### Política de retry (`retry-policy.ts`)

`ExponentialBackoff`: `base · 2^(tentativa−1)`, com teto e número máximo de tentativas. Determinística (sem jitter),
para que os testes de unidade e a agenda de referências pendentes sejam previsíveis. Reutilizada pelo worker de
referências pendentes e pelo relay da outbox.

### Hash do payload (`payload-hash.ts`)

A idempotência precisa responder: "esta requisição é a mesma que já vi?". A resposta é um hash do **conteúdo de
negócio**:

- `payloadHash = hex(SHA-256(JSON canônico))`;
- JSON canônico: chaves ordenadas recursivamente, membros `undefined` removidos, sem espaços. Dois payloads
  semanticamente iguais geram sempre a mesma string;
- entram só os campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`,
  `kind`, `money` e `referenceExternalTransactionId`;
- **ficam de fora** os metadados de transporte (header, `messageId`, `occurredAt`), para que a mesma operação enviada
  por HTTP ou por fila, ou reenviada com outro `messageId`, seja reconhecida como a mesma;
- o `amount` entra já normalizado, então `"25"` e `"25.00"` geram o mesmo hash.

### Inbox, Outbox e eventos de integração

- **`InboxMessage`**: registro de deduplicação por `(consumerName, messageId)`.
- **`OutboxMessage`**: evento aguardando publicação, com tentativas e backoff. `scheduleRetry` **nunca desiste**:
  um evento financeiro não pode ser descartado.
- **`IntegrationEvent<T>`**: envelope abstrato (`eventId`, `eventType`, `aggregateId`, `correlationId`,
  `causationId`, `occurredAt`, `version`, `data`). Cada evento concreto fixa `eventType` e `version` no próprio tipo.
  `partitionKey` é o `walletId`, para ordem por wallet no broker.
- Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e
  `WalletBalanceChanged` (só quando o saldo muda de fato).
- **Decisão:** `data` carrega `MoneyProps` (strings), nunca instâncias de `Money`. O payload publicado é JSON puro,
  estável e versionável.

### Erros de domínio (`errors.ts`)

Hierarquia própria (`DomainError` com `code`), sem nenhuma referência a HTTP. A camada de interface faz o mapeamento
(etapa 5).

## Padrões aplicados em todo o domínio

- **Construtores privados** com factories nomeadas (`create`, `open`, `from`) que validam, e `rehydrate` para
  reconstrução a partir da persistência sem revalidar.
- **Sem dependência de framework ou ORM.** A única importação externa é `node:crypto`, para o SHA-256.
- **Tempo e ids injetados.** Nenhuma classe chama `new Date()` ou gera UUID por conta própria; tudo chega por
  parâmetro, o que torna os testes determinísticos.

## Testes

73 testes de unidade na entrega desta etapa, em `test/unit/`:

| Arquivo | Cobre |
|---|---|
| `money.test.ts` | Escala fixa, aritmética exata, rejeição de >2 casas, entradas inválidas, não-strings, limite de precisão, moeda inválida, operações entre moedas, reidratação com sinal. |
| `wallet.test.ts` | Abertura com e sem saldo, débito/crédito com versão, saldo nunca negativo, débito do saldo inteiro, outra moeda, aritmética do lançamento, journal com contrapartida. |
| `wager-transaction.test.ts` | Nasce `PENDING`, terminais sem saída, tocar terminal é erro, backoff de pendência, regras de referência, valor zero só em LOSS, direção por tipo, comparação de hash. |
| `settlement.test.ts` | Cada regra de BET, WIN, LOSS, REFUND e ROLLBACK, inclusive referências fora de ordem e limite de tentativas. |
| `idempotency-and-messaging.test.ts` | JSON canônico, ordem de chaves irrelevante, payload divergente muda o hash, metadados ignorados, inbox, outbox e backoff com teto. |

## Limitações e pontos de atenção

- Reversão parcial está fora de escopo: REFUND e ROLLBACK precisam ter o mesmo valor da referência
  (`AMOUNT_MISMATCH`).
- A regra "uma transação é revertida no máximo uma vez, por qualquer tipo" é uma interpretação mais estrita do
  enunciado. Está justificada em [`decisoes.md`](../decisoes.md#d-07-reversão-no-máximo-uma-vez-por-qualquer-tipo).
