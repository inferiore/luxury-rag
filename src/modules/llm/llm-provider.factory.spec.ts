import { ConfigService } from '@nestjs/config';
import { OllamaProvider } from '../ollama/ollama.provider';
import { OpenAiCompatibleProvider } from '../openai-compatible/openai-compatible.provider';
import { GeminiProvider } from '../gemini/gemini.provider';
import { createLlmProvider } from './llm-provider.factory';

describe('createLlmProvider', () => {
  const ollamaProvider = {
    embed: jest.fn(),
    chat: jest.fn(),
  } as unknown as OllamaProvider;
  const openAiCompatibleProvider = {
    embed: jest.fn(),
    chat: jest.fn(),
  } as unknown as OpenAiCompatibleProvider;
  const geminiProvider = {
    embed: jest.fn(),
    chat: jest.fn(),
  } as unknown as GeminiProvider;

  function configServiceReturning(value: unknown): ConfigService {
    return {
      get: jest.fn().mockReturnValue(value),
    } as unknown as ConfigService;
  }

  it('selecciona OpenAiCompatibleProvider cuando llm.provider es "openai"', () => {
    const configService = configServiceReturning('openai');

    expect(
      createLlmProvider(
        configService,
        ollamaProvider,
        openAiCompatibleProvider,
        geminiProvider,
      ),
    ).toBe(openAiCompatibleProvider);
  });

  it('selecciona GeminiProvider cuando llm.provider es "gemini"', () => {
    const configService = configServiceReturning('gemini');

    expect(
      createLlmProvider(
        configService,
        ollamaProvider,
        openAiCompatibleProvider,
        geminiProvider,
      ),
    ).toBe(geminiProvider);
  });

  it('selecciona OllamaProvider cuando llm.provider es "ollama"', () => {
    const configService = configServiceReturning('ollama');

    expect(
      createLlmProvider(
        configService,
        ollamaProvider,
        openAiCompatibleProvider,
        geminiProvider,
      ),
    ).toBe(ollamaProvider);
  });

  it('por defecto (valor no reconocido) selecciona OllamaProvider', () => {
    const configService = configServiceReturning(undefined);

    expect(
      createLlmProvider(
        configService,
        ollamaProvider,
        openAiCompatibleProvider,
        geminiProvider,
      ),
    ).toBe(ollamaProvider);
  });
});
