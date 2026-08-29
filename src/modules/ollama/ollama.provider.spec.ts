import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { OllamaProvider } from './ollama.provider';

describe('OllamaProvider', () => {
  let provider: OllamaProvider;
  const originalFetch = global.fetch;

  const configValues: Record<string, unknown> = {
    'llm.baseUrl': 'http://localhost:11434',
    'llm.embeddingModel': 'qwen3-embedding',
    'llm.chatModel': 'qwen3:8b',
    vectorDim: 1536,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OllamaProvider,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    provider = module.get(OllamaProvider);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('llama a /api/embed con el body esperado y devuelve embeddings[0]', async () => {
    const embedding = [0.1, 0.2, 0.3];
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [embedding] }),
    });
    global.fetch = fetchMock;

    const result = await provider.embed('texto de prueba');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen3-embedding',
          input: 'texto de prueba',
          dimensions: 1536,
        }),
      }),
    );
    expect(result).toEqual(embedding);
  });

  it('lanza un error descriptivo si la respuesta HTTP no es ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });

    await expect(provider.embed('texto')).rejects.toThrow(
      /Ollama \/api\/embed respondió 500/,
    );
  });

  it('lanza un error descriptivo si falla la conexión (Ollama caído)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(provider.embed('texto')).rejects.toThrow(
      /No se pudo conectar con Ollama/,
    );
  });

  it('lanza un error si la respuesta no trae embeddings', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [] }),
    });

    await expect(provider.embed('texto')).rejects.toThrow(
      /no devolvió ningún embedding/,
    );
  });

  it('llama a /api/chat con stream:false y devuelve message.content', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          message: { role: 'assistant', content: 'respuesta del modelo' },
        }),
    });
    global.fetch = fetchMock;

    const messages = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'pregunta' },
    ];
    const result = await provider.chat(messages);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen3:8b',
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
      /Ollama \/api\/chat respondió 500/,
    );
  });

  it('chat() lanza un error descriptivo si falla la conexión', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(provider.chat([])).rejects.toThrow(
      /No se pudo conectar con Ollama/,
    );
  });
});
