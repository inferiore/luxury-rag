import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';
import { ApiClientsRepository } from '../api-clients.repository';
import { hashApiKey } from '../api-key-hash.util';
import { ApiClient } from '../entities/api-client.entity';
import { AuthenticatedRequest } from '../types/authenticated-request';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let apiClientsRepository: jest.Mocked<
    Pick<ApiClientsRepository, 'findByKeyHash'>
  >;

  const activeClient = {
    id: 'client-uuid',
    isActive: true,
  } as ApiClient;

  function buildContext(headers: Record<string, unknown>): ExecutionContext {
    const request: Partial<AuthenticatedRequest> = {
      headers: headers as AuthenticatedRequest['headers'],
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    apiClientsRepository = { findByKeyHash: jest.fn() };
    guard = new ApiKeyGuard(
      reflector as unknown as Reflector,
      apiClientsRepository as unknown as ApiClientsRepository,
    );
  });

  it('permite el paso sin tocar el repositorio si la ruta es @Public()', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const context = buildContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiClientsRepository.findByKeyHash).not.toHaveBeenCalled();
  });

  it('rechaza si falta el header Authorization', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = buildContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza si el header está mal formado (sin esquema Bearer)', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = buildContext({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza si el hash de la key no existe en el registro', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    apiClientsRepository.findByKeyHash.mockResolvedValue(null);
    const context = buildContext({ authorization: 'Bearer raw-key' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(apiClientsRepository.findByKeyHash).toHaveBeenCalledWith(
      hashApiKey('raw-key'),
    );
  });

  it('rechaza si el cliente existe pero está inactivo', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    apiClientsRepository.findByKeyHash.mockResolvedValue({
      ...activeClient,
      isActive: false,
    });
    const context = buildContext({ authorization: 'Bearer raw-key' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('permite el paso y adjunta el cliente a la request si la key es válida', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    apiClientsRepository.findByKeyHash.mockResolvedValue(activeClient);
    const request: Partial<AuthenticatedRequest> = {
      headers: {
        authorization: 'Bearer raw-key',
      },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.apiClient).toBe(activeClient);
  });
});
