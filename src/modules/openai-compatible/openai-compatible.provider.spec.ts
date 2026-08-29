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
    expect(result).toBe('respuesta del modelo');
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
});
