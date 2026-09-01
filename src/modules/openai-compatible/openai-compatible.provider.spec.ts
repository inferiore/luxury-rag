import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

describe('OpenAiCompatibleProvider', () => {
  let provider: OpenAiCompatibleProvider;
  const originalFetch = global.fetch;

  const configValues: Record<string, unknown> = {
    'llm.baseUrl': 'https://openrouter.ai/api/v1',
    'llm.apiKey': 'sk-test-key',
    'llm.chatModel': 'qwen/qwen3-8b:free',
    'llm.embeddingModel': 'text-embedding-3-small',
    vectorDim: 1536,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenAiCompatibleProvider,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    provider = module.get(OpenAiCompatibleProvider);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('llama a /embeddings con dimensions=vectorDim en el body y devuelve data[0].embedding', async () => {
    const embedding = [0.1, 0.2, 0.3];
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding }] }),
    });
    global.fetch = fetchMock;

    const result = await provider.embed('texto de prueba');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key',
        }),
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: 'texto de prueba',
          dimensions: 1536,
        }),
      }),
    );
    expect(result).toEqual(embedding);
  });

  it('embed() lanza un error descriptivo si la respuesta HTTP no es ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });

    await expect(provider.embed('texto')).rejects.toThrow(
      /OpenAI-compatible \/embeddings respondió 500/,
    );
  });

  it('embed() lanza un error descriptivo si falla la conexión', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(provider.embed('texto')).rejects.toThrow(
      /No se pudo conectar con el proveedor OpenAI-compatible/,
    );
  });

  it('embed() lanza un error si la respuesta no trae embeddings', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    await expect(provider.embed('texto')).rejects.toThrow(
      /no devolvió ningún embedding/,
    );
  });

  it('llama a /chat/completions con stream:false y devuelve choices[0].message.content', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { role: 'assistant', content: 'respuesta del modelo' } },
          ],
        }),
    });
    global.fetch = fetchMock;

    const messages = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'pregunta' },
    ];
    const result = await provider.chat(messages);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key',
        }),
        body: JSON.stringify({
          model: 'qwen/qwen3-8b:free',
          messages,
          stream: false,
        }),
      }),
    );
    expect(result).toEqual({
      content: 'respuesta del modelo',
      toolCalls: undefined,
    });
  });

  it('chat() lanza un error descriptivo si la respuesta HTTP no es ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });

    await expect(provider.chat([])).rejects.toThrow(
      /OpenAI-compatible \/chat\/completions respondió 500/,
    );
  });

  it('chat() lanza un error descriptivo si falla la conexión', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(provider.chat([])).rejects.toThrow(
      /No se pudo conectar con el proveedor OpenAI-compatible/,
    );
  });

  it('chat() lanza un error si la respuesta no trae message.content', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
    });

    await expect(provider.chat([])).rejects.toThrow(
      /no devolvió ningún mensaje/,
    );
  });

  it('pasa tool_calls (arguments ya como string) casi sin transformar', async () => {
    const toolCalls = [
      {
        id: 'call_abc',
        type: 'function' as const,
        function: {
          name: 'create_payment_link',
          arguments: '{"description":"Tour X","amount_total_cop":180000}',
        },
      },
    ];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls,
              },
            },
          ],
        }),
    });

    const result = await provider.chat([]);

    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual(
      toolCalls.map((call) => ({ ...call, raw: call })),
    );
  });

  it('preserva campos no estándar del tool call (ej. thought_signature de Gemini) vía `raw`, y los reenvía tal cual en el próximo request', async () => {
    const geminiToolCall = {
      id: 'call_gemini',
      type: 'function' as const,
      function: {
        name: 'create_payment_link',
        arguments: '{"amount_total_cop":50000}',
      },
      thought_signature: 'opaque-signature-abc123',
    };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [geminiToolCall],
              },
            },
          ],
        }),
    });
    global.fetch = fetchMock;

    const result = await provider.chat([]);
    expect(result.toolCalls?.[0].raw).toEqual(geminiToolCall);

    // Reenviar ese tool call en el historial de mensajes debe mandar el
    // objeto crudo (con thought_signature) tal cual, no una versión
    // reconstruida que lo pierda.
    await provider.chat([
      {
        role: 'assistant',
        content: null,
        toolCalls: result.toolCalls,
      },
    ]);

    const [, requestInit] = fetchMock.mock.calls[1];
    const body = JSON.parse((requestInit as { body: string }).body) as {
      messages: { tool_calls?: unknown[] }[];
    };
    expect(body.messages[0].tool_calls).toEqual([geminiToolCall]);
  });

  it('no lanza cuando content es null pero hay tool_calls', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'x', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
    });

    await expect(provider.chat([])).resolves.not.toThrow();
  });

  it('incluye tools en el body saliente cuando se pasan por options', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
    });
    global.fetch = fetchMock;

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'create_payment_link',
          description: 'x',
          parameters: {},
        },
      },
    ];
    await provider.chat([], { tools });

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse((requestInit as { body: string }).body) as {
      tools: unknown;
    };
    expect(body.tools).toEqual(tools);
  });
});
