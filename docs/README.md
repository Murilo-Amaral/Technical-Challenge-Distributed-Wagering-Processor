# Documentação técnica

Esta pasta registra **como o projeto foi construído, etapa por etapa**: o que cada etapa entregou, por que ela existe,
quais decisões foram tomadas (e quais alternativas foram descartadas) e o que ficou como limitação conhecida.

Ela complementa, sem substituir, os dois documentos da raiz:

| Documento | Para que serve |
|---|---|
| [`README.md`](../README.md) | Como subir, rodar, testar e chamar a API. Referência operacional. |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | Visão consolidada da arquitetura final: garantias, tabelas de referência, mapa requisito → implementação. |
| `docs/` (aqui) | A história técnica: cada etapa explicada no seu próprio documento, com o raciocínio por trás. |

## Visão geral em um parágrafo

O serviço processa operações financeiras de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) que chegam de vários
provedores por **HTTP** e por **SQS**, e precisa continuar correto com mensagens duplicadas, fora de ordem e
processadas em paralelo por várias instâncias. A solução se apoia em uma ideia central: **o PostgreSQL é a fonte da
verdade de todas as invariantes**. Cada wallet é serializada por um lock de linha; idempotência, imutabilidade, saldo
não-negativo e consistência saldo × ledger são garantidos por constraints e triggers; eventos saem por uma
*transactional outbox*; mensagens da fila são deduplicadas por uma *inbox* na mesma transação do efeito.

## Etapas

As etapas seguem a ordem em que o projeto foi construído. Cada uma corresponde a um ou mais commits do histórico.

| # | Etapa | Documento | Commit(s) |
|---|---|---|---|
| 1 | Fundação do projeto e infraestrutura local | [`etapas/01-fundacao-e-infraestrutura.md`](./etapas/01-fundacao-e-infraestrutura.md) | `7ba312a` |
| 2 | Modelo de domínio | [`etapas/02-modelo-de-dominio.md`](./etapas/02-modelo-de-dominio.md) | `0afdfc6` |
| 3 | Persistência e schema com invariantes no banco | [`etapas/03-persistencia-e-schema.md`](./etapas/03-persistencia-e-schema.md) | `4b26556` |
| 4 | Casos de uso, idempotência e concorrência | [`etapas/04-casos-de-uso-idempotencia-e-concorrencia.md`](./etapas/04-casos-de-uso-idempotencia-e-concorrencia.md) | `580e65b` |
| 5 | API HTTP, autenticação (Keycloak) e observabilidade | [`etapas/05-api-http-autenticacao-e-observabilidade.md`](./etapas/05-api-http-autenticacao-e-observabilidade.md) | `4931f02` |
| 6 | Mensageria: consumidor SQS, inbox e outbox | [`etapas/06-mensageria-sqs-inbox-e-outbox.md`](./etapas/06-mensageria-sqs-inbox-e-outbox.md) | `d36e65c` |
| 7 | Testes de falha de infraestrutura e teste de carga | [`etapas/07-testes-de-falha-e-carga.md`](./etapas/07-testes-de-falha-e-carga.md) | `d0cabf8` |
| 8 | Revisões de código e correções | [`etapas/08-revisoes-de-codigo.md`](./etapas/08-revisoes-de-codigo.md) | `1c431a4`, `e086caa` |
| 9 | Teste de aceitação caixa-preta e ajuste do Compose | [`etapas/09-aceitacao-caixa-preta-e-compose.md`](./etapas/09-aceitacao-caixa-preta-e-compose.md) | `a8cfa93`, `eab6016` |

Documentos transversais:

| Documento | Conteúdo |
|---|---|
| [`decisoes.md`](./decisoes.md) | Registro de decisões (estilo ADR): contexto, decisão, alternativas e consequências de cada escolha importante, com link para a etapa onde ela aparece. |
| [`estrategia-de-testes.md`](./estrategia-de-testes.md) | Pirâmide de testes, o que cada suíte prova, infraestrutura de teste e o invariante final verificado por todas. |
| [`LOAD_TEST.md`](./LOAD_TEST.md) | Metodologia, ambiente, resultados e análise do teste de carga. |

## Ordem de leitura sugerida

- **Quero entender a solução rapidamente:** este README → [`ARCHITECTURE.md`](../ARCHITECTURE.md) (visão geral e
  fluxo) → [`decisoes.md`](./decisoes.md).
- **Vou mexer no código:** etapas 2, 3 e 4, nessa ordem. Elas explicam as regras de domínio, o que o banco garante e
  como o caso de uso central amarra tudo numa transação.
- **Vou operar ou depurar em produção:** etapas 5, 6 e 7 (status HTTP, classificação de mensagens na fila, DLQ,
  outbox, métricas, comportamento com o banco ou o SQS fora).
- **Quero saber o que já deu errado e foi corrigido:** etapas 8 e 9.

## Mapa do código por camada

```
src/
  main.ts                    bootstrap do processo e tratamento de SIGTERM/SIGINT            (etapa 5)
  bootstrap/                 composition root (container) e fábrica da aplicação Nest         (etapa 5)
  config/app-config.ts       configuração validada com zod                                    (etapas 1 e 5)
  wagering/
    domain/                  Money, Wallet, WagerTransaction, ledger, Settlement, eventos     (etapa 2)
    application/             casos de uso e portas                                            (etapa 4)
    infrastructure/
      persistence/           migrations, schemas TypeORM, repositórios, unit of work          (etapa 3)
      messaging/             consumidor SQS, publisher de eventos, criação das filas          (etapa 6)
      observability/         logger pino e métricas Prometheus                                (etapa 5)
      workers.ts             runner periódico dos workers de background                       (etapa 6)
    interface/http/          controllers, mapeamento de erros, guard OIDC                     (etapa 5)
test/                        unit · integration · concurrency · support                       (todas)
scripts/                     migrate · load-test · acceptance-test · keycloak-token           (etapas 3, 5, 7, 9)
infra/                       postgres · localstack · keycloak                                 (etapas 1 e 5)
```

## Glossário

| Termo | Significado neste projeto |
|---|---|
| **Provedor** | Sistema de jogos externo que envia as operações. Identificado por `providerId`. |
| **Wallet** | Saldo de um jogador em uma moeda. Uma por `(playerId, currency)`. |
| **Operação / transação de aposta** | Uma `WagerTransaction`: BET, WIN, LOSS, REFUND, ROLLBACK (ou OPENING, interna). |
| **Referência** | A transação que uma operação aponta por `referenceExternalTransactionId` (ex.: o REFUND aponta a BET). |
| **Reversão** | REFUND ou ROLLBACK. Uma transação pode ser revertida no máximo uma vez. |
| **Journal** | O par balanceado de lançamentos de uma transação no ledger de partidas dobradas. |
| **Conta de sistema** | Contrapartida do lançamento da wallet: `HOUSE` (apostas) ou `FUNDING` (abertura). |
| **Replay** | Reenvio idempotente: mesma chave e mesmo payload devolvem o resultado gravado, sem novo efeito. |
| **Inbox** | Tabela que deduplica mensagens da fila por `(consumerName, messageId)`. |
| **Outbox** | Tabela onde os eventos de integração são gravados na mesma transação do efeito, para publicação posterior. |
| **Relay** | Worker que lê a outbox e publica os eventos no SQS. |
| **Lease** | Reserva temporária (`locked_until`) de um lote da outbox por um publisher. |
| **DLQ** | *Dead-letter queue*: fila para onde vão mensagens que não podem ser processadas. |
