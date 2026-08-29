import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiClientsRepository } from '../api-clients.repository';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { hashApiKey } from '../api-key-hash.util';
import type { AuthenticatedRequest } from '../types/authenticated-request';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiClientsRepository: ApiClientsRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = request.headers['authorization'];

    if (!authHeader || Array.isArray(authHeader)) {
      throw new UnauthorizedException('Falta el header Authorization');
    }

    const [scheme, rawKey] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !rawKey) {
      throw new UnauthorizedException(
        "Header Authorization mal formado — se espera 'Bearer <api-key>'",
      );
    }

    const apiClient = await this.apiClientsRepository.findByKeyHash(
      hashApiKey(rawKey),
    );

    if (!apiClient || !apiClient.isActive) {
      throw new UnauthorizedException('API key inválida o inactiva');
    }

    request.apiClient = apiClient;
    return true;
  }
}
