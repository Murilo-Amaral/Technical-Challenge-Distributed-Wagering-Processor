import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Container } from "../bootstrap/container";
import { CreateWallet } from "./application/create-wallet";
import { APP_LOGGER } from "./application/logger";
import { WageringQueries } from "./application/queries";
import { ReconcileWallet } from "./application/reconcile-wallet";
import { SubmitWagerTransaction } from "./application/submit-wager-transaction";
import { AuthGuard } from "./interface/http/auth/auth.guard";
import { TOKEN_VERIFIER } from "./interface/http/auth/token-verifier";
import { correlationMiddleware } from "./interface/http/correlation.middleware";
import { HealthController, METRICS_REGISTRY, READINESS_PROBES } from "./interface/http/health.controller";
import { HttpExceptionFilter } from "./interface/http/http-exception.filter";
import { WageringController } from "./interface/http/wagering.controller";
import { WalletsController } from "./interface/http/wallets.controller";

const WORKERS = Symbol("WORKERS");

/** Starts background workers once the app is up; stops them (draining in-flight work) before shutdown. */
@Injectable()
class WorkersLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(WORKERS) private readonly workers: Container["workers"]) {}

  onApplicationBootstrap(): void {
    this.workers.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.workers.stop();
  }
}

@Module({})
export class WageringModule implements NestModule {
  static forRoot(container: Container): DynamicModule {
    return {
      module: WageringModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: APP_LOGGER, useValue: container.logger },
        { provide: TOKEN_VERIFIER, useValue: container.tokenVerifier },
        { provide: READINESS_PROBES, useValue: container.readinessProbes },
        { provide: METRICS_REGISTRY, useValue: container.metrics.registry },
        { provide: SubmitWagerTransaction, useValue: container.submitWagerTransaction },
        { provide: CreateWallet, useValue: container.createWallet },
        { provide: ReconcileWallet, useValue: container.reconcileWallet },
        { provide: WageringQueries, useValue: container.queries },
        { provide: WORKERS, useValue: container.workers },
        WorkersLifecycle,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes("*");
  }
}
