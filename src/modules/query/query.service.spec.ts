import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

// `LangfuseService` importa el SDK real de `langfuse`, que hace un
// `import()` dinámico a nivel de módulo incompatible con ts-jest sin
// `--experimental-vm-modules` — se mockea para poder cargar el módulo aquí
// (no se usa el mock directamente: en los tests se inyecta un stub simple
// de `LangfuseService` con `client: null`).
jest.mock('langfuse', () => ({
  Langfuse: jest.fn().mockImplementation(() => ({
    trace: jest.fn(),
    shutdownAsync: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { QueryService, NO_MATCH_ANSWER, SYSTEM_PROMPT } from './query.service';
import { ChunksRepository } from '../chunks/chunks.repository';
import { LLM_PROVIDER_TOKEN, LlmProvider } from '../llm/llm-provider';
import { LangfuseService } from '../langfuse/langfuse.service';

describe('QueryService', () => {
  let service: QueryService;
  let chunksRepository: jest.Mocked<Pick<ChunksRepository, 'findNearest'>>;
  let llmProvider: jest.Mocked<Pick<LlmProvider, 'embed' | 'chat'>>;
  let langfuseService: {
    client: null | { trace: jest.Mock };
    getSystemPrompt: jest.Mock;
  };

  const configValues: Record<string, unknown> = {
    'query.defaultTopK': 1,
    'query.similarityThreshold': 0.4,
    'llm.chatModel': 'qwen3:8b',
  };

  beforeEach(async () => {
    chunksRepository = { findNearest: jest.fn() };
    llmProvider = { embed: jest.fn(), chat: jest.fn() };
    langfuseService = {
      client: null,
      getSystemPrompt: jest
        .fn()
        .mockResolvedValue({ text: SYSTEM_PROMPT, promptForTrace: null }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueryService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
        { provide: ChunksRepository, useValue: chunksRepository },
        { provide: LLM_PROVIDER_TOKEN, useValue: llmProvider },
        { provide: LangfuseService, useValue: langfuseService },
      ],
    }).compile();

    service = module.get(QueryService);
  });

  it('devuelve matched:true y la respuesta stripeada cuando hay coincidencia bajo el umbral', async () => {
    llmProvider.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'Tour Guatapé: 180000 COP', distance: 0.1 },
    ]);
    llmProvider.chat.mockResolvedValue(
      '<think>razono...</think>El tour a Guatapé cuesta $180.000 COP.',
    );

    const result = await service.ask('¿Cuánto cuesta el tour a Guatapé?', 1);

    expect(result).toEqual({
      answer: 'El tour a Guatapé cuesta $180.000 COP.',
      matched: true,
    });
    expect(result.answer).not.toMatch(/<think>/);
    expect(chunksRepository.findNearest).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      1,
    );
  });

  it('devuelve "datos no encontrados" sin llamar al chat model si no hay candidatos', async () => {
    llmProvider.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    chunksRepository.findNearest.mockResolvedValue([]);

    const result = await service.ask('¿Cuál es la capital de Francia?', 1);

    expect(result).toEqual({ answer: NO_MATCH_ANSWER, matched: false });
    expect(llmProvider.chat).not.toHaveBeenCalled();
  });

  it('devuelve "datos no encontrados" sin llamar al chat model si la distancia supera el umbral', async () => {
    llmProvider.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'contenido lejano', distance: 0.9 },
    ]);

    const result = await service.ask('pregunta sin relación', 1);

    expect(result).toEqual({ answer: NO_MATCH_ANSWER, matched: false });
    expect(llmProvider.chat).not.toHaveBeenCalled();
  });

  it('usa DEFAULT_TOP_K cuando no se pasa topK', async () => {
    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([]);

    await service.ask('pregunta cualquiera');

    expect(chunksRepository.findNearest).toHaveBeenCalledWith([0.1], 1);
  });

  it('usa el topK pasado explícitamente', async () => {
    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([]);

    await service.ask('pregunta cualquiera', 3);

    expect(chunksRepository.findNearest).toHaveBeenCalledWith([0.1], 3);
  });

  it('propaga el error si falla el embedding de la pregunta', async () => {
    llmProvider.embed.mockRejectedValue(new Error('Ollama caído'));

    await expect(service.ask('pregunta')).rejects.toThrow('Ollama caído');
    expect(chunksRepository.findNearest).not.toHaveBeenCalled();
  });

  it('propaga el error si falla la llamada al chat model', async () => {
    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'contenido', distance: 0.1 },
    ]);
    llmProvider.chat.mockRejectedValue(new Error('chat caído'));

    await expect(service.ask('pregunta')).rejects.toThrow('chat caído');
  });

  it('usa el texto devuelto por getSystemPrompt() como mensaje system enviado al chat model', async () => {
    const customPromptText = 'Prompt versionado desde Langfuse';
    langfuseService.getSystemPrompt.mockResolvedValue({
      text: customPromptText,
      promptForTrace: null,
    });
    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'contenido', distance: 0.1 },
    ]);
    llmProvider.chat.mockResolvedValue('respuesta');

    await service.ask('pregunta', 1);

    expect(llmProvider.chat).toHaveBeenCalledWith([
      { role: 'system', content: customPromptText },
      expect.objectContaining({ role: 'user' }),
    ]);
  });

  it('no rompe /query si trace.generation() lanza una excepción (tracing no-fatal, criterio 15 de spec 09)', async () => {
    const mockTrace = {
      span: jest.fn().mockReturnValue({ end: jest.fn() }),
      generation: jest.fn().mockImplementation(() => {
        throw new Error('Langfuse caído');
      }),
      event: jest.fn(),
      update: jest.fn(),
    };
    langfuseService.client = { trace: jest.fn().mockReturnValue(mockTrace) };

    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'contenido', distance: 0.1 },
    ]);
    llmProvider.chat.mockResolvedValue('respuesta ok');

    const result = await service.ask('pregunta', 1);

    expect(result).toEqual({ answer: 'respuesta ok', matched: true });
    expect(mockTrace.generation).toHaveBeenCalled();
  });
});
