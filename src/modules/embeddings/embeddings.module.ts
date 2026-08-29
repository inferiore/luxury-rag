import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { EmbedChunkListener } from './listeners/embed-chunk.listener';
import { ChunksModule } from '../chunks/chunks.module';
import { JobsModule } from '../jobs/jobs.module';
import { DocumentsModule } from '../documents/documents.module';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [ChunksModule, JobsModule, DocumentsModule, LlmModule],
  providers: [EmbeddingsService, EmbedChunkListener],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
