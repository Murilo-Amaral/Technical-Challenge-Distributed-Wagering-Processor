# Etapa 6 — Mensageria: consumidor SQS, inbox e outbox

> Commit: `d36e65c feat(messaging): SQS consumer with inbox, outbox relay and background workers`
>
> Código: `src/wagering/infrastructure/messaging/`, `src/wagering/application/publish-outbox.ts`,
> `src/wagering/infrastructure/workers.ts` · Testes: `test/integration/messaging.test.ts`,
> `test/concurrency/multi-instance.test.ts`

## Objetivo

Fazer o serviço funcionar por fila com as mesmas garantias do HTTP, e publicar eventos de integração sem nunca perder
nem antecipar um evento:

- **entrada:** consumir `wager-transactions.fifo` com deduplicação (inbox), ack só depois do commit, classificação de
  erros, retry com backoff, DLQ com motivo e desligamento gracioso;
- **saída:** publicar os eventos gravados na outbox em `wagering-events.fifo`, com vários publishers concorrentes,
  recuperação de crash e ordem por wallet;
- **workers:** um runner periódico para o relay da outbox, a métrica de lag e as referências pendentes.

## Parte 1 — Consumidor SQS (`sqs-wager-consumer.ts`)

### Contrato da mensagem (`wager-message.ts`)

Envelope `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`. O `data` passa **exatamente** pela mesma
validação do corpo HTTP (`parseWagerCommand`), com `data.idempotencyKey` no lugar do header. Os provedores publicam
com `MessageGroupId = walletId`.

### Recebimento e paralelismo

- Long polling de até 10 mensagens (`WaitTimeSeconds` configurável, até 20).
- Mensagens do mesmo `MessageGroupId` (wallet) são processadas **em sequência**; grupos diferentes, **em paralelo**.
- O polling continua enquanto lotes anteriores ainda estão sendo processados, até `CONSUMER_MAX_IN_FLIGHT_BATCHES`.
  Isso impede que um grupo lento trave os demais. É seguro porque o SQS FIFO não entrega um grupo que ainda tem
  mensagens em andamento, então a ordem por wallet se mantém. (Esse comportamento foi refinado nas revisões da etapa
  8; o limite padrão é `DB_POOL_SIZE / 10`, para que 10 mensagens por lote não excedam o pool de conexões.)

### Ack somente depois do commit

- **Decisão:** `DeleteMessage` só é chamado depois que o caso de uso confirmou a transação.
- **Por quê:** se o processo morrer entre o commit e o ack, a mensagem reaparece depois do visibility timeout. A inbox,
  gravada na mesma transação do efeito, transforma o reprocessamento num no-op. O resultado é **efeito exatamente uma
  vez** sobre um transporte *at-least-once*.
- **Alternativa descartada:** ack antes de processar. Uma falha no meio perderia a operação.
- Isso é provado com `SIGKILL` real (fault injection `crash-after-commit-before-ack`).

### Classificação do resultado

| Resultado | Ação | Por quê |
|---|---|---|
| `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, duplicata de inbox | **ack** | Desfecho de negócio, já persistido e auditável. Reprocessar não muda nada. |
| Payload inválido, conflito de idempotência, wallet inexistente, `messageId` reutilizado com outro conteúdo | **DLQ imediata** com atributo `reason` | Erro permanente que **não pode** ser persistido como transação; repetir não ajuda; não pode sumir. |
| Erro transitório (banco fora, lock esgotado, erro inesperado) | **retry**: `ChangeMessageVisibility` com `base · 2^(n−1)` segundos, com teto | Pode dar certo depois. O backoff evita martelar um banco que está voltando. |
| Transitório na tentativa `CONSUMER_MAX_RECEIVES` (5) | **DLQ** com `reason = retries_exhausted:<erro>` | Não fica em loop para sempre. |

Detalhes:

- **Rejeição de negócio é ack, não DLQ.** Uma BET sem saldo é um resultado válido, gravado como `REJECTED` com
  `failureCode` e com evento emitido. A DLQ é para o que não conseguiu virar registro.
- **A redrive policy da fila** (`maxReceiveCount` igual ao limite do consumidor) é a rede de segurança para o caso de o
  próprio consumidor falhar repetidamente antes de conseguir decidir (por exemplo, morrer sempre na mesma mensagem).
- Ao mandar para a DLQ, o consumidor envia a mensagem original com `reason` e `sourceMessageId` como atributos e com
  `MessageDeduplicationId = MessageId` original, e só então faz ack na fila principal. Se o processo cair entre os
  dois passos, a reentrega gera um segundo envio à DLQ com o mesmo id de deduplicação, que o FIFO descarta dentro da
  sua janela de 5 minutos.
- Se as próprias chamadas de ack/visibilidade/DLQ falharem, a mensagem simplesmente reaparece e a inbox absorve o
  reprocessamento.

### Desligamento gracioso (SIGTERM)

1. O polling para.
2. O long poll em andamento **não é abortado**. Um `ReceiveMessage` abortado pode já ter retirado mensagens no
   servidor, deixando-as invisíveis (e travando o grupo FIFO delas) até o visibility timeout. Ele termina em até
   `WaitTimeSeconds`, e o que trouxer é devolvido na hora.
3. Mensagens em andamento terminam, dentro de `SHUTDOWN_GRACE_MS`.
4. Mensagens recebidas que ainda não começaram voltam a ficar visíveis imediatamente (`VisibilityTimeout=0`), para
   outra instância pegar sem esperar.

No Compose, `stop_grace_period: 30s`.

### Fault injection só para testes

`FAULT_INJECTION=crash-after-commit-before-ack` faz o processo se matar com `SIGKILL` exatamente entre o commit e o ack.
A configuração recusa essa variável com `NODE_ENV=production` (etapa 5).

### Criação das filas (`sqs.ts`)

Com `SQS_CREATE_QUEUES=true`, a aplicação cria as filas de forma idempotente na inicialização: DLQ (retenção de 14
dias), fila principal FIFO com `ContentBasedDeduplication` e redrive para a DLQ, e a fila de eventos. Se a fila já
existe com outros atributos (criada pelo script do LocalStack), é reutilizada.

## Parte 2 — Transactional Outbox

### O problema

Publicar um evento e confirmar uma transação no banco são duas operações em sistemas diferentes. Qualquer ordem entre
elas tem uma janela de falha:

- publicar antes do commit pode anunciar algo que depois sofre rollback;
- publicar depois do commit pode nunca acontecer se o processo cair no meio.

### A solução

- Os eventos são gravados em `outbox_messages` **na mesma transação** da mudança financeira (etapa 4). Publicar antes
  do commit é impossível por construção, e o evento não se perde porque está no banco.
- Um **relay** (`PublishOutbox.runOnce`) publica depois, em três passos curtos, **nenhum deles segurando uma transação
  aberta durante I/O com o broker**:
  1. **lease:** `UPDATE … SET locked_until, locked_by WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING
     *` e commit. Publishers concorrentes pegam lotes disjuntos sem esperar uns pelos outros;
  2. **publicação** em `wagering-events.fifo` via `SendMessageBatch`;
  3. **conclusão:** `published_at` nos que deram certo; `attempts + 1` e `next_attempt_at` com backoff nos que
     falharam.

### Decisões

- **Lease em vez de manter a transação aberta durante a publicação.** Uma transação aberta enquanto se fala com o SQS
  seguraria locks e conexões pelo tempo de rede, e uma falha do broker deixaria tudo preso. Com lease, se o publisher
  morrer, o `locked_until` expira e outra instância assume.
- **`SKIP LOCKED`** para que vários relays (um por instância) dividam o trabalho sem lock global.
- **O relay nunca desiste** de um evento. Falhas viram backoff (`OUTBOX_RETRY_BASE_MS` até `OUTBOX_RETRY_MAX_MS`), e o
  lag fica visível na métrica.
- **Entrega *at-least-once*:** se o relay morrer depois de publicar e antes de marcar, o evento é republicado. Por
  isso:
  - `MessageDeduplicationId = eventId`: o SQS FIFO descarta a repetição dentro da janela de 5 minutos;
  - fora da janela, o consumidor deduplica por `eventId` (contrato documentado no README).
- **Ordem por wallet:** `MessageGroupId = walletId` (o `partitionKey` do evento). As garantias de ordem foram
  reforçadas nas revisões (etapa 8): o claim não pega um evento enquanto um mais antigo da mesma wallet está em
  backoff ou com lease de outro publisher; cada `SendMessageBatch` leva no máximo um evento por wallet; e, se um
  evento falha, os seguintes da mesma wallet são retidos.
- O envelope publicado é o `toJSON()` do `IntegrationEvent`, com `eventType` também como atributo da mensagem, para
  filtros no consumidor.

### Lag da outbox

Uma tarefa separada atualiza a cada 5 s `wagering_outbox_pending` e `wagering_outbox_lag_seconds` (idade do evento não
publicado mais antigo). É o primeiro sinal de que o relay não está dando conta (veja o teste de carga, etapa 7).

## Parte 3 — Runner de workers (`workers.ts`)

- `PeriodicRunner` executa cada tarefa em seu próprio laço.
- **Modo drenagem:** se um passo fez trabalho (`step()` devolveu > 0), o próximo roda imediatamente; se não fez, dorme
  `intervalMs`. Com backlog, o relay drena sem esperar o intervalo; sem backlog, não gasta CPU.
- Erros num passo são logados e o laço continua.
- `stop()` acorda os laços que estão dormindo e espera o passo atual terminar (nenhum passo segura transação longa).
- `WORKERS=consumer,outbox,pending-references` escolhe o que cada processo roda, o que permite separar papéis por
  instância se necessário.

## Uma correção encontrada nesta etapa

O driver do TypeORM para PostgreSQL devolve `[linhas, contagem]` para `UPDATE … RETURNING`, e não só as linhas. O
`claimDue` foi ajustado para tratar os dois formatos. Os testes de integração com publishers concorrentes pegaram o
problema.

## Testes

`test/integration/messaging.test.ts` (LocalStack real, filas com sufixo aleatório por arquivo):

- **consumidor:** processa pelo mesmo caso de uso, grava a inbox e faz ack após o commit; reentrega do mesmo
  `messageId` e novo `messageId` com a mesma chave aplicam uma vez; rejeições de negócio recebem ack e ficam
  auditáveis; erros permanentes vão direto para a DLQ com motivo; transitórios repetem com backoff e vão para a DLQ
  ao esgotar; transitório seguido de recuperação aplica uma única vez; `stop()` deixa a mensagem em andamento
  terminar e devolve o resto do grupo;
- **outbox:** dois publishers concorrentes drenam a mesma outbox sem publicar duas vezes; publisher que morre depois
  do claim é substituído quando o lease expira; falha do broker agenda retry e nunca perde o evento. (O teste de
  ordem no claim veio na etapa 8.)

`test/concurrency/multi-instance.test.ts` (3 processos reais com `Bun.spawn`):

- hot wallet por HTTP e SQS, duplicatas, cenário 100/80/80 e publicação da outbox, tudo entre 3 instâncias;
- **worker morto com `SIGKILL` depois do commit e antes do ack:** a reentrega é absorvida pela inbox;
- **reinício sob carga:** `SIGTERM` gracioso, novas instâncias terminam o trabalho, inclusive um ROLLBACK que chegou
  antes da BET; estado final consistente.

## Limitações

- **Visibility timeout fixo**, sem heartbeat que estenda a visibilidade de mensagens lentas. O processamento leva
  dezenas de milissegundos e o timeout padrão é 30 s; se uma mensagem passar disso, ela é reentregue e a inbox absorve.
- **Janela estreita de ordem entre publishers:** dois relays fazendo o claim no mesmo instante ainda podem pegar
  eventos consecutivos da mesma wallet, porque o `SKIP LOCKED` não enxerga um claim ainda não commitado. Fechar isso
  exigiria um lock por `partition_key` (por exemplo, advisory lock). Os eventos carregam `walletVersion` e
  `occurredAt` para o consumidor ordenar se precisar.
- **Vazão do relay** é o primeiro gargalo sob carga alta; publicar em paralelo lotes de wallets diferentes é a
  evolução natural.
