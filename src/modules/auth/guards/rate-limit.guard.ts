import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import {
  RATE_LIMIT_ACTION_KEY,
  RateLimitAction,
} from '../decorators/rate-limit.decorator';
import type { AuthenticatedRequest } from '../types/authenticated-request';

interface WindowState {
  windowStart: number;
  count: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  // Estado en memoria del proceso: se pierde en cada restart/redeploy.
  // Aceptado a propósito, misma filosofía que el estado de jobs en memoria
  // (specs/00-arquitectura-general.md) — evitar Redis solo para esto.
  private readonly windows = new Map<string, WindowState>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<
      RateLimitAction | undefined
    >(RATE_LIMIT_ACTION_KEY, [context.getHandler(), context.getClass()]);
    if (!action) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const apiClient = request.apiClient;
    if (!apiClient) {
      // Solo puede pasar si ApiKeyGuard no corrió antes — ver el orden de
      // registro en AuthModule.providers. Falla cerrado.
      throw new HttpException('No autenticado', HttpStatus.UNAUTHORIZED);
    }

    const limit =
      action === 'query'
        ? apiClient.queryLimitPerWindow
        : apiClient.uploadLimitPerWindow;
    const windowSeconds =
      action === 'query'
        ? apiClient.queryWindowSeconds
        : apiClient.uploadWindowSeconds;

    if (limit === null || windowSeconds === null) return true;

    const key = `${apiClient.id}:${action}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const state = this.windows.get(key);

    if (!state || now - state.windowStart >= windowMs) {
      this.windows.set(key, { windowStart: now, count: 1 });
      return true;
    }

    if (state.count < limit) {
      state.count += 1;
      return true;
    }

    const retryAfterSeconds = Math.ceil(
      (state.windowStart + windowMs - now) / 1000,
    );
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      'Límite de solicitudes excedido, intenta de nuevo más tarde',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
