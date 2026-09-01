import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

const mockEmbedContent = jest.fn();
const mockChatsCreate = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { embedContent: mockEmbedContent },
    chats: { create: mockChatsCreate },
  })),
}));

import { GoogleGenAI } from '@google/genai';
import { GeminiProvider } from './gemini.provider';

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  const configValues: Record<string, unknown> = {
    'llm.apiKey': 'vertex-express-key',
    'llm.chatModel': 'gemini-2.5-flash',
    'llm.embeddingModel': 'gemini-embedding-001',
    vectorDim: 1536,
  };

  beforeEach(async () => {
    mockEmbedContent.mockReset();
    mockChatsCreate.mockReset();
    (GoogleGenAI as jest.Mock).mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeminiProvider,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    provider = module.get(GeminiProvider);
  });

  it('inicializa el cliente en modo Vertex AI Express (vertexai:true + apiKey, sin proyecto/región)', async () => {
    mockEmbedContent.mockResolvedValue({ embeddings: [{ values: [0.1] }] });

    await provider.embed('texto');

    expect(GoogleGenAI).toHaveBeenCalledWith({
      vertexai: true,
      apiKey: 'vertex-express-key',
    });
  });

  it('embed() llama a embedContent con outputDimensionality=vectorDim y devuelve embeddings[0].values', async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockEmbedContent.mockResolvedValue({ embeddings: [{ values: embedding }] });

    const result = await provider.embed('texto de prueba');

    expect(mockEmbedContent).toHaveBeenCalledWith({
      model: 'gemini-embedding-001',
      contents: 'texto de prueba',
      config: { outputDimensionality: 1536 },
    });
    expect(result).toEqual(embedding);
  });

  it('embed() lanza si la respuesta no trae embeddings', async () => {
    mockEmbedContent.mockResolvedValue({ embeddings: [] });

    await expect(provider.embed('texto')).rejects.toThrow(
      /no devolvió ningún embedding/,
    );
  });

  it('embed() lanza un error descriptivo si el SDK falla', async () => {
    mockEmbedContent.mockRejectedValue(new Error('quota exceeded'));

    await expect(provider.embed('texto')).rejects.toThrow(
      /Gemini embedContent falló/,
    );
  });

  it('chat() sin tool calls: separa el system message como systemInstruction y devuelve el texto de la respuesta', async () => {
    const mockChat = {
      sendMessage: jest.fn().mockResolvedValue({
        text: 'respuesta del modelo',
        functionCalls: undefined,
      }),
      getHistory: jest.fn(),
    };
    mockChatsCreate.mockReturnValue(mockChat);

    const result = await provider.chat([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'pregunta' },
    ]);

    expect(mockChatsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        history: [], // el único mensaje no-system es el último -> va como sendMessage, no en history
        config: expect.objectContaining({ systemInstruction: 'system prompt' }),
      }),
    );
    expect(mockChat.sendMessage).toHaveBeenCalledWith({
      message: [{ text: 'pregunta' }],
    });
    expect(result).toEqual({ content: 'respuesta del modelo' });
  });

  it('chat() lanza si no hay texto ni function calls en la respuesta', async () => {
    const mockChat = {
      sendMessage: jest
        .fn()
        .mockResolvedValue({ text: undefined, functionCalls: undefined }),
      getHistory: jest.fn(),
    };
    mockChatsCreate.mockReturnValue(mockChat);

    await expect(
      provider.chat([{ role: 'user', content: 'hola' }]),
    ).rejects.toThrow(/Gemini no devolvió ningún mensaje/);
  });

  it('chat() con tools: pasa functionDeclarations con parametersJsonSchema y normaliza functionCalls a ToolCall, guardando el Content crudo en raw', async () => {
    const rawModelContent = {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call_0',
            name: 'create_payment_link',
            args: { amount_total_cop: 50000 },
          },
          thoughtSignature: 'opaque-abc123',
        },
      ],
    };
    const mockChat = {
      sendMessage: jest.fn().mockResolvedValue({
        text: undefined,
        functionCalls: [
          {
            id: 'call_0',
            name: 'create_payment_link',
            args: { amount_total_cop: 50000 },
          },
        ],
      }),
      getHistory: jest
        .fn()
        .mockReturnValue([
          { role: 'user', parts: [{ text: 'generame un link de pago' }] },
          rawModelContent,
        ]),
    };
    mockChatsCreate.mockReturnValue(mockChat);

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'create_payment_link',
          description: 'genera un link',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];

    const result = await provider.chat(
      [{ role: 'user', content: 'generame un link de pago' }],
      { tools },
    );

    expect(mockChatsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'create_payment_link',
                  description: 'genera un link',
                  parametersJsonSchema: { type: 'object', properties: {} },
                },
              ],
            },
          ],
        }),
      }),
    );

    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([
      {
        id: 'call_0',
        type: 'function',
        function: {
          name: 'create_payment_link',
          arguments: JSON.stringify({ amount_total_cop: 50000 }),
        },
        raw: rawModelContent,
      },
    ]);
  });

  it('chat() en una ronda posterior: reenvía el Content crudo guardado en ToolCall.raw tal cual (con thoughtSignature) en vez de reconstruirlo', async () => {
    const rawModelContentFromRound1 = {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call_0',
            name: 'create_payment_link',
            args: { amount_total_cop: 50000 },
          },
          thoughtSignature: 'opaque-abc123',
        },
      ],
    };
    const mockChat = {
      sendMessage: jest.fn().mockResolvedValue({
        text: 'Aquí tienes tu link',
        functionCalls: undefined,
      }),
      getHistory: jest.fn(),
    };
    mockChatsCreate.mockReturnValue(mockChat);

    await provider.chat([
      { role: 'user', content: 'generame un link de pago' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_0',
            type: 'function',
            function: {
              name: 'create_payment_link',
              arguments: JSON.stringify({ amount_total_cop: 50000 }),
            },
            raw: rawModelContentFromRound1,
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_0',
        content: JSON.stringify({ url: 'https://checkout.bold.co/LNK_1' }),
      },
    ]);

    const [{ history }] = mockChatsCreate.mock.calls[0] as [
      { history: unknown[] },
    ];
    // El segundo turno de history (el assistant con tool call) debe ser
    // EXACTAMENTE el objeto crudo guardado en round 1 — no uno reconstruido.
    expect(history[1]).toBe(rawModelContentFromRound1);
  });
});
