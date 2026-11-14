# Etapa 5 — API HTTP, autenticação (Keycloak) e observabilidade

> Commit: `4931f02 feat(http): REST API, observability and Keycloak (OIDC) authentication`
>
> Código: `src/wagering/interface/http/`, `src/bootstrap/`, `src/main.ts`, `src/config/app-config.ts`,
> `src/wagering/infrastructure/observability/` · Infra: `infra/keycloak/`, `Dockerfile`, `docker-compose.yml`
>
> Testes: `test/integration/http-api.test.ts`, `http-auth.test.ts`, `keycloak-e2e.test.ts`

## Objetivo

Expor os casos de uso da etapa 4 por uma API REST com status HTTP distintos para cada situação, proteger a API com
um IdP externo (Keycloak, OIDC), dar ao serviço logs estruturados, métricas e health checks, e empacotar tudo em
containers com uma topologia de várias instâncias.

## O que foi feito

| Área | Arquivos |
|---|---|
| Controllers | `wallets.controller.ts`, `wagering.controller.ts`, `health.controller.ts` |
| Mapeamento de erros | `error-mapping.ts`, `http-exception.filter.ts` |
| Apresentação e status de submissão | `presenters.ts` |
| Validação de parâmetros de rota | `params.ts` |
| Correlação | `correlation.middleware.ts` |
| Autenticação e autorização | `auth/token-verifier.ts`, `auth/auth.guard.ts`, `auth/principal.ts`, `auth/provider-identity.ts` |
| Composition root | `src/bootstrap/container.ts`, `src/bootstrap/application.ts`, `src/wagering/wagering.module.ts` |
| Configuração validada | `src/config/app-config.ts` |
| Logs e métricas | `observability/pino-logger.ts`, `observability/prometheus-metrics.ts` |
| Realm do Keycloak | `infra/keycloak/realm-wagering.json`, `scripts/keycloak-token.sh` |
| Containers | `Dockerfile`, `docker-compose.yml` (serviços `keycloak`, `migrate`, `api`, `worker`) |

## API

| Rota | Papel | Descrição |
|---|---|---|
| `POST /wallets` | operator | Cria wallet (com `OPENING` se saldo > 0). |
| `GET /wallets/:walletId` | operator | Saldo e versão. |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | operator | Ledger do mais novo para o mais antigo, cursor opaco, `limit` ≤ 200. |
| `POST /wallets/:walletId/reconciliation` | operator | Saldo materializado × saldo reconstruído. |
| `POST /wagering/transactions` | provider / operator | Submete operação; `Idempotency-Key` obrigatório. |
| `GET /wagering/transactions/:id` | provider (dono) / operator | Por id interno. |
| `GET /providers/:providerId/wagering/transactions/:externalId` | provider (dono) / operator | Por id do provedor. |
| `GET /health/live`, `GET /health/ready` | aberto | Liveness e readiness. |
| `GET /metrics` | aberto | Prometheus. |

### Status HTTP: uma situação, um status

**Problema:** o provedor precisa decidir sozinho, e de forma automática, se reenvia, corrige ou desiste. Se várias
situações compartilham o mesmo status, ele teria de interpretar mensagens de texto.

**Decisão:** cada situação relevante tem um status próprio, e todo erro traz `error.retryable`:

| Situação | Status |
|---|---|
| Aplicada agora | `201` |
| Replay de operação aplicada | `200` (mesmo corpo, `idempotentReplay: true`) |
| Aceita, aguardando referência | `202` |
| Rejeitada por regra de negócio (terminal, com `failureCode`) | `422` |
| Payload inválido | `400` |
| Sem token / token inválido | `401` |
| Papel ou provedor não autorizado | `403` |
| Wallet ou transação inexistente | `404` |
| Conflito de idempotência / unicidade | `409` |
| Falha transitória (banco, IdP, lock esgotado) | `503` + `Retry-After: 1` |
| `FAILED` (erro permanente auditado) | `500` |

- **422 e não 200 para rejeição de negócio:** a rejeição é persistida e auditável, mas o provedor precisa distinguir
  "aplicado" de "não aplicado" sem abrir o corpo.
- **202 para pendente:** a operação foi aceita e será resolvida depois; não é sucesso nem erro.
- **Consultas `GET` sempre 200** com o recurso, qualquer que seja o status da transação; o status está no corpo.
- Implementação centralizada: `error-mapping.ts` (erros) e `presenters.ts#submissionStatus` (resultado). Um único
  `HttpExceptionFilter` global aplica o mapeamento, então nenhum controller decide status de erro sozinho.

### Outras decisões da camada HTTP

- `bodyParser` com limite de 64 KB: payloads de aposta são pequenos; isso corta abuso barato.
- Parâmetros de rota validados (`uuidParam`, `tokenParam`, `limitParam`) antes de chegar ao banco: um id malformado é
  400, não uma exceção do driver.
- `X-Correlation-Id` aceito se tiver formato seguro, senão gerado; sempre devolvido na resposta.

## Composition root em vez de DI do Nest nos casos de uso

- **Decisão:** `buildContainer(config)` constrói cada adaptador e caso de uso **uma vez**, com `new`. O módulo Nest
  (`WageringModule.forRoot(container)`) só expõe essas instâncias com `useValue`.
- **Por quê:** os casos de uso e o domínio ficam livres de decorators e de qualquer dependência do framework. O mesmo
  container é usado pelos testes (`test/support/app.ts`) sem precisar do mecanismo de injeção do Nest. O Nest fica
  restrito ao que faz bem: roteamento, guards, filtros, ciclo de vida.
- **Ciclo de vida:** `WorkersLifecycle` inicia os workers de background (consumidor, relay, pendências) em
  `onApplicationBootstrap` e os para, drenando o trabalho em andamento, em `beforeApplicationShutdown`.
- **Desligamento gracioso:** `main.ts` trata `SIGTERM`/`SIGINT` uma única vez e fecha, nesta ordem, o servidor HTTP,
  os workers e os pools (banco e SQS).
- **Inicialização resiliente:** PostgreSQL e SQS são conectados com retry e backoff (até 30 tentativas), porque em um
  orquestrador as dependências podem subir depois da aplicação.

## Configuração validada (`app-config.ts`)

- Todas as variáveis passam por um schema zod na inicialização; configuração inválida derruba o processo com uma
  mensagem que lista cada problema. Melhor falhar na largada do que no meio de uma transação.
- Padrões seguros para desenvolvimento local; `WORKERS` define quais componentes de background o processo roda.
- `FAULT_INJECTION` (só para testes) é **recusado quando `NODE_ENV=production`**.

## Autenticação e autorização

O desafio não pontua autenticação, mas pede integração com um IdP externo.

### Modelo no Keycloak (`realm-wagering.json`)

- Realm `wagering`, tokens com 300 s de vida.
- **Provedores são clients confidenciais** (`provider-a`, `provider-b`) com `client_credentials`: comunicação
  máquina-a-máquina, sem usuários nem senhas próprias.
  - *hardcoded claim mapper* injeta `provider_id` no token;
  - client scope padrão `wagering-api-audience` injeta `aud=wagering-api` e os papéis de realm;
  - a service account tem o papel `wagering-provider`.
- Client `backoffice` com o papel `wagering-operator`.
- **Nenhum segredo no repositório:** os client secrets são gerados pelo Keycloak na importação.
  `scripts/keycloak-token.sh` os lê pela API de administração local, autenticando com a senha de admin vinda de
  `KEYCLOAK_ADMIN_PASSWORD`.

### Validação do token na API (`OidcTokenVerifier`)

- Validação **local** com `jose`: assinatura contra o JWKS do realm (com cache e rotação de chaves), `iss`, `aud`,
  `exp`, tolerância de relógio de 5 s.
- **Por quê local:** nenhuma chamada ao IdP por requisição. O Keycloak fora do ar não derruba requisições com tokens
  válidos enquanto as chaves estiverem em cache.
- Papéis lidos de `realm_access.roles`; identidade do provedor lida do claim configurável (`provider_id`).

### Autorização

- `AuthGuard` global: rotas marcadas com `@Public()` (health, métricas) passam; as demais exigem token válido e um dos
  papéis declarados em `@RequireRoles`.
- **`ProviderIdentityPolicy`** (`assertActsAsProvider`): um provedor só submete ou lê transações cujo `providerId` é o
  do seu token. Operadores podem tudo.
- Wallets, ledger e reconciliação só para operadores: provedores operam apostas, não abrem contas.

### Modo desabilitado

- `AUTH_MODE=disabled` é o ponto de extensão explícito para desenvolvimento e testes: o verificador vira um no-op que
  devolve um operador anônimo, e um aviso é logado na inicialização.
- Mensagens da fila não têm token (canal interno confiável), mas o `providerId` delas passa pelas mesmas validações de
  domínio, e a resolução de referência é sempre escopada por provedor.

## Observabilidade

### Logs (pino, JSON)

- Campos de correlação: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instance`.
- Os pontos de log registram apenas identificadores e status. **Por defesa**, `money`, `amount`, `balance`, `payload`,
  `body`, `authorization` e `token` são *redacted* mesmo assim: um log descuidado no futuro não vaza valores nem
  credenciais.
- `X-Correlation-Id` (HTTP) ou `messageId` (SQS) viram o `correlationId` dos logs **e** dos eventos de integração;
  `causationId` aponta a mensagem ou transação que causou o evento.
- Erros 5xx logados como `error` com a causa; 4xx como `info` ("request rejected").

### Métricas (Prometheus, `/metrics`)

| Métrica | Mede |
|---|---|
| `wagering_transactions_total{status,kind,source}` | Transações por status final |
| `wagering_duplicates_detected_total{source,type}` | Replays, duplicatas de inbox e conflitos |
| `wagering_retries_total{component,reason}` | Retries de transação, consumidor, outbox e pendências |
| `wagering_lock_conflicts_total{component,reason}` | `lock_timeout`, deadlock, serialização, conflito de versão |
| `wagering_dlq_messages_total{reason}` | Mensagens enviadas à DLQ |
| `wagering_outbox_lag_seconds`, `wagering_outbox_pending` | Idade do evento não publicado mais antigo e tamanho da fila |
| `wagering_processing_duration_seconds{source,outcome}` | Latência de processamento (histograma) |
| `wagering_reconciliations_total{consistent}` | Resultado das reconciliações |

A aplicação fala com a porta `Metrics`; `PrometheusMetrics` é o adaptador. Testes usam `noopMetrics`.

### Health

- **`/health/live`** não checa dependências. **Por quê:** num orquestrador, liveness falhando reinicia o processo.
  Uma queda do banco reiniciaria todas as instâncias ao mesmo tempo sem resolver nada.
- **`/health/ready`** checa PostgreSQL (`SELECT 1`) e SQS (`GetQueueAttributes`) com timeout de 2 s cada; 503 se
  algum estiver fora, para o balanceador parar de mandar tráfego.

## Containers e topologia do Compose

### `Dockerfile`

- Dois estágios: instala só dependências de produção (`--frozen-lockfile --production`), depois copia o código.
- Roda como usuário `bun`, não root.
- `CMD` em forma *exec*: o Bun é o PID 1 e recebe o `SIGTERM` diretamente, condição para o desligamento gracioso.

### `docker-compose.yml`

| Serviço | Papel |
|---|---|
| `keycloak` | IdP em `start-dev --import-realm`, com healthcheck. |
| `migrate` | Job único que aplica as migrations e termina. |
| `api` | Instância pública (porta 3000), roda HTTP e todos os workers. |
| `worker` ×2 | Mais duas instâncias competindo pelas mesmas wallets, fila e outbox. |

Decisões:

- **Migração como job separado**, com `api` e `worker` dependendo de `service_completed_successfully`. Assim as
  instâncias nunca disputam a aplicação de migrations e nunca sobem com schema desatualizado.
- **Três instâncias por padrão**, para que rodar a stack já exercite a correção multi-instância.
- `stop_grace_period: 30s` para dar tempo de drenar mensagens em andamento.
- **Emissor do token consistente:** `KC_HOSTNAME=http://localhost:8080` faz o Keycloak emitir sempre
  `iss=http://localhost:8080/realms/wagering`, seja o token pedido do host ou de dentro da rede do Compose. A API
  valida esse `iss`, mas busca o JWKS pelo nome interno (`OIDC_JWKS_URL=http://keycloak:8080/…`).
- **Senha de admin do Keycloak vem do ambiente** (`KEYCLOAK_ADMIN_PASSWORD`); o valor padrão do Compose serve só para
  desenvolvimento local.
- Healthcheck da `api` usa o próprio `/health/ready` (via `bun -e fetch`, sem precisar de `curl` na imagem).
- Ajustes posteriores: as instâncias deixaram de esperar o Keycloak na inicialização (etapa 8) e o modo de
  autenticação do Compose ganhou variável própria (etapa 9).

## Testes

- `http-api.test.ts`: health aberto e readiness; contrato de `POST /wallets` e 409; **status distintos por situação**;
  consultas e reconciliação; métricas em formato Prometheus e eco do correlation id.
- `http-auth.test.ts`: um emissor OIDC **local** com chaves RSA e JWKS reais. Token ausente, forjado, expirado ou com
  audiência errada → 401; papéis (provedor não gerencia wallets); provedor só age sobre o próprio `providerId`. Na
  etapa 8 ganhou o caso "JWKS inacessível → 503".
- `keycloak-e2e.test.ts`: tokens reais do Keycloak via `client_credentials`. Roda só quando
  `KEYCLOAK_ADMIN_PASSWORD` está definido e o Keycloak está no ar; caso contrário, é pulado.

## Limitações

- Keycloak em `start-dev` (HTTP, banco embutido): adequado para desenvolvimento, não para produção.
- Não há rate limiting nem quotas por provedor.
