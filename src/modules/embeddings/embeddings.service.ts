import { Injectable } from '@nestjs/common';
import { ChunksRepository } from '../chunks/chunks.repository';
import { OllamaProvider } from '../ollama/ollama.provider';

/**
 * Genera y persiste el embedding de un chunk. Orquesta ChunksRepository
 * (acceso a datos) y OllamaProvider (integración externa) — la
 * decisión de qué hacer con el resultado de un job de embedding
 * (job_status, documents.status agregado) vive en el listener y en
 * DocumentsService, no aquí.
 */
@Injectable()
export class EmbeddingsService {
  constructor(
    private readonly chunksRepository: ChunksRepository,
    private readonly ollamaProvider: OllamaProvider,
  ) {}

  async embedChunk(chunkId: string): Promise<void> {
    const chunk = await this.chunksRepository.findById(chunkId);
    if (!chunk) {
      throw new Error(`Chunk ${chunkId} no encontrado`);
    }

    await this.chunksRepository.markProcessing(chunkId);

    try {
      const embedding = await this.ollamaProvider.embed(chunk.content);
      await this.chunksRepository.markEmbeddingDone(chunkId, embedding);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      await this.chunksRepository.markFailed(chunkId, message);
      throw error instanceof Error ? error : new Error(message);
    }
  }
}
