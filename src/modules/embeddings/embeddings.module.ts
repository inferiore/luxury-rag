import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { EmbedChunkListener } from './listeners/embed-chunk.listener';
import { ChunksModule } from '../chunks/chunks.module';
import { JobsModule } from '../jobs/jobs.module';
import { DocumentsModule } from '../documents/documents.module';
import { OllamaModule } from '../ollama/ollama.module';

@Module({
  imports: [ChunksModule, JobsModule, DocumentsModule, OllamaModule],
  providers: [EmbeddingsService, EmbedChunkListener],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
