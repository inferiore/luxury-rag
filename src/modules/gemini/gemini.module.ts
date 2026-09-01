import { Module } from '@nestjs/common';
import { GeminiProvider } from './gemini.provider';

@Module({
  providers: [GeminiProvider],
  exports: [GeminiProvider],
})
export class GeminiModule {}
