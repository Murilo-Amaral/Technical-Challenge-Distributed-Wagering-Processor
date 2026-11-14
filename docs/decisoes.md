# Registro de decisões

Cada entrada segue o formato de um ADR (*Architecture Decision Record*) curto: **contexto**, **decisão**,
**alternativas consideradas** e **consequências**. O link "Etapa" leva ao documento onde a decisão é explicada em
detalhe.

| # | Decisão | Etapa |
|---|---|---|
| D-01 | [O banco é a fonte da verdade das invariantes](#d-01-o-banco-é-a-fonte-da-verdade-das-invariantes) | 3 |
| D-02 | [Dinheiro em bigint de centavos e string decimal no contrato](#d-02-dinheiro-em-bigint-de-centavos-e-string-decimal-no-contrato) | 2 |
| D-03 | [Lock pessimista por wallet](#d-03-lock-pessimista-por-wallet) | 4 |
| D-04 | [Nenhum lock global e contas de sistema sem saldo materializado](#d-04-nenhum-lock-global-e-contas-de-sistema-sem-saldo-materializado) | 2, 4 |
| D-05 | [Ledger de partidas dobradas e append-only](#d-05-ledger-de-partidas-dobradas-e-append-only) | 2, 3 |
| D-06 | [Idempotência persistente, escopada por provedor, com hash canônico](#d-06-idempotência-persistente-escopada-por-provedor-com-hash-canônico) | 2, 4, 8 |
| D-07 | [Reversão no máximo uma vez por qualquer tipo](#d-07-reversão-no-máximo-uma-vez-por-qualquer-tipo) | 2, 3 |
| D-08 | [Referências fora de ordem com espera limitada](#d-08-referências-fora-de-ordem-com-espera-limitada) | 4 |
| D-09 | [Um único caso de uso para HTTP e SQS](#d-09-um-único-caso-de-uso-para-http-e-sqs) | 4 |
| D-10 | [Inbox na mesma transação e ack somente após o commit](#d-10-inbox-na-mesma-transação-e-ack-somente-após-o-commit) | 6 |
| D-11 | [Transactional outbox com lease e SKIP LOCKED](#d-11-transactional-outbox-com-lease-e-skip-locked) | 6, 8 |
| D-12 | [Rejeição de negócio recebe ack e erro permanente vai para a DLQ](#d-12-rejeição-de-negócio-recebe-ack-e-erro-permanente-vai-para-a-dlq) | 6 |
| D-13 | [Um status HTTP por situação e o campo retryable](#d-13-um-status-http-por-situação-e-o-campo-retryable) | 5 |
| D-14 | [TypeORM com EntitySchema separado do domínio](#d-14-typeorm-com-entityschema-separado-do-domínio) | 3 |
| D-15 | [Composition root em vez da injeção de dependência do Nest](#d-15-composition-root-em-vez-da-injeção-de-dependência-do-nest) | 5 |
| D-16 | [READ COMMITTED com retry de erros transitórios](#d-16-read-committed-com-retry-de-erros-transitórios) | 3 |
| D-17 | [Constraint triggers deferred para saldo e ledger](#d-17-constraint-triggers-deferred-para-saldo-e-ledger) | 3 |
| D-18 | [Keycloak com client_credentials e validação local do JWT](#d-18-keycloak-com-client_credentials-e-validação-local-do-jwt) | 5, 8 |
| D-19 | [Liveness sem dependências e readiness com dependências](#d-19-liveness-sem-dependências-e-readiness-com-dependências) | 5 |
| D-20 | [Testes contra infraestrutura real](#d-20-testes-contra-infraestrutura-real) | 1, 7 |
| D-21 | [Variável própria para a autenticação no Compose](#d-21-variável-própria-para-a-autenticação-no-compose) | 9 |

---

### D-01: O banco é a fonte da verdade das invariantes

- **Contexto:** várias instâncias processam ao mesmo tempo; só o banco vê todas as escritas.
- **Decisão:** toda invariante (unicidade, saldo ≥ 0, imutabilidade, state machine, saldo = ledger, journal
  balanceado) é aplicada por constraint ou trigger, além do código.
- **Alternativas:** validar só na aplicação (falha com instâncias concorrentes ou código com bug); serializar tudo
  num processo único (sem escala horizontal).
- **Consequências:** um bug na aplicação vira erro, não dado inválido. Schema amarrado ao PostgreSQL (PL/pgSQL).
  O broker (FIFO, deduplicação) passa a ser otimização, não garantia.
- **Etapa:** [3](./etapas/03-persistencia-e-schema.md).

### D-02: Dinheiro em bigint de centavos e string decimal no contrato

- **Contexto:** ponto flutuante não representa decimais com exatidão; arredondar esconde erros.
- **Decisão:** `Money` interno em `bigint` de centavos; entrada e saída como string com 2 casas; valores com mais de
  2 casas são rejeitados; `NUMERIC(20,2)` no banco, lido como string.
- **Alternativas:** `number` (inexato); biblioteca decimal (dependência a mais para uma escala fixa); arredondar a
  entrada (perda silenciosa).
- **Consequências:** nenhum `number` no caminho do dinheiro. Clientes precisam enviar strings.
- **Etapa:** [2](./etapas/02-modelo-de-dominio.md).

### D-03: Lock pessimista por wallet

- **Contexto:** hot wallets recebem muitas operações simultâneas; o saldo não pode ficar negativo nem perder updates.
- **Decisão:** `SELECT … FOR UPDATE` na wallet antes de qualquer decisão, com update condicionado à versão como
  redundância.
- **Alternativas:** otimista puro (tempestade de retries sob contenção); fila em memória por wallet (não funciona entre
  instâncias); advisory locks (equivalente, porém menos visível que o lock da linha).
- **Consequências:** escritores da mesma wallet se serializam sem retrabalho; a vazão de uma única wallet é limitada
  pela latência de uma transação curta. Exige transações curtas e sem I/O externo.
- **Etapa:** [4](./etapas/04-casos-de-uso-idempotencia-e-concorrencia.md).

### D-04: Nenhum lock global e contas de sistema sem saldo materializado

- **Contexto:** o desafio proíbe lock global; as contas de contrapartida do ledger seriam atualizadas por toda
  operação.
- **Decisão:** `HOUSE` e `FUNDING` existem só como lançamentos, sem linha de saldo; outbox com `SKIP LOCKED`; worker de
  pendências trava wallet por wallet.
- **Alternativas:** saldo materializado da casa (ponto quente global).
- **Consequências:** wallets diferentes processam em paralelo de verdade. O saldo da casa é calculado por `SUM` sob
  demanda, sem endpoint.
- **Etapas:** [2](./etapas/02-modelo-de-dominio.md), [4](./etapas/04-casos-de-uso-idempotencia-e-concorrencia.md).

### D-05: Ledger de partidas dobradas e append-only

- **Contexto:** o enunciado exige ledger imutável; partidas dobradas eram diferencial.
- **Decisão:** cada transação financeira gera um journal com o lançamento da wallet e a contrapartida; o banco proíbe
  `UPDATE`, `DELETE` e `TRUNCATE` e verifica encadeamento e balanceamento.
- **Alternativas:** ledger de entrada simples (sem auto-verificação).
- **Consequências:** o ledger se verifica sozinho; correções são sempre novos lançamentos (estornos), nunca edições.
- **Etapas:** [2](./etapas/02-modelo-de-dominio.md), [3](./etapas/03-persistencia-e-schema.md).

### D-06: Idempotência persistente, escopada por provedor, com hash canônico

- **Contexto:** provedores reenviam operações; o mesmo pedido pode chegar por HTTP e por fila, em várias instâncias.
- **Decisão:** `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`; o replay
  compara o SHA-256 do JSON canônico dos campos de negócio; replay devolve status e saldo gravados.
- **Alternativas:** cache em memória ou Redis (não sobrevive a restart / não é atômico com a transação); chave global
  (permite preempção e sondagem entre provedores — corrigido na etapa 8).
- **Consequências:** reenvio seguro por qualquer canal; mesma chave com outro conteúdo é 409, nunca replay silencioso.
- **Etapas:** [2](./etapas/02-modelo-de-dominio.md), [4](./etapas/04-casos-de-uso-idempotencia-e-concorrencia.md),
  [8](./etapas/08-revisoes-de-codigo.md).

### D-07: Reversão no máximo uma vez por qualquer tipo

- **Contexto:** o enunciado diz que uma transação não pode ser revertida duas vezes "pelo mesmo tipo".
- **Decisão:** leitura mais estrita: uma transação é revertida no máximo uma vez, seja por REFUND ou por ROLLBACK.
  Garantido pelo índice único parcial `uq_wager_reversed_once`. WIN/LOSS sobre BET revertida também é recusado.
- **Alternativas:** permitir REFUND e ROLLBACK da mesma BET (o jogador seria creditado duas vezes).
- **Consequências:** desfazer um REFUND continua possível via ROLLBACK *do REFUND* (outra referência).
- **Etapas:** [2](./etapas/02-modelo-de-dominio.md), [3](./etapas/03-persistencia-e-schema.md).

### D-08: Referências fora de ordem com espera limitada

- **Contexto:** um REFUND pode chegar antes da BET que ele estorna.
- **Decisão:** `PENDING_REFERENCE` sem efeito no saldo; liquidação imediata quando a referência chega (na mesma
  transação); worker com backoff como rede de segurança; limite de 10 tentativas (~8 min); depois,
  `REFERENCE_NOT_FOUND`.
- **Alternativas:** rejeitar na hora (quebra com reordenação normal da rede); esperar para sempre (reversões abertas
  indefinidamente).
- **Consequências:** reordenação comum é absorvida sem atraso perceptível; casos patológicos terminam de forma
  auditável.
- **Etapa:** [4](./etapas/04-casos-de-uso-idempotencia-e-concorrencia.md).

### D-09: Um único caso de uso para HTTP e SQS

- **Contexto:** as mesmas operações chegam pelos dois canais.
- **Decisão:** `SubmitWagerTransaction` e `parseWagerCommand` compartilhados; a inbox é o único extra da fila.
- **Alternativas:** dois fluxos (divergem com o tempo).
- **Consequências:** regras e idempotência idênticas; um reenvio por outro canal vira replay.
- **Etapa:** [4](./etapas/04-casos-de-uso-idempotencia-e-concorrencia.md).

### D-10: Inbox na mesma transação e ack somente após o commit

- **Contexto:** SQS entrega *at-least-once*; o processo pode morrer a qualquer momento.
- **Decisão:** registrar `(consumerName, messageId)` na mesma transação do efeito; `DeleteMessage` só depois do commit.
- **Alternativas:** ack antes de processar (perde mensagens); inbox em transação separada (janela de inconsistência).
- **Consequências:** efeito exatamente uma vez sobre transporte *at-least-once*. Provado com `SIGKILL` real entre
  commit e ack.
- **Etapa:** [6](./etapas/06-mensageria-sqs-inbox-e-outbox.md).

### D-11: Transactional outbox com lease e SKIP LOCKED

- **Contexto:** publicar evento e confirmar transação são operações em sistemas diferentes.
- **Decisão:** eventos gravados na transação do efeito; relay em três passos curtos (claim com lease, publicação,
  conclusão); `SKIP LOCKED` entre publishers; ordem por wallet garantida no claim, na montagem da chamada e em falha
  parcial; nunca desiste.
- **Alternativas:** publicar dentro da transação (I/O segurando locks; pode anunciar rollback); publicar depois do
  commit sem outbox (perde evento em crash); CDC/Debezium (mais infraestrutura).
- **Consequências:** nenhum evento perdido nem antecipado; entrega *at-least-once* com deduplicação por `eventId`;
  o relay é o primeiro gargalo sob carga alta; resta uma janela estreita de ordem entre dois claims simultâneos.
- **Etapas:** [6](./etapas/06-mensageria-sqs-inbox-e-outbox.md), [8](./etapas/08-revisoes-de-codigo.md).

### D-12: Rejeição de negócio recebe ack e erro permanente vai para a DLQ

- **Contexto:** a fila precisa distinguir o que repetir, o que descartar com segurança e o que não pode sumir.
- **Decisão:** desfechos de negócio (incluindo `REJECTED`) → ack; erro permanente que não vira registro (payload
  inválido, conflito, wallet inexistente) → DLQ imediata com `reason`; transitório → retry com backoff até 5 vezes,
  depois DLQ.
- **Alternativas:** mandar rejeições para a DLQ (ela vira lixeira de resultados válidos); repetir tudo (loops).
- **Consequências:** a DLQ só contém o que exige ação humana, sempre com motivo.
- **Etapa:** [6](./etapas/06-mensageria-sqs-inbox-e-outbox.md).

### D-13: Um status HTTP por situação e o campo retryable

- **Contexto:** o provedor precisa decidir automaticamente se repete, corrige ou desiste.
- **Decisão:** 201 aplicada, 200 replay, 202 pendente, 422 rejeição de negócio, 400/401/403/404/409, 503 com
  `Retry-After`; todo erro com `error.retryable`.
- **Alternativas:** 200 com status no corpo para tudo (obriga a interpretar o corpo); 400 genérico.
- **Consequências:** clientes simples conseguem agir só pelo status.
- **Etapa:** [5](./etapas/05-api-http-autenticacao-e-observabilidade.md).

### D-14: TypeORM com EntitySchema separado do domínio

- **Contexto:** o enunciado prefere MikroORM e aceita TypeORM; o domínio tem construtores privados.
- **Decisão:** TypeORM 0.3, entidades como `EntitySchema` sem decorators, mapeamento explícito record ↔ agregado,
  escritas explícitas.
- **Alternativas:** MikroORM (preferido no enunciado; escolha seguiu a recomendação recebida); decorators nas classes de
  domínio (acopla domínio ao ORM).
- **Consequências:** domínio ignorante do ORM; mais código de mapeamento; nenhum flush implícito no caminho do
  dinheiro.
- **Etapa:** [3](./etapas/03-persistencia-e-schema.md).

### D-15: Composition root em vez da injeção de dependência do Nest

- **Contexto:** usar a DI do Nest nos casos de uso exigiria decorators na camada de aplicação.
- **Decisão:** `buildContainer` constrói tudo com `new`; o módulo Nest só expõe as instâncias.
- **Alternativas:** `@Injectable` em tudo.
- **Consequências:** aplicação e domínio sem framework; testes montam o mesmo container sem o Nest.
- **Etapa:** [5](./etapas/05-api-http-autenticacao-e-observabilidade.md).

### D-16: READ COMMITTED com retry de erros transitórios

- **Contexto:** a correção já vem do lock da wallet.
- **Decisão:** READ COMMITTED (REPEATABLE READ só na reconciliação); `lock_timeout` e `statement_timeout` por
  transação; retry limitado com backoff exponencial e *full jitter*; `query_timeout` no cliente.
- **Alternativas:** SERIALIZABLE (mais abortos para repetir, sem ganho de correção aqui).
- **Consequências:** falhas transitórias viram retry automático e, se persistirem, 503 ou retry na fila.
- **Etapa:** [3](./etapas/03-persistencia-e-schema.md).

### D-17: Constraint triggers deferred para saldo e ledger

- **Contexto:** dentro da transação, saldo e ledger são escritos em passos; uma checagem imediata falharia no meio.
- **Decisão:** `DEFERRABLE INITIALLY DEFERRED`: saldo = último lançamento e journal balanceado são verificados no
  commit.
- **Alternativas:** checagem só na aplicação; ordem de escrita artificial.
- **Consequências:** saldo sem ledger (ou o inverso) não pode ser confirmado; a reconciliação só acha divergência se os
  triggers forem contornados.
- **Etapa:** [3](./etapas/03-persistencia-e-schema.md).

### D-18: Keycloak com client_credentials e validação local do JWT

- **Contexto:** o desafio pede integração com IdP externo; provedores são sistemas, não pessoas.
- **Decisão:** cada provedor é um client confidencial com `provider_id` e `aud` injetados; a API valida o JWT
  localmente via JWKS; um provedor só age pelo próprio `providerId`; IdP inacessível → 503, não 401; segredos gerados
  pelo Keycloak, nunca versionados.
- **Alternativas:** introspecção do token a cada request (latência e dependência do IdP por chamada); API keys
  estáticas (sem rotação nem padrão).
- **Consequências:** nenhuma chamada ao IdP por request; Keycloak em `start-dev` adequado apenas para desenvolvimento.
- **Etapas:** [5](./etapas/05-api-http-autenticacao-e-observabilidade.md), [8](./etapas/08-revisoes-de-codigo.md).

### D-19: Liveness sem dependências e readiness com dependências

- **Contexto:** um orquestrador reinicia processos com liveness falhando.
- **Decisão:** `/health/live` só confirma que o processo responde; `/health/ready` checa PostgreSQL e SQS.
- **Alternativas:** um único health checando tudo (queda do banco reiniciaria todas as instâncias).
- **Consequências:** durante uma queda o tráfego é desviado, mas os processos ficam vivos e se recuperam sozinhos
  (provado com `docker pause`).
- **Etapa:** [5](./etapas/05-api-http-autenticacao-e-observabilidade.md).

### D-20: Testes contra infraestrutura real

- **Contexto:** as garantias dependem de locks, constraints, visibility timeout e grupos FIFO.
- **Decisão:** nenhuma suíte substitui PostgreSQL ou SQS por mocks; concorrência com paralelismo real; falhas reais
  (`SIGKILL`, `docker pause`).
- **Alternativas:** mocks (provariam o mock, não o sistema).
- **Consequências:** suítes de integração mais lentas e dependentes de Docker; confiança muito maior.
- **Etapas:** [1](./etapas/01-fundacao-e-infraestrutura.md), [7](./etapas/07-testes-de-falha-e-carga.md),
  [estratégia de testes](./estrategia-de-testes.md).

### D-21: Variável própria para a autenticação no Compose

- **Contexto:** o Compose carrega o `.env` local, que desliga a autenticação para execução fora de containers.
- **Decisão:** o Compose lê `COMPOSE_AUTH_MODE` (padrão `keycloak`), não `AUTH_MODE`.
- **Alternativas:** remover `AUTH_MODE` do `.env.example`; fixar `keycloak` sem variável.
- **Consequências:** a stack sobe sempre autenticada, salvo pedido explícito.
- **Etapa:** [9](./etapas/09-aceitacao-caixa-preta-e-compose.md).
