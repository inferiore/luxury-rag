import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApiClientsRepository } from '../src/modules/auth/api-clients.repository';
import { hashApiKey } from '../src/modules/auth/api-key-hash.util';
import { ApiClient } from '../src/modules/auth/entities/api-client.entity';
import { ApiKeyGuard } from '../src/modules/auth/guards/api-key.guard';
import { RateLimitGuard } from '../src/modules/auth/guards/rate-limit.guard';
import { RateLimit } from '../src/modules/auth/decorators/rate-limit.decorator';
import { Public } from '../src/modules/auth/decorators/public.decorator';

/**
 * Reconstruye el wiring real de AuthModule.providers (mismo orden de
 * APP_GUARD) contra una app HTTP mínima, sin depender de Postgres/Ollama —
 * lo que se está probando es el orden de ejecución de los guards, no la
 * lógica de negocio de /query o /documents/upload. Un test unitario de cada
 * guard por separado no detecta un reordenamiento accidental en
 * AuthModule.providers.
 */
const RAW_KEY = 'test-raw-key';
const LIMITED_CLIENT: ApiClient = {
  id: 'limited-client-id',
  name: 'test-client',
  apiKeyHash: hashApiKey(RAW_KEY),
  isActive: true,
  queryLimitPerWindow: 1,
  queryWindowSeconds: 300,
  uploadLimitPerWindow: null,
  uploadWindowSeconds: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

@Controller('test')
class TestController {
  @Get('public')
  @Public()
  publicRoute() {
    return { ok: true };
  }

  @Get('limited')
  @RateLimit('query')
  limitedRoute() {
    return { ok: true };
  }
}

@Module({
  controllers: [TestController],
  providers: [
    {
      provide: ApiClientsRepository,
      useValue: {
        findByKeyHash: (hash: string) =>
          Promise.resolve(
            hash === LIMITED_CLIENT.apiKeyHash ? LIMITED_CLIENT : null,
          ),
      },
    },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
class TestAuthModule {}

describe('Auth guard ordering (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestAuthModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('permite una ruta @Public() sin ningún header', async () => {
    await request(app.getHttpServer()).get('/test/public').expect(200);
  });

  it('rechaza con 401 una ruta protegida sin Authorization', async () => {
    await request(app.getHttpServer()).get('/test/limited').expect(401);
  });

  it('permite la primera llamada y responde 429 (no 500) al exceder el límite', async () => {
    await request(app.getHttpServer())
      .get('/test/limited')
      .set('Authorization', `Bearer ${RAW_KEY}`)
      .expect(200);

    const second = await request(app.getHttpServer())
      .get('/test/limited')
      .set('Authorization', `Bearer ${RAW_KEY}`);

    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
  });
});
