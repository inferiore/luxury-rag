import { Module } from '@nestjs/common';
import { QueryController } from './query.controller';
import { QueryService } from './query.service';
import { ChunksModule } from '../chunks/chunks.module';
import { LlmModule } from '../llm/llm.module';
import { LangfuseModule } from '../langfuse/langfuse.module';

@Module({
  imports: [ChunksModule, LlmModule, LangfuseModule],
  controllers: [QueryController],
  providers: [QueryService],
})
export class QueryModule {}
