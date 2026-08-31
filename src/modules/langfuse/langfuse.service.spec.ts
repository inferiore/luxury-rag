import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

// El SDK real de `@langfuse/client` hace llamadas HTTP reales al construirse
// el cliente de API generado. Se mockea para poder testear `LangfuseService`
// sin llamadas reales.
const mockLangfuseClient = {
  shutdown: jest.fn().mockResolvedValue(undefined),
  prompt: {
    get: jest.fn(),
  },
};

jest.mock('@langfuse/client', () => ({
  LangfuseClient: jest.fn().mockImplementation(() => mockLangfuseClient),
}));

import { LangfuseService } from './langfuse.service';
import { SYSTEM_PROMPT } from '../query/system-prompt.constant';

describe('LangfuseService', () => {
  beforeEach(() => {
    mockLangfuseClient.prompt.get.mockReset();
  });

  const buildService = async (
    configValues: Record<string, unknown>,
  ): Promise<LangfuseService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LangfuseService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    return module.get(LangfuseService);
  };

  it('deja client en null si faltan las credenciales (tracing deshabilitado)', async () => {
    const service = await buildService({
      'langfuse.publicKey': '',
      'langfuse.secretKey': '',
      'langfuse.host': 'https://cloud.langfuse.com',
    });

    expect(service.client).toBeNull();
    expect(service.isEnabled()).toBe(false);
  });

  it('instancia el cliente si las credenciales están configuradas', async () => {
    const service = await buildService({
      'langfuse.publicKey': 'pk-test',
      'langfuse.secretKey': 'sk-test',
      'langfuse.host': 'https://cloud.langfuse.com',
    });

    expect(service.client).not.toBeNull();
    expect(service.isEnabled()).toBe(true);
  });

  it('onModuleDestroy no lanza si el cliente es null', async () => {
    const service = await buildService({
      'langfuse.publicKey': '',
      'langfuse.secretKey': '',
    });

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('loguea warning de alias deprecado y el host resuelto cuando usingDeprecatedHostAlias es true', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    const logSpy = jest.spyOn(Logger.prototype, 'log');

    await buildService({
      'langfuse.publicKey': 'pk-test',
      'langfuse.secretKey': 'sk-test',
      'langfuse.host': 'https://us.cloud.langfuse.com',
      'langfuse.usingDeprecatedHostAlias': true,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('LANGFUSE_BASE_URL'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://us.cloud.langfuse.com'),
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('no loguea warning de alias deprecado cuando usingDeprecatedHostAlias es false', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    await buildService({
      'langfuse.publicKey': 'pk-test',
      'langfuse.secretKey': 'sk-test',
      'langfuse.host': 'https://cloud.langfuse.com',
      'langfuse.usingDeprecatedHostAlias': false,
    });

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('LANGFUSE_BASE_URL'),
    );

    warnSpy.mockRestore();
  });

  describe('getSystemPrompt', () => {
    it('devuelve el fallback local sin llamar a getPrompt si client es null (criterio 10)', async () => {
      const service = await buildService({
        'langfuse.publicKey': '',
        'langfuse.secretKey': '',
      });

      const result = await service.getSystemPrompt();

      expect(result).toEqual({ text: SYSTEM_PROMPT, promptForTrace: null });
      expect(mockLangfuseClient.prompt.get).not.toHaveBeenCalled();
    });

    it('devuelve el texto y el promptForTrace del SDK cuando prompt.get resuelve (criterio 11)', async () => {
      const fakePrompt = { prompt: SYSTEM_PROMPT };
      mockLangfuseClient.prompt.get.mockResolvedValue(fakePrompt);

      const service = await buildService({
        'langfuse.publicKey': 'pk-test',
        'langfuse.secretKey': 'sk-test',
        'langfuse.host': 'https://cloud.langfuse.com',
      });

      const result = await service.getSystemPrompt();

      expect(result.text).toBe(SYSTEM_PROMPT);
      expect(result.promptForTrace).toBe(fakePrompt);
      expect(mockLangfuseClient.prompt.get).toHaveBeenCalledWith(
        'query-system-prompt',
        expect.objectContaining({
          label: 'production',
          type: 'text',
          fallback: SYSTEM_PROMPT,
        }),
      );
    });

    it('devuelve el fallback local sin propagar el error si prompt.get rechaza (criterio 12)', async () => {
      mockLangfuseClient.prompt.get.mockRejectedValue(
        new Error('Langfuse caído'),
      );

      const service = await buildService({
        'langfuse.publicKey': 'pk-test',
        'langfuse.secretKey': 'sk-test',
        'langfuse.host': 'https://cloud.langfuse.com',
      });

      await expect(service.getSystemPrompt()).resolves.toEqual({
        text: SYSTEM_PROMPT,
        promptForTrace: null,
      });
    });
  });
});
