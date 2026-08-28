import { ChunkStatus } from '../../chunks/entities/chunk.entity';
import { DocumentStatus } from '../entities/document.entity';

export interface RetryChunkResponseDto {
  chunkId: string;
  documentId: string;
  status: ChunkStatus;
}

export interface RetryFailedChunksResponseDto {
  documentId: string;
  retriedCount: number;
  status: DocumentStatus;
}
