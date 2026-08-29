import { ConfigService } from '@nestjs/config';
import { LlmProvider } from './llm-provider';
import { OllamaProvider } from '../ollama/ollama.provider';
import { OpenAiCompatibleProvider } from '../openai-compatible/openai-compatible.provider';

export function createLlmProvider(
  configService: ConfigService,
  ollamaProvider: OllamaProvider,
  openAiCompatibleProvider: OpenAiCompatibleProvider,
): LlmProvider {
  const provider = configService.get<string>('llm.provider');
  return provider === 'openai' ? openAiCompatibleProvider : ollamaProvider;
}
