import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ProviderForbiddenError } from "../../../application/errors";
import type { Principal, Role } from "./principal";
import { TOKEN_VERIFIER, type TokenVerifier } from "./token-verifier";

const PUBLIC_KEY = "auth:public";
const ROLES_KEY = "auth:roles";

/** Health and metrics endpoints are open (no authentication). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Any of the listed realm roles grants access. */
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export type AuthenticatedRequest = Request & { principal?: Principal; correlationId?: string };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.verifier.verify(request.headers.authorization);
    request.principal = principal;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets) ?? [];
    if (required.length > 0 && !required.some((role) => principal.roles.has(role))) {
      throw new ProviderForbiddenError("Missing role for this operation");
    }
    return true;
  }
}
