# Teste de carga

Comando: `bun run test:load` (script em `scripts/load-test.ts`). Requer `bun run infra:up`. Os resultados são gravados
em `load-results/*.json`, que fica no `.gitignore`.

## Metodologia

- **Topologia:** 3 processos reais do serviço (`bun run src/main.ts`). Cada um roda HTTP, consumidor SQS, relay da
  outbox e worker de referências pendentes. Todos compartilham um PostgreSQL 16 e um SQS (LocalStack). Cada instância
  usa `DB_POOL_SIZE=16`.
- **Dados:** 200 wallets com 1.000.000,00 BRL cada, mais uma *hot wallet* com 50.000,00 BRL.
- **Gerador:** loop fechado, com `C` usuários virtuais concorrentes por `D` segundos, alternando entre as instâncias
  (round-robin), via `POST /wagering/transactions`.
- **Mistura de requisições:**
  - 70% BET e 15% WIN em wallets aleatórias, com valores aleatórios entre 1,00 e 50,99;
  - 10% replays exatos de requisições anteriores (caminho de idempotência);
  - 5% BET na hot wallet (disputa pelo lock da linha).
- **Medições:**
  - latência de cada requisição, medida no cliente;
  - status HTTP;
  - outbox lag (idade do evento não publicado mais antigo), amostrado do banco a cada segundo;
  - conflitos de lock e retries de transação, coletados do `/metrics` de cada instância ao final.
- **Portão de correção:** ao final, o saldo de cada wallet deve ser igual ao saldo reconstruído pelo seu ledger, e
  todo journal deve estar balanceado. As duas rodadas abaixo passaram.

Parâmetros: `LOAD_DURATION_S`, `LOAD_CONCURRENCY`, `LOAD_WALLETS` e `LOAD_INSTANCES`.

## Ambiente

Sandbox de nuvem: 4 vCPU, 15 GB de RAM, Linux, Bun 1.4.4, PostgreSQL 16 (alpine) e LocalStack 3.8 em Docker.
**O gerador de carga, as 3 instâncias, o PostgreSQL e o LocalStack dividem as mesmas 4 vCPUs.** Os números descrevem
esta máquina, não uma estimativa de capacidade em produção.

## Resultados

| Rodada | VUs | Duração | Requisições | Throughput | p50 | p95 | p99 | máx | 5xx / erros de rede | Conflitos de lock | Outbox lag p95 / máx | Pico pendente | Drenagem pós-carga |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 16 | 20 s | 5.503 | **274,6 req/s** | 51 ms | 117 ms | 177 ms | 392 ms | 0 / 0 | 0 | 0,48 s / 0,48 s | 242 | 0,2 s |
| C* | 32 | 30 s | 11.533 | **382,8 req/s** | 56 ms | 193 ms | 722 ms | 2.340 ms | 0 / 0 | 0 | 9,9 s / 10,4 s | 7.372 | 4,7 s |
| B | 48 | 30 s | 9.863 | **325,0 req/s** | 90 ms | 313 ms | 1.607 ms | 5.006 ms | 0 / 0 | 0 | 9,2 s / 9,2 s | 5.828 | 3,6 s |

\* Rodada C executada depois das correções de ordem por wallet na outbox (no máximo um evento por wallet em cada
chamada ao SQS; claim que respeita o evento mais antigo da wallet). A ordem custa vazão no relay: o lag cresce mais
cedo do que nas rodadas A e B, e continua drenando sem perda depois da carga.

Status HTTP: a rodada A teve 4.951 × 201 e 552 × 200 (replays); a rodada B teve 8.905 × 201 e 958 × 200. Não aparece
nenhum 422 porque todas as wallets têm saldo alto.

## Análise

- **A correção se mantém sob carga:** zero erros, todo replay respondeu 200 com o resultado original e o invariante do
  ledger passou nas 201 wallets.
- **Ponto de saturação:** de 16 para 48 VUs o throughput sobe só cerca de 18%, enquanto o p99 cresce 9× e o máximo
  chega a uns 5 s. A máquina está limitada por CPU: gerador, 3 processos Bun, PostgreSQL e LocalStack disputam
  4 vCPUs. O máximo de cerca de 5 s coincide com o `connectionTimeoutMillis` do pool: requisições esperaram por uma
  conexão, porque 48 VUs mais os workers de background disputam 3 × 16 conexões. Elas esperaram, mas não falharam.
- **Hot wallet:** os escritores de uma wallet se serializam no lock da linha, por design. Com 5% do tráfego nela, nenhum
  `lock_timeout` (5 s) disparou: zero conflitos de lock e zero retries. A espera aparece como latência de cauda.
- **O outbox lag é o primeiro recurso a ficar para trás:** cada relay publica até 50 eventos por passo, em lotes de
  10 enviados em sequência. Com 48 VUs, os eventos foram produzidos mais rápido do que três relays conseguiam
  publicar: pico de 5.828 pendentes, cerca de 9 s de lag. O acúmulo drenou em 3,6 s depois que a carga parou, sem
  perda de evento.
  - Ajustes disponíveis: `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_MS` e mais instâncias de relay.
  - Evolução possível: publicar em paralelo os lotes de 10 de wallets *diferentes*, o que preserva a ordem por wallet.
- **O que este teste não mede:**
  - latência de rede entre serviços;
  - SQS real da AWS;
  - PostgreSQL ajustado (`shared_buffers`, `synchronous_commit`);
  - throughput do caminho de ingestão por SQS. Esse caminho é exercitado quanto à correção em
    `test/concurrency/multi-instance.test.ts`, não quanto a throughput.
