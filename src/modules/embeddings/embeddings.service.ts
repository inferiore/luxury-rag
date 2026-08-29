import { Inject, Injectable } from '@nestjs/common';
import { ChunksRepository } from '../chunks/chunks.repository';
import { LLM_PROVIDER_TOKEN } from '../llm/llm-provider';
import type { LlmProvider } from '../llm/llm-provider';

/**
 * Genera y persiste el embedding de un chunk. Orquesta ChunksRepository
 * (acceso a datos) y el proveedor LLM activo (integración externa) — la
 * decisión de qué hacer con el resultado de un job de embedding
 * (job_status, documents.status agregado) vive en el listener y en
 * DocumentsService, no aquí.
 */
@Injectable()
export class EmbeddingsService {
  constructor(
    private readonly chunksRepository: ChunksRepository,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llmProvider: LlmProvider,
  ) {}

  async embedChunk(chunkId: string): Promise<void> {
    const chunk = await this.chunksRepository.findById(chunkId);
    if (!chunk) {
      throw new Error(`Chunk ${chunkId} no encontrado`);
    }

    await this.chunksRepository.markProcessing(chunkId);

    try {
      const embedding = await this.llmProvider.embed(chunk.content);
      await this.chunksRepository.markEmbeddingDone(chunkId, embedding);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      await this.chunksRepository.markFailed(chunkId, message);
      throw error instanceof Error ? error : new Error(message);
    }
  }
}
