import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { DOCUMENT_UPLOADED_EVENT } from '../../documents/documents.service';
import type { DocumentUploadedPayload } from '../../documents/documents.service';
import { JobsService } from '../../jobs/jobs.service';
import { ChunksService } from '../chunks.service';
import { CHUNK_CREATED_EVENT, ChunkCreatedPayload } from '../chunks.events';

/**
 * Reacciona a `document.uploaded` (emitido por DocumentsService tras validar
 * y persistir el documento). Crea el job de tipo 'chunking', inserta 1 chunk
 * por item del array (en orden) y emite `chunk.created` por cada uno.
 * No genera embeddings — eso lo consume el módulo `embeddings` (spec 03).
 */
@Injectable()
export class DocumentUploadedListener {
  private readonly logger = new Logger(DocumentUploadedListener.name);

  constructor(
    private readonly chunksService: ChunksService,
    private readonly jobsService: JobsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent(DOCUMENT_UPLOADED_EVENT)
  async handleDocumentUploaded(
    payload: DocumentUploadedPayload,
  ): Promise<void> {
    const { documentId, items } = payload;
    const job = await this.jobsService.startJob(documentId, 'chunking');

    try {
      for (const item of items) {
        const chunk = await this.chunksService.createChunk(documentId, item);
        const chunkCreatedPayload: ChunkCreatedPayload = {
          chunkId: chunk.id,
          documentId,
        };
        this.eventEmitter.emit(CHUNK_CREATED_EVENT, chunkCreatedPayload);
      }

      await this.jobsService.markDone(job.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(
        `Job de chunking falló para documentId=${documentId}: ${message}`,
      );
      await this.jobsService.markFailed(job.id, message);
    }
  }
}
