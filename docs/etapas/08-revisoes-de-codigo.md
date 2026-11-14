# Etapa 8 — Revisões de código e correções

> Commits: `1c431a4 fix: apply code review findings` e `e086caa fix: apply second code review findings`
>
> Entraram em `main` pelo merge do PR #2 (`67577dc`), junto com a etapa 9.

## Objetivo

Depois da primeira versão completa (PR #1), o código passou por duas rodadas de revisão focadas em correção. Este
documento registra **cada achado**: o problema, o risco concreto, a correção e o teste que passou a cobri-lo.

## Por que registrar as correções

- Mostra quais garantias eram mais sutis do que pareciam (quase todos os achados envolvem concorrência, ordem ou
  vazamento de informação entre provedores).
- Explica partes do código que, sem contexto, parecem complexidade desnecessária (por exemplo, a consulta de claim da
  outbox ou o envio de no máximo um evento por wallet por chamada ao SQS).

---

## Primeira revisão (`1c431a4`)

### 1. Worker de pendências em *busy loop*

- **Problema:** `ProcessPendingReferences.runOnce` devolvia o número de candidatas **examinadas**. O runner (etapa 6)
  entende "> 0" como "houve trabalho, rode de novo agora". Candidatas adiadas (erro transitório) ou já tratadas por
  outra instância eram contadas como trabalho.
- **Risco:** com uma candidata permanentemente adiada, o worker girava sem pausa, consumindo CPU e conexões.
- **Correção:** devolver só as transações efetivamente liquidadas, reagendadas ou marcadas como `FAILED`.

### 2. WIN/LOSS sobre uma BET já estornada

- **Problema:** a verificação "referência já revertida" só valia para REFUND/ROLLBACK. Um WIN que referenciasse uma
  BET já estornada seria aplicado.
- **Risco:** o jogador recebe o valor da aposta de volta (REFUND) **e** o prêmio dela.
- **Correção:** `REFERENCE_ALREADY_REVERSED` para qualquer operação que referencie uma transação revertida.
- **Teste:** `settlement.test.ts` — "a WIN referencing an already refunded BET is rejected".

### 3. Ordem por wallet quando um evento falha na publicação

- **Problema:** se um evento de uma wallet falhasse no `SendMessageBatch`, os eventos seguintes da mesma wallet no
  mesmo lote ainda eram enviados.
- **Risco:** consumidores recebem `WalletBalanceChanged` da versão 7 antes da versão 6.
- **Correção:** depois de uma falha, os eventos seguintes da mesma partição são retidos para a próxima rodada; outras
  wallets seguem normalmente.
- **Teste:** `sqs-event-publisher.test.ts` (novo).

### 4. Conflito de idempotência com wallet desconhecida

- **Problema:** a wallet era verificada antes da idempotência. Reusar uma chave já usada, mas com um `walletId`
  inexistente, respondia 404.
- **Risco:** o provedor recebe "wallet não existe" quando o problema real é "você reusou a chave com outro payload".
- **Correção:** a busca de idempotência roda mesmo sem a wallet; o conflito (409) tem precedência sobre o 404.
- **Teste:** `wagering-flows.test.ts` — "reusing a key with an unknown walletId is a conflict, not WALLET_NOT_FOUND".

### 5. Cursor do ledger acima do limite de `bigint`

- **Problema:** um cursor com número maior que `9223372036854775807` passava na validação e estourava na consulta.
- **Risco:** 500 para uma entrada inválida.
- **Correção:** o decodificador rejeita valores acima do máximo de `bigint` → 400.

### 6. Consulta de transação de outro provedor

- **Problema:** `GET /wagering/transactions/:id` de uma transação de outro provedor respondia 403.
- **Risco:** a diferença entre 403 e 404 revela que o id existe (enumeração entre provedores).
- **Correção:** responde 404, igual a um id inexistente.

### 7. Dependentes percorridos uma única vez; métrica de conflito com a origem real

- **Problema:** `settleDependents` percorria a cadeia com uma fila própria (busca em largura), mas `processPending`
  também chama `settleDependents` para cada dependente. A cadeia era visitada duas vezes. Além disso, a métrica de
  conflito de idempotência era registrada com `source: "any"`.
- **Risco:** consultas repetidas com lock no caminho quente; métrica sem a origem real.
- **Correção:** a recursão via `processPending` passou a ser o único mecanismo de percorrer a cadeia; a métrica usa a
  origem da requisição (`http`/`sqs`).

### 8. Consumidor continua fazendo polling enquanto processa

- **Problema:** o consumidor esperava o lote inteiro terminar antes do próximo `ReceiveMessage`.
- **Risco:** um único grupo lento (wallet com muitas mensagens) travava todos os outros.
- **Correção:** o lote é processado sem `await` no laço de polling, com número limitado de lotes em andamento. A ordem
  por wallet continua garantida porque o SQS FIFO não entrega um grupo com mensagens em andamento.

### 9. Instâncias não esperam mais o Keycloak para subir

- **Problema:** `api` e `worker` tinham `depends_on: keycloak: service_healthy` no Compose.
- **Risco:** o Keycloak leva dezenas de segundos para subir; a stack inteira (inclusive o consumidor da fila, que nem
  usa autenticação) ficava parada esperando.
- **Correção:** dependência removida. O JWKS é buscado sob demanda na primeira validação de token, então a aplicação
  não precisa do Keycloak para iniciar. Enquanto ele não responde, só as requisições autenticadas são afetadas (a
  partir da segunda revisão, com um 503 retentável; veja o item 13).

---

## Segunda revisão (`e086caa`)

### 10. Chaves de idempotência escopadas por provedor

- **Problema:** `UNIQUE (idempotency_key)` era global.
- **Risco:**
  - **preempção:** um provedor que usasse uma chave antes de outro faria as operações legítimas do segundo receberem
    409;
  - **sondagem:** um provedor poderia descobrir, pelo 409, quais chaves outro provedor já usou.
- **Correção:** nova migration `1761000000005-ScopeIdempotencyAndOrderOutbox` troca a constraint global por
  `UNIQUE (provider_id, idempotency_key)`. Repositório, porta e caso de uso passaram a buscar por `(providerId, key)`,
  e a constraint nova entrou na lista de corridas de unicidade tratadas como transitórias.
- **Decisão:** uma migration nova, não uma edição da migration original, porque migrations aplicadas não devem mudar.
  O `down` dela documenta que falha se dois provedores já tiverem usado a mesma chave (esse dado não cabe na
  constraint antiga).
- **Teste:** `wagering-flows.test.ts` — "idempotency keys are scoped to the provider"; `schema-constraints` ajustado.

### 11. Claim da outbox respeitando a ordem por wallet

- **Problema:** o claim pegava qualquer evento vencido. Se o evento mais antigo de uma wallet estivesse em backoff (ou
  com lease de outro publisher), um evento mais novo da mesma wallet podia ser publicado antes.
- **Correção:** a consulta de claim só pega um evento se **nenhum evento mais antigo e não publicado da mesma
  partição** estiver em backoff ou com lease vigente (`NOT EXISTS` com comparação por `(occurred_at, id)`). Um índice
  parcial novo, `ix_outbox_partition_pending (partition_key, occurred_at, id) WHERE published_at IS NULL`, sustenta
  essa checagem. As linhas devolvidas pelo `UPDATE … RETURNING` (que não tem ordem garantida) são reordenadas por
  `(occurred_at, id)`; como os ids são UUIDv7, eventos de uma mesma transação mantêm a ordem de criação.
- **Teste:** `messaging.test.ts` — "claim keeps per-wallet order: a newer event waits while an older one of the same
  wallet is backing off".

### 12. No máximo um evento por wallet em cada chamada ao SQS

- **Problema:** dentro de um `SendMessageBatch`, o SQS pode aceitar uma entrada posterior de um grupo e rejeitar uma
  anterior do mesmo grupo.
- **Risco:** publicação fora de ordem mesmo com o lote ordenado.
- **Correção:** o publisher monta cada chamada com no máximo um evento por partição; os demais vão para chamadas
  seguintes.
- **Custo:** menos eventos por chamada quando poucas wallets concentram a atividade. A rodada C do teste de carga
  mostra o efeito (o lag cresce mais cedo) e o registro está em [`LOAD_TEST.md`](../LOAD_TEST.md).

### 13. JWKS inacessível vira 503, não 401

- **Problema:** se o Keycloak estivesse fora, a falha ao buscar o JWKS era tratada como token inválido (401).
- **Risco:** o provedor conclui que suas credenciais estão erradas e para de tentar, quando o problema é temporário e
  do servidor.
- **Correção:** erros de token (assinatura, expiração, audiência) continuam 401; timeout ou falha de busca do JWKS
  viram `TransientInfrastructureError` → **503 retentável**.
- **Teste:** `http-auth.test.ts` — "an unreachable JWKS endpoint is a retryable 503, not 401".

### 14. Concorrência do consumidor configurável e limitada pelo pool

- `CONSUMER_MAX_IN_FLIGHT_BATCHES`, com padrão `DB_POOL_SIZE / 10` (mínimo 1). Cada lote tem até 10 mensagens; sem esse
  limite, o consumidor poderia abrir mais transações simultâneas do que o pool de conexões comporta e competir com o
  tráfego HTTP.

### 15. Referência e flag de reversão numa única consulta

- `findReference` devolve a transação referenciada **e** se ela já foi revertida, com um `EXISTS` na mesma consulta.
  Antes eram duas idas ao banco no caminho quente.

### 16. `query_timeout` do lado do cliente

- **Problema:** `statement_timeout` é aplicado pelo servidor. Com o servidor congelado e a conexão TCP aberta, ele
  nunca dispara, e a requisição fica pendurada.
- **Correção:** o pool recebe `query_timeout = statement_timeout + 5 s`. A consulta pendurada vira erro transitório
  (mensagem "Query read timeout" adicionada à classificação em `pg-errors.ts`), e o fluxo segue para retry ou 503.
- **Validado** pelo teste de `docker pause` (etapa 7).

### 17. Testes e suporte

- Novos testes listados acima, mais o valor de retorno do worker de pendências e o lote do publisher.
- `test/support/instances.ts`: a criação de instância em porta aleatória tenta de novo se a porta já estiver em uso,
  eliminando uma fonte de flakiness nos testes multi-processo.

---

## Lições

| Tema | O que a revisão mostrou |
|---|---|
| Ordem de eventos | Ordem por wallet precisa ser garantida em três pontos (claim, montagem da chamada, falha parcial). Um só não basta. |
| Isolamento entre provedores | Tanto unicidade global quanto a diferença 403/404 vazavam informação entre provedores. |
| Classificação de erros | "Não consegui validar" (IdP fora) é diferente de "inválido" (token ruim). A diferença decide se o cliente repete. |
| Workers periódicos | O contrato "devolva quanto trabalho fez" precisa contar só trabalho real, senão vira busy loop. |
| Timeouts | Timeouts do servidor não protegem contra servidor congelado; é preciso um do lado do cliente. |
