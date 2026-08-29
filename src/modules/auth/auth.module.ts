import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiClient } from './entities/api-client.entity';
import { ApiClientsRepository } from './api-clients.repository';
import { ApiKeyGuard } from './guards/api-key.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';

@Module({
  imports: [TypeOrmModule.forFeature([ApiClient])],
  providers: [
    ApiClientsRepository,
    // Orden intencional: ApiKeyGuard antes que RateLimitGuard — este último
    // lee request.apiClient, que solo existe si ApiKeyGuard ya corrió.
    // Nest ejecuta los APP_GUARD en el orden de este array.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [ApiClientsRepository],
})
export class AuthModule {}
