import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';
import { ApiClient } from '../entities/api-client.entity';
import { AuthenticatedRequest } from '../types/authenticated-request';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  const setHeader = jest.fn();

  function buildContext(
    action: 'query' | 'upload' | undefined,
    apiClient?: Partial<ApiClient>,
  ): ExecutionContext {
    reflector.getAllAndOverride.mockReturnValue(action);
    const request: Partial<AuthenticatedRequest> = {
      apiClient: apiClient as ApiClient,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RateLimitGuard(reflector as unknown as Reflector);
    setHeader.mockClear();
  });

  it('permite el paso si la ruta no tiene metadata @RateLimit', () => {
    const context = buildContext(undefined, undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('permite el paso siempre si el límite del cliente es null (ilimitado)', () => {
    const context = buildContext('query', {
      id: 'unlimited-client',
      queryLimitPerWindow: null,
      queryWindowSeconds: null,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('permite hasta el límite y luego rechaza con 429 + Retry-After', () => {
    const context = buildContext('query', {
      id: 'limited-client',
      queryLimitPerWindow: 1,
      queryWindowSeconds: 300,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
    try {
      guard.canActivate(context);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
    }
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('vuelve a permitir el paso una vez transcurrida la ventana', () => {
    jest.useFakeTimers();
    try {
      const context = buildContext('query', {
        id: 'limited-client-2',
        queryLimitPerWindow: 1,
        queryWindowSeconds: 300,
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(() => guard.canActivate(context)).toThrow(HttpException);

      jest.advanceTimersByTime(300 * 1000 + 1);

      expect(guard.canActivate(context)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('mantiene contadores independientes para query y upload del mismo cliente', () => {
    const apiClient = {
      id: 'same-client',
      queryLimitPerWindow: 1,
      queryWindowSeconds: 300,
      uploadLimitPerWindow: 1,
      uploadWindowSeconds: 1800,
    };

    const queryContext = buildContext('query', apiClient);
    expect(guard.canActivate(queryContext)).toBe(true);
    expect(() => guard.canActivate(queryContext)).toThrow(HttpException);

    const uploadContext = buildContext('upload', apiClient);
    expect(guard.canActivate(uploadContext)).toBe(true);
  });

  it('falla cerrado (401) si hay metadata @RateLimit pero no hay apiClient en la request', () => {
    const context = buildContext('query', undefined);

    expect(() => guard.canActivate(context)).toThrow(HttpException);
    try {
      guard.canActivate(context);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(401);
    }
  });
});
