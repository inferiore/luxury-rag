import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm-provider';
import { OllamaProvider } from '../ollama/ollama.provider';
import { OpenAiCompatibleProvider } from '../openai-compatible/openai-compatible.provider';
import { GeminiProvider } from '../gemini/gemini.provider';

export function createLlmProvider(
  configService: ConfigService,
  ollamaProvider: OllamaProvider,
  openAiCompatibleProvider: OpenAiCompatibleProvider,
  geminiProvider: GeminiProvider,
): LlmProvider {
  const provider = configService.get<string>('llm.provider');
  if (provider === 'openai') {
    return openAiCompatibleProvider;
  }
  if (provider === 'gemini') {
    return geminiProvider;
  }
  return ollamaProvider;
}
