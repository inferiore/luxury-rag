import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaModule } from '../ollama/ollama.module';
import { OllamaProvider } from '../ollama/ollama.provider';
import { OpenAiCompatibleModule } from '../openai-compatible/openai-compatible.module';
import { OpenAiCompatibleProvider } from '../openai-compatible/openai-compatible.provider';
import { GeminiModule } from '../gemini/gemini.module';
import { GeminiProvider } from '../gemini/gemini.provider';
import { LLM_PROVIDER_TOKEN } from './llm-provider';
import { createLlmProvider } from './llm-provider.factory';

@Module({
  imports: [OllamaModule, OpenAiCompatibleModule, GeminiModule],
  providers: [
    {
      provide: LLM_PROVIDER_TOKEN,
      useFactory: createLlmProvider,
      inject: [
        ConfigService,
        OllamaProvider,
        OpenAiCompatibleProvider,
        GeminiProvider,
      ],
    },
  ],
  exports: [LLM_PROVIDER_TOKEN],
})
export class LlmModule {}
