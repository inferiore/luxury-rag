import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CHUNK_CREATED_EVENT } from '../../chunks/chunks.events';
import type { ChunkCreatedPayload } from '../../chunks/chunks.events';
import { JobsService } from '../../jobs/jobs.service';
import { DocumentsService } from '../../documents/documents.service';
import { EmbeddingsService } from '../embeddings.service';

/**
 * Reacciona a `chunk.created` (emitido por DocumentUploadedListener, spec 02).
 * Crea el job de tipo 'embedding', genera y persiste el embedding del chunk
 * vía EmbeddingsService y, al terminar (éxito o fallo), revisa si el
 * documento padre ya puede pasar a `'done'`/`'failed'`.
 */
@Injectable()
export class EmbedChunkListener {
  private readonly logger = new Logger(EmbedChunkListener.name);

  constructor(
    private readonly embeddingsService: EmbeddingsService,
    private readonly jobsService: JobsService,
    private readonly documentsService: DocumentsService,
  ) {}

  @OnEvent(CHUNK_CREATED_EVENT)
  async handleChunkCreated(payload: ChunkCreatedPayload): Promise<void> {
    const { chunkId, documentId } = payload;
    const job = await this.jobsService.startJob(
      documentId,
      'embedding',
      chunkId,
    );

    try {
      await this.embeddingsService.embedChunk(chunkId);
      await this.jobsService.markDone(job.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(
        `Job de embedding falló para chunkId=${chunkId}: ${message}`,
      );
      await this.jobsService.markFailed(job.id, message);
    } finally {
      await this.documentsService.finalizeStatusIfComplete(documentId);
    }
  }
}
