# Etapa 1 — Fundação do projeto e infraestrutura local

> Commit: `7ba312a chore: scaffold Bun + NestJS + TypeORM project and local infra`

## Objetivo

Deixar pronto o terreno sobre o qual todas as outras etapas foram construídas: runtime, linguagem, ferramentas de
qualidade, executor de testes e uma infraestrutura local **real** (PostgreSQL e SQS) que os testes de integração e
concorrência pudessem usar desde o primeiro dia.

## Por que esta etapa veio primeiro

O desafio é, essencialmente, sobre **correção sob concorrência e falhas**. Esse tipo de garantia só pode ser provado
contra os componentes reais: um mock de banco não tem locks de linha, não tem constraints, não aborta transações
por deadlock; um mock de fila não tem visibility timeout nem grupos FIFO. Por isso a primeira decisão foi ter
PostgreSQL e SQS (via LocalStack) rodando localmente antes de escrever qualquer regra de negócio.

## O que foi feito

| Item | Arquivo(s) | Descrição |
|---|---|---|
| Runtime e gerenciador de pacotes | `package.json`, `bun.lock` | Bun 1.x como runtime, gerenciador de pacotes e executor de testes. |
| TypeScript estrito | `tsconfig.json` | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`. |
| Lint e formatação | `biome.json` | Biome com preset recomendado; `noExplicitAny` como erro; `node:` obrigatório em imports nativos. |
| Scripts | `package.json` | `lint`, `typecheck`, `check`, `test:unit`, `test:integration`, `test:concurrency`, `infra:up/down`. |
| Infra local | `docker-compose.yml` | PostgreSQL 16 (alpine) e LocalStack 3.8 com apenas o serviço SQS. |
| Banco de testes | `infra/postgres/init-test-db.sql` | Cria `wagering_test` na inicialização do container. |
| Filas FIFO | `infra/localstack/init-queues.sh` | `wager-transactions.fifo`, sua DLQ (`maxReceiveCount=5`) e `wagering-events.fifo`. |
| Configuração de exemplo | `.env.example` | Valores locais; nenhum segredo necessário. |

## Decisões e justificativas

### Bun como runtime, gerenciador de pacotes e executor de testes

- **Decisão:** usar Bun para tudo (instalar, rodar, testar), sem Node.js + npm + Jest/Vitest.
- **Por quê:** um único binário reduz configuração; o executor de testes nativo é rápido e roda TypeScript sem
  transpilação prévia; `Bun.spawn` facilita os testes multi-processo (etapa 6) e `Bun.randomUUIDv7()` dá ids
  ordenados no tempo sem dependência extra (etapa 4).
- **Consequência:** o projeto exige Bun ≥ 1.1 (`engines`). NestJS e TypeORM rodam sem adaptação.

### TypeScript no modo mais estrito razoável

- **Decisão:** além de `strict`, ligar `noUncheckedIndexedAccess` e `useUnknownInCatchVariables`.
- **Por quê:** em código financeiro, um `array[i]` que pode ser `undefined` ou um `catch (e)` tratado como `Error` sem
  checagem são fontes clássicas de bug silencioso. O custo é escrever `!` ou checagens explícitas em alguns pontos, o
  que deixa a intenção visível.
- `experimentalDecorators` e `emitDecoratorMetadata` ficam ligados apenas porque o NestJS precisa deles na camada de
  interface; o domínio e a aplicação não usam decorators (veja a etapa 5).

### Biome em vez de ESLint + Prettier

- **Decisão:** Biome para lint e formatação.
- **Por quê:** uma ferramenta, uma configuração, execução rápida. `noExplicitAny` como erro impede que o sistema de
  tipos seja contornado no caminho do dinheiro.

### PostgreSQL 16

- **Por quê:** o desafio pede PostgreSQL. A versão 16 tem tudo o que a solução usa: `NUMERIC` exato, `SELECT … FOR
  UPDATE`, `FOR UPDATE SKIP LOCKED`, índices parciais, constraint triggers `DEFERRABLE INITIALLY DEFERRED`, colunas
  `GENERATED ALWAYS AS IDENTITY`.
- O Compose sobe com `max_connections=300` para comportar várias instâncias com pool próprio durante os testes de
  concorrência e de carga.

### LocalStack para o SQS

- **Decisão:** emular o SQS com LocalStack 3.8, apenas o serviço `sqs`.
- **Por quê:** permite testar a semântica que importa (FIFO, `MessageGroupId`, visibility timeout, redrive para DLQ,
  deduplicação) sem conta AWS.
- **Limitação aceita:** a semântica do LocalStack é muito próxima, mas não idêntica à da AWS. Os testes cobrem o
  comportamento, não as cotas da AWS. Registrado em [`ARCHITECTURE.md`](../../ARCHITECTURE.md#trade-offs-e-limitações).

### Filas FIFO com DLQ desde o início

- **Decisão:** a fila de entrada é FIFO (`wager-transactions.fifo`), com redrive para `wager-transactions-dlq.fifo`
  depois de 5 recebimentos. Os eventos de saída vão para `wagering-events.fifo`.
- **Por quê:** FIFO com `MessageGroupId = walletId` dá ordem por wallet, que é também a unidade de concorrência. A DLQ
  garante que nenhuma mensagem com problema desapareça.
- **Importante:** a ordem do FIFO é tratada como **otimização**, não como garantia. A correção vem do banco (lock por
  wallet, idempotência persistente, referências pendentes). Isso é o que permite processar mensagens fora de ordem
  corretamente.
- O script de init é uma conveniência para inspeção manual; a aplicação também cria as filas de forma idempotente
  na inicialização (`SQS_CREATE_QUEUES=true`, etapa 6).

### Banco separado para testes

- **Decisão:** `wagering_test`, criado pelo init do container.
- **Por quê:** as suítes de integração recriam o schema do zero a cada arquivo. Um banco separado garante que elas
  nunca apaguem dados de desenvolvimento.

## Como verificar

```bash
bun install
```

```bash
bun run infra:up
```

```bash
bun run check
```

## O que esta etapa deixou para as próximas

- Infraestrutura pronta para testes reais (usada a partir da etapa 3).
- Convenções de código e de scripts seguidas por todo o projeto.
- O `docker-compose.yml` foi depois estendido com Keycloak, job de migração e instâncias da aplicação (etapa 5).
