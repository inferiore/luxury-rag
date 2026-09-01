import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

// `QueryService` crea sus observaciones con `startObservation` real de
// `@langfuse/tracing` (SDK v5, OTEL-based) — es seguro de llamar tal cual en
// tests sin ningún `LangfuseSpanProcessor` registrado (no hay exportador
// activo, así que las observaciones no van a ningún lado; el SDK está
// diseñado para no lanzar). Se envuelve en `jest.fn()` únicamente para poder
// inyectar un fallo puntual en el test de resiliencia del tracing más abajo,
// dejando pasar la implementación real en el resto de los tests.
jest.mock('@langfuse/tracing', () => {
  const actual =
    jest.requireActual<typeof import('@langfuse/tracing')>('@langfuse/tracing');
  return { ...actual, startObservation: jest.fn(actual.startObservation) };
});

import * as tracing from '@langfuse/tracing';
import { QueryService, NO_MATCH_ANSWER, SYSTEM_PROMPT } from './query.service';
import { ChunksRepository } from '../chunks/chunks.repository';
import { LLM_PROVIDER_TOKEN, LlmProvider } from '../llm/llm-provider';
import { LangfuseService } from '../langfuse/langfuse.service';
import { BoldPaymentsService } from '../bold-payments/bold-payments.service';
import { CREATE_PAYMENT_LINK_TOOL_NAME } from './tools/create-payment-link.tool';

describe('QueryService', () => {
  let service: QueryService;
  let chunksRepository: jest.Mocked<Pick<ChunksRepository, 'findNearest'>>;
  let llmProvider: jest.Mocked<Pick<LlmProvider, 'embed' | 'chat'>>;
  let langfuseService: {
    getSystemPrompt: jest.Mock;
  };
  let boldPaymentsService: jest.Mocked<
    Pick<BoldPaymentsService, 'isEnabled' | 'createPaymentLink'>
  >;

  const configValues: Record<string, unknown> = {
    'query.defaultTopK': 5,
    'query.similarityThreshold': 0.4,
    'llm.chatModel': 'qwen3:8b',
  };

  beforeEach(async () => {
    chunksRepository = { findNearest: jest.fn() };
    llmProvider = { embed: jest.fn(), chat: jest.fn() };
    langfuseService = {
      getSystemPrompt: jest
        .fn()
        .mockResolvedValue({ text: SYSTEM_PROMPT, promptForTrace: null }),
    };
    // Deshabilitado por default en la mayoría de los tests — así el modelo
    // recibe tools: [] y el comportamiento es el mismo de un solo round de
    // chat que existía antes de spec 11. Los tests de tool-calling lo
    // habilitan explícitamente.
    boldPaymentsService = {
      isEnabled: jest.fn().mockReturnValue(false),
      createPaymentLink: jest.fn(),
    };
    (tracing.startObservation as jest.Mock).mockImplementation(
      jest.requireActual<typeof import('@langfuse/tracing')>(
        '@langfuse/tracing',
      ).startObservation,
    );

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
        { provide: BoldPaymentsService, useValue: boldPaymentsService },
      ],
    }).compile();

    service = module.get(QueryService);
  });

  it('devuelve matched:true y la respuesta stripeada cuando hay coincidencia bajo el umbral', async () => {
    llmProvider.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'Tour Guatapé: 180000 COP', distance: 0.1 },
    ]);
    llmProvider.chat.mockResolvedValue({
      content: '<think>razono...</think>El tour a Guatapé cuesta $180.000 COP.',
    });

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

  it('filtra individualmente cada candidato contra el umbral (distancias mixtas)', async () => {
    llmProvider.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'Tour Guatapé: 180000 COP', distance: 0.1 },
      { id: 'chunk-2', content: 'Tour Comuna 13: 120000 COP', distance: 0.35 },
      { id: 'chunk-3', content: 'Tour lejano irrelevante', distance: 0.6 },
    ]);
    llmProvider.chat.mockResolvedValue({ content: 'respuesta' });

    const result = await service.ask('¿Qué tours tienen?', 3);

    expect(result.matched).toBe(true);
    const [messages] = llmProvider.chat.mock.calls[0];
    const userMessage = messages.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(userMessage.content).toContain('Tour Guatapé: 180000 COP');
    expect(userMessage.content).toContain('Tour Comuna 13: 120000 COP');
    expect(userMessage.content).not.toContain('Tour lejano irrelevante');
  });

  it('incluye todos los candidatos cuando todos están dentro del umbral', async () => {
    llmProvider.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'Contenido A', distance: 0.1 },
      { id: 'chunk-2', content: 'Contenido B', distance: 0.2 },
      { id: 'chunk-3', content: 'Contenido C', distance: 0.3 },
    ]);
    llmProvider.chat.mockResolvedValue({ content: 'respuesta' });

    const result = await service.ask('¿Qué tours tienen?', 3);

    expect(result.matched).toBe(true);
    const [messages] = llmProvider.chat.mock.calls[0];
    const userMessage = messages.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(userMessage.content).toContain('Contenido A');
    expect(userMessage.content).toContain('Contenido B');
    expect(userMessage.content).toContain('Contenido C');
  });

  it('devuelve "datos no encontrados" cuando todos los candidatos superan el umbral, aun con varios candidatos', async () => {
    llmProvider.embed.mockResolvedValue([0.1, 0.2, 0.3]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'Contenido A', distance: 0.5 },
      { id: 'chunk-2', content: 'Contenido B', distance: 0.6 },
      { id: 'chunk-3', content: 'Contenido C', distance: 0.7 },
    ]);

    const result = await service.ask('pregunta sin relación', 3);

    expect(result).toEqual({ answer: NO_MATCH_ANSWER, matched: false });
    expect(llmProvider.chat).not.toHaveBeenCalled();
  });

  it('incluye el candidato cuando la distancia es exactamente igual al umbral', async () => {
    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'Contenido límite', distance: 0.4 },
    ]);
    llmProvider.chat.mockResolvedValue({ content: 'respuesta' });

    const result = await service.ask('pregunta', 1);

    expect(result.matched).toBe(true);
  });

  it('usa DEFAULT_TOP_K cuando no se pasa topK', async () => {
    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([]);

    await service.ask('pregunta cualquiera');

    expect(chunksRepository.findNearest).toHaveBeenCalledWith([0.1], 5);
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
    llmProvider.chat.mockResolvedValue({ content: 'respuesta' });

    await service.ask('pregunta', 1);

    expect(llmProvider.chat).toHaveBeenCalledWith(
      [
        { role: 'system', content: customPromptText },
        expect.objectContaining({ role: 'user' }),
      ],
      { tools: [] },
    );
  });

  it('no rompe /query si la generation de Langfuse lanza una excepción (tracing no-fatal, criterio 15 de spec 09)', async () => {
    const throwLangfuseDown = (): never => {
      throw new Error('Langfuse caído');
    };
    const mockRootSpan = {
      startObservation: jest.fn((name: string) =>
        name === 'chat-round-1'
          ? throwLangfuseDown()
          : { update: jest.fn().mockReturnThis(), end: jest.fn() },
      ),
      update: jest.fn().mockReturnThis(),
      end: jest.fn(),
    };
    (tracing.startObservation as jest.Mock).mockReturnValue(mockRootSpan);

    llmProvider.embed.mockResolvedValue([0.1]);
    chunksRepository.findNearest.mockResolvedValue([
      { id: 'chunk-1', content: 'contenido', distance: 0.1 },
    ]);
    llmProvider.chat.mockResolvedValue({ content: 'respuesta ok' });

    const result = await service.ask('pregunta', 1);

    expect(result).toEqual({ answer: 'respuesta ok', matched: true });
    expect(mockRootSpan.startObservation).toHaveBeenCalledWith(
      'chat-round-1',
      expect.anything(),
      expect.objectContaining({ asType: 'generation' }),
    );
  });

  describe('tool calling (Bold payment links, spec 11)', () => {
    it('completa una ronda de tool-calling: primera respuesta con toolCalls, segunda con texto final', async () => {
      boldPaymentsService.isEnabled.mockReturnValue(true);
      boldPaymentsService.createPaymentLink.mockResolvedValue({
        url: 'https://checkout.bold.co/LNK_1',
        paymentLink: 'LNK_1',
      });
      llmProvider.embed.mockResolvedValue([0.1]);
      chunksRepository.findNearest.mockResolvedValue([
        { id: 'chunk-1', content: 'Tour Guatapé: 180000 COP', distance: 0.1 },
      ]);
      llmProvider.chat
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [
            {
              id: 'call_0',
              type: 'function',
              function: {
                name: CREATE_PAYMENT_LINK_TOOL_NAME,
                arguments: JSON.stringify({
                  description: 'Tour Guatapé',
                  amount_total_cop: 180000,
                }),
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'Aquí tienes tu link: https://checkout.bold.co/LNK_1',
        });

      const result = await service.ask('quiero pagar el tour a Guatapé', 1);

      expect(result).toEqual({
        answer: 'Aquí tienes tu link: https://checkout.bold.co/LNK_1',
        matched: true,
      });
      expect(llmProvider.chat).toHaveBeenCalledTimes(2);
      expect(boldPaymentsService.createPaymentLink).toHaveBeenCalledWith({
        description: 'Tour Guatapé',
        amountCop: 180000,
      });
    });

    it('agota MAX_TOOL_ROUNDS y devuelve el fallback fijo si el modelo nunca da contenido final', async () => {
      boldPaymentsService.isEnabled.mockReturnValue(true);
      boldPaymentsService.createPaymentLink.mockResolvedValue({
        url: 'https://checkout.bold.co/LNK_1',
        paymentLink: 'LNK_1',
      });
      llmProvider.embed.mockResolvedValue([0.1]);
      chunksRepository.findNearest.mockResolvedValue([
        { id: 'chunk-1', content: 'Tour Guatapé: 180000 COP', distance: 0.1 },
      ]);
      const toolCallResult = {
        content: null,
        toolCalls: [
          {
            id: 'call_0',
            type: 'function' as const,
            function: {
              name: CREATE_PAYMENT_LINK_TOOL_NAME,
              arguments: JSON.stringify({
                description: 'Tour Guatapé',
                amount_total_cop: 180000,
              }),
            },
          },
        ],
      };
      llmProvider.chat.mockResolvedValue(toolCallResult);

      const result = await service.ask('quiero pagar el tour a Guatapé', 1);

      expect(result.matched).toBe(true);
      expect(result.answer).toBe(
        'No pude generar una respuesta, por favor intenta de nuevo.',
      );
      expect(llmProvider.chat).toHaveBeenCalledTimes(3); // MAX_TOOL_ROUNDS (2) + 1
    });

    it('no ofrece el tool al modelo (tools: []) cuando Bold no está habilitado', async () => {
      boldPaymentsService.isEnabled.mockReturnValue(false);
      llmProvider.embed.mockResolvedValue([0.1]);
      chunksRepository.findNearest.mockResolvedValue([
        { id: 'chunk-1', content: 'Tour Guatapé: 180000 COP', distance: 0.1 },
      ]);
      llmProvider.chat.mockResolvedValue({ content: 'respuesta' });

      await service.ask('¿cuánto cuesta el tour a Guatapé?', 1);

      const [, options] = llmProvider.chat.mock.calls[0];
      expect(options).toEqual({ tools: [] });
    });
  });
});
