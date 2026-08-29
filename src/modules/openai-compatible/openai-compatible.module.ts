import { Module } from '@nestjs/common';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

@Module({
  providers: [OpenAiCompatibleProvider],
  exports: [OpenAiCompatibleProvider],
})
export class OpenAiCompatibleModule {}
