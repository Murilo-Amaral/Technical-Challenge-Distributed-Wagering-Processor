# Etapa 7 — Testes de falha de infraestrutura e teste de carga

> Commit: `d0cabf8 test: infrastructure outage tests and load test`
>
> Código: `test/concurrency/infrastructure-outage.test.ts`, `scripts/load-test.ts` · Resultados: [`LOAD_TEST.md`](../LOAD_TEST.md)

## Objetivo

Até aqui os testes provavam correção com a infraestrutura saudável (inclusive com processos morrendo). Esta etapa
responde duas perguntas que faltavam:

1. **O que acontece quando o PostgreSQL ou o SQS ficam indisponíveis?** O serviço precisa sinalizar o problema,
   responder de forma que o cliente saiba que pode repetir, não deixar efeito parcial e se recuperar sozinho.
2. **Como o serviço se comporta sob carga?** Onde satura, qual é o primeiro gargalo e se a correção se mantém.

## Parte 1 — Indisponibilidade real de infraestrutura

### Como a falha é simulada

- **Decisão:** congelar os containers com `docker pause` enquanto uma instância real do serviço está rodando.
- **Por quê `pause` e não `stop`:** `pause` congela o processo sem fechar as conexões TCP. É o cenário mais traiçoeiro:
  o cliente não recebe "conexão recusada", ele simplesmente não recebe resposta. É exatamente o caso que motivou o
  `query_timeout` do lado do cliente (etapa 3): `statement_timeout` roda no servidor e não dispara com o servidor
  congelado.
- A instância de teste sobe com `DB_LOCK_TIMEOUT_MS=1000`, `DB_STATEMENT_TIMEOUT_MS=2000` e `TX_MAX_RETRIES=1`, para
  que o teste não leve minutos.
- A suíte é pulada automaticamente se o CLI do Docker ou os containers do Compose não estiverem disponíveis; nomes dos
  containers configuráveis por `TEST_POSTGRES_CONTAINER` e `TEST_LOCALSTACK_CONTAINER`.

### PostgreSQL fora

O teste verifica, nesta ordem:

1. `/health/ready` responde **503** com `checks.postgres = "down"`;
2. `/health/live` continua **200** (liveness não depende do banco, etapa 5);
3. `POST /wagering/transactions` responde **503**, com `Retry-After: 1` e `error.retryable = true`;
4. depois do `unpause`, a readiness volta sozinha;
5. o mesmo request repetido agora responde **201**: a tentativa que falhou **não deixou nada gravado**;
6. repetido de novo, responde **200** (replay), e o saldo reflete um único débito.

O ponto 5 é a prova de atomicidade sob falha: um 503 garante que nada foi aplicado, então o cliente pode reenviar sem
risco.

### SQS fora

1. `/health/ready` reporta `checks.sqs = "down"`;
2. **o HTTP continua funcionando** (201): os eventos esperam na outbox, porque a publicação é desacoplada da
   transação (etapa 6);
3. uma mensagem enviada antes da queda é processada depois que o SQS volta, e o relay publica os eventos acumulados.

**Decisão de produto que este teste confirma:** a indisponibilidade do broker não impede o processamento financeiro
pela API. Só atrasa a publicação dos eventos e o consumo da fila.

## Parte 2 — Teste de carga

### Metodologia (`scripts/load-test.ts`)

- 3 processos reais do serviço, cada um rodando HTTP, consumidor, relay e worker de pendências, com
  `DB_POOL_SIZE=16`, sobre o mesmo PostgreSQL e LocalStack.
- 200 wallets com saldo alto e uma *hot wallet*.
- Gerador em loop fechado: `C` usuários virtuais por `D` segundos, round-robin entre as instâncias.
- Mistura: 70% BET e 15% WIN em wallets aleatórias; 10% replays exatos (caminho de idempotência); 5% BET na hot
  wallet (disputa pelo lock da linha).
- Medições: latência por requisição no cliente (p50/p95/p99/máx), status HTTP, lag da outbox amostrado do banco a cada
  segundo, conflitos de lock e retries coletados do `/metrics` de cada instância.
- **Portão de correção:** ao final, saldo de cada wallet = saldo reconstruído pelo ledger, e todo journal balanceado.
  Uma rodada rápida mas incorreta é uma rodada reprovada.
- Parâmetros: `LOAD_DURATION_S`, `LOAD_CONCURRENCY`, `LOAD_WALLETS`, `LOAD_INSTANCES`. Resultados em
  `load-results/*.json` (fora do git).

### Por que esse desenho

- **Loop fechado** (cada usuário espera a resposta antes do próximo request) mede o comportamento do sistema sob
  concorrência fixa e revela a saturação como aumento de latência, sem gerar uma fila artificial no cliente.
- **Replays e hot wallet na mistura** porque são os caminhos que mais diferenciam esta solução: idempotência
  persistente e serialização por lock.
- **Invariante como portão** porque o objetivo do desafio é correção; vazão vem depois.

### Principais conclusões

Os números completos estão em [`LOAD_TEST.md`](../LOAD_TEST.md). Em resumo:

- **A correção se manteve:** zero erros, todo replay respondeu 200 com o resultado original, invariante do ledger
  aprovado em todas as wallets.
- **Saturação por CPU:** gerador, 3 instâncias, PostgreSQL e LocalStack dividem 4 vCPUs. De 16 para 48 usuários a
  vazão sobe pouco e a latência de cauda cresce bastante; o máximo de ~5 s coincide com o
  `connectionTimeoutMillis` do pool (requisições esperaram conexão, mas não falharam).
- **Hot wallet:** os escritores se serializam no lock, por design; nenhum `lock_timeout` disparou. A espera aparece
  como latência de cauda, não como erro.
- **O relay da outbox é o primeiro recurso a ficar para trás:** o lag cresce sob carga alta e drena em poucos
  segundos quando a carga para, sem perda de evento.
- Uma rodada adicional foi feita depois das correções de ordem por wallet na outbox (etapa 8): a ordem custa vazão no
  relay (o lag cresce mais cedo), e continua drenando sem perda.

### O que o teste não mede

Latência de rede entre serviços, SQS real da AWS, PostgreSQL ajustado (`shared_buffers`, `synchronous_commit`) e a
vazão do caminho de ingestão por SQS (que é exercitado quanto à correção em `multi-instance.test.ts`).

## Decisões resultantes

- **Manter o lock pessimista:** sob contenção real ele não gerou retries nem conflitos, o que confirma a escolha da
  etapa 4.
- **Registrar o relay como limitação conhecida**, com os ajustes disponíveis (`OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_MS`,
  mais instâncias) e a evolução natural (publicar em paralelo lotes de wallets diferentes, preservando a ordem por
  wallet).

## Também nesta etapa

`docs/LOAD_TEST.md` com metodologia, ambiente, duas rodadas e análise. O documento foi traduzido para português junto
com a documentação da etapa seguinte e ganhou a rodada pós-correções na etapa 9.
