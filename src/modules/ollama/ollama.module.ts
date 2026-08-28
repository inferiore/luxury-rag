import { Module } from '@nestjs/common';
import { OllamaProvider } from './ollama.provider';

@Module({
  providers: [OllamaProvider],
  exports: [OllamaProvider],
})
export class OllamaModule {}
